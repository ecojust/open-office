/* Real canvas mouse gestures, grouping, session history and image exporters.
 * Run: node tests/browser/workflow-transforms.cjs
 * Native file dialogs and installed platform WebViews are not exercised.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_TRANSFORMS_OUTPUT || path.join(root, 'test-results/workflow-transforms'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real WorkflowEditor, WorkflowSession, canvas pointer handlers and production SVG/PNG exporters in Chromium', checks: [], errors: [], consoleErrors: [], limitations: ['No native file dialogs or installed platform WebViews are exercised.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const model = () => page.evaluate(() => window.__transformEditor.value.inspectModel());
const state = () => page.evaluate(() => window.__transformEditor.value.inspect());
const stage = () => page.getByTestId('canvas-stage');
const rotationButton = () => page.getByTestId('selection-rotate');
const resizeHandle = corner => page.getByTestId('selection-resize-' + corner);
const style = { stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16, textAlign: 'center', opacity: 1, dashed: false, roughness: 'clean', strokePattern: 'solid' };
const shape = (id, x, y, width, height, extra = {}) => ({ id, type: 'shape', shape: 'rectangle', x, y, width, height, text: '', style: { ...style }, locked: false, ...extra });
const basicElements = () => [shape('a', 200, 200, 120, 80), shape('b', 440, 260, 100, 100), shape('outside', 740, 500, 80, 60)];
const groupedElements = () => basicElements().map(node => node.id === 'outside' ? node : { ...node, groupId: 'test-group' });
const near = (actual, expected, message, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
const rotated = (point, pivot, degrees) => { const angle = degrees * Math.PI / 180, x = point.x - pivot.x, y = point.y - pivot.y; return { x: pivot.x + x * Math.cos(angle) - y * Math.sin(angle), y: pivot.y + x * Math.sin(angle) + y * Math.cos(angle) }; };
function sourceHashes() {
  const files = ['src/components/WorkflowEditor.vue'];
  const visit = directory => { for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) { const file = path.posix.join(directory, item.name); if (item.isDirectory()) visit(file); else if (/\.(ts|vue)$/.test(file)) files.push(file); } };
  visit('src/workflow');
  return Object.fromEntries(files.sort().map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function load(elementsOrDocument) {
  await page.evaluate(async supplied => {
    const { createDocument, serializeDocument } = await import('/src/workflow/core/documents.ts');
    const { bytesToBase64 } = await import('/src/shared/document.ts');
    const doc = Array.isArray(supplied) ? { ...createDocument('board'), title: '组合变换', scene: { elements: supplied, background: '#ffffff', grid: false } } : supplied;
    window.__transformNative.value = { id: crypto.randomUUID(), name: '组合变换.owflow', kind: 'canvas', base64: bytesToBase64(new TextEncoder().encode(serializeDocument(doc))) };
    await window.__transformNextTick();
  }, elementsOrDocument);
  await stage().waitFor(); await frame();
  await page.getByRole('checkbox', { name: '吸附到网格' }).uncheck(); await frame();
}
async function screenPoint(point) {
  return page.locator('svg.scene-svg').evaluate((svg, p) => { const result = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()); return { x: result.x, y: result.y }; }, point);
}
async function clickWorld(point) { const p = await screenPoint(point); await page.mouse.click(p.x, p.y); await frame(); }
async function gesture(from, to, cancel = false) {
  const a = await screenPoint(from), b = await screenPoint(to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await frame();
}
async function marquee() { await page.getByTestId('tool-select').click(); await gesture({ x: 180, y: 180 }, { x: 560, y: 380 }); assert.match(await page.locator('.canvas-hint').innerText(), /已选 2 个元素/); }
async function history(action) { await page.getByRole('button', { name: action === 'undo' ? '撤销' : '重做', exact: true }).click(); await frame(); }
async function key(value) { await stage().focus(); await page.keyboard.press(value); await frame(); }
async function exportFile(format = 'owflow') { return page.evaluate(format => window.__transformEditor.value.exportFile({ format }), format); }
async function save() { const exported = await exportFile(); await page.evaluate(base64 => window.__transformEditor.value.markSaved(base64), exported.base64); return exported; }
async function dragHandle(corner, delta, cancel = false) {
  const handle = resizeHandle(corner), box = await handle.boundingBox(); assert.ok(box, `Visible ${corner} resize handle`);
  const zoom = await page.locator('svg.scene-svg').evaluate(svg => svg.getScreenCTM().a);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + delta.x * zoom, from.y + delta.y * zoom, { steps: 8 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await frame();
}
function rgb(image, point) { const index = (Math.round(point.y) * image.width + Math.round(point.x)) * 4; return [...image.data.subarray(index, index + 3)]; }
const blue = pixel => pixel[2] > pixel[0] + 40 && pixel[0] < 100;
const white = pixel => pixel.every(value => value > 245);

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = sourceHashes(); persist();
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref, nextTick } from 'vue'; import WorkflowEditor from '/src/components/WorkflowEditor.vue'; import '/src/style.css';
      window.__transformNative = ref({ id: 'initial', name: '组合变换.owflow', kind: 'canvas' }); window.__transformEditor = ref(); window.__transformNextTick = nextTick;
      createApp({ setup() { return () => h(WorkflowEditor, { key: window.__transformNative.value.id, ref: window.__transformEditor, document: window.__transformNative.value, theme: 'light' }); } }).mount('#transforms-app');`;
    const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#transforms-app{margin:0;width:100%;height:100%;overflow:hidden}#transforms-app{display:flex}</style></head><body><div id="transforms-app"></div><script type="module" src="/__transforms_harness__.js"></script></body></html>';
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'canvas-transforms-harness', resolveId(id) { if (id === '/__transforms_harness__.js') return '\0canvas-transforms-harness'; }, load(id) { if (id === '\0canvas-transforms-harness') return harness; }, configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__canvas-transforms__') return next(); response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_TRANSFORMS_PORT || 5364), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__canvas-transforms__`); await stage().waitFor(); await frame();

    await check('real-marquee-and-visible-group-controls-create-a-persistent-group', async () => {
      await load(basicElements()); const initial = await state(); await marquee();
      assert.equal((await state()).revision, initial.revision, 'Selection alone is not a content edit');
      await page.getByTestId('selection-group').click(); await frame();
      const after = (await model()).scene.elements;
      assert.ok(after[0].groupId); assert.equal(after[0].groupId, after[1].groupId); assert.equal(after[2].groupId, undefined);
      assert.equal((await state()).revision, initial.revision + 1); assert.equal((await state()).dirty, true);
      await history('undo'); assert.ok((await model()).scene.elements.every(node => !node.groupId));
      await history('redo'); assert.equal((await model()).scene.elements[0].groupId, after[0].groupId);
      await clickWorld({ x: 140, y: 140 }); await clickWorld({ x: 260, y: 240 });
      assert.match(await page.locator('.canvas-hint').innerText(), /已选 2 个元素/);
      await key('Control+Shift+g'); assert.ok((await model()).scene.elements.every(node => !node.groupId));
      await key('Control+g'); assert.equal((await model()).scene.elements[0].groupId, (await model()).scene.elements[1].groupId);
      await page.getByTestId('selection-ungroup').click(); await frame(); assert.ok((await model()).scene.elements.every(node => !node.groupId));
    });

    await check('clicking-one-group-member-moves-the-whole-group-once', async () => {
      await load(groupedElements()); await clickWorld({ x: 260, y: 240 }); const before = await model(), oldState = await state();
      assert.match(await page.locator('.canvas-hint').innerText(), /已选 2 个元素/);
      await gesture({ x: 260, y: 240 }, { x: 300, y: 260 });
      const after = (await model()).scene.elements;
      for (const index of [0, 1]) { near(after[index].x, before.scene.elements[index].x + 40, 'Group x move', 1); near(after[index].y, before.scene.elements[index].y + 20, 'Group y move', 1); }
      assert.deepEqual(after[2], before.scene.elements[2]); assert.equal((await state()).revision, oldState.revision + 1);
      await history('undo'); assert.deepEqual((await model()).scene, before.scene);
    });

    await check('all-four-corners-scale-a-selection-uniformly-about-the-opposite-corner', async () => {
      const corners = { nw: { x: 200, y: 200 }, ne: { x: 540, y: 200 }, sw: { x: 200, y: 360 }, se: { x: 540, y: 360 } };
      const opposite = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }, factor = 1.2;
      for (const corner of Object.keys(corners)) {
        await load(groupedElements()); await clickWorld({ x: 260, y: 240 }); const before = await model(), oldState = await state(), anchor = corners[opposite[corner]], moving = corners[corner];
        for (const name of Object.keys(corners)) assert.equal(await resizeHandle(name).count(), 1);
        await dragHandle(corner, { x: (moving.x - anchor.x) * (factor - 1), y: (moving.y - anchor.y) * (factor - 1) });
        const after = (await model()).scene.elements;
        for (const index of [0, 1]) {
          const a = after[index], b = before.scene.elements[index];
          near(a.width / b.width, a.height / b.height, `${corner} preserves aspect ratio`);
          near(a.width / b.width, factor, `${corner} requested scale`, .01);
          near(a.x, anchor.x + (b.x - anchor.x) * (a.width / b.width), `${corner} fixed anchor x`, 1);
          near(a.y, anchor.y + (b.y - anchor.y) * (a.width / b.width), `${corner} fixed anchor y`, 1);
          assert.equal(a.groupId, b.groupId);
        }
        assert.deepEqual(after[2], before.scene.elements[2]); assert.equal((await state()).revision, oldState.revision + 1, 'One drag is one history entry');
        await history('undo'); assert.deepEqual((await model()).scene, before.scene);
        await history('redo'); assert.deepEqual((await model()).scene.elements, after);
      }
    });

    await check('escape-cancels-a-resize-without-changing-content-or-history', async () => {
      await load(groupedElements()); await clickWorld({ x: 260, y: 240 }); const before = await model(), oldState = await state();
      await dragHandle('se', { x: 100, y: 60 }, true);
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), oldState);
    });

    await check('top-right-rotation-button-rotates-a-group-by-five-degrees', async () => {
      await load(groupedElements()); await clickWorld({ x: 260, y: 240 }); const before = await model(), oldState = await state();
      const box = await page.getByTestId('selection-bounds').boundingBox(), button = await rotationButton().boundingBox(), handle = await resizeHandle('ne').boundingBox();
      assert.ok(button.x + button.width / 2 > box.x + box.width - 16, 'Rotation control sits at the right edge');
      assert.ok(button.y + button.height / 2 < box.y + 16, 'Rotation control sits at the top edge');
      assert.ok(button.x >= handle.x + handle.width || button.y + button.height <= handle.y || button.x + button.width <= handle.x, 'Rotation control does not cover the resize handle');
      assert.match(await rotationButton().getAttribute('aria-label'), /5°/);
      await rotationButton().click(); await frame(); const after = (await model()).scene.elements, pivot = { x: 370, y: 280 };
      for (const index of [0, 1]) {
        const a = after[index], b = before.scene.elements[index], expected = rotated({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, pivot, 5);
        near(a.rotation, 5, 'Click rotates exactly five degrees'); near(a.x + a.width / 2, expected.x, 'Group center rotation x'); near(a.y + a.height / 2, expected.y, 'Group center rotation y');
        near(a.width, b.width, 'Rotation preserves width'); near(a.height, b.height, 'Rotation preserves height'); assert.equal(a.groupId, b.groupId);
      }
      assert.deepEqual(after[2], before.scene.elements[2]); assert.equal((await state()).revision, oldState.revision + 1);
      await history('undo'); assert.deepEqual((await model()).scene, before.scene); await history('redo'); assert.deepEqual((await model()).scene.elements, after);
      const saved = await save(); await load(JSON.parse(Buffer.from(saved.base64, 'base64'))); assert.deepEqual((await model()).scene.elements, after); assert.equal((await state()).dirty, false);
      await clickWorld({ x: after[0].x + after[0].width / 2, y: after[0].y + after[0].height / 2 }); assert.match(await page.locator('.canvas-hint').innerText(), /已选 2 个元素/);
      await page.screenshot({ path: path.join(output, 'group-rotation.png') });
    });

    await check('seventy-two-real-clicks-complete-a-turn-without-position-drift', async () => {
      await load([shape('turn', 300, 220, 180, 60)]); await clickWorld({ x: 390, y: 250 }); const before = await model(), oldState = await state();
      for (let index = 1; index <= 72; index++) { await rotationButton().click(); await frame(); near((await model()).scene.elements[0].rotation || 0, index * 5 % 360, `Rotation click ${index}`); }
      const after = (await model()).scene.elements[0], original = before.scene.elements[0];
      for (const key of ['x', 'y', 'width', 'height']) near(after[key], original[key], `Full-turn ${key}`);
      assert.equal((await state()).revision, oldState.revision + 72); assert.equal((await state()).dirty, false, 'A complete turn has the original saved content');
      await history('undo'); near((await model()).scene.elements[0].rotation, 355, 'Undo last step'); await history('redo'); near((await model()).scene.elements[0].rotation || 0, 0, 'Redo wraps to zero');
    });

    await check('mixed-group-transforms-preserve-ink-and-bound-connector-geometry', async () => {
      const nodes = groupedElements();
      nodes.splice(2, 0, { id: 'ink', type: 'stroke', points: [{ x: 230, y: 330 }, { x: 270, y: 350 }, { x: 330, y: 330 }], brush: 'pen', pressures: [.5, .8, .5], style: { ...style, fill: 'none' }, locked: false, groupId: 'test-group' }, { id: 'connection', type: 'edge', from: { x: 260, y: 240, nodeId: 'a' }, to: { x: 490, y: 310, nodeId: 'b' }, label: '', arrow: 'end', route: 'straight', style: { ...style, fill: 'none' }, locked: false, groupId: 'test-group' });
      await load(nodes); await clickWorld({ x: 260, y: 240 }); assert.match(await page.locator('.canvas-hint').innerText(), /已选 4 个元素/);
      const original = await model();
      const edgePoints = () => page.evaluate(async () => { const doc = await window.__transformEditor.value.inspectModel(); const { edgePoints } = await import('/src/workflow/core/geometry.ts'); return edgePoints(doc.scene.elements.find(node => node.id === 'connection'), doc.scene); });
      const originalEdge = await edgePoints();
      await rotationButton().click(); await frame(); const rotatedModel = await model(), afterRotationEdge = await edgePoints();
      for (let index = 0; index < original.scene.elements[2].points.length; index++) {
        const expected = rotated(original.scene.elements[2].points[index], { x: 370, y: 280 }, 5), actual = rotatedModel.scene.elements[2].points[index];
        near(actual.x, expected.x, 'Rotated ink x'); near(actual.y, expected.y, 'Rotated ink y');
      }
      for (let index = 0; index < originalEdge.length; index++) {
        const expected = rotated(originalEdge[index], { x: 370, y: 280 }, 5);
        near(afterRotationEdge[index].x, expected.x, 'Bound endpoint rotates once, x', 1e-5); near(afterRotationEdge[index].y, expected.y, 'Bound endpoint rotates once, y', 1e-5);
      }
      await dragHandle('se', { x: 100, y: 80 }); const scaled = await model(), scaledEdge = await edgePoints();
      const beforeA = rotatedModel.scene.elements[0], afterA = scaled.scene.elements[0], factor = afterA.width / beforeA.width;
      assert.ok(factor > 1.05, 'Dragging outwards enlarges the selected group');
      const offset = { x: afterA.x + afterA.width / 2 - factor * (beforeA.x + beforeA.width / 2), y: afterA.y + afterA.height / 2 - factor * (beforeA.y + beforeA.height / 2) };
      for (const index of [0, 1]) { const node = scaled.scene.elements[index], previous = rotatedModel.scene.elements[index]; near(node.width / previous.width, factor, 'Mixed shape width scale'); near(node.height / previous.height, factor, 'Mixed shape height scale'); near(node.rotation, 5, 'Resizing preserves angle'); }
      for (let index = 0; index < scaled.scene.elements[2].points.length; index++) {
        const actual = scaled.scene.elements[2].points[index], previous = rotatedModel.scene.elements[2].points[index];
        near(actual.x, previous.x * factor + offset.x, 'Mixed ink scale x'); near(actual.y, previous.y * factor + offset.y, 'Mixed ink scale y');
      }
      assert.deepEqual(scaled.scene.elements[2].pressures, original.scene.elements[2].pressures);
      assert.equal(scaled.scene.elements[3].from.nodeId, 'a'); assert.equal(scaled.scene.elements[3].to.nodeId, 'b');
      for (let index = 0; index < scaledEdge.length; index++) { near(scaledEdge[index].x, afterRotationEdge[index].x * factor + offset.x, 'Scaled bound endpoint x', 1e-5); near(scaledEdge[index].y, afterRotationEdge[index].y * factor + offset.y, 'Scaled bound endpoint y', 1e-5); }
      assert.deepEqual(scaled.scene.elements.at(-1), original.scene.elements.at(-1));
      await history('undo'); assert.deepEqual((await model()).scene, rotatedModel.scene); await history('undo'); assert.deepEqual((await model()).scene, original.scene);
      await history('redo'); await history('redo'); assert.deepEqual((await model()).scene, scaled.scene);
    });

    await check('a-locked-group-cannot-be-partially-scaled-rotated-or-moved', async () => {
      const nodes = groupedElements(); nodes[1].locked = true; await load(nodes); await clickWorld({ x: 260, y: 240 }); const before = await model(), oldState = await state();
      for (const corner of ['nw', 'ne', 'sw', 'se']) assert.equal(await resizeHandle(corner).count(), 0);
      if (await rotationButton().count()) assert.equal(await rotationButton().isEnabled(), false);
      await gesture({ x: 260, y: 240 }, { x: 310, y: 270 }); assert.deepEqual(await model(), before); assert.deepEqual(await state(), oldState);
    });

    await check('rotated-shape-hit-testing-and-svg-png-exports-match-visible-geometry', async () => {
      await load([shape('blue', 300, 220, 180, 60, { style: { ...style, fill: '#2563eb', strokeWidth: 0 } })]); await clickWorld({ x: 390, y: 250 });
      for (let i = 0; i < 9; i++) { await rotationButton().click(); await frame(); }
      assert.equal((await model()).scene.elements[0].rotation, 45); for (const corner of ['nw', 'ne', 'sw', 'se']) assert.equal(await resizeHandle(corner).count(), 1);
      await clickWorld({ x: 230, y: 100 }); await clickWorld({ x: 443.03, y: 303.03 }); assert.match(await page.locator('.canvas-hint').innerText(), /已选 1 个元素/, 'Visible rotated tip remains clickable outside the original rectangle');
      await clickWorld({ x: 465, y: 250 }); assert.doesNotMatch(await page.locator('.canvas-hint').innerText(), /已选/, 'Empty part of the old rectangle does not hit the rotated shape');
      const probes = [{ x: 443.03, y: 303.03 }, { x: 336.97, y: 196.97 }, { x: 390, y: 250 }, { x: 465, y: 250 }];
      const stageBox = await stage().boundingBox(), screenPoints = await Promise.all(probes.map(screenPoint));
      const screenshot = PNG.sync.read(await stage().screenshot({ path: path.join(output, 'rotated-canvas.png') }));
      const svg = await exportFile('svg'), png = await exportFile('png');
      fs.writeFileSync(path.join(output, 'rotated.svg'), Buffer.from(svg.base64, 'base64')); fs.writeFileSync(path.join(output, 'rotated-export.png'), Buffer.from(png.base64, 'base64'));
      const bounds = await page.evaluate(base64 => { const doc = new DOMParser().parseFromString(atob(base64), 'image/svg+xml'); return { viewBox: doc.documentElement.getAttribute('viewBox').split(/\s+/).map(Number), transforms: [...doc.querySelectorAll('[transform]')].map(node => node.getAttribute('transform')) }; }, svg.base64);
      assert.ok(bounds.transforms.some(transform => /rotate\(45(?:[ ,]|\))/.test(transform)), 'SVG preserves the angle');
      const [x, y, width, height] = bounds.viewBox, raster = PNG.sync.read(Buffer.from(png.base64, 'base64'));
      const corners = [{ x: 300, y: 220 }, { x: 480, y: 220 }, { x: 300, y: 280 }, { x: 480, y: 280 }].map(p => rotated(p, { x: 390, y: 250 }, 45));
      for (const corner of corners) assert.ok(corner.x > x && corner.x < x + width && corner.y > y && corner.y < y + height, 'SVG bounds contain every rotated corner');
      const screenPixels = screenPoints.map(p => rgb(screenshot, { x: p.x - stageBox.x, y: p.y - stageBox.y }));
      const pngPixels = probes.map(p => rgb(raster, { x: (p.x - x) * raster.width / width, y: (p.y - y) * raster.height / height }));
      for (const pixels of [screenPixels, pngPixels]) { assert.ok(pixels.slice(0, 3).every(blue), 'Rotated interior is blue'); assert.ok(white(pixels[3]), 'Old unrotated interior is empty'); }
      report.pixelEvidence = { screenPixels, pngPixels, viewBox: bounds.viewBox, pngSize: [raster.width, raster.height] };
      const saved = await save(), savedElements = (await model()).scene.elements; await load(JSON.parse(Buffer.from(saved.base64, 'base64'))); assert.deepEqual((await model()).scene.elements, savedElements); assert.equal((await state()).dirty, false);
    });

    report.sourcesAfter = sourceHashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Production sources changed during verification');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
    console.log(`Canvas transforms: ${report.checks.length} checks passed`);
  } catch (error) { report.failure = error.stack; console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  finally { report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); await server?.close(); }
})();
