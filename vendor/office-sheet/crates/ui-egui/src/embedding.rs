//! Editing-only presentation for a shell that owns workbook files and windows.

use serde_json::{Value, json};

pub(crate) fn tab_visible(tab: &str) -> bool {
    !matches!(tab, "File" | "Help")
}

pub(crate) fn dialog_visible(name: &str) -> bool {
    !matches!(
        name,
        "open" | "openPassword" | "saveAs" | "saveCopy" | "saveChanges" | "close" | "start" | "backstage" | "options" | "about" | "agents"
    )
}

/// File shortcuts are offered to the host before this presentation policy. Print-preview
/// geometry and workbook metadata remain available to the spreadsheet's editing tools.
pub(crate) fn command_visible(id: &str) -> bool {
    (!id.starts_with("file.") || matches!(id, "file.printPreview" | "file.properties"))
        && !id.starts_with("help.")
        && !matches!(
            id,
            "ui.backstage"
                | "ui.printSettings"
                | "ui.printSubmit"
                | "app.quit"
                | "data.getData"
                | "window.activate"
                | "view.newWindow"
                | "view.hideWindow"
                | "view.unhideWindow"
                | "view.switchWindows"
                | "view.theme"
                | "view.darkMode"
        )
}

pub(crate) fn command_allowed(id: &str, params: &Value) -> bool {
    command_visible(id)
        && (id != "ui.ribbonTab" || params.get("tab").and_then(Value::as_str).is_none_or(tab_visible))
        && (id != "ui.dialog" || params.get("name").and_then(Value::as_str).is_none_or(dialog_visible))
}

pub(crate) fn action_visible(action: crate::keytips::Action) -> bool {
    use crate::keytips::Action;
    match action {
        Action::Tab(tab) => tab_visible(tab),
        Action::Command(id) | Action::Pending(id) => command_visible(id),
        Action::Dialog(name) => dialog_visible(name),
        Action::Control(id) => command_visible(id) && dialog_visible(id),
    }
}

/// Geometry comes from the controls actually drawn in this frame, so browser checks can
/// distinguish a hidden preference from a File button accidentally left on the canvas.
pub(crate) fn reset_drawn(ctx: &egui::Context) {
    ctx.data_mut(|data| data.insert_temp(egui::Id::new("sheet_drawn_chrome"), Vec::<Value>::new()));
}

pub(crate) fn record(ctx: &egui::Context, id: &str, label: &str, rect: egui::Rect) {
    if !rect.is_positive() || !rect.min.is_finite() || !rect.max.is_finite() {
        return;
    }
    ctx.data_mut(|data| {
        data.get_temp_mut_or_default::<Vec<Value>>(egui::Id::new("sheet_drawn_chrome"))
            .push(json!({"id": id, "label": label, "rect": [rect.left(), rect.top(), rect.width(), rect.height()]}));
    });
}

