/* Paragraph indentation compatibility: unmodified native LibreOffice DOCX,
 * actual editor UI, downloaded packages, independent Python XML inspection,
 * native LibreOffice resave/reopen, and strict malformed OOXML rejection.
 */
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
const corpus = path.join(root, 'tests/compatibility/independent-word-indentation');
const output = path.resolve(process.env.INDEPENDENT_WORD_INDENT_OUTPUT || path.join(root, 'test-results/independent-word-indentation'));
const sourceFile = path.join(corpus, 'libreoffice/paragraph-indentation.docx');
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const fixture = manifest.fixtures[0];
const expected = fixture.expectedSemantics.indentPoints;
const soffice = process.env.SOFFICE || 'soffice';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  scope: 'Independent Word paragraph indentation, native LibreOffice DOCX corpus and save/reopen interoperability',
  limitations: ['One installed native LibreOffice build; no Microsoft Word runtime.', 'Continuous browser layout only; no native pagination or pixel-fidelity claim.', 'Enter/Delete are Chromium UI tests, not native LibreOffice keystroke tests.'],
  corpus: { source: sourceFile, sha256: sha256(sourceFile), libreoffice: manifest.libreoffice },
  checks: [], pageErrors: [], consoleErrors: [], runtimeRequests: [], externalRequests: [],
};
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const ok = message => { report.checks.push(message); console.log('PASS', message); persist(); };
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8' }));
const indents = document => document.paragraphs.map(p => p.indent);
const texts = document => document.paragraphs.map(p => p.text);
let server, browser, page, phase = 'startup';
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
  const download = page.waitForEvent('download');
  await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click();
  const result = await download, file = path.join(output, name);
  assert.match(result.suggestedFilename(), /\.docx$/i); await result.saveAs(file); await idle(); return file;
}
async function caret(paragraph, offset) {
  await content().evaluate((node, { paragraph, offset }) => {
    const p = node.children[paragraph], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) {
      if (offset <= n.length) { node.focus(); window.getSelection().setBaseAndExtent(n, offset, n, offset); document.dispatchEvent(new Event('selectionchange')); return; }
      offset -= n.length;
    }
    throw Error('Invalid caret position');
  }, { paragraph, offset });
}
async function selectParagraphRange(first, last, offset) {
  await content().evaluate((node, { first, last, offset }) => {
    const point = (index, position) => {
      const walker = document.createTreeWalker(node.children[index], NodeFilter.SHOW_TEXT); let n;
      while ((n = walker.nextNode())) { if (position <= n.length) return [n, position]; position -= n.length; }
      throw Error('Invalid range position');
    };
    node.focus(); window.getSelection().setBaseAndExtent(...point(first, 0), ...point(last, offset));
    document.dispatchEvent(new Event('selectionchange'));
  }, { first, last, offset });
}
async function undo() { await page.locator('.command-bar button[title="撤销"]').click(); await idle(); }
async function redo() { await page.locator('.command-bar button[title="重做"]').click(); await idle(); }
async function domParagraphs() {
  return content().evaluate(node => [...node.children].map(p => {
    const css = getComputedStyle(p);
    return { text: p.textContent, left: parseFloat(css.marginLeft) * 0.75, right: parseFloat(css.marginRight) * 0.75, firstLine: parseFloat(css.textIndent) * 0.75 };
  }));
}
async function assertRendered(expectations) {
  const actual = await domParagraphs();
  assert.equal(actual.length, expectations.length);
  actual.forEach((p, i) => { for (const key of ['left', 'right', 'firstLine']) assert.ok(Math.abs(p[key] - expectations[i][key]) < 0.02, `Paragraph ${i + 1} CSS ${key}: ${p[key]} != ${expectations[i][key]}`); });
}
async function nativeRoundtrip(file, name) {
  const destination = path.join(output, 'native', name); fs.mkdirSync(destination, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-indent-native-'));
  try {
    const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file];
    const result = await run(soffice, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
    const converted = path.join(destination, path.basename(file));
    assert.ok(fs.existsSync(converted), result.stdout + result.stderr);
    return { file: converted, stdout: result.stdout, stderr: result.stderr, document: inspect(converted) };
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
function synthetic(body, styles = '') {
  const parts = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ''}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${PR}"><Relationship Id="r1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  if (styles) {
    parts['word/styles.xml'] = `<w:styles xmlns:w="${W}">${styles}</w:styles>`;
    parts['word/_rels/document.xml.rels'] = `<Relationships xmlns="${PR}"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`;
  }
  return Array.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]))));
}

