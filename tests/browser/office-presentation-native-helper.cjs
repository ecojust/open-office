/* Chromium counterpart of the installed-app presentation helper. This must
 * report browser transport and reject the native entry point; it cannot stand
 * in for an installed WebKit/WebView2 run. Uses the real Vue shell lifecycle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const legacyEngineBrand = new RegExp(require('../../scripts/office-branding-policy.json').families.map(family => family.old).join('|'), 'i');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PRESENTATION_SMOKE_OUTPUT || path.join(root, 'test-results/office-presentation-native-helper'));
const sourceFiles = ['src/App.vue', 'src/components/RustPresentationEditor.vue', 'src/presentation/rust/client.ts', 'src/presentation/rust/media.ts', 'src/presentation/rust/office-presentation-native-smoke.ts', 'public/office-presentation/manifest.json', 'public/office-presentation/office-presentation.js', 'public/office-presentation/office-presentation_bg.wasm'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, startedAt: new Date().toISOString(), errors: [], consoleErrors: [], externalRequests: [], forbiddenRequests: [],
  runtime: 'Real default presentation shell in Chromium; native helper browser counterpart only',
  limitations: ['Native WebView, operating-system IME, file dialogs and filesystem persistence are not covered.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
// Await the evaluated predicate explicitly; waitForFunction may treat its
// Promise as truthy. Keep the original 30-second deadline, including each read.
async function waitForAsync(predicate, arg, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const failure = () => Error('Timed out waiting for the presentation editor state');
  while (Date.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        page.evaluate(predicate, arg),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), deadline - Date.now()); }),
      ]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw failure();
}
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-presentation.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productsBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_PRESENTATION_SMOKE_PORT || 5301), strictPort: true, hmr: false,
      // Worktrees may share dependencies through a symlink; Vite must transform the worker's ?url import.
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
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
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.exposeFunction('captureDeckSmoke', async () => {
      const started = Date.now();
      const inspect = () => page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return app.rustPresentationHandles.get(app.activeKey).inspect();
      });
      const query = () => page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return app.rustPresentationHandles.get(app.activeKey).query('slide.inspect', { index: 0 });
      });
      const beforeSelection = await inspect();
      await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        const editor = app.rustPresentationHandles.get(app.activeKey);
        const slide = await editor.query('slide.inspect', { index: 0 });
        const visible = slide.shapes.filter(shape => shape.text === 'Open Office 演示😀');
        if (visible.length !== 1) throw Error('The visible smoke text box was not uniquely identified');
        await editor.command('selection.select', { id: visible[0].id });
      });
      const before = await inspect();
      assert.equal(before.documentId, beforeSelection.documentId); assert.equal(before.revision, beforeSelection.revision);
      assert.equal(before.dirty, beforeSelection.dirty, 'Selecting the visible text box does not change document contents');
      assert.equal(await page.locator('iframe').count(), 0);
      assert.ok(!legacyEngineBrand.test(await page.locator('body').innerText()), 'Ordinary interface contains no upstream brand');
      for (const id of ['shell-open', 'shell-save', 'shell-save-as', 'shell-export-pdf', 'shell-print']) {
        assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is in the global toolbar`);
      }
      for (const theme of ['dark', 'light']) {
        await page.getByTestId('theme-' + theme).click();
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        await waitForAsync(async theme => {
          const app = document.querySelector('#app').__vue_app__._instance.setupState;
          return (await app.rustPresentationHandles.get(app.activeKey).inspect()).ui?.ui?.brightness === theme;
        }, theme);
        // The Rust state reports its new palette before WebGL has painted the
        // updated slide textures; capture only after two rendered frames.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const state = await inspect();
        assert.equal(state.documentId, before.documentId); assert.equal(state.revision, before.revision); assert.equal(state.dirty, before.dirty);
        await page.screenshot({ path: path.join(output, `presentation-${theme}.png`), fullPage: true });
      }
      await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        await app.rustPresentationHandles.get(app.activeKey).command('slide.notes', { index: 0, text: 'GLOBAL_TOOLBAR_NOTE' });
      });
      assert.equal((await query()).notes, 'GLOBAL_TOOLBAR_NOTE');
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return (await app.rustPresentationHandles.get(app.activeKey).query('slide.inspect', { index: 0 })).notes !== 'GLOBAL_TOOLBAR_NOTE';
      });
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await waitForAsync(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return (await app.rustPresentationHandles.get(app.activeKey).query('slide.inspect', { index: 0 })).notes === 'GLOBAL_TOOLBAR_NOTE';
      });
      await page.getByTestId('shell-save-as').click();
      await page.getByTestId('save-format-pptx').check();
      await page.getByTestId('save-format-name').fill('Global presentation 保存');
      const pptxDownload = page.waitForEvent('download');
      await page.getByTestId('save-format-confirm').click();
      const savedPptx = await pptxDownload;
      assert.equal(savedPptx.suggestedFilename(), 'Global presentation 保存.pptx');
      await savedPptx.saveAs(path.join(output, 'global-toolbar.pptx'));
      await page.waitForFunction(() => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !app.busy && !app.saveAsDraft && !app.active.dirty;
      });
      assert.equal((await inspect()).dirty, false, 'Global Save As acknowledges the exact PPTX receipt');
      assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.active.document.name), 'Global presentation 保存.pptx');
      await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        await app.rustPresentationHandles.get(app.activeKey).command('slide.notes', { index: 0, text: 'PDF_COPY_UNSAVED' });
      });
      const beforePdf = await inspect();
      assert.equal(beforePdf.dirty, true);
      const pdfDownload = page.waitForEvent('download');
      await page.getByTestId('shell-export-pdf').click();
      const savedPdf = await pdfDownload;
      assert.equal(savedPdf.suggestedFilename(), 'Global presentation 保存.pdf');
      await savedPdf.saveAs(path.join(output, 'global-toolbar.pdf'));
      await page.waitForFunction(() => !document.querySelector('#app').__vue_app__._instance.setupState.busy);
      const afterPdf = await inspect();
      assert.equal(afterPdf.documentId, beforePdf.documentId); assert.equal(afterPdf.revision, beforePdf.revision);
      assert.equal(afterPdf.dirty, true, 'Global PDF copy preserves newer unsaved PPTX changes');
      assert.equal((await query()).notes, 'PDF_COPY_UNSAVED');
      report.globalDownloads = {
        pptx: { filename: savedPptx.suggestedFilename(), path: path.join(output, 'global-toolbar.pptx') },
        pdf: { filename: savedPdf.suggestedFilename(), path: path.join(output, 'global-toolbar.pdf') },
      };
      report.globalControls = { toolbarVisible: true, undoRedoRoutedToActivePresentation: true, themePreservesRevision: true,
        lightAndDark: true, noVisibleUpstreamBrand: true, saveAsDownloadAcknowledgesReceipt: true, pdfDownloadPreservesUnsavedPresentation: true };
      report.mountedInteractionMilliseconds = Date.now() - started;
    });
    await page.goto(origin); await page.locator('.create-card.presentation').waitFor();
    report.helper = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const vueUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/deps\/vue\.js(?:\?|$)/.test(name));
      if (!vueUrl) throw Error('Actual Vue module URL was not observed');
      const { nextTick } = await import(vueUrl);
      const { inspectOfficePresentationSession } = await import('/src/presentation/rust/client.ts');
      const { runOfficePresentationNativeSmoke, verifyMountedOfficePresentationEditor } = await import('/src/presentation/rust/office-presentation-native-smoke.ts');
      const closeTimings = [];
      const adapter = {
        async open(base64, name) {
          await app.editorTransaction('Browser presentation smoke', () => app.addDocument({ id: '', kind: 'presentation', extension: 'pptx', name, base64, sha256: '', sizeBytes: Math.floor(base64.length * .75) }));
          await nextTick(); const tab = app.active;
          if (!tab || tab.document.kind !== 'presentation') throw Error('Default Rust presentation tab missing');
          await app.awaitReady(tab);
          const handle = app.rustPresentationHandles.get(tab.key), snapshot = await handle.inspect();
          const element = [...document.querySelectorAll('[data-testid="rust-presentation-editor"]')].find(node => node.dataset.sessionId === snapshot.sessionId);
          if (!element) throw Error('Actual presentation component missing');
          return { key: tab.key, element, editor: app.nativeTransactionalEditor(handle) };
        },
        activeKey: () => app.activeKey,
        async verifyMounted() { await window.captureDeckSmoke(); },
        async close(key) {
          const started = performance.now();
          const tab = app.tabs.find(tab => tab.key === key);
          if (!tab) throw Error('Smoke cleanup tab missing');
          const id = (await app.rustPresentationHandles.get(key).inspect()).sessionId;
          await app.removeTab(tab, true); await nextTick();
          let closed = false;
          try { await inspectOfficePresentationSession(id); } catch { closed = true; }
          if (!closed) throw Error('Rust session survived actual Vue unmount');
          closeTimings.push({ key, milliseconds: Math.round(performance.now() - started) });
        },
      };
      let nativeGuardRejected = false;
      try { await runOfficePresentationNativeSmoke(adapter); }
      catch (error) { nativeGuardRejected = String(error).includes('real native WebView is required'); }
      if (!nativeGuardRejected) throw Error('Native entry point accepted browser evidence');
      return { ...await verifyMountedOfficePresentationEditor(adapter), nativeGuardRejected, closeTimings };
    });
    persist();
    assert.equal(report.helper.ok, true, report.helper.error || report.helper.closeError);
    assert.equal(report.helper.transport, 'local-wasm-in-browser');
    assert.equal(report.helper.nativeGuardRejected, true);
    assert.equal(report.helper.cleanup.closed, 2);
    assert.equal(report.helper.cleanup.remainingCanvas, 0); assert.equal(report.helper.cleanup.remainingInput, 0);
    const { inspectOfficePresentationExports, REQUIRED_OFFICE_PRESENTATION_CHECKS } = await import('../../scripts/office-presentation-native-smoke.mjs');
    assert.deepEqual(report.helper.checks, [...REQUIRED_OFFICE_PRESENTATION_CHECKS]);
    report.independentExports = inspectOfficePresentationExports(report.helper);
    assert.ok(report.globalDownloads, 'Global toolbar downloads were not exercised');
    report.independentGlobalDownloads = inspectOfficePresentationExports({
      pptxBase64: report.helper.pptxBase64,
      reopenedPptxBase64: fs.readFileSync(report.globalDownloads.pptx.path).toString('base64'),
      pdfBase64: fs.readFileSync(report.globalDownloads.pdf.path).toString('base64'),
    });
    for (const key of ['pptxBase64', 'reopenedPptxBase64', 'pdfBase64']) {
      fs.writeFileSync(path.join(output, key + (key === 'pdfBase64' ? '.pdf' : '.pptx')), Buffer.from(report.helper[key], 'base64'));
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
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
