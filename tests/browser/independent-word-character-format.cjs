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
const corpus = path.join(root, 'tests/compatibility/independent-word-character-format');
const output = path.resolve(process.env.WORD_CHARACTER_OUTPUT || path.join(root, 'test-results/independent-word-character-format'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const fixture = manifest.fixtures[0];
const sourceFile = path.join(corpus, fixture.docx);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/highlight.ts', 'src/word/core/background.ts', 'src/word/core/editor.css', 'src/components/StandaloneWordEditor.vue'];
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, sha256(path.join(root, p))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = document => document.paragraphs.map(p => p.characters);
const texts = document => document.paragraphs.map(p => p.text);
const fullCharacters = paragraph => paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, ...Object.fromEntries(['fontSize', 'fontSizeCs', 'verticalAlign', 'strike', 'underline', 'color', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, run.style[key] ?? null])), bold: !!run.style.bold, italic: !!run.style.italic })));
const report = { scope: 'Independent character-format compatibility against an untouched native LibreOffice DOCX and actual native resave', limitations: ['One installed native LibreOffice build; no Microsoft Word runtime.', 'CSS script scale/offset and separate underline/strike are checked, not native pixel or pagination fidelity.', 'Enter expectations come from pinned LibreOffice source; keystrokes run in Chromium, not LibreOffice.', 'insertText is not an operating-system IME test.'], corpus: { sha256: sha256(sourceFile), nativeVersion: manifest.libreoffice.version }, productBefore: sourceHashes(), checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [] };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-character-native-'));
  try {
    const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const target = path.join(destination,path.basename(file)); assert.ok(fs.existsSync(target),result.stdout+result.stderr);
    return { file: target, sha256: sha256(target), stdout: result.stdout, stderr: result.stderr, document: inspect(target) };
  } finally { fs.rmSync(profile,{ recursive:true,force:true }); }
}
function chars(text, style) { return Array.from(text,character => ({ character, fontSize:12, strike:'none', verticalAlign:'baseline', underline:false, ...style })); }
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
(async()=>{try{
  assert.equal(sha256(sourceFile),fixture.docxSha256);
  const original=inspect(sourceFile), expected=fixture.expectedSemantics.characters;
  assert.deepEqual(texts(original),fixture.expectedParagraphs); assert.deepEqual(semantics(original),expected);
  report.original=original;
  const { createServer }=await import('vite');
  server=await createServer({root,cacheDir:'node_modules/.vite-word-character-test',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:{ignored:['**/src-tauri/target/**','**/test-results/**']}}});await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}/`, origin=new URL(url).origin;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  page=await browser.newPage({viewport:{width:1360,height:1000},acceptDownloads:true});page.setDefaultTimeout(30000);await page.routeWebSocket('**',()=>{});
  page.on('request',request=>{const u=new URL(request.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)report.externalRequests.push(u.href);if(/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(u.href))report.runtimeRequests.push(u.href);});
  page.on('pageerror',error=>report.pageErrors.push({phase,message:error.message}));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({phase,message:m.text()});});
  await page.goto(url);await page.getByTestId('independent-word-open').waitFor();
  phase='native-import-and-render';await open(sourceFile,true);
  report.visual=await content().evaluate(node=>[...node.querySelectorAll('[data-word-vertical-align]')].map(run=>{const script=run.querySelector('[data-word-visual="script"]'),strike=run.querySelector('[data-word-visual="strike"]');return {text:run.textContent,verticalAlign:run.dataset.wordVerticalAlign,strike:run.dataset.wordStrike,logicalPt:parseFloat(run.style.fontSize),visualPx:script?parseFloat(getComputedStyle(script).fontSize):null,basePx:parseFloat(getComputedStyle(run).fontSize),offset:script?parseFloat(getComputedStyle(script).verticalAlign):null,strikeLine:strike?getComputedStyle(strike).textDecorationLine:null,strikeStyle:strike?getComputedStyle(strike).textDecorationStyle:null,underline:run.dataset.wordUnderline};}));
  assert.ok(report.visual.some(r=>r.verticalAlign==='superscript'));assert.ok(report.visual.some(r=>r.verticalAlign==='subscript'));
  for(const r of report.visual.filter(r=>r.verticalAlign!=='baseline')){assert.ok(Math.abs(r.visualPx/r.basePx-.58)<.001);assert.ok(r.verticalAlign==='superscript'?r.offset>0:r.offset<0);assert.ok([9,12,16,18,24].includes(r.logicalPt));}
  const combo=report.visual.find(r=>r.text.includes('Underline double'));assert.equal(combo.strike,'double');assert.equal(combo.strikeStyle,'double');assert.equal(combo.strikeLine,'line-through');assert.equal(combo.underline,'true');
  const originalSave = await assertDownload('native-original-save.docx',expected);
  assert.deepEqual(originalSave.document.paragraphs.map(fullCharacters), original.paragraphs.map(fullCharacters), 'Unchanged text must retain fonts, regional language, complex-script size, kerning and all other supported run properties');
  ok('Untouched native DOCX matches ODT-authored per-character contract; import/render/save preserves named/direct super/sub/base, strike resets and logical sizes');

  phase='native-ui-roundtrip';await range(4,fixture.expectedParagraphs[4].length);await page.keyboard.type(' ASCII');await page.keyboard.insertText(' 中文😀');await idle();
  const changed=structuredClone(expected);changed[4].push(...chars(' ASCII 中文😀'));
  const first=await assertDownload('native-edited.docx',changed);report.nativeControl=await nativeRoundtrip(sourceFile,'control');report.nativeEdited=await nativeRoundtrip(first.file,'edited');
  assert.deepEqual(semantics(report.nativeControl.document),expected);assert.deepEqual(semantics(report.nativeEdited.document),changed);
  assert.deepEqual(report.nativeEdited.document.paragraphs.slice(0,4).map(fullCharacters),report.nativeControl.document.paragraphs.slice(0,4).map(fullCharacters),'All nonedited native properties must match an unedited LibreOffice resave control');
  await open(report.nativeEdited.file);await assertDownload('native-reopened.docx',changed);
  ok('Actual UI keyboard typing/download -> native LibreOffice resave -> UI reopen/download preserves per-character script/strike/underline and logical font sizes');

  phase='nested-script-typing';await open(sourceFile);
  const at=fixture.expectedParagraphs[3].indexOf('中')+1;await range(3,at);await page.keyboard.type('abc');await page.keyboard.insertText('汉😀');await idle();
  const atChars=Array.from(fixture.expectedParagraphs[3].slice(0,at)).length;
  const typed=replaceChars(expected,3,atChars,0,'abc汉😀',{verticalAlign:'superscript',strike:'double',underline:true});
  const nested=await assertDownload('nested-script-typing.docx',typed);await open(nested.file);await assertDownload('nested-script-typing-reopened.docx',typed);
  report.domCycles=await page.evaluate(async bytes=>{const {importWordDocument}=await import('/src/word/core/docx.ts');const {renderWordDom,readWordDom}=await import('/src/word/core/dom.ts');let doc=importWordDocument(Uint8Array.from(bytes));const initial=JSON.stringify(doc.paragraphs.map(p=>p.runs.map(r=>[r.text,r.style])));const root=document.createElement('div');document.body.append(root);try{for(let i=0;i<12;i++){renderWordDom(root,doc);doc=readWordDom(root,doc);}if(JSON.stringify(doc.paragraphs.map(p=>p.runs.map(r=>[r.text,r.style])))!==initial)throw Error('Owned visual wrappers changed logical styles during read/render cycles');return {iterations:12,paragraphs:doc.paragraphs.length};}finally{root.remove();}},Array.from(fs.readFileSync(nested.file)));
  ok('Real ASCII typing and Unicode insertText inside CJK/emoji script+double-strike+underline wrappers retain logical 12pt through reopen and 12 DOM read/render cycles');

  phase='empty-scripted-insertion-and-heading';
  const emptyFile=path.join(output,'synthetic-empty-scripted-run.docx');fs.writeFileSync(emptyFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:dstrike/><w:sz w:val="36"/><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr><w:t/></w:r></w:p>')));await open(emptyFile);
  const emptySaved=await save('empty-scripted-before-typing.docx');await open(emptySaved);
  // Saving this legacy empty run promotes its insertion format to a real
  // paragraph marker (pPr/rPr). After reopening, marker escapement persists
  // across Enter, as verified by the native marker editing corpus; a direct
  // body-run escapement without a marker still uses the separate reset case.
  await content().focus();await page.keyboard.press('Control+Home');
  await page.keyboard.type('AB');await page.keyboard.insertText('中文😀');await idle();
  const emptyText='AB中文😀';const emptyExpected=[chars(emptyText,{fontSize:18,verticalAlign:'superscript',strike:'double',underline:true})];await assertDownload('empty-scripted-insertion.docx',emptyExpected);
  await selectText(0,emptyText);assert.equal(await page.getByTestId('word-font-size').inputValue(),'18','Toolbar must show logical size, not reduced paint size');await page.getByTestId('word-heading').selectOption('1');await idle();await assertDownload('scripted-heading.docx',emptyExpected);
  await range(0,emptyText.length);await page.keyboard.press('Enter');await page.keyboard.type('body');await idle();
  const headingEnd=[...emptyExpected,chars('body',{fontSize:18,verticalAlign:'superscript',strike:'double',underline:true})];await assertDownload('scripted-heading-end-enter.docx',headingEnd);
  ok('Legacy empty-run save/reopen promotes a real marker; insertion, heading and end Enter preserve its logical 18pt, superscript, double strike and underline');

  phase='ui-controls-history-and-mixed';await open(sourceFile);await selectText(4,'Edit target');await page.getByTestId('word-superscript').click();await idle();await selectText(4,'Edit target');await strike('double');await selectText(4,'Edit target');await page.getByTestId('word-underline').click();await idle();
  const formatted=structuredClone(expected);formatted[4]=chars('Edit target',{verticalAlign:'superscript',strike:'double',underline:true});await assertDownload('ui-formatted.docx',formatted);
  await undo();const withoutUnderline=structuredClone(formatted);withoutUnderline[4]=chars('Edit target',{verticalAlign:'superscript',strike:'double'});await assertDownload('ui-undo.docx',withoutUnderline);await redo();await assertDownload('ui-redo.docx',formatted);
  await selectText(4,'Edit target');await page.getByTestId('word-subscript').click();await idle();formatted[4]=chars('Edit target',{verticalAlign:'subscript',strike:'double',underline:true});await assertDownload('ui-script-exclusive.docx',formatted);
  await selectText(4,'Edit target');await page.getByTestId('word-subscript').click();await idle();formatted[4]=chars('Edit target',{strike:'double',underline:true});await assertDownload('ui-script-baseline.docx',formatted);
  await selectText(4,'Edit target');await page.getByTestId('word-strike').click();await idle();formatted[4]=chars('Edit target',{underline:true});await assertDownload('ui-strike-clear.docx',formatted);
  await range(0,0,fixture.expectedParagraphs[0].length);assert.equal(await page.getByTestId('word-superscript').getAttribute('aria-pressed'),'mixed');assert.equal(await page.getByTestId('word-strike').getAttribute('aria-pressed'),'mixed');
  await strike('double');formatted[0]=formatted[0].map(c=>({...c,strike:'double'}));await assertDownload('ui-mixed-strike.docx',formatted);await undo();formatted[0]=structuredClone(expected[0]);await assertDownload('ui-mixed-undo.docx',formatted);
  await selectText(4,'Edit target');await page.getByTestId('word-strike-menu-toggle').click();await page.keyboard.press('End');await page.keyboard.press('Enter');await idle();formatted[4]=chars('Edit target',{underline:true,strike:'double'});await assertDownload('ui-menu-keyboard.docx',formatted);
  await page.getByTestId('word-strike-menu-toggle').click();await page.keyboard.press('Escape');assert.equal(await content().evaluate(n=>n===document.activeElement||n.contains(document.activeElement)),true);
  ok('Toolbar super/sub are exclusive with explicit baseline reset; strike menu, keyboard, mixed selection, underline combination and undo/redo preserve selections and formats');

  phase='softbreak-enter-and-merge';await open(sourceFile);await range(3,4);await page.keyboard.press('Shift+Enter');await page.keyboard.type('X');await idle();
  const soft=replaceChars(expected,3,4,0,'\nX',{verticalAlign:'superscript',strike:'double',underline:true});await assertDownload('script-softbreak.docx',soft);
  await open(sourceFile);await range(3,4);await page.keyboard.press('Enter');await idle();const mid=structuredClone(expected);mid.splice(3,1,expected[3].slice(0,4),expected[3].slice(4));await assertDownload('script-mid-enter.docx',mid);await undo();await assertDownload('script-mid-enter-undo.docx',expected);
  await range(3,fixture.expectedParagraphs[3].length);await page.keyboard.press('Enter');await page.keyboard.type('baseline');await idle();const end=structuredClone(expected);end.splice(4,0,chars('baseline',{fontSize:9}));await assertDownload('script-end-enter.docx',end);
  await open(sourceFile);await range(1,fixture.expectedParagraphs[1].length);await page.keyboard.press('Enter');await page.keyboard.type('inherited');await idle();const inherited=structuredClone(expected);inherited.splice(2,0,chars('inherited',{fontSize:18,verticalAlign:'superscript',strike:'single'}));await assertDownload('script-inherited-end-enter.docx',inherited);
  await open(sourceFile);await range(2,0);await page.keyboard.press('Backspace');await idle();const merged=structuredClone(expected);merged.splice(1,2,[...expected[1],...expected[2]]);const merge=await assertDownload('script-merge.docx',merged);await undo();await assertDownload('script-merge-undo.docx',expected);await redo();await assertDownload('script-merge-redo.docx',merged);await open(merge.file);await assertDownload('script-merge-reopened.docx',merged);
  await open(sourceFile);await range(1,fixture.expectedParagraphs[1].length);await page.keyboard.press('Delete');await idle();await assertDownload('script-forward-merge.docx',merged);
  ok('Shift+Enter and middle Enter retain script; end Enter resets direct script but retains inherited script; Backspace/Delete merges preserve opposing styles through history/reopen');

  phase='named-character-script-end-enter';
  report.namedScriptEnter=[];
  for(const variant of [
    {name:'named-super',script:'superscript',direct:''},
    {name:'named-sub',script:'subscript',direct:''},
    {name:'named-super-direct-baseline',script:'superscript',directAlign:'baseline',direct:'<w:vertAlign w:val="baseline"/>'},
    {name:'named-super-direct-subscript',script:'superscript',directAlign:'subscript',direct:'<w:vertAlign w:val="subscript"/>'},
    {name:'named-baseline-under-paragraph-super',script:'baseline',paragraphScript:'superscript',direct:''},
  ]){
    const file=path.join(output,`synthetic-${variant.name}.docx`);
    const styles=`<w:style w:type="character" w:styleId="Script"><w:rPr><w:strike/><w:vertAlign w:val="${variant.script}"/></w:rPr></w:style>${variant.paragraphScript?'<w:style w:type="paragraph" w:styleId="Parent"><w:rPr><w:vertAlign w:val="'+variant.paragraphScript+'"/></w:rPr></w:style>':''}`;
    fs.writeFileSync(file,Buffer.from(synthetic(`<w:p>${variant.paragraphScript?'<w:pPr><w:pStyle w:val="Parent"/></w:pPr>':''}<w:r><w:rPr><w:rStyle w:val="Script"/>${variant.direct}</w:rPr><w:t>AB</w:t></w:r></w:p>`,styles)));
    const originalStyle={strike:'single',verticalAlign:variant.directAlign||variant.script};
    const originalExpected=[chars('AB',originalStyle)];
    const stages=[file];
    for(let generation=1;generation<=2;generation++){await open(stages.at(-1));stages.push((await assertDownload(`${variant.name}-save-${generation}.docx`,originalExpected)).file);}
    for(let generation=0;generation<stages.length;generation++){
      await open(stages[generation]);await range(0,2);await page.keyboard.press('Enter');await page.keyboard.type('Z');await idle();
      const expect=[...originalExpected,chars('Z',{strike:'single',verticalAlign:variant.script})];
      const result=await assertDownload(`${variant.name}-generation-${generation}-enter.docx`,expect);
      report.namedScriptEnter.push({variant:variant.name,generation,file:result.file});
    }
    await open(stages[2]);await range(0,1);await page.keyboard.press('Shift+Enter');await idle();
    const softNamed=[chars('A\nB',originalStyle)];await assertDownload(`${variant.name}-softbreak.docx`,softNamed);
    await open(stages[2]);await range(0,0,2);await page.getByTestId('word-heading').selectOption('1');await idle();
    const headingNamed=[chars('AB',{...originalStyle,fontSize:24})];await assertDownload(`${variant.name}-heading.docx`,headingNamed);
    await range(0,2);await page.keyboard.press('Enter');await page.keyboard.type('Z');await idle();
    await assertDownload(`${variant.name}-heading-enter.docx`,[...headingNamed,chars('Z',{strike:'single',verticalAlign:variant.script})]);
  }
  ok('Named character-style super/sub survive soft breaks, headings and end Enter before/after two saves; a direct baseline override clears back to named superscript');

  phase='synthetic-negative-and-neutral-properties';
  const invalid=[['positive-position-missing-font-size','<w:position w:val="2"/>'],['negative-position-missing-font-size','<w:position w:val="-2"/>'],['nonstandard-scale','<w:w w:val="75"/>'],['bad-script','<w:vertAlign w:val="super"/>'],['missing-script','<w:vertAlign/>'],['duplicate-script','<w:vertAlign w:val="superscript"/><w:vertAlign w:val="subscript"/>'],['duplicate-strike','<w:strike/><w:strike w:val="false"/>'],['invalid-strike-boolean','<w:strike w:val="yes"/>'],['invalid-double-boolean','<w:dstrike w:val="2"/>'],['unknown-script-attribute','<w:vertAlign w:val="baseline" w:foo="1"/>'],['duplicate-xml-attribute','<w:vertAlign w:val="baseline" w:val="superscript"/>']];
  report.negative=[];
  for(const [name,props]of invalid){const bytes=synthetic(`<w:p><w:r><w:rPr>${props}</w:rPr><w:t>Unsupported</w:t></w:r></w:p>`);const message=await page.evaluate(async bytes=>{try{(await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes));return null;}catch(e){return e.message;}},bytes);assert.ok(message,`${name} silently accepted`);if(name.endsWith('position-missing-font-size'))assert.match(message,/明确指定字号/);report.negative.push({name,message});}
  ok('11 separate synthetic unsupported/malformed script, scale, strike and duplicate-property encodings reject explicitly');

  phase='atomic-ui-rejection';await range(0,0);await page.keyboard.type('unsaved ');await idle();
  const before=await content().innerHTML(),tabs=await page.locator('.document-tab').count();const badFile=path.join(output,'synthetic-position-missing-font-size.docx');fs.writeFileSync(badFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:position w:val="6"/></w:rPr><w:t>Unsupported</w:t></w:r></w:p>')));
  const chooser=page.waitForEvent('filechooser');await page.locator('.command-bar').getByRole('button',{name:'打开',exact:true}).click();await(await chooser).setFiles(badFile);await page.locator('.error-banner').waitFor();assert.match(await page.locator('.error-banner').innerText(),/明确指定字号/);await page.locator('.busy-overlay').waitFor({state:'hidden'});
  assert.equal(await content().innerHTML(),before);assert.equal(await page.locator('.document-tab').count(),tabs);assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(),1);await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();await idle();
  ok('Custom positioning without an explicit font size is rejected before tab creation, retaining the active unsaved document byte-for-byte in DOM');
  await page.screenshot({path:path.join(output,'character-format-editor.png'),fullPage:true});await page.setViewportSize({width:800,height:1000});await page.getByTestId('word-strike-menu-toggle').click();await page.screenshot({path:path.join(output,'character-format-narrow-menu.png'),fullPage:true});
  const bounds=await page.getByTestId('word-strike-double').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=800,'Strike menu must remain within narrow viewport');await page.keyboard.press('Escape');
  report.productAfter=sourceHashes();assert.deepEqual(report.productAfter,report.productBefore,'Product sources changed during validation; rerun after freeze');assert.equal(sha256(sourceFile),fixture.docxSha256);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.runtimeRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.failure={phase,message:error.message,stack:error.stack};if(page){try{report.failure.body=(await page.locator('body').innerText()).slice(-6000);await page.screenshot({path:path.join(output,'failure.png')});}catch{}}console.error(error);process.exitCode=1;
}finally{persist();if(browser)await browser.close();if(server)await server.close();}})();
