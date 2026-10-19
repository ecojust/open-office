/* Real local Rust/WASM spreadsheet acceptance. All editing below uses browser
 * pointer/keyboard events. Read-only Rust queries observe it; independent Python
 * ZIP/XML inspection checks delivered XLSX bytes. No Office iframe or mock engine. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const legacyEngineBrand = new RegExp(require('../../scripts/office-branding-policy.json').families.map(family => family.old).join('|'), 'i');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_SHEET_OUTPUT || path.join(root, 'test-results/office-sheet-engine'));
const oracle = path.join(__dirname, 'office-sheet-inspect-xlsx.py');
const report = { ok: false, startedAtUtc: new Date().toISOString(), checks: [], files: [],
  pageErrors: [], consoleErrors: [], wasmRequests: [], externalRequests: [], forbiddenRequests: [],
  scope: 'Default spreadsheet shell, real local Rust canvas/browser input, independently inspected XLSX/PDF output',
  limitations: [
    'Headless Chromium does not verify installed Tauri WebKit/WebView2 or physical operating-system IMEs.',
    'Only the explicitly exercised cells, formulas, styles and file lifecycle are verified; this is not full Excel parity.',
    'Legacy XLS/ODS compatibility routing is outside this local Rust XLSX/CSV/TSV acceptance.',
  ] };
fs.mkdirSync(output, { recursive: true });
for (const staleDiagnostic of ['failure.png', 'last-state.json']) {
  fs.rmSync(path.join(output, staleDiagnostic), { force: true });
}
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const phase = name => { report.phase = name; console.log('PHASE', name); persist(); };
const pass = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS', name); persist(); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const productSourceHashes = () => Object.fromEntries([
  'src/App.vue', 'src/components/RustSheetEditor.vue', 'src/sheet/rust/client.ts',
  'src/sheet/rust/office-sheet-types.ts', 'public/office-sheet/manifest.json', 'public/office-sheet/office-sheet.js',
].map(file => [file, sha(path.join(root, file))]));
const record = (file, kind) => { report.files.push({ file: path.relative(root, file), kind, bytes: fs.statSync(file).size, sha256: sha(file) }); return file; };
const inspectXlsx = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [oracle, file], { encoding: 'utf8' }));
const inspectDelimited = (file, delimiter) => JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
  'import csv,json,sys; f=open(sys.argv[1],encoding="utf-8-sig",newline=""); print(json.dumps(list(csv.reader(f,delimiter=sys.argv[2])),ensure_ascii=False))', file, delimiter], { encoding: 'utf8' }));
const inspectPdf = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
  'import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps({"pages":len(d),"text":"\\n".join(p.get_text() for p in d)},ensure_ascii=False))', file], { encoding: 'utf8' }));
let browser, server, page, context;
const editor = () => page.getByTestId('rust-sheet-editor').filter({ visible: true });
const canvas = () => editor().getByTestId('office-sheet-canvas');
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function idle({ allowError = false } = {}) {
  await page.waitForFunction(allowError => {
    const error = document.querySelector('.error-banner');
    if (error && !allowError) throw Error(error.textContent);
    const node = [...document.querySelectorAll('[data-testid="rust-sheet-editor"]')].find(node => node.getBoundingClientRect().width > 0);
    return node?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  }, allowError);
}
async function inspect(id) {
  id ||= await editor().getAttribute('data-session-id');
  return page.evaluate(async id => (await import('/src/sheet/rust/client.ts')).inspectOfficeSheetSession(id), id);
}
async function query(command, params = {}, id) {
  id ||= await editor().getAttribute('data-session-id');
  return page.evaluate(async ({ id, command, params }) => (await import('/src/sheet/rust/client.ts')).queryOfficeSheetSession(id, command, params), { id, command, params });
}
const cell = (address, sheet, id) => query('cell.get', { cell: address, ...(sheet === undefined ? {} : { sheet }) }, id);
async function until(read, predicate, description, timeout = 30000) {
  const start = Date.now(); let last;
  report.currentStep = description;
  console.log('STEP', description);
  while (Date.now() - start < timeout) {
    last = await read();
    if (predicate(last)) {
      console.log('STEP_DONE', Date.now() - start, description);
      return last;
    }
    await page.waitForTimeout(40);
  }
  fs.writeFileSync(path.join(output, 'last-state.json'), JSON.stringify(last, null, 2));
  assert.fail(description + ': timed out; see last-state.json');
}
async function clickRect(rect, options) {
  const box = await canvas().boundingBox();
  assert.ok(box && Array.isArray(rect) && rect.length === 4, 'Actual Rust widget geometry is available');
  const [x, y, w, h] = rect;
  assert.ok(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w / 2 < box.width && y + h / 2 < box.height, 'Widget is inside the visible canvas');
  await page.mouse.click(box.x + x + w / 2, box.y + y + h / 2, options);
  await frame();
}
async function selectCell(address) {
  const state = await until(() => inspect(), state => state.ui?.visibleCells?.some(item => item.cell === address), 'Rendered cell ' + address);
  await clickRect(state.ui.visibleCells.find(item => item.cell === address).rect);
  const selected = await until(() => query('document.inspect'), state => state.activeCell === address, 'Pointer selects ' + address);
  report.selections ||= [];
  report.selections.push({ address, mode: selected.mode, selection: selected.selection, at: new Date().toISOString() });
  console.log('SELECTED_MODE', address, selected.mode);
}
async function beginCellText(address) {
  await selectCell(address);
  // Chromium insertText requires an actual editable DOM target. A ready grid
  // canvas handles physical keydown; it cannot receive a browser input event.
  await page.keyboard.press('F2');
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    target => target === 'office-sheet-input', 'F2 focuses the actual cell text input');
  await page.keyboard.press('Control+a');
}
async function writeCell(address, text, expected = text) {
  if (/[^\x00-\x7f]/.test(text)) {
    await beginCellText(address);
    await page.keyboard.insertText(text);
  } else {
    await selectCell(address);
    await page.keyboard.type(text);
  }
  await page.keyboard.press('Enter');
  return until(() => cell(address), state => state.value === expected, 'Browser commits ' + address + ' = ' + JSON.stringify(expected));
}
async function control(id) {
  const state = await until(() => inspect(), state => state.ui?.drawnChrome?.some(item => item.id === id), 'Rendered control ' + id);
  const item = state.ui.drawnChrome.find(item => item.id === id);
  await clickRect(item.rect);
  report.clickedControls ||= []; report.clickedControls.push({ id, label: item.label, rect: item.rect });
}
async function newWorkbook() {
  const home = page.locator('.home-tab');
  if (await home.isVisible()) await home.click();
  await page.locator('.create-card.sheet').click(); await idle();
}
async function openFile(file, keyboard = false) {
  if (keyboard) await selectCell('A1');
  const choice = page.waitForEvent('filechooser');
  if (keyboard) await page.keyboard.press('Control+o');
  else await page.getByTestId('shell-open').click();
  await (await choice).setFiles(file);
}
async function download(filename, trigger, extension = 'xlsx') {
  const pending = page.waitForEvent('download');
  await (trigger || (() => page.getByTestId('shell-save').click()))();
  const delivered = await pending;
  assert.ok(delivered.suggestedFilename().toLowerCase().endsWith('.' + extension));
  report.downloads ||= []; report.downloads.push({ file: filename, suggestedFilename: delivered.suggestedFilename() });
  const file = path.join(output, filename); await delivered.saveAs(file); await idle();
  record(file, 'Actual shell download'); return file;
}
async function chrome() {
  const state = await inspect();
  const drawn = state.ui?.drawnChrome;
  assert.ok(drawn?.length, 'Read actual Rust-drawn controls');
  assert.ok(drawn.some(item => item.id === 'tab:Home'));
  assert.ok(drawn.some(item => item.id === 'formulaBar'));
  assert.ok(drawn.some(item => item.id === 'statusBar'));
  assert.equal(state.ui.backstage, null);
  assert.ok(!drawn.some(item => /^(?:titleBar|tab:(?:File|Help)|quickAccess:file\.)/.test(item.id)), 'Embedded renderer omits internal app/file chrome');
  assert.ok(!drawn.some(item => legacyEngineBrand.test(item.label || '')), 'Ordinary drawn chrome has no upstream product branding');
  assert.ok(!legacyEngineBrand.test(await page.locator('body').innerText()));
  assert.equal(await page.locator('iframe').count(), 0, 'The actual editor is a local canvas, without another Office iframe');
  report.chrome = drawn;
}
async function componentCall(method, argument) {
  return editor().evaluate(async (node, { method, argument }) => {
    const exposed = node.__vueParentComponent?.exposed;
    if (!exposed?.[method]) throw Error('Actual mounted spreadsheet component lacks ' + method);
    return exposed[method](argument);
  }, { method, argument });
}

async function checks() {
  phase('default-entry-and-real-input');
  await newWorkbook(); await chrome();
  assert.equal(await canvas().count(), 1);
  assert.equal((await inspect()).dirty, false);
  assert.ok(report.wasmRequests.some(url => /\/office-sheet\/.*\.wasm/.test(url)), 'Default Excel actually loads the local Rust/WASM artifact');
  const sample = 'Open Office 中文😀';
  await writeCell('A1', sample);
  await writeCell('B1', '12', 12); await writeCell('B2', '30', 30);
  await writeCell('C1', '=SUM(B1:B2)', 42);
  assert.equal((await cell('C1')).formula, '=SUM(B1:B2)');
  await writeCell('B1', '15', 15);
  await until(() => cell('C1'), value => value.value === 45, 'Live dependency recalculation');
  await page.keyboard.press('Control+z');
  await until(() => cell('B1'), value => value.value === 12, 'Keyboard Undo reverts cell edit');
  assert.equal((await cell('C1')).value, 42);
  await page.keyboard.press('Control+y');
  await until(() => cell('C1'), value => value.value === 45, 'Keyboard Redo recalculates dependents');
  pass('Actual canvas edits Chinese/emoji, numbers and formulas; dependencies recalculate through Undo/Redo');

  phase('actual-format-and-sheet-controls');
  await selectCell('A1'); await control('home.bold');
  await until(() => cell('A1'), value => value.style.font.bold === true, 'Actual Bold ribbon changes font');
  await selectCell('A1');
  assert.equal((await query('document.inspect')).mode, 'Ready', 'Returning to a selected cell after a ribbon action is not a double-click');
  // Start a distinct double-click gesture instead of a three-click sequence.
  await selectCell('B1');
  const a1Rect = (await inspect()).ui.visibleCells.find(item => item.cell === 'A1').rect;
  const canvasBox = await canvas().boundingBox();
  await page.mouse.dblclick(canvasBox.x + a1Rect[0] + a1Rect[2] / 2, canvasBox.y + a1Rect[1] + a1Rect[3] / 2);
  await until(() => inspect(), state => state.ui.editor?.cell === 'A1' && state.ui.mode === 'Edit', 'Actual double-click enters cell text editing');
  await page.keyboard.press('Escape');
  await until(() => query('document.inspect'), state => state.mode === 'Ready', 'Escape cancels the actual cell editor');
  assert.equal((await cell('A1')).value, sample);
  // Clipboard state survives browser contexts. Observe this copy's async system
  // write, rather than accidentally accepting identical text from a prior run.
  await page.evaluate(() => navigator.clipboard.writeText('Copy pending: ' + crypto.randomUUID()));
  await page.keyboard.press('Control+c');
  report.copiedClipboard = await until(
    () => page.evaluate(() => navigator.clipboard.readText()),
    text => text.replace(/[\r\n]+$/, '') === sample,
    'Current cell copy reaches the system clipboard',
  );
  await selectCell('D4'); await page.keyboard.press('Control+v');
  await until(() => cell('D4'), value => value.value === sample, 'Real browser clipboard pastes cell content once');
  await page.keyboard.press('Control+z');
  await until(() => cell('D4'), value => value.value === null, 'One Undo removes the clipboard paste');
  await page.evaluate(() => navigator.clipboard.writeText('外部剪贴板的新内容'));
  await selectCell('D4'); await control('edit.paste');
  await until(() => cell('D4'), value => value.value === '外部剪贴板的新内容', 'Ribbon Paste reads current OS clipboard instead of its previous internal copy');
  await selectCell('D4'); await page.keyboard.press('Control+z');
  await until(() => cell('D4'), value => value.value === null, 'One Undo removes the toolbar clipboard paste');
  await control('addSheet');
  await until(() => inspect(), state => state.sheets.length === 2 && state.activeSheet === 1, 'Actual plus button adds and activates worksheet');
  await writeCell('A1', '第二张工作表');
  await control('sheetTab:0');
  await until(() => inspect(), state => state.activeSheet === 0, 'Actual sheet tab activates first worksheet');
  assert.equal((await cell('A1')).value, sample);
  const saved = await download('canvas-edits.xlsx'), packageData = inspectXlsx(saved);
  assert.equal(packageData.sheets.length, 2);
  assert.equal(packageData.sheets[0].cells.A1.value, sample);
  assert.equal(packageData.sheets[0].cells.A1.style.bold, true);
  assert.equal(packageData.sheets[0].cells.C1.formula, '=SUM(B1:B2)');
  assert.equal(packageData.sheets[0].cells.C1.value, 45);
  assert.equal(packageData.sheets[1].cells.A1.value, '第二张工作表');
  await until(() => inspect(), state => !state.dirty, 'Delivered XLSX acknowledges the current revision');
  pass('Real Bold/add-sheet/tab controls survive independently inspected XLSX; shell Save alone clears dirty');

  phase('save-receipt-and-cancellation');
  await writeCell('D1', '待保存');
  const exported = await componentCall('exportFile', { format: 'xlsx' });
  assert.equal((await inspect()).dirty, true, 'Encoding without successful delivery never acknowledges save');
  await writeCell('D1', '导出后修改');
  await assert.rejects(() => componentCall('markSaved', exported.base64), /修改|保存/, 'Stale save receipt cannot mark a newer edit clean');
  assert.equal((await inspect()).dirty, true);
  await selectCell('A1'); await page.keyboard.press('Control+Shift+s');
  const saveAs = page.getByTestId('save-format-dialog'); await saveAs.waitFor();
  assert.equal((await inspect()).ui.dialog, null, 'Save As belongs to Open Office');
  const beforeCancel = await inspect(); await page.keyboard.press('Escape'); await saveAs.waitFor({ state: 'hidden' });
  const afterCancel = await inspect();
  for (const key of ['documentId', 'revision', 'dirty']) assert.deepEqual(afterCancel[key], beforeCancel[key]);
  const downloadCount = report.downloadCount || 0;
  await selectCell('A1'); await download('shortcut-save.xlsx', () => page.keyboard.press('Control+s'));
  assert.equal(report.downloadCount, downloadCount + 1, 'Canvas Ctrl+S routes once through the shell');
  assert.equal((await inspect()).dirty, false);
  await beginCellText('E1'); await page.keyboard.insertText('保存时提交');
  // Do not inspect/press Enter between typing and the real save-button blur.
  const pendingEditSaved = await download('pending-cell-save.xlsx');
  assert.equal(inspectXlsx(pendingEditSaved).sheets[0].cells.E1.value, '保存时提交');
  assert.equal((await inspect()).dirty, false, 'Only the delivered committed cell revision is marked saved');
  pass('Export-only and stale save receipts retain dirty; canceled shell Save As preserves revision and Ctrl+S saves once');

  phase('tabs-and-failed-open-atomicity');
  await writeCell('D2', '保留草稿');
  const firstId = (await inspect()).sessionId;
  const firstName = await page.locator('.document-tab.active .tab-name').innerText();
  const beforeNew = await page.locator('.document-tab').count();
  await selectCell('A1'); await page.keyboard.press('Control+n');
  await page.waitForFunction(count => document.querySelectorAll('.document-tab').length === count + 1, beforeNew);
  await idle();
  const secondId = (await inspect()).sessionId;
  assert.notEqual(secondId, firstId);
  await beginCellText('A1'); await page.keyboard.insertText('切换前输入');
  // No Enter or query here: switching must settle the pending UI edit itself.
  await page.locator('.document-tab .tab-name').filter({ hasText: firstName }).click(); await idle();
  assert.equal((await cell('A1', 0, secondId)).value, '切换前输入');
  assert.equal((await cell('D2')).value, '保留草稿');
  assert.equal((await inspect()).dirty, true);
  assert.equal(await page.getByTestId('office-sheet-canvas').filter({ visible: true }).count(), 1);
  await page.locator('.document-tab.active .tab-close').click();
  const close = page.getByRole('dialog', { name: '保存你的修改？' }); await close.waitFor();
  await close.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await cell('D2')).value, '保留草稿');
  const before = await inspect(), values = await query('sheet.read', { range: 'A1:D2' });
  const tabs = await page.locator('.document-tab').count();
  const broken = path.join(output, 'broken.xlsx'); fs.writeFileSync(broken, Buffer.from('PK\x03\x04broken'));
  await openFile(broken); await page.locator('.error-banner').waitFor(); await idle({ allowError: true });
  const after = await inspect();
  for (const key of ['sessionId', 'documentId', 'revision', 'dirty', 'canUndo', 'canRedo']) assert.deepEqual(after[key], before[key], 'Malformed open preserves ' + key);
  assert.deepEqual(await query('sheet.read', { range: 'A1:D2' }), values);
  assert.equal(await page.locator('.document-tab').count(), tabs);
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  pass('Queued cell edit stays with its tab, close cancellation preserves drafts, malformed XLSX leaves active workbook/history unchanged');

  phase('word-and-sheet-session-isolation');
  const sheetName = await page.locator('.document-tab.active .tab-name').innerText();
  const sheetId = (await inspect()).sessionId;
  await page.locator('.home-tab').click();
  await page.locator('.create-card.word').click();
  const wordEditor = page.getByTestId('rust-word-editor').filter({ visible: true });
  await until(() => wordEditor.getAttribute('data-ready'), value => value === 'true', 'Word editor mounts alongside retained spreadsheet');
  const wordId = await wordEditor.getAttribute('data-session-id');
  const readWord = () => page.evaluate(async id => (await import('/src/word/rust/client.ts')).inspectOfficeWordSession(id), wordId);
  const wordState = await until(readWord, value => value.ui?.pages?.length, 'Word actual page geometry');
  const wordCanvas = wordEditor.getByTestId('office-word-canvas'), wordBox = await wordCanvas.boundingBox();
  const [wx, wy, ww, wh] = wordState.ui.pages[0];
  await page.mouse.click(wordBox.x + wx + ww * 0.7, wordBox.y + Math.min(wy + Math.min(200, wh / 4), wordBox.height - 50));
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    target => target === 'office-word-input', 'Word page focuses its actual text input');
  await page.keyboard.insertText('Word与表格独立草稿');
  await until(readWord, value => value.text === 'Word与表格独立草稿', 'Word owns its own browser input');
  const wordName = await page.locator('.document-tab.active .tab-name').innerText();
  await page.locator('.document-tab .tab-name').filter({ hasText: sheetName }).click(); await idle();
  assert.equal((await inspect()).sessionId, sheetId);
  assert.equal((await cell('D2')).value, '保留草稿');
  await writeCell('D3', '跨引擎切换');
  await page.locator('.document-tab .tab-name').filter({ hasText: wordName }).click();
  await until(readWord, value => value.text === 'Word与表格独立草稿', 'Returning Word text is unchanged');
  await page.locator('.document-tab .tab-name').filter({ hasText: sheetName }).click(); await idle();
  assert.equal((await cell('D3')).value, '跨引擎切换');
  assert.equal((await inspect()).dirty, true);
  assert.equal(await page.getByTestId('office-word-canvas').filter({ visible: true }).count(), 0);
  assert.equal(await page.getByTestId('office-sheet-canvas').filter({ visible: true }).count(), 1);
  pass('Word and spreadsheet canvas sessions retain separate dirty drafts and browser input across cross-engine tab switches');

  phase('independent-import-and-reopen');
  const independent = path.join(output, 'independent.xlsx');
  execFileSync(process.env.PYTHON || 'python3', [oracle, '--fixture', independent]); record(independent, 'Independent XML-authored source');
  await openFile(independent, true); await idle();
  assert.equal((await cell('A1')).value, '地区 中文');
  assert.equal((await cell('C1')).value, 42);
  assert.equal((await cell('C2', 1)).value, 42);
  assert.equal((await cell('A1')).style.font.bold, true);
  await writeCell('B2', '20', 20);
  await until(() => cell('C2', 1), state => state.value === 50, 'Cross-sheet formula recalculates independent source');
  const roundtrip = await download('independent-roundtrip.xlsx');
  const inspected = inspectXlsx(roundtrip);
  assert.deepEqual(inspected.sheets.map(sheet => sheet.name), ['销售', '预算']);
  assert.equal(inspected.sheets[0].cells.C1.value, 50);
  assert.equal(inspected.sheets[0].cells.C1.formula, '=SUM(B2:B3)');
  assert.equal(inspected.sheets[0].cells.A1.style.bold, true);
  assert.equal(inspected.sheets[0].cells.A1.style.fontSize, 16);
  assert.equal(inspected.sheets[0].cells.A1.style.color, '336699');
  assert.equal(inspected.sheets[0].cells.B2.style.numberFormat, '0.00');
  assert.equal(inspected.sheets[1].cells.C2.value, 50);
  assert.match(inspected.sheets[1].cells.C2.formula, /^='?销售'?!C1$/);
  await openFile(roundtrip); await idle();
  assert.equal((await cell('C1')).value, 50); assert.equal((await cell('C2', 1)).value, 50);
  await writeCell('B3', '40', 40);
  await until(() => cell('C2', 1), state => state.value === 60, 'Reopened formula remains live');
  pass('Independent XLSX import, edited cross-sheet formula, styles/number format and reopened formulas agree with external XML oracle');

  phase('pdf-and-visible-workspace');
  const pdfFile = await download('sheet-export.pdf', async () => {
    await page.getByTestId('shell-export-pdf').click();
    if (await page.getByTestId('save-format-confirm').isVisible()) await page.getByTestId('save-format-confirm').click();
  }, 'pdf');
  const pdf = inspectPdf(pdfFile);
  assert.ok(pdf.pages > 0); assert.ok(pdf.text.replace(/\s/g, '').includes('地区中文'));
  assert.equal((await inspect()).dirty, true, 'PDF export never acknowledges XLSX save');
  await chrome();
  await page.screenshot({ path: path.join(output, 'open-office-spreadsheet.png') });
  await page.setViewportSize({ width: 1000, height: 820 }); await frame();
  await selectCell('A1'); await chrome();
  await page.screenshot({ path: path.join(output, 'open-office-spreadsheet-narrow.png') });
  pass('Shell PDF contains actual selectable Chinese text and preserves dirty state; editing-only workspace renders at two sizes');

  phase('csv-tsv-displayed-values-and-source-copies');
  await page.setViewportSize({ width: 1440, height: 1050 }); await frame();
  const textExportOrigin = await inspect();
  assert.equal(textExportOrigin.sheets.length, 2);
  assert.equal(textExportOrigin.dirty, true);
  const exportContent = () => Promise.all([
    cell('A1'), cell('B2'), cell('B3'), cell('C1'), cell('A1', 1), cell('C2', 1),
  ]);
  const contentBeforeTextExport = await exportContent();
  const textFiles = {};
  for (const [format, delimiter] of [['csv', ','], ['tsv', '\t']]) {
    await page.getByTestId('shell-save-as').click();
    await page.getByTestId('save-format-dialog').waitFor();
    await page.getByTestId('save-format-' + format).check();
    const notice = await page.getByTestId('save-format-' + format).locator('..').innerText();
    assert.match(notice, /当前工作表/); assert.match(notice, /显示值/);
    if (format === 'csv') {
      assert.match(notice, /公式/); assert.match(notice, /格式/); assert.match(notice, /其他工作表/);
    }
    assert.match(await page.locator('.save-format-note').innerText(), /副本/);
    const file = await download('displayed-values.' + format, () => page.getByTestId('save-format-confirm').click(), format);
    textFiles[format] = file;
    const rows = inspectDelimited(file, delimiter);
    assert.equal(rows[0][0], '地区 中文');
    assert.equal(rows[0][2], '60', 'Formula exports its calculated display value');
    assert.equal(rows[1][1], '20.00', 'Number format reaches the text export as displayed');
    assert.equal(rows[2][1], '40.00');
    assert.equal(rows.length, 3, 'Only the active worksheet is exported');
    assert.ok(!rows.flat().some(value => value.includes('SUM(') || value.includes('预算副表')));
    const current = await inspect();
    assert.equal(current.sessionId, textExportOrigin.sessionId);
    // Export may persist the current active cell/top-left view and increment
    // its receipt revision. It must preserve actual workbook content/history.
    assert.deepEqual(await exportContent(), contentBeforeTextExport);
    assert.deepEqual(current.sheets, textExportOrigin.sheets);
    assert.equal(current.canUndo, textExportOrigin.canUndo);
    assert.equal(current.canRedo, textExportOrigin.canRedo);
    assert.equal(current.dirty, true, 'Lossy text export never acknowledges workbook save');
    assert.equal(current.sheets.length, 2, 'Text export keeps the original workbook editable');
  }
  const source = path.join(output, 'independent-chinese.csv');
  fs.writeFileSync(source, '\uFEFF"地区,名称",金额,备注\r\n华东,12,"逗号,引号"""\r\n华南,30,=1+2\r\n');
  record(source, 'Independent UTF-8 BOM CSV with escaped quote and literal formula-looking text');
  const sourceHash = sha(source);
  await openFile(source); await idle();
  assert.match(await page.getByTestId('import-review-notice').innerText(), /原始数据文件保留/);
  assert.equal((await inspect()).sheets.length, 1);
  assert.equal((await cell('A1')).value, '地区,名称');
  assert.equal((await cell('B2')).value, 12);
  assert.equal((await cell('C2')).value, '逗号,引号"');
  assert.equal((await cell('C3')).value, '=1+2');
  assert.equal((await cell('C3')).formula, null, 'CSV imports formula-looking fields as source text');
  await writeCell('D2', '=SUM(B2:B3)', 42);
  await writeCell('B2', '15', 15);
  await until(() => cell('D2'), state => state.value === 45, 'Formula added to imported CSV recalculates');
  const importedCopy = await download('csv-import-copy.xlsx');
  assert.equal(sha(source), sourceHash, 'Imported text source remains byte-for-byte unchanged');
  const importedXlsx = inspectXlsx(importedCopy).sheets[0].cells;
  assert.equal(importedXlsx.A1.value, '地区,名称');
  assert.equal(importedXlsx.C2.value, '逗号,引号"');
  assert.equal(importedXlsx.C3.value, '=1+2'); assert.equal(importedXlsx.C3.formula, null);
  assert.equal(importedXlsx.D2.formula, '=SUM(B2:B3)'); assert.equal(importedXlsx.D2.value, 45);
  await openFile(importedCopy); await idle();
  assert.equal((await cell('D2')).formula, '=SUM(B2:B3)'); assert.equal((await cell('D2')).value, 45);
  await openFile(textFiles.tsv); await idle();
  assert.equal((await inspect()).sheets.length, 1);
  assert.equal((await cell('A1')).value, '地区 中文');
  assert.equal((await cell('B2')).value, 20);
  assert.equal((await cell('C1')).value, 60); assert.equal((await cell('C1')).formula, null);
  assert.match(await page.getByTestId('import-review-notice').innerText(), /原始数据文件保留/);
  pass('CSV/TSV copies export only active-sheet displayed values without clearing dirty; Chinese/quoted CSV and TSV import into independent XLSX workbooks with source bytes preserved');

  phase('clipboard-permission-failure-preserves-workbook');
  await selectCell('D4');
  const deniedBefore = await inspect();
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  const permission = { permission: { name: 'clipboard-read' }, origin: new URL(page.url()).origin, browserContextId: targetInfo.browserContextId };
  try {
    // Change Chromium's real permission policy; do not replace navigator or the
    // editor's clipboard functions with a test implementation.
    await cdp.send('Browser.setPermission', { ...permission, setting: 'denied' });
    await control('edit.paste');
    await page.locator('.error-banner').waitFor();
    assert.match(await page.locator('.error-banner').innerText(), /剪贴板.*拒绝|剪贴板权限/);
    const deniedAfter = await inspect();
    assert.equal(deniedAfter.revision, deniedBefore.revision);
    assert.equal(deniedAfter.dirty, deniedBefore.dirty);
    assert.equal((await cell('D4')).value, null, 'Permission denial never falls back to stale internal clipboard cells');
  } finally {
    await cdp.send('Browser.setPermission', { ...permission, setting: 'granted' });
    await cdp.detach();
  }
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  pass('Actual denied browser clipboard permission shows a clear error and leaves the workbook revision and cells unchanged');
}

async function main() {
  try {
    phase('initializing-local-runtime');
    assert.ok(fs.existsSync(path.join(root, 'public/office-sheet/office-sheet_bg.wasm')), 'Build the local spreadsheet WASM before acceptance');
    const build = path.join(root, 'scripts/build-office-sheet.mjs');
    report.artifactCheck = execFileSync(process.execPath, [build, '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.artifactSha256 = sha(path.join(root, 'public/office-sheet/office-sheet_bg.wasm'));
    report.productSourcesBefore = productSourceHashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { entries: ['index.html'] }, server: {
      host: '127.0.0.1', port: Number(process.env.OFFICE_SHEET_QA_PORT || 5223), strictPort: true, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    console.log('BOOT', 'Local Vite shell is listening');
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'] });
    context.on('request', request => {
      const url = request.url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
      if (/\/office-runtime\/|\/office\/host\.html|\/office\/runtime\/|soffice\.(?:js|wasm)/.test(url)) report.forbiddenRequests.push(url);
      if (/\.wasm(?:\?|$)/.test(url)) report.wasmRequests.push(url);
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    await page.addInitScript(() => {
      window.__sheetInputTrace = [];
      const target = node => ({ tag: node?.tagName, testid: node?.getAttribute?.('data-testid') });
      for (const type of ['pointerdown', 'pointerup', 'click', 'copy', 'cut', 'paste', 'keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'focusin', 'focusout']) {
        document.addEventListener(type, event => {
          window.__sheetInputTrace.push({ time: performance.now(), type,
            x: event.clientX, y: event.clientY, key: event.key, keyCode: event.keyCode, inputType: event.inputType, isComposing: event.isComposing,
            ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
            clipboardTypes: event.clipboardData ? [...event.clipboardData.types] : undefined,
            target: target(event.target), focus: target(document.activeElement) });
          if (window.__sheetInputTrace.length > 200) window.__sheetInputTrace.shift();
        }, true);
      }
    });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('download', () => { report.downloadCount = (report.downloadCount || 0) + 1; });
    await page.goto(origin); console.log('BOOT', 'Shell loaded; opening the actual Rust spreadsheet'); await checks();
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    assert.equal(sha(path.join(root, 'public/office-sheet/office-sheet_bg.wasm')), report.artifactSha256, 'WASM artifact did not change during acceptance');
    report.productSourcesAfter = productSourceHashes();
    assert.deepEqual(report.productSourcesAfter, report.productSourcesBefore, 'Shell/client/loader source remained frozen during acceptance');
    report.ok = true;
  } catch (error) {
    report.failure = { phase: report.phase, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      try {
        report.failureSnapshot = await inspect();
        report.failureFocus = await page.evaluate(() => {
          const node = document.activeElement;
          return { tag: node?.tagName, id: node?.id, testid: node?.getAttribute('data-testid'), value: node?.value };
        });
        report.failureInputTrace = await page.evaluate(() => window.__sheetInputTrace);
      } catch { /* Keep the original failure if the editor could not mount. */ }
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    report.finishedAtUtc = new Date().toISOString(); persist();
    await browser?.close(); await server?.close();
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
