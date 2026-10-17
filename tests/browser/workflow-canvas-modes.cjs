/* Real mouse/keyboard regression for canvas interaction modes and session history.
 * Run: node tests/browser/workflow-canvas-modes.cjs
 * Native file dialogs, physical hardware and installed WebViews are not exercised.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_CANVAS_MODES_OUTPUT || path.join(root, 'test-results/workflow-canvas-modes'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real WorkflowEditor and WorkflowSession in Chromium', checks: [], errors: [], consoleErrors: [], limitations: ['No native file dialogs, physical hardware or installed platform WebView validation.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const model = () => page.evaluate(() => window.__modeEditor.value.inspectModel());
const state = () => page.evaluate(() => window.__modeEditor.value.inspect());
const stage = () => page.getByTestId('canvas-stage');
const control = name => page.getByTestId('tool-' + name);
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
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

(async () => {
  try {
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
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true;
    console.log(`Canvas interaction modes: ${report.checks.length} checks passed`);
  } catch (error) { report.failure = error.stack; console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
  finally { persist(); await browser?.close(); await server?.close(); }
})();
