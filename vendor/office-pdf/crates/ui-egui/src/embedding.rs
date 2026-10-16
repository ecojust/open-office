//! In-process document surface used by the Open Office window.
//!
//! File ownership and save acknowledgements belong to the containing window. These hooks never
//! mark a document saved merely because bytes have been handed to JavaScript.

use serde_json::{Value, json};

use crate::{OfficePdfApp, control::Host};

pub(crate) fn is_embedded_context(ctx: &egui::Context) -> bool {
    ctx.data(|data| data.get_temp::<bool>(egui::Id::new("open-office-embedded"))).unwrap_or(false)
}

fn content_draft_changed(view: &crate::DocView, document: Option<&office_pdf_engine::Document>) -> bool {
    let Some(draft) = &view.content.draft else { return false };
    let Some(index) = draft.index else { return !draft.text.trim().is_empty() };
    // An existing item whose text was cleared commits a deletion, including whitespace-only
    // drafts. Opening an unchanged item, however, must not create a spurious unsaved prompt.
    if draft.text.trim().is_empty() {
        return true;
    }
    let old = document.and_then(|doc| doc.added().iter().filter(|item| item.page == draft.page).nth(index));
    let Some(office_pdf_engine::AddedContent::Text(old)) = old.map(|item| &item.content) else { return true };
    let updated = office_pdf_engine::AddedText { text: draft.text.trim_end().to_owned(), rect: draft.rect, ..draft.style.clone() };
    *old != updated
}

impl OfficePdfApp {
    /// Prepare this document for the shared canvas after another document used it.
    pub fn activate_host_context(&mut self, ctx: &egui::Context) {
        self.embedded = true;
        ctx.data_mut(|data| data.insert_temp(egui::Id::new("open-office-embedded"), true));
        self.language = "zh-hans".into();
        self.ctx = Some(ctx.clone());
        self.styled = false;
        self.fonts_ready = false;
        self.update_source = None;
        self.window_controls = None;
        self.integrated_titlebar = false;
        if self.left == crate::LeftPanel::AllTools {
            self.left_open = false;
        }
        crate::i18n::set_current(crate::i18n::Lang::from_pref(&self.language));
        ctx.request_repaint();
    }

    pub fn embedding_state(&self) -> Value {
        let mut state = Host::state(self);
        if let Some(object) = state.as_object_mut() {
            object.insert("author".into(), json!(self.comment_prefs.author));
            object.insert("backgroundExportReady".into(), json!(self.background_export_ready()));
            object.insert("toolbar".into(), json!(self.ctx.as_ref().map(crate::embedded_toolbar::drawn).unwrap_or_default()));
            object.insert("deletePrompt".into(), json!(self.pending_removal.as_ref().map(|pending| &pending.label)));
            object.insert(
                "commentDraft".into(),
                json!(self.unfinished_comment().map(|draft| json!({
                    "kind":format!("{:?}", draft.kind), "page":draft.page + 1, "text":draft.text, "orphaned":draft.orphaned,
                }))),
            );
            object.insert(
                "commentDraftDialog".into(),
                json!(self.comment_draft_dialog.as_ref().map(|dialog| json!({"confirmDiscard":dialog.confirm_discard,"error":dialog.error}))),
            );
        }
        state
    }

    /// Unlike dirty tracking, an empty/unchanged open editor also blocks a
    /// background export: committing it would end the user's editing session.
    pub fn background_export_ready(&self) -> bool {
        !self.embedding_composing
            && self.pending_removal.is_none()
            && self.comment_draft_dialog.is_none()
            && self.dialog.is_none()
            && !self.palette_open
            && self.password_prompt.is_none()
            && self.close_request.is_none()
            && self.progress_notice.is_none()
            && self.deferred_commands.is_empty()
            && self.views.iter().all(|view| {
                view.pending_edit.is_none()
                    && view.pending_action.is_none()
                    && view.content.draft.is_none()
                    && view.line_editor.is_none()
                    && view.forms.focus.is_none()
                    && view.fill_text.is_none()
                    && view.comments.composer.is_none()
                    && view.comments.reply.is_empty()
                    && view.comments.editing.is_none()
                    && view.comments.add_box.is_empty()
            })
    }

