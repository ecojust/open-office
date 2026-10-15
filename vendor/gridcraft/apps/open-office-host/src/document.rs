//! Save receipts cover committed workbook changes and in-progress editor drafts.
use std::sync::Arc;

use gridcraft_engine::{DocState, Session, core::CellRef};
use gridcraft_model::{HfPage, Workbook};
use gridcraft_ui_egui::{Services, SheetApp};
use serde_json::{Value, json};

pub(crate) struct Entry {
    pub app: SheetApp,
    pub name: String,
    pub document_id: u32,
    pub revision: u32,
    pub memory: Option<egui::Memory>,
    pub notified: String,
    warnings: Vec<String>,
    observed: Arc<Workbook>,
    draft: Value,
}

pub(crate) fn clean_error(error: impl std::fmt::Display) -> String {
    error
        .to_string()
        .replace("GridCraft can't", "Open Office can't")
        .replace("GridCraft saves", "Open Office saves")
        .replace("GridCraft does not", "Open Office does not")
        .replace("GridCraft doesn't", "Open Office doesn't")
        .replace("GridCraft cannot", "Open Office cannot")
}

impl Entry {
    pub fn new(name: &str, bytes: &[u8], document_id: u32, services: Services) -> Result<Self, String> {
        // Reject unsupported imports by content as well as suffix, so an ODS renamed
        // .xlsx cannot silently lose formulas or formatting.
        if !matches!(
            gridcraft_engine::io::FileKind::from_path(name),
            Some(gridcraft_engine::io::FileKind::Xlsx | gridcraft_engine::io::FileKind::Csv | gridcraft_engine::io::FileKind::Tsv)
        ) {
            return Err("此工作区仅支持 XLSX、CSV 和 TSV；请先将其他格式转换后再打开。".into());
        }
        if matches!(
            gridcraft_xlsx::sniff(bytes),
            gridcraft_xlsx::Format::Ods
                | gridcraft_xlsx::Format::Xlsb
                | gridcraft_xlsx::Format::Xls
                | gridcraft_xlsx::Format::LegacyBinary
                | gridcraft_xlsx::Format::Encrypted
        ) {
            return Err("当前版本不支持此文件格式或加密工作簿；原文件保持不变。".into());
        }
        let (workbook, warnings) =
            if bytes.is_empty() { (Workbook::new(), Vec::new()) } else { gridcraft_engine::io::open_bytes(name, bytes).map_err(clean_error)? };
        if workbook.vba_project.is_some() {
            return Err("当前版本不支持含 VBA 宏的工作簿；原文件保持不变。".into());
        }
        let mut session = Session::new();
        session.prefs.user_name = "Open Office User".into();
        session.add_document(DocState::new(workbook, None, name.to_owned()));
        let observed = session.doc().map_err(clean_error)?.wb.clone();
        let mut app = SheetApp::new(session, services);
        app.ui.language = gridcraft_ui_egui::i18n::Language::Zh;
        app.grid.autosave = false;
        Ok(Self {
            app,
            name: name.to_owned(),
            document_id,
            revision: 1,
            memory: None,
            notified: String::new(),
            warnings: warnings.into_iter().map(clean_error).collect(),
            observed,
            draft: Value::Null,
        })
    }

    fn pending_draft(&self) -> Value {
        json!({
            "pendingInput": self.app.has_pending_input(),
            "cell": self.app.editor.as_ref().map(|e| json!([e.sheet, e.cell.a1(), e.text, e.completion])),
            "textBox": self.app.text_box_editor.as_ref().map(|e| json!([e.id, e.text])),
            "headerFooter": self.app.grid.hf_edit.as_ref().map(|e| json!([e.sheet, e.footer, e.kind.id(), e.texts]))
        })
    }

    pub fn has_draft(&self) -> bool {
        self.app.has_pending_input() || self.app.editor.is_some() || self.app.text_box_editor.is_some() || self.app.grid.hf_edit.is_some()
    }

    fn cell_draft_unchanged(&self) -> bool {
        self.app.editor.as_ref().is_some_and(|edit| {
            // English is also the formula syntax for Chinese and most UI languages. A
            // localized formula remains conservatively dirty until the editor canonicalizes it.
            edit.locale == gridcraft_engine::formula::FormulaLocale::En
                && edit.completion.is_none()
                && self.app.session.active().is_some_and(|doc| {
                    doc.wb.sheet(edit.sheet).is_some_and(|sheet| edit.text == gridcraft_engine::display::edit_text(&doc.wb, sheet, edit.cell))
                })
        })
    }

    pub fn dirty(&self) -> bool {
        self.app.has_pending_input()
            || (self.app.editor.is_some() && !self.cell_draft_unchanged())
            || self.app.text_box_editor.is_some()
            || self.app.grid.hf_edit.is_some()
            || self.app.session.active().is_some_and(DocState::is_dirty)
    }

