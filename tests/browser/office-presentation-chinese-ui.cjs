/* Real embedded-WASM Chinese UI audit. Build first: npm run deck:build.
 * Run: node tests/browser/office-presentation-chinese-ui.cjs
 * Screenshots require visual review: canvas text is not DOM body.innerText.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PRESENTATION_CHINESE_OUTPUT || path.join(root, 'test-results/office-presentation-chinese-ui'));
const tabs = [
  ['Home', '开始'], ['Insert', '插入'], ['Draw', '绘图'], ['Design', '设计'], ['Transitions', '切换'],
  ['Animations', '动画'], ['Slide Show', '幻灯片放映'], ['Record', '录制'], ['Review', '审阅'], ['View', '视图'],
];
const report = { ok: false, startedAt: new Date().toISOString(), screenshots: [], tabClicks: [], pageErrors: [], consoleErrors: [], cleanupErrors: [],
  runtime: 'Real Vue presentation shell and packaged WASM in Chromium', visualReview: 'Required; inspect every PNG before accepting the visual UI',
  limitations: ['Chinese glyphs, translations and clipping require review of the PNG files.',
    'Playwright browser input is not a physical operating-system IME. Native file dialogs are not covered.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
// Await asynchronous Rust queries outside waitForFunction, preserving each
// caller's original deadline even when an individual browser query stalls.
async function waitForAsync(predicate, arg, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const failure = () => Error('Timed out waiting for the presentation UI state');
  while (Date.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        page.evaluate(predicate, arg),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), deadline - Date.now()); }),
      ]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw failure();
}
const editor = (method, ...args) => page.evaluate(async ({ method, args }) => {
  const app = document.querySelector('#app').__vue_app__._instance.setupState;
  const handle = app.rustPresentationHandles.get(app.activeKey);
  if (!handle) throw Error('The active Vue presentation handle is missing');
  return handle[method](...args);
}, { method, args });
const command = (id, params = {}) => editor('command', id, params);
const inspect = () => editor('inspect');
const query = (id, params = {}) => editor('query', id, params);
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
async function waitUi(expected) {
  await waitForAsync(async expected => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const state = await app.rustPresentationHandles.get(app.activeKey).inspect();
    return Object.entries(expected).every(([key, value]) => (key === 'dialog' ? state.ui?.dialog : state.ui?.ui?.[key]) === value);
  }, expected, 15000);
  await paint();
}
async function capture(name) {
  await paint();
  const file = `${String(report.screenshots.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true });
  const state = await inspect();
  report.screenshots.push({ file, tab: state.ui.ui.tab, pane: state.ui.ui.pane, dialog: state.ui.dialog,
    slideNames: state.slides.map(slide => slide.name), revision: state.revision });
  persist();
}
async function mousePoint(x, y) {
  const canvas = page.getByTestId('office-presentation-canvas'), box = await canvas.boundingBox();
  const state = await inspect(), [width, height] = state.ui.window;
  assert.ok(box && width > 0 && height > 0, 'The real presentation canvas has a layout');
  const point = { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
  await page.mouse.click(point.x, point.y);
  return point;
}
async function expectTitles(expected) {
  const state = await inspect();
  assert.deepEqual(state.slides.map(slide => slide.name), expected, 'UI navigation preserves user slide titles verbatim');
  for (let index = 0; index < expected.length; index++) {
    const slide = await query('slide.inspect', { index });
    assert.ok(slide.shapes.some(shape => shape.text === expected[index]), `Slide ${index + 1} retains its actual title text`);
  }
}
(async () => {
  try {
    report.stage = 'artifact-check';
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-office-presentation.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_PRESENTATION_CHINESE_PORT || 5304), strictPort: true, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', deviceScaleFactor: 1 });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.locator('.create-card.presentation').click();
    await page.getByTestId('office-presentation-canvas').waitFor();
    await waitForAsync(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      const handle = app.rustPresentationHandles.get(app.activeKey);
      return !app.busy && handle && (await handle.inspect()).ui?.canvasRect?.length === 4;
    }, undefined, 120000);
    assert.equal(await page.getByTestId('rust-presentation-editor').getAttribute('data-engine'), 'office-presentation-wasm');
    await page.getByTestId('theme-light').click();
    await waitUi({ brightness: 'light' });
    await page.screenshot({ path: path.join(output, 'blank-presentation.png'), fullPage: true });
    report.placeholderScreenshot = 'blank-presentation.png';
    report.stage = 'document-and-tabs';
    // Titles deliberately match UI dictionary entries: neither may be localized as document text.
    const initialCount = (await inspect()).slides.length;
    await command('slide.new', { at: 0, layout: 'titleOnly', title: 'Home' });
    await command('slide.new', { at: 1, layout: 'titleOnly', title: '开始' });
    for (let index = initialCount + 1; index >= 2; index--) await command('slide.delete', { index });
    await command('slide.go', { index: 0 });
    const first = await query('slide.inspect', { index: 0 });
    const titleId = first.shapes.find(shape => shape.text === 'Home')?.id;
    assert.ok(Number.isSafeInteger(titleId), 'The English title placeholder exists');
    await command('selection.select', { id: titleId });
    await expectTitles(['Home', '开始']);
    await assert.rejects(() => command('edit.redo'), /没有可重做的操作/);
    report.localizedFeedback = true;
    const commands = await query('commands.list');
    for (const id of ['slide.new', 'insert.table', 'format.bold']) assert.ok(commands.some(item => item.id === id), `Stable command ID ${id}`);
    await command('ui.set', { tab: 'View', pane: null, notes: false, ribbonCollapsed: false });
    await waitUi({ tab: 'View' });
    // Embedded ribbon.rs starts at x=12; 13px CJK tab glyphs plus 18px padding,
    // with 2px gaps. Use real mouse input at translated tab positions, never ui.click.
    let x = 12;
    for (const [id, label] of tabs) {
      const width = [...label].length * 13 + 18;
      const point = await mousePoint(x + width / 2, 14);
      await waitUi({ tab: id, ribbonCollapsed: false });
      report.tabClicks.push({ translatedLabel: label, internalId: id, point });
      await capture('ribbon-' + id.toLowerCase().replaceAll(' ', '-'));
      x += width + 2;
    }
    await expectTitles(['Home', '开始']);
    await command('ui.set', { tab: 'Insert' }); await waitUi({ tab: 'Insert' });
    const beforeNew = (await inspect()).slides.length;
    const newSlidePoint = await mousePoint(38, 55); // Main area of 插入 > 新建幻灯片.
    await waitForAsync(async count => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return (await app.rustPresentationHandles.get(app.activeKey).inspect()).slides.length === count + 1;
    }, beforeNew);
    report.mouseCommand = { id: 'slide.new', point: newSlidePoint, before: beforeNew, after: (await inspect()).slides.length };
    await command('edit.undo'); await command('slide.go', { index: 0 });
    await command('selection.select', { id: titleId });
    await expectTitles(['Home', '开始']);
    report.stage = 'panes-and-dialogs';
    await command('ui.set', { tab: 'Shape Format' }); await waitUi({ tab: 'Shape Format' });
    await capture('ribbon-shape-format');
    for (const formatTab of ['fill', 'effects', 'size', 'text']) {
      await command('ui.set', { pane: 'format', formatTab }); await waitUi({ pane: 'format', formatTab });
      await capture('pane-format-' + formatTab);
    }
    for (const pane of ['background', 'animation', 'selection', 'comments']) {
      await command('ui.set', { pane }); await waitUi({ pane }); await capture('pane-' + pane);
    }
    await command('ui.set', { tab: 'Home', pane: null }); await waitUi({ tab: 'Home', pane: null });
    const dialogs = ['font', 'paragraph', 'tabs', 'table', 'hyperlink', 'slideSize', 'sizePosition', 'setupShow',
      'bullets', 'symbol', 'dateTime', 'language', 'altText', 'preferences', 'gridOptions', 'smartart', 'photoAlbum'];
    for (const id of dialogs) {
      if (id === 'font' || id === 'paragraph') await command(`format.${id}Dialog`);
      else await command('app.dialog', { id });
      await waitUi({ dialog: id }); await capture('dialog-' + id);
      await command('ui.dialog.close'); await waitUi({ dialog: null });
    }
    await expectTitles(['Home', '开始']);
    report.stage = 'real-browser-input-and-export';
    await command('text.edit', { id: titleId, end: true }); await paint();
    await page.getByTestId('office-presentation-input').focus(); await paint();
    await page.keyboard.insertText(' · Edited 中文');
    const editedTitle = 'Home · Edited 中文';
    await waitForAsync(async ({ titleId, editedTitle }) => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return (await app.rustPresentationHandles.get(app.activeKey).query('text.get', { id: titleId })).text === editedTitle;
    }, { titleId, editedTitle });
    await command('text.exit'); await expectTitles([editedTitle, '开始']);
    await capture('edited-title');
    report.browserInput = { method: 'Playwright keyboard.insertText through the real eframe input', text: editedTitle };
    await page.getByTestId('shell-save-as').click();
    await page.getByTestId('save-format-pptx').check();
    await page.getByTestId('save-format-name').fill('Chinese UI 中文标题');
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('save-format-confirm').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'Chinese UI 中文标题.pptx');
    const pptx = path.join(output, 'chinese-ui.pptx'); await download.saveAs(pptx);
    await page.waitForFunction(() => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      return !app.busy && !app.saveAsDraft && !app.active.dirty;
    });
    const exported = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'scripts/office-presentation-inspect-presentation.py'), pptx], { encoding: 'utf8' }));
    assert.equal(exported.slides.length, 2);
    assert.ok(exported.slides[0].text.split('\n').includes(editedTitle));
    assert.ok(exported.slides[1].text.split('\n').includes('开始'));
    assert.equal((await inspect()).dirty, false, 'The downloaded PPTX receipt was acknowledged');
    report.export = { file: pptx, filename: download.suggestedFilename(), independentXmlReadback: exported, saved: true };
    report.stage = 'narrow-ribbon';
    await page.setViewportSize({ width: 1100, height: 1050 });
    await command('ui.set', { tab: 'Design', pane: null }); await waitUi({ tab: 'Design', pane: null });
    await paint();
    await page.screenshot({ path: path.join(output, 'design-narrow-before-scroll.png'), fullPage: true });
    await page.mouse.move(550, 160);
    await page.mouse.wheel(5000, 0);
    await page.waitForTimeout(350); // Let the real egui smooth scroll settle.
    await paint();
    await page.screenshot({ path: path.join(output, 'design-narrow-after-scroll.png'), fullPage: true });
    const narrowState = await inspect();
    const designerPoint = await mousePoint(narrowState.ui.window[0] - 60, 55);
    await waitUi({ pane: 'designer' });
    await page.screenshot({ path: path.join(output, 'design-narrow-command.png'), fullPage: true });
    report.narrowRibbon = { width: 1100, horizontalScroll: true, command: 'view.pane', pane: 'designer', point: designerPoint };
    await expectTitles([editedTitle, '开始']);
    assert.equal((await inspect()).dirty, false, 'Ribbon scrolling and opening a pane do not modify the presentation');
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    report.ok = true; report.stage = 'complete';
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    // Attempt both closes even if one fails; persist cleanup errors in the final report.
    for (const [name, resource] of [['browser', browser], ['server', server]]) {
      try { await resource?.close(); } catch (error) { report.cleanupErrors.push(`${name}: ${error}`); }
    }
    if (report.cleanupErrors.length) { report.ok = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); persist();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
