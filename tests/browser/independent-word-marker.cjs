/* Real UI + actual product codec + complete native LibreOffice DOCX round trips.
 * Python XML/ZIP independently resolves marker and visible-body properties.
 * Deliberately malformed packages live under test-results, never the corpus.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const root = path.resolve(__dirname, '../..');
const corpus = path.join(root, 'tests/compatibility/independent-word-marker');
const output = path.resolve(process.env.WORD_MARKER_OUTPUT || path.join(root, 'test-results/independent-word-marker'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const sources = ['src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/editor.css', 'src/components/StandaloneWordEditor.vue'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = () => Object.fromEntries(sources.map(name => [name, sha(path.join(root, name))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = document => document.paragraphs.map(p => ({ characters: p.characters, markerStyle: p.markerStyle }));
const fixture = name => manifest.fixtures.find(f => f.name === name);
const fileFor = name => path.join(corpus, fixture(name).docx);
const report = { scope: 'Independent paragraph markers, empty insertion and native DOCX preservation', limitations: ['One native LibreOffice build; no Microsoft Word runtime.', 'Browser continuous-view metrics are checked relatively, not native pagination or pixel fidelity.', 'Typing is Chromium keyboard/insertText, not native Writer keyboard or OS IME.', 'Internal underlineColor auto means follow text color and exports without w:u/@w:color; explicit source OOXML auto is rejected because this native build converts it to white.'], corpusManifestSha256: sha(path.join(corpus, 'manifest.json')), oracleSha256: sha(path.join(corpus, 'inspect.py')), productBefore: sourceHashes(), checks: [], nativeRoundtrips: [], pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [] };
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const ok = message => { report.checks.push(message); persist(); console.log('PASS', message); };
let server, browser, page, phase = 'startup', home = true;
const content = () => page.getByTestId('word-content');
async function idle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner'); if (error) throw Error(error.textContent);
    return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  });
  assert.equal(await page.locator('iframe').count(), 0);
}
async function open(file) {
  const chooser = page.waitForEvent('filechooser');
  if (home) await page.getByTestId('independent-word-open').click();
  else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(file); await idle(); home = false;
}
async function save(name) {
  const download = page.waitForEvent('download'); await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click();
  const result = await download, file = path.join(output, name); assert.match(result.suggestedFilename(), /\.docx$/i); await result.saveAs(file); await idle(); return file;
}
async function range(p, start, end = start) {
  await content().evaluate((node, { p, start, end }) => {
    const paragraph = node.children[p];
    const at = offset => { const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (offset <= n.length) return [n, offset]; offset -= n.length; } if (!offset) return [paragraph, paragraph.childNodes.length]; throw Error('Selection offset out of bounds'); };
    node.focus(); window.getSelection().setBaseAndExtent(...at(start), ...at(end)); document.dispatchEvent(new Event('selectionchange'));
  }, { p, start, end });
}
async function undo() { await page.locator('.command-bar button[title="撤销"]').click(); await idle(); }
async function redo() { await page.locator('.command-bar button[title="重做"]').click(); await idle(); }
async function nativeBatch(files, name) {
  const destination = path.join(output, 'native', name); fs.mkdirSync(destination, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-marker-native-'));
  try {
    const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, ...files], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    const outputs = files.map(file => { const target = path.join(destination, path.basename(file)); assert.ok(fs.existsSync(target), result.stdout + result.stderr); return { file: target, sha256: sha(target), document: inspect(target) }; });
    report.nativeRoundtrips.push({ name, stdout: result.stdout, stderr: result.stderr, files: outputs.map(({ file, sha256 }) => ({ file, sha256 })) }); persist(); return outputs;
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
async function assertDownload(name, expected) { const file = await save(name), document = inspect(file); assert.deepEqual(semantics(document), expected, name); return { file, document }; }
function assertHashes() { for (const f of manifest.fixtures) { assert.equal(sha(path.join(corpus, f.source)), f.sourceSha256); assert.equal(sha(path.join(corpus, f.docx)), f.docxSha256); } }
const chars = (text, style) => Array.from(text, character => ({ character, ...style }));
const defaults = { bold: false, italic: false, fontSize: 12, color: '#20242B', verticalAlign: 'baseline', strike: 'none', underline: false, underlineColor: 'auto', highlight: 'none', backgroundColor: 'none' };
const gateCases = [
  ['plain', {}], ['bold', { bold: true }], ['italic', { italic: true }], ['size', { fontSize: 36 }], ['color', { color: '#FF0000' }], ['underline', { underline: 'double' }], ['strike', { strike: 'double' }], ['background', { backgroundColor: '#13579B' }], ['highlight', { highlight: 'yellow' }], ['script', { verticalAlign: 'superscript' }], ['font', { fontName: 'Arial' }], ['combined', { bold: true, fontSize: 36, underline: 'double', backgroundColor: '#13579B', highlight: 'yellow' }],
  ['explicit-clear', { underline: false, bold: false, backgroundColor: 'none', highlight: 'none', strike: 'none', verticalAlign: 'baseline' }],
  ['source-script', { verticalAlign: 'superscript' }], ['source-script-baseline', { verticalAlign: 'baseline' }],
  ['underline-rgb', { underline: 'double', underlineColor: '#FF0000', color: '#0000FF' }],
  ['underline-follow-text', { underline: true, underlineColor: 'auto', color: '#0000FF' }],
];
(async () => { try {
  assertHashes(); const { createServer } = await import('vite');
  server = await createServer({ root, cacheDir: 'node_modules/.vite-word-marker-test', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } } });
  await server.listen(); const url = `http://127.0.0.1:${server.httpServer.address().port}/`, origin = new URL(url).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true }); page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
  page.on('request', request => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== origin) report.externalRequests.push(url.href); if (/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(url.href)) report.runtimeRequests.push(url.href); });
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message })); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text() }); });
  await page.goto(url); await page.getByTestId('independent-word-open').waitFor();

  phase = 'native-corpus-preservation';
  const positives = manifest.fixtures.filter(f => !f.expectUnsupported), firstSaves = [];
  for (const f of positives) {
    const original = inspect(path.join(corpus, f.docx)); assert.deepEqual(semantics(original), f.expectedSemantics, f.name + ': authored contract');
    await open(path.join(corpus, f.docx)); const first = await assertDownload(`${f.name}-first.docx`, f.expectedSemantics); firstSaves.push(first.file);
    await open(first.file); await assertDownload(`${f.name}-second.docx`, f.expectedSemantics);
  }
  const nativeSaved = await nativeBatch(firstSaves, 'corpus');
  for (let i = 0; i < positives.length; i++) { assert.deepEqual(semantics(nativeSaved[i].document), positives[i].expectedSemantics, positives[i].name + ': native resave'); await open(nativeSaved[i].file); await assertDownload(`${positives[i].name}-native-reopened.docx`, positives[i].expectedSemantics); }
  ok(`${positives.length} complete native marker/body controls preserve independent marker format, explicit resets, script, paints, RGB underline color and trailing-break font through two downloads, native resave and UI reopen`);

  phase = 'empty-product-export-native-gate';
  const gateFiles = [], contracts = [];
  for (const [name, style] of gateCases) {
    const bytes = await page.evaluate(async ({ name, style }) => {
      const { createWordDocument } = await import('/src/word/core/model.ts'); const { exportWordDocument } = await import('/src/word/core/docx.ts'); const model = createWordDocument(); model.paragraphs[0].runs = [{ text: '', style }];
      if (name === 'explicit-clear') { model.paragraphs[0].sourceRun = { bold: true, underline: 'double', backgroundColor: '#13579B', highlight: 'yellow', strike: 'double', verticalAlign: 'superscript' }; model.paragraphs[0].runs[0].directStyle = style; }
      if (name.startsWith('source-script')) { model.paragraphs[0].runs[0].sourceVerticalAlign = 'superscript'; model.paragraphs[0].runs[0].directStyle = name === 'source-script' ? {} : { verticalAlign: 'baseline' }; }
      return Array.from(exportWordDocument(model));
    }, { name, style });
    const file = path.join(output, `gate-${name}.docx`); fs.writeFileSync(file, Uint8Array.from(bytes)); gateFiles.push(file);
    if (name === 'underline-follow-text') {
      const xml = strFromU8(unzipSync(Uint8Array.from(bytes))['word/document.xml']);
      const underlines = xml.match(/<w:u\b[^>]*>/g) || [];
      assert.ok(underlines.length > 0, 'Follow-text gate must export actual underlines');
      assert.ok(underlines.every(tag => !/w:color=/.test(tag)), 'Follow-text underline omits color instead of emitting native-white raw auto');
    }
    const wanted = { ...defaults, ...Object.fromEntries(Object.entries(style).filter(([key]) => key in defaults)) }; contracts.push(wanted);
    assert.deepEqual(inspect(file).paragraphs[0].emptyInsertionStyle, wanted, name + ': product encodes insertion format in marker');
  }
  const gateNative = await nativeBatch(gateFiles, 'empty-product'); report.emptyProductCases = [];
  for (let i = 0; i < gateCases.length; i++) {
    const [name, style] = gateCases[i], result = gateNative[i], wanted = contracts[i]; assert.deepEqual(result.document.paragraphs[0].emptyInsertionStyle, wanted, name + ': native retains empty format');
    await open(result.file); await range(0, 0); await page.keyboard.type('AB'); await page.keyboard.insertText('中文😀'); await idle();
    const file = await save(`gate-${name}-typed.docx`), parsed = inspect(file); assert.deepEqual(parsed.paragraphs[0].characters, chars('AB中文😀', wanted), name + ': actual typing after native resave');
    if (style.fontName) assert.equal(parsed.paragraphs[0].runs[0].style['rFonts:ascii'], style.fontName);
    await open(file); assert.deepEqual(inspect(await save(`gate-${name}-typed-reopened.docx`)).paragraphs[0].characters, chars('AB中文😀', wanted));
    report.emptyProductCases.push({ name, intended: wanted, nativeSha256: result.sha256 });
  }
  ok(`${gateCases.length} actual product-exported empty documents retain format after native resave and real ASCII/CJK/emoji input, including inherited explicit clears, font name, RGB underline color and following text color`);

  phase = 'empty-native-insertion-and-history';
  for (const name of ['empty-rich-marker', 'empty-style-rich-marker-clear', 'empty-marker-super', 'empty-marker-double-multiple-runs', 'marker-character-style', 'unsupported-marker-color']) {
    const f = fixture(name), wanted = f.expectedSemantics[1].markerStyle; await open(fileFor(name)); await range(1, 0);
    assert.equal(await page.getByTestId('word-bold').getAttribute('aria-pressed'), String(wanted.bold)); assert.equal(await page.getByTestId('word-font-size').inputValue(), String(wanted.fontSize));
    await page.keyboard.insertText('输入😀'); await idle(); const typed = await save(`${name}-typed.docx`); assert.deepEqual(inspect(typed).paragraphs[1].characters, chars('输入😀', wanted));
    await undo(); assert.deepEqual(semantics(inspect(await save(`${name}-undo.docx`))), f.expectedSemantics); await redo(); assert.deepEqual(inspect(await save(`${name}-redo.docx`)).paragraphs[1].characters, chars('输入😀', wanted));
  }
  ok('Native empty marker controls determine actual insertion, toolbar state and undo/redo without reviving cleared inherited formatting');

  phase = 'visible-body-marker-independence';
  const visible = fixture('text-rich-marker'), bodyExpected = visible.expectedSemantics[1].characters[0], markerExpected = visible.expectedSemantics[1].markerStyle;
  await open(fileFor(visible.name)); await range(1, 2); assert.equal(await page.getByTestId('word-bold').getAttribute('aria-pressed'), 'false'); assert.equal(await page.getByTestId('word-font-size').inputValue(), '12');
  await page.keyboard.type('x'); await idle(); const independent = await save('visible-edited.docx'), independentDoc = inspect(independent); const bodyStyle = { ...bodyExpected }; delete bodyStyle.character;
  assert.deepEqual(independentDoc.paragraphs[1].characters, chars('BOxDY', bodyStyle)); assert.deepEqual(independentDoc.paragraphs[1].markerStyle, markerExpected);
  const nativeEdited = (await nativeBatch([independent], 'visible-edited'))[0]; assert.deepEqual(semantics(nativeEdited.document), semantics(independentDoc)); await open(nativeEdited.file); await assertDownload('visible-edited-native-reopen.docx', semantics(independentDoc));
  await range(1, 5); await page.keyboard.press('End'); await page.keyboard.type('E'); await idle();
  const endTyped = inspect(await save('visible-end-typed.docx')); assert.deepEqual(endTyped.paragraphs[1].characters, [...chars('BOxDY', bodyStyle), ...chars('E', markerExpected)]); assert.deepEqual(endTyped.paragraphs[1].markerStyle, markerExpected);
  await range(1, 0, 2); await page.getByTestId('word-underline-menu-toggle').click(); await page.getByTestId('word-underline-single').click(); await idle();
  const formatted = inspect(await save('visible-format-only.docx')); assert.ok(formatted.paragraphs[1].characters.slice(0, 2).every(c => c.underline === true)); assert.deepEqual(formatted.paragraphs[1].characters.slice(2), endTyped.paragraphs[1].characters.slice(2)); assert.deepEqual(formatted.paragraphs[1].markerStyle, markerExpected, 'Partial selection must not format marker');
  ok('Visible body stays independent during middle typing and partial formatting; End typing uses marker without repainting old text, across download and native resave');

  phase = 'whole-body-format-marker-rebuild';
  await open(fileFor('text-rich-marker')); await range(1, 0, 4); await page.getByTestId('word-bold').click(); await idle();
  const rebuiltWanted = { ...bodyStyle, bold: true }, rebuilt = await save('whole-body-bold.docx'), rebuiltDoc = inspect(rebuilt);
  assert.deepEqual(rebuiltDoc.paragraphs[1].characters, chars('BODY', rebuiltWanted)); assert.deepEqual(rebuiltDoc.paragraphs[1].markerStyle, rebuiltWanted);
  await undo(); await assertDownload('whole-body-bold-undo.docx', visible.expectedSemantics); await redo(); await assertDownload('whole-body-bold-redo.docx', semantics(rebuiltDoc));
  await range(1, 0, 4); await page.getByTestId('word-italic').click(); await idle();
  const twiceWanted = { ...rebuiltWanted, italic: true }, twice = await save('whole-body-bold-italic.docx'), twiceDoc = inspect(twice);
  assert.deepEqual(twiceDoc.paragraphs[1].characters, chars('BODY', twiceWanted)); assert.deepEqual(twiceDoc.paragraphs[1].markerStyle, twiceWanted);
  await undo(); await assertDownload('whole-body-italic-undo.docx', semantics(rebuiltDoc)); await redo(); await assertDownload('whole-body-italic-redo.docx', semantics(twiceDoc));
  const rebuiltNative = await nativeBatch([rebuilt, twice], 'whole-body'); assert.deepEqual(semantics(rebuiltNative[0].document), semantics(rebuiltDoc)); assert.deepEqual(semantics(rebuiltNative[1].document), semantics(twiceDoc));
  await open(rebuiltNative[1].file); await range(1, 0, 4); await page.getByTestId('word-underline-menu-toggle').click(); await page.getByTestId('word-underline-single').click(); await idle();
  const reopenedWhole = await save('whole-body-reopened-underline.docx'), reopenedWholeDoc = inspect(reopenedWhole);
  assert.deepEqual(reopenedWholeDoc.paragraphs[1].characters, chars('BODY', { ...twiceWanted, underline: true })); assert.deepEqual(reopenedWholeDoc.paragraphs[1].markerStyle, { ...bodyStyle, underline: true });
  assert.deepEqual(semantics((await nativeBatch([reopenedWhole], 'whole-body-reopened'))[0].document), semantics(reopenedWholeDoc));
  ok('Whole-body formatting replaces imported marker attributes, accumulates consecutive bold/italic within the session and resets imported marker attributes again after native reopening; undo/redo and native resave preserve each contract');

  phase = 'synthetic-composition-at-marker';
  await open(fileFor('text-rich-marker')); await range(1, 4); await content().dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('合😀'); await content().dispatchEvent('compositionend', { data: '合😀' }); await idle();
  const composed = inspect(await save('marker-composition.docx')); assert.deepEqual(composed.paragraphs[1].characters, [...chars('BODY', bodyStyle), ...chars('合😀', markerExpected)]); assert.deepEqual(composed.paragraphs[1].markerStyle, markerExpected);
  await undo(); await assertDownload('marker-composition-undo.docx', visible.expectedSemantics); await redo(); await assertDownload('marker-composition-redo.docx', semantics(composed));
  ok('Synthetic composition lifecycle at paragraph end uses marker format for the appended text and stays one undoable transaction; this is not an OS IME test');

  phase = 'sparse-marker-end-insertion';
  const sparse = fixture('text-rich-body-sparse-marker'), sparseBody = { ...sparse.expectedSemantics[1].characters[0] }; delete sparseBody.character;
  const sparseInserted = { ...sparseBody, bold: true }, sparseMarker = sparse.expectedSemantics[1].markerStyle;
  assert.equal(sparseBody.fontSize, 24); assert.equal(sparseBody.italic, true); assert.equal(sparseBody.color, '#0000FF');
  assert.equal(sparseMarker.fontSize, 12); assert.equal(sparseMarker.italic, false); assert.equal(sparseMarker.bold, true);
  for (const composition of [false, true]) {
    const label = composition ? 'composition' : 'keyboard'; await open(fileFor(sparse.name)); await range(1, 4); await page.keyboard.press('End');
    assert.equal(await page.getByTestId('word-bold').getAttribute('aria-pressed'), 'true'); assert.equal(await page.getByTestId('word-italic').getAttribute('aria-pressed'), 'true'); assert.equal(await page.getByTestId('word-font-size').inputValue(), '24');
    if (composition) await content().dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('尾😀');
    if (composition) await content().dispatchEvent('compositionend', { data: '尾😀' });
    await idle(); const typed = await save(`sparse-marker-${label}.docx`), parsed = inspect(typed);
    assert.deepEqual(parsed.paragraphs[1].characters, [...chars('BODY', sparseBody), ...chars('尾😀', sparseInserted)]); assert.deepEqual(parsed.paragraphs[1].markerStyle, sparseMarker);
    await undo(); await assertDownload(`sparse-marker-${label}-undo.docx`, sparse.expectedSemantics); await redo(); await assertDownload(`sparse-marker-${label}-redo.docx`, semantics(parsed));
    const native = (await nativeBatch([typed], `sparse-marker-${label}`))[0]; assert.deepEqual(semantics(native.document), semantics(parsed)); await open(native.file); await assertDownload(`sparse-marker-${label}-native-reopen.docx`, semantics(parsed));
  }
  await open(fileFor(sparse.name)); await range(1, 4); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await idle();
  const sparseEnter = await save('sparse-marker-end-enter-empty.docx'), sparseEnterDoc = inspect(sparseEnter);
  assert.deepEqual(sparseEnterDoc.paragraphs.map(p => p.text), ['BEFORE', 'BODY', '', 'AFTER']);
  assert.deepEqual(sparseEnterDoc.paragraphs[1].markerStyle, sparseMarker, 'End Enter preserves the old paragraph marker');
  assert.deepEqual(sparseEnterDoc.paragraphs[2].emptyInsertionStyle, sparseInserted, 'New empty marker explicitly retains actual insertion formatting');
  const sparseEnterNative = (await nativeBatch([sparseEnter], 'sparse-marker-end-enter'))[0]; assert.deepEqual(semantics(sparseEnterNative.document), semantics(sparseEnterDoc));
  await open(sparseEnterNative.file); await range(2, 0); assert.equal(await page.getByTestId('word-font-size').inputValue(), '24'); await page.keyboard.insertText('换行😀'); await idle();
  const sparseEnterTyped = inspect(await save('sparse-marker-end-enter-reopened-typed.docx')); assert.deepEqual(sparseEnterTyped.paragraphs[2].characters, chars('换行😀', sparseInserted)); assert.deepEqual(sparseEnterTyped.paragraphs[1].markerStyle, sparseMarker);
  ok('Sparse bold marker overlays rich 24pt italic blue tail-body End keyboard/composition; End Enter explicitly preserves that insertion format in the new empty marker across native resave/reopen, without changing the old marker');

  phase = 'empty-toolbar-delete-and-roundtrip';
  await open(fileFor('empty-style-rich-marker-clear')); await range(1, 0); await page.getByTestId('word-underline-menu-toggle').click(); await page.getByTestId('word-underline-double').click(); await idle();
  const toolbarEmpty = await save('empty-toolbar.docx'), toolbarWanted = { ...fixture('empty-style-rich-marker-clear').expectedSemantics[1].markerStyle, underline: 'double' };
  assert.deepEqual(inspect(toolbarEmpty).paragraphs[1].emptyInsertionStyle, toolbarWanted);
  const toolbarNative = (await nativeBatch([toolbarEmpty], 'empty-toolbar'))[0]; await open(toolbarNative.file); await range(1, 0); await page.keyboard.insertText('保留😀'); await idle(); assert.deepEqual(inspect(await save('empty-toolbar-typed.docx')).paragraphs[1].characters, chars('保留😀', toolbarWanted));
  await range(1, 0, '保留😀'.length); await page.keyboard.press('Backspace'); await idle(); const deleted = await save('deleted-to-empty.docx'); assert.deepEqual(inspect(deleted).paragraphs[1].emptyInsertionStyle, toolbarWanted);
  const deletedNative = (await nativeBatch([deleted], 'deleted-empty'))[0]; await open(deletedNative.file); await range(1, 0); await page.keyboard.type('Z'); await idle(); assert.deepEqual(inspect(await save('deleted-retyped.docx')).paragraphs[1].characters, chars('Z', toolbarWanted));
  ok('Collapsed toolbar formatting and deletion to empty update saved marker, survive native roundtrip and retain subsequent typing format');

  phase = 'marker-heading-rebase';
  await open(fileFor('empty-marker-super')); await range(1, 0); await page.getByTestId('word-heading').selectOption('1'); await idle();
  const headed = inspect(await save('marker-heading.docx')); assert.deepEqual(headed.paragraphs[1].markerStyle, fixture('empty-marker-super').expectedSemantics[1].markerStyle);
  await page.keyboard.insertText('标题😀'); await idle(); assert.deepEqual(inspect(await save('marker-heading-typed.docx')).paragraphs[1].characters, chars('标题😀', headed.paragraphs[1].markerStyle));
  ok('Heading change preserves explicit empty-marker overrides and subsequent typed text');

  phase = 'marker-line-geometry';
  const geometry = {};
  for (const name of ['empty-rich-marker', 'empty-marker-super', 'empty-48pt-marker', 'text-rich-marker', 'text-48pt-marker', 'text-48pt-marker-trailing-break']) {
    await open(fileFor(name)); geometry[name] = await content().evaluate(node => Array.from(node.children, p => ({ text: p.textContent, height: p.getBoundingClientRect().height, fontSize: getComputedStyle(p).fontSize })));
  }
  assert.ok(geometry['empty-48pt-marker'][1].height > geometry['empty-rich-marker'][1].height * 1.5);
  assert.ok(Math.abs(geometry['empty-marker-super'][1].height - geometry['empty-rich-marker'][1].height) < 1, 'Empty superscript marker retains nominal line height');
  assert.ok(Math.abs(geometry['text-48pt-marker'][1].height - geometry['text-rich-marker'][1].height) < 1, 'Marker size must not enlarge a populated last line');
  assert.ok(geometry['text-48pt-marker-trailing-break'][1].height > geometry['text-48pt-marker'][1].height * 2, 'Trailing empty soft line uses marker size');
  report.geometry = geometry; await page.screenshot({ path: path.join(output, 'marker-trailing-break.png'), fullPage: true });
  ok('Marker font changes empty/trailing-empty line height, leaves populated line unchanged and does not shrink empty superscript nominal size');

  phase = 'unsupported-marker-atomic';
  const template = unzipSync(fs.readFileSync(fileFor('text-rich-marker'))), xml = strFromU8(template['word/document.xml']); report.negative = [];
  for (const [name, markup] of [['unknown-property', '<w:foo/>'], ['duplicate-underline', '<w:u w:val="single"/><w:u w:val="double"/>'], ['missing-value', '<w:u/>'], ['invalid-bold', '<w:b w:val="maybe"/>'], ['unknown-attribute', '<w:b w:foo="1"/>'], ['unknown-style', '<w:rStyle w:val="Missing"/>'], ['revision', '<w:rPrChange/>'], ['underline-theme', '<w:u w:val="single" w:color="FF0000" w:themeColor="accent1"/>'], ['underline-raw-auto', '<w:u w:val="single" w:color="auto"/>'], ['underline-malformed-color', '<w:u w:val="double" w:color="GG0000"/>']]) {
    const parts = { ...template, 'word/document.xml': strToU8(xml.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, `<w:rPr>${markup}</w:rPr>`)) }, bytes = zipSync(parts);
    fs.writeFileSync(path.join(output, `synthetic-marker-${name}.docx`), bytes);
    const error = await page.evaluate(async bytes => { try { (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)); return null; } catch (e) { return e.message; } }, Array.from(bytes)); assert.ok(error, name + ' accepted'); report.negative.push({ name, error });
  }
  await open(fileFor('text-rich-marker')); await range(1, 0); await page.keyboard.insertText('unsaved '); await idle(); report.atomicErrors = [];
  for (const f of manifest.fixtures.filter(f => f.expectUnsupported)) {
    const before = await content().innerHTML(), tabs = await page.locator('.document-tab').count(), chooser = page.waitForEvent('filechooser'); await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click(); await (await chooser).setFiles(path.join(corpus, f.docx));
    await page.locator('.error-banner').waitFor(); await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); assert.equal(await content().innerHTML(), before); assert.equal(await page.locator('.document-tab').count(), tabs); assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(), 1);
    report.atomicErrors.push({ name: f.name, error: await page.locator('.error-banner').textContent() }); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
  }
  await undo(); await assertDownload('atomic-history-preserved.docx', visible.expectedSemantics);
  ok('Malformed marker properties and untouched native unsupported marker files reject atomically while preserving unsaved body, marker, tabs and undo history');

  phase = 'frozen-sources'; assertHashes(); report.productAfter = sourceHashes(); assert.deepEqual(report.productAfter, report.productBefore, 'Product changed during regression; rerun after freeze');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.runtimeRequests, []); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { phase, message: error.message, stack: error.stack }; if (page) { try { report.failure.body = (await page.locator('body').innerText()).slice(-5000); await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {} } console.error(error); process.exitCode = 1;
} finally { persist(); if (browser) await browser.close(); if (server) await server.close(); } })();
