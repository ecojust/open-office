//! Explicit removal actions wait for confirmation against the same document revision.

use office_pdf_engine::{DocId, Edit, ImageEdit};

use crate::{OfficePdfApp, fill_sign::SavedSig, stamps_ui::CustomStamp, widgets};

pub(crate) enum Removal {
    Edit(Box<Edit>),
    Signature { initials: bool, saved: SavedSig },
    Stamp { index: usize, saved: CustomStamp },
}

pub(crate) struct Pending {
    document: Option<(DocId, u64)>,
    action: Removal,
    pub label: String,
}

fn needs_confirmation(edit: &Edit) -> bool {
    let mut pending = vec![edit];
    while let Some(edit) = pending.pop() {
        match edit {
            Edit::EditPageImage { change: ImageEdit::Delete, .. }
            | Edit::DeletePages { .. }
            | Edit::DeleteAnnotation { .. }
            | Edit::DeleteBookmark { .. }
            | Edit::DeleteField { .. }
            | Edit::DeleteLink { .. }
            | Edit::RemoveLinks { .. }
            | Edit::RemoveMarks { .. }
            | Edit::ClearRedactions
            | Edit::ResetForm { .. }
            | Edit::RemoveProtection
            | Edit::SetDocumentScript { script: None, .. } => return true,
            Edit::Batch { edits, .. } => pending.extend(edits.iter()),
            // Clearing text inside an editor is ordinary typing, committed by that editor.
            // Explicit added-content deletion is queued separately by the selection keyboard handler.
            _ => {}
        }
    }
    false
}

impl OfficePdfApp {
    fn request_removal(&mut self, action: Removal, label: String) {
        if self.pending_removal.is_some() {
            return;
        }
        self.pending_removal = Some(Pending {
            document: self.active_ids().and_then(|(_, id)| self.session.get(id).map(|doc| (id, doc.edit_generation()))),
            action,
            label,
        });
        if let Some(ctx) = &self.ctx {
            ctx.request_repaint();
        }
    }

    pub(crate) fn confirm_edit_removal(&mut self, edit: &Edit) -> bool {
        if !self.embedded || !needs_confirmation(edit) {
            return false;
        }
        let label = edit.label();
        self.request_removal(Removal::Edit(Box::new(edit.clone())), label.said(crate::i18n::tr(crate::i18n::current(), label.wording)));
        true
    }

    pub(crate) fn remove_selected_content(&mut self, page: usize, index: usize) {
        let edit = Edit::DeleteContent { page, index };
        if self.embedded {
            self.request_removal(Removal::Edit(Box::new(edit)), "删除选中的内容".into());
        } else {
            self.apply_edit(edit);
        }
    }

    pub(crate) fn remove_saved_signature(&mut self, initials: bool) {
        if !self.embedded {
            if initials {
                self.initials = None;
            } else {
                self.signature = None;
            }
            return;
        }
        if let Some(saved) = if initials { self.initials.clone() } else { self.signature.clone() } {
            self.request_removal(Removal::Signature { initials, saved }, if initials { "删除保存的首字母签名" } else { "删除保存的签名" }.into());
        }
    }

    pub(crate) fn remove_saved_stamp(&mut self, index: usize) {
        let Some(saved) = self.custom_stamps.get(index).cloned() else { return };
        if !self.embedded {
            self.custom_stamps.remove(index);
            self.quick_tool = crate::QuickTool::Select;
            return;
        }
        self.request_removal(Removal::Stamp { index, saved }, "删除保存的图章".into());
    }

    pub(crate) fn resolve_removal(&mut self, confirmed: bool) -> Result<(), String> {
        let Some(pending) = self.pending_removal.take() else { return Ok(()) };
        if !confirmed {
            return Ok(());
        }
        let current = self.active_ids().and_then(|(_, id)| self.session.get(id).map(|doc| (id, doc.edit_generation())));
        if current != pending.document {
            return Err("文稿已变化，请重新选择要删除的内容".into());
        }
        match pending.action {
            Removal::Edit(edit) => {
                if !self.apply_edit_confirmed(*edit) {
                    return Err("删除未完成，原内容已保留".into());
                }
            }
            Removal::Signature { initials, saved } => {
                let target = if initials { &mut self.initials } else { &mut self.signature };
                if target.as_ref() != Some(&saved) {
                    return Err("保存的签名已变化，请重新选择".into());
                }
                *target = None;
                self.quick_tool = crate::QuickTool::Select;
            }
            Removal::Stamp { index, saved } => {
                if self.custom_stamps.get(index) != Some(&saved) {
                    return Err("图章列表已变化，请重新选择".into());
                }
                self.custom_stamps.remove(index);
                self.quick_tool = crate::QuickTool::Select;
            }
        }
        Ok(())
    }
}

