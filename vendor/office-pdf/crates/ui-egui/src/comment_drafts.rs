//! Recover unfinished comment input without treating an empty editor as a document edit.

use office_pdf_engine::{Edit, NewAnnotation, NoteIcon, Shape};
use office_pdf_render::DocInfo;

use crate::{
    DocView, OfficePdfApp, RightPanel,
    comments::{CommentTool, CommentView, ComposerKind},
    widgets,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum DraftKind {
    Composer,
    Editing,
    Reply,
    Add,
}

#[derive(Clone)]
pub(crate) struct Draft {
    pub kind: DraftKind,
    pub page: usize,
    pub text: String,
    pub orphaned: bool,
}

#[derive(Default)]
pub(crate) struct DraftDialog {
    pub confirm_discard: bool,
    pub error: String,
}

fn annotation(info: &DocInfo, page: usize, index: usize) -> Option<&office_pdf_render::Annotation> {
    info.annotations.iter().find(|item| item.page == page && item.index == index)
}

fn text_changed(before: &str, draft: &str) -> bool {
    before != draft && !(before.trim().is_empty() && draft.trim().is_empty())
}

pub(crate) fn editing_changed(view: &CommentView, info: &DocInfo) -> bool {
    view.editing.as_ref().is_some_and(|(page, index, text)| {
        annotation(info, *page, *index).map_or_else(|| !text.trim().is_empty(), |item| text_changed(item.contents.as_deref().unwrap_or(""), text))
    })
}

pub(crate) fn composer_changed(view: &CommentView, info: &DocInfo) -> bool {
    view.composer.as_ref().is_some_and(|draft| match draft.kind {
        ComposerKind::Edit(index) => annotation(info, draft.page, index)
            .map_or_else(|| !draft.text.trim().is_empty(), |item| text_changed(item.contents.as_deref().unwrap_or(""), &draft.text)),
        _ => !draft.text.trim().is_empty(),
    })
}

pub(crate) fn has_changes(view: &DocView, info: &DocInfo) -> bool {
    composer_changed(&view.comments, info)
        || editing_changed(&view.comments, info)
        || !view.comments.reply.trim().is_empty()
        || !view.comments.add_box.trim().is_empty()
}

/// Annotation edits use array indexes, which change after deletion, page edits and undo.
/// Hold the old identity across each model change so a draft never attaches to its neighbour.
pub(crate) struct Targets {
    editing: Option<office_pdf_render::Annotation>,
    composer: Option<office_pdf_render::Annotation>,
    reply: Option<office_pdf_render::Annotation>,
    has_reply: bool,
}

fn relocated<'a>(old: &office_pdf_render::Annotation, info: &'a DocInfo) -> Option<&'a office_pdf_render::Annotation> {
    let mut matching = info.annotations.iter().filter(|item| match old.name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => item.name.as_deref() == Some(name),
        None => {
            item.name.as_deref().unwrap_or("").is_empty()
                && item.subtype == old.subtype
                && item.rect == old.rect
                && item.author == old.author
                && item.contents == old.contents
                && item.in_reply_to == old.in_reply_to
        }
    });
    let found = matching.next()?;
    // Imported PDFs may omit or duplicate names. Ambiguity keeps the text recoverable
    // as a new note instead of risking an overwrite of a different annotation.
    matching.next().is_none().then_some(found)
}

impl Targets {
    pub(crate) fn capture(view: &CommentView, info: &DocInfo) -> Self {
        Self {
            editing: view.editing.as_ref().and_then(|(page, index, _)| annotation(info, *page, *index)).cloned(),
            composer: view
                .composer
                .as_ref()
                .and_then(|draft| match draft.kind {
                    ComposerKind::Edit(index) => annotation(info, draft.page, index),
                    _ => None,
                })
                .cloned(),
            reply: view.selected.and_then(|(page, index)| annotation(info, page, index)).cloned(),
            has_reply: !view.reply.trim().is_empty(),
        }
    }

