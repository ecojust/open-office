# Native LibreOffice DOCX reference corpus

These are real, unmodified DOCX files written by native LibreOffice from small,
project-authored ODT documents. They are not packages assembled to fit the new
codec. All relationships, settings, styles, fonts, themes and numbering parts
emitted by LibreOffice are retained.

`manifest.json` records the exact application version, conversion arguments,
source/output SHA-256 values, output sizes, expected paragraph text and selected
formatting expectations. The current reference is LibreOfficeDev
`26.8.0.0.alpha0`, commit `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.

| Fixture | Coverage |
| --- | --- |
| `libreoffice/plain-text.docx` | Plain text, four paragraphs, empty paragraph |
| `libreoffice/explicit-styles.docx` | Bold, italic, underline, color, size, alignment, spacing |
| `libreoffice/headings.docx` | Heading 1/2, inherited formatting, next style, keep-with-next |
| `libreoffice/unicode-breaks.docx` | Chinese, emoji, soft break, tab, significant spaces |
| `libreoffice/unsupported-table.docx` | Negative control: preserve the current document on unsupported-table rejection |

`source/` contains the original ODT files, readable content XML and shared styles
XML. The shared styles deliberately declare headings in every source, so even
the plain-text output contains unused heading styles and numbering definitions.
`inventory/` records every original package part, its hash/size, and XML
element/attribute paths. The DOCX theme and numbering parts were not stripped.

The negative control has a final empty body paragraph inserted by LibreOffice
after its table. Its expected top-level paragraph list includes that paragraph;
the table cell text remains in the actual table.

To regenerate all files with an installed native LibreOffice:

```sh
python3 tests/compatibility/independent-word/generate.py
```

This overwrites this corpus and updates the manifest. Use `--output /tmp/new-corpus`
to compare another build without changing the checked-in references. ODT source
ZIP timestamps are fixed; DOCX output metadata and environmental font/locale
defaults may differ between LibreOffice installations. Compare semantics as well
as provenance; cross-version output bytes are not expected to match.

The generator validates every output's exact top-level text using an independent
Python XML reader. Browser import/export and native LibreOffice reopening are
separate tests; generation alone does not claim the independent editor supports
all files or provides identical pagination. No Microsoft Office runtime has been
used for these fixtures.
