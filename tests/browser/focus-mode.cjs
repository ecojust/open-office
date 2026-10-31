/* Actual Vue shell and packaged Rust/WASM: full-window editing must resize the
 * live editor without recreating its session or losing content/history.
 * Run directly after building the existing engines; no package/release changes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_FOCUS_OUTPUT || path.join(root, 'test-results/focus-mode'));
const allKinds = ['word', 'sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram', 'schedule'];
const kinds = process.env.OFFICE_FOCUS_KINDS?.split(',') || allKinds;
assert.ok(kinds.length && kinds.every(kind => allKinds.includes(kind)) && new Set(kinds).size === kinds.length);
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, kinds, completeSuite: kinds.length === allKinds.length,
  runtime: 'Actual Vue shell and locally packaged Rust/WASM editors in Chromium; real pointer/keyboard entry and exit',
  limitations: ['Installed native WebViews and operating-system fullscreen are separate checks.',
    'Programmatic editor commands seed fixtures and verify presentation/canvas history; post-resize Word, Sheet, PDF, Notebook, diagram and schedule edits use browser input.',
    'Each editor runs in a fresh browser lifetime to bound WASM memory. Holiday responses are deterministic fixtures.'],
  checks: [], dimensions: [], screenshots: [], errors: [], consoleErrors: [], externalRequests: [] };
const files = ['src/App.vue', 'src/style.css', 'src/components/ScheduleEditor.vue', 'src/components/RustPdfEditor.vue',
  ...['word', 'sheet', 'presentation', 'pdf'].map(name => `public/office-${name}/manifest.json`)];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
let server, browser, page, kind;
const canvasIds = { word: 'office-word-canvas', sheet: 'office-sheet-canvas', presentation: 'office-presentation-canvas', pdf: 'pdf-canvas' };
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready() {
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    if (app?.active?.loadError) throw Error(app.active.loadError);
    return app?.active?.ready && !app.busy;
  }, null, { timeout: 120000 });
  await frames();
}
async function call(method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.active)[method](...args);
  }, { method, args });
}
async function tool(name, args = {}) {
  return page.evaluate(async ({ name, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.active).mcpExecute(name, args, () => {});
  }, { name, args });
}
async function content() {
  if (kind === 'word') return (await call('inspect')).text;
  if (kind === 'sheet') return (await call('query', 'cell.get', { cell: 'A1' })).value ?? '';
  if (kind === 'presentation') return (await call('query', 'slide.inspect', { index: 0 })).notes ?? '';
  if (kind === 'pdf') return (await call('query', 'document.inspect')).texts.join('\n');
  if (kind === 'note') return (await tool('note_read')).sections;
  if (kind === 'canvas' || kind === 'diagram') return call('inspectModel');
  return (await tool('schedule_read')).project;
}
async function state() {
  const snapshot = await call('inspect');
  const shell = await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState, tab = app.active;
    return { key: tab.key, dirty: tab.dirty, name: tab.document.name };
  });
  return { shell, snapshot: Object.fromEntries(['sessionId', 'documentId', 'revision', 'dirty', 'canUndo', 'canRedo'].filter(key => key in snapshot).map(key => [key, snapshot[key]])), content: await content() };
}
async function capture(name) {
  await frames(); const filename = `${name}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage: true }); report.screenshots.push(filename); persist();
}
async function clickable(locator) {
  assert.ok(await locator.isVisible()); assert.ok(await locator.isEnabled());
  assert.ok(await locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1 &&
      element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  }), 'Control is in the viewport and owns its actual pointer hit target');
}
const isFocus = () => page.locator('.app-shell').evaluate(element => element.classList.contains('focus-mode'));
async function enter() {
  await clickable(page.getByTestId('shell-focus-enter')); await page.getByTestId('shell-focus-enter').click();
  await page.locator('.app-shell.focus-mode').waitFor(); await frames();
  await clickable(page.getByTestId('shell-focus-exit'));
  for (const selector of ['.sidebar', '[data-testid="global-toolbar"]', '.tab-strip', '.document-mcp-bar', '.editor-status']) {
    assert.equal(await page.locator(selector).isVisible(), false, `Hidden shell surface ${selector}`);
  }
  const bar = await page.locator('.editor-focus-bar').boundingBox(); assert.ok(bar.height <= 32, 'Exit strip stays compact');
}
async function exit() {
  await clickable(page.getByTestId('shell-focus-exit')); await page.getByTestId('shell-focus-exit').click();
  await page.locator('.app-shell.focus-mode').waitFor({ state: 'hidden' }); await frames();
  assert.ok(await page.getByTestId('global-toolbar').isVisible()); assert.ok(await page.locator('.tab-strip').isVisible());
}
async function create() {
  await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-' + kind).click(); await ready();
  if (kind === 'schedule') {
    const dialog = page.getByTestId('schedule-project-dialog'); await dialog.waitFor();
    await dialog.getByTestId('schedule-project-title').fill('全屏编辑 · 产品上线计划');
    await dialog.getByTestId('schedule-project-start').fill('2026-06-01');
    await dialog.getByTestId('schedule-project-end').fill('2026-07-10');
    await dialog.getByTestId('schedule-project-confirm').click(); await dialog.waitFor({ state: 'hidden' });
    await tool('schedule_edit', { operations: [
      { op: 'role.add', role: { id: 'alice', name: '小林', role: '设计', color: '#4376d4' } },
      { op: 'role.add', role: { id: 'bob', name: '小周', role: '研发', color: '#2f9b7f' } },
      { op: 'event.add', event: { id: 'overall', roleId: null, title: '整体交付', startDate: '2026-06-01', endDate: '2026-06-19' } },
      { op: 'event.add', event: { id: 'design', roleId: 'alice', title: '交互设计', startDate: '2026-06-01', endDate: '2026-06-05' } },
      { op: 'event.add', event: { id: 'dev', roleId: 'bob', title: '功能开发', startDate: '2026-06-08', endDate: '2026-06-19' } },
    ] });
  } else if (kind === 'word') await tool('word_insert_text', { text: '全屏前的文稿内容 ' });
  else if (kind === 'sheet') await tool('sheet_set_cell', { cell: 'A1', input: '全屏前的单元格' });
  else if (kind === 'presentation') await call('command', 'slide.notes', { index: 0, text: '全屏前的演示备注' });
  else if (kind === 'pdf') await tool('pdf_add_text', { text: '全屏前的 PDF 文字', page: 0, x: 42, y: 72, width: 330, height: 60 });
  else if (kind === 'note') await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('全屏前的页面标题');
  else if (kind === 'canvas') await tool('canvas_add_shape', { text: '全屏前的图形', x: 80, y: 80, width: 240, height: 100 });
  else if (kind === 'diagram') await page.getByTestId('diagram-source').fill('flowchart LR\n A[全屏前] --> B[文档内容]');
  await call('prepareDeactivate'); await frames();
}
async function postResizeEdit() {
  if (kind === 'word') {
    const snapshot = await call('inspect'), box = await page.getByTestId(canvasIds.word).boundingBox();
    const [x, y, width, height] = snapshot.ui.pages[0];
    await page.mouse.click(box.x + x + width * .6, box.y + Math.min(y + Math.min(180, height / 4), box.height - 40));
    await page.keyboard.press('Control+End'); await page.keyboard.insertText('全屏中继续输入');
  } else if (kind === 'sheet') {
    const snapshot = await call('inspect'), box = await page.getByTestId(canvasIds.sheet).boundingBox();
    const cell = snapshot.ui.visibleCells.find(cell => cell.cell === 'A1'); assert.ok(cell);
    const [x, y, width, height] = cell.rect;
    await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2); await frames(); await page.keyboard.press('F2');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-sheet-input');
    await page.keyboard.press('Control+a'); await page.keyboard.insertText('全屏中继续输入'); await page.keyboard.press('Enter');
  } else if (kind === 'pdf') {
    await call('command', 'edit.text'); await frames();
    const ui = await call('query', 'ui.state'), box = await page.getByTestId(canvasIds.pdf).boundingBox();
    const [left, top, right, bottom] = ui.active.pages_on_screen[0].rect;
    await page.mouse.click(box.x + left + (right - left) * .2, box.y + top + (bottom - top) * .5);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pdf-input');
    await page.keyboard.insertText('全屏中继续输入');
  } else if (kind === 'note') await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('全屏中继续输入');
  else if (kind === 'diagram') await page.getByTestId('diagram-source').fill('flowchart LR\n A[全屏中继续输入] --> B[实时预览]');
  else if (kind === 'schedule') {
    await page.getByTestId('schedule-event-design').dblclick(); const dialog = page.getByTestId('schedule-event-dialog'); await dialog.waitFor();
    await dialog.getByTestId('schedule-event-title').fill('全屏中继续编辑事件');
    await dialog.getByTestId('schedule-event-confirm').click(); await dialog.waitFor({ state: 'hidden' });
  } else if (kind === 'presentation') await call('command', 'slide.notes', { index: 0, text: '全屏中继续编辑演示备注' });
  else if (kind === 'canvas') await tool('canvas_add_shape', { text: '全屏中继续添加图形', x: 360, y: 80, width: 240, height: 100 });
  await call('prepareDeactivate'); await frames();
}
async function scheduleExtras() {
  await enter();
  for (const selector of ['.schedule-project-name', '[data-testid="schedule-settings"]', '[data-testid="schedule-roles"]', '[data-testid="schedule-import"]']) assert.equal(await page.locator(selector).isVisible(), false);
  for (const id of ['schedule-mode-people', 'schedule-mode-global', 'schedule-view-menu', 'schedule-add-event', 'schedule-export-menu']) assert.ok(await page.getByTestId(id).isVisible());
  await tool('schedule_set_view', { selectedEventId: null });
  const beforeMove = await content(), first = await page.getByTestId('schedule-event-design').boundingBox();
  assert.equal(await page.getByTestId('schedule-event-design').getAttribute('aria-pressed'), 'false');
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 64, first.y + first.height / 2, { steps: 8 });
  await page.locator('.schedule-event-ghost').waitFor(); await page.mouse.up(); await frames();
  assert.notDeepEqual(await content(), beforeMove, 'First drag on an unselected event commits instead of being cancelled by a layout resize');
  await call('undo'); assert.deepEqual(await content(), beforeMove);
  const baseline = await state();
  for (const gesture of ['move', 'end', 'height', 'track']) {
    const target = gesture === 'track' ? page.getByTestId('track-resize-alice') : page.getByTestId('schedule-event-design');
    const box = await target.boundingBox();
    const x = gesture === 'end' ? box.x + box.width - 3 : box.x + box.width / 2;
    const y = gesture === 'height' ? box.y + box.height - 3 : box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (gesture === 'move' || gesture === 'end' ? 64 : 0), y + (gesture === 'height' ? -40 : gesture === 'track' ? 28 : 0), { steps: 8 });
    if (gesture === 'track') await page.locator('.track-resizing').waitFor(); else await page.locator('.schedule-event-ghost').waitFor();
    await page.keyboard.press('Escape'); await frames();
    assert.equal(await isFocus(), true, `${gesture} Escape cancels the gesture without leaving fullscreen`);
    await page.mouse.up(); await frames();
    assert.equal(await page.locator('.schedule-event-ghost, .track-resizing').count(), 0);
    assert.deepEqual(await state(), baseline, `${gesture} cancellation retains original data, revision and dirty state`);
  }
  pass('schedule: first unselected drag commits; move/date/height/track resize Escape cancels only the gesture');
  await page.getByTestId('schedule-add-event').click(); await page.getByTestId('schedule-event-dialog').waitFor();
  await page.getByTestId('schedule-event-title').fill('取消的临时草稿');
  await clickable(page.getByTestId('shell-focus-exit')); await page.getByTestId('shell-focus-exit').click();
  assert.equal(await isFocus(), true);
  assert.equal(await page.getByTestId('schedule-event-dialog').evaluate(element => element.contains(document.activeElement)), true, 'Blocked mode changes restore focus inside the local modal');
  await page.keyboard.press('Escape');
  await page.getByTestId('schedule-event-dialog').waitFor({ state: 'hidden' }); assert.equal(await isFocus(), true, 'Escape closes the local dialog before leaving fullscreen');
  assert.deepEqual(await state(), baseline);
  await page.getByTestId('schedule-view-menu').click(); await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('schedule-view-menu').evaluate(element => element.parentElement.open), false);
  assert.equal(await isFocus(), true, 'Escape closes a menu first');
  await page.keyboard.press('Control+Shift+s'); await page.getByTestId('save-format-dialog').waitFor();
  await page.keyboard.press('Escape'); await page.getByTestId('save-format-dialog').waitFor({ state: 'hidden' });
  assert.equal(await isFocus(), true, 'Shell Save As can still be cancelled without leaving fullscreen');
  assert.deepEqual(await state(), baseline);
  pass('schedule: project chrome hides; local dialog, menu and Save As Escape retain fullscreen and data');
  await capture('schedule-fullscreen-light');
  await exit(); await page.getByTestId('theme-dark').click(); await page.setViewportSize({ width: 800, height: 600 }); await frames(); await enter();
  await capture('schedule-fullscreen-dark-narrow');
  await clickable(page.getByTestId('schedule-add-event')); await clickable(page.getByTestId('shell-focus-exit'));
  await page.getByTestId('schedule-mode-global').click(); assert.equal(await page.getByTestId('schedule-mode-global').getAttribute('aria-pressed'), 'true');
  await capture('schedule-fullscreen-event-narrow');
  await page.getByTestId('schedule-mode-people').click();
  assert.deepEqual(await content(), baseline.content); await exit();
  for (const id of ['schedule-settings', 'schedule-roles', 'schedule-import']) assert.ok(await page.getByTestId(id).isVisible());
  pass('schedule: dark/narrow and people/event layouts retain clickable exit and restore settings');
  await page.getByTestId('theme-light').click(); await page.setViewportSize({ width: 1440, height: 1000 }); await frames();
  await enter(); await page.getByTestId('schedule-timeline-scroll').focus(); await page.keyboard.press('Escape');
  await page.locator('.app-shell.focus-mode').waitFor({ state: 'hidden' });
  assert.equal(await isFocus(), false, 'Unconsumed Escape returns to normal view');
  await enter();
  await page.evaluate(() => { document.querySelector('#app').__vue_app__._instance.setupState.home = true; }); await frames();
  assert.equal(await isFocus(), false, 'Returning home resets focus mode');
  await page.locator('.sidebar-documents button').last().click(); await ready();
  assert.equal(await isFocus(), false); assert.deepEqual(await content(), baseline.content);
  pass('schedule: unconsumed Escape and returning home exit without losing the live project');
}
async function group(value) {
  kind = value; report.stage = kind; persist(); console.log('GROUP', kind);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    await context.route(/^https:\/\/(?:raw\.githubusercontent\.com\/NateScarlet\/holiday-cn\/master\/|cdn\.jsdelivr\.net\/gh\/NateScarlet\/holiday-cn@master\/)(\d{4})\.json$/, route => {
      const year = Number(route.request().url().match(/(\d{4})\.json$/)[1]);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }, body: JSON.stringify({ year, papers: [], days: [{ name: '元旦', date: `${year}-01-01`, isOffDay: true }] }) });
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push({ kind, error: error.message }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ kind, error: message.text() }); });
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:') && !request.url().includes('/holiday-cn')) report.externalRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
    await create();
    const before = await state(), normalBox = await page.locator('.editor-content').boundingBox();
    await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      window.__focusIdentity = { handle: app.handleFor(app.active), element: [...document.querySelectorAll('.editor-content > section')].find(element => element.getBoundingClientRect().width > 0) };
    });
    if (kind === 'schedule') await capture('schedule-normal-light');
    await enter(); const focusBox = await page.locator('.editor-content').boundingBox();
    assert.ok(focusBox.width >= normalBox.width + 50, `${kind} gains horizontal working space`);
    assert.ok(focusBox.height >= normalBox.height + 60, `${kind} gains vertical working space`);
    assert.ok(focusBox.x < 1 && focusBox.y <= 33 && Math.abs(focusBox.width - 1440) < 1);
    report.dimensions.push({ kind, normal: normalBox, focus: focusBox });
    assert.deepEqual(await state(), before, 'Enter only changes the view');
    assert.equal(await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return window.__focusIdentity.handle === app.handleFor(app.active) && window.__focusIdentity.element.isConnected;
    }), true, 'The live editor and its handle are retained');
    if (canvasIds[kind]) {
      const canvas = page.getByTestId(canvasIds[kind]);
      await page.waitForFunction(id => {
        const canvas = document.querySelector(`[data-testid="${id}"]`), box = canvas.getBoundingClientRect();
        return Math.abs(canvas.width / devicePixelRatio - box.width) <= 2 && Math.abs(canvas.height / devicePixelRatio - box.height) <= 2;
      }, canvasIds[kind]);
      const size = await canvas.boundingBox(); assert.ok(size.width > normalBox.width - 5, 'Rust canvas resizes with the new container');
    }
    pass(`${kind}: fullscreen expands live editor and preserves identity, content, revision, dirty state and history flags`);
    await postResizeEdit(); const edited = await content(); assert.notDeepEqual(edited, before.content);
    await call('undo'); assert.notDeepEqual(await content(), edited, 'Undo stays usable after resizing');
    await call('redo'); assert.deepEqual(await content(), edited, 'Redo restores the post-resize edit');
    if (kind === 'presentation') {
      await page.getByTestId(canvasIds.presentation).focus(); await page.keyboard.press('F5');
      await page.waitForFunction(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return Boolean((await app.handleFor(app.active).query('ui.inspect')).showing);
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState;
        return !(await app.handleFor(app.active).query('ui.inspect')).showing;
      });
      assert.equal(await isFocus(), true, 'Escape stops the slide show before leaving fullscreen editing');
      assert.deepEqual(await content(), edited);
      pass('presentation: actual F5 and Escape stop only the slide show while retaining fullscreen editing');
    }
    const afterEdit = await state(); await exit();
    assert.deepEqual(await state(), afterEdit, 'Exit does not modify the document');
    const restoredBox = await page.locator('.editor-content').boundingBox();
    assert.ok(Math.abs(restoredBox.width - normalBox.width) <= 2 && Math.abs(restoredBox.height - normalBox.height) <= 2, 'Normal layout is restored');
    pass(`${kind}: editing after resize, undo/redo and click exit preserve content and restore normal layout`);
    if (kind === 'schedule') await scheduleExtras();
  } catch (error) {
    if (page) await capture(kind + '-failure').catch(() => {});
    throw error;
  } finally { await browser?.close(); browser = undefined; page = undefined; persist(); }
}
(async () => {
  report.sourceBefore = hashes();
  try {
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), optimizeDeps: { entries: ['index.html'] },
      server: { host: '127.0.0.1', port: Number(process.env.OFFICE_FOCUS_PORT || 5341), strictPort: true, hmr: false,
        watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen(); for (const value of kinds) await group(value);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.sourceAfter = hashes(); assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Production code is unchanged during browser verification');
    report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally { persist(); await browser?.close(); await server?.close(); console.log(output); }
})();
