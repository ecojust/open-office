//! Compact document controls for the containing application. File ownership stays in the shell.

use egui::{Align, Layout, Stroke, vec2};
use office_pdf_engine::{StampGroup, StampKind, catalog, commands};
use serde_json::{Value, json};

use crate::{LeftPanel, OfficePdfApp, QuickTool, RightPanel, canvas::Fit, icons, theme};

const RECORD: &str = "office-pdf-document-toolbar";

pub(crate) fn drawn(ctx: &egui::Context) -> Vec<Value> {
    ctx.data(|data| data.get_temp(egui::Id::new(RECORD))).unwrap_or_default()
}

pub(crate) fn record(ui: &egui::Ui, id: &str, response: &egui::Response) {
    let r = response.rect;
    ui.ctx().data_mut(|data| {
        data.get_temp_mut_or_default::<Vec<Value>>(egui::Id::new(RECORD))
            .push(json!({"id":id,"rect":[r.left(),r.top(),r.width(),r.height()],"enabled":response.enabled()}));
    });
}

fn button(ui: &mut egui::Ui, id: &str, icon: &str, label: &str, selected: bool, compact: bool) -> egui::Response {
    let t = theme::Tokens::get(ui.ctx());
    let response = if compact {
        icons::button(ui, icon, 32.0, selected, label)
    } else {
        ui.add(egui::Button::image_and_text(icons::image(ui, icon, icons::TOOL_SIZE, t.icon), label).selected(selected).min_size(vec2(0.0, 32.0)))
            .on_hover_text(label)
    };
    record(ui, id, &response);
    response
}

fn enabled(app: &OfficePdfApp, id: &str) -> bool {
    commands::command(id).is_some_and(|spec| app.command_enabled(spec))
}

fn command_button(app: &mut OfficePdfApp, ui: &mut egui::Ui, id: &str, label: &str, compact: bool) {
    let Some(spec) = commands::command(id) else { return };
    let selected = match id {
        "edit.edit_text" => app.quick_tool == QuickTool::EditText,
        "edit.text" => app.quick_tool == QuickTool::AddText,
        "comment.highlight" => app.quick_tool == QuickTool::Comment(crate::comments::CommentTool::Highlight),
        _ => false,
    };
    // A widget closure participates in the parent's wrapping layout. A nested UI scope
    // lays out its child before its size is known and can clip the last narrow-screen item.
    let clicked = ui.add_enabled(enabled(app, id), |ui: &mut egui::Ui| button(ui, id, spec.icon, label, selected, compact)).clicked();
    if clicked {
        app.run_command(id);
        // These controls carry their options in the toolbar instead of covering the page.
        if matches!(id, "edit.edit_text" | "edit.text") {
            app.left_open = false;
        }
    }
}

fn menu_command(app: &mut OfficePdfApp, ui: &mut egui::Ui, id: &str) {
    if !app.embedding_command_visible(id) {
        return;
    }
    let Some(spec) = commands::command(id) else { return };
    let label = commands::current_label(spec, &app.session, app.active_ids().map(|(_, id)| id));
    let label = crate::i18n::menu_label(id, &label);
    if ui
        .add_enabled(
            enabled(app, id),
            egui::Button::image_and_text(icons::image(ui, spec.icon, icons::TOOL_SIZE, theme::Tokens::get(ui.ctx()).icon), label),
        )
        .clicked()
    {
        app.run_command(id);
        ui.close();
    }
}

fn group_menu(app: &mut OfficePdfApp, ui: &mut egui::Ui, group: &str) {
    let Some(group) = catalog::group(group) else { return };
    // Some catalog groups still carry a future overall milestone while individual actions
    // already work. Judge each action, keeping unavailable import/export paths out.
    for section in group.sections {
        let items: Vec<_> = section
            .items
            .iter()
            .filter(|item| item.availability == catalog::Availability::Ready && app.embedding_command_visible(item.command))
            .collect();
        if items.is_empty() {
            continue;
        }
        ui.label(egui::RichText::new(tl!(section.title)).small().color(theme::Tokens::get(ui.ctx()).text_faint));
        for item in items {
            if item.actions.is_empty() {
                menu_command(app, ui, item.command);
            } else {
                ui.menu_button(tl!(item.label), |ui| {
                    for id in item.actions {
                        menu_command(app, ui, id);
                    }
                });
            }
        }
    }
}