pub(crate) fn drawn(ctx: &egui::Context) -> Vec<Value> {
    ctx.data(|data| data.get_temp(egui::Id::new("sheet_drawn_chrome"))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Services, SheetApp};
    use egui::{Context, Event, Key, Modifiers};
    use office_sheet_engine::Session;
    use std::{cell::RefCell, rc::Rc};

    fn app(services: Services) -> SheetApp {
        let mut session = Session::new();
        session.new_workbook();
        SheetApp::new(session, services)
    }

    fn frame(ctx: &Context, app: &mut SheetApp, events: Vec<Event>) {
        let mut input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1600.0, 900.0))),
            events,
            ..Default::default()
        };
        app.raw_input_hook(&mut input);
        let mut output = ctx.run_ui(input, |ui| {
            app.logic(ui.ctx());
            app.ui(ui);
        });
        output.textures_delta.clear();
    }

    fn settle(ctx: &Context, app: &mut SheetApp) {
        for _ in 0..4 {
            frame(ctx, app, vec![]);
        }
    }

    fn key(key: Key, modifiers: Modifiers) -> Event {
        Event::Key { key, physical_key: Some(key), pressed: true, repeat: false, modifiers }
    }

    #[test]
    fn browser_double_click_recovers_slow_pointer_processing_without_committing_or_restarting_edits() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        app.run("cell.set", json!({"cell":"D6", "input":"Original"})).unwrap();
        settle(&ctx, &mut app);
        let doc = app.session.active().unwrap();
        let pos = app.grid.geo.as_ref().unwrap().screen_cell_rect(doc.wb.active().unwrap(), office_sheet_engine::core::CellRef::new(5, 3)).center();
        // These are two ordinary pointer clicks processed 500 ms apart. The browser
        // can still recognize their OS double-click while egui's 300 ms window cannot.
        for (time, pressed) in [(1.0, true), (1.01, false), (1.5, true), (1.51, false)] {
            let mut input = egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1600.0, 900.0))),
                time: Some(time),
                events: vec![
                    Event::PointerMoved(pos),
                    Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: Modifiers::NONE },
                ],
                ..Default::default()
            };
            app.raw_input_hook(&mut input);
            let mut output = ctx.run_ui(input, |ui| {
                app.logic(ui.ctx());
                app.ui(ui);
            });
            output.textures_delta.clear();
        }
        assert_eq!(app.session.mode, office_sheet_engine::Mode::Ready);
        assert_eq!(app.session.active().unwrap().selection.active.a1(), "D6");
        assert!(app.editor.is_none());
        let workbook = app.session.active().unwrap().wb.clone();
        let revision = app.session.active().unwrap().revision;
        assert!(crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        assert_eq!(app.editor.as_ref().unwrap().text, "Original");
        assert_eq!(app.session.mode, office_sheet_engine::Mode::Edit);
        assert!(std::sync::Arc::ptr_eq(&workbook, &app.session.active().unwrap().wb));
        assert_eq!(app.session.active().unwrap().revision, revision);
        frame(&ctx, &mut app, vec![]);
        assert_eq!(app.editor.as_ref().unwrap().text, "Original", "the consumed pointer release must not close the new editor on repaint");
        assert_eq!(app.session.mode, office_sheet_engine::Mode::Edit);

        let editor = app.editor.as_mut().unwrap();
        editor.text = "=1+".into();
        editor.caret = 2;
        editor.request_focus = false;
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        let editor = app.editor.as_ref().unwrap();
        assert_eq!((editor.text.as_str(), editor.caret, editor.request_focus), ("=1+", 2, false));
        assert!(app.message.is_none(), "the invalid draft must never be committed");
        assert!(std::sync::Arc::ptr_eq(&workbook, &app.session.active().unwrap().wb));
    }

    #[test]
    fn browser_double_click_rejects_controls_menus_objects_and_stale_grid_surfaces() {
        use office_sheet_engine::{
            core::{CellRef, RangeRef},
            model::{Anchor, AutoFilter, Color, Shape, ShapeKind},
        };
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        let cell = CellRef::new(5, 3);
        app.run("selection.set", json!({"cell":"D6"})).unwrap();
        settle(&ctx, &mut app);
        app.grid.last_click = Some(cell);
        let geo = app.grid.geo.clone().unwrap();
        let sheet = app.session.active().unwrap().wb.active().unwrap();
        let rect = geo.screen_cell_rect(sheet, cell);
        let pos = rect.center();
        for rejected in [
            egui::pos2(f32::NAN, 0.0),
            egui::pos2(5.0, 5.0),                                     // ribbon, outside the cell surface
            egui::pos2(pos.x, geo.cells.top() - 4.0),                 // column header
            egui::pos2(geo.cells.left() - 4.0, pos.y),                // row header
            egui::pos2(geo.cells.right() + 3.0, pos.y),               // vertical scrollbar
            rect.right_bottom(),                                      // fill handle
            egui::pos2(rect.left(), pos.y),                           // move border
            geo.screen_cell_rect(sheet, CellRef::new(5, 4)).center(), // another cell
        ] {
            assert!(!crate::grid::browser_double_click(&mut app, &ctx, rejected, false), "{rejected:?}");
        }
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, true));
        app.grid.context_menu = Some(pos);
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        app.grid.context_menu = None;
        app.grid.filter_menu = Some((3, 5, pos));
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        app.grid.filter_menu = None;
        app.grid.list_picker = Some(cell);
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        app.grid.list_picker = None;
        app.open_dialog("formatCells", json!({}));
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        app.dialog = None;
        egui::Popup::open_id(&ctx, egui::Id::new("blocked-cell-menu"));
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        egui::Popup::close_all(&ctx);
        app.grid.last_click = None;
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        app.grid.last_click = Some(cell);
        app.grid.interaction_surface = app.grid.interaction_surface.map(|(layer, uid, sheet)| (layer, uid, sheet + 1));
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        settle(&ctx, &mut app);
        app.grid.last_click = Some(cell);
        let wb = std::sync::Arc::make_mut(&mut app.session.active_mut().unwrap().wb);
        std::sync::Arc::make_mut(&mut wb.sheets[0]).shapes.push(Shape {
            id: 1,
            kind: ShapeKind::Rectangle,
            anchor: Anchor { cell, width: 80.0, height: 30.0, ..Default::default() },
            fill: Color::rgb(0, 0, 0),
            line: Color::rgb(0, 0, 0),
            text: String::new(),
            format: Default::default(),
        });
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
        assert!(app.editor.is_none());
        let wb = std::sync::Arc::make_mut(&mut app.session.active_mut().unwrap().wb);
        let sheet = std::sync::Arc::make_mut(&mut wb.sheets[0]);
        sheet.shapes.clear();
        sheet.autofilter = Some(AutoFilter { range: RangeRef::new(cell, CellRef::new(9, 3)), criteria: vec![] });
        let filter = crate::grid::filter_button_rect(&geo, sheet, cell).center();
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, filter, false));

        for _ in 0..2 {
            let mut output = ctx.run_ui(egui::RawInput::default(), |ui| {
                app.logic(ui.ctx());
                app.ui(ui);
                egui::Area::new(egui::Id::new("foreground-cell-cover")).order(egui::Order::Foreground).fixed_pos(pos - egui::vec2(12.0, 12.0)).show(
                    ui.ctx(),
                    |ui| {
                        ui.allocate_exact_size(egui::vec2(30.0, 30.0), egui::Sense::click());
                    },
                );
            });
            output.textures_delta.clear();
        }
        assert_ne!(ctx.layer_id_at(pos), app.grid.interaction_surface.map(|surface| surface.0));
        assert!(!crate::grid::browser_double_click(&mut app, &ctx, pos, false));
    }

    #[test]
    fn embedded_editor_draws_editing_controls_without_file_chrome() {
        assert!(!Services::default().embedded_editor);
        for embedded in [false, true] {
            let ctx = Context::default();
            let mut app = app(Services { embedded_editor: embedded, ..Default::default() });
            if embedded {
                // A stale preference or direct restore cannot reveal the standalone shell.
                app.backstage = Some(crate::backstage::Backstage::new(crate::backstage::Page::Home));
                app.ui.ribbon_tab = "File".into();
            }
            settle(&ctx, &mut app);
            let controls = drawn(&ctx);
            let has = |id: &str| controls.iter().any(|control| control["id"] == id);
            for id in ["titleBar", "tab:File"] {
                assert_eq!(has(id), !embedded, "{id}, embedded={embedded}");
            }
            for id in ["tab:Home", "tab:Insert", "tab:Formulas", "home.bold", "formulaBar", "sheetTab:0", "addSheet", "statusBar"] {
                assert!(has(id), "{id}, embedded={embedded}");
            }
            if embedded {
                assert!(has("quickAccess:edit.undo") && has("quickAccess:edit.redo"));
                assert!(app.backstage.is_none());
                assert_eq!(app.application_name(), "Open Office");
            }
        }
    }

    #[test]
    fn embedded_editor_blocks_standalone_dialogs_commands_and_control_aliases() {
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        let ctx = Context::default();
        for name in ["about", "agents", "start", "saveCopy", "saveChanges", "openPassword", "options"] {
            assert!(app.run("ui.dialog", json!({"name": name})).is_err(), "{name}");
            app.open_dialog(name, json!({}));
            assert!(app.dialog.is_none(), "{name}");
            assert!(crate::dialogs::Dialog::open(&mut app, name, json!({})).is_none());
        }
        for (id, params) in [("ui.backstage", json!({})), ("ui.ribbonTab", json!({"tab": "File"})), ("file.saveBytes", json!({}))] {
            assert!(app.run(id, params).is_err(), "{id}");
        }
        for (method, params) in [("ui.ribbon", json!({"tab": "Help"})), ("ui.dialog", json!({"name": "about"}))] {
            let crate::control::Outcome::Done(reply) = crate::control::handle(&mut app, &ctx, method, &params) else { panic!("expected reply") };
            assert_eq!(reply["ok"], false, "{method}");
        }
        let crate::control::Outcome::Done(reply) = crate::control::handle(&mut app, &ctx, "engine.commands", &json!({})) else {
            panic!("expected command list")
        };
        let commands = reply["result"].as_array().unwrap();
        assert!(!commands.iter().any(|command| matches!(command["id"].as_str(), Some("file.new" | "file.save" | "ui.backstage"))));
        assert!(commands.iter().any(|command| command["id"] == "home.bold"));
        app.open_dialog("formatCells", json!({}));
        assert_eq!(app.dialog.as_ref().unwrap().name(), "formatCells");
    }

    #[test]
    fn embedded_editor_file_shortcuts_delegate_once_without_saving_or_closing() {
        let calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let received = calls.clone();
        let mut app = app(Services {
            embedded_editor: true,
            host_command: Some(Box::new(move |id, _| {
                id.starts_with("file.").then(|| {
                    received.borrow_mut().push(id.into());
                    Ok(json!({"delegated": true}))
                })
            })),
            ..Default::default()
        });
        app.run("cell.set", json!({"cell": "A1", "input": "42"})).unwrap();
        let revision = app.session.active().unwrap().revision;
        for (key, shift) in [(Key::N, false), (Key::O, false), (Key::S, false), (Key::S, true), (Key::P, false), (Key::W, false)] {
            crate::ribbon::shortcut(&mut app, key, Modifiers { command: true, shift, ..Default::default() });
        }
        assert_eq!(*calls.borrow(), ["file.new", "file.open", "file.save", "file.saveAs", "file.print", "file.close"]);
        assert_eq!(app.session.documents().len(), 1);
        assert_eq!(app.session.active().unwrap().revision, revision);
        assert!(app.session.active().unwrap().is_dirty());
        assert!(app.dialog.is_none() && app.backstage.is_none() && app.message.is_none());
    }

    #[test]
    fn clipboard_button_delegates_read_without_intercepting_internal_paste() {
        let calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let received = calls.clone();
        let mut app = app(Services {
            embedded_editor: true,
            host_command: Some(Box::new(move |id, _| {
                received.borrow_mut().push(id.to_owned());
                (id == "host.pasteClipboard").then(|| Ok(json!({"pending": "host"})))
            })),
            ..Default::default()
        });
        app.run("cell.set", json!({"cell": "A1", "input": "Original"})).unwrap();
        let revision = app.session.active().unwrap().revision;
        calls.borrow_mut().clear();
        app.paste_from_clipboard();
        assert_eq!(*calls.borrow(), ["host.pasteClipboard"]);
        assert_eq!(app.session.active().unwrap().revision, revision);
        assert!(app.message.is_none());
        calls.borrow_mut().clear();
        assert!(app.run("edit.paste", json!({})).is_err());
        assert_eq!(*calls.borrow(), ["edit.paste"]);
    }

    #[test]
    fn opening_a_dialog_stops_cell_input_in_the_same_event_batch() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        app.run("cell.set", json!({"cell": "A1", "input": "Original"})).unwrap();
        settle(&ctx, &mut app);
        let before = app.session.active().unwrap().revision;
        frame(&ctx, &mut app, vec![key(Key::F, Modifiers::COMMAND), key(Key::Delete, Modifiers::NONE), Event::Paste("replacement".into())]);
        assert_eq!(app.dialog.as_ref().unwrap().name(), "find");
        assert_eq!(app.session.active().unwrap().revision, before);
        assert!(app.editor.is_none());
    }

    #[test]
    fn a_dialog_preserves_the_uncommitted_formula_bar_draft() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        settle(&ctx, &mut app);
        app.begin_edit(Some("=SUM(A1:A3)".into()), true);
        settle(&ctx, &mut app);
        app.open_dialog("commandSearch", json!({}));
        let before = app.session.active().unwrap().revision;
        frame(&ctx, &mut app, vec![Event::Text("bold".into()), key(Key::Delete, Modifiers::NONE)]);
        assert_eq!(app.editor.as_ref().unwrap().text, "=SUM(A1:A3)");
        assert_eq!(app.session.active().unwrap().revision, before);
    }

    #[test]
    fn embedded_keytips_hide_file_navigation_and_keep_editing_tabs() {
        let ctx = Context::default();
        ctx.set_os(egui::os::OperatingSystem::Nix);
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        settle(&ctx, &mut app);
        frame(&ctx, &mut app, vec![key(Key::F10, Modifiers::NONE)]);
        assert_eq!(app.keytips.prefix(), Some(""));
        frame(&ctx, &mut app, vec![key(Key::F, Modifiers::NONE)]);
        assert_eq!(app.keytips.prefix(), None);
        assert!(app.backstage.is_none() && app.dialog.is_none() && app.editor.is_none());
        frame(&ctx, &mut app, vec![key(Key::F10, Modifiers::NONE)]);
        frame(&ctx, &mut app, vec![key(Key::N, Modifiers::NONE)]);
        assert_eq!(app.ui.ribbon_tab, "Insert");
    }

    fn cell_input(app: &SheetApp, row: u32, col: u32) -> String {
        app.session
            .active()
            .unwrap()
            .wb
            .active()
            .unwrap()
            .cell(office_sheet_engine::core::CellRef::new(row, col))
            .map(|cell| cell.input_text())
            .unwrap_or_default()
    }

    fn drain_input(ctx: &Context, app: &mut SheetApp) {
        for _ in 0..10 {
            if !app.has_pending_input() {
                return;
            }
            frame(ctx, app, vec![]);
        }
        assert!(!app.has_pending_input(), "deferred input must finish without another user event");
    }

    #[test]
    fn text_chunks_and_enter_in_one_frame_commit_once_in_order() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        settle(&ctx, &mut app);
        frame(&ctx, &mut app, vec![Event::Text("中文".into()), Event::Text("排班".into()), key(Key::Enter, Modifiers::NONE)]);
        assert!(app.has_pending_input());
        assert_eq!(cell_input(&app, 0, 0), "");
        drain_input(&ctx, &mut app);
        assert_eq!(cell_input(&app, 0, 0), "中文排班");
        assert!(app.editor.is_none());
        assert_eq!(app.session.active().unwrap().selection.active.a1(), "A2");
    }

    #[test]
    fn text_after_same_frame_commit_belongs_to_the_next_cell() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        settle(&ctx, &mut app);
        frame(
            &ctx,
            &mut app,
            vec![Event::Text("A".into()), key(Key::Enter, Modifiers::NONE), Event::Text("B".into()), key(Key::Enter, Modifiers::NONE)],
        );
        drain_input(&ctx, &mut app);
        assert_eq!(cell_input(&app, 0, 0), "A");
        assert_eq!(cell_input(&app, 1, 0), "B");
        assert_eq!(cell_input(&app, 2, 0), "");
        assert!(app.editor.is_none());
    }

    #[test]
    fn f2_and_backspace_preserve_following_text_and_commit_keys() {
        for trigger in [Key::F2, Key::Backspace] {
            let ctx = Context::default();
            let mut app = app(Services { embedded_editor: true, ..Default::default() });
            app.run("cell.set", json!({"cell": "A1", "input": "old"})).unwrap();
            settle(&ctx, &mut app);
            frame(&ctx, &mut app, vec![key(trigger, Modifiers::NONE), Event::Text("new".into()), key(Key::Tab, Modifiers::NONE)]);
            drain_input(&ctx, &mut app);
            assert_eq!(cell_input(&app, 0, 0), if trigger == Key::F2 { "oldnew" } else { "new" });
            assert_eq!(app.session.active().unwrap().selection.active.a1(), "B1");
            assert!(app.editor.is_none());
        }
    }

    #[test]
    fn deferred_commit_precedes_text_from_the_next_browser_frame() {
        let ctx = Context::default();
        let mut app = app(Services { embedded_editor: true, ..Default::default() });
        settle(&ctx, &mut app);
        frame(&ctx, &mut app, vec![Event::Text("first".into()), key(Key::Enter, Modifiers::NONE)]);
        frame(&ctx, &mut app, vec![Event::Text("second".into()), key(Key::Enter, Modifiers::NONE)]);
        drain_input(&ctx, &mut app);
        assert_eq!(cell_input(&app, 0, 0), "first");
        assert_eq!(cell_input(&app, 1, 0), "second");
        assert!(app.editor.is_none());
    }

    #[test]
    fn first_pointer_click_after_commit_selects_the_clicked_cell() {
        for redraw_before_click in [true, false] {
            let ctx = Context::default();
            let mut app = app(Services { embedded_editor: true, ..Default::default() });
            settle(&ctx, &mut app);
            frame(&ctx, &mut app, vec![Event::Text("A long cell text spanning several columns".into()), key(Key::Enter, Modifiers::NONE)]);
            drain_input(&ctx, &mut app);
            assert!(app.editor.is_none());
            assert_eq!(app.session.active().unwrap().selection.active.a1(), "A2");
            if redraw_before_click {
                frame(&ctx, &mut app, vec![]);
            }
            let doc = app.session.active().unwrap();
            let pos =
                app.grid.geo.as_ref().unwrap().screen_cell_rect(doc.wb.active().unwrap(), office_sheet_engine::core::CellRef::new(0, 1)).center();
            frame(
                &ctx,
                &mut app,
                vec![
                    Event::PointerMoved(pos),
                    Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed: true, modifiers: Modifiers::NONE },
                ],
            );
            frame(
                &ctx,
                &mut app,
                vec![Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed: false, modifiers: Modifiers::NONE }],
            );
            assert_eq!(app.session.active().unwrap().selection.active.a1(), "B1", "redraw before click: {redraw_before_click}");
        }
    }
}