    /// Invoke existing editing commands without starting the optional network control server.
    pub fn run_host_command(&mut self, command: &str, params: Value) -> Result<Value, String> {
        match command {
            "ui.state" => Ok(self.embedding_state()),
            "ui.commands" => Ok(Host::commands(self)),
            "ui.dock" => Host::dock(self, false, &params),
            "ui.dock.reset" => Host::dock(self, true, &params),
            "ui.delete.confirm" => {
                self.resolve_removal(true)?;
                Ok(self.embedding_state())
            }
            "ui.delete.cancel" => {
                self.resolve_removal(false)?;
                Ok(self.embedding_state())
            }
            "ui.commentDraft.open" => {
                self.open_comment_drafts();
                Ok(self.embedding_state())
            }
            "ui.commentDraft.submit" => {
                self.submit_comment_draft()?;
                Ok(self.embedding_state())
            }
            "ui.commentDraft.discard" => {
                self.discard_comment_draft(params.get("confirmed").and_then(Value::as_bool).unwrap_or(false))?;
                Ok(self.embedding_state())
            }
            "ui.commentDraft.return" => {
                self.return_to_comment_draft();
                Ok(self.embedding_state())
            }
            _ => Host::command(self, command),
        }
    }

    pub(crate) fn observe_embedding_input(&mut self, events: &[egui::Event]) {
        for event in events {
            match event {
                egui::Event::Ime(egui::ImeEvent::Preedit { text, .. }) => self.embedding_composing = !text.is_empty(),
                egui::Event::Ime(egui::ImeEvent::Commit(_)) => self.embedding_composing = false,
                _ => {}
            }
        }
    }

    /// Draft content participates in the host's revision receipt, including formatting changes.
    /// Cursor movement, selection and view changes are intentionally absent.
    pub fn embedding_draft(&self) -> Value {
        let views: Vec<Value> = self
            .views
            .iter()
            .map(|view| {
                let form = view
                    .forms
                    .focus
                    .as_ref()
                    .filter(|focus| self.session.get(view.id).is_some_and(|doc| crate::forms_ui::draft_edit(focus, &doc.form).is_some()));
                json!({
                    "document": view.id.0,
                    // Queued media edits can contain megabytes of binary data. The presence
                    // bit blocks a save receipt until committed; the model generation then
                    // identifies its content without formatting the bytes on every frame.
                    "queued": view.pending_edit.is_some(),
                    "content": view.content.draft.as_ref().filter(|_| content_draft_changed(view, self.session.get(view.id))).map(|draft| json!({
                        "page": draft.page, "index": draft.index, "text": draft.text,
                        "rect": draft.rect, "style": format!("{:?}", draft.style),
                    })),
                    "line": view.line_editor.as_ref().filter(|line| line.has_changes()).map(|line| json!({
                        "page": line.page, "block": line.block, "text": line.text,
                        "style": format!("{:?}", line.style()),
                    })),
                    "form": form.map(|focus| json!({"name": focus.name, "text": focus.text, "picked": focus.picked})),
                    "fill": view.fill_text.as_ref().filter(|text| !text.text.trim().is_empty())
                        .map(|text| json!({"page": text.page, "at": text.at, "text": text.text, "size": text.size})),
                    "comment": view.comments.composer.as_ref().filter(|_| self.session.get(view.id).is_some_and(|doc| crate::comment_drafts::composer_changed(&view.comments, &doc.info)))
                        .map(|draft| json!({"page": draft.page, "at": draft.at, "text": draft.text})),
                    "commentReply": (!view.comments.reply.trim().is_empty()).then_some(&view.comments.reply),
                    "commentEdit": view.comments.editing.as_ref().filter(|_| self.session.get(view.id).is_some_and(|doc| crate::comment_drafts::editing_changed(&view.comments, &doc.info))),
                    "commentAdd": (!view.comments.add_box.trim().is_empty()).then_some(&view.comments.add_box),
                })
            })
            .collect();
        json!({"composing": self.embedding_composing, "views": views, "deletePrompt": self.pending_removal.as_ref().map(|pending| &pending.label)})
    }

