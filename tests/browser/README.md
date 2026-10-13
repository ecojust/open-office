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

## Presentation regression

With the same local development server and Python environment available:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser:ppt
```

Omit the executable override when using Playwright's installed Chromium. This opens the full application, creates a PPTX, adds slides, imports the checked-in original Chinese fixture, exports and reopens PPTX/ODP, independently checks PDF page count and text, and exercises static presentation preview plus the safe F5 route. The output is `test-results/presentation-ui/`; no user documents are used or overwritten.

`npm run test:browser:impress` separately exercises actual original slide-text modification and exact two-slide PPTX/ODP reopening through the real bundled engine. Neither browser runner claims native Windows/macOS WebView validation; release workflows run the native checks separately.
