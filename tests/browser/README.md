# Browser editor regression

The current runners mount the real local Rust WASM editors inside the application. They exercise document sessions and exported files; browser results do not establish native file-dialog, physical input-method, or installed macOS/Windows WebView compatibility.

Build the editor assets and install a browser first:

```sh
npm run build
npx playwright install chromium
python -m pip install -r tests/requirements-pdf-inspection.txt
```

Run the PDF or presentation checks from the project root:

```sh
npm run test:browser:pdf
npm run test:browser:ppt-engine
```

These runners start their own local development server. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects an already installed Chromium executable where supported by the runner. Python is used only for independent inspection of exported documents; it is not an application runtime or PDF editing backend.

The PDF check covers the mounted canvas, local WASM resource hashes, real content insertion and replacement, export/reopen, undo/redo, stale save receipts, multiple isolated sessions, invalid-open preservation, and session cleanup. Results and screenshots are retained under `test-results/office-pdf-native-helper/`. Additional PDF fixture generators and independent inspection scripts remain available for targeted compatibility work; their existence alone does not mean every historical editor feature has been verified in the current engine.

The presentation check covers the mounted canvas, input, formatting, slide creation, theme changes, export/reopen and save receipts. Exported packages are inspected independently. Platform release workflows separately verify the installed application and bind its bundled engine hashes to the checked-out source.

Run `node tests/browser/office-ui-style.cjs` after a full build to inspect the shared interface style across the home page and all five editors. It verifies local UI font loading, DOM control fonts, SVG stroke conventions, light/dark appearance, compact layout and unchanged document history. Each surface runs in its own sequential Chromium process to keep WASM memory bounded. The report and 19 screenshots are saved under `test-results/office-ui-style/`, including the home page at 480px; inspect the screenshots for canvas glyphs, icon appearance and presentation ribbon clipping that DOM checks cannot establish. This suite does not change or normalize document fonts.
