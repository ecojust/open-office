# Independent output inspector

`inspect-output.py` reads file structure independently of the application and its LibreOffice/WASM runtime. It does not open Microsoft Office, run macros, fetch linked content, calculate formulas, or decide that two documents are visually identical.

```sh
pdf-backend/.venv/bin/python tests/compatibility/inspect-output.py output.docx
pdf-backend/.venv/bin/python tests/compatibility/inspect-output.py output.pdf --preview-dir /tmp/pdf-previews
pdf-backend/.venv/bin/python -m unittest discover -s tests/compatibility -p 'test_*.py'
```

The existing PDF backend virtual environment supplies PyMuPDF. A standard Python 3.12 interpreter is sufficient for the office formats. No additional dependencies are installed by this script. The only writes are optional PDF preview images; existing preview filenames are never overwritten.

## Result contract

The CLI writes one JSON object to stdout. Exit codes are `0` for structurally parsed input, `1` for rejected/failed inspection, and `2` for unsupported content. `schemaVersion` is `1`.

Common fields are `format`, `inspection`, `ok`, `file` (name, byte count, SHA-256), `zipSafety`, `limits`, `warnings`, `errors`, `features`, and `coreText.strings`. `ok: true` means that the supported structural parser completed; **it does not mean a round trip preserved the source**. The comparison runner must also evaluate its source assertions, warnings, unsupported feature boundaries, and structural differences.

| Content | Independent evidence |
| --- | --- |
| DOCX | Current and deleted paragraph text, paragraph/run properties, table cells and merges, styles, sections/page properties, linked headers/footers, comments, notes, fields and tracked-change nodes. |
| XLSX | Workbook sheet order/names/visibility; cell addresses, types, formula strings and cached values; merges, frozen panes, validations, defined names, conditional rules; linked chart sources and series caches. |
| PPTX | Relationship-defined slide order, hidden state, slide text, speaker notes, tables, linked charts, media sizes/SHA-256, raw transitions and recognized animation nodes. Unknown effects are not claimed playable. |
| ODT/ODS/ODP | Content/style XML, text including tabs/spaces, tables/repeated cells, formulas and stored values, notes/changes, slide notes, objects and embedded chart sources/cached tables. ODF formula syntax and object properties remain explicit instead of being silently rewritten to OOXML. |
| RTF | Group/control parser with ANSI code pages, hex escapes, Unicode, visible text, header/footer/note/field destinations and object/control counts. Table layout, nested field semantics, complete styles and tracked ranges remain partial and produce a warning. |
| PDF | PyMuPDF page count, dimensions, rotation, actual extracted text, images, annotations and outline; optional first six previews capped at 1,400 pixels on the longest side. Password/copy restrictions are respected. |
| Legacy DOC/XLS/PPT | OLE container detection only. The result is explicitly `unsupported`, with `contentParsed: false`; the filename extension cannot prove the binary subtype or successful preservation. |

`spreadsheet.sheets[].cells` contains `{address, type, value, formula, ...}`. Numeric cached values remain numbers and literal text such as `00123` remains a string. A formula cell has `type: "formula"`. Shared formulas are reported with their OOXML attributes but not expanded or evaluated.

`package.charts`, `spreadsheet.sheets[].charts`, and `presentation.slides[].charts` expose OOXML chart types, series, source formulas and indexed cached values. Each series data item contains `formula`, `values: [{index, value}]`, `literal`, `formatCode`, and `pointCounts`. Values are the original chart XML strings. The owning worksheet is resolved through its drawing relationships; an unrelated chart part does not establish a chart on that sheet. Embedded workbook relations include their actual byte digest. ODF uses `odf.charts` and linked sheet/slide arrays with `chartClass`, `plotRange`, `categoryRanges`, `series`, and `cachedTables`.

Conditional formatting retains rule type/operator/formulas and the rule XML, not just a count. The comparator must account for meaningful representation changes such as a chart name changing on export; it must not replace editable-chart checks with image counts. A chart series cache by itself does not prove that its external source is available.

## Safety and known limits

- Input is limited to 128 MiB, 6,000 ZIP entries and 256 MiB actual aggregate expansion. Every ZIP entry is streamed and checked for CRC, declared length and SHA-256. Duplicate/case-colliding paths, path traversal, ZIP symlinks, encrypted entries and unsupported compression are rejected. Entries are never extracted to disk.
- XML is bounded to 24 MiB per part, 500,000 nodes and depth 128. DTD/entity declarations are rejected, including UTF-16 encodings. Core and auxiliary XML is validated. One explicit exception permits the standard zero-byte optional LibreOffice `Configurations2/accelerator/current.xml` slot; nonempty malformed configuration and empty core XML are still rejected.
- Output is limited to 30,000 reported cells, 20,000 text strings, two million text characters, 5,000 objects per bounded collection and 24 MiB of JSON. Repeated empty ODF rows are handled symbolically. Exceeding a reporting limit produces a rejected/incomplete report, never a successful truncated comparison.
- Internal media relationships are resolved within the package only. External links are reported without downloading them. Missing referenced parts produce explicit warnings. Strict OOXML namespaces and encrypted ODF packages are not silently treated as ordinary supported documents.
- This is structural evidence, not full format conformance validation. It does not verify pagination, fonts, rendering, VBA, signatures, accessibility, unknown extensions, every animation, or Microsoft 365 interoperability. Formula caches can be stale. RTF structure is partial; legacy OLE content remains unparsed. Fixture provenance must distinguish generated examples from independently sourced documents.

The tests create real ZIP/XML/RTF/PDF inputs and cover malicious ZIP/XML, resource limits, CLI exit codes, OLE rejection boundaries, formula/literal types, merges, charts/conditional rules, ordered slides/media hashes, ODP notes, PDF permissions, and bounded previews. They do not replace the browser/native round-trip suite.
