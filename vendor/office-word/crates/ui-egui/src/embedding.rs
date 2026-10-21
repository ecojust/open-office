//! Optional editor-only presentation for shells that own documents and files.

use serde_json::Value;

pub(crate) fn tab_visible(tab: &str) -> bool {
    !matches!(tab, "File" | "Help" | "Zotero")
}

pub(crate) fn dialog_visible(name: &str) -> bool {
    !matches!(
        name,
        "about"
            | "contributors"
            | "models"
            | "encrypt"
            | "encryptPassword"
            | "customizeKeyboard"
            | "customizeRibbon"
            | "customizeQuickAccess"
            | "rename"
            | "renameDocument"
            | "saveChanges"
    )
}

/// Presentation policy, separate from the host's file-ownership/security policy. File shortcuts
/// reach `host_command` before this check; they never open a second file interface here.
pub(crate) fn command_visible(id: &str) -> bool {
    (!id.starts_with("file.") || matches!(id, "file.properties" | "file.accessibility" | "file.printMarkup" | "file.setAuthor" | "file.privacy" | "file.privacyOptions"))
        && !id.starts_with("help.")
        && !id.starts_with("ui.zotero.")
        && !matches!(
            id,
            "ui.backstage"
                | "ui.theme"
                | "ui.dark"
                | "ui.print"
                | "ui.printSubmit"
                | "ui.openFileDialog"
                | "ui.fileBrowser"
                | "ui.makeDefaultApp"
                | "ui.discord"
                | "tools.customizeRibbon"
                | "tools.customizeKeyboard"
                | "ui.recoveryDiscard"
                | "ui.saveChanges"
                | "ui.startScreen"
                | "ui.printSettings"
        )
}

pub(crate) fn command_allowed(id: &str, params: &Value) -> bool {
    command_visible(id)
        && (id != "ui.tab" || params.get("tab").and_then(Value::as_str).is_none_or(tab_visible))
        && (id != "ui.dialog" || params.get("name").and_then(Value::as_str).is_none_or(dialog_visible))
}

/// Geometry recorded by the actual drawing code in the current frame, not inferred from prefs.
pub(crate) fn reset_drawn(ctx: &egui::Context) {
    ctx.data_mut(|data| data.insert_temp(egui::Id::new("editor_drawn_chrome"), Vec::<Value>::new()));
}

pub(crate) fn record(ctx: &egui::Context, id: &str, label: &str, key: &str, rect: egui::Rect) {
    ctx.data_mut(|data| {
        data.get_temp_mut_or_default::<Vec<Value>>(egui::Id::new("editor_drawn_chrome"))
            .push(serde_json::json!({"id":id,"label":label,"key":key,"rect":[rect.left(),rect.top(),rect.width(),rect.height()]}));
    });
}

