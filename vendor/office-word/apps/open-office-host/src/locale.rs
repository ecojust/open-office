//! The host's display preference never enters document editing or undo history.

use office_word_ui_egui::WordApp;

pub(crate) fn language(locale: &str) -> Result<&'static str, String> {
    match locale {
        "zh-CN" => Ok("zh-hans"),
        "en" => Ok("en"),
        _ => Err("locale must be zh-CN or en".into()),
    }
}

pub(crate) fn apply(app: &mut WordApp, language: &str) {
    app.ui.language = language.to_owned();
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::document_state::DocumentState;
    use office_word_doc::{Document, StoryRef};
    use office_word_engine::Session;
    use office_word_ui_egui::Services;
    use serde_json::json;

    #[test]
    fn interface_switch_preserves_document_selection_and_undo() {
        let mut app = WordApp::new(
            Session::new(Document::from_text("保留中文 and English")),
            Services {
                embedded_editor: true,
                ..Services::default()
            },
        );
        let mut document = DocumentState::new(app.session.doc.clone());
        app.run("text.insert", json!({"text": " draft", "raw": true}))
            .unwrap();
        document.sync(&app.session.doc).unwrap();
        let before = app.session.doc.clone();
        let selection = app.session.sel.clone();
        let revision = document.revision();
        let undo = app.session.can_undo();
        let redo = app.session.can_redo();
        for locale in ["en", "zh-CN", "en"] {
            apply(&mut app, language(locale).unwrap());
            document.sync(&app.session.doc).unwrap();
            assert_eq!(document.revision(), revision);
            assert!(document.dirty());
            assert_eq!(app.session.sel, selection);
            assert_eq!(app.session.can_undo(), undo);
            assert_eq!(app.session.can_redo(), redo);
            assert_eq!(
                app.session.doc.plain_text(StoryRef::Body),
                before.plain_text(StoryRef::Body)
            );
        }
        assert!(language("xx").is_err());
        assert_eq!(app.ui.language, "en");
        app.run("edit.undo", json!({})).unwrap();
        document.sync(&app.session.doc).unwrap();
        assert!(!document.dirty());
    }

    #[test]
    fn interface_switch_does_not_change_blank_document_proofing_language() {
        let mut app = WordApp::new(
            Session::new(Document::default()),
            Services {
                embedded_editor: true,
                ..Services::default()
            },
        );
        let mut document = DocumentState::new(app.session.doc.clone());
        let proofing = app.session.doc.styles.default_chr.lang.clone();
        let ctx = egui::Context::default();
        for locale in ["zh-CN", "en", "zh-CN"] {
            apply(&mut app, language(locale).unwrap());
            let mut output = ctx.run_ui(Default::default(), |ui| app.logic(ui.ctx()));
            output.textures_delta.clear();
            document.sync(&app.session.doc).unwrap();
            assert_eq!(document.revision(), 1);
            assert!(!document.dirty());
            assert_eq!(app.session.doc.styles.default_chr.lang, proofing);
        }
    }
}
