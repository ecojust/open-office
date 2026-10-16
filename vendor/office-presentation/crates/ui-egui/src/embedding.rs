//! Shell integration: preserve drafts and keep global file commands outside the canvas.
use crate::{SlideApp, theme};
use serde_json::{Value, json};

impl SlideApp {
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
