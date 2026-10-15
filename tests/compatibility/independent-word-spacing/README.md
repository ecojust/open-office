# Character spacing corpus

`manifest.json` records immutable input/output SHA-256 values and independently specified expectations. `inspect.py` resolves OOXML with Python's ZIP/XML libraries; it does not call the product model or codec.

The corpus distinguishes three sources:

- Independently authored ODF, serialized by native LibreOffice to ODT and then DOCX. The original minimal ODF also enables native CJK layout defaults outside the editor's current subset; its complete DOCX remains an expected rejection control.
- A deliberately synthetic DOCX containing every integer character-spacing value from −400 through 400 twips. Its complete native DOCX export must retain all 801 values exactly.
- Deliberately synthetic style-inheritance inputs edited using real LibreOffice XToolkitRobot Enter and `X` keystrokes. Their complete native DOCX outputs establish the expected difference between an explicitly referenced character style and inherited paragraph formatting when the next paragraph changes style.

The positive editing controls explicitly disable automatic hyphenation and set a black font color in their authored inputs. The earlier control set enabling automatic hyphenation remains an expected rejection. Four earlier native controls introducing automatic foreground color are now accepted by the automatic-color iteration; their original source/native bytes and hashes remain unchanged, and the previous rejection is retained as history in the manifest. An input that the editor can open is not sufficient evidence that it can open the resulting native output. The browser suite opens and downloads every positive native control output before testing Enter from its corresponding input.

No exported native package is stripped, normalized or rewritten. Source authoring may restrict unrelated layout settings to the editor's supported subset; the source and every native result are retained separately. The manifest links the pinned research reports and hashes that establish provenance.

Run the browser/native regression with:

```sh
node tests/browser/independent-word-spacing.cjs
```

The suite uses an isolated Vite server, Chromium, real editor controls/downloads and native LibreOffice resaves. It covers signed spacing, explicit zero, style inheritance, independent paragraph markers, typing, history, Enter, DOM metadata/CSS recovery and strict malformed-input rejection. It records source/test/fixture hashes and asserts zero external or Office-runtime requests. It does not establish Microsoft Word interoperability, exact native pagination, shaping or pixel equivalence, operating-system IME behavior, or actual Tauri IPC.
