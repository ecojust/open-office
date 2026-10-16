/* Real Chromium check of the installed-app helper's shared mounted-editor path.
 * This is browser evidence, never a substitute for a packaged native WebView.
 * Uses the development Vue instance to drive the actual App lifecycle; neither
 * Tauri detection nor the OfficeWord host, renderer, input or exports are mocked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const legacyEngineBrand = new RegExp(require('../../scripts/office-branding-policy.json').families.map(family => family.old).join('|'), 'i');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_WORD_SMOKE_OUTPUT || path.join(root, 'test-results/office-word-native-helper'));
const sourceFiles = ['src/App.vue', 'src/components/RustWordEditor.vue', 'src/word/rust/client.ts', 'src/word/rust/office-word-native-smoke.ts', 'public/office-word/manifest.json', 'public/office-word/office-word.js', 'public/office-word/office-word_bg.wasm'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const report = { ok: false, runtime: 'Chromium development Vite with the real default App and OfficeWord WASM', limitations: ['Native WebView, operating-system IME and file dialogs are not covered by this browser check.'], errors: [], externalRequests: [], forbiddenRequests: [], startedAt: new Date().toISOString(), productsBefore: hashes() };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-word.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/src-tauri/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    context.on('request', request => {
      const url = request.url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
      if (/\/office\/host\.html|\/office-runtime\/|soffice\.(?:js|wasm)/.test(url)) report.forbiddenRequests.push(url);
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin);
    await page.locator('.create-card.word').waitFor();
    assert.doesNotMatch(await page.locator('.create-card.word').innerText(), legacyEngineBrand, 'The visible workbench has no upstream editor branding');
    report.helper = await page.evaluate(async legacyPattern => {
      const legacyEngineBrand = new RegExp(legacyPattern, 'i');
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const vueUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/deps\/vue\.js(?:\?|$)/.test(name));
      if (!vueUrl) throw Error('Actual App Vue module URL was not observed');
      const { nextTick } = await import(vueUrl);
      const { inspectOfficeWordSession } = await import('/src/word/rust/client.ts');
      const { runOfficeWordNativeSmoke, verifyMountedOfficeWordEditor } = await import('/src/word/rust/office-word-native-smoke.ts');
      const embeddedChrome = [];
      const adapter = {
        async open(base64, name) {
          await app.editorTransaction('Browser smoke document', () => app.addDocument({ id: '', kind: 'word', extension: 'docx', name, base64, sha256: '', sizeBytes: Math.floor(base64.length * .75) }));
          await nextTick(); const tab = app.active;
          if (!tab || tab.document.kind !== 'word') throw Error('Default OfficeWord tab missing');
          await app.awaitReady(tab);
          const handle = app.rustWordHandles.get(tab.key), state = await handle.inspect();
          const element = [...document.querySelectorAll('[data-testid="rust-word-editor"]')].find(node => node.dataset.sessionId === state.sessionId);
          if (!element) throw Error('Actual OfficeWord component missing');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const drawn = await handle.inspect();
          if (!drawn.ui?.ribbonTabs?.length || !drawn.ui?.drawnChrome?.length) throw Error('Actual embedded chrome geometry missing');
          for (const tab of drawn.ui.ribbonTabs) {
            if (/^(File|Help|Zotero)$/i.test(tab.id)) throw Error('Embedded file/help/external connector tab remains visible');
          }
          for (const widget of drawn.ui.drawnChrome) {
            if (!widget.id.startsWith('tab:') && !['quickAccess:edit.undo', 'quickAccess:edit.redo'].includes(widget.id)) throw Error('Non-editing embedded chrome remains visible: ' + widget.id);
          }
          for (const selector of ['.command-bar', '.editor-status', '[data-testid="import-review-notice"]']) {
            if (legacyEngineBrand.test(document.querySelector(selector)?.innerText || '')) throw Error('Upstream brand appears in visible application chrome: ' + selector);
          }
          embeddedChrome.push({ documentId: drawn.documentId, tabs: drawn.ui.ribbonTabs, chrome: drawn.ui.drawnChrome });
          return { key: tab.key, element, editor: app.nativeTransactionalEditor(handle) };
        },
        activeKey: () => app.activeKey,
        async close(key) {
          const tab = app.tabs.find(tab => tab.key === key);
          if (!tab) throw Error('Smoke cleanup tab missing');
          const id = (await app.rustWordHandles.get(key).inspect()).sessionId;
          await app.removeTab(tab, true); await nextTick();
          let closed = false;
          try { await inspectOfficeWordSession(id); } catch { closed = true; }
          if (!closed) throw Error('Session survived real Vue unmount');
        },
      };
      let nativeGuardRejected = false;
      try { await runOfficeWordNativeSmoke(adapter); } catch (error) { nativeGuardRejected = String(error).includes('real native WebView is required'); }
      if (!nativeGuardRejected) throw Error('Native smoke accepted a browser');
      const result = await verifyMountedOfficeWordEditor(adapter);
      return { ...result, nativeGuardRejected, embeddedChrome };
    }, legacyEngineBrand.source);
    persist();
    assert.equal(report.helper.ok, true, report.helper.error || report.helper.closeError);
    assert.equal(report.helper.transport, 'local-wasm-in-browser');
    assert.equal(report.helper.nativeGuardRejected, true);
    assert.equal(report.helper.embeddedChrome.length, 2, 'Both mounted real editors use editing-only chrome while retaining the deliberately branded document content');
    assert.equal(report.helper.cleanup.closed, 2); assert.equal(report.helper.cleanup.remainingCanvas, 0); assert.equal(report.helper.cleanup.remainingInput, 0);
    report.docx = [];
    for (const key of ['docxBase64', 'reopenedDocxBase64']) {
      const destination = path.join(output, `${key}.docx`);
      fs.writeFileSync(destination, Buffer.from(report.helper[key], 'base64'));
      const inspected = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'tests/compatibility/office-word-core/inspect_docx.py'), destination], { encoding: 'utf8' }));
      const paragraphs = inspected.paragraphs.filter(p => p.part === 'word/document.xml' && p.location.length === 2);
      assert.equal(paragraphs.map(p => p.text).join('\n'), 'OfficeWord Native 中文😀');
      for (const run of paragraphs.flatMap(p => p.runs).filter(run => run.text)) {
        assert.equal(run.style.bold, true); assert.equal(run.style.italic, true); assert.equal(run.style.underline, 'single'); assert.equal(run.style.fontSize, 16); assert.equal(run.style.color, '#336699');
      }
      report.docx.push({ key, bytes: fs.statSync(destination).size, sha256: hash(fs.readFileSync(destination)), externallyInspected: true });
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    report.productsAfter = hashes(); assert.deepEqual(report.productsAfter, report.productsBefore);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); persist();
    if (browser) await browser.close(); if (server) await server.close();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
