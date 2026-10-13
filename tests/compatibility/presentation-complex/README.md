# Complex presentation compatibility corpus

This corpus contains **12 independent PPTX samples**: nine original generated OOXML cases and three unmodified Apache POI SmartArt files. These inputs are separate from the older compatibility corpus. The manifest pins the exact bytes, SHA-256, source and license of every input.

| Input | What the package contains |
| --- | --- |
| `typography-rich` | Multiple runs and fonts, mixed size/color/bold/italic, a slide-number field, run hyperlink, paragraph alignment/spacing, tabs, bullets and baseline/character spacing |
| `text-layout-vertical` | Top/center/bottom anchors, zero/asymmetric margins, no-wrap, text-body rotation in both directions and East Asian vertical text |
| `nested-groups-images` | Nested and rotated groups, cropped/flipped images, alpha; a separate complete group with two shapes and a connector for independent duplication |
| `merged-styled-tables` | Horizontal/vertical merged cells, varied row heights, cell margins/fills, vertical cell text and borders |
| `combo-and-doughnut-charts` | A true two-type bar/line combination chart, a doughnut chart, cached data and two embedded editable XLSX workbooks |
| `motion-triggers-connectors` | Bézier/line motion path, explicit click trigger, rotation behavior, build list, bound connector and internal slide link |
| `slide-links-inheritance` | Three slides, hidden slide, links in both directions, repeated slide references in a custom show and an inherited master logo |
| `placeholder-inheritance` | An own transform containing only rotation with layout offsets/extents, plus text-body attributes inherited individually from master/layout/slide |
| `affine-group-mc-custom` | Nonuniform group scale with a rotated child, explicit custom Bézier geometry, `AlternateContent` choice/fallback sharing a shape ID, an ancestor-only `Requires` namespace, and ungrouped connector/endpoint copy protection |
| `poi-smartart-default-list` | POI `SmartArt.pptx`: default list layout, five original blank placeholder nodes |
| `poi-smartart-alternating-hexagons` | POI `smartart-rotated-text.pptx`: alternating hexagons, rotated shapes and text |
| `poi-smartart-venn` | POI `smartart-simple.pptx`: Venn layout, gradients, transparency and image fill; reused unchanged from the previous corpus |

The POI files are pinned to commit `f3688f45b0de8934fb32736ba14efc5bbca4a580`. Full Apache license and notice files are retained beside them. [Upstream source records](fixtures/upstream/SOURCES.json) contain original URLs, legal scope, diagram hashes, layout IDs, data-node text and structural evidence distinguishing the three layouts. Producer metadata is recorded as a declaration, not proof of an observed PowerPoint authoring session. The nine generated files are original MIT-licensed test content; they are not Microsoft Office, WPS or LibreOffice originals.

## Run the independent checks

Python dependencies are `python-pptx`, `lxml` and `Pillow` (Pillow is only used by the generator).

```sh
python3 tests/compatibility/presentation-complex/test_inspect.py -v
python3 tests/compatibility/presentation-complex/inspect.py \
  tests/compatibility/presentation-complex/fixtures/generated/typography-rich.pptx \
  /path/to/roundtrip.pptx \
  --fixture typography-rich --scenario noop --report /tmp/typography-audit.json
```

The real application runner is `tests/browser/standalone-presentation-complex.cjs`. It serializes browser use, imports these fixed inputs, writes real exports and invokes the independent Python inspector. Its output directory is `test-results/standalone-presentation-complex`.

`inspect.py` accepts one source and zero or more outputs. A zero-output invocation checks source readability, fixed digest, ZIP/OOXML relationship integrity and embedded XLSX relationships. Output scenarios are:

- `noop`: each output independently compared with the fixed original, including three repeated saves.
- `edit`: the named safe text object and notes may change to `--expected-edit-text` and `--expected-notes`; other original shape semantics remain exact.
- `duplicate`: pass `--slide-order '[0,0,1]'` to map output slides to source indices; optional edit text/notes apply to the declared source page. Animation and slide-link destinations are compared semantically.
- `format-color` / `format-size`: change only the manifest's named text object to `--expected-color '#146CA4'` or `--expected-font-size 28`. Other run/field/font/paragraph/hyperlink data must survive.
- `duplicate-object`: the complete connected group must appear twice. Each group's connector endpoints must point to its own children, while original IDs remain owned by the original group.
- `move-object`: default move is +10 mm X, 0 mm Y. The group's own offset must change by exactly that amount. Group rotation, extents, child coordinate system and every complete child XML subtree must remain unchanged.
- `nested-format-color`: a controlled codec-only edit of `AFFINE_CHILD`. This is explicitly not a claim of nested text editing through the user interface. Only that child's text color may change; all group/child raw transforms must remain exact.
- `delete`: any unexpected unsafe export is audited against the original; the browser contract expects animation target/trigger deletion to be rejected before producing an output.

The inspector imports no production JavaScript. It uses lxml expanded XML names, namespace scope, independently resolved geometry and actual relationship destinations. It checks motion path strings, trigger and build targets, connector endpoints, shape/timing IDs, text runs/fields/style/body properties, crop/flip/alpha and custom show references. Mutually exclusive markup-compatibility branches may reuse an ID; duplicate IDs in the same active scope fail. `Requires`/`Ignorable` prefixes must retain their namespace bindings. Original media, diagram, chart/workbook, theme, master and layout parts listed in the manifest must retain identical bytes.

The negative controls deliberately alter motion paths, a trigger to another valid shape, run formatting, crop values, diagram bytes, connector targets and affine geometry. This demonstrates that retaining element counts is insufficient to pass.

## Refresh generated inputs

`generate.py` creates the original samples and rebuilds the manifest from the fixed upstream source records. It fixes presentation properties and top-level ZIP timestamps. Embedded workbook metadata can depend on the installed writer version and generation time, so a refresh intentionally regenerates the recorded hashes; the shipped corpus and all test runs use the checked-in manifest digests. Refreshes should be followed by source checks and a new browser audit. The script never downloads or changes the pinned upstream inputs.

Package preservation, editable basic objects, preview fidelity and animation playback are separate results. Passing these checks establishes structural preservation and the tested edit protections. It does not establish PowerPoint-equivalent rendering, SmartArt editing, full complex animation playback or packaged native WebView compatibility.
