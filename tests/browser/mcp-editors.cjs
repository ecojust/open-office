/* Actual seven-editor MCP integration in Chromium.
 * Commands travel through the production Rust HTTP server and App dispatcher;
 * independent engine queries, rendered content and exported documents verify the
 * effects. A stdio bridge replaces Tauri IPC only. No editor, document model or
 * network server is mocked. Installed WebViews require their separate checks.
 * Run: node tests/browser/mcp-editors.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const net = require('node:net');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_MCP_OUTPUT || path.join(root, 'test-results/mcp-editors'));
const kinds = ['word', 'sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram'];
const requestedKinds = process.env.OFFICE_MCP_KINDS?.split(',').map(value => value.trim());
if (requestedKinds?.some(kind => !kinds.includes(kind))) throw Error('OFFICE_MCP_KINDS contains an unknown editor kind');
const testedKinds = requestedKinds || kinds;
const handleNames = { word: 'rustWordHandles', sheet: 'rustSheetHandles', presentation: 'rustPresentationHandles', pdf: 'rustPdfHandles', note: 'noteHandles', canvas: 'workflowHandles', diagram: 'workflowHandles' };
const canvasIds = { word: 'office-word-canvas', sheet: 'office-sheet-canvas', presentation: 'office-presentation-canvas', pdf: 'pdf-canvas' };
const sourceFiles = ['src/App.vue', 'src/style.css', 'src/shared/document.ts', 'src/mcp/config.ts', 'src/mcp/service.ts', 'src/mcp/native.ts', 'src/mcp/document-tools.ts',
  'src/mcp/tool-schema.ts', 'src/mcp/word-tools.ts', 'src/mcp/sheet-tools.ts', 'src/mcp/presentation-tools.ts', 'src/mcp/pdf-tools.ts', 'src/mcp/notes-workflow-tools.ts',
  'src/components/McpSettingsDialog.vue', 'src/components/NotebookEditor.vue', 'src/components/WorkflowEditor.vue',
  'src/notes/mcp.ts', 'src/workflow/mcp.ts',
  'src-tauri/src/mcp.rs', 'src-tauri/src/mcp_commands.rs',
  ...['Word', 'Sheet', 'Presentation', 'Pdf'].map(name => `src/components/Rust${name}Editor.vue`),
  ...['word', 'sheet', 'presentation', 'pdf'].map(name => `src/${name}/rust/client.ts`),
  ...['word', 'sheet', 'presentation', 'pdf'].flatMap(name => [`public/office-${name}/manifest.json`, `public/office-${name}/office${name === 'pdf' ? '_' : '-'}${name}_bg.wasm`])];
const report = { ok: false, startedAtUtc: new Date().toISOString(),
  testedKinds, completeSuite: testedKinds.length === kinds.length && kinds.every(kind => testedKinds.includes(kind)),
  runtime: 'Production Rust MCP HTTP server → stdio bridge replacing Tauri IPC → actual Vue App dispatcher and seven real editors in Chromium',
  checks: [], operations: [], commandCatalogCounts: {}, visualUpdates: [], files: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [],
  limitations: ['The production Rust HTTP server runs on Linux and talks to Chromium through a stdio bridge replacing Tauri IPC; installed macOS/Windows WebViews and native IPC are separate checks.',
    'MCP edits are intentionally programmatic, as external client tools are; browser input is used for the shell, settings and undo controls.',
    'Screenshots cover browser rendering, not platform-specific installed WebView rendering.'] };
let server, browser, page, origin, kind, harness, harnessSequence = 0, rpcSequence = 0, endpoint, protocolSession, token;
const pendingHarness = new Map();
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inlinePng = (() => {
  const png = new PNG({ width: 32, height: 32 });
  for (let pixel = 0; pixel < 32 * 32; pixel++) png.data.set([40, 140, 190, 255], pixel * 4);
  return PNG.sync.write(png).toString('base64');
})();
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(path.join(root, file))]));
const phase = value => { report.phase = value; console.log('PHASE', value); persist(); };
const pass = value => { report.checks.push(value); console.log('PASS', value); persist(); };
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function poll(read, accept, description, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    let timer;
    try {
      last = await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(description + ' timed out')), deadline - Date.now()); })]);
      if (accept(last)) return last;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  fs.writeFileSync(path.join(output, 'last-state.json'), JSON.stringify({ description, last }, null, 2));
  throw Error(description + ' timed out');
}
async function active() {
  return page.evaluate(() => { const app = document.querySelector('#app').__vue_app__._instance.setupState;
    return { key: app.activeKey, name: app.active?.document.name, kind: app.active?.document.kind, ready: app.active?.ready, dirty: app.active?.dirty, busy: app.busy, error: app.active?.loadError }; });
}
async function ready() {
  await poll(active, value => { if (value.error) throw Error(value.error); return value.ready && value.kind === kind && !value.busy; }, kind + ' actual editor readiness');
  if (canvasIds[kind]) await page.getByTestId(canvasIds[kind]).waitFor();
  await frame();
}
async function call(method, ...args) {
  return page.evaluate(async ({ handleName, method, args }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const handle = app[handleName].get(app.activeKey);
    if (!handle || typeof handle[method] !== 'function') throw Error('Missing actual editor method: ' + handleName + '.' + method);
    return await handle[method](...args);
  }, { handleName: handleNames[kind], method, args });
}
async function mcp(tool, arguments_ = {}) {
  const before = await call('inspect');
  const response = await rpc('tools/call', { name: tool, arguments: arguments_ });
  assert.equal(response.error, undefined, 'MCP JSON-RPC call succeeds');
  assert.notEqual(response.result?.isError, true, response.result?.content?.map(item => item.text).join('\n'));
  const result = JSON.parse(response.result.content.find(item => item.type === 'text').text);
  const after = await call('inspect');
  report.operations.push({ kind, tool, before: { documentId: before.documentId, revision: before.revision }, after: { documentId: after.documentId, revision: after.revision }, result });
  persist(); return result;
}
async function exported(stem = kind + '-mcp') {
  const receipt = await call('exportFile');
  const file = path.join(output, stem + '.' + receipt.extension);
  fs.writeFileSync(file, Buffer.from(receipt.base64, 'base64'));
  report.files.push({ path: path.relative(root, file), bytes: fs.statSync(file).size, sha256: sha(file), revision: receipt.revision });
  persist(); return { receipt, file, bytes: fs.readFileSync(file) };
}
function packageText(bytes, filePattern) {
  const entries = unzipSync(bytes);
  return Object.entries(entries).filter(([name]) => filePattern.test(name)).map(([, bytes]) => strFromU8(bytes)).join('\n');
}
async function historyRoundTrip(read, before, after) {
  await page.getByTestId('global-toolbar').getByRole('button', { name: '撤销', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#app').__vue_app__._instance.setupState.globalActionsBlocked);
  await poll(read, value => JSON.stringify(value) === JSON.stringify(before), kind + ' MCP edit can be undone through the actual shell');
  await page.getByTestId('global-toolbar').getByRole('button', { name: '重做', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#app').__vue_app__._instance.setupState.globalActionsBlocked);
  await poll(read, value => JSON.stringify(value) === JSON.stringify(after), kind + ' MCP edit can be redone through the actual shell');
  await mcp('document_undo');
  assert.deepEqual(await read(), before, 'MCP Undo targets the same actual document history');
  await mcp('document_redo');
  assert.deepEqual(await read(), after, 'MCP Redo restores actual edited content');
}
async function capture(name) {
  await frame(); const file = path.join(output, name + '.png');
  await page.screenshot({ path: file });
  report.screenshots.push({ file: path.relative(root, file), sha256: sha(file) }); persist();
}
// A document query alone cannot prove that a canvas repaint happened. Compare
// the actual rendered pixels around a second edit, without clicking the canvas
// or navigating away and back to incidentally trigger a repaint.
async function visibleCanvasChange(label, edit) {
  const canvas = page.getByTestId(canvasIds[kind]);
  await frame();
  const before = await canvas.screenshot({ animations: 'disabled' });
  const beforeImage = PNG.sync.read(before);
  const result = await edit();
  let after, changedPixels = 0;
  await poll(async () => {
    await frame(); after = await canvas.screenshot({ animations: 'disabled' });
    const afterImage = PNG.sync.read(after);
    assert.equal(afterImage.width, beforeImage.width); assert.equal(afterImage.height, beforeImage.height);
    changedPixels = 0;
    // Ignore the top ribbon: it can update even when the document viewport
    // accidentally retains its old texture. Ignore tiny antialiasing noise.
    const firstRow = Math.min(180, Math.floor(beforeImage.height / 4));
    for (let pixel = firstRow * beforeImage.width; pixel < beforeImage.width * beforeImage.height; pixel++) {
      const offset = pixel * 4;
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(beforeImage.data[offset + channel] - afterImage.data[offset + channel]))) > 24) changedPixels++;
    }
    return changedPixels;
  }, value => value >= 150, `${kind} ${label}: MCP changes visible document pixels without user input`, 10000);
  for (const [suffix, bytes] of [['before', before], ['after', after]]) {
    const file = path.join(output, `${kind}-${label}-${suffix}.png`); fs.writeFileSync(file, bytes);
    report.screenshots.push({ file: path.relative(root, file), sha256: sha(file) });
  }
  report.visualUpdates.push({ kind, label, changedPixels }); persist(); return result;
}
async function rejectedTool(name, args) {
  const before = await call('inspect');
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(response.error || response.result?.isError, `${name} rejects unsupported or unsafe commands`);
  assert.equal((await call('inspect')).revision, before.revision, 'Rejected command must not change document revision');
  report.operations.push({ kind, tool: name, rejected: true }); persist();
}
async function passiveReadCheck() {
  const before = await call('inspect');
  const focus = page.getByTestId(canvasIds[kind] || (kind === 'diagram' ? 'diagram-source' : kind === 'note' ? 'notebook-content' : 'canvas-stage')).first();
  await focus.focus();
  await page.evaluate(() => { window.__mcpFocusBeforeRead = document.activeElement; });
  await mcp('document_inspect');
  assert.equal(await page.evaluate(() => document.activeElement === window.__mcpFocusBeforeRead), true, 'Read-only MCP inspection preserves actual document focus');
  assert.equal((await call('inspect')).revision, before.revision, 'Read-only MCP inspection does not add history');
}
async function assertMcpPlacement() {
  const settings = page.getByTestId('mcp-settings'), toolbar = page.getByTestId('global-toolbar');
  assert.equal(await settings.isVisible(), true, 'Global MCP settings is visible');
  assert.equal(await toolbar.getByTestId('mcp-settings').count(), 0, 'Global MCP settings belongs to the sidebar');
  assert.equal(await toolbar.getByTestId('document-mcp-toggle').count(), 0, 'Document MCP start belongs to the editor, not the shared file toolbar');
  const toggle = page.getByTestId('document-mcp-toggle');
  assert.equal(await toggle.isVisible(), true, 'Current editor exposes one MCP service control');
  assert.equal(await toggle.count(), 1, 'Inactive editors do not duplicate the current document MCP control');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'Browser never pretends to run the desktop HTTP service');
  assert.match(await toggle.getAttribute('title'), /桌面/, 'Browser explains where the actual service is available');
  assert.equal(await toggle.locator('.mcp-running-dot').count(), 0);
  const box = await settings.boundingBox(), view = page.viewportSize();
  assert.ok(box.x >= 0 && box.x < 80 && box.y > view.height / 2 && box.y + box.height <= view.height + 1, 'MCP settings remains at the lower left');
  assert.equal(await settings.locator('svg').count(), 1, 'MCP settings uses a shared-style SVG icon');
}

async function settingsChecks() {
  const trigger = page.getByTestId('mcp-settings');
  await trigger.click();
  const dialog = page.getByTestId('mcp-settings-dialog'); await dialog.waitFor();
  assert.ok((await dialog.textContent()).includes('MCP 服务需要在桌面版中开启。'));
  assert.equal(await page.getByTestId('mcp-allow-edits').isChecked(), true, 'New global configuration exposes editing by default');
  assert.equal(await page.getByTestId('mcp-token').getAttribute('type'), 'password');
  const secret = await page.getByTestId('mcp-token').inputValue();
  assert.match(secret, /^[A-Za-z0-9_-]{32,128}$/);
  assert.ok(!(await page.getByTestId('mcp-client-config').textContent()).includes(secret), 'Client preview masks the secret');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Settings takes focus');
  await page.getByTestId('mcp-settings-save').focus(); await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab is trapped inside settings');
  await page.getByTestId('mcp-port').fill('80'); await page.getByTestId('mcp-settings-save').click();
  assert.ok((await dialog.getByRole('alert').textContent()).includes('1024'));
  await page.getByTestId('mcp-port').fill('19781');
  await capture('mcp-settings-light');
  await page.getByTestId('mcp-settings-save').click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'Settings restores trigger focus');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('open-office.mcp-config')));
  assert.equal(persisted.port, 19781); assert.equal(persisted.allowEdits, true);
  await page.getByTestId('theme-dark').click();
  await trigger.click(); await dialog.waitFor(); await capture('mcp-settings-dark');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 900, height: 640 });
  await trigger.click(); await dialog.waitFor();
  const geometry = await dialog.evaluate(element => { const box = element.getBoundingClientRect(); const backdrop = element.parentElement;
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, blur: getComputedStyle(backdrop).backdropFilter, rootScroll: document.documentElement.scrollWidth }; });
  assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1, 'Settings fits minimum supported viewport');
  assert.match(geometry.blur, /blur/); assert.ok(geometry.rootScroll <= geometry.width);
  await page.getByTestId('mcp-settings-save').scrollIntoViewIfNeeded(); await capture('mcp-settings-dark-900x640');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.getByTestId('theme-light').click(); await page.setViewportSize({ width: 1440, height: 1000 });
  pass('Global MCP settings: private preview, validation, persisted defaults, focus trap, frosted light/dark and minimum viewport');
}

const editorChecks = {};

editorChecks.word = async () => {
  const read = async () => (await call('inspect')).text;
  const before = await read();
  const text = 'MCP_WORD_实际文档编辑_2026';
  await mcp('word_insert_text', { text });
  assert.ok((await read()).includes(text));
  assert.ok(JSON.stringify(await mcp('word_read')).includes(text));
  const after = await read(); await historyRoundTrip(read, before, after);
  const file = await exported(); assert.ok(packageText(file.bytes, /^word\/document\.xml$/).includes(text));
};
editorChecks.sheet = async () => {
  const read = () => page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const snapshot = await app.rustSheetHandles.get(app.activeKey).inspect();
    return (await import('/src/sheet/rust/client.ts')).queryOfficeSheetSession(snapshot.sessionId, 'cell.get', { cell: 'B2' });
  });
  await mcp('sheet_set_cell', { cell: 'A1', input: '41' });
  const before = await read();
  await mcp('sheet_set_cell', { cell: 'B2', input: '=A1+1' });
  const after = await read(); assert.equal(after.value, 42);
  assert.ok(JSON.stringify(await mcp('sheet_read_range', { range: 'A1:B2' })).includes('42'));
  await historyRoundTrip(read, before, after);
  const file = await exported(); assert.match(packageText(file.bytes, /^xl\/worksheets\/sheet\d+\.xml$/), /A1\+1/);
};
editorChecks.presentation = async () => {
  const read = async () => (await call('inspect')).slides.length;
  const before = await read(); assert.equal(before, 3);
  const title = 'MCP_PRESENTATION_新幻灯片';
  await mcp('presentation_add_slide', { title, body: 'Real Rust presentation edit through HTTP' });
  assert.equal(await read(), before + 1);
  assert.ok(JSON.stringify(await mcp('presentation_read_slide')).includes(title));
  await historyRoundTrip(read, before, before + 1);
  const file = await exported(); assert.ok(packageText(file.bytes, /^ppt\/slides\/slide\d+\.xml$/).includes(title));
};
editorChecks.pdf = async () => {
  const read = async () => (await call('query', 'document.inspect')).texts.join('\n');
  const before = await read(), text = 'MCP_PDF_REAL_HTTP_EDIT';
  await mcp('pdf_add_text', { text, page: 0, x: 42, y: 72, width: 330, height: 60, size: 18 });
  const after = await read(); assert.ok(after.includes(text));
  assert.ok(JSON.stringify(await mcp('pdf_read')).includes(text));
  await historyRoundTrip(read, before, after);
  const file = await exported();
  const verified = await page.evaluate(async base64 => (await import('/src/pdf/rust/client.ts')).inspectPdfBytes(base64), file.receipt.base64);
  assert.ok(verified.texts.join('\n').includes(text));
};
editorChecks.note = async () => {
  await mcp('note_add_page', { title: 'MCP 笔记页面', text: 'MCP_NOTE_PAGE' });
  const read = () => page.getByTestId('notebook-content').allTextContents();
  const before = await read(), text = 'MCP_NOTE_REGION_独立排版';
  await mcp('note_add_text', { text, x: 300, y: 180, width: 320 });
  await poll(read, value => value.join('\n').includes(text), 'MCP note region renders in actual editor');
  const after = await read(); assert.ok(JSON.stringify(await mcp('note_read')).includes(text));
  await historyRoundTrip(read, before, after);
  const model = JSON.parse((await exported()).bytes.toString('utf8'));
  const notePage = model.sections.flatMap(section => section.pages).find(page => page.title === 'MCP 笔记页面');
  const region = notePage.regions.find(region => JSON.stringify(region.blocks).includes(text));
  assert.equal(region.x, 300); assert.equal(region.y, 180); assert.equal(region.width, 320);
};
editorChecks.canvas = async () => {
  const read = async () => (await call('inspectModel')).scene.elements;
  const before = await read(), text = 'MCP_CANVAS_矩形';
  await mcp('canvas_add_shape', { shape: 'rectangle', text, x: 120, y: 90, width: 220, height: 120 });
  const after = await read(); assert.equal(after.length, before.length + 1); assert.equal(after.at(-1).text, text);
  assert.ok(JSON.stringify(await mcp('canvas_read')).includes(text));
  await historyRoundTrip(read, before, after);
  assert.ok((await page.getByTestId('canvas-stage').textContent()).includes(text));
  const model = JSON.parse((await exported()).bytes.toString('utf8'));
  assert.equal(model.scene.elements.at(-1).text, text);
};
editorChecks.diagram = async () => {
  const source = page.getByTestId('diagram-source'), before = await source.inputValue();
  const after = 'sequenceDiagram\n  participant A as MCPClient\n  participant B as Document\n  A->>B: MCP_DIAGRAM_REAL_HTTP\n  B-->>A: Saved';
  await mcp('diagram_set_source', { source: after });
  assert.equal(await source.inputValue(), after); assert.ok(JSON.stringify(await mcp('diagram_read_source')).includes('MCP_DIAGRAM_REAL_HTTP'));
  await poll(() => page.getByTestId('diagram-preview').textContent(), value => value.includes('MCP_DIAGRAM_REAL_HTTP'), 'MCP source update redraws actual SVG diagram');
  await historyRoundTrip(() => source.inputValue(), before, after);
  const model = JSON.parse((await exported()).bytes.toString('utf8')); assert.equal(model.source, after);
};

const editingChecks = {};
editingChecks.word = async () => {
  report.commandCatalogCounts.word = (await mcp('word_list_commands', { limit: 1 })).total;
  const catalog = await mcp('word_list_commands', { search: 'format', limit: 100 });
  assert.ok(JSON.stringify(catalog).includes('format.set'), 'Word formatting commands are discoverable');
  await rejectedTool('word_query', { command: 'text.insert', params: { text: 'READ_ONLY_MUST_NOT_EDIT' } });
  await rejectedTool('word_execute_command', { command: 'insert.picture' });
  await rejectedTool('word_execute_command', { command: 'edit.goto', params: { page: null } });
  await rejectedTool('word_execute_command', { command: 'insert.link', params: { heading: null } });
  const text = 'MCP_WORD_实际文档编辑_2026';
  await mcp('word_select_text', { text });
  const readBlocks = async () => (await mcp('word_inspect_document', { text: true })).blocks;
  const beforeBlocks = await readBlocks();
  await visibleCanvasChange('format-live', () => mcp('word_execute_command', {
    command: 'format.set', params: { props: { bold: true, size: 22, color: 'D52B3F' } },
  }));
  const structure = await mcp('word_inspect_document', { text: true });
  const formattedRun = structure.blocks.flatMap(block => block.runs || []).find(run => run.props.bold && run.props.size === 22);
  assert.deepEqual(formattedRun?.props.color, { Rgb: [213, 43, 63] }, 'Word structural query exposes edited run formatting');
  await historyRoundTrip(readBlocks, beforeBlocks, structure.blocks);
  for (const command of ['review.compare', 'review.combine']) {
    const original = await readBlocks();
    await mcp('word_execute_command', { command, params: { text: text + '\nMCP reviewed addition', showIn: 'original', author: 'MCP Reviewer' } });
    const revisionFile = await exported('word-' + command.split('.')[1] + '-revision');
    const revisionXml = packageText(revisionFile.bytes, /^word\/document\.xml$/);
    assert.match(revisionXml, /<w:(?:ins|del)[ >]/, command + ' creates actual document revisions');
    assert.ok(revisionXml.includes('MCP Reviewer'));
    await mcp('document_undo');
    assert.deepEqual(await readBlocks(), original, command + ' is a single reversible current-document change');
  }
  const privacyBefore = await mcp('word_query', { command: 'file.privacy' });
  await mcp('word_execute_command', { command: 'file.privacyOptions', params: { removePersonalInfo: true } });
  assert.equal((await mcp('word_query', { command: 'file.privacy' })).removePersonalInfo, true);
  await mcp('document_undo');
  assert.deepEqual(await mcp('word_query', { command: 'file.privacy' }), privacyBefore);
  await mcp('word_execute_command', { command: 'para.alignCenter' });
  await mcp('word_execute_command', { command: 'layout.margins', params: { preset: 'narrow' } });
  await mcp('word_select_range', { anchor: { block: 0, off: 0 }, focus: { block: 0, off: 0 } });
  await mcp('word_execute_command', { command: 'insert.table', params: { rows: 2, cols: 3 } });
  assert.ok((await mcp('word_inspect_document', { text: true })).blocks.some(block => block.type === 'table' && block.rows === 2 && block.cols === 3));
  await mcp('word_execute_command', { command: 'insert.picture', params: { data: inlinePng, width: 60, alt: 'MCP inline image' } });
  await rejectedTool('word_execute_command', { command: 'file.open', params: { path: '/tmp/should-never-open.docx' } });
  const file = await exported('word-mcp-full-editing');
  const document = packageText(file.bytes, /^word\/document\.xml$/);
  assert.ok(document.includes(text)); assert.match(document, /D52B3F/i); assert.match(document, /<w:tbl[ >]/);
  assert.ok(Object.keys(unzipSync(file.bytes)).some(name => /^word\/media\//.test(name)), 'MCP image bytes are embedded in DOCX');
};
editingChecks.sheet = async () => {
  report.commandCatalogCounts.sheet = (await mcp('sheet_list_commands', { limit: 1 })).total;
  const catalog = await mcp('sheet_list_commands', { search: 'home.', limit: 100 });
  assert.ok(JSON.stringify(catalog).includes('home.fillColor'), 'Sheet range formatting is discoverable');
  await rejectedTool('sheet_query', { command: 'range.setValues', params: { range: 'A1', values: [['READ_ONLY_MUST_NOT_EDIT']] } });
  await rejectedTool('sheet_execute_command', { command: 'insert.picture' });
  await mcp('sheet_write_range', { range: 'A5:B7', values: [['月份', '收入'], ['一月', 10], ['二月', 20]] });
  assert.equal((await call('query', 'cell.get', { cell: 'B7' })).value, 20);
  const readCell = () => call('query', 'cell.get', { cell: 'A5' });
  const beforeCell = await readCell();
  await visibleCanvasChange('range-format-live', () => mcp('sheet_execute_command', {
    command: 'home.fillColor', params: { range: 'A5:B7', color: '#DBEAFE' },
  }));
  await historyRoundTrip(readCell, beforeCell, await readCell());
  await mcp('sheet_execute_command', { command: 'home.bold', params: { range: 'A5:B5', on: true } });
  const formattedCell = await mcp('sheet_query', { command: 'cell.get', params: { cell: 'A5' } });
  assert.deepEqual(formattedCell.style.fill.fg, { Rgb: 0xDBEAFE });
  assert.equal(formattedCell.style.font.bold, true);
  await mcp('sheet_execute_command', { command: 'insert.chart', params: { range: 'A5:B7', type: 'column', title: 'MCP图表', at: 'D5' } });
  assert.ok(JSON.stringify(await mcp('sheet_query', { command: 'document.inspect' })).includes('MCP图表'));
  const beforeSheets = (await call('inspect')).sheets.length;
  await mcp('sheet_execute_command', { command: 'home.insertSheet', params: { name: 'MCP数据' } });
  assert.equal((await call('inspect')).sheets.length, beforeSheets + 1);
  await mcp('sheet_execute_command', { command: 'sheet.activate', params: { sheet: 0 } });
  await mcp('sheet_execute_command', { command: 'insert.picture', params: { base64: inlinePng, at: 'D15', alt: 'MCP inline image' } });
  await rejectedTool('sheet_execute_command', { command: 'file.open', params: { path: '/tmp/should-never-open.xlsx' } });
  const file = await exported('sheet-mcp-full-editing');
  assert.ok(packageText(file.bytes, /^xl\/workbook\.xml$/).includes('MCP数据'));
  assert.match(packageText(file.bytes, /^xl\/styles\.xml$/), /DBEAFE/i);
  assert.ok(packageText(file.bytes, /^xl\/charts\/chart\d+\.xml$/).includes('MCP图表'));
  assert.ok(Object.keys(unzipSync(file.bytes)).some(name => /^xl\/media\//.test(name)), 'MCP image bytes are embedded in XLSX');
};
editingChecks.presentation = async () => {
  const catalog = await mcp('presentation_list_commands');
  report.commandCatalogCounts.presentation = catalog.commands.length;
  assert.ok(JSON.stringify(catalog).includes('shape.insert'));
  await rejectedTool('presentation_query', { command: 'text.set', params: { text: 'READ_ONLY_MUST_NOT_EDIT' } });
  await rejectedTool('presentation_query', { command: 'text.compose', params: { text: 'READ_ONLY_MUST_NOT_COMPOSE' } });
  await rejectedTool('presentation_execute_command', { command: 'format.fontDialog' });
  await mcp('presentation_execute_command', { command: 'slide.go', params: { index: 0 } });
  await mcp('presentation_execute_command', { command: 'shape.insert', params: { preset: 'rect', rect: [80, 100, 220, 100], text: 'MCP_SHAPE_ORIGINAL' } });
  const readSlide = () => call('query', 'slide.inspect', { index: 0 });
  const shape = (await readSlide()).shapes.find(shape => shape.text === 'MCP_SHAPE_ORIGINAL');
  assert.ok(shape?.id, 'New presentation shape has a discoverable ID');
  await visibleCanvasChange('existing-text-live', () => mcp('presentation_execute_command', {
    command: 'text.set', params: { id: shape.id, text: 'MCP_SHAPE_UPDATED' },
  }));
  assert.equal((await readSlide()).shapes.find(item => item.id === shape.id).text, 'MCP_SHAPE_UPDATED');
  await mcp('presentation_execute_command', { command: 'selection.select', params: { id: shape.id } });
  await mcp('presentation_execute_command', { command: 'shape.move', params: { id: shape.id, dx: 80, dy: 30 } });
  await mcp('presentation_execute_command', { command: 'insert.picture', params: { data: inlinePng, name: 'inline.png', rect: [420, 90, 96, 96] } });
  const freeform = (await mcp('presentation_execute_command', { command: 'shape.freeform', params: {
    points: [[10, 10], [100, 10], [100, 80], [10, 80]], closed: true,
  } })).result.id;
  const readPoints = () => mcp('presentation_query', { command: 'shape.points', params: { id: freeform } });
  const pointsBefore = await readPoints();
  await mcp('presentation_execute_command', { command: 'shape.movePoint', params: { id: freeform, path: 0, index: 1, x: 120, y: 10 } });
  assert.notDeepEqual(await readPoints(), pointsBefore, 'Shape subpath indices remain editable through MCP');
  const before = (await call('inspect')).slides.length;
  await mcp('presentation_execute_command', { command: 'slide.duplicate' });
  assert.equal((await call('inspect')).slides.length, before + 1);
  await mcp('presentation_execute_command', { command: 'slide.delete' });
  assert.equal((await call('inspect')).slides.length, before);
  const templates = (await mcp('presentation_list_templates')).templates;
  assert.ok(templates.length >= 100, 'MCP can discover the application presentation template library');
  const readSlides = async () => (await call('inspect')).slides;
  const originalSlides = await readSlides();
  await visibleCanvasChange('template-live', () => mcp('presentation_apply_template', { id: templates[0].id }));
  assert.equal((await readSlides()).length, 3, 'Applying a built-in template replaces the actual presentation');
  await historyRoundTrip(readSlides, originalSlides, await readSlides());
  await mcp('document_undo');
  await rejectedTool('presentation_execute_command', { command: 'file.open', params: { path: '/tmp/should-never-open.pptx' } });
  const file = await exported('presentation-mcp-full-editing');
  assert.ok(packageText(file.bytes, /^ppt\/slides\/slide\d+\.xml$/).includes('MCP_SHAPE_UPDATED'));
};
editingChecks.pdf = async () => {
  const catalog = await mcp('pdf_list_commands');
  report.commandCatalogCounts.pdf = catalog.commands.length;
  assert.ok(JSON.stringify(catalog).includes('content_update'), 'PDF existing content editing is discoverable');
  await rejectedTool('pdf_query', { command: 'content_update', params: { page: 1, index: 1, text: 'READ_ONLY_MUST_NOT_EDIT' } });
  await rejectedTool('pdf_execute_command', { command: 'page_add_text' });
  const read = async () => (await mcp('pdf_query', { command: 'content_list' })).result.items;
  const item = (await read()).find(item => item.text === 'MCP_PDF_REAL_HTTP_EDIT');
  assert.ok(item, 'PDF query identifies previously added text and its page/index');
  await visibleCanvasChange('existing-text-live', () => mcp('pdf_execute_command', {
    command: 'content_update', params: { page: item.page, index: item.index, text: 'MCP_PDF_UPDATED_TEXT', color: '#ff0000', size: 24, rect: [42, 120, 500, 200] },
  }));
  assert.ok((await read()).some(item => item.text === 'MCP_PDF_UPDATED_TEXT' && item.size === 24));
  await mcp('pdf_execute_command', { command: 'comment_add', params: {
    page: 1, type: 'stamp', at: [220, 220], stamp: 'approved', dynamic: true, author: 'Open Office QA',
  } });
  assert.ok(JSON.stringify(await mcp('pdf_query', { command: 'comment_list' })).includes('Open Office QA'));
  await mcp('pdf_execute_command', { command: 'fill_sign_add', params: {
    page: 1, type: 'signature', at: [80, 300], text: 'Open Office',
  } });
  await mcp('pdf_execute_command', { command: 'page_add_image', params: { page: 1, path: 'inline.png', rect: [80, 350, 144, 414] }, assets: { 'inline.png': inlinePng } });
  assert.ok((await read()).some(item => item.type === 'image'), 'PDF image insertion consumes embedded assets without filesystem access');
  const beforePages = (await call('inspect')).pageCount;
  await mcp('pdf_execute_command', { command: 'page_insert_blank', params: { at: 2 } });
  assert.equal((await call('inspect')).pageCount, beforePages + 1);
  await rejectedTool('pdf_execute_command', { command: 'doc_open', params: { path: '/tmp/should-never-open.pdf' } });
  const file = await exported('pdf-mcp-full-editing');
  const verified = await page.evaluate(async base64 => (await import('/src/pdf/rust/client.ts')).inspectPdfBytes(base64), file.receipt.base64);
  assert.ok(verified.texts.join('\n').includes('MCP_PDF_UPDATED_TEXT'));
};
editingChecks.note = async () => {
  await mcp('note_edit', { operations: [
    { op: 'section.add', id: 'mcp_section', title: 'MCP分区' },
    { op: 'page.add', sectionId: 'mcp_section', id: 'mcp_page', title: 'MCP页面' },
    { op: 'page.add', sectionId: 'mcp_section', id: 'mcp_child', parentId: 'mcp_page', title: 'MCP子页面' },
    { op: 'region.add', pageId: 'mcp_child', region: { id: 'mcp_region', x: 100, y: 140, width: 360,
      blocks: [{ id: 'mcp_block', type: 'heading', level: 2, content: [{ text: 'MCP动态标题', marks: ['bold'] }] }] } },
    { op: 'region.add', pageId: 'mcp_child', region: { id: 'mcp_image_region', x: 600, y: 140, width: 200, height: 200,
      blocks: [{ id: 'mcp_image', type: 'image', dataUrl: 'data:image/png;base64,' + inlinePng, alt: 'MCP内嵌图片' }] } },
  ], selectPageId: 'mcp_child' });
  assert.ok((await page.getByTestId('notebook-content').allTextContents()).join('\n').includes('MCP动态标题'));
  await poll(() => page.getByAltText('MCP内嵌图片').evaluate(image => image.complete && image.naturalWidth === 32), Boolean, 'MCP notebook embedded image renders in the actual page');
  const readContent = () => page.getByTestId('notebook-content').allTextContents();
  const beforeContent = await readContent();
  await mcp('note_edit', { operations: [{ op: 'region.update', regionId: 'mcp_region', patch: {
    x: 220, y: 180, width: 500,
    blocks: [{ id: 'mcp_block', type: 'todo', checked: true, content: [{ text: 'MCP修改后待办' }] }],
  } }] });
  await poll(() => page.getByTestId('notebook-content').allTextContents(), value => value.join('\n').includes('MCP修改后待办'), 'MCP notebook block edit is rendered immediately');
  await historyRoundTrip(readContent, beforeContent, await readContent());
  const model = await mcp('note_read');
  const child = model.sections.find(section => section.id === 'mcp_section').pages.find(page => page.id === 'mcp_child');
  assert.equal(child.parentId, 'mcp_page');
  const region = child.regions.find(region => region.id === 'mcp_region');
  assert.equal(region.width, 500); assert.equal(region.x, 220); assert.equal(region.blocks[0].checked, true);
  await rejectedTool('note_edit', { operations: [{ op: 'section.add', id: 'rejected_section', title: 'MUST_NOT_APPEAR' }, { op: 'region.update', regionId: 'missing-region', patch: { x: 20 } }] });
  assert.ok(!(await mcp('note_read')).sections.some(section => section.id === 'rejected_section'), 'Failed notebook batch rolls back earlier operations');
  const saved = JSON.parse((await exported('note-mcp-full-editing')).bytes.toString('utf8'));
  assert.ok(JSON.stringify(saved).includes('MCP修改后待办'));
};
editingChecks.canvas = async () => {
  await mcp('canvas_edit', { operations: [{ op: 'add', element: { id: 'mcp_node', type: 'shape', shape: 'rectangle', x: 40, y: 40,
    width: 200, height: 100, text: 'MCP图形', style: { fill: '#aaddff' } } }] });
  const readElements = async () => (await call('inspectModel')).scene.elements;
  const beforeElements = await readElements();
  await mcp('canvas_edit', { operations: [{ op: 'update', id: 'mcp_node', patch: {
    text: 'MCP修改后图形', cornerRadius: 20, width: 280, style: { fill: '#fddc88' },
  } }, { op: 'add', element: { id: 'mcp_edge', type: 'edge', from: { x: 100, y: 100, nodeId: 'mcp_node' },
    to: { x: 500, y: 300 }, route: 'straight', arrow: 'end', label: 'MCP连线' } }] });
  await poll(() => page.getByTestId('canvas-stage').textContent(), value => value.includes('MCP修改后图形') && value.includes('MCP连线'), 'MCP canvas text and connector redraw immediately');
  await historyRoundTrip(readElements, beforeElements, await readElements());
  const scene = (await call('inspectModel')).scene;
  const node = scene.elements.find(element => element.id === 'mcp_node');
  assert.equal(node.width, 280); assert.equal(node.cornerRadius, 20); assert.equal(node.style.fill, '#fddc88');
  assert.equal(scene.elements.find(element => element.id === 'mcp_edge').from.nodeId, 'mcp_node');
  await rejectedTool('canvas_edit', { operations: [{ op: 'add', element: { id: 'rejected_node', type: 'shape', shape: 'rectangle', text: 'MUST_NOT_APPEAR' } }, { op: 'update', id: 'missing-node', patch: { x: 20 } }] });
  assert.ok(!(await readElements()).some(element => element.id === 'rejected_node'), 'Failed canvas batch rolls back earlier operations');
  const saved = JSON.parse((await exported('canvas-mcp-full-editing')).bytes.toString('utf8'));
  assert.ok(saved.scene.elements.some(element => element.id === 'mcp_edge'));
};
editingChecks.diagram = async () => {
  const source = 'sequenceDiagram\n  participant A as MCP\n  participant B as Editor\n  A->>B: MCP_DIAGRAM_UPDATED\n  B-->>A: 实时刷新';
  await mcp('diagram_update', { source, style: 'blueprint', title: 'MCP更新图表' });
  assert.equal(await page.getByTestId('diagram-source').inputValue(), source);
  await poll(() => page.getByTestId('diagram-preview').textContent(), value => value.includes('MCP_DIAGRAM_UPDATED'), 'MCP diagram settings and source rerender the SVG');
  const model = await call('inspectModel'); assert.equal(model.source, source); assert.equal(model.diagramStyle, 'blueprint'); assert.equal(model.title, 'MCP更新图表');
  const saved = JSON.parse((await exported('diagram-mcp-full-editing')).bytes.toString('utf8'));
  assert.equal(saved.diagramStyle, 'blueprint'); assert.equal(saved.source, source);
};

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}

function harnessRequest(request) {
  const id = ++harnessSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingHarness.delete(id); reject(Error('Rust harness timed out: ' + request.op)); }, 30000);
    pendingHarness.set(id, { resolve, reject, timer });
    harness.stdin.write(JSON.stringify({ ...request, id }) + '\n');
  });
}
async function startHarness() {
  const manifest = path.join(root, 'tests/native/mcp-http-harness/Cargo.toml');
  const target = process.env.OFFICE_MCP_RUST_TARGET || path.join(output, 'rust-target');
  phase('compile-production-rust-http-harness');
  execFileSync('cargo', ['build', '--locked', '--manifest-path', manifest, '--target-dir', target], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  harness = spawn(path.join(target, 'debug/office-mcp-http-harness'), [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  harness.stderr.on('data', chunk => process.stderr.write(chunk));
  harness.on('exit', (code, signal) => {
    for (const pending of pendingHarness.values()) { clearTimeout(pending.timer); pending.reject(Error(`Rust harness exited: ${code ?? signal}`)); }
    pendingHarness.clear();
  });
  readline.createInterface({ input: harness.stdout }).on('line', async line => {
    let value;
    try { value = JSON.parse(line); } catch { report.consoleErrors.push({ kind, message: 'Invalid harness output: ' + line }); return; }
    if (value.event === 'mcp-request') {
      try { await page.evaluate(request => window.__mcpBrowserRequest?.(request), value.request); }
      catch (error) { report.pageErrors.push({ kind, message: 'MCP bridge failed: ' + error.message }); }
    } else {
      const pending = pendingHarness.get(value.id); if (!pending) return;
      clearTimeout(pending.timer); pendingHarness.delete(value.id);
      if (value.ok) pending.resolve(value.result); else pending.reject(Error(value.error));
    }
  });
  assert.equal((await harnessRequest({ op: 'status' })).running, false);
}
async function rpc(method, params = {}, options = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` };
  if (protocolSession) headers['mcp-session-id'] = protocolSession;
  if (method !== 'initialize') headers['mcp-protocol-version'] = '2025-06-18';
  const request = { jsonrpc: '2.0', method, params, ...(options.notification ? {} : { id: ++rpcSequence }) };
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `MCP ${method} HTTP status ${response.status}: ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
  if (method === 'initialize') protocolSession = response.headers.get('mcp-session-id');
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find(line => line.startsWith('data:'))?.slice(5) : text;
  return JSON.parse(data);
}
async function startMcp(allowEdits = true) {
  const port = await freePort();
  const started = await page.evaluate(async ({ port, allowEdits }) => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const { mcpTransport } = await import('/src/mcp/native.ts');
    const { catalogForKind } = await import('/src/mcp/document-tools.ts');
    Object.assign(mcpTransport, {
      start: (config, document, tools) => window.__mcpHarness({ op: 'start', config, document, tools }),
      stop: sessionId => window.__mcpHarness({ op: 'stop', sessionId }),
      heartbeat: sessionId => window.__mcpHarness({ op: 'heartbeat', sessionId }),
      claim: (sessionId, requestId) => window.__mcpHarness({ op: 'claim', sessionId, requestId }),
      complete: (sessionId, requestId, result) => window.__mcpHarness({ op: 'complete', sessionId, requestId, result }),
      listen: async callback => { window.__mcpBrowserRequest = callback; return () => { window.__mcpBrowserRequest = undefined; }; },
    });
    const config = { ...app.mcpConfig, port, allowEdits };
    app.mcpConfig = config;
    await app.mcpService.start(config, { id: app.activeKey, kind: app.active.document.kind, title: app.active.document.name }, catalogForKind(app.active.document.kind));
    return { config, state: app.mcpService.inspect() };
  }, { port, allowEdits });
  assert.equal(started.state.phase, 'running'); endpoint = started.state.endpoint; token = started.config.token; protocolSession = undefined;
  const response = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Open Office integration test', version: '1' } });
  assert.ok(response.result?.capabilities?.tools); assert.ok(response.result?.serverInfo?.name);
  await rpc('notifications/initialized', {}, { notification: true });
  const list = await rpc('tools/list');
  assert.ok(list.result.tools.some(tool => tool.name === 'document_inspect'));
  report.operations.push({ kind, operation: 'initialize-and-list', protocolVersion: response.result.protocolVersion, tools: list.result.tools.map(tool => tool.name) });
  const toggle = page.getByTestId('document-mcp-toggle');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true'); assert.match(await toggle.textContent(), /Running/);
  return list.result.tools;
}

async function launchSurface(surface) {
  kind = surface;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', acceptDownloads: true });
  context.on('request', request => { const url = request.url(); if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push({ kind, url }); });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.exposeFunction('__mcpHarness', harnessRequest);
  page.on('pageerror', error => report.pageErrors.push({ kind, message: error.message }));
  page.on('console', event => { if (event.type() === 'error') report.consoleErrors.push({ kind, message: event.text() }); });
  await page.goto(origin); await page.getByTestId('global-toolbar').waitFor();
  await page.locator('.create-card.' + kind).click(); await ready();
}
async function rehearseInstalledHelper() {
  phase('installed-helper-rehearsal-with-stdio-ipc');
  await launchSurface('word');
  await startMcp();
  const result = await page.evaluate(async handleNames => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState;
    const nextTick = () => new Promise(resolve => requestAnimationFrame(resolve));
    const { catalogForKind } = await import('/src/mcp/document-tools.ts');
    const { runMcpNativeSmoke } = await import('/src/mcp/native-smoke.ts');
    await app.mcpService.stop();
    for (const tab of [...app.tabs]) await app.removeTab(tab, true);
    await nextTick();
    // The report is solely rehearsal evidence: Chromium replaces native IPC.
    // No report is delivered to the native smoke endpoint or release verifier.
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => {
      if (command === 'mcp_status') return window.__mcpHarness({ op:'status' });
      if (command === 'mcp_smoke_probe') return window.__mcpHarness({ op:'probe',request:args.request });
      throw Error('Unexpected native command during rehearsal: ' + command);
    } };
    const handleFor = tab => app[handleNames[tab.document.kind]].get(tab.key);
    try {
      return await runMcpNativeSmoke({
        open: async source => {
          const tab = await app.addDocument(source);
          await nextTick(); await app.awaitReady(tab);
          const editor = handleFor(tab);
          return { key:tab.key,editor,read:async () => {
            if(source.kind === 'sheet') return editor.query('cell.get',{cell:'A1'});
            if(source.kind === 'presentation') return editor.query('slide.inspect',{index:0});
            if(source.kind === 'pdf') return editor.query('document.inspect');
            if(source.kind === 'canvas' || source.kind === 'diagram') return editor.inspectModel();
            if(source.kind === 'note') return { visibleText:[...document.querySelectorAll('[data-testid="notebook-content"]')].map(element=>element.textContent||'').join('\n') };
            return editor.inspect();
          } };
        },
        start:async key => {
          const tab = app.currentDocument;
          if(tab.key !== key) throw Error('Rehearsal opened the wrong document');
          const config = { ...app.mcpConfig,allowEdits:true };
          await app.mcpService.start(config,{id:key,kind:tab.document.kind,title:tab.document.name},catalogForKind(tab.document.kind));
          await nextTick();
        },
        documentState:key => ({ active:app.activeKey === key && !app.home,dirty:app.tabs.find(tab=>tab.key===key)?.dirty===true }),
        state:()=>app.mcpService.inspect(),stop:async()=>{await app.mcpService.stop();await nextTick();},
        close:async key => {const tab=app.tabs.find(tab=>tab.key===key);await app.removeTab(tab,true);await nextTick();if(handleFor(tab))throw Error('Editor survived cleanup');},
      });
    } finally { window.isTauri = false;delete window.__TAURI_INTERNALS__; }
  },handleNames);
  fs.writeFileSync(path.join(output,'helper-rehearsal.json'),JSON.stringify({
    runtime:'Chromium plus production Rust HTTP/probe; stdio replaces native IPC. NOT installed-app acceptance evidence.',result,
  },null,2));
  assert.equal(result.ok,true,result.error || result.cleanupError);
  const { validateNativeMcpReport } = await import('../../scripts/mcp-native-smoke.mjs');
  report.rehearsalValidation=validateNativeMcpReport(result);
  report.rehearsalBytes=Buffer.byteLength(JSON.stringify(result));
  pass('Installed helper seven-editor arguments, history, actual state and independently parsed exports work over real Rust HTTP; native IPC remains for CI');
}
async function main() {
  try {
    report.sourceHashesBefore = sourceHashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: Number(process.env.OFFICE_MCP_PORT || 5358), strictPort: true, hmr: false,
        watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await startHarness();
    if(process.env.OFFICE_MCP_NATIVE_REHEARSAL === '1') {
      report.completeSuite=false;
      await rehearseInstalledHelper();
      report.sourceHashesAfter=sourceHashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashesBefore);
      assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);
      report.ok=true;return;
    }
    for (const surface of testedKinds) {
      phase(surface + '-real-editor-tools'); await launchSurface(surface);
      await assertMcpPlacement();
      if (surface === 'word') {
        await settingsChecks();
        const before = await call('inspect');
        const tools = await startMcp(false);
        assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true));
        const denied = await rpc('tools/call', { name: 'word_insert_text', arguments: { text: 'MUST_NOT_BE_INSERTED' } });
        assert.ok(denied.error || denied.result?.isError, 'Read-only service refuses document mutations over actual HTTP');
        assert.equal((await call('inspect')).revision, before.revision);
        await page.getByTestId('document-mcp-toggle').click();
        await poll(() => harnessRequest({ op: 'status' }), value => !value.running, 'Stop button closes actual read-only HTTP server');
        pass('Actual Rust HTTP initialize/list and read-only tool enforcement; Running reflects listener, stop button closes it');
      }
      await startMcp();
      const inspected = await mcp('document_inspect'); assert.equal(inspected.documentId, (await call('inspect')).documentId);
      assert.equal(typeof editorChecks[surface], 'function', 'Acceptance scenario is defined for ' + surface);
      await editorChecks[surface]();
      assert.equal(typeof editingChecks[surface], 'function', 'Full editing scenario is defined for ' + surface);
      await editingChecks[surface]();
      await passiveReadCheck();
      assert.equal((await active()).dirty, true, 'MCP content edit updates the shell unsaved indicator');
      await capture(surface + '-mcp-edited');
      await page.setViewportSize({ width: 900, height: 640 }); await frame();
      assert.equal(await page.getByTestId('document-mcp-toggle').getAttribute('aria-pressed'), 'true');
      await capture(surface + '-mcp-narrow');
      pass(surface + ': actual MCP edit, query, undo/redo and persisted document verified');
      if (surface === 'word') {
        const previous = await active();
        const oldProtocolSession = protocolSession;
        // Hold only the native-claim IPC acknowledgement, while the real HTTP
        // request and its document-scoped dispatcher are pending. Navigation
        // must revoke it before an editor mutation can begin.
        await page.evaluate(async () => {
          const { mcpTransport } = await import('/src/mcp/native.ts');
          const original = mcpTransport.claim;
          const gate = new Promise(resolve => { window.__releaseMcpClaim = resolve; });
          window.__mcpClaimHeld = false;
          mcpTransport.claim = async (...args) => { window.__mcpClaimHeld = true; await gate; return original(...args); };
          window.__restoreMcpClaim = () => { mcpTransport.claim = original; window.__releaseMcpClaim(); };
        });
        const pendingEdit = rpc('tools/call', { name: 'word_insert_text', arguments: { text: 'INFLIGHT_MUST_NOT_EDIT_EITHER_DOCUMENT' } })
          .then(value => ({ value }), error => ({ error: error.message }));
        await poll(() => page.evaluate(() => window.__mcpClaimHeld), Boolean, 'Actual HTTP mutation waits for native claim');
        await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-word').click(); await ready();
        assert.notEqual((await active()).key, previous.key);
        await poll(() => harnessRequest({ op: 'status' }), value => !value.running, 'Switching current document closes the native listener');
        assert.equal(await page.getByTestId('document-mcp-toggle').getAttribute('aria-pressed'), 'false');
        await page.evaluate(() => window.__restoreMcpClaim());
        const cancelledEdit = await pendingEdit;
        assert.equal(cancelledEdit.error, undefined, 'In-flight request receives a protocol response when the document switches');
        assert.ok(cancelledEdit.value?.error || cancelledEdit.value?.result?.isError, 'Switching documents cancels the pending mutation');
        const nextBefore = await call('inspect');
        assert.ok(!nextBefore.text.includes('INFLIGHT_MUST_NOT_EDIT_EITHER_DOCUMENT'));
        await startMcp();
        const oldSessionResponse = await fetch(endpoint, { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
          'mcp-session-id': oldProtocolSession, 'mcp-protocol-version': '2025-06-18',
        }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method: 'tools/call', params: {
          name: 'word_insert_text', arguments: { text: 'STALE_SESSION_MUST_NOT_EDIT_NEW_DOCUMENT' },
        } }), signal: AbortSignal.timeout(3000) });
        assert.equal(oldSessionResponse.status, 404, 'Previous document MCP client session is invalid after a new service starts');
        assert.equal((await call('inspect')).revision, nextBefore.revision, 'Old MCP session cannot mutate the newly selected document');
        await page.locator('.document-tab .tab-name').filter({ hasText: previous.name }).click(); await ready();
        assert.equal((await harnessRequest({ op: 'status' })).running, false, 'Returning to the original document never silently restarts MCP');
        assert.ok((await call('inspect')).text.includes('MCP_WORD_实际文档编辑_2026'));
        assert.ok(!(await call('inspect')).text.includes('INFLIGHT_MUST_NOT_EDIT_EITHER_DOCUMENT'));
        pass('Real document switch cancels an in-flight HTTP edit and invalidates the old client session; returning preserves original edits');
      }
      await page.locator('.home-tab').click();
      await poll(() => harnessRequest({ op: 'status' }), value => !value.running, kind + ' home navigation stops real TCP service');
      await assert.rejects(() => fetch(endpoint, { signal: AbortSignal.timeout(3000) }), 'Closed MCP port refuses further connections');
      await browser.close(); browser = undefined; page = undefined;
    }
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.sourceHashesAfter = sourceHashes();
    assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore, 'Product sources remained unchanged through the actual integration run');
    report.ok = true;
  } catch (error) {
    report.failure = { phase: report.phase, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) { await capture('failure').catch(() => {}); try { report.failureSnapshot = await call('inspect'); } catch {} }
    throw error;
  } finally {
    report.finishedAtUtc = new Date().toISOString(); persist();
    if (harness) { await harnessRequest({ op: 'stop' }).catch(() => {}); harness.stdin.end(); }
    await browser?.close(); await server?.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
