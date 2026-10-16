/* Real embedded PDF toolbar acceptance. Owns Vite/Chromium; run only after pdf:check.
 * The canvas receives genuine Playwright mouse/keyboard events. This is browser evidence,
 * not proof of native WebView, operating-system IME or filesystem persistence.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PDF_TOOLBAR_OUTPUT || path.join(root, 'test-results/office-pdf-toolbar'));
const files = ['src/App.vue', 'src/components/RustPdfEditor.vue', 'src/pdf/rust/client.ts', 'public/office-pdf/manifest.json', 'public/office-pdf/office_pdf_bg.wasm'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue PDF editor and Rust WASM in Chromium', checks: [], screenshots: [], clicks: [], layouts: [], errors: [], consoleErrors: [], externalRequests: [],
  limitations: ['Native WebView, native dialogs, filesystem saving and physical IME are not exercised.', 'Menu choices use observed canvas geometry and assert the resulting Rust state.', 'Screenshots need visual review.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
async function frames(count = 3) { await page.evaluate(count => new Promise(resolve => { const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); }), count); }
async function wait(predicate, arg, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await page.evaluate(predicate, arg); if (result) return result; await frames(2); }
  throw Error('Timed out waiting for PDF toolbar state');
}
const state = () => page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.rustPdfHandles.get(app.activeKey).query('ui.state'); });
const inspect = () => page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.rustPdfHandles.get(app.activeKey).inspect(); });
const command = (id, params = {}) => page.evaluate(async ({ id, params }) => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.rustPdfHandles.get(app.activeKey).command(id, params); }, { id, params });
async function check(name, work) { await work(); report.checks.push(name); persist(); }
async function shot(name) { const file = name + '.png'; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); persist(); }
async function canvasBox() { const box = await page.getByTestId('pdf-canvas').boundingBox(); assert.ok(box, 'Live PDF canvas must be mounted'); return box; }
async function click(x, y, label) { report.clicks.push({ label, x, y }); await page.mouse.click(x, y); await frames(4); }
async function toolbar(id) {
  const ui = await state(), item = ui.toolbar.find(item => item.id === id);
  assert.ok(item?.enabled, `${id} is available`);
  const box = await canvasBox(), [x, y, width, height] = item.rect;
  const rect = { x: box.x + x, y: box.y + y, width, height };
  await click(rect.x + width / 2, rect.y + height / 2, 'toolbar:' + id);
  return rect;
}
async function waitTool(tool) { return wait(async tool => { const app = document.querySelector('#app').__vue_app__._instance.setupState; const ui = await app.rustPdfHandles.get(app.activeKey).query('ui.state'); return ui.quick_tool === tool ? ui : null; }, tool); }
async function pagePoint(xFraction, yFraction) {
  const ui = await state(), shown = ui.active.pages_on_screen.find(p => p.page === ui.active.page);
  assert.ok(shown, 'Current PDF page must be visible');
  const box = await canvasBox(), [x0, y0, x1, y1] = shown.rect;
  return { x: box.x + x0 + (x1 - x0) * xFraction, y: box.y + y0 + (y1 - y0) * yFraction };
}
async function escape() { await page.keyboard.press('Escape'); await frames(4); }
// Locate the enabled blue confirmation button in the lower half of the actual modal.
// This avoids guessing a button coordinate or using a model mutation to accept the dialog.
async function confirmModal(label) {
  const box = await canvasBox(), png = PNG.sync.read(await page.screenshot());
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  let best = null;
  for (let y = Math.max(0, Math.floor(center.y)); y < Math.min(png.height, Math.ceil(center.y + 220)); y++) {
    let start = -1;
    for (let x = Math.max(0, Math.floor(center.x - 300)); x <= Math.min(png.width - 1, Math.ceil(center.x + 300)); x++) {
      const p = (y * png.width + x) * 4, blue = png.data[p] < 90 && png.data[p + 1] >= 60 && png.data[p + 1] < 165 && png.data[p + 2] > 180;
      if (blue && start < 0) start = x;
      if ((!blue || x === Math.min(png.width - 1, Math.ceil(center.x + 300))) && start >= 0) {
        const width = x - start;
        if (width >= 25 && (!best || width > best.width)) best = { x: start + width / 2, y, width };
        start = -1;
      }
    }
  }
  assert.ok(best, 'Enabled confirmation button must be visibly painted');
  await click(best.x, best.y + 3, label);
}
async function exportPdf(name) {
  const exported = await page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.nativeTransactionalEditor(app.rustPdfHandles.get(app.activeKey)).exportFile({ format: 'pdf' }); });
  fs.writeFileSync(path.join(output, name), Buffer.from(exported.base64, 'base64'));
  return exported;
}
function readPdf(name) {
  const source = 'import json,sys,fitz\nwith fitz.open(sys.argv[1]) as doc:\n print(json.dumps({"pages":doc.page_count,"annotations":[{"page":i+1,"type":a.type[1],"rect":list(a.rect)} for i,p in enumerate(doc) for a in (p.annots() or [])]}))\n';
  return JSON.parse(execFileSync('python3', ['-c', source, path.join(output, name)], { encoding: 'utf8' }));
}
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-pdf.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productsBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_PDF_TOOLBAR_PORT || 5314), strictPort: true, hmr: false,
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN', deviceScaleFactor: 1 });
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(origin); await page.locator('.create-card.pdf').click();
    await wait(async () => { const app = document.querySelector('#app')?.__vue_app__?._instance.setupState; if (!app?.active?.ready) return false; const h = app.rustPdfHandles.get(app.activeKey); return h && (await h.query('ui.state')).toolbar?.length > 0; });
    await page.getByTestId('theme-light').click(); await frames(8);
    await check('primary-toolbar-wraps-within-320-480-850-1280', async () => {
      for (const width of [320, 480, 850, 1280]) {
        await page.setViewportSize({ width, height: 1000 }); await frames(10);
        const box = await canvasBox(), ui = await state();
        assert.ok(box.width <= width + 1, `Shell canvas fits ${width}`);
        for (const id of ['select', 'hand', 'edit.edit_text', 'edit.text', 'comment.highlight', 'annotations', 'signature', 'stamps', 'view', 'advanced', 'edit.find', 'edit.undo', 'edit.redo']) {
          assert.ok(ui.toolbar.some(item => item.id === id), `${width}: ${id}`);
        }
        for (const entry of ui.toolbar) {
          const id = entry.id;
          const [x, y, w, h] = entry.rect;
          assert.ok(x >= 0 && x + w <= box.width + 1 && y >= 0 && y + h < 210, `${width}: ${id} overflows ${JSON.stringify(entry.rect)}`);
        }
        assert.equal(ui.left_panel, null, 'Default tools do not consume page width');
        report.layouts.push({ width, canvas: box, toolbar: ui.toolbar }); await shot('toolbar-' + width);
      }
      await toolbar('edit.edit_text'); await waitTool('edit-text');
      await toolbar('edit.text'); await waitTool('add-text');
      await toolbar('select'); await waitTool('select');
      await toolbar('hand'); await waitTool('hand');
      await toolbar('select'); await waitTool('select');
      assert.equal((await inspect()).dirty, false, 'Tool selection alone must not edit the file');
    });
    await check('advanced-and-view-menus-are-usable', async () => {
      const advanced = await toolbar('advanced'); await shot('advanced-menu');
      await page.mouse.move(advanced.x + 45, advanced.y + advanced.height + 16); await frames(16);
      await shot('advanced-page-submenu'); await escape(); await escape();
      const view = await toolbar('view'); await shot('view-menu');
      await click(view.x + 40, view.y + view.height + 39, 'view:fit-width');
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).query('ui.state')).active.fit === 'Width'; });
      const viewAgain = await toolbar('view');
      await click(viewAgain.x + 40, viewAgain.y + viewAgain.height + 15, 'view:fit-page');
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).query('ui.state')).active.fit === 'Page'; });
    });
    await check('handwritten-signature-uses-real-menu-and-pointer', async () => {
      const signature = await toolbar('signature'); await shot('signature-menu');
      await click(signature.x + 75, signature.y + signature.height + 65, 'signature:add');
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).query('ui.state')).dialog === 'Signature'; });
      await shot('signature-handwriting-dialog');
      const box = await canvasBox(), center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(center.x - 160, center.y + 15); await page.mouse.down(); await frames(2);
      for (let index = 1; index <= 12; index++) { await page.mouse.move(center.x - 160 + index * 20, center.y + (index % 2 ? -12 : 25)); await frames(1); }
      await page.mouse.up(); await frames(4); await shot('signature-drawn-before-apply');
      await confirmModal('signature:apply');
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).query('ui.state')).dialog === null; });
      await waitTool('fill-signature');
      const point = await pagePoint(.25, .35); await click(point.x, point.y, 'signature:place-on-page');
      await waitTool('select'); await shot('signature-placed');
      await exportPdf('signature.pdf'); report.signatureReadback = readPdf('signature.pdf');
      assert.equal(report.signatureReadback.annotations.filter(a => a.type === 'Ink').length, 1);
    });
    await check('standard-stamp-uses-menu-and-real-page-placement', async () => {
      const stamp = await toolbar('stamps'); await shot('stamp-menu');
      await page.mouse.move(stamp.x + 80, stamp.y + stamp.height + 74); await frames(16); await shot('stamp-standard-submenu');
      await click(stamp.x + 350, stamp.y + stamp.height + 74, 'stamp:approved');
      await waitTool('stamp-approved');
      const point = await pagePoint(.5, .55); await click(point.x, point.y, 'stamp:place-on-page');
      await waitTool('select'); await shot('signature-and-stamp');
      await exportPdf('signed-and-stamped.pdf'); report.annotationReadback = readPdf('signed-and-stamped.pdf');
      assert.equal(report.annotationReadback.annotations.filter(a => a.type === 'Ink').length, 1);
      assert.equal(report.annotationReadback.annotations.filter(a => a.type === 'Stamp').length, 1);
    });
    await check('delete-cancel-confirm-undo-keeps-content-and-save-barrier', async () => {
      await command('page.insert_blank'); assert.equal((await inspect()).pageCount, 2);
      await command('page.delete'); await frames(4); const prompt = await state(); assert.ok(prompt.deletePrompt);
      assert.equal((await inspect()).pageCount, 2);
      assert.equal(await page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.rustPdfHandles.get(app.activeKey).canBackgroundExport(); }), false);
      await shot('delete-confirmation'); await command('ui.delete.cancel');
      assert.equal((await inspect()).pageCount, 2); assert.equal((await state()).deletePrompt, null);
      await command('page.delete'); await frames(4); await confirmModal('delete:confirm');
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).inspect()).pageCount === 1; });
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await wait(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return (await app.rustPdfHandles.get(app.activeKey).inspect()).pageCount === 2; });
    });
    await check('signed-stamped-export-reopens-in-the-real-pdf-editor', async () => {
      const exported = await exportPdf('final.pdf'); report.finalReadback = readPdf('final.pdf');
      await page.evaluate(async exported => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        await app.editorTransaction('验证 PDF 重开', () => app.addDocument({ id: '', kind: 'pdf', extension: 'pdf', name: '重开签名图章.pdf', base64: exported.base64, sha256: '', sizeBytes: Math.floor(exported.base64.length * .75) }));
        await app.awaitReady(app.active);
      }, exported);
      await frames(8); assert.equal((await inspect()).pageCount, 2);
      await exportPdf('reopened.pdf'); report.reopenedReadback = readPdf('reopened.pdf');
      assert.deepEqual(report.reopenedReadback, report.finalReadback);
      assert.ok(report.finalReadback.annotations.some(a => a.type === 'Ink'));
      assert.ok(report.finalReadback.annotations.some(a => a.type === 'Stamp'));
      await shot('reopened-signature-and-stamp');
    });
    await page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; for (const tab of [...app.tabs]) await app.removeTab(tab, true); });
    await frames(4); report.cleanup = { canvas: await page.getByTestId('pdf-canvas').count(), input: await page.getByTestId('pdf-input').count() };
    assert.deepEqual(report.cleanup, { canvas: 0, input: 0 });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.productsAfter = hashes(); assert.deepEqual(report.productsAfter, report.productsBefore); report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); if (page) { report.lastState = await state().catch(() => null); await shot('failure').catch(() => {}); } process.exitCode = 1;
  } finally { report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close(); }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
