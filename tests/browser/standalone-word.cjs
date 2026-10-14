/* Real application acceptance checks for the independent Word route.
 * Uses user-visible controls, DOM Selection, real downloads, and Python's
 * independent ZIP/XML reader. Never reads Vue internals or editor model state.
 * Start Vite first; override STANDALONE_WORD_URL when its port is not 5198.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.STANDALONE_WORD_OUTPUT || path.join(root, 'test-results/standalone-word'));
const url = process.env.STANDALONE_WORD_URL || 'http://127.0.0.1:5198/';
const python = process.env.PYTHON || 'python3';
const report = {
  scope: 'Full Vue application in Chromium; independent Word editing and actual DOCX downloads read by Python zipfile and ElementTree',
  limitations: ['No packaged Tauri/WebView or native file dialog validation.', 'Chinese text insertion and a synthetic composition lifecycle are not an operating-system IME test.', 'No Microsoft Word or LibreOffice rendering/fidelity claim.'],
  checks: [], operations: [], screenshots: [], files: {}, pageErrors: [], consoleErrors: [], failedRequests: [], officeRuntimeRequests: [], externalRequests: [],
};
let browser, page, phase = 'startup';
fs.mkdirSync(out, { recursive: true });
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const ok = name => { report.checks.push(name); console.log('PASS', name); persist(); };
const body = () => page.getByTestId('word-content');
const tabs = () => page.locator('.document-tab');
const activeTab = () => page.locator('.document-tab[aria-selected="true"]');
const tabNamed = name => page.locator('.document-tab').filter({ has: page.locator('.tab-name', { hasText: name }) });
async function stage(name, work) {
  phase = name; console.log('PHASE', name); const start = performance.now();
  const value = await work(); report.operations.push({ name, milliseconds: Math.round(performance.now() - start) }); persist(); return value;
}
async function idle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner');
    if (error) throw Error(error.textContent || 'Application error');
    return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true'
      && !document.querySelector('.busy-overlay');
  });
  await body().waitFor();
  assert.equal(await page.locator('iframe').count(), 0, 'Independent Word session must contain no iframe');
}
async function screenshot(name) {
  const file = `${name}.png`; await page.screenshot({ path: path.join(out, file) }); report.screenshots.push(file);
}
async function paragraphs() {
  return body().evaluate(node => [...node.children].map(p => {
    const walk = n => n.nodeType === Node.TEXT_NODE ? n.textContent : n.nodeName === 'BR'
      ? (n.hasAttribute('data-word-placeholder') ? '' : '\n') : [...n.childNodes].map(walk).join('');
    return walk(p);
  }));
}
async function selectText(text, paragraph = 0) {
  await body().evaluate((node, value) => {
    const p = node.children[value.paragraph]; if (!p) throw Error('Missing paragraph');
    const nodes = [], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let next; while ((next = walker.nextNode())) nodes.push(next);
    const full = nodes.map(n => n.textContent).join(''), start = full.indexOf(value.text);
    if (start < 0) throw Error(`Missing selection text: ${value.text}`);
    const at = target => { let offset = target; for (const n of nodes) { if (offset <= n.textContent.length) return [n, offset]; offset -= n.textContent.length; } throw Error('Selection offset overflow'); };
    node.focus(); window.getSelection().setBaseAndExtent(...at(start), ...at(start + value.text.length));
    document.dispatchEvent(new Event('selectionchange'));
  }, { text, paragraph });
}
async function selectRange(startParagraph, startOffset, endParagraph, endOffset) {
  await body().evaluate((node, value) => {
    const point = (paragraph, wanted) => {
      const p = node.children[paragraph], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let text, remaining = wanted;
      while ((text = walker.nextNode())) { if (remaining <= text.length) return [text, remaining]; remaining -= text.length; }
      if (!wanted) return [p, 0]; throw Error('Selection offset outside paragraph');
    };
    node.focus(); window.getSelection().setBaseAndExtent(...point(value[0], value[1]), ...point(value[2], value[3]));
    document.dispatchEvent(new Event('selectionchange'));
  }, [startParagraph, startOffset, endParagraph, endOffset]);
}
async function atEnd() { await body().focus(); await page.keyboard.press('Control+End'); }
async function append(text) { await atEnd(); await page.keyboard.insertText(text); await idle(); }
async function choose(file, home = false) {
  const chooser = page.waitForEvent('filechooser');
  if (home) await page.getByTestId('independent-word-open').click();
  else await page.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click();
  await (await chooser).setFiles(file);
}
async function download(filename, action) {
  const pending = page.waitForEvent('download'); await action();
  const downloaded = await pending, file = path.join(out, filename);
  assert.match(downloaded.suggestedFilename(), /\.docx$/i);
  await downloaded.saveAs(file); await idle(); return file;
}
const save = filename => download(filename, () => page.locator('.command-bar').getByRole('button', { name: '保存', exact: true }).click());
function inspect(file) {
  return JSON.parse(execFileSync(python, ['-c', String.raw`
import json,sys,zipfile,xml.etree.ElementTree as E
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';ns={'w':w};q=lambda n:'{'+w+'}'+n
def val(node,default=None):return node.get(q('val'),default) if node is not None else default
def props(node):
 result={}
 if node is None:return result
 for tag,key in [('b','bold'),('i','italic')]:
  child=node.find('w:'+tag,ns)
  if child is not None:result[key]=val(child,'true') not in ['false','0','off']
 child=node.find('w:u',ns)
 if child is not None:result['underline']=val(child,'single') not in ['none','0','false']
 child=node.find('w:sz',ns)
 if child is not None:result['fontSize']=float(val(child))/2
 child=node.find('w:color',ns)
 if child is not None:result['color']=val(child)
 return result
def paragraph_props(node):
 result={}
 if node is None:return result
 for tag,key in [('jc','align'),('outlineLvl','outlineLevel')]:
  child=node.find('w:'+tag,ns)
  if child is not None:result[key]=val(child)
 return result
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for name in ['[Content_Types].xml','_rels/.rels','word/document.xml']: assert name in z.namelist(),name
 for name in z.namelist():
  if name.endswith('.xml') or name.endswith('.rels'):E.fromstring(z.read(name))
 styles={};defaults={'bold':False,'italic':False,'underline':False,'fontSize':12,'color':None};paragraph_defaults={'align':'left','outlineLevel':None};default_p=None
 if 'word/styles.xml' in z.namelist():
  sheet=E.fromstring(z.read('word/styles.xml'))
  defaults.update(props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr',ns)))
  paragraph_defaults.update(paragraph_props(sheet.find('w:docDefaults/w:pPrDefault/w:pPr',ns)))
  for style in sheet.findall('w:style',ns):
   styles[style.get(q('styleId'))]=style
   if style.get(q('type'))=='paragraph' and style.get(q('default')) in ['1','true']:default_p=style.get(q('styleId'))
 def chain(sid,seen=None):
  seen=set() if seen is None else seen
  if not sid or sid not in styles or sid in seen:return []
  seen.add(sid);style=styles[sid]
  return chain(val(style.find('w:basedOn',ns)),seen)+[style]
 document=E.fromstring(z.read('word/document.xml')); paragraphs=[]
 for p in document.findall('./w:body/w:p',ns):
  inherited=dict(defaults);paragraph_style=dict(paragraph_defaults);sid=val(p.find('w:pPr/w:pStyle',ns),default_p)
  for style in chain(sid):
   inherited.update(props(style.find('w:rPr',ns)))
   paragraph_style.update(paragraph_props(style.find('w:pPr',ns)))
  paragraph_style.update(paragraph_props(p.find('w:pPr',ns)))
  runs=[]
  for r in p.findall('w:r',ns):
   style=dict(inherited)
   for inherited_style in chain(val(r.find('w:rPr/w:rStyle',ns))):style.update(props(inherited_style.find('w:rPr',ns)))
   style.update(props(r.find('w:rPr',ns)))
   text=''.join((n.text or '') if n.tag=='{'+w+'}t' else '\n' if n.tag=='{'+w+'}br' else '\t' if n.tag=='{'+w+'}tab' else '' for n in r)
   runs.append({'text':text,**style})
  paragraphs.append({'text':''.join(r['text'] for r in runs),'runs':runs,'style':sid,**paragraph_style})
 print(json.dumps({'paragraphs':paragraphs,'zipEntries':len(z.namelist()),'hasSection':document.find('./w:body/w:sectPr',ns) is not None},ensure_ascii=False))
`, file], { encoding: 'utf8' }));
}
function complexFixture(source) {
  const target = path.join(out, 'unsupported-table.docx');
  execFileSync(python, ['-c', String.raw`
import sys,zipfile,xml.etree.ElementTree as E
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';ns={'w':w}
with zipfile.ZipFile(sys.argv[1]) as src,zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as dst:
 for name in src.namelist():
  data=src.read(name)
  if name=='word/document.xml':
   doc=E.fromstring(data);body=doc.find('w:body',ns)
   tbl=E.fromstring('<w:tbl xmlns:w="'+w+'"><w:tr><w:tc><w:p><w:r><w:t>复杂表格不可丢失</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
   body.insert(0,tbl);data=E.tostring(doc,encoding='utf-8',xml_declaration=True)
  dst.writestr(name,data)
`, source, target]); return target;
}
function assertFormattedFile(result) {
  assert.deepEqual(result.paragraphs.map(p => p.text), ['第一段 中文😀测试 尾部', '第二段\n软换行', '第三段 撤销重做 追加']);
  const first = result.paragraphs[0], selected = first.runs.filter(r => r.text.includes('中文') || r.text.includes('😀'));
  assert.equal(selected.map(r => r.text).join(''), '中文😀');
  assert.ok(selected.every(r => r.bold && r.italic && r.underline && r.fontSize === 18));
  assert.ok(first.runs.filter(r => !selected.includes(r)).every(r => !r.bold && !r.italic && !r.underline), 'Formatting must not bleed beyond the selected text');
  assert.equal(result.paragraphs[1].align, 'center');
  assert.ok(/heading.?1/i.test(result.paragraphs[1].style || '') || result.paragraphs[1].outlineLevel === '0', 'Second paragraph must retain heading level one');
  assert.ok(result.hasSection);
}

(async () => { try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 920 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.routeWebSocket('**', () => {}); // Avoid unrelated concurrent edits reloading this acceptance session.
  const origin = new URL(url).origin;
  context.on('request', request => {
    const requested = new URL(request.url());
    if (/^https?:$/.test(requested.protocol) && requested.origin !== origin) report.externalRequests.push({ phase, url: requested.href });
    if (/^\/(office|office-runtime)\//.test(requested.pathname) || /soffice|\.wasm(?:$|\?)/i.test(requested.href)) report.officeRuntimeRequests.push({ phase, url: requested.href });
  });
  page.on('pageerror', error => report.pageErrors.push({ phase, error: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, error: message.text() }); });
  page.on('requestfailed', request => report.failedRequests.push({ phase, url: request.url(), error: request.failure()?.errorText }));

  await stage('new-independent-word', async () => {
    await page.goto(url); await page.getByTestId('independent-word-new').click(); await idle();
    assert.equal(await tabs().count(), 1); assert.equal(await body().getAttribute('contenteditable'), 'true');
    await body().click(); await page.keyboard.insertText('第一段 中文😀测试 尾部');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('第二段');
    await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('软换行');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('第三段 撤销重做'); await idle();
    assert.deepEqual(await paragraphs(), ['第一段 中文😀测试 尾部', '第二段\n软换行', '第三段 撤销重做']);
  });
  ok('The normal home entry opens an independent editor; Chinese, emoji, paragraphs and soft line breaks are editable');

  await stage('selection-formatting-and-history', async () => {
    for (const control of ['word-bold', 'word-italic', 'word-underline']) { await selectText('中文😀'); await page.getByTestId(control).click(); }
    await selectText('中文😀'); await page.getByTestId('word-font-size').selectOption('18');
    await selectText('第二段', 1); await page.getByTestId('word-align').selectOption('center');
    await selectText('第二段', 1); await page.getByTestId('word-heading').selectOption('1');
    await append(' 追加'); assert.ok((await paragraphs())[2].endsWith(' 追加'));
    await page.getByTestId('word-undo').click(); assert.equal((await paragraphs())[2], '第三段 撤销重做');
    await page.getByTestId('word-redo').click(); assert.equal((await paragraphs())[2], '第三段 撤销重做 追加');
    await page.locator('.command-bar button[title="撤销"]').click(); await idle();
    assert.equal((await paragraphs())[2], '第三段 撤销重做', 'The shell undo command must remain usable inside its busy transaction');
    await page.locator('.command-bar button[title="重做"]').click(); await idle();
    assert.equal((await paragraphs())[2], '第三段 撤销重做 追加');
    await screenshot('formatted-document');
  });
  const firstDownload = await stage('real-docx-download', () => save('first-save.docx'));
  report.files.first = inspect(firstDownload); assertFormattedFile(report.files.first);
  assert.equal(await activeTab().locator('.dirty-dot').count(), 0);
  ok('Partial-selection formatting, paragraph formatting and undo/redo survive an actual DOCX download and independent XML inspection');

  await stage('save-as-docx-only', async () => {
    await page.locator('.command-bar').getByRole('button', { name: '另存为', exact: true }).click();
    const dialog = page.getByTestId('save-format-dialog'); await dialog.waitFor();
    assert.deepEqual(await dialog.locator('input[type="radio"]').evaluateAll(nodes => nodes.map(n => n.value)), ['docx']);
    await page.getByTestId('save-format-name').fill('独立文字回归');
    const file = await download('named-save.docx', () => page.getByTestId('save-format-confirm').click());
    report.files.named = inspect(file); assertFormattedFile(report.files.named);
    assert.equal(await page.locator('.command-bar').getByRole('button', { name: '导出 PDF', exact: true }).count(), 0);
  });
  ok('Save As offers only supported DOCX and produces a readable file');

  await stage('independent-tabs-and-saved-dirty-state', async () => {
    await append(' 保存后修改');
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByTestId('independent-word-new').click(); await idle();
    await body().click(); await page.getByTestId('word-heading').selectOption('1');
    await body().click(); await page.keyboard.insertText('第二个独立文档'); await idle();
    const emptyHeadingStyle = await body().locator('p span').first().evaluate(node => ({ size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight }));
    assert.equal(emptyHeadingStyle.size, '32px'); assert.ok(Number(emptyHeadingStyle.weight) >= 600, 'Typing into an empty heading must retain its explicit size and bold style');
    assert.equal(await tabs().count(), 2);
    await tabNamed('独立文字回归.docx').locator('.tab-name').click(); await idle();
    assert.equal((await paragraphs())[2], '第三段 撤销重做 追加 保存后修改');
    assert.equal(await activeTab().locator('.dirty-dot').count(), 1, 'Switching must not mark an unsaved edit as saved');
    await tabs().nth(1).locator('.tab-name').click(); await idle(); assert.deepEqual(await paragraphs(), ['第二个独立文档']);
    await tabs().nth(0).locator('.tab-name').click(); await idle();
    assert.equal((await paragraphs())[2], '第三段 撤销重做 追加 保存后修改');
  });
  ok('Independent tabs retain their own text; editing a saved file and switching away retains its dirty state');

  await stage('unsupported-import-is-atomic', async () => {
    const before = await paragraphs(), count = await tabs().count(), name = await activeTab().locator('.tab-name').textContent();
    await choose(complexFixture(firstDownload)); await page.locator('.error-banner').waitFor();
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    const message = await page.locator('.error-banner').textContent();
    assert.match(message, /不支持|超出|完整|复杂/);
    assert.equal(await tabs().count(), count); assert.equal(await activeTab().locator('.tab-name').textContent(), name);
    assert.deepEqual(await paragraphs(), before); assert.equal(await activeTab().locator('.dirty-dot').count(), 1);
    report.rejectedImport = { message, preservedTabCount: count }; await screenshot('unsupported-import-preserves-document');
    await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
  });
  ok('A complex DOCX containing a table is rejected before tab creation and leaves the active dirty document untouched');

  await stage('close-confirmation', async () => {
    await tabs().nth(1).locator('.tab-name').click(); await idle();
    await activeTab().locator('.tab-close').click(); const dialog = page.getByRole('dialog', { name: '保存你的修改？' });
    await dialog.waitFor(); assert.equal(await tabs().count(), 2);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(await paragraphs(), ['第二个独立文档']);
    await activeTab().locator('.tab-close').click(); await dialog.getByRole('button', { name: '不保存', exact: true }).click(); await idle();
    assert.equal(await tabs().count(), 1); assert.equal((await paragraphs())[2], '第三段 撤销重做 追加 保存后修改');
  });
  ok('Closing an unsaved independent tab prompts; cancellation preserves it and discard closes only that tab');

  await stage('reopen-download-edit-and-save', async () => {
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await choose(firstDownload, true); await idle();
    assert.deepEqual(await paragraphs(), report.files.first.paragraphs.map(p => p.text));
    await append(' 再次编辑');
    const file = await save('reopened-edited.docx'); report.files.reopened = inspect(file);
    assert.equal(report.files.reopened.paragraphs[2].text, '第三段 撤销重做 追加 再次编辑');
    const original = { ...report.files.reopened, paragraphs: report.files.reopened.paragraphs.map((p, i) => i === 2 ? { ...p, text: '第三段 撤销重做 追加' } : p) };
    assertFormattedFile(original);
    assert.equal(await activeTab().locator('.dirty-dot').count(), 0);
  });
  ok('Opening the actual download through the home file chooser, editing again and saving preserves supported content and formatting');

  await stage('synthetic-composition-deduplication', async () => {
    await atEnd();
    await body().evaluate(node => {
      // Simulate the DOM change a browser makes during composition. This tests
      // event reconciliation only and must not be reported as real OS IME use.
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      const p = node.lastElementChild, text = document.createTextNode('组合输入'); p.append(text);
      window.getSelection().setBaseAndExtent(text, text.length, text, text.length);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '组合输入', isComposing: true }));
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组合输入' }));
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '组合输入', isComposing: false }));
    });
    await idle(); const after = await paragraphs(); assert.equal(after.join('\n').split('组合输入').length - 1, 1);
    await page.getByTestId('word-undo').click(); assert.ok(!(await paragraphs()).join('\n').includes('组合输入'));
    await page.getByTestId('word-redo').click(); assert.equal((await paragraphs()).join('\n').split('组合输入').length - 1, 1);
    report.files.composition = inspect(await save('composition-edited.docx'));
    assert.equal(report.files.composition.paragraphs.map(p => p.text).join('\n').split('组合输入').length - 1, 1);
    await screenshot('reopened-edited-document');
  });
  ok('Synthetic composition and its trailing input commit once, undo/redo once and save once; real OS IME remains untested');

  await stage('input-limit-recovers-editable-document', async () => {
    const before = await paragraphs(), maximum = 'x'.repeat(250000);
    await body().focus(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(maximum); await idle();
    assert.deepEqual(await paragraphs(), [maximum]);
    await page.keyboard.insertText('y'); await page.locator('.error-banner').waitFor();
    assert.match(await page.locator('.error-banner').textContent(), /大小限制|超过|超出/);
    assert.deepEqual(await paragraphs(), [maximum], 'An over-limit native input must restore the last committed document');
    await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await idle();
    const maximumFile = inspect(await save('maximum-text.docx'));
    assert.deepEqual(maximumFile.paragraphs.map(p => p.text), [maximum]);
    report.files.maximum = { paragraphs: maximumFile.paragraphs.length, characters: maximumFile.paragraphs[0].text.length, zipEntries: maximumFile.zipEntries };
    await page.locator('.command-bar button[title="撤销"]').click(); await idle();
    assert.deepEqual(await paragraphs(), before, 'Undo must still work after rejecting an oversized input and saving');
  });
  ok('A 250,000-character document saves; an extra character is rejected without trapping invalid DOM, and shell undo still works');

  await stage('cross-paragraph-selection-and-real-clipboard', async () => {
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByTestId('independent-word-new').click(); await idle();
    await body().click(); await page.keyboard.insertText('甲一 中文😀 尾');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('乙二 中间');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('丙三 结尾'); await idle();
    const original = ['甲一 中文😀 尾', '乙二 中间', '丙三 结尾'];
    await selectRange(0, 3, 1, 2); await page.getByTestId('word-bold').click();
    await selectRange(0, 3, 1, 2); await page.keyboard.insertText('替换'); await idle();
    assert.deepEqual(await paragraphs(), ['甲一 替换 中间', '丙三 结尾']);
    await page.getByTestId('word-undo').click(); await idle(); assert.deepEqual(await paragraphs(), original);
    await page.getByTestId('word-redo').click(); await idle(); assert.deepEqual(await paragraphs(), ['甲一 替换 中间', '丙三 结尾']);
    await selectRange(0, 3, 1, 2); await page.keyboard.press('Backspace'); await idle();
    assert.deepEqual(await paragraphs(), ['甲一  结尾']);
    await page.getByTestId('word-undo').click(); await idle(); assert.deepEqual(await paragraphs(), ['甲一 替换 中间', '丙三 结尾']);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('粘贴中文😀尾\n第二行'));
    await body().focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+v'); await idle();
    assert.deepEqual(await paragraphs(), ['粘贴中文😀尾', '第二行']);
    await atEnd(); for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '第二行');
    await page.getByTestId('word-italic').click();
    await selectText('中文'); await page.getByTestId('word-bold').click();
    // Offset 6 is inside the ordinary run, between the complete emoji and 尾.
    // Keep a following glyph: the paragraph end inherits its independently
    // formatted marker, which is covered by the native marker editing suite.
    await selectRange(0, 6, 0, 6); await page.keyboard.insertText('普通'); await idle();
    assert.deepEqual(await paragraphs(), ['粘贴中文😀普通尾', '第二行']);
    const exported = inspect(await save('selection-paste.docx')); report.files.selectionPaste = exported;
    const runs = exported.paragraphs[0].runs;
    assert.ok(runs.filter(run => run.text.includes('中文')).every(run => run.bold));
    assert.ok(runs.filter(run => run.text.includes('普通')).every(run => !run.bold), 'Typing in an ordinary run after bold text must retain ordinary formatting');
    assert.ok(exported.paragraphs[1].runs.every(run => run.italic));
    await screenshot('selection-and-paste');
  });
  ok('Cross-paragraph replacement/deletion, undo/redo, real clipboard paste, keyboard range extension and typing after a formatted run preserve text and formatting');

  await stage('heading-soft-break-and-next-paragraph', async () => {
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByTestId('independent-word-new').click(); await idle();
    await body().click(); await page.getByTestId('word-heading').selectOption('1');
    await body().click(); await page.keyboard.insertText('标题新段');
    await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('仍是标题');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('回到正文'); await idle();
    assert.deepEqual(await paragraphs(), ['标题新段\n仍是标题', '回到正文']);
    const file = inspect(await save('heading-next-paragraph.docx')); report.files.headingNextParagraph = file;
    assert.equal(file.paragraphs[0].outlineLevel, '0');
    assert.ok(file.paragraphs[0].runs.every(run => run.bold && run.fontSize === 24));
    assert.ok([null, '9'].includes(file.paragraphs[1].outlineLevel));
    assert.ok(file.paragraphs[1].runs.every(run => !run.bold && run.fontSize === 12));
  });
  ok('A heading soft break retains heading formatting; Enter at its end starts a normal 12pt paragraph');

  await stage('mixed-run-formatting-does-not-leak-through-heading', async () => {
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByTestId('independent-word-new').click(); await idle();
    await body().click(); await page.keyboard.insertText('Italic Plain');
    await selectText('Italic'); await page.getByTestId('word-italic').click();
    await selectText('Italic'); await page.getByTestId('word-color').fill('#c00000');
    await selectText('Italic Plain'); await page.getByTestId('word-heading').selectOption('1');
    const saved = await save('mixed-heading.docx');
    await choose(saved); await idle();
    await selectText('Italic Plain'); await page.getByTestId('word-heading').selectOption('0');
    await selectText('Italic Plain'); await page.getByTestId('word-heading').selectOption('1');
    const result = inspect(await save('mixed-heading-reopened.docx')); report.files.mixedHeading = result;
    assert.equal(result.paragraphs[0].text, 'Italic Plain');
    const italic = result.paragraphs[0].runs.filter(run => run.text.includes('Italic'));
    const plain = result.paragraphs[0].runs.filter(run => run.text.includes('Plain'));
    assert.ok(italic.length && italic.every(run => run.italic && run.color?.toUpperCase() === 'C00000'));
    assert.ok(plain.length && plain.every(run => !run.italic && run.color?.toUpperCase() !== 'C00000'), 'Character formatting from the first run must not become the paragraph default');
    assert.ok(result.paragraphs[0].runs.every(run => run.fontSize === 24), 'Non-overridden font sizes must still follow the heading style after save/reopen');
  });
  ok('Partial italic/color formatting stays local through heading changes and save/reopen; inherited font size still follows the paragraph style');
  assert.equal(await page.locator('iframe').count(), 0);
  assert.deepEqual(report.officeRuntimeRequests, []); assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedRequests, []);
  ok('The complete independent session uses no iframe, Office runtime, WASM, external requests, failed requests or browser errors');
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { phase, message: error.message, stack: error.stack };
  if (page) { try { await screenshot('failure'); report.failure.body = (await page.locator('body').innerText()).slice(-6000); } catch {} }
  console.error(error); process.exitCode = 1;
} finally { persist(); if (browser) await browser.close(); } })();
