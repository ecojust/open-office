/* Pixel regression for the real Vue canvas and production SVG/PNG exporters.
 * Run: node tests/browser/workflow-brush-overlap.cjs
 * Optional focused run: OFFICE_BRUSH_FILTER=sparse-sharp-corners node tests/browser/workflow-brush-overlap.cjs
 * No native APIs, installed WebViews or physical stylus hardware are exercised.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_BRUSH_OUTPUT || path.join(root, 'test-results/workflow-brush-overlap'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real Vue SceneEditor in Chromium, screenshot pixels and production SVG/PNG exports', filter: process.env.OFFICE_BRUSH_FILTER || null, checks: [], renders: [], failures: [], errors: [], consoleErrors: [], limitations: ['No native I/O or installed platform WebView validation.', 'Deterministic pressure samples exercise rendering, not physical stylus hardware.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const ink = [51, 65, 85];
const line = (a, b, steps) => Array.from({ length: steps + 1 }, (_, i) => ({ x: a[0] + (b[0] - a[0]) * i / steps, y: a[1] + (b[1] - a[1]) * i / steps }));
const forward = line([80, 100], [500, 320], 84);
const cross = [...forward, ...line([500, 320], [500, 100], 44).slice(1), ...line([500, 100], [80, 320], 84).slice(1)];
const reverse = [...line([80, 200], [520, 200], 110), ...line([520, 200], [200, 200], 80).slice(1)];
const stroke = (brush, points, opacity, id = 'stroke-1') => ({ id, type: 'stroke', brush, points, pressures: points.map(() => .75), style: { stroke: brush === 'highlighter' ? '#facc15' : '#334155', fill: 'none', strokeWidth: 40, fontSize: 16, textAlign: 'center', opacity, dashed: false, roughness: 'clean', strokePattern: 'solid' }, locked: false });
const singleProbe = { x: 185, y: 155 }, overlapProbe = { x: 290, y: 210 };
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function sample(image, point, radius = 1) {
  const sums = [0, 0, 0, 0]; let count = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = Math.round(point.x) + dx, y = Math.round(point.y) + dy;
    assert.ok(x >= 0 && y >= 0 && x < image.width && y < image.height, 'Pixel probe stays inside rendered image');
    const at = (y * image.width + x) * 4;
    for (let c = 0; c < 4; c++) sums[c] += image.data[at + c];
    count++;
  }
  return sums.map(value => Number((value / count).toFixed(3)));
}
function alpha(rgb, brush) { return (255 - rgb[2]) / (255 - (brush === 'highlighter' ? 21 : ink[2])); }
function near(actual, expected, tolerance, description) { assert.ok(Math.abs(actual - expected) <= tolerance, `${description}: expected ${expected.toFixed(4)} ± ${tolerance}, got ${actual.toFixed(4)}`); }
async function render(name, elements, probes, background = '#ffffff') {
  const scene = { background, grid: false, elements };
  await page.evaluate(async scene => { window.__brushScene.value = scene; await window.__brushNextTick(); }, scene);
  await page.getByRole('button', { name: '适应画布', exact: true }).click(); await frame();
  const stage = page.getByTestId('canvas-stage');
  const screenPoints = await stage.evaluate((node, points) => {
    const svg = node.querySelector('svg.scene-svg'), matrix = svg.getScreenCTM(), bounds = node.getBoundingClientRect();
    return points.map(point => { const p = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: p.x - bounds.x, y: p.y - bounds.y }; });
  }, probes);
  const screenBytes = await stage.screenshot({ path: path.join(output, `${name}-canvas.png`) });
  const screen = PNG.sync.read(screenBytes);
  const exported = await page.evaluate(async scene => {
    const { createDocument } = await import('/src/workflow/core/documents.ts');
    const { exportDocument } = await import('/src/workflow/core/files.ts');
    const doc = createDocument('board'); doc.scene = scene;
    const svg = await exportDocument(doc, 'svg'), png = await exportDocument(doc, 'png');
    const markup = new TextDecoder().decode(svg.bytes), node = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const viewBox = node.getAttribute('viewBox').split(/\s+/).map(Number), width = Number(node.getAttribute('width')), height = Number(node.getAttribute('height'));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
      canvas.getContext('2d').drawImage(image, 0, 0);
      const encode = bytes => { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); };
      return { markup, viewBox, raster: canvas.toDataURL('image/png').split(',')[1], png: encode(png.bytes) };
    } finally { URL.revokeObjectURL(url); }
  }, scene);
  fs.writeFileSync(path.join(output, `${name}.svg`), exported.markup);
  const svgBytes = Buffer.from(exported.raster, 'base64'), pngBytes = Buffer.from(exported.png, 'base64');
  fs.writeFileSync(path.join(output, `${name}-svg.png`), svgBytes); fs.writeFileSync(path.join(output, `${name}-export.png`), pngBytes);
  const svg = PNG.sync.read(svgBytes), png = PNG.sync.read(pngBytes);
  const [x, y, w, h] = exported.viewBox;
  const project = (point, image) => ({ x: (point.x - x) * image.width / w, y: (point.y - y) * image.height / h });
  const values = probes.map((point, index) => ({ point, canvas: sample(screen, screenPoints[index]), svg: sample(svg, project(point, svg)), png: sample(png, project(point, png)) }));
  report.renders.push({ name, pixels: values }); persist();
  for (const value of values) for (const format of ['svg', 'png']) for (let c = 0; c < 3; c++) near(value[format][c], value.canvas[c], 8, `${name} ${format}/canvas channel ${c}`);
  return values;
}
async function check(name, run) {
  if (process.env.OFFICE_BRUSH_FILTER && !name.includes(process.env.OFFICE_BRUSH_FILTER)) return;
  report.stage = name; persist();
  try { const pixels = await run(); report.checks.push({ name, pixels }); }
  catch (error) { report.failures.push({ name, error: error.stack }); }
  persist();
}
(async () => {
  try {
    report.startedAt = new Date().toISOString();
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref, nextTick } from 'vue';
      import SceneEditor from '/src/workflow/components/SceneEditor.vue';
      import '/src/style.css';
      window.__brushScene = ref({ background: '#ffffff', grid: false, elements: [] }); window.__brushNextTick = nextTick;
      createApp({ setup() { return () => h(SceneEditor, { scene: window.__brushScene.value, mode: 'board', theme: 'light', onChange: scene => { window.__brushScene.value = scene; } }); } }).mount('#brush-app');`;
    const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#brush-app{margin:0;width:100%;height:100%;overflow:hidden}#brush-app{display:flex}.scene-editor{width:100%;height:100%}</style></head><body><div id="brush-app"></div><script type="module" src="/__brush_harness__.js"></script></body></html>';
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'brush-pixel-harness', resolveId(id) { if (id === '/__brush_harness__.js') return '\0brush-pixel-harness'; }, load(id) { if (id === '\0brush-pixel-harness') return harness; }, configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__brush-overlap__') return next(); response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_BRUSH_PORT || 5348), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(`${origin}/__brush-overlap__`);
    await page.getByTestId('canvas-stage').waitFor();
    for (const brush of ['pen', 'marker', 'brush', 'highlighter']) {
      for (const opacity of [1, .5]) await check(`${brush}-self-cross-${opacity}`, async () => {
        const pixels = await render(`${brush}-self-cross-${opacity}`, [stroke(brush, cross, opacity)], [singleProbe, overlapProbe]);
        const a = opacity * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) { near(alpha(pixels[0][format], brush), a, .035, `${format} single pass`); near(alpha(pixels[1][format], brush), 1 - (1 - a) ** 2, .035, `${format} self-overlap source-over`); }
        return pixels;
      });
      await check(`${brush}-two-strokes`, async () => {
        const pixels = await render(`${brush}-two-strokes`, [stroke(brush, forward, .5), stroke(brush, line([500, 100], [80, 320], 84), .5, 'stroke-2')], [singleProbe, overlapProbe]);
        const a = .5 * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) near(alpha(pixels[1][format], brush), 1 - (1 - a) ** 2, .035, `${format} separate-stroke source-over`);
        return pixels;
      });
      for (const density of [2, 440]) await check(`${brush}-straight-${density}`, async () => {
        const probes = Array.from({ length: 33 }, (_, i) => ({ x: 140 + i * 10, y: 200 }));
        const pixels = await render(`${brush}-straight-${density}`, [stroke(brush, line([80, 200], [520, 200], density), .5)], probes);
        const a = .5 * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) {
          const alphas = pixels.map(value => alpha(value[format], brush));
          for (const actual of alphas) near(actual, a, .035, `${format} uniform single-pass opacity`);
          assert.ok(Math.max(...alphas) - Math.min(...alphas) <= .035, `${format} no seams or dark joints in a continuous line`);
        }
        return pixels;
      });
      await check(`${brush}-reverse-retrace`, async () => {
        const pixels = await render(`${brush}-reverse-retrace`, [stroke(brush, reverse, .5)], [{ x: 140, y: 200 }, { x: 300, y: 200 }, { x: 420, y: 200 }]);
        const a = .5 * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) {
          near(alpha(pixels[0][format], brush), a, .035, `${format} untouched single pass`);
          for (const value of pixels.slice(1)) near(alpha(value[format], brush), 1 - (1 - a) ** 2, .035, `${format} reverse retracing source-over`);
        }
        return pixels;
      });
      await check(`${brush}-self-cross-continuous-joins`, async () => {
        const probes = [];
        for (let x = 130; x <= 450; x += 4) if (Math.abs(x - 290) > 75) {
          probes.push({ x, y: 100 + (x - 80) * 220 / 420 });
          probes.push({ x, y: 320 - (x - 80) * 220 / 420 });
        }
        for (let y = 160; y <= 260; y += 4) probes.push({ x: 500, y });
        const pixels = await render(`${brush}-self-cross-continuous-joins`, [stroke(brush, cross, .5)], probes);
        const a = .5 * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) for (const value of pixels) near(alpha(value[format], brush), a, .04, `${format} joined stroke at (${value.point.x},${value.point.y})`);
        return pixels;
      });
      await check(`${brush}-sparse-sharp-corners`, async () => {
        // Four samples deliberately keep the long incoming/outgoing segments
        // sparse. A tangent derived from the full chord can flatten the middle
        // horizontal edge; its visible pixels must retain continuous ink.
        const points = [{ x: 80, y: 100 }, { x: 500, y: 320 }, { x: 80, y: 320 }, { x: 500, y: 100 }];
        const probes = [singleProbe, overlapProbe, ...Array.from({ length: 29 }, (_, index) => ({ x: 150 + index * 10, y: 320 }))];
        const pixels = await render(`${brush}-sparse-sharp-corners`, [stroke(brush, points, .5)], probes);
        const a = .5 * (brush === 'highlighter' ? .32 : 1);
        for (const format of ['canvas', 'svg', 'png']) {
          near(alpha(pixels[0][format], brush), a, .04, `${format} sparse diagonal single pass`);
          near(alpha(pixels[1][format], brush), 1 - (1 - a) ** 2, .04, `${format} sparse diagonal crossing`);
          for (const value of pixels.slice(2)) near(alpha(value[format], brush), a, .04, `${format} sparse sharp-corner horizontal at (${value.point.x},${value.point.y})`);
        }
        return pixels;
      });
    }
    for (const brush of ['pencil', 'rainbow']) await check(`${brush}-self-cross-export-parity`, async () => {
      const pixels = await render(`${brush}-self-cross-export-parity`, [stroke(brush, cross, .5)], [singleProbe, overlapProbe]);
      for (const value of pixels) for (const format of ['canvas', 'svg', 'png']) assert.ok(Math.min(...value[format].slice(0, 3)) < 240, `${brush} visible ink remains at crossing`);
      return pixels;
    });
    const coverage = (white, black) => 1 - white.slice(0, 3).reduce((sum, channel, index) => sum + channel - black[index], 0) / 765;
    for (const brush of ['pencil', 'rainbow']) {
      await check(`${brush}-half-opacity-overlap-coverage`, async () => {
        const elements = [stroke(brush, cross, .5)];
        const white = await render(`${brush}-coverage-white`, elements, [singleProbe, overlapProbe]);
        const black = await render(`${brush}-coverage-black`, elements, [singleProbe, overlapProbe], '#000000');
        const measured = {};
        for (const format of ['canvas', 'svg', 'png']) {
          const single = coverage(white[0][format], black[0][format]), overlap = coverage(white[1][format], black[1][format]);
          measured[format] = { single, overlap };
          assert.ok(overlap > single + .04, `${brush} ${format} self-overlap increases ink coverage: ${single} -> ${overlap}`);
          if (brush === 'rainbow') { near(single, .5, .035, `${format} single rainbow coverage`); near(overlap, .75, .035, `${format} layered rainbow coverage`); }
        }
        return { white, black, measured };
      });
      for (const opacity of [1, .5]) await check(`${brush}-reverse-retrace-${opacity}`, async () => {
        const probes = [{ x: 300, y: 200 }, { x: 420, y: 200 }];
        const elements = [stroke(brush, reverse, opacity)], baseline = [stroke(brush, line([80, 200], [520, 200], 110), opacity)];
        const referenceWhite = await render(`${brush}-reference-white-${opacity}`, baseline, probes);
        const referenceBlack = await render(`${brush}-reference-black-${opacity}`, baseline, probes, '#000000');
        const white = await render(`${brush}-reverse-white-${opacity}`, elements, probes);
        const black = await render(`${brush}-reverse-black-${opacity}`, elements, probes, '#000000');
        const measured = {};
        for (const format of ['canvas', 'svg', 'png']) {
          measured[format] = probes.map((_, index) => ({ single: coverage(referenceWhite[index][format], referenceBlack[index][format]), overlap: coverage(white[index][format], black[index][format]) }));
          for (const value of measured[format]) {
            assert.ok(value.overlap > .08, `${brush} ${format} retracing retains visible ink`);
            if (opacity < 1 || brush === 'pencil') assert.ok(value.overlap > value.single + .025, `${brush} ${format} retracing adds ink coverage: ${value.single} -> ${value.overlap}`);
            if (brush === 'rainbow') near(value.overlap, 1 - (1 - opacity) ** 2, .04, `${format} rainbow retrace coverage`);
          }
        }
        return measured;
      });
    }
    const ring = [...line([80, 100], [500, 100], 84), ...line([500, 100], [500, 320], 44).slice(1), ...line([500, 320], [80, 320], 84).slice(1), ...line([80, 320], [80, 100], 44).slice(1, -1)];
    for (const brush of ['pen', 'marker', 'brush', 'highlighter', 'pencil', 'rainbow']) await check(`${brush}-closed-stroke-remains-hollow`, async () => {
      const element = { ...stroke(brush, ring, .5), closed: true };
      const pixels = await render(`${brush}-closed-stroke-remains-hollow`, [element], [{ x: 290, y: 210 }, { x: 290, y: 100 }, { x: 80, y: 210 }]);
      for (const format of ['canvas', 'svg', 'png']) {
        assert.deepEqual(pixels[0][format], [255, 255, 255, 255], `${brush} ${format} does not fill the interior of a closed ink stroke`);
        for (const value of pixels.slice(1)) assert.ok(Math.min(...value[format].slice(0, 3)) < 245, `${brush} ${format} closed boundary remains visible`);
      }
      return pixels;
    });
    await check('pointer-drawing-self-cross-stays-visible-before-and-after-release', async () => {
      await page.evaluate(async () => { window.__brushScene.value = { background: '#ffffff', grid: false, elements: [] }; await window.__brushNextTick(); });
      await page.getByTestId('brush-settings-toggle').click(); await page.getByTestId('brush-highlighter').click();
      await page.getByTestId('brush-width').fill('40'); await page.getByTestId('brush-width').press('Tab');
      for (const [testid, value] of [['brush-opacity', '1'], ['brush-smoothing', '0']]) await page.getByTestId(testid).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
      await page.getByTestId('brush-start').click(); await page.locator('.zoom-value').click(); await frame();
      const stage = page.getByTestId('canvas-stage'), b = await stage.boundingBox(); assert.ok(b.width > 750 && b.height > 500);
      await page.mouse.move(b.x + 100, b.y + 150); await page.mouse.down();
      try {
        for (const [x, y] of [[700, 450], [700, 150], [100, 450]]) await page.mouse.move(b.x + x, b.y + y, { steps: 30 });
        await frame();
        const inFlight = PNG.sync.read(await stage.screenshot({ path: path.join(output, 'pointer-drawing-in-flight.png') }));
        await page.mouse.up(); await frame();
        const committed = PNG.sync.read(await stage.screenshot({ path: path.join(output, 'pointer-drawing-committed.png') }));
        const pixels = { inFlight: sample(inFlight, { x: 400, y: 300 }), committed: sample(committed, { x: 400, y: 300 }) };
        report.renders.push({ name: 'pointer-drawing', pixels }); persist();
        for (const [state, rgb] of Object.entries(pixels)) near(alpha(rgb, 'highlighter'), 1 - .68 ** 2, .035, `${state} live highlighter overlap`);
        return pixels;
      } finally { await page.mouse.up(); }
    });
    assert.ok(report.checks.length + report.failures.length > 0, 'At least one selected pixel regression must execute');
    report.ok = !report.failures.length && !report.errors.length && !report.consoleErrors.length;
    report.finishedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.length, failed: report.failures.map(value => ({ name: value.name, error: value.error.split('\n')[0] })), output }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) { report.errors.push(error.stack); persist(); console.error(error); process.exitCode = 1; }
  finally { if (browser) await browser.close(); if (server) await server.close(); }
})();
