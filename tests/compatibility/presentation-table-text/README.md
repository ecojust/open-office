# Mixed table-cell preservation fixture

`mixed-cell.pptx` is a generated regression fixture, not a third-party document.
SHA-256: `68915e65d1201b8c986aaaf45c6b32ac47bed3ee2b7fdcaba2cfa66a9307700b`.

One 2×2 table: cell [0,0] has two paragraphs, one explicit line break and four styled runs (`Red `, `Blue`, `Green`, `Tail`), paragraph spacing and a positive baseline. The target cell has a custom left margin; grid width and row height are nonuniform. Other cells provide unchanged-content oracles. The small original text frame deliberately remains unchanged; browser UI validation expands its height before deriving an editable baseline.

Independent reproduction initially showed that changing just `Red` to `Bed` removed the soft break and several styles. `tests/browser/presentation-table-text.cjs` verifies preserved XML on the real production importer/controller/exporter and generates adversarial fixtures in memory. External-link variants are never fetched. Native-rendering evidence is separate from these browser XML assertions.
