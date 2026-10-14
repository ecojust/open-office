# Native LibreOffice paragraph indentation corpus

`libreoffice/paragraph-indentation.docx` is an unmodified file written by native
LibreOffice from the project-authored ODT in `source/`. Every ZIP part is kept;
the generator does not strip or rewrite the DOCX to suit the independent codec.
The exact LibreOffice build, source/output hashes and expected text/indentation
are recorded in `manifest.json`. This corpus is separate from the original
four positive independent Word fixtures so their provenance remains stable.

The seven paragraphs cover plain text, inherited left/right indentation,
first-line indentation, hanging indentation, explicit zero overrides of a
nonzero inherited style, an indented heading with a different follow style,
and a final plain paragraph. Dimensions are points. In the editor model a
negative first-line value means hanging indentation.

LibreOffice repeats some named-style properties directly on the paragraph.
In particular, the native heading contains explicit indentation overrides;
an independent editor Enter test must retain those overrides. The browser
suite separately uses a clearly labeled synthetic inherited-only heading to
verify that a follow style can change the inherited indentation.

Regenerate with an installed native LibreOffice:

```sh
python3 tests/compatibility/independent-word-indentation/generate.py
```

Use `--output /tmp/word-indent-corpus` to compare another build without changing
the checked-in fixture. `generate.py` reuses the original corpus generator's
ODT writer, native conversion and package inventory functions. `inspect.py`
independently resolves paragraph style inheritance and reads OOXML twips;
it does not import any editor code.

Run the full application/native interoperability test:

```sh
node tests/browser/independent-word-indentation.cjs
```

The test starts its own Vite server and Chromium, edits through the actual UI,
downloads DOCX, resaves through native LibreOffice and reopens the result. It
also checks Enter, Backspace/Delete, undo/redo, explicit zero, unsupported
character-based/ambiguous attributes and atomic rejection. Reports and actual
saved documents are written to `test-results/independent-word-indentation/`.

This validates the supported continuous-view paragraph subset against one
native LibreOffice build. It does not claim Microsoft Word compatibility,
native LibreOffice keyboard parity, exact pagination or visual fidelity.
