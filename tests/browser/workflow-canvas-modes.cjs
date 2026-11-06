/* Real mouse/keyboard regression for canvas interaction modes and session history.
 * Run: node tests/browser/workflow-canvas-modes.cjs
 * Native file dialogs, physical hardware and installed WebViews are not exercised.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_CANVAS_MODES_OUTPUT || path.join(root, 'test-results/workflow-canvas-modes'));
fs.mkdirSync(output, { recursive: true });
const incrementalChecks = { 'edge-defaults': 'edge-defaults-belong-to-quick-shapes-and-only-affect-new-connectors', focus: 'focus-centers-selection-or-scene-without-zoom-or-content-changes' };
const only = process.env.OFFICE_CANVAS_MODES_ONLY?.split(',');
if (only) assert.ok(only.length && only.every(name => Object.hasOwn(incrementalChecks, name)), 'Unknown canvas mode check filter');
const selectedChecks = only ? new Set(only.map(name => incrementalChecks[name])) : undefined;
const report = { ok: false, runtime: 'Real WorkflowEditor and WorkflowSession in Chromium', checks: [], skipped: [], only: only || null, errors: [], consoleErrors: [], limitations: ['No native file dialogs, physical hardware or installed platform WebView validation.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const model = () => page.evaluate(() => window.__modeEditor.value.inspectModel());
const state = () => page.evaluate(() => window.__modeEditor.value.inspect());
const stage = () => page.getByTestId('canvas-stage');
const control = name => page.getByTestId('tool-' + name);
function sourceHashes() {
  const files = ['src/components/WorkflowEditor.vue', 'src/mcp/notes-workflow-tools.ts', 'src/mcp/document-tools.ts', 'src/mcp/tool-schema.ts'];
  const visit = directory => { for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) { const file = path.posix.join(directory, item.name); if (item.isDirectory()) visit(file); else if (/\.(ts|vue)$/.test(file)) files.push(file); } };
  visit('src/workflow');
  return Object.fromEntries(files.sort().map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
async function check(name, run) { if (selectedChecks && !selectedChecks.has(name)) { report.skipped.push(name); return; } report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function mode(expected) {
  for (const name of ['lock', 'select', 'hand']) assert.equal(await control(name).getAttribute('aria-pressed'), String(name === expected), `${expected} mode: ${name} indicator`);
}
async function tool(expected) { assert.equal(await control(expected).getAttribute('aria-pressed'), 'true'); }
async function screenPoint(point) {
  return page.locator('svg.scene-svg').evaluate((svg, point) => {
    const result = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM()); return { x: result.x, y: result.y };
  }, point);
}
async function gesture(from, to) {
  const a = await screenPoint(from), b = await screenPoint(to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await frame();
}
async function reset(doc) {
  await page.evaluate(async supplied => {
    const { createDocument, serializeDocument } = await import('/src/workflow/core/documents.ts');
    const { bytesToBase64 } = await import('/src/shared/document.ts');
    const model = supplied || createDocument('board');
    window.__modeNative.value = { id: crypto.randomUUID(), name: '交互模式.owflow', kind: 'canvas', base64: bytesToBase64(new TextEncoder().encode(serializeDocument(model))) };
    await window.__modeNextTick();
  }, doc);
  await stage().waitFor(); await frame();
}
async function key(value) { await stage().focus(); await page.keyboard.press(value); await frame(); }
async function save() {
  return page.evaluate(async () => { const editor = window.__modeEditor.value, output = await editor.exportFile(); await editor.markSaved(output.base64); return output; });
}
async function history(action) { await page.getByRole('button', { name: action === 'undo' ? '撤销' : '重做', exact: true }).click(); await frame(); }
async function selectElement(id) { await page.locator(`[data-element-id="${id}"]`).click(); await frame(); }
const view = () => page.locator('svg.scene-svg').evaluate(svg => svg.getAttribute('viewBox').split(/\s+/).map(Number));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
async function pan(dx = 130, dy = 80) {
  await stage().focus(); await page.keyboard.down('Space'); const box = await stage().boundingBox();
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45); await page.mouse.down(); await page.mouse.move(box.x + box.width * .45 + dx, box.y + box.height * .45 + dy, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Space'); await frame();
}
function rectangleBounds(elements) {
  const points = elements.flatMap(node => { const cx = node.x + node.width / 2, cy = node.y + node.height / 2, angle = (node.rotation || 0) * Math.PI / 180; return [[node.x, node.y], [node.x + node.width, node.y], [node.x, node.y + node.height], [node.x + node.width, node.y + node.height]].map(([x, y]) => ({ x: cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle), y: cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle) })); });
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
function assertCentered(box, point, previous, label) { near(box[0] + box[2] / 2, point.x, `${label} center x`); near(box[1] + box[3] / 2, point.y, `${label} center y`); near(box[2], previous[2], `${label} keeps zoom/width`); near(box[3], previous[3], `${label} keeps zoom/height`); }
async function selectMcp(args) { const result = await page.evaluate(async args => { const { executeDocumentTool } = await import('/src/mcp/document-tools.ts'); return executeDocumentTool('canvas', window.__modeEditor.value, 'canvas_select_elements', args, () => {}); }, args); await frame(); return result; }

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = sourceHashes();
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref, nextTick } from 'vue';
      import WorkflowEditor from '/src/components/WorkflowEditor.vue'; import '/src/style.css';
      window.__modeNative = ref({ id: 'initial', name: '交互模式.owflow', kind: 'canvas' });
      window.__modeEditor = ref(); window.__modeNextTick = nextTick;
      createApp({ setup() { return () => h(WorkflowEditor, { key: window.__modeNative.value.id, ref: window.__modeEditor, document: window.__modeNative.value, theme: 'light' }); } }).mount('#modes-app');`;
    const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#modes-app{margin:0;width:100%;height:100%;overflow:hidden}#modes-app{display:flex}</style></head><body><div id="modes-app"></div><script type="module" src="/__modes_harness__.js"></script></body></html>';
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'canvas-modes-harness', resolveId(id) { if (id === '/__modes_harness__.js') return '\0canvas-modes-harness'; }, load(id) { if (id === '\0canvas-modes-harness') return harness; }, configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__canvas-modes__') return next(); response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_CANVAS_MODES_PORT || 5359), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, locale: 'zh-CN' }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(`${origin}/__canvas-modes__`); await stage().waitFor(); await frame();
    await check('continuous-select-hand-are-leftmost-and-mutually-exclusive', async () => {
      const ids = await page.locator('.canvas-commandbar button').evaluateAll(buttons => buttons.slice(0, 3).map(button => button.dataset.testid));
      assert.deepEqual(ids, ['tool-lock', 'tool-select', 'tool-hand']); await mode('select');
      const before = await state(); await control('lock').click(); await mode('lock'); await tool('rectangle');
      await control('hand').click(); await mode('hand');
      await control('select').click(); await mode('select'); assert.deepEqual(await state(), before, 'Mode switches do not dirty content or add history');
    });
    await check('continuous-mode-draws-repeatedly-and-preserves-new-element-independence', async () => {
      await control('lock').click(); await mode('lock');
      await gesture({ x: 100, y: 100 }, { x: 260, y: 200 }); await mode('lock'); await tool('rectangle');
      await gesture({ x: 340, y: 100 }, { x: 500, y: 200 }); await mode('lock'); await tool('rectangle');
      const elements = (await model()).scene.elements;
      assert.equal(elements.length, 2); assert.ok(elements.every(element => element.shape === 'rectangle' && !element.locked));
      assert.notEqual(elements[0].id, elements[1].id);
      await history('undo'); assert.equal((await model()).scene.elements.length, 1); await mode('lock');
      await history('redo'); assert.equal((await model()).scene.elements.length, 2); await mode('lock');
    });
    await check('changing-drawing-tools-retains-continuous-mode-including-custom-brush', async () => {
      await control('ellipse').click(); await mode('lock');
      await gesture({ x: 100, y: 300 }, { x: 260, y: 420 }); await tool('ellipse'); await mode('lock'); assert.equal((await model()).scene.elements.at(-1).shape, 'ellipse');
      await control('edge').click(); await gesture({ x: 340, y: 320 }, { x: 500, y: 420 }); await tool('edge'); await mode('lock'); assert.equal((await model()).scene.elements.at(-1).type, 'edge');
      await page.getByTestId('brush-settings-toggle').click(); await page.getByTestId('brush-marker').click(); await page.getByTestId('brush-start').click(); await mode('lock'); await tool('pen');
      await gesture({ x: 100, y: 500 }, { x: 280, y: 540 }); await tool('pen'); await mode('lock'); assert.equal((await model()).scene.elements.at(-1).brush, 'marker');
    });
    await check('select-exits-continuous-and-moves-content-instead-of-drawing', async () => {
      await control('select').click(); await mode('select'); const before = await model(), first = before.scene.elements[0];
      await gesture({ x: first.x + first.width / 2, y: first.y + first.height / 2 }, { x: first.x + first.width / 2 + 40, y: first.y + first.height / 2 + 20 });
      const after = await model(); assert.equal(after.scene.elements.length, before.scene.elements.length);
      assert.equal(after.scene.elements[0].x, first.x + 40); assert.equal(after.scene.elements[0].y, first.y + 20); await mode('select');
    });
    await check('hand-exits-continuous-and-pans-without-changing-the-document', async () => {
      await control('lock').click(); await mode('lock'); await tool('pen');
      await control('hand').click(); await mode('hand');
      const before = await model(), oldState = await state(), viewBox = await page.locator('svg.scene-svg').getAttribute('viewBox');
      await gesture({ x: 600, y: 200 }, { x: 660, y: 240 });
      assert.notEqual(await page.locator('svg.scene-svg').getAttribute('viewBox'), viewBox);
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), oldState); await mode('hand');
    });
    await check('ordinary-drawing-is-single-use-and-reentering-continuous-remembers-the-tool', async () => {
      await reset(); await control('ellipse').click(); await mode('select');
      await gesture({ x: 100, y: 100 }, { x: 260, y: 200 }); await mode('select'); assert.equal(await control('ellipse').getAttribute('aria-pressed'), 'false');
      await gesture({ x: 340, y: 100 }, { x: 500, y: 200 }); assert.equal((await model()).scene.elements.length, 1, 'Second drag selects instead of drawing');
      await control('lock').click(); await mode('lock'); await tool('ellipse');
      await gesture({ x: 340, y: 100 }, { x: 500, y: 200 }); assert.equal((await model()).scene.elements.at(-1).shape, 'ellipse');
      await control('lock').click(); await mode('lock'); await tool('ellipse');
      await control('select').click(); await mode('select');
    });
    await check('keyboard-tools-escape-and-temporary-space-pan-respect-the-mode', async () => {
      await control('lock').click(); await key('r'); await mode('lock'); await tool('rectangle');
      const before = await model(); await stage().focus(); await page.keyboard.down('Space');
      await gesture({ x: 600, y: 300 }, { x: 650, y: 330 }); await mode('lock');
      await page.keyboard.up('Space'); await frame(); assert.deepEqual(await model(), before); await tool('rectangle');
      await key('v'); await mode('select'); await control('lock').click(); await mode('lock');
      await key('h'); await mode('hand'); await control('lock').click(); await mode('lock'); await tool('rectangle');
      const count = (await model()).scene.elements.length, a = await screenPoint({ x: 600, y: 450 }), b = await screenPoint({ x: 720, y: 550 });
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 });
      await page.keyboard.press('Escape'); await page.mouse.up(); await frame(); await mode('select'); assert.equal((await model()).scene.elements.length, count, 'Escape cancels an in-progress shape');
      await control('lock').click(); await key('Escape'); await mode('select');
    });
    await check('drawing-mode-lock-does-not-change-existing-element-locks', async () => {
      const doc = await model(); doc.scene.elements[0].locked = true; await reset(doc);
      const locked = (await model()).scene.elements[0], count = (await model()).scene.elements.length;
      await control('lock').click(); await gesture({ x: 330, y: 300 }, { x: 490, y: 420 });
      assert.equal((await model()).scene.elements.length, count + 1); assert.deepEqual((await model()).scene.elements[0], locked); assert.equal((await model()).scene.elements.at(-1).locked, false);
      await control('select').click(); await selectElement(locked.id); const before = await model();
      await gesture({ x: locked.x + locked.width / 2, y: locked.y + locked.height / 2 }, { x: locked.x + locked.width / 2 + 60, y: locked.y + locked.height / 2 + 40 });
      assert.deepEqual(await model(), before, 'Locked element cannot move after returning to select mode');
      const saved = await save(); assert.equal(JSON.parse(Buffer.from(saved.base64, 'base64')).scene.elements[0].locked, true); assert.equal((await state()).dirty, false);
      await page.screenshot({ path: path.join(output, 'canvas-modes.png') });
    });
    await check(incrementalChecks['edge-defaults'], async () => {
      await reset();
      const toggle = page.getByTestId('edge-defaults-toggle'), panel = page.getByTestId('edge-defaults-panel');
      assert.deepEqual(await toggle.evaluate(button => ({ group: button.closest('[data-testid="quick-shapes-group"]')?.getAttribute('data-testid'), previous: button.previousElementSibling?.getAttribute('data-testid') })), { group: 'quick-shapes-group', previous: 'tool-edge' });
      assert.equal(await page.locator('.canvas-actions-group [data-testid="edge-defaults-toggle"]').count(), 0);
      await control('edge').click(); await gesture({ x: 100, y: 100 }, { x: 300, y: 220 }); const original = (await model()).scene.elements[0];
      assert.equal(original.route, 'straight'); assert.equal(original.arrow, 'end'); await save(); const initial = await state();
      await toggle.click(); await panel.waitFor();
      assert.equal(await panel.evaluate(node => node.parentElement?.getAttribute('data-testid')), 'quick-shapes-group'); assert.equal(await panel.evaluate(node => !!node.closest('.toolset')), false, 'Popover is outside the horizontally clipped toolset');
      await page.getByTestId('default-route-orthogonal').click(); await page.getByTestId('default-arrow-both').click();
      assert.deepEqual((await model()).scene.elements, [original]); assert.deepEqual(await state(), initial, 'Defaults do not edit the selected old connector');
      await panel.getByRole('button', { name: '开始连线' }).click(); await gesture({ x: 400, y: 120 }, { x: 620, y: 260 });
      const second = (await model()).scene.elements[1]; assert.equal(second.route, 'orthogonal'); assert.equal(second.arrow, 'both'); assert.deepEqual((await model()).scene.elements[0], original);
      await toggle.click(); await page.getByTestId('default-route-straight').click(); await page.getByTestId('default-arrow-none').click(); await panel.getByRole('button', { name: '开始连线' }).click(); await gesture({ x: 100, y: 400 }, { x: 300, y: 500 });
      const all = (await model()).scene.elements; assert.deepEqual(all.slice(0, 2), [original, second]); assert.equal(all[2].route, 'straight'); assert.equal(all[2].arrow, 'none');
      report.edgeDefaultsLayouts = [];
      for (const width of [740, 480]) {
        await page.setViewportSize({ width, height: 760 }); await frame(); await toggle.click(); await panel.waitFor();
        const layout = await panel.evaluate(node => {
          const box = node.getBoundingClientRect(), targets = [...node.querySelectorAll('button')].map(button => { const rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2; return { label: button.getAttribute('aria-label') || button.textContent.trim(), visible: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && button.contains(document.elementFromPoint(x, y)) }; });
          return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, targets };
        });
        assert.ok(layout.x >= 0 && layout.x + layout.width <= width, `Popover fits ${width}px screen horizontally`); assert.ok(layout.y >= 0 && layout.y + layout.height <= 760, `Popover fits ${width}px screen vertically`);
        assert.ok(layout.targets.every(button => button.visible), `Every ${width}px popover button is hit-testable: ${JSON.stringify(layout.targets)}`);
        await page.getByTestId('default-arrow-both').click(); assert.equal(await page.getByTestId('default-arrow-both').getAttribute('aria-pressed'), 'true');
        await page.screenshot({ path: path.join(output, `edge-defaults-${width}.png`) }); report.edgeDefaultsLayouts.push(layout);
        await panel.getByRole('button', { name: '关闭新建连线设置' }).click();
      }
      await page.setViewportSize({ width: 1480, height: 1000 }); await frame();
    });
    await check(incrementalChecks.focus, async () => {
      await reset(); const doc = await model();
      const style = { stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16, textAlign: 'center', opacity: 1, dashed: false, roughness: 'clean', strokePattern: 'solid' };
      const rectangle = (id, x, y, width, height, groupId) => ({ id, type: 'shape', shape: 'rectangle', x, y, width, height, text: id === 'focus-a' ? 'Focus title' : '', style: { ...style }, locked: false, ...(groupId ? { groupId } : {}) });
      doc.scene.elements = [rectangle('focus-a', 200, 200, 120, 80, 'focus-group'), rectangle('focus-b', 440, 260, 100, 100, 'focus-group'), rectangle('focus-outside', 740, 500, 80, 60)]; doc.scene.grid = false;
      await reset(doc); await selectElement('focus-a'); await page.getByTestId('selection-rotate').click(); await frame(); await save();
      const before = await model(), snapshot = await state(), selectedCenter = rectangleBounds(before.scene.elements.slice(0, 2)), wholeCenter = rectangleBounds(before.scene.elements);
      await page.getByRole('button', { name: '放大', exact: true }).click(); await control('hand').click(); await pan();
      const away = await view(), selectedText = await page.locator('.canvas-hint').innerText();
      await page.getByTestId('canvas-focus').click(); await frame(); assertCentered(await view(), selectedCenter, away, 'Button centers rotated group'); await mode('hand'); assert.equal(await page.locator('.canvas-hint').innerText(), selectedText);
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), snapshot);
      await pan(-90, 55); const homeBefore = await view(); await key('Home'); assertCentered(await view(), selectedCenter, homeBefore, 'Home centers selection'); await mode('hand'); assert.deepEqual(await state(), snapshot);
      await key('Escape'); await pan(120, -40); const wholeBefore = await view(); await page.getByTestId('canvas-focus').click(); await frame(); assertCentered(await view(), wholeCenter, wholeBefore, 'Empty selection centers scene'); await mode('select'); assert.doesNotMatch(await page.locator('.canvas-hint').innerText(), /已选/);
      await selectElement('focus-a'); await page.keyboard.down('Alt'); await selectElement('focus-a'); await page.keyboard.up('Alt'); await pan();
      const typingBefore = await view(), text = page.getByTestId('property-text'); await text.focus(); await text.press('End'); await text.press('Home'); await frame();
      assert.deepEqual(await view(), typingBefore, 'Home in text input keeps canvas position'); assert.equal(await text.evaluate(input => document.activeElement === input && input.selectionStart === 0), true); assert.deepEqual(await model(), before); assert.deepEqual(await state(), snapshot);
      await pan(110, 70); const mcpBefore = await view(), result = await selectMcp({ ids: ['focus-a', 'focus-b'], focus: true }); assert.deepEqual(result.selectedIds, ['focus-a', 'focus-b']); assertCentered(await view(), selectedCenter, mcpBefore, 'MCP focus centers selection');
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), snapshot);
      const conflictView = await view(), conflictSelection = await page.locator('.canvas-hint').innerText();
      await assert.rejects(() => selectMcp({ ids: ['focus-outside'], fit: true, focus: true }), /MCP|focus|fit|同时/); assert.deepEqual(await view(), conflictView); assert.equal(await page.locator('.canvas-hint').innerText(), conflictSelection); assert.deepEqual(await model(), before); assert.deepEqual(await state(), snapshot);
      await pan(-85, 45); const clearBefore = await view(); await selectMcp({ ids: [], focus: true }); assertCentered(await view(), wholeCenter, clearBefore, 'MCP empty selection centers scene'); assert.doesNotMatch(await page.locator('.canvas-hint').innerText(), /已选/);
      await page.screenshot({ path: path.join(output, 'canvas-focus.png') });
      await reset(); assert.equal(await page.getByTestId('canvas-focus').isDisabled(), true); await pan(); const emptyView = await view(), emptyModel = await model(), emptyState = await state(); await key('Home'); assert.deepEqual(await view(), emptyView); assert.deepEqual(await model(), emptyModel); assert.deepEqual(await state(), emptyState);
    });
    report.sourcesAfter = sourceHashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Production sources changed during canvas mode verification');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
    console.log(`Canvas interaction modes: ${report.checks.length} checks passed`);
  } catch (error) { report.failure = error.stack; console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  finally { persist(); await browser?.close(); await server?.close(); }
})();
