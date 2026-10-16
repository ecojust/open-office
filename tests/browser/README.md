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
