//! Save receipts cover committed workbook changes and in-progress editor drafts.
use std::sync::Arc;

use office_sheet_engine::{DocState, Session, core::CellRef};
use office_sheet_model::{HfPage, Workbook};
use office_sheet_ui_egui::{Services, SheetApp};
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
    error.to_string()
}

impl Entry {
    pub fn new(name: &str, bytes: &[u8], document_id: u32, services: Services) -> Result<Self, String> {
        // Reject unsupported imports by content as well as suffix, so an ODS renamed
        // .xlsx cannot silently lose formulas or formatting.
        if !matches!(
            office_sheet_engine::io::FileKind::from_path(name),
            Some(office_sheet_engine::io::FileKind::Xlsx | office_sheet_engine::io::FileKind::Csv | office_sheet_engine::io::FileKind::Tsv)
        ) {
            return Err("此工作区仅支持 XLSX、CSV 和 TSV；请先将其他格式转换后再打开。".into());
        }
        if matches!(
            office_sheet_xlsx::sniff(bytes),
            office_sheet_xlsx::Format::Ods
                | office_sheet_xlsx::Format::Xlsb
                | office_sheet_xlsx::Format::Xls
                | office_sheet_xlsx::Format::LegacyBinary
                | office_sheet_xlsx::Format::Encrypted
        ) {
            return Err("当前版本不支持此文件格式或加密工作簿；原文件保持不变。".into());
        }
        let (workbook, warnings) =
            if bytes.is_empty() { (Workbook::new(), Vec::new()) } else { office_sheet_engine::io::open_bytes(name, bytes).map_err(clean_error)? };
        if workbook.vba_project.is_some() {
            return Err("当前版本不支持含 VBA 宏的工作簿；原文件保持不变。".into());
        }
        let mut session = Session::new();
        session.prefs.user_name = "Open Office User".into();
        session.add_document(DocState::new(workbook, None, name.to_owned()));
        let observed = session.doc().map_err(clean_error)?.wb.clone();
        let mut app = SheetApp::new(session, services);
        app.ui.language = office_sheet_ui_egui::i18n::Language::Zh;
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

    /// Background saves must leave even unchanged, still-open editors alone.
    pub fn background_export_ready(&self) -> bool {
        !self.has_draft()
            && self.app.session.mode == office_sheet_engine::Mode::Ready
            && self.app.dialog.is_none()
            && self.app.message.is_none()
            && self.app.backstage.is_none()
    }

    fn cell_draft_unchanged(&self) -> bool {
        self.app.editor.as_ref().is_some_and(|edit| {
            // English is also the formula syntax for Chinese and most UI languages. A
            // localized formula remains conservatively dirty until the editor canonicalizes it.
            edit.locale == office_sheet_engine::formula::FormulaLocale::En
                && edit.completion.is_none()
                && self.app.session.active().is_some_and(|doc| {
                    doc.wb.sheet(edit.sheet).is_some_and(|sheet| edit.text == office_sheet_engine::display::edit_text(&doc.wb, sheet, edit.cell))
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
            let print = &office_sheet_engine::cmd::print::join_header_footer;
            let spec = print(&edit.texts.clone().map(|text| office_sheet_engine::cmd::print::fields_to_codes(&text)));
            self.app.run("pageLayout.headerFooter", json!({"sheet":edit.sheet, key:spec})).map_err(clean_error)?;
            office_sheet_ui_egui::paper_view::cancel(&mut self.app);
        }
        self.app.store_view_state();
        self.sync()
    }

    pub fn matches(&self, document_id: f64, revision: f64) -> bool {
        f64::from(self.document_id) == document_id && f64::from(self.revision) == revision
    }

    pub fn trusted_double_click(&mut self, document_id: f64, ctx: &egui::Context, css_pos: egui::Pos2, modifiers: bool) -> bool {
        let zoom = ctx.zoom_factor();
        if f64::from(self.document_id) != document_id || !css_pos.is_finite() || !zoom.is_finite() || zoom <= 0.0 {
            return false;
        }
        // eframe's mouse input divides local CSS pixels by interface zoom only.
        // Device pixel ratio is already accounted for by the canvas renderer.
        office_sheet_ui_egui::grid::browser_double_click(&mut self.app, ctx, css_pos / zoom, modifiers)
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
        office_sheet_ui_egui::paper_view::cancel(&mut self.app);
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
                office_sheet_engine::io::save_bytes(&self.app.session.doc().map_err(clean_error)?.wb, &format!("workbook.{format}"))
                    .map_err(clean_error)
            }
            "pdf" => {
                let result = self.app.session.run("file.exportPdf", json!({"sheets":"all"})).map_err(clean_error)?;
                result
                    .get("base64")
                    .and_then(Value::as_str)
                    .and_then(office_sheet_engine::io::base64_decode)
                    .ok_or_else(|| "PDF 导出没有返回有效数据。".into())
            }
            _ => Err("export format must be xlsx, csv, tsv, or pdf".into()),
        }
    }

    pub fn snapshot(&mut self, id: &str, ctx: Option<&egui::Context>) -> Result<Value, String> {
        self.sync()?;
        let doc = self.app.session.doc().map_err(clean_error)?;
        let mut ui = ctx.map(|ctx| office_sheet_ui_egui::control::inspect(&self.app, ctx)).unwrap_or(Value::Null);
        if let (Some(object), Some(geo), Some(sheet)) = (ui.as_object_mut(), self.app.grid.geo.as_ref(), doc.wb.active()) {
            let mut cells = Vec::new();
            // Actual painted grid geometry, bounded to a useful diagnostic viewport.
            let start_row = geo.row_at(sheet, geo.cells.top());
            let start_col = geo.col_at(sheet, geo.cells.left());
            let rows = (0..geo.fr.min(20)).chain(start_row..start_row.saturating_add(20).min(office_sheet_engine::core::MAX_ROWS));
            let cols: Vec<_> = (0..geo.fc.min(12)).chain(start_col..start_col.saturating_add(12).min(office_sheet_engine::core::MAX_COLS)).collect();
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
            "backgroundExportReady":self.background_export_ready(),
            "dirty":self.dirty(),"canUndo":!doc.undo.is_empty(),"canRedo":!doc.redo.is_empty(),
            "selection":doc.selection,"activeSheet":doc.wb.active_sheet,
            "sheets":doc.wb.sheets.iter().enumerate().map(|(index,sheet)| json!({"index":index,"name":sheet.name,"visibility":sheet.visibility,"hidden":sheet.visibility != office_sheet_model::Visibility::Visible})).collect::<Vec<_>>(),
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
    fn browser_double_click_checks_document_identity_and_uses_css_interface_zoom_once() {
        let mut entry = Entry::new("Book.xlsx", &[], 17, Services { embedded_editor: true, ..Default::default() }).unwrap();
        let ctx = egui::Context::default();
        entry.app.ui.interface_scale = 150;
        ctx.set_zoom_factor(1.5);
        entry.app.run("selection.set", json!({"cell":"D6"})).unwrap();
        for _ in 0..5 {
            let mut output = ctx.run_ui(
                egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1600.0, 900.0))), ..Default::default() },
                |ui| {
                    entry.app.logic(ui.ctx());
                    entry.app.ui(ui);
                },
            );
            output.textures_delta.clear();
        }
        let cell = CellRef::new(5, 3);
        entry.app.grid.last_click = Some(cell);
        let doc = entry.app.session.active().unwrap();
        let pos = entry.app.grid.geo.as_ref().unwrap().screen_cell_rect(doc.wb.active().unwrap(), cell).center();
        let css_pos = pos * ctx.zoom_factor();
        let workbook = doc.wb.clone();
        let before = entry.snapshot("first", Some(&ctx)).unwrap();
        assert!(!entry.trusted_double_click(18.0, &ctx, css_pos, false));
        assert!(!entry.trusted_double_click(f64::NAN, &ctx, css_pos, false));
        assert!(!entry.trusted_double_click(17.0, &ctx, css_pos, true));
        assert_eq!(entry.snapshot("first", Some(&ctx)).unwrap(), before);
        assert!(entry.trusted_double_click(17.0, &ctx, css_pos, false));
        assert_eq!(entry.app.editor.as_ref().unwrap().cell, cell);
        assert_eq!(entry.app.session.mode, office_sheet_engine::Mode::Edit);
        assert!(Arc::ptr_eq(&workbook, &entry.app.session.active().unwrap().wb));
        assert!(!entry.dirty(), "opening the existing cell must not dirty its workbook");
    }