fn bounded_menu(ui: &mut egui::Ui, id: &str, body: impl FnOnce(&mut egui::Ui)) {
    ui.set_width((ui.ctx().content_rect().width() - 40.0).clamp(240.0, 320.0));
    let height = (ui.ctx().content_rect().height() - 110.0).clamp(100.0, 390.0);
    egui::ScrollArea::vertical().id_salt(id).max_height(height).show(ui, body);
}

fn advanced(app: &mut OfficePdfApp, ui: &mut egui::Ui) {
    bounded_menu(ui, "advanced", |ui| {
        for (label, groups) in [
            (tl!("Manage pages"), &["organize"][..]),
            (tl!("Page content and decoration"), &["edit"][..]),
            (tl!("Fill and forms"), &["fill_sign", "form"][..]),
            (tl!("Security and signature validation"), &["protect", "redact", "certificate"][..]),
            (tl!("Inspect and measure"), &["scan", "accessibility", "standards", "measure"][..]),
            (tl!("Optimize and scripts"), &["compress", "javascript"][..]),
        ] {
            ui.menu_button(label, |ui| {
                bounded_menu(ui, label, |ui| {
                    for group in groups {
                        group_menu(app, ui, group);
                    }
                })
            });
        }
        ui.separator();
        menu_command(app, ui, "file.properties");
        menu_command(app, ui, "file.word_count");
        menu_command(app, ui, "view.palette");
        menu_command(app, ui, "help.shortcuts");
    });
}

fn stamp_label(kind: StampKind) -> &'static str {
    use StampKind::*;
    match kind {
        Approved | DynApproved => tl!("Approved"),
        Completed => tl!("Completed"),
        Confidential | DynConfidential => tl!("Confidential"),
        Draft => tl!("Draft"),
        Final => tl!("Final"),
        ForComment => tl!("For Comment"),
        ForPublicRelease => tl!("For Public Release"),
        InformationOnly => tl!("Information Only"),
        NotApproved => tl!("Not Approved"),
        NotForPublicRelease => tl!("Not For Public Release"),
        PreliminaryResults => tl!("Preliminary Results"),
        Void => tl!("Void"),
        Accepted => tl!("Accepted"),
        InitialHere => tl!("Initial Here"),
        Rejected => tl!("Rejected"),
        SignHere => tl_ctx!("embedded", "Sign Here"),
        Witness => tl!("Witness"),
        DynReceived => tl!("Received"),
        DynReviewed => tl!("Reviewed"),
        DynRevised => tl!("Revised"),
    }
}

fn stamps(app: &mut OfficePdfApp, ui: &mut egui::Ui) {
    bounded_menu(ui, "stamp-picker", |ui| {
        ui.label(egui::RichText::new(tl!("Choose a stamp, then click the page to place it")).small());
        for (group, label) in
            [(StampGroup::Dynamic, tl!("Dynamic")), (StampGroup::SignHere, tl!("Signing prompts")), (StampGroup::StandardBusiness, tl!("Common"))]
        {
            ui.menu_button(label, |ui| {
                for kind in StampKind::ALL.into_iter().filter(|kind| kind.group() == group) {
                    // The preview names the actual appearance written into the document.
                    if ui.selectable_label(app.quick_tool == QuickTool::Stamp(kind), format!("{} · {}", stamp_label(kind), kind.label())).clicked() {
                        app.quick_tool = QuickTool::Stamp(kind);
                        app.left_open = false;
                        ui.close();
                    }
                }
            });
        }
        if !app.custom_stamps.is_empty() {
            let t = theme::Tokens::get(ui.ctx());
            crate::stamps_ui::palette_section(app, ui, &t);
        }
    });
}

fn signature(app: &mut OfficePdfApp, ui: &mut egui::Ui) {
    bounded_menu(ui, "signature-picker", |ui| {
        ui.label(egui::RichText::new(tl!("Visual signature")).strong());
        ui.label(egui::RichText::new(tl!("Draw, type, or import an image, then click the page to place it.")).small());
        let t = theme::Tokens::get(ui.ctx());
        if let Some(command) = crate::fill_sign::signature_entries(ui, app, &t) {
            app.run_command(command);
            ui.close();
        }
        ui.separator();
        ui.label(
            egui::RichText::new(tl!(
                "Visual signatures do not contain digital certificates. Existing certificate signatures can be viewed and validated."
            ))
            .small()
            .color(theme::Tokens::get(ui.ctx()).text_muted),
        );
        menu_command(app, ui, "sign.validate");
    });
}

