# Independent Word: ordinary single and double underline

Reference application: **LibreOfficeDev 26.8.0.0.alpha0**,
commit `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.

The corpus contains three supported fixtures and one negative control. Every
`libreoffice/*.docx` is a complete native conversion output. No ZIP part, XML
property, or paragraph marker was removed or rewritten after conversion.

| Fixture | Source provenance | Contract |
| --- | --- | --- |
| `inline-underline` | Original authored ODT, converted by native LibreOffice | Eight paragraphs: single/double/none, nested explicit clearing, mixed selection, Chinese/emoji, both scripts, single/double strike and RGB character background. |
| `inheritance` | Explicitly synthetic DOCX authored in the native inline fixture's package, then opened/resaved by native LibreOffice | Thirteen paragraphs: implicit default character underline ignored, explicit reference applied, paragraph/named/basedOn inheritance, direct single/none overrides, plus double underline with independent strike, script, highlight and background. |
| `unsupported-wave` | Original authored ODT, converted by native LibreOffice | Wavy underline remains outside the ordinary underline subset and must reject atomically. |
| `unsupported-color` | Original authored ODT, converted by native LibreOffice | Independently red double underline is now supported; its RGB remains separate from the text color. The historical filename and all original package bytes are retained. |

All ODT inline selections end before an unchanged tail. This is a legitimate
authored document boundary: it avoids mixing the tested character feature with
the separately unsupported paragraph-marker character properties. It does not
strip a native output or turn a marker-bearing document into a supported one.

`source/` retains the ODT XML and input packages. `manifest.json` records the
reference version, source kinds, exact conversion commands, SHA-256 checksums,
and independently authored expected character semantics. `inventory/` records
the complete native part/property inventory and the supported fixtures'
resolved semantics.

`inspect.py` uses Python's standard XML and ZIP libraries, never application
code. It resolves paragraph and explicitly named character style ancestry,
run properties, and the distinct underline values `false`, `true`, and
`"double"`. It keeps highlight/background and underline/strike independent,
and verifies explicit RGB underline colors separately from text color.
Unknown underline patterns fail instead of being treated as enabled underline.
Explicit OOXML `w:u/@w:color="auto"` remains outside the supported input
subset: this LibreOffice build paints it white. The application value `auto`
means follow text color and exports by omitting the XML color attribute.
The focused `independent-word-underline-color` corpus covers color inheritance,
markers and actual painted color boundaries.

Regenerate only when deliberately updating the native reference evidence:

```bash
python3 tests/compatibility/independent-word-underline/generate.py --soffice /path/to/soffice
```

Run the independent browser/native roundtrip regression:

```bash
SOFFICE=/path/to/soffice node tests/browser/independent-word-underline.cjs
```

The browser script starts and closes its own Vite server. Its output is
`test-results/independent-word-underline/`, overridable through
`WORD_UNDERLINE_OUTPUT`. The report records product hashes before and after the
run, fixture hashes, real UI downloads, untouched native resaves, screenshots,
and all page/console/external-runtime request errors. It fails if product
sources change during verification. Testing covers menu styles and keyboard
navigation, mixed formatting, history, real text input, empty runs, structural
editing, DOM wrappers and atomic negative imports.

The contract was cross-checked against the pinned LibreOffice importer and
exporter and a separate 46-case, 259-assertion native investigation. In
particular, native PDF paint confirms one/two/zero underline lines, independent
strike lines, and the difference between an implicit default character style
and an explicit `rStyle` reference:

- [DomainMapper.cxx L5032](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L5032)
  maps underline enum values; word-only underline has additional semantics.
- [docxattributeoutput.cxx L8438](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8438)
  exports underline line style and optional independent color/theme properties.
- [swfont.cxx L591](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/swfont.cxx#L591)
  keeps underline and strikeout separate.
- [ndtxt.cxx L761](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L761)
  resets direct escapement for a newly empty successor paragraph while leaving
  ordinary underline attributes intact.

This demonstrates bounded semantic compatibility with one LibreOffice build.
It does not establish Microsoft Word runtime compatibility, native pagination
or pixel fidelity, packaged desktop dialogs/IPC, or OS IME behavior. Enter
expectations are derived from pinned source; browser keystrokes are performed
in Chromium, not in a native Writer window.