    #[test]
    fn background_readiness_keeps_unchanged_cell_and_header_editors_open() {
        let mut entry = blank();
        assert!(entry.background_export_ready());
        entry.app.begin_edit(None, false);
        let before = entry.pending_draft();
        assert_eq!(entry.snapshot("one", None).unwrap()["backgroundExportReady"], false);
        assert!(entry.app.editor.is_some());
        assert_eq!(entry.pending_draft(), before);
        entry.app.cancel_edit();
        assert!(entry.background_export_ready());

        let sheet = entry.app.session.doc().unwrap().wb.active().unwrap().clone();
        office_sheet_ui_egui::paper_view::begin(&mut entry.app, 0, &sheet, (0, 0), office_sheet_engine::paper::HfZone { footer: false, section: 1 });
        // Header/footer editing is in-place and does not switch the cell mode.
        assert_eq!(entry.app.session.mode, office_sheet_engine::Mode::Ready);
        assert!(entry.app.dialog.is_none());
        entry.app.ui.ribbon_tab = "Home".into();
        assert!(!entry.background_export_ready());
        assert!(entry.app.grid.hf_edit.is_some());
        office_sheet_ui_egui::paper_view::cancel(&mut entry.app);
        assert!(entry.background_export_ready());

        entry.app.message = Some(("Validation".into(), "Keep editing".into()));
        assert!(!entry.background_export_ready());
        entry.app.message = None;
        entry.app.open_dialog("formatCells", json!({}));
        assert!(entry.app.dialog.is_some());
        assert!(!entry.background_export_ready());
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
        let (workbook, _) = office_sheet_engine::io::open_bytes("saved.xlsx", &bytes).unwrap();
        let cell = workbook.active().unwrap().cell(CellRef::new(0, 1)).unwrap();
        assert_eq!(cell.value, office_sheet_engine::core::Value::Number(6.0));
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