fn view_menu(app: &mut OfficePdfApp, ui: &mut egui::Ui) {
    bounded_menu(ui, "view-picker", |ui| {
        if let Some(view) = app.active.and_then(|index| app.views.get_mut(index)) {
            for (fit, label) in [(Fit::Page, tl!("Fit page")), (Fit::Width, tl!("Fit width")), (Fit::Height, tl!("Fit height"))] {
                if ui.selectable_label(view.fit == fit, label).clicked() {
                    view.set_fit(fit);
                    ui.close();
                }
            }
            if ui.button(tl!("Actual size")).clicked() {
                view.set_zoom(1.0);
                ui.close();
            }
        }
        for id in ["view.layout.single", "view.layout.two_up", "view.continuous", "view.layout.cover", "view.full_screen"] {
            menu_command(app, ui, id);
        }
        ui.separator();
        ui.menu_button(tl!("Sidebar"), |ui| {
            for (panel, label) in [
                (RightPanel::Pages, tl!("Page thumbnails")),
                (RightPanel::Bookmarks, tl!("Bookmarks")),
                (RightPanel::Comments, tl_ctx!("embedded", "Comments")),
                (RightPanel::Fields, tl_ctx!("embedded", "Form fields")),
                (RightPanel::Layers, tl!("Layers")),
                (RightPanel::Attachments, tl!("Attachments")),
                (RightPanel::Signatures, tl!("Existing signatures")),
            ] {
                if ui.selectable_label(app.right == Some(panel), label).clicked() {
                    app.choose_right_panel(if app.right == Some(panel) { None } else { Some(panel) });
                    ui.close();
                }
            }
        });
    });
}

