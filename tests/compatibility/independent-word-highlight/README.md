# Independent Word highlight corpus

The positive fixture `libreoffice/highlight.docx` is a **complete native
LibreOffice open/save output from an explicitly synthetic DOCX input**. It is not
presented as an ODT-authored highlight document. Native outputs retain every ZIP
part and XML property without postprocessing.

The source chain is preserved:

1. Project-authored `source/highlight-template.odt`, its content XML and styles.
2. Complete native conversion `source/native-highlight-template.docx`.
3. `source/highlight.docx`, an explicitly synthetic OOXML input authored in that
   template. Its document body and added paragraph/character styles define the
   intended highlight cases before native conversion.
4. Complete native open/save output `libreoffice/highlight.docx`.

The 22-paragraph positive fixture covers all 17 standard highlight values,
paragraph inheritance, direct `none` resets, ignored character-style highlights,
Chinese/emoji, and combined highlighting, superscript, double strike and
underline. `expectedSemantics.characters` is authored in the generator from this
input contract, not inferred from native or application output. `inspect.py`
independently resolves the OOXML using Python XML/ZIP libraries and verifies
native conversion against that contract. Full package/XML inventories and a
resolved semantic inventory are retained.

`source/unsupported-background.odt` is a separately authored ODT character
background example. Its complete native `libreoffice/unsupported-background.docx`
contains both ordinary `w:r/w:rPr/w:shd` and independent paragraph-mark
`w:pPr/w:rPr/w:shd`. Both are positive controls represented independently; the
historical filename, bytes and SHA-256 remain unchanged. The browser suite uses
the background corpus's independent Python inspector to verify both layers,
clears only a partial text selection's background through the UI, and checks that the yellow
marker survives native DOCX resave and reopening. Direct marker expectations
are recorded separately in `expectedParagraphMarkers`.
Separately synthetic patterned shading on body runs and paragraph markers
remains unsupported and is tested atomically. An ODT roundtrip cannot serve as the sole reference for highlight
reset: the controlled native probe found that an explicit DOCX `highlight=none`
can lose its reset in ODT.

`manifest.json` records the exact LibreOffice build, input/output SHA-256 digests,
source kinds, expected semantics and conversion commands. This corpus uses
LibreOfficeDev `26.8.0.0.alpha0` at
`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.

Regenerate (review changed native files and hashes):

```sh
python3 tests/compatibility/independent-word-highlight/generate.py --soffice /path/to/soffice
```

Run real UI and native conversion regression:

```sh
SOFFICE=/path/to/soffice node tests/browser/independent-word-highlight.cjs
```

The suite owns and closes its Vite, Chromium and temporary native profiles. It
checks actual toolbar choices, keyboard input, DOM wrappers, undo/redo,
structural edits, downloads, native DOCX resave and reopening. Product source
hashes (including the shared palette/background modules) and both original native fixture
hashes must remain stable throughout validation. Synthetic malformed cases stay
separate under `test-results`. DOM mutation checks retain explicit highlight
metadata; CSS-only background colors are tested as the independent RGB
background layer in the background suite.

This is semantic compatibility with one installed LibreOffice version. It does
not establish Microsoft Word runtime compatibility, exact native rendering or
pagination, packaged Tauri file dialogs, or operating-system IME behavior.

## Pinned reference behavior

- [`DomainMapper.cxx`, L2208](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2208): standard highlights map into character highlight; character-style highlight is ignored. Paragraph/default/direct highlighting and explicit none are distinct.
- [`docxattributeoutput.cxx`, L8522](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8522): ordinary character background exports as shading.
- [`docxattributeoutput.cxx`, L8726](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8726): highlight has its own standard-palette exporter.

Character-style highlight ignoring follows Writer's behavior. It is not a claim
that all Office consumers interpret arbitrary style chains identically.
