# Independent Word character-format corpus

The fixture is an original ODT authored for this project, converted by native
LibreOffice `26.8.0.0.alpha0` at commit
`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`. The complete resulting DOCX is retained
without rewriting XML, stripping ZIP entries, or adapting it to the editor.
`manifest.json` records source and DOCX SHA-256 digests and the conversion command.

Five paragraphs exercise standard automatic superscript and subscript, baseline
resets, single/double strike and explicit none, named character and paragraph
inheritance, underline combined with double strike, Chinese/emoji, and logical
9/12/16/18/24-point font sizes. `expectedSemantics.characters` is authored from the
ODT source contract before conversion; it is not derived from editor output.
The independent Python inspector resolves DOCX run style inheritance and verifies
that native conversion matches that initial contract. The XML/package inventory
and resolved character inventory are both retained.

Generate with an installed native LibreOffice (the command replaces this corpus,
so review changed native output and digests):

```sh
python3 tests/compatibility/independent-word-character-format/generate.py --soffice /path/to/soffice
```

Run the application regression, which starts and stops its own Vite/Chromium and
isolates each native conversion in a temporary LibreOffice profile:

```sh
SOFFICE=/path/to/soffice node tests/browser/independent-word-character-format.cjs
```

The regression uses actual toolbar actions, ASCII keyboard input, Unicode
insertion, DOCX downloads, native LibreOffice resave and application reopen.
Every supported character property is compared independently of the TypeScript
codec, with a native resave control for LibreOffice's own normalization. It checks
logical font size separately from CSS script scaling, structural edits, history,
malformed-file rejection and that product/fixture hashes did not change during
the run. Synthetic minimal and malformed files are separately labeled and stored
under `test-results`, never substituted for the native fixture.

This covers one installed LibreOffice version and Chromium. It does not assert
Microsoft Word runtime compatibility, exact native pagination or rendering,
packaged Tauri file dialogs, or operating-system IME behavior. Enter expectations
are based on the pinned LibreOffice source, not automated native keystrokes.

## Reference semantics and provenance

The separate 55-case controlled native probe in
`/workspace/open-office-research/libreoffice/character-format-compatibility/`
starts from intentionally constructed OOXML, then retains LibreOffice's native
ODT and DOCX conversions unchanged. Those probe inputs are synthetic; they are
not the ODT-authored native corpus committed here. Its findings determine the
supported subset:

| Input | Observed native Writer meaning |
| --- | --- |
| Repeated single/double strike in paragraph or character style ancestry | Same single/double strike, not cancellation |
| Either strike property explicitly false over inherited strike | No strike |
| One true and the other false in the same run properties | The true form, independent of element order |
| Both strike properties true | Last property wins; the independent editor rejects this ambiguity |
| Explicit baseline over inherited script | Baseline and full logical size |
| Zero `position` over inherited script | No override; inherited script remains |

Pinned source references:

- [`DomainMapper.cxx` strike handling, L2242](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2242), [zero-position handling, L2430](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2430), and [standard script, L3131](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L3131).
- [`docxattributeoutput.cxx` strike and escapement export, L8275](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8275). Standard script uses 58% paint size and approximately +33%/-8% offsets while keeping logical font size.
- [`ndtxt.cxx` empty successor clearing direct escapement, L761](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L761). Named character style and direct escapement are separate: end Enter clears the direct override and restores named super/sub/baseline. The browser suite checks this before and after two saves, including a baseline character style under a superscript paragraph, heading changes and soft breaks.

The strike ancestry decision follows measured Writer behavior; it is not a claim
that every Office consumer interprets arbitrary style chains identically.