    pub fn has_pending_input(&self) -> bool {
        self.embedding_composing
            || self.pending_removal.is_some()
            || self.views.iter().any(|view| {
                view.pending_edit.is_some()
                    || content_draft_changed(view, self.session.get(view.id))
                    || view.line_editor.as_ref().is_some_and(|line| line.has_changes())
                    || view
                        .forms
                        .focus
                        .as_ref()
                        .is_some_and(|focus| self.session.get(view.id).is_some_and(|doc| crate::forms_ui::draft_edit(focus, &doc.form).is_some()))
                    || view.fill_text.as_ref().is_some_and(|text| !text.text.trim().is_empty())
                    || self.session.get(view.id).is_some_and(|doc| crate::comment_drafts::has_changes(view, &doc.info))
            })
    }

    pub fn is_composing(&self) -> bool {
        self.embedding_composing
    }

    pub fn host_dirty(&self) -> bool {
        self.first_dirty().is_some() || self.has_pending_input()
    }

    /// Flush the live document editors before exporting. Rejected text stays available to fix.
    pub fn commit_pending(&mut self) -> Result<(), String> {
        if self.pending_removal.is_some() {
            return Err("请先确认或取消删除，再保存文稿".into());
        }
        if self.embedding_composing {
            return Err("请先确认输入法候选文字，再保存文稿".into());
        }
        let Some((index, id)) = self.active_ids() else { return Ok(()) };
        if self.unfinished_comment().is_some() {
            self.open_comment_drafts();
            return Err("还有未提交的批注，已打开草稿处理窗口；提交或确认放弃后即可保存文稿".into());
        }
        if !self.process_pending_edits() || !self.commit_typing_in(id) {
            return Err(self.toast.as_ref().map(|notice| notice.0.clone()).unwrap_or_else(|| "当前输入未通过验证，请修正后再保存".into()));
        }
        let line = self.views.get_mut(index).and_then(|view| view.line_editor.take());
        if let Some(line) = line
            && let Some(edit) = crate::edit_text_ui::finished_edit(line.clone())
            && !self.apply_edit(edit)
        {
            if let Some(view) = self.views.get_mut(index) {
                view.line_editor = Some(line);
            }
            return Err(self.toast.as_ref().map(|notice| notice.0.clone()).unwrap_or_else(|| "无法提交正文修改".into()));
        }
        let draft = self.views.get(index).and_then(|view| view.content.draft.clone());
        let added = self.session.get(id).map(|doc| doc.added().to_vec()).unwrap_or_default();
        let edit = self.views.get_mut(index).and_then(|view| view.content.finish_draft(&added));
        if let Some(edit) = edit
            && !self.apply_edit(edit)
        {
            if let Some(view) = self.views.get_mut(index) {
                view.content.draft = draft;
            }
            return Err(self.toast.as_ref().map(|notice| notice.0.clone()).unwrap_or_else(|| "无法提交新增文字".into()));
        }
        Ok(())
    }

    /// Called only after the containing window has confirmed discarding unsaved work.
    pub fn discard_pending(&mut self) {
        self.pending_removal = None;
        self.comment_draft_dialog = None;
        self.embedding_composing = false;
        self.deferred_commands.clear();
        for view in &mut self.views {
            view.pending_edit = None;
            view.pending_action = None;
            view.content.draft = None;
            view.line_editor = None;
            view.forms.focus = None;
            view.forms.committed = None;
            view.fill_text = None;
            view.comments.composer = None;
            view.comments.reply.clear();
            view.comments.editing = None;
            view.comments.add_box.clear();
        }
    }

