/* Page-setting contract suite. Native fixture expectations are independently
 * frozen in the corpus manifest; application exports never establish them. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

const root = path.resolve(__dirname, '../..');
const corpus = path.join(root, 'tests/compatibility/independent-word-page-settings');
const output = path.resolve(process.env.WORD_PAGE_SETTINGS_OUTPUT || path.join(root, 'test-results/independent-word-page-settings'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const run = promisify(execFile);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const productSources = ['src/word/core/model.ts', 'src/word/core/paper.ts', 'src/word/core/docx.ts', 'src/word/core/dom.ts', 'src/word/core/editor.css', 'src/style.css', 'src/components/StandaloneWordEditor.vue'];
const testSources = ['tests/browser/independent-word-page-settings.cjs', 'tests/compatibility/independent-word-page-settings/inspect_docx.py', 'tests/compatibility/independent-word-page-settings/freeze.py', 'tests/compatibility/independent-word-page-settings/manifest.json', 'tests/compatibility/independent-word-page-settings/research-provenance.json'];
const hashes = files => Object.fromEntries(files.map(file => [file, sha256(path.join(root, file))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect_docx.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const inspectPdf = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect_docx.py'), '--pdf', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const effectivePage = document => { const s = section(document); return { ...s.explicitPoints, orientation: s.size?.orient || 'portrait' }; };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .03, `${label}: ${actual} vs ${expected}pt`);
const section = document => { assert.equal(document.sections.length, 1); assert.equal(document.sections[0].location, 'body'); return document.sections[0]; };
let server, browser, page;
let phase = 'startup';
const report = { startedAtUtc: new Date().toISOString(), scope: 'Single-section paper dimensions, orientation and four margins', limitations: ['Continuous view checks paper width and body area only, not native pagination.', 'One pinned LibreOffice version; no Microsoft Word runtime or actual Tauri IPC.', 'UI normalizes near-standard paper sizes at Apply time for save/reopen stability; native property edits may wait until DOCX reopening.'], checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [] };
const persist = () => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); };
const ok = message => { report.checks.push(message); console.log('PASS', message); persist(); };
const content = () => page.getByTestId('word-content');
async function idle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner'); if (error) throw Error(error.textContent);
    return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  });
  assert.equal(await page.locator('iframe').count(), 0);
}
async function open(file, home = false) {
  const chooser = page.waitForEvent('filechooser');
  if (home) await page.getByTestId('independent-word-open').click();
  else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(file); await idle();
}
async function save(name) {
  const download = page.waitForEvent('download'); await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click();
  const result = await download, file = path.join(output, name); assert.match(result.suggestedFilename(), /\.docx$/i); await result.saveAs(file); await idle();
  return { file, document: inspect(file) };
}
async function range(start, end = start) {
  await content().evaluate((node, { start, end }) => {
    const at = offset => { const walker = document.createTreeWalker(node.children[0], NodeFilter.SHOW_TEXT); let text; while ((text = walker.nextNode())) { if (offset <= text.length) return [text, offset]; offset -= text.length; } throw Error('Invalid range'); };
    node.focus(); window.getSelection().setBaseAndExtent(...at(start), ...at(end)); document.dispatchEvent(new Event('selectionchange'));
  }, { start, end });
}
async function selectedRange() { return content().evaluate(async node => (await import('/src/word/core/dom.ts')).readWordSelection(node)); }
async function undo() { await page.locator('.command-bar button[title="撤销"]').click(); await idle(); }
async function redo() { await page.locator('.command-bar button[title="重做"]').click(); await idle(); }
const control = name => page.getByTestId('word-page-settings-' + name);
async function nativeRoundtrip(file, name) {
  const destination = path.join(output, 'native', name); fs.mkdirSync(destination, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-page-settings-native-'));
  try {
    const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const target = path.join(destination, path.basename(file)); assert.ok(fs.existsSync(target), result.stdout + result.stderr);
    return { file: target, sha256: sha256(target), document: inspect(target), stdout: result.stdout, stderr: result.stderr };
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
async function menu() { await control('toggle').click(); await control('panel').waitFor(); }
async function apply() { await control('apply').click(); }
async function cancel() { await control('cancel').click(); await control('panel').waitFor({ state: 'hidden' }); }
const fieldNames = { width: 'width', height: 'height', marginTop: 'margin-top', marginBottom: 'margin-bottom', marginLeft: 'margin-left', marginRight: 'margin-right' };
async function setFields(patch) { for (const [key, value] of Object.entries(patch)) await control(fieldNames[key]).fill(String(value)); }
async function checkedSave(name, expected, paragraphs) {
  const saved = await save(name); assert.deepEqual(effectivePage(saved.document), expected, name);
  if (paragraphs) assert.deepEqual(saved.document.paragraphs, paragraphs, name + ' body');
  assert.equal(section(saved.document).margins.header, '0'); assert.equal(section(saved.document).margins.footer, '0'); assert.equal(section(saved.document).margins.gutter, '0');
  return saved;
}
async function checkedGeometry(expected, label) {
  const actual = await geometry(); near(actual.widthPt, expected.width, label + ' width'); near(actual.minHeightPt, expected.height, label + ' minimum height');
  for (const key of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) near(actual.marginsPt[key], expected[key], label + ' ' + key);
  near(actual.bodyWidthPt, expected.width - expected.marginLeft - expected.marginRight, label + ' body width'); near(actual.paragraphWidthPt, actual.bodyWidthPt, label + ' paragraph width');
  assert.equal(actual.borderWidthPt, 0, label + ' decoration must not consume page geometry'); return actual;
}
function malformed(base, name, sectionXml) {
  const parts = unzipSync(fs.readFileSync(base));
  const xml = strFromU8(parts['word/document.xml']).replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, sectionXml);
  assert.notEqual(xml, strFromU8(parts['word/document.xml'])); parts['word/document.xml'] = strToU8(xml);
  const file = path.join(output, 'negative-' + name + '.docx'); fs.writeFileSync(file, zipSync(parts)); return file;
}
async function geometry() {
  return content().evaluate(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    const px = name => Number.parseFloat(style[name]);
    return { widthPt: box.width * .75, minHeightPt: px('minHeight') * .75,
      marginsPt: { marginTop: px('paddingTop') * .75, marginRight: px('paddingRight') * .75, marginBottom: px('paddingBottom') * .75, marginLeft: px('paddingLeft') * .75 },
      bodyWidthPt: (box.width - px('borderLeftWidth') - px('borderRightWidth') - px('paddingLeft') - px('paddingRight')) * .75,
      borderWidthPt: (px('borderLeftWidth') + px('borderRightWidth')) * .75,
      boxSizing: style.boxSizing, paragraphWidthPt: node.children[0]?.getBoundingClientRect().width * .75 };
  });
}

async function main() {
  try {
    // No manifest is authored from the product. Research first freezes complete
    // source/native files and declares page expectations for this runner.
    const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
    report.productBefore = hashes(productSources); report.testBefore = hashes(testSources);
    const verify = () => { for (const f of manifest.fixtures) { assert.equal(sha256(path.join(corpus, f.source)), f.sourceSha256); assert.equal(sha256(path.join(corpus, f.docx)), f.docxSha256); for (const artifact of [f.pdf, f.secondDocx, f.secondPdf].filter(Boolean)) assert.equal(sha256(path.join(corpus, artifact.path)), artifact.sha256); } }; verify(); report.corpus = manifest;
    const provenance = JSON.parse(fs.readFileSync(path.join(corpus, 'research-provenance.json'), 'utf8'));
    for (const record of provenance) assert.equal(sha256(record.path), record.sha256); report.researchProvenance = provenance;
    const { createServer } = await import('vite'); server = await createServer({ root, cacheDir: 'node_modules/.vite-word-page-settings-test', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } } }); await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`, origin = new URL(url).origin;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true }); page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
    page.on('request', r => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) report.externalRequests.push(u.href); if (/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(u.href)) report.runtimeRequests.push(u.href); });
    page.on('pageerror', e => report.pageErrors.push({ phase, message: e.message })); page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ phase, message: m.text() }); });
    await page.goto(url); await page.getByTestId('independent-word-open').waitFor();

    // Complete-package import gate precedes all editing/native work so an
    // unrelated existing import limitation cannot hide halfway through it.
    phase = 'complete-package-import-gate'; report.gate = [];
    for (const f of manifest.fixtures) for (const kind of f.expectUnsupported ? ['docx'] : ['source', 'docx']) {
      const result = await page.evaluate(async bytes => { try { const model = (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)); return { accepted: true, page: model.page }; } catch (error) { return { accepted: false, error: error.message }; } }, Array.from(fs.readFileSync(path.join(corpus, f[kind]))));
      assert.equal(result.accepted, !f.expectUnsupported, `${f.name}/${kind}: ${result.error}`); report.gate.push({ name: f.name, kind, ...result });
    }
    ok('Complete positive sources/native outputs and negative packages pass their independently declared import gates');

    assert.ok(manifest.contractFrozen, 'Native page-setting contract is not frozen');
    if (process.env.WORD_PAGE_SETTINGS_GATE_ONLY === '1') { report.productAfter = hashes(productSources); report.testAfter = hashes(testSources); assert.deepEqual(report.productAfter, report.productBefore); assert.deepEqual(report.testAfter, report.testBefore); report.gateOnly = true; report.ok = true; return; }
    const positives = manifest.fixtures.filter(f => !f.expectUnsupported), find = name => { const f = positives.find(f => f.name === name); assert.ok(f, name); return f; };
    phase = 'native-packages-and-geometry'; report.native = []; report.geometry = []; let opened = false;
    for (const f of positives) {
      const source = path.join(corpus, f.source), native = path.join(corpus, f.docx), text = inspect(source).paragraphs;
      assert.deepEqual(effectivePage(inspect(native)), f.expected, f.name + ' independent native XML');
      assert.deepEqual(effectivePage(inspect(path.join(corpus, f.secondDocx.path))), f.expected, f.name + ' native second XML');
      const pdf = inspectPdf(path.join(corpus, f.pdf.path)), pdf2 = inspectPdf(path.join(corpus, f.secondPdf.path));
      for (const pages of [pdf, pdf2]) { assert.ok(pages.length); near(pages[0].mediaBox[2], f.expected.width, f.name + ' PDF width'); near(pages[0].mediaBox[3], f.expected.height, f.name + ' PDF height'); }
      await open(source, !opened); opened = true;
      const saved = await checkedSave(f.name + '-source.docx', f.sourceExpected, text);
      const sourceGeometry = await checkedGeometry(f.sourceExpected, f.name + ' source');
      if (f.roundtrip) {
        const result = await nativeRoundtrip(saved.file, f.name); assert.deepEqual(effectivePage(result.document), f.expected, f.name + ' actual native resave'); assert.deepEqual(result.document.paragraphs, text);
        await open(result.file); await checkedSave(f.name + '-resave-reopened.docx', f.expected, text); report.native.push({ name: f.name, ...result });
      }
      await open(native); await checkedSave(f.name + '-native.docx', f.expected, text);
      report.geometry.push({ name: f.name, nativePdf: pdf[0].mediaBox, secondPdf: pdf2[0].mediaBox, source: sourceGeometry, native: await checkedGeometry(f.expected, f.name + ' native') });
    }
    ok('Frozen native XML/PDF, authored imports, actual Writer resaves and reopened downloads preserve paper dimensions, orientation and margins; browser paper/body widths match without decorative border loss');

    phase = 'real-page-ui-history-selection'; const base = find('a4-portrait'), custom = find('custom-odd'), baseFile = path.join(corpus, base.source), text = inspect(baseFile).paragraphs;
    await open(baseFile); await range(1, 4); const originalSelection = await selectedRange();
    await menu(); await setFields(Object.fromEntries(Object.entries(custom.sourceExpected).filter(([key]) => key !== 'orientation'))); await apply(); await idle();
    assert.deepEqual(await selectedRange(), originalSelection); const customSaved = await checkedSave('ui-custom.docx', custom.sourceExpected, text); await checkedGeometry(custom.sourceExpected, 'UI custom');
    await undo(); assert.deepEqual(await selectedRange(), originalSelection); await checkedSave('ui-custom-undo.docx', base.sourceExpected, text); assert.equal(await page.getByTestId('word-undo').isEnabled(), false);
    await redo(); assert.deepEqual(await selectedRange(), originalSelection); await checkedSave('ui-custom-redo.docx', custom.sourceExpected, text);
    const uiNative = await nativeRoundtrip(customSaved.file, 'ui-custom'); assert.deepEqual(effectivePage(uiNative.document), custom.expected); await open(uiNative.file); await checkedSave('ui-custom-native-reopened.docx', custom.expected, text); report.uiNative = uiNative;
    report.presets = [];
    for (const preset of ['a4', 'a5', 'letter', 'legal']) {
      await open(path.join(corpus, custom.source)); await range(1, 4); const selection = await selectedRange(); await menu(); await control('orientation-landscape').check(); await control('preset-' + preset).check(); await apply(); await idle();
      const standard = manifest.presets[preset], expected = { ...custom.sourceExpected, width: standard.height, height: standard.width, orientation: 'landscape' };
      const result = await checkedSave('ui-preset-' + preset + '.docx', expected); assert.deepEqual(await selectedRange(), selection); await checkedGeometry(expected, preset + ' landscape');
      await undo(); await checkedSave('ui-preset-' + preset + '-undo.docx', custom.sourceExpected); assert.deepEqual(await selectedRange(), selection); assert.equal(await page.getByTestId('word-undo').isEnabled(), false); report.presets.push({ preset, expected, file: result.file });
    }
    for (const name of ['tall-landscape-flag', 'wide-portrait-flag']) {
      const f = find(name); await open(path.join(corpus, f.source)); await menu(); assert.equal(await control('orientation-' + f.sourceExpected.orientation).isChecked(), true); await apply(); await checkedSave(name + '-ui-noop.docx', f.sourceExpected); assert.equal(await page.getByTestId('word-undo').isEnabled(), false);
    }
    ok('Actual page controls apply six custom values or preset/orientation as one undoable transaction, preserve body selection, retain margins across orientation changes and leave contradictory imported flags untouched on no-op Apply');

    phase = 'invalid-atomic-and-history'; await open(baseFile); await range(1, 4); const unchanged = await content().innerHTML(), beforeGeometry = await geometry();
    for (const [name, patch] of [['width-low', { width: 71.95 }], ['height-high', { height: 1584.05 }], ['negative-margin', { marginLeft: -.05 }], ['fraction-twip', { width: 700.01 }], ['occupied-width', { marginLeft: 300, marginRight: 300 }], ['occupied-height', { marginTop: 500, marginBottom: 400 }], ['empty', { width: '' }], ['native-drift', { width: 298.25 }], ['fractional-zero-body', { width: 72.15, marginLeft: .05, marginRight: 72.1 }]]) {
      await menu(); await setFields(patch); await apply(); assert.equal(await control('panel').isVisible(), true, name); assert.ok(await control('panel').getByRole('alert').innerText()); assert.equal(await content().innerHTML(), unchanged); assert.deepEqual(await geometry(), beforeGeometry); assert.equal(await page.getByTestId('word-undo').isEnabled(), false); await cancel();
    }
    report.atomicModel = await page.evaluate(async () => {
      const { WordController, createWordDocument } = await import('/src/word/core/model.ts');
      const patches = [null, [], { width: NaN }, { height: Infinity }, { orientation: 'reverse' }, { paper: 'a4' }, { width: 700.01 }, { marginLeft: -1 }, { marginLeft: 400, marginRight: 400 }, { width: 71.95 }, { height: 1584.05 }, { width: 298.25 }, { width: 72.15, marginLeft: .05, marginRight: 72.1 }];
      return patches.map(patch => { const c = new WordController(createWordDocument()), before = JSON.stringify(c.model), revision = c.revision; let error; try { c.formatPage(patch); } catch (e) { error = e.message; } return { patch: JSON.stringify(patch), error, unchanged: before === JSON.stringify(c.model), revisionStable: c.revision === revision, canUndo: c.canUndo }; });
    });
    for (const row of report.atomicModel) { assert.ok(row.error, row.patch); assert.equal(row.unchanged, true); assert.equal(row.revisionStable, true); assert.equal(row.canUndo, false); }
    const negatives = manifest.fixtures.filter(f => f.expectUnsupported).map(f => ({ name: f.name, file: path.join(corpus, f.docx) }));
    for (const [name, xml] of [['fraction', '<w:pgSz w:w="12000.5"/>'], ['invalid-orient', '<w:pgSz w:orient="reverse"/>'], ['empty-orient', '<w:pgSz w:orient=""/>'], ['too-wide', '<w:pgSz w:w="31681"/>'], ['too-small', '<w:pgSz w:w="1439"/>'], ['native-drift', '<w:pgSz w:w="5965"/>'], ['fractional-zero-body', '<w:pgSz w:w="1443"/><w:pgMar w:left="1" w:right="1442"/>'], ['duplicate-size', '<w:pgSz/><w:pgSz/>'], ['duplicate-margins', '<w:pgMar/><w:pgMar/>']]) negatives.push({ name, file: malformed(baseFile, name, '<w:sectPr>' + xml + '</w:sectPr>') });
    await range(0); await page.keyboard.insertText('unsaved '); await idle(); report.negative = [];
    for (const item of negatives) {
      const before = await content().innerHTML(), tabs = await page.locator('.document-tab').count(); const chooser = page.waitForEvent('filechooser'); await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click(); await (await chooser).setFiles(item.file);
      await page.locator('.error-banner').waitFor(); await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); assert.equal(await content().innerHTML(), before); assert.equal(await page.locator('.document-tab').count(), tabs); assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(), 1);
      report.negative.push({ name: item.name, error: await page.locator('.error-banner').innerText(), sha256: sha256(item.file) }); await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
    }
    await undo(); await checkedSave('failed-open-history.docx', base.sourceExpected, text);
    ok('Invalid UI/model fields and malformed or unsupported complete packages reject atomically without changing page/body content, dirty state or undo history');

    phase = 'cancel-caret-stale-narrow'; await open(baseFile); await range(1, 4); await menu(); await setFields({ width: 700.05 }); await page.keyboard.press('Escape'); await control('panel').waitFor({ state: 'hidden' }); assert.deepEqual(await selectedRange(), originalSelection); await checkedSave('escape-cancelled.docx', base.sourceExpected, text);
    await menu(); await setFields({ marginLeft: 36.2 }); await range(2, 3); const movedSelection = await selectedRange(); assert.equal(await control('panel').isVisible(), true); await apply(); await idle(); assert.deepEqual(await selectedRange(), movedSelection); await checkedSave('caret-keeps-draft.docx', { ...base.sourceExpected, marginLeft: 36.2 }, text); await undo();
    await menu(); await setFields({ marginRight: 40 }); await range(0); await page.keyboard.insertText('edit '); await idle(); await control('panel').waitFor({ state: 'hidden' }); await undo(); await checkedSave('revision-discards-draft.docx', base.sourceExpected, text);
    await page.setViewportSize({ width: 320, height: 400 }); await menu();
    for (const id of ['apply', 'cancel']) assert.equal(await control(id).evaluate(n => { const b = n.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && n.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), true, id + ' reachable');
    await page.screenshot({ path: path.join(output, 'page-settings-narrow.png') }); await cancel(); await menu(); await control('margin-left').fill('36.2'); await apply(); await idle(); await checkedSave('narrow-apply.docx', { ...base.sourceExpected, marginLeft: 36.2 }, text); await undo(); await checkedSave('narrow-undo.docx', base.sourceExpected, text); await page.setViewportSize({ width: 1360, height: 1000 });
    ok('Escape/Cancel retain the original page and selection, caret movement retains a page-global draft, body edits invalidate stale drafts, and 320×400 controls remain actionable with one-step undo');

    verify(); for (const record of provenance) assert.equal(sha256(record.path), record.sha256); report.productAfter = hashes(productSources); report.testAfter = hashes(testSources);
    assert.deepEqual(report.productAfter, report.productBefore); assert.deepEqual(report.testAfter, report.testBefore);
    for (const key of ['pageErrors', 'consoleErrors', 'externalRequests', 'runtimeRequests']) assert.deepEqual(report[key], []);
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = { phase, message: error.message, stack: error.stack }; if (page) try { report.failure.body = (await page.locator('body').innerText()).slice(-6000); await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {} console.error(error); process.exitCode = 1;
  } finally {
    report.completedAtUtc = new Date().toISOString(); persist(); if (browser) await browser.close(); if (server) await server.close();
  }
}

if (require.main === module) main();
