# Paragraph spacing with a rule but no numeric line value

This corpus contains six complete authored DOCX files and 30 unmodified native output files: first DOCX, ODT and PDF, followed by a second DOCX save and its PDF. It records 27 paragraphs produced by LibreOfficeDev 26.8.0.0.alpha0 at commit `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`. It uses no product parser to obtain native expectations.

## Verified contract

An otherwise valid `w:spacing` with `w:lineRule` but no `w:line` starts a fresh 240-twip value in a direct paragraph, named style or `docDefaults` declaration. The resulting effective values are exact 12 pt, minimum 12 pt or automatic 100%. This also applies when an inherited declaration specified 24 pt or automatic 200%; the inherited numeric line value is not reused.

A later line-only declaration inherits the effective rule: `360` becomes exact/minimum 18 pt, while automatic `277` imports as 116% and saves as raw `278`. A before/after-only declaration preserves line spacing. Paragraph margins are independent: rule-only preserves inherited margins, and explicit `after="0"` clears after only.

Controls cover direct format, child and parent styles, each document-default rule, reversed attribute order, `pStyle` following spacing and child style definitions before bases. The reverse-definition control has ordinary empty paragraph defaults; it does not establish every possible default-order combination. First and second native saves are stable in all six packages.

For the explicitly authored DejaVu Sans 12 pt text, two soft-line baselines are 12 pt apart for exact 12 pt, 14 pt for minimum 12 pt or automatic 100%, 18 pt for exact/minimum 18 pt, and 16.2 pt for automatic 116%. These are measured fixture results, not general font metrics.

## Files and independent verification

- `original/` retains complete authored inputs; `native/` retains all complete native outputs without sanitizing them.
- `manifest.json` provides portable fixture paths, per-artifact hashes, measured effective values and original direct/style provenance for the browser test.
- `expected.json` freezes native raw OOXML values and PDF baseline distances separately from product values.
- `resolved-native.json` records independently resolved native DOCX and ODT inheritance.
- `research-provenance.json` records the native version, original research seal hashes and corpus-relative artifact paths. `source-manifest.json` records six source URLs and SHA-256 hashes at the fixed commit; downloading those source files is optional.
- `native-report.json` retains full native XML, measured text origins, authored case descriptions and historical native conversion commands. Historical paths are replaced with `.` and `soffice` for portability. Its legacy `odt` field is a naive merged property inventory; effective line spacing comes from `resolved-native.json`, which clears conflicting inherited ODT line-height alternatives.
- `inspect_docx.py` independently resolves original direct/style/default values and preserves their raw spacing attributes. `validate_native.py` independently reads native OOXML/ODT and opens the actual PDFs, verifies full ZIP/XML packages and hashes, and compares first/second save results.

From the repository root, with Python and PyMuPDF available:

```sh
python tests/compatibility/independent-word-line-rule/validate_native.py
```

No original research directory, live Office runtime, network or product build is required for this frozen-artifact check. `inventory.json` seals the corpus and checker; `verification.json` records the check result. Re-running native conversions should use a separate directory to preserve these reference bytes.

## Source anchors and scope

- [`DomainMapper_Impl.cxx`, `SetLineSpacing`, lines 5303–5378](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L5303) initializes a missing current line item as FIX with `convertTwipToMm100(240)`, then applies the rule.
- [`DomainMapper.cxx`, lines 2734–2753](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2734) uses inherited-rule finalization when line exists but lineRule does not.
- [`ww8atr.cxx`, lines 5230–5281](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/ww8atr.cxx#L5230) and [`docxattributeoutput.cxx`, lines 9323–9345](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L9323) export explicit numeric values and rules.

Invalid rule tokens, duplicate spacing elements, unsupported attributes, malformed XML and invalid explicit line values remain outside the accepted input contract. This adds no numeric ranges, pagination capability or new native Enter behavior. Product Enter/history checks reuse the previously verified paragraph split contract. No Microsoft Word runtime was used; PDF checks cover same-page soft-line baselines, not browser/native pagination equality.