    pub fn sync(&mut self) -> Result<(), String> {
        let workbook = self.app.session.doc().map_err(clean_error)?.wb.clone();
        let draft = self.pending_draft();
        if !Arc::ptr_eq(&self.observed, &workbook) || self.draft != draft {
            self.revision = self.revision.checked_add(1).ok_or("workbook revision exhausted")?;
            self.observed = workbook;
            self.draft = draft;
        }
        Ok(())
    }

    /// Flush all text editors. An invalid cell/formula/validation keeps its draft and returns
    /// an error; callers must not export an older workbook or clear the dirty flag.
    pub fn commit_pending(&mut self) -> Result<(), String> {
        if self.app.has_pending_input() {
            return Err("请等待当前输入处理完成后再保存。".into());
        }
        if self.cell_draft_unchanged() {
            self.app.cancel_edit();
        }
        if !self.app.commit_edit(0, 0, false, false) {
            self.sync()?;
            return Err(self.app.message.as_ref().map(|(_, message)| clean_error(message)).unwrap_or_else(|| "请先完成当前单元格输入。".into()));
        }
        self.app.commit_text_box_edit().map_err(clean_error)?;
        if let Some(edit) = self.app.grid.hf_edit.as_ref() {
            let key = match (edit.kind, edit.footer) {
                (HfPage::Odd, false) => "header",
                (HfPage::Odd, true) => "footer",
                (HfPage::Even, false) => "evenHeader",
                (HfPage::Even, true) => "evenFooter",
                (HfPage::First, false) => "firstHeader",
                (HfPage::First, true) => "firstFooter",
            };
            let print = &gridcraft_engine::cmd::print::join_header_footer;
            let spec = print(&edit.texts.clone().map(|text| gridcraft_engine::cmd::print::fields_to_codes(&text)));
            self.app.run("pageLayout.headerFooter", json!({"sheet":edit.sheet, key:spec})).map_err(clean_error)?;
            gridcraft_ui_egui::paper_view::cancel(&mut self.app);
        }
        self.app.store_view_state();
        self.sync()
    }

    pub fn matches(&self, document_id: f64, revision: f64) -> bool {
        f64::from(self.document_id) == document_id && f64::from(self.revision) == revision
    }

    pub fn can_close(&mut self, document_id: f64, revision: f64, force: bool) -> Result<bool, String> {
        self.sync()?;
        // Explicitly confirmed discard drops the whole session, including invalid drafts and
        // queued input. It must not require a successful commit, but still needs a current receipt.
        Ok(self.matches(document_id, revision) && (force || !self.dirty()))
    }

    pub fn mark_saved(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.has_draft() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        let doc = self.app.session.doc_mut().map_err(clean_error)?;
        doc.saved = doc.wb.clone();
        Ok(true)
    }

    pub fn discard(&mut self, document_id: f64, revision: f64) -> Result<bool, String> {
        self.sync()?;
        if self.app.has_pending_input() || !self.matches(document_id, revision) {
            return Ok(false);
        }
        self.app.cancel_edit();
        self.app.cancel_text_box_edit();
        gridcraft_ui_egui::paper_view::cancel(&mut self.app);
        let doc = self.app.session.doc_mut().map_err(clean_error)?;
        doc.wb = doc.saved.clone();
        doc.calc.rebuild(&doc.wb);
        doc.undo.clear();
        doc.redo.clear();
        doc.selection = Default::default();
        self.app.after_engine();
        self.sync()?;
        Ok(true)
    }

    pub fn export(&mut self, format: &str) -> Result<Vec<u8>, String> {
        self.commit_pending()?;
        match format {
            "xlsx" | "csv" | "tsv" => {
                gridcraft_engine::io::save_bytes(&self.app.session.doc().map_err(clean_error)?.wb, &format!("workbook.{format}")).map_err(clean_error)
            }
            "pdf" => {
                let result = self.app.session.run("file.exportPdf", json!({"sheets":"all"})).map_err(clean_error)?;
                result
                    .get("base64")
                    .and_then(Value::as_str)
                    .and_then(gridcraft_engine::io::base64_decode)
                    .ok_or_else(|| "PDF 导出没有返回有效数据。".into())
            }
            _ => Err("export format must be xlsx, csv, tsv, or pdf".into()),
        }
    }

