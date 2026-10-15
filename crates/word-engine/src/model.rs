use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_CHARACTERS: usize = 10_000;
pub const MAX_PARAGRAPHS: usize = 500;
pub const MAX_PAGES: usize = 200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
}
impl Default for Page {
    fn default() -> Self {
        Self {
            width: 595.3,
            height: 841.9,
            margin_top: 72.0,
            margin_bottom: 72.0,
            margin_left: 72.0,
            margin_right: 72.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyle {
    pub bold: bool,
    pub italic: bool,
    pub font_size: f64,
    pub color: String,
    pub font_family: String,
}
impl Default for TextStyle {
    fn default() -> Self {
        Self {
            bold: false,
            italic: false,
            font_size: 12.0,
            color: "#20242B".into(),
            font_family: "DejaVu Sans".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Alignment {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub text: String,
    pub style: TextStyle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Paragraph {
    pub runs: Vec<Run>,
    pub align: Alignment,
}
impl Default for Paragraph {
    fn default() -> Self {
        Self {
            runs: vec![Run {
                text: String::new(),
                style: TextStyle::default(),
            }],
            align: Alignment::Left,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub page: Page,
    pub paragraphs: Vec<Paragraph>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            page: Page::default(),
            paragraphs: vec![Paragraph::default()],
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    pub paragraph: usize,
    pub offset: usize,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub anchor: Position,
    pub focus: Position,
}
impl Selection {
    pub fn collapsed(position: Position) -> Self {
        Self {
            anchor: position,
            focus: position,
        }
    }
    pub fn ordered(&self) -> (Position, Position) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }
    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.focus
    }
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn paragraph_text(paragraph: &Paragraph) -> String {
    paragraph.runs.iter().map(|run| run.text.as_str()).collect()
}
pub fn document_text(document: &Document) -> String {
    document
        .paragraphs
        .iter()
        .map(paragraph_text)
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn byte_index(text: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += ch.len_utf16();
        if units > offset {
            return Err("Selection splits a UTF-16 surrogate pair".into());
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err("Selection offset exceeds paragraph length".into())
    }
}
pub fn grapheme_offsets(text: &str) -> Vec<usize> {
    let mut offset = 0;
    let mut result = vec![0];
    for grapheme in text.graphemes(true) {
        offset += utf16_len(grapheme);
        result.push(offset);
    }
    result
}
pub fn validate_selection(document: &Document, selection: &Selection) -> Result<(), String> {
    for position in [selection.anchor, selection.focus] {
        let paragraph = document
            .paragraphs
            .get(position.paragraph)
            .ok_or("Selection paragraph does not exist")?;
        let text = paragraph_text(paragraph);
        byte_index(&text, position.offset)?;
        if !grapheme_offsets(&text).contains(&position.offset) {
            return Err("Selection splits an extended grapheme cluster".into());
        }
    }
    Ok(())
}
pub fn normalize_color(color: &str) -> Result<String, String> {
    if color == "auto" {
        return Ok(color.into());
    }
    if color.len() == 7
        && color.starts_with('#')
        && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Ok(color.to_ascii_uppercase());
    }
    Err("Text color must be auto or #RRGGBB".into())
}
pub fn validate_text(text: &str, allow_breaks: bool) -> Result<(), String> {
    if text.chars().any(|ch| {
        (ch < ' ' && ch != '\t' && !(allow_breaks && (ch == '\n' || ch == '\r')))
            || ch == '\u{fffe}'
            || ch == '\u{ffff}'
    }) {
        return Err("Text contains unsupported control characters".into());
    }
    Ok(())
}
pub fn normalize_style(mut style: TextStyle) -> Result<TextStyle, String> {
    if !style.font_size.is_finite()
        || !(8.0..=72.0).contains(&style.font_size)
        || (style.font_size * 2.0).fract() != 0.0
    {
        return Err("Font size must be between 8 and 72 points in half-point steps".into());
    }
    if style.font_family != "DejaVu Sans" {
        return Err(format!("Unsupported font family: {}", style.font_family));
    }
    style.color = normalize_color(&style.color)?;
    Ok(style)
}
pub fn compact_runs(runs: Vec<Run>, fallback: &TextStyle) -> Vec<Run> {
    let mut result: Vec<Run> = Vec::new();
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        if let Some(previous) = result.last_mut() {
            if previous.style == run.style {
                previous.text.push_str(&run.text);
                continue;
            }
        }
        result.push(run);
    }
    if result.is_empty() {
        result.push(Run {
            text: String::new(),
            style: fallback.clone(),
        });
    }
    result
}
pub fn normalize_document(mut document: Document) -> Result<Document, String> {
    if document.paragraphs.is_empty() || document.paragraphs.len() > MAX_PARAGRAPHS {
        return Err("Document must contain 1 to 500 paragraphs".into());
    }
    let p = &document.page;
    if ![
        p.width,
        p.height,
        p.margin_top,
        p.margin_bottom,
        p.margin_left,
        p.margin_right,
    ]
    .iter()
    .all(|n| n.is_finite())
        || !(144.0..=1584.0).contains(&p.width)
        || !(144.0..=1584.0).contains(&p.height)
        || [p.margin_top, p.margin_bottom, p.margin_left, p.margin_right]
            .iter()
            .any(|n| *n < 0.0)
        || p.width - p.margin_left - p.margin_right < 36.0
        || p.height - p.margin_top - p.margin_bottom < 36.0
    {
        return Err("Invalid page dimensions or margins".into());
    }
    let mut total = document.paragraphs.len() - 1;
    let mut run_count = 0;
    for paragraph in &mut document.paragraphs {
        if paragraph.runs.is_empty() {
            return Err("Paragraph must contain at least one run".into());
        }
        run_count += paragraph.runs.len();
        if run_count > 15_000 {
            return Err("Document exceeds the run limit".into());
        }
        for run in &mut paragraph.runs {
            validate_text(&run.text, false)?;
            total += utf16_len(&run.text);
            if total > MAX_CHARACTERS {
                return Err("Document exceeds 10,000 UTF-16 units".into());
            }
            run.style = normalize_style(run.style.clone())?;
        }
        let fallback = paragraph.runs[0].style.clone();
        paragraph.runs = compact_runs(std::mem::take(&mut paragraph.runs), &fallback);
        let boundaries = grapheme_offsets(&paragraph_text(paragraph));
        let mut offset = 0;
        for run in &paragraph.runs {
            offset += utf16_len(&run.text);
            if !boundaries.contains(&offset) {
                return Err("A style boundary splits an extended grapheme cluster".into());
            }
        }
    }
    Ok(document)
}

pub fn style_at(paragraph: &Paragraph, offset: usize) -> TextStyle {
    let mut end = 0;
    for run in &paragraph.runs {
        end += utf16_len(&run.text);
        if offset <= end {
            return run.style.clone();
        }
    }
    paragraph
        .runs
        .last()
        .map(|run| run.style.clone())
        .unwrap_or_default()
}
pub fn slice_runs(paragraph: &Paragraph, from: usize, to: usize) -> Result<Vec<Run>, String> {
    let mut result = Vec::new();
    let mut start = 0;
    for run in &paragraph.runs {
        let end = start + utf16_len(&run.text);
        let left = from.max(start);
        let right = to.min(end);
        if left < right {
            result.push(Run {
                text: run.text
                    [byte_index(&run.text, left - start)?..byte_index(&run.text, right - start)?]
                    .into(),
                style: run.style.clone(),
            });
        }
        start = end;
    }
    Ok(result)
}
pub fn selection_text(document: &Document, selection: &Selection) -> Result<String, String> {
    validate_selection(document, selection)?;
    let (start, end) = selection.ordered();
    let mut lines = Vec::new();
    for index in start.paragraph..=end.paragraph {
        let text = paragraph_text(&document.paragraphs[index]);
        let from = if index == start.paragraph {
            start.offset
        } else {
            0
        };
        let to = if index == end.paragraph {
            end.offset
        } else {
            utf16_len(&text)
        };
        lines.push(text[byte_index(&text, from)?..byte_index(&text, to)?].to_string());
    }
    Ok(lines.join("\n"))
}
