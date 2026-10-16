use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use office_pdf_engine::{AddedContent, AddedText, DocId, Edit, Session};
use office_pdf_ui_egui::OfficePdfApp;
use serde_json::{Value, json};

pub(crate) const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_INSPECT_PAGES: usize = 2_000;
const MAX_EXTRACTED_CHARS: usize = 8 * 1024 * 1024;

/// Last-resort boundary around untrusted import/export/commands. Error text never exposes panic payloads.
pub(crate) fn guarded<T>(action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(action)).map_err(|_| "PDF 操作未能完成，当前文档仍保留在工作区。".to_owned())?
}

pub(crate) struct Entry {
    pub app: OfficePdfApp,
    pub name: String,
    pub document_id: u32,
    pub revision: u32,
    pub memory: Option<egui::Memory>,
    pub notified: String,
    observed_generation: u64,
    observed_draft: Value,
    exported: Option<(u32, Arc<Vec<u8>>)>,
}

impl Entry {
    pub fn new(name: &str, input: &[u8], document_id: u32) -> Result<Self, String> {
        guarded(|| {
            if input.len() > MAX_INPUT_BYTES || !name.to_ascii_lowercase().ends_with(".pdf") {
                return Err("请选择不超过 64 MiB 的 PDF 文件。".into());
            }
            if !input.is_empty() && !input.get(..input.len().min(1024)).unwrap_or_default().windows(5).any(|header| header == b"%PDF-") {
                return Err("文件内容不是有效的 PDF。".into());
            }
            let mut app = OfficePdfApp::new();
            app.embedded = true;
            app.set_option("language", "zh-Hans")?;
            #[cfg(target_arch = "wasm32")]
            {
                app.session = app.session.with_wall_clock(wall_clock, utc_offset);
            }
            let bytes = if input.is_empty() {
                app.session.create_blank(595.28, 841.89, 1).map_err(|e| e.to_string())?.as_ref().clone()
            } else {
                input.to_vec()
            };
            app.open_bytes(name, None, bytes)?;
            // A password prompt is not a prepared document. Do not admit an empty candidate tab.
            let (_, id) = app.active_ids().ok_or("此 PDF 需要密码，或未能读取有效页面。")?;
            let doc = app.session.get(id).ok_or("PDF 文档尚未就绪。")?;
            if doc.info.pages.is_empty() {
                return Err("PDF 文件没有可读取的页面。".into());
            }
            let generation = doc.edit_generation();
            let draft = app.embedding_draft();
            Ok(Self {
                app,
                name: name.to_owned(),
                document_id,
                revision: 1,
                memory: None,
                notified: String::new(),
                observed_generation: generation,
                observed_draft: draft,
                exported: None,
            })
        })
    }

    pub fn id(&self) -> Result<DocId, String> {
        self.app.active_ids().map(|(_, id)| id).ok_or_else(|| "PDF 文档尚未就绪。".into())
    }

    pub fn dirty(&self) -> bool {
        self.app.first_dirty().is_some() || self.app.has_pending_input()
    }

    pub fn sync(&mut self) -> Result<(), String> {
        let generation = self.app.session.get(self.id()?).ok_or("PDF 文档已关闭。")?.edit_generation();
        let draft = self.app.embedding_draft();
        if generation != self.observed_generation || draft != self.observed_draft {
            self.revision = self.revision.checked_add(1).ok_or("PDF 修订编号已达到上限。")?;
            self.observed_generation = generation;
            self.observed_draft = draft;
        }
        Ok(())
    }

    pub fn commit_pending(&mut self) -> Result<(), String> {
        self.app.commit_pending()?;
        self.sync()
    }

    pub fn matches(&self, document_id: f64, revision: f64) -> bool {
        f64::from(self.document_id) == document_id && f64::from(self.revision) == revision
    }

