//! Open Office must draw Chinese without access to operating-system or imported fonts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use wordcraft_fonts::{FontDb, chinese_fonts, shape, ui_cjk_fonts, ui_uncovered_cjk};

#[test]
fn embedded_chinese_covers_the_complete_simplified_interface() {
    let faces = ui_cjk_fonts(true);
    assert_eq!(faces.first().map(|f| (f.family, f.style)), Some(("Noto Sans CJK SC", "Regular")));
    let catalog = include_str!("../../ui-egui/src/i18n/zh-hans.tsv");
    let missing = ui_uncovered_cjk(&[catalog, "简体中文 文档 排版 撤销 保存 打印 页眉 页脚"], &faces);
    assert!(missing.is_empty(), "Chinese interface glyphs missing: {missing:?}");
}

#[test]
fn chinese_documents_use_real_regular_and_bold_without_system_fonts() {
    let db = FontDb::with_font_dirs(vec![]);
    db.set_system_fallback(false);
    let chars: Vec<char> = "中文排版简体页眉页脚".chars().collect();
    for (style, bold, weight) in [("Regular", false, 400.0), ("Bold", true, 700.0)] {
        let face = db.face("Noto Sans CJK SC", style);
        assert_eq!(face.family, "Noto Sans CJK SC");
        assert_eq!(face.weight, weight);
        let embedded = chinese_fonts().find(|f| f.style == style).unwrap();
        assert!(std::ptr::eq(face.data().as_ptr(), embedded.bytes.as_ptr()), "document face must use the shared static bytes");
        let fallback = db.fallback_for_east_asian(&chars, u32::MAX, bold, false).unwrap();
        assert_eq!(fallback.family, "Noto Sans CJK SC");
        assert_eq!(fallback.weight, weight);
        let glyphs = shape(&face, "中文排版简体页眉页脚", &[], |c| c);
        assert_eq!(glyphs.len(), chars.len());
        assert!(glyphs.iter().all(|g| g.gid != 0 && g.x_advance > 0 && !face.glyph_outline(g.gid).elements().is_empty()));
    }
}

#[test]
fn embedded_symbol_fallbacks_have_real_emoji_outlines() {
    let db = FontDb::with_font_dirs(vec![]);
    db.set_system_fallback(false);
    for (text, family) in [("😀", "DejaVu Sans"), ("🌍", "Noto Sans Symbols2")] {
        let face = db.fallback_for(text.chars().next().unwrap(), u32::MAX).unwrap();
        assert_eq!(face.family, family);
        let embedded = wordcraft_fonts::symbol_fonts().find(|f| f.family == family).unwrap();
        assert!(std::ptr::eq(face.data().as_ptr(), embedded.bytes.as_ptr()));
        let glyphs = shape(&face, text, &[], |c| c);
        assert_eq!(glyphs.len(), 1);
        assert!(glyphs[0].gid != 0 && !face.glyph_outline(glyphs[0].gid).elements().is_empty());
    }
}
