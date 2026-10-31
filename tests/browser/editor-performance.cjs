/* Real Vue + Rust/WASM performance probe. Software-GPU Chromium timings are
 * diagnostic, not installed macOS/Windows benchmarks. No polling of inspect()
 * occurs inside a measured interaction: snapshots can themselves be expensive.
 * OFFICE_EDITOR_PERF_FIXTURES optionally selects representative .pdf/.pptx files.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_EDITOR_PERF_OUTPUT || path.join(root, 'test-results/editor-performance'));
const artifactRoot = path.resolve(process.env.OFFICE_EDITOR_PERF_ARTIFACT_ROOT || path.join(root, 'public'));
const settleMs = Number(process.env.OFFICE_EDITOR_PERF_SETTLE_MS || 500);
assert.ok(Number.isFinite(settleMs) && settleMs >= 400, 'Allow deferred exact-resolution rendering to finish');
const requireCache = process.env.OFFICE_EDITOR_PERF_REQUIRE_CACHE === '1';
const kinds = (process.env.OFFICE_EDITOR_PERF_KINDS || 'presentation,pdf').split(',');
assert.ok(kinds.every(kind => ['presentation', 'pdf'].includes(kind)));
fs.mkdirSync(output, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { ok: false, startedAt: new Date().toISOString(), runtime: 'Chromium + actual Vue/Rust-WASM, software GPU',
  limitations: ['Timings include browser protocol/input delivery and are not native OS benchmarks.', 'Snapshots are taken only outside measured interactions.',
    'Default fixtures are small smoke documents; OFFICE_EDITOR_PERF_FIXTURES selects richer representative documents.'],
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  probeSha256: hash(__filename), artifactRoot, settleMs, requireCache, kinds: [], errors: [], consoleErrors: [] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let server, browser, page, kind;
const canvasId = () => kind === 'pdf' ? 'pdf-canvas' : 'office-presentation-canvas';
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const inspect = () => page.evaluate(async () => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return app.handleFor(app.active).inspect(); });
async function documentPicture(snapshot) {
  const canvas = await page.getByTestId(canvasId()).boundingBox(); assert.ok(canvas);
  const rect = kind === 'presentation' ? snapshot.ui.slideRect : snapshot.ui.active.pages_on_screen[0].rect;
  const [x, y] = rect, width = kind === 'presentation' ? rect[2] : rect[2] - x, height = kind === 'presentation' ? rect[3] : rect[3] - y;
  const left = Math.ceil(canvas.x + Math.max(0, x) + 2), top = Math.ceil(canvas.y + Math.max(0, y) + 2);
  const right = Math.floor(canvas.x + Math.min(canvas.width, x + width) - 2), bottom = Math.floor(canvas.y + Math.min(canvas.height, y + height) - 2);
  assert.ok(right > left && bottom > top);
  const bytes = await page.screenshot({ clip: { x: left, y: top, width: right - left, height: bottom - top } });
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width: right - left, height: bottom - top };
}
async function record(name, action) {
  await frames();
  const before = await inspect();
  await page.evaluate(() => { window.__editorPerf.current = { start: performance.now(), rafMs: [], uploads: 0, resizeEvents: 0, canvasResizes: [], longTasks: [], events: [] }; });
  await action(before);
  await frames();
  // Include the editors' deferred exact-resolution render after resize/zoom.
  // Two RAFs alone can observe only the temporary rescaled preview. Keep this
  // identical before/after, and include the tail in long-task/upload totals.
  await page.waitForTimeout(settleMs);
  await frames();
  const data = await page.evaluate(() => { const value = window.__editorPerf.current; value.elapsedMs = performance.now() - value.start; window.__editorPerf.current = null; return value; });
  const after = await inspect();
  if (after.ui?.perf?.canvasResizePending !== undefined) assert.equal(after.ui.perf.canvasResizePending, false, `${name}: final slide pixels are ready`);
  if (after.ui?.active?.raster_memory?.visible_rasters_pending !== undefined) {
    assert.equal(after.ui.active.raster_memory.visible_rasters_pending, 0, `${name}: final PDF pixels are ready`);
    assert.equal(after.ui.active.raster_memory.pending_requests, 0, `${name}: PDF raster requests have completed`);
    assert.deepEqual(after.ui.active.page_errors, [], `${name}: final PDF pages have no render errors`);
  }
  const sum = values => values.reduce((total, value) => total + value, 0);
  const durations = data.rafMs.slice().sort((a, b) => a - b);
  const result = { name, settleMs, elapsedMs: data.elapsedMs, rafCallbacks: durations.length, rafTotalMs: sum(durations),
    rafMaxMs: Math.max(0, ...durations), rafP95Ms: durations[Math.floor(durations.length * .95)] || 0,
    longTaskCount: data.longTasks.length, longTaskTotalMs: sum(data.longTasks.map(item => item.duration)), longTasks: data.longTasks,
    uploads: data.uploads, resizeEvents: data.resizeEvents, canvasResizes: data.canvasResizes, events: data.events,
    before: { documentId: before.documentId, revision: before.revision, perf: before.ui?.perf, raster: before.ui?.active?.raster_memory, activePage: before.activePage, activeSlide: before.activeSlide, zoom: before.ui?.active?.zoom_percent ?? before.ui?.ui?.zoom, canvasScale: before.ui?.canvasScale },
    after: { documentId: after.documentId, revision: after.revision, perf: after.ui?.perf, raster: after.ui?.active?.raster_memory, activePage: after.activePage, activeSlide: after.activeSlide, zoom: after.ui?.active?.zoom_percent ?? after.ui?.ui?.zoom, canvasScale: after.ui?.canvasScale } };
  assert.equal(after.documentId, before.documentId, `${name} keeps document session`);
  assert.equal(after.revision, before.revision, `${name} does not edit content`);
  for (const key of ['dirty', 'canUndo', 'canRedo']) assert.equal(after[key], before[key], `${name} preserves ${key}`);
  if (requireCache && /^fullscreen-(enter|exit)-[12]$/.test(name)) {
    if (kind === 'presentation') {
      assert.equal(after.ui.perf.canvasResizePending, false);
      assert.equal(after.ui.perf.canvasRenders, before.ui.perf.canvasRenders, 'Warm fullscreen sizes reuse exact slide rasters');
    } else {
      assert.equal(after.ui.active.raster_memory.visible_rasters_pending, 0);
      assert.ok(Number.isSafeInteger(after.ui.active.raster_memory.page_uploads));
      assert.equal(after.ui.active.raster_memory.page_uploads, before.ui.active.raster_memory.page_uploads, 'Warm fullscreen sizes reuse exact PDF rasters');
    }
  }
  report.kinds.at(-1).measurements.push(result); persist();
  console.log(kind, name, JSON.stringify({ elapsedMs: Math.round(data.elapsedMs), rafMaxMs: Math.round(result.rafMaxMs), longTaskMs: Math.round(result.longTaskTotalMs), uploads: data.uploads }));
  return after;
}
async function fixture(selectedKind) {
  const custom = process.env.OFFICE_EDITOR_PERF_FIXTURES;
  if (custom) {
    const extension = selectedKind === 'pdf' ? '.pdf' : '.pptx';
    const file = fs.readdirSync(custom).find(name => name.endsWith(extension));
    assert.ok(file, `Missing ${extension} fixture in ${custom}`); return path.resolve(custom, file);
  }
  if (selectedKind === 'presentation') return path.join(root, 'tests/browser/fixtures/presentation.pptx');
  const file = path.join(output, 'performance.pdf');
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 12; index++) {
    const p = document.addPage([842, 595]);
    p.drawText(`Performance review ${index + 1}`, { x: 48, y: 530, size: 26, font });
    for (let row = 0; row < 14; row++) p.drawText(`Project ${row + 1}: plan, review, implement and validate.`, { x: 48, y: 480 - row * 28, size: 13, font });
    p.drawRectangle({ x: 550, y: 90, width: 210, height: 350, color: rgb(.8, .9, .95) });
  }
  fs.writeFileSync(file, await document.save()); return file;
}
(async () => {
  try {
    if (artifactRoot === path.join(root, 'public') && process.env.OFFICE_EDITOR_PERF_SKIP_ARTIFACT_CHECK !== '1') for (const name of kinds) execFileSync(process.execPath, [`scripts/build-office-${name}.mjs`, '--check'], { cwd: root, stdio: 'pipe' });
    // A retained distribution can serve the old WASM while the same Vue shell
    // and probe run both before/after. Verify every served engine asset first.
    for (const name of kinds) {
      const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, `office-${name}/manifest.json`)));
      for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hash(path.join(artifactRoot, `office-${name}`, file)), digest, `${name}/${file} matches its build manifest`);
    }
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      plugins: [{ name: 'performance-artifacts', configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url, 'http://localhost').pathname;
          if (!/^\/office-(?:pdf|presentation)\//.test(pathname)) return next();
          const file = path.resolve(artifactRoot, '.' + pathname);
          if (!file.startsWith(artifactRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.statusCode = 404; response.end(); return; }
          response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/json');
          fs.createReadStream(file).pipe(response);
        });
      } }], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen();
    for (kind of kinds) {
      const file = await fixture(kind);
      const entry = { kind, fixture: path.relative(root, file), fixtureSha256: hash(file), artifact: JSON.parse(fs.readFileSync(path.join(artifactRoot, `office-${kind}/manifest.json`))), measurements: [] };
      report.kinds.push(entry); persist();
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
      page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, locale: 'zh-CN', colorScheme: 'light' });
      page.setDefaultTimeout(120000);
      page.on('pageerror', error => report.errors.push({ kind, message: error.message }));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ kind, message: message.text() }); });
      await page.addInitScript(() => {
        const probe = window.__editorPerf = { current: null };
        const raf = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => raf.call(window, time => { const start = performance.now(), current = probe.current; try { return callback(time); } finally { if (current) current.rafMs.push(performance.now() - start); } });
        const patched = new Set();
        for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
          if (!Type || patched.has(Type.prototype)) continue; patched.add(Type.prototype);
          for (const method of ['texImage2D', 'texSubImage2D']) { const original = Type.prototype[method]; Type.prototype[method] = function (...args) { if (probe.current) probe.current.uploads++; return original.apply(this, args); }; }
        }
        for (const property of ['width', 'height']) {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
          Object.defineProperty(HTMLCanvasElement.prototype, property, { ...descriptor, set(value) { if (probe.current) probe.current.canvasResizes.push({ property, value }); return descriptor.set.call(this, value); } });
        }
        addEventListener('resize', () => { if (probe.current) probe.current.resizeEvents++; });
        new PerformanceObserver(list => { if (probe.current) probe.current.longTasks.push(...list.getEntries().filter(item => item.startTime >= probe.current.start).map(item => ({ start: item.startTime, duration: item.duration }))); }).observe({ type: 'longtask', buffered: false });
        try { new PerformanceObserver(list => { if (probe.current) probe.current.events.push(...list.getEntries().filter(item => item.startTime >= probe.current.start).map(item => ({ name: item.name, duration: item.duration, inputDelay: item.processingStart - item.startTime }))); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch {}
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
      await page.getByTestId('theme-light').click();
      await page.getByTestId('document-open-input').setInputFiles(file);
      await page.waitForFunction(() => { const app = document.querySelector('#app')?.__vue_app__?._instance.setupState; if (app?.active?.loadError) throw Error(app.active.loadError); return app?.active?.ready && !app.busy; });
      await page.waitForTimeout(1500); await frames();
      entry.initial = await inspect();
      const pictures = {};
      for (let iteration = 0; iteration < 3; iteration++) {
        const full = await record(`fullscreen-enter-${iteration}`, () => page.getByTestId('shell-focus-enter').click());
        assert.ok(await page.getByTestId('shell-focus-exit').isVisible());
        if (iteration === 0) pictures.full = await documentPicture(full);
        if (iteration === 2) assert.deepEqual(await documentPicture(full), pictures.full, 'Repeated fullscreen displays the same exact document pixels');
        const normal = await record(`fullscreen-exit-${iteration}`, () => page.getByTestId('shell-focus-exit').click());
        assert.ok(await page.getByTestId('shell-focus-enter').isVisible());
        if (iteration === 0) pictures.normal = await documentPicture(normal);
        if (iteration === 2) assert.deepEqual(await documentPicture(normal), pictures.normal, 'Returning to normal displays the same exact document pixels');
      }
      entry.fullscreenPictures = pictures;
      const box = await page.getByTestId(canvasId()).boundingBox(); assert.ok(box);
      await record('toolbar-hover', async () => { for (let index = 0; index < 30; index++) await page.mouse.move(box.x + 20 + index * 28, box.y + 18); });
      await record('scroll', async () => { await page.mouse.move(box.x + box.width * .65, box.y + box.height * .6); for (const delta of [300, 300, -300, -300]) { await page.mouse.wheel(0, delta); await frames(); } });
      if (kind === 'presentation') {
        await record('slide-switch', async before => {
          const width = before.ui.ui.thumbsWidth ?? before.ui.ui.thumbs_width ?? before.ui.canvasRect[0];
          const height = (width - 40) * 540 / 960;
          for (const index of [1, 0, 1, 0]) { await page.mouse.click(box.x + width / 2, box.y + before.ui.canvasRect[1] + 8 + (height + 20) * index + (height + 16) / 2); await frames(); }
        });
        await record('zoom', async () => { await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5); await page.keyboard.down('Control'); for (const delta of [-100, -100, 100, 100]) { await page.mouse.wheel(0, delta); await frames(); } await page.keyboard.up('Control'); });
      } else {
        await record('page-switch', async () => { for (const x of [108, 24, 108, 24]) { await page.mouse.click(box.x + x, box.y + 59); await frames(); } });
        await record('zoom', async () => { for (const x of [216, 216, 147, 147]) { await page.mouse.click(box.x + x, box.y + 59); await frames(); } });
      }
      // Verify the input targets outside timed windows: the measured navigation
      // sequence returns to its starting page and otherwise could hide a miss.
      if (kind === 'presentation') {
        const before = await inspect(), width = before.ui.ui.thumbsWidth ?? before.ui.canvasRect[0], height = (width - 40) * 540 / 960;
        await page.mouse.click(box.x + width / 2, box.y + before.ui.canvasRect[1] + 8 + height + 20 + (height + 16) / 2); await frames();
        assert.equal((await inspect()).activeSlide, 1, 'Real thumbnail target changes the active slide');
        await page.mouse.click(box.x + width / 2, box.y + before.ui.canvasRect[1] + 8 + (height + 16) / 2); await frames();
        assert.equal((await inspect()).activeSlide, 0);
        const oldZoom = (await inspect()).ui.canvasScale;
        await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control'); await frames();
        assert.notEqual((await inspect()).ui.canvasScale, oldZoom, 'Real Ctrl+wheel changes slide zoom');
      } else {
        await page.mouse.click(box.x + 108, box.y + 59); await frames();
        assert.equal((await inspect()).activePage, 1, 'Real next-page target changes the active page');
        await page.mouse.click(box.x + 24, box.y + 59); await frames();
        assert.equal((await inspect()).activePage, 0);
        const oldZoom = (await inspect()).ui.active.zoom_percent;
        await page.mouse.click(box.x + 216, box.y + 59); await frames();
        assert.ok((await inspect()).ui.active.zoom_percent > oldZoom, 'Real zoom button enlarges the PDF');
      }
      entry.inputTargetsVerified = true;
      await page.waitForTimeout(settleMs); await frames();
      entry.final = await inspect();
      await page.screenshot({ path: path.join(output, `${kind}-final.png`) });
      await browser.close(); browser = page = undefined; persist();
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
  } catch (error) { report.error = { kind, message: error.message, stack: error.stack }; process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  finally { await browser?.close(); await server?.close(); report.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ ok: report.ok, error: report.error?.message })); }
})();
