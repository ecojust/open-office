//! Authoritative, platform-independent point layout. The UI receives outlines,
//! never text to reflow or shape with platform fonts.

use crate::model::{
    normalize_document, paragraph_text, utf16_len, validate_selection, Alignment, Document,
    Paragraph, Position, Selection, TextStyle, MAX_PAGES,
};
use rustybuzz::{BufferClusterLevel, Direction, Face, Feature, UnicodeBuffer};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt::Write;
use ttf_parser::{GlyphId, OutlineBuilder};
use unicode_linebreak::linebreaks;
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

const FONT_DATA: [&[u8]; 7] = [
    include_bytes!("../fonts/DejaVuSans.ttf"),
    include_bytes!("../fonts/DejaVuSans-Bold.ttf"),
    include_bytes!("../fonts/DejaVuSans-Oblique.ttf"),
    include_bytes!("../fonts/DejaVuSans-BoldOblique.ttf"),
    include_bytes!("../fonts/NotoSansCJKsc-Regular.otf"),
    include_bytes!("../fonts/NotoSansCJKsc-Bold.otf"),
    include_bytes!("../fonts/NotoSansSymbols2-Regular.ttf"),
];
const ITALIC_SHEAR: f64 = 0.212_556_561_670_022_1; // tan(12 degrees)
const EPSILON: f64 = 0.000_01;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphPath {
    pub d: String,
    pub fill: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLayout {
    pub width: f64,
    pub height: f64,
    pub paths: Vec<GlyphPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretRect {
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRect {
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub pages: Vec<PageLayout>,
    pub caret: Option<CaretRect>,
    pub selection_rects: Vec<SelectionRect>,
    // Navigation must use the live Rust layout, not client-supplied JSON.
    #[serde(skip)]
    lines: Vec<Line>,
}

#[derive(Clone, Debug, PartialEq)]
struct CaretStop {
    offset: usize,
    x: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct Line {
    paragraph: usize,
    page: usize,
    y: f64,
    height: f64,
    paragraph_end: bool,
    stops: Vec<CaretStop>,
}

struct Fonts {
    faces: Vec<Face<'static>>,
}

impl Fonts {
    fn load() -> Result<Self, String> {
        let faces = FONT_DATA
            .iter()
            .enumerate()
            .map(|(index, data)| {
                Face::from_slice(data, 0).ok_or_else(|| format!("Invalid embedded font {index}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { faces })
    }

    fn choose(&self, text: &str, style: &TextStyle) -> Result<usize, String> {
        let primary = usize::from(style.bold) + 2 * usize::from(style.italic);
        let cjk = 4 + usize::from(style.bold);
        for index in [primary, cjk, 0, 6] {
            if text
                .chars()
                .all(|ch| self.faces[index].glyph_index(ch).is_some())
            {
                return Ok(index);
            }
        }
        let codepoints = text
            .chars()
            .map(|ch| format!("U+{:04X}", ch as u32))
            .collect::<Vec<_>>()
            .join(" ");
        Err(format!(
            "Embedded fonts do not support grapheme {codepoints}"
        ))
    }
}

#[derive(Clone)]
struct PositionedGlyph {
    id: u16,
    x: f64,
    y: f64,
}

#[derive(Clone)]
struct Atom {
    text: String,
    start: usize,
    end: usize,
    width: f64,
    ascent: f64,
    descent: f64,
    font: usize,
    style: TextStyle,
    glyphs: Vec<PositionedGlyph>,
    break_after: bool,
}

fn validate_grapheme(text: &str) -> Result<(), String> {
    for ch in text.chars() {
        let code = ch as u32;
        if ch.is_control() && ch != '\t'
            || matches!(code, 0x00ad | 0x061c | 0x200b..=0x200f | 0x202a..=0x202e |
                0x2060..=0x206f | 0xfe00..=0xfe0f | 0xfeff | 0xe0000..=0xe007f |
                0xe0100..=0xe01ef)
        {
            return Err(format!(
                "Unsupported text control or emoji sequence U+{code:04X}; phase 1 uses LTR outline fonts"
            ));
        }
        if !matches!(
            ch.script(),
            Script::Latin
                | Script::Han
                | Script::Hiragana
                | Script::Katakana
                | Script::Hangul
                | Script::Common
                | Script::Inherited
        ) {
            return Err(format!("Unsupported text script at U+{code:04X}; phase 1 supports Latin and East Asian LTR text"));
        }
    }
    Ok(())
}

// A segment shares one real font and one style. rustybuzz shapes the complete
// segment, preserving kerning and mark positioning across grapheme boundaries.
fn shape_segment(
    text: &str,
    start: usize,
    font: usize,
    style: &TextStyle,
    fonts: &Fonts,
    atoms: &mut Vec<Atom>,
) -> Result<(), String> {
    let face = &fonts.faces[font];
    let scale = style.font_size / f64::from(face.units_per_em());
    let ascent = f64::from(face.ascender()).max(0.0) * scale;
    let descent = -f64::from(face.descender()).min(0.0) * scale;
    let mut starts = Vec::new();
    let first_atom = atoms.len();
    let mut offset = start;
    for (byte, grapheme) in text.grapheme_indices(true) {
        starts.push(byte);
        let end = offset + utf16_len(grapheme);
        atoms.push(Atom {
            text: grapheme.into(),
            start: offset,
            end,
            width: 0.0,
            ascent,
            descent,
            font,
            style: style.clone(),
            glyphs: Vec::new(),
            break_after: false,
        });
        offset = end;
    }
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_cluster_level(BufferClusterLevel::MonotoneGraphemes);
    buffer.guess_segment_properties();
    buffer.set_direction(Direction::LeftToRight);
    let features: Vec<Feature> = ["liga=0", "clig=0", "dlig=0"]
        .iter()
        .map(|feature| feature.parse().expect("constant shaping feature"))
        .collect();
    let shaped = rustybuzz::shape(face, &features, buffer);
    for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
        if info.glyph_id == 0 {
            return Err(
                "Text shaping produced a missing glyph; no platform fallback is allowed".into(),
            );
        }
        let cluster = info.cluster as usize;
        let atom_index = starts
            .partition_point(|byte| *byte <= cluster)
            .saturating_sub(1);
        let atom = &mut atoms[first_atom + atom_index];
        atom.glyphs.push(PositionedGlyph {
            id: info.glyph_id as u16,
            x: atom.width + f64::from(position.x_offset) * scale,
            y: f64::from(position.y_offset) * scale,
        });
        atom.width += f64::from(position.x_advance) * scale;
    }
    // With discretionary ligatures disabled, supported LTR graphemes each own
    // their glyph cluster. An unsupported shaping behavior must not invent a caret.
    for atom in &atoms[first_atom..] {
        if atom.glyphs.is_empty() || atom.width < -EPSILON {
            return Err("Unsupported cross-grapheme shaping cluster".into());
        }
    }
    Ok(())
}

fn paragraph_atoms(paragraph: &Paragraph, fonts: &Fonts) -> Result<Vec<Atom>, String> {
    let text = paragraph_text(paragraph);
    let breaks: BTreeSet<usize> = linebreaks(&text).map(|(byte, _)| byte).collect();
    let mut atoms = Vec::new();
    let mut run_offset = 0;
    let mut full_byte = 0;
    for run in &paragraph.runs {
        let mut segment = String::new();
        let mut segment_font = None;
        let mut segment_start = run_offset;
        let mut offset = run_offset;
        for grapheme in run.text.graphemes(true) {
            validate_grapheme(grapheme)?;
            if grapheme == "\t" {
                if !segment.is_empty() {
                    shape_segment(
                        &segment,
                        segment_start,
                        segment_font.unwrap(),
                        &run.style,
                        fonts,
                        &mut atoms,
                    )?;
                    segment.clear();
                }
                let font = fonts.choose(" ", &run.style)?;
                let before = atoms.len();
                shape_segment(" ", offset, font, &run.style, fonts, &mut atoms)?;
                atoms[before].width = 36.0;
                atoms[before].text = "\t".into();
                atoms[before].glyphs.clear();
                offset += 1;
                segment_start = offset;
                segment_font = None;
                continue;
            }
            let font = fonts.choose(grapheme, &run.style)?;
            if segment_font.is_some_and(|previous| previous != font) {
                shape_segment(
                    &segment,
                    segment_start,
                    segment_font.unwrap(),
                    &run.style,
                    fonts,
                    &mut atoms,
                )?;
                segment.clear();
                segment_start = offset;
            }
            if segment.is_empty() {
                segment_start = offset;
            }
            segment_font = Some(font);
            segment.push_str(grapheme);
            offset += utf16_len(grapheme);
        }
        if !segment.is_empty() {
            shape_segment(
                &segment,
                segment_start,
                segment_font.unwrap(),
                &run.style,
                fonts,
                &mut atoms,
            )?;
        }
        run_offset = offset;
    }
    for (atom, grapheme) in atoms.iter_mut().zip(text.graphemes(true)) {
        full_byte += grapheme.len();
        atom.break_after = breaks.contains(&full_byte);
    }
    Ok(atoms)
}

fn reshape_line(atoms: &[Atom], fonts: &Fonts) -> Result<Vec<Atom>, String> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut used = 0.0;
    while start < atoms.len() {
        let atom = &atoms[start];
        if atom.text == "\t" {
            let mut tab = atom.clone();
            tab.width = tab_advance(used);
            used += tab.width;
            result.push(tab);
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < atoms.len()
            && atoms[end].font == atom.font
            && atoms[end].style == atom.style
            && atoms[end].text != "\t"
        {
            end += 1;
        }
        let text: String = atoms[start..end]
            .iter()
            .map(|atom| atom.text.as_str())
            .collect();
        let previous = result.len();
        shape_segment(
            &text,
            atom.start,
            atom.font,
            &atom.style,
            fonts,
            &mut result,
        )?;
        used += result[previous..]
            .iter()
            .map(|atom| atom.width)
            .sum::<f64>();
        start = end;
    }
    Ok(result)
}

fn tab_advance(used: f64) -> f64 {
    36.0 - used.rem_euclid(36.0)
}

fn wrapped_lines(atoms: &[Atom], width: f64, fonts: &Fonts) -> Result<Vec<Vec<Atom>>, String> {
    if atoms.is_empty() {
        return Ok(vec![Vec::new()]);
    }
    let mut lines = Vec::new();
    let mut start = 0;
    while start < atoms.len() {
        let mut end = start;
        let mut used = 0.0;
        let mut last_break = None;
        while end < atoms.len() {
            let advance = if atoms[end].text == "\t" {
                tab_advance(used)
            } else {
                atoms[end].width
            };
            if used + advance > width + EPSILON && end > start {
                if let Some(boundary) = last_break {
                    end = boundary;
                }
                break;
            }
            used += advance;
            end += 1;
            if atoms[end - 1].break_after {
                last_break = Some(end);
            }
        }
        // Paragraph shaping is only a break estimate. Re-shape the final line
        // so a glyph on the following line cannot kern or contextualize its tail.
        loop {
            let line = reshape_line(&atoms[start..end], fonts)?;
            let measured: f64 = line.iter().map(|atom| atom.width).sum();
            if measured <= width + EPSILON {
                lines.push(line);
                break;
            }
            if end == start + 1 {
                return Err("A grapheme is wider than the page text area".into());
            }
            end = (start + 1..end)
                .rev()
                .find(|boundary| atoms[*boundary - 1].break_after)
                .unwrap_or(end - 1);
        }
        start = end;
    }
    Ok(lines)
}

struct SvgOutline {
    d: String,
    x: f64,
    baseline: f64,
    scale: f64,
    shear: f64,
}

impl SvgOutline {
    fn point(&self, x: f32, y: f32) -> (f64, f64) {
        (
            self.x + (f64::from(x) + self.shear * f64::from(y)) * self.scale,
            self.baseline - f64::from(y) * self.scale,
        )
    }
}

impl OutlineBuilder for SvgOutline {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.point(x, y);
        let _ = write!(self.d, "M{x:.3} {y:.3}");
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.point(x, y);
        let _ = write!(self.d, "L{x:.3} {y:.3}");
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.point(x1, y1);
        let (x, y) = self.point(x, y);
        let _ = write!(self.d, "Q{x1:.3} {y1:.3} {x:.3} {y:.3}");
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.point(x1, y1);
        let (x2, y2) = self.point(x2, y2);
        let (x, y) = self.point(x, y);
        let _ = write!(self.d, "C{x1:.3} {y1:.3} {x2:.3} {y2:.3} {x:.3} {y:.3}");
    }
    fn close(&mut self) {
        self.d.push('Z');
    }
}

fn caret_line<'a>(layout: &'a Layout, position: &Position) -> Option<(usize, &'a Line, f64)> {
    layout
        .lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, line)| {
            if line.paragraph != position.paragraph {
                return None;
            }
            line.stops
                .iter()
                .find(|stop| stop.offset == position.offset)
                .map(|stop| (index, line, stop.x))
        })
}

fn select_rects(layout: &Layout, selection: &Selection) -> Vec<SelectionRect> {
    if selection.is_collapsed() {
        return Vec::new();
    }
    let (start, end) = selection.ordered();
    let mut rectangles = Vec::new();
    for line in &layout.lines {
        if line.paragraph < start.paragraph || line.paragraph > end.paragraph {
            continue;
        }
        let first = line.stops.first().expect("line caret");
        let last = line.stops.last().expect("line caret");
        let from = if line.paragraph == start.paragraph {
            start.offset.max(first.offset)
        } else {
            first.offset
        };
        let to = if line.paragraph == end.paragraph {
            end.offset.min(last.offset)
        } else {
            last.offset
        };
        let includes_separator = line.paragraph_end && line.paragraph < end.paragraph;
        if from > to {
            continue;
        }
        let left = line
            .stops
            .iter()
            .find(|stop| stop.offset == from)
            .map(|stop| stop.x);
        let right = line
            .stops
            .iter()
            .find(|stop| stop.offset == to)
            .map(|stop| stop.x);
        if let (Some(x), Some(right)) = (left, right) {
            let width = right - x
                + if includes_separator {
                    line.height * 0.25
                } else {
                    0.0
                };
            if width > EPSILON {
                rectangles.push(SelectionRect {
                    page: line.page,
                    x,
                    y: line.y,
                    width,
                    height: line.height,
                });
            }
        }
    }
    rectangles
}

pub fn layout_document(document: &Document, selection: &Selection) -> Result<Layout, String> {
    let document = normalize_document(document.clone())?;
    validate_selection(&document, selection)?;
    let fonts = Fonts::load()?;
    let page = &document.page;
    let content_width = page.width - page.margin_left - page.margin_right;
    let content_bottom = page.height - page.margin_bottom;
    let empty_page = || PageLayout {
        width: page.width,
        height: page.height,
        paths: Vec::new(),
    };
    let mut layout = Layout {
        pages: vec![empty_page()],
        caret: None,
        selection_rects: Vec::new(),
        lines: Vec::new(),
    };
    let mut page_index = 0;
    let mut y = page.margin_top;
    for (paragraph_index, paragraph) in document.paragraphs.iter().enumerate() {
        let atoms = paragraph_atoms(paragraph, &fonts)?;
        let lines = wrapped_lines(&atoms, content_width, &fonts)?;
        for (line_index, line_atoms) in lines.iter().enumerate() {
            let style = &paragraph.runs[0].style;
            let mut ascent: f64 = 0.0;
            let mut descent: f64 = 0.0;
            let mut size: f64 = 0.0;
            if line_atoms.is_empty() {
                let font = fonts.choose(" ", style)?;
                let face = &fonts.faces[font];
                let scale = style.font_size / f64::from(face.units_per_em());
                ascent = f64::from(face.ascender()).max(0.0) * scale;
                descent = -f64::from(face.descender()).min(0.0) * scale;
                size = style.font_size;
            }
            for atom in line_atoms {
                ascent = ascent.max(atom.ascent);
                descent = descent.max(atom.descent);
                size = size.max(atom.style.font_size);
            }
            let leading = size * 0.2;
            let height = ascent + descent + leading;
            if height > content_bottom - page.margin_top + EPSILON {
                return Err("A text line is taller than the page text area".into());
            }
            if y + height > content_bottom + EPSILON {
                if layout.pages.len() >= MAX_PAGES {
                    return Err("Document exceeds 200 laid-out pages".into());
                }
                layout.pages.push(empty_page());
                page_index += 1;
                y = page.margin_top;
            }
            let width: f64 = line_atoms.iter().map(|atom| atom.width).sum();
            let shift = match paragraph.align {
                Alignment::Left => 0.0,
                Alignment::Center => (content_width - width) / 2.0,
                Alignment::Right => content_width - width,
            };
            let mut x = page.margin_left + shift;
            let baseline = y + leading / 2.0 + ascent;
            let mut stops = vec![CaretStop {
                offset: line_atoms.first().map_or(0, |atom| atom.start),
                x,
            }];
            for atom in line_atoms {
                let face = &fonts.faces[atom.font];
                let scale = atom.style.font_size / f64::from(face.units_per_em());
                for glyph in &atom.glyphs {
                    let mut outline = SvgOutline {
                        d: String::new(),
                        x: x + glyph.x,
                        baseline: baseline - glyph.y,
                        scale,
                        shear: if (4..=5).contains(&atom.font) && atom.style.italic {
                            ITALIC_SHEAR
                        } else {
                            0.0
                        },
                    };
                    face.outline_glyph(GlyphId(glyph.id), &mut outline);
                    if !outline.d.is_empty() {
                        let fill = if atom.style.color == "auto" {
                            "#000000".into()
                        } else {
                            atom.style.color.clone()
                        };
                        layout.pages[page_index]
                            .paths
                            .push(GlyphPath { d: outline.d, fill });
                    }
                }
                x += atom.width;
                stops.push(CaretStop {
                    offset: atom.end,
                    x,
                });
            }
            layout.lines.push(Line {
                paragraph: paragraph_index,
                page: page_index,
                y,
                height,
                paragraph_end: line_index + 1 == lines.len(),
                stops,
            });
            y += height;
        }
        y += 6.0; // explicit phase-1 paragraph spacing, in points
    }
    if selection.is_collapsed() {
        if let Some((_, line, x)) = caret_line(&layout, &selection.focus) {
            layout.caret = Some(CaretRect {
                page: line.page,
                x,
                y: line.y,
                height: line.height,
            });
        }
    }
    layout.selection_rects = select_rects(&layout, selection);
    Ok(layout)
}

pub fn hit_test(layout: &Layout, page: usize, x: f64, y: f64) -> Result<Position, String> {
    if page >= layout.pages.len() {
        return Err("Hit-test page does not exist".into());
    }
    if !x.is_finite() || !y.is_finite() {
        return Err("Hit-test coordinates must be finite".into());
    }
    let distance = |line: &Line| {
        if y < line.y {
            line.y - y
        } else if y > line.y + line.height {
            y - line.y - line.height
        } else {
            0.0
        }
    };
    let line = layout
        .lines
        .iter()
        .filter(|line| line.page == page)
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .ok_or("No live layout available for hit testing")?;
    let stop = line
        .stops
        .iter()
        .min_by(|a, b| (a.x - x).abs().total_cmp(&(b.x - x).abs()))
        .ok_or("Line has no caret positions")?;
    Ok(Position {
        paragraph: line.paragraph,
        offset: stop.offset,
    })
}

pub fn move_vertical(
    layout: &Layout,
    position: &Position,
    direction: i8,
) -> Result<Position, String> {
    if direction != -1 && direction != 1 {
        return Err("Vertical direction must be -1 or 1".into());
    }
    let (index, _, x) =
        caret_line(layout, position).ok_or("Position is not a live layout caret stop")?;
    let target = if direction < 0 {
        index.checked_sub(1)
    } else if index + 1 < layout.lines.len() {
        Some(index + 1)
    } else {
        None
    };
    let Some(target) = target else {
        return Ok(*position);
    };
    let line = &layout.lines[target];
    let stop = line
        .stops
        .iter()
        .min_by(|a, b| (a.x - x).abs().total_cmp(&(b.x - x).abs()))
        .ok_or("Line has no caret positions")?;
    Ok(Position {
        paragraph: line.paragraph,
        offset: stop.offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Run;

    fn document(text: &str) -> Document {
        let mut document = Document::default();
        document.paragraphs[0].runs[0].text = text.into();
        document
    }

    fn layout(text: &str) -> Layout {
        layout_document(&document(text), &Selection::default()).unwrap()
    }

    fn line_width(line: &Line) -> f64 {
        line.stops.last().unwrap().x - line.stops.first().unwrap().x
    }

    fn narrow(mut document: Document) -> Document {
        document.page.width = 144.0;
        document.page.margin_left = 42.0;
        document.page.margin_right = 42.0;
        document
    }

    #[test]
    fn empty_paragraph_has_a_real_caret_but_no_fake_glyph() {
        let layout = layout("");
        assert_eq!(layout.pages.len(), 1);
        assert!(layout.pages[0].paths.is_empty());
        let caret = layout.caret.unwrap();
        assert_eq!((caret.page, caret.x, caret.y), (0, 72.0, 72.0));
        assert!(caret.height > 12.0);
    }

    #[test]
    fn actual_font_metrics_and_kerning_control_advances() {
        let wide = line_width(&layout("WWWW").lines[0]);
        let narrow = line_width(&layout("iiii").lines[0]);
        assert!(wide > narrow * 3.0);
        let kerned = line_width(&layout("AV").lines[0]);
        let separate = line_width(&layout("A").lines[0]) + line_width(&layout("V").lines[0]);
        assert!(kerned < separate - 0.5);
    }

    #[test]
    fn chinese_and_supported_monochrome_emoji_emit_outlines() {
        let layout = layout("中文排版 A😀");
        assert_eq!(layout.pages[0].paths.len(), 6);
        assert!(layout.pages[0]
            .paths
            .iter()
            .all(|path| path.d.starts_with('M') && path.d.contains('Z')));
        assert!(layout.lines[0].height > 12.0);
        let symbols = layout_document(&document("🌍👍💻"), &Selection::default()).unwrap();
        assert_eq!(symbols.pages[0].paths.len(), 3);
    }

    #[test]
    fn bold_and_italic_use_different_outlines_in_both_font_families() {
        for text in ["A", "中"] {
            let plain = layout(text).pages[0].paths[0].d.clone();
            let mut doc = document(text);
            doc.paragraphs[0].runs[0].style.bold = true;
            let bold = layout_document(&doc, &Selection::default()).unwrap().pages[0].paths[0]
                .d
                .clone();
            doc.paragraphs[0].runs[0].style.bold = false;
            doc.paragraphs[0].runs[0].style.italic = true;
            let italic = layout_document(&doc, &Selection::default()).unwrap().pages[0].paths[0]
                .d
                .clone();
            assert_ne!(plain, bold);
            assert_ne!(plain, italic);
            assert_ne!(bold, italic);
        }
    }

    #[test]
    fn auto_is_painted_black_without_mutating_model_semantics() {
        let mut doc = document("auto");
        doc.paragraphs[0].runs[0].style.color = "auto".into();
        let actual = layout_document(&doc, &Selection::default()).unwrap();
        assert!(actual.pages[0]
            .paths
            .iter()
            .all(|path| path.fill == "#000000"));
        assert_eq!(doc.paragraphs[0].runs[0].style.color, "auto");
    }

    #[test]
    fn alignment_moves_glyphs_and_carets_by_the_same_measured_width() {
        let mut doc = document("aligned");
        let left = layout_document(&doc, &Selection::default()).unwrap();
        let width = line_width(&left.lines[0]);
        let remaining = doc.page.width - doc.page.margin_left - doc.page.margin_right - width;
        doc.paragraphs[0].align = Alignment::Center;
        let center = layout_document(&doc, &Selection::default()).unwrap();
        doc.paragraphs[0].align = Alignment::Right;
        let right = layout_document(&doc, &Selection::default()).unwrap();
        assert!((center.caret.unwrap().x - 72.0 - remaining / 2.0).abs() < EPSILON);
        assert!((right.caret.unwrap().x - 72.0 - remaining).abs() < EPSILON);
        assert_ne!(left.pages[0].paths, center.pages[0].paths);
    }

    #[test]
    fn word_breaks_use_unicode_opportunities_and_do_not_drop_spaces() {
        let text = "alpha beta gamma delta";
        let actual = layout_document(&narrow(document(text)), &Selection::default()).unwrap();
        assert!(actual.lines.len() > 1);
        for line in &actual.lines[..actual.lines.len() - 1] {
            let end = line.stops.last().unwrap().offset;
            assert_eq!(text.as_bytes()[end - 1], b' ');
            assert!(line_width(line) <= 60.0 + EPSILON);
        }
        let lengths: usize = actual
            .lines
            .iter()
            .map(|line| line.stops.last().unwrap().offset - line.stops.first().unwrap().offset)
            .sum();
        assert_eq!(lengths, text.len());
    }

    #[test]
    fn a_long_unbroken_word_emergency_wraps_on_graphemes() {
        let actual =
            layout_document(&narrow(document(&"W".repeat(30))), &Selection::default()).unwrap();
        assert!(actual.lines.len() > 1);
        assert_eq!(
            actual.lines.last().unwrap().stops.last().unwrap().offset,
            30
        );
        assert!(actual
            .lines
            .iter()
            .all(|line| line_width(line) <= 60.0 + EPSILON));
    }

    #[test]
    fn chinese_pagination_and_selection_stay_inside_the_text_area() {
        let mut doc = narrow(document(&"中文排版".repeat(60)));
        doc.page.height = 200.0;
        doc.page.margin_top = 36.0;
        doc.page.margin_bottom = 36.0;
        let selection = Selection {
            anchor: Position::default(),
            focus: Position {
                paragraph: 0,
                offset: 240,
            },
        };
        let actual = layout_document(&doc, &selection).unwrap();
        assert!(actual.pages.len() > 2);
        assert!(actual
            .selection_rects
            .iter()
            .all(|rect| rect.x >= 42.0 - EPSILON
                && rect.x + rect.width <= 102.0 + EPSILON
                && rect.y >= 36.0 - EPSILON
                && rect.y + rect.height <= 164.0 + EPSILON));
        assert_eq!(actual.selection_rects.len(), actual.lines.len());
    }

    #[test]
    fn carets_and_hit_tests_are_utf16_grapheme_positions() {
        let actual = layout("A😀中");
        let line = &actual.lines[0];
        assert_eq!(
            line.stops
                .iter()
                .map(|stop| stop.offset)
                .collect::<Vec<_>>(),
            vec![0, 1, 3, 4]
        );
        for stop in &line.stops {
            assert_eq!(
                hit_test(&actual, 0, stop.x, line.y + line.height / 2.0)
                    .unwrap()
                    .offset,
                stop.offset
            );
        }
        let combining = layout("e\u{301}");
        assert_eq!(
            combining.lines[0]
                .stops
                .iter()
                .map(|stop| stop.offset)
                .collect::<Vec<_>>(),
            vec![0, 2]
        );
    }

    #[test]
    fn selection_never_splits_a_surrogate_or_combining_cluster() {
        for text in ["😀", "e\u{301}"] {
            let selection = Selection::collapsed(Position {
                paragraph: 0,
                offset: 1,
            });
            assert!(layout_document(&document(text), &selection).is_err());
        }
    }

    #[test]
    fn unsupported_emoji_or_script_is_an_error_not_an_empty_or_replacement_path() {
        for text in ["🚀", "👩‍💻", "❤️", "مرحبا", "abc\u{202e}xyz"] {
            assert!(
                layout_document(&document(text), &Selection::default()).is_err(),
                "{text}"
            );
        }
    }

    #[test]
    fn tabs_use_default_docx_36_point_stops_and_one_utf16_unit() {
        let actual = layout("A\tB\tC");
        assert_eq!(actual.lines[0].stops[2].offset, 2);
        assert!((actual.lines[0].stops[2].x - 108.0).abs() < EPSILON);
        assert!((actual.lines[0].stops[4].x - 144.0).abs() < EPSILON);
        assert_eq!(actual.pages[0].paths.len(), 3);
        let text = "AAAA\tB\tC";
        let wrapped = layout_document(&narrow(document(text)), &Selection::default()).unwrap();
        for line in &wrapped.lines {
            for stop in &line.stops[1..] {
                if text.as_bytes()[stop.offset - 1] == b'\t' {
                    assert!(((stop.x - line.stops[0].x) / 36.0).fract().abs() < EPSILON);
                }
            }
        }
    }

    #[test]
    fn final_lines_reshape_kerning_without_next_line_context() {
        for text in ["AVAVAVAVAVAVAVA", "AVAV中文AVAVA中文AV"] {
            let mut doc = document(text);
            doc.page.width = 144.0;
            doc.page.margin_left = 53.25;
            doc.page.margin_right = 53.25;
            let actual = layout_document(&doc, &Selection::default()).unwrap();
            assert!(actual.lines.len() > 1);
            for line in &actual.lines {
                let from = line.stops[0].offset;
                let to = line.stops.last().unwrap().offset;
                let encoded: Vec<u16> = text.encode_utf16().collect();
                let part = String::from_utf16(&encoded[from..to]).unwrap();
                let separate = layout(&part);
                assert!((line_width(line) - line_width(&separate.lines[0])).abs() < EPSILON);
                assert!(line_width(line) <= 37.5 + EPSILON);
            }
        }
    }

    #[test]
    fn wrap_boundary_caret_affinity_chooses_following_line() {
        let doc = narrow(document("one two three four five"));
        let first = layout_document(&doc, &Selection::default()).unwrap();
        let offset = first.lines[1].stops[0].offset;
        let selected = layout_document(
            &doc,
            &Selection::collapsed(Position {
                paragraph: 0,
                offset,
            }),
        )
        .unwrap();
        assert_eq!(selected.caret.unwrap().y, first.lines[1].y);
    }

    #[test]
    fn vertical_navigation_uses_visual_lines_and_nearest_measured_caret() {
        let actual = layout_document(
            &narrow(document("one two three four five six")),
            &Selection::default(),
        )
        .unwrap();
        let first = Position {
            paragraph: 0,
            offset: 1,
        };
        let next = move_vertical(&actual, &first, 1).unwrap();
        assert!(next.offset >= actual.lines[1].stops[0].offset);
        assert!(next.offset <= actual.lines[1].stops.last().unwrap().offset);
        assert_eq!(
            move_vertical(&actual, &Position::default(), -1).unwrap(),
            Position::default()
        );
        assert!(move_vertical(&actual, &first, 0).is_err());
    }

    #[test]
    fn backwards_selection_matches_forward_and_includes_paragraph_separator() {
        let mut doc = document("first");
        doc.paragraphs.push(Paragraph::default());
        doc.paragraphs.push(document("last").paragraphs.remove(0));
        let forward = Selection {
            anchor: Position {
                paragraph: 0,
                offset: 2,
            },
            focus: Position {
                paragraph: 2,
                offset: 2,
            },
        };
        let reverse = Selection {
            anchor: forward.focus,
            focus: forward.anchor,
        };
        let actual = layout_document(&doc, &forward).unwrap();
        assert_eq!(
            actual.selection_rects,
            layout_document(&doc, &reverse).unwrap().selection_rects
        );
        assert_eq!(actual.selection_rects.len(), 3);
        assert!(actual.selection_rects[1].width > 0.0);
    }

    #[test]
    fn different_run_sizes_share_a_baseline_and_use_largest_line_height() {
        let mut doc = document("A");
        let mut large = TextStyle::default();
        large.font_size = 36.0;
        large.color = "#C00000".into();
        doc.paragraphs[0].runs.push(Run {
            text: "中".into(),
            style: large,
        });
        let actual = layout_document(&doc, &Selection::default()).unwrap();
        assert_eq!(actual.lines.len(), 1);
        assert!(actual.lines[0].height > 36.0);
        assert_eq!(actual.pages[0].paths[1].fill, "#C00000");
    }

    #[test]
    fn bad_coordinates_and_non_live_layouts_reject() {
        let actual = layout("click");
        assert!(hit_test(&actual, 1, 0.0, 0.0).is_err());
        assert!(hit_test(&actual, 0, f64::NAN, 0.0).is_err());
        let from_json: Layout =
            serde_json::from_str(&serde_json::to_string(&actual).unwrap()).unwrap();
        assert!(hit_test(&from_json, 0, 0.0, 0.0).is_err());
    }

    #[test]
    fn character_page_and_size_limits_are_enforced_before_output() {
        assert!(layout_document(&document(&"a".repeat(10001)), &Selection::default()).is_err());
        let mut doc = document("A");
        doc.paragraphs[0].runs[0].style.font_size = f64::NAN;
        assert!(layout_document(&doc, &Selection::default()).is_err());
        doc.paragraphs[0].runs[0].style.font_size = 72.0;
        doc.page.width = 144.0;
        doc.page.height = 144.0;
        doc.page.margin_top = 18.0;
        doc.page.margin_bottom = 18.0;
        doc.page.margin_left = 18.0;
        doc.page.margin_right = 18.0;
        doc.paragraphs = vec![doc.paragraphs[0].clone(); 201];
        assert!(layout_document(&doc, &Selection::default())
            .unwrap_err()
            .contains("200 laid-out pages"));
    }

    #[test]
    fn wire_output_has_only_drawable_geometry_and_is_deterministic() {
        let first = layout("一致 deterministic 😀");
        assert_eq!(first, layout("一致 deterministic 😀"));
        let json = serde_json::to_value(&first).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 3);
        assert!(json.get("lines").is_none());
        assert!(json.get("selectionRects").is_some());
        assert!(json["pages"][0]["paths"][0].get("d").is_some());
        assert!(json["pages"][0]["paths"][0].get("text").is_none());
    }
}
