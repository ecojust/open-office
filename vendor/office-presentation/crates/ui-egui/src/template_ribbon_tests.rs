//! The host template chooser is a presentation ribbon control, not document content.
#![allow(clippy::unwrap_used)]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use egui_kittest::{Harness, kittest::Queryable};
use office_presentation_engine::Session;
use serde_json::json;

use crate::{Services, SlideApp};

fn ribbon(app: SlideApp) -> Harness<'static, SlideApp> {
    Harness::builder().with_size(egui::vec2(1400.0, 400.0)).build_ui_state(
        |ui, app: &mut SlideApp| {
            app.logic(ui.ctx());
            // Font installation is deferred by egui until the next frame, as in app.ui.
            if !app.fonts_ready {
                return;
            }
            let _language = crate::i18n::scope(app.services.embedded_editor);
            super::show(app, ui);
        },
        app,
    )
}

#[test]
fn template_ribbon_control_follows_view_and_precedes_contextual_tabs() {
    let mut session = Session::with_new();
    session.execute("shape.insert", &json!({"preset":"rect","rect":[10,10,100,80]})).unwrap();
    let app = SlideApp::new(session, Services { embedded_editor: true, host_command: Some(Box::new(|_, _| None)), ..Services::default() });
    let mut h = ribbon(app);
    h.run_steps(2);
    let _ = h.get_by_label("演示模板");
    let tabs = &h.state().ribbon_tabs;
    let view = tabs.iter().position(|tab| tab.name == "View").unwrap();
    assert_eq!(tabs[view + 1].name, "Templates");
    assert_eq!(tabs[view + 1].label, "模板");
    assert_eq!(tabs[view + 2].name, "Shape Format");
    assert!(tabs[view].rect.right() < tabs[view + 1].rect.left());
    assert!(tabs[view + 1].rect.right() < tabs[view + 2].rect.left());
    assert_eq!(tabs[view].rect.top(), tabs[view + 1].rect.top());
}

#[test]
fn template_ribbon_toggle_keeps_selected_tab_collapse_and_document_unchanged() {
    for collapsed in [false, true] {
        let commands = Rc::new(RefCell::new(Vec::new()));
        let calls = commands.clone();
        let mut app = SlideApp::new(
            Session::with_new(),
            Services {
                embedded_editor: true,
                host_command: Some(Box::new(move |id, _| {
                    if id != "host.toggleTemplates" {
                        return None;
                    }
                    calls.borrow_mut().push(id.to_owned());
                    Some(Ok(json!({"pending":"host","action":"toggleTemplates"})))
                })),
                ..Services::default()
            },
        );
        app.ui.tab = "View".into();
        app.ui.ribbon_collapsed = collapsed;
        let original = app.session.doc().unwrap().doc.clone();
        let original_dirty = app.session.doc().unwrap().is_dirty();
        let mut h = ribbon(app);
        h.run_steps(2);
        for open in [true, false] {
            h.get_by_label("演示模板").click();
            h.run_steps(2);
            h.state_mut().run("host.setTemplatePanelOpen", json!({"open":open})).unwrap();
            h.run_steps(2);
            let inspected = crate::control::inspect(h.state(), &h.ctx);
            assert_eq!(inspected["templatePanelOpen"], open);
            let template = inspected["ribbonTabs"].as_array().unwrap().iter().find(|tab| tab["name"] == "Templates").unwrap();
            assert_eq!(template["selected"], open);
            assert_eq!(h.state().ui.tab, "View");
            assert_eq!(h.state().ui.ribbon_collapsed, collapsed);
            let doc = h.state().session.doc().unwrap();
            assert!(Arc::ptr_eq(&original, &doc.doc));
            assert_eq!(doc.is_dirty(), original_dirty);
            assert!(doc.history.undo.is_empty() && doc.history.redo.is_empty());
        }
        assert_eq!(*commands.borrow(), vec!["host.toggleTemplates", "host.toggleTemplates"]);
    }
}

#[test]
fn standalone_and_embedded_without_a_host_have_no_template_ribbon_control() {
    for embedded_editor in [false, true] {
        let mut h = ribbon(SlideApp::new(Session::with_new(), Services { embedded_editor, ..Services::default() }));
        h.run_steps(2);
        assert!(h.query_by_label("演示模板").is_none());
        assert!(!h.state().ribbon_tabs.iter().any(|tab| tab.name == "Templates"));
    }
    let mut app = SlideApp::new(Session::with_new(), Services::default());
    assert!(app.run("host.setTemplatePanelOpen", json!({"open":true})).is_err());
    assert!(!app.template_panel_open);
}
