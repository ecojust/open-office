/* Focused acceptance of the global file toolbar and appearance controls.
 * Uses the actual Vue shell and both local Rust/WASM canvases. Editing and file
 * actions use browser input; engine APIs are read-only observations. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.GLOBAL_SHELL_OUTPUT || path.join(root, 'test-results/global-shell-theme'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, startedAtUtc: new Date().toISOString(), checks: [], files: [], downloads: [],
  pageErrors: [], consoleErrors: [], externalRequests: [], forbiddenRequests: [], fileChoosers: 0,
  limitations: ['Headless Chromium verifies browser integration, not installed Tauri WebViews or physical OS IMEs.',
    'This focused suite verifies global toolbar routing and appearance; broader format compatibility has separate suites.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const phase = name => { report.phase = name; console.log('PHASE', name); persist(); };
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const products = () => Object.fromEntries([
  'src/App.vue', 'src/style.css', 'src/shared/appearance.ts', 'src/components/Icon.vue',
  ...['word', 'sheet'].flatMap(kind => [`src/${kind}/rust/client.ts`, `src/components/Rust${kind === 'word' ? 'Word' : 'Sheet'}Editor.vue`]),
  ...['office-word', 'office-sheet'].flatMap(engine => [`public/${engine}/manifest.json`, `public/${engine}/${engine}.js`, `public/${engine}/${engine}_bg.wasm`]),
].map(file => [file, sha(path.join(root, file))]));
const record = file => { report.files.push({ path: path.relative(root, file), bytes: fs.statSync(file).size, sha256: sha(file) }); return file; };
const inspectXlsx = file => JSON.parse(execFileSync('python3', [path.join(__dirname, 'office-sheet-inspect-xlsx.py'), file], { encoding: 'utf8' }));
const inspectDocx = file => JSON.parse(execFileSync('python3', [path.join(root, 'tests/compatibility/office-word-core/inspect_docx.py'), file], { encoding: 'utf8' }));
let server, browser, context, page, origin;
const editor = kind => page.locator(`[data-testid="rust-${kind}-editor"]:visible`);
const canvas = kind => editor(kind).getByTestId(kind === 'word' ? 'office-word-canvas' : 'office-sheet-canvas');
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function until(read, predicate, description, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    last = await read();
    if (predicate(last)) return last;
    await page.waitForTimeout(40);
  }
  fs.writeFileSync(path.join(output, 'last-state.json'), JSON.stringify({ description, last }, null, 2));
  assert.fail(description + ': timed out; see last-state.json');
}
async function idle(kind) {
  await page.waitForFunction(kind => {
    const error = document.querySelector('.error-banner');
    if (error) throw Error(error.textContent);
    const editor = [...document.querySelectorAll(`[data-testid="rust-${kind}-editor"]`)].find(node => node.getBoundingClientRect().width > 0);
    return editor?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  }, kind);
}
async function snapshot(kind, id) {
  id ||= await editor(kind).getAttribute('data-session-id');
  return page.evaluate(async ({ kind, id }) => kind === 'word'
    ? (await import('/src/word/rust/client.ts')).inspectOfficeWordSession(id)
    : (await import('/src/sheet/rust/client.ts')).inspectOfficeSheetSession(id), { kind, id });
}
async function cell(address, id) {
  id ||= await editor('sheet').getAttribute('data-session-id');
  return page.evaluate(async ({ id, address }) => (await import('/src/sheet/rust/client.ts')).queryOfficeSheetSession(id, 'cell.get', { cell: address }), { id, address });
}
async function clickRect(kind, rect) {
  const box = await canvas(kind).boundingBox();
  assert.ok(box && rect?.length === 4);
  await page.mouse.click(box.x + rect[0] + rect[2] / 2, box.y + rect[1] + rect[3] / 2);
}
async function selectCell(address) {
  const state = await until(() => snapshot('sheet'), state => state.ui?.visibleCells?.some(item => item.cell === address), 'Rendered cell ' + address);
  await clickRect('sheet', state.ui.visibleCells.find(item => item.cell === address).rect);
  await frames();
}
async function focusWord() {
  const state = await until(() => snapshot('word'), state => state.ui?.pages?.length, 'Word page layout');
  const box = await canvas('word').boundingBox(), [x, y, width, height] = state.ui.pages[0];
  await page.mouse.click(box.x + x + width * .7, box.y + Math.min(y + Math.min(200, height / 4), box.height - 50));
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), id => id === 'office-word-input', 'Actual Word text agent focus');
}
async function newDocument(kind) {
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-' + kind).click();
  await idle(kind);
  assert.equal(await page.locator('.new-document-menu').getAttribute('open'), null, 'Choosing a new type closes its menu');
  return { id: await editor(kind).getAttribute('data-session-id'), name: await page.locator('.document-tab.active .tab-name').innerText() };
}
async function switchTab(document, kind) {
  await page.locator('.document-tab .tab-name').filter({ hasText: document.name }).click();
  await idle(kind);
  assert.equal(await editor(kind).getAttribute('data-session-id'), document.id);
}
const history = state => ({ revision: state.revision, dirty: state.dirty, canUndo: state.canUndo, canRedo: state.canRedo });
async function expectedTheme(kind, preference, resolved) {
  await page.waitForFunction(({ preference, resolved }) => document.documentElement.dataset.theme === resolved
    && document.documentElement.dataset.themePreference === preference, { preference, resolved });
  assert.equal(await page.getByTestId('theme-' + preference).getAttribute('aria-pressed'), 'true');
  return until(() => snapshot(kind), state => state.ui?.theme?.preference === preference && state.ui?.theme?.resolved === resolved,
    `${kind} real canvas follows ${preference} / ${resolved}`);
}
async function setTheme(kind, preference, resolved) {
  await page.getByTestId('theme-' + preference).click();
  return expectedTheme(kind, preference, resolved);
}
async function assertChrome(kind) {
  const header = page.getByTestId('global-toolbar'), headerBox = await header.boundingBox();
  assert.ok(headerBox.y <= 2, 'File toolbar is the top application row');
  for (const id of ['shell-new', 'shell-open', 'shell-save', 'shell-save-as', 'shell-export-pdf', 'shell-print']) {
    assert.equal(await page.getByTestId(id).count(), 1, 'One global control ' + id);
    assert.equal(await header.getByTestId(id).isVisible(), true);
  }
  for (const preference of ['light', 'dark', 'system']) {
    const button = header.getByTestId('theme-' + preference);
    assert.equal(await button.locator('svg').count(), 1, 'Theme choice is an SVG icon');
    assert.ok(await button.getAttribute('aria-label'), 'Theme choice has an accessible label');
  }
  const state = await snapshot(kind), drawn = state.ui?.drawnChrome || [];
  assert.ok(drawn.length > 0, 'Actual renderer exposes drawn controls');
  assert.ok(!drawn.some(item => ['view.theme', 'interfaceTheme'].includes(item.id)), 'Embedded canvas does not draw a second theme selector');
  assert.ok(!drawn.some(item => /^(?:titleBar|tab:File|quickAccess:file\.)/.test(item.id)), 'File chrome belongs to the shell');
  assert.equal(await editor(kind).locator('select').count(), 0, 'No local DOM theme dropdown');
  assert.equal(await page.locator('iframe').count(), 0);
}
async function screenshot(name) {
  await frames();
  const file = path.join(output, name + '.png');
  await page.screenshot({ path: file }); record(file);
}
async function download(kind, name, trigger) {
  const before = report.downloads.length, pending = page.waitForEvent('download');
  await trigger();
  const item = await pending, file = path.join(output, name);
  assert.ok(item.suggestedFilename().toLowerCase().endsWith(kind === 'word' ? '.docx' : '.xlsx'));
  await item.saveAs(file); await idle(kind); await frames();
  assert.equal(report.downloads.length, before + 1, 'One file action creates exactly one download');
  return record(file);
}

async function checks() {
  phase('home-global-controls');
  const toolbar = page.getByTestId('global-toolbar'); await toolbar.waitFor();
  for (const id of ['shell-save', 'shell-save-as', 'shell-export-pdf', 'shell-print']) assert.equal(await page.getByTestId(id).isDisabled(), true);
  assert.equal(await toolbar.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
  assert.equal(await page.getByTestId('shell-open').isEnabled(), true);
  await page.getByTestId('shell-new').click();
  for (const kind of ['word', 'sheet', 'presentation', 'pdf']) assert.equal(await page.getByTestId('shell-new-' + kind).isVisible(), true);
  await page.keyboard.press('Escape');
  const chooserPending = page.waitForEvent('filechooser'); await page.getByTestId('shell-open').click();
  const chooser = await chooserPending;
  assert.match(await chooser.element().getAttribute('accept'), /\.docx/);
  assert.match(await chooser.element().getAttribute('accept'), /\.xlsx/);
  await chooser.setFiles([]);
  pass('Top-level file actions are available on home; document actions are disabled and Open accepts all supported types');

  phase('word-and-sheet-current-document-routing');
  const word = await newDocument('word'); await focusWord();
  const text = 'Global Word 文档主题';
  await page.keyboard.insertText(text);
  await until(() => snapshot('word'), state => state.text === text && state.dirty, 'Actual Word text committed');
  await assertChrome('word');
  const sheet = await newDocument('sheet');
  await selectCell('A1'); await page.keyboard.type('42'); await page.keyboard.press('Enter');
  await until(() => cell('A1'), state => state.value === 42, 'Actual spreadsheet numeric cell');
  // The value is committed before Enter finishes closing the editor and moving
  // the selection. Let that real input frame finish before measuring whether
  // a later appearance change affects the revision or undo history.
  await until(() => snapshot('sheet'), state => state.ui?.editor === null
    && state.selection?.active?.col === 0 && state.selection?.active?.row === 1,
  'Enter closes the cell editor and advances to A2');
  await frames();
  await assertChrome('sheet');
  assert.equal((await snapshot('word', word.id)).dirty, true);

  phase('themes-history-and-live-system-preference');
  const before = await snapshot('sheet');
  for (const [preference, resolved] of [['dark', 'dark'], ['light', 'light'], ['system', 'light']]) {
    const after = await setTheme('sheet', preference, resolved);
    assert.deepEqual(history(after), history(before), 'Theme selection changes no cell, dirty state or history');
    assert.equal((await cell('A1')).value, 42);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.deepEqual(history(await expectedTheme('sheet', 'system', 'dark')), history(before));
  await page.emulateMedia({ colorScheme: 'light' }); await expectedTheme('sheet', 'system', 'light');
  await setTheme('sheet', 'light', 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); await frames(); await expectedTheme('sheet', 'light', 'light');
  await setTheme('sheet', 'dark', 'dark');
  await toolbar.getByRole('button', { name: '撤销', exact: true }).click(); await idle('sheet');
  await until(() => cell('A1'), state => state.value === null, 'Global Undo still targets the original cell edit after theme switches');
  await toolbar.getByRole('button', { name: '重做', exact: true }).click(); await idle('sheet');
  await until(() => cell('A1'), state => state.value === 42, 'Global Redo restores the same history entry');
  // Redo becomes disabled after restoring the only edit. Give an enabled shell
  // control actual DOM focus before testing the canvas's native focus handoff.
  const focusedShellButton = toolbar.getByTestId('theme-dark');
  await focusedShellButton.click();
  assert.equal(await focusedShellButton.evaluate(button => document.activeElement === button), true,
    'A real shell click holds DOM focus before returning to the grid');
  await selectCell('A1');
  await until(() => snapshot('sheet'), state => state.selection?.active?.col === 0 && state.selection?.active?.row === 0,
    'A single real canvas click selects A1 after leaving the shell');
  await page.keyboard.press('ArrowRight');
  await until(() => snapshot('sheet'), state => state.selection?.active?.col === 1 && state.selection?.active?.row === 0,
    'The real ArrowRight key reaches Rust and moves selection from A1 to B1');
  await selectCell('A2');
  await until(() => snapshot('sheet'), state => state.selection?.active?.col === 0 && state.selection?.active?.row === 1,
    'A real canvas click restores A2 for the remaining checks');
  pass('A single grid click recovers keyboard navigation from a focused global toolbar button');
  await switchTab(word, 'word');
  const wordBefore = await expectedTheme('word', 'dark', 'dark');
  assert.equal(wordBefore.text, text); assert.equal(wordBefore.dirty, true);
  assert.deepEqual(history(await setTheme('word', 'light', 'light')), history(wordBefore));
  assert.deepEqual(history(await setTheme('word', 'system', 'dark')), history(wordBefore));
  await page.emulateMedia({ colorScheme: 'light' });
  assert.deepEqual(history(await expectedTheme('word', 'system', 'light')), history(wordBefore));
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.deepEqual(history(await expectedTheme('word', 'system', 'dark')), history(wordBefore));
  assert.deepEqual(history(await setTheme('word', 'dark', 'dark')), history(wordBefore));
  await toolbar.getByRole('button', { name: '撤销', exact: true }).click(); await idle('word');
  await until(() => snapshot('word'), state => state.text === '', 'Global Undo targets the current Word document');
  await toolbar.getByRole('button', { name: '重做', exact: true }).click(); await idle('word');
  await until(() => snapshot('word'), state => state.text === text, 'Word history survives theme changes');
  await screenshot('word-global-toolbar-dark');
  await switchTab(sheet, 'sheet'); await expectedTheme('sheet', 'dark', 'dark');
  assert.equal((await cell('A1')).value, 42);
  pass('Three icon choices, real OS media changes and Word/Sheet switching share appearance without modifying content or undo history');

  phase('pending-draft-theme-and-global-save');
  await selectCell('A2'); await page.keyboard.press('F2');
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), id => id === 'office-sheet-input', 'Cell editor has real text focus');
  const draftText = '主题切换保留草稿'; await page.keyboard.insertText(draftText);
  const draftBefore = await until(() => snapshot('sheet'), state => state.ui?.editor?.text === draftText, 'Actual uncommitted cell draft');
  assert.equal((await cell('A2')).value, null);
  const draftAfter = await setTheme('sheet', 'light', 'light');
  assert.deepEqual(history(draftAfter), history(draftBefore));
  assert.equal(draftAfter.ui.editor.text, draftText);
  assert.equal((await cell('A2')).value, null, 'Theme choice does not commit a pending cell editor');
  const sheetFile = await download('sheet', 'global-sheet.xlsx', () => page.getByTestId('shell-save').click());
  const inspectedSheet = inspectXlsx(sheetFile).sheets[0];
  assert.equal(inspectedSheet.cells.A1.value, 42); assert.equal(inspectedSheet.cells.A2.value, draftText);
  assert.equal((await snapshot('sheet')).dirty, false);
  assert.equal((await snapshot('word', word.id)).dirty, true, 'Saving the active sheet never marks the retained Word saved');
  await setTheme('sheet', 'dark', 'dark'); await screenshot('sheet-global-toolbar-dark');
  await page.setViewportSize({ width: 800, height: 820 }); await assertChrome('sheet');
  const header = await toolbar.boundingBox(), grid = await canvas('sheet').boundingBox();
  assert.ok(grid.y >= header.y + header.height, 'Narrow global toolbar does not overlap the editor');
  await screenshot('sheet-global-toolbar-narrow');
  await page.setViewportSize({ width: 1440, height: 1050 });
  pass('Switching theme preserves a live uncommitted Chinese cell draft; global Save commits and exports it without saving another tab');

  phase('global-shortcuts-home-guard-and-generic-open');
  await switchTab(word, 'word'); await expectedTheme('word', 'dark', 'dark');
  await page.getByTestId('shell-save').focus();
  const wordFile = await download('word', 'global-word.docx', () => page.keyboard.press('Control+s'));
  const bodyText = inspectDocx(wordFile).paragraphs.filter(p => p.part === 'word/document.xml' && p.location.length === 2).map(p => p.text).join('\n');
  assert.equal(bodyText, text);
  await focusWord();
  await download('word', 'global-word-canvas-shortcut.docx', () => page.keyboard.press('Control+s'));
  assert.equal((await snapshot('word')).dirty, false);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  for (const id of ['shell-save', 'shell-save-as', 'shell-export-pdf', 'shell-print']) assert.equal(await page.getByTestId(id).isDisabled(), true);
  const downloadCount = report.downloads.length;
  await page.getByTestId('shell-open').focus(); await page.keyboard.press('Control+s'); await frames();
  assert.equal(report.downloads.length, downloadCount, 'Home shortcut cannot save a retained hidden editor');
  const fixture = path.join(output, 'generic-open.xlsx');
  execFileSync('python3', [path.join(__dirname, 'office-sheet-inspect-xlsx.py'), '--fixture', fixture]);
  const chooserCount = report.fileChoosers;
  const pending = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await pending).setFiles(fixture); await idle('sheet');
  assert.equal(report.fileChoosers, chooserCount + 1, 'Global Open produces exactly one file chooser');
  assert.equal((await cell('A1')).value, '地区 中文');
  await expectedTheme('sheet', 'dark', 'dark');
  pass('Global buttons and header/canvas shortcuts save exactly the current document; home cannot save hidden tabs and generic Open imports a workbook');

  phase('appearance-persistence-and-new-session');
  assert.equal(await page.evaluate(() => localStorage.getItem('open-office.appearance')), 'dark');
  const firstPage = page; page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(origin); await page.getByTestId('global-toolbar').waitFor();
  assert.equal(await page.getByTestId('theme-dark').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await newDocument('sheet'); await expectedTheme('sheet', 'dark', 'dark');
  await page.getByTestId('theme-system').click();
  await page.emulateMedia({ colorScheme: 'light' }); await expectedTheme('sheet', 'system', 'light');
  await firstPage.waitForFunction(() => document.documentElement.dataset.themePreference === 'system');
  await screenshot('sheet-global-toolbar-system-light');
  pass('Appearance persists across application pages, applies to future sessions and synchronizes storage changes');
}

async function main() {
  try {
    phase('checking-frozen-runtimes');
    report.artifactChecks = {};
    for (const engine of ['office-word', 'office-sheet']) report.artifactChecks[engine] = execFileSync(process.execPath, [path.join(root, `scripts/build-${engine}.mjs`), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productSourcesBefore = products();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), optimizeDeps: { entries: ['index.html'] },
      server: { host: '127.0.0.1', port: Number(process.env.GLOBAL_SHELL_QA_PORT || 5231), strictPort: true, hmr: false,
        watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] } } });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', colorScheme: 'light', acceptDownloads: true });
    context.on('request', request => {
      const url = request.url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
      if (/\/office-runtime\/|\/office\/host\.html|soffice\.(?:js|wasm)/.test(url)) report.forbiddenRequests.push(url);
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    // Playwright enables Chromium's chooser interception asynchronously when the
    // first listener is added. Subscribe before navigation so a direct keyboard
    // shortcut cannot race that setup (unlike pointer clicks it has no actionability wait).
    page.on('filechooser', () => { report.fileChoosers += 1; });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('download', item => report.downloads.push(item.suggestedFilename()));
    await page.goto(origin); await checks();
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    report.productSourcesAfter = products();
    assert.deepEqual(report.productSourcesAfter, report.productSourcesBefore, 'Product sources and runtime artifacts stayed frozen');
    report.ok = true;
  } catch (error) {
    report.failure = { phase: report.phase, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      for (const kind of ['word', 'sheet']) try {
        if (await editor(kind).count()) report[kind + 'FailureSnapshot'] = await snapshot(kind);
      } catch { /* Preserve original failure. */ }
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    report.finishedAtUtc = new Date().toISOString(); persist();
    await browser?.close(); await server?.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