    pub(crate) fn route_embedding_action(&mut self, command: &str) -> bool {
        if !self.embedded {
            return false;
        }
        let action = match command {
            "create.blank" => "new",
            "file.open" => "open",
            "file.save" => "save",
            "file.save_as" => "saveAs",
            "print.dialog" => "print",
            "file.close" => "close",
            _ => return false,
        };
        if let Some(callback) = self.host_action.as_mut() {
            callback(action);
        }
        true
    }

    pub(crate) fn embedding_command_blocked(&self, command: &str) -> bool {
        command.starts_with("view.theme")
            || command.starts_with("export.")
            || command.starts_with("actions.")
            || (command.starts_with("help.") && command != "help.shortcuts")
            || matches!(
                command,
                "file.open_recent"
                    | "file.clear_recent"
                    | "file.pin_folder"
                    | "file.close_all"
                    | "file.revert"
                    | "app.preferences"
                    | "create.file"
                    | "create.multiple"
                    | "create.multiple_separate"
                    | "create.images"
                    | "create.clipboard"
                    | "page.combine"
                    | "ocr.recognize_batch"
                    | "form.merge_data"
                    | "edit.image"
                    | "comment.attach"
                    | "comment.import"
                    | "comment.export"
                    | "form.import_data"
                    | "form.export_data"
                    | "measure.export"
                    | "page.extract"
                    | "page.split"
                    | "doc.compare"
                    | "sign.digital"
                    | "sign.certify"
                    | "sign.certify_invisible"
            )
            || (office_pdf_engine::catalog::TOOL_GROUPS
                .iter()
                .flat_map(|group| group.sections.iter())
                .flat_map(|section| section.items.iter())
                .any(|item| item.command == command && item.availability != office_pdf_engine::catalog::Availability::Ready)
                && !office_pdf_engine::catalog::TOOL_GROUPS
                    .iter()
                    .flat_map(|group| group.sections.iter())
                    .flat_map(|section| section.items.iter())
                    .any(|item| item.command == command && item.availability == office_pdf_engine::catalog::Availability::Ready))
    }

    pub(crate) fn embedding_command_visible(&self, command: &str) -> bool {
        !self.embedded
            || (!self.embedding_command_blocked(command)
                && !matches!(command, "create.blank" | "file.open" | "file.save" | "file.save_as" | "print.dialog" | "file.close"))
    }

