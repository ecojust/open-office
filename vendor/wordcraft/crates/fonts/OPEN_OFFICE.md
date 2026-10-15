# Open Office Chinese font adaptation

Open Office embeds the complete Noto Sans CJK SC Regular and Bold faces on both native and
WebAssembly targets. `build.rs` reads the existing files from
`../../../../crates/word-engine/fonts` relative to this crate; no second font copy or network
download is required. The two faces total 33,439,564 bytes before binary compression.

Two additional shared monochrome fallbacks cover emoji used by existing documents and checks:
`DejaVuSans.ttf` (759,720 bytes, including 😀) and `NotoSansSymbols2-Regular.ttf` (656,852
bytes, including 🌍). They are registered for both documents and UI fonts. They do not supply
complete modern or colour emoji coverage; for example, neither face covers 🙂, 🧑 or 🦄.

`CRAFT_FONTS` owns the static byte slices. The document `FontDb` and egui's `font_definitions`
use those same slices. Chinese UI menus select the Regular face as their fallback; document
bold selects the real Bold face. The host selects `app.ui.language = "zh-hans"` before its
first frame, while the upstream language picker remains available.

The complete source, extraction details, file sizes and SHA-256 hashes are recorded in the
shared `crates/word-engine/fonts/manifest.json` and `README.md`; the distribution must retain
`LICENSE-Noto-CJK.txt` and `LICENSE-Noto-Core.txt` (SIL Open Font License 1.1), and
`LICENSE-DejaVu.txt`. The CJK files are full SC faces extracted from
the system Noto CJK collections, not subsets limited to the interface or a test document.

Focused checks are `cargo test -p wordcraft-fonts --test open_office_chinese` and the
`open_office_chinese_menus_share_the_document_font` test in `wordcraft-ui-egui`. They check
the complete Simplified Chinese catalog, actual regular/bold shaping and outlines with
system fallback disabled, actual symbol shaping/outlines, and egui menu glyph availability
with shared font bytes.
