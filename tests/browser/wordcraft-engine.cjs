/* WordCraft integration acceptance. This script uses the real local WASM and
 * WordApp canvas, real browser input and independently inspected DOCX/PDF bytes.
 * It never mocks invoke, supplies a replacement editor, or imports the legacy
 * TypeScript document model. Run only after the host/UI/build are frozen. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.WORDCRAFT_OUTPUT || path.join(root, 'test-results/wordcraft-engine'));
const corpus = path.join(root, 'tests/compatibility/wordcraft-core');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  ok: false, startedAtUtc: new Date().toISOString(),
  scope: 'Real locally built WordCraft WASM and original WordApp canvas/ribbon inside the default Vue shell',
  limitations: [
    'Chromium composition events validate the browser event path, not a physical operating-system IME.',
    'Headless Chromium validates the browser integration, not Tauri WebKit/WebView2 GPU or native file dialogs.',
    'Only explicitly exercised features and inspected fixture fields are covered; upstream feature counts are not acceptance evidence.',
  ],
  checks: [], files: [], pageErrors: [], consoleErrors: [], externalRequests: [], forbiddenRequests: [], wasmRequests: [],
};
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = (name, details) => { report.checks.push({ name, ...details }); console.log('PASS', name); persist(); };
let browser, context, page, server, phase = 'initialization', productFiles = [], testFiles = [];
function enterPhase(name) { phase = name; report.currentPhase = name; console.log('PHASE', name); persist(); }

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return ['target', 'node_modules', '.git', 'test-results'].includes(entry.name) ? [] : filesUnder(file);
    return [file];
  });
}
const hashes = files => Object.fromEntries(files.map(file => [path.relative(root, file), sha(file)]));
function products() {
  return [
    'src/App.vue', 'src/components/RustWordEditor.vue', 'src/style.css', 'package.json',
    ...filesUnder(path.join(root, 'src/word/rust')),
    ...filesUnder(path.join(root, 'vendor/wordcraft')),
    ...filesUnder(path.join(root, 'assets/fonts/open-office')),
    ...filesUnder(path.join(root, 'public/wordcraft')),
    'scripts/build-wordcraft.mjs',
  ].map(file => path.resolve(root, file)).filter(fs.existsSync);
}
function recordFile(file, details = {}) {
  report.files.push({ file: path.relative(root, file), bytes: fs.statSync(file).size, sha256: sha(file), ...details });
  return file;
}
function inspectDocx(file) {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect_docx.py'), file], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
}
function inspectPdf(file) {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
    'import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps({"pages":[{"width":p.rect.width,"height":p.rect.height,"text":p.get_text(),"images":len(p.get_images()),"lines":[{"text":"".join(s["text"] for s in l["spans"]),"bbox":l["bbox"]} for b in p.get_text("dict")["blocks"] for l in b.get("lines",[])]} for p in d]},ensure_ascii=False))', file], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
}
const editor = () => page.locator('[data-testid="rust-word-editor"]:visible');
const canvas = () => editor().getByTestId('wordcraft-canvas');
async function idle({ allowError = false } = {}) {
  await page.waitForFunction(allowError => {
    const error = document.querySelector('.error-banner');
    if (error && !allowError) throw Error(error.textContent);
    const editor = [...document.querySelectorAll('[data-testid="rust-word-editor"]')].find(node => node.getBoundingClientRect().width > 0);
    return editor?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  }, allowError);
  assert.equal(await page.locator('iframe').count(), 0, 'The editor must mount local WordCraft directly without an Office iframe');
}
async function newDocument() {
  const home = page.getByRole('button', { name: '工作台', exact: true });
  if (await home.isVisible()) await home.click();
  await page.locator('.create-card.word').click();
  await idle();
}
async function openFile(file, shortcut = false) {
  const diagnostic = async (stage, details) => {
    const dom = await page.evaluate(() => {
      const app = document.querySelector('#app')?.__vue_app__?._instance?.setupState;
      const node = document.activeElement;
      const canvas = document.querySelector('[data-testid="wordcraft-canvas"]');
      return {
        activeElement: { tag: node?.tagName, testid: node?.getAttribute('data-testid'), text: node?.textContent?.slice(0, 160) },
        canvas: canvas && { parentTestid: canvas.parentElement?.getAttribute('data-testid'),
          parking: !!canvas.closest('[data-wordcraft-parking]'),
          ownerSession: canvas.closest('[data-testid="rust-word-editor"]')?.getAttribute('data-session-id'),
          rect: canvas.getBoundingClientRect().toJSON() },
        app: app ? { activeKey: app.activeKey, home: app.home, busy: app.busy, help: app.help,
          active: app.active && { id: app.active.document?.id, name: app.active.document?.name, ready: app.active.ready, dirty: app.active.dirty },
          closeTarget: typeof app.closeTarget === 'string' ? app.closeTarget : app.closeTarget?.document?.id ?? null,
          saveAs: app.saveAsDraft && { name: app.saveAsDraft.name, format: app.saveAsDraft.format } } : null,
      };
    });
    let session;
    try { session = await inspectSession(); } catch (error) { session = { error: error.message }; }
    report.openFileDiagnostics ||= [];
    report.openFileDiagnostics.push({ file: path.basename(file), shortcut, stage, atUtc: new Date().toISOString(), details, dom, session });
    persist();
  };
  await diagnostic('before-open');
  try {
    if (shortcut) await focusDocument(diagnostic);
    const [choice] = await Promise.all([
      page.waitForEvent('filechooser'),
      (async () => {
        if (shortcut) {
          await diagnostic('before-Control+o');
          await page.keyboard.press('Control+o');
          await diagnostic('after-Control+o');
        } else await page.getByTestId('shell-open').click();
      })(),
    ]);
    await diagnostic('chooser-opened');
    await choice.setFiles(file);
  } catch (error) {
    await diagnostic('open-failed', { message: error.message });
    throw error;
  }
}
async function saveFile(filename, trigger) {
  const pending = page.waitForEvent('download');
  if (trigger) await trigger();
  else await page.getByTestId('shell-save').click();
  const download = await pending, destination = path.join(output, filename);
  assert.match(download.suggestedFilename(), /\.docx$/i);
  await download.saveAs(destination); await idle();
  recordFile(destination, { kind: 'actual UI DOCX download' });
  return { file: destination, inspected: inspectDocx(destination) };
}
const bodyParagraphs = inspected => inspected.paragraphs.filter(p => p.part === 'word/document.xml' && p.location.length === 2);
const bodyText = inspected => bodyParagraphs(inspected).map(p => p.text).join('\n');
async function inspectSession(id) {
  const sessionId = id || await editor().getAttribute('data-session-id');
  assert.ok(sessionId, 'The actual editor identifies its Rust session');
  return page.evaluate(async id => {
    const client = await import('/src/word/rust/client.ts');
    return client.inspectWordcraftSession(id);
  }, sessionId);
}
async function waitState(predicate, description, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    last = await inspectSession();
    if (predicate(last)) return last;
    await page.waitForTimeout(40);
  }
  fs.writeFileSync(path.join(output, 'last-snapshot.json'), JSON.stringify(last, null, 2));
  assert.fail(description + ': timed out; see last-snapshot.json');
}
async function expectText(expected) { return waitState(state => state.text === expected, `Text equals ${JSON.stringify(expected)}`); }
async function selectAll() {
  await page.keyboard.press('Control+a');
  return waitState(value => JSON.stringify(value.selection.anchor) !== JSON.stringify(value.selection.focus), 'Ctrl+A establishes a real Rust text selection before the next operation');
}
async function focusDocument(diagnostic) {
  if (diagnostic) await diagnostic('focus-wait-layout');
  const state = await waitState(value => value.ui?.pages?.length > 0, 'Actual Rust canvas completes its first page layout');
  const box = await canvas().boundingBox();
  assert.ok(box && state.ui.pages.length, 'Rust supplies a visible page and actual canvas');
  const [x, y, width, height] = state.ui.pages[0];
  // Click real page whitespace. Clicking inside an existing selection can
  // initiate WordCraft's text drag; its caret also carries an IME DOM agent.
  const target = { x: x + width * 0.7, y: Math.min(y + Math.min(200, height / 4), box.height - 50) };
  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return { tag: node?.tagName, testid: node?.getAttribute('data-testid') };
  }, { x: box.x + target.x, y: box.y + target.y });
  if (diagnostic) await diagnostic('focus-before-click', { box, target, hit });
  assert.equal(hit.testid, 'wordcraft-canvas', 'Focus click must reach the actual canvas');
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (diagnostic) await diagnostic('focus-after-click');
  await waitState(value => value.ui.focused, 'Actual canvas receives document focus');
  if (diagnostic) await diagnostic('focus-ready');
}
async function insertText(text, expected) {
  await page.keyboard.insertText(text);
  if (expected !== undefined) await expectText(expected);
}
async function compose(text) {
  // eframe owns its hidden text agent as a sibling of the canvas. Feed its real
  // registered input/composition listeners; do not call the engine to insert.
  await editor().locator('input[autocapitalize="off"]').evaluate((node, value) => {
    node.focus(); node.value = '';
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    node.value = value; node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
  }, text);
}
async function commitComposition(text) {
  await editor().locator('input[autocapitalize="off"]').evaluate((node, value) => {
    // A native IME updates the input's value before compositionend. A save
    // attempt may have blurred/cleared eframe's agent since the preedit event.
    node.value = value; node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, text);
}
async function clickRibbon(id) {
  // Web eframe has no AccessKit DOM tree. Its existing KeyTips expose the real
  // widget rectangles; read them, dismiss badges, then click the real button.
  const before = await inspectSession();
  assert.notDeepEqual(before.selection.anchor, before.selection.focus, 'Formatting probe requires an established selection');
  await page.keyboard.press('F10');
  // KeyTips activates at frame end; deliver the tab key in the following frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press('h');
  const state = await waitState(value => value.ui.ribbonControls?.some(control => control.id === id), 'Real ribbon geometry: ' + id);
  const control = state.ui.ribbonControls.find(control => control.id === id);
  const [x, y, width, height] = control.rect, box = await canvas().boundingBox();
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + x + width / 2, box.y + y + height / 2);
  const field = id.replace('format.', '');
  const after = await waitState(value => value.format[field] === true, 'Actual ribbon command changes ' + field);
  assert.deepEqual(after.selection, before.selection, 'Ribbon click keeps the selected text');
  report.ribbonClicks ||= []; report.ribbonClicks.push({ id, label: control.label, rect: control.rect, beforeSelection: before.selection, afterSelection: after.selection, format: after.format });
}
async function exportPdf(filename) {
  const pending = page.waitForEvent('download');
  await page.getByTestId('shell-export-pdf').click();
  const chooser = page.getByTestId('save-format-confirm');
  if (await chooser.isVisible()) await chooser.click();
  const download = await pending, destination = path.join(output, filename);
  assert.match(download.suggestedFilename(), /\.pdf$/i); await download.saveAs(destination); await idle();
  recordFile(destination, { kind: 'actual UI PDF download' });
  return inspectPdf(destination);
}
async function startBrowser() {
  const { createServer } = await import('vite');
  server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: {
    host: '127.0.0.1', port: 0, hmr: false,
    watch: { ignored: ['**/vendor/**', '**/src-tauri/target/**', '**/crates/**/target/**', '**/test-results/**'] },
  } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
    if (/\/office-runtime\/|\/office\/host\.html|\/office\/runtime\/|soffice\.(?:js|wasm)|\/src\/word\/core\/(?:model|docx|dom|runtime)\.ts/.test(url)) report.forbiddenRequests.push(url);
    if (/\.wasm(?:\?|$)/.test(url)) report.wasmRequests.push(url);
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.setDefaultTimeout(30000);
  await page.goto(origin);
}

async function coreTests() {
  enterPhase('independent-core-in-real-wasm');
  const { runWordcraftCore } = await import('../compatibility/wordcraft-core/run.mjs');
  await page.evaluate(async () => {
    const module = await import('/wordcraft/wordcraft.js');
    await module.default();
    window.__wordcraftQaCore = { host: module.createHost(() => {}), id: undefined, next: 0 };
  });
  report.coreRequests = [];
  const adapter = {
    async open(name, bytes) {
      const snapshot = await page.evaluate(({ name, bytes }) => {
        const qa = window.__wordcraftQaCore;
        if (qa.id) {
          const old = JSON.parse(qa.host.inspect(qa.id));
          if (old.dirty && !qa.host.discardChanges(qa.id, old.documentId, old.revision)) throw Error('Core test failed to discard its isolated session');
          const current = JSON.parse(qa.host.inspect(qa.id));
          if (!qa.host.close(qa.id, current.documentId, current.revision, false)) throw Error('Core test failed to close its isolated session');
        }
        qa.id = `qa-core-${++qa.next}`;
        return JSON.parse(qa.host.prepare(qa.id, name, new Uint8Array(bytes)));
      }, { name, bytes: Array.from(bytes) });
      report.coreRequests.push({ op: 'open', name, documentId: snapshot.documentId, revision: snapshot.revision }); persist();
      return snapshot;
    },
    async command(id, params) {
      const response = await page.evaluate(({ id, params }) => {
        const qa = window.__wordcraftQaCore;
        return JSON.parse(qa.host.command(qa.id, id, JSON.stringify(params)));
      }, { id, params });
      report.coreRequests.push({ op: 'command', id, ok: response.ok, error: response.error,
        documentId: response.snapshot?.documentId, revision: response.snapshot?.revision }); persist();
      return response;
    },
    async exportDocument(name) {
      const data = await page.evaluate(name => {
        const qa = window.__wordcraftQaCore;
        return Array.from(qa.host.exportFile(qa.id, name.endsWith('.pdf') ? 'pdf' : 'docx'));
      }, name);
      report.coreRequests.push({ op: 'export', name, bytes: data.length }); persist();
      return new Uint8Array(data);
    },
  };
  try { report.core = await runWordcraftCore(adapter, path.join(output, 'core')); }
  finally {
    await page.evaluate(() => { window.__wordcraftQaCore?.host.destroy(); delete window.__wordcraftQaCore; });
  }
  pass('Real WordCraft WASM accepts independent source and native packages; commands, roundtrip OOXML and PDF match the external oracle',
    { fixtures: report.core.fixtures.length, commands: report.core.commands.length });
}

async function uiTests() {
  enterPhase('default-entry-and-real-input');
  await newDocument();
  assert.equal(await canvas().count(), 1);
  assert.ok(report.wasmRequests.some(url => /\/wordcraft\/.*\.wasm/.test(url)), 'Default Word actually loads the locally built WordCraft artifact');
  let state = await inspectSession(); assert.equal(state.text, ''); assert.equal(state.dirty, false);
  const unicode = 'Hello 中文😀e\u0301 连续输入\n第二段';
  await focusDocument(); await insertText('Hello 中文😀e\u0301', 'Hello 中文😀e\u0301');
  await insertText(' 连续', 'Hello 中文😀e\u0301 连续');
  await insertText('输入', 'Hello 中文😀e\u0301 连续输入');
  await page.keyboard.press('Enter'); await insertText('第二段', unicode);
  state = await inspectSession(); assert.equal(state.dirty, true); assert.equal(state.canUndo, true);
  const unicodeSaved = await saveFile('ui-unicode.docx'); assert.equal(bodyText(unicodeSaved.inspected), unicode);
  await waitState(value => !value.dirty, 'Successful delivered DOCX marks the current Rust revision saved');
  pass('Default entry loads local WordCraft, real Chinese/emoji/combining input and Enter survive externally inspected DOCX');

  enterPhase('composition-and-history');
  await focusDocument(); await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  await compose('组合输入');
  // Preedit stays outside the committed document. The following read waits for
  // an actual frame before committing; composition is not a replacement mock.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await inspectSession()).text, unicode);
  await commitComposition('组合输入');
  const composed = unicode + '组合输入';
  const compositionSaved = await saveFile('ui-composition.docx'); assert.equal(bodyText(compositionSaved.inspected), composed);
  await focusDocument(); await page.keyboard.press('Control+z'); await expectText(unicode);
  await page.keyboard.press('Control+y'); await expectText(composed);
  await page.keyboard.type('abc', { delay: 0 }); await page.keyboard.press('Backspace');
  await expectText(composed + 'ab');
  pass('Real eframe composition commits once, immediate save includes it, undo/redo and rapid keyboard input retain text');

  enterPhase('actual-ribbon-buttons');
  await focusDocument(); await selectAll();
  await clickRibbon('format.bold'); await clickRibbon('format.italic'); await clickRibbon('format.underline');
  const formatted = await saveFile('ui-ribbon.docx');
  assert.equal(bodyText(formatted.inspected), composed + 'ab');
  for (const character of bodyParagraphs(formatted.inspected).flatMap(p => p.characters)) {
    assert.equal(character.bold, true, 'Actual Bold button reaches the exported document');
    assert.equal(character.italic, true, 'Actual Italic button reaches the exported document');
    assert.equal(character.underline, 'single', 'Actual Underline button reaches the exported document');
  }
  await page.screenshot({ path: path.join(output, 'wordcraft-ribbon-desktop.png') });
  pass('Original WordCraft ribbon buttons are clicked at their real Rust widget positions; B/I/U agree with external OOXML');

  enterPhase('native-clipboard-atomicity');
  await focusDocument(); await selectAll(); await page.keyboard.press('Control+c');
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, composed + 'ab');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), composed + 'ab');
  await page.keyboard.press('Control+x'); await expectText('');
  await page.keyboard.press('Control+z'); await expectText(composed + 'ab');
  await page.keyboard.press('Control+End');
  await page.evaluate(() => navigator.clipboard.writeText(' clipboard中文'));
  await page.keyboard.press('Control+v'); await expectText(composed + 'ab clipboard中文');
  await page.keyboard.press('Control+z'); await expectText(composed + 'ab');
  await page.keyboard.press('Control+y'); await expectText(composed + 'ab clipboard中文');
  const clipboardOriginId = await editor().getAttribute('data-session-id');
  const clipboardOriginName = await page.locator('.document-tab.active .tab-name').innerText();
  const copiedText = (await inspectSession()).text;
  enterPhase('same-session-rich-and-plain-paste');
  // Keep the source fragment and both paste variants inside the same WordApp
  // session. A different session may only receive text/plain from the browser,
  // which would make a plain-looking result an insufficient mode comparison.
  await newDocument(); await focusDocument();
  const richSample = '富文本粘贴 中文😀';
  await insertText(richSample, richSample); await selectAll();
  const emphasisKeys = [['bold', 'b'], ['italic', 'i'], ['underline', 'u']];
  for (const [flag, key] of emphasisKeys) {
    await page.keyboard.press('Control+' + key);
    await waitState(value => value.format[flag] === true, 'Rich clipboard source enables ' + flag);
  }
  const clipboardSource = await saveFile('ui-paste-rich-source.docx');
  assert.equal(bodyText(clipboardSource.inspected), richSample);
  for (const character of bodyParagraphs(clipboardSource.inspected).flatMap(p => p.characters)) {
    assert.equal(character.bold, true); assert.equal(character.italic, true); assert.equal(character.underline, 'single');
  }
  await focusDocument(); await selectAll(); await page.keyboard.press('Control+c');
  await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, richSample);
  report.plainPasteSource = {
    sessionId: await editor().getAttribute('data-session-id'), text: richSample,
    independentlyCheckedSourceFormatting: path.relative(root, clipboardSource.file),
    clipboardMimeTypes: await page.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types)),
  };
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
  await expectText(richSample + '\n');
  async function plainTypingTarget() {
    for (const [flag, key] of emphasisKeys) {
      if ((await inspectSession()).format[flag]) await page.keyboard.press('Control+' + key);
      await waitState(value => value.format[flag] === false, 'Plain paste target disables ' + flag);
    }
  }
  await plainTypingTarget();
  await page.keyboard.press('Control+v'); await expectText(richSample + '\n' + richSample);
  const richPasted = await saveFile('ui-rich-paste.docx');
  assert.equal(bodyText(richPasted.inspected), richSample + '\n' + richSample);
  assert.equal(bodyParagraphs(richPasted.inspected).length, 2);
  for (const character of bodyParagraphs(richPasted.inspected)[1].characters) {
    assert.equal(character.bold, true, 'Ordinary paste proves the same-session rich fragment is available');
    assert.equal(character.italic, true); assert.equal(character.underline, 'single');
  }
  await focusDocument(); await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+z'); await expectText(richSample + '\n');
  await plainTypingTarget();
  await page.keyboard.press('Control+Shift+v'); await expectText(richSample + '\n' + richSample);
  const plainPasted = await saveFile('ui-plain-paste.docx');
  assert.equal(bodyText(plainPasted.inspected), richSample + '\n' + richSample, 'Plain paste inserts the current system clipboard exactly once');
  assert.equal(bodyParagraphs(plainPasted.inspected).length, 2);
  for (const character of bodyParagraphs(plainPasted.inspected)[1].characters) {
    assert.equal(character.bold, false, 'Ctrl+Shift+V must not import source bold');
    assert.equal(character.italic, false, 'Ctrl+Shift+V must not import source italic');
    assert.equal(character.underline, 'none', 'Ctrl+Shift+V must not import source underline');
  }
  await focusDocument(); await page.keyboard.press('Control+z'); await expectText(richSample + '\n');
  await page.keyboard.press('Control+y'); await expectText(richSample + '\n' + richSample);
  await page.locator('.document-tab .tab-name').filter({ hasText: clipboardOriginName }).click(); await idle();
  assert.equal(await editor().getAttribute('data-session-id'), clipboardOriginId);
  await expectText(copiedText);
  pass('Native copy/cut and paste insert once; same-session ordinary paste retains rich emphasis while Ctrl+Shift+V uses the plain target, with one undo per paste');

  enterPhase('native-browser-ime-during-save');
  await focusDocument(); await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  const beforePending = await inspectSession();
  const cdp = await context.newCDPSession(page);
  await editor().getByTestId('wordcraft-input').evaluate(node => {
    window.__wordcraftQaImeEvents = [];
    window.__wordcraftQaImeListener = event => window.__wordcraftQaImeEvents.push({
      type: event.type, data: event.data, inputType: event.inputType,
      isComposing: event.isComposing, isTrusted: event.isTrusted,
      value: node.value, focused: document.activeElement === node,
    });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'blur']) {
      node.addEventListener(type, window.__wordcraftQaImeListener, true);
    }
  });
  await cdp.send('Input.imeSetComposition', { text: '延迟确认', selectionStart: 4, selectionEnd: 4 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await inspectSession()).text, beforePending.text, 'Native IME preedit remains outside committed Rust text');
  // Unlike a manually dispatched CompositionEvent, Chromium owns this active
  // composition and commits it on the real save-button blur. Keep the earlier
  // synthetic late-event failure artifacts; do not claim this covers OS IMEs.
  const delayedSaved = await saveFile('ui-delayed-composition.docx');
  assert.equal(bodyText(delayedSaved.inspected), beforePending.text + '延迟确认');
  await expectText(beforePending.text + '延迟确认');
  assert.equal((await inspectSession()).dirty, false, 'Save marks only the committed, delivered IME revision clean');
  report.nativeImeEvents = await editor().getByTestId('wordcraft-input').evaluate(node => {
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'blur']) {
      node.removeEventListener(type, window.__wordcraftQaImeListener, true);
    }
    return window.__wordcraftQaImeEvents;
  });
  assert.ok(report.nativeImeEvents.some(event => event.type === 'compositionstart' && event.isTrusted), 'The preedit must originate in Chromium, not a hand-dispatched event');
  await cdp.detach();
  // Retain a dirty edit for the subsequent real close-confirmation test.
  await focusDocument(); await page.keyboard.press('Control+End');
  await insertText(' 待保存', beforePending.text + '延迟确认 待保存');
  pass('Chromium-generated native preedit commits on the real save-button blur and the delivered DOCX includes it exactly once');
  enterPhase('tab-lifecycle');
  const firstId = await editor().getAttribute('data-session-id');
  const firstName = await page.locator('.document-tab.active .tab-name').innerText();
  const firstBefore = await inspectSession();
  await newDocument(); await focusDocument(); await insertText('第二个标签', '第二个标签');
  const secondId = await editor().getAttribute('data-session-id'); assert.notEqual(secondId, firstId);
  const secondName = await page.locator('.document-tab.active .tab-name').innerText();
  // Do not wait for a Rust acknowledgement between the browser input event and
  // switching tabs: queued input must remain with the session that received it.
  await page.keyboard.insertText(' 即时切换');
  await page.locator('.document-tab .tab-name').filter({ hasText: firstName }).click(); await idle();
  await expectText(firstBefore.text); assert.equal((await inspectSession()).dirty, true);
  assert.equal((await inspectSession(secondId)).text, '第二个标签 即时切换', 'Queued browser input remains in its originating Rust session');
  assert.equal(await page.locator('[data-testid="wordcraft-canvas"]:visible').count(), 1, 'One active WordCraft canvas after switching');
  assert.equal(await page.locator('input[autocapitalize="off"]').count(), 1, 'One live eframe text agent');
  await page.locator('.document-tab.active .tab-close').click();
  const closeDialog = page.getByRole('dialog', { name: '保存你的修改？' }); await closeDialog.waitFor();
  await closeDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await inspectSession()).text, firstBefore.text);
  await page.locator('.document-tab.active .tab-close').click(); await closeDialog.waitFor();
  await closeDialog.getByRole('button', { name: '不保存', exact: true }).click(); await idle();
  await assert.rejects(() => inspectSession(firstId), 'A closed editor session must actually be destroyed');
  // Closing a tab selects a neighbouring tab; the independent paste control
  // may be that neighbour. Explicitly return to the session under test.
  await page.locator('.document-tab .tab-name').filter({ hasText: secondName }).click(); await idle();
  await expectText('第二个标签 即时切换');
  pass('Dirty sessions retain queued input across immediate tab switches, close cancellation retains content and discard destroys only the target session');

  enterPhase('failed-open-atomicity');
  const before = await inspectSession(), tabCount = await page.locator('.document-tab').count();
  const broken = path.join(output, 'broken.docx'); fs.writeFileSync(broken, 'PK\x03\x04broken');
  await openFile(broken); await page.locator('.error-banner').waitFor(); await idle({ allowError: true });
  const after = await inspectSession();
  for (const key of ['sessionId', 'documentId', 'revision', 'text', 'dirty', 'canUndo', 'canRedo']) assert.deepEqual(after[key], before[key], 'Failed open keeps ' + key);
  assert.equal(await page.locator('.document-tab').count(), tabCount);
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  pass('Malformed DOCX preflight leaves the actual active tab, Rust document identity, content, revision and history unchanged');

  enterPhase('independent-source-and-pdf');
  const source = path.join(corpus, 'independent-rich.docx'), original = inspectDocx(source);
  recordFile(source, { kind: 'Independent complete OOXML source; not emitted by product' });
  await openFile(source); await idle();
  const reopened = await saveFile('ui-independent-rich.docx');
  // The independent core suite checks more detailed style and source semantics.
  // Here also require the actual shell's imported/exported table, image and
  // header/footer contents, rather than treating an opened canvas as success.
  assert.deepEqual(reopened.inspected.tables.map(t => ({ rows: t.rows, columns: t.columns, cells: t.cells })), original.tables.map(t => ({ rows: t.rows, columns: t.columns, cells: t.cells })));
  assert.deepEqual(reopened.inspected.images.map(i => ({ sha256: i.sha256, width: i.width, height: i.height })), original.images.map(i => ({ sha256: i.sha256, width: i.width, height: i.height })));
  assert.deepEqual(bodyParagraphs(reopened.inspected).map(p => p.text), bodyParagraphs(original).map(p => p.text));
  for (const kind of ['header', 'footer']) {
    const paragraphs = value => value.paragraphs.filter(p => p.location[0] === kind).map(p => p.text);
    assert.deepEqual(paragraphs(reopened.inspected), paragraphs(original), kind + ' text survives actual UI save');
  }
  assert.ok(reopened.inspected.fields.some(field => /^PAGE(?:\s|$)/.test(field.instruction)));
  const richSession = await inspectSession();
  await openFile(reopened.file, true); await idle();
  const savedReopened = await inspectSession();
  assert.notEqual(savedReopened.sessionId, richSession.sessionId, 'The actual saved file opens into a distinct Rust session');
  assert.equal(savedReopened.text, richSession.text, 'Actual UI reopen retains body text');
  const secondSaved = await saveFile('ui-independent-rich-second.docx');
  for (const key of ['paragraphs', 'tables', 'images', 'fields', 'sections']) {
    assert.deepEqual(secondSaved.inspected[key], reopened.inspected[key], 'Second actual UI save preserves independent ' + key + ' projection');
  }
  const pdf = await exportPdf('ui-independent-rich.pdf');
  const pdfText = pdf.pages.map(p => p.text).join('\n');
  assert.ok(pdf.pages.length > 0);
  for (const paragraph of original.paragraphs.filter(p => p.text.trim())) {
    // PDF may wrap whitespace. Preserve all non-whitespace source characters.
    // This includes independently authored header/footer text and the cached
    // PAGE value, as well as body paragraphs and every table cell.
    assert.ok(pdfText.replace(/\s/g, '').includes(paragraph.text.replace(/\s/g, '')), 'Selectable PDF retains ' + paragraph.text);
  }
  report.pdfHeaderFooter = [];
  for (const paragraph of original.paragraphs.filter(p => ['header', 'footer'].includes(p.location[0]) && p.text.trim())) {
    const kind = paragraph.location[0];
    const line = pdf.pages[0].lines.find(line => line.text.replace(/\s/g, '').includes(paragraph.text.replace(/\s/g, '')));
    assert.ok(line, 'First-page PDF retains independent ' + kind + ' text, including the PAGE value');
    assert.ok(kind === 'header' ? line.bbox[3] < pdf.pages[0].height * 0.2 : line.bbox[1] > pdf.pages[0].height * 0.8,
      'Independent ' + kind + ' is painted in its page region');
    report.pdfHeaderFooter.push({ kind, text: paragraph.text, bbox: line.bbox });
  }
  assert.ok(pdf.pages.some(p => p.images > 0), 'Real PDF contains the source picture');
  await page.screenshot({ path: path.join(output, 'wordcraft-independent-desktop.png') });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.screenshot({ path: path.join(output, 'wordcraft-narrow.png') });
  pass('Actual import/save and PDF export retain independently authored text, table cells, image bytes, headers/footers and PAGE field');
}

async function embeddedUiTests() {
  enterPhase('embedded-editor-chrome');
  assert.doesNotMatch(await page.locator('.create-card.word').innerText(), /wordcraft/i, 'The workbench names the product, not its implementation');
  await newDocument();
  const downloads = [], fileChoosers = [];
  page.on('download', value => downloads.push(value.suggestedFilename()));
  page.on('filechooser', value => fileChoosers.push(value));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shellText = async () => {
    assert.doesNotMatch(await page.locator('body').innerText(), /wordcraft/i, 'Visible application chrome contains no upstream brand');
    for (const id of ['shell-new', 'shell-open', 'shell-save', 'shell-save-as', 'shell-export-pdf', 'shell-print']) {
      assert.equal(await page.getByTestId(id).count(), 1, 'Exactly one shell file control: ' + id);
      assert.equal(await page.getByTestId(id).isVisible(), true, 'Shell file control remains accessible: ' + id);
    }
  };
  const inspectChrome = async () => {
    const value = await waitState(state => state.ui?.ribbonTabs?.length > 0 && state.ui?.drawnChrome?.length > 0, 'Actual rendered editor chrome and tab geometry');
    const tabs = value.ui.ribbonTabs;
    assert.ok(tabs.some(tab => tab.id === 'Home'), 'The real editing ribbon remains mounted');
    assert.ok(tabs.some(tab => tab.id === 'Insert'), 'Insertion tools remain available');
    for (const tab of tabs) {
      assert.doesNotMatch(tab.label, /^(?:File|Help)$|\b(?:wordcraft|backstage)\b/i, 'Embedded ribbon excludes file/help/brand tabs');
      assert.doesNotMatch(tab.id, /^(?:File|Help)$|\b(?:wordcraft|backstage)\b/i, 'Embedded ribbon excludes file/help/brand tab identities');
      assert.equal(tab.rect.length, 4);
      assert.ok(tab.rect.every(Number.isFinite) && tab.rect[2] > 0 && tab.rect[3] > 0, 'Tab evidence comes from an actual rendered widget');
    }
    for (const widget of value.ui.drawnChrome) {
      assert.ok(widget.id.startsWith('tab:') || ['quickAccess:edit.undo', 'quickAccess:edit.redo'].includes(widget.id), 'Actual embedded chrome contains editing controls only: ' + widget.id);
      assert.ok(!['tab:File', 'tab:Help'].includes(widget.id), 'Actual painted chrome excludes file and help tabs');
      assert.doesNotMatch(widget.label, /wordcraft/i, 'Actual canvas chrome contains no upstream brand');
      assert.ok(widget.rect.every(Number.isFinite) && widget.rect[2] > 0 && widget.rect[3] > 0, 'Chrome evidence must have real painted geometry');
    }
    assert.ok(value.ui.drawnChrome.some(widget => widget.id === 'quickAccess:edit.undo'), 'Compact editing undo remains rendered');
    assert.ok(value.ui.drawnChrome.some(widget => widget.id === 'quickAccess:edit.redo'), 'Compact editing redo remains rendered');
    assert.equal(value.ui.ui.backstage, false, 'Embedded Word has no open independent file workspace');
    return value;
  };
  await shellText();
  const initialChrome = await inspectChrome();
  report.embeddedChrome = { initial: { tabs: initialChrome.ui.ribbonTabs, chrome: initialChrome.ui.drawnChrome } };
  const sample = '统一文档工作区\n文字排版、表格与图片均在这里编辑。中文😀';
  await focusDocument(); await insertText(sample.split('\n')[0], sample.split('\n')[0]);
  await page.keyboard.press('Enter'); await insertText(sample.split('\n')[1], sample);
  await selectAll();
  await clickRibbon('format.bold'); await clickRibbon('format.italic'); await clickRibbon('format.underline');
  const beforeHidden = await inspectSession(), beforeDownloads = downloads.length, beforeChoosers = fileChoosers.length;
  await page.keyboard.press('F10'); await frame(); await page.keyboard.press('f'); await frame();
  assert.equal((await inspectChrome()).text, sample, 'Removed File keytip cannot navigate to an independent file screen or insert text');
  await page.keyboard.press('Escape'); await frame();
  await page.keyboard.press('F10'); await frame(); await page.keyboard.press('1'); await frame();
  await page.keyboard.press('Escape'); await frame();
  await page.keyboard.press('F1'); await frame();
  assert.equal((await inspectSession()).ui.dialog, null, 'The removed help shortcut cannot open an upstream About/Help dialog');
  await page.keyboard.press('Escape'); await frame();
  const afterHidden = await inspectChrome();
  for (const key of ['documentId', 'revision', 'text', 'dirty']) assert.deepEqual(afterHidden[key], beforeHidden[key], 'Hidden file/QAT entry points cannot change ' + key);
  assert.equal(downloads.length, beforeDownloads, 'Removed QAT keytips cannot independently save a document');
  assert.equal(fileChoosers.length, beforeChoosers, 'Removed file keytips cannot independently open a document');
  report.embeddedCommandSearch = [];
  for (const query of ['', 'file', 'save', 'about', 'print', 'discord', 'bold']) {
    await focusDocument(); await page.keyboard.press('Alt+q');
    await waitState(value => value.ui.dialog?.dialog === 'commands', 'Real command-search shortcut opens the editing search');
    if (query) await page.keyboard.type(query);
    await waitState(value => value.ui.dialog?.dialog === 'commands' && value.ui.dialog.query === query, 'Real command-search input receives ' + JSON.stringify(query));
    await frame();
    const searching = await inspectSession();
    const hits = searching.ui.drawnChrome.filter(widget => widget.id.startsWith('command:'));
    for (const hit of hits) {
      const id = hit.id.slice('command:'.length);
      assert.ok(!id.startsWith('file.') || ['file.properties', 'file.accessibility', 'file.printMarkup', 'file.setAuthor'].includes(id), 'Command search cannot reveal independent file actions: ' + id);
      assert.doesNotMatch(id, /^help\.|^ui\.(?:backstage|print|printSubmit|printSettings|openFileDialog|fileBrowser|makeDefaultApp|discord|saveChanges|startScreen)$|^tools\.customize/);
      assert.doesNotMatch(hit.label, /wordcraft/i, 'Command-search results contain no upstream brand');
    }
    if (query === 'bold') assert.ok(hits.some(hit => hit.id === 'command:format.bold'), 'Editing commands remain discoverable in real search');
    report.embeddedCommandSearch.push({ query, hits, text: searching.text, revision: searching.revision });
    persist();
    await page.keyboard.press('Escape');
    const closedSearch = await waitState(value => value.ui.dialog === null, 'Escape closes command search');
    assert.equal(closedSearch.text, beforeHidden.text, 'Command search must not insert its query into the document: ' + JSON.stringify(query));
    assert.equal(closedSearch.revision, beforeHidden.revision, 'Command search must not mutate the document revision: ' + JSON.stringify(query));
  }
  const afterSearch = await inspectSession();
  for (const key of ['documentId', 'revision', 'text', 'dirty']) assert.deepEqual(afterSearch[key], beforeHidden[key], 'Searching hidden file/brand commands cannot change ' + key);
  await shellText();
  await page.screenshot({ path: path.join(output, 'open-office-word-desktop.png') });
  pass('Embedded canvas exposes real editing tabs and B/I/U controls, with no File/Help entry, file keytips or visible upstream branding');

  enterPhase('shell-save-shortcuts-and-dirty-state');
  const initial = await inspectSession(), originalId = initial.sessionId;
  assert.equal(initial.dirty, true);
  assert.equal(await page.locator('.save-state').innerText(), '尚未保存');
  await focusDocument();
  const firstDownload = downloads.length;
  const saved = await saveFile('shell-shortcut-save.docx', () => page.keyboard.press('Control+s'));
  assert.equal(downloads.length, firstDownload + 1, 'Ctrl+S delivers one shell save, without a second internal save');
  assert.equal(bodyText(saved.inspected), sample);
  for (const character of bodyParagraphs(saved.inspected).flatMap(paragraph => paragraph.characters)) {
    assert.equal(character.bold, true); assert.equal(character.italic, true); assert.equal(character.underline, 'single');
  }
  await waitState(value => value.sessionId === originalId && !value.dirty, 'Only the exported Rust revision becomes clean');
  assert.equal(await page.locator('.save-state').innerText(), '已保存');
  assert.equal(await page.locator('.document-tab.active .dirty-dot').count(), 0);
  await page.getByTestId('shell-save').focus();
  const beforeShellSave = downloads.length;
  const shellFocusedSave = await saveFile('shell-focused-shortcut-save.docx', () => page.keyboard.press('Control+s'));
  assert.equal(downloads.length, beforeShellSave + 1, 'Ctrl+S with shell focus delivers exactly one document save');
  assert.equal(bodyText(shellFocusedSave.inspected), sample, 'Shell-focused Ctrl+S saves the document, not the browser page');
  const deliveredBeforeCancel = downloads.length;
  const beforeSaveAs = await inspectSession();
  await focusDocument(); await page.keyboard.press('Control+Shift+s');
  const saveAs = page.getByTestId('save-format-dialog'); await saveAs.waitFor();
  assert.equal(await saveAs.count(), 1, 'Save As uses the sole Open Office dialog');
  assert.equal((await inspectSession()).ui.dialog, null, 'Save As does not open an embedded Rust dialog');
  await page.getByTestId('save-format-name').fill('外壳另存副本');
  await page.keyboard.press('Escape'); await saveAs.waitFor({ state: 'hidden' });
  const canceled = await inspectSession();
  for (const key of ['documentId', 'revision', 'text', 'dirty']) assert.deepEqual(canceled[key], beforeSaveAs[key], 'Canceled shell Save As keeps ' + key);
  assert.equal(downloads.length, deliveredBeforeCancel, 'Canceling Save As writes nothing');
  await focusDocument(); await page.keyboard.press('F12'); await saveAs.waitFor();
  assert.equal((await inspectSession()).ui.dialog, null, 'F12 routes Save As through the shell, not an embedded file screen');
  await page.keyboard.press('Escape'); await saveAs.waitFor({ state: 'hidden' });
  assert.equal(downloads.length, deliveredBeforeCancel, 'Canceled F12 Save As writes nothing');
  await page.getByTestId('shell-save-as').click(); await saveAs.waitFor();
  await page.getByTestId('save-format-name').fill('外壳另存副本');
  const copy = await saveFile('shell-save-as.docx', () => page.getByTestId('save-format-confirm').click());
  assert.equal(bodyText(copy.inspected), sample);
  assert.equal(await editor().getAttribute('data-session-id'), originalId, 'Save As keeps the existing Rust editing session');
  assert.equal(await page.locator('.save-state').innerText(), '已保存');
  pass('Shell Ctrl+S saves once, Save As cancellation preserves the document, and successful delivery updates the sole visible saved state');

  enterPhase('shell-new-open-and-close');
  await focusDocument(); await page.keyboard.press('Control+End');
  await insertText(' 未保存修改', sample + ' 未保存修改');
  const originalName = await page.locator('.document-tab.active .tab-name').innerText();
  const originalText = (await inspectSession()).text, tabsBefore = await page.locator('.document-tab').count();
  await page.keyboard.press('Control+n');
  await page.waitForFunction(expected => document.querySelectorAll('.document-tab').length === expected, tabsBefore + 1);
  await idle();
  const blank = await inspectSession();
  assert.notEqual(blank.sessionId, originalId); assert.equal(blank.text, '');
  assert.equal((await inspectSession(originalId)).text, originalText); assert.equal((await inspectSession(originalId)).dirty, true);
  const discardBlank = async () => {
    const id = (await inspectSession()).sessionId;
    await page.locator('.document-tab.active .tab-close').click();
    const dialog = page.getByRole('dialog', { name: '保存你的修改？' });
    await dialog.waitFor(); await dialog.getByRole('button', { name: '不保存', exact: true }).click(); await idle();
    await assert.rejects(() => inspectSession(id), 'The shell close destroys only its target session');
  };
  await discardBlank();
  await page.getByTestId('shell-new').click();
  await page.getByTestId('shell-new-word').click();
  await page.waitForFunction(expected => document.querySelectorAll('.document-tab').length === expected, tabsBefore + 1);
  await idle(); assert.equal((await inspectSession()).text, ''); await discardBlank();
  await page.locator('.document-tab .tab-name').filter({ hasText: originalName }).click(); await idle();
  await page.locator('.document-tab.active .tab-close').click();
  const closeDialog = page.getByRole('dialog', { name: '保存你的修改？' }); await closeDialog.waitFor();
  await closeDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await inspectSession()).text, originalText); assert.equal((await inspectSession()).dirty, true);
  const chooserCount = fileChoosers.length;
  await openFile(copy.file, true); await idle();
  assert.equal(fileChoosers.length, chooserCount + 1, 'Ctrl+O routes once to the shell file chooser');
  assert.notEqual((await inspectSession()).sessionId, originalId); assert.equal((await inspectSession()).text, sample);
  assert.equal((await inspectSession(originalId)).text, originalText); assert.equal((await inspectSession(originalId)).dirty, true);
  await page.getByTestId('shell-open').focus();
  const beforeShellOpen = fileChoosers.length, shellChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o'); await (await shellChooser).setFiles(copy.file); await idle();
  assert.equal(fileChoosers.length, beforeShellOpen + 1, 'Ctrl+O with shell focus reaches exactly one application file chooser');
  assert.equal((await inspectSession()).text, sample);
  assert.equal((await inspectSession(originalId)).text, originalText); assert.equal((await inspectSession(originalId)).dirty, true);
  await shellText(); await inspectChrome();
  pass('Shell new button and Ctrl+N create distinct tabs, close cancellation retains dirty text, and Ctrl+O opens a copy without replacing unsaved work');

  enterPhase('shell-pdf-and-print');
  await focusDocument(); await page.keyboard.press('Control+End'); await insertText(' 打印与导出', sample + ' 打印与导出');
  const beforePdf = await inspectSession();
  const pdf = await exportPdf('shell-export.pdf');
  assert.ok(pdf.pages.map(value => value.text).join('\n').replace(/\s/g, '').includes(beforePdf.text.replace(/\s/g, '')));
  assert.equal((await inspectSession()).dirty, true, 'PDF export does not mark unsaved DOCX content clean');
  assert.equal(await page.locator('.save-state').innerText(), '尚未保存');
  await shellText(); await inspectChrome();
  await page.screenshot({ path: path.join(output, 'open-office-word-complete.png') });
  await page.setViewportSize({ width: 900, height: 900 }); await frame();
  await page.screenshot({ path: path.join(output, 'open-office-word-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1050 }); await frame();
  const inspectPrintedPdf = async filename => {
    const printFrame = page.locator('iframe[title="文稿打印预览"]');
    await printFrame.waitFor({ state: 'attached' });
    assert.equal(await printFrame.count(), 1, 'Print uses one shell-owned local PDF preview');
    const url = await printFrame.getAttribute('src'); assert.match(url, /^blob:/);
    const bytes = await page.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), url);
    const destination = path.join(output, filename); fs.writeFileSync(destination, Buffer.from(bytes)); recordFile(destination, { kind: 'Actual shell print PDF blob' });
    const printed = inspectPdf(destination), text = printed.pages.map(value => value.text).join('\n');
    assert.ok(text.replace(/\s/g, '').includes(beforePdf.text.replace(/\s/g, '')), 'Print consumes the actual Rust PDF with the edited Chinese text');
    assert.equal((await inspectSession()).dirty, true, 'Printing does not clear unsaved DOCX state');
    return url;
  };
  await page.getByTestId('shell-print').click();
  const previousPrint = await inspectPrintedPdf('shell-button-print.pdf');
  await focusDocument(); await page.keyboard.press('Control+p');
  await page.waitForFunction(previous => {
    const frame = document.querySelector('iframe[title="文稿打印预览"]');
    return frame && frame.getAttribute('src') !== previous;
  }, previousPrint);
  await inspectPrintedPdf('shell-shortcut-print.pdf');
  pass('Shell PDF export and print button/Ctrl+P consume real selectable Rust PDFs while preserving unsaved document state');
  const finalChrome = await inspectChrome();
  report.embeddedChrome.final = { tabs: finalChrome.ui.ribbonTabs, chrome: finalChrome.ui.drawnChrome };
  report.shellFileEvents = { downloads, fileChoosers: fileChoosers.length };
}

async function main({ scope = 'full' } = {}) {
  try {
    productFiles = products();
    testFiles = [__filename, path.join(root, 'tests/browser/wordcraft-embedded-ui.cjs'), path.join(root, 'tests/wordcraft-core.test.mjs'), ...filesUnder(corpus)];
    report.productsBefore = hashes(productFiles); report.testsBefore = hashes(testFiles); persist();
    assert.ok(fs.existsSync(path.join(root, 'public/wordcraft/wordcraft_bg.wasm')), 'Build the real WordCraft WASM before running acceptance');
    report.artifactCheck = execFileSync(process.execPath, [path.join(root, 'scripts/build-wordcraft.mjs'), '--check'], { cwd: root, encoding: 'utf8' }).trim();
    phase = 'start-browser'; await startBrowser();
    const failures = [];
    report.scope = scope === 'embedded' ? 'Actual embedded editing ribbon and Open Office file shell, using local WASM, browser events and independent DOCX/PDF inspection' : report.scope;
    for (const run of scope === 'embedded' ? [embeddedUiTests] : [coreTests, uiTests]) {
      try { await run(); }
      catch (error) {
        failures.push({ phase, message: error.message, stack: error.stack });
        report.failures = failures; persist();
        // The isolated core host is always destroyed in its own finally block.
        // Continue into the independent UI path so a codec failure does not hide
        // unrelated integration failures. The entire run still fails below.
      }
    }
    if (failures.length) {
      phase = 'independent-core-and-ui';
      throw Error(failures.map(item => item.phase + ': ' + item.message).join('\n'));
    }
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.forbiddenRequests, []);
    assert.deepEqual(report.consoleErrors, []);
    report.productsAfter = hashes(productFiles); report.testsAfter = hashes(testFiles);
    assert.deepEqual(report.productsAfter, report.productsBefore, 'Product source/artifacts changed during acceptance');
    assert.deepEqual(report.testsAfter, report.testsBefore, 'Test/independent sources changed during acceptance');
    report.ok = true;
  } catch (error) {
    report.failure = { phase, message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.productsAfter = hashes(productFiles); report.testsAfter = hashes(testFiles);
    if (report.failure && page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(output, 'failure.png') }); } catch { /* Keep the original failure. */ }
    }
    report.finishedAtUtc = new Date().toISOString(); persist();
    if (browser) await browser.close();
    if (server) await server.close();
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
