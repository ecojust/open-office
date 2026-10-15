use crate::{
    docx,
    layout::{self, Layout},
    model::*,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

const MAX_SESSIONS: usize = 4;
const MAX_HISTORY: usize = 32;

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Create {
        session_id: String,
    },
    Open {
        session_id: String,
        base64: String,
    },
    Command {
        session_id: String,
        expected_revision: u64,
        command: Command,
    },
    Export {
        session_id: String,
        expected_revision: Option<u64>,
    },
    Close {
        session_id: String,
    },
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Left,
    Right,
    Home,
    End,
    Up,
    Down,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    ReplaceText {
        text: String,
    },
    DeleteBackward,
    DeleteForward,
    Select {
        selection: Selection,
    },
    SelectAll,
    Move {
        direction: Direction,
        #[serde(default)]
        extend: bool,
    },
    Format {
        bold: Option<bool>,
        italic: Option<bool>,
        font_size: Option<f64>,
        color: Option<String>,
    },
    Align {
        alignment: Alignment,
    },
    Undo,
    Redo,
    MarkSaved,
    HitTest {
        page: usize,
        x: f64,
        y: f64,
        #[serde(default)]
        extend: bool,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFormat {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub font_size: Option<f64>,
    pub color: Option<String>,
    pub font_family: Option<String>,
    pub align: Option<Alignment>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    pub revision: u64,
    pub document: Document,
    pub selection: Selection,
    pub selection_text: String,
    pub layout: Layout,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub format: SelectionFormat,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl Response {
    pub fn error(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            snapshot: None,
            base64: None,
            error: Some(error.into()),
        }
    }
    fn success(snapshot: Option<Snapshot>) -> Self {
        Self {
            ok: true,
            snapshot,
            base64: None,
            error: None,
        }
    }
}

#[derive(Clone, PartialEq)]
struct EditState {
    document: Document,
    selection: Selection,
    typing: Option<TextStyle>,
}
#[derive(Clone)]
struct Session {
    document: Document,
    selection: Selection,
    typing: Option<TextStyle>,
    layout: Layout,
    revision: u64,
    saved: Document,
    past: VecDeque<EditState>,
    future: Vec<EditState>,
}
impl Session {
    fn new(document: Document, revision: u64) -> Result<Self, String> {
        let document = normalize_document(document)?;
        let selection = Selection::default();
        let layout = layout::layout_document(&document, &selection)?;
        Ok(Self {
            saved: document.clone(),
            document,
            selection,
            typing: None,
            layout,
            revision,
            past: VecDeque::new(),
            future: Vec::new(),
        })
    }
    fn state(&self) -> EditState {
        EditState {
            document: self.document.clone(),
            selection: self.selection.clone(),
            typing: self.typing.clone(),
        }
    }
    fn restore(&mut self, state: EditState) {
        self.document = state.document;
        self.selection = state.selection;
        self.typing = state.typing;
    }
    fn snapshot(&self, id: &str) -> Result<Snapshot, String> {
        Ok(Snapshot {
            session_id: id.into(),
            revision: self.revision,
            document: self.document.clone(),
            selection: self.selection.clone(),
            selection_text: selection_text(&self.document, &self.selection)?,
            layout: self.layout.clone(),
            can_undo: !self.past.is_empty(),
            can_redo: !self.future.is_empty(),
            dirty: self.document != self.saved,
            format: self.format()?,
        })
    }
    fn format(&self) -> Result<SelectionFormat, String> {
        let (start, end) = self.selection.ordered();
        let mut styles = Vec::new();
        let mut aligns = Vec::new();
        if self.selection.is_collapsed() {
            styles.push(self.typing.clone().unwrap_or_else(|| {
                style_at(&self.document.paragraphs[start.paragraph], start.offset)
            }));
            aligns.push(self.document.paragraphs[start.paragraph].align);
        } else {
            for index in start.paragraph..=end.paragraph {
                if index == end.paragraph && end.offset == 0 && index != start.paragraph {
                    break;
                }
                let paragraph = &self.document.paragraphs[index];
                let from = if index == start.paragraph {
                    start.offset
                } else {
                    0
                };
                let to = if index == end.paragraph {
                    end.offset
                } else {
                    utf16_len(&paragraph_text(paragraph))
                };
                styles.extend(
                    slice_runs(paragraph, from, to)?
                        .into_iter()
                        .map(|run| run.style),
                );
                aligns.push(paragraph.align);
            }
        }
        if styles.is_empty() {
            styles.push(style_at(
                &self.document.paragraphs[start.paragraph],
                start.offset,
            ));
        }
        let first = &styles[0];
        Ok(SelectionFormat {
            bold: styles
                .iter()
                .all(|s| s.bold == first.bold)
                .then_some(first.bold),
            italic: styles
                .iter()
                .all(|s| s.italic == first.italic)
                .then_some(first.italic),
            font_size: styles
                .iter()
                .all(|s| s.font_size == first.font_size)
                .then_some(first.font_size),
            color: styles
                .iter()
                .all(|s| s.color == first.color)
                .then(|| first.color.clone()),
            font_family: styles
                .iter()
                .all(|s| s.font_family == first.font_family)
                .then(|| first.font_family.clone()),
            align: aligns
                .first()
                .copied()
                .filter(|first| aligns.iter().all(|a| a == first)),
        })
    }
    fn selected(&mut self, position: Position, extend: bool) {
        self.selection = if extend {
            Selection {
                anchor: self.selection.anchor,
                focus: position,
            }
        } else {
            Selection::collapsed(position)
        };
        self.typing = None;
    }
    fn previous(&self, position: Position) -> Position {
        if position.offset == 0 {
            return if position.paragraph == 0 {
                position
            } else {
                Position {
                    paragraph: position.paragraph - 1,
                    offset: utf16_len(&paragraph_text(
                        &self.document.paragraphs[position.paragraph - 1],
                    )),
                }
            };
        }
        let text = paragraph_text(&self.document.paragraphs[position.paragraph]);
        Position {
            paragraph: position.paragraph,
            offset: grapheme_offsets(&text)
                .into_iter()
                .rev()
                .find(|offset| *offset < position.offset)
                .unwrap_or(0),
        }
    }
    fn following(&self, position: Position) -> Position {
        let text = paragraph_text(&self.document.paragraphs[position.paragraph]);
        if position.offset == utf16_len(&text) {
            return if position.paragraph + 1 == self.document.paragraphs.len() {
                position
            } else {
                Position {
                    paragraph: position.paragraph + 1,
                    offset: 0,
                }
            };
        }
        Position {
            paragraph: position.paragraph,
            offset: grapheme_offsets(&text)
                .into_iter()
                .find(|offset| *offset > position.offset)
                .unwrap_or(position.offset),
        }
    }
    fn replace(&mut self, input: &str) -> Result<(), String> {
        validate_text(input, true)?;
        if utf16_len(input) > MAX_CHARACTERS {
            return Err("Replacement exceeds 10,000 UTF-16 units".into());
        }
        let text = input.replace("\r\n", "\n").replace('\r', "\n");
        let (start, end) = self.selection.ordered();
        let first = &self.document.paragraphs[start.paragraph];
        let last = &self.document.paragraphs[end.paragraph];
        let style = self
            .typing
            .clone()
            .unwrap_or_else(|| style_at(first, start.offset));
        let left = slice_runs(first, 0, start.offset)?;
        let right = slice_runs(last, end.offset, utf16_len(&paragraph_text(last)))?;
        let lines: Vec<&str> = text.split('\n').collect();
        let mut replacements = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let mut runs = if index == 0 { left.clone() } else { Vec::new() };
            runs.push(Run {
                text: (*line).into(),
                style: style.clone(),
            });
            if index + 1 == lines.len() {
                runs.extend(right.clone());
            }
            replacements.push(Paragraph {
                runs: compact_runs(runs, &style),
                align: first.align,
            });
        }
        self.document
            .paragraphs
            .splice(start.paragraph..=end.paragraph, replacements);
        self.selection = Selection::collapsed(Position {
            paragraph: start.paragraph + lines.len() - 1,
            offset: utf16_len(lines.last().unwrap())
                + if lines.len() == 1 { start.offset } else { 0 },
        });
        Ok(())
    }
    fn apply(&mut self, command: Command) -> Result<(), String> {
        let before = self.state();
        let saved_before = self.saved.clone();
        let history_command = matches!(command, Command::Undo | Command::Redo);
        match command {
            Command::ReplaceText { text } => self.replace(&text)?,
            Command::DeleteBackward => {
                if self.selection.is_collapsed() {
                    self.selection.anchor = self.previous(self.selection.focus);
                }
                self.replace("")?;
            }
            Command::DeleteForward => {
                if self.selection.is_collapsed() {
                    self.selection.focus = self.following(self.selection.focus);
                }
                self.replace("")?;
            }
            Command::Select { selection } => {
                validate_selection(&self.document, &selection)?;
                self.selection = selection;
                self.typing = None;
            }
            Command::SelectAll => {
                let paragraph = self.document.paragraphs.len() - 1;
                self.selection = Selection {
                    anchor: Position::default(),
                    focus: Position {
                        paragraph,
                        offset: utf16_len(&paragraph_text(&self.document.paragraphs[paragraph])),
                    },
                };
                self.typing = None;
            }
            Command::Move { direction, extend } => {
                let focus = self.selection.focus;
                let (start, end) = self.selection.ordered();
                let position = match direction {
                    Direction::Left if !extend && !self.selection.is_collapsed() => start,
                    Direction::Right if !extend && !self.selection.is_collapsed() => end,
                    Direction::Left => self.previous(focus),
                    Direction::Right => self.following(focus),
                    Direction::Home => Position {
                        paragraph: focus.paragraph,
                        offset: 0,
                    },
                    Direction::End => Position {
                        paragraph: focus.paragraph,
                        offset: utf16_len(&paragraph_text(
                            &self.document.paragraphs[focus.paragraph],
                        )),
                    },
                    Direction::Up => layout::move_vertical(&self.layout, &focus, -1)?,
                    Direction::Down => layout::move_vertical(&self.layout, &focus, 1)?,
                };
                self.selected(position, extend);
            }
            Command::Format {
                bold,
                italic,
                font_size,
                color,
            } => {
                if bold.is_none() && italic.is_none() && font_size.is_none() && color.is_none() {
                    return Ok(());
                }
                let patch = |style: &TextStyle| -> Result<TextStyle, String> {
                    let mut result = style.clone();
                    if let Some(value) = bold {
                        result.bold = value;
                    }
                    if let Some(value) = italic {
                        result.italic = value;
                    }
                    if let Some(value) = font_size {
                        result.font_size = value;
                    }
                    if let Some(value) = &color {
                        result.color = value.clone();
                    }
                    normalize_style(result)
                };
                let (start, end) = self.selection.ordered();
                if self.selection.is_collapsed() {
                    self.typing = Some(patch(&self.typing.clone().unwrap_or_else(|| {
                        style_at(&self.document.paragraphs[start.paragraph], start.offset)
                    }))?);
                } else {
                    for index in start.paragraph..=end.paragraph {
                        if index == end.paragraph && end.offset == 0 && index != start.paragraph {
                            break;
                        }
                        let paragraph = &mut self.document.paragraphs[index];
                        let length = utf16_len(&paragraph_text(paragraph));
                        let from = if index == start.paragraph {
                            start.offset
                        } else {
                            0
                        };
                        let to = if index == end.paragraph {
                            end.offset
                        } else {
                            length
                        };
                        let fallback = patch(&paragraph.runs[0].style)?;
                        let mut runs = slice_runs(paragraph, 0, from)?;
                        for mut run in slice_runs(paragraph, from, to)? {
                            run.style = patch(&run.style)?;
                            runs.push(run);
                        }
                        runs.extend(slice_runs(paragraph, to, length)?);
                        paragraph.runs = compact_runs(runs, &fallback);
                    }
                    self.typing = None;
                }
            }
            Command::Align { alignment } => {
                let (start, end) = self.selection.ordered();
                for index in start.paragraph..=end.paragraph {
                    if index == end.paragraph && end.offset == 0 && index != start.paragraph {
                        break;
                    }
                    self.document.paragraphs[index].align = alignment;
                }
            }
            Command::Undo => {
                if let Some(previous) = self.past.pop_back() {
                    self.future.push(before.clone());
                    self.restore(previous);
                }
            }
            Command::Redo => {
                if let Some(next) = self.future.pop() {
                    self.past.push_back(before.clone());
                    self.restore(next);
                }
            }
            Command::MarkSaved => self.saved = self.document.clone(),
            Command::HitTest { page, x, y, extend } => {
                self.selected(layout::hit_test(&self.layout, page, x, y)?, extend)
            }
        }
        self.document = normalize_document(self.document.clone())?;
        validate_selection(&self.document, &self.selection)?;
        if before == self.state() && saved_before == self.saved {
            return Ok(());
        }
        let layout = layout::layout_document(&self.document, &self.selection)?;
        if !history_command && self.document != before.document {
            self.past.push_back(before);
            while self.past.len() > MAX_HISTORY {
                self.past.pop_front();
            }
            self.future.clear();
        }
        self.layout = layout;
        self.revision = self.revision.checked_add(1).ok_or("Revision exhausted")?;
        Ok(())
    }
}

#[derive(Default)]
pub struct Engine {
    sessions: HashMap<String, Session>,
}
impl Engine {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn request(&mut self, request: Request) -> Response {
        match self.handle(request) {
            Ok(response) => response,
            Err(error) => Response::error(error),
        }
    }
    fn handle(&mut self, request: Request) -> Result<Response, String> {
        let id = match &request {
            Request::Create { session_id }
            | Request::Open { session_id, .. }
            | Request::Command { session_id, .. }
            | Request::Export { session_id, .. }
            | Request::Close { session_id } => session_id,
        };
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err("Invalid session ID".into());
        }
        match request {
            Request::Create { session_id } => self.open(session_id, Document::default()),
            Request::Open { session_id, base64 } => {
                if base64.len() > word_package::encoded_limit(word_package::INPUT_LIMIT) {
                    return Err("DOCX exceeds 16 MiB".into());
                }
                let bytes = STANDARD
                    .decode(base64)
                    .map_err(|_| "Invalid standard Base64 DOCX".to_string())?;
                let document = docx::import_document(&bytes)?;
                self.open(session_id, document)
            }
            Request::Command {
                session_id,
                expected_revision,
                command,
            } => {
                let session = self
                    .sessions
                    .get(&session_id)
                    .ok_or("Session does not exist")?;
                if expected_revision != session.revision {
                    return Err(format!(
                        "Stale revision: expected {expected_revision}, current {}",
                        session.revision
                    ));
                }
                // All model, history and layout work happens on a private candidate.
                let mut candidate = session.clone();
                candidate.apply(command)?;
                let snapshot = candidate.snapshot(&session_id)?;
                self.sessions.insert(session_id, candidate);
                Ok(Response::success(Some(snapshot)))
            }
            Request::Export {
                session_id,
                expected_revision,
            } => {
                let session = self
                    .sessions
                    .get(&session_id)
                    .ok_or("Session does not exist")?;
                if expected_revision.is_some_and(|revision| revision != session.revision) {
                    return Err("Stale export revision".into());
                }
                let bytes = docx::export_document(&session.document)?;
                let mut response = Response::success(Some(session.snapshot(&session_id)?));
                response.base64 = Some(STANDARD.encode(bytes));
                Ok(response)
            }
            Request::Close { session_id } => {
                self.sessions.remove(&session_id);
                Ok(Response::success(None))
            }
        }
    }
    fn open(&mut self, id: String, document: Document) -> Result<Response, String> {
        if !self.sessions.contains_key(&id) && self.sessions.len() >= MAX_SESSIONS {
            return Err("Close a document before opening more than four sessions".into());
        }
        let revision = match self.sessions.get(&id) {
            Some(session) => session
                .revision
                .checked_add(1)
                .ok_or("Revision exhausted")?,
            None => 0,
        };
        let candidate = Session::new(document, revision)?;
        let snapshot = candidate.snapshot(&id)?;
        self.sessions.insert(id, candidate);
        Ok(Response::success(Some(snapshot)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create(engine: &mut Engine) -> Snapshot {
        engine
            .request(Request::Create {
                session_id: "test".into(),
            })
            .snapshot
            .expect("create")
    }
    fn command(engine: &mut Engine, snapshot: &Snapshot, command: Command) -> Snapshot {
        let response = engine.request(Request::Command {
            session_id: "test".into(),
            expected_revision: snapshot.revision,
            command,
        });
        assert!(response.ok, "{:?}", response.error);
        response.snapshot.unwrap()
    }
    #[test]
    fn unicode_selection_edit_history_and_saved_content_are_owned_by_rust() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "A😀e\u{301}\n中文".into(),
            },
        );
        assert_eq!(
            state.selection.focus,
            Position {
                paragraph: 1,
                offset: 2
            }
        );
        assert!(state.dirty);
        state = command(&mut engine, &state, Command::MarkSaved);
        assert!(!state.dirty);
        state = command(
            &mut engine,
            &state,
            Command::Select {
                selection: Selection::collapsed(Position {
                    paragraph: 0,
                    offset: 5,
                }),
            },
        );
        state = command(&mut engine, &state, Command::DeleteBackward);
        assert_eq!(paragraph_text(&state.document.paragraphs[0]), "A😀");
        state = command(&mut engine, &state, Command::DeleteBackward);
        assert_eq!(paragraph_text(&state.document.paragraphs[0]), "A");
        state = command(&mut engine, &state, Command::Undo);
        state = command(&mut engine, &state, Command::Undo);
        assert_eq!(paragraph_text(&state.document.paragraphs[0]), "A😀e\u{301}");
        assert!(!state.dirty);
        assert!(state.can_redo);
    }
    #[test]
    fn invalid_or_stale_commands_and_layout_rejections_leave_everything_unchanged() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "A😀e\u{301}".into(),
            },
        );
        let before = serde_json::to_value(&state).unwrap();
        for command in [
            Command::Select {
                selection: Selection::collapsed(Position {
                    paragraph: 0,
                    offset: 2,
                }),
            },
            Command::Select {
                selection: Selection::collapsed(Position {
                    paragraph: 0,
                    offset: 4,
                }),
            },
            Command::Format {
                bold: Some(true),
                italic: None,
                font_size: Some(100.0),
                color: None,
            },
            Command::ReplaceText {
                text: "x".repeat(MAX_CHARACTERS + 1),
            },
            Command::ReplaceText {
                text: "مرحبا".into(),
            },
        ] {
            assert!(
                !engine
                    .request(Request::Command {
                        session_id: "test".into(),
                        expected_revision: state.revision,
                        command
                    })
                    .ok
            );
            assert_eq!(
                serde_json::to_value(engine.sessions["test"].snapshot("test").unwrap()).unwrap(),
                before
            );
        }
        assert!(
            !engine
                .request(Request::Command {
                    session_id: "test".into(),
                    expected_revision: 0,
                    command: Command::DeleteBackward
                })
                .ok
        );
        assert_eq!(
            serde_json::to_value(engine.sessions["test"].snapshot("test").unwrap()).unwrap(),
            before
        );
    }
    #[test]
    fn paragraph_split_join_backward_selection_and_format_round_trip() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "first\nsecond".into(),
            },
        );
        state = command(
            &mut engine,
            &state,
            Command::Select {
                selection: Selection {
                    anchor: Position {
                        paragraph: 1,
                        offset: 3,
                    },
                    focus: Position {
                        paragraph: 0,
                        offset: 2,
                    },
                },
            },
        );
        assert_eq!(state.selection_text, "rst\nsec");
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "中\n文".into(),
            },
        );
        assert_eq!(document_text(&state.document), "fi中\n文ond");
        state = command(&mut engine, &state, Command::SelectAll);
        state = command(
            &mut engine,
            &state,
            Command::Format {
                bold: Some(true),
                italic: None,
                font_size: Some(18.0),
                color: Some("auto".into()),
            },
        );
        assert_eq!(state.format.bold, Some(true));
        assert_eq!(state.format.color.as_deref(), Some("auto"));
        let exported = engine.request(Request::Export {
            session_id: "test".into(),
            expected_revision: Some(state.revision),
        });
        assert!(exported.ok, "{:?}", exported.error);
        assert!(exported.snapshot.unwrap().dirty);
        let opened = engine.request(Request::Open {
            session_id: "test".into(),
            base64: exported.base64.unwrap(),
        });
        assert!(opened.ok, "{:?}", opened.error);
        let imported = opened.snapshot.unwrap();
        assert_eq!(imported.document, state.document);
        assert!(!imported.dirty);
        assert!(imported.revision > state.revision);
    }
    #[test]
    fn strict_protocol_and_sessions_are_bounded() {
        let mut engine = Engine::new();
        for id in ["one", "two", "three", "four"] {
            assert!(
                engine
                    .request(Request::Create {
                        session_id: id.into()
                    })
                    .ok
            );
        }
        assert!(
            !engine
                .request(Request::Create {
                    session_id: "five".into()
                })
                .ok
        );
        assert!(
            engine
                .request(Request::Close {
                    session_id: "two".into()
                })
                .ok
        );
        assert!(
            engine
                .request(Request::Create {
                    session_id: "five".into()
                })
                .ok
        );
        for bytes in [
            br#"{"op":"create","sessionId":"bad/id"}"#.as_slice(),
            br#"{"op":"create","sessionId":"one","unknown":true}"#.as_slice(),
            br#"{"op":"command","sessionId":"one","command":{"type":"undo"}}"#.as_slice(),
        ] {
            let result: serde_json::Value =
                serde_json::from_slice(&crate::request_json(&mut engine, bytes)).unwrap();
            assert_eq!(result["ok"], false);
        }
    }
    #[test]
    fn failed_open_export_and_stale_save_do_not_destroy_current_edits() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "saved".into(),
            },
        );
        let exported = engine.request(Request::Export {
            session_id: "test".into(),
            expected_revision: Some(state.revision),
        });
        assert!(exported.ok);
        assert!(exported.snapshot.unwrap().dirty);
        let exported_revision = state.revision;
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: " later".into(),
            },
        );
        let before = serde_json::to_value(&state).unwrap();
        for request in [
            Request::Open {
                session_id: "test".into(),
                base64: "not a package".into(),
            },
            Request::Export {
                session_id: "test".into(),
                expected_revision: Some(exported_revision),
            },
            Request::Command {
                session_id: "test".into(),
                expected_revision: exported_revision,
                command: Command::MarkSaved,
            },
        ] {
            assert!(!engine.request(request).ok);
            assert_eq!(
                serde_json::to_value(engine.sessions["test"].snapshot("test").unwrap()).unwrap(),
                before
            );
        }
        assert!(state.dirty);
        assert!(state.can_undo);
    }
    #[test]
    fn history_is_bounded_and_non_document_commands_leave_redo_available() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        for _ in 0..40 {
            state = command(
                &mut engine,
                &state,
                Command::ReplaceText { text: "x".into() },
            );
        }
        assert_eq!(engine.sessions["test"].past.len(), MAX_HISTORY);
        state = command(&mut engine, &state, Command::Undo);
        state = command(
            &mut engine,
            &state,
            Command::Move {
                direction: Direction::Home,
                extend: false,
            },
        );
        assert!(state.can_redo);
        state = command(&mut engine, &state, Command::Redo);
        assert_eq!(document_text(&state.document), "x".repeat(40));
        for _ in 0..MAX_HISTORY {
            state = command(&mut engine, &state, Command::Undo);
        }
        assert_eq!(document_text(&state.document), "x".repeat(8));
        assert!(!state.can_undo);
    }

    #[test]
    fn exact_run_boundaries_keep_styles_and_delete_one_complete_grapheme() {
        let mut engine = Engine::new();
        let mut state = create(&mut engine);
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText {
                text: "A😀B".into(),
            },
        );
        state = command(
            &mut engine,
            &state,
            Command::Select {
                selection: Selection {
                    anchor: Position {
                        paragraph: 0,
                        offset: 1,
                    },
                    focus: Position {
                        paragraph: 0,
                        offset: 3,
                    },
                },
            },
        );
        state = command(
            &mut engine,
            &state,
            Command::Format {
                bold: Some(true),
                italic: None,
                font_size: None,
                color: Some("#c00000".into()),
            },
        );
        let formatted = state.document.clone();
        assert_eq!(
            formatted.paragraphs[0]
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>(),
            ["A", "😀", "B"]
        );
        assert_eq!(formatted.paragraphs[0].runs[1].style.color, "#C00000");
        state = command(
            &mut engine,
            &state,
            Command::Select {
                selection: Selection::collapsed(Position {
                    paragraph: 0,
                    offset: 3,
                }),
            },
        );
        state = command(
            &mut engine,
            &state,
            Command::ReplaceText { text: "X".into() },
        );
        assert_eq!(state.document.paragraphs[0].runs[1].text, "😀X");
        assert!(state.document.paragraphs[0].runs[1].style.bold);
        assert!(!state.document.paragraphs[0].runs.last().unwrap().style.bold);
        state = command(&mut engine, &state, Command::Undo);
        assert_eq!(state.document, formatted);
        state = command(&mut engine, &state, Command::DeleteBackward);
        assert_eq!(document_text(&state.document), "AB");
        assert_eq!(state.document.paragraphs[0].runs.len(), 1);
        assert!(!state.document.paragraphs[0].runs[0].style.bold);
        state = command(&mut engine, &state, Command::Undo);
        assert_eq!(state.document, formatted);
        state = command(
            &mut engine,
            &state,
            Command::Select {
                selection: Selection::collapsed(Position {
                    paragraph: 0,
                    offset: 1,
                }),
            },
        );
        state = command(&mut engine, &state, Command::DeleteForward);
        assert_eq!(document_text(&state.document), "AB");
    }
}
