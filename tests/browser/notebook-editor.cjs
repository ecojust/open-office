/* Real notebook UI, browser downloads and reopen. No native file-dialog/IME claim.
 * Run: node tests/browser/notebook-editor.cjs (owns Vite 5312 and Chromium).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_NOTEBOOK_OUTPUT || path.join(root, 'test-results/notebook-ui'));
const files = ['src/App.vue', 'src/style.css', 'src/shared/document.ts', 'src/components/NotebookEditor.vue', 'src/components/NotebookCanvas.vue', 'src/notes/search.ts', 'src/notes/layout.ts', 'src/notes/model.ts', 'src/notes/session.ts', 'src/notes/dom.ts'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue notebook UI in Chromium over local Vite HTTP', checks: [], screenshots: [], errors: [], consoleErrors: [], externalRequests: [],
  limitations: ['Browser download and file input are exercised; native dialogs and native filesystem autosave are not.', 'Keyboard/mouse input is automated Chromium input; physical operating-system IME is not covered.', 'History menu routing is tested with beforeinput events; the operating-system Edit menu is not exercised.', 'Screenshots require visual review.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const note = () => page.locator('[data-testid="notebook-editor"]:visible');
const body = () => note().getByTestId('notebook-content').first();
const contents = () => note().getByTestId('notebook-content');
const pageBlocks = value => value.regions.flatMap(region => region.blocks);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const title = () => note().getByRole('textbox', { name: '页面标题', exact: true });
async function wait(predicate, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let timer;
    try {
      const value = await Promise.race([page.evaluate(predicate, arg), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Notebook state timed out')), end - Date.now()); })]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Notebook state timed out');
}
async function ready() {
  await wait(() => { const app = document.querySelector('#app')?.__vue_app__?._instance.setupState; return app && !app.busy && app.active?.ready && app.active.document.kind === 'note'; });
  assert.equal(await body().getAttribute('contenteditable'), 'true');
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const file = `${String(report.screenshots.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true });
  report.screenshots.push({ file, viewport: page.viewportSize() }); persist();
}
async function check(name, action) { report.stage = name; persist(); await action(); report.checks.push(name); persist(); }
async function dialogValue(name, value) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByRole('textbox').fill(value);
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function newNote() { await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-note').click(); await ready(); }
async function text(value) { await body().click(); await page.keyboard.insertText(value); }
async function saveDownload(filename, saveAs = false) {
  if (saveAs) {
    await page.getByTestId('shell-save-as').click();
    await page.getByTestId('save-format-name').fill(filename.replace(/\.oonote$/, ''));
  }
  const nextDownload = page.waitForEvent('download');
  await page.getByTestId(saveAs ? 'save-format-confirm' : 'shell-save').click();
  const download = await nextDownload;
  assert.equal(download.suggestedFilename(), filename);
  const target = path.join(output, filename); await download.saveAs(target); assert.equal(await download.failure(), null);
  await ready();
  return { target, bytes: fs.readFileSync(target), model: JSON.parse(fs.readFileSync(target, 'utf8')) };
}
const blockText = block => block.type === 'image' ? block.alt : block.content.map(part => part.text).join('');
async function exportedModel() {
  return page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const value = await app.noteHandles.get(app.activeKey).exportFile({ format: 'oonote', background: true });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))));
  });
}
async function drag(handle, dx, dy) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); assert.ok(box, 'Gesture handle is visible');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
}
async function highlightTexts() {
  return page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('open-office-note-search-')).flatMap(([, value]) => [...value].map(range => range.toString())));
}
async function highlightCount(count) {
  await wait(expected => [...CSS.highlights.entries()].filter(([name]) => name.startsWith('open-office-note-search-')).reduce((sum, [, value]) => sum + value.size, 0) === expected, count);
}
async function insertImage(name = 'local-pixel.png') {
  const chooser = page.waitForEvent('filechooser');
  await note().getByTitle('插入 PNG / JPEG 图片').click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: pixel });
  await note().locator('img').last().waitFor();
}

async function todoEvidence(stage) {
  const evidence = { stage, html: await body().innerHTML(), title: await title().inputValue() };
  (report.todoEvidence ||= []).push(evidence); persist();
  assert.equal(await body().locator('[data-note-type="todo"]').count(), 1, `${stage}: the todo must remain structural`);
  assert.equal(await note().getByRole('checkbox', { name: '标记待办完成' }).isChecked(), true, `${stage}: todo completion must remain checked`);
}
(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_NOTEBOOK_PORT || 5312), strictPort: true, hmr: false,
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', acceptDownloads: true });
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(origin); assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    await check('create-title-body-format-and-todo', async () => {
      await newNote(); await title().fill('项目记录'); await text('今天完成原型，明天验证离线保存。');
      await body().press('ControlOrMeta+A'); await note().getByRole('button', { name: '加粗', exact: true }).click();
      assert.equal(await body().locator('b,strong').innerText(), '今天完成原型，明天验证离线保存。');
      await body().press('ArrowRight'); await body().press('End'); await body().press('Enter');
      await note().getByRole('button', { name: '待办', exact: true }).click();
      await note().getByRole('checkbox', { name: '标记待办完成' }).check();
      await todoEvidence('immediately-after-checking-todo');
      await note().getByTitle('重命名笔记本').click(); await dialogValue('重命名笔记本', '季度项目笔记');
      await todoEvidence('after-notebook-rename');
      await note().getByRole('button', { name: '重命名分区', exact: true }).click(); await dialogValue('重命名分区', '项目计划');
      await todoEvidence('after-initial-format-and-todo');
    });
    await check('sections-pages-and-search', async () => {
      await note().getByRole('button', { name: '新建页面', exact: true }).click(); await title().fill('会议纪要'); await text('下一次会议安排在周五。');
      await note().getByRole('button', { name: '新建分区', exact: true }).click(); await dialogValue('新建分区', '资料归档');
      await title().fill('参考材料'); await text('保留本地文件，不上传云端。');
      await note().getByRole('textbox', { name: '搜索整个笔记本' }).fill('周五');
      assert.equal(await note().locator('.note-search-results button').count(), 1);
      await note().locator('.note-search-results button').click(); assert.equal(await title().inputValue(), '会议纪要');
      assert.equal(await body().innerText(), '下一次会议安排在周五。');
      await note().getByRole('textbox', { name: '搜索整个笔记本' }).fill('');
    });
    await check('search-highlights-cross-rich-text-and-persist-after-navigation-and-editing', async () => {
      // Format one character only: the searched phrase must span separate text nodes.
      await body().click(); await body().press('ControlOrMeta+Home');
      for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      await note().getByRole('button', { name: '加粗', exact: true }).click();
      assert.equal(await body().locator('strong,b').innerText(), '周');
      const search = note().getByRole('textbox', { name: '搜索整个笔记本' });
      await search.fill('周五'); await note().locator('.note-search-results button').click();
      assert.equal(await search.inputValue(), '周五'); await highlightCount(1); assert.deepEqual(await highlightTexts(), ['周五']);
      assert.equal(await body().locator('mark').count(), 0, 'Search decoration leaves editable markup unchanged');
      await body().click(); await body().press('ControlOrMeta+End'); await page.keyboard.insertText('周五再次确认。');
      await highlightCount(2); assert.deepEqual(await highlightTexts(), ['周五', '周五']);
      await capture('persistent-search-highlights');
      const model = await exportedModel(), current = model.sections.flatMap(section => section.pages).find(item => item.title === '会议纪要');
      assert.equal(pageBlocks(current).map(blockText).join(''), '下一次会议安排在周五。周五再次确认。');
      assert.equal(JSON.stringify(model).includes('note-search'), false, 'Search decorations are not serialized');
      await note().getByRole('button', { name: '撤销', exact: true }).click(); await highlightCount(1);
      assert.equal(await body().innerText(), '下一次会议安排在周五。');
      await search.fill(''); await highlightCount(0);
      assert.deepEqual(await highlightTexts(), []);
      await search.fill('会议'); await note().locator('.note-search-results button').click();
      assert.equal(await note().locator('.note-title-highlights .note-search-mark').innerText(), '会议');
      await search.fill(''); await highlightCount(0);
      assert.equal(await note().locator('.note-title-highlights .note-search-mark').count(), 0);
    });
    await check('mixed-format-editing-preserves-the-caret-between-model-updates', async () => {
      await note().getByRole('button', { name: '新建页面', exact: true }).click(); await title().fill('光标验收'); await text('位置固定');
      await body().press('ControlOrMeta+A');
      await note().getByRole('button', { name: '下划线', exact: true }).click();
      await note().getByRole('button', { name: '删除线', exact: true }).click();
      await body().press('ControlOrMeta+Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
      await page.keyboard.insertText('A'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await page.keyboard.insertText('B'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await body().innerText(), '位置AB固定', 'Mixed marks never reset the caret to the end during reactive model updates');
      const saved = (await exportedModel()).sections.flatMap(section => section.pages).find(item => item.title === '光标验收');
      assert.equal(pageBlocks(saved).map(blockText).join(''), '位置AB固定');
      assert.ok(pageBlocks(saved)[0].content.every(part => part.marks.includes('underline') && part.marks.includes('strike')));
      assert.equal(await body().evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }))), false, 'Native-history event routing prevents the browser from maintaining a competing undo stack');
      await wait(() => document.querySelector('[data-testid="notebook-editor"]:not([style*="display: none"]) [data-testid="notebook-content"]').innerText === '位置A固定');
      assert.equal(await body().evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true }))), false);
      await wait(() => document.querySelector('[data-testid="notebook-editor"]:not([style*="display: none"]) [data-testid="notebook-content"]').innerText === '位置AB固定');

      await note().getByTitle('删除当前页面').click(); await page.getByRole('dialog', { name: '删除页面', exact: true }).getByRole('button', { name: '确认删除' }).click();
      await note().locator('.note-pages button', { hasText: '会议纪要' }).click();
    });
    await check('page-and-section-deletion-require-confirmation', async () => {
      await note().getByRole('button', { name: '新建页面', exact: true }).click(); await title().fill('待删除页面'); await text('删除前必须确认。');
      await note().getByTitle('删除当前页面').click(); await capture('delete-page-confirmation');
      await page.getByRole('dialog', { name: '删除页面', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await title().inputValue(), '待删除页面'); assert.equal(await body().innerText(), '删除前必须确认。');
      await note().getByTitle('删除当前页面').click(); await page.getByRole('dialog', { name: '删除页面', exact: true }).getByRole('button', { name: '确认删除' }).click();
      assert.equal(await note().locator('.note-pages button', { hasText: '待删除页面' }).count(), 0);
      await note().getByRole('button', { name: '新建分区', exact: true }).click(); await dialogValue('新建分区', '临时分区');
      await note().getByRole('button', { name: '删除分区', exact: true }).click();
      await page.getByRole('dialog', { name: '删除分区', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await note().locator('.note-sections button', { hasText: '临时分区' }).count(), 1);
      await note().getByRole('button', { name: '删除分区', exact: true }).click();
      await page.getByRole('dialog', { name: '删除分区', exact: true }).getByRole('button', { name: '确认删除' }).click();
      assert.equal(await note().locator('.note-sections button', { hasText: '临时分区' }).count(), 0);
    });
    await check('page-context-menu-creates-nested-pages-with-confirmed-subtree-deletion-and-undo', async () => {
      await note().getByRole('button', { name: '新建页面', exact: true }).click(); await title().fill('分层页面');
      const pageButton = value => note().locator('.note-pages button[data-page-id]', { hasText: value });
      await pageButton('分层页面').click({ button: 'right' });
      await note().getByRole('menuitem', { name: '添加子页面', exact: true }).click();
      await title().fill('第一层子页面'); await text('子页面正文');
      await pageButton('第一层子页面').click({ button: 'right' });
      await note().getByRole('menuitem', { name: '添加子页面', exact: true }).click();
      await title().fill('第二层子页面'); await text('孙页面正文');
      const parentX = (await pageButton('分层页面').locator('strong').boundingBox()).x;
      const childX = (await pageButton('第一层子页面').locator('strong').boundingBox()).x;
      const grandchildX = (await pageButton('第二层子页面').locator('strong').boundingBox()).x;
      assert.ok(childX > parentX && grandchildX > childX, 'Each nested page is visibly indented');
      const model = await exportedModel(), items = model.sections.flatMap(section => section.pages);
      const parent = items.find(item => item.title === '分层页面'), child = items.find(item => item.title === '第一层子页面'), grandchild = items.find(item => item.title === '第二层子页面');
      assert.equal(child.parentId, parent.id); assert.equal(grandchild.parentId, child.id);
      await capture('nested-pages');
      await pageButton('分层页面').click(); await note().getByTitle('删除当前页面').click();
      const dialog = page.getByRole('dialog', { name: '删除页面', exact: true });
      assert.match(await dialog.innerText(), /子页面|下级页面/);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await pageButton('第二层子页面').count(), 1);
      await note().getByTitle('删除当前页面').click(); await dialog.getByRole('button', { name: '确认删除' }).click();
      for (const name of ['分层页面', '第一层子页面', '第二层子页面']) assert.equal(await pageButton(name).count(), 0);
      await note().getByRole('button', { name: '撤销', exact: true }).click();
      for (const name of ['分层页面', '第一层子页面', '第二层子页面']) assert.equal(await pageButton(name).count(), 1);
      assert.deepEqual((await exportedModel()).sections.flatMap(section => section.pages).filter(item => [parent.id, child.id, grandchild.id].includes(item.id)), [parent, child, grandchild]);
      await note().getByRole('button', { name: '重做', exact: true }).click();
      for (const name of ['分层页面', '第一层子页面', '第二层子页面']) assert.equal(await pageButton(name).count(), 0);
    });
    await check('invalid-title-can-be-corrected-and-saved', async () => {
      await note().locator('.note-pages button', { hasText: '项目记录' }).click();
      await title().fill('长'.repeat(201));
      assert.match(await note().getByRole('alert').innerText(), /不能超过 200/);
      await title().fill('项目记录');
      assert.equal(await note().getByRole('alert').count(), 0, 'Correcting the invalid title clears its own error');
      // Navigation must work immediately after correcting only the title.
      await note().locator('.note-pages button', { hasText: '会议纪要' }).click(); assert.equal(await title().inputValue(), '会议纪要');
      await note().locator('.note-pages button', { hasText: '项目记录' }).click(); assert.equal(await title().inputValue(), '项目记录');
      await todoEvidence('after-pages-sections-and-title-recovery');
    });
    await check('image-regions-are-independent-and-deletion-requires-confirmation', async () => {
      await body().click(); await body().press('ControlOrMeta+End'); await body().press('Enter'); await todoEvidence('after-enter-below-todo');
      const chooser = page.waitForEvent('filechooser');
      await note().getByTitle('插入 PNG / JPEG 图片').click();
      await (await chooser).setFiles({ name: 'local-pixel.png', mimeType: 'image/png', buffer: pixel });
      await note().locator('img').waitFor();
      assert.equal(await body().locator('img').count(), 0, 'Images have their own region outside the flowing editable text');
      await todoEvidence('after-inserting-image');
      await body().click(); await body().press('ControlOrMeta+End'); await body().press('Enter'); await page.keyboard.insertText('图片后的正文。');
      assert.ok((await body().innerText()).includes('图片后的正文。'));
      await todoEvidence('after-typing-in-independent-text-region');
      await body().press('ControlOrMeta+Home'); await page.keyboard.press('Backspace');
      assert.equal(await note().locator('img').count(), 1, 'Backspace in a text region cannot delete an independent image');
      await note().locator('img').click();
      await note().getByRole('button', { name: /^删除图片：/ }).click();
      await page.getByRole('dialog', { name: '删除图片', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await note().locator('img').count(), 1);
      await note().locator('img').click();
      await note().getByRole('button', { name: /^删除图片：/ }).click();
      await page.getByRole('dialog', { name: '删除图片', exact: true }).getByRole('button', { name: '确认删除' }).click();
      assert.equal(await note().locator('img').count(), 0);
      assert.ok((await body().innerText()).includes('图片后的正文。'), 'Deleting only the picture preserves body text');
      await todoEvidence('after-confirmed-picture-deletion');
    });
    let layoutExpected;
    await check('free-layout-regions-drag-resize-and-image-aspect-ratio-remain-independent', async () => {
      await note().getByRole('button', { name: '新建页面', exact: true }).click(); await title().fill('布局验收'); await text('左侧文字区域。');
      await note().getByRole('button', { name: '添加文本区域', exact: true }).click();
      assert.equal(await contents().count(), 2); await page.keyboard.insertText('第二块文字由我安排位置。');
      await note().getByTestId('notebook-canvas').dblclick({ position: { x: 570, y: 210 } });
      assert.equal(await contents().count(), 3); await page.keyboard.insertText('双击空白位置新增区域。');
      const layout = async () => (await exportedModel()).sections.flatMap(section => section.pages).find(item => item.title === '布局验收');
      const initial = await layout(), firstId = initial.regions[0].id;
      const regionById = id => note().locator(`[data-region-id="${id}"]`);
      await contents().first().click();
      await drag(regionById(firstId).locator('.note-region-move'), 70, 35);
      const moved = await layout();
      assert.equal(moved.regions[0].x, initial.regions[0].x + 70); assert.equal(moved.regions[0].y, initial.regions[0].y + 35);
      assert.deepEqual(moved.regions.slice(1), initial.regions.slice(1), 'Moving one region does not reposition siblings');
      await note().getByRole('button', { name: '撤销', exact: true }).click(); assert.deepEqual((await layout()).regions, initial.regions);
      await note().getByRole('button', { name: '重做', exact: true }).click(); assert.deepEqual((await layout()).regions, moved.regions);
      await contents().first().click(); await drag(regionById(firstId).locator('.note-region-resize'), 100, 0);
      const resized = await layout(); assert.equal(resized.regions[0].width, moved.regions[0].width + 100);
      assert.deepEqual(resized.regions.slice(1), moved.regions.slice(1));
      await contents().first().click(); await contents().first().press('ControlOrMeta+End'); await contents().first().press('Enter'); await page.keyboard.insertText('增加正文\n'.repeat(8));
      const grown = await layout();
      assert.deepEqual(grown.regions.slice(1), resized.regions.slice(1), 'Growing text never flows or moves a neighboring region');
      assert.equal(grown.regions[0].width, resized.regions[0].width, 'Line wrapping stays inside the manually chosen width');
      await insertImage('比例缩放.png');
      const withImage = await layout(), imageBefore = withImage.regions.find(region => region.blocks.some(block => block.type === 'image'));
      const imageRegion = regionById(imageBefore.id); await imageRegion.locator('img').click();
      await drag(imageRegion.locator('.note-region-resize'), 60, 60);
      const scaled = await layout(), imageAfter = scaled.regions.find(region => region.id === imageBefore.id);
      assert.ok(imageAfter.width > imageBefore.width && imageAfter.height > imageBefore.height, 'Dragging the image corner resizes the persisted image box');
      assert.ok(Math.abs(imageAfter.width / imageAfter.height - imageBefore.width / imageBefore.height) < .01, 'Image resizing preserves its aspect ratio');
      assert.equal(imageAfter.x, imageBefore.x); assert.equal(imageAfter.y, imageBefore.y);
      assert.deepEqual(scaled.regions.filter(region => region.id !== imageBefore.id), withImage.regions.filter(region => region.id !== imageBefore.id));
      await note().getByRole('button', { name: '撤销', exact: true }).click(); assert.deepEqual((await layout()).regions, withImage.regions);
      await note().getByRole('button', { name: '重做', exact: true }).click(); assert.deepEqual((await layout()).regions, scaled.regions);
      const distant = regionById(initial.regions[2].id);
      await distant.getByTestId('notebook-content').click(); await distant.locator('.note-region-delete').click();
      const removeTextDialog = page.getByRole('dialog', { name: '删除内容区域', exact: true });
      await removeTextDialog.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await contents().count(), 3);
      await distant.getByTestId('notebook-content').click(); await distant.locator('.note-region-delete').click();
      await removeTextDialog.getByRole('button', { name: '确认删除' }).click(); assert.equal(await contents().count(), 2);
      await note().getByRole('button', { name: '撤销', exact: true }).click();
      assert.deepEqual((await layout()).regions, scaled.regions, 'Confirmed text-region deletion can restore the exact text and layout through undo');
      await distant.getByTestId('notebook-content').click();
      for (let index = 0; index < 35; index++) await distant.locator('.note-region-move').press('Shift+ArrowDown');
      await note().locator('.note-canvas-container').evaluate(element => element.scrollTop = 0);
      layoutExpected = await layout();
      const search = note().getByRole('textbox', { name: '搜索整个笔记本' });
      await search.fill('新增区域'); await note().locator('.note-search-results button').click(); await highlightCount(1);
      const visibleMatch = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="notebook-editor"] .note-canvas-container'), box = container.getBoundingClientRect();
        const ranges = [...CSS.highlights.entries()].filter(([name]) => name.startsWith('open-office-note-search-')).flatMap(([, value]) => [...value]);
        const match = ranges[0].getBoundingClientRect();
        return { scrollTop: container.scrollTop, visible: match.top >= box.top && match.bottom <= box.bottom };
      });
      assert.ok(visibleMatch.scrollTop > 0 && visibleMatch.visible, 'Choosing a search result reveals its highlighted match even in a distant canvas region');
      await search.fill('区域'); await note().locator('.note-search-results button').click();
      await highlightCount(2); assert.deepEqual(await highlightTexts(), ['区域', '区域']);
      const highlightedRegions = await page.evaluate(() => [...new Set([...CSS.highlights.entries()].filter(([name]) => name.startsWith('open-office-note-search-')).flatMap(([, value]) => [...value].map(range => range.startContainer.parentElement.closest('[data-region-id]')?.dataset.regionId)))]);
      assert.equal(highlightedRegions.length, 2, 'Search decorations reach every matching independently positioned text region');
      await search.fill(''); await highlightCount(0);
      await capture('free-layout-and-resized-image');
      report.layoutEvidence = { regionCount: layoutExpected.regions.length, initialTextBox: { x: initial.regions[0].x, y: initial.regions[0].y, width: initial.regions[0].width }, finalTextBox: { x: grown.regions[0].x, y: grown.regions[0].y, width: grown.regions[0].width }, initialImageBox: { width: imageBefore.width, height: imageBefore.height }, finalImageBox: { width: imageAfter.width, height: imageAfter.height } };
    });
    await check('light-dark-and-narrow-layout', async () => {
      await page.getByTestId('theme-light').click(); assert.equal(await note().getAttribute('data-theme'), 'light'); await capture('desktop-light');
      await page.getByTestId('theme-dark').click(); assert.equal(await note().getAttribute('data-theme'), 'dark'); await capture('desktop-dark');
      await page.setViewportSize({ width: 390, height: 844 }); await capture('narrow-dark');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Narrow screen has no document-level horizontal overflow');
      assert.equal(await page.getByTestId('shell-autosave').evaluate(button => {
        const track = button.querySelector('.autosave-track').getBoundingClientRect(), bounds = button.getBoundingClientRect();
        return track.left >= bounds.left && track.right <= bounds.right && getComputedStyle(button.querySelector('.autosave-label')).display === 'none';
      }), true, 'The narrow autosave switch fits its own button without overlapping adjacent file actions');
      await note().locator('.note-navigation-toggle').click(); await capture('narrow-navigation');
      await note().locator('.note-pages button', { hasText: '会议纪要' }).click(); assert.equal(await title().inputValue(), '会议纪要');
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByTestId('theme-light').click();
    });
    let saved;
    await check('save-download-and-exact-model', async () => {
      saved = await saveDownload('项目笔记验收.oonote', true);
      const model = saved.model; assert.equal(model.format, 'open-office-notebook'); assert.equal(model.version, 2); assert.equal(model.title, '季度项目笔记');
      assert.deepEqual(model.sections.map(item => item.title), ['项目计划', '资料归档']);
      assert.deepEqual(model.sections[0].pages.map(item => item.title), ['项目记录', '会议纪要', '布局验收']);
      assert.deepEqual(model.sections[0].pages[2], layoutExpected, 'All manually placed region coordinates and resized image dimensions are saved');
      const first = model.sections[0].pages[0];
      assert.equal(pageBlocks(first).find(block => blockText(block).includes('今天完成')).content.map(part => part.text).join(''), '今天完成原型，明天验证离线保存。');
      assert.ok(pageBlocks(first).flatMap(block => block.content || []).filter(part => part.text.includes('今天完成')).every(part => part.marks?.includes('bold')));
      const todo = pageBlocks(first).find(block => block.type === 'todo'); assert.ok(todo); assert.equal(todo.checked, true); assert.equal(blockText(todo), '待办事项');
      assert.ok(pageBlocks(first).some(block => blockText(block).includes('图片后的正文。')));
      assert.equal(pageBlocks(model.sections[0].pages[1]).map(blockText).join(''), '下一次会议安排在周五。');
      assert.equal(model.sections[1].pages[0].title, '参考材料'); assert.equal(pageBlocks(model.sections[1].pages[0]).map(blockText).join(''), '保留本地文件，不上传云端。');
      report.download = { file: path.basename(saved.target), bytes: saved.bytes.length, sha256: crypto.createHash('sha256').update(saved.bytes).digest('hex') };
      assert.equal(await page.getByTestId('global-save-state').innerText(), '已保存');
    });
    await check('reopen-download-and-roundtrip-model', async () => {
      await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready();
      assert.equal(await page.locator('.document-tab').count(), 2); assert.equal(await title().inputValue(), '项目记录');
      assert.ok((await body().innerText()).includes('今天完成原型，明天验证离线保存。'));
      assert.equal(await note().getByRole('checkbox', { name: '标记待办完成' }).isChecked(), true);
      await note().locator('.note-pages button', { hasText: '布局验收' }).click();
      assert.equal(await contents().count(), 3); assert.equal(await note().locator('img').count(), 1);
      assert.deepEqual((await exportedModel()).sections[0].pages[2], layoutExpected);
      for (const expected of layoutExpected.regions) {
        const actual = await note().locator(`[data-region-id="${expected.id}"]`).evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width) }));
        assert.deepEqual(actual, { x: expected.x, y: expected.y, width: expected.width });
      }
      await note().locator('.note-pages button', { hasText: '项目记录' }).click();
      await capture('reopened-notebook');
      const reopened = await saveDownload('项目笔记验收.oonote');
      assert.deepEqual(reopened.model, saved.model, 'Reopening and saving preserves every notebook ID, section, page, block, text, mark and todo flag');
      report.roundtripSha256 = crypto.createHash('sha256').update(reopened.bytes).digest('hex');
      assert.equal(report.roundtripSha256, report.download.sha256);
    });
    await check('background-export-receipt-preserves-focused-input', async () => {
      await body().click();
      report.backgroundReceipt = await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__._instance.setupState, handle = app.noteHandles.get(app.activeKey);
        const before = document.activeElement; let blurEvents = 0; const onBlur = () => blurEvents++; before.addEventListener('blur', onBlur);
        try {
          if (!await handle.canBackgroundExport()) throw Error('Idle notebook cannot export in background');
          const exported = await handle.exportFile({ format: 'oonote', background: true });
          await handle.markSaved(exported.base64, { background: true });
          const after = await handle.inspect();
          return { sameFocus: document.activeElement === before, blurEvents, dirty: after.dirty, revision: `${after.documentId}:${after.revision}`, exportedRevision: exported.revision };
        } finally { before.removeEventListener('blur', onBlur); }
      });
      assert.equal(report.backgroundReceipt.sameFocus, true); assert.equal(report.backgroundReceipt.blurEvents, 0); assert.equal(report.backgroundReceipt.dirty, false);
      assert.equal(report.backgroundReceipt.revision, report.backgroundReceipt.exportedRevision);
    });
    await check('multiple-tabs-batch-discard-and-cancel', async () => {
      await newNote(); await title().fill('仅用于关闭确认'); await text('这份修改选择不保存。');
      await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); await title().fill('原标签未保存修改');
      const count = await page.locator('.document-tab').count(); assert.equal(count, 3);
      await page.getByTestId('tabs-close-all').click(); await capture('batch-close-confirmation');
      await page.getByTestId('close-cancel').click(); assert.equal(await page.locator('.document-tab').count(), count); assert.equal(await title().inputValue(), '原标签未保存修改');
      let downloads = 0; const unexpected = () => downloads++; page.on('download', unexpected);
      await page.getByTestId('tabs-close-all').click(); await page.getByTestId('close-discard').click();
      await wait(() => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return !app.busy && app.home && app.tabs.length === 0; });
      assert.equal(await page.getByTestId('notebook-editor').count(), 0); assert.equal(downloads, 0); page.off('download', unexpected);
    });
    await check('legacy-v1-file-migrates-with-rich-text-todo-and-separate-image-without-data-loss', async () => {
      const legacy = { format: 'open-office-notebook', version: 1, id: 'legacy_book', title: '旧版笔记', sections: [{ id: 'legacy_section', title: '旧分区', pages: [{ id: 'legacy_page', title: '旧页面', blocks: [
        { id: 'legacy_paragraph', type: 'paragraph', content: [{ text: '旧版重点', marks: ['bold'] }, { text: '仍可编辑。' }] },
        { id: 'legacy_picture', type: 'image', dataUrl: `data:image/png;base64,${pixel.toString('base64')}`, alt: '旧版图片' },
        { id: 'legacy_task', type: 'todo', checked: true, content: [{ text: '旧版待办' }] },
      ] }] }] };
      const fixtureDir = path.join(output, 'fixtures'); fs.mkdirSync(fixtureDir, { recursive: true });
      const source = path.join(fixtureDir, '旧版笔记.oonote'); fs.writeFileSync(source, JSON.stringify(legacy));
      await page.getByTestId('document-open-input').setInputFiles(source); await ready();
      assert.equal(await title().inputValue(), '旧页面');
      assert.equal(await body().locator('strong,b').innerText(), '旧版重点');
      assert.equal(await note().getByRole('checkbox', { name: '标记待办完成' }).isChecked(), true);
      assert.equal(await note().locator('img').count(), 1); assert.equal(await body().locator('img').count(), 0);
      const migrated = await saveDownload('旧版笔记.oonote');
      assert.equal(migrated.model.version, 2); assert.equal(migrated.model.sections[0].pages[0].id, 'legacy_page');
      assert.deepEqual(pageBlocks(migrated.model.sections[0].pages[0]), legacy.sections[0].pages[0].blocks);
      assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), legacy, 'The import fixture remains byte-equivalent v1 source data');
      await page.getByTestId('tabs-close-all').click();
      await wait(() => document.querySelector('#app').__vue_app__._instance.setupState.tabs.length === 0);
    });
    report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Product sources must remain fixed during verification');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.ok = true; report.finishedAt = new Date().toISOString();
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) { try { await capture('failure'); report.failure.text = (await page.locator('body').innerText()).slice(-7000); } catch {} }
    process.exitCode = 1;
  } finally {
    await browser?.close(); await server?.close(); persist();
    console.log(JSON.stringify({ ok: report.ok, stage: report.stage, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message }));
  }
})();
