/* Real production HTTP listener + packaged Vue/Rust spreadsheet editor.
 * Two independent browser contexts use loopback and an ordinary LAN HTTP URL.
 * Browser input drives edits; independent ZIP/XML inspection verifies snapshots.
 * This does not claim an installed Tauri or operating-system WebView run. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_SYNC_OUTPUT || path.join(root, 'test-results/workspace-sync'));
const assets = path.resolve(process.env.OFFICE_SYNC_ASSETS || path.join(root, 'dist'));
const binary = process.env.OFFICE_SYNC_HARNESS || '/tmp/open-office-browser-server-target/debug/office-browser-harness';
const report = { ok: false, startedAt: new Date().toISOString(), checks: [], files: [], requests: [], errors: [], downloads: [],
  scope: 'Actual production HTTP routes and durable store; separate loopback/LAN Chromium contexts; packaged Vue and real Rust/WASM document models',
  limitations: ['Browser loopback represents the desktop workspace client; native Tauri IPC and macOS WebView are not executed.',
    'Concurrent edits preserve complete document versions; this verifies snapshot/CAS synchronization, not character-level collaborative merging.'] };
fs.mkdirSync(output, { recursive: true });
for (const file of fs.readdirSync(output)) if (/^failure-\d+\.png$/.test(file)) fs.rmSync(path.join(output, file));
const products = () => Object.fromEntries(['index.html', ...fs.readdirSync(path.join(assets, 'assets')).filter(file => /\.(js|css)$/.test(file)).sort().map(file => 'assets/' + file)]
  .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex')]));
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const phase = value => { report.phase = value; console.log('PHASE', value); persist(); };
const pass = value => { report.checks.push(value); console.log('PASS', value); persist(); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, accept, description, timeout = 45000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    last = await read();
    if (accept(last)) return last;
    await pause(100);
  }
  report.lastState = { description, value: last }; persist();
  throw Error(description + ' timed out');
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let browser, harness, workspace, status, releaseConflict;
const pages = [];
const kinds = new WeakMap();
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
async function startServer() {
  assert.ok(fs.existsSync(path.join(assets, 'index.html')), 'Build the frontend before running this helper');
  assert.ok(fs.existsSync(binary), 'Build the small production HTTP harness before this helper');
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sync-browser-'));
  harness = spawn(binary, [assets, workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
  const started = deferred(); let stderr = '';
  harness.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = readline.createInterface({ input: harness.stdout });
  lines.on('line', line => {
    try { const value = JSON.parse(line); if (value.ready) started.resolve(value.ready); }
    catch { report.harnessOutputError = 'Invalid harness JSON'; }
  });
  harness.on('exit', code => { report.harnessExit = code; if (!status) started.resolve({ error: stderr || `Exit ${code}` }); });
  harness.on('error', error => started.resolve({ error: String(error) }));
  const timer = setTimeout(() => started.resolve({ error: 'HTTP harness startup timed out' }), 15000);
  status = await started.promise; clearTimeout(timer);
  assert.equal(status.running, true, status.error);
  assert.ok(status.localUrl && status.lanUrls.length, 'Harness must expose both loopback and actual LAN addresses');
  const lan = status.lanUrls.find(value => !['127.0.0.1', 'localhost'].includes(new URL(value).hostname));
  assert.ok(lan, 'Do not substitute localhost for the insecure LAN context');
  report.origins = { loopback: new URL(status.localUrl).origin, lan: new URL(lan).origin };
  return { loopback: status.localUrl, lan };
}
async function api(route) {
  const response = await fetch(new URL(route, status.localUrl));
  assert.equal(response.status, 200, 'Production HTTP GET ' + route);
  return response.json();
}
function inspectBytes(base64, label) {
  const file = path.join(output, label + '.xlsx'), bytes = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, bytes);
  const result = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'office-sheet-inspect-xlsx.py'), file], { encoding: 'utf8' }));
  const entry = { file: path.basename(file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  report.files = report.files.filter(item => item.file !== entry.file); report.files.push(entry);
  return result.sheets[0].cells;
}
async function serverCells(id, label) {
  const document = await api('_sync/documents/' + id);
  return { document, cells: inspectBytes(document.base64, label) };
}
const editor = page => page.getByTestId(`rust-${kinds.get(page) || 'sheet'}-editor`).filter({ visible: true });
async function editorCall(page, method, ...args) {
  return page.evaluate(async ({ kind, method, args }) => {
    // Production Vue omits the development-only DOM component backlink. Read
    // the mounted vnode tree instead; do not alter the app or create an engine.
    // Locate the live DOM and its component in this same task. Passing a node
    // from locator.evaluate can retain a retired node across remote adoption.
    let handle;
    const seen = new Set();
    function visit(vnode) {
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return;
      seen.add(vnode);
      const node = vnode.el;
      if (vnode.component?.exposed && node?.getAttribute?.('data-testid') === `rust-${kind}-editor` &&
          node.isConnected && node.getBoundingClientRect().width > 0) handle = vnode.component.exposed;
      if (vnode.component) visit(vnode.component.subTree);
      if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
    }
    visit(document.querySelector('#app')?._vnode);
    if (!handle?.[method]) throw Error('Actual mounted Rust ' + kind + ' handle lacks ' + method);
    return handle[method](...args);
  }, { kind: kinds.get(page) || 'sheet', method, args });
}
const inspect = page => editorCall(page, 'inspect');
const cell = (page, address) => editorCall(page, 'query', 'cell.get', { cell: address });
async function backgroundReady(page, description) {
  await until(() => editorCall(page, 'canBackgroundExport'), value => value === true, description + ' permits a read-only background snapshot');
}
async function ready(page) {
  await page.waitForFunction(kind => {
    const error = document.querySelector('.error-banner');
    if (error) throw Error(error.textContent);
    return [...document.querySelectorAll(`[data-testid="rust-${kind}-editor"]`)]
      .some(node => node.getBoundingClientRect().width > 0 && node.dataset.ready === 'true') && !document.querySelector('.busy-overlay');
  }, kinds.get(page) || 'sheet', { timeout: 90000 });
}
async function writeCell(page, address, value) {
  const trace = async step => {
    const state = await inspect(page);
    const dom = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute('data-testid'),
      tag: document.activeElement?.tagName, panel: !!document.querySelector('[data-testid="server-panel"]'),
      events: (window.__syncInputTrace || []).slice(-12) }));
    (report.inputSteps ||= []).push({ address, step, time: new Date().toISOString(), sessionId: state.sessionId,
      documentId: state.documentId, revision: state.revision, mode: state.ui?.mode, editor: state.ui?.editor, dom }); persist();
    return state;
  };
  await page.bringToFront(); await ready(page);
  const snapshot = await until(() => inspect(page), value => value.ui?.visibleCells?.some(item => item.cell === address), 'Rendered cell ' + address);
  const rect = snapshot.ui.visibleCells.find(item => item.cell === address).rect;
  const bounds = await editor(page).getByTestId('office-sheet-canvas').boundingBox();
  assert.ok(bounds && rect[2] > 0 && rect[3] > 0, 'Use actual rendered cell geometry');
  await page.mouse.click(bounds.x + rect[0] + rect[2] / 2, bounds.y + rect[1] + rect[3] / 2);
  await until(() => editorCall(page, 'query', 'document.inspect'), value => value.activeCell === address, 'Cell selection ' + address);
  await trace('selected');
  await page.keyboard.press('F2');
  await until(() => inspect(page), state => state.ui?.mode === 'Edit' && state.ui?.editor?.cell === address, 'Rust cell editor ' + address);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'office-sheet-input');
  const editing = await trace('editing');
  if (address === 'B1') {
    // An ordinary pause during cell editing must not let background sync flush
    // or replace the editor before the user explicitly confirms the draft.
    await pause(3500);
    const idle = await trace('idle-editing');
    assert.equal(idle.sessionId, editing.sessionId, 'Background synchronization must not replace an active cell draft');
    assert.equal(idle.ui?.mode, 'Edit', 'Background synchronization must not confirm an active cell draft');
    assert.equal(idle.ui?.editor?.cell, address);
    assert.equal(await editorCall(page, 'canBackgroundExport'), false, 'An active cell editor blocks background export');
  }
  await page.keyboard.press('Control+a'); await page.keyboard.insertText(value);
  await until(() => inspect(page), state => state.ui?.editor?.cell === address && state.ui.editor.text === value, 'Actual browser draft ' + address);
  await trace('typed');
  if (address === 'B1') {
    await pause(3500);
    const draft = await trace('idle-typed');
    assert.equal(draft.sessionId, editing.sessionId, 'Background synchronization must retain the session with unconfirmed text');
    assert.equal(draft.ui?.mode, 'Edit', 'An idle text draft still requires explicit user confirmation');
    assert.equal(draft.ui?.editor?.text, value, 'Unconfirmed text remains intact during background synchronization');
    assert.equal((await cell(page, address)).value, null, 'Idle synchronization must not commit the draft into the workbook');
    assert.equal(await editorCall(page, 'canBackgroundExport'), false, 'Typed but unconfirmed cell text blocks background export');
  }
  await page.keyboard.press('Enter');
  await until(() => cell(page, address), result => result.value === value, 'Actual browser input ' + address);
  await trace('committed');
  await backgroundReady(page, 'Confirmed cell ' + address);
}
async function closePanel(page) { if (await page.getByTestId('server-close').isVisible()) await page.getByTestId('server-close').click(); }
async function openShared(page, document) {
  if (!await page.getByTestId('server-panel').isVisible()) await page.getByTestId('shell-server').click();
  await page.getByRole('button', { name: '打开文档 ' + document.name, exact: true }).click();
  await ready(page);
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(output, name + '.png') });
  await backgroundReady(page, name);
  const exported = await editorCall(page, 'exportFile', { format: 'xlsx', background: true });
  const current = await inspect(page);
  assert.equal(exported.revision, `${current.documentId}:${current.revision}`);
  return inspectBytes(exported.base64, name);
}
async function openBrowser(url, label, kind = 'sheet') {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage(); pages.push(page); kinds.set(page, kind); page.setDefaultTimeout(45000);
  await page.addInitScript(() => {
    window.__syncInputTrace = [];
    for (const type of ['pointerdown', 'keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'focusin', 'focusout']) {
      document.addEventListener(type, event => {
        window.__syncInputTrace.push({ time: performance.now(), type, key: event.key, data: event.data,
          target: event.target?.getAttribute?.('data-testid'), focus: document.activeElement?.getAttribute('data-testid') });
        if (window.__syncInputTrace.length > 40) window.__syncInputTrace.shift();
      }, true);
    }
  });
  page.on('pageerror', error => report.errors.push({ client: label, message: error.message }));
  page.on('download', download => report.downloads.push({ client: label, filename: download.suggestedFilename() }));
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/_sync/documents')) {
      const body = request.postDataJSON();
      report.requests.push({ client: label, status: response.status(), id: body.id, expectedVersion: body.expectedVersion, name: body.name });
    }
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200, label + ' must receive the actual packaged application');
  await page.getByTestId('server-panel').waitFor();
  return page;
}

const independentTextScript = `import sys,json,zipfile,xml.etree.ElementTree as ET
file,extension=sys.argv[1:]
if extension=='pdf':
 import fitz
 with fitz.open(file) as document: text='\\n'.join(page.get_text() for page in document)
else:
 with zipfile.ZipFile(file) as package:
  names=['word/document.xml'] if extension=='docx' else sorted(name for name in package.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml'))
  text='\\n'.join(''.join(node.text or '' for node in ET.fromstring(package.read(name)).iter() if node.tag.endswith('}t')) for name in names)
print(json.dumps({'text':text},ensure_ascii=False))`;
function inspectText(base64, extension, label) {
  const file = path.join(output, label + '.' + extension), bytes = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, bytes);
  const result = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', independentTextScript, file, extension], { encoding: 'utf8' }));
  const entry = { file: path.basename(file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  report.files = report.files.filter(item => item.file !== entry.file); report.files.push(entry);
  return result.text;
}
const contains = (text, token) => text.replace(/\s/g, '').includes(token.replace(/\s/g, ''));
async function modelText(page, kind) {
  if (kind === 'word') return (await inspect(page)).text;
  if (kind === 'presentation') return (await editorCall(page, 'query', 'slide.inspect', { index: 0 })).shapes.map(shape => shape.text || '').join('\n');
  return (await editorCall(page, 'query', 'document.inspect')).texts.join('\n');
}
async function addModelText(page, kind, text, second = false) {
  await page.bringToFront(); await ready(page);
  if (kind === 'word') {
    await editorCall(page, 'command', 'caret.docEnd');
    await editorCall(page, 'command', 'text.insert', { text: ' ' + text });
  } else if (kind === 'presentation') {
    await editorCall(page, 'command', 'insert.textBox', { rect: [80, second ? 200 : 80, 600, 90], text });
    await editorCall(page, 'command', 'text.exit');
  } else {
    await editorCall(page, 'command', 'pdf.addText', { page: 0, text, rect: [72, second ? 540 : 650, 500, second ? 610 : 720], size: 18 });
  }
  assert.ok(contains(await modelText(page, kind), text), 'Command must mutate the actual Rust document model');
  await backgroundReady(page, kind + ' confirmed model change');
}
async function verifyFormat(urls, kind, extension) {
  phase('shared-' + kind + '-round-trip');
  // Destroy both browser contexts and the browser between formats. No four
  // WASM renderers are held in memory together on constrained test machines.
  await browser.close(); browser = await launch();
  const local = await openBrowser(urls.loopback, kind + '-loopback', kind);
  const lan = await openBrowser(urls.lan, kind + '-lan', kind);
  await closePanel(local); await local.locator('.create-card.' + kind).click(); await ready(local);
  const firstText = `LOCAL_${kind.toUpperCase()}_共享文字`, secondText = `LAN_${kind.toUpperCase()}_返回修改`;
  await addModelText(local, kind, firstText);
  let summary;
  await until(async () => {
    const state = await api('_sync/state'); summary = state.documents.find(item => item.extension === extension);
    if (!summary) return '';
    const document = await api('_sync/documents/' + summary.id);
    return inspectText(document.base64, extension, kind + '-published');
  }, value => contains(value, firstText), kind + ' publishes independently readable content');
  await openShared(lan, summary);
  assert.ok(contains(await modelText(lan, kind), firstText), 'LAN admission uses the shared bytes');
  const previous = (await inspect(local)).sessionId;
  await addModelText(lan, kind, secondText, true);
  await until(() => modelText(local, kind), value => contains(value, secondText), kind + ' receives LAN model changes');
  assert.notEqual((await inspect(local)).sessionId, previous, 'Remote updates replace the live Rust model');
  for (const [label, page] of [['loopback', local], ['lan', lan]]) {
    await backgroundReady(page, kind + ' ' + label);
    const exported = await editorCall(page, 'exportFile', { format: extension, background: true });
    const text = inspectText(exported.base64, extension, `${kind}-${label}-final`);
    assert.ok(contains(text, firstText) && contains(text, secondText), kind + ' independent export preserves both edits');
    assert.equal(await page.locator('.document-tab').count(), 1);
    assert.equal(await page.locator('.document-tab.active .dirty-dot').count(), 1);
    const canvas = editor(page).locator('canvas');
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100, kind + ' actual editor canvas remains visible');
    await page.screenshot({ path: path.join(output, `${kind}-${label}-final.png`) });
  }
  pass(`${kind}: actual Rust model changes traverse HTTP both ways and independent ${extension.toUpperCase()} exports retain both edits`);
  await local.context().close(); await lan.context().close();
}

(async () => {
  try {
    phase('start-production-server-and-real-LAN-context');
    report.productsBefore = products();
    const urls = await startServer();
    browser = await launch();
    const local = await openBrowser(urls.loopback, 'loopback'), lan = await openBrowser(urls.lan, 'lan');
    report.capabilities = {};
    for (const [label, page] of [['loopback', local], ['lan', lan]]) report.capabilities[label] = await page.evaluate(() => ({
      secureContext: isSecureContext, crossOriginIsolated, randomUUID: typeof crypto.randomUUID,
      subtle: typeof crypto.subtle, randomValues: typeof crypto.getRandomValues, wasm: typeof WebAssembly }));
    assert.equal(report.capabilities.lan.secureContext, false);
    assert.equal(report.capabilities.lan.randomUUID, 'undefined');
    assert.equal(report.capabilities.lan.subtle, 'undefined');
    assert.equal(report.capabilities.lan.randomValues, 'function');
    pass('LAN HTTP uses normal browser security without a randomUUID/subtle polyfill');

    phase('loopback-edit-is-published-and-opened-on-LAN');
    await closePanel(local); await local.locator('.create-card.sheet').click(); await ready(local);
    await writeCell(local, 'A1', '本机同步 中文😀');
    let first;
    await until(async () => {
      const state = await api('_sync/state'); first = state.documents.find(item => item.extension === 'xlsx');
      return first ? (await serverCells(first.id, 'initial-shared')).cells.A1?.value : null;
    }, value => value === '本机同步 中文😀', 'Automatic loopback snapshot persists');
    await openShared(lan, first);
    assert.equal((await cell(lan, 'A1')).value, '本机同步 中文😀');
    assert.equal(await local.locator('.document-tab').count(), 1);
    assert.equal(await lan.locator('.document-tab').count(), 1);
    assert.equal(await local.locator('.document-tab.active .dirty-dot').count(), 1, 'Synchronization must retain file dirty state');
    assert.equal(await local.getByTestId('shell-autosave').getAttribute('aria-checked'), 'true');
    const controls = await local.evaluate(() => {
      const save = document.querySelector('[data-testid="shell-save"]'), auto = document.querySelector('[data-testid="shell-autosave"]');
      const a = save.getBoundingClientRect(), b = auto.getBoundingClientRect();
      return { after: !!(save.compareDocumentPosition(auto) & Node.DOCUMENT_POSITION_FOLLOWING), dx: b.x - a.right, dy: Math.abs(b.y - a.y) };
    });
    assert.ok(controls.after && controls.dx >= -2 && controls.dx < 180 && controls.dy < 15, 'Autosave belongs beside Save');
    await local.screenshot({ path: path.join(output, 'global-save-autosave.png'), clip: { x: 0, y: 0, width: 1600, height: 100 } });
    pass('Real XLSX editing automatically reaches LAN; dirty state and global Save/Autosave placement remain correct');

    phase('bidirectional-remote-model-replacement');
    const localSession = (await inspect(local)).sessionId;
    await writeCell(lan, 'B1', '局域网回传');
    await until(() => cell(local, 'B1'), value => value.value === '局域网回传', 'LAN changes replace the synchronized loopback model');
    assert.notEqual((await inspect(local)).sessionId, localSession, 'Remote bytes are admitted into a new real Rust model');
    await writeCell(local, 'C1', '本机再次修改');
    await until(() => cell(lan, 'C1'), value => value.value === '本机再次修改', 'Loopback changes replace the synchronized LAN model');
    for (const [label, page] of [['loopback-bidirectional', local], ['lan-bidirectional', lan]]) {
      const cells = await capture(page, label);
      assert.equal(cells.A1.value, '本机同步 中文😀'); assert.equal(cells.B1.value, '局域网回传'); assert.equal(cells.C1.value, '本机再次修改');
      assert.equal(await page.locator('.document-tab').count(), 1, 'Remote replacement does not lose or duplicate tabs');
    }
    pass('Both directions update actual Rust models, and independent XLSX inspection confirms all edits');

    phase('concurrent-edits-use-real-CAS-and-preserve-both-versions');
    const pending = deferred(), release = deferred(); releaseConflict = release.resolve;
    let gated = false;
    await lan.route('**/_sync/documents', async route => {
      if (route.request().method() !== 'POST' || gated) return route.continue();
      gated = true; pending.resolve(route.request().postDataJSON());
      await release.promise; await route.continue();
    });
    await writeCell(lan, 'D1', '保留局域网分支');
    const blocked = await Promise.race([pending.promise, pause(10000).then(() => { throw Error('LAN publish did not reach the controlled request gate'); })]);
    assert.equal(blocked.id, first.id);
    await writeCell(local, 'D1', '保留本机分支');
    await until(async () => (await api('_sync/state')).documents.find(item => item.id === first.id),
      value => value?.version > blocked.expectedVersion, 'Loopback wins the common base revision', 10000);
    release.resolve(); releaseConflict = undefined;
    const conflict = await until(async () => (await api('_sync/state')).documents.find(item => item.id !== first.id && item.name.includes('冲突副本')),
      Boolean, 'Conflicting LAN changes are preserved as a distinct shared document');
    await until(() => lan.locator('.document-tab.active').innerText(), value => value.includes('冲突副本'), 'Conflict copy remains the active LAN tab');
    const canonical = await serverCells(first.id, 'canonical-after-conflict'), fork = await serverCells(conflict.id, 'conflict-after-conflict');
    assert.equal(canonical.cells.D1.value, '保留本机分支'); assert.equal(fork.cells.D1.value, '保留局域网分支');
    assert.equal((await cell(local, 'D1')).value, '保留本机分支'); assert.equal((await cell(lan, 'D1')).value, '保留局域网分支');
    assert.ok(report.requests.some(item => item.client === 'lan' && item.id === first.id && item.status === 409), 'A real stale HTTP publish must receive CAS 409');
    assert.equal(await lan.locator('.document-tab.active .dirty-dot').count(), 1);
    await local.screenshot({ path: path.join(output, 'loopback-conflict.png') });
    await lan.screenshot({ path: path.join(output, 'lan-conflict.png') });
    pass('Actual HTTP CAS rejects the stale writer; canonical and conflict XLSX bytes retain both branches without silent overwrite');

    await local.getByTestId('shell-server').click();
    await local.getByRole('button', { name: '打开文档 ' + conflict.name, exact: true }).waitFor();
    // The browser panel shows shared documents, without the desktop's token URL.
    await local.screenshot({ path: path.join(output, 'browser-server-panel.png') });
    await closePanel(local);

    await local.context().close(); await lan.context().close();
    const formats = new Set((process.env.OFFICE_SYNC_FORMATS ?? 'word,presentation,pdf').split(',').filter(Boolean));
    for (const [kind, extension] of [['word', 'docx'], ['presentation', 'pptx'], ['pdf', 'pdf']]) {
      if (formats.has(kind)) await verifyFormat(urls, kind, extension);
    }

    assert.deepEqual(report.errors, []); assert.deepEqual(report.downloads, [], 'Automatic synchronization never triggers browser file downloads');
    report.finalDocuments = (await api('_sync/state')).documents;
    report.productsAfter = products(); assert.deepEqual(report.productsAfter, report.productsBefore, 'Packaged frontend must stay unchanged during verification');
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    for (let index = 0; index < pages.length; index++) await pages[index].screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  } finally {
    releaseConflict?.();
    await browser?.close();
    if (harness && harness.exitCode === null) {
      harness.stdin.end();
      await Promise.race([new Promise(resolve => harness.once('exit', resolve)), pause(3000)]);
      if (harness.exitCode === null) harness.kill('SIGTERM');
    }
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString(); persist();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