(async () => { try {
  assert.equal(sha256(sourceFile), fixture.docxSha256, 'Native corpus must remain byte-for-byte unchanged');
  const source = inspect(sourceFile);
  assert.deepEqual(texts(source), fixture.expectedParagraphs); assert.deepEqual(indents(source), expected);
  assert.deepEqual(source.paragraphs[4].sourceIndent, { left: 36, right: 18, firstLine: -18 });
  assert.deepEqual(source.paragraphs[4].directIndent, { left: 0, right: 0, firstLine: 0 });
  report.original = source;
  const { createServer } = await import('vite');
  server = await createServer({ root, cacheDir: 'node_modules/.vite-word-indentation-test', server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`, origin = new URL(url).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
  page.on('request', request => { const target = new URL(request.url()); if (/^https?:$/.test(target.protocol) && target.origin !== origin) report.externalRequests.push(target.href); if (/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(target.href)) report.runtimeRequests.push(target.href); });
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text() }); });
  await page.goto(url); await page.getByTestId('independent-word-open').waitFor();

  phase = 'original-native-import';
  await open(sourceFile, true); await assertRendered(expected);
  assert.deepEqual((await domParagraphs()).map(p => p.text), fixture.expectedParagraphs);
  const imported = await page.evaluate(async bytes => (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)), Array.from(fs.readFileSync(sourceFile)));
  const zero = imported.paragraphs[4];
  assert.deepEqual([zero.sourceParagraph.indentLeft, zero.sourceParagraph.indentRight, zero.sourceParagraph.indentFirstLine], [36, 18, -18]);
  assert.deepEqual([zero.directStyle.indentLeft, zero.directStyle.indentRight, zero.directStyle.indentFirstLine], [0, 0, 0]);
  ok('Native named-style and direct zero-reset indentation imports with separate inherited/direct provenance and correct CSS geometry');

  phase = 'native-roundtrip';
  await caret(6, fixture.expectedParagraphs[6].length); await page.keyboard.insertText(' 中文编辑😀'); await idle();
  const edited = await save('paragraph-indentation-edited.docx'), saved = inspect(edited);
  assert.deepEqual(indents(saved), expected); assert.equal(saved.paragraphs[6].text, fixture.expectedParagraphs[6] + ' 中文编辑😀');
  assert.deepEqual(saved.paragraphs[4].sourceIndent, source.paragraphs[4].sourceIndent);
  assert.deepEqual(saved.paragraphs[4].directIndent, source.paragraphs[4].directIndent);
  report.nativeControl = await nativeRoundtrip(sourceFile, 'control');
  report.nativeEdited = await nativeRoundtrip(edited, 'edited');
  assert.deepEqual(indents(report.nativeControl.document), expected); assert.deepEqual(indents(report.nativeEdited.document), expected);
  assert.deepEqual(texts(report.nativeEdited.document), texts(saved));
  await open(report.nativeEdited.file); await assertRendered(expected);
  report.secondDownload = inspect(await save('paragraph-indentation-reopened.docx'));
  assert.deepEqual(indents(report.secondDownload), expected); assert.deepEqual(texts(report.secondDownload), texts(saved));
  ok('Native DOCX -> UI edit/download -> native LibreOffice resave -> UI reopen/download preserves all seven paragraphs and indentation');

  phase = 'synthetic-inheritance-and-negative-cases';
  const styles = '<w:style w:type="paragraph" w:styleId="Body"><w:pPr><w:ind w:left="720" w:right="360" w:hanging="240"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:next w:val="Body"/><w:pPr><w:ind w:left="480" w:right="240" w:firstLine="240"/><w:outlineLvl w:val="0"/></w:pPr></w:style>';
  const body = '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Body"/><w:ind w:firstLine="0" w:left="0" w:right="0"/></w:pPr><w:r><w:t>Zero</w:t></w:r></w:p>';
  report.synthetic = await page.evaluate(async bytes => {
    const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts');
    const { WordController } = await import('/src/word/core/model.ts');
    const original = importWordDocument(Uint8Array.from(bytes));
    const reopened = importWordDocument(exportWordDocument(original));
    const controller = new WordController(reopened);
    controller.replaceText({ anchor: { paragraph: 0, offset: 7 }, focus: { paragraph: 0, offset: 7 } }, '\n');
    const result = importWordDocument(exportWordDocument(controller.model));
    return { original, reopened, split: result };
  }, synthetic(body, styles));
  for (const doc of [report.synthetic.original, report.synthetic.reopened]) {
    assert.deepEqual([doc.paragraphs[1].style.indentLeft, doc.paragraphs[1].style.indentRight, doc.paragraphs[1].style.indentFirstLine], [0, 0, 0]);
    assert.deepEqual([doc.paragraphs[1].sourceParagraph.indentLeft, doc.paragraphs[1].sourceParagraph.indentRight, doc.paragraphs[1].sourceParagraph.indentFirstLine], [36, 18, -12]);
  }
  assert.deepEqual([report.synthetic.split.paragraphs[1].style.indentLeft, report.synthetic.split.paragraphs[1].style.indentRight, report.synthetic.split.paragraphs[1].style.indentFirstLine], [36, 18, -12]);
  report.lineHeightRegression = await page.evaluate(async () => {
    const { importWordDocument, exportWordDocument } = await import('/src/word/core/docx.ts');
    const { createWordDocument, normalizeDocument, WordController } = await import('/src/word/core/model.ts');
    const styles = [];
    for (const inherited of [true, false]) {
      const doc = createWordDocument(), paragraph = doc.paragraphs[0];
      paragraph.sourceRun = {}; paragraph.style = { lineHeight: 18, lineHeightRule: 'exact' };
      paragraph.directStyle = inherited ? {} : { lineHeight: 18 };
      if (inherited) paragraph.sourceParagraph = { lineHeight: 12, lineHeightRule: 'exact' };
      const imported = importWordDocument(exportWordDocument(doc)); styles.push(imported.paragraphs[0].style);
      if (imported.paragraphs[0].style.lineHeight !== 18 || imported.paragraphs[0].style.lineHeightRule !== 'exact') throw Error('Rebased or legacy direct line-height lost its exact rule');
    }
    // The paragraph-spacing native probe replaces the old self-roundtrip-only
    // upper bound: Writer's intermediate unit conversion is stable throughout
    // 1..333%, but larger values can drift or overflow on native save/reopen.
    const maximum = createWordDocument(); maximum.paragraphs[0].style = { lineHeight: 3.33, lineHeightRule: 'auto' };
    const roundtrip = importWordDocument(exportWordDocument(maximum));
    if (roundtrip.paragraphs[0].style.lineHeight !== 3.33) throw Error('Maximum supported automatic line-height fails to roundtrip');
    const rejectedValues = [];
    for (const unsupported of [3.34, 132, 132.01]) {
      maximum.paragraphs[0].style.lineHeight = unsupported;
      let rejected = false; try { normalizeDocument(maximum); } catch { rejected = true; }
      if (!rejected) throw Error('Automatic line-height outside the verified continuous native range was accepted');
      rejectedValues.push(unsupported);
    }
    const keep = [];
    for (const direct of [true, false]) {
      const doc = createWordDocument(), paragraph = doc.paragraphs[0];
      paragraph.sourceRun = { fontSize: 12 }; paragraph.runs = [{ text: 'AB', style: { fontSize: 12 }, directStyle: {} }];
      paragraph.style = { keepNext: true, keepLines: true };
      paragraph.directStyle = direct ? { keepNext: true, keepLines: true } : {};
      const results = [];
      for (const candidate of [doc, importWordDocument(exportWordDocument(doc))]) {
        const controller = new WordController(candidate);
        controller.replaceText({ anchor: { paragraph: 0, offset: 1 }, focus: { paragraph: 0, offset: 1 } }, '\n');
        const successor = controller.model.paragraphs[1];
        if (!!successor.style.keepNext !== !direct || !!successor.style.keepLines !== !direct) throw Error('Saving changed hard/inherited keep semantics during Enter');
        results.push(successor.style);
      }
      keep.push({ direct, beforeAndAfterSave: results });
    }
    return { styles, maximum: roundtrip.paragraphs[0].style, rejectedValues, keep };
  });
  const invalid = [
    ['character-left', '<w:ind w:leftChars="100"/>'], ['character-start', '<w:ind w:startChars="100"/>'],
    ['character-right', '<w:ind w:rightChars="100"/>'], ['character-end', '<w:ind w:endChars="100"/>'],
    ['character-first-line', '<w:ind w:firstLineChars="100"/>'], ['character-hanging', '<w:ind w:hangingChars="100"/>'],
    ['conflicting-left-alias', '<w:ind w:left="120" w:start="240"/>'], ['conflicting-right-alias', '<w:ind w:right="120" w:end="240"/>'],
    ['conflicting-first-hanging', '<w:ind w:firstLine="120" w:hanging="240"/>'],
    ['negative-first-line', '<w:ind w:firstLine="-1"/>'], ['negative-hanging', '<w:ind w:hanging="-1"/>'],
    ['fractional-twips', '<w:ind w:left="2.5"/>'], ['unknown-indent-attribute', '<w:ind w:unknown="1"/>'],
    ['mirror-indent', '<w:mirrorIndents/>'], ['rtl-indent', '<w:bidi/><w:ind w:left="100"/>'],
  ];
  report.negative = [];
  for (const [name, props] of invalid) {
    const bytes = synthetic(`<w:p><w:pPr>${props}</w:pPr><w:r><w:t>Must reject</w:t></w:r></w:p>`);
    const rejected = await page.evaluate(async bytes => { try { (await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes)); return null; } catch (error) { return error.message; } }, bytes);
    assert.ok(rejected, `${name} was silently accepted`); report.negative.push({ name, message: rejected });
  }
  ok('Inherited-only heading follows body indentation after Enter; explicit zero survives two saves; 15 unsupported/ambiguous indentation encodings reject');
  ok('Paragraph provenance retains exact line-height and legacy hard/inherited keep flags through save and Enter; maximum automatic line-height self-roundtrips');

  phase = 'ui-indent-controls';
  await open(sourceFile); await caret(3, 10);
  await page.getByTestId('word-indent-toggle').click();
  await page.getByTestId('word-indent-left').fill('48');
  await page.getByTestId('word-indent-right').fill('24');
  await page.getByTestId('word-indent-first-line').fill('-12');
  await page.screenshot({ path: path.join(output, 'indentation-panel.png'), fullPage: true });
  await page.getByTestId('word-indent-apply').click(); await idle();
  const uiExpected = expected.map(p => ({ ...p })); uiExpected[3] = { left: 48, right: 24, firstLine: -12 };
  await assertRendered(uiExpected);
  const uiFile = await save('paragraph-indentation-ui.docx'); report.uiEdited = inspect(uiFile);
  assert.deepEqual(indents(report.uiEdited), uiExpected);
  await undo(); const afterUndo = await domParagraphs(); assert.equal(afterUndo[3].firstLine, -18);
  await redo(); await assertRendered(uiExpected);
  await open(uiFile); await assertRendered(uiExpected);
  ok('Paragraph settings change left/right/hanging indentation; undo/redo and DOCX reopen preserve the result');

  phase = 'structural-edits';
  const originalText = texts(report.uiEdited);
  await caret(3, 8); await page.keyboard.press('Enter'); await idle();
  const split = inspect(await save('paragraph-indentation-split.docx'));
  assert.deepEqual(split.paragraphs[3].indent, uiExpected[3]); assert.deepEqual(split.paragraphs[4].indent, uiExpected[3]);
  assert.equal(split.paragraphs[3].text + split.paragraphs[4].text, originalText[3]);
  await undo(); await caret(4, 0); await page.keyboard.press('Backspace'); await idle();
  const merged = inspect(await save('paragraph-indentation-merged.docx'));
  assert.equal(merged.paragraphs[3].text, originalText[3] + originalText[4]); assert.deepEqual(merged.paragraphs[3].indent, uiExpected[3]);
  await undo(); await caret(3, originalText[3].length); await page.keyboard.press('Delete'); await idle();
  const forward = inspect(await save('paragraph-indentation-forward-merged.docx'));
  assert.deepEqual(texts(forward), texts(merged)); assert.deepEqual(indents(forward), indents(merged));
  await undo(); await caret(5, originalText[5].length); await page.keyboard.press('Enter'); await page.keyboard.insertText('Body retains direct indent'); await idle();
  const endSplit = inspect(await save('paragraph-indentation-heading-enter.docx'));
  assert.deepEqual(endSplit.paragraphs[6].indent, expected[5], 'Native fixture has explicit indentation overrides on the heading');
  report.structural = { split, merged, forward, endSplit };
  ok('Mid-paragraph Enter retains indentation; Backspace/Delete merge into the first paragraph style; end-heading Enter retains explicit indentation');

  phase = 'mixed-selection-and-invalid-panel-input';
  await open(sourceFile); await selectParagraphRange(1, 3, 0);
  await page.getByTestId('word-indent-toggle').click();
  for (const id of ['word-indent-left', 'word-indent-right', 'word-indent-first-line']) assert.equal(await page.getByTestId(id).inputValue(), '', 'Different values must appear as mixed, not a misleading number');
  await page.getByTestId('word-indent-left').fill('12'); await page.getByTestId('word-indent-apply').click(); await idle();
  const mixed = expected.map(p => ({ ...p })); mixed[1].left = 12; mixed[2].left = 12;
  await assertRendered(mixed);
  report.mixedSelection = inspect(await save('paragraph-indentation-mixed-selection.docx'));
  assert.deepEqual(indents(report.mixedSelection), mixed, 'Only touched left indentation changes; end paragraph at offset zero is excluded');
  await undo(); await assertRendered(expected);
  await caret(1, 4); await page.getByTestId('word-indent-toggle').click();
  const beforeInvalid = await domParagraphs();
  await page.getByTestId('word-indent-left').fill('2000'); await page.getByTestId('word-indent-apply').click();
  await page.getByTestId('word-indent-panel').getByRole('alert').waitFor(); assert.deepEqual(await domParagraphs(), beforeInvalid);
  await page.getByTestId('word-indent-left').fill('0.03'); await page.getByTestId('word-indent-apply').click();
  await page.getByTestId('word-indent-panel').getByRole('alert').waitFor(); assert.deepEqual(await domParagraphs(), beforeInvalid);
  await page.getByTestId('word-indent-cancel').click(); await page.getByTestId('word-indent-panel').waitFor({ state: 'hidden' });
  await caret(1, 4); await page.getByTestId('word-indent-toggle').click(); await page.getByTestId('word-indent-left').fill('40');
  await caret(2, 2); await page.getByTestId('word-indent-panel').waitFor({ state: 'hidden' });
  assert.deepEqual(await domParagraphs(), beforeInvalid);
  ok('Mixed paragraph selection changes only edited fields; zero-offset end boundary, invalid values, cancel and stale selection preserve other indentation');

  phase = 'atomic-rejection';
  await caret(0, 0); await page.keyboard.insertText('Unsaved '); await idle();
  const before = await domParagraphs(), tabCount = await page.locator('.document-tab').count();
  const badFile = path.join(output, 'unsupported-character-indent.docx');
  fs.writeFileSync(badFile, Buffer.from(synthetic('<w:p><w:pPr><w:ind w:leftChars="100"/></w:pPr><w:r><w:t>Unsupported</w:t></w:r></w:p>')));
  const chooser = page.waitForEvent('filechooser'); await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(badFile); await page.locator('.error-banner').waitFor(); await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.deepEqual(await domParagraphs(), before); assert.equal(await page.locator('.document-tab').count(), tabCount);
  assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(), 1);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
  ok('Unsupported character-based indentation fails atomically without changing the active unsaved document or opening a tab');
  assert.equal(sha256(sourceFile), fixture.docxSha256); assert.equal(await page.locator('iframe').count(), 0);
  assert.deepEqual(report.runtimeRequests, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  await page.screenshot({ path: path.join(output, 'indentation-editor.png'), fullPage: true });
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { phase, message: error.message, stack: error.stack };
  if (page) { try { report.failure.body = (await page.locator('body').innerText()).slice(-6000); await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {} }
  console.error(error); process.exitCode = 1;
} finally { persist(); if (browser) await browser.close(); if (server) await server.close(); } })();
