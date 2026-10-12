# Offline Writer / Calc adapter

`OfficeEditor.vue` keeps one ZetaOffice WASM engine in a same-origin iframe. It accepts `document` (id/name/kind/extension/base64/sha256/sizeBytes), emits `ready`, `dirty`, `status`, `error`, and `request` for desktop file actions. `request.type` is `open`, `new`, `save`, `save-as`, `export-pdf`, `print`, `close`, or `insert-image`; `quit` requests the application’s existing guarded exit flow. `request.notice` must be surfaced when present. Generic Export currently routes to PDF with an explicit notice; Save a Copy routes to native Save As. Print Preview remains an engine view, while all print buttons request the shell’s explicit “export PDF, then print in a system application” guidance; no system print job is claimed.

Exposed methods:

- `exportFile({format?})`: returns `{base64, extension, name, revision, dirty}`. Writer supports DOCX/ODT/PDF; Calc supports XLSX/ODS/PDF. Export does **not** clear unsaved changes.
- `markSaved()`: call only after the native filesystem confirms a successful save. It only clears changes if the document revision still matches the exported revision.
- `discardChanges()`: only clears a state already exported at the same revision, preventing edits during a save/switch from being lost. After explicit user confirmation, `discardChanges({force:true})` may discard the current document without that check.
- `undo()`, `redo()`, `search(query?)`, `focus()`.
- `insertImage({name,base64})`: inserts and embeds a PNG/JPEG/WebP/GIF selected by the desktop picker. Images are limited to 25 MiB. The temporary file is not a linked dependency.
- `smokeTest()`: only enabled by the optional `smokeMode` prop or a Vite development build. Creates hidden disposable documents; edits Writer original text, saves and reopens DOCX, calculates `SUM(A1:A2)` from 40 and 2, saves and reopens XLSX, and exports both as PDF. The resulting JSON includes actual reopened text/formula/value and byte sizes/PDF signatures.

Keep the component mounted when hiding its tab, and resolve unsaved changes before changing `document.id`. Do not mount a separate engine for each tab: the engine starts with a 1 GiB shared WebAssembly memory. `retry()` explicitly asks before discarding in-memory edits. A failed or cancelled native save must not call `markSaved()`.

The native server must serve the full built frontend through loopback HTTP with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: same-origin` on all assets. Relative paths preserve the server's unpredictable URL prefix. `SharedArrayBuffer` and WASM threads are mandatory; test actual WKWebView and WebView2 builds, not only Chromium. The iframe protocol validates origin, source window, session, request ID and active document ID. Imported files always use `MacroExecMode.NEVER_EXECUTE` and `UpdateDocMode.NO_UPDATE`; password/macro/update prompts are aborted.

`clipboard-compat.js` handles a Qt WASM startup compatibility issue: Qt discards the promises from `navigator.permissions.query` for `clipboard-read` / `clipboard-write`, while WebKit rejects these unsupported permission descriptors with `TypeError`. The wrapper observes only those two descriptors, keeps the original promise and permission state, and explicitly reports other errors. It does not grant clipboard access; actual copy/paste remains subject to browser and OS permission checks.

Resources are pinned by exact SHA-256 in `vendor/office-runtime-manifest.json`. Run `node scripts/fetch-office-runtime.mjs` during preparation, or use `--verify` for a strictly offline integrity check. Keep giant runtime files out of Git; Vite copies `public/office-runtime` into the distribution. Once packaged, editing never downloads these resources. The engine has English menus; the application wrapper is Chinese, and a bundled Noto Sans CJK SC font supports Chinese document rendering. The engine currently does not import PDF; the separate PDF editor handles original PDF text edits.

Do not describe the complete product as MIT-only: ZetaJS is MIT but LibreOffice, its bundled Qt WASM platform plugin, fonts and other dependencies have separate redistribution/source obligations. See the project's third-party notices and corresponding-source records before distribution.
