# Ordinary text opacity fixture

`make-fixtures.py` creates one deterministic, self-authored 12-object PPTX from the existing small package shell. No product importer or exporter generates the expected values. Run with Python and lxml. `manifest.json` records the original SHA-256 and each object's expected run opacity and coordinates.

The objects cover direct 50%, 0% and opaque text; paragraph default inheritance; a direct opaque run overriding a half-transparent default; three runs at 100/50/0%; an ordered alpha chain; bold; underline; a scheme color; an end-paragraph-only override; and a body list default. Shape backgrounds and borders remain opaque throughout.

`native-observations.json` contains interior RGB histograms from the official desktop opening this original. The screenshot is retained under `test-results/text-opacity-native-baseline`. Direct and inherited alpha behave as expected. The reference renders the 80% × 50% + 10% chain near 80%, whereas ordered DrawingML math is 50%; its underline is darker than the half-transparent glyph. These are recorded differences, not parity claims.

The actual application UI test is `tests/browser/presentation-text-opacity-ui.cjs`. It imports this file, changes font size/text, changes opacity with undo/redo, changes the color of mixed-opacity runs, changes the opacity of one selected character, downloads/reopens real PPTX files, exports PDFs, and checks invalid drafts and a 390px viewport. Source files must remain unchanged.