    pub fn snapshot(&mut self, id: &str, ctx: Option<&egui::Context>) -> Result<Value, String> {
        self.sync()?;
        let doc = self.app.session.doc().map_err(clean_error)?;
        let mut ui = ctx.map(|ctx| gridcraft_ui_egui::control::inspect(&self.app, ctx)).unwrap_or(Value::Null);
        if let (Some(object), Some(geo), Some(sheet)) = (ui.as_object_mut(), self.app.grid.geo.as_ref(), doc.wb.active()) {
            let mut cells = Vec::new();
            // Actual painted grid geometry, bounded to a useful diagnostic viewport.
            let start_row = geo.row_at(sheet, geo.cells.top());
            let start_col = geo.col_at(sheet, geo.cells.left());
            let rows = (0..geo.fr.min(20)).chain(start_row..start_row.saturating_add(20).min(gridcraft_engine::core::MAX_ROWS));
            let cols: Vec<_> = (0..geo.fc.min(12)).chain(start_col..start_col.saturating_add(12).min(gridcraft_engine::core::MAX_COLS)).collect();
            for row in rows {
                for col in &cols {
                    let cell = CellRef::new(row, *col);
                    let rect = geo.screen_cell_rect(sheet, cell);
                    if rect.intersects(geo.cells) && rect.width() > 0.0 && rect.height() > 0.0 {
                        cells.push(json!({"address":cell.a1(),"rect":[rect.left(),rect.top(),rect.width(),rect.height()]}));
                    }
                }
            }
            object.insert(
                "visibleCells".into(),
                json!(cells.iter().map(|cell| json!({"cell":cell["address"],"rect":cell["rect"]})).collect::<Vec<_>>()),
            );
            object.insert("cellRects".into(), json!(cells));
        }
        Ok(json!({
            "sessionId":id,"name":self.name,"documentId":self.document_id,"revision":self.revision,
            "dirty":self.dirty(),"canUndo":!doc.undo.is_empty(),"canRedo":!doc.redo.is_empty(),
            "selection":doc.selection,"activeSheet":doc.wb.active_sheet,
            "sheets":doc.wb.sheets.iter().enumerate().map(|(index,sheet)| json!({"index":index,"name":sheet.name,"visibility":sheet.visibility,"hidden":sheet.visibility != gridcraft_model::Visibility::Visible})).collect::<Vec<_>>(),
            "warnings":self.warnings,"ui":ui
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> Entry {
        Entry::new("Book.xlsx", &[], 1, Services::default()).unwrap()
    }

    #[test]
    fn pending_input_exports_formula_and_rejects_stale_save_acknowledgement() {
        let mut entry = blank();
        entry.app.run("cell.set", json!({"cell":"A1","input":"2"})).unwrap();
        entry.app.run("selection.set", json!({"range":"B1"})).unwrap();
        entry.app.begin_edit(Some("=A1*3".into()), false);
        let stale = entry.snapshot("one", None).unwrap();
        assert!(entry.dirty());
        let bytes = entry.export("xlsx").unwrap();
        let (workbook, _) = gridcraft_engine::io::open_bytes("saved.xlsx", &bytes).unwrap();
        let cell = workbook.active().unwrap().cell(CellRef::new(0, 1)).unwrap();
        assert_eq!(cell.value, gridcraft_engine::core::Value::Number(6.0));
        assert!(cell.formula.is_some());
        assert!(entry.dirty(), "export is not a save acknowledgement");
        assert!(!entry.mark_saved(1.0, stale["revision"].as_f64().unwrap()).unwrap());
        let current = entry.snapshot("one", None).unwrap();
        assert!(entry.mark_saved(1.0, current["revision"].as_f64().unwrap()).unwrap());
        assert!(!entry.dirty());
        entry.app.run("cell.set", json!({"cell":"A1","input":"4"})).unwrap();
        assert!(!entry.mark_saved(1.0, current["revision"].as_f64().unwrap()).unwrap());
    }

    #[test]
    fn malformed_import_does_not_modify_existing_workbook() {
        let mut entry = blank();
        entry.app.run("cell.set", json!({"cell":"A1","input":"keep me"})).unwrap();
        let before = entry.export("xlsx").unwrap();
        assert!(Entry::new("bad.xlsx", b"PK\x03\x04broken", 2, Services::default()).is_err());
        assert_eq!(entry.export("xlsx").unwrap(), before);
    }

    #[test]
    fn invalid_formula_draft_blocks_export_and_remains_dirty() {
        let mut entry = blank();
        entry.app.begin_edit(Some("=1+".into()), false);
        assert!(entry.export("xlsx").is_err());
        assert!(entry.app.editor.is_some());
        assert!(entry.dirty());
        assert!(!entry.mark_saved(1.0, f64::from(entry.revision)).unwrap());
    }

    #[test]
    fn inspecting_an_unchanged_cell_does_not_create_unsaved_changes() {
        let mut entry = blank();
        entry.app.begin_edit(None, false);
        assert!(!entry.dirty());
        entry.commit_pending().unwrap();
        assert!(!entry.dirty());
        assert!(entry.app.session.doc().unwrap().undo.is_empty());
    }

    #[test]
    fn confirmed_close_can_discard_queued_input_without_committing_it() {
        let mut entry = blank();
        entry.app.begin_edit(Some("=1+".into()), false);
        entry.app.synthetic.push_back(vec![egui::Event::Text("未提交".into())]);
        let receipt = entry.snapshot("one", None).unwrap();
        let revision = receipt["revision"].as_f64().unwrap();
        assert!(entry.app.has_pending_input());
        assert!(!entry.can_close(1.0, revision, false).unwrap());
        assert!(!entry.can_close(1.0, revision - 1.0, true).unwrap());
        assert!(entry.can_close(1.0, revision, true).unwrap());
        assert!(entry.app.editor.is_some(), "discard permission must not commit an invalid draft");
    }
}
