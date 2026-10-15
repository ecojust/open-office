// Browser regression for the native diagnostic adapter. Chromium evidence is
// explicitly separate from an installed macOS WKWebView/CGEvent acceptance run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/macos-editing-helper-browser');
const report = { ok: false, runtime: 'Chromium trusted input; not native macOS acceptance', requests: [], errors: [], boots: [], limitations: ['CGEvent, macOS WebContent termination, native IME and macOS 26.5 are not covered.'] };
fs.mkdirSync(output, { recursive: true });
let server, browser, page;
(async () => {
  try {
    report.artifacts = ['wordcraft', 'gridcraft'].map(engine => execFileSync(process.execPath, [`scripts/build-${engine}.mjs`, '--check'], { cwd: root, encoding: 'utf8' }).trim());
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 5304, strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] } } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', deviceScaleFactor: 2 });
    await context.exposeBinding('editingBoot', (_, boot) => report.boots.push(boot));
    await context.addInitScript(() => {
      window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__ = Object.freeze({ bootId: crypto.randomUUID(), timeOrigin: performance.timeOrigin });
      window.editingBoot(window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__);
      // WebKit converts the origin between clocks on every read. Simulate a
      // later conversion differing while the native startup marker stays fixed.
      Object.defineProperty(performance, 'timeOrigin', { get: () => window.__OPEN_OFFICE_DIAGNOSTIC_BOOT__.timeOrigin + 1 });
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.exposeBinding('editingInput', async (_, request) => {
      report.requests.push(request);
      if (request.kind === 'click') await page.mouse.click(request.clientX, request.clientY);
      else if (request.kind === 'doubleClick') await page.mouse.dblclick(request.clientX, request.clientY, { delay: 80 });
      else if (request.kind === 'type') await page.keyboard.type(request.text, { delay: 30 });
      else if (request.kind === 'key') await page.keyboard.press(request.key);
      else throw Error(`Unknown input kind ${request.kind}`);
    });
    await page.goto('http://127.0.0.1:5304');
    await page.locator('.create-card.sheet').waitFor();
    report.helper = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const { runMacosEditingSmoke, verifyMacosEditing, MACOS_EDITING_CHECKS } = await import('/src/sheet/rust/macos-editing-smoke.ts');
      let nativeGuardRejected = false;
      try { await runMacosEditingSmoke(app.editingSmokeAdapter()); }
      catch (error) { nativeGuardRejected = String(error).includes('opted-in native WebView'); }
      if (!nativeGuardRejected) throw Error('Native diagnostic accepted browser evidence');
      const value = await verifyMacosEditing(app.editingSmokeAdapter(), request => window.editingInput(request));
      return { ...value, nativeGuardRejected, requiredChecks: MACOS_EDITING_CHECKS };
    });
    assert.equal(report.helper.ok, true, report.helper.error || report.helper.closeError);
    assert.equal(report.helper.transport, 'local-wasm-in-browser');
    assert.equal(report.helper.nativeGuardRejected, true);
    assert.deepEqual(report.helper.checks, report.helper.requiredChecks);
    assert.deepEqual(report.helper.actions.map(action => action.actionId), ['single-a1', 'type-a1', 'enter-a1', 'double-d6', 'type-d6', 'enter-d6', 'select-a1', 'ribbon-bold', 'global-undo', 'word-click', 'word-type']);
    assert.ok(report.helper.actions.every(action => action.completed && action.events.some(event => event.isTrusted)));
    assert.equal(report.helper.initialTabIds.length, 2);
    assert.equal(report.helper.finalTabIds.length, 3);
    assert.deepEqual(report.helper.finalTabIds.slice(0, 2), report.helper.initialTabIds);
    assert.equal(new Set(report.helper.sessions.map(session => session.sessionId)).size, 3);
    assert.deepEqual(report.helper.cleanup, { attempted: 3, closed: 3, ok: true });
    assert.equal(report.boots.length, 1);
    assert.equal(report.helper.bootId, report.boots[0].bootId);
    assert.equal(report.helper.timeOrigin, report.boots[0].timeOrigin);
    report.liveTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    assert.equal(report.liveTimeOrigin, report.helper.timeOrigin + 1, 'Live getter drift must not replace the captured startup identity');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await server?.close();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
