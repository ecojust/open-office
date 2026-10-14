These small inputs are authored independently of Open Office: a DOCX made with
Python's ZIP/XML standard library and an XLSX made with openpyxl. Run
`python3 tests/compatibility/office-viewport/make-fixtures.py` to regenerate them.
The manifest records source hashes; UI tests never overwrite these sources.

`tests/browser/office-viewport-ui.cjs` opens the actual native Word and Calc
editors at 1560, 820, and 390 CSS pixels, then restores 1560. At each width it
finds two distinct marker colors in a screenshot using Pillow, clicks those
visible positions, and reads the selected word/cell through the public,
read-only office protocol. Marker proportions also detect persistent canvas
compression. Word additionally scrolls to the paragraph command and opens and closes its sidebar at 820 px
without changing the outer viewport. The test types a real edit at 390 px,
checks it again after restoring desktop width, saves through the visible UI,
and inspects the downloaded ZIP/XML independently.

Run a production preview first, then:

```sh
OFFICE_WORKBENCH_URL=http://127.0.0.1:4299 node tests/browser/office-viewport-ui.cjs
```

Chromium defaults to `/usr/bin/chromium`. `VIEWPORT_DPRS=1` or `2` restricts the
default serial DPR 1 and 2 runs. `VIEWPORT_KINDS=word` or `calc` restricts the
default serial document runs. `OFFICE_VIEWPORT_UI_OUTPUT` sets the artifact
directory; the default creates a unique directory under
`test-results/viewport-iteration/ui/`. Each run writes screenshots, downloaded
files and `ui-report.json`, including geometry, image bounds, selected content,
document identity, console errors, and independent package inspections.

Two explicit control flows isolate an observed Calc input failure without
changing the default assertions. `VIEWPORT_FLOW=wide-control VIEWPORT_KINDS=calc
VIEWPORT_DPRS=1` uses a fresh document at 1560 px, types B2=314, waits for Enter
to commit at B3, then tests Ctrl+Home followed by a screenshot-derived B2 click.
It saves and audits the output even when that selection assertion fails, and
retains a failing result. `VIEWPORT_FLOW=direct-export` runs the normal resize
and target checks before editing, then restores desktop width and exports
without Ctrl+Home or a canvas click after the edit. Its pass applies only to
that separately named flow. Optional `VIEWPORT_POINTER_DIAGNOSTIC=1` records
pointer movement/pacing probes after an assertion failure without turning it
into a pass.

Observed in the current production preview: after Calc commits B2=314 at B3,
the helper's DOM `canvas.focus()` followed by Ctrl+Home and a click on visible
B2 leaves native selection at A1. The same sequence reproduced on a fresh
1560 px document without resizing, while the saved XLSX retained the edit and
sentinels. Correct DOM pointer coordinates and settled screenshots were
recorded. The role of the helper's focus call versus Ctrl+Home is not isolated;
this evidence does not establish a resize-specific product regression. The
default test retains that failing assertion.

This checks native resizing, visible pointer hit testing and retained edits at
the sampled widths. It does not establish full mobile or touch usability.
