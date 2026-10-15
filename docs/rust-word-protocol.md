# Rust Word engine protocol (phase 1)

The Rust `word-engine` crate owns DOCX parsing/writing, document content, editing,
history, selection and layout. Browser code sends JSON commands and renders the
returned layout; it must not import the existing TypeScript Word model or codec.

## Transport

`Engine::request(Request) -> Response` is the shared native/WASM/CLI entry point.
The CLI `word-engine-cli` reads one UTF-8 JSON request per line and writes one JSON
response per line. One process retains sessions between requests.

Raw WASM exports (no wasm-bindgen):

- `word_engine_alloc(len: u32) -> u32`: allocate input bytes.
- `word_engine_dealloc(ptr: u32, len: u32)`: free those exact input bytes.
- `word_engine_request(ptr: u32, len: u32) -> u32`: consume UTF-8 JSON without
  freeing input; return the response pointer.
- `word_engine_result_len() -> u32`: response length. Response storage is owned by
  Rust and remains valid until the next request. Copy it before another request;
  never deallocate the result pointer. Re-read WASM memory after calls may grow it.

All JSON keys use camelCase. Unknown request/command/model fields reject. Errors
return `{ "ok": false, "error": "..." }`; failed requests never replace a session
or change document, selection, history, saved state or revision.

## Requests

```json
{"op":"create","sessionId":"editor"}
{"op":"open","sessionId":"editor","base64":"DOCX bytes in standard Base64"}
{"op":"command","sessionId":"editor","expectedRevision":0,"command":{"type":"replaceText","text":"Hello\nWorld"}}
{"op":"export","sessionId":"editor","expectedRevision":1}
{"op":"close","sessionId":"editor"}
```

`create`/`open` replace an existing same-ID session only after successful validation
and layout. Session IDs are nonempty ASCII letters/digits/`-_.`, at most 64 bytes.
At most four sessions are live. `command.expectedRevision` is required;
`export.expectedRevision` is optional but clients should supply it. Stale revisions
reject. A changed state increments revision monotonically, including selection,
live typing format, undo/redo and saved state. No-op commands retain revision.

Successful create/open/command responses have `{ok:true,snapshot:Snapshot}`.
Export has `{ok:true,snapshot:Snapshot,base64:"..."}` and does not mark the content
saved. Close returns `{ok:true}`. Only an explicit `markSaved` after successful
delivery updates the clean baseline. Dirty compares document content to that
baseline, independently of selection and undo cursor.

## Document and snapshot

```ts
type Position = { paragraph: number; offset: number }; // UTF-16 code units
type Selection = { anchor: Position; focus: Position };
type Alignment = 'left' | 'center' | 'right';
type TextStyle = {
  bold: boolean; italic: boolean; fontSize: number; color: string;
  fontFamily: string;
};
type Document = {
  page: { width: number; height: number; marginTop: number; marginBottom: number;
          marginLeft: number; marginRight: number }; // points, 72 pt/in
  paragraphs: { runs: { text: string; style: TextStyle }[]; align: Alignment }[];
};
type Snapshot = {
  sessionId: string; revision: number; document: Document; selection: Selection;
  selectionText: string; layout: Layout; canUndo: boolean; canRedo: boolean;
  dirty: boolean;
  format: { bold: boolean|null; italic: boolean|null; fontSize: number|null;
            color: string|null; fontFamily: string|null; align: Alignment|null };
};
```

New documents use A4 595.3 × 841.9 pt (integer OOXML twips), 72 pt margins, one left-aligned empty
paragraph, 12 pt regular DejaVu Sans, and `#20242B`. Colors are canonical `#RRGGBB`
or the semantic token `auto`. This phase supports white pages only. Paragraph run
text contains no CR/LF; tabs are permitted. Replacement text normalizes CRLF/CR to
paragraph breaks. DOCX files containing tabs must explicitly declare the default
tab stop as 720 twips (36 pt); exports always include this setting.
Limits: 10,000 UTF-16 units including paragraph separators,
500 paragraphs, 200 laid-out pages, 8–72 pt font sizes in half-point steps, 32 undo entries.
Positions must lie on extended grapheme boundaries; splitting surrogate pairs,
combining sequences or emoji clusters rejects atomically.

