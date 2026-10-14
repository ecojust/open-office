# Independent underline colors

This corpus retains complete authored DOCX inputs and complete native
LibreOffice outputs, with separate SHA-256 hashes in `manifest.json`. No native
package has been stripped or rewritten. The reference is LibreOfficeDev
26.8.0.0.alpha0, commit `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.
`research-provenance.json` identifies the independent native reports, source
contracts and actual product-import verification used to select these files.

The ten positive pairs contain 23 static paragraphs and six real native
keyboard controls. Static paragraphs distinguish single, double and disabled
underline; explicit RGB and follow-text color; document defaults; implicit and
explicit default character styles; named/paragraph/basedOn inheritance; and
independent body and paragraph-marker properties. Native Enter controls cover
named/default character styles equal to the paragraph, a mode-only character
style, the paragraph-only next-style control, and two empty markers. An extra
native dispatch control selects the entire double-red body without its paragraph
separator, changes only color to blue, then saves/reopens before Enter. The
body's double-blue pair must replace the old single-green marker and continue
in the new paragraph, independently of the paragraph's default no-underline.

The native contract treats underline mode and color as one item. A mode-only
item inside a basedOn chain retains the base color. A new explicitly selected
character-style item or a direct mode-only item uses the document-default
underline color, or follows text when no default color exists. An absent item
inherits the previous scope unchanged. Disabled underline retains its latent
RGB, so re-enabling the line restores that color. `inspect.py` implements these
rules independently with Python ZIP/XML libraries; it never imports product
code. Each character's expected line, underline color, text color and strike
are distinct fields.

The model/UI value `auto` means **follow text color**, and serializes by omitting
`w:u/@w:color`. Explicit OOXML `w:color="auto"` remains unsupported because this
native LibreOffice build paints it white. The original research package with
that encoding and missing `w:u/@w:val` is retained as a whole-package negative
control. Malformed RGB, themes, tints, shades and unsupported line patterns
remain rejected. The old `independent-word-underline` corpus retains its
historically named `unsupported-color.docx` unchanged and now verifies it as
a positive RGB document.

Run:

```sh
WORD_UNDERLINE_COLOR_OUTPUT=test-results/independent-word-underline-color \
  node tests/browser/independent-word-underline-color.cjs
```

The runner uses an isolated Vite server, real Chromium editor controls and
downloads, actual LibreOffice resaves, and independent Python inspection.
Every chosen source and native output is imported through the product. It
checks UI mixed/untouched colors, explicit follow-text reset, independent
line-style/color drafts, cancel/stale selection, one-step undo/redo, UTF-16
selection, empty markers, actual rich clipboard copy/cut and plain-text paste,
DOM metadata/CSS recovery,
and atomic failed imports. CSS-only currentColor controls use explicit RGB
foregrounds; named foreground colors remain outside the existing input subset.
The shorthand control also verifies its CSSOM initial line style resolves to
a solid underline rather than being rejected as an unsupported pattern. Clipboard
HTML preserves separate decoration colors; the existing plain-text paste flow
retains target insertion formatting and does not claim rich-HTML paste support.
Applying color to mixed line modes preserves each run's existing mode as an
application contract. Native Writer's color control is disabled for that mixed
selection, so this behavior is not claimed as a native UI equivalence.

`pixels.py` uses Pillow to inspect actual screenshot pixels at columns inside
spaces between glyphs. Colored row bands establish the count and placement of
red/green underlines independently of blue strike-through, including single,
double, follow-text, superscript and subscript. This catches incorrect paint
inheritance that computed CSS alone cannot establish. Original text remains
unchanged. The screenshots and measurements do not claim identical native
glyph geometry, shaping or pagination.

Product, test and package hashes must remain stable throughout the run; the
report asserts zero external requests, Office-runtime requests, iframes and
browser errors. Microsoft Word runtime compatibility, system IME, and real
Tauri IPC are outside this suite. The separate Rust runner covers CLI package
transport using the same TypeScript codec and native corpus.