    pub fn export(&mut self, format: &str) -> Result<Arc<Vec<u8>>, String> {
        if format != "pdf" {
            return Err("PDF 工作区仅支持导出 PDF。".into());
        }
        self.commit_pending()?;
        if let Some((revision, bytes)) = &self.exported
            && *revision == self.revision
        {
            // Repeated exports of one revision share the same save receipt, including /ModDate.
            return Ok(bytes.clone());
        }
        let id = self.id()?;
        let bytes = guarded(|| {
            let bytes = self.app.session.save_bytes(id).map_err(|e| e.to_string())?;
            self.app.session.check_save(id, &bytes).map_err(|e| e.to_string())?;
            Ok(bytes)
        })?;
        // Retain the exact validated bytes. A delayed save receipt must not generate different bytes.
        self.exported = Some((self.revision, bytes.clone()));
        Ok(bytes)
    }

    pub fn mark_saved(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.app.has_pending_input() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        let Some((export_revision, bytes)) = self.exported.clone() else { return Ok(false) };
        if export_revision != self.revision {
            return Ok(false);
        }
        let id = self.id()?;
        guarded(|| self.app.session.mark_saved(id, bytes, None).map_err(|e| e.to_string()))?;
        self.exported = None;
        self.sync()?;
        Ok(true)
    }

    pub fn can_close(&mut self, document_id: f64, revision: f64, force: bool) -> Result<bool, String> {
        self.sync()?;
        Ok(self.matches(document_id, revision) && (force || (!self.app.is_composing() && !self.dirty())))
    }

    pub fn discard(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.app.is_composing() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        self.app.discard_pending();
        let id = self.id()?;
        guarded(|| self.app.session.revert(id).map_err(|e| e.to_string()))?;
        self.refresh_view()?;
        self.exported = None;
        self.sync()?;
        Ok(true)
    }

    fn refresh_view(&mut self) -> Result<(), String> {
        let (index, id) = self.app.active_ids().ok_or("PDF 文档已关闭。")?;
        let doc = self.app.session.get(id).ok_or("PDF 文档已关闭。")?;
        let view = self.app.views.get_mut(index).ok_or("PDF 页面视图已关闭。")?;
        view.document_changed(&doc.info);
        Ok(())
    }

    pub fn command(&mut self, command: &str, params: &Value) -> Result<Value, String> {
        guarded(|| self.run_command(command, params))
    }

    fn run_command(&mut self, command: &str, params: &Value) -> Result<Value, String> {
        if matches!(command, "document.inspect" | "ui.state" | "ui.inspect") {
            return if command == "document.inspect" { self.inspect_document() } else { Ok(self.app.embedding_state()) };
        }
        if command == "edit.find" {
            let query = params.get("query").and_then(Value::as_str).ok_or("请输入搜索内容。")?;
            if query.len() > 8192 {
                return Err("搜索内容过长。".into());
            }
            self.app.set_option("find", query)?;
            return Ok(json!({"query":query}));
        }
        if command == "ui.set" {
            let key = params.get("key").and_then(Value::as_str).ok_or("缺少视图选项。")?;
            let value = params.get("value").and_then(Value::as_str).ok_or("缺少视图选项值。")?;
            if !matches!(key, "page" | "zoom" | "mode" | "panel" | "find" | "select" | "fields") {
                return Err("此选项由 Open Office 全局设置管理。".into());
            }
            self.app.set_option(key, value)?;
            return Ok(Value::Null);
        }
        self.commit_pending()?;
        let id = self.id()?;
        match command {
            "edit.undo" => {
                self.app.session.undo(id).map_err(|e| e.to_string())?;
                self.refresh_view()?;
            }
            "edit.redo" => {
                self.app.session.redo(id).map_err(|e| e.to_string())?;
                self.refresh_view()?;
            }
            "pdf.addText" | "pdf.editText" | "pdf.updateText" => {
                let page = index(params, "page", 0)?;
                let doc = self.app.session.get(id).ok_or("PDF 文档已关闭。")?;
                if page >= doc.info.pages.len() {
                    return Err("页码超出文档范围。".into());
                }
                let text = params.get("text").and_then(Value::as_str).ok_or("缺少要写入的文字。")?;
                if text.len() > 1024 * 1024 {
                    return Err("单次写入的文字不能超过 1 MiB。".into());
                }
                let edit = match command {
                    "pdf.addText" => {
                        let rect = rectangle(params)?;
                        let size = match params.get("size") {
                            None => 18.0,
                            Some(value) => value.as_f64().ok_or("字号必须为数字。")?,
                        };
                        if !size.is_finite() || !(1.0..=500.0).contains(&size) {
                            return Err("字号应在 1 到 500 之间。".into());
                        }
                        Edit::AddText { page, text: AddedText { rect, text: text.into(), size, ..Default::default() } }
                    }
                    "pdf.editText" => Edit::EditTextLine { page, line: index(params, "line", 0)?, text: text.into() },
                    _ => {
                        let index = index(params, "index", 0)?;
                        let item = doc.added().iter().filter(|item| item.page == page).nth(index).ok_or("找不到要修改的文字框。")?;
                        let AddedContent::Text(mut content) = item.content.clone() else { return Err("选中的内容不是文字框。".into()) };
                        content.text = text.into();
                        Edit::UpdateContent { page, index, content: AddedContent::Text(content) }
                    }
                };
                if !self.app.apply_edit(edit) {
                    return Err(self.app.toast.as_ref().map(|(message, _)| message.clone()).unwrap_or_else(|| "PDF 编辑未能完成。".into()));
                }
            }
            _ => return self.app.run_host_command(command, params.clone()),
        }
        self.sync()?;
        Ok(json!({"edited":true}))
    }

