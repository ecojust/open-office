/* Complete native LibreOffice corpus -> real editor controls/keyboard/downloads
 * -> native LibreOffice resave -> reopen. Python independently resolves OOXML.
 * Synthetic malformed files are separate and never replace native fixtures.
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
const corpus = path.join(root, 'tests/compatibility/independent-word-underline');
const output = path.resolve(process.env.WORD_UNDERLINE_OUTPUT || path.join(root, 'test-results/independent-word-underline'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const fixture = manifest.fixtures.find(f => f.name === 'inheritance');
const inlineFixture = manifest.fixtures.find(f=>f.name==='inline-underline');
const inlineFile=path.join(corpus,inlineFixture.docx);
const sourceFile = path.join(corpus, fixture.docx);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['src/word/core/background.ts', 'src/word/core/highlight.ts', 'src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/editor.css', 'src/style.css', 'src/components/StandaloneWordEditor.vue'];
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, sha256(path.join(root, p))]));
const testHashes = () => Object.fromEntries(['tests/browser/independent-word-underline.cjs','tests/compatibility/independent-word-underline/inspect.py','tests/compatibility/independent-word-underline/manifest.json'].map(p=>[p,sha256(path.join(root,p))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = document => document.paragraphs.map(p => p.characters);
const texts = document => document.paragraphs.map(p => p.text);
const fullCharacters = paragraph => paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, ...Object.fromEntries(['backgroundColor', 'highlight', 'fontSize', 'fontSizeCs', 'verticalAlign', 'strike', 'underline', 'underlineColor', 'color', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, run.style[key] ?? null])), bold: !!run.style.bold, italic: !!run.style.italic })));
const report = { scope:'Original authored ODT and explicitly synthetic underline inheritance DOCX -> untouched native LibreOffice DOCX -> real UI/download/native resave/reopen', limitations:['One native LibreOffice build, no Microsoft Word runtime.','Native outputs remain complete and unmodified.','Continuous CSS, not native pagination or pixel fidelity.','Enter expected behavior is source-based; keyboard runs in Chromium.','insertText is not an OS IME test.'], productBefore:sourceHashes(), corpus:manifest.fixtures.map(f=>({name:f.name,sourceKind:f.sourceKind,sourceSha256:sha256(path.join(corpus,f.source)),docxSha256:sha256(path.join(corpus,f.docx))})), checks:[],pageErrors:[],consoleErrors:[],externalRequests:[],runtimeRequests:[] };
report.testBefore=testHashes();
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const ok = message => { report.checks.push(message); console.log('PASS', message); persist(); };
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
async function range(p, start, end = start) {
  await content().evaluate((node, { p, start, end }) => {
    const paragraph = node.children[p];
    const at = offset => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT); let text;
      while ((text = walker.nextNode())) { if (offset <= text.length) return [text, offset]; offset -= text.length; }
      if (offset === 0) return [paragraph, paragraph.childNodes.length];
      throw Error('Selection offset out of bounds');
    };
    node.focus(); window.getSelection().setBaseAndExtent(...at(start), ...at(end)); document.dispatchEvent(new Event('selectionchange'));
  }, { p, start, end });
}
async function selectText(p, text) { const full = await content().evaluate((n,p) => n.children[p].textContent,p); const start = full.indexOf(text); assert.ok(start >= 0); await range(p,start,start+text.length); }
async function undo() { await page.locator('.command-bar button[title="撤销"]').click(); await idle(); }
async function redo() { await page.locator('.command-bar button[title="重做"]').click(); await idle(); }
async function strike(value) { await page.getByTestId('word-strike-menu-toggle').click(); await page.getByTestId(`word-strike-${value}`).click(); await idle(); }
async function nativeRoundtrip(file, name) {
  const destination = path.join(output, 'native', name); fs.mkdirSync(destination, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-underline-native-'));
  try {
    const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const target = path.join(destination,path.basename(file)); assert.ok(fs.existsSync(target),result.stdout+result.stderr);
    return { file: target, sha256: sha256(target), stdout: result.stdout, stderr: result.stderr, document: inspect(target) };
  } finally { fs.rmSync(profile,{ recursive:true,force:true }); }
}
function chars(text, style) { return Array.from(text,character => ({ character, fontSize:12, strike:'none', verticalAlign:'baseline', underline:false, highlight:'none', backgroundColor:'none', ...style })); }
function replaceChars(expected,p,start,deleteCount,text,style) { const copy=structuredClone(expected); copy[p].splice(start,deleteCount,...chars(text,style)); return copy; }
async function assertDownload(name,expected) { const file=await save(name), document=inspect(file); assert.deepEqual(semantics(document),expected,name); return {file,document}; }
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main', R='http://schemas.openxmlformats.org/officeDocument/2006/relationships', PR='http://schemas.openxmlformats.org/package/2006/relationships';
function synthetic(body,styles='') {
  const parts={
    '[Content_Types].xml':`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles?'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>':''}</Types>`,
    '_rels/.rels':`<Relationships xmlns="${PR}"><Relationship Id="r1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml':`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  if(styles){parts['word/styles.xml']=`<w:styles xmlns:w="${W}">${styles}</w:styles>`;parts['word/_rels/document.xml.rels']=`<Relationships xmlns="${PR}"><Relationship Id="s" Type="${R}/styles" Target="styles.xml"/></Relationships>`;}
  return Array.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,strToU8(v)]))));
}

async function highlight(value) { await page.getByTestId('word-highlight-menu-toggle').click(); await page.getByTestId(`word-highlight-${value}`).click(); await idle(); }
async function background(value) { await page.getByTestId('word-background-menu-toggle').click(); if(value==='none')await page.getByTestId('word-background-none').click(); else {await page.getByTestId('word-background-color').fill(value.toLowerCase());await page.getByTestId('word-background-apply').click();}await idle(); }
function hashes() { for(const f of manifest.fixtures){assert.equal(sha256(path.join(corpus,f.docx)),f.docxSha256);assert.equal(sha256(path.join(corpus,f.source)),f.sourceSha256);} }
async function underline(value) {
  await page.getByTestId('word-underline-menu-toggle').click();
  await page.getByTestId(`word-underline-${value}`).click();
  await idle();
}
async function menuSelected(value) {
  await page.getByTestId('word-underline-menu-toggle').click();
  for (const name of ['none', 'single', 'double']) assert.equal(await page.getByTestId(`word-underline-${name}`).getAttribute('aria-checked'), String(name === value));
  await page.keyboard.press('Escape');
}

(async () => { try {
  hashes();
  const expected = fixture.expectedSemantics.characters;
  const combo = { underline:'double', strike:'double', fontSize:18, highlight:'magenta', backgroundColor:'#13579B', verticalAlign:'superscript' };
  const sub = { underline:'double', strike:'single', fontSize:18, highlight:'cyan', backgroundColor:'#ABCDEF', verticalAlign:'subscript' };
  const { createServer } = await import('vite');
  server = await createServer({root, cacheDir:'node_modules/.vite-word-underline-test', server:{host:'127.0.0.1', port:0, strictPort:false, hmr:false, watch:{ignored:['**/src-tauri/target/**','**/test-results/**']}}});
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`, origin = new URL(url).origin;
  browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args:['--no-sandbox','--disable-dev-shm-usage']});
  page = await browser.newPage({viewport:{width:1360,height:1000}, acceptDownloads:true});
  page.setDefaultTimeout(30000);
  await page.routeWebSocket('**', () => {});
  page.on('request', request => {const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&url.origin!==origin)report.externalRequests.push(url.href);if(/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(url.href))report.runtimeRequests.push(url.href);});
  page.on('pageerror', error => report.pageErrors.push({phase,message:error.message}));
  page.on('console', message => {if(message.type()==='error')report.consoleErrors.push({phase,message:message.text()});});
  await page.goto(url);
  await page.getByTestId('independent-word-open').waitFor();

  phase = 'untouched-native-corpus';
  report.nativeRoundtrips = [];
  let home = true;
  for (const nativeFixture of manifest.fixtures.filter(fixture => !fixture.expectUnsupported)) {
    const file = path.join(corpus,nativeFixture.docx), original = inspect(file), contract = nativeFixture.expectedSemantics.characters;
    assert.deepEqual(texts(original),nativeFixture.expectedParagraphs);
    assert.deepEqual(semantics(original),contract);
    if(nativeFixture.expectedUnderlineColorSegments) assert.deepEqual(original.paragraphs.flatMap(fullCharacters).map(c=>({character:c.character,underlineColor:c.underlineColor})),nativeFixture.expectedUnderlineColorSegments.flatMap(s=>Array.from(s.text,character=>({character,underlineColor:s.underlineColor}))));
    await open(file,home); home=false;
    const first = await assertDownload(`${nativeFixture.name}-first.docx`,contract);
    assert.deepEqual(first.document.paragraphs.map(fullCharacters),original.paragraphs.map(fullCharacters));
    await open(first.file);
    await assertDownload(`${nativeFixture.name}-second.docx`,contract);
    const native = await nativeRoundtrip(first.file,nativeFixture.name);
    assert.deepEqual(semantics(native.document),contract);
    assert.deepEqual(native.document.paragraphs.map(p=>fullCharacters(p).map(c=>c.underlineColor)),original.paragraphs.map(p=>fullCharacters(p).map(c=>c.underlineColor)));
    await open(native.file);
    await assertDownload(`${nativeFixture.name}-native-reopened.docx`,contract);
    report.nativeRoundtrips.push({name:nativeFixture.name,sourceKind:nativeFixture.sourceKind,...native});
  }
  ok('Complete original ODT and explicitly synthetic inheritance DOCX retain single/double/none, named/paragraph/basedOn/direct resets and independent formats through two saves, native LibreOffice resave and reopen');

  phase = 'menu-history-and-mixed';
  await open(inlineFile);
  await selectText(6,'single double none');
  assert.equal(await page.getByTestId('word-underline').getAttribute('aria-pressed'),'mixed');
  await menuSelected('mixed');
  const inlineExpected = inlineFixture.expectedSemantics.characters;
  const changed = structuredClone(inlineExpected);
  for (const [choice,value] of [['double','double'],['single',true],['none',false]]) {
    await underline(choice);
    changed[6] = changed[6].map(character => ({...character,underline:value}));
    await assertDownload(`mixed-${choice}.docx`,changed);
    await menuSelected(choice);
  }
  await undo(); changed[6]=changed[6].map(character=>({...character,underline:true}));
  await assertDownload('mixed-none-undo.docx',changed);
  await redo(); changed[6]=changed[6].map(character=>({...character,underline:false}));
  await assertDownload('mixed-none-redo.docx',changed);
  await underline('double');
  await page.getByTestId('word-underline').click();
  changed[6]=changed[6].map(character=>({...character,underline:false}));
  await assertDownload('main-button-clears-double.docx',changed);
  await page.getByTestId('word-underline').click();
  changed[6]=changed[6].map(character=>({...character,underline:true}));
  await assertDownload('main-button-applies-single.docx',changed);
  await underline('double'); await content().focus(); await page.keyboard.press('Control+u'); await idle();
  changed[6]=changed[6].map(character=>({...character,underline:false}));
  await assertDownload('shortcut-clears-double.docx',changed);
  ok('Mixed single/double/none selection uses explicit menu styles, one-step undo/redo; main button and Ctrl+U clear existing double while ordinary toggle applies single');

  phase = 'inherited-reset-and-native-edit';
  await open(sourceFile); await selectText(2,'Paragraph double'); await underline('none');
  const cleared = structuredClone(expected); cleared[2]=cleared[2].map(character=>({...character,underline:false}));
  const reset = await assertDownload('inherited-double-cleared.docx',cleared);
  assert.ok(reset.document.paragraphs[2].runs.every(run=>run.directStyle.underline===false));
  await undo(); await assertDownload('inherited-clear-undo.docx',expected);
  await redo(); await assertDownload('inherited-clear-redo.docx',cleared);
  await open(sourceFile); await selectText(12,'Edit target'); await underline('double');
  await range(12,'Edit target'.length); await page.keyboard.type(' ASCII'); await page.keyboard.insertText(' 中文😀'); await idle();
  const edited = structuredClone(expected); edited[12]=chars('Edit target ASCII 中文😀',{underline:'double'});
  const editedFile = await assertDownload('underline-edited.docx',edited);
  const nativeEdit = await nativeRoundtrip(editedFile.file,'edited');
  assert.deepEqual(semantics(nativeEdit.document),edited);
  await open(nativeEdit.file); await assertDownload('underline-edited-native-reopened.docx',edited);
  report.nativeEdited=nativeEdit;
  ok('Clearing inherited double writes explicit none; undo/redo, actual ASCII/CJK/emoji edits and native resave/reopen preserve the intended underline');

  phase = 'keyboard-and-menu-closure';
  await selectText(12,'Edit target');
  const toggle = page.getByTestId('word-underline-menu-toggle');
  await toggle.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByTestId('word-underline-double').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Home'); assert.equal(await page.getByTestId('word-underline-none').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('End'); assert.equal(await page.getByTestId('word-underline-double').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('ArrowUp'); assert.equal(await page.getByTestId('word-underline-single').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape'); assert.equal(await page.getByTestId('word-underline-menu').count(),0);
  await toggle.click(); await page.keyboard.press('Tab'); assert.equal(await page.getByTestId('word-underline-menu').count(),1);
  assert.equal(await page.getByTestId('word-underline-menu').evaluate(node=>node.contains(document.activeElement)),true);
  await page.locator('.command-bar button[title="撤销"]').focus(); await page.getByTestId('word-underline-menu').waitFor({state:'hidden'});
  await toggle.click(); await page.getByTestId('word-highlight-menu-toggle').click(); assert.equal(await page.getByTestId('word-underline-menu').count(),0); await page.keyboard.press('Escape');
  await toggle.click(); await page.locator('.word-status > span').first().click(); assert.equal(await page.getByTestId('word-underline-menu').count(),0);
  await range(12,0); await toggle.click(); await page.screenshot({path:path.join(output,'underline-menu.png'),fullPage:true});
  await page.keyboard.press('Escape'); await page.setViewportSize({width:320,height:400}); await toggle.click();
  const bounds = await page.getByTestId('word-underline-menu').boundingBox();
  assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=320&&bounds.y>=0&&bounds.y+bounds.height<=400);
  await page.screenshot({path:path.join(output,'underline-menu-narrow.png'),fullPage:true});
  await page.keyboard.press('Escape'); await page.setViewportSize({width:1360,height:1000});
  ok('Underline menu focuses current style, supports Home/End/arrows/Escape/Tab, excludes other menus and stays within a 320×400 viewport');

  phase = 'nested-typing-and-structural-editing';
  for (const [paragraph,style] of [[10,combo],[11,sub]]) {
    await open(sourceFile); await range(paragraph,3); await page.keyboard.type('abc'); await page.keyboard.insertText('汉😀'); await idle();
    const typed = replaceChars(expected,paragraph,3,0,'abc汉😀',style);
    const result=await assertDownload(`nested-${paragraph}.docx`,typed); await open(result.file); await assertDownload(`nested-${paragraph}-second.docx`,typed);
  }
  await open(sourceFile); await range(10,3); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('X'); await idle();
  await assertDownload('double-softbreak.docx',replaceChars(expected,10,3,0,'\nX',combo));
  await open(sourceFile); await range(10,3); await page.keyboard.press('Enter'); await idle();
  const middle=structuredClone(expected); middle.splice(10,1,expected[10].slice(0,3),expected[10].slice(3));
  await assertDownload('double-middle-enter.docx',middle); await undo(); await assertDownload('double-middle-undo.docx',expected);
  await range(10,fixture.expectedParagraphs[10].length); await page.keyboard.press('Enter'); await page.keyboard.type('next'); await idle();
  const end=structuredClone(expected); end.splice(11,0,chars('next',{...combo,verticalAlign:'baseline'}));
  await assertDownload('double-end-enter.docx',end);
  await open(sourceFile); await range(3,0); await page.keyboard.press('Backspace'); await idle();
  const merged=structuredClone(expected); merged.splice(2,2,[...expected[2],...expected[3]]);
  const merge=await assertDownload('double-backspace-merge.docx',merged); await undo(); await assertDownload('double-merge-undo.docx',expected); await redo(); await open(merge.file); await assertDownload('double-merge-second.docx',merged);
  await open(sourceFile); await range(2,fixture.expectedParagraphs[2].length); await page.keyboard.press('Delete'); await idle(); await assertDownload('double-forward-merge.docx',merged);
  ok('Double underline coexists with single/double strike and both scripts through real nested typing, soft/middle/end breaks and both-direction paragraph merges');

  phase = 'whole-paragraph-replacement';
  report.replacements=[];
  for (const method of ['type','insertText','backspace-then-type','delete-then-insertText']) {
    await open(sourceFile); await range(10,0,fixture.expectedParagraphs[10].length);
    if(method==='type')await page.keyboard.type('AB');
    else if(method==='insertText')await page.keyboard.insertText('替换😀');
    else {await page.keyboard.press(method.startsWith('backspace')?'Backspace':'Delete');await idle();const empty=await save(`empty-${method}.docx`);await open(empty);await range(10,0);if(method.startsWith('backspace'))await page.keyboard.type('AB');else await page.keyboard.insertText('替换😀');}
    await idle();
    const text=method==='type'||method.startsWith('backspace')?'AB':'替换😀', replaced=structuredClone(expected);replaced[10]=chars(text,combo);
    const download=await assertDownload(`replace-${method}.docx`,replaced);await open(download.file);await assertDownload(`replace-${method}-second.docx`,replaced);report.replacements.push({method,text});
  }
  await open(sourceFile);await range(10,0,fixture.expectedParagraphs[10].length);await page.keyboard.insertText('替换😀');await idle();await undo();await assertDownload('replace-undo.docx',expected);await redo();const replaced=structuredClone(expected);replaced[10]=chars('替换😀',combo);await assertDownload('replace-redo.docx',replaced);
  ok('Whole-paragraph typing/replacement and selection deletion retain double underline and all independent formats, including empty save/reopen and undo/redo');

  phase = 'last-character-deletion';
  report.finalGraphemes=[];
  for (const fallback of [false,true]) {
    await page.evaluate(fallback=>{window.underlineOriginalTargetRanges ||= InputEvent.prototype.getTargetRanges;InputEvent.prototype.getTargetRanges=fallback?function(){return []}:window.underlineOriginalTargetRanges;},fallback);
    for (const text of ['A','😀','👩‍💻','e\u0301']) {
      await open(sourceFile);await range(10,0,fixture.expectedParagraphs[10].length);await page.keyboard.insertText(text);await page.keyboard.press('End');await page.keyboard.press('Backspace');await idle();
      const remaining=await content().evaluate(node=>node.children[10].textContent);
      if(remaining){assert.equal(fallback,false);assert.equal(text,'e\u0301');assert.equal(remaining,'e');await page.keyboard.press('Backspace');await idle();}
      assert.equal(await content().evaluate(node=>node.children[10].textContent),'');await menuSelected('double');
      await page.keyboard.insertText(text);await page.keyboard.press('Home');await page.keyboard.press('Delete');await idle();
      assert.equal(await content().evaluate(node=>node.children[10].textContent),'');await menuSelected('double');
      const empty=await save(`last-empty-${report.finalGraphemes.length}.docx`);await open(empty);await range(10,0);await page.keyboard.insertText('保留😀');await idle();
      const inserted=structuredClone(expected);inserted[10]=chars('保留😀',combo);const download=await assertDownload(`last-insert-${report.finalGraphemes.length}.docx`,inserted);await open(download.file);await assertDownload(`last-second-${report.finalGraphemes.length}.docx`,inserted);
      report.finalGraphemes.push({text,fallback,backward:true,forward:true,emptySaveReopen:true});
    }
  }
  await page.evaluate(()=>InputEvent.prototype.getTargetRanges=window.underlineOriginalTargetRanges);
  ok('ASCII/emoji/ZWJ/combining final-character deletion preserves double underline, script/strike/highlight/background with native target ranges and fallback through empty save/reopen');

  phase = 'imported-empty-insertion';
  const emptyFile=path.join(output,'synthetic-empty-double.docx');
  fs.writeFileSync(emptyFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:dstrike/><w:sz w:val="36"/><w:highlight w:val="magenta"/><w:u w:val="double"/><w:shd w:val="clear" w:fill="13579B"/><w:vertAlign w:val="superscript"/></w:rPr><w:t/></w:r></w:p>')));
  await open(emptyFile);const emptySaved=await save('empty-double-first.docx');await open(emptySaved);await range(0,0);await page.keyboard.type('AB');await page.keyboard.insertText('中文😀');await idle();await assertDownload('empty-double-typed.docx',[chars('AB中文😀',combo)]);
  ok('Imported empty double-underlined run retains insertion styles after save/reopen and real typing');

  phase = 'dom-independent-decoration';
  report.dom = await page.evaluate(async () => {
    const {renderWordDom,readWordDom}=await import('/src/word/core/dom.ts');
    const {createWordDocument,normalizeDocument}=await import('/src/word/core/model.ts');
    const host=document.createElement('div');document.body.append(host);
    const equal=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+' '+JSON.stringify({a,b}));};
    const results=[];
    try {
      for(const underline of [undefined,false,true,'double'])for(const strike of ['none','single','double'])for(const verticalAlign of ['baseline','superscript','subscript']){
        const style={...(underline===undefined?{}:{underline}),strike,verticalAlign,fontSize:18,highlight:'yellow',backgroundColor:'#123456'};
        const document=createWordDocument();document.paragraphs[0]={id:'probe',style:{},sourceRun:style,runs:[{text:'A中文😀Z',style,directStyle:{}}]};let current=normalizeDocument(document);
        for(let cycle=0;cycle<8;cycle++){renderWordDom(host,current);const read=readWordDom(host,current);equal(read.paragraphs[0].runs,current.paragraphs[0].runs,'decoration cycle');current=read;}
        const run=host.firstElementChild.firstElementChild, visual=run.querySelector('[data-word-visual="script"]')||run;
        equal(visual.style.textDecorationLine,underline===undefined?'':underline?'underline':'none','underline line');equal(visual.style.textDecorationStyle,underline===undefined?'':underline==='double'?'double':'solid','underline style');
        const strikeNode=run.querySelector('[data-word-visual="strike"]');
        if(strikeNode){equal(strikeNode.style.textDecorationLine,'line-through','strike line');equal(strikeNode.style.textDecorationStyle,strike==='double'?'double':'solid','strike style');strikeNode.removeAttribute('data-word-visual');equal(readWordDom(host,current).paragraphs[0].runs,current.paragraphs[0].runs,'native clone');}
        results.push({underline:underline??'absent',strike,verticalAlign,cycles:8});
      }
      let recoveredMetadata=0;
      for(const directUnderline of [undefined,false,true,'double'])for(const verticalAlign of ['baseline','superscript','subscript']){
        const sourceRun={underline:'double',fontSize:18},directStyle={verticalAlign,...(directUnderline===undefined?{}:{underline:directUnderline})};
        const document=createWordDocument();document.paragraphs[0]={id:'missing-underline',style:{},sourceRun,runs:[{text:'AB',style:{...sourceRun,...directStyle},directStyle}]};
        const current=normalizeDocument(document);renderWordDom(host,current);host.firstElementChild.firstElementChild.removeAttribute('data-word-underline');equal(readWordDom(host,current).paragraphs[0].runs,current.paragraphs[0].runs,'missing underline provenance');recoveredMetadata++;
      }
      const previous=createWordDocument();previous.paragraphs[0].id='css';
      const cases=[['<u style="text-decoration-style:double">a</u>',{underline:'double'}],['<span style="text-decoration:underline double">a</span>',{underline:'double',underlineColor:'auto'}],['<span style="text-decoration:underline line-through double">a</span>',{underline:'double',underlineColor:'auto',strike:'double'}],['<u><span style="text-decoration:line-through double">a</span></u>',{underline:true,strike:'double'}],['<span style="text-decoration:underline double"><s>a</s></span>',{underline:'double',underlineColor:'auto',strike:'single'}],['<span style="text-decoration:underline double"><span style="text-decoration:none">a</span></span>',{underline:'double',underlineColor:'auto'}],['<span style="text-decoration:underline double" data-word-underline="false">a</span>',{underline:false,underlineColor:'auto'}]];
      cases.push(['<u style="text-decoration:none">a</u>',{}],['<s style="text-decoration:none">a</s>',{}],['<span style="text-decoration:underline double"><u style="text-decoration:none">a</u></span>',{underline:'double',underlineColor:'auto'}]);
      for(const [html,expected]of cases){host.innerHTML=`<p data-word-paragraph="css">${html}</p>`;equal(readWordDom(host,previous).paragraphs[0].runs[0].style,expected,'external CSS');}
      let rejectedPatterns=0;for(const pattern of ['wavy','dotted','dashed'])for(const html of [`<span style="text-decoration:underline ${pattern}">a</span>`,`<u style="text-decoration-style:${pattern}">a</u>`,`<s style="text-decoration-style:${pattern}">a</s>`]){host.innerHTML=`<p data-word-paragraph="css">${html}</p>`;let rejected=false;try{readWordDom(host,previous);}catch{rejected=true;}if(!rejected)throw Error('Unsupported CSS silently accepted: '+html);rejectedPatterns++;}
      let rejectedMetadata=0;for(const metadata of ['single','none','TRUE','DOUBLE','']){host.innerHTML=`<p data-word-paragraph="css"><span data-word-underline="${metadata}">a</span></p>`;let rejected=false;try{readWordDom(host,previous);}catch{rejected=true;}if(!rejected)throw Error('Invalid underline metadata accepted');rejectedMetadata++;}
      return {combinations:results,recoveredMetadata,externalCssCases:cases.length,rejectedPatterns,rejectedMetadata};
    }finally{host.remove();}
  });
  ok('36 underline/strike/script combinations survive eight DOM cycles and metadata-free strike clones; 12 missing-metadata and 10 external CSS contracts pass, nine patterned decorations and five invalid metadata encodings reject');

  phase = 'malformed-ooxml-and-atomic-import';
  report.negative=[];
  for(const [name,properties]of [['missing-value','<w:u/>'],['wave','<w:u w:val="wave"/>'],['words','<w:u w:val="words"/>'],['heavy','<w:u w:val="thick"/>'],['invalid-color','<w:u w:val="double" w:color="FF000000"/>'],['auto-color','<w:u w:val="double" w:color="auto"/>'],['theme','<w:u w:val="double" w:themeColor="accent1"/>'],['tint','<w:u w:val="double" w:themeTint="80"/>'],['shade','<w:u w:val="double" w:themeShade="80"/>'],['duplicate','<w:u w:val="single"/><w:u w:val="double"/>'],['unknown-attribute','<w:u w:val="double" w:foo="1"/>'],['nested','<w:u w:val="double"><w:b/></w:u>']]){
    const error=await page.evaluate(async bytes=>{try{(await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes));return null;}catch(error){return error.message;}},synthetic(`<w:p><w:r><w:rPr>${properties}</w:rPr><w:t>Unsupported</w:t></w:r></w:p>`));assert.ok(error,name+' accepted');report.negative.push({name,error});
  }
  await open(sourceFile);await range(12,0);await page.keyboard.insertText('unsaved ');await idle();report.atomicErrors=[];
  for(const fixture of manifest.fixtures.filter(fixture=>fixture.expectUnsupported)){
    const before=await content().innerHTML(), tabs=await page.locator('.document-tab').count(), chooser=page.waitForEvent('filechooser');
    await page.locator('.command-bar').getByRole('button',{name:'打开',exact:true}).click();await(await chooser).setFiles(path.join(corpus,fixture.docx));
    await page.locator('.error-banner').waitFor();await page.locator('.busy-overlay').waitFor({state:'hidden'});
    assert.equal(await content().innerHTML(),before);assert.equal(await page.locator('.document-tab').count(),tabs);assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(),1);
    report.atomicErrors.push({name:fixture.name,error:await page.locator('.error-banner').textContent()});await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();await idle();
  }
  await undo();await assertDownload('atomic-import-history-intact.docx',expected);
  ok('12 malformed/unsupported OOXML encodings reject, including explicit OOXML auto and invalid RGB; untouched native wave documents reject atomically while preserving unsaved content, tabs and undo history');

  phase = 'frozen-sources';
  hashes();report.productAfter=sourceHashes();assert.deepEqual(report.productAfter,report.productBefore,'Product changed during regression; rerun after freeze');
  report.testAfter=testHashes();assert.deepEqual(report.testAfter,report.testBefore,'Test changed during regression; rerun after freeze');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.runtimeRequests,[]);
  report.ok=true;
} catch(error) {
  report.ok=false;report.failure={phase,message:error.message,stack:error.stack};
  if(page){try{report.failure.body=(await page.locator('body').innerText()).slice(-6000);await page.screenshot({path:path.join(output,'failure.png')});}catch{}}
  console.error(error);process.exitCode=1;
} finally {
  persist();if(browser)await browser.close();if(server)await server.close();
}})();
