/* Real Rust engine acceptance: the identical WASM/CLI protocol, the actual app
 * keyboard and SVG UI, and an external ZIP/XML oracle. No mocked invoke, legacy
 * TypeScript model, Office runtime, or product-produced input-only oracle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { chromium } = require('playwright');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.RUST_WORD_OUTPUT || path.join(root, 'test-results/rust-word-engine'));
const corpus = path.join(root, 'crates/word-engine/tests/fixtures/basic-docx');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const textOf = document => document.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
const oracle = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'rust-word-docx-oracle.py'), file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const base64 = file => fs.readFileSync(file).toString('base64');
const report = { ok: false, startedAtUtc: new Date().toISOString(),
  scope: 'Real Rust WASM, same-crate native CLI, actual default app editing UI and independent complete DOCX/XML verification',
  limitations: ['Chromium event-driven composition is not an operating-system IME test.', 'The CLI validates native Rust behavior, not native Tauri IPC or file dialogs.', 'First-phase supported document subset only; unsupported features must reject.'],
  checks: [], protocol: [], fixtures: [], files: [], pageErrors: [], consoleErrors: [], externalRequests: [], forbiddenRequests: [], wasmRequests: [] };
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
let phase = 'initialization', server, browser, page, nativeProcess, hashedProducts = [], hashedTests = [];

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ?
    (['target', 'node_modules'].includes(item.name) ? [] : filesUnder(path.join(directory, item.name))) : [path.join(directory, item.name)]);
}
function productFiles() {
  return ['src/App.vue', 'src/native.ts', 'src/types.ts', 'src/shared/document.ts', 'src/style.css', 'package.json', 'src/components/RustWordEditor.vue',
    'src-tauri/src/lib.rs', 'src-tauri/src/main.rs', 'src-tauri/src/word.rs', 'src-tauri/build.rs', 'src-tauri/Cargo.toml',
    'scripts/build-word-engine.mjs', 'public/word-engine/manifest.json',
    ...filesUnder(path.join(root, 'src/word/rust')), ...filesUnder(path.join(root, 'crates/word-engine')), ...filesUnder(path.join(root, 'crates/word-package/src'))]
    .map(file => path.resolve(root, file)).filter(file => fs.existsSync(file) && !file.endsWith('/Cargo.lock'));
}
const hashes = files => Object.fromEntries(files.map(file => [path.relative(root, file), sha(file)]));
const position = (paragraph, offset) => ({ paragraph, offset });
const selection = (paragraph, start, end = start, endParagraph = paragraph) => ({ anchor: position(paragraph, start), focus: position(endParagraph, end) });

async function loadWasm(file) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(file), {});
  const api = instance.exports;
  for (const name of ['memory', 'word_engine_alloc', 'word_engine_dealloc', 'word_engine_request', 'word_engine_result_len']) assert.ok(api[name], name);
  return request => {
    const input = new TextEncoder().encode(JSON.stringify(request));
    const ptr = api.word_engine_alloc(input.length) >>> 0;
    try {
      new Uint8Array(api.memory.buffer, ptr, input.length).set(input);
      const answer = api.word_engine_request(ptr, input.length) >>> 0;
      const length = api.word_engine_result_len() >>> 0;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(api.memory.buffer, answer, length).slice()));
    } finally { api.word_engine_dealloc(ptr, input.length); }
  };
}
function loadCli(file) {
  nativeProcess = spawn(file, [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = [];
  nativeProcess.stderr.on('data', data => { report.nativeStderr = (report.nativeStderr || '') + data; });
  readline.createInterface({ input: nativeProcess.stdout }).on('line', line => {
    const pending = waiting.shift();
    if (!pending) throw Error('Unexpected native CLI response');
    clearTimeout(pending.timer);
    try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
  });
  nativeProcess.on('exit', (code, signal) => {
    report.nativeExit = { code, signal };
    for (const pending of waiting.splice(0)) { clearTimeout(pending.timer); pending.reject(Error(`Native CLI exited ${code || signal}`)); }
  });
  return request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Native CLI timed out')), 30000);
    waiting.push({ resolve, reject, timer });
    nativeProcess.stdin.write(JSON.stringify(request) + '\n');
  });
}
function compareOracle(document, inspected, label) {
  assert.equal(inspected.unsupported.length, 0, label);
  assert.deepEqual(inspected.paragraphs.map(p => p.text), document.paragraphs.map(p => p.runs.map(r => r.text).join('')), label + ': text');
  assert.deepEqual(inspected.paragraphs.map(p => p.align), document.paragraphs.map(p => p.align), label + ': alignment');
  document.paragraphs.forEach((paragraph, index) => {
    const expected = paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, bold: run.style.bold, italic: run.style.italic, fontSize: run.style.fontSize, color: run.style.color, fontFamily: run.style.fontFamily })));
    const actual = inspected.paragraphs[index].characters.map(character => ({ character: character.character, bold: character.bold, italic: character.italic, fontSize: character.fontSize, color: character.color, fontFamily: character['font:ascii'] || character['font:hAnsi'] || 'DejaVu Sans' }));
    assert.deepEqual(actual, expected, label + ': characters ' + index);
    if (!expected.length && paragraph.runs.length) {
      const style = inspected.paragraphs[index].runs[0]?.style;
      assert.ok(style, label + ': empty paragraph formatting');
      for (const field of ['bold', 'italic', 'fontSize', 'color']) assert.equal(style[field], paragraph.runs[0].style[field], label + ': empty paragraph ' + field);
    }
  });
  for (const [key, number] of Object.entries(document.page)) assert.ok(Math.abs(inspected.page[key] - number) <= 0.026, label + ': page ' + key);
}

async function protocolTests(wasmFile, cliFile) {
  const wasm = await loadWasm(wasmFile), cli = loadCli(cliFile);
  async function request(input) {
    const actual = wasm(input), native = await cli(input);
    // ZIP creation timestamps may differ. Decode exports independently below.
    assert.deepEqual({ ...actual, base64: undefined }, { ...native, base64: undefined }, 'WASM/native semantic and layout parity');
    if (actual.base64) {
      const wasmParts = unzipSync(Buffer.from(actual.base64, 'base64')), nativeParts = unzipSync(Buffer.from(native.base64, 'base64'));
      assert.deepEqual(Object.keys(wasmParts).sort(), Object.keys(nativeParts).sort());
      for (const key of Object.keys(wasmParts)) assert.deepEqual(wasmParts[key], nativeParts[key], 'native/WASM export member ' + key);
    }
    report.protocol.push({ op: input.op, command: input.command?.type, ok: actual.ok, revision: actual.snapshot?.revision, error: actual.error });
    return actual;
  }
  let snapshot;
  async function accepted(input) { const result = await request(input); assert.equal(result.ok, true, result.error); if (result.snapshot) snapshot = result.snapshot; return result; }
  const command = value => accepted({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision, command: value });
  async function rejected(input, message) {
    const before = structuredClone(snapshot), result = await request(input);
    assert.equal(result.ok, false, message); assert.ok(result.error);
    const current = await request({ op: 'export', sessionId: 'qa', expectedRevision: before.revision });
    assert.equal(current.ok, true, current.error); assert.deepEqual(current.snapshot, before, message + ': failure atomicity');
    return result.error;
  }
  await accepted({ op: 'create', sessionId: 'qa' });
  assert.equal(textOf(snapshot.document), ''); assert.equal(snapshot.dirty, false); assert.equal(snapshot.canUndo, false);
  const initial = structuredClone(snapshot.document);
  await command({ type: 'replaceText', text: 'A中😀e\u0301\r\n第二段\r第三段' });
  assert.equal(textOf(snapshot.document), 'A中😀e\u0301\n第二段\n第三段');
  assert.equal(snapshot.dirty, true); assert.equal(snapshot.canUndo, true);
  const inserted = structuredClone(snapshot.document);
  for (const offset of [3, 5]) await rejected({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision, command: { type: 'select', selection: selection(0, offset) } }, 'reject non-grapheme boundary ' + offset);
  await rejected({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision, command: { type: 'replaceText', text: '👨‍👩‍👧‍👦' } }, 'reject unsupported ZWJ glyph sequence');
  await rejected({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision - 1, command: { type: 'deleteBackward' } }, 'reject stale revision');
  await rejected({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision, command: { type: 'replaceText', text: 'bad', unexpected: true } }, 'reject unknown command field');
  await rejected({ op: 'create', sessionId: 'qa', unexpected: true }, 'reject unknown request field');
  await rejected({ op: 'open', sessionId: 'qa', base64: Buffer.from('broken ZIP').toString('base64') }, 'reject corrupt package');
  await command({ type: 'undo' }); assert.deepEqual(snapshot.document, initial); assert.equal(snapshot.dirty, false);
  await command({ type: 'redo' }); assert.deepEqual(snapshot.document, inserted);
  await command({ type: 'select', selection: selection(0, 6) });
  await command({ type: 'deleteBackward' }); assert.equal(snapshot.document.paragraphs[0].runs.map(r => r.text).join(''), 'A中😀');
  await command({ type: 'deleteBackward' }); assert.equal(snapshot.document.paragraphs[0].runs.map(r => r.text).join(''), 'A中');
  await command({ type: 'undo' }); assert.equal(snapshot.document.paragraphs[0].runs.map(r => r.text).join(''), 'A中😀');
  await command({ type: 'selectAll' });
  await command({ type: 'format', bold: true, italic: true, fontSize: 18, color: '#C00000' });
  await command({ type: 'align', alignment: 'center' });
  assert.equal(snapshot.format.bold, true); assert.equal(snapshot.format.color, '#C00000'); assert.equal(snapshot.format.align, 'center');
  for (const commandValue of [{ type: 'format', fontSize: 7 }, { type: 'format', color: 'transparent' }, { type: 'replaceText', text: 'x'.repeat(10001) }, { type: 'replaceText', text: '\n'.repeat(500) }]) await rejected({ op: 'command', sessionId: 'qa', expectedRevision: snapshot.revision, command: commandValue }, 'reject invalid/over-limit command');
  const exported = await accepted({ op: 'export', sessionId: 'qa', expectedRevision: snapshot.revision });
  assert.equal(snapshot.dirty, true, 'export alone cannot mark saved');
  const savedFile = path.join(output, 'protocol-export.docx'); fs.writeFileSync(savedFile, Buffer.from(exported.base64, 'base64'));
  compareOracle(snapshot.document, oracle(savedFile), 'protocol export');
  const savedDocument = structuredClone(snapshot.document);
  await command({ type: 'markSaved' }); assert.equal(snapshot.dirty, false);
  await command({ type: 'replaceText', text: 'changed' }); assert.equal(snapshot.dirty, true);
  await command({ type: 'undo' }); assert.equal(snapshot.dirty, false); assert.deepEqual(snapshot.document, savedDocument);
  await accepted({ op: 'open', sessionId: 'qa', base64: exported.base64 });
  assert.deepEqual(snapshot.document, savedDocument); assert.equal(snapshot.canUndo, false); assert.equal(snapshot.dirty, false);
  await command({ type: 'selectAll' });
  await command({ type: 'replaceText', text: 'A\tB\nC\t中文' });
  await command({ type: 'selectAll' }); await command({ type: 'align', alignment: 'left' });
  await command({ type: 'select', selection: selection(0, 2) });
  assert.ok(Math.abs(snapshot.layout.caret.x - (snapshot.document.page.marginLeft + 36)) < 0.001, 'Rust default tab stop is 36 points from the text origin');
  const tabSaved = await accepted({ op: 'export', sessionId: 'qa', expectedRevision: snapshot.revision });
  const tabFile = path.join(output, 'protocol-tabs.docx'); fs.writeFileSync(tabFile, Buffer.from(tabSaved.base64, 'base64'));
  const tabXml = oracle(tabFile); assert.equal(tabXml.defaultTabStop, 36); compareOracle(snapshot.document, tabXml, 'tab export');
  await accepted({ op: 'open', sessionId: 'qa', base64: tabSaved.base64 }); assert.equal(textOf(snapshot.document), 'A\tB\nC\t中文');
  report.files.push({ file: path.relative(root, tabFile), sha256: sha(tabFile) });
  for (const id of ['two', 'three', 'four']) { const response = await request({ op: 'create', sessionId: id }); assert.equal(response.ok, true); }
  await rejected({ op: 'create', sessionId: 'five' }, 'reject fifth session');
  for (const id of ['two', 'three', 'four']) assert.equal((await request({ op: 'close', sessionId: id })).ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
  for (const artifact of manifest.artifacts) assert.equal(sha(path.join(corpus, artifact.path)), artifact.sha256, artifact.path + ': corpus hash');
  for (const fixture of manifest.fixtures) {
    const source = path.join(corpus, fixture.source), original = oracle(source), native = oracle(path.join(corpus, fixture.nativeDocx));
    // The source packages were independently authored, then accepted unchanged
    // by native Writer. We compare body semantics of Writer's complete resave;
    // its additional language/kerning/script properties remain a deliberate
    // import-negative boundary.
    const body = value => value.paragraphs.map(paragraph => ({ text: paragraph.text, align: paragraph.align, characters: paragraph.characters.map(({ character, bold, italic, fontSize, color }) => ({ character, bold, italic, fontSize, color })) }));
    assert.deepEqual(body(native), body(original), fixture.name + ': independent native body semantics');
    await accepted({ op: 'open', sessionId: 'qa', base64: base64(source) });
    compareOracle(snapshot.document, original, fixture.name + ': independent input');
    const opened = structuredClone(snapshot.document);
    for (let round = 1; round <= 2; round++) {
      const saved = await accepted({ op: 'export', sessionId: 'qa', expectedRevision: snapshot.revision });
      const file = path.join(output, `${fixture.name}-round-${round}.docx`);
      fs.writeFileSync(file, Buffer.from(saved.base64, 'base64')); compareOracle(opened, oracle(file), fixture.name + ': independent output round ' + round);
      await accepted({ op: 'open', sessionId: 'qa', base64: saved.base64 }); assert.deepEqual(snapshot.document, opened);
      report.files.push({ file: path.relative(root, file), sha256: sha(file) });
    }
    const nativeReason = await rejected({ op: 'open', sessionId: 'qa', base64: base64(path.join(corpus, fixture.nativeDocx)) }, fixture.name + ': native semantics outside first-phase model');
    report.fixtures.push({ name: fixture.name, sourceSha256: sha(source), nativeSha256: sha(path.join(corpus, fixture.nativeDocx)), acceptedSource: true, nativeOutputRejected: true, nativeReason });
  }
  report.files.push({ file: path.relative(root, savedFile), sha256: sha(savedFile) });
  pass('Real WASM/native parity: Unicode graphemes, paragraphs, selection, atomic invalid/stale/limit requests, formatting, history, saved baseline and independent DOCX export');
  pass('Independently authored complete DOCX accepted by native Writer, actual Rust import and two export/reopen rounds match external XML; unsupported native resaves reject atomically');
  return { request, accepted, command, snapshot: () => snapshot };
}

const editor = () => page.locator('[data-testid="rust-word-editor"]:visible');
const input = () => editor().getByTestId('rust-word-input');
async function idle({ allowError = false } = {}) {
  await page.waitForFunction(allowError => {
    const error = document.querySelector('.error-banner');
    if (error && !allowError) throw Error(error.textContent);
    const editor = [...document.querySelectorAll('[data-testid="rust-word-editor"]')].find(node => node.getBoundingClientRect().width > 0);
    return editor?.getAttribute('data-ready') === 'true' && !editor.querySelector('[data-testid="rust-word-font-size"]')?.disabled && !document.querySelector('.busy-overlay');
  }, allowError);
  assert.equal(await page.locator('iframe').count(), 0, 'Rust main path must not embed Office');
}
async function focusInput() { await input().focus(); }
async function copySelection() {
  await focusInput(); await page.keyboard.press('Control+c');
  return page.evaluate(() => navigator.clipboard.readText());
}
async function readAllText() {
  await focusInput(); await page.keyboard.press('Control+a'); await idle();
  const result = await copySelection();
  await page.keyboard.press('ArrowRight'); await idle();
  return result;
}
async function expectText(text) { assert.equal(await readAllText(), text); }
async function newDocument() {
  const home = page.getByRole('button', { name: '工作台', exact: true });
  if (await home.isVisible()) await home.click();
  await page.locator('.create-card.word').click(); await idle();
}
async function openFile(file, shortcut = false) {
  const choice = page.waitForEvent('filechooser');
  if (shortcut) await page.keyboard.press('Control+o');
  else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await choice).setFiles(file);
}
async function saveFile(filename, expectedText) {
  const pending = page.waitForEvent('download');
  await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click();
  const download = await pending, destination = path.join(output, filename);
  assert.match(download.suggestedFilename(), /\.docx$/i); await download.saveAs(destination); await idle();
  const inspected = oracle(destination);
  if (expectedText !== undefined) assert.equal(inspected.paragraphs.map(p => p.text).join('\n'), expectedText, filename);
  report.files.push({ file: path.relative(root, destination), sha256: sha(destination) });
  return { destination, inspected };
}
async function insert(text) { await focusInput(); await page.keyboard.insertText(text); await idle(); }
async function undo() { await editor().getByTestId('rust-word-undo').click(); await idle(); }
async function redo() { await editor().getByTestId('rust-word-redo').click(); await idle(); }
async function compose(text) {
  await focusInput();
  await input().evaluate((node, value) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    node.value = value;
    node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, text);
}

async function browserTests(wasmFile) {
  const { createServer } = await import('vite');
  server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, hmr: false,
    watch: { ignored: ['**/src-tauri/target/**', '**/crates/**/target/**', '**/test-results/**'] } } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
    if (/\/office-runtime\/|\/office\/host\.html|\/office\/runtime\/|soffice\.(?:js|wasm)|\/src\/word\/core\/(?:model|docx|dom|runtime)\.ts/.test(url)) report.forbiddenRequests.push(url);
    if (/word_engine\.wasm/.test(url)) report.wasmRequests.push(url);
  });
  await page.goto(origin);
  await newDocument();
  assert.ok(report.wasmRequests.length > 0, 'Actual default app must request the Rust WASM artifact');
  assert.equal(await editor().getAttribute('data-pages'), '1');
  assert.equal(await page.locator('[data-testid^="rust-word-page-"] text').count(), 0, 'Browser text must not replace Rust glyph outlines');
  await insert('Hello 中文😀e\u0301');
  await page.keyboard.press('Enter'); await idle();
  await insert('第二段');
  await expectText('Hello 中文😀e\u0301\n第二段');
  assert.ok(await editor().getByTestId('rust-word-page-0').locator('path').count() > 5, 'Rust returned visible glyph outlines');
  await saveFile('ui-unicode.docx', 'Hello 中文😀e\u0301\n第二段');
  pass('Default Word entry loads actual Rust WASM; Chinese, supported emoji, combining marks and Enter render as SVG outlines and survive independent DOCX inspection');

  phase = 'ui-composition-and-rapid-history';
  await compose('组合输入');
  // Saving immediately must flush the queued composition commit exactly once.
  await saveFile('ui-composition.docx', 'Hello 中文😀e\u0301\n第二段组合输入');
  await undo(); await expectText('Hello 中文😀e\u0301\n第二段');
  await redo(); await expectText('Hello 中文😀e\u0301\n第二段组合输入');
  await focusInput();
  await page.keyboard.type('abc', { delay: 0 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await idle(); await expectText('Hello 中文😀e\u0301\n第二段组合输入ab');
  await page.keyboard.press('Home'); await page.keyboard.press('Backspace'); await idle();
  await expectText('Hello 中文😀e\u0301第二段组合输入ab');
  await undo(); await expectText('Hello 中文😀e\u0301\n第二段组合输入ab');
  pass('IME composition is one undoable commit, immediate save flushes it, rapid commands retain order and boundary Backspace merges paragraphs');

  phase = 'ui-formatting-selection';
  await newDocument();
  await insert('abcdef');
  await page.keyboard.press('Home'); await idle();
  const caret = await editor().getByTestId('rust-word-caret').evaluate(node => ({ x: Number(node.getAttribute('x1')), y: (Number(node.getAttribute('y1')) + Number(node.getAttribute('y2'))) / 2 }));
  const rectangle = await editor().getByTestId('rust-word-page-0').boundingBox();
  const viewBox = await editor().getByTestId('rust-word-page-0').getAttribute('viewBox');
  const width = Number(viewBox.split(' ')[2]), scale = rectangle.width / width;
  await page.mouse.click(rectangle.x + (caret.x + 0.01) * scale, rectangle.y + caret.y * scale); await idle();
  await page.keyboard.down('Shift'); await page.mouse.click(rectangle.x + (caret.x + 200) * scale, rectangle.y + caret.y * scale); await page.keyboard.up('Shift'); await idle();
  assert.equal(await copySelection(), 'abcdef', 'Pointer coordinates must go through Rust hit testing');
  assert.ok(await editor().getByTestId('rust-word-selection').count() > 0);
  await page.keyboard.press('Control+x'); await idle();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'abcdef');
  await expectText(''); await undo(); await expectText('abcdef');
  await focusInput(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await idle();
  await editor().getByTestId('rust-word-bold').click(); await idle();
  await editor().getByTestId('rust-word-italic').click(); await idle();
  await editor().getByTestId('rust-word-font-size').selectOption('18'); await idle();
  await editor().getByTestId('rust-word-color').fill('#c00000'); await idle();
  await editor().getByTestId('rust-word-align').selectOption('center'); await idle();
  const formatted = await saveFile('ui-formatting.docx', 'abcdef');
  const characters = formatted.inspected.paragraphs[0].characters;
  assert.equal(formatted.inspected.paragraphs[0].align, 'center');
  for (const character of characters) assert.deepEqual({ bold: character.bold, italic: character.italic, fontSize: character.fontSize, color: character.color }, { bold: true, italic: true, fontSize: 18, color: '#C00000' });
  assert.ok((await editor().getByTestId('rust-word-page-0').locator('path').evaluateAll(nodes => nodes.map(n => n.getAttribute('fill')))).every(fill => fill === '#C00000'));
  await page.screenshot({ path: path.join(output, 'rust-word-desktop.png') });
  pass('Actual pointer selection, toolbar bold/italic/size/color/alignment, Rust outline fill and independent saved OOXML agree');

  phase = 'ui-failure-atomicity';
  await focusInput(); await page.keyboard.press('ArrowRight'); await idle(); await insert(' unsaved');
  const before = { text: await readAllText(), revision: await editor().getAttribute('data-revision'), tabs: await page.locator('.document-tab').count(), active: await page.locator('.document-tab.active .tab-name').innerText(), dirty: await page.locator('.document-tab.active .dirty-dot').count(), undo: await editor().getByTestId('rust-word-undo').isEnabled() };
  const damaged = path.join(output, 'damaged.docx'); fs.writeFileSync(damaged, Buffer.from('PK\x03\x04broken zip'));
  const negativeFiles = [path.join(root, 'tests/compatibility/independent-word/libreoffice/unsupported-table.docx'), damaged];
  negativeFiles.push(path.join(corpus, 'native-docx/basic-styles.docx'));
  for (const file of negativeFiles) {
    await openFile(file); await page.locator('.error-banner').waitFor(); await idle({ allowError: true });
    assert.equal(await editor().getAttribute('data-revision'), before.revision);
    assert.equal(await page.locator('.document-tab').count(), before.tabs);
    assert.equal(await page.locator('.document-tab.active .tab-name').innerText(), before.active);
    assert.equal(await page.locator('.document-tab.active .dirty-dot').count(), before.dirty);
    assert.equal(await editor().getByTestId('rust-word-undo').isEnabled(), before.undo);
    await page.getByRole('button', { name: '关闭错误提示' }).click();
    assert.equal(await readAllText(), before.text);
    before.revision = await editor().getAttribute('data-revision');
  }
  await undo(); await expectText('abcdef');
  pass('Opening real unsupported native DOCX and damaged ZIP preserves active tab, content, revision, dirty state and usable undo history');

  phase = 'ui-tabs-and-pagination';
  await insert(' retained');
  const previousName = await page.locator('.document-tab.active .tab-name').innerText();
  await newDocument(); await insert('Second tab');
  await page.locator('.document-tab .tab-name').filter({ hasText: previousName }).click(); await idle();
  await expectText('abcdef retained');
  assert.equal(await page.locator('.document-tab.active .dirty-dot').count(), 1, 'Returning to an unsaved tab must not mark it clean');
  await undo(); await expectText('abcdef');
  const text = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 行：Rust pagination 中文 text`).join('\n');
  await focusInput(); await page.keyboard.press('Control+a'); await idle(); await insert(text);
  assert.ok(Number(await editor().getAttribute('data-pages')) > 1, 'Rust must paginate a multi-page document');
  const pagination = await saveFile('ui-pagination.docx', text);
  const pageCount = await editor().getAttribute('data-pages');
  await openFile(pagination.destination, true); await idle();
  assert.equal(await editor().getAttribute('data-pages'), pageCount); await expectText(text);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.screenshot({ path: path.join(output, 'rust-word-narrow.png') });
  pass('Dirty Rust tabs retain text and history; pagination and Ctrl+O save/reopen retain all paragraph text and page count');
  phase = 'ui-independent-source-open';
  // A fresh actual app instance avoids consuming a fifth document session. It
  // receives the same immutable source used in native Writer, never a product
  // generated package masquerading as an independent fixture.
  await page.close(); page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(origin);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  const independentSource = path.join(corpus, 'basic-styles.docx');
  await (await chooser).setFiles(independentSource); await idle();
  const inspectRust = await loadWasm(wasmFile);
  const rustSource = inspectRust({ op: 'open', sessionId: 'independent-layout', base64: base64(independentSource) });
  assert.equal(rustSource.ok, true, rustSource.error);
  const drawnPages = await editor().locator('[data-testid^="rust-word-page-"]').evaluateAll(nodes => nodes.map(node => ({
    width: Number(node.getAttribute('viewBox').split(' ')[2]), height: Number(node.getAttribute('viewBox').split(' ')[3]),
    paths: [...node.querySelectorAll('path')].map(path => ({ d: path.getAttribute('d'), fill: path.getAttribute('fill') })),
  })));
  assert.deepEqual(drawnPages, rustSource.snapshot.layout.pages, 'Actual UI must draw precisely the Rust outline geometry');
  const independentText = oracle(independentSource).paragraphs.map(paragraph => paragraph.text).join('\n');
  await expectText(independentText);
  await saveFile('ui-independent-source.docx', independentText);
  await focusInput(); await page.keyboard.press('Control+a'); await idle();
  await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['Pasted 中文😀'], { type: 'text/plain' }), 'text/html': new Blob(['<b style="color:red">Pasted 中文😀</b>'], { type: 'text/html' }) })]));
  await page.keyboard.press('Control+v'); await idle(); await expectText('Pasted 中文😀');
  await undo(); await expectText(independentText);
  pass('Generic Open uses the same Rust path for an independent complete DOCX; actual clipboard paste inserts plaintext in one undo transaction');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
  assert.deepEqual(report.consoleErrors, []);
}

async function main() {
  try {
    const wasmFile = process.env.RUST_WORD_WASM || [path.join(root, 'public/word-engine/word_engine.wasm'), path.join(root, 'public/word-engine.wasm')].find(fs.existsSync);
    const cliFile = process.env.RUST_WORD_CLI || [path.join(root, 'crates/word-engine/target/debug/word-engine-cli'), path.join(root, 'src-tauri/target/debug/word-engine-cli')].find(fs.existsSync);
    assert.ok(wasmFile && cliFile, 'Build the real word-engine WASM and native CLI first (RUST_WORD_WASM/RUST_WORD_CLI override paths)');
    report.artifactCheck = execFileSync(process.execPath, ['scripts/build-word-engine.mjs', '--check'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const products = hashedProducts = [...productFiles(), wasmFile, cliFile];
    const testFiles = hashedTests = [__filename, path.join(__dirname, 'rust-word-docx-oracle.py'), path.join(corpus, 'manifest.json')];
    report.productsBefore = hashes(products); report.testsBefore = hashes(testFiles); persist();
    phase = 'real-protocol';
    await protocolTests(wasmFile, cliFile);
    nativeProcess.stdin.end();
    phase = 'actual-app';
    if (process.env.RUST_WORD_PROTOCOL_ONLY !== '1') await browserTests(wasmFile);
    else report.limitations.push('This invocation intentionally ran protocol checks only; no UI acceptance claimed.');
    report.productsAfter = hashes(products); report.testsAfter = hashes(testFiles);
    assert.deepEqual(report.productsAfter, report.productsBefore, 'Product artifacts changed during verification');
    assert.deepEqual(report.testsAfter, report.testsBefore, 'Test changed during verification');
    report.ok = true;
  } catch (error) { report.failure = { phase, message: error.message, stack: error.stack }; throw error; }
  finally {
    if (hashedProducts.length) report.productsAfter = hashes(hashedProducts);
    if (hashedTests.length) report.testsAfter = hashes(hashedTests);
    if (report.failure && page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(output, 'failure.png') }); } catch { /* Preserve the original failure. */ }
    }
    report.finishedAtUtc = new Date().toISOString(); persist();
    if (browser) await browser.close();
    if (server) await server.close();
    if (nativeProcess) nativeProcess.stdin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
