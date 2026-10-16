//! Original Open Office SVG artwork, using independent theme foreground and accent paints.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
};

use craft_ui::buttons::{ButtonVisuals, IconButton, IconButtonStyle};
use egui::{Color32, Rect, Response, Stroke, Vec2};

use crate::icon_data::ICONS;
use crate::theme::{self, Tokens};

/// Same toolbar viewport used by the shell, notebook and other document editors.
pub const TOOL_SIZE: f32 = 18.0;

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
struct IconColors {
    name: &'static str,
    ink: [u8; 3],
    accent: [u8; 3],
}

#[derive(Default)]
struct IconCache {
    images: HashMap<IconColors, egui::ImageSource<'static>>,
    order: VecDeque<IconColors>,
}

pub fn exists(name: &str) -> bool {
    ICONS.iter().any(|(candidate, _)| *candidate == name)
}

fn source(name: &str, ink: Color32, accent: Color32) -> egui::ImageSource<'static> {
    // Resolve before caching so unknown names cannot create unbounded entries.
    let (name, bytes) = ICONS
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .or_else(|| ICONS.iter().find(|(candidate, _)| *candidate == "square"))
        .copied()
        .unwrap_or(("square", &[]));
    let rgb = |color: Color32| {
        let [r, g, b, _] = color.to_srgba_unmultiplied();
        [r, g, b]
    };
    let key = IconColors { name, ink: rgb(ink), accent: rgb(accent) };
    static CACHE: OnceLock<Mutex<IconCache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Mutex::default).lock().unwrap_or_else(|error| error.into_inner());
    if let Some(image) = cache.images.get(&key) {
        return image.clone();
    }
    let hex = |[r, g, b]: [u8; 3]| format!("#{r:02x}{g:02x}{b:02x}");
    let ink_hex = hex(key.ink);
    let accent_hex = hex(key.accent);
    // Color the two paints independently. Multiplying a blue SVG by a dark gray
    // tint used to turn the accent almost black, unlike the other editors.
    let svg = String::from_utf8_lossy(bytes).replace("currentColor", &ink_hex).replace("#5b73e8", &accent_hex);
    let image = egui::ImageSource::Bytes {
        uri: format!("bytes://office-pdf-icons/{name}-{}-{}.svg", ink_hex.trim_start_matches('#'), accent_hex.trim_start_matches('#')).into(),
        bytes: svg.into_bytes().into(),
    };
    // Ordinary light/dark and disabled variants fit comfortably. Evict one old
    // entry rather than clearing the cache and rebuilding every icon next frame.
    if cache.images.len() >= 4096
        && let Some(oldest) = cache.order.pop_front()
    {
        cache.images.remove(&oldest);
    }
    cache.order.push_back(key);
    cache.images.insert(key, image.clone());
    image
}

pub fn image(ui: &egui::Ui, name: &str, size: f32, tint: Color32) -> egui::Image<'static> {
    let t = Tokens::get(ui.ctx());
    let accent = if ui.is_enabled() && tint != t.text_faint { t.accent } else { tint };
    egui::Image::new(source(name, tint, accent)).fit_to_exact_size(Vec2::splat(size)).tint(Color32::from_white_alpha(tint.a()))
}

pub fn paint(ui: &egui::Ui, rect: Rect, name: &str, size: f32, tint: Color32) {
    image(ui, name, size, tint).paint_at(ui, Rect::from_center_size(rect.center(), Vec2::splat(size)));
}