    pub fn inspect_document(&self) -> Result<Value, String> {
        let doc = self.app.session.get(self.id()?).ok_or("PDF 文档已关闭。")?;
        read_document(doc)
    }

    pub fn snapshot(&mut self, session_id: &str) -> Result<Value, String> {
        self.sync()?;
        let (index, id) = self.app.active_ids().ok_or("PDF 文档已关闭。")?;
        let doc = self.app.session.get(id).ok_or("PDF 文档已关闭。")?;
        let view = self.app.views.get(index).ok_or("PDF 页面视图已关闭。")?;
        Ok(json!({"sessionId":session_id,"name":self.name,"documentId":self.document_id,"revision":self.revision,
            "backgroundExportReady":self.app.background_export_ready(),
            "dirty":self.dirty(),"canUndo":doc.can_undo().is_some(),"canRedo":doc.can_redo().is_some(),
            "pageCount":doc.info.pages.len(),"activePage":view.current,
            "pages":doc.info.pages.iter().enumerate().map(|(index,page)|json!({"index":index,"width":page.width,"height":page.height,"label":page.label})).collect::<Vec<_>>(),
            "warnings":doc.info.warnings,"readOnly":!doc.editable(),"ui":self.app.embedding_state()}))
    }
}

fn index(params: &Value, key: &str, fallback: usize) -> Result<usize, String> {
    match params.get(key) {
        None => Ok(fallback),
        Some(value) => value.as_u64().and_then(|v| usize::try_from(v).ok()).ok_or_else(|| format!("{key} 必须为非负整数。")),
    }
}

fn rectangle(params: &Value) -> Result<[f64; 4], String> {
    let Some(value) = params.get("rect") else { return Ok([72.0, 650.0, 432.0, 720.0]) };
    let values = value.as_array().filter(|v| v.len() == 4).ok_or("文字框需要四个坐标。")?;
    let mut rect = [0.0; 4];
    for (target, value) in rect.iter_mut().zip(values) {
        *target = value.as_f64().filter(|v| v.is_finite() && v.abs() <= 100_000.0).ok_or("文字框坐标无效。")?;
    }
    if rect[2] <= rect[0] || rect[3] <= rect[1] {
        return Err("文字框需要正数宽度和高度。".into());
    }
    Ok(rect)
}

fn read_document(doc: &office_pdf_engine::Document) -> Result<Value, String> {
    if !doc.allows_copying() {
        return Err("此 PDF 的权限不允许提取文字。".into());
    }
    if doc.info.pages.len() > MAX_INSPECT_PAGES {
        return Err("文字检查最多支持 2000 页。".into());
    }
    let config = office_pdf_render::RenderConfig { password: doc.password.as_deref().map(Arc::from), ..Default::default() };
    let mut renderer = office_pdf_render::PageRenderer::new(doc.bytes.clone(), config);
    let mut texts = Vec::new();
    let mut length = 0usize;
    for page in 0..doc.info.pages.len() {
        let text = renderer.filtered_text(page, Default::default())?.plain_text();
        length = length.checked_add(text.len()).ok_or("PDF 文字量超出限制。")?;
        if length > MAX_EXTRACTED_CHARS {
            return Err("PDF 文字检查结果不能超过 8 MiB。".into());
        }
        texts.push(text);
    }
    Ok(json!({"pageCount":doc.info.pages.len(),"texts":texts}))
}

