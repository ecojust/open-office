/* Chromium counterpart of the installed-app spreadsheet helper. This must
 * report browser transport and reject the native entry point; it cannot stand
 * in for an installed WebKit/WebView2 run. Uses the real Vue shell lifecycle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.GRIDCRAFT_SMOKE_OUTPUT || path.join(root, 'test-results/gridcraft-native-helper'));
const sourceFiles = ['src/App.vue', 'src/components/RustSheetEditor.vue', 'src/sheet/rust/client.ts', 'src/sheet/rust/gridcraft-native-smoke.ts', 'public/gridcraft/manifest.json', 'public/gridcraft/gridcraft.js', 'public/gridcraft/gridcraft_bg.wasm'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, startedAt: new Date().toISOString(), errors: [], externalRequests: [], forbiddenRequests: [],
  runtime: 'Real default spreadsheet shell in Chromium; native helper browser counterpart only',
  limitations: ['Native WebView, operating-system IME, file dialogs and filesystem persistence are not covered.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-gridcraft.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productsBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.GRIDCRAFT_SMOKE_PORT || 5299), strictPort: true, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    context.on('request', request => {
      const url = request.url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
      if (/\/office\/host\.html|\/office-runtime\/|soffice\.(?:js|wasm)/.test(url)) report.forbiddenRequests.push(url);
    });
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin); await page.locator('.create-card.sheet').waitFor();
    report.helper = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const vueUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/deps\/vue\.js(?:\?|$)/.test(name));
      if (!vueUrl) throw Error('Actual Vue module URL was not observed');
      const { nextTick } = await import(vueUrl);
      const { inspectGridcraftSession } = await import('/src/sheet/rust/client.ts');
      const { runGridcraftNativeSmoke, verifyMountedGridcraftEditor } = await import('/src/sheet/rust/gridcraft-native-smoke.ts');
      const adapter = {
        async open(base64, name) {
          await app.editorTransaction('Browser spreadsheet smoke', () => app.addDocument({ id: '', kind: 'sheet', extension: 'xlsx', name, base64, sha256: '', sizeBytes: Math.floor(base64.length * .75) }));
          await nextTick(); const tab = app.active;
          if (!tab || tab.document.kind !== 'sheet') throw Error('Default Rust spreadsheet tab missing');
          await app.awaitReady(tab);
          const handle = app.rustSheetHandles.get(tab.key), snapshot = await handle.inspect();
          const element = [...document.querySelectorAll('[data-testid="rust-sheet-editor"]')].find(node => node.dataset.sessionId === snapshot.sessionId);
          if (!element) throw Error('Actual spreadsheet component missing');
          return { key: tab.key, element, editor: app.nativeTransactionalEditor(handle) };
        },
        activeKey: () => app.activeKey,
        async close(key) {
          const tab = app.tabs.find(tab => tab.key === key);
          if (!tab) throw Error('Smoke cleanup tab missing');
          const id = (await app.rustSheetHandles.get(key).inspect()).sessionId;
          await app.removeTab(tab, true); await nextTick();
          let closed = false;
          try { await inspectGridcraftSession(id); } catch { closed = true; }
          if (!closed) throw Error('Rust session survived actual Vue unmount');
        },
      };
      let nativeGuardRejected = false;
      try { await runGridcraftNativeSmoke(adapter); }
      catch (error) { nativeGuardRejected = String(error).includes('real native WebView is required'); }
      if (!nativeGuardRejected) throw Error('Native entry point accepted browser evidence');
      return { ...await verifyMountedGridcraftEditor(adapter), nativeGuardRejected };
    });
    persist();
    assert.equal(report.helper.ok, true, report.helper.error || report.helper.closeError);
    assert.equal(report.helper.transport, 'local-wasm-in-browser');
    assert.equal(report.helper.nativeGuardRejected, true);
    assert.equal(report.helper.cleanup.closed, 2);
    assert.equal(report.helper.cleanup.remainingCanvas, 0); assert.equal(report.helper.cleanup.remainingInput, 0);
    for (const key of ['xlsxBase64', 'reopenedXlsxBase64']) {
      const destination = path.join(output, key + '.xlsx'); fs.writeFileSync(destination, Buffer.from(report.helper[key], 'base64'));
      const inspected = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'gridcraft-inspect-xlsx.py'), destination], { encoding: 'utf8' }));
      assert.equal(inspected.sheets.length, 1);
      const cells = inspected.sheets[0].cells;
      assert.equal(cells.A1.value, 'Open Office 表格😀'); assert.equal(cells.A1.style.bold, true);
      assert.equal(cells.B1.value, 12); assert.equal(cells.B2.value, 30);
      assert.equal(cells.C1.formula, '=SUM(B1:B2)'); assert.equal(cells.C1.value, 42);
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    report.productsAfter = hashes(); assert.deepEqual(report.productsAfter, report.productsBefore);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
