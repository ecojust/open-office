/* Real Vue + Rust/WASM language-switch regression. No native or editor mocks.
 * Build the four hosts first, then: node tests/browser/editor-locales.cjs
 * A fresh Chromium process per editor releases its WASM memory before the next.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_LOCALE_OUTPUT || path.join(root, 'test-results/editor-locales'));
const kinds = (process.env.OFFICE_LOCALE_KINDS || 'word,sheet,presentation,pdf').split(',');
assert.ok(kinds.length && kinds.every(kind => ['word', 'sheet', 'presentation', 'pdf'].includes(kind)));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real Vue shell and local Rust/WASM in Chromium', checks: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [], limitations: ['Native WebView and operating-system file dialogs are not exercised.', 'IME coverage uses Chromium composition, not a physical operating-system input method.'] };
let server, browser, page;
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
async function frames(count = 4) { await page.evaluate(count => new Promise(resolve => { const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); }), count); }
async function until(read, accept, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await frames(2); }
  throw Error('Timed out: ' + description);
}
async function ready() {
  await until(() => page.evaluate(() => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    if (app?.active?.loadError) throw Error(app.active.loadError);
    return !!app?.active?.ready && !app.busy;
  }), Boolean, 'editor ready');
  await frames(6);
}
async function call(key, method, ...args) {
  return page.evaluate(async ({ key, method, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const tab = app.tabs.find(tab => tab.key === key);
    return app.handleFor(tab)[method](...args);
  }, { key, method, args });
}
async function currentKey() { return page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey); }
async function create(kind) {
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-' + kind).click();
  await ready();
  return currentKey();
}
async function switchTo(key) {
  await page.evaluate(key => { const app = document.querySelector('#app').__vue_app__._instance.setupState; app.changeTab(app.tabs.find(tab => tab.key === key)); }, key);
  await ready();
  assert.equal(await currentKey(), key);
}
const receipt = snapshot => Object.fromEntries(['sessionId', 'documentId', 'revision', 'dirty', 'canUndo', 'canRedo', 'selection', 'text', 'activeSlide', 'sheets', 'slides'].filter(key => key in snapshot).map(key => [key, snapshot[key]]));
async function content(kind, key) {
  if (kind === 'word') return (await call(key, 'inspect')).text;
  if (kind === 'sheet') return Promise.all(['A1', 'B1'].map(cell => call(key, 'query', 'cell.get', { cell })));
  if (kind === 'presentation') return (await call(key, 'query', 'slide.inspect', { index: 0 })).notes;
  return (await call(key, 'query', 'document.inspect')).texts;
}
async function languageEvidence(kind, key) {
  const snapshot = await call(key, 'inspect');
  if (kind === 'word' || kind === 'sheet') return snapshot.ui?.ui?.language;
  if (kind === 'presentation') return snapshot.ui?.ribbonTabs?.find(tab => tab.name === 'Home')?.label;
  return (await call(key, 'query', 'ui.state')).language;
}
async function expectLanguage(kind, key, locale) {
  const expected = locale === 'en' ? (kind === 'presentation' ? 'Home' : 'en') : kind === 'sheet' ? 'zh' : 'zh-hans';
  const value = await until(() => languageEvidence(kind, key), value => locale === 'zh-CN' && kind === 'presentation' ? /[\u3400-\u9fff]/.test(value || '') : value === expected, kind + ' canvas language ' + locale);
  assert.equal(await page.locator('html').getAttribute('lang'), locale);
  return value;
}
async function locale(value, useButton = false) {
  if (useButton) await page.getByTestId('language-toggle').click();
  else await page.evaluate(value => document.querySelector('#app').__vue_app__._instance.setupState.setLocale(value), value);
  await frames();
  assert.equal(await page.locator('html').getAttribute('lang'), value);
}
async function edit(kind, key) {
  const text = 'Locale remains 原文不变';
  if (kind === 'word') await call(key, 'command', 'text.insert', { text, raw: true });
  else if (kind === 'sheet') {
    await call(key, 'command', 'cell.set', { cell: 'A1', input: text });
    await call(key, 'command', 'cell.set', { cell: 'B1', input: '=SUM(1,2)' });
  } else if (kind === 'presentation') await call(key, 'command', 'slide.notes', { index: 0, text });
  else await call(key, 'command', 'pdf.addText', { text, page: 0, rect: [40, 100, 400, 150], size: 18 });
  await frames();
}
async function prepareDraft(kind, key, context) {
  if (kind === 'word') {
    const state = await call(key, 'inspect'), box = await page.getByTestId('office-word-canvas').boundingBox();
    assert.ok(state.ui.pages.length);
    const [x, y, width, height] = state.ui.pages[0];
    await page.mouse.click(box.x + x + width * .6, box.y + Math.min(y + Math.min(180, height / 4), box.height - 40));
    await page.keyboard.press('Control+End');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-word-input');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '未提交输入', selectionStart: 5, selectionEnd: 5 });
    await frames();
    return async () => ({ input: await page.getByTestId('office-word-input').inputValue(), focused: await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), background: await call(key, 'canBackgroundExport') });
  }
  if (kind === 'sheet') {
    const state = await call(key, 'inspect'), box = await page.getByTestId('office-sheet-canvas').boundingBox();
    const cell = state.ui.visibleCells.find(cell => cell.cell === 'A1'); assert.ok(cell);
    const [x, y, width, height] = cell.rect;
    await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2); await frames();
    await page.keyboard.press('F2');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-sheet-input');
    await page.keyboard.press('Control+a'); await page.keyboard.insertText('=SUM(1,2)+9'); await frames();
    return async () => ({ editor: (await call(key, 'inspect')).ui.editor, background: await call(key, 'canBackgroundExport') });
  }
  if (kind === 'presentation') {
    await call(key, 'command', 'insert.textBox', { text: '' });
    const state = await call(key, 'inspect');
    const selected = state.selection.shapes?.[0]; assert.ok(selected, 'New text box is selected');
    await call(key, 'command', 'text.edit', { id: selected });
    await call(key, 'focus');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-presentation-input');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '未提交输入', selectionStart: 5, selectionEnd: 5 }); await frames();
    return async () => ({ input: await page.getByTestId('office-presentation-input').inputValue(), focused: await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), background: await call(key, 'canBackgroundExport'), content: await content(kind, key) });
  }
  await call(key, 'command', 'ui.set', { key: 'panel', value: 'comments' }); await frames(6);
  const ui = await call(key, 'query', 'ui.state'), box = await page.getByTestId('pdf-canvas').boundingBox();
  await page.mouse.click(box.x + (ui.active.viewport[2] + box.width) / 2, box.y + ui.active.viewport[1] + 92);
  await page.keyboard.insertText('Unsubmitted 批注草稿'); await frames();
  assert.equal((await call(key, 'query', 'ui.state')).commentDraft?.text, 'Unsubmitted 批注草稿');
  return async () => ({ draft: (await call(key, 'query', 'ui.state')).commentDraft, background: await call(key, 'canBackgroundExport') });
}
async function run(kind) {
  report.stage = kind; persist();
  execFileSync(process.execPath, [path.join(root, `scripts/build-office-${kind}.mjs`), '--check'], { cwd: root, stdio: 'pipe' });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
    await context.addInitScript(() => localStorage.setItem('open-office.locale', 'en'));
    page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.create-card.' + kind).click(); await ready();
    await page.getByTestId('theme-light').click(); await frames(8);
    const first = await currentKey(); await expectLanguage(kind, first, 'en');
    const clean = receipt(await call(first, 'inspect'));
    assert.equal(clean.dirty, false);
    await locale('zh-CN', true); await expectLanguage(kind, first, 'zh-CN');
    assert.deepEqual(receipt(await call(first, 'inspect')), clean, 'Language keeps a blank document clean');
    await locale('en', true); await expectLanguage(kind, first, 'en');
    assert.deepEqual(receipt(await call(first, 'inspect')), clean);
    pass(kind + ': saved locale initializes the real canvas and switching leaves a blank document clean');
    await edit(kind, first);
    const before = receipt(await call(first, 'inspect')), original = await content(kind, first);
    assert.equal(before.dirty, true);
    for (const value of ['zh-CN', 'en']) {
      await locale(value, true); await expectLanguage(kind, first, value);
      assert.deepEqual(receipt(await call(first, 'inspect')), before);
      assert.deepEqual(await content(kind, first), original);
    }
    const file = `${kind}-english.png`; await page.screenshot({ path: path.join(output, file) }); report.screenshots.push(file);
    await call(first, 'undo'); assert.notDeepEqual(await content(kind, first), original);
    await call(first, 'redo'); assert.deepEqual(await content(kind, first), original);
    pass(kind + ': English/Chinese switching preserves content, selection, dirty state and undo/redo');
    const second = await create(kind), parked = receipt(await call(first, 'inspect'));
    await locale('zh-CN', true); await expectLanguage(kind, second, 'zh-CN');
    assert.deepEqual(receipt(await call(first, 'inspect')), parked);
    await switchTo(first); await expectLanguage(kind, first, 'zh-CN');
    await locale('en', true); await expectLanguage(kind, first, 'en');
    await switchTo(second); await expectLanguage(kind, second, 'en');
    pass(kind + ': global language reaches parked sessions and survives tab reactivation');
    await switchTo(first);
    const readDraft = await prepareDraft(kind, first, context);
    const draft = await readDraft(), draftReceipt = receipt(await call(first, 'inspect'));
    assert.equal(draft.background, false, 'An unfinished edit must remain pending');
    for (const value of ['zh-CN', 'en']) {
      // The real shell button must preserve focus, including active browser composition.
      await locale(value, true); await expectLanguage(kind, first, value);
      assert.deepEqual(await readDraft(), draft);
      assert.deepEqual(receipt(await call(first, 'inspect')), draftReceipt);
    }
    pass(kind + ': changing language retains unfinished text and does not flush input');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `${kind}-failure.png`) }).catch(() => {});
    throw error;
  } finally { await browser.close(); browser = undefined; }
}
(async () => {
  try {
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: Number(process.env.OFFICE_LOCALE_PORT || 5327), strictPort: true, hmr: false, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] } } });
    await server.listen();
    for (const kind of kinds) await run(kind);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error(error);
  } finally { persist(); if (browser) await browser.close(); if (server) await server.close(); }
})();
