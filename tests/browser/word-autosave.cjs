/* Browser regression for the real Vue shell and existing OfficeWord WASM.
 * Only src/native.ts is replaced: this verifies scheduling, dirty/save UI and
 * actual DOCX export bytes, not Tauri IPC or native filesystem persistence.
 * Starts Vite directly; never runs predev, a WASM build or a production build. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/word-autosave');
fs.mkdirSync(output, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wasm = path.join(root, 'public/office-word/office-word_bg.wasm');
const scenarios = (process.env.WORD_AUTOSAVE_SCENARIOS || 'typing,ime,dialog').split(',');
assert.ok(scenarios.length && scenarios.every(value => ['typing', 'ime', 'dialog'].includes(value)));
const report = {
  ok: false, startedAt: new Date().toISOString(),
  runtime: 'Real Vue App, real existing OfficeWord WASM, real 10-second scheduler in Chromium; src/native.ts save receipt stub',
  limitations: [
    'No native file write, Tauri IPC, native file dialog or WebView verification; src/native.ts is stubbed in this browser only.',
    'Existing public/office-word WASM is used without rebuilding; this does not validate new Rust dialog styling.',
    'Chromium CDP owns the composition start/update/input events; compositionend trust is recorded as observed. A physical operating-system IME is not exercised.',
  ],
  scenarios, wasmSha256: hash(fs.readFileSync(wasm)), checks: [], saves: [], states: [], screenshots: [], pageErrors: [], consoleErrors: [], wasmRequests: [], externalRequests: [],
};
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS', name); persist(); };
let server, browser, page, cdp;
const nativeStub = `
export { bytesToBase64, base64ToBytes } from '/src/shared/document.ts';
window.__autosaveEvidence = { saves: [], labels: [], downloadCount: 0 };
const evidence = window.__autosaveEvidence;
const observer = new MutationObserver(() => {
 const label = document.querySelector('[data-testid="global-save-state"]')?.textContent?.trim();
 if (label && evidence.labels.at(-1)?.text !== label) evidence.labels.push({ text: label, at: Date.now() });
});
observer.observe(document, { childList: true, subtree: true, characterData: true });
export const isTauri = () => true;
export const bootstrap = async () => ({ origin: location.origin, basePath: '/', platform: 'browser-native-stub', smokeMode: false });
export const listRecentDocuments = async () => [];
export const onCloseRequested = async () => () => {};
export const openDocument = async () => null;
export const openRecent = async () => { throw Error('Unexpected openRecent'); };
export const pickImage = async () => null;
export const confirmClose = async () => {};
export async function saveDocument(request) {
 const bytes = Uint8Array.from(atob(request.base64), char => char.charCodeAt(0));
 const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
 evidence.saves.push({ request: structuredClone(request), at: Date.now() });
 // Allow Vue to paint the in-flight state, as asynchronous native I/O would.
 await new Promise(resolve => setTimeout(resolve, 80));
 return { status: 'saved', document: { id: request.documentId || 'stub-word-original-file', name: request.name, extension: request.extension, kind: 'word', sha256, sizeBytes: bytes.length } };
}
`;
const editor = () => page.getByTestId('rust-word-editor');
const label = () => page.getByTestId('global-save-state');
async function inspect() {
  const id = await editor().getAttribute('data-session-id');
  return page.evaluate(async id => (await import('/src/word/rust/client.ts')).inspectOfficeWordSession(id), id);
}
async function waitForState(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await inspect();
    if (predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  fs.writeFileSync(path.join(output, 'last-snapshot.json'), JSON.stringify(state, null, 2));
  throw Error(description + ': timeout; see last-snapshot.json');
}
async function focusDocument() {
  const state = await waitForState(value => value.ui?.pages?.length, 'Word has page layout');
  const canvas = page.getByTestId('office-word-canvas');
  const box = await canvas.boundingBox();
  const [x, y, width, height] = state.ui.pages[0];
  await page.mouse.click(box.x + x + width * .7, box.y + Math.min(y + Math.min(200, height / 4), box.height - 50));
  await waitForState(value => value.ui.focused, 'Real Word canvas receives focus');
  await page.keyboard.press('Control+End');
}
async function textIs(expected) { await waitForState(value => value.text === expected, 'Expected real Word text ' + JSON.stringify(expected)); }
async function saveCount() { return page.evaluate(() => window.__autosaveEvidence.saves.length); }
async function toggle(enabled) {
  const control = page.getByTestId('shell-autosave');
  assert.equal(await control.isEnabled(), true);
  if ((await control.getAttribute('aria-checked')) !== String(enabled)) await control.click();
  assert.equal(await control.getAttribute('aria-checked'), String(enabled));
  return Date.now();
}
async function until(deadline) {
  while (Date.now() < deadline) await page.waitForTimeout(Math.min(500, deadline - Date.now()));
}
async function screenshot(name) {
  const file = `${name}.png`; await page.screenshot({ path: path.join(output, file) }); report.screenshots.push(file); persist();
}
async function acknowledgeSaved(count, text, stoppedAt, scenario) {
  await page.waitForFunction(count => window.__autosaveEvidence.saves.length === count && document.querySelector('[data-testid="global-save-state"]')?.textContent?.trim() === '已自动保存', count, { timeout: 6500 });
  const elapsedMs = Date.now() - stoppedAt;
  assert.ok(elapsedMs < 6500, 'Deferred autosave resumes promptly instead of waiting another 10 seconds');
  assert.equal((await inspect()).dirty, false);
  assert.equal(await editor().getAttribute('data-dirty'), 'false');
  assert.equal(await page.locator('[data-testid="global-save-state"] .dirty-dot').count(), 0);
  await textIs(text);
  const saved = await page.evaluate(() => window.__autosaveEvidence.saves.at(-1));
  assert.equal(saved.request.documentId, 'stub-word-original-file');
  assert.equal(saved.request.saveAs, false);
  assert.match(saved.request.expectedSha256, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from(saved.request.base64, 'base64');
  const file = path.join(output, scenario + '.docx'); fs.writeFileSync(file, bytes);
  const parsed = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'tests/compatibility/office-word-core/inspect_docx.py'), file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const actual = parsed.paragraphs.filter(item => item.part === 'word/document.xml' && item.location.length === 2).map(item => item.text).join('\n');
  assert.equal(actual, text, 'Independent OOXML parser sees the actual edited Word content');
  report.saves.push({ scenario, file: path.basename(file), bytes: bytes.length, sha256: hash(bytes), text: actual, resumedAfterMs: elapsedMs, documentId: saved.request.documentId, saveAs: saved.request.saveAs });
  pass(scenario + '-resumes-with-real-docx-and-clean-saved-ui', { resumedAfterMs: elapsedMs });
  await screenshot(scenario + '-saved');
}
async function beginComposition(text) {
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  report.composition = { before: await inspect() };
  report.composition.input = await editor().locator('input[autocapitalize="off"]').evaluate(node => {
    window.__autosaveImeEvents = [];
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'blur']) {
      node.addEventListener(type, event => window.__autosaveImeEvents.push({ type: event.type, data: event.data, inputType: event.inputType,
        isTrusted: event.isTrusted, isComposing: event.isComposing, value: node.value, start: node.selectionStart, end: node.selectionEnd }), true);
    }
    return { value: node.value, start: node.selectionStart, end: node.selectionEnd };
  });
  // Let Chromium own composition. Manually clearing eframe's retained input
  // context would produce DeleteSurrounding and change committed document text.
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.composition.preedit = await inspect(); persist();
}
async function endComposition(text) {
  await cdp.send('Input.insertText', { text });
  report.composition.events = await page.evaluate(() => window.__autosaveImeEvents);
  assert.ok(report.composition.events.some(event => event.type === 'compositionstart' && event.isTrusted));
  assert.ok(report.composition.events.some(event => event.type === 'compositionupdate' && event.isTrusted));
  assert.ok(report.composition.events.some(event => event.type === 'input' && event.isTrusted && event.isComposing));
  assert.ok(report.composition.events.some(event => event.type === 'compositionend' && event.data === text));
}

(async () => {
  try {
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), server: {
      host: '127.0.0.1', port: 0, strictPort: false, hmr: false,
      watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
      fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
    } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
    await context.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: nativeStub }));
    context.on('request', request => {
      const url = request.url();
      if (/\.wasm(?:\?|$)/.test(url)) report.wasmRequests.push(url);
      if (/^https?:/.test(url) && new URL(url).origin !== origin) report.externalRequests.push(url);
    });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    cdp = await context.newCDPSession(page);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') report.consoleErrors.push(entry.text()); });
    page.on('download', () => { report.downloadCount = (report.downloadCount || 0) + 1; });
    await page.goto(origin);
    await page.locator('.create-card.word').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="rust-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay'));
    assert.ok(report.wasmRequests.some(url => url.includes('/office-word/')));
    assert.equal(await page.locator('iframe').count(), 0);
    await toggle(true);
    assert.equal((await label().textContent()).trim(), '请先保存');
    await toggle(false);
    await focusDocument();
    let expected = '自动保存浏览器回归';
    await page.keyboard.insertText(expected); await textIs(expected);
    assert.equal(await editor().getAttribute('data-dirty'), 'true');
    await page.getByTestId('shell-save').click();
    await page.waitForFunction(() => window.__autosaveEvidence.saves.length === 1 && document.querySelector('[data-testid="global-save-state"]')?.textContent?.trim() === '已保存');
    pass('new-document-requires-first-save-and-real-input-sets-dirty');
    let savedCount = 1;

    if (scenarios.includes('typing')) {
    console.log('PHASE actual typing across the real 10-second deadline');
    const typingStarted = await toggle(true);
    await focusDocument(); expected += ' typing'; await page.keyboard.insertText(' typing'); await textIs(expected);
    assert.equal((await label().textContent()).trim(), '等待自动保存');
    assert.equal(await page.locator('[data-testid="global-save-state"] .dirty-dot').count(), 1);
    await until(typingStarted + 8000);
    let typingStopped;
    let index = 0;
    while (Date.now() < typingStarted + 12500) {
      const character = String(index++ % 10);
      expected += character; await page.keyboard.insertText(character);
      typingStopped = Date.now();
      await page.waitForTimeout(150);
    }
    assert.equal(await saveCount(), savedCount, 'No automatic save occurs while typing across the deadline');
    await textIs(expected);
    assert.equal((await inspect()).dirty, true);
    pass('typing-at-10-seconds-defers-without-clearing-dirty', { elapsedMs: Date.now() - typingStarted });
    await screenshot('typing-deferred');
    await acknowledgeSaved(++savedCount, expected, typingStopped, 'typing');
    }

    if (scenarios.includes('ime')) {
    console.log('PHASE unfinished IME composition across the real 10-second deadline');
    await toggle(false);
    const imeStarted = await toggle(true);
    await focusDocument(); expected += ' IME'; await page.keyboard.insertText(' IME'); await textIs(expected);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await inspect()).dirty, true);
    await beginComposition('中文输入');
    assert.equal(report.composition.preedit.text, expected, 'IME preedit preserves all previously committed text');
    assert.equal(report.composition.preedit.dirty, true, 'IME preedit preserves the real engine dirty state');
    await page.waitForFunction(() => document.querySelector('[data-testid="global-save-state"]')?.textContent?.trim() === '等待输入完成');
    await until(imeStarted + 10900);
    assert.equal(await saveCount(), savedCount, 'Unfinished IME is not exported or marked saved');
    report.composition.due = await inspect(); persist();
    assert.equal(report.composition.due.text, expected);
    assert.equal(report.composition.due.dirty, true);
    assert.equal(await page.locator('[data-testid="global-save-state"] .dirty-dot').count(), 1);
    pass('ime-at-10-seconds-shows-waiting-and-preserves-unsaved-input', { elapsedMs: Date.now() - imeStarted });
    await screenshot('ime-deferred');
    const imeStopped = Date.now(); await endComposition('中文输入'); expected += '中文输入'; await textIs(expected);
    await acknowledgeSaved(++savedCount, expected, imeStopped, 'ime');
    }

    if (scenarios.includes('dialog')) {
    console.log('PHASE real Rust command dialog across the real 10-second deadline');
    await toggle(false);
    const dialogStarted = await toggle(true);
    await focusDocument(); expected += ' dialog'; await page.keyboard.insertText(' dialog'); await textIs(expected);
    await page.keyboard.press('Alt+q');
    await waitForState(value => value.ui.dialog?.dialog === 'commands', 'Real Rust command-search dialog opens');
    await until(dialogStarted + 10900);
    assert.equal(await saveCount(), savedCount, 'Unfinished real Rust dialog is not exported');
    assert.equal((await label().textContent()).trim(), '等待完成编辑');
    assert.equal((await inspect()).dirty, true);
    pass('rust-dialog-at-10-seconds-defers-with-visible-explanation', { elapsedMs: Date.now() - dialogStarted });
    await screenshot('dialog-deferred');
    const dialogClosed = Date.now(); await page.keyboard.press('Escape');
    await waitForState(value => value.ui.dialog === null, 'Escape closes the actual Rust dialog');
    await acknowledgeSaved(++savedCount, expected, dialogClosed, 'dialog');
    }

    report.states = await page.evaluate(() => window.__autosaveEvidence.labels);
    assert.ok(report.states.some(state => state.text === '正在自动保存'));
    assert.ok(report.states.some(state => state.text === '已自动保存'));
    assert.equal(report.downloadCount || 0, 0, 'Desktop-path autosave never triggers a browser download');
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.equal(hash(fs.readFileSync(wasm)), report.wasmSha256, 'Existing WASM stays unchanged');
    pass('in-flight-and-saved-labels-observed-no-download-no-page-errors-no-build');
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); process.exitCode = 1;
    if (page) {
      try { report.failureUi = await page.locator('body').innerText(); await screenshot('failure'); } catch {}
      try { report.failureSnapshot = await inspect(); } catch {}
      try { report.states = await page.evaluate(() => window.__autosaveEvidence?.labels || []); } catch {}
    }
  } finally {
    report.finishedAt = new Date().toISOString(); persist();
    await browser?.close(); await server?.close();
  }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