pub(crate) fn show(app: &mut OfficePdfApp, ctx: &egui::Context) {
    let Some(pending) = &app.pending_removal else { return };
    let label = pending.label.clone();
    let mut choice = None;
    let modal = widgets::show_modal(ctx, "pdf-delete-confirmation", |ui| {
        ui.set_width((ctx.content_rect().width() - 64.0).clamp(200.0, 360.0));
        ui.heading("确认删除");
        ui.label(format!("确定要{label}吗？"));
        ui.label(egui::RichText::new("取消会保留当前内容。").small());
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if widgets::pill_button(ui, "取消", false).clicked() {
                choice = Some(false);
            }
            if widgets::pill_button(ui, "确认删除", true).clicked() {
                choice = Some(true);
            }
        });
    });
    if modal.should_close() {
        choice = Some(false);
    }
    if let Some(confirmed) = choice {
        if let Err(error) = app.resolve_removal(confirmed) {
            app.notify(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use office_pdf_engine::AddedText;

    fn document() -> OfficePdfApp {
        let mut app = OfficePdfApp::new();
        app.embedded = true;
        let bytes = app.session.create_blank(300.0, 400.0, 2).unwrap();
        app.open_bytes("Delete.pdf", None, bytes.as_ref().clone()).unwrap();
        app
    }

    #[test]
    fn deletion_waits_for_confirmation_and_blocks_background_save_and_shortcuts() {
        let mut app = document();
        let id = app.views[0].id;
        let generation = app.session.get(id).unwrap().edit_generation();
        assert!(!app.apply_edit(Edit::DeletePages { pages: vec![0] }));
        assert_eq!(app.session.get(id).unwrap().edit_generation(), generation);
        assert_eq!(app.session.get(id).unwrap().info.pages.len(), 2);
        assert!(app.modal_open());
        assert!(app.has_pending_input());
        assert!(!app.background_export_ready());
        assert!(app.commit_pending().is_err());
        assert!(!app.execute("page.rotate"));
        app.run_host_command("ui.delete.cancel", serde_json::Value::Null).unwrap();
        assert_eq!(app.session.get(id).unwrap().info.pages.len(), 2);
        assert!(!app.modal_open());
        assert!(!app.apply_edit(Edit::DeletePages { pages: vec![0] }));
        app.run_host_command("ui.delete.confirm", serde_json::Value::Null).unwrap();
        assert_eq!(app.session.get(id).unwrap().info.pages.len(), 1);
        assert!(app.execute("edit.undo"));
        assert_eq!(app.session.get(id).unwrap().info.pages.len(), 2);
    }

    #[test]
    fn a_stale_confirmation_never_deletes_from_a_changed_document() {
        let mut app = document();
        let id = app.views[0].id;
        app.apply_edit(Edit::DeletePages { pages: vec![0] });
        app.session.apply(id, Edit::RotatePages { pages: vec![0], degrees: 90 }).unwrap();
        assert!(app.resolve_removal(true).is_err());
        assert_eq!(app.session.get(id).unwrap().info.pages.len(), 2);
        assert!(app.pending_removal.is_none());
    }

    #[test]
    fn explicit_object_delete_confirms_but_clearing_an_open_text_editor_is_normal_editing() {
        let mut app = document();
        let id = app.views[0].id;
        assert!(app.apply_edit(Edit::AddText {
            page: 0,
            text: AddedText { rect: [30.0, 30.0, 200.0, 60.0], text: "Keep until confirmed".into(), ..Default::default() }
        }));
        app.remove_selected_content(0, 0);
        assert_eq!(app.session.get(id).unwrap().added().len(), 1);
        app.resolve_removal(false).unwrap();
        assert_eq!(app.session.get(id).unwrap().added().len(), 1);
        app.remove_selected_content(0, 0);
        app.resolve_removal(true).unwrap();
        assert!(app.session.get(id).unwrap().added().is_empty());
        assert!(app.execute("edit.undo"));
        assert!(app.apply_edit(Edit::DeleteContent { page: 0, index: 0 }));
        assert!(app.pending_removal.is_none());
        assert!(app.session.get(id).unwrap().added().is_empty());
    }

    #[test]
    fn image_removal_and_nested_batches_require_confirmation() {
        assert!(needs_confirmation(&Edit::EditPageImage { page: 0, index: 0, change: ImageEdit::Delete }));
        assert!(!needs_confirmation(&Edit::EditPageImage { page: 0, index: 0, change: ImageEdit::Rotate(90) }));
        assert!(needs_confirmation(&Edit::Batch {
            label: "Delete objects".into(),
            edits: vec![Edit::Batch { label: "Delete links".into(), edits: vec![Edit::DeletePages { pages: vec![0] }] }]
        }));
        // Ordinary deletion in a text editor does not open a second interaction.
        assert!(!needs_confirmation(&Edit::DeleteContent { page: 0, index: 0 }));
    }

    #[test]
    fn saved_signature_removal_keeps_the_library_until_confirmed() {
        let mut app = document();
        let signature = SavedSig::Drawn(vec![vec![[0.0, 0.0], [0.8, 0.2]]]);
        app.signature = Some(signature.clone());
        app.remove_saved_signature(false);
        assert_eq!(app.signature.as_ref(), Some(&signature));
        app.resolve_removal(false).unwrap();
        assert_eq!(app.signature.as_ref(), Some(&signature));
        app.remove_saved_signature(false);
        app.resolve_removal(true).unwrap();
        assert!(app.signature.is_none());
    }
}
