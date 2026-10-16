/* Actual Vue + Rust/WASM + browser input. Timings are diagnostic, not native benchmarks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PRESENTATION_CACHE_OUTPUT || path.join(root, 'test-results/presentation-render-cache'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Chromium + actual Rust/WASM; software GPU timings are not macOS native timings', checks: [], switches: [], requests: [], errors: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = text => { report.checks.push(text); console.log(text); };
let server, browser, page, measuring = false;

const inspect = () => page.evaluate(async () => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  return app.rustPresentationHandles.get(app.activeKey).inspect();
});
const query = (id, params = {}) => page.evaluate(async ({ id, params }) => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  return app.rustPresentationHandles.get(app.activeKey).query(id, params);
}, { id, params });
const command = (id, params = {}) => page.evaluate(async ({ id, params }) => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  return app.rustPresentationHandles.get(app.activeKey).command(id, params);
}, { id, params });
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function waitState(predicate, message) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const state = await inspect();
    if (predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw Error(message);
}
async function create() {
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-presentation').click();
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    if (app?.active?.loadError) throw Error(app.active.loadError);
    return app?.active?.ready && !app.busy;
  }, null, { timeout: 120000 });
  await paint();
}
async function canvasPoint(x, y, state = undefined) {
  state ??= await inspect();
  const box = await page.getByTestId('office-presentation-canvas').boundingBox();
  const [width, height] = state.ui.window;
  assert.ok(box && width > 0 && height > 0);
  return { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
}
async function clickSlide(index, record = false) {
  const before = await inspect();
  // Normal-view thumbnail rows: 8px top padding, 16px row padding and egui's 4px gap.
  // Derive thumbnail size from the real layout, rather than screen coordinates.
  const width = before.ui.ui.thumbsWidth ?? before.ui.ui.thumbs_width ?? before.ui.canvasRect[0];
  const thumbHeight = (width - 40) * 540 / 960;
  const point = await canvasPoint(width / 2, before.ui.canvasRect[1] + 8 + (thumbHeight + 20) * index + (thumbHeight + 16) / 2, before);
  const started = await page.evaluate(() => performance.now());
  await page.mouse.click(point.x, point.y);
  await waitState(state => state.activeSlide === index, `Real thumbnail click did not activate slide ${index}`);
  await paint();
  const after = await inspect();
  if (record) report.switches.push({ index, elapsedMs: await page.evaluate(() => performance.now()) - started,
    rendersBefore: before.ui.perf.canvasRenders, rendersAfter: after.ui.perf.canvasRenders, cachedPages: after.ui.perf.canvasCachedPages });
  return after;
}
async function slidePicture(name) {
  await paint();
  const state = await inspect();
  const [x, y, width, height] = state.ui.slideRect;
  const top = await canvasPoint(x + 1, y + 1, state), bottom = await canvasPoint(x + width - 1, y + height - 1, state);
  const bytes = await page.screenshot({ path: path.join(output, `${name}.png`), clip: {
    x: top.x, y: top.y, width: bottom.x - top.x, height: bottom.y - top.y,
  } });
  return digest(bytes);
}

(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, ['scripts/build-office-presentation.mjs', '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.artifact = JSON.parse(fs.readFileSync(path.join(root, 'public/office-presentation/manifest.json')));
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: 0, strictPort: false, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 920 }, locale: 'zh-CN', colorScheme: 'light' });
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (measuring) report.requests.push({ url: request.url(), type: request.resourceType() }); });
    await page.addInitScript(() => {
      window.__cacheProbe = { enabled: false, textureUploads: 0, longTasks: [] };
      const patched = new Set();
      for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!Type || patched.has(Type.prototype)) continue;
        patched.add(Type.prototype);
        const original = Type.prototype.texImage2D;
        Type.prototype.texImage2D = function (...args) {
          if (window.__cacheProbe.enabled) window.__cacheProbe.textureUploads++;
          return original.apply(this, args);
        };
      }
      new PerformanceObserver(list => {
        if (window.__cacheProbe.enabled) window.__cacheProbe.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
      }).observe({ type: 'longtask', buffered: false });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
    await create();
    await page.waitForTimeout(1500);
    const first = await inspect();
    assert.equal(first.slides.length, 3);
    assert.ok(Number.isSafeInteger(first.ui.perf.canvasRenders), 'Current WASM exposes the actual canvas render counter');
    measuring = true;
    await page.evaluate(() => { window.__cacheProbe.enabled = true; });
    for (const index of [1, 2, 0, 1, 2, 0]) await clickSlide(index, true);
    measuring = false;
    report.renderProbe = await page.evaluate(() => { window.__cacheProbe.enabled = false; return window.__cacheProbe; });
    assert.deepEqual(report.switches.slice(3).map(item => item.rendersAfter - item.rendersBefore), [0, 0, 0]);
    assert.ok(report.switches.at(-1).rendersAfter - first.ui.perf.canvasRenders <= 2, 'Only the two previously unseen pages need rasterizing');
    assert.ok(report.renderProbe.textureUploads < 6, 'Six switches upload fewer than six complete textures');
    assert.equal(report.requests.filter(request => ['image', 'font', 'fetch', 'xhr'].includes(request.type)).length, 0, 'Switching warmed slides fetches no new document resources');
    check('Six real thumbnail clicks reuse visited pages without repainting them or reloading resources');

    const originalHash = await slidePicture('original');
    const title = (await query('slide.inspect', { index: 0 })).shapes.find(shape => shape.text === 'Open Office 演示');
    assert.ok(title);
    const state = await inspect(), [sx, sy] = state.ui.slideRect, scale = state.ui.canvasScale;
    const [x, y, w, h] = title.box;
    const point = await canvasPoint(sx + (x + w * .3) * scale, sy + (y + h * .4) * scale, state);
    await page.mouse.dblclick(point.x, point.y, { delay: 120 });
    await waitState(value => value.selection.text != null, 'Double-clicking the title enters real text editing');
    await page.getByTestId('office-presentation-input').focus();
    await page.keyboard.insertText('CACHE VERIFIED');
    await waitState(value => value.revision > state.revision, 'Real browser input changes the document');
    assert.match((await query('text.get', { id: title.id })).text, /CACHE VERIFIED/);
    await page.keyboard.press('Escape');
    await clickSlide(1); await clickSlide(0);
    const editedHash = await slidePicture('edited-return');
    assert.notEqual(editedHash, originalHash, 'Returning to an edited page displays changed pixels rather than the prior texture');
    const editedState = await inspect();
    await clickSlide(1); const editedHit = await clickSlide(0);
    assert.equal(editedHit.ui.perf.canvasRenders, editedState.ui.perf.canvasRenders, 'The updated page is cached after its first redraw');
    assert.equal(await slidePicture('edited-hit'), editedHash, 'Cached pixels retain the actual edited appearance');
    check('Real title input invalidates old pixels; the updated page remains correct on subsequent cache hits');

    const originalKey = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey);
    await create();
    assert.equal(await slidePicture('second-document'), originalHash, 'A new document does not inherit the first document’s edited texture');
    await page.evaluate(async key => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      await app.activate(app.tabs.find(tab => tab.key === key));
    }, originalKey);
    await waitState(value => value.documentId === editedState.documentId, 'Original document reactivates');
    assert.equal(await slidePicture('original-document-return'), editedHash);
    await command('edit.undo');
    assert.equal((await query('text.get', { id: title.id })).text, title.text);
    await clickSlide(1); await clickSlide(0);
    assert.equal(await slidePicture('undo-return'), originalHash, 'Undo restores both document text and rendered pixels');
    check('Document switching and undo invalidate incompatible cached pictures without losing edits');

    await command('slide.new', { at: 3, layout: 'blank' });
    await command('slide.new', { at: 4, layout: 'blank' });
    for (const index of [0, 1, 2, 3, 0, 4]) await clickSlide(index);
    const full = await inspect();
    assert.equal(full.ui.perf.canvasCachedPages, 4);
    assert.ok(full.ui.perf.canvasCachedBytes <= 64 * 1024 * 1024);
    const retained = await clickSlide(0);
    assert.equal(retained.ui.perf.canvasRenders, full.ui.perf.canvasRenders, 'Recently visited slide remains cached');
    const evicted = await clickSlide(1);
    assert.ok(evicted.ui.perf.canvasRenders > retained.ui.perf.canvasRenders, 'Least recently used fifth page is rendered again after eviction');
    assert.equal(evicted.ui.perf.canvasCachedPages, 4);
    report.cacheBounds = evicted.ui.perf;
    check('Five pages obey the four-page / 64 MiB budget and evict the least recently used page');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server?.close();
  }
})();
