/* Character case contract: immutable native corpus, independent Python XML
 * oracle, real Chromium controls/downloads, and actual LibreOffice resave.
 * Synthetic malformed files are separate from native positive fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { zipSync, strToU8 } = require('fflate');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const corpus = path.join(root, 'tests/compatibility/independent-word-case');
const output = path.resolve(process.env.WORD_CASE_OUTPUT || path.join(root, 'test-results/independent-word-case'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/editor.css', 'src/style.css', 'src/components/StandaloneWordEditor.vue'];
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, sha256(path.join(root, p))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = d => d.paragraphs.map(p => p.characters);
const checkMarkers = (document, expected = {}) => { for (const [paragraph, mode] of Object.entries(expected)) assert.equal(document.paragraphs[Number(paragraph)].marker.caseMap, mode, `paragraph ${paragraph} marker`); };
const chars = (text, caseMap = 'none', fontSize = 12, verticalAlign = 'baseline') => Array.from(text, character => ({ character, caseMap, fontSize, verticalAlign }));
const testSources = ['tests/browser/independent-word-case.cjs', 'tests/compatibility/independent-word-case/inspect.py', 'tests/compatibility/independent-word-case/manifest.json'];
const testHashes = () => Object.fromEntries(testSources.map(p => [p, sha256(path.join(root, p))]));
const report = { startedAtUtc: new Date().toISOString(), scope: 'OOXML caps/smallCaps visual formatting with unchanged Unicode source text; independent semantics and real editor/native resave', limitations: ['One installed LibreOffice build; no Microsoft Word runtime.', 'CSS visual-case assertions do not establish exact native glyph shaping, language-sensitive casing, small-cap font availability or pagination equivalence.', 'Browser keyboard and insertText are not operating-system IME tests.', 'Rust CLI/native Tauri IPC is outside this browser suite.'], productBefore: sourceHashes(), testBefore: testHashes(), checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [] };
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const ok = message => { report.checks.push(message); console.log('PASS', message); persist(); };
let server, browser, page, phase = 'startup';
const content = () => page.getByTestId('word-content');
async function idle() { await page.waitForFunction(() => { const error = document.querySelector('.error-banner'); if (error) throw Error(error.textContent); return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay'); }); assert.equal(await page.locator('iframe').count(), 0); }
async function open(file, home = false) { const chooser = page.waitForEvent('filechooser'); if (home) await page.getByTestId('independent-word-open').click(); else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click(); await (await chooser).setFiles(file); await idle(); }
async function save(name) { const download = page.waitForEvent('download'); await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click(); const result = await download, file = path.join(output, name); assert.match(result.suggestedFilename(), /\.docx$/i); await result.saveAs(file); await idle(); return file; }
async function checkSave(name, expected) { const file = await save(name), document = inspect(file); assert.deepEqual(semantics(document), expected, name); return { file, document }; }
async function range(p, start, end = start, endParagraph = p) { await content().evaluate((node, { p, start, end, endParagraph }) => { const at = (paragraph, offset) => { const walker = document.createTreeWalker(node.children[paragraph], NodeFilter.SHOW_TEXT); let text; while ((text = walker.nextNode())) { if (offset <= text.length) return [text, offset]; offset -= text.length; } if (!offset) return [node.children[paragraph], node.children[paragraph].childNodes.length]; throw Error('Invalid selection offset'); }; node.focus(); window.getSelection().setBaseAndExtent(...at(p, start), ...at(endParagraph, end)); document.dispatchEvent(new Event('selectionchange')); }, { p, start, end, endParagraph }); }
async function clipboardContents() { return page.evaluate(async () => { const items = await navigator.clipboard.read(); const item = items.find(v => v.types.includes('text/html')); const html = item ? await (await item.getType('text/html')).text() : ''; const body = new DOMParser().parseFromString(html, 'text/html').body; return { plain: await navigator.clipboard.readText(), html, text: body.textContent, paragraphs: body.querySelectorAll('p').length, fontSizes: [...body.querySelectorAll('*')].map(e => e.style.fontSize).filter(Boolean) }; }); }

async function caseMenu(value) { await page.getByTestId('word-case-menu-toggle').click(); await page.getByTestId(`word-case-${value}`).click(); await idle(); }
async function undo() { await page.locator('.command-bar button[title="撤销"]').click(); await idle(); }
async function redo() { await page.locator('.command-bar button[title="重做"]').click(); await idle(); }
async function nativeRoundtrip(file, name) { const destination = path.join(output, 'native', name); fs.mkdirSync(destination, { recursive: true }); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-case-native-')); try { const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file], { timeout: 60000, maxBuffer: 1024 * 1024 }); const target = path.join(destination, path.basename(file)); assert.ok(fs.existsSync(target), result.stdout + result.stderr); return { file: target, sha256: sha256(target), stdout: result.stdout, stderr: result.stderr, document: inspect(target) }; } finally { fs.rmSync(profile, { recursive: true, force: true }); } }
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
function synthetic(body, styles = '') { const parts = { '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ''}</Types>`, '_rels/.rels': `<Relationships xmlns="${PR}"><Relationship Id="r1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`, 'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>` }; if (styles) { parts['word/styles.xml'] = `<w:styles xmlns:w="${W}">${styles}</w:styles>`; parts['word/_rels/document.xml.rels'] = `<Relationships xmlns="${PR}"><Relationship Id="s" Type="${R}/styles" Target="styles.xml"/></Relationships>`; } return Array.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])))); }
function input(name, body, styles = '') { const file = path.join(output, `synthetic-${name}.docx`); fs.writeFileSync(file, Buffer.from(synthetic(body, styles))); return file; }
const textRun = (text, properties = '') => `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const baseBody = '<w:p>' + textRun('aßﬃ中😀z') + '</w:p><w:p>' + textRun('alpha', '<w:caps/>') + '</w:p><w:p>' + textRun('beta', '<w:smallCaps/>') + '</w:p><w:p><w:pPr><w:rPr><w:caps/></w:rPr></w:pPr>' + textRun('body', '<w:caps w:val="0"/><w:smallCaps w:val="0"/>') + '</w:p><w:p><w:pPr><w:rPr><w:smallCaps/></w:rPr></w:pPr></w:p><w:p>' + textRun('abc', '<w:caps/>') + textRun('DEF', '<w:smallCaps/>') + '</w:p>';
const baseExpected = [chars('aßﬃ中😀z'), chars('alpha', 'upper'), chars('beta', 'smallCaps'), chars('body'), [], [...chars('abc', 'upper'), ...chars('DEF', 'smallCaps')]];

(async () => { try {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
  assert.ok(manifest.fixtures.some(f => !f.expectUnsupported), 'The native corpus must not be empty');
  const hashes = () => { for (const f of manifest.fixtures) { assert.equal(sha256(path.join(corpus, f.source)), f.sourceSha256); assert.equal(sha256(path.join(corpus, f.docx)), f.docxSha256); } };
  hashes(); report.corpus = manifest;
  const { createServer } = await import('vite'); server = await createServer({ root, cacheDir: 'node_modules/.vite-word-case-test', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } } }); await server.listen(); const url = `http://127.0.0.1:${server.httpServer.address().port}/`, origin = new URL(url).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] }); page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true }); page.setDefaultTimeout(30000); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await page.routeWebSocket('**', () => {});
  page.on('request', r => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) report.externalRequests.push(u.href); if (/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(u.href)) report.runtimeRequests.push(u.href); }); page.on('pageerror', e => report.pageErrors.push({ phase, message: e.message })); page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ phase, message: m.text() }); }); await page.goto(url); await page.getByTestId('independent-word-open').waitFor();

  phase = 'native-corpus-and-editing'; report.native = []; let opened = false;
  for (const fixture of manifest.fixtures) {
    if (fixture.expectUnsupported) {
      const error = await page.evaluate(async bytes => { try { (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)); return null; } catch (e) { return e.message; } }, Array.from(fs.readFileSync(path.join(corpus, fixture.docx))));
      assert.ok(error?.includes('请使用完整文字编辑器'), fixture.name + ' must retain its unsupported feature boundary'); report.native.push({ name: fixture.name, expectedRejection: error }); continue;
    }
    const source = path.join(corpus, fixture.source), nativeFile = path.join(corpus, fixture.docx);
    const nativeInspection = inspect(nativeFile); assert.deepEqual(semantics(nativeInspection), fixture.expectedCharacters, fixture.name); checkMarkers(nativeInspection, fixture.expectedMarkers);
    let sourceImportedByProduct = false;
    if (source.endsWith('.docx')) {
      await open(source, !opened); opened = true; sourceImportedByProduct = true;
      const sourceSaved = await checkSave(`${fixture.name}-source-imported.docx`, fixture.sourceCharacters || fixture.expectedCharacters); checkMarkers(sourceSaved.document, fixture.sourceMarkers);
      if (fixture.edit) {
        await range(fixture.edit.paragraph, fixture.edit.offset);
        if (fixture.edit.enter) await page.keyboard.press('Enter');
        await page.keyboard.insertText(fixture.edit.text); await idle();
        const edited = await checkSave(`${fixture.name}-real-ui-edited.docx`, fixture.expectedCharacters); checkMarkers(edited.document, fixture.expectedMarkers);
      }
    }
    await open(nativeFile, !opened); opened = true;
    const saved = await checkSave(`${fixture.name}-native-output-imported.docx`, fixture.expectedCharacters);
    checkMarkers(saved.document, fixture.expectedMarkers);
    const native = await nativeRoundtrip(saved.file, fixture.name); assert.deepEqual(semantics(native.document), fixture.expectedCharacters); checkMarkers(native.document, fixture.expectedMarkers);
    await open(native.file); const reopened = await checkSave(`${fixture.name}-native-reopened.docx`, fixture.expectedCharacters); checkMarkers(reopened.document, fixture.expectedMarkers);
    report.native.push({ name: fixture.name, sourceImportedByProduct, nativeOutputImportedByProduct: true, native });
  }
  ok('Immutable native outputs and all DOCX source inputs pass real product import/download; native resave/reopen and recorded Enter actions retain independent case/raw-text expectations');

  phase = 'direct-flags-and-order'; const base = input('case-base', baseBody); assert.deepEqual(semantics(inspect(base)), baseExpected); await open(base, !opened); opened = true; await checkSave('case-base.docx', baseExpected);
  const supported = [
    ['caps-first', '<w:caps/><w:smallCaps w:val="false"/>', 'upper'],
    ['small-false-first', '<w:smallCaps w:val="0"/><w:caps w:val="on"/>', 'upper'],
    ['both-false-caps-first', '<w:caps w:val="false"/><w:smallCaps w:val="off"/>', 'none'],
    ['both-false-small-first', '<w:smallCaps w:val="false"/><w:caps w:val="0"/>', 'none'],
    ['small-alone', '<w:smallCaps w:val="1"/>', 'smallCaps'],
  ];
  const ordered = input('supported-property-order', supported.map(([name, properties]) => '<w:p>' + textRun(name, properties) + '</w:p>').join(''));
  await open(ordered); const orderedExpected = supported.map(([name, , mode]) => chars(name, mode)); await checkSave('supported-property-order.docx', orderedExpected);
  ok('Missing-value true, supported boolean spellings, caps plus smallCaps=false and double-false resets resolve identically in both XML orders');

  phase = 'small-caps-real-fallback';
  const fallbackFont = execFileSync('fc-match', ['-f', '%{file}', 'DejaVu Sans'], { encoding: 'utf8' }).trim();
  const features = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', 'import json,sys; from fontTools.ttLib import TTFont; f=TTFont(sys.argv[1]); print(json.dumps(sorted({r.FeatureTag for r in f["GSUB"].table.FeatureList.FeatureRecord})))', fallbackFont], { encoding: 'utf8' }));
  assert.ok(!features.includes('smcp'), 'Fallback control font must not supply small-cap glyphs');
  const visualText = 'abcdefg Abc XYZ', visualFont = '<w:rFonts w:ascii="DejaVu Sans" w:hAnsi="DejaVu Sans" w:eastAsia="DejaVu Sans"/><w:sz w:val="48"/>';
  const visualInput = input('small-caps-fallback', ['none', 'smallCaps', 'upper'].map(mode => '<w:p>' + textRun(visualText, visualFont + (mode === 'smallCaps' ? '<w:smallCaps/>' : mode === 'upper' ? '<w:caps/>' : '<w:caps w:val="0"/><w:smallCaps w:val="0"/>')) + '</w:p>').join(''));
  await open(visualInput);
  report.smallCapsFallback = await content().evaluate(async node => {
    await document.fonts.load('24pt "DejaVu Sans"'); await document.fonts.ready;
    const width = element => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().width; };
    const spans = [...node.children].map(p => p.querySelector('[data-word-case-map]'));
    const actual = spans.map(span => ({ text: span.textContent, mode: span.dataset.wordCaseMap, width: width(span), fontSize: getComputedStyle(span).fontSize, fontFamily: getComputedStyle(span).fontFamily, synthesis: getComputedStyle(span).fontSynthesis }));
    const disabled = spans[1].cloneNode(true); disabled.style.fontSynthesis = 'none'; disabled.style.whiteSpace = 'pre'; disabled.style.position = 'fixed'; disabled.style.left = '0'; disabled.style.top = '0'; disabled.style.visibility = 'hidden'; document.body.append(disabled);
    try { return { actual, disabledFallbackWidth: width(disabled), rootSynthesis: getComputedStyle(document.documentElement).fontSynthesis }; } finally { disabled.remove(); }
  }); report.smallCapsFallback.font = { path: fallbackFont, sha256: sha256(fallbackFont), gsubFeatures: features };
  const [plainVisual, smallVisual, upperVisual] = report.smallCapsFallback.actual;
  assert.equal(report.smallCapsFallback.rootSynthesis, 'none');
  assert.equal(plainVisual.synthesis, 'none'); assert.equal(upperVisual.synthesis, 'none'); assert.equal(smallVisual.synthesis, 'small-caps');
  for (const v of report.smallCapsFallback.actual) { assert.equal(v.text, visualText); assert.equal(v.fontSize, '32px'); assert.match(v.fontFamily, /DejaVu Sans/); }
  assert.ok(Math.abs(smallVisual.width - plainVisual.width) > 2, 'Rendered small caps must differ from unchanged lowercase');
  assert.ok(smallVisual.width + 2 < upperVisual.width, 'Rendered small capitals must differ from full uppercase');
  assert.ok(Math.abs(report.smallCapsFallback.disabledFallbackWidth - plainVisual.width) < .2, 'Disabling synthesis in a font without smcp must reproduce ordinary lowercase');
  await content().screenshot({ path: path.join(output, 'small-caps-fallback.png') });
  await range(1, 0, visualText.length); await page.keyboard.press('Control+c'); const smallClipboard = await clipboardContents(); assert.equal(smallClipboard.plain, visualText); assert.equal(smallClipboard.text, visualText);
  const clipboardVisual = await page.evaluate(html => { const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;font-synthesis:none;white-space:pre'; host.innerHTML = html; document.body.append(host); try { const span = [...host.querySelectorAll('span')].find(e => e.style.fontVariantCaps === 'small-caps'); if (!span) throw Error('Small-cap clipboard span missing'); const r = document.createRange(); r.selectNodeContents(span); return { inlineSynthesis: span.style.fontSynthesis, width: r.getBoundingClientRect().width, rawText: span.textContent }; } finally { host.remove(); } }, smallClipboard.html);
  assert.equal(clipboardVisual.inlineSynthesis, 'small-caps'); assert.equal(clipboardVisual.rawText, visualText); assert.ok(Math.abs(clipboardVisual.width - smallVisual.width) < .2, 'Rich clipboard must retain actual synthesized small-cap rendering'); report.smallCapsFallback.clipboard = { ...clipboardVisual, plain: smallClipboard.plain };
  await page.getByTestId('word-case-menu-toggle').click(); assert.equal(await page.getByTestId('word-case-smallCaps').locator('.word-case-preview').evaluate(e => getComputedStyle(e).fontSynthesis), 'small-caps'); await page.screenshot({ path: path.join(output, 'small-caps-fallback-menu.png'), fullPage: true }); await page.keyboard.press('Escape');
  await checkSave('small-caps-fallback-saved.docx', [chars(visualText, 'none', 24), chars(visualText, 'smallCaps', 24), chars(visualText, 'upper', 24)]);
  ok('A real font without smcp renders synthesized small caps distinctly from lowercase and uppercase under global font-synthesis:none; disabling fallback reproduces lowercase, and actual clipboard HTML retains the visible fallback');

  phase = 'ui-selection-history'; await open(base); await range(0, 3, 7); await caseMenu('upper'); const formatted = structuredClone(baseExpected); formatted[0] = [...chars('aßﬃ'), ...chars('中😀z', 'upper')];
  assert.equal(await content().evaluate(n => n.children[0].textContent), 'aßﬃ中😀z'); await checkSave('unicode-selection-upper.docx', formatted); await undo(); await checkSave('unicode-selection-undo.docx', baseExpected); await redo(); await checkSave('unicode-selection-redo.docx', formatted);
  await range(0, 3, 7); await caseMenu('none'); formatted[0] = chars('aßﬃ中😀z'); const reset = await checkSave('unicode-selection-reset.docx', formatted); assert.ok(reset.document.paragraphs[0].runs.some(r => r.text.includes('中') && r.directStyle.caseMap === 'none'));
  await range(5, 0, 6); assert.equal(await page.getByTestId('word-case-menu-toggle').getAttribute('data-case'), 'mixed'); await caseMenu('smallCaps'); formatted[5] = chars('abcDEF', 'smallCaps'); await checkSave('mixed-small-caps.docx', formatted);
  const before = await content().innerHTML(); await page.getByTestId('word-case-menu-toggle').click(); await page.keyboard.press('Escape'); assert.equal(await content().innerHTML(), before); assert.equal(await content().evaluate(n => n === document.activeElement || n.contains(document.activeElement)), true);
  await page.getByTestId('word-case-menu-toggle').click(); await range(1, 0, 5); await page.getByTestId('word-case-menu').waitFor({ state: 'hidden' }); await checkSave('stale-menu.docx', formatted);
  ok('Real case menu preserves UTF-16 selections and source text, exposes mixed state, writes explicit reset, restores focus and supports undo/redo/cancel/stale selection');

  phase = 'real-clipboard'; const clipboard = input('clipboard-mixed', '<w:p>' + textRun('a', '<w:caps/>') + textRun('ßﬃ', '<w:caps w:val="0"/><w:smallCaps w:val="0"/>') + textRun('b', '<w:smallCaps/>') + textRun('中😀z', '<w:caps w:val="0"/><w:smallCaps w:val="0"/>') + '</w:p>'); const clipboardExpected = [[...chars('a', 'upper'), ...chars('ßﬃ'), ...chars('b', 'smallCaps'), ...chars('中😀z')]]; await open(clipboard); await range(0, 0, 7); await page.evaluate(() => navigator.clipboard.writeText('sentinel')); await page.keyboard.press('Control+c'); await page.waitForFunction(async () => await navigator.clipboard.readText() === 'aßﬃb中😀');
  report.clipboard = await page.evaluate(async () => { const items = await navigator.clipboard.read(); const htmlItem = items.find(item => item.types.includes('text/html')); const html = htmlItem ? await (await htmlItem.getType('text/html')).text() : null; return { plain: await navigator.clipboard.readText(), htmlText: html === null ? null : new DOMParser().parseFromString(html, 'text/html').body.textContent }; }); assert.equal(report.clipboard.plain, 'aßﬃb中😀'); assert.equal(report.clipboard.htmlText, 'aßﬃb中😀');
  await page.keyboard.press('Control+x'); await idle(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'aßﬃb中😀'); await checkSave('clipboard-cut.docx', [chars('z')]); await undo(); await checkSave('clipboard-cut-undo.docx', clipboardExpected); await redo(); await checkSave('clipboard-cut-redo.docx', [chars('z')]);
  await range(0, 0); await page.keyboard.press('Control+v'); await idle(); const pasted = await checkSave('clipboard-paste.docx', [chars('aßﬃb中😀z')]); await open(pasted.file); await checkSave('clipboard-reopened.docx', [chars('aßﬃb中😀z')]);
  const clipboardBoundary = input('clipboard-boundaries', '<w:p><w:pPr><w:rPr><w:sz w:val="140"/><w:smallCaps/></w:rPr></w:pPr>' + textRun('abc ', '<w:caps/>') + '</w:p><w:p><w:pPr><w:rPr><w:sz w:val="200"/></w:rPr></w:pPr>' + textRun('next') + '</w:p>'); await open(clipboardBoundary);
  await range(0, 3, 4); await page.keyboard.press('Control+c'); const partialClipboard = await clipboardContents(); assert.equal(partialClipboard.plain, ' '); assert.equal(partialClipboard.text, ' '); assert.ok(!partialClipboard.fontSizes.includes('70pt')); assert.ok(!partialClipboard.fontSizes.includes('0pt'));
  await range(0, 1, 0, 1); await page.keyboard.press('Control+c'); const boundaryClipboard = await clipboardContents(); assert.equal(boundaryClipboard.plain, 'bc \n'); assert.equal(boundaryClipboard.text, 'bc '); assert.equal(boundaryClipboard.paragraphs, 1); assert.ok(!boundaryClipboard.fontSizes.includes('100pt')); report.clipboard.partial = partialClipboard; report.clipboard.boundary = boundaryClipboard;
  ok('Actual copy/cut of mixed active-case ASCII and ordinary ß/ﬃ/CJK/emoji preserves original plain text and HTML; exact UTF-16 deletion, undo/redo and plain-text paste/reopen remain correct');

  phase = 'marker-and-insertion'; await open(base); await range(4, 0); await caseMenu('upper'); const empty = await checkSave('empty-marker-uppercase.docx', baseExpected); assert.equal(empty.document.paragraphs[4].marker.caseMap, 'upper'); await undo(); const emptyUndo = await checkSave('empty-marker-undo.docx', baseExpected); assert.equal(emptyUndo.document.paragraphs[4].marker.caseMap, 'smallCaps'); await redo(); await open(empty.file); await range(4, 0); await page.keyboard.insertText('ab😀'); await idle(); const inserted = structuredClone(baseExpected); inserted[4] = chars('ab😀', 'upper'); await checkSave('empty-marker-typed.docx', inserted);
  await open(base); await range(3, 4); await page.keyboard.type('x'); await idle(); const tail = structuredClone(baseExpected); tail[3].push(...chars('x', 'upper')); await checkSave('marker-tail.docx', tail); await range(3, 5); await page.keyboard.press('Enter'); await page.keyboard.type('y'); await idle(); tail.splice(4, 0, chars('y', 'upper')); await checkSave('marker-end-enter.docx', tail);
  ok('Empty-marker formatting saves independently, supports history and controls unchanged Unicode input; paragraph-tail and end Enter use marker case without repainting prior body');

  phase = 'dom-source-and-css'; report.dom = await page.evaluate(async bytes => {
    const { importWordDocument } = await import('/src/word/core/docx.ts'); const { renderWordDom, readWordDom } = await import('/src/word/core/dom.ts'); const { createWordDocument } = await import('/src/word/core/model.ts'); const node = document.createElement('div'); document.body.append(node);
    const project = d => d.paragraphs.map(p => ({ runs: p.runs, marker: p.marker }));
    try { let doc = importWordDocument(Uint8Array.from(bytes)); const initial = JSON.stringify(project(doc)); for (let i = 0; i < 8; i++) { renderWordDom(node, doc); doc = readWordDom(node, doc); if (JSON.stringify(project(doc)) !== initial) throw Error('Case or raw-text drift on DOM cycle ' + i); }
      renderWordDom(node, doc); const visual = [...node.querySelectorAll('[data-word-case-map]')].map(e => ({ text: e.textContent, caseMap: e.dataset.wordCaseMap, transform: getComputedStyle(e).textTransform, variant: getComputedStyle(e).fontVariantCaps }));
      const css = [['<p><span style="text-transform:uppercase">a中<span style="text-transform:none;font-variant-caps:normal">x😀</span></span></p>', ['upper', 'upper', 'none', 'none']], ['<p><span style="font-variant-caps:small-caps">aB<span style="font-variant-caps:normal">c</span></span></p>', ['smallCaps', 'smallCaps', 'none']]].map(([html, expected]) => { node.innerHTML = html; const model = readWordDom(node, createWordDocument()); return { expected, text: model.paragraphs.flatMap(p => p.runs.map(r => r.text)).join(''), actual: model.paragraphs.flatMap(p => p.runs.flatMap(r => Array.from(r.text, () => r.style.caseMap ?? 'none'))) }; });
      const rejected = []; for (const style of ['text-transform:lowercase', 'text-transform:capitalize', 'font-variant-caps:all-small-caps', 'text-transform:uppercase;font-variant-caps:small-caps']) { node.innerHTML = `<p><span style="${style}">ab</span></p>`; try { readWordDom(node, createWordDocument()); rejected.push({ style, error: null }); } catch (e) { rejected.push({ style, error: e.message }); } }
      return { cycles: 8, visual, css, rejected };
    } finally { node.remove(); }
  }, Array.from(fs.readFileSync(base)));
  for (const item of report.dom.css) assert.deepEqual(item.actual, item.expected); assert.deepEqual(report.dom.css.map(c => c.text), ['a中x😀', 'aBc']); for (const item of report.dom.rejected) assert.ok(item.error, item.style); assert.ok(report.dom.visual.some(v => v.caseMap === 'upper' && v.transform === 'uppercase' && v.variant === 'normal')); assert.ok(report.dom.visual.some(v => v.caseMap === 'smallCaps' && v.transform === 'none' && v.variant === 'small-caps'));
  ok('Eight DOM metadata cycles preserve case/raw text; independent CSS inheritance/reset recovers supported modes and rejects transformations the single case enum cannot represent');

  phase = 'unsupported-and-atomic'; const invalid = [
    ['caps-bad-boolean', '<w:caps w:val="yes"/>'], ['small-bad-boolean', '<w:smallCaps w:val="2"/>'], ['duplicate-caps', '<w:caps/><w:caps w:val="0"/>'], ['unknown-attribute', '<w:smallCaps w:val="1" w:extra="1"/>'], ['nested', '<w:caps><w:b/></w:caps>'], ['duplicate-attribute', '<w:caps w:val="1" w:val="0"/>'],
    ['both-true-caps-first', '<w:caps/><w:smallCaps/>'], ['both-true-small-first', '<w:smallCaps/><w:caps/>'], ['small-true-caps-false-first', '<w:caps w:val="0"/><w:smallCaps/>'], ['small-true-caps-false-last', '<w:smallCaps/><w:caps w:val="false"/>'],
  ]; report.negative = [];
  for (const [name, properties] of invalid) for (const location of ['run', 'marker', 'style']) { const body = location === 'marker' ? `<w:p><w:pPr><w:rPr>${properties}</w:rPr></w:pPr><w:r><w:t>Bad</w:t></w:r></w:p>` : `<w:p>${textRun('Bad', location === 'run' ? properties : '<w:rStyle w:val="Bad"/>')}</w:p>`; const styles = location === 'style' ? `<w:style w:type="character" w:styleId="Bad"><w:rPr>${properties}</w:rPr></w:style>` : ''; const bytes = synthetic(body, styles); const error = await page.evaluate(async b => { try { (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(b)); return null; } catch (e) { return e.message; } }, bytes); assert.ok(error, `${name}/${location} silently accepted`); report.negative.push({ name, location, error }); }
  await open(base); await range(0, 0); await page.keyboard.type('unsaved '); await idle(); const beforeRejection = await content().innerHTML(), tabs = await page.locator('.document-tab').count(); const badFile = input('conflicting-case', '<w:p>' + textRun('Unsupported', '<w:caps/><w:smallCaps/>') + '</w:p>'); const chooser = page.waitForEvent('filechooser'); await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click(); await (await chooser).setFiles(badFile); await page.locator('.error-banner').waitFor(); await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); assert.equal(await content().innerHTML(), beforeRejection); assert.equal(await page.locator('.document-tab').count(), tabs); assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(), 1); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
  ok('30 malformed/conflicting case encodings across run/marker/named style reject explicitly; failed open atomically retains unsaved active document');

  phase = 'strict-subset-atomic';
  const ordinaryUnicode = 'ßﬃéαİıᵃe\u0301中文😀❤️👩‍💻';
  const ordinary = input('ordinary-unicode', '<w:p>' + textRun(ordinaryUnicode, '<w:caps w:val="0"/><w:smallCaps w:val="0"/>') + '</w:p>');
  await open(ordinary); await checkSave('ordinary-unicode-preserved.docx', [chars(ordinaryUnicode)]);
  const unicodeNegative = [];
  for (const mode of ['caps', 'smallCaps']) {
    for (const text of ['ß', 'ﬃ', 'é', 'α', 'İ', 'ı', 'ᵃ', 'e\u0301']) unicodeNegative.push({ name: mode + ':' + text, body: '<w:p>' + textRun(text, `<w:${mode}/>` ) + '</w:p>' });
    for (const language of ['tr-TR', 'az-Latn-AZ', 'el-GR', 'lt-LT', 'ga-IE']) unicodeNegative.push({ name: mode + ':' + language, body: '<w:p>' + textRun('ascii', `<w:${mode}/><w:lang w:val="${language}"/>`) + '</w:p>' });
  }
  unicodeNegative.push({ name: 'paragraph-inherited-caps', body: '<w:p><w:pPr><w:pStyle w:val="Upper"/></w:pPr>' + textRun('ß') + '</w:p>', styles: '<w:style w:type="paragraph" w:styleId="Upper"><w:rPr><w:caps/></w:rPr></w:style>' });
  unicodeNegative.push({ name: 'named-inherited-small', body: '<w:p>' + textRun('é', '<w:rStyle w:val="Small"/>') + '</w:p>', styles: '<w:style w:type="character" w:styleId="Small"><w:rPr><w:smallCaps/></w:rPr></w:style>' });
  unicodeNegative.push({ name: 'document-default-caps', body: '<w:p>' + textRun('e\u0301') + '</w:p>', styles: '<w:docDefaults><w:rPrDefault><w:rPr><w:caps/></w:rPr></w:rPrDefault></w:docDefaults>' });
  report.unicodeNegative = [];
  for (const item of unicodeNegative) { const error = await page.evaluate(async bytes => { try { (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)); return null; } catch (e) { return e.message; } }, synthetic(item.body, item.styles)); assert.ok(error?.includes('请使用完整文字编辑器'), item.name); report.unicodeNegative.push({ name: item.name, error }); }
  report.atomicModel = await page.evaluate(async () => {
    const { WordController, createWordDocument } = await import('/src/word/core/model.ts');
    const selection = (from, to = from) => ({ anchor: { paragraph: 0, offset: from }, focus: { paragraph: 0, offset: to } });
    const snapshot = c => JSON.stringify({ model: c.model, selection: c.selection, revision: c.revision, dirty: c.dirty, canUndo: c.canUndo, canRedo: c.canRedo });
    const doc = createWordDocument(); doc.paragraphs[0].runs = [{ text: 'aß', style: {} }]; const c = new WordController(doc); c.setSelection(selection(0, 1)); c.formatText(selection(0, 1), { bold: true }); c.undo(); const before = snapshot(c); let error;
    try { c.formatText(selection(0, 2), { caseMap: 'upper' }); } catch (e) { error = e.message; } const formatStable = snapshot(c) === before;
    const empty = new WordController(createWordDocument()); empty.formatText(selection(0), { caseMap: 'smallCaps' }); const beforeInput = snapshot(empty); let insertionError;
    try { empty.replaceText(selection(0), 'ß'); } catch (e) { insertionError = e.message; }
    return { formatStable, error, insertionStable: snapshot(empty) === beforeInput, insertionError, activeEmptyMarker: empty.model.paragraphs[0].marker.style.caseMap };
  }); assert.equal(report.atomicModel.formatStable, true); assert.ok(report.atomicModel.error); assert.equal(report.atomicModel.insertionStable, true); assert.ok(report.atomicModel.insertionError); assert.equal(report.atomicModel.activeEmptyMarker, 'smallCaps');
  await open(base); await range(0, 1, 3); const beforeFormat = await content().innerHTML(); await page.getByTestId('word-case-menu-toggle').click(); await page.getByTestId('word-case-upper').click(); await page.locator('.error-banner').waitFor(); assert.equal(await content().innerHTML(), beforeFormat); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await page.keyboard.press('Escape'); await idle(); await checkSave('rejected-case-format.docx', baseExpected);
  await range(4, 0); const beforeInput = await content().innerHTML(); await page.keyboard.insertText('ß'); await page.locator('.error-banner').waitFor(); assert.equal(await content().innerHTML(), beforeInput); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle(); await checkSave('rejected-empty-marker-input.docx', baseExpected);
  const emoji = input('active-uncased-unicode', '<w:p>' + textRun('ASCII 中文😀❤️👩‍💻', '<w:caps/>') + '</w:p><w:p>' + textRun('ascii 中文😀❤️👩‍💻', '<w:smallCaps/>') + '</w:p>'); await open(emoji); await checkSave('active-uncased-unicode.docx', [chars('ASCII 中文😀❤️👩‍💻', 'upper'), chars('ascii 中文😀❤️👩‍💻', 'smallCaps')]);
  ok('Strict active-case Unicode/locale subset rejects direct and inherited inputs plus formatting and empty-marker insertion atomically; ordinary Unicode and active ASCII/CJK/emoji variation sequences retain source text');

  phase = 'narrow-menu'; await page.setViewportSize({ width: 800, height: 1000 }); await page.getByTestId('word-case-menu-toggle').click(); const bounds = await page.getByTestId('word-case-menu').boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 800 && bounds.y >= 0); await page.screenshot({ path: path.join(output, 'case-menu-narrow.png'), fullPage: true }); await page.keyboard.press('Escape');
  hashes(); report.productAfter = sourceHashes(); report.testAfter = testHashes(); assert.deepEqual(report.productAfter, report.productBefore, 'Product changed during validation'); assert.deepEqual(report.testAfter, report.testBefore, 'Test/manifest changed during validation'); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.runtimeRequests, []); report.ok = true;
} catch (error) { report.ok = false; report.failure = { phase, message: error.message, stack: error.stack }; if (page) try { report.failure.body = (await page.locator('body').innerText()).slice(-6000); await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {} console.error(error); process.exitCode = 1; }
finally { report.completedAtUtc = new Date().toISOString(); persist(); if (browser) await browser.close(); if (server) await server.close(); } })();
