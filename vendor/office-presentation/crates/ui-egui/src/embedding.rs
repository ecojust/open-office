//! Shell integration: preserve drafts and keep global file commands outside the canvas.
use crate::{SlideApp, theme};
use serde_json::{Value, json};

impl SlideApp {
    /// Reflect a shell-owned panel without committing input, changing the active ribbon tab,
    /// or creating a document revision. The shell remains the source of truth on close/switch.
    pub(crate) fn set_host_template_panel_open(&mut self, params: &Value) -> Result<Value, String> {
        if !self.services.embedded_editor {
            return Err("演示模板面板由 Open Office 工作区管理。".into());
        }
        let open = params.get("open").and_then(Value::as_bool).ok_or("模板面板状态必须为 true 或 false。")?;
        self.template_panel_open = open;
        Ok(json!({"open": open}))
    }

    /// A shared egui context may contain another tab's styles and embedded-font fallbacks.
    pub fn activate_host_context(&mut self) {
        self.styled = false;
        self.fonts_ready = false;
        self.restyle = true;
    }

    pub fn has_pending_input(&self) -> bool {
        self.host_ime_active || !self.synthetic.is_empty() || self.session.active().is_some_and(|d| d.composition.is_some())
    }

    pub fn embedding_draft(&self) -> Value {
        json!({"pending": self.has_pending_input(), "notes": if self.notes_buf.2.edited {
            json!([self.notes_buf.0, self.notes_buf.1, self.notes_buf.2.text, self.notes_buf.2.body])
        } else { Value::Null }})
    }

    pub fn has_notes_draft(&self) -> bool {
        self.notes_buf.2.edited
    }

    /// Commit the old deck's notes only after its replacement has been parsed successfully.
    /// The registered engine command retains one undo step for the entire template switch.
    pub fn apply_host_template(&mut self, params: Value) -> Result<Value, String> {
        if self.has_pending_input() || self.session.active().is_some_and(|doc| doc.interaction.is_some()) {
            return Err("请先完成当前输入或拖动，再切换模板。".into());
        }
        // Preflight is intentionally separate: an invalid template must not consume a notes draft.
        office_presentation_engine::cmd::template::parse(&params).map_err(|error| error.to_string())?;
        let before = self.session.doc().map_err(|error| error.to_string())?.clone();
        let notes = self.notes_buf.clone();
        let journal_len = self.session.journal.len();
        let applied = self.commit_pending().and_then(|()| self.run("template.applyBytes", params));
        if applied.is_err() {
            *self.session.doc_mut().map_err(|error| error.to_string())? = before;
            self.notes_buf = notes;
            self.session.journal.truncate(journal_len);
            return applied;
        }
        self.discard_pending();
        self.show = None;
        self.anim_preview = None;
        self.media.set_document(None);
        self.textures = Default::default();
        self.thumb_drag = None;
        self.eyedropper = None;
        self.selpane = Default::default();
        self.sorter = Default::default();
        self.ui.smartart_drafts = Default::default();
        self.ui.smartart_focus = None;
        self.ui.comment_focus = None;
        self.ui.view = crate::ViewMode::Normal;
        self.ui.zoom = None;
        self.session.tool = Default::default();
        applied
    }

    pub fn commit_pending(&mut self) -> Result<(), String> {
        if self.has_pending_input() {
            return Err("请完成当前输入法输入后再保存。".into());
        }
        if self.notes_buf.2.edited {
            if !self.session.active().is_some_and(|d| d.uid == self.notes_buf.0) {
                return Err("演讲者备注的文档已改变，请先完成编辑。".into());
            }
            self.run("slide.notes", json!({"body": self.notes_buf.2.body, "index": self.notes_buf.1}))?;
            self.notes_buf.2.edited = false;
        }
        Ok(())
    }

    pub fn validate_host_file(&self, request: u64, name: &str, bytes: &[u8]) -> Result<(), String> {
        let pending = self.pending_files.iter().find(|pending| pending.id == request).ok_or("文件选择请求已结束。")?;
        let command = crate::command_for(pending.purpose, name, bytes)?;
        if command == "file.openBytes" {
            return Err("请使用 Open Office 打开演示文稿。".into());
        }
        let content_type = office_presentation_engine::cmd::insert::content_type(name, bytes);
        match command {
            "insert.picture" | "picture.change" => {
                if !content_type.starts_with("image/")
                    || (content_type != "image/svg+xml" && office_presentation_render::decode_image(bytes).is_none())
                {
                    return Err("无法读取此图片，请选择有效的图片文件。".into());
                }
            }
            "insert.audio" if !content_type.starts_with("audio/") => {
                return Err("请选择有效的音频文件。".into());
            }
            "insert.video" if !content_type.starts_with("video/") => {
                return Err("请选择有效的视频文件。".into());
            }
            _ => {}
        }
        if !self.viewing_target(&pending.target) {
            return Err("插入目标已改变，请重新选择文件。".into());
        }
        Ok(())
    }

