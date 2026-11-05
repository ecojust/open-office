/* Real Vue naming/rename regression. Native file operations are an explicit
 * in-memory stub; native rename safety is covered separately by Rust tests.
 * Uses existing WASM resources, with one Rust editor per browser lifetime.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_DOCUMENT_NAMES_OUTPUT || path.join(root, 'test-results/document-names'));
const groups = (process.env.OFFICE_DOCUMENT_NAMES_GROUPS || 'structured,naming-edges,word,sheet,presentation,pdf').split(',');
assert.ok(groups.length && groups.every(group => ['structured', 'naming-edges', 'word', 'sheet', 'presentation', 'pdf'].includes(group)));
fs.mkdirSync(output, { recursive: true });
const sources = ['src/App.vue', 'src/shared/document.ts', 'src/native.ts', 'src/components/ScheduleEditor.vue', 'src/components/CalendarEditor.vue', 'src/components/NotebookEditor.vue', 'src/components/WorkflowEditor.vue', 'src/schedule/session.ts', 'src/calendar/session.ts', 'src/notes/session.ts', 'src/workflow/session.ts'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, groups, checks: [], errors: [], screenshots: [],
  runtime: 'Real Vue shell, structured editors and existing Rust/WASM editors in Chromium; native file receipts and rename operations are in-memory stubs',
  limitations: ['No native WebView, file dialog, physical IME or filesystem rename is exercised.', 'Browser download assertions cover the generated download and do not rename the original imported file.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
let server, browser, page;
const nativeStub = `
export { bytesToBase64, base64ToBytes } from '/src/shared/document.ts';
let sequence=0;
const e=window.__nameEvidence={native:true,saves:[],renames:[],files:{},savePlan:[],renamePlan:[]};
const hash=async base64=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(base64),c=>c.charCodeAt(0))))].map(n=>n.toString(16).padStart(2,'0')).join('');
const receipt=file=>{const {base64,...document}=file;return document};
const kindOf=(extension,base64)=>({docx:'word',xlsx:'sheet',csv:'sheet',tsv:'sheet',pptx:'presentation',pdf:'pdf',oonote:'note',ooschedule:'schedule',oocalendar:'calendar'})[extension]||((JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)))).kind==='mermaid')?'diagram':'canvas');
window.__seedNameFile=async file=>{const data={...file,sha256:await hash(file.base64),sizeBytes:atob(file.base64).length};e.files[data.id]=data;return structuredClone(data)};
export const isTauri=()=>e.native;
export const bootstrap=async()=>({origin:location.origin,basePath:'/',platform:'browser-native-stub',smokeMode:false});
export const listRecentDocuments=async()=>Object.values(e.files).map(file=>({...receipt(file),lastOpenedAt:1}));
export const onCloseRequested=async()=>()=>{};
export const openDocument=async()=>null;
export const openRecent=async id=>{if(!e.files[id])throw Error('Missing stub file');return structuredClone(e.files[id])};
export const pickImage=async()=>null;
export const clipboardImages=async()=>[];
export const confirmClose=async()=>{};
export async function renameDocument(request){
 e.renames.push(structuredClone(request)); const action=e.renamePlan.shift()||{};
 if(action.status)return action;
 const file=e.files[request.documentId];
 if(!file||file.sha256!==request.expectedSha256)return {status:'conflict',message:'Stub external file change'};
 if(request.name!==file.name&&request.name.normalize('NFC').toLowerCase()===file.name.normalize('NFC').toLowerCase())return {status:'conflict',message:'Stub case-insensitive or canonical-equivalent path already exists'};
 if(Object.values(e.files).some(other=>other.id!==file.id&&other.name===request.name))return {status:'conflict',message:'Stub destination exists'};
 if(request.name.split('.').at(-1)!==file.extension)throw Error('Rename changed extension');
 file.name=action.name||request.name;return {status:'renamed',document:receipt(file)};
}
export async function saveDocument(request){
 e.saves.push(structuredClone(request)); const action=e.savePlan.shift()||{};
 if(action.status)return action;
 const existing=request.documentId&&!request.saveAs?e.files[request.documentId]:undefined;
 if(request.documentId&&!request.saveAs&&!existing)throw Error('Save lost file capability');
 if(existing&&request.expectedSha256!==existing.sha256)return {status:'conflict',message:'Stub stale save hash'};
 const name=action.name||(existing?existing.name:request.name);
 const file={id:existing?.id||'name-file-'+(++sequence),name,extension:request.extension,kind:kindOf(request.extension,request.base64),base64:request.base64,sha256:await hash(request.base64),sizeBytes:atob(request.base64).length};
 e.files[file.id]=file;return {status:'saved',document:receipt(file)};
}
`;
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready() {
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?.__vue_app__?._instance.setupState;
    if (app?.active?.loadError) throw Error(app.active.loadError);
    return app?.active?.ready && !app.busy;
  }, null, { timeout: 120000 });
  await frames();
}
const evidence = () => page.evaluate(() => structuredClone(window.__nameEvidence));
async function state(key) {
  return page.evaluate(key => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState, tab = key ? app.tabs.find(item => item.key === key) : app.active;
    return { key: tab.key, name: tab.document.name, extension: tab.document.extension, kind: tab.document.kind, dirty: tab.dirty, fileId: tab.fileId, sha256: tab.document.sha256, requiresSaveAs: tab.requiresSaveAs };
  }, key);
}
async function call(key, method, ...args) {
  return page.evaluate(async ({ key, method, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return app.handleFor(app.tabs.find(tab => tab.key === key))[method](...args);
  }, { key, method, args });
}
async function model(key) { return JSON.parse(Buffer.from((await call(key, 'exportFile')).base64, 'base64').toString('utf8')); }
async function create(kind) {
  await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-' + kind).click(); await ready();
  if (kind === 'schedule' && await page.getByTestId('schedule-project-confirm').isVisible()) { await page.getByTestId('schedule-project-confirm').click(); await ready(); }
  return (await state()).key;
}
async function tabButton(key) {
  const index = await page.evaluate(key => document.querySelector('#app').__vue_app__._instance.setupState.tabs.findIndex(tab => tab.key === key), key);
  assert.ok(index >= 0); return page.locator('.document-tab').nth(index).locator('.tab-name');
}
async function switchTo(key) { await (await tabButton(key)).click(); await ready(); assert.equal((await state()).key, key); }
async function beginRename(key) {
  await (await tabButton(key)).dblclick(); await page.getByTestId('document-rename-dialog').waitFor();
  assert.equal((await state()).key, key, 'Double-click selects the intended live document');
}
async function rename(key, title) {
  await beginRename(key); await page.getByTestId('document-rename-input').fill(title);
  await page.getByTestId('document-rename-confirm').click(); await page.getByTestId('document-rename-dialog').waitFor({ state: 'hidden' }); await ready();
}
async function save() { await page.getByTestId('shell-save').click(); await ready(); }
async function clearError() { const close = page.getByRole('button', { name: '关闭错误提示', exact: true }); if (await close.count()) await close.click(); }
async function plan(savePlan = [], renamePlan = []) { await page.evaluate(({ savePlan, renamePlan }) => { window.__nameEvidence.savePlan = savePlan; window.__nameEvidence.renamePlan = renamePlan; }, { savePlan, renamePlan }); }
async function saveAs(name) {
  await page.getByTestId('shell-save-as').click(); await page.getByTestId('save-format-name').fill(name); await page.getByTestId('save-format-confirm').click(); await ready();
}
async function closeSaveDialog() { if (await page.getByTestId('save-format-dialog').count()) await page.getByTestId('save-format-cancel').click(); await clearError(); }
function stem(name) { return name.replace(/\.[^.]+$/, ''); }
function storedModel(file) { return JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')); }
async function expectCleanStored(key, expectedTitle) {
  const current = await state(key), file = (await evidence()).files[current.fileId];
  assert.ok(file); assert.equal(current.name, file.name); assert.equal(stem(file.name), expectedTitle); assert.equal(current.sha256, file.sha256);
  assert.equal(current.dirty, false); assert.equal((await call(key, 'inspect')).dirty, false);
  if (['note', 'schedule', 'calendar', 'canvas', 'diagram'].includes(current.kind)) assert.equal(storedModel(file).title, expectedTitle);
  return file;
}
async function structured() {
  const ids = {};
  for (const kind of ['schedule', 'calendar', 'note', 'canvas', 'diagram']) {
    const key = ids[kind] = await create(kind), original = await state(key), before = await model(key);
    assert.equal(before.title, stem(original.name));
    const initial = await call(key, 'inspect'); await beginRename(key); await page.getByTestId('document-rename-input').fill('取消的草稿');
    assert.equal((await model(key)).title, before.title); assert.equal((await state(key)).name, original.name);
    await page.getByTestId('document-rename-cancel').click(); assert.equal((await call(key, 'inspect')).revision, initial.revision);
    const name = `项目 ${kind} 中文`;
    await rename(key, name); assert.equal((await state(key)).name, `${name}.${original.extension}`); const renamedModel = await model(key); assert.equal(renamedModel.title, name);
    const compared = { ...renamedModel, title: before.title };
    if ('updatedAt' in before) { assert.ok(Date.parse(renamedModel.updatedAt) >= Date.parse(before.updatedAt)); compared.updatedAt = before.updatedAt; }
    assert.deepEqual(compared, before, 'Renaming preserves pages, section names and project contents'); assert.equal((await call(key, 'inspect')).documentId, initial.documentId);
    await save(); await expectCleanStored(key, name);
    pass(`${kind}: new document, cancelled draft, double-click rename and stored title agree`);
  }

  // Rename an inactive tab without touching the document that was active before it.
  const inactiveBefore = await model(ids.diagram); await rename(ids.calendar, '日历多标签');
  assert.equal((await model(ids.diagram)).title, inactiveBefore.title); assert.equal((await model(ids.calendar)).title, '日历多标签');
  await call(ids.calendar, 'undo'); await frames(); assert.equal((await state(ids.calendar)).name, '项目 calendar 中文.oocalendar');
  await call(ids.calendar, 'redo'); await frames(); assert.equal((await state(ids.calendar)).name, '日历多标签.oocalendar');
  await save(); const calendarSaved = await expectCleanStored(ids.calendar, '日历多标签');
  pass('inactive tab rename and undo/redo synchronize only the intended document');

  await page.getByTestId('calendar-settings').click(); await page.getByTestId('calendar-book-title').fill('设置里的日历'); await page.getByTestId('calendar-settings-confirm').click(); await frames();
  assert.equal((await state(ids.calendar)).name, '设置里的日历.oocalendar');
  await page.evaluate(async key => { const app = document.querySelector('#app').__vue_app__._instance.setupState; await app.handleFor(app.tabs.find(tab => tab.key === key)).mcpExecute('calendar_edit', { operations: [{ op: 'book.title', title: 'MCP 日历名称' }] }, () => {}); }, ids.calendar);
  await frames(); assert.equal((await state(ids.calendar)).name, 'MCP 日历名称.oocalendar');
  await save(); await expectCleanStored(ids.calendar, 'MCP 日历名称');
  await switchTo(ids.schedule); await page.getByTestId('schedule-settings').click(); await page.getByTestId('schedule-project-title').fill('设置里的项目'); await page.getByTestId('schedule-project-confirm').click(); await frames();
  assert.equal((await state(ids.schedule)).name, '设置里的项目.ooschedule'); await save(); await expectCleanStored(ids.schedule, '设置里的项目');
  pass('project/calendar settings and MCP title edits synchronize file names');

  await switchTo(ids.calendar); const invalidBefore = await state(), invalidModel = await model(ids.calendar), counts = await evidence();
  for (const invalid of ['目录/文件', 'CON', '超'.repeat(100)]) {
    await beginRename(ids.calendar); await page.getByTestId('document-rename-input').fill(invalid); await page.getByTestId('document-rename-confirm').click(); await frames();
    assert.equal(await page.getByTestId('document-rename-dialog').count(), 1); assert.equal((await state()).name, invalidBefore.name); assert.equal((await model(ids.calendar)).title, invalidModel.title);
    await page.getByTestId('document-rename-cancel').click();
  }
  await beginRename(ids.calendar); const input = page.getByTestId('document-rename-input'); await input.fill('中文输入候选');
  await input.dispatchEvent('compositionstart'); await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true }); await frames();
  assert.equal(await page.getByTestId('document-rename-dialog').count(), 1); assert.equal((await state()).name, invalidBefore.name);
  await input.dispatchEvent('compositionend'); await page.keyboard.press('Escape'); await page.getByTestId('document-rename-dialog').waitFor({ state: 'hidden' });
  assert.equal((await state()).name, invalidBefore.name); assert.equal((await evidence()).renames.length, counts.renames.length); assert.equal((await evidence()).saves.length, counts.saves.length);
  pass('invalid filenames, composition Enter and Escape keep model and file identity unchanged');

  await rename(ids.calendar, '拒绝覆盖后重试'); const beforeConflict = await evidence();
  await plan([], [{ status: 'conflict', message: '目标文件已存在' }]); await save();
  assert.equal((await evidence()).saves.length, beforeConflict.saves.length); assert.deepEqual((await evidence()).files, beforeConflict.files); assert.equal((await state()).dirty, true);
  await clearError(); await save(); const retryFile = await expectCleanStored(ids.calendar, '拒绝覆盖后重试'); assert.equal(retryFile.id, calendarSaved.id);
  pass('rename conflict preserves saved bytes and pending edit; retry saves using the same capability');

  await rename(ids.calendar, '改名成功写入失败'); const beforeWriteFailure = await evidence();
  await plan([{ status: 'conflict', message: '测试保存失败' }]); await save();
  const failedState = await state(), afterFailure = await evidence(), renamedFile = afterFailure.files[failedState.fileId];
  assert.equal(renamedFile.name, '改名成功写入失败.oocalendar'); assert.equal(renamedFile.base64, beforeWriteFailure.files[failedState.fileId].base64);
  assert.equal(failedState.dirty, true); assert.equal(failedState.sha256, renamedFile.sha256); assert.equal(failedState.name, renamedFile.name);
  const renameCount = afterFailure.renames.length; await clearError(); await save(); await expectCleanStored(ids.calendar, '改名成功写入失败');
  assert.equal((await evidence()).renames.length, renameCount);
  pass('successful rename plus failed write retains actual file identity and dirty content for retry');

  const originalSaveAs = await state(), originalFiles = (await evidence()).files, beforeSaveAsModel = await model(ids.calendar);
  await plan([{ status: 'cancelled' }]); await saveAs('取消另存名称');
  assert.equal((await state()).name, originalSaveAs.name); assert.equal((await model(ids.calendar)).title, beforeSaveAsModel.title); assert.deepEqual((await evidence()).files, originalFiles); await closeSaveDialog();
  await plan([{ name: '系统最终名称.oocalendar' }]); await saveAs('建议名称'); await page.getByTestId('save-format-dialog').waitFor({ state: 'hidden' });
  const actualFile = await expectCleanStored(ids.calendar, '系统最终名称'); assert.notEqual(actualFile.id, originalSaveAs.fileId); assert.deepEqual((await evidence()).files[originalSaveAs.fileId], originalFiles[originalSaveAs.fileId]);
  await plan([{ name: '第二次保存待重试.oocalendar' }, { status: 'conflict', message: '测试第二次保存失败' }]); await saveAs('另一建议名称');
  assert.equal((await state()).name, '第二次保存待重试.oocalendar'); assert.equal((await state()).dirty, true); const pendingId = (await state()).fileId;
  await closeSaveDialog(); await save(); const corrected = await expectCleanStored(ids.calendar, '第二次保存待重试'); assert.equal(corrected.id, pendingId);
  pass('Save As cancellation is inert; actual native filename wins and follow-up failure remains retryable');

  // Browser import is an import-only .json source: saving must create a new native
  // calendar file, never rename or overwrite the imported source capability.
  const sourceModel = { ...beforeSaveAsModel, title: '旧内部名称', notes: [{ id: 'name-kept-note', title: '保留的事项', content: '改名后正文仍保留 😀', date: '2026-11-05', color: '#3b82f6', type: '工作日', created_at: '2026-11-01T10:00:00.000Z' }] };
  const importedKey = await page.evaluate(async value => {
    const source = await window.__seedNameFile({ id: 'import-source', name: '原始导入.json', extension: 'json', kind: 'calendar', base64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))) });
    const app = document.querySelector('#app').__vue_app__._instance.setupState; let key;
    await app.task('测试导入', async () => { await app.openImportedDocument(source, source.id); key = app.activeKey; }); return key;
  }, sourceModel); await ready();
  assert.equal((await model(importedKey)).title, '原始导入'); const importBefore = (await evidence()).files['import-source'];
  await rename(importedKey, '导入后日历'); const importRenameCount = (await evidence()).renames.length; await save();
  assert.equal((await evidence()).renames.length, importRenameCount); assert.deepEqual((await evidence()).files['import-source'], importBefore); assert.notEqual((await state()).fileId, 'import-source');
  const importSaved = await state(), importedFile = await expectCleanStored(importedKey, stem(importSaved.name));
  assert.deepEqual(storedModel(importedFile).notes, sourceModel.notes); assert.deepEqual(storedModel(importedFile).history, sourceModel.history);
  pass('imported internal title adopts source filename and conversion never renames the source file');

  // Native autosave is driven by the production ten-second scheduler.
  await rename(importedKey, '自动保存改名'); const beforeAuto = await evidence(); await page.getByTestId('shell-autosave').click();
  await page.waitForFunction(() => { const app = document.querySelector('#app').__vue_app__._instance.setupState; return !app.active.dirty && !app.busy && window.__nameEvidence.files[app.active.fileId]?.name === '自动保存改名.oocalendar'; }, null, { timeout: 18000 });
  await expectCleanStored(importedKey, '自动保存改名'); assert.equal((await evidence()).renames.length, beforeAuto.renames.length + 1); await page.getByTestId('shell-autosave').click();
  pass('production autosave persists a pending name with the correct file identity');

  // Browser-only downloads cannot rename the original OS file.
  await page.evaluate(() => { window.__nameEvidence.native = false; }); const downloadKey = await create('calendar'); await rename(downloadKey, '浏览器下载标题');
  const downloadPending = page.waitForEvent('download'); await page.getByTestId('shell-save').click(); const download = await downloadPending;
  assert.equal(download.suggestedFilename(), '浏览器下载标题.oocalendar'); const downloadPath = await download.path(); assert.equal(JSON.parse(fs.readFileSync(downloadPath, 'utf8')).title, '浏览器下载标题'); await ready();
  pass('browser download name and serialized book title match');
  await page.screenshot({ path: path.join(output, 'document-names-structured.png') }); report.screenshots.push('document-names-structured.png');
}
async function rust(kind) {
  const key = await create(kind), initial = await state(), sessionId = (await call(key, 'inspect')).documentId;
  await rename(key, `统一标题 ${kind}`); assert.equal((await state()).name, `统一标题 ${kind}.${initial.extension}`); await save(); const saved = await expectCleanStored(key, `统一标题 ${kind}`);
  await rename(key, `重命名 ${kind}`); assert.equal((await state()).dirty, true); await save(); const renamed = await expectCleanStored(key, `重命名 ${kind}`);
  assert.equal(renamed.id, saved.id); assert.equal((await evidence()).renames.at(-1).expectedSha256, saved.sha256);
  await saveAs(`另存 ${kind}`); await page.getByTestId('save-format-dialog').waitFor({ state: 'hidden' }); const copied = await expectCleanStored(key, `另存 ${kind}`);
  assert.notEqual(copied.id, saved.id); assert.equal((await evidence()).files[saved.id].name, renamed.name);
  await rename(key, `另存后继续 ${kind}`); await save(); await expectCleanStored(key, `另存后继续 ${kind}`);
  assert.equal((await call(key, 'inspect')).documentId, sessionId, 'Renaming and saving keep the same live editor session');
  pass(`${kind}: tab rename, same-file save, Save As and continued rename retain live editor and filename`);
}
async function namingEdges() {
  const actualName = 'Cafe\u0301.OOCALENDAR';
  const key = await page.evaluate(async name => {
    const model = { format: 'open-office-calendar', version: 1, id: 'name-edge-calendar', title: '旧内部名称', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', notes: [], history: [] };
    const source = await window.__seedNameFile({ id: 'unicode-source', name, extension: 'oocalendar', kind: 'calendar', base64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(model)))) });
    const app = document.querySelector('#app').__vue_app__._instance.setupState; let key;
    await app.task('测试打开等价文件名', async () => { key = (await app.addDocument(source, source.id)).key; }); return key;
  }, actualName); await ready();
  assert.equal((await model(key)).title.normalize('NFC'), 'Café');
  await save(); assert.equal((await state()).dirty, false); assert.equal((await state()).name, actualName); assert.equal((await evidence()).renames.length, 0);
  await rename(key, 'Café'); await save();
  const saved = await state(), stored = (await evidence()).files[saved.fileId];
  assert.equal(saved.dirty, false); assert.equal(stored.name, actualName); assert.equal(storedModel(stored).title.normalize('NFC'), 'Café'); assert.equal((await evidence()).renames.length, 0);
  pass('NFD filename and uppercase extension remain saveable without a redundant rename');

  await rename(key, 'Café 改名'); await plan([], [{ name: 'Cafe\u0301 改名.oocalendar' }]); await save();
  const afterRename = await state(), renameCount = (await evidence()).renames.length;
  assert.equal(afterRename.dirty, false); assert.equal(stem((await evidence()).files[afterRename.fileId].name).normalize('NFC'), 'Café 改名');
  await save(); assert.equal((await state()).dirty, false); assert.equal((await evidence()).renames.length, renameCount);
  assert.equal(storedModel((await evidence()).files[afterRename.fileId]).title.normalize('NFC'), 'Café 改名');
  pass('native NFD rename receipt is retained and subsequent save does not repeat the move');

  const longTitle = 'L'.repeat(229), longName = `${longTitle}.oocalendar`;
  assert.equal(Buffer.byteLength(longName), 240, 'Fixture reaches the accepted native filename byte limit');
  const longKey = await page.evaluate(async name => {
    const model = { format: 'open-office-calendar', version: 1, id: 'long-name-calendar', title: '原有内部标题', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', history: [], notes: [{ id: 'long-name-note', title: '长文件名中的事项', content: '原始正文', date: '2026-11-05', color: '#3b82f6', type: '工作日', created_at: '2026-11-01T10:00:00.000Z' }] };
    const source = await window.__seedNameFile({ id: 'long-name-source', name, extension: 'oocalendar', kind: 'calendar', base64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(model)))) });
    const app = document.querySelector('#app').__vue_app__._instance.setupState; let key;
    await app.task('测试打开长文件名', async () => { key = (await app.addDocument(source, source.id)).key; }); return key;
  }, longName); await ready(); assert.equal((await model(longKey)).title, longTitle);
  await page.evaluate(async key => { const app = document.querySelector('#app').__vue_app__._instance.setupState; await app.handleFor(app.tabs.find(tab => tab.key === key)).mcpExecute('calendar_edit', { operations: [{ op: 'note.update', noteId: 'long-name-note', patch: { content: '长名称下修改并保存的正文 😀' } }] }, () => {}); }, longKey);
  await frames(); await save(); const longFile = await expectCleanStored(longKey, longTitle); assert.equal(storedModel(longFile).notes[0].content, '长名称下修改并保存的正文 😀');
  const longTab = (await tabButton(longKey)).locator('..'); await longTab.locator('.tab-close').click();
  await page.waitForFunction(key => !document.querySelector('#app').__vue_app__._instance.setupState.tabs.some(tab => tab.key === key), longKey);
  await page.evaluate(id => { const app = document.querySelector('#app').__vue_app__._instance.setupState; app.openRecent({ id }); }, longFile.id); await ready();
  const reopened = await state(); assert.notEqual(reopened.key, longKey); assert.equal(reopened.fileId, longFile.id); assert.equal(reopened.name, longName); assert.equal((await model(reopened.key)).title, longTitle); assert.equal((await model(reopened.key)).notes[0].content, '长名称下修改并保存的正文 😀');
  pass('229-character existing filename opens, edits, saves and reopens with its full project title');
}
async function runGroup(group) {
  report.stage = group; persist();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN', acceptDownloads: true, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('open-office-autosave', 'false'));
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/src/native.ts') return route.fulfill({ contentType: 'application/javascript', body: nativeStub });
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      const match = url.pathname.match(/(?:master\/|master@|@master\/)(\d{4})\.json$/);
      if (match && ['raw.githubusercontent.com', 'cdn.jsdelivr.net'].includes(url.hostname)) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }, body: JSON.stringify({ year: Number(match[1]), papers: [], days: [] }) });
      return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (group === 'structured') await structured(); else if (group === 'naming-edges') await namingEdges(); else await rust(group);
  } catch (error) {
    if (page) { const file = `${group}-failure.png`; await page.screenshot({ path: path.join(output, file) }).catch(() => {}); report.screenshots.push(file); }
    throw error;
  } finally { await browser?.close(); browser = undefined; page = undefined; persist(); }
}
(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: process.env.OFFICE_DOCUMENT_NAMES_CACHE || path.join(output, 'vite-cache'), optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen(); for (const group of groups) await runGroup(group);
    report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Production source changed while browser verification was running'); assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.failure = error.stack || String(error); console.error(error); process.exitCode = 1; }
  finally { persist(); await browser?.close(); await server?.close(); console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, report: path.join(output, 'report.json') })); }
})();
