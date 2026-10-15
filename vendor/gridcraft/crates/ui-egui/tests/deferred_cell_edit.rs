//! A real double-click must finish its pointer frame before creating the cell TextEdit.
//! These tests drive egui directly, without a window or GPU.

use egui::{Event, Key, Modifiers, PointerButton, Pos2};
use gridcraft_engine::core::{CellRef, Value};
use gridcraft_engine::{Mode, Session};
use gridcraft_ui_egui::{SheetApp, grid::Geo};
use serde_json::json;

struct Harness {
    app: SheetApp,
    ctx: egui::Context,
    time: f64,
    repeat_pointer_pass: bool,
}

impl Harness {
    fn new(initial: &str) -> Self {
        let mut session = Session::new();
        session.new_workbook();
        session.execute("cell.set", json!({"cell": "D6", "input": initial})).unwrap();
        session.execute("home.insertSheet", json!({"name": "Other"})).unwrap();
        session.execute("sheet.activate", json!({"sheet": "Sheet1"})).unwrap();
        let mut h = Self { app: SheetApp::new(session, Default::default()), ctx: egui::Context::default(), time: 0.0, repeat_pointer_pass: false };
        for _ in 0..6 {
            h.frame(vec![]);
        }
        h
    }

    fn frame(&mut self, events: Vec<Event>) -> egui::FullOutput {
        self.time += 1.0 / 60.0;
        let mut raw = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(1200.0, 800.0))),
            time: Some(self.time),
            events,
            ..Default::default()
        };
        self.app.raw_input_hook(&mut raw);
        self.ctx.run_ui(raw, |ui| {
            self.app.logic(ui.ctx());
            self.app.ui(ui);
            if self.repeat_pointer_pass && self.app.has_pending_input() && ui.ctx().current_pass_index() == 0 {
                ui.ctx().request_discard("exercise a second layout pass in the pointer frame");
            }
        })
    }

    fn point(&self, a1: &str) -> Pos2 {
        let sheet = self.app.session.active().unwrap().wb.active().unwrap();
        Geo::new(sheet, self.app.grid.rect.unwrap(), self.app.view().scroll).cell_rect(sheet, CellRef::parse(a1).unwrap()).center()
    }

    fn click(&mut self, a1: &str) -> egui::FullOutput {
        let pos = self.point(a1);
        self.frame(vec![Event::PointerMoved(pos), button(pos, true)]);
        self.frame(vec![button(pos, false)])
    }

    fn double_click(&mut self, a1: &str, batched: bool) -> egui::FullOutput {
        if batched {
            let pos = self.point(a1);
            self.frame(vec![Event::PointerMoved(pos), button(pos, true), button(pos, false), button(pos, true), button(pos, false)])
        } else {
            self.click(a1);
            self.click(a1)
        }
    }

    fn key(&mut self, key: Key) {
        self.frame(vec![
            Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE },
            Event::Key { key, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE },
        ]);
        self.frame(vec![]);
    }

    fn text(&mut self, text: &str) {
        self.frame(vec![Event::Text(text.into())]);
        self.frame(vec![]);
    }

    fn value(&self, a1: &str) -> Value {
        self.app.session.active().unwrap().wb.active().unwrap().value(CellRef::parse(a1).unwrap())
    }
}

fn button(pos: Pos2, pressed: bool) -> Event {
    Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers: Modifiers::NONE }
}

#[test]
fn double_click_waits_for_a_new_frame_then_preserves_and_commits_text() {
    for batched in [false, true] {
        for initial in ["", "before"] {
            let mut h = Harness::new(initial);
            // Match the native failure sequence: ordinary A1 typing succeeds before D6.
            h.click("A1");
            h.text("42");
            h.key(Key::Enter);
            assert_eq!(h.value("A1"), Value::Number(42.0));
            assert!(h.app.editor.is_none());

            h.repeat_pointer_pass = true;
            let release = h.double_click("D6", batched);
            assert!(release.platform_output.num_completed_passes >= 2, "the pointer frame must exercise a discarded layout pass");
            assert!(h.app.editor.is_none(), "even a second layout pass must not create the editor in the pointer callback");
            assert!(release.platform_output.ime.is_none(), "the pointer frame must not request a text input focus");
            assert!(h.app.has_pending_input(), "save and tab activation must wait for the queued edit");
            assert_eq!(h.app.session.mode, Mode::Ready);

            h.frame(vec![]);
            let editor = h.app.editor.as_ref().unwrap();
            assert_eq!(editor.cell.a1(), "D6");
            assert_eq!(editor.text, initial);
            assert!(!editor.enter_mode, "double-click must retain edit mode rather than replacing cell text");
            assert!(!h.app.has_pending_input());
            h.frame(vec![]); // The normal TextEdit focus/IME pass.
            h.text("99");
            h.key(Key::Enter);
            assert_eq!(h.value("D6"), if initial.is_empty() { Value::Number(99.0) } else { Value::from("before99") });
            assert_eq!(h.value("A1"), Value::Number(42.0));
            assert_eq!(h.app.session.active().unwrap().selection.active.a1(), "D7");
        }
    }
}

