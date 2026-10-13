# Real PDF browser regression

This suite runs Chromium against Vite's development-only local PyMuPDF bridge. It does not mock editing responses and does not claim to exercise Tauri native dialogs or macOS/Windows WebViews.

From the project root:

```sh
npm run pdf:ensure
npx playwright install chromium
npm run dev
```

In a second terminal:

```sh
node tests/browser/pdf-ui.cjs
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an installed Chromium executable. `PDF_QA_URL` defaults to `http://127.0.0.1:5198/`; the development PDF bridge only accepts its configured loopback origin. `PDF_QA_OUTPUT` can override the default `test-results/pdf-ui` directory.

The runner generates its own PDFs and image with `pdf-backend/.venv/bin/python` (Windows: `.venv/Scripts/python.exe`). It verifies editing, text removal, Chinese text, undo/redo, annotations, images, page management, search, extraction, merging, passwords, permissions, scanned and rotated/cropped documents, pending-edit guards, tab restoration, and narrow viewports. The exported files are independently reopened and inspected by `pdf-verify.py`. Screenshots, PDFs, and JSON reports are written under the output directory.

## Independent presentation regression

With the Vite server and Python environment above available:

```sh
npm run test:browser:ppt-independent
```

This opens one Chromium session and exercises the actual independent PPTX editor: text, pointer movement and resizing, undo/redo, slide management, editable tables/charts, real rich and 20-slide fixtures, save/reopen, Chinese PDF readback, slideshow shortcuts, hidden slides, unsaved-tab guards, and 640/900/1360-pixel layouts. The same page runs the production codec fixture checks, including real embedded XLSX chart workbooks. It asserts zero iframes, Office/WASM runtime requests, external requests and page errors; the local PDF font is the only allowed `/office-runtime/` resource.

The default output is `test-results/standalone-presentation/`. `STANDALONE_PRESENTATION_URL`, `STANDALONE_PRESENTATION_OUTPUT`, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override the local URL, artifact directory, and Chromium executable. The JSON report includes operation timings and browser JS heap measurements; these are not native process-memory measurements or packaged WebView validation. Optional `STANDALONE_PRESENTATION_MODE=layout`, `final`, or `codec` runs the corresponding targeted regression after a relevant change.

## Complex presentation preservation and rendering evidence

```sh
npm run test:browser:ppt-complex
```

This uses one Chromium session and the independent corpus in `tests/compatibility/presentation-complex/manifest.json`, including unchanged upstream PowerPoint SmartArt files with provenance and hashes. Each source undergoes three real export/reopen cycles, an unrelated text and notes edit, slide duplication and reordering, and relevant rich-text, grouped-connector or animation edit guards. The runner saves actual PPTX files, per-part byte changes, warnings and locked-object descriptions, model comparisons, and real Vue screenshots. Python's `python-pptx` and `lxml` independently inspect every exported package and protected XML/data relationships.

`PRESENTATION_COMPLEX_URL`, `PRESENTATION_COMPLEX_OUTPUT`, `PRESENTATION_COMPLEX_MANIFEST`, and comma-separated `PRESENTATION_COMPLEX_CASES` override the default local server, `test-results/standalone-presentation-complex/`, manifest, or fixture selection. `PYTHON` selects a Python interpreter with `python-pptx` and `lxml` installed. The report's success means the declared preservation, semantic and edit-safety checks passed. It does **not** mean that all input features render faithfully or play: SmartArt, complex charts, vertical text and source animations have separate limitations, shown by the screenshots and warnings. Identical screenshots across saves only demonstrate stability of this editor's renderer; they are not a comparison with PowerPoint.

## Legacy Impress presentation regression

With the same local development server and Python environment available:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser:ppt
```

Omit the executable override when using Playwright's installed Chromium. This opens the full application, creates a PPTX, adds slides, imports the checked-in original Chinese fixture, exports and reopens PPTX/ODP, independently checks PDF page count and text, and exercises static presentation preview plus the safe F5 route. The output is `test-results/presentation-ui/`; no user documents are used or overwritten.

`npm run test:browser:impress` separately exercises actual original slide-text modification and exact two-slide PPTX/ODP reopening through the real bundled engine. Neither browser runner claims native Windows/macOS WebView validation; release workflows run the native checks separately.
