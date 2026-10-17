//! Thumbnail Enter follows the selected page; text Enter remains text editing.
#![allow(clippy::unwrap_used)]

use egui_kittest::{Harness, kittest::Queryable};
use office_presentation_engine::{Mods, Session};
use serde_json::json;
use std::sync::Arc;

use crate::{Services, SlideApp, ViewMode};

fn harness() -> Harness<'static, SlideApp> {
    let mut app = SlideApp::new(Session::with_new(), Services::default());
    app.run("slide.new", json!({"title":"Middle page","body":"Keep this editable content"})).unwrap();
    app.run("shape.insert", json!({"preset":"rect","rect":[70,180,180,80],"text":"Custom shape"})).unwrap();
    app.run("slide.notes", json!({"text":"Speaker notes"})).unwrap();
    app.run("slide.new", json!({"title":"Last page"})).unwrap();
    Harness::builder().with_size(egui::vec2(1200.0, 850.0)).build_ui_state(
        |ui, app: &mut SlideApp| {
            app.logic(ui.ctx());
            app.ui(ui);
        },
        app,
    )
}

#[test]
fn thumbnail_enter_copies_current_content_after_that_page_and_undoes_once() {
    let mut h = harness();
    h.run_steps(3);
    h.get_by_label("Slide 2").click();
    h.run_steps(2);
    assert!(h.state().slides_focused);
    let before = h.state().session.doc().unwrap().doc.clone();
    let undo = h.state().session.doc().unwrap().history.undo.len();
    assert_eq!(h.state().session.doc().unwrap().selection.slide, 1);
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
    let state = h.state().session.doc().unwrap();
    assert_eq!(state.doc.slides.len(), 4);
    assert_eq!(state.selection.slide, 2);
    assert_eq!(state.history.undo.len(), undo + 1);
    assert!(Arc::ptr_eq(&state.doc.slides[0], &before.slides[0]));
    assert!(Arc::ptr_eq(&state.doc.slides[1], &before.slides[1]));
    assert!(Arc::ptr_eq(&state.doc.slides[3], &before.slides[2]));
    let source = &before.slides[1];
    let copy = &state.doc.slides[2];
    assert_ne!(source.id, copy.id);
    assert_eq!(state.selection.slides, vec![copy.id]);
    assert_eq!(source.layout, copy.layout);
    assert_eq!(source.background, copy.background);
    assert_eq!(source.notes_text(), copy.notes_text());
    assert_eq!(source.shapes.len(), copy.shapes.len());
    for (original, duplicate) in source.shapes.iter().zip(&copy.shapes) {
        assert_ne!(original.id, duplicate.id);
        let mut normalized = duplicate.clone();
        normalized.id = original.id;
        assert_eq!(*original, normalized);
    }
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert!(Arc::ptr_eq(&h.state().session.doc().unwrap().doc, &before));
}

#[test]
fn thumbnail_enter_does_not_override_text_newlines_or_other_focus_contexts() {
    let mut h = harness();
    h.run_steps(3);
    h.get_by_label("Slide 2").click();
    h.run_steps(2);
    let title = h.state().session.doc().unwrap().doc.slides[1].shapes.iter().find(|shape| shape.text.is_some()).unwrap().id;
    h.state_mut().run("text.set", json!({"id":title,"text":"First line"})).unwrap();
    h.state_mut().run("text.edit", json!({"id":title})).unwrap();
    h.state_mut().session.key("End", Mods::default()).unwrap();
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
    assert_eq!(h.state().session.doc().unwrap().doc.slides.len(), 3);
    assert_eq!(h.state_mut().run("text.get", json!({"id":title})).unwrap()["text"], "First line\n");
    h.state_mut().run("text.compose", json!({"text":"候选"})).unwrap();
    assert!(h.state_mut().thumbnail_enter("Enter", Mods::default()).is_none());
    h.state_mut().session.end_composition();
    h.state_mut().run("slide.go", json!({"index":1})).unwrap();
    for mods in [Mods { shift: true, ..Mods::default() }, Mods { alt: true, ..Mods::default() }, Mods { cmd: true, ..Mods::default() }] {
        assert!(h.state_mut().thumbnail_enter("Enter", mods).is_none());
    }
    h.state_mut().ui.view = ViewMode::Sorter;
    assert!(h.state_mut().thumbnail_enter("Enter", Mods::default()).is_none());
    h.state_mut().ui.view = ViewMode::Normal;
    h.state_mut().slides_focused = false;
    assert!(h.state_mut().thumbnail_enter("Enter", Mods::default()).is_none());
    assert_eq!(h.state().session.doc().unwrap().doc.slides.len(), 3);
}