    pub(crate) fn embedding_group_visible(&self, group: &office_pdf_engine::catalog::ToolGroup) -> bool {
        !self.embedded
            || (group.availability == office_pdf_engine::catalog::Availability::Ready
                && group.sections.iter().flat_map(|section| section.items.iter()).any(|item| self.embedding_command_visible(item.command)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    fn document() -> OfficePdfApp {
        let mut app = OfficePdfApp::new();
        app.embedded = true;
        let bytes = app.session.create_blank(595.0, 842.0, 1).unwrap();
        app.open_bytes("Document.pdf", None, bytes.as_ref().clone()).unwrap();
        app
    }

    #[test]
    fn shell_file_shortcuts_keep_the_live_document_and_do_not_mark_it_saved() {
        let mut app = document();
        let actions = Rc::new(RefCell::new(Vec::new()));
        let captured = Rc::clone(&actions);
        app.host_action = Some(Box::new(move |action| captured.borrow_mut().push(action.to_owned())));
        let id = app.views[0].id;
        for command in ["file.open", "file.save", "file.save_as", "print.dialog", "file.close", "create.blank"] {
            assert!(app.execute(command));
        }
        assert_eq!(*actions.borrow(), ["open", "save", "saveAs", "print", "close", "new"]);
        assert_eq!(app.views.len(), 1);
        assert_eq!(app.views[0].id, id);
        assert!(app.session.get(id).is_some());
    }

    #[test]
    fn export_flushes_added_text_and_preserves_unconfirmed_ime_text() {
        let mut app = document();
        app.views[0].content.draft = Some(crate::content_ui::TextDraft {
            page: 0,
            index: None,
            rect: [40.0, 40.0, 300.0, 80.0],
            text: "Pending PDF text".into(),
            style: Default::default(),
            focus: true,
        });
        let draft = app.embedding_draft();
        assert!(app.host_dirty());
        app.observe_embedding_input(&[egui::Event::Ime(egui::ImeEvent::Preedit { text: "待".into(), active_range_chars: None })]);
        assert!(app.commit_pending().is_err());
        assert!(app.views[0].content.draft.is_some());
        app.observe_embedding_input(&[egui::Event::Ime(egui::ImeEvent::Commit("待".into()))]);
        app.commit_pending().unwrap();
        assert!(!app.has_pending_input());
        assert_ne!(draft, app.embedding_draft());
        let id = app.views[0].id;
        let bytes = app.session.save_bytes(id).unwrap();
        let mut reopened = OfficePdfApp::new();
        reopened.open_bytes("Saved.pdf", None, bytes.as_ref().clone()).unwrap();
        assert!(reopened.session.get(reopened.views[0].id).unwrap().text_lines(0).iter().any(|line| line.text.contains("Pending PDF text")));
    }

    #[test]
    fn a_second_document_cannot_replace_a_host_owned_tab() {
        let mut app = document();
        let original = app.views[0].id;
        let bytes = app.session.create_blank(200.0, 200.0, 2).unwrap();
        assert!(app.open_bytes("Another.pdf", None, bytes.as_ref().clone()).is_err());
        app.open_created("Generated.pdf", bytes, "Generated");
        assert_eq!(app.views.len(), 1);
        assert_eq!(app.views[0].id, original);
        assert_eq!(app.session.get(original).unwrap().info.pages.len(), 1);
        assert!(!app.embedding_command_visible("help.discord"));
        assert!(!app.embedding_command_visible("view.theme.dark"));
        assert!(app.embedding_command_visible("page.rotate_cw"));
    }

    #[test]
    fn embedded_signing_is_blocked_without_hiding_signature_verification() {
        let mut app = document();
        let original = app.views[0].id;
        let before = app.embedding_draft();
        for command in ["sign.digital", "sign.certify", "sign.certify_invisible"] {
            assert!(!app.embedding_command_visible(command));
            assert!(app.run_host_command(command, Value::Null).is_err());
            assert!(app.dialog.is_none());
            assert!(app.sign_draft.is_none());
        }
        // Existing unsigned fields and the signatures panel can bypass commands.
        app.start_signing(0, None, Some("ExistingSignature".into()), None);
        assert!(app.dialog.is_none());
        assert!(app.embedding_command_visible("comment.stamp"), "standard stamps remain available despite a duplicate catalog entry");
        assert!(app.sign_draft.is_none());
        assert!(app.digital_ids.is_empty());
        assert!(app.embedding_command_visible("sign.validate"));
        assert!(app.embedding_command_visible("sign.fill.signature"));
        assert!(app.embedding_group_visible(office_pdf_engine::catalog::group("certificate").unwrap()));
        assert!(app.run_host_command("sign.validate", Value::Null).is_ok());
        assert_eq!(app.views[0].id, original);
        assert_eq!(app.embedding_draft(), before);
    }

    #[test]
    fn embedded_file_workflows_are_unavailable_before_they_change_a_document() {
        let mut app = document();
        let before = app.embedding_draft();
        for command in [
            "edit.image",
            "comment.attach",
            "comment.import",
            "comment.export",
            "form.import_data",
            "form.export_data",
            "measure.export",
            "page.extract",
            "page.split",
            "doc.compare",
            "actions.wizard",
            "actions.distribution",
            "actions.optimize_scans",
            "export.image",
            "export.all_images",
            "export.text",
            "export.docx",
            "export.pptx",
            "export.html",
            "export.rtf",
        ] {
            assert!(!app.embedding_command_visible(command), "{command}");
            assert!(app.run_host_command(command, Value::Null).is_err(), "{command}");
        }
        assert!(app.dialog.is_none());
        assert_eq!(app.embedding_draft(), before);
        assert_eq!(app.session.get(app.views[0].id).unwrap().info.pages.len(), 1);
        let ctx = egui::Context::default();
        assert!(!is_embedded_context(&ctx));
        app.activate_host_context(&ctx);
        assert!(is_embedded_context(&ctx));
    }

    #[test]
    fn clearing_saved_added_text_is_unsaved_until_deletion_is_committed() {
        let mut app = document();
        let text = office_pdf_engine::AddedText { rect: [40.0, 40.0, 300.0, 80.0], text: "Saved text to delete".into(), ..Default::default() };
        assert!(app.apply_edit(office_pdf_engine::Edit::AddText { page: 0, text: text.clone() }));
        let id = app.views[0].id;
        let bytes = app.session.save_bytes(id).unwrap();
        app.session.mark_saved(id, bytes, None).unwrap();
        let clean = app.embedding_draft();
        app.views[0].content.draft =
            Some(crate::content_ui::TextDraft { page: 0, index: Some(0), rect: text.rect, text: String::new(), style: text, focus: true });
        assert!(app.has_pending_input(), "clearing saved text must block stale save receipts");
        assert!(app.host_dirty(), "beforeunload and close must ask before losing the pending deletion");
        assert_ne!(app.embedding_draft(), clean);
        app.commit_pending().unwrap();
        assert!(!app.has_pending_input());
        assert!(app.host_dirty());
        assert!(app.session.get(id).unwrap().added().is_empty(), "flush commits the intended deletion");
        app.undo();
        assert_eq!(app.session.get(id).unwrap().added().len(), 1, "the deletion remains undoable");
    }

    #[test]
    fn empty_new_text_draft_does_not_mark_a_document_unsaved() {
        let mut app = document();
        assert!(app.background_export_ready());
        let clean = app.embedding_draft();
        app.views[0].content.draft = Some(crate::content_ui::TextDraft {
            page: 0,
            index: None,
            rect: [40.0, 40.0, 300.0, 80.0],
            text: "  \n".into(),
            style: Default::default(),
            focus: true,
        });
        assert!(!app.has_pending_input());
        assert!(!app.host_dirty());
        assert!(!app.background_export_ready(), "background save must not close an empty text editor");
        assert_eq!(app.embedding_state()["backgroundExportReady"], false);
        assert!(app.views[0].content.draft.is_some(), "checking readiness never commits a draft");
        assert_eq!(app.embedding_draft(), clean);
        app.commit_pending().unwrap();
        assert!(app.background_export_ready());
        assert!(!app.host_dirty());
        assert!(app.session.get(app.views[0].id).unwrap().added().is_empty());
    }

    #[test]
    fn background_readiness_preserves_form_focus_and_blocks_modal_or_ime_input() {
        let mut app = document();
        app.views[0].forms.focus = Some(crate::forms_ui::Focus {
            name: "Unchanged field".into(),
            widget: 0,
            text: String::new(),
            picked: Vec::new(),
            request_focus: false,
            select_all: false,
            press: None,
            calendar: None,
            calendar_rect: None,
        });
        assert!(!app.has_pending_input(), "unchanged form focus is not a changed draft");
        assert!(!app.background_export_ready());
        assert!(app.views[0].forms.focus.is_some());
        app.views[0].forms.focus = None;
        assert!(app.background_export_ready());
        app.dialog = Some(crate::Dialog::WordCount);
        assert!(!app.background_export_ready());
        app.dialog = None;
        app.palette_open = true;
        assert!(!app.background_export_ready());
        app.palette_open = false;
        app.observe_embedding_input(&[egui::Event::Ime(egui::ImeEvent::Preedit { text: "待确认".into(), active_range_chars: None })]);
        assert!(!app.background_export_ready());
        app.observe_embedding_input(&[egui::Event::Ime(egui::ImeEvent::Commit("完成".into()))]);
        assert!(app.background_export_ready());
    }
}
