/* Real WorkflowEditor UI, session history and file/image exporters in Chromium.
 * Run: node tests/browser/workflow-rectangle-corners.cjs
 * No native file dialogs or installed platform WebViews are exercised.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_RECTANGLE_OUTPUT || path.join(root, 'test-results/workflow-rectangle-corners'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real WorkflowEditor, WorkflowSession and production exporters in Chromium', checks: [], errors: [], consoleErrors: [], limitations: ['No native file dialogs or installed platform WebView validation.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const model = () => page.evaluate(() => window.__rectEditor.value.inspectModel());
const state = () => page.evaluate(() => window.__rectEditor.value.inspect());
const input = () => page.getByTestId('shape-corner-radius');
const shapeNode = id => page.locator(`[data-element-id="${id}"]`);
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function load(doc) {
  await page.evaluate(async doc => {
    const { serializeDocument } = await import('/src/workflow/core/documents.ts');
    const { bytesToBase64 } = await import('/src/shared/document.ts');
    window.__rectNative.value = { id: crypto.randomUUID(), name: '圆角测试.owflow', kind: 'canvas', base64: bytesToBase64(new TextEncoder().encode(serializeDocument(doc))) };
    await window.__rectNextTick();
  }, doc);
  await page.getByTestId('canvas-stage').waitFor(); await frame();
}
async function empty() { const doc = await page.evaluate(async () => (await import('/src/workflow/core/documents.ts')).createDocument('board')); await load(doc); }
async function clickWorld(point) {
  const p = await screenPoint(point); await page.mouse.click(p.x, p.y); await frame();
}
async function screenPoint(point) {
  return page.locator('svg.scene-svg').evaluate((svg, point) => {
    const result = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM()); return { x: result.x, y: result.y };
  }, point);
}
async function draw(kind, from, to) {
  await page.getByTestId('tool-' + kind).click();
  const a = await screenPoint(from), b = await screenPoint(to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await frame();
  return (await model()).scene.elements.at(-1);
}
async function radius(value) { await input().fill(String(value)); await input().press('Tab'); await frame(); }
async function history(action) { await page.getByRole('button', { name: action === 'undo' ? '撤销' : '重做', exact: true }).click(); await frame(); }
async function exportFile(format = 'owflow') { return page.evaluate(format => window.__rectEditor.value.exportFile({ format }), format); }
async function save() { const output = await exportFile(); await page.evaluate(base64 => window.__rectEditor.value.markSaved(base64), output.base64); return output; }
function rgb(image, point) { const i = (Math.round(point.y) * image.width + Math.round(point.x)) * 4; return [...image.data.subarray(i, i + 3)]; }
const white = pixel => pixel.every(value => value > 245);
const filled = pixel => pixel[2] > pixel[0] + 40 && pixel[0] < 100;

(async () => {
  try {
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref, nextTick } from 'vue';
      import WorkflowEditor from '/src/components/WorkflowEditor.vue'; import '/src/style.css';
      window.__rectNative = ref({ id: 'initial', name: '圆角测试.owflow', kind: 'canvas' });
      window.__rectEditor = ref(); window.__rectNextTick = nextTick; window.__rectTheme = ref('light');
      createApp({ setup() { return () => h(WorkflowEditor, { key: window.__rectNative.value.id, ref: window.__rectEditor, document: window.__rectNative.value, theme: window.__rectTheme.value }); } }).mount('#rectangle-app');`;
    const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#rectangle-app{margin:0;width:100%;height:100%;overflow:hidden}#rectangle-app{display:flex}</style></head><body><div id="rectangle-app"></div><script type="module" src="/__rectangle_harness__.js"></script></body></html>';
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'rectangle-harness', resolveId(id) { if (id === '/__rectangle_harness__.js') return '\0rectangle-harness'; }, load(id) { if (id === '\0rectangle-harness') return harness; }, configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__rectangle__') return next(); response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_RECTANGLE_PORT || 5358), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(`${origin}/__rectangle__`); await page.getByTestId('canvas-stage').waitFor(); await frame();
    let rect;
    await check('new-canvas-defaults-to-grid-snap-and-straight-connectors', async () => {
      assert.equal(await page.getByRole('checkbox', { name: '吸附到网格' }).isChecked(), true);
      await page.getByTestId('edge-defaults-toggle').click();
      assert.equal(await page.getByTestId('default-route-straight').getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '关闭新建连线设置' }).click();
      const line = await draw('edge', { x: 153, y: 153 }, { x: 297, y: 257 });
      assert.equal(line.route, 'straight'); assert.deepEqual(line.from, { x: 160, y: 160 }); assert.deepEqual(line.to, { x: 300, y: 260 });
      await history('undo');
      rect = await draw('rectangle', { x: 153, y: 153 }, { x: 397, y: 297 });
      assert.deepEqual({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { x: 160, y: 160, width: 240, height: 140 });
      assert.equal(rect.cornerRadius ?? 0, 0); assert.equal(await input().inputValue(), '0');
      assert.equal(Number(await shapeNode(rect.id).locator('rect').first().getAttribute('rx')), 0);
    });
    await check('radius-change-commits-on-change-and-supports-history', async () => {
      await save(); const initial = await state();
      await input().fill('28.5');
      assert.equal((await model()).scene.elements[0].cornerRadius ?? 0, 0, 'Typing alone is pending, not a history entry');
      await input().press('Tab'); await frame();
      assert.equal((await model()).scene.elements[0].cornerRadius, 28.5); assert.equal((await state()).dirty, true);
      assert.equal((await state()).revision, initial.revision + 1);
      assert.equal(Number(await shapeNode(rect.id).locator('rect').first().getAttribute('rx')), 28.5);
      await history('undo'); assert.equal((await model()).scene.elements[0].cornerRadius ?? 0, 0); assert.equal((await state()).dirty, false);
      await history('redo'); assert.equal((await model()).scene.elements[0].cornerRadius, 28.5);
    });
    await check('radius-bounds-empty-input-and-zero-do-not-corrupt-state', async () => {
      await radius(10000); assert.equal((await model()).scene.elements[0].cornerRadius, 70);
      const before = await state(); await radius(''); assert.equal(await input().inputValue(), '70'); assert.equal((await state()).revision, before.revision);
      await radius(-12); assert.equal((await model()).scene.elements[0].cornerRadius ?? 0, 0); assert.equal(await input().inputValue(), '0');
      const zero = await state(); await radius(0); assert.equal((await state()).revision, zero.revision);
      await radius(32);
    });
    await check('save-and-reopen-retains-radius-and-a-clean-session', async () => {
      const saved = await save(), doc = JSON.parse(Buffer.from(saved.base64, 'base64'));
      assert.equal(doc.scene.elements[0].cornerRadius, 32); assert.equal((await state()).dirty, false);
      await load(doc); assert.equal((await state()).dirty, false); rect = (await model()).scene.elements[0];
      await shapeNode(rect.id).click(); assert.equal(await input().inputValue(), '32');
      const exported = await exportFile('svg'); assert.match(Buffer.from(exported.base64, 'base64').toString(), /rx="32"/);
    });
    await check('radius-control-is-rectangle-only-and-respects-locking', async () => {
      const doc = await model(); doc.scene.elements[0].locked = true; await load(doc); await shapeNode(rect.id).click(); assert.equal(await input().isDisabled(), true);
      doc.scene.elements[0].locked = false; doc.scene.elements[0].shape = 'ellipse'; delete doc.scene.elements[0].cornerRadius; await load(doc); await shapeNode(rect.id).click(); assert.equal(await input().count(), 0);
      doc.scene.elements[0].shape = 'rectangle'; doc.scene.elements[0].cornerRadius = 32; await load(doc); await shapeNode(rect.id).click(); assert.equal(await input().isEnabled(), true);
    });
    await check('real-canvas-svg-and-png-keep-rounded-corners-transparent', async () => {
      const doc = await model(); rect = doc.scene.elements[0]; rect.x = 100; rect.y = 100; rect.width = 240; rect.height = 160; rect.cornerRadius = 64; rect.style.fill = '#2563eb'; rect.style.strokeWidth = 0; doc.scene.grid = false;
      await load(doc);
      const probes = [{ x: 103, y: 103 }, { x: 220, y: 104 }, { x: 220, y: 180 }];
      const stage = page.getByTestId('canvas-stage'), bounds = await stage.boundingBox(), points = await Promise.all(probes.map(screenPoint));
      const screen = PNG.sync.read(await stage.screenshot({ path: path.join(output, 'rounded-canvas.png') }));
      const svg = await exportFile('svg'), png = await exportFile('png');
      fs.writeFileSync(path.join(output, 'rounded.svg'), Buffer.from(svg.base64, 'base64')); fs.writeFileSync(path.join(output, 'rounded-export.png'), Buffer.from(png.base64, 'base64'));
      const raster = PNG.sync.read(Buffer.from(png.base64, 'base64'));
      const dimensions = await page.evaluate(encoded => { const svg = new DOMParser().parseFromString(atob(encoded), 'image/svg+xml').documentElement; return svg.getAttribute('viewBox').split(/\s+/).map(Number); }, svg.base64);
      const [x, y, width, height] = dimensions;
      const canvasPixels = points.map(point => rgb(screen, { x: point.x - bounds.x, y: point.y - bounds.y }));
      const pngPixels = probes.map(point => rgb(raster, { x: (point.x - x) * raster.width / width, y: (point.y - y) * raster.height / height }));
      assert.ok(white(canvasPixels[0])); assert.ok(white(pngPixels[0]));
      for (const pixels of [canvasPixels, pngPixels]) for (const pixel of pixels.slice(1)) assert.ok(filled(pixel));
      report.pixelEvidence = { canvasPixels, pngPixels };
    });
    await check('resize-limits-visible-radius-and-keeps-an-editable-number', async () => {
      await shapeNode(rect.id).click();
      const handle = page.getByTestId('resize-handle'), target = await screenPoint({ x: rect.x + rect.width, y: rect.y + 40 }), bounds = await handle.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up(); await frame();
      const shrunk = (await model()).scene.elements[0]; assert.equal(shrunk.height, 40);
      assert.equal(Number(await shapeNode(rect.id).locator('rect').first().getAttribute('rx')), 20); assert.equal(await input().inputValue(), '20');
      await history('undo'); assert.equal(Number(await shapeNode(rect.id).locator('rect').first().getAttribute('rx')), 64);
    });
    await check('manual-folded-connector-and-unsnapped-drawing-override-defaults', async () => {
      await empty(); await page.getByRole('checkbox', { name: '吸附到网格' }).uncheck();
      const free = await draw('rectangle', { x: 153, y: 153 }, { x: 397, y: 297 });
      assert.ok(Math.abs(free.x - 153) < 1); assert.ok(Math.abs(free.y - 153) < 1); assert.ok(Math.abs(free.width - 244) < 1);
      await page.getByTestId('edge-defaults-toggle').click(); await page.getByTestId('default-route-orthogonal').click(); await page.getByRole('button', { name: '关闭新建连线设置' }).click();
      const line = await draw('edge', { x: 503, y: 333 }, { x: 697, y: 437 }); assert.equal(line.route, 'orthogonal');
      assert.ok(Math.abs(line.from.x - 503) < 1); assert.ok(Math.abs(line.to.y - 437) < 1);
    });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
    console.log(`Canvas rectangle corners: ${report.checks.length} checks passed`);
  } catch (error) { report.failure = error.stack; console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  finally { persist(); await browser?.close(); await server?.close(); }
})();
