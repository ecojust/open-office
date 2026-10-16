/* Real Vue + existing Rust/WASM lifecycle regression. Only native file I/O is stubbed.
 * Runs Vite directly: no package/WASM build, upload or release. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_LIVE_TABS_OUTPUT || path.join(root, 'test-results/live-tab-switching'));
fs.mkdirSync(output, { recursive: true });
const allKinds = ['word', 'sheet', 'presentation', 'pdf'];
const kinds = process.env.OFFICE_LIVE_TABS_KINDS?.split(',') || allKinds;
assert.ok(kinds.length && kinds.every(kind => allKinds.includes(kind)) && new Set(kinds).size === kinds.length);
const report = { ok: false, runtime: 'Real Vue shell and packaged Rust/WASM in Chromium; native file I/O stub',
  limitations: ['Native WebView, OS IME and filesystem writes are not exercised.',
    'Each Rust editor is tested with Notebook in a separate Chromium lifetime; all five kinds are not simultaneously resident.'],
  groups: kinds, checks: [], errors: [], timings: [] };
const pass = name => { report.checks.push(name); console.log('PASS', name); };
let server, browser, page;
const pdfInputCounts = new Map();
const nativeStub = `
export { bytesToBase64, base64ToBytes } from '/src/shared/document.ts';
window.__tabEvidence={exports:[],saves:[]}; let sequence=0;
export const isTauri=()=>true;
export const bootstrap=async()=>({origin:location.origin,basePath:'/',platform:'browser-native-stub',smokeMode:false});
export const listRecentDocuments=async()=>[];
export const onCloseRequested=async()=>()=>{};
export const openDocument=async()=>null;
export const openRecent=async()=>{throw Error('Unexpected openRecent')};
export const pickImage=async()=>null;
export const confirmClose=async()=>{};
export async function saveDocument(request){
 const bytes=Uint8Array.from(atob(request.base64),c=>c.charCodeAt(0));
 const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
 window.__tabEvidence.saves.push(structuredClone(request));
 return {status:'saved',document:{id:!request.saveAs&&request.documentId?request.documentId:'native-file-'+(++sequence),
  name:request.name,extension:request.extension,kind:({docx:'word',xlsx:'sheet',pptx:'presentation',pdf:'pdf',oonote:'note'})[request.extension],sha256,sizeBytes:bytes.length}};
}`;
const ready = () => page.waitForFunction(() => {
  const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
  if (app?.active?.loadError) throw Error(app.active.loadError);
  return app?.active?.ready && !app.busy;
}, null, { timeout: 120000 });
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const evidence = () => page.evaluate(() => window.__tabEvidence);
async function create(kind) {
  console.log('CREATE', kind);
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-' + kind).click(); await ready();
  return page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey);
}
async function call(key, method, ...args) {
  return page.evaluate(async ({ key, method, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.tabs.find(tab => tab.key === key))[method](...args);
  }, { key, method, args });
}
async function switchTo(key) {
  const before = (await evidence()).exports.length, started = Date.now();
  await page.evaluate(key => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    app.changeTab(app.tabs.find(tab => tab.key === key));
  }, key); await ready();
  assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey), key);
  assert.equal((await evidence()).exports.length, before, 'Switching never serializes a file');
  report.timings.push({ operation: 'switch', milliseconds: Date.now() - started });
}
async function documentState(key) {
  return page.evaluate(key => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState, tab = app.tabs.find(tab => tab.key === key);
    return { document: { ...tab.document }, fileId: tab.fileId, dirty: tab.dirty, requiresSaveAs: tab.requiresSaveAs };
  }, key);
}
async function save(key, saveAs = false, name) {
  await switchTo(key);
  await page.evaluate(async ({ saveAs, name }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    await app.task('测试保存', async () => { if (!await app.saveActive(saveAs, undefined, name)) throw Error('Save failed'); });
  }, { saveAs, name }); await ready();
  assert.equal((await call(key, 'inspect')).dirty, false);
}
async function wordInput(text) {
  await page.waitForFunction(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return (await app.handleFor(app.active).inspect()).ui?.pages?.length;
  });
  const state = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.active).inspect();
  });
  const canvas = page.getByTestId('office-word-canvas'), box = await canvas.boundingBox();
  const [x, y, width, height] = state.ui.pages[0];
  await page.mouse.click(box.x + x + width * .6, box.y + Math.min(y + Math.min(180, height / 4), box.height - 40));
  await page.keyboard.press('Control+End'); await page.keyboard.insertText(text);
}
async function sheetInput(text) {
  const state = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.active).inspect();
  });
  const cell = state.ui.visibleCells.find(cell => cell.cell === 'A1'), box = await page.getByTestId('office-sheet-canvas').boundingBox();
  assert.ok(cell); const [x, y, width, height] = cell.rect;
  await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2); await frames();
  await page.keyboard.press('F2');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-sheet-input');
  await page.keyboard.press('Control+a'); await page.keyboard.insertText(text);
}
async function clearError() { const button = page.getByRole('button', { name: '关闭错误提示', exact: true }); if (await button.count()) await button.click(); }
async function pdfToolbar(key, id) {
  const ui = await call(key, 'query', 'ui.state'), item = ui.toolbar.find(item => item.id === id);
  assert.ok(item?.enabled, `${id} is available`);
  const box = await page.getByTestId('pdf-canvas').boundingBox(), [x, y, width, height] = item.rect;
  await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2); await frames();
}
// Keep only one Rust/WASM engine plus Notebook in memory at a time. Separate
// Chromium lifetimes release WASM linear memory between groups. The shell unit
// suite additionally checks routing among the four retained Rust editor kinds.
async function edit(kind, key, text) {
  if (kind === 'word') return wordInput(text);
  if (kind === 'sheet') return sheetInput(text);
  if (kind === 'presentation') return call(key, 'command', 'slide.notes', { index: 0, text });
  await call(key, 'command', 'edit.text'); await frames();
  const ui = await call(key, 'query', 'ui.state'), box = await page.getByTestId('pdf-canvas').boundingBox();
  const [left, top, right, bottom] = ui.active.pages_on_screen[0].rect;
  // Repeated clicks on an existing text box can select it instead of starting a
  // new text input. Add each test edit in a different empty part of the page.
  const count = pdfInputCounts.get(key) ?? 0; pdfInputCounts.set(key, count + 1);
  await page.mouse.click(box.x + left + (right-left) * .2, box.y + top + (bottom-top) * (.35 + count * .14));
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pdf-input');
  await page.keyboard.insertText(text);
}
async function content(kind, key) {
  if (kind === 'word') return (await call(key, 'inspect')).text;
  if (kind === 'sheet') return (await call(key, 'query', 'cell.get', { cell: 'A1' })).value ?? '';
  if (kind === 'presentation') return (await call(key, 'query', 'slide.inspect', { index: 0 })).notes ?? '';
  return (await call(key, 'query', 'document.inspect')).texts.join('');
}
async function runGroup(kind) {
  report.stage = kind;
  console.log('GROUP', kind);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
    await context.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: nativeStub }));
    page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async kind => {
      const symbols = { word: 'RustWordSession', sheet: 'RustSheetSession', presentation: 'RustPresentationSession', pdf: 'RustPdfSession' };
      for (const [type, file, symbol] of [[kind,kind+'/rust/client',symbols[kind]],['note','notes/session','NotebookSession']]) {
        const Type = (await import('/src/' + file + '.ts'))[symbol], original = Type.prototype.export;
        Type.prototype.export = function(...args) { window.__tabEvidence.exports.push({ kind:type }); return original.apply(this, args); };
      }
    }, kind);
    const main = await create(kind); await edit(kind, main, '切换前输入');
    const note = await create('note');
    assert.ok((await content(kind, main)).includes('切换前输入'));
    await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('切换保留的笔记标题');
    await switchTo(main);
    assert.equal((await evidence()).exports.length, 0);
    pass(`${kind}: queued input survives creation and cross-type switching with zero file exports`);

    const before = await content(kind, main);
    await call(main, 'undo'); assert.notEqual(await content(kind, main), before);
    await call(main, 'redo'); assert.equal(await content(kind, main), before);
    await switchTo(note); assert.equal(await page.getByRole('textbox', { name: '页面标题', exact: true }).inputValue(), '切换保留的笔记标题');
    pass(`${kind}: cross-type switches retain content and undo/redo history`);
    await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('长'.repeat(201));
    await page.evaluate(key => { const app = document.querySelector('#app').__vue_app__._instance.setupState; app.changeTab(app.tabs.find(tab => tab.key === key)); }, main);
    await ready(); assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey), note);
    assert.equal(await page.getByRole('textbox', { name: '页面标题', exact: true }).inputValue(), '长'.repeat(201));
    await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('切换保留的笔记标题'); await clearError();
    pass(`${kind}: invalid notebook drafts block switching and preserve the entered text`);
    await switchTo(main);
    if (kind === 'pdf') {
      await call(main, 'command', 'ui.set', { key: 'panel', value: 'comments' }); await frames();
      const ui = await call(main, 'query', 'ui.state'), box = await page.getByTestId('pdf-canvas').boundingBox();
      await page.mouse.click(box.x + (ui.active.viewport[2] + box.width) / 2, box.y + ui.active.viewport[1] + 92);
      await page.keyboard.insertText('未提交批注必须保留'); await frames();
      await page.evaluate(key => { const app = document.querySelector('#app').__vue_app__._instance.setupState; app.changeTab(app.tabs.find(tab => tab.key === key)); }, note);
      await ready(); assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.activeKey), main);
      assert.equal((await call(main, 'query', 'ui.state')).commentDraft.text, '未提交批注必须保留');
      await pdfToolbar(main, 'comment-draft');
      await pdfToolbar(main, 'comment-draft-discard');
      const confirmation = await call(main, 'query', 'ui.state');
      assert.equal(confirmation.commentDraftDialog.confirmDiscard, true);
      assert.equal(confirmation.commentDraft.text, '未提交批注必须保留');
      await pdfToolbar(main, 'comment-draft-confirm-discard');
      assert.equal((await call(main, 'query', 'ui.state')).commentDraft, null); await clearError();
      pass('pdf: unfinished comments still block switching without losing their drafts');
    }

    await save(main); const firstSaved = await documentState(main), firstRequest = (await evidence()).saves.at(-1);
    if (kind === 'word') assert.ok(strFromU8(unzipSync(Buffer.from(firstRequest.base64, 'base64'))['word/document.xml']).includes('切换前输入'));
    await edit(kind, main, '继续编辑');
    await switchTo(note); await switchTo(main);
    const unchanged = await documentState(main);
    assert.deepEqual(unchanged.document, firstSaved.document); assert.equal(unchanged.fileId, firstSaved.fileId); assert.equal(unchanged.dirty, true);
    assert.ok((await content(kind, main)).includes('继续编辑'));
    await save(main); const updatedRequest = (await evidence()).saves.at(-1);
    assert.equal(updatedRequest.documentId, firstSaved.fileId); assert.equal(updatedRequest.expectedSha256, firstSaved.document.sha256); assert.equal(updatedRequest.saveAs, false);
    assert.notEqual(updatedRequest.base64, firstRequest.base64);
    if (kind === 'word') assert.ok(strFromU8(unzipSync(Buffer.from(updatedRequest.base64, 'base64'))['word/document.xml']).includes('继续编辑'));
    const renamedName = '另存后的文档.' + firstSaved.document.extension;
    await save(main, true, renamedName); const renamed = await documentState(main);
    assert.notEqual(renamed.fileId, firstSaved.fileId); assert.equal(renamed.document.name, renamedName);
    pass(`${kind}: switching preserves saved bytes/file identity/hash; Save and Save As write the live revision`);

    const receipt = await call(main, 'exportFile'); await edit(kind, main, '回执之后'); await switchTo(note); await switchTo(main);
    await assert.rejects(() => call(main, 'markSaved', receipt.base64));
    assert.equal((await call(main, 'inspect')).dirty, true);
    await assert.rejects(() => call(main, 'discardChanges'));
    pass(`${kind}: stale save receipts and unconfirmed dirty closes remain rejected`);

    for (const key of [main, note]) await save(key);
    const saved = await documentState(main);
    const imported = await page.evaluate(async sourceDocument => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState;
      let key; await app.task('测试打开', async () => { key = (await app.addDocument({ ...sourceDocument, id: 'original-file' }, 'original-file')).key; }); return key;
    }, saved.document); await ready();
    assert.ok((await content(kind, imported)).includes('回执之后'), 'The current live revision was persisted in the actual exported format');
    const exportCount = (await evidence()).exports.length; await switchTo(note);
    assert.equal((await evidence()).exports.length, exportCount);
    assert.equal((await call(imported, 'inspect')).dirty, false);
    await page.getByTestId('tabs-close-all').click();
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.tabs.length === 0);
    assert.equal(await page.getByTestId('close-discard').count(), 0);
    pass(`${kind}: clean batch close accepts a hidden imported document with no prior export receipt`);

    const dirtyMain = await create(kind); await edit(kind, dirtyMain, '不保存的内容'); await create('note');
    await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('不保存的笔记');
    await page.getByTestId('tabs-close-all').click(); await page.getByTestId('close-cancel').click();
    assert.equal(await page.locator('.document-tab').count(), 2);
    assert.equal(await page.getByRole('textbox', { name: '页面标题', exact: true }).inputValue(), '不保存的笔记');
    assert.ok((await content(kind, dirtyMain)).includes('不保存的内容'));
    await page.getByTestId('tabs-close-all').click();
    const beforeDiscard = await evidence(); await page.getByTestId('close-discard').click();
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__._instance.setupState.tabs.length === 0);
    const afterDiscard = await evidence();
    assert.equal(afterDiscard.saves.length, beforeDiscard.saves.length); assert.equal(afterDiscard.exports.length, beforeDiscard.exports.length);
    pass(`${kind}: dirty batch close requires confirmation; cancellation preserves content and discard does not export/save`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, kind + '-failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); browser = undefined; page = undefined;
  }
}
(async () => {
  try {
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), optimizeDeps: { entries: ['index.html'] },
      server: { host: '127.0.0.1', port: Number(process.env.OFFICE_LIVE_TABS_PORT || 5317), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
        fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen();
    for (const kind of kinds) await runGroup(kind);
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); console.log(output); }
})();
