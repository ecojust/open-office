# Direct baseline offset compatibility

This corpus checks the bounded direct `w:position` implementation against complete,
unchanged LibreOffice packages. It does not establish general Word pagination or
cross-platform font equivalence.

Run `npm run test:browser:word-baseline-offset`. The runner creates its own Vite
port and Chromium context. `WORD_BASELINE_OFFSET_OUTPUT` chooses a fresh report
directory; `SOFFICE`, `PYTHON` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override local
executables. The independent geometry reader needs Python PyMuPDF and Pillow.

## Independent expectations

`inspect.py` reads ZIP/XML with Python's standard library, resolves explicit font
sizes and script inheritance, and calculates native integer percentages with exact
rational arithmetic and ties away from zero. Raw ±3 half-points at 12pt therefore
become ±13%, including the negative tie. Raw zero is ignored, rather than resetting
an inherited superscript. Direct nonzero position wins a same-run script in either
XML order. Marker positions are recorded as raw evidence but ignored on reopening.
The native files' expected character vectors and original file hashes are stored in
`manifest.json`; no native ZIP member has been rewritten to fit the application.

`geometry.py` independently reopens the pinned native PDF, identifies Cxxx/Xxxx
reference/target labels and measures their glyph origins. Its browser screenshot
check counts two red underline bands and one independent blue strike band in a
space-only column, and compares their movement to the glyph rectangle. The runner
records native/browser deviations. It checks direction, logical font size and
advance preservation, not exact glyph origin equality. Native metrics can differ
with font substitution and fallback glyphs, particularly CJK and emoji.

## Bounded behavior

The model stores integer percentages from -100 through 100; zero normalizes to
baseline. Direct visible positions need an explicit effective font size. Numeric
positions currently allow Times New Roman, DejaVu Sans or Liberation Serif, with
an absent or matching East Asian font when the run contains non-ASCII text.
ASCII, tab, newline and empty runs use their Western font; an unused differing
East Asian declaration is allowed. Nonzero positions in named styles or
`docDefaults`, other numeric fonts, and empty-run position/script combinations
remain unsupported. The runner includes atomic rejection checks for these limits.

Eight groups cover whole source/native imports and own/native saves; 18pt real
font-size edits and 1pt controller/codec quantization controls; native Enter and
marker behavior; measured glyph/decoration geometry; real position UI and UTF-16
selection/history; DOM metadata and CSS boundaries; actual clipboard/cut/plain
paste; malformed XML and failed-open atomicity. The 1pt control is deliberately not
called a toolbar interaction: 1pt is outside the toolbar's choices.

Native resizing retains the percentage within the live session but re-quantizes
on DOCX save. A 4% run at 18pt writes raw 1 and reopens at 3%. At 1pt it writes raw 0
and reopens with its inherited baseline/script. Native empty marker positions do
not survive reopening: applying 25% in an empty live paragraph and typing produces
positioned body text; saving it while empty and reopening first loses the offset.
The real `.uno:Escapement` whole-body control establishes a live marker, so typing
at the end and pressing Enter continues 25% in that session. A plain imported hard
body position can behave differently at End/Enter. These are separate assertions.

The full-body Backspace controls include both one-paragraph and multi-paragraph
imports. Deleting the body keeps its live numeric insertion format unless an
explicit baseline marker resets it; importing an
ignored numeric marker is not a reason to discard that format after deletion.
Empty export also must remain readable: numeric empty-run position is omitted,
while a named superscript marker survives and resumes its script after reopening.
These controls include actual native keyboard evidence and native resaves of the
application output, in addition to the independent XML oracle.

Successive typing is checked with separate x and y keyboard events, without a save
or focus change between them. After deleting a body with a superscript marker,
both characters retain 25% at 12pt; Enter then inserts baseline text at 12pt while
the independent saved marker remains superscript. Fresh import followed by End
is different: new x/y text uses that superscript marker. The explicit baseline
marker has a separate native Backspace/first-key reset control.

The 24pt/bold marker has an observed native limitation: repeated identical native
deletion probes produced both 12pt and 24pt insertion sizes. The application uses
a deterministic rule retaining the deleted body's 12pt size and the marker's bold
attribute. The unchanged native 12pt variant is included, but the suite does not
claim that all native runs select 12pt. Initial End, without deletion, uses 24pt.
Native autocorrect also capitalizes Xy on Enter; application keyboard expectations
preserve the supplied lowercase xy rather than introducing that separate feature.

The browser suite hashes its product inputs, runner/oracles and corpus before and
after execution, actually imports both sides of every positive pair, and records
external and same-origin Office-runtime requests, console errors and page errors.
The native packages are controls; synthetic malformed files are created only in
the output directory and never overwrite them.