pub(crate) fn inspect_bytes(bytes: &[u8]) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err("PDF 文件为空或超过 64 MiB。".into());
    }
    guarded(|| {
        let mut session = Session::new();
        let id = session.open("检查.pdf", None, Arc::new(bytes.to_vec()), None).map_err(|e| e.to_string())?;
        read_document(session.get(id).ok_or("PDF 文档未能读取。")?)
    })
}

#[cfg(target_arch = "wasm32")]
fn wall_clock() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}
#[cfg(target_arch = "wasm32")]
fn utc_offset() -> i64 {
    (-js_sys::Date::new_0().get_timezone_offset() * 60.0) as i64
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn blank() -> Entry {
        Entry::new("Test.pdf", &[], 1).unwrap()
    }
    #[test]
    fn export_preserves_unsaved_edits_and_receipts_reject_newer_changes() {
        let mut entry = blank();
        entry.command("pdf.addText", &json!({"text":"First version"})).unwrap();
        let bytes = entry.export("pdf").unwrap();
        assert!(entry.dirty());
        assert!(inspect_bytes(&bytes).unwrap()["texts"][0].as_str().unwrap().contains("First version"));
        let revision = f64::from(entry.revision);
        entry.command("pdf.updateText", &json!({"text":"Second version"})).unwrap();
        assert!(!entry.mark_saved(1.0, revision).unwrap());
        let next = entry.export("pdf").unwrap();
        assert!(inspect_bytes(&next).unwrap()["texts"][0].as_str().unwrap().contains("Second version"));
        assert!(entry.mark_saved(1.0, f64::from(entry.revision)).unwrap());
        assert!(!entry.dirty());
    }
    #[test]
    fn sessions_are_independent_and_malformed_candidates_do_not_replace_them() {
        let mut first = blank();
        let second = Entry::new("Second.pdf", &[], 2).unwrap();
        first.command("pdf.addText", &json!({"text":"Keep this text"})).unwrap();
        assert!(Entry::new("Broken.pdf", b"not a PDF", 3).is_err());
        assert!(first.inspect_document().unwrap()["texts"][0].as_str().unwrap().contains("Keep this text"));
        assert_eq!(second.inspect_document().unwrap()["texts"][0], "");
        let revision = f64::from(first.revision);
        assert!(!first.can_close(1.0, revision, false).unwrap());
        assert!(first.can_close(1.0, revision, true).unwrap());
    }
    #[test]
    fn undo_redo_and_discard_keep_pdf_model_and_view_in_sync() {
        let mut entry = blank();
        entry.command("pdf.addText", &json!({"text":"Undo proof"})).unwrap();
        entry.command("edit.undo", &json!({})).unwrap();
        assert_eq!(entry.inspect_document().unwrap()["texts"][0], "");
        entry.command("edit.redo", &json!({})).unwrap();
        assert!(entry.inspect_document().unwrap()["texts"][0].as_str().unwrap().contains("Undo proof"));
        assert!(entry.discard(1.0, f64::from(entry.revision)).unwrap());
        assert_eq!(entry.inspect_document().unwrap()["texts"][0], "");
    }
    #[test]
    fn added_text_remains_editable_after_saved_rebase_and_reopen() {
        let mut entry = blank();
        entry.command("pdf.addText", &json!({"text":"Saved baseline"})).unwrap();
        let saved = entry.export("pdf").unwrap();
        assert!(entry.mark_saved(1.0, f64::from(entry.revision)).unwrap());
        entry.command("pdf.updateText", &json!({"text":"Changed after save"})).unwrap();
        assert!(entry.inspect_document().unwrap()["texts"][0].as_str().unwrap().contains("Changed after save"));
        let mut reopened = Entry::new("Saved.pdf", &saved, 2).unwrap();
        reopened.command("pdf.updateText", &json!({"text":"Changed after reopen"})).unwrap();
        assert!(reopened.inspect_document().unwrap()["texts"][0].as_str().unwrap().contains("Changed after reopen"));
    }
}
