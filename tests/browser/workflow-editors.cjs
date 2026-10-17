/* Real Vue shell and drawing/source editors in Chromium.
 * Only native.ts is replaced to record save requests. This is not native I/O.
 * Run: node tests/browser/workflow-editors.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_WORKFLOW_OUTPUT || path.join(root, 'test-results/workflow-editors'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Real Vue shell, canvas and code diagram editors in Chromium; native save receipt stub', checks: [], screenshots: [], errors: [], consoleErrors: [], externalRequests: [], limitations: ['Native file dialogs, filesystem writes and platform WebViews are not exercised.', 'Composition events are synthetic and do not claim physical operating-system IME validation.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let server, browser, page;
const nativeStub = `
export { bytesToBase64, base64ToBytes } from '/src/shared/document.ts';
window.__workflowQa = { saves: [], nextOpen: null, recents: [] };
export const isTauri = () => true;
export const bootstrap = async () => ({ origin: location.origin, basePath: '/', platform: 'browser-save-stub', smokeMode: false });
export const listRecentDocuments = async () => window.__workflowQa.recents;
export const onCloseRequested = async () => () => {};
export const openDocument = async () => { const value = window.__workflowQa.nextOpen; window.__workflowQa.nextOpen = null; return value; };
export const openRecent = async () => { throw Error('Unexpected recent-file open'); };
export const pickImage = async () => null;
export const confirmClose = async () => {};
export async function saveDocument(request) {
 const bytes = Uint8Array.from(atob(request.base64), value => value.charCodeAt(0));
 const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
 let kind = 'canvas';
 if (request.extension === 'owflow') kind = JSON.parse(new TextDecoder().decode(bytes)).kind === 'mermaid' ? 'diagram' : 'canvas';
 else if (['mmd','mermaid'].includes(request.extension)) kind = 'diagram';
 const document = { id: request.documentId || 'stub-file-' + (window.__workflowQa.saves.length + 1), name: request.name, extension: request.extension, kind, sha256, sizeBytes: bytes.length };
 window.__workflowQa.saves.push({ request: structuredClone(request), document, at: Date.now() });
 await new Promise(resolve => setTimeout(resolve, 40));
 return { status: 'saved', document };
}
`;
const editor = () => page.locator('[data-testid="workflow-editor"]:visible');
const scene = () => editor().getByTestId('scene-editor');
const source = () => editor().getByTestId('diagram-source');
async function check(name, action) { report.stage = name; persist(); await action(); report.checks.push(name); persist(); }
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function poll(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await page.waitForTimeout(40); }
  throw Error('Timed out: ' + description);
}
async function active() { return page.evaluate(() => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return { key: a.activeKey, name: a.active?.document.name, kind: a.active?.document.kind, dirty: a.active?.dirty, ready: a.active?.ready, fileId: a.active?.fileId }; }); }
async function model(key) { return page.evaluate(async key => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.workflowHandles.get(key || a.activeKey).inspectModel(); }, key); }
async function state() { return page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.workflowHandles.get(a.activeKey).inspect(); }); }
async function ready(kind) { await poll(async () => { const a = await active(); return a.ready && a.kind === kind; }, `${kind} document is ready`); await frame(); }
async function saves() { return page.evaluate(() => window.__workflowQa.saves); }
async function save() {
  const count = (await saves()).length;
  await page.getByTestId('shell-save').click();
  await poll(async () => (await saves()).length > count && !(await active()).dirty, 'shared save acknowledges current content');
  return (await saves()).at(-1);
}
async function capture(name) { const file = `${report.screenshots.length + 1}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); persist(); }
async function goHome() { await page.locator('.home-tab').click(); await page.getByTestId('home-new-canvas').waitFor(); }
async function switchTab(name) { await page.locator('.document-tab .tab-name').filter({ hasText: name }).click(); await frame(); }
async function undo() { await page.locator('.titlebar').getByRole('button', { name: '撤销', exact: true }).click(); await frame(); }
async function redo() { await page.locator('.titlebar').getByRole('button', { name: '重做', exact: true }).click(); await frame(); }
async function draw(tool, x, y, width, height) {
  await scene().getByTestId('tool-' + tool).click();
  const b = await scene().getByTestId('canvas-stage').boundingBox(); assert.ok(b);
  await page.mouse.move(b.x + x, b.y + y); await page.mouse.down(); await page.mouse.move(b.x + x + width, b.y + y + height, { steps: 8 }); await page.mouse.up(); await frame();
}
async function closeCurrent() {
  const a = await active(), count = await page.getByTestId('workflow-editor').count();
  await page.getByRole('button', { name: '关闭 ' + a.name, exact: true }).click(); if (await page.getByTestId('close-discard').isVisible()) await page.getByTestId('close-discard').click(); await frame();
  assert.equal(await page.getByTestId('workflow-editor').count(), count - 1, 'Closing removes the editor component');
  assert.equal(await page.evaluate(key => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.workflowHandles.has(key) || a.workflowEntries.some(entry => entry.document.id === key); }, a.key), false, 'Closing releases the session and its handle');
}
async function openRecord(saved) {
  await page.evaluate(value => { window.__workflowQa.nextOpen = { ...value.document, base64: value.request.base64 }; }, saved);
  await page.getByTestId('shell-open').click(); await ready(saved.document.kind);
}
async function saveAs(format, name) {
  const before = (await saves()).length;
  await page.getByTestId('shell-save-as').click(); await page.getByTestId('save-format-dialog').waitFor();
  await page.getByTestId('save-format-' + format).check(); await page.getByTestId('save-format-name').fill(name);
  await page.getByTestId('save-format-confirm').click(); await poll(async () => (await saves()).length > before, 'save-as request');
  await page.getByTestId('save-format-dialog').waitFor({ state: 'hidden' }); return (await saves()).at(-1);
}

(async () => {
  try {
    report.startedAt = new Date().toISOString();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: Number(process.env.OFFICE_WORKFLOW_PORT || 5326), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1480, height: 1000 }, locale: 'zh-CN' });
    await context.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: nativeStub }));
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push(event.text()); });
    await page.goto(origin);
    let firstCanvas, firstDiagram, canvasSaved, diagramSaved, originalSource;
    await check('two-subapps-share-the-office-shell', async () => {
      assert.equal(await page.getByTestId('home-new-canvas').count(), 1); assert.equal(await page.getByTestId('home-new-diagram').count(), 1);
      await page.getByTestId('home-new-canvas').click(); await ready('canvas'); firstCanvas = await active();
      assert.equal(await page.getByTestId('shell-save').count(), 1); assert.equal(await page.locator('[data-testid="workflow-editor"]:visible').count(), 1);
      assert.equal(await editor().locator('[data-testid*="server"],iframe,[aria-label="界面主题"]').count(), 0);
      assert.equal((await model()).scene.elements.length, 0);
      await page.getByTestId('shell-autosave').click(); assert.equal(await page.getByTestId('autosave-countdown').textContent(), '请先保存');
      await page.getByTestId('shell-autosave').click(); assert.equal(await page.getByTestId('autosave-countdown').count(), 0);
    });
    await check('canvas-pointer-drawing-text-and-global-undo-redo', async () => {
      await draw('rectangle', 330, 170, 210, 110);
      const document = await model(); assert.equal(document.scene.elements.length, 1); assert.equal(document.scene.elements[0].shape, 'rectangle');
      await scene().locator('[data-element-id]').first().dblclick(); await scene().getByRole('textbox', { name: '编辑图形文字' }).fill('季度计划与执行');
      await page.getByTestId('shell-save').click(); await poll(async () => !(await active()).dirty, 'inline text is saved through shared toolbar');
      assert.equal((await model()).scene.elements[0].text, '季度计划与执行');
      await undo(); assert.equal((await model()).scene.elements[0].text, '');
      await redo(); assert.equal((await model()).scene.elements[0].text, '季度计划与执行');
      canvasSaved = await save(); firstCanvas = await active(); assert.equal(canvasSaved.request.extension, 'owflow');
    });
    await check('canvas-delete-requires-confirmation-and-undo-restores-content', async () => {
      const before = (await model()).scene;
      await scene().locator('[data-element-id]').first().click(); await page.keyboard.press('Delete');
      await scene().getByTestId('canvas-delete-dialog').waitFor(); assert.deepEqual((await model()).scene, before);
      await scene().getByTestId('canvas-delete-dialog').getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual((await model()).scene, before);
      await scene().locator('[data-element-id]').first().click(); await page.keyboard.press('Delete'); await scene().getByTestId('confirm-canvas-delete').click();
      assert.equal((await model()).scene.elements.length, 0); await undo(); assert.deepEqual((await model()).scene, before);
    });
    await check('eraser-confirms-before-removing-any-element', async () => {
      const before = (await model()).scene;
      await scene().getByTestId('tool-eraser').click(); await scene().locator('[data-element-id]').first().click();
      await scene().getByTestId('canvas-delete-dialog').waitFor(); assert.deepEqual((await model()).scene, before);
      await scene().getByTestId('canvas-delete-dialog').getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual((await model()).scene, before);
      await scene().locator('[data-element-id]').first().click(); await scene().getByTestId('confirm-canvas-delete').click();
      assert.equal((await model()).scene.elements.length, 0); await undo(); assert.deepEqual((await model()).scene, before);
      await scene().getByTestId('tool-select').click();
    });
    await check('six-canvas-templates-insert-editable-elements', async () => {
      await scene().getByTestId('board-template-toggle').click(); assert.equal(await scene().locator('[data-board-template]').count(), 6);
      await scene().locator('[data-board-template="board"]').click(); assert.ok((await model()).scene.elements.length > 1);
      await undo(); assert.equal((await model()).scene.elements.length, 1); await capture('canvas-light');
    });
    await check('code-editor-preview-and-source-tab-isolation', async () => {
      await goHome(); await page.getByTestId('home-new-diagram').click(); await ready('diagram'); firstDiagram = await active(); originalSource = await source().inputValue();
      const edited = 'flowchart LR\n  A[本地文档] --> B[共享工具栏]\n  B --> C[独立标签]';
      await source().fill(edited);
      await switchTab(firstCanvas.name); await ready('canvas'); assert.equal((await model()).scene.elements[0].text, '季度计划与执行');
      await switchTab(firstDiagram.name); await ready('diagram'); assert.equal(await source().inputValue(), edited);
      await poll(async () => (await editor().getByTestId('diagram-preview').textContent()).includes('共享工具栏'), 'edited source appears in SVG preview');
      assert.equal(await editor().getByTestId('diagram-error').count(), 0);
      await undo(); assert.equal(await source().inputValue(), originalSource); await redo(); assert.equal(await source().inputValue(), edited);
      diagramSaved = await save(); firstDiagram = await active(); assert.equal(JSON.parse(Buffer.from(diagramSaved.request.base64, 'base64')).source, edited);
    });
    await check('code-template-and-style-galleries-with-undo', async () => {
      const before = await source().inputValue();
      await editor().getByTestId('diagram-template-toggle').click(); assert.equal(await editor().locator('[data-template-id]').count(), 46);
      assert.equal(new Set(await editor().locator('[data-diagram-kind]').evaluateAll(nodes => nodes.map(node => node.dataset.diagramKind))).size, 22);
      await editor().getByRole('searchbox', { name: '搜索图表模板' }).fill('时序'); assert.ok(await editor().locator('[data-template-id]').count() > 0);
      await editor().locator('[data-template-id]').first().click(); await editor().getByTestId('diagram-confirm-template').click();
      assert.notEqual(await source().inputValue(), before); await undo(); assert.equal(await source().inputValue(), before);
      await editor().getByTestId('diagram-style-toggle').click(); assert.equal(await editor().getByTestId('diagram-style-card').count(), 10);
      await editor().locator('[data-diagram-style="forest"]').click();
      if (await editor().getByTestId('diagram-style-panel').isVisible()) await editor().getByRole('button', { name: '完成', exact: true }).click();
      assert.equal((await model()).diagramStyle, 'forest'); assert.equal(await source().inputValue(), before); await capture('diagram-light');
    });
    await check('source-errors-are-visible-and-editable-source-can-still-be-saved', async () => {
      const valid = await source().inputValue(), invalid = 'flowchart LR\n  this is an invalid statement ???';
      await source().fill(invalid); await editor().getByTestId('diagram-error').waitFor(); assert.equal(await source().getAttribute('aria-invalid'), 'true');
      const saved = await save(); assert.equal(JSON.parse(Buffer.from(saved.request.base64, 'base64')).source, invalid);
      assert.equal(await editor().getByTestId('diagram-export-image').isDisabled(), true);
      await undo(); assert.equal(await source().inputValue(), valid); await editor().getByTestId('diagram-preview').waitFor();
    });
    await check('unfinished-source-composition-blocks-export-without-losing-input', async () => {
      const before = await model(), draft = 'flowchart LR\n  A[中文输入中] --> B[确认后保留]';
      await source().focus(); await source().dispatchEvent('compositionstart');
      await source().evaluate((element, value) => { element.value = value; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '中文输入中', isComposing: true })); }, draft);
      const during = await page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState, h = a.workflowHandles.get(a.activeKey); let error = ''; try { await h.exportFile(); } catch(cause) { error = cause.message; } return { canExport: await h.canBackgroundExport(), error, state: await h.inspect() }; });
      assert.equal(during.canExport, false); assert.equal(during.state.dirty, true); assert.match(during.error, /输入法|输入/); assert.equal((await model()).source, before.source);
      await source().dispatchEvent('compositionend'); await editor().getByRole('button', { name: '重置预览缩放' }).click(); await poll(async () => (await model()).source === draft, 'composition commits after confirmation');
      await undo(); assert.equal(await source().inputValue(), before.source);
    });
    await check('svg-and-png-export-use-host-save-without-retargeting-document', async () => {
      const before = await active();
      const svg = await saveAs('svg', '图表验证'); assert.match(Buffer.from(svg.request.base64, 'base64').toString(), /<svg\b/); assert.equal(svg.request.documentId, undefined);
      assert.equal((await active()).fileId, before.fileId); assert.equal((await active()).kind, 'diagram');
      await editor().getByTestId('diagram-export-image').click(); const count = (await saves()).length;
      await editor().getByTestId('diagram-export-png').click(); await poll(async () => (await saves()).length > count, 'PNG export request');
      const png = (await saves()).at(-1); assert.equal(png.request.extension, 'png'); assert.equal(Buffer.from(png.request.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal((await active()).fileId, before.fileId); assert.equal((await active()).kind, 'diagram');
    });
    await check('code-to-canvas-copy-is-independent-and-editable', async () => {
      const codeKey = (await active()).key, original = await model(codeKey);
      await editor().getByTestId('diagram-create-copy').click(); await ready('canvas');
      assert.notEqual((await active()).key, codeKey); assert.ok((await model()).scene.elements.some(element => element.type === 'edge'));
      const node = (await model()).scene.elements.find(element => element.type === 'shape');
      await scene().locator(`[data-element-id="${node.id}"]`).dblclick(); await scene().getByRole('textbox', { name: '编辑图形文字' }).fill('副本可以独立编辑'); await save();
      assert.deepEqual(await model(codeKey), original); await closeCurrent(); await switchTab(firstDiagram.name); await ready('diagram');
    });
    await check('save-reopen-preserves-source-style-and-canvas-model', async () => {
      diagramSaved = await save(); const before = await model(); await closeCurrent(); await openRecord(diagramSaved); assert.deepEqual(await model(), before);
      await closeCurrent(); await switchTab(firstCanvas.name); await ready('canvas'); canvasSaved = await save(); const canvasBefore = await model(); await closeCurrent(); await openRecord(canvasSaved); assert.deepEqual(await model(), canvasBefore);
      await openRecord(diagramSaved); await ready('diagram');
    });
    await check('light-dark-and-narrow-layout-do-not-scroll-the-page', async () => {
      await page.getByTestId('theme-dark').click(); await frame(); await capture('diagram-dark');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      for (const width of [980, 640]) {
        await page.setViewportSize({ width, height: 850 }); await frame();
        const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
        assert.ok(dimensions.scrollWidth <= dimensions.width + 1, 'The page must not overflow horizontally'); assert.ok(dimensions.scrollHeight <= dimensions.height + 1, 'Editor areas scroll within the workspace');
      }
      await capture('diagram-narrow'); await page.setViewportSize({ width: 1480, height: 1000 }); await page.getByTestId('theme-light').click();
    });
    await check('native-autosave-scheduler-saves-edited-source-back-to-same-file', async () => {
      const before = await active(), count = (await saves()).length;
      await page.getByTestId('shell-autosave').click(); assert.equal(await page.getByTestId('autosave-countdown').textContent(), '已保存');
      const edited = 'flowchart TD\n  A[自动保存] --> B[原文件]'; await source().fill(edited);
      await editor().getByRole('button', { name: '重置预览缩放' }).click();
      const remaining = await poll(async () => { const text = await page.getByTestId('autosave-countdown').textContent(); return /^\d+ 秒$/.test(text) ? parseInt(text) : false; }, 'visible autosave countdown');
      await poll(async () => { const text = await page.getByTestId('autosave-countdown').textContent(); return /^\d+ 秒$/.test(text) && parseInt(text) < remaining; }, 'countdown decreases from the scheduler deadline', 4000);
      await capture('autosave-countdown');
      await poll(async () => (await saves()).length > count && !(await active()).dirty, 'real 30-second autosave', 38000);
      const record = (await saves()).at(-1); assert.equal(record.request.documentId, before.fileId); assert.equal(record.request.saveAs, false); assert.match(record.request.expectedSha256, /^[0-9a-f]{64}$/);
      assert.equal(JSON.parse(Buffer.from(record.request.base64, 'base64')).source, edited); assert.equal(await page.getByTestId('global-save-state').textContent(), '已自动保存');
      await poll(async () => await page.getByTestId('autosave-countdown').textContent() === '已保存', 'countdown acknowledges completed scheduler task', 2500); await page.getByTestId('shell-autosave').click(); assert.equal(await page.getByTestId('autosave-countdown').count(), 0);
    });
    await check('multi-page-xml-import-creates-independent-tabs-and-protects-original', async () => {
      const xml = '<mxfile>' + ['首页', '详情'].map((name, index) => `<diagram id="page-${index}" name="${name}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" parent="1" vertex="1" value="${name}内容" style="shape=rectangle;fillColor=#ffffff;strokeColor=#334155;"><mxGeometry x="50" y="50" width="180" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram>`).join('') + '</mxfile>';
      const before = await page.locator('.document-tab').count();
      await page.getByTestId('document-open-input').setInputFiles({ name: '多页图形.drawio', mimeType: 'application/xml', buffer: Buffer.from(xml) });
      await poll(async () => await page.locator('.document-tab').count() === before + 2, 'both XML pages become independent tabs'); await ready('canvas');
      const names = await page.locator('.document-tab .tab-name').allTextContents(); const imported = names.filter(name => name.includes('多页图形')); assert.equal(imported.length, 2);
      for (const name of imported) { await switchTab(name.trim()); await ready('canvas'); assert.equal((await model()).scene.elements.length, 1); const saved = await save(); assert.equal(saved.request.extension, 'owflow'); assert.equal(saved.request.saveAs, true); }
    });
    await check('invalid-import-leaves-current-document-and-tabs-intact', async () => {
      const before = await model(), count = await page.locator('.document-tab').count();
      await page.getByTestId('document-open-input').setInputFiles({ name: '无效图形.drawio', mimeType: 'application/xml', buffer: Buffer.from('<!DOCTYPE mxfile [<!ENTITY injected SYSTEM "https://invalid.example/entity">]><mxfile>&injected;</mxfile>') });
      await page.locator('.error-banner').waitFor(); assert.equal(await page.locator('.document-tab').count(), count); assert.deepEqual(await model(), before); await page.getByRole('button', { name: '关闭错误提示' }).click();
    });
    await check('closing-an-inactive-document-releases-only-its-session', async () => {
      const before = await active(), currentModel = await model(), count = await page.getByTestId('workflow-editor').count();
      const inactive = await page.evaluate(() => { const a = document.querySelector('#app').__vue_app__._instance.setupState; const tab = a.tabs.find(tab => tab.key !== a.activeKey && ['canvas','diagram'].includes(tab.document.kind)); return { key: tab.key, name: tab.document.name }; });
      await page.getByRole('button', { name: '关闭 ' + inactive.name, exact: true }).click(); if (await page.getByTestId('close-discard').isVisible()) await page.getByTestId('close-discard').click(); await frame();
      assert.equal(await page.getByTestId('workflow-editor').count(), count - 1); assert.equal((await active()).key, before.key); assert.deepEqual(await model(), currentModel);
      assert.equal(await page.evaluate(key => document.querySelector('#app').__vue_app__._instance.setupState.workflowHandles.has(key), inactive.key), false);
    });
    await check('global-new-menu-opens-both-editor-types-and-close-cancels-unsaved-documents', async () => {
      for (const kind of ['canvas', 'diagram']) {
        const count = await page.getByTestId('workflow-editor').count(); await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-' + kind).click(); await ready(kind);
        assert.equal(await page.getByTestId('workflow-editor').count(), count + 1); assert.equal((await active()).dirty, true);
        const current = await active(); await page.getByRole('button', { name: '关闭 ' + current.name, exact: true }).click(); await page.getByTestId('close-documents-dialog').waitFor(); await page.getByTestId('close-cancel').click(); assert.equal((await active()).key, current.key);
        await closeCurrent(); assert.equal(await page.getByTestId('workflow-editor').count(), count);
      }
    });
    await check('seven-home-cards-keep-long-recent-list-scroll-contained', async () => {
      await page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; window.__workflowQa.recents = Array.from({ length: 60 }, (_, i) => ({ id: 'recent-' + i, name: '本地画布记录' + i + '.owflow', extension: 'owflow', kind: i % 2 ? 'diagram' : 'canvas', lastOpenedAt: Date.now() })); await a.refreshRecents(); });
      await goHome(); await page.setViewportSize({ width: 1280, height: 800 }); await frame(); assert.equal(await page.locator('.create-card').count(), 7);
      const before = await page.evaluate(() => { const list = document.querySelector('.recent-list'); return { document: document.documentElement.scrollTop, windowY: scrollY, height: list.clientHeight, scrollHeight: list.scrollHeight }; });
      assert.ok(before.height > 100); assert.ok(before.scrollHeight > before.height);
      await page.locator('.recent-list').hover(); await page.mouse.wheel(0, 700); await frame();
      const after = await page.evaluate(() => ({ document: document.documentElement.scrollTop, windowY: scrollY, list: document.querySelector('.recent-list').scrollTop }));
      assert.equal(after.document, before.document); assert.equal(after.windowY, before.windowY); assert.ok(after.list > 0); await capture('home-seven-apps-recent-list');
    });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.ok = true; report.finishedAt = new Date().toISOString();
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; if (page && !page.isClosed()) { try { await capture('failure'); } catch {} } }
  finally { await browser?.close(); await server?.close(); persist(); console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message })); }
})();
