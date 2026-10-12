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