    pub(crate) fn restore(&self, view: &mut CommentView, info: &DocInfo) {
        if let Some(old) = &self.editing {
            if view.editing.as_ref().is_some_and(|(_, _, text)| !text_changed(old.contents.as_deref().unwrap_or(""), text)) {
                // An untouched editor is only a view of the old model. Keeping it after
                // another edit would turn that old text into a phantom overwrite/delete.
                view.editing = None;
            } else if let Some((page, index, _)) = &mut view.editing {
                (*page, *index) = relocated(old, info).map_or((old.page, usize::MAX), |item| (item.page, item.index));
            }
        }
        if let Some(old) = &self.composer {
            if view.composer.as_ref().is_some_and(|draft| !text_changed(old.contents.as_deref().unwrap_or(""), &draft.text)) {
                view.composer = None;
            } else if let Some(draft) = &mut view.composer
                && let ComposerKind::Edit(index) = &mut draft.kind
            {
                (draft.page, *index) = relocated(old, info).map_or((old.page, usize::MAX), |item| (item.page, item.index));
            }
        }
        self.restore_reply(view, info);
    }

    pub(crate) fn restore_reply(&self, view: &mut CommentView, info: &DocInfo) {
        if self.has_reply {
            view.selected = self.reply.as_ref().and_then(|old| relocated(old, info)).map(|item| (item.page, item.index));
        }
    }
}

/// Undo/deletion can remove the annotation whose empty editor was opened automatically.
/// Only empty orphan editors are removed; typed text remains recoverable.
pub(crate) fn reconcile(view: &mut CommentView, info: &DocInfo) {
    if view.editing.as_ref().is_some_and(|(page, index, text)| annotation(info, *page, *index).is_none() && text.trim().is_empty()) {
        view.editing = None;
    }
    if view.composer.as_ref().is_some_and(|draft| {
        matches!(draft.kind, ComposerKind::Edit(index) if annotation(info, draft.page, index).is_none()) && draft.text.trim().is_empty()
    }) {
        view.composer = None;
    }
}

impl OfficePdfApp {
    pub(crate) fn unfinished_comment(&self) -> Option<Draft> {
        let (index, id) = self.active_ids()?;
        let view = self.views.get(index)?;
        let info = &self.session.get(id)?.info;
        let comments = &view.comments;
        if composer_changed(comments, info) {
            let draft = comments.composer.as_ref()?;
            let orphaned = info.pages.get(draft.page).is_none()
                || matches!(draft.kind, ComposerKind::Edit(index) if annotation(info, draft.page, index).is_none());
            return Some(Draft { kind: DraftKind::Composer, page: draft.page, text: draft.text.clone(), orphaned });
        }
        if editing_changed(comments, info) {
            let (page, index, text) = comments.editing.as_ref()?;
            return Some(Draft { kind: DraftKind::Editing, page: *page, text: text.clone(), orphaned: annotation(info, *page, *index).is_none() });
        }
        if !comments.reply.trim().is_empty() {
            let selected = comments.selected.and_then(|(page, index)| annotation(info, page, index));
            return Some(Draft {
                kind: DraftKind::Reply,
                page: selected.map_or(view.current, |item| item.page),
                text: comments.reply.clone(),
                orphaned: selected.is_none(),
            });
        }
        if !comments.add_box.trim().is_empty() {
            return Some(Draft { kind: DraftKind::Add, page: view.current, text: comments.add_box.clone(), orphaned: false });
        }
        None
    }

    pub(crate) fn open_comment_drafts(&mut self) {
        if self.unfinished_comment().is_some() {
            self.comment_draft_dialog = Some(DraftDialog::default());
            if let Some(ctx) = &self.ctx {
                ctx.request_repaint();
            }
        }
    }

    fn clear_comment_draft(&mut self, kind: DraftKind) {
        let Some(view) = self.active.and_then(|index| self.views.get_mut(index)) else { return };
        match kind {
            DraftKind::Composer => {
                view.comments.composer = None;
                view.comments.replace = None;
            }
            DraftKind::Editing => view.comments.editing = None,
            DraftKind::Reply => view.comments.reply.clear(),
            DraftKind::Add => view.comments.add_box.clear(),
        }
        self.comment_draft_dialog = self.unfinished_comment().map(|_| DraftDialog::default());
    }

