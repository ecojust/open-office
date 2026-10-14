# Character case corpus

`manifest.json` records complete source/native packages, immutable SHA-256 values, and independently specified raw-text/case expectations. `inspect.py` uses only Python ZIP/XML libraries; it never imports the product codec or model. `research-provenance.json` records the pinned LibreOffice build, native experiment reports and inspected upstream C++ source hashes.

The nine positive controls cover the following distinct sources:

- Authored DOCX inputs and complete native DOCX exports: 34 direct/style/marker cases, the 16-case paragraph/character style matrix, explicit versus implicit default character styles, and document defaults.
- Independently authored ODT with uppercase, small caps, inherited formatting, explicit reset, CJK/emoji and an empty paragraph. Its native DOCX export is tested through the product; the ODT source itself is outside this DOCX importer.
- Four real native editing controls: named character and explicit default character modes equal to the paragraph mode, the no-character-style next-paragraph control, and typing into an empty character-style marker. Native XToolkitRobot sends Enter and `x`, or only `x` for the empty paragraph. The browser repeats those actions from the same source input.

Native Writer resolves a style's `basedOn` chain by ordinary override. When an explicit named character style has the same non-`none` case mode as the paragraph/default mode, their combination toggles to `none`; a different character mode overrides it. Direct run/marker properties take precedence. The recorded 3×3 matrix and native serialized resets establish these expectations independently of the product.

Two complete inputs remain expected rejections: a native locale/Unicode output beyond the supported display subset, and the authored source containing order-sensitive `caps` plus `smallCaps=true`. No native package was stripped or rewritten to make it pass.

Run the regression with:

```sh
node tests/browser/independent-word-case.cjs
```

The suite imports every positive DOCX source **and** native output through the real browser editor, downloads it, resaves it using the installed native LibreOffice, then reopens the result. Python checks original characters, effective formatting and selected independent markers at each stage. It also tests real toolbar selections/history, actual system copy/cut/paste, UTF-16 range boundaries, raw Unicode retention, DOM metadata/CSS recovery, and atomic malformed/unsupported input rejection. Product, test and fixture hashes must remain stable; external requests, Office-runtime requests, iframes and browser errors must remain zero.

The small-cap visual control uses the installed DejaVu Sans font. FontTools confirms that its GSUB table has no `smcp` feature, and the report records its file hash. Actual browser glyph widths must distinguish synthesized small caps from ordinary lowercase and full uppercase under the application's global `font-synthesis: none`. A control with synthesis disabled must reproduce ordinary lowercase. Real copied HTML must retain the inline synthesis setting and the same measured rendering. Two screenshots retain the editor and menu appearance; these checks test visible fallback, not only declared CSS properties. The runner requires `fc-match` and Python FontTools for this control.

Active uppercase/small caps are intentionally restricted to ASCII case mappings and uncased Unicode such as CJK/emoji. Non-ASCII cased characters and combining marks are rejected, with variation selectors allowed; ASCII letters with primary language `tr`, `az`, `el`, `lt` or `ga` are also rejected. Ordinary text retains the existing Unicode support. These checks do not claim exact glyph metrics, font-provided small caps, native pagination, Microsoft Word runtime compatibility, operating-system IME coverage or real Tauri IPC. The separate Rust suite exercises package transport through its CLI and the same TypeScript codec.
