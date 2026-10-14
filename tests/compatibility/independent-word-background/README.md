# Independent Word character background corpus

This corpus tests **solid character RGB background as a separate property from
standard-palette highlighting**. Native LibreOffice DOCX outputs retain every ZIP
part and XML property, with no stripping or rewriting. Input expectations are
authored before conversion, and `inspect.py` independently resolves the OOXML
with Python XML/ZIP libraries. It also records paragraph-mark properties rather
than silently treating them as ordinary text formatting.

| Fixture | Input provenance | Expected editor behavior |
| --- | --- | --- |
| `libreoffice/inline-background.docx` | Original `source/inline-background.odt` | Positive: RGB applied to a middle text selection, unchanged surrounding text, transparent reset, named character/paragraph inheritance and script/strike/underline combination |
| `libreoffice/inheritance.docx` | Explicitly synthetic `source/inheritance.docx`, authored in a native template and then natively resaved | Positive: paragraph, named and based-on character background, direct RGB, explicit no-background and opaque black/white |
| `libreoffice/combined-layers.docx` | Explicitly synthetic `source/combined-layers.docx`, authored in a native template and then natively resaved | Positive: independent highlight and RGB background, including explicit clears and a combined CJK/emoji/script/strike/underline run |
| `libreoffice/background.docx` | Original `source/background.odt` | Positive: full-paragraph formatting preserves **independent paragraph-marker properties** at `w:pPr/w:rPr` separately from body runs |

The original full-paragraph ODT and its native DOCX remain intact. Its two
paragraph markers carry background alone and a combination of font size,
background, script, strike and underline. The regression verifies both markers
independently from body text, clears only a partial text selection's background through the UI, and
checks marker retention through native DOCX resave and reopening. The separate
inline ODT describes formatting only a text selection while the
sentence ends in unformatted text. It was authored and converted once; its
native output contains no independent paragraph-mark formatting.

`generate.py` creates the original ODT/control and combined-layer source.
`generate_supplemental.py` adds the separately authored inline ODT and controlled
inheritance cases while retaining the original native control and combined file.
Their `expectedSemantics.characters` arrays are defined from those authored input
contracts, not from application output. `expectedParagraphMarkers` records the
independently inventoried direct properties of the untouched native markers.
Full package/XML inventories and independently resolved character/paragraph-mark
inventories are retained.

The pinned native version is LibreOfficeDev `26.8.0.0.alpha0`, commit
`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`. Exact source/native SHA-256 values,
source kinds, conversion commands and expected semantics are in `manifest.json`.

## Supported semantic boundary

Character shading is `w:shd` with `val="clear"` and an explicit six-digit RGB
`fill` or `fill="auto"`. RGB normalizes to `#RRGGBB`; `auto` explicitly cancels
background. Opaque white is distinct from no background. A clear brush's optional
`color` is validated but does not change the fill.

Paragraph-style character shading and named character-style inheritance apply.
Implicit default-character background does not apply; an explicit reference to
that same style does. Direct paragraph-marker shading is a separate supported
property. Document-default shading, paragraph-box shading, patterns, themes, `nil`, missing fill,
malformed colors and unsupported attributes remain rejected.

Highlight has visual precedence, while both model properties persist. Clearing
highlight reveals the underlying RGB; clearing RGB leaves the highlight.
ODT cannot be the sole oracle for a combined-layer DOCX: Writer's ODT route can
collapse the two properties. Combined-layer comparisons therefore use direct
native DOCX resave and independent XML semantics.

The corresponding native research covered 65 controlled cases and 275
assertions, including native PDF paint evidence and explicit default-character
references. The first-load/native-resave discrepancy for document-default
background is why that layer is outside the accepted scope.

## Regression

```sh
SOFFICE=/path/to/soffice node tests/browser/independent-word-background.cjs
SOFFICE=/path/to/soffice node tests/browser/independent-word-highlight.cjs
```

The background suite owns and closes its Vite server, Chromium and temporary
native profiles. It checks actual toolbar draft/apply/cancel/reset, mixed
selection, history, ordinary typing and `insertText`, whole-selection replacement
and deletion, empty insertion formatting, soft/hard breaks, opposing-background
paragraph merges, two real downloads, complete native DOCX resave, and reopening.
Native and deliberately empty `getTargetRanges` paths cover final ASCII, emoji,
ZWJ and combining-grapheme deletion in both directions. Logical 18pt and hidden
RGB are asserted along with script, strike, underline and highlighting.

DOM mutation tests distinguish semantic metadata from paint: CSS-only colors,
including palette yellow, become RGB background; copying the current paint
preserves both properties; a conflicting CSS paint beneath an active highlight
is rejected. Empty/nested script/strike/glyph wrappers and trailing soft-break
placeholders are covered. Malformed inputs are explicitly synthetic files under
`test-results`, separate from complete native fixtures. Native/input digests and
product source digests must remain stable throughout each run.

Regenerate in a separate directory to review new native files and hashes:

```sh
python3 tests/compatibility/independent-word-background/generate.py --soffice /path/to/soffice --output /tmp/background-corpus
python3 tests/compatibility/independent-word-background/generate_supplemental.py --soffice /path/to/soffice --output /tmp/background-corpus
```

## Pinned source references and limits

- [DomainMapper.cxx L2509](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2509): character shading import applies to styles as well as direct runs.
- [CellColorHandler.cxx L110](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/CellColorHandler.cxx#L110) and [L294](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/CellColorHandler.cxx#L294): explicit fill/auto and character background assignment; omitted fields are not equivalent to clear/auto.
- [DocxAttributeOutput::CharBackground L8522](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8522): character background exports separately as shading.
- [SwTextPaintInfo::DrawBackBrush L1337](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/text/inftxt.cxx#L1337): nontransparent highlight takes precedence over background.
- [ndtxt.cxx L3110](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L3110) and [L761](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L761): successor character attributes and direct script reset; background is not in that reset set.
- [DomainMapper_Impl.cxx L2697](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L2697): paragraph-marker formatting can affect paragraph geometry independently of visible text.

This is bounded semantic compatibility with one installed LibreOffice build.
It does not establish Microsoft Word runtime compatibility, native pagination or
pixel fidelity, packaged Tauri dialogs, or OS IME behavior. Enter expectations
are source-based; all test keystrokes run in Chromium, not native Writer.
