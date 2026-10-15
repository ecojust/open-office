//! Versioned document sessions. Exporting bytes is deliberately not a save acknowledgement.
use deckcraft_engine::{DocState, Session};
use deckcraft_model::Presentation;
use deckcraft_ui_egui::{Services, SlideApp};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) struct Entry {
    pub app: SlideApp,
    pub name: String,
    pub document_id: u32,
    pub revision: u32,
    pub memory: Option<egui::Memory>,
    pub notified: String,
    observed: Arc<Presentation>,
    draft: Value,
}

pub(crate) fn clean_error(error: impl std::fmt::Display) -> String {
    error.to_string().replace("DeckCraft", "Open Office").replace("deckcraft", "presentation")
}

fn validate_package(bytes: &[u8]) -> Result<(), String> {
    let mut package = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(clean_error)?;
    if package.len() > 10_000 {
        return Err("演示文稿包含过多部件。".into());
    }
    let mut expanded = 0u64;
    let mut presentation = false;
    for index in 0..package.len() {
        let file = package.by_index(index).map_err(clean_error)?;
        expanded = expanded.checked_add(file.size()).ok_or("演示文稿解压大小超出限制。")?;
        if expanded > 256 * 1024 * 1024 {
            return Err("演示文稿解压后不能超过 256 MiB。".into());
        }
        let name = file.name().to_ascii_lowercase();
        if name == "ppt/presentation.xml" {
            presentation = true;
        }
        if name.ends_with("vbaproject.bin") || name.starts_with("ppt/activex/") {
            return Err("暂不支持包含宏或 ActiveX 控件的演示文稿；原文件保持不变。".into());
        }
    }
    if !presentation {
        return Err("请选择有效的 PPTX 演示文稿。".into());
    }
    Ok(())
}

