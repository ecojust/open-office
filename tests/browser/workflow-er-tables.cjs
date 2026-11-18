/* Real ER table preview, role controls, history and production file exports.
 * Run: node tests/browser/workflow-er-tables.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_ER_OUTPUT || path.join(root, 'test-results/workflow-er-tables'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], consoleErrors: [], screenshots: [], limitations: ['Chromium validates web rendering; native platform file dialogs are not exercised.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page, standalonePage;
const fixture = `erDiagram
CUSTOMER["客户"] {
  bigint customer_id PK "客户编号😀"
  varchar display_name "显示名称 WWWM"
  string email UK
}
ORDER {
  bigint order_id PK "订单编号"
}
CUSTOMER ||--o{ ORDER : places`;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const model = () => page.evaluate(() => window.__erEditor.value.inspectModel());
const state = () => page.evaluate(() => window.__erEditor.value.inspect());
const scene = () => page.evaluate(async () => (await import('/src/workflow/core/files.ts')).documentScene(await window.__erEditor.value.inspectModel()));
const preview = () => page.getByTestId('diagram-preview');
const panel = () => page.getByTestId('diagram-style-panel');
const control = (role, property) => page.getByTestId(`er-${role}-${property}`);
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function load(source = fixture, erStyle) {
  await page.evaluate(async ({ source, erStyle }) => {
    const { createDocument, serializeDocument } = await import('/src/workflow/core/documents.ts');
    const { bytesToBase64 } = await import('/src/shared/document.ts');
    const document = createDocument('mermaid'); document.source = source;
    if (erStyle) document.erStyle = erStyle;
    window.__erNative.value = { id: crypto.randomUUID(), name: 'ER表格.owflow', kind: 'diagram', base64: bytesToBase64(new TextEncoder().encode(serializeDocument(document))) };
    await window.__erNextTick();
  }, { source, erStyle });
  await preview().waitFor(); await page.evaluate(() => document.fonts.ready); await frame();
}
async function size(role, value) { await control(role, 'font-size').fill(String(value)); await control(role, 'font-size').press('Tab'); await frame(); }
async function color(role, value) { await control(role, 'color').evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }, value); await frame(); }
async function exportFile(format = 'owflow') { return page.evaluate(format => window.__erEditor.value.exportFile({ format }), format); }
async function screenshot(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); persist(); }
function shape(scene, value) { const result = scene.elements.find(element => element.type === 'shape' && element.text === value); assert.ok(result, `Missing text shape ${value}`); return result; }
function assertGeometry(measurements, expectedScene, label) {
  for (const measurement of measurements) {
    const element = expectedScene.elements.find(element => element.id === measurement.id);
    const table = expectedScene.elements.find(candidate => candidate.groupId === element.groupId && candidate.type === 'shape' && candidate.shape === 'rectangle');
    assert.ok(table, `${label}: missing table for ${element.text}`);
    assert.equal(measurement.text, element.text.replace(/\r\n?|\n|\u2028|\u2029/g, ' '), `${label}: full text retained`);
    assert.equal(measurement.lines, 1, `${label}: single line for ${element.text}`);
    const box = measurement.box, tolerance = .75;
    assert.ok(box.x >= table.x - tolerance && box.y >= table.y - tolerance && box.x + box.width <= table.x + table.width + tolerance && box.y + box.height <= table.y + table.height + tolerance, `${label}: actual glyph bbox escapes table: ${JSON.stringify({ text: element.text, box, table: { x: table.x, y: table.y, width: table.width, height: table.height } })}`);
    assert.ok(box.x >= element.x - tolerance && box.x + box.width <= element.x + element.width + tolerance, `${label}: actual glyph bbox escapes its column: ${JSON.stringify({ text: element.text, box, cell: { x: element.x, y: element.y, width: element.width, height: element.height } })}`);
  }
}
async function measurePreviewAndExport() {
  const currentScene = await scene();
  const exported = await exportFile('svg');
  const svg = Buffer.from(exported.base64, 'base64').toString('utf8');
  const measured = await page.evaluate(({ scene, svg }) => {
    function measurements(svg) {
      const groups = [...svg.children].filter(element => element.tagName.toLowerCase() === 'g');
      return scene.elements.flatMap((element, index) => {
        if (element.type !== 'shape' || element.shape !== 'text' || !element.text || !/^er-\d+-card$/.test(element.groupId || '')) return [];
        const text = groups[index].querySelector('text'), box = text.getBBox();
        return [{ id: element.id, text: text.textContent, lines: text.querySelectorAll('tspan').length, position: [...text.querySelectorAll('tspan')].map(span => [span.getAttribute('x'), span.getAttribute('y')]), box: { x: box.x, y: box.y, width: box.width, height: box.height }, attributes: Object.fromEntries(['font-size', 'font-weight', 'font-style', 'fill', 'text-anchor'].map(name => [name, text.getAttribute(name)])) }];
      });
    }
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-30000px;top:0;visibility:hidden'; host.innerHTML = svg; document.body.append(host);
    try { return { preview: measurements(document.querySelector('[data-testid="diagram-preview"] svg')), exported: measurements(host.querySelector('svg')) }; }
    finally { host.remove(); }
  }, { scene: currentScene, svg });
  assertGeometry(measured.preview, currentScene, 'preview');
  assertGeometry(measured.exported, currentScene, 'SVG export');
  // Chromium hints glyphs at the displayed SVG scale, so getBBox can differ by
  // fractions between a fitted preview and the intrinsic export size. Both
  // must fit; text, positions and typography must match exactly.
  const appearance = items => items.map(({ box, ...item }) => item);
  assert.deepEqual(appearance(measured.preview), appearance(measured.exported), 'text, geometry, font and color match exported SVG');
  return { scene: currentScene, measured, svg };
}
async function measureStandalone(scene, svg) {
  standalonePage ??= await browser.newPage();
  await standalonePage.setContent(`<!doctype html><html><body>${svg}</body></html>`);
  const measurements = await standalonePage.evaluate(scene => {
    if (document.fonts.size) throw Error('Standalone SVG must not inherit application webfonts');
    const groups = [...document.querySelector('svg').children].filter(element => element.tagName.toLowerCase() === 'g');
    return scene.elements.flatMap((element, index) => {
      if (element.type !== 'shape' || element.shape !== 'text' || !element.text || !/^er-\d+-card$/.test(element.groupId || '')) return [];
      const text = groups[index].querySelector('text'), box = text.getBBox();
      return [{ id: element.id, text: text.textContent, lines: text.querySelectorAll('tspan').length, box: { x: box.x, y: box.y, width: box.width, height: box.height } }];
    });
  }, scene);
  assertGeometry(measurements, scene, 'standalone SVG using system fonts');
}

(async () => {
  try {
    const { createServer } = await import('vite');
    const harness = `import { createApp, h, ref, nextTick } from 'vue';
      import WorkflowEditor from '/src/components/WorkflowEditor.vue'; import '/src/style.css';
      window.__erNative = ref({ id: 'initial', name: 'ER表格.owflow', kind: 'diagram' });
      window.__erEditor = ref(); window.__erNextTick = nextTick; window.__erTheme = ref('light');
      createApp({ setup() { return () => h(WorkflowEditor, { key: window.__erNative.value.id, ref: window.__erEditor, document: window.__erNative.value, theme: window.__erTheme.value }); } }).mount('#er-app');`;
    const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#er-app{margin:0;width:100%;height:100%;overflow:hidden}#er-app{display:flex}</style></head><body><div id="er-app"></div><script type="module" src="/__er_harness__.js"></script></body></html>';
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'er-harness', resolveId(id) { if (id === '/__er_harness__.js') return '\0er-harness'; }, load(id) { if (id === '\0er-harness') return harness; }, configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__er__') return next(); response.setHeader('Content-Type', 'text/html;charset=utf-8'); response.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_ER_PORT || 5368), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' }); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__er__`); await preview().waitFor(); await page.evaluate(() => document.fonts.ready);

    await check('default-name-comment-order-left-right-columns-and-real-glyph-bounds', async () => {
      await load();
      const { scene: current, measured } = await measurePreviewAndExport();
      const title = shape(current, 'CUSTOMER'), tableComment = shape(current, '客户'), comment = shape(current, '客户编号😀');
      assert.equal(title.style.fontWeight, 'bold'); assert.ok(title.y + title.height <= tableComment.y);
      assert.equal(comment.style.textAlign, 'right');
      assert.equal(measured.preview.find(item => item.text === 'CUSTOMER').attributes['font-weight'], 'bold');
      await screenshot('01-default');
    });
    await check('wide-Latin-CJK-emoji-at-large-fonts-fit-every-cell-in-all-directions', async () => {
      for (const direction of ['LR', 'RL', 'TB', 'BT']) {
        const source = `erDiagram\ndirection ${direction}\nCUSTOMER["WWWM客户资料😀"] {\n string WWWM_${'wide_'.repeat(15)} "${'WWMW 中文😀 '.repeat(14).trim()}"\n int identifier PK "第二行"\n string optional\n}\nEMPTY\nCUSTOMER ||--o{ EMPTY : owns`;
        await load(source, { title: { fontSize: 48, fontStyle: 'italic' }, tableComment: { fontSize: 35, fontWeight: 'bold' }, field: { fontSize: direction === 'LR' ? 10 : 48, fontWeight: 'bold', fontStyle: 'italic' }, comment: { fontSize: direction === 'LR' ? 48 : 10, fontWeight: 'bold', fontStyle: 'italic' } });
        const result = await measurePreviewAndExport();
        assert.ok(result.scene.elements.find(element => element.id === 'er-0').width > 680);
        await measureStandalone(result.scene, result.svg);
      }
    });
    await check('all-four-role-controls-change-preview-independently-and-undo-inside-panel', async () => {
      await load(); await page.getByTestId('diagram-style-toggle').click(); await page.getByTestId('er-text-styles').waitFor();
      for (const role of ['title', 'tableComment', 'field', 'comment']) assert.equal(await page.getByTestId(`er-text-style-${role}`).count(), 1);
      await size('title', 31); await control('title', 'bold').click(); await frame();
      assert.equal(shape(await scene(), 'CUSTOMER').style.fontWeight, 'normal');
      await page.keyboard.press('Control+z'); await frame();
      assert.equal(shape(await scene(), 'CUSTOMER').style.fontWeight, 'bold');
      assert.equal(await panel().isVisible(), true);
      await page.keyboard.press('Control+Shift+z'); await frame();
      assert.equal(shape(await scene(), 'CUSTOMER').style.fontWeight, 'normal');
      await control('tableComment', 'italic').click(); await control('tableComment', 'align').selectOption('left'); await color('tableComment', '#7050aa');
      await size('field', 36); await control('field', 'bold').click(); await control('field', 'align').selectOption('center'); await color('field', '#0088cc');
      await size('comment', 48); await control('comment', 'bold').click(); await control('comment', 'italic').click(); await control('comment', 'align').selectOption('right'); await color('comment', '#bb2244');
      const current = await scene(), title = shape(current, 'CUSTOMER'), annotation = shape(current, '客户'), comment = shape(current, '客户编号😀');
      assert.equal(title.style.fontSize, 31); assert.equal(title.style.fontWeight, 'normal');
      assert.equal(annotation.style.fontStyle, 'italic'); assert.equal(annotation.style.textAlign, 'left'); assert.equal(annotation.style.stroke, '#7050aa');
      assert.equal(comment.style.fontSize, 48); assert.equal(comment.style.fontWeight, 'bold'); assert.equal(comment.style.fontStyle, 'italic'); assert.equal(comment.style.stroke, '#bb2244');
      assert.equal((await model()).source, fixture);
      await screenshot('02-role-controls');
    });
    await check('explicit-role-colors-survive-theme-switch-and-follow-theme-is-undoable', async () => {
      await page.locator('[data-diagram-style="midnight"]').click(); await frame();
      assert.equal(shape(await scene(), '客户编号😀').style.stroke, '#bb2244');
      assert.equal(shape(await scene(), '客户').style.stroke, '#7050aa');
      assert.equal(await control('comment', 'color-reset').getAttribute('aria-pressed'), 'false');
      await control('comment', 'color-reset').click(); await frame();
      assert.equal((await model()).erStyle.comment.color, undefined);
      assert.notEqual(shape(await scene(), '客户编号😀').style.stroke, '#bb2244');
      await page.keyboard.press('Control+z'); await frame();
      assert.equal(shape(await scene(), '客户编号😀').style.stroke, '#bb2244');
      await page.keyboard.press('Escape'); await frame();
      await measurePreviewAndExport(); await screenshot('03-styled-midnight');
    });
    await check('native-save-reopen-preserves-source-and-role-style-and-all-exported-glyphs', async () => {
      const before = await model(), saved = await exportFile();
      const persisted = JSON.parse(Buffer.from(saved.base64, 'base64').toString('utf8'));
      assert.deepEqual(persisted.erStyle, before.erStyle); assert.equal(persisted.source, fixture);
      await page.evaluate(base64 => window.__erEditor.value.markSaved(base64), saved.base64); assert.equal((await state()).dirty, false);
      const mmd = await exportFile('mmd'); assert.equal(Buffer.from(mmd.base64, 'base64').toString('utf8'), fixture);
      await page.evaluate(async base64 => { window.__erNative.value = { id: crypto.randomUUID(), name: 'reopened.owflow', kind: 'diagram', base64 }; await window.__erNextTick(); }, saved.base64);
      await preview().waitFor(); await frame();
      assert.deepEqual((await model()).erStyle, before.erStyle); assert.equal((await model()).source, fixture); assert.equal((await state()).dirty, false);
      await measurePreviewAndExport();
      const png = await exportFile('png'); assert.equal(Buffer.from(png.base64, 'base64').subarray(1, 4).toString(), 'PNG');
    });
    await check('narrow-style-panel-fits-and-keeps-native-input-keys-and-tab-focus', async () => {
      await page.setViewportSize({ width: 640, height: 850 }); await frame();
      await page.getByTestId('diagram-style-toggle').click(); await panel().waitFor();
      assert.equal(await control('title', 'font-size').evaluate(element => element === document.activeElement), true);
      const bounds = await panel().evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth }));
      assert.ok(bounds.width <= bounds.viewport && bounds.scroll <= bounds.client + 1, 'dialog has no horizontal overflow');
      const previous = Number(await control('title', 'font-size').inputValue());
      await control('title', 'font-size').press('ArrowUp');
      assert.equal(Number(await control('title', 'font-size').inputValue()), previous + 1, 'numeric arrows edit the font size');
      await control('title', 'font-size').press('Tab'); await frame();
      assert.equal((await model()).erStyle.title.fontSize, previous + 1);
      await page.keyboard.press('Control+z'); await frame();
      assert.equal((await model()).erStyle.title.fontSize, previous);
      const focusables = panel().locator('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
      await focusables.last().focus(); await page.keyboard.press('Tab');
      assert.equal(await focusables.first().evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focusables.last().evaluate(element => element === document.activeElement), true);
      await control('title', 'font-size').focus();
      await screenshot('04-narrow-controls');
      await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1480, height: 1000 }); await frame();
    });
    await check('ER-controls-are-hidden-for-class-diagrams', async () => {
      await load('classDiagram\nclass CUSTOMER["客户"] {\n+String name\n+run()\n}');
      await page.getByTestId('diagram-style-toggle').click(); await panel().waitFor();
      assert.equal(await page.getByTestId('er-text-styles').count(), 0);
    });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    report.ok = true; delete report.stage; persist(); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    report.failure = error.stack || String(error); persist(); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(report.failure); process.exitCode = 1;
  } finally { if (browser) await browser.close(); if (server) await server.close(); }
})();