    pub fn discard_pending(&mut self) {
        self.synthetic.clear();
        self.host_ime_active = false;
        self.notes_buf = (0, usize::MAX, Default::default());
        self.dialog = None;
        self.palette = None;
        self.pending_files.clear();
        if let Some(inbox) = &self.services.inbox
            && let Ok(mut inbox) = inbox.lock()
        {
            inbox.clear();
        }
    }

    pub fn set_host_theme(&mut self, mode: &str, ctx: Option<&egui::Context>) -> Result<(), String> {
        let dark = match mode {
            "dark" => true,
            "light" => false,
            "system" => ctx.is_some_and(|ctx| ctx.system_theme() == Some(egui::Theme::Dark)),
            _ => return Err("theme mode must be system, light, or dark".into()),
        };
        let brightness = if dark { theme::Brightness::Dark } else { theme::Brightness::Light };
        if self.ui.brightness != brightness {
            self.ui.brightness = brightness;
            self.restyle = true;
        }
        Ok(())
    }

    pub(crate) fn host_shortcuts(&mut self, ctx: &egui::Context) {
        if !self.services.embedded_editor {
            return;
        }
        let mut commands = Vec::new();
        ctx.input_mut(|input| {
            input.events.retain(|event| {
                let egui::Event::Key { key, pressed: true, modifiers, .. } = event else { return true };
                if !(modifiers.command || modifiers.ctrl) || modifiers.alt {
                    return true;
                }
                let command = match (key, modifiers.shift) {
                    (egui::Key::N, false) => "file.new",
                    (egui::Key::O, false) => "file.open",
                    (egui::Key::S, false) => "file.save",
                    (egui::Key::S, true) => "file.saveAs",
                    (egui::Key::P, false) => "file.print",
                    (egui::Key::W, false) => "file.close",
                    _ => return true,
                };
                commands.push(command);
                false
            })
        });
        for command in commands {
            let _ = self.run(command, json!({}));
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod template_tests {
    use super::*;
    use crate::{Services, notes};
    use office_presentation_engine::{DocState, Session, cmd::base64_encode};
    use office_presentation_model::{TextBody, defaults};
    use std::sync::Arc;

    fn app_with_notes_draft() -> SlideApp {
        let mut session = Session::new();
        session.add_document(DocState::new(defaults::new_presentation(None), None, "当前文稿".into()));
        let uid = session.doc().unwrap().uid;
        let mut app = SlideApp::new(session, Services::default());
        let body = TextBody::from_text("切换前尚未提交的备注");
        let mut draft = notes::Draft::new(&body);
        draft.edited = true;
        app.notes_buf = (uid, 0, draft);
        app
    }

    #[test]
    fn host_template_failure_keeps_notes_draft_and_exact_document() {
        let mut app = app_with_notes_draft();
        let before = app.session.doc().unwrap().doc.clone();
        let draft = app.embedding_draft();
        assert!(app.apply_host_template(json!({"data":base64_encode(b"broken")})).is_err());
        assert!(Arc::ptr_eq(&app.session.doc().unwrap().doc, &before));
        assert_eq!(app.embedding_draft(), draft);
        assert!(app.session.doc().unwrap().history.undo.is_empty());
    }

    #[test]
    fn host_template_success_commits_old_notes_then_undo_restores_them() {
        let mut app = app_with_notes_draft();
        let mut source = defaults::new_presentation(None);
        Arc::make_mut(&mut source.slides[0]).notes = TextBody::from_text("模板自己的备注");
        let bytes = office_presentation_pptx::export(&source).unwrap();
        let result = app.apply_host_template(json!({"data":base64_encode(&bytes)})).unwrap();
        assert_eq!(result["slides"], 1);
        assert_eq!(app.session.documents().len(), 1);
        assert!(!app.has_notes_draft());
        assert_eq!(app.session.doc().unwrap().doc.slides[0].notes_text(), "模板自己的备注");
        app.commit_pending().unwrap();
        assert_eq!(app.session.doc().unwrap().doc.slides[0].notes_text(), "模板自己的备注");
        app.run("edit.undo", json!({})).unwrap();
        assert_eq!(app.session.doc().unwrap().doc.slides[0].notes_text(), "切换前尚未提交的备注");
        app.run("edit.redo", json!({})).unwrap();
        assert_eq!(app.session.doc().unwrap().doc.slides[0].notes_text(), "模板自己的备注");
    }
}