pub(crate) fn drawn(ctx: &egui::Context) -> Vec<Value> {
    ctx.data(|data| data.get_temp(egui::Id::new("editor_drawn_chrome"))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Services, WordApp};
    use serde_json::json;

    #[test]
    fn embedded_editor_draws_editing_controls_without_the_standalone_shell() {
        assert!(!Services::default().embedded_editor);
        for embedded in [false, true] {
            let mut app = WordApp::new(
                office_word_engine::Session::new(office_word_doc::Document::from_text("Draft")),
                Services { embedded_editor: embedded, ..Default::default() },
            );
            // A previous preference or direct state restore cannot reveal Backstage in the host.
            app.ui.backstage = embedded;
            app.ui.tab = "View".into();
            let mut h = egui_kittest::Harness::builder().with_size(egui::vec2(1600.0, 900.0)).build_ui_state(
                |ui, app: &mut WordApp| {
                    app.logic(ui.ctx());
                    app.ui(ui);
                },
                app,
            );
            h.run_steps(4);
            let ctx = h.state().ctx.as_ref().unwrap();
            let controls = drawn(ctx);
            let has = |id: &str| controls.iter().any(|control| control["id"] == id);
            for id in ["titleBar", "share", "quickAccess:file.save", "tab:File", "tab:Help", "tab:Zotero", "interfaceTheme"] {
                assert_eq!(has(id), !embedded, "{id}, embedded={embedded}");
            }
            for id in ["quickAccess:edit.undo", "quickAccess:edit.redo", "tab:Home", "tab:Insert", "tab:Layout"] {
                assert!(has(id), "{id}, embedded={embedded}");
            }
            if embedded {
                let app = h.state_mut();
                for name in ["about", "contributors", "models", "encryptPassword", "renameDocument", "customizeRibbon"] {
                    assert!(app.run("ui.dialog", json!({"name": name})).is_err(), "{name}");
                    assert!(app.dialog.is_none());
                }
                assert!(app.run("ui.backstage", json!({"value": true})).is_err());
                assert!(app.run("ui.tab", json!({"tab": "File"})).is_err());
                assert!(app.run("ui.tab", json!({"tab": "Zotero"})).is_err());
                assert!(app.run("ui.zotero.status", json!({})).is_err());
                assert!(!app.ui.backstage);
                crate::keytips::activate(app);
                crate::keytips::handle_key(app, egui::Key::Num1);
                assert!(!app.ui.backstage);
            }
        }
    }

    #[test]
    fn embedded_host_theme_changes_only_interface_and_keeps_system_automatic() {
        use crate::theme::Appearance;
        for edited in [false, true] {
            let mut app = WordApp::new(
                office_word_engine::Session::new(office_word_doc::Document::from_text("Draft")),
                Services { embedded_editor: true, ..Default::default() },
            );
            if edited {
                app.run("text.insert", json!({"text": "Unsaved "})).unwrap();
                app.run("format.bold", json!({"value": true})).unwrap();
                app.run("edit.undo", json!({})).unwrap();
            }
            app.session.view.dark_mode = true;
            let ctx = egui::Context::default();
            ctx.run_ui(egui::RawInput::default(), |ui| app.logic(ui.ctx())).drop_without_applying_deltas();
            let document = app.session.doc.clone();
            let selection = app.session.sel.clone();
            let revision = app.session.rev();
            let dirty = app.session.dirty;
            let undo = app.session.undo_depth();
            let redo = app.session.can_redo();
            for appearance in [Appearance::Dark, Appearance::Light, Appearance::System] {
                app.set_host_theme(appearance);
                for os in [egui::Theme::Dark, egui::Theme::Light] {
                    ctx.run_ui(egui::RawInput { system_theme: Some(os), ..Default::default() }, |ui| app.logic(ui.ctx()))
                        .drop_without_applying_deltas();
                    let observed = crate::control::inspect(&mut app, &ctx);
                    assert_eq!(observed["theme"]["preference"], appearance.code());
                    assert_eq!(observed["theme"]["resolved"], if appearance.is_dark(Some(os)) { "dark" } else { "light" });
                    assert_eq!(ctx.options(|options| options.theme_preference), appearance.preference());
                    assert_eq!(app.session.doc, document);
                    assert_eq!(app.session.sel, selection);
                    assert_eq!(app.session.rev(), revision);
                    assert_eq!(app.session.dirty, dirty);
                    assert_eq!(app.session.undo_depth(), undo);
                    assert_eq!(app.session.can_redo(), redo);
                    assert!(app.session.view.dark_mode);
                }
                for id in ["ui.theme", "ui.dark"] {
                    assert!(app.run(id, json!({"value": "light"})).is_err());
                    assert!(app.execute(id, json!({"value": "light"})).is_err());
                    assert_eq!(app.ui.theme, appearance);
                }
            }
        }
    }

    #[test]
    fn embedded_editor_save_shortcut_delegates_without_acknowledging_or_mutating() {
        let calls = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = calls.clone();
        let mut app = WordApp::new(
            office_word_engine::Session::new(office_word_doc::Document::new()),
            Services {
                embedded_editor: true,
                host_command: Some(Box::new(move |id, _| {
                    (id == "file.save").then(|| {
                        sink.borrow_mut().push(id.to_string());
                        Ok(json!({"pending": "host"}))
                    })
                })),
                ..Default::default()
            },
        );
        app.run("text.insert", json!({"text": "Unsaved draft"})).unwrap();
        let document = app.session.doc.clone();
        let selection = app.session.sel.clone();
        let undo = app.session.undo_depth();
        let modifiers = egui::Modifiers::COMMAND;
        let event = egui::Event::Key { key: egui::Key::S, physical_key: Some(egui::Key::S), pressed: true, repeat: false, modifiers };
        let ctx = egui::Context::default();
        ctx.run_ui(egui::RawInput { events: vec![egui::Event::ModifiersChanged(modifiers), event], ..Default::default() }, |ui| {
            crate::keys::canvas_events(&mut app, ui.ctx());
        })
        .drop_without_applying_deltas();
        assert_eq!(*calls.borrow(), ["file.save"]);
        assert_eq!(app.session.doc, document);
        assert_eq!(app.session.sel, selection);
        assert_eq!(app.session.undo_depth(), undo);
        assert!(app.session.dirty);
        assert!(app.dialog.is_none() && !app.ui.backstage);
    }
}
