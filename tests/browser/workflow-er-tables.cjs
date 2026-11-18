/* Real ER table preview, source navigation, panning and production file exports.
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
const viewport = () => page.getByTestId('diagram-preview-viewport');
const sourceInput = () => page.getByTestId('diagram-source');
const panel = () => page.getByTestId('diagram-style-panel');
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function load(source = fixture, legacyERStyle) {
  await page.evaluate(async ({ source, legacyERStyle }) => {
    const { createDocument, serializeDocument } = await import('/src/workflow/core/documents.ts');
    const { bytesToBase64 } = await import('/src/shared/document.ts');
    const document = createDocument('mermaid'); document.source = source;
    const payload = JSON.parse(serializeDocument(document));
    if (legacyERStyle) payload.erStyle = legacyERStyle;
    window.__erNative.value = { id: crypto.randomUUID(), name: 'ER表格.owflow', kind: 'diagram', base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload))) };
    await window.__erNextTick();
  }, { source, legacyERStyle });
  await preview().waitFor(); await page.evaluate(() => document.fonts.ready); await frame();
}
async function exportFile(format = 'owflow') { return page.evaluate(format => window.__erEditor.value.exportFile({ format }), format); }
async function screenshot(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); persist(); }
async function sourceSelection() { return sourceInput().evaluate(element => { const api = element.closest('.diagram-source-editor').__vueParentComponent.exposed; return { start: api.selectionStart, end: api.selectionEnd, text: api.value.slice(api.selectionStart, api.selectionEnd), focused: document.activeElement === element }; }); }
async function selectSource(start = 0) { await sourceInput().evaluate((element, start) => { const api = element.closest('.diagram-source-editor').__vueParentComponent.exposed; api.setSelectionRange(start, start); api.focus(); }, start); await frame(); }
async function scrollPosition() { return viewport().evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop })); }
async function worldPoint(point) { return preview().locator('svg').evaluate((svg, point) => { const p = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y }; }, point); }
async function foldHeader(label) {
  const header = sourceInput().locator('.cm-line').filter({ hasText: label }); await header.waitFor();
  const box = await header.boundingBox();
  const point = await page.locator('.cm-foldGutter').evaluate((gutter, y) => {
    const marker = [...gutter.querySelectorAll('.cm-gutterElement')].find(element => element.textContent === '⌄' && Math.abs(element.getBoundingClientRect().top - y) < 3);
    if (!marker) throw Error('Missing fold marker for visible declaration');
    const box = marker.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, box.y);
  await page.mouse.click(point.x, point.y); await frame(); assert.equal(await page.locator('.cm-foldPlaceholder').count(), 1);
}
async function assertRevealed(source, declaration) {
  const selected = await sourceSelection();
  assert.equal(selected.start, source.indexOf(declaration)); assert.equal(selected.text, declaration); assert.equal(selected.focused, true);
  const bounds = await sourceInput().locator('.cm-line').filter({ hasText: declaration }).boundingBox();
  const scroller = await page.locator('.diagram-source-editor .cm-scroller').boundingBox();
  assert.ok(bounds && bounds.y >= scroller.y - 1 && bounds.y + bounds.height <= scroller.y + scroller.height + 1, 'declaration and source selection are visible');
}
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
      window.__erEditor = ref(); window.__erNextTick = nextTick; window.__erTheme = ref('light'); window.__erActive = ref(true);
      createApp({ setup() { return () => h(WorkflowEditor, { key: window.__erNative.value.id, ref: window.__erEditor, document: window.__erNative.value, theme: window.__erTheme.value, active: window.__erActive.value }); } }).mount('#er-app');`;
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
    await check('wide-Latin-CJK-emoji-fit-every-cell-at-default-typography-in-all-directions', async () => {
      for (const direction of ['LR', 'RL', 'TB', 'BT']) {
        const source = `erDiagram\ndirection ${direction}\nCUSTOMER["WWWM客户资料😀"] {\n string WWWM_${'wide_'.repeat(15)} "${'WWMW 中文😀 '.repeat(14).trim()}"\n int identifier PK "第二行"\n string optional\n}\nEMPTY\nCUSTOMER ||--o{ EMPTY : owns`;
        await load(source);
        const result = await measurePreviewAndExport();
        assert.ok(result.scene.elements.find(element => element.id === 'er-0').width > 680);
        await measureStandalone(result.scene, result.svg);
      }
    });
    await check('legacy-role-styles-are-ignored-and-no-independent-ER-controls-remain', async () => {
      await load(); const defaults = await scene();
      await load(fixture, { title: { fontSize: 48, fontWeight: 'normal', color: '#ee1122' }, tableComment: { fontSize: 40, fontStyle: 'italic' }, field: { fontSize: 30, textAlign: 'right' }, comment: { fontSize: 48, textAlign: 'left', color: '#bb2244' } });
      assert.equal(Object.hasOwn(await model(), 'erStyle'), false);
      assert.deepEqual(await scene(), defaults, 'legacy appearance overrides do not change default rendering');
      await measurePreviewAndExport();
      await page.getByTestId('diagram-style-toggle').click(); await panel().waitFor();
      assert.equal(await page.getByTestId('er-text-styles').count(), 0);
      assert.equal(await panel().locator('[data-er-role], [data-testid^="er-"]').count(), 0);
      assert.equal(await panel().getByTestId('diagram-style-card').count(), 10);
      await screenshot('02-theme-controls');
    });
    await check('theme-changes-and-undo-preserve-default-ER-typography-and-source', async () => {
      const before = await scene();
      await page.locator('[data-diagram-style="midnight"]').click(); await frame();
      const themed = await scene(); assert.notEqual(themed.background, before.background);
      for (const element of before.elements.filter(element => element.type === 'shape' && element.text)) {
        const actual = themed.elements.find(candidate => candidate.id === element.id);
        for (const property of ['fontSize', 'fontWeight', 'fontStyle', 'textAlign', 'textWrap']) assert.equal(actual.style[property], element.style[property]);
      }
      await page.keyboard.press('Control+z'); await frame();
      assert.deepEqual(await scene(), before); assert.equal(await panel().isVisible(), true);
      await page.keyboard.press('Control+Shift+z'); await frame(); assert.deepEqual(await scene(), themed);
      assert.equal((await model()).source, fixture); assert.equal(Object.hasOwn(await model(), 'erStyle'), false);
      await page.keyboard.press('Escape'); await frame();
      await measurePreviewAndExport(); await screenshot('03-styled-midnight');
    });
    await check('native-save-reopen-preserves-source-and-theme-without-legacy-ER-overrides', async () => {
      const before = await model(), saved = await exportFile();
      const persisted = JSON.parse(Buffer.from(saved.base64, 'base64').toString('utf8'));
      assert.equal(Object.hasOwn(persisted, 'erStyle'), false); assert.equal(persisted.diagramStyle, before.diagramStyle); assert.equal(persisted.source, fixture);
      await page.evaluate(base64 => window.__erEditor.value.markSaved(base64), saved.base64); assert.equal((await state()).dirty, false);
      const mmd = await exportFile('mmd'); assert.equal(Buffer.from(mmd.base64, 'base64').toString('utf8'), fixture);
      await page.evaluate(async base64 => { window.__erNative.value = { id: crypto.randomUUID(), name: 'reopened.owflow', kind: 'diagram', base64 }; await window.__erNextTick(); }, saved.base64);
      await preview().waitFor(); await frame();
      assert.equal(Object.hasOwn(await model(), 'erStyle'), false); assert.equal((await model()).diagramStyle, before.diagramStyle); assert.equal((await model()).source, fixture); assert.equal((await state()).dirty, false);
      await measurePreviewAndExport();
      const png = await exportFile('png'); assert.equal(Buffer.from(png.base64, 'base64').subarray(1, 4).toString(), 'PNG');
    });
    await check('narrow-theme-panel-fits-and-keeps-focus-without-independent-ER-settings', async () => {
      await page.setViewportSize({ width: 640, height: 850 }); await frame();
      await page.getByTestId('diagram-style-toggle').click(); await panel().waitFor();
      const selected = panel().locator('[data-diagram-style="midnight"]');
      assert.equal(await selected.evaluate(element => element === document.activeElement), true);
      assert.equal(await panel().locator('input, select, [data-er-role]').count(), 0);
      const bounds = await panel().evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth }));
      assert.ok(bounds.width <= bounds.viewport && bounds.scroll <= bounds.client + 1, 'dialog has no horizontal overflow');
      const focusables = panel().locator('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
      await focusables.last().focus(); await page.keyboard.press('Tab');
      assert.equal(await focusables.first().evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focusables.last().evaluate(element => element === document.activeElement), true);
      await selected.focus();
      await screenshot('04-narrow-controls');
      await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1480, height: 1000 }); await frame();
    });
    await check('source-entity-styles-survive-theme-and-export-without-document-role-settings', async () => {
      const styledSource = `${fixture}\nclassDef highlighted fill:#ffffcc,stroke:#112233,stroke-width:3px,color:#123456,font-size:48px,font-weight:bold,font-style:italic\nclass CUSTOMER highlighted\nstyle ORDER fill:#e2e8f0,stroke:#556677,color:#334455`;
      await load(styledSource); const styled = await scene();
      const table = styled.elements.find(element => element.id === 'er-0');
      assert.equal(table.style.fill, '#ffffcc'); assert.equal(table.style.stroke, '#112233'); assert.equal(table.style.strokeWidth, 3);
      const textMembers = styled.elements.filter(element => element.groupId === 'er-0-card' && element.type === 'shape' && element.text);
      for (const member of textMembers) {
        assert.equal(member.style.fontSize, 48); assert.equal(member.style.fontWeight, 'bold'); assert.equal(member.style.fontStyle, 'italic'); assert.equal(member.style.stroke, '#123456');
      }
      assert.equal(shape(styled, 'ORDER').style.fontSize, 16, 'entity colors alone leave default typography unchanged');
      const field = styled.elements.find(element => element.id === 'er-1-field-0'); assert.equal(field.style.fontSize, 14); assert.equal(field.style.fontWeight, 'normal');
      await page.getByTestId('diagram-style-toggle').click(); await page.locator('[data-diagram-style="midnight"]').click(); await page.keyboard.press('Escape'); await frame();
      const result = await measurePreviewAndExport(); await measureStandalone(result.scene, result.svg);
      for (const id of ['er-0', 'er-1', ...textMembers.map(element => element.id)]) {
        const expected = styled.elements.find(element => element.id === id), actual = result.scene.elements.find(element => element.id === id);
        assert.equal(actual.style.stroke, expected.style.stroke); assert.equal(actual.style.fill, expected.style.fill);
      }
      assert.equal((await model()).source, styledSource); assert.equal(Object.hasOwn(await model(), 'erStyle'), false);
      const mmd = await exportFile('mmd'); assert.equal(Buffer.from(mmd.base64, 'base64').toString('utf8'), styledSource);
      const saved = JSON.parse(Buffer.from((await exportFile()).base64, 'base64').toString('utf8'));
      assert.equal(saved.source, styledSource); assert.equal(Object.hasOwn(saved, 'erStyle'), false);
      await screenshot('05-source-entity-style');
      await load(`${fixture}\nstyle CUSTOMER fill:#ffffff`);
      await page.getByTestId('diagram-style-toggle').click(); await page.locator('[data-diagram-style="midnight"]').click(); await page.keyboard.press('Escape'); await frame();
      const whiteTable = await measurePreviewAndExport();
      assert.equal(whiteTable.scene.elements.find(element => element.id === 'er-0').style.fill, '#ffffff');
      for (const member of whiteTable.scene.elements.filter(element => element.groupId === 'er-0-card' && element.type === 'shape' && element.text)) {
        const color = member.style.stroke; assert.match(color, /^#[0-9a-f]{6}$/i);
        const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
        const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
        assert.ok(1.05 / (luminance + .05) >= 4.5, `Default text stays readable on the source-defined white table after midnight theme: ${member.text} (${color})`);
      }
    });
    await check('table-header-body-field-and-comment-clicks-reveal-the-correct-declaration', async () => {
      const source = ['# 前言😀', 'erDiagram', 'A ||--o{ B : 先引用后定义', ...Array.from({ length: 60 }, (_, index) => `# source spacing ${index}`), 'A["重复别名"] { # 表定义后有注释', ' string left_name "左字段注释😀"', '}', 'B["重复别名"] { # 第二张表', ' int right_id PK "右字段注释😀"', '}'].join('\r\n');
      await load(source); const before = await model(), initial = await state();
      for (const [id, declaration] of [['er-0-title', 'A["重复别名"] {'], ['er-0-tableComment', 'A["重复别名"] {'], ['er-0-field-0', 'A["重复别名"] {'], ['er-0-comment-0', 'A["重复别名"] {'], ['er-1-title', 'B["重复别名"] {'], ['er-1-field-0', 'B["重复别名"] {'], ['er-1-comment-0', 'B["重复别名"] {']]) {
        await selectSource(); await preview().locator(`[data-element-id="${id}"]`).click(); await frame(); await assertRevealed(source, declaration);
      }
      await selectSource(); const table = (await scene()).elements.find(element => element.id === 'er-1');
      const body = await worldPoint({ x: table.x + table.width - 4, y: table.y + table.height - 4 });
      await page.mouse.click(body.x, body.y); await frame(); await assertRevealed(source, 'B["重复别名"] {');
      const declaration = 'A["重复别名"] {';
      await selectSource(source.indexOf(declaration)); await foldHeader(declaration); await selectSource();
      await preview().locator('[data-element-id="er-0-field-0"]').click(); await frame();
      assert.equal(await page.locator('.cm-foldPlaceholder').count(), 0, 'table click unfolds the declaration despite its inline comment');
      await assertRevealed(source, declaration);
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), initial, 'source navigation creates no content or history changes');
      await screenshot('05-table-source-navigation');
    });
    await check('keyboard-table-navigation-supports-declared-and-implicit-entities', async () => {
      const examples = [[fixture, ['CUSTOMER["客户"] {', 'ORDER {']], ['erDiagram\nA ||--o{ B : implicit', ['A ||--o{ B : implicit', 'A ||--o{ B : implicit']]];
      for (const [source, expected] of examples) {
        await load(source); const initial = await state();
        assert.equal(await preview().getByTestId('diagram-table-source').count(), 2);
        for (const [index, key] of [[0, 'Enter'], [1, 'Space']]) {
          await selectSource(); const target = preview().locator(`[data-testid="diagram-table-source"][data-element-id="er-${index}"]`);
          assert.equal(await target.getAttribute('role'), 'button'); assert.equal(await target.getAttribute('tabindex'), '0');
          await target.focus(); await page.keyboard.press(key); await frame(); await assertRevealed(source, expected[index]);
        }
        assert.deepEqual(await state(), initial);
      }
    });
    await check('blank-and-table-drag-pan-with-sticky-threshold-and-outside-pointer-capture', async () => {
      await load(); const before = await model(), initial = await state(); await selectSource();
      const bounds = await viewport().boundingBox(), blank = { x: bounds.x + bounds.width - 100, y: bounds.y + bounds.height - 80 };
      const start = await scrollPosition();
      await page.mouse.move(blank.x, blank.y); await page.mouse.down(); await page.mouse.move(blank.x + 50, blank.y + 45, { steps: 6 }); await page.mouse.up(); await frame();
      const moved = await scrollPosition(); assert.ok(Math.abs(moved.x - (start.x - 50)) < 2 && Math.abs(moved.y - (start.y - 45)) < 2, 'blank drag follows the pointer');
      assert.equal((await sourceSelection()).start, 0);
      await viewport().evaluate(element => { element.scrollLeft = 240; element.scrollTop = 240; }); await frame();
      const titleBox = await preview().locator('[data-element-id="er-0-title"]').boundingBox(), point = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x - 40, point.y + 15, { steps: 4 });
      assert.ok((await scrollPosition()).x > 260); await page.mouse.move(point.x, point.y, { steps: 4 }); await page.mouse.up(); await frame();
      assert.equal((await sourceSelection()).start, 0, 'returning to the original point after a drag does not activate the table');
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 1, point.y + 1); await page.mouse.up(); await frame();
      await assertRevealed(fixture, 'CUSTOMER["客户"] {');
      await selectSource(); await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(bounds.x - 80, point.y + 50, { steps: 8 }); await frame();
      assert.equal(await viewport().evaluate(element => element.classList.contains('is-panning')), true);
      assert.ok((await scrollPosition()).x > 300, 'pointer capture keeps panning outside the viewport');
      await page.mouse.up(); await frame(); assert.equal((await sourceSelection()).start, 0);
      assert.equal(await viewport().evaluate(element => element.classList.contains('is-panning')), false);
      assert.deepEqual(await model(), before); assert.deepEqual(await state(), initial);
    });
    await check('native-wheel-scroll-and-control-wheel-zoom-remain-available', async () => {
      await load(); const initial = await state(), box = await viewport().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const start = await scrollPosition(); await page.mouse.wheel(0, 120);
      await page.waitForFunction(y => document.querySelector('[data-testid="diagram-preview-viewport"]').scrollTop > y + 30, start.y);
      const reset = page.getByRole('button', { name: '重置预览缩放', exact: true }); assert.equal(await reset.textContent(), '100%');
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="重置预览缩放"]').textContent.replace('%', '')) > 100);
      await reset.click(); await frame(); assert.equal(await reset.textContent(), '100%'); assert.deepEqual(await state(), initial);
    });
    await check('escape-blur-pointer-cancel-modal-and-tab-deactivation-end-drag-cleanly', async () => {
      for (const cancel of ['escape', 'blur', 'pointercancel', 'lostpointercapture', 'modal', 'inactive']) {
        await load(); await selectSource(); const initial = await state();
        const box = await preview().locator('[data-element-id="er-0-title"]').boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x - 30, point.y + 15, { steps: 3 }); await frame();
        if (cancel === 'escape') await page.keyboard.press('Escape');
        else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        else if (cancel === 'modal') await page.getByTestId('diagram-style-toggle').evaluate(element => element.click());
        else if (cancel === 'inactive') await page.evaluate(() => { window.__erActive.value = false; });
        else await viewport().dispatchEvent(cancel, { pointerId: 1, pointerType: 'mouse', bubbles: true });
        await frame(); const stopped = await scrollPosition();
        await page.mouse.move(point.x - 90, point.y + 55, { steps: 3 }); await page.mouse.up(); await frame();
        assert.deepEqual(await scrollPosition(), stopped, `${cancel}: pointer movement after cancellation does not pan`);
        assert.equal((await sourceSelection()).start, 0, `${cancel}: ending a canceled drag does not select source`);
        assert.equal(await viewport().evaluate(element => element.classList.contains('is-panning')), false);
        if (cancel === 'modal') { await page.keyboard.press('Escape'); await frame(); }
        if (cancel === 'inactive') { await page.evaluate(() => { window.__erActive.value = true; }); await frame(); }
        assert.deepEqual(await state(), initial);
      }
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