    pub(crate) fn discard_comment_draft(&mut self, confirmed: bool) -> Result<(), String> {
        let draft = self.unfinished_comment().ok_or("没有待完成的批注草稿")?;
        if !confirmed {
            self.comment_draft_dialog = Some(DraftDialog { confirm_discard: true, error: String::new() });
            return Ok(());
        }
        if !self.comment_draft_dialog.as_ref().is_some_and(|dialog| dialog.confirm_discard) {
            return Err("请先确认是否放弃这段批注草稿".into());
        }
        self.clear_comment_draft(draft.kind);
        Ok(())
    }

    pub(crate) fn submit_comment_draft(&mut self) -> Result<(), String> {
        let draft = self.unfinished_comment().ok_or("没有待完成的批注草稿")?;
        let (index, id) = self.active_ids().ok_or("文稿已关闭")?;
        let view = self.views.get(index).ok_or("页面视图已关闭")?;
        let info = &self.session.get(id).ok_or("文稿已关闭")?.info;
        let edit = if draft.orphaned || draft.kind == DraftKind::Add {
            // Recover typed text as an explicitly requested new note if its old target vanished.
            let page = draft.page.min(info.pages.len().saturating_sub(1));
            let geometry = info.pages.get(page).ok_or("文稿没有可添加批注的页面，草稿已保留")?;
            let point = geometry.view_to_user(geometry.width - 44.0, 24.0);
            Edit::AddAnnotation(NewAnnotation {
                page,
                shape: Shape::Note { at: [point[0] as f64, point[1] as f64], icon: NoteIcon::Comment },
                style: self.comment_prefs.style(CommentTool::Note),
                contents: draft.text.clone(),
                author: self.comment_prefs.author.clone(),
            })
        } else {
            match draft.kind {
                DraftKind::Composer => {
                    crate::comments::composer_edit(&view.comments, info, &self.comment_prefs).ok_or("无法提交该批注，草稿已保留")?
                }
                DraftKind::Editing => {
                    let (page, index, text) = view.comments.editing.as_ref().ok_or("批注编辑已结束")?;
                    Edit::SetAnnotationContents { page: *page, index: *index, text: text.clone() }
                }
                DraftKind::Reply => {
                    let (page, index) = view.comments.selected.ok_or("原批注已不存在，草稿已保留")?;
                    Edit::ReplyToAnnotation { page, index, text: draft.text.clone(), author: self.comment_prefs.author.clone() }
                }
                DraftKind::Add => return Err("批注草稿状态已变化，请重试".into()),
            }
        };
        if !self.apply_edit(edit) {
            return Err("提交批注失败，草稿仍完整保留，请检查文稿是否允许批注".into());
        }
        self.clear_comment_draft(draft.kind);
        Ok(())
    }

    pub(crate) fn return_to_comment_draft(&mut self) {
        let Some(draft) = self.unfinished_comment() else {
            self.comment_draft_dialog = None;
            return;
        };
        if draft.orphaned {
            return;
        }
        self.choose_right_panel(Some(RightPanel::Comments));
        let Some(view) = self.active.and_then(|index| self.views.get_mut(index)) else { return };
        view.goto = Some((draft.page, 0.0));
        view.comments.search = None;
        view.comments.hidden_types.clear();
        view.comments.hidden_authors.clear();
        view.comments.hidden_statuses.clear();
        view.comments.hidden_colors.clear();
        view.comments.hidden_checks.clear();
        view.comments.collapsed_pages.clear();
        view.comments.reveal = true;
        if draft.kind == DraftKind::Composer
            && let Some(composer) = &mut view.comments.composer
        {
            composer.focus = true;
        }
        if draft.kind == DraftKind::Editing
            && let Some((page, index, _)) = &view.comments.editing
        {
            view.comments.selected = Some((*page, *index));
        }
        self.comment_draft_dialog = None;
    }
}

fn button(ui: &mut egui::Ui, id: &str, label: &str, primary: bool) -> egui::Response {
    let response = widgets::pill_button(ui, label, primary);
    crate::embedded_toolbar::record(ui, id, &response);
    response
}