#[test]
fn queued_double_click_does_not_follow_a_changed_document_sheet_cell_or_revision() {
    for changed in ["document", "sheet", "cell", "revision", "cancel"] {
        let mut h = Harness::new("before");
        let pos = h.point("D6");
        h.frame(vec![
            Event::PointerMoved(pos),
            button(pos, true),
            button(pos, false),
            button(pos, true),
            button(pos, false),
            Event::Text("stale".into()),
            Event::Key { key: Key::Enter, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE },
            Event::Key { key: Key::Enter, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE },
        ]);
        assert!(h.app.has_pending_input());
        match changed {
            "document" => {
                h.app.session.new_workbook();
                h.app.session.execute("selection.set", json!({"cell": "D6"})).unwrap();
            }
            "sheet" => {
                let revision = h.app.session.active().unwrap().revision;
                h.app.session.execute("sheet.activate", json!({"sheet": "Other"})).unwrap();
                h.app.session.execute("selection.set", json!({"cell": "D6"})).unwrap();
                assert_eq!(h.app.session.active().unwrap().revision, revision, "sheet identity is checked independently of edits");
            }
            "cell" => {
                h.app.session.execute("selection.set", json!({"cell": "E7"})).unwrap();
            }
            "revision" => {
                h.app.session.execute("cell.set", json!({"cell": "D6", "input": "changed"})).unwrap();
            }
            "cancel" => h.app.cancel_edit(),
            _ => unreachable!(),
        }
        let workbook = h.app.session.active().unwrap().wb.clone();
        h.frame(vec![]);
        h.frame(vec![]);
        assert!(h.app.editor.is_none(), "a stale {changed} request must be discarded");
        assert!(!h.app.has_pending_input());
        assert_eq!(h.app.session.active().unwrap().wb, workbook, "queued text must not modify the new {changed} target");

        // Input arriving after the target changed is independent of the discarded gesture.
        h.text("fresh");
        h.key(Key::Enter);
        let expected = if changed == "cell" { "E7" } else { "D6" };
        assert_eq!(h.value(expected), Value::from("fresh"));
    }
}

#[test]
fn f2_still_begins_editing_immediately_and_supersedes_a_queued_double_click() {
    let mut h = Harness::new("before");
    h.click("D6");
    h.frame(vec![Event::Key { key: Key::F2, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE }]);
    assert_eq!(h.app.editor.as_ref().unwrap().text, "before");
    assert!(!h.app.has_pending_input());
    h.frame(vec![Event::Key { key: Key::F2, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE }]);
    h.key(Key::Escape);
    h.time += 1.0; // Start a fresh double-click gesture, outside the earlier click's interval.
    h.double_click("D6", false);
    assert!(h.app.has_pending_input());
    h.app.begin_edit(Some("replacement".into()), false);
    h.frame(vec![]);
    assert_eq!(h.app.editor.as_ref().unwrap().text, "replacement", "an explicit new edit wins over the queued double-click");
    assert!(h.app.editor.as_ref().unwrap().enter_mode);
    assert!(!h.app.has_pending_input());
}

#[test]
fn double_click_preserves_immediate_text_commit_and_next_cell_input() {
    for same_pointer_batch in [false, true] {
        for initial in ["", "before"] {
            let mut h = Harness::new(initial);
            let input = vec![
                Event::Text("99".into()),
                Event::Key { key: Key::Enter, physical_key: None, pressed: true, repeat: false, modifiers: Modifiers::NONE },
                Event::Key { key: Key::Enter, physical_key: None, pressed: false, repeat: false, modifiers: Modifiers::NONE },
                Event::Text("next".into()),
            ];
            if same_pointer_batch {
                let pos = h.point("D6");
                let mut events = vec![Event::PointerMoved(pos), button(pos, true), button(pos, false), button(pos, true), button(pos, false)];
                events.extend(input);
                h.frame(events);
            } else {
                h.double_click("D6", false);
                // No idle focus frame: this input is already waiting when the edit starts.
                h.frame(input);
            }
            for _ in 0..6 {
                h.frame(vec![]);
            }
            assert_eq!(h.value("D6"), if initial.is_empty() { Value::Number(99.0) } else { Value::from("before99") });
            let editor = h.app.editor.as_ref().unwrap();
            assert_eq!(editor.cell.a1(), "D7", "input after Enter belongs to the next cell");
            assert_eq!(editor.text, "next");
            assert!(!h.app.has_pending_input());
            h.key(Key::Enter);
            assert_eq!(h.value("D7"), Value::from("next"));
        }
    }
}