/// Wrap, rather than horizontally clip, at small viewport widths. Every control stays reachable.
pub(crate) fn show(app: &mut OfficePdfApp, ui: &mut egui::Ui) {
    ui.ctx().data_mut(|data| data.insert_temp(egui::Id::new(RECORD), Vec::<Value>::new()));
    let t = theme::Tokens::get(ui.ctx());
    egui::Panel::top("document_toolbar")
        .frame(egui::Frame::NONE.fill(t.chrome).inner_margin(egui::Margin::symmetric(10, 7)).stroke(Stroke::new(1.0, t.divider)))
        .show(ui, |ui| {
            let compact = ui.available_width() < 850.0;
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = vec2(5.0, 5.0);
                ui.add_enabled_ui(app.active.is_some(), |ui| {
                    for (tool, id, icon, label) in
                        [(QuickTool::Select, "select", "mouse-pointer-2", tl!("Select")), (QuickTool::Hand, "hand", "hand", tl!("Hand"))]
                    {
                        if button(ui, id, icon, label, app.quick_tool == tool, compact).clicked() {
                            app.put_down_edit_text();
                            app.quick_tool = tool;
                            app.left_open = false;
                        }
                    }
                    command_button(app, ui, "edit.edit_text", tl_ctx!("embedded", "Edit text"), compact);
                    command_button(app, ui, "edit.text", tl_ctx!("embedded", "Add text"), compact);
                    command_button(app, ui, "comment.highlight", tl_ctx!("embedded", "Highlight"), compact);
                    let annotations =
                        button(ui, "annotations", "message-square-text", tl!("Annotate"), matches!(app.quick_tool, QuickTool::Comment(_)), compact);
                    egui::Popup::menu(&annotations).show(|ui| bounded_menu(ui, "annotations", |ui| group_menu(app, ui, "comment")));
                    let sig = ui.add_enabled(enabled(app, "sign.fill.signature"), |ui: &mut egui::Ui| {
                        button(ui, "signature", "signature", tl!("Signature"), matches!(app.quick_tool, QuickTool::Fill(_)), compact)
                    });
                    egui::Popup::menu(&sig).show(|ui| signature(app, ui));
                    let stamp = ui.add_enabled(enabled(app, "comment.stamp"), |ui: &mut egui::Ui| {
                        button(
                            ui,
                            "stamps",
                            "stamp",
                            tl!("Stamps"),
                            matches!(app.quick_tool, QuickTool::Stamp(_) | QuickTool::CustomStamp(_)),
                            compact,
                        )
                    });
                    egui::Popup::menu(&stamp).show(|ui| stamps(app, ui));
                    if matches!(app.quick_tool, QuickTool::AddText | QuickTool::EditText) {
                        let format = button(ui, "format", "settings-2", tl!("Text formatting"), false, compact);
                        egui::Popup::menu(&format).show(|ui| {
                            bounded_menu(ui, "text-format", |ui| {
                                let t = theme::Tokens::get(ui.ctx());
                                crate::panels::format_section(app, ui, &t)
                            })
                        });
                    }
                    let view = button(ui, "view", "panels-top-left", tl!("View"), false, false);
                    egui::Popup::menu(&view).show(|ui| view_menu(app, ui));
                    let more = button(ui, "advanced", "sliders-horizontal", tl!("Advanced"), false, false);
                    egui::Popup::menu(&more).show(|ui| advanced(app, ui));
                    if app.unfinished_comment().is_some()
                        && button(ui, "comment-draft", "message-square-text", tl!("Pending comments"), app.comment_draft_dialog.is_some(), false)
                            .clicked()
                    {
                        app.open_comment_drafts();
                    }
                });
            });
            if app.active.is_some() {
                ui.horizontal_wrapped(|ui| {
                    if let Some(view) = app.active.and_then(|index| app.views.get_mut(index)) {
                        if icons::button(ui, "chevron-left", 26.0, false, tl!("Previous page")).clicked() {
                            view.step_page(false);
                        }
                        let count = app.session.get(view.id).map_or(0, |doc| doc.info.pages.len());
                        ui.label(crate::i18n::fmt(
                            tl!("Page {page} of {count}"),
                            &[("page", &(view.current + 1).to_string()), ("count", &count.to_string())],
                        ));
                        if icons::button(ui, "chevron-right", 26.0, false, tl!("Next page")).clicked() {
                            view.step_page(true);
                        }
                        ui.add_space(6.0);
                        if icons::button(ui, "zoom-out", 26.0, false, tl!("Zoom out")).clicked() {
                            view.zoom_step(false);
                        }
                        ui.label(format!("{:.0}%", view.zoom * 100.0));
                        if icons::button(ui, "zoom-in", 26.0, false, tl!("Zoom in")).clicked() {
                            view.zoom_step(true);
                        }
                    }
                    command_button(app, ui, "edit.find", tl!("Find"), true);
                    command_button(app, ui, "edit.undo", tl!("Undo"), true);
                    command_button(app, ui, "edit.redo", tl!("Redo"), true);
                    if let QuickTool::Comment(tool) = app.quick_tool {
                        if let Some(color) = crate::comments::quick_bar_controls(ui, tool, &mut app.comment_prefs)
                            && let Some((index, id)) = app.active_ids()
                            && let Some((page, annotation)) = app.views.get(index).and_then(|view| view.comments.selected)
                            && app.session.get(id).is_some_and(|doc| {
                                doc.allows_annotation()
                                    && doc.info.annotations.iter().any(|a| {
                                        a.page == page && a.index == annotation && a.in_reply_to.is_none() && crate::comments::made_by(a, tool)
                                    })
                            })
                        {
                            app.apply_edit(office_pdf_engine::Edit::StyleAnnotation {
                                page,
                                index: annotation,
                                color: Some(color),
                                opacity: None,
                                width: None,
                                endings: None,
                            });
                        }
                    }
                    if app.left_open && app.left != LeftPanel::AllTools {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button(tl!("Collapse tool settings")).clicked() {
                                app.left_open = false;
                            }
                        });
                    }
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> OfficePdfApp {
        let mut app = OfficePdfApp::new();
        app.embedded = true;
        let bytes = app.session.create_blank(595.0, 842.0, 1).unwrap();
        app.open_bytes("Toolbar.pdf", None, bytes.as_ref().clone()).unwrap();
        app.left_open = false;
        app
    }

    fn frame(app: &mut OfficePdfApp, ctx: &egui::Context, width: f32, events: Vec<egui::Event>) {
        ctx.run_ui(
            egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, vec2(width, 700.0))), events, ..Default::default() },
            |ui| show(app, ui),
        )
        .drop_without_applying_deltas();
    }

    fn control(ctx: &egui::Context, id: &str) -> egui::Rect {
        let item = drawn(ctx).into_iter().find(|item| item["id"] == id).unwrap();
        let rect = item["rect"].as_array().unwrap();
        egui::Rect::from_min_size(
            egui::pos2(rect[0].as_f64().unwrap() as f32, rect[1].as_f64().unwrap() as f32),
            vec2(rect[2].as_f64().unwrap() as f32, rect[3].as_f64().unwrap() as f32),
        )
    }

    #[test]
    fn embedded_toolbar_language_switch_translates_visible_controls_without_editing() {
        let ctx = egui::Context::default();
        ctx.set_fonts(theme::font_definitions());
        egui_extras::install_image_loaders(&ctx);
        let mut app = document();
        let id = app.views[0].id;
        let generation = app.session.get(id).unwrap().edit_generation();
        let original_language = crate::i18n::current();
        for (locale, labels) in
            [("en", ["Edit text", "Signature", "View"]), ("zh-hans", ["编辑文字", "签名", "视图"]), ("en", ["Edit text", "Signature", "View"])]
        {
            crate::i18n::set_current(crate::i18n::Lang::from_pref(locale));
            let output = ctx.run_ui(
                egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, vec2(1280.0, 700.0))), ..Default::default() },
                |ui| show(&mut app, ui),
            );
            let text: Vec<_> = output
                .shapes
                .iter()
                .filter_map(|shape| if let egui::Shape::Text(text) = &shape.shape { Some(text.galley.job.text.as_str()) } else { None })
                .collect();
            for label in labels {
                assert!(text.contains(&label), "{locale} is missing {label:?}: {text:?}");
            }
            assert_eq!(app.session.get(id).unwrap().edit_generation(), generation);
            assert!(!app.host_dirty());
            output.drop_without_applying_deltas();
        }
        crate::i18n::set_current(original_language);
    }

    #[test]
    fn embedded_toolbar_wraps_all_primary_controls_without_covering_the_page() {
        let ctx = egui::Context::default();
        ctx.set_fonts(theme::font_definitions());
        egui_extras::install_image_loaders(&ctx);
        let mut app = document();
        for width in [320.0, 480.0, 850.0, 1280.0] {
            for _ in 0..3 {
                frame(&mut app, &ctx, width, vec![]);
            }
            for item in drawn(&ctx) {
                let id = item["id"].as_str().unwrap();
                let rect = control(&ctx, id);
                assert!(rect.left() >= 0.0 && rect.right() <= width + 1.0, "{width}: {id} {rect:?}");
                assert!(rect.bottom() <= 200.0, "compact toolbar leaves document space: {width} {id} {rect:?}");
            }
            assert!(!app.left_open);
        }
    }

    #[test]
    fn primary_add_text_button_uses_the_real_tool_without_opening_a_sidebar() {
        let ctx = egui::Context::default();
        ctx.set_fonts(theme::font_definitions());
        egui_extras::install_image_loaders(&ctx);
        let mut app = document();
        for _ in 0..3 {
            frame(&mut app, &ctx, 1280.0, vec![]);
        }
        let pos = control(&ctx, "edit.text").center();
        frame(&mut app, &ctx, 1280.0, vec![egui::Event::PointerMoved(pos)]);
        for pressed in [true, false] {
            frame(
                &mut app,
                &ctx,
                1280.0,
                vec![egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE }],
            );
        }
        assert_eq!(app.quick_tool, QuickTool::AddText);
        assert!(!app.left_open);
        assert!(!app.host_dirty(), "choosing a tool alone must not alter the document");
    }

    #[test]
    fn visual_signature_and_standard_stamp_write_real_annotations_that_reopen() {
        let mut app = document();
        assert!(app.execute("sign.fill.signature"));
        assert_eq!(app.dialog, Some(crate::Dialog::Signature));
        assert!(app.signature_draft.drawing, "Chinese users start with a usable handwritten signature");
        app.dialog = None;
        let id = app.views[0].id;
        let saved = crate::fill_sign::SavedSig::Drawn(vec![vec![[0.0, 0.0], [0.2, 0.3], [0.8, 0.1]]]);
        let edit = crate::fill_sign::place(0, &app.session.get(id).unwrap().info.pages[0], [100.0, 500.0], &saved, false, "Tester").unwrap();
        assert!(app.apply_edit(edit));
        let shape = office_pdf_engine::Shape::Stamp { rect: [100.0, 350.0, 260.0, 400.0], stamp: StampKind::Approved, by: None };
        assert!(app.apply_edit(office_pdf_engine::Edit::AddAnnotation(office_pdf_engine::NewAnnotation {
            page: 0,
            style: office_pdf_engine::Style::default_for(&shape),
            shape,
            contents: String::new(),
            author: "Tester".into(),
        })));
        assert_eq!(app.session.get(id).unwrap().info.annotations.len(), 2);
        let bytes = app.session.save_bytes(id).unwrap();
        let mut reopened = OfficePdfApp::new();
        reopened.open_bytes("Signed.pdf", None, bytes.as_ref().clone()).unwrap();
        let doc = reopened.session.get(reopened.views[0].id).unwrap();
        assert_eq!(doc.info.annotations.len(), 2);
        assert!(doc.info.annotations.iter().any(|item| item.subtype == "Stamp"));
        assert!(!app.embedding_command_visible("sign.digital"));
        assert!(app.embedding_command_visible("sign.validate"));
    }
}