impl Entry {
    pub fn new(name: &str, bytes: &[u8], document_id: u32, services: Services) -> Result<Self, String> {
        let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(), "pptx" | "potx" | "ppsx") {
            return Err("演示文稿工作区支持 PPTX、POTX 和 PPSX；请先将旧格式转换为 PPTX。".into());
        }
        let mut session = Session::new();
        if bytes.is_empty() {
            session.execute("file.new", &json!({})).map_err(clean_error)?;
        } else {
            if deckcraft_pptx::is_encrypted(bytes) {
                return Err("暂不支持密码保护的演示文稿。".into());
            }
            validate_package(bytes)?;
            let presentation = deckcraft_engine::cmd::file::open_presentation(name, bytes).map_err(clean_error)?;
            deckcraft_engine::cmd::file::add_opened(&mut session, name, None, presentation);
        }
        session.doc_mut().map_err(clean_error)?.title = name.to_owned();
        let observed = session.doc().map_err(clean_error)?.doc.clone();
        let app = SlideApp::new(session, services);
        let draft = app.embedding_draft();
        Ok(Self { app, name: name.to_owned(), document_id, revision: 1, memory: None, notified: String::new(), observed, draft })
    }

    pub fn dirty(&self) -> bool {
        self.app.has_pending_input() || self.app.has_notes_draft() || self.app.session.active().is_some_and(DocState::is_dirty)
    }

    pub fn sync(&mut self) -> Result<(), String> {
        let document = self.app.session.doc().map_err(clean_error)?.doc.clone();
        let draft = self.app.embedding_draft();
        if !Arc::ptr_eq(&document, &self.observed) || self.draft != draft {
            self.revision = self.revision.checked_add(1).ok_or("presentation revision exhausted")?;
            self.observed = document;
            self.draft = draft;
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
    pub fn can_close(&mut self, document_id: f64, revision: f64, force: bool) -> Result<bool, String> {
        self.sync()?;
        Ok(self.matches(document_id, revision) && (force || !self.dirty()))
    }
    pub fn mark_saved(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.app.has_pending_input() || self.app.has_notes_draft() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        let doc = self.app.session.doc_mut().map_err(clean_error)?;
        doc.saved_doc = doc.doc.clone();
        Ok(true)
    }
    pub fn discard(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.app.has_pending_input() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        self.app.discard_pending();
        let doc = self.app.session.doc_mut().map_err(clean_error)?;
        doc.doc = doc.saved_doc.clone();
        doc.history = Default::default();
        doc.selection = Default::default();
        doc.interaction = None;
        doc.composition = None;
        self.sync()?;
        Ok(true)
    }
    pub fn export(&mut self, format: &str) -> Result<Vec<u8>, String> {
        self.commit_pending()?;
        let doc = &self.app.session.doc().map_err(clean_error)?.doc;
        match format {
            "pptx" => deckcraft_pptx::export(doc).map_err(clean_error),
            "pdf" => deckcraft_pdf::export(doc, &Default::default()).map_err(clean_error),
            _ => Err("export format must be pptx or pdf".into()),
        }
    }
    pub fn snapshot(&mut self, id: &str, ctx: Option<&egui::Context>) -> Result<Value, String> {
        self.sync()?;
        let doc = self.app.session.doc().map_err(clean_error)?;
        let ui = ctx.map(|ctx| deckcraft_ui_egui::control::inspect(&self.app, ctx)).unwrap_or(Value::Null);
        Ok(json!({"sessionId":id,"name":self.name,"documentId":self.document_id,"revision":self.revision,
            "dirty":self.dirty(),"canUndo":!doc.history.undo.is_empty(),"canRedo":!doc.history.redo.is_empty(),
            "selection":doc.selection,"activeSlide":doc.selection.slide,
            "slides":doc.doc.slides.iter().enumerate().map(|(index,slide)|json!({"id":slide.id,"index":index,"name":slide.title(),"hidden":slide.hidden})).collect::<Vec<_>>(),
            "warnings":[],"ui":ui}))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn blank() -> Entry {
        Entry::new("Presentation.pptx", &[], 1, Services::default()).unwrap()
    }
    #[test]
    fn pptx_round_trip_preserves_unicode_and_formatting_without_clearing_dirty() {
        let mut entry = blank();
        entry.app.run("insert.textBox", json!({"rect":[80,90,500,90],"text":"Open Office 演示😀"})).unwrap();
        entry.app.run("format.bold", json!({"on":true})).unwrap();
        let snapshot = entry.snapshot("one", None).unwrap();
        let bytes = entry.export("pptx").unwrap();
        assert!(entry.dirty());
        let doc = deckcraft_pptx::import(&bytes).unwrap();
        let text = doc.slides.iter().flat_map(|s| &s.shapes).filter_map(|s| s.text.as_ref()).map(|t| t.text()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("Open Office 演示😀"));
        let body = doc
            .slides
            .iter()
            .flat_map(|slide| &slide.shapes)
            .filter_map(|shape| shape.text.as_ref())
            .find(|body| body.text() == "Open Office 演示😀")
            .unwrap();
        assert!(body.paragraphs.iter().flat_map(|paragraph| &paragraph.runs).all(|run| run.props.bold == Some(true)));
        assert!(entry.mark_saved(1.0, snapshot["revision"].as_f64().unwrap()).unwrap());
        assert!(!entry.dirty());
        entry.app.run("slide.new", json!({})).unwrap();
        assert!(!entry.mark_saved(1.0, snapshot["revision"].as_f64().unwrap()).unwrap());
    }
    #[test]
    fn failed_import_does_not_change_existing_document() {
        let mut entry = blank();
        entry.app.run("insert.textBox", json!({"text":"retain me"})).unwrap();
        let before = entry.app.run("document.inspect", json!({})).unwrap();
        assert!(Entry::new("Broken.pptx", b"broken", 2, Services::default()).is_err());
        assert_eq!(before, entry.app.run("document.inspect", json!({})).unwrap());
        assert!(Entry::new("Legacy.ppt", b"", 2, Services::default()).is_err());
    }
    #[test]
    fn composition_must_finish_before_save_receipt_or_export() {
        let mut entry = blank();
        let id = entry.app.run("insert.textBox", json!({"text":""})).unwrap()["id"].clone();
        entry.app.run("text.edit", json!({"id":id})).unwrap();
        entry.app.run("text.compose", json!({"text":"演"})).unwrap();
        let old = entry.snapshot("one", None).unwrap();
        assert!(entry.export("pptx").is_err());
        assert!(!entry.mark_saved(1.0, old["revision"].as_f64().unwrap()).unwrap());
        entry.app.run("text.commit", json!({"text":"演示"})).unwrap();
        assert!(entry.export("pptx").is_ok());
        assert!(!entry.mark_saved(1.0, old["revision"].as_f64().unwrap()).unwrap());
    }
    #[test]
    fn independent_sessions_and_current_receipt_required_to_close() {
        let mut first = blank();
        let mut second = Entry::new("Other.pptx", &[], 2, Services::default()).unwrap();
        let snapshot = first.snapshot("one", None).unwrap();
        first.app.run("slide.new", json!({})).unwrap();
        assert_eq!(second.snapshot("two", None).unwrap()["slides"].as_array().unwrap().len(), 1);
        assert!(!first.can_close(1.0, snapshot["revision"].as_f64().unwrap(), true).unwrap());
        let current = first.snapshot("one", None).unwrap()["revision"].as_f64().unwrap();
        assert!(!first.can_close(1.0, current, false).unwrap());
        assert!(first.can_close(1.0, current, true).unwrap());
    }
    #[test]
    fn pdf_export_is_real_and_does_not_acknowledge_save() {
        let mut entry = blank();
        entry.app.run("insert.textBox", json!({"text":"Open Office PDF"})).unwrap();
        let pdf = entry.export("pdf").unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(entry.dirty());
    }
}