/// Square icon button: transparent until hovered; `selected` gets the accent treatment.
pub fn button(ui: &mut egui::Ui, name: &str, box_size: f32, selected: bool, tooltip: &str) -> Response {
    let t = Tokens::get(ui.ctx());
    // The shared button paints no fill of its own: the eased press wash below replaces it.
    let clear = |icon| ButtonVisuals { fill: Color32::TRANSPARENT, stroke: Stroke::NONE, icon };
    let style = IconButtonStyle {
        normal: clear(t.icon),
        hovered: clear(t.icon),
        pressed: Some(clear(t.icon)),
        selected: clear(t.accent_text),
        corner_radius: t.radius.into(),
        focus_stroke: Stroke::new(1.0, t.accent),
    };
    let label = if tooltip.is_empty() { name } else { tooltip };
    // The wash eases from the response, so reserve its place under the icon and focus ring.
    let wash = ui.painter().add(egui::Shape::Noop);
    let mut painted = None;
    let resp = IconButton::new(label, Vec2::splat(box_size), &style).selected(selected).show(ui, |_, rect, tint| painted = Some((rect, tint)));
    if let Some((rect, tint)) = painted {
        let press = theme::Press::track(ui, &resp);
        let mut shapes = Vec::with_capacity(2);
        let fill = press.wash_color(&t, selected);
        if fill.a() > 0 {
            shapes.push(egui::Shape::rect_filled(rect, t.radius, fill));
        }
        if selected {
            shapes.push(egui::Shape::rect_stroke(
                rect.shrink(0.5),
                t.radius,
                Stroke::new(1.0, t.accent.gamma_multiply(0.45)),
                egui::StrokeKind::Inside,
            ));
        }
        ui.painter().set(wash, egui::Shape::Vec(shapes));
        // The glyph shrinks a little and drops a pixel while the pointer is down.
        let size = TOOL_SIZE.min((box_size - 6.0).max(0.0)) * (1.0 - 0.08 * press.down);
        paint(ui, rect.translate(press.offset()), name, size, tint);
    }
    let resp = theme::hand(resp);
    if tooltip.is_empty() { resp } else { resp.on_hover_text(tooltip) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_catalog_icon_exists() {
        for g in office_pdf_engine::catalog::TOOL_GROUPS {
            assert!(super::exists(g.icon), "missing icon {}", g.icon);
            for s in g.sections {
                for i in s.items {
                    assert!(super::exists(i.icon), "missing icon {}", i.icon);
                }
            }
        }
    }

    #[test]
    fn every_command_icon_exists() {
        for c in office_pdf_engine::commands::COMMANDS {
            assert!(super::exists(c.icon), "missing icon {} ({})", c.icon, c.id);
        }
    }

    #[test]
    fn themed_icons_keep_foreground_and_accent_separate_and_reuse_cached_bytes() {
        let ink = Color32::from_rgb(0x22, 0x22, 0x26);
        let accent = Color32::from_rgb(0x4b, 0x8b, 0xf5);
        for (name, original) in ICONS {
            let expected = String::from_utf8_lossy(original).replace("currentColor", "#222226").replace("#5b73e8", "#4b8bf5");
            let egui::ImageSource::Bytes { uri, bytes } = source(name, ink, accent) else { panic!("expected SVG bytes") };
            assert_eq!(uri.as_ref(), format!("bytes://office-pdf-icons/{name}-222226-4b8bf5.svg"));
            assert_eq!(bytes.as_ref(), expected.as_bytes(), "{name}");
            let egui::ImageSource::Bytes { bytes: again, .. } = source(name, ink, accent) else { panic!("expected SVG bytes") };
            assert!(std::ptr::eq(bytes.as_ref(), again.as_ref()), "cached SVG bytes should be shared");
        }
        let egui::ImageSource::Bytes { uri, bytes } = source("missing-icon", ink, accent) else { panic!("expected SVG bytes") };
        let egui::ImageSource::Bytes { bytes: fallback, .. } = source("square", ink, accent) else { panic!("expected SVG bytes") };
        assert_eq!(uri.as_ref(), "bytes://office-pdf-icons/square-222226-4b8bf5.svg");
        assert_eq!(bytes.as_ref(), fallback.as_ref());
        assert!(!exists("missing-icon"));
    }

    #[test]
    fn shared_button_preserves_pointer_responses() {
        // The shared button must respond like the original allocate-and-paint path in both
        // themes. Its painting differs on purpose (the eased press wash, the selected outline
        // and the sinking glyph); the keyboard-focus outline is covered in craft-ui.
        fn frame(
            ctx: &egui::Context,
            events: Vec<egui::Event>,
            selected: bool,
            enabled: bool,
            legacy: bool,
        ) -> (egui::Response, Vec<egui::epaint::ClippedShape>) {
            let mut response = None;
            let mut output = ctx.run_ui(egui::RawInput { events, ..Default::default() }, |ui| {
                response = Some(
                    ui.add_enabled_ui(enabled, |ui| {
                        if legacy {
                            let t = Tokens::get(ui.ctx());
                            let (rect, response) = ui.allocate_exact_size(Vec2::splat(28.0), egui::Sense::click());
                            if selected {
                                ui.painter().rect_filled(rect, t.radius, t.accent_soft);
                            } else if response.is_pointer_button_down_on() {
                                ui.painter().rect_filled(rect, t.radius, t.pressed);
                            } else if response.hovered() {
                                ui.painter().rect_filled(rect, t.radius, t.hover);
                            }
                            let tint = if selected { t.accent_text } else { t.icon };
                            paint(ui, rect, "square", (28.0_f32 * 0.5).round(), tint);
                            response
                        } else {
                            button(ui, "square", 28.0, selected, "")
                        }
                    })
                    .inner,
                );
            });
            output.textures_delta.clear();
            (response.unwrap(), output.shapes)
        }
        for theme in [crate::theme::ThemeKind::Dark, crate::theme::ThemeKind::Light] {
            for selected in [false, true] {
                for enabled in [false, true] {
                    let old = egui::Context::default();
                    let new = egui::Context::default();
                    for ctx in [&old, &new] {
                        crate::theme::apply(ctx, theme);
                        egui_extras::install_image_loaders(ctx);
                    }
                    let mut center = egui::Pos2::ZERO;
                    for step in 0..7 {
                        let events = match step {
                            2 => vec![egui::Event::PointerMoved(center)],
                            3 | 4 => vec![egui::Event::PointerButton {
                                pos: center,
                                button: egui::PointerButton::Primary,
                                pressed: step == 3,
                                modifiers: egui::Modifiers::NONE,
                            }],
                            5 => vec![egui::Event::PointerMoved(egui::pos2(300.0, 200.0))],
                            _ => vec![],
                        };
                        let (a, _) = frame(&old, events.clone(), selected, enabled, true);
                        let (b, after) = frame(&new, events, selected, enabled, false);
                        center = a.rect.center();
                        assert_eq!(a.rect, b.rect);
                        assert_eq!(
                            (a.clicked(), a.hovered(), a.is_pointer_button_down_on()),
                            (b.clicked(), b.hovered(), b.is_pointer_button_down_on())
                        );
                        assert!(!after.is_empty(), "{theme:?}, selected={selected}, enabled={enabled}, step={step}");
                    }
                }
            }
        }
    }
}
