//! Interface typography shared by the four Rust editors and the web shell.
//!
//! These faces are only installed into explicit interface families. Document font databases,
//! spreadsheet cell families, font previews and export settings keep their existing fonts.

use std::sync::Arc;

use egui::{FontData, FontDefinitions, FontFamily, FontId, Style, TextStyle};

pub const BODY_SIZE: f32 = 13.0;
pub const SMALL_SIZE: f32 = 11.0;
pub const HEADING_SIZE: f32 = 18.0;

const REGULAR: &str = "office-ui-regular";
const SEMIBOLD: &str = "office-ui-semibold";
const CHINESE: &str = "office-ui-cjk";
const HEADING: &str = "office-ui-heading";

/// Give every interface family the same regular/semibold Latin and Chinese sans faces.
/// Existing script and symbol fallbacks remain available after this shared prefix.
pub fn install(fonts: &mut FontDefinitions, regular_families: &[FontFamily], semibold_families: &[FontFamily]) {
    for (name, bytes) in [
        (REGULAR, include_bytes!("../../assets/fonts/deck/Inter-Regular.ttf").as_slice()),
        (SEMIBOLD, include_bytes!("../../assets/fonts/deck/Inter-SemiBold.ttf").as_slice()),
        (CHINESE, include_bytes!("../../assets/fonts/ui/WenQuanYiMicroHei-Regular.ttf").as_slice()),
    ] {
        let mut data = FontData::from_static(bytes);
        if name == CHINESE {
            // Both pinned faces use 2048 units/em. Their ascent+descent sums differ by 55
            // units; compensate egui's fallback line-box centring to share Inter's baseline.
            data.tweak.y_offset_factor = 55.0 / 4096.0;
        }
        fonts.font_data.insert(name.into(), Arc::new(data));
    }
    let fallback = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    for (families, primary) in [(regular_families, REGULAR), (semibold_families, SEMIBOLD)] {
        for family in families {
            let chain = fonts.families.entry(family.clone()).or_insert_with(|| fallback.clone());
            chain.retain(|name| name != primary && name != CHINESE);
            chain.splice(0..0, [primary.into(), CHINESE.into()]);
        }
    }
    let mut heading = vec![SEMIBOLD.into(), CHINESE.into()];
    heading.extend(fallback.into_iter().filter(|name| name != SEMIBOLD && name != CHINESE));
    fonts.families.insert(FontFamily::Name(HEADING.into()), heading);
}

/// The common interface hierarchy. Per-document typography is never a TextStyle override.
pub fn apply_style(style: &mut Style) {
    style.text_styles.insert(TextStyle::Body, FontId::proportional(BODY_SIZE));
    style.text_styles.insert(TextStyle::Button, FontId::proportional(BODY_SIZE));
    style.text_styles.insert(TextStyle::Small, FontId::proportional(SMALL_SIZE));
    style.text_styles.insert(TextStyle::Heading, FontId::new(HEADING_SIZE, FontFamily::Name(HEADING.into())));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_fonts_leave_document_families_and_existing_font_bytes_untouched() {
        let mut fonts = FontDefinitions::default();
        fonts.font_data.insert("OfficeChinese".into(), Arc::new(FontData::from_static(b"existing document face")));
        fonts.families.insert(FontFamily::Name("cell".into()), vec!["OfficeChinese".into()]);
        let before_data = fonts.font_data.clone();
        let before_families = fonts.families.clone();
        install(&mut fonts, &[FontFamily::Proportional], &[FontFamily::Name("semibold".into())]);
        for (name, data) in before_data {
            assert!(Arc::ptr_eq(&fonts.font_data[&name], &data), "existing document face {name} was replaced");
        }
        for family in [FontFamily::Name("cell".into()), FontFamily::Monospace] {
            assert_eq!(fonts.families.get(&family), before_families.get(&family), "document family {family:?} changed");
        }
        let mut style = Style::default();
        let monospace = style.text_styles.get(&TextStyle::Monospace).cloned();
        apply_style(&mut style);
        assert_eq!(style.text_styles.get(&TextStyle::Monospace), monospace.as_ref());
    }

    #[test]
    fn shared_interface_faces_render_chinese_and_latin_in_both_weights() {
        let mut fonts = FontDefinitions::default();
        install(&mut fonts, &[FontFamily::Proportional], &[FontFamily::Name("semibold".into())]);
        let ctx = egui::Context::default();
        ctx.set_fonts(fonts);
        let mut output = ctx.run_ui(Default::default(), |_| {});
        // This test checks glyph coverage without a renderer consuming the font atlas.
        output.textures_delta.clear();
        ctx.fonts_mut(|fonts| {
            for family in [FontFamily::Proportional, FontFamily::Name("semibold".into())] {
                assert!(fonts.has_glyphs(&FontId::new(BODY_SIZE, family), "文件编辑视图插入格式保存笔记页面 A1 100%"));
            }
        });
    }
}
