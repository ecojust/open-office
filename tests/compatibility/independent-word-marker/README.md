# Independent Word paragraph-marker corpus

This corpus distinguishes a paragraph's **marker format** (`w:pPr/w:rPr`) from
its visible text runs. Marker properties supply empty-paragraph insertion
formatting and can affect empty-line height. They must not become formatting for
all visible characters in the paragraph.

The 15 complete native files are **14 positive controls and 1 negative control**.
Every source is explicitly synthetic: `generate.py` uses the existing native
plain-text OPC container and authors controlled marker/body XML. It sets an
explicit black RGB default and disables automatic hyphenation to isolate marker
semantics from separately unsupported color/line-breaking settings. These are new controlled inputs, not edited copies of the research's
native outputs. After conversion, no native ZIP part or XML property is removed,
repaired or rewritten. SHA-256 digests and conversion logs are in `manifest.json`.

| Files | Expected behavior |
| --- | --- |
| `empty-rich-marker`, `empty-marker-super` | Marker stores bold/italic, 18pt, red, double underline/strike, highlight and separate RGB background, with an additional superscript control |
| `empty-style-rich-marker-clear` | Explicit marker clears win over inherited paragraph character attributes |
| `empty-marker-rich-run-clear`, `empty-marker-clear-run-rich` | Empty marker wins conflicting empty-run properties |
| `empty-marker-double-multiple-runs` | Conflicting empty runs do not override the double-underlined marker |
| `text-rich-marker`, `text-rich-marker-run-clear` | Rich marker remains separate from plain/explicitly cleared visible BODY |
| `text-rich-body-sparse-marker` | Sparse bold marker overrides insertion bold while preserving the tail body's 24pt, italic and blue attributes at End |
| `text-48pt-marker`, `empty-48pt-marker`, `text-48pt-marker-trailing-break` | Marker size affects an empty paragraph or trailing empty soft line, not a populated last line |
| `marker-character-style` | Explicit named marker character style remains distinct from direct marker overrides |
| `unsupported-marker-color` | Historical filename retained: the original red double-underlined empty marker is now a positive RGB-color control, with source and native bytes unchanged |
| `unsupported-marker-wave` | Unsupported pattern must reject without discarding marker data |

`inspect.py` independently reads ZIP/XML with Python standard libraries. It
resolves defaults and paragraph ancestry, reports visible characters separately
from marker direct/effective formatting, and uses the marker as the empty
paragraph insertion oracle. Positive expectations are derived from authored
input contracts before native conversion. Complete native XML inventories and
independent semantic inventories are retained under `inventory/`.

The oracle records `underlineColor` separately from text color, including latent
RGB on a `none` underline. Internal `auto` means following text color; product
exports omit `w:u/@w:color` for that value. Explicit OOXML `w:color="auto"` is
still rejected: this pinned native build turns it into white. Theme colors also
remain unsupported. Color inherits within paragraph/character `basedOn` chains;
a new direct or selected-character `w:u` without color uses the document-default
underline color, or follows text if the document default omits it.

## Regression

```sh
SOFFICE=/path/to/soffice node tests/browser/independent-word-marker.cjs
```

The suite owns and closes Vite, Chromium and temporary native conversion
profiles. It exercises actual file-open controls, toolbar actions, keyboard
input, Unicode insertion, downloads, complete native DOCX resave and reopening.
It preserves all source/native hashes and checks that product source hashes stay
unchanged during a run.

A separate long-term gate starts from the real product exporter, not synthetic
XML: 17 empty documents cover plain, bold, italic, size, color, double underline,
double strike, background, highlight, superscript, font name, combinations and
explicit clears against inherited formatting, inherited character-style script and
a direct baseline override of that script, distinct RGB underline/text colors,
and underline color following text. Their native round trips must
preserve insertion properties before real ASCII/CJK/emoji typing. This catches
the original failure in which formatting was written only on an empty run and
silently dropped by native Writer.

Other checks cover independent partial-body editing without marker pollution,
whole-body formatting that replaces unrelated imported marker attributes,
accumulates later whole-body edits in the same session, and treats a saved and
reopened marker as imported again,
paragraph-end typing and synthetic composition using explicit marker overrides
on the tail-body formatting,
empty toolbar formatting, deletion to empty and subsequent native reopening,
undo/redo, relative browser empty-line geometry, and atomic rejection of unknown
or malformed marker properties while preserving the active unsaved document.
Generated malformed packages live in test results, separate from this corpus.
They include malformed underline RGB, theme color, and explicit OOXML auto;
the formerly unsupported RGB corpus file also undergoes real empty-paragraph
Unicode typing and undo/redo.

At End followed by Enter, the product explicitly records the actual insertion
format in the new empty paragraph's marker and leaves the old marker unchanged.
The sparse-bold/24pt-italic-blue control verifies that this survives saving,
native resaving and reopening before typing. This deliberately repairs a native
Writer persistence defect: its same-session new empty run can retain 24pt while
its sparse marker does not, losing that empty-run format on reopening. Native
behavior is retained unchanged in the companion research evidence; this gate
does not claim to reproduce that loss.

To regenerate and review new native bytes in an isolated directory:

```sh
python3 tests/compatibility/independent-word-marker/generate.py \
  --soffice /path/to/soffice --output /tmp/marker-corpus
```

Regeneration compares all 14 source-derived semantic contracts to fresh,
unmodified native outputs. ZIP timestamps and native metadata can change the
new byte hashes; regeneration does not replace the checked-in originals.

## Native evidence and limits

Pinned native version: LibreOfficeDev 26.8.0.0.alpha0,
`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`. The companion research under
`open-office-research/libreoffice/paragraph-marker-compatibility` retains
synthetic inputs, unmodified native first/second DOCX outputs, ODT, and first/
resaved PDF evidence. Its original defaults are distinct from the explicit-RGB
controls here.

- [DomainMapper_Impl.cxx](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L2678) preserves paragraph-marker properties independently.
- [docxattributeoutput.cxx](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx) writes marker and text-run formatting separately.

These tests establish bounded semantics with one installed native build. They
do not establish Microsoft Word runtime compatibility, native pagination or
pixel fidelity, packaged desktop IPC, OS IME, or native Writer keystroke behavior.
Empty-marker superscript keeps its logical font size; relative browser geometry
is checked separately from XML persistence and does not claim identical native
line metrics.