## Commands

```ts
type Command =
 | {type:'replaceText';text:string}
 | {type:'deleteBackward'} | {type:'deleteForward'}
 | {type:'select';selection:Selection} | {type:'selectAll'}
 | {type:'move';direction:'left'|'right'|'home'|'end'|'up'|'down';extend?:boolean}
 | {type:'format';bold?:boolean;italic?:boolean;fontSize?:number;color?:string}
 | {type:'align';alignment:Alignment}
 | {type:'undo'} | {type:'redo'} | {type:'markSaved'}
 | {type:'hitTest';page:number;x:number;y:number;extend?:boolean};
```

Replacement replaces the current selection in one history transaction. Composition
is committed by one `replaceText` at compositionend; intermediate composition text
stays in the UI overlay. Delete uses extended graphemes, including across paragraph
boundaries. `format` on a collapsed selection updates live typing style; selection
movement clears that override. Font-family selection is not exposed in phase 1.
Home/end use paragraph boundaries; up/down and hit testing use Rust layout. Page
indices are zero-based and x/y are page-local points. Selection/movement/hit tests
do not create document undo entries. Every document-changing command is validated
and laid out before commit; a layout failure rolls the complete command back.

## Rust module interfaces

`model` exposes `Document`, `Page`, `Paragraph`, `Run`, `TextStyle`, `Alignment`,
`Position`, `Selection`. Serde uses camelCase; Rust fields use snake_case.

`docx::import_document(bytes: &[u8]) -> Result<Document, String>` and
`docx::export_document(document: &Document) -> Result<Vec<u8>, String>`.
Unsupported DOCX semantics must reject explicitly rather than silently disappear.

`layout::layout_document(document: &Document, selection: &Selection) -> Result<Layout, String>`;
`layout::hit_test(layout: &Layout, page: usize, x: f64, y: f64) -> Result<Position, String>`;
`layout::move_vertical(layout: &Layout, position: &Position, direction: i8) -> Result<Position, String>`.
`Layout` is serializable and cloneable. The engine never reconstructs layout in
JavaScript. Its exact wire schema is:

```ts
type Layout = {
  pages: { width: number; height: number; paths: { d: string; fill: string }[] }[];
  caret: { page: number; x: number; y: number; height: number } | null;
  selectionRects: { page: number; x: number; y: number; width: number; height: number }[];
};
```

All coordinates are absolute page-local points. `d` is an SVG glyph outline path
already shaped, scaled, positioned, and slanted by Rust; `fill` is `#RRGGBB`.
The UI draws paths in a page-sized SVG viewBox, selection rectangles behind paths,
and the caret above paths. It must not draw authoritative text with browser fonts.
Visual-line caret stops and UTF-16 grapheme offsets stay in Rust for hit testing
and vertical navigation. Soft-wrap boundary positions choose the following line
for caret display; paragraph-end positions choose the last line. A selection
spanning a paragraph separator includes a small end-of-paragraph rectangle.

Embedded font order is the requested DejaVu Sans face, Noto Sans CJK SC Regular
or Bold, then regular DejaVu and Noto Sans Symbols2 for monochrome emoji missing from a
styled face.
Chinese italic uses an explicit 12-degree outline slant; Latin italic uses a real
italic face. Tabs advance to the next default DOCX 36 pt stop measured from each visual
line’s text origin. Phase 1 supports LTR
Latin and East Asian text plus available monochrome emoji; unsupported scripts,
bidi controls, emoji variation/ZWJ sequences, and missing glyphs reject explicitly.
No browser or operating-system font fallback is used. Discretionary/common Latin
ligatures are disabled to retain one authoritative grapheme caret stop per cluster;
kerning and combining-mark shaping remain enabled.
