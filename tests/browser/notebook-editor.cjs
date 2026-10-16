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
const files = ['src/App.vue', 'src/style.css', 'src/components/NotebookEditor.vue', 'src/notes/model.ts', 'src/notes/session.ts', 'src/notes/dom.ts'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue notebook UI in Chromium over local Vite HTTP', checks: [], screenshots: [], errors: [], consoleErrors: [], externalRequests: [],
  limitations: ['Browser download and file input are exercised; native dialogs and native filesystem autosave are not.', 'Keyboard/mouse input is automated Chromium input; physical operating-system IME is not covered.', 'Screenshots require visual review.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const note = () => page.locator('[data-testid="notebook-editor"]:visible');
const body = () => note().getByTestId('notebook-content');
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
    await check('invalid-title-can-be-corrected-and-saved', async () => {
      await title().fill('长'.repeat(201));
      assert.match(await note().getByRole('alert').innerText(), /不能超过 200/);
      await title().fill('项目记录');
      assert.equal(await note().getByRole('alert').count(), 0, 'Correcting the invalid title clears its own error');
      // Navigation must work immediately after correcting only the title.
      await note().locator('.note-pages button', { hasText: '会议纪要' }).click(); assert.equal(await title().inputValue(), '会议纪要');
      await note().locator('.note-pages button', { hasText: '项目记录' }).click(); assert.equal(await title().inputValue(), '项目记录');
      await todoEvidence('after-pages-sections-and-title-recovery');
    });
    await check('image-and-following-text-survive-unconfirmed-deletion', async () => {
      await body().click(); await body().press('ControlOrMeta+End'); await body().press('Enter'); await todoEvidence('after-enter-below-todo');
      const chooser = page.waitForEvent('filechooser');
      await note().getByTitle('插入 PNG / JPEG 图片').click();
      await (await chooser).setFiles({ name: 'local-pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
      await body().locator('img').waitFor();
      await todoEvidence('after-inserting-image');
      await body().press('ControlOrMeta+End'); await body().press('ArrowRight'); await body().press('Enter'); await page.keyboard.insertText('图片后的正文。');
      assert.ok((await body().innerText()).includes('图片后的正文。'));
      await todoEvidence('after-typing-below-image');
      // Place only the selection, then use a real browser Backspace. This probes
      // the collapsed-caret path, not a synthetic DOM mutation or component call.
      await body().evaluate(element => {
        const figure = element.querySelector('figure');
        const after = figure?.nextSibling;
        if (!after) throw Error('Expected a real paragraph following the picture');
        element.focus(); const range = document.createRange(); range.selectNodeContents(after); range.collapse(true);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      await page.keyboard.press('Backspace');
      assert.equal(await body().locator('img').count(), 1, 'Backspace beside a picture cannot delete it without confirmation');
      await todoEvidence('after-unconfirmed-backspace');
      await body().locator('[data-delete-image]').click();
      await page.getByRole('dialog', { name: '删除图片', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await body().locator('img').count(), 1);
      await body().locator('[data-delete-image]').click();
      await page.getByRole('dialog', { name: '删除图片', exact: true }).getByRole('button', { name: '确认删除' }).click();
      assert.equal(await body().locator('img').count(), 0);
      assert.ok((await body().innerText()).includes('图片后的正文。'), 'Deleting only the picture preserves following body text');
      await todoEvidence('after-confirmed-picture-deletion');
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
      const model = saved.model; assert.equal(model.format, 'open-office-notebook'); assert.equal(model.version, 1); assert.equal(model.title, '季度项目笔记');
      assert.deepEqual(model.sections.map(item => item.title), ['项目计划', '资料归档']);
      assert.deepEqual(model.sections[0].pages.map(item => item.title), ['项目记录', '会议纪要']);
      const first = model.sections[0].pages[0];
      assert.equal(first.blocks.find(block => blockText(block).includes('今天完成')).content.map(part => part.text).join(''), '今天完成原型，明天验证离线保存。');
      assert.ok(first.blocks.flatMap(block => block.content || []).filter(part => part.text.includes('今天完成')).every(part => part.marks?.includes('bold')));
      const todo = first.blocks.find(block => block.type === 'todo'); assert.ok(todo); assert.equal(todo.checked, true); assert.equal(blockText(todo), '待办事项');
      assert.ok(first.blocks.some(block => blockText(block).includes('图片后的正文。')));
      assert.equal(model.sections[0].pages[1].blocks.map(blockText).join(''), '下一次会议安排在周五。');
      assert.equal(model.sections[1].pages[0].title, '参考材料'); assert.equal(model.sections[1].pages[0].blocks.map(blockText).join(''), '保留本地文件，不上传云端。');
      report.download = { file: path.basename(saved.target), bytes: saved.bytes.length, sha256: crypto.createHash('sha256').update(saved.bytes).digest('hex') };
      assert.equal(await page.getByTestId('global-save-state').innerText(), '已保存');
    });
    await check('reopen-download-and-roundtrip-model', async () => {
      await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready();
      assert.equal(await page.locator('.document-tab').count(), 2); assert.equal(await title().inputValue(), '项目记录');
      assert.ok((await body().innerText()).includes('今天完成原型，明天验证离线保存。'));
      assert.equal(await note().getByRole('checkbox', { name: '标记待办完成' }).isChecked(), true);
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
