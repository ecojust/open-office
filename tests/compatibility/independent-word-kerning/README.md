# Character kerning corpus

`manifest.json` preserves complete authored DOCX inputs and native LibreOffice outputs, with a SHA-256 for every package. `inspect.py` resolves their raw XML independently using Python ZIP/XML libraries, without calling the application. Native research reports and their hashes are recorded in `research-provenance.json`.

The first fixture has twelve paragraphs: font sizes 12 and 8 points, each with raw `w:kern` values 0, 1, 2, 24, 28 and 800. Native PDF widths establish that zero disables kerning and every positive value enables it, including values larger than the font size. Raw 1 means 0.5 points and is supported. Native saving normalizes enabled kerning to raw 2. The application preserves the original raw value until an explicit UI change; tests distinguish that preservation from the native boolean behavior.

Six additional fixtures use real native XToolkitRobot Enter and `x` keystrokes. They cover an explicitly named or default character style equal to the paragraph's positive value, explicit zero equal to the paragraph value, a paragraph-only control that follows the next style, and two empty paragraph markers. The source inputs and complete native outputs remain separate and unmodified.

Run the regression with:

```sh
node tests/browser/independent-word-kerning.cjs
```

The suite uses an isolated Vite server, real Chromium editor controls/downloads, an independent Python inspector, and native LibreOffice resaves. Every source and native output is actually imported by the product. It verifies raw and effective semantics separately, repeats the native Enter actions, checks independent spacing/kerning UI drafts and single-transaction undo, explicit resets, Unicode selection, marker typing, DOM provenance, CSS recovery and atomic rejection. Horizontal character scaling remains unsupported.

The visual control uses installed Liberation Serif, whose `AV` pair is verified with FontTools and whose file hash is recorded. Actual browser glyph widths must distinguish disabled kerning from every positive value at both font sizes; raw text must remain unchanged. These measurements establish that kerning is rendered, without claiming identical native glyph metrics, pagination or shaping. The runner requires `fc-match` and Python FontTools.

Source, test and fixture hashes must remain stable during the run. The report asserts no external requests, Office-runtime requests, iframes or browser errors. Microsoft Word runtime compatibility, operating-system IME behavior and actual Tauri IPC remain outside this suite; the separate Rust regression exercises CLI package transport and the same TypeScript codec.
