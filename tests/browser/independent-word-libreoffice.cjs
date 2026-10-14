/* Native LibreOffice-produced DOCX -> full application UI -> actual download ->
 * native LibreOffice open/save -> full application UI -> second download.
 * Original corpus files are read-only. Requires Vite and the `soffice` CLI.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const corpus = path.join(root, 'tests/compatibility/independent-word/libreoffice');
const out = path.resolve(process.env.INDEPENDENT_WORD_LO_OUTPUT || path.join(root, 'test-results/independent-word-libreoffice'));
const url = process.env.STANDALONE_WORD_URL || 'http://127.0.0.1:5198/';
const soffice = process.env.SOFFICE || 'soffice', python = process.env.PYTHON || 'python3';
const marker = '独立编辑验证 中文😀';
const names = ['plain-text', 'explicit-styles', 'headings', 'unicode-breaks'];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  scope: 'Unmodified native LibreOffice DOCX corpus, actual Vue UI edits/downloads, native LibreOffice DOCX conversion, and second UI import/save',
  limitations: ['One installed LibreOfficeDev build; this is not Microsoft Word compatibility validation.', 'Paragraph/run subset only, without page-layout or pixel-fidelity comparison.', 'Chinese text is inserted through Chromium; real operating-system IME and packaged Tauri dialogs are not exercised.'],
  cases: [], checks: [], pageErrors: [], consoleErrors: [], runtimeRequests: [], externalRequests: [], failedRequests: [],
};
fs.mkdirSync(out, { recursive: true });
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const ok = name => { report.checks.push(name); console.log('PASS', name); persist(); };
let browser, page, phase = 'startup';
const content = () => page.getByTestId('word-content');
async function idle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner'); if (error) throw Error(error.textContent);
    return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  });
  await content().waitFor(); assert.equal(await page.locator('iframe').count(), 0);
}
async function textParagraphs() {
  return content().evaluate(node => [...node.children].map(p => {
    const text = n => n.nodeType === Node.TEXT_NODE ? n.textContent : n.nodeName === 'BR'
      ? (n.hasAttribute('data-word-placeholder') ? '' : '\n') : [...n.childNodes].map(text).join('');
    return text(p);
  }));
}
async function open(file, home = false) {
  const chooser = page.waitForEvent('filechooser');
  if (home) await page.getByTestId('independent-word-open').click();
  else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(file); await idle();
}
async function save(filename) {
  const pending = page.waitForEvent('download');
  await page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click();
  const downloaded = await pending, file = path.join(out, filename);
  assert.match(downloaded.suggestedFilename(), /\.docx$/i); await downloaded.saveAs(file); await idle(); return file;
}
async function selectTextInParagraph(text, paragraph = -1) {
  await content().evaluate((node, { text: marker, paragraph }) => {
    const p = paragraph < 0 ? node.lastElementChild : node.children[paragraph], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    const start = nodes.map(n => n.textContent).join('').indexOf(marker); if (start < 0) throw Error('Missing marker');
    const at = offset => { for (const n of nodes) { if (offset <= n.length) return [n, offset]; offset -= n.length; } throw Error('Bad selection'); };
    node.focus(); window.getSelection().setBaseAndExtent(...at(start), ...at(start + marker.length));
    document.dispatchEvent(new Event('selectionchange'));
  }, { text, paragraph });
}
const selectMarker = () => selectTextInParagraph(marker);
async function caretInParagraph(paragraph, offset) {
  await content().evaluate((node, { paragraph, offset }) => {
    const p = node.children[paragraph], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) {
      if (offset <= n.length) { node.focus(); window.getSelection().setBaseAndExtent(n, offset, n, offset); document.dispatchEvent(new Event('selectionchange')); return; }
      offset -= n.length;
    }
    throw Error('Caret position outside paragraph');
  }, { paragraph, offset });
}
function inspect(file) {
  return JSON.parse(execFileSync(python, ['-c', String.raw`
import hashlib,json,sys,zipfile,xml.etree.ElementTree as E
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';ns={'w':w};q=lambda n:'{'+w+'}'+n
def val(n,d=None):return n.get(q('val'),d) if n is not None else d
def props(n):
 o={}
 if n is None:return o
 for k in ['b','i']:
  child=n.find('w:'+k,ns)
  if child is not None:o[{'b':'bold','i':'italic'}[k]]=val(child,'true') not in ['0','false','off']
 child=n.find('w:u',ns)
 if child is not None:o['underline']=val(child,'single') not in ['none','0','false']
 child=n.find('w:sz',ns)
 if child is not None:o['fontSize']=float(val(child))/2
 child=n.find('w:color',ns)
 if child is not None:o['color']=val(child)
 for key in ['szCs','kern']:
  child=n.find('w:'+key,ns)
  if child is not None:o[key]=float(val(child))/2
 for tag,keys in [('rFonts',['ascii','hAnsi','eastAsia','cs']),('lang',['val','eastAsia','bidi'])]:
  child=n.find('w:'+tag,ns)
  if child is not None:
   for key in keys:
    if child.get(q(key)) is not None:o[tag+':'+key]=child.get(q(key))
 return o
def paragraph_props(n):
 o={}
 if n is None:return o
 for key in ['keepNext','keepLines','widowControl','suppressAutoHyphens']:
  child=n.find('w:'+key,ns)
  if child is not None:o[key]=val(child,'true') not in ['0','false','off']
 child=n.find('w:jc',ns)
 if child is not None:o['align']={'start':'left','end':'right'}.get(val(child),val(child))
 child=n.find('w:outlineLvl',ns)
 if child is not None:o['outline']=None if val(child)=='9' else int(val(child))
 child=n.find('w:spacing',ns)
 if child is not None:
  for key in ['before','after','line']:
   if child.get(q(key)) is not None:o['spacing:'+key]=int(child.get(q(key)))
  if child.get(q('lineRule')) is not None:o['spacing:lineRule']=child.get(q('lineRule'))
 return o
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for name in ['[Content_Types].xml','_rels/.rels','word/document.xml']:assert name in z.namelist(),name
 for name in z.namelist():
  if name.endswith('.xml') or name.endswith('.rels'):E.fromstring(z.read(name))
 styles={};defaults={};paragraph_defaults={};default_p=None
 if 'word/styles.xml' in z.namelist():
  sheet=E.fromstring(z.read('word/styles.xml'));defaults=props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr',ns))
  paragraph_defaults=paragraph_props(sheet.find('w:docDefaults/w:pPrDefault/w:pPr',ns))
  for s in sheet.findall('w:style',ns):
   styles[s.get(q('styleId'))]=s
   if s.get(q('type'))=='paragraph' and s.get(q('default')) in ['1','true']:default_p=s.get(q('styleId'))
 def chain(sid,seen=None):
  seen=set() if seen is None else seen
  if not sid or sid not in styles or sid in seen:return []
  seen.add(sid);s=styles[sid];return chain(val(s.find('w:basedOn',ns)),seen)+[s]
 doc=E.fromstring(z.read('word/document.xml'));paragraphs=[]
 for p in doc.findall('w:body/w:p',ns):
  inherited=dict(defaults);paragraph_style=dict(paragraph_defaults)
  for s in chain(val(p.find('w:pPr/w:pStyle',ns),default_p)):
   inherited.update(props(s.find('w:rPr',ns)))
   paragraph_style.update(paragraph_props(s.find('w:pPr',ns)))
  paragraph_style.update(paragraph_props(p.find('w:pPr',ns)));runs=[]
  for r in p.findall('w:r',ns):
   style=dict(inherited)
   for s in chain(val(r.find('w:rPr/w:rStyle',ns))):style.update(props(s.find('w:rPr',ns)))
   style.update(props(r.find('w:rPr',ns)))
   text=''.join((n.text or '') if n.tag==q('t') else '\n' if n.tag==q('br') else '\t' if n.tag==q('tab') else '' for n in r)
   if text:runs.append({'text':text,**style})
  paragraphs.append({'text':''.join(r['text'] for r in runs),'runs':runs,'style':paragraph_style})
 settings=E.fromstring(z.read('word/settings.xml')) if 'word/settings.xml' in z.namelist() else None
 tab=val(settings.find('w:defaultTabStop',ns)) if settings is not None else None
 empty_custom=False
 if 'docProps/custom.xml' in z.namelist():
  custom=E.fromstring(z.read('docProps/custom.xml'));empty_custom=len(custom)==0 and not custom.attrib and not (custom.text or '').strip()
 # LibreOffice adds an empty custom-properties container on resave. It has no
 # property data to preserve; retain this fact in the report, compare all
 # nonempty metadata, and never strip or modify the native file itself.
 metadata={n:hashlib.sha256(E.canonicalize(z.read(n).decode('utf-8-sig'),rewrite_prefixes=True).encode()).hexdigest() for n in ['word/fontTable.xml','word/theme/theme1.xml','docProps/core.xml','docProps/app.xml','docProps/custom.xml'] if n in z.namelist() and not (n=='docProps/custom.xml' and empty_custom)}
 print(json.dumps({'paragraphs':paragraphs,'zipEntries':len(z.namelist()),'defaultTabStop':float(tab)/20 if tab else 36,'metadata':metadata,'emptyCustomProperties':empty_custom},ensure_ascii=False))
`, file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
function characterStyles(paragraph) {
  return paragraph.runs.flatMap(run => Array.from(run.text).map(character => ({ character,
    bold: !!run.bold, italic: !!run.italic, underline: !!run.underline,
    fontSize: run.fontSize ?? 12, color: !run.color || run.color === 'auto' ? '000000' : run.color.toUpperCase(),
    ...Object.fromEntries(['szCs', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, run[key] ?? null])),
  })));
}
function assertSourcePreserved(source, output) {
  assert.deepEqual(output.paragraphs.slice(0, source.paragraphs.length).map(p => p.text), source.paragraphs.map(p => p.text));
  for (let i = 0; i < source.paragraphs.length; i++) {
    assert.deepEqual(characterStyles(output.paragraphs[i]), characterStyles(source.paragraphs[i]), `Character formatting differs in source paragraph ${i + 1}`);
    const normalized = paragraph => ({ align: 'left', outline: null, keepNext: false, keepLines: false, widowControl: true,
      suppressAutoHyphens: false, 'spacing:before': 0, 'spacing:after': 0, 'spacing:line': 240, 'spacing:lineRule': 'auto', ...paragraph.style });
    assert.deepEqual(normalized(output.paragraphs[i]), normalized(source.paragraphs[i]), `Paragraph properties differ in source paragraph ${i + 1}`);
  }
  assert.equal(output.defaultTabStop, source.defaultTabStop, 'Default tab stop must survive editing');
}
function assertMarker(output, expected = marker) {
  const paragraph = output.paragraphs.at(-1); assert.equal(paragraph.text, expected);
  assert.ok(paragraph.runs.length && paragraph.runs.every(r => r.bold && r.italic && r.underline && r.fontSize === 18), 'Marker must retain direct bold/italic/underline/18pt formatting');
}
async function nativeRoundtrip(file, name) {
  const directory = path.join(out, 'libreoffice-roundtrip', name); fs.mkdirSync(directory, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'open-office-word-qa-'));
  try {
    const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', directory, file];
    const result = await run(soffice, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
    const converted = path.join(directory, path.basename(file)); assert.ok(fs.existsSync(converted), `LibreOffice did not create output: ${result.stdout}\n${result.stderr}`);
    return { file: converted, stdout: result.stdout, stderr: result.stderr, sha256: sha256(converted) };
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

(async () => { try {
  report.libreofficeVersion = execFileSync(soffice, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, '../manifest.json'), 'utf8'));
  report.corpus = { generatedAtUtc: manifest.generatedAtUtc, provenance: manifest.provenance, libreoffice: manifest.libreoffice };
  for (const name of names) assert.ok(fs.existsSync(path.join(corpus, `${name}.docx`)), `Missing native corpus: ${name}`);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 920 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
  const origin = new URL(url).origin;
  context.on('request', request => {
    const target = new URL(request.url());
    if (/^https?:$/.test(target.protocol) && target.origin !== origin) report.externalRequests.push(target.href);
    if (/^\/(office|office-runtime)\//.test(target.pathname) || /soffice|\.wasm(?:$|\?)/i.test(target.href)) report.runtimeRequests.push(target.href);
  });
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text() }); });
  page.on('requestfailed', request => report.failedRequests.push({ phase, url: request.url(), error: request.failure()?.errorText }));
  await page.goto(url); await page.getByTestId('independent-word-open').waitFor();
  for (const name of names) {
    phase = name; console.log('CASE', name);
    const sourceFile = path.join(corpus, `${name}.docx`), sourceHash = sha256(sourceFile), source = inspect(sourceFile);
    const expected = manifest.fixtures.find(fixture => fixture.name === name);
    assert.equal(sourceHash, expected.docxSha256, 'The input must be the original native LibreOffice fixture');
    assert.deepEqual(source.paragraphs.map(p => p.text), expected.expectedParagraphs);
    const result = { name, source: { path: sourceFile, sha256: sourceHash, ...source } }; report.cases.push(result); persist();
    await open(sourceFile, name === names[0]); assert.deepEqual(await textParagraphs(), source.paragraphs.map(p => p.text));
    await content().focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText(marker); await idle();
    for (const id of ['word-bold', 'word-italic', 'word-underline']) {
      await selectMarker(); if (await page.getByTestId(id).getAttribute('aria-pressed') !== 'true') await page.getByTestId(id).click();
    }
    await selectMarker(); await page.getByTestId('word-font-size').selectOption('18');
    const downloaded = await save(`${name}-edited.docx`); result.firstDownload = inspect(downloaded);
    assertSourcePreserved(source, result.firstDownload); assertMarker(result.firstDownload);
    assert.deepEqual(result.firstDownload.metadata, source.metadata, 'Known package metadata must survive the first independent save as equivalent canonical XML');
    // The reference application itself can normalize omitted OOXML defaults
    // when opening/resaving its own DOCX (for example, adding w:kern=0). Compare
    // the product's native roundtrip to an unedited native roundtrip control.
    result.nativeControl = await nativeRoundtrip(sourceFile, `${name}-control`);
    result.nativeControl.document = inspect(result.nativeControl.file);
    assert.deepEqual(result.nativeControl.document.paragraphs.map(p => p.text), source.paragraphs.map(p => p.text));
    result.native = await nativeRoundtrip(downloaded, name); result.native.document = inspect(result.native.file);
    assertSourcePreserved(result.nativeControl.document, result.native.document); assertMarker(result.native.document);
    await open(result.native.file); assert.deepEqual(await textParagraphs(), result.native.document.paragraphs.map(p => p.text));
    await content().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' 再次保存'); await idle();
    result.secondDownload = inspect(await save(`${name}-twice-edited.docx`));
    assertSourcePreserved(result.nativeControl.document, result.secondDownload); assertMarker(result.secondDownload, marker + ' 再次保存');
    assert.deepEqual(result.secondDownload.metadata, result.native.document.metadata, 'Metadata added by the native application must survive independent reopening and saving');
    assert.equal(sha256(sourceFile), sourceHash, 'Native corpus files must remain unmodified');
    result.ok = true; ok(`${name}: native DOCX import, UI edit, native LibreOffice open/save, UI reopen and second save preserve text and supported formatting`);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
  phase = 'unsupported-native-table';
  await content().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' 未保存内容'); await idle();
  const before = await textParagraphs(), tabCount = await page.locator('.document-tab').count();
  const activeName = await page.locator('.document-tab[aria-selected="true"] .tab-name').textContent();
  const table = path.join(corpus, 'unsupported-table.docx'), tableHash = sha256(table);
  assert.equal(tableHash, manifest.fixtures.find(fixture => fixture.name === 'unsupported-table').docxSha256);
  const chooser = page.waitForEvent('filechooser'); await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(table); await page.locator('.error-banner').waitFor(); await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.error-banner').textContent(), /不支持|完整|复杂/);
  assert.deepEqual(await textParagraphs(), before); assert.equal(await page.locator('.document-tab').count(), tabCount);
  assert.equal(await page.locator('.document-tab[aria-selected="true"] .tab-name').textContent(), activeName);
  assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(), 1);
  assert.equal(sha256(table), tableHash);
  report.rejectedTable = { source: table, sha256: tableHash, preservedTabCount: tabCount, message: await page.locator('.error-banner').textContent() };
  await page.screenshot({ path: path.join(out, 'unsupported-table.png') });
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
  ok('An unmodified native LibreOffice table document is rejected atomically, retaining the active unsaved document and source bytes');

  phase = 'imported-heading-direct-overrides-and-enter';
  await open(path.join(corpus, 'headings.docx'));
  const importedHeadingText = await textParagraphs();
  await selectTextInParagraph('A heading', 0); await page.getByTestId('word-font-size').selectOption('18');
  await selectTextInParagraph('A heading', 0); await page.getByTestId('word-color').fill('#c00000');
  await selectTextInParagraph('A heading', 0);
  if (await page.getByTestId('word-bold').getAttribute('aria-pressed') === 'true') await page.getByTestId('word-bold').click();
  await caretInParagraph(0, 2); await page.keyboard.press('Enter'); await idle();
  assert.deepEqual((await textParagraphs()).slice(0, 2), ['A ', 'heading']);
  const middleEnter = inspect(await save('heading-middle-enter.docx'));
  assert.equal(middleEnter.paragraphs[0].style.outline, 0); assert.equal(middleEnter.paragraphs[1].style.outline, 0);
  await page.locator('.command-bar button[title="撤销"]').click(); await idle();
  assert.deepEqual(await textParagraphs(), importedHeadingText);
  await caretInParagraph(0, 'A heading'.length); await page.keyboard.press('Enter'); await page.keyboard.insertText('Direct override 正文'); await idle();
  const endEnter = inspect(await save('heading-end-enter-direct-overrides.docx'));
  assert.equal(endEnter.paragraphs[1].text, 'Direct override 正文');
  assert.ok(endEnter.paragraphs[1].style.outline === undefined || endEnter.paragraphs[1].style.outline === null);
  assert.ok(endEnter.paragraphs[1].runs.every(run => run.fontSize === 18 && !run.bold && run.color?.toUpperCase() === 'C00000'));
  report.headingEnter = { middle: middleEnter, end: endEnter };
  ok('In the application, Enter inside an imported heading retains its style; Enter at its end uses body style while retaining explicit size, color and false-bold overrides');

  phase = 'native-document-manual-heading-and-follow-style';
  await open(path.join(corpus, 'plain-text.docx'));
  await selectTextInParagraph('Plain LibreOffice document.', 0); await page.getByTestId('word-heading').selectOption('1');
  const manualHeading = inspect(await save('native-manual-heading.docx'));
  assert.equal(manualHeading.paragraphs[0].style.outline, 0);
  await caretInParagraph(0, 'Plain LibreOffice document.'.length); await page.keyboard.press('Enter');
  await page.keyboard.insertText('Body after custom heading'); await idle();
  const manualFollow = inspect(await save('native-manual-heading-follow.docx'));
  assert.equal(manualFollow.paragraphs[1].text, 'Body after custom heading');
  assert.ok(manualFollow.paragraphs[1].style.outline === undefined || manualFollow.paragraphs[1].style.outline === null);
  assert.equal(manualFollow.paragraphs[1].style.suppressAutoHyphens, true);
  assert.ok(manualFollow.paragraphs[1].runs.every(run => !run.bold && run.fontSize === 12));
  report.manualHeading = { heading: manualHeading, follow: manualFollow };
  ok('Applying a heading to a native LibreOffice paragraph, saving, and pressing Enter retains a saveable body follow style with automatic hyphenation suppressed');

  phase = 'heading-to-body-preserves-direct-alignment';
  await open(path.join(corpus, 'headings.docx'));
  // The second heading inherits its spacing; the first one also contains an
  // explicit spacing override in native document.xml, so it is not this case.
  await selectTextInParagraph('A subheading', 2); await page.getByTestId('word-align').selectOption('center');
  await selectTextInParagraph('A subheading', 2); await page.getByTestId('word-heading').selectOption('0');
  const bodyStyleFile = await save('heading-to-body-aligned.docx'); await open(bodyStyleFile);
  const bodyStyle = inspect(await save('heading-to-body-aligned-reopened.docx'));
  const paragraphStyle = bodyStyle.paragraphs[2].style;
  assert.equal(paragraphStyle.align, 'center'); assert.ok(!paragraphStyle.keepNext);
  assert.ok(paragraphStyle.outline === undefined || paragraphStyle.outline === null);
  assert.equal(paragraphStyle['spacing:before'] ?? 0, 0); assert.equal(paragraphStyle['spacing:after'] ?? 0, 0);
  report.headingToBody = bodyStyle;
  ok('Changing an imported heading to body drops inherited heading spacing/keep-next while retaining direct center alignment after save/reopen');

  phase = 'native-backspace-merges-distinct-paragraph-styles';
  await open(path.join(corpus, 'headings.docx'));
  const mergeSource = inspect(path.join(corpus, 'headings.docx'));
  await caretInParagraph(1, 0); await page.keyboard.press('Backspace'); await idle();
  const expectedMergedText = [mergeSource.paragraphs[0].text + mergeSource.paragraphs[1].text, ...mergeSource.paragraphs.slice(2).map(p => p.text)];
  assert.deepEqual(await textParagraphs(), expectedMergedText);
  const mergedFile = await save('native-style-merge.docx');
  const merged = inspect(mergedFile);
  const expectedMergedStyles = [...characterStyles(mergeSource.paragraphs[0]), ...characterStyles(mergeSource.paragraphs[1])];
  assert.deepEqual(characterStyles(merged.paragraphs[0]), expectedMergedStyles, 'Native Backspace merging a 20pt heading and 12pt body must retain each run\'s effective character formatting');
  await page.locator('.command-bar button[title="撤销"]').click(); await idle();
  assert.deepEqual(await textParagraphs(), mergeSource.paragraphs.map(p => p.text));
  await caretInParagraph(0, mergeSource.paragraphs[0].text.length); await page.keyboard.press('Delete'); await idle();
  assert.deepEqual(await textParagraphs(), expectedMergedText);
  const forwardMerge = inspect(await save('native-style-forward-merge.docx'));
  assert.deepEqual(characterStyles(forwardMerge.paragraphs[0]), expectedMergedStyles, 'Forward Delete must preserve the same distinct native run metadata');
  await page.locator('.command-bar button[title="撤销"]').click(); await idle();
  assert.deepEqual(await textParagraphs(), mergeSource.paragraphs.map(p => p.text));
  await page.locator('.command-bar button[title="重做"]').click(); await idle();
  assert.deepEqual(await textParagraphs(), expectedMergedText);
  await open(mergedFile);
  const reopenedMerge = inspect(await save('native-style-merge-reopened.docx'));
  assert.deepEqual(characterStyles(reopenedMerge.paragraphs[0]), expectedMergedStyles);
  report.mergedParagraphs = { first: merged, forward: forwardMerge, reopened: reopenedMerge };
  ok('Backspace and Delete across imported heading/body paragraphs preserve distinct effective run styles through undo/redo and save/reopen');
  assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(report.runtimeRequests, []); assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedRequests, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { phase, message: error.message, stack: error.stack };
  if (page) { try { report.failure.body = (await page.locator('body').innerText()).slice(-6000); await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {} }
  console.error(error); process.exitCode = 1;
} finally { persist(); if (browser) await browser.close(); } })();