pub(crate) fn show(app: &mut OfficePdfApp, ctx: &egui::Context) {
    let Some(dialog) = &app.comment_draft_dialog else { return };
    let Some(draft) = app.unfinished_comment() else {
        app.comment_draft_dialog = None;
        return;
    };
    let confirm_discard = dialog.confirm_discard;
    let error = dialog.error.clone();
    let mut action = None;
    let modal = widgets::show_modal(ctx, "pdf-comment-draft", |ui| {
        ui.set_width((ctx.content_rect().width() - 64.0).clamp(200.0, 420.0));
        ui.heading(if confirm_discard { "确认放弃批注草稿？" } else { "完成待保存的批注" });
        ui.label(if confirm_discard {
            "这段尚未提交的文字将被清除，已保存的批注不会受影响。"
        } else if draft.orphaned {
            "原批注或页面已移除，输入的文字仍然保留。可以将它恢复为新批注。"
        } else {
            "以下文字尚未提交。完成此批注后，即可继续保存文稿。"
        });
        ui.add_space(8.0);
        egui::ScrollArea::vertical().max_height((ctx.content_rect().height() - 300.0).clamp(70.0, 180.0)).show(ui, |ui| {
            ui.add(egui::Label::new(if draft.text.is_empty() { "（清空此批注的原有文字）" } else { &draft.text }).wrap().selectable(true));
        });
        if !error.is_empty() {
            ui.colored_label(egui::Color32::from_rgb(180, 55, 55), &error);
        }
        ui.add_space(12.0);
        ui.horizontal_wrapped(|ui| {
            if confirm_discard {
                if button(ui, "comment-draft-keep", "保留草稿", false).clicked() {
                    action = Some("keep");
                }
                if button(ui, "comment-draft-confirm-discard", "确认放弃", true).clicked() {
                    action = Some("discard");
                }
            } else {
                if button(ui, "comment-draft-close", "稍后处理", false).clicked() {
                    action = Some("close");
                }
                if !draft.orphaned && button(ui, "comment-draft-edit", "返回编辑", false).clicked() {
                    action = Some("edit");
                }
                if button(ui, "comment-draft-discard", "放弃草稿", false).clicked() {
                    action = Some("ask-discard");
                }
                if button(ui, "comment-draft-submit", if draft.orphaned { "恢复为新批注" } else { "提交批注" }, true).clicked() {
                    action = Some("submit");
                }
            }
        });
    });
    if modal.should_close() {
        action = Some(if confirm_discard { "keep" } else { "close" });
    }
    let result = match action {
        Some("submit") => app.submit_comment_draft(),
        Some("discard") => app.discard_comment_draft(true),
        Some("ask-discard") => app.discard_comment_draft(false),
        Some("edit") => {
            app.return_to_comment_draft();
            Ok(())
        }
        Some("close") => {
            app.comment_draft_dialog = None;
            Ok(())
        }
        Some("keep") => {
            app.comment_draft_dialog = Some(DraftDialog::default());
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err(error) = result
        && let Some(dialog) = &mut app.comment_draft_dialog
    {
        dialog.error = error;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::Composer;
    use office_pdf_engine::{Markup, Style};

    fn document() -> OfficePdfApp {
        let mut app = OfficePdfApp::new();
        app.embedded = true;
        let bytes = app.session.create_blank(595.0, 842.0, 1).unwrap();
        app.open_bytes("Notes.pdf", None, bytes.as_ref().clone()).unwrap();
        app
    }

    fn highlight(app: &mut OfficePdfApp, text: &str) {
        let shape = Shape::TextMarkup { kind: Markup::Highlight, quads: vec![[20.0, 280.0, 80.0, 280.0, 20.0, 270.0, 80.0, 270.0]] };
        assert!(app.apply_edit(Edit::AddAnnotation(NewAnnotation {
            page: 0,
            style: Style::default_for(&shape),
            shape,
            contents: text.into(),
            author: "Editor".into(),
        })));
    }

    #[test]
    fn undo_or_delete_highlight_removes_its_automatic_empty_editor_and_allows_save() {
        for delete in [false, true] {
            let mut app = document();
            highlight(&mut app, "");
            assert!(app.views[0].comments.editing.is_some());
            assert!(!app.has_pending_input(), "opening the empty highlight note is not a text change");
            if delete {
                assert!(!app.apply_edit(Edit::DeleteAnnotation { page: 0, index: 0 }));
                app.resolve_removal(true).unwrap();
            } else {
                app.undo();
            }
            let id = app.views[0].id;
            assert!(app.session.get(id).unwrap().info.annotations.is_empty());
            assert!(app.views[0].comments.editing.is_none());
            assert!(!app.has_pending_input());
            assert!(app.background_export_ready());
            app.commit_pending().unwrap();
            assert!(app.session.save_bytes(id).is_ok());
        }
    }

    #[test]
    fn whitespace_new_comments_and_unchanged_editors_do_not_dirty_or_invalidate_receipts() {
        let mut app = document();
        let receipt = app.embedding_draft();
        let comments = &mut app.views[0].comments;
        comments.add_box = " \n ".into();
        comments.reply = "\t ".into();
        comments.composer = Some(Composer { page: 0, at: [80.0, 80.0], kind: ComposerKind::Note, text: " \n".into(), focus: true });
        assert!(!app.has_pending_input());
        assert!(!app.host_dirty());
        assert_eq!(app.embedding_draft(), receipt);
        app.commit_pending().unwrap();

        highlight(&mut app, "Saved note ");
        let id = app.views[0].id;
        let bytes = app.session.save_bytes(id).unwrap();
        app.session.mark_saved(id, bytes, None).unwrap();
        let receipt = app.embedding_draft();
        // Editors open the inspected model text, which normalizes PDF string whitespace.
        // The raw insertion argument is not the text shown by an unchanged editor.
        let saved_text = app.session.get(id).unwrap().info.annotations[0].contents.clone().unwrap();
        assert_eq!(saved_text, "Saved note");
        app.views[0].comments.editing = Some((0, 0, saved_text.clone()));
        app.views[0].comments.composer =
            Some(Composer { page: 0, at: [80.0, 80.0], kind: ComposerKind::Edit(0), text: saved_text.clone(), focus: true });
        assert!(!app.has_pending_input());
        assert!(!app.host_dirty(), "opening the saved model text must not create a draft");
        assert_eq!(app.embedding_draft(), receipt);
        app.commit_pending().unwrap();

        app.views[0].comments.editing = Some((0, 0, format!("{saved_text} ")));
        assert!(app.has_pending_input(), "a newly typed trailing space is still a real edit");
        assert!(app.host_dirty());
        assert_ne!(app.embedding_draft(), receipt);
        assert!(app.commit_pending().is_err());
    }

    #[test]
    fn clearing_existing_note_is_a_real_edit_and_can_be_submitted_and_undone() {
        let mut app = document();
        highlight(&mut app, "Keep until submitted");
        app.views[0].comments.editing = Some((0, 0, String::new()));
        assert!(app.has_pending_input());
        assert!(app.commit_pending().is_err());
        assert!(app.comment_draft_dialog.is_some());
        app.submit_comment_draft().unwrap();
        assert!(!app.has_pending_input());
        let id = app.views[0].id;
        assert!(app.session.get(id).unwrap().info.annotations[0].contents.as_deref().unwrap_or("").is_empty());
        app.undo();
        assert_eq!(app.session.get(id).unwrap().info.annotations[0].contents.as_deref(), Some("Keep until submitted"));
    }

    #[test]
    fn hidden_typed_draft_is_revealed_and_orphaned_text_can_be_restored() {
        let mut app = document();
        highlight(&mut app, "");
        app.views[0].comments.editing.as_mut().unwrap().2 = "Do not lose this note".into();
        app.views[0].comments.search = Some("unrelated".into());
        app.views[0].comments.collapsed_pages.push(0);
        app.choose_right_panel(None);
        assert!(app.commit_pending().is_err());
        assert_eq!(app.unfinished_comment().unwrap().text, "Do not lose this note");
        app.return_to_comment_draft();
        assert!(app.views[0].comments.search.is_none());
        assert!(app.views[0].comments.collapsed_pages.is_empty());
        assert_eq!(app.views[0].goto, Some((0, 0.0)));
        app.undo();
        assert!(app.unfinished_comment().unwrap().orphaned);
        assert!(app.commit_pending().is_err());
        app.submit_comment_draft().unwrap();
        let id = app.views[0].id;
        assert_eq!(app.session.get(id).unwrap().info.annotations[0].contents.as_deref(), Some("Do not lose this note"));
        assert!(!app.has_pending_input());
        app.commit_pending().unwrap();
    }

    #[test]
    fn abandoning_a_real_draft_requires_confirmation_and_only_clears_that_draft() {
        let mut app = document();
        app.views[0].comments.add_box = "First note".into();
        assert!(app.discard_comment_draft(true).is_err());
        assert!(app.commit_pending().is_err());
        app.discard_comment_draft(false).unwrap();
        assert_eq!(app.views[0].comments.add_box, "First note");
        app.discard_comment_draft(true).unwrap();
        assert!(app.views[0].comments.add_box.is_empty());
        assert!(!app.host_dirty());
        app.commit_pending().unwrap();
    }

    #[test]
    fn deleting_neighbours_and_undoing_never_retargets_a_draft_to_another_annotation() {
        let mut app = document();
        for text in ["First", "Second", "Third"] {
            highlight(&mut app, text);
        }
        let original = app.session.get(app.views[0].id).unwrap().info.annotations.clone();
        app.views[0].comments.editing = Some((0, 1, "Second with pending changes".into()));
        assert!(!app.apply_edit(Edit::DeleteAnnotation { page: 0, index: 0 }));
        app.resolve_removal(true).unwrap();
        assert_eq!(app.views[0].comments.editing.as_ref().unwrap().1, 0);
        app.undo();
        assert_eq!(app.views[0].comments.editing.as_ref().unwrap().1, 1);
        assert!(!app.apply_edit(Edit::DeleteAnnotation { page: 0, index: 1 }));
        app.resolve_removal(true).unwrap();
        assert!(app.unfinished_comment().unwrap().orphaned);
        app.submit_comment_draft().unwrap();
        let annotations = &app.session.get(app.views[0].id).unwrap().info.annotations;
        // Inspection orders comments by page position; a recovered note is placed near
        // the page top. Compare PDF annotation indexes, not that presentation order.
        let mut contents = annotations.iter().map(|item| (item.index, item.contents.as_deref().unwrap_or(""))).collect::<Vec<_>>();
        contents.sort_by_key(|(index, _)| *index);
        assert_eq!(contents, [(0, "First"), (1, "Third"), (2, "Second with pending changes")]);
        for old_index in [0, 2] {
            let old = original.iter().find(|item| item.index == old_index).unwrap();
            assert!(old.name.is_some());
            let kept = annotations.iter().find(|item| item.name == old.name).unwrap();
            assert_eq!(kept.contents, old.contents, "a neighbouring annotation must not be overwritten");
        }
        let removed = original.iter().find(|item| item.index == 1).unwrap();
        assert!(removed.name.is_some());
        assert!(annotations.iter().all(|item| item.name != removed.name), "recovery must create a new annotation identity");
        assert!(!app.has_pending_input());
        app.commit_pending().unwrap();
    }

    #[test]
    fn stale_unchanged_editors_do_not_become_new_drafts_after_model_changes() {
        let mut app = document();
        highlight(&mut app, "Saved note");
        app.views[0].comments.editing = Some((0, 0, "Saved note".into()));
        app.views[0].comments.composer =
            Some(Composer { page: 0, at: [80.0, 80.0], kind: ComposerKind::Edit(0), text: "Updated note".into(), focus: true });
        app.submit_comment_draft().unwrap();
        assert!(app.unfinished_comment().is_none(), "the old unchanged inline text must not revert the submitted composer");
        app.views[0].comments.editing = Some((0, 0, "Updated note".into()));
        assert!(!app.apply_edit(Edit::DeleteAnnotation { page: 0, index: 0 }));
        app.resolve_removal(true).unwrap();
        assert!(app.unfinished_comment().is_none(), "deleting an unchanged open annotation creates no new text draft");
        app.commit_pending().unwrap();
    }
}
