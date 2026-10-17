/* Real Note canvas pointer input. No native OS input or filesystem claims.
 * Run: node tests/browser/notebook-alignment.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_NOTE_ALIGNMENT_OUTPUT || path.join(root, 'test-results/notebook-alignment'));
const report = { ok: false, runtime: 'Real Vue Note canvas in Chromium, with Playwright mouse and keyboard events', checks: [], screenshots: [], errors: [], consoleErrors: [], externalRequests: [], limitations: ['Native platform pointer and operating-system IME input are not exercised.', 'Document import and export use browser file input and the real editor export handler.'] };
const sourceFiles = ['src/components/NotebookCanvas.vue', 'src/components/NotebookEditor.vue', 'src/notes/layout.ts', 'src/notes/snapping.ts'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const note = () => page.getByTestId('notebook-editor');
const canvas = () => note().getByTestId('notebook-canvas');
const viewport = () => note().locator('.note-canvas-container');
const region = id => note().locator(`[data-region-id="${id}"]`);
const guides = () => note().locator('.note-alignment-guide');
const toggle = label => note().getByRole('button', { name: label, exact: true });
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function capture(name) { const file = `${report.screenshots.length + 1}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); persist(); }
async function check(name, fn) { report.stage = name; persist(); await fn(); report.checks.push(name); persist(); }
async function settings(smart, grid) {
  for (const [label, wanted] of [['智能对齐', smart], ['网格吸附', grid]]) {
    if ((await toggle(label).getAttribute('aria-pressed')) !== String(wanted)) await toggle(label).click();
    assert.equal(await toggle(label).getAttribute('aria-pressed'), String(wanted));
  }
}
async function model() {
  return page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const value = await app.noteHandles.get(app.activeKey).exportFile({ format: 'oonote', background: true });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))));
  });
}
const regions = async () => (await model()).sections[0].pages[0].regions;
async function state() { return page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.noteHandles.get(app.activeKey).inspect(); }); }
async function beginDrag(id, dx, dy, kind = 'move') {
  await region(id).getByTestId('notebook-content').click();
  const handle = region(id).locator(`.note-region-${kind}`); await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); assert.ok(box);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await frame();
  return { x: x + dx, y: y + dy };
}
async function endDrag() { await page.mouse.up(); await frame(); assert.equal(await guides().count(), 0, 'Guides disappear when the move finishes'); }
async function undoTo(expected) { await note().getByRole('button', { name: '撤销', exact: true }).click(); assert.deepEqual(await regions(), expected, 'One undo restores every region exactly'); }
async function livePosition(id) { return region(id).evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) })); }
async function scrollPosition() { return viewport().evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop })); }
async function resetViewport() { await viewport().evaluate(element => element.scrollTo(0, 0)); await frame(); }
async function scrollWithHeldPointer(dx, dy) {
  const before = await scrollPosition(); await page.mouse.wheel(dx, dy);
  await page.waitForFunction(({ before, dx, dy }) => { const element = document.querySelector('.note-canvas-container'); return (dx !== 0 && element.scrollLeft !== before.x) || (dy !== 0 && element.scrollTop !== before.y); }, { before, dx, dy });
  await frame(); const after = await scrollPosition(); return { x: after.x - before.x, y: after.y - before.y };
}
async function xGuide(position) {
  const values = await guides().evaluateAll(elements => elements.map(element => ({ axis: element.dataset.axis, position: Number(element.dataset.position) })));
  assert.ok(values.some(value => value.axis === 'x' && Math.abs(value.position - position) < .1), `Expected vertical guide at ${position}: ${JSON.stringify(values)}`);
}
const paragraph = (id, text) => ({ id, type: 'paragraph', content: [{ text }] });
const fixture = { format: 'open-office-notebook', version: 2, id: 'alignment_book', title: '自由布局与辅助对齐', sections: [{ id: 'alignment_section', title: '布局验证', pages: [{ id: 'alignment_page', title: '拖动对齐与网格吸附', regions: [
  { id: 'reference_region', x: 63, y: 80, width: 240, height: 120, blocks: [paragraph('reference_text', '参考区域\n保留原有位置与内容')] },
  { id: 'moving_region', x: 420, y: 250, width: 180, height: 80, blocks: [paragraph('moving_text', '拖动这块区域')] },
  { id: 'third_region', x: 140, y: 480, width: 180, height: 100, blocks: [paragraph('third_text', '独立区域不会被重新排版')] },
  { id: 'distant_region', x: 1500, y: 1400, width: 180, height: 100, blocks: [paragraph('distant_text', '远处的自由布局区域')] },
] }] }] };

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: Number(process.env.OFFICE_NOTE_ALIGNMENT_PORT || 5318), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN' });
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(origin);
    await page.getByTestId('document-open-input').setInputFiles({ name: '布局辅助验证.oonote', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await page.waitForFunction(() => { const app = document.querySelector('#app')?.__vue_app__?._instance.setupState; return app && !app.busy && app.active?.ready && app.active.document.kind === 'note'; });
    await region('moving_region').waitFor(); await frame();
    const initial = await regions();
    await check('grid-and-guide-settings-are-view-preferences-without-dirtying-content', async () => {
      const before = await state();
      assert.equal(await toggle('智能对齐').getAttribute('aria-pressed'), 'true');
      assert.equal(await toggle('网格吸附').getAttribute('aria-pressed'), 'true');
      await settings(false, false); await settings(true, true);
      const after = await state(); assert.equal(after.revision, before.revision); assert.equal(after.dirty, before.dirty); assert.deepEqual(await regions(), initial);
    });
    await check('pointer-drag-snaps-to-ten-pixel-grid-and-undo-restores-layout', async () => {
      await settings(false, true); await beginDrag('moving_region', 23, 36);
      assert.deepEqual(await livePosition('moving_region'), { x: 440, y: 290 });
      await endDrag(); const moved = await regions();
      assert.equal(moved[1].x, 440); assert.equal(moved[1].y, 290); assert.deepEqual(moved[0], initial[0]); assert.deepEqual(moved[2], initial[2]);
      await undoTo(initial);
    });
    await check('edge-alignment-overrides-grid-and-shows-only-live-guides', async () => {
      await settings(true, true); await beginDrag('moving_region', -353, 27);
      assert.deepEqual(await livePosition('moving_region'), { x: 63, y: 280 }); await xGuide(63); await capture('edge-alignment');
      await endDrag(); const moved = await regions(); assert.equal(moved[1].x, 63); assert.equal(moved[1].y, 280); assert.deepEqual(moved[1].blocks, initial[1].blocks);
      await undoTo(initial);
    });
    await check('center-alignment-works-between-regions-of-different-widths', async () => {
      await settings(true, false); await beginDrag('moving_region', -324, 80);
      assert.deepEqual(await livePosition('moving_region'), { x: 93, y: 330 }); await xGuide(183); await capture('center-alignment');
      await endDrag(); const moved = await regions(); assert.equal(moved[1].x, 93); assert.deepEqual(moved[0], initial[0]); assert.deepEqual(moved[2], initial[2]); await undoTo(initial);
    });
    await check('alt-drag-and-disabled-toggles-allow-free-placement', async () => {
      await settings(true, true); await page.keyboard.down('Alt');
      try { await beginDrag('moving_region', -353, 27); assert.deepEqual(await livePosition('moving_region'), { x: 67, y: 277 }); assert.equal(await guides().count(), 0); await endDrag(); } finally { await page.keyboard.up('Alt'); }
      await undoTo(initial);
      await settings(false, false); await beginDrag('moving_region', -353, 27); assert.deepEqual(await livePosition('moving_region'), { x: 67, y: 277 }); assert.equal(await guides().count(), 0); await endDrag(); await undoTo(initial);
    });
    await check('escape-cancels-a-snapped-move-without-adding-history', async () => {
      await settings(true, true); const before = await state();
      await beginDrag('moving_region', -353, 27); await xGuide(63); await page.keyboard.press('Escape'); await page.mouse.up(); await frame();
      assert.equal(await guides().count(), 0); assert.deepEqual(await regions(), initial); const after = await state(); assert.equal(after.revision, before.revision); assert.equal(after.canUndo, before.canUndo);
    });
    await check('stationary-alt-toggle-updates-preview-and-handle-click-does-not-snap', async () => {
      await settings(true, true); const before = await state();
      await beginDrag('moving_region', 0, 0); await endDrag(); assert.deepEqual(await regions(), initial); assert.equal((await state()).revision, before.revision);
      await beginDrag('moving_region', -353, 27); await xGuide(63);
      await page.keyboard.down('Alt'); await frame(); assert.deepEqual(await livePosition('moving_region'), { x: 67, y: 277 }); assert.equal(await guides().count(), 0);
      await page.keyboard.up('Alt'); await frame(); assert.deepEqual(await livePosition('moving_region'), { x: 63, y: 280 }); await xGuide(63);
      await endDrag(); await undoTo(initial);
    });
    await check('scaled-canvas-translates-screen-pointer-movement-to-document-coordinates', async () => {
      await settings(false, false);
      // A browser-applied scale exercises coordinate conversion; this is not a native zoom-control claim.
      await canvas().evaluate(element => { element.style.zoom = '1.25'; }); await frame();
      await beginDrag('moving_region', 25, 50); assert.deepEqual(await livePosition('moving_region'), { x: 440, y: 290 });
      await endDrag(); await undoTo(initial);
      await canvas().evaluate(element => { element.style.zoom = ''; }); await resetViewport();
    });
    await check('wheel-scroll-under-stationary-held-pointer-keeps-move-and-resize-aligned', async () => {
      await page.setViewportSize({ width: 1440, height: 720 }); await settings(false, false); await resetViewport();
      await beginDrag('moving_region', 10, 10); const moveScroll = await scrollWithHeldPointer(0, 80);
      assert.deepEqual(await livePosition('moving_region'), { x: 430 + moveScroll.x, y: 260 + moveScroll.y });
      await endDrag(); const moved = (await regions())[1]; assert.equal(moved.x, 430 + moveScroll.x); assert.equal(moved.y, 260 + moveScroll.y); await undoTo(initial); await resetViewport();
      await beginDrag('moving_region', 20, 0, 'resize'); const resizeScroll = await scrollWithHeldPointer(80, 0);
      assert.equal(await region('moving_region').evaluate(element => parseFloat(element.style.width)), 200 + resizeScroll.x);
      await endDrag(); const resized = (await regions())[1]; assert.equal(resized.width, 200 + resizeScroll.x); assert.equal(resized.x, initial[1].x); assert.equal(resized.y, initial[1].y); await undoTo(initial); await resetViewport();
    });
    await check('inward-drag-at-scroll-boundary-does-not-cascade-with-shrinking-extent', async () => {
      await settings(false, false);
      await viewport().evaluate(element => element.scrollTo(element.scrollWidth, element.scrollHeight)); await frame();
      await beginDrag('distant_region', -12, -10); await frame(); await frame();
      assert.deepEqual(await livePosition('distant_region'), { x: 1488, y: 1390 });
      await endDrag(); const moved = (await regions())[3]; assert.equal(moved.x, 1488); assert.equal(moved.y, 1390); await undoTo(initial);
      await page.setViewportSize({ width: 1440, height: 1080 }); await resetViewport();
    });
    await check('selection-borders-stay-hidden-after-blank-canvas-click', async () => {
      await region('moving_region').getByTestId('notebook-content').click(); assert.equal(await note().locator('.note-region.selected').count(), 1);
      await canvas().click({ position: { x: 710, y: 530 } }); await frame();
      assert.equal(await note().locator('.note-region.selected').count(), 0); assert.equal(await guides().count(), 0);
      for (const id of ['reference_region', 'moving_region', 'third_region']) {
        assert.equal(await region(id).evaluate(element => getComputedStyle(element).borderTopColor), 'rgba(0, 0, 0, 0)');
        assert.equal(await region(id).locator('.note-region-controls').evaluate(element => getComputedStyle(element).visibility), 'hidden');
      }
      assert.deepEqual(await regions(), initial); await capture('blank-selection-cleared');
    });
    report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Note source stayed fixed throughout this browser run');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.ok = true; report.finishedAt = new Date().toISOString();
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
    if (page && !page.isClosed()) { try { await capture('failure'); } catch {} }
  } finally { await browser?.close(); await server?.close(); persist(); console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message })); }
})();
