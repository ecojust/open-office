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
const corpus = path.join(root, 'tests/compatibility/independent-word-background');
const output = path.resolve(process.env.WORD_BACKGROUND_OUTPUT || path.join(root, 'test-results/independent-word-background'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const fixture = manifest.fixtures.find(f => f.name === 'inheritance');
const inlineFixture = manifest.fixtures.find(f=>f.name==='inline-background');
const inlineFile=path.join(corpus,inlineFixture.docx);
const markerFixture=manifest.fixtures.find(f=>f.name==='background');
const combinedFixture = manifest.fixtures.find(f => f.name === 'combined-layers');
const combinedFile = path.join(corpus,combinedFixture.docx);
const syntheticSource = path.join(corpus, fixture.source);
const sourceFile = path.join(corpus, fixture.docx);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['src/word/core/background.ts', 'src/word/core/highlight.ts', 'src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/editor.css', 'src/components/StandaloneWordEditor.vue'];
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, sha256(path.join(root, p))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = document => document.paragraphs.map(p => p.characters);
const texts = document => document.paragraphs.map(p => p.text);
const fullCharacters = paragraph => paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, ...Object.fromEntries(['backgroundColor', 'highlight', 'fontSize', 'fontSizeCs', 'verticalAlign', 'strike', 'underline', 'color', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, run.style[key] ?? null])), bold: !!run.style.bold, italic: !!run.style.italic })));
const markerFormats = document => document.paragraphs.map(p => {
  const style = { ...p.sourceStyle, ...p.paragraphMarkStyle };
  return { ...Object.fromEntries(['backgroundColor', 'highlight', 'fontSize', 'fontSizeCs', 'verticalAlign', 'strike', 'underline', 'color', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, style[key] ?? null])), bold: !!style.bold, italic: !!style.italic };
});
function assertMarkerPreserved(actual, original) {
  assert.deepEqual(markerFormats(actual), markerFormats(original), 'Effective paragraph marker formatting changed independently of text');
  original.paragraphs.forEach((p, i) => {
    for (const [key, value] of Object.entries(p.paragraphMarkStyle)) assert.equal(actual.paragraphs[i].paragraphMarkStyle[key], value, `Explicit marker ${i}.${key} was lost`);
  });
}
const report = { scope:'Original ODT and explicitly synthetic combined-layer DOCX -> untouched native LibreOffice DOCX -> real UI/download/native resave/reopen', limitations:['One native LibreOffice build, no Microsoft Word runtime.','Native outputs remain complete and unmodified.','Continuous CSS, not native pagination or pixel fidelity.','Enter expected behavior is source-based; keyboard runs in Chromium.','insertText is not an OS IME test.'], productBefore:sourceHashes(), corpus:manifest.fixtures.map(f=>({name:f.name,sourceKind:f.sourceKind,sourceSha256:sha256(path.join(corpus,f.source)),docxSha256:sha256(path.join(corpus,f.docx))})), checks:[],pageErrors:[],consoleErrors:[],externalRequests:[],runtimeRequests:[] };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-background-native-'));
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
async function paint(p) { return content().evaluate((n,p)=>{const e=n.children[p].firstElementChild;return {highlight:e.dataset.wordHighlight||'none',background:e.dataset.wordBackgroundColor||'none',paint:getComputedStyle(e).backgroundColor};},p); }
const css=color=>color==='none'?'rgba(0, 0, 0, 0)':`rgb(${[1,3,5].map(n=>parseInt(color.slice(n,n+2),16)).join(', ')})`;
function hashes() { for(const f of manifest.fixtures){assert.equal(sha256(path.join(corpus,f.docx)),f.docxSha256);assert.equal(sha256(path.join(corpus,f.source)),f.sourceSha256);} }
(async()=>{try{
  hashes();const original=inspect(sourceFile),expected=fixture.expectedSemantics.characters,combined=inspect(combinedFile),bothExpected=combinedFixture.expectedSemantics.characters;
  assert.deepEqual(texts(original),fixture.expectedParagraphs);assert.deepEqual(semantics(original),expected);assert.deepEqual(semantics(combined),bothExpected);assert.deepEqual(semantics(inspect(path.join(corpus,combinedFixture.source))),bothExpected);report.original=original;report.combined=combined;
  const {createServer}=await import('vite');server=await createServer({root,cacheDir:'node_modules/.vite-word-background-test',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:{ignored:['**/src-tauri/target/**','**/test-results/**']}}});await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/`,origin=new URL(url).origin;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});page=await browser.newPage({viewport:{width:1360,height:1000},acceptDownloads:true});page.setDefaultTimeout(30000);await page.routeWebSocket('**',()=>{});
  page.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)report.externalRequests.push(u.href);if(/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(u.href))report.runtimeRequests.push(u.href);});page.on('pageerror',e=>report.pageErrors.push({phase,message:e.message}));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({phase,message:m.text()});});await page.goto(url);await page.getByTestId('independent-word-open').waitFor();

  phase='native-controlled-inheritance';await open(sourceFile,true);report.nativePaint=[];for(const [p,color]of [[0,'none'],[1,'#123456'],[3,'#ABCDEF'],[5,'#13579B']]){const current=await paint(p);assert.equal(current.background,color);assert.equal(current.paint,css(color));report.nativePaint.push({p,...current});}
  const first=await assertDownload('native-background-save.docx',expected);assert.deepEqual(first.document.paragraphs.map(fullCharacters),original.paragraphs.map(fullCharacters));await open(first.file);await assertDownload('native-background-second-save.docx',expected);
  ok('Explicitly synthetic inheritance input resaved by native LibreOffice preserves paragraph/named/basedOn/direct RGB and transparent resets through two UI downloads');
  phase='native-inline-odt';await open(inlineFile);const inlineExpected=inlineFixture.expectedSemantics.characters;assert.deepEqual(semantics(inspect(inlineFile)),inlineExpected);const inlineSave=await assertDownload('inline-odt-save.docx',inlineExpected);await open(inlineSave.file);await assertDownload('inline-odt-second-save.docx',inlineExpected);report.nativeInline=await nativeRoundtrip(inlineSave.file,'inline');assert.deepEqual(semantics(report.nativeInline.document),inlineExpected);await open(report.nativeInline.file);await assertDownload('inline-odt-native-reopened.docx',inlineExpected);ok('Separately authored original inline ODT produces complete native DOCX with RGB/transparent/named/scripted selections and survives two UI saves/native resave/reopen');

  phase='native-independent-paragraph-markers';
  const markerFile=path.join(corpus,markerFixture.docx),markerOriginal=inspect(markerFile);
  assert.deepEqual(texts(markerOriginal),markerFixture.expectedParagraphs);
  assert.deepEqual(semantics(markerOriginal),markerFixture.expectedSemantics.characters);
  assert.deepEqual(markerOriginal.paragraphs.map(p=>p.paragraphMarkStyle),markerFixture.expectedParagraphMarkers);
  await open(markerFile);const markerSave=await save('native-paragraph-marker-save.docx'),markerSaved=inspect(markerSave);
  assert.deepEqual(markerSaved.paragraphs.map(fullCharacters),markerOriginal.paragraphs.map(fullCharacters));assertMarkerPreserved(markerSaved,markerOriginal);
  await open(markerSave);await range(5,0,5);await background('none');
  const markerBodyExpected=markerOriginal.paragraphs.map(fullCharacters);markerBodyExpected[5]=markerBodyExpected[5].map((c,i)=>i<5?({...c,backgroundColor:'none'}):c);
  const markerEdited=await save('native-paragraph-marker-body-cleared.docx'),markerEditedDocument=inspect(markerEdited);
  assert.deepEqual(markerEditedDocument.paragraphs.map(fullCharacters),markerBodyExpected);assertMarkerPreserved(markerEditedDocument,markerOriginal);
  // Native Writer adds a default kern=0 on a second save even without edits.
  // Compare against an untouched native control, retaining the stricter own-save checks above.
  report.nativeMarkerControl=await nativeRoundtrip(markerFile,'paragraph-markers-control');
  assert.deepEqual(report.nativeMarkerControl.document.paragraphs.map(p=>p.paragraphMarkStyle),markerFixture.expectedParagraphMarkers);
  const nativeMarkerBodyExpected=report.nativeMarkerControl.document.paragraphs.map(fullCharacters);nativeMarkerBodyExpected[5]=nativeMarkerBodyExpected[5].map((c,i)=>i<5?({...c,backgroundColor:'none'}):c);
  report.nativeMarker=await nativeRoundtrip(markerEdited,'paragraph-markers');
  assert.deepEqual(report.nativeMarker.document.paragraphs.map(fullCharacters),nativeMarkerBodyExpected);assertMarkerPreserved(report.nativeMarker.document,report.nativeMarkerControl.document);
  await open(report.nativeMarker.file);const markerReopened=inspect(await save('native-paragraph-marker-reopened.docx'));
  assert.deepEqual(markerReopened.paragraphs.map(fullCharacters),nativeMarkerBodyExpected);assertMarkerPreserved(markerReopened,report.nativeMarkerControl.document);
  ok('Complete original ODT export preserves separate paragraph marker RGB/script/strike/size/underline through partial-body background clearing, native resave and UI reopen');

  phase='combined-layer-precedence';await open(combinedFile);assert.deepEqual(await paint(0),{highlight:'yellow',background:'#123456',paint:css('#FFFF00')});const both=await assertDownload('combined-layers-save.docx',bothExpected);await open(both.file);await assertDownload('combined-layers-second-save.docx',bothExpected);
  await range(0,0,combinedFixture.expectedParagraphs[0].length);await highlight('none');const noHighlight=structuredClone(bothExpected);noHighlight[0]=noHighlight[0].map(c=>({...c,highlight:'none'}));assert.equal((await paint(0)).paint,css('#123456'));await assertDownload('reveal-background.docx',noHighlight);await undo();await assertDownload('reveal-undo.docx',bothExpected);await redo();await assertDownload('reveal-redo.docx',noHighlight);
  await open(combinedFile);await range(0,0,combinedFixture.expectedParagraphs[0].length);await background('none');const noBackground=structuredClone(bothExpected);noBackground[0]=noBackground[0].map(c=>({...c,backgroundColor:'none'}));assert.equal((await paint(0)).paint,css('#FFFF00'));await assertDownload('clear-background-keeps-highlight.docx',noBackground);await highlight('none');noBackground[0]=noBackground[0].map(c=>({...c,highlight:'none'}));assert.equal((await paint(0)).paint,css('none'));await assertDownload('clear-both-layers.docx',noBackground);
  ok('Native combined layers persist independently: highlight wins paint, clearing highlight reveals RGB, clearing RGB retains highlight, undo/redo and two saves retain both');

  phase='background-controls';await open(sourceFile);await selectText(6,'Edit target');const beforeDraft=await content().innerHTML();await page.getByTestId('word-background-menu-toggle').click();await page.getByTestId('word-background-color').fill('#102938');assert.equal(await content().innerHTML(),beforeDraft);await page.getByTestId('word-background-cancel').click();assert.equal(await content().innerHTML(),beforeDraft);await background('#102938');assert.equal(await page.getByTestId('word-background-menu-toggle').getAttribute('data-background'),'#102938');const changed=structuredClone(expected);changed[6]=chars('Edit target',{backgroundColor:'#102938'});await assertDownload('background-menu-applied.docx',changed);await undo();await assertDownload('background-menu-undo.docx',expected);await redo();await assertDownload('background-menu-redo.docx',changed);
  await range(2,0,fixture.expectedParagraphs[2].length);assert.equal(await page.getByTestId('word-background-menu-toggle').getAttribute('data-background'),'mixed');await background('none');changed[2]=changed[2].map(c=>({...c,backgroundColor:'none'}));await assertDownload('clear-inherited-background.docx',changed);await undo();changed[2]=structuredClone(expected[2]);await assertDownload('clear-inherited-undo.docx',changed);
  await selectText(6,'Edit target');await page.getByTestId('word-background-menu-toggle').click();await page.keyboard.press('Escape');assert.equal(await page.getByTestId('word-background-menu').count(),0);await page.getByTestId('word-background-menu-toggle').click();await page.getByTestId('word-highlight-menu-toggle').click();assert.equal(await page.getByTestId('word-background-menu').count(),0);await page.keyboard.press('Escape');
  ok('RGB draft/cancel leaves document unchanged; Apply/reset are single history transactions, inherited mixed selection clears explicitly and color menus remain exclusive');

  phase='real-ui-native-roundtrip';await open(sourceFile);await selectText(6,'Edit target');await background('#02468A');await range(6,'Edit target'.length);await page.keyboard.type(' ASCII');await page.keyboard.insertText(' 中文😀');await idle();const editedExpected=structuredClone(expected);editedExpected[6]=chars('Edit target ASCII 中文😀',{backgroundColor:'#02468A'});const edited=await assertDownload('background-edited.docx',editedExpected);report.nativeControl=await nativeRoundtrip(sourceFile,'control');report.nativeEdited=await nativeRoundtrip(edited.file,'edited');assert.deepEqual(semantics(report.nativeControl.document),expected);assert.deepEqual(semantics(report.nativeEdited.document),editedExpected);assert.deepEqual(report.nativeEdited.document.paragraphs.slice(0,6).map(fullCharacters),report.nativeControl.document.paragraphs.slice(0,6).map(fullCharacters));await open(report.nativeEdited.file);await assertDownload('native-edited-reopened.docx',editedExpected);
  await open(combinedFile);const combinedSave=await save('combined-native-input.docx');report.nativeCombined=await nativeRoundtrip(combinedSave,'combined');assert.deepEqual(semantics(report.nativeCombined.document),bothExpected);await open(report.nativeCombined.file);await assertDownload('combined-native-reopened.docx',bothExpected);
  ok('Actual menu/ASCII/CJK/emoji edits and both layers survive UI download -> complete native LibreOffice resave -> UI reopen/download');

  phase='nested-and-structural';await open(combinedFile);const combo={backgroundColor:'#13579B',highlight:'magenta',fontSize:18,verticalAlign:'superscript',strike:'double',underline:true},offset=combinedFixture.expectedParagraphs[4].indexOf('中')+1;await range(4,offset);await page.keyboard.type('abc');await page.keyboard.insertText('汉😀');await idle();const typed=replaceChars(bothExpected,4,Array.from(combinedFixture.expectedParagraphs[4].slice(0,offset)).length,0,'abc汉😀',combo);const nested=await assertDownload('combined-nested-typing.docx',typed);await open(nested.file);await assertDownload('combined-nested-second-save.docx',typed);
  await open(combinedFile);await range(4,3);await page.keyboard.press('Shift+Enter');await page.keyboard.type('X');await idle();await assertDownload('combined-softbreak.docx',replaceChars(bothExpected,4,3,0,'\nX',combo));
  await open(combinedFile);await range(4,3);await page.keyboard.press('Enter');await idle();const mid=structuredClone(bothExpected);mid.splice(4,1,bothExpected[4].slice(0,3),bothExpected[4].slice(3));await assertDownload('combined-middle-enter.docx',mid);await undo();await assertDownload('combined-middle-undo.docx',bothExpected);await range(4,combinedFixture.expectedParagraphs[4].length);await page.keyboard.press('Enter');await page.keyboard.type('next');await idle();const end=structuredClone(bothExpected);end.push(chars('next',{...combo,verticalAlign:'baseline'}));await assertDownload('combined-end-enter.docx',end);
  await open(sourceFile);await range(3,0);await page.keyboard.press('Backspace');await idle();const merged=structuredClone(expected);merged.splice(2,2,[...expected[2],...expected[3]]);const merge=await assertDownload('background-backspace-merge.docx',merged);await undo();await assertDownload('background-merge-undo.docx',expected);await redo();await assertDownload('background-merge-redo.docx',merged);await open(merge.file);await assertDownload('background-merge-reopen.docx',merged);await open(sourceFile);await range(2,fixture.expectedParagraphs[2].length);await page.keyboard.press('Delete');await idle();await assertDownload('background-forward-merge.docx',merged);
  ok('Nested script/strike/CJK input, soft/middle/end breaks and both-direction paragraph merges preserve RGB, highlight and logical18pt without drift');

  phase='whole-selection-replacement';report.replacements=[];
  for(const method of ['type','insertText','backspace-then-type','delete-then-insertText']){await open(combinedFile);await range(4,0,combinedFixture.expectedParagraphs[4].length);if(method==='type')await page.keyboard.type('AB');else if(method==='insertText')await page.keyboard.insertText('替换😀');else{await page.keyboard.press(method.startsWith('backspace')?'Backspace':'Delete');await idle();const emptySave=await save(`empty-after-${method}.docx`);await open(emptySave);await range(4,0);if(method.startsWith('backspace'))await page.keyboard.type('AB');else await page.keyboard.insertText('替换😀');}await idle();const replacement=method==='type'||method.startsWith('backspace')?'AB':'替换😀',replaced=structuredClone(bothExpected);replaced[4]=chars(replacement,combo);const file=await assertDownload(`selection-${method}.docx`,replaced);await open(file.file);await assertDownload(`selection-${method}-second-save.docx`,replaced);report.replacements.push({method,text:replacement,keptBothLayers:true});}
  await open(combinedFile);await range(4,0,combinedFixture.expectedParagraphs[4].length);await page.keyboard.insertText('替换😀');await idle();await undo();await assertDownload('replacement-undo.docx',bothExpected);await redo();const redone=structuredClone(bothExpected);redone[4]=chars('替换😀',combo);await assertDownload('replacement-redo.docx',redone);
  ok('Whole styled paragraph typing/replacement/deletion retains hidden RGB, highlight, script/strike/underline, empty insertion metadata, one-step history and two saves');

  phase='native-and-fallback-final-grapheme-deletion';report.graphemeDeletion=[];
  const checkInsertion=async label=>{assert.equal(await page.getByTestId('word-background-menu-toggle').getAttribute('data-background'),'#13579B',label);assert.equal(await page.getByTestId('word-highlight-menu-toggle').getAttribute('data-highlight'),'magenta',label);for(const id of ['word-superscript','word-strike','word-underline'])assert.equal(await page.getByTestId(id).getAttribute('aria-pressed'),'true',label);};
  for(const fallback of [false,true]){await page.evaluate(f=>{window.backgroundOriginalTargetRanges ||= InputEvent.prototype.getTargetRanges;InputEvent.prototype.getTargetRanges=f?function(){return []}:window.backgroundOriginalTargetRanges;},fallback);for(const text of ['A','😀','👩‍💻','e\u0301']){await open(combinedFile);await range(4,0,combinedFixture.expectedParagraphs[4].length);await page.keyboard.insertText(text);await page.keyboard.press('End');await page.keyboard.press('Backspace');await idle();let remaining=await content().evaluate(n=>n.children[4].textContent);if(remaining){assert.equal(fallback,false);assert.equal(text,'e\u0301');assert.equal(remaining,'e');await checkInsertion('partial native combining deletion');await page.keyboard.press('Backspace');await idle();}assert.equal(await content().evaluate(n=>n.children[4].textContent),'');await checkInsertion('final backward deletion');await page.keyboard.insertText(text);await page.keyboard.press('Home');await page.keyboard.press('Delete');await idle();assert.equal(await content().evaluate(n=>n.children[4].textContent),'');await checkInsertion('final forward deletion');const empty=await save(`grapheme-empty-${fallback}-${report.graphemeDeletion.length}.docx`);await open(empty);await range(4,0);await page.keyboard.insertText('保留😀');await idle();const expectedInsertion=structuredClone(bothExpected);expectedInsertion[4]=chars('保留😀',combo);const downloaded=await assertDownload(`grapheme-insertion-${fallback}-${report.graphemeDeletion.length}.docx`,expectedInsertion);await open(downloaded.file);await assertDownload(`grapheme-second-${fallback}-${report.graphemeDeletion.length}.docx`,expectedInsertion);report.graphemeDeletion.push({text,fallback,backward:true,forward:true,emptySaveReopen:true});}}
  await page.evaluate(()=>InputEvent.prototype.getTargetRanges=window.backgroundOriginalTargetRanges);
  ok('ASCII/emoji/ZWJ/combining final-grapheme deletion in both directions preserves both layers and all formats with native target ranges and explicit empty-range fallback, including empty save/reopen');

  phase='imported-empty-two-layer-run';const emptyFile=path.join(output,'synthetic-empty-combined.docx');fs.writeFileSync(emptyFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:dstrike/><w:sz w:val="36"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:shd w:val="clear" w:fill="13579B"/><w:vertAlign w:val="superscript"/></w:rPr><w:t/></w:r></w:p>')));await open(emptyFile);const emptySaved=await save('empty-combined-beforetyping.docx');await open(emptySaved);await content().focus();await page.keyboard.press('Control+Home');await page.keyboard.type('AB');await page.keyboard.insertText('中文😀');await idle();await assertDownload('empty-combined-typed.docx',[chars('AB中文😀',{...combo,highlight:'yellow'})]);
  ok('Imported empty two-layer scripted run survives save/reopen and actual typing with arbitrary RGB, highlight and logical18pt');

  phase='dom-layer-metadata';report.dom=await page.evaluate(async({plainBytes,bothBytes})=>{const {importWordDocument}=await import('/src/word/core/docx.ts');const {renderWordDom,readWordDom}=await import('/src/word/core/dom.ts');const source=importWordDocument(Uint8Array.from(plainBytes)),combined=importWordDocument(Uint8Array.from(bothBytes)),host=document.createElement('div');document.body.append(host);const results=[];
    const flat=(d,p)=>d.paragraphs[p].runs.flatMap(r=>Array.from(r.text,c=>({c,backgroundColor:r.style.backgroundColor||'none',highlight:r.style.highlight||'none',fontSize:r.style.fontSize,verticalAlign:r.style.verticalAlign,strike:r.style.strike,underline:r.style.underline})));
    try{for(const kind of ['script','strike','glyph','ordinary']){renderWordDom(host,source);const p=host.children[5];let target=kind==='ordinary'?null:kind==='glyph'?p.querySelector('[data-word-glyph-font]'):p.querySelector(`[data-word-visual="${kind}"]`);if(!target){const parent=p.querySelector('[data-word-visual="strike"]')||p.firstElementChild;target=document.createElement('span');while(parent.firstChild)target.append(parent.firstChild);parent.append(target);}target.style.backgroundColor=kind==='ordinary'?'rgb(255, 255, 0)':'rgb(2, 70, 138)';let d=readWordDom(host,source),initial=flat(d,5);const expectedColor=kind==='ordinary'?'#FFFF00':'#02468A';if(!initial.some(c=>c.backgroundColor===expectedColor)||initial.some(c=>c.highlight!=='none'||c.fontSize!==18||c.verticalAlign!=='superscript'||c.strike!=='double'||!c.underline))throw Error('CSS-only background lost other semantics '+kind);for(let n=0;n<8;n++){renderWordDom(host,d);d=readWordDom(host,d);}if(JSON.stringify(flat(d,5))!==JSON.stringify(initial))throw Error('CSS background unstable '+kind);results.push({kind,cycles:8,backgroundColor:expectedColor,highlight:'none'});}
      for(const kind of ['script','strike']){renderWordDom(host,combined);let target=host.children[4].querySelector(`[data-word-visual="${kind}"]`);target.style.backgroundColor='rgb(255, 0, 255)';if(flat(readWordDom(host,combined),4).some(c=>c.backgroundColor!=='#13579B'||c.highlight!=='magenta'))throw Error('Copied paint dropped hidden background '+kind);target.style.backgroundColor='rgb(255,255,0)';let rejected=false;try{readWordDom(host,combined);}catch{rejected=true;}if(!rejected)throw Error('Conflicting unowned CSS silently guessed '+kind);results.push({kind:'copied-'+kind,bothPreserved:true,conflictRejected:true});}
      const empty=structuredClone(source);empty.paragraphs=[structuredClone(source.paragraphs[5])];const run=structuredClone(empty.paragraphs[0].runs[0]);run.text='';run.sourceVerticalAlign='superscript';if(run.directStyle)delete run.directStyle.verticalAlign;empty.paragraphs[0].runs=[run];for(const kind of ['script','strike']){renderWordDom(host,empty);const target=host.children[0].querySelector(`[data-word-visual="${kind}"]`);target.style.backgroundColor='rgb(2, 70, 138)';let d=readWordDom(host,empty);for(let n=0;n<8;n++){renderWordDom(host,d);d=readWordDom(host,d);}const r=d.paragraphs[0].runs[0];if(r.text!==''||r.style.backgroundColor!=='#02468A'||r.style.fontSize!==18||r.sourceVerticalAlign!=='superscript'||r.style.strike!=='double')throw Error('Empty CSS insertion attrs lost '+kind);results.push({kind:'empty-'+kind,cycles:8,preserved:true});}
      const trailing=structuredClone(combined);trailing.paragraphs=[trailing.paragraphs[4]];trailing.paragraphs[0].runs=[trailing.paragraphs[0].runs[0]];trailing.paragraphs[0].runs[0].text='A\n';renderWordDom(host,trailing);const d=readWordDom(host,trailing);if(d.paragraphs[0].runs.map(r=>r.text).join('')!=='A\n'||d.paragraphs[0].runs.some(r=>r.style.backgroundColor!=='#13579B'||r.style.highlight!=='magenta'))throw Error('Trailing placeholder changed text/layers');return {cases:results,trailingSoftBreakPreserved:true};
    }finally{host.remove();}},{plainBytes:Array.from(fs.readFileSync(sourceFile)),bothBytes:Array.from(fs.readFileSync(combinedFile))});
  ok('CSS-only arbitrary/palette RGB is background, copied paint preserves hidden layer, conflicting CSS rejects, empty/nested wrappers and trailing breaks remain stable');

  phase='unsupported-shading';report.negative=[];const invalid=[['pattern','<w:shd w:val="pct15" w:fill="123456"/>'],['nil','<w:shd w:val="nil" w:fill="123456"/>'],['missing-fill','<w:shd w:val="clear"/>'],['missing-value','<w:shd w:fill="123456"/>'],['short-hex','<w:shd w:val="clear" w:fill="FFF"/>'],['invalid-hex','<w:shd w:val="clear" w:fill="GGGGGG"/>'],['theme','<w:shd w:val="clear" w:fill="123456" w:themeFill="accent1"/>'],['tint','<w:shd w:val="clear" w:fill="123456" w:themeFillTint="80"/>'],['foreground-theme','<w:shd w:val="clear" w:fill="123456" w:themeColor="accent1"/>'],['invalid-foreground','<w:shd w:val="clear" w:fill="123456" w:color="red"/>'],['duplicate-attribute','<w:shd w:val="clear" w:fill="123456" w:fill="ABCDEF"/>'],['duplicate-property','<w:shd w:val="clear" w:fill="123456"/><w:shd w:val="clear" w:fill="ABCDEF"/>'],['unknown-attribute','<w:shd w:val="clear" w:fill="123456" w:foo="1"/>'],['nested','<w:shd w:val="clear" w:fill="123456"><w:b/></w:shd>']];
  for(const[name,props]of invalid){const bytes=synthetic(`<w:p><w:r><w:rPr>${props}</w:rPr><w:t>Unsupported</w:t></w:r></w:p>`);const error=await page.evaluate(async b=>{try{(await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(b));return null;}catch(e){return e.message;}},bytes);assert.ok(error,name+' silently accepted');report.negative.push({name,error});}
  for(const[name,bytes]of [['paragraph-shading',synthetic('<w:p><w:pPr><w:shd w:val="clear" w:fill="123456"/></w:pPr><w:r><w:t>P</w:t></w:r></w:p>')],['document-default-shading',synthetic('<w:p><w:r><w:t>P</w:t></w:r></w:p>','<w:docDefaults><w:rPrDefault><w:rPr><w:shd w:val="clear" w:fill="123456"/></w:rPr></w:rPrDefault></w:docDefaults>')]]){const error=await page.evaluate(async b=>{try{(await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(b));return null;}catch(e){return e.message;}},bytes);assert.ok(error);report.negative.push({name,error});}
  await open(combinedFile);await range(0,0);await page.keyboard.type('unsaved ');await idle();const negativeFile=path.join(output,'synthetic-theme-background.docx');fs.writeFileSync(negativeFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:shd w:val="clear" w:fill="123456" w:themeFill="accent1"/></w:rPr><w:t>Unsupported theme</w:t></w:r></w:p>')));report.atomicErrors=[];
  const markerThemeFile=path.join(output,'synthetic-theme-paragraph-marker.docx');fs.writeFileSync(markerThemeFile,Buffer.from(synthetic('<w:p><w:pPr><w:rPr><w:shd w:val="clear" w:fill="123456" w:themeFill="accent1"/></w:rPr></w:pPr><w:r><w:t>Unsupported marker theme</w:t></w:r></w:p>')));
  for(const file of [markerThemeFile,negativeFile]){const before=await content().innerHTML(),tabs=await page.locator('.document-tab').count();const chooser=page.waitForEvent('filechooser');await page.locator('.command-bar').getByRole('button',{name:'打开',exact:true}).click();await(await chooser).setFiles(file);await page.locator('.error-banner').waitFor();await page.locator('.busy-overlay').waitFor({state:'hidden'});assert.equal(await content().innerHTML(),before);assert.equal(await page.locator('.document-tab').count(),tabs);assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(),1);report.atomicErrors.push({name:path.basename(file),error:await page.locator('.error-banner').textContent()});await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();await idle();}
  ok('16 unsupported/malformed shading encodings reject explicitly; synthetic marker and text theme imports preserve unsaved content/tab/history atomically');

  phase='responsive-and-hash-freeze';await open(combinedFile);await range(4,0,combinedFixture.expectedParagraphs[4].length);await page.getByTestId('word-background-menu-toggle').click();await page.screenshot({path:path.join(output,'background-dialog.png'),fullPage:true});await page.keyboard.press('Escape');await page.setViewportSize({width:800,height:1000});await page.getByTestId('word-background-menu-toggle').click();await page.screenshot({path:path.join(output,'background-narrow-dialog.png'),fullPage:true});const bounds=await page.getByTestId('word-background-menu').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=800);await page.keyboard.press('Escape');hashes();report.productAfter=sourceHashes();assert.deepEqual(report.productAfter,report.productBefore,'Product changed during regression; rerun after freeze');assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.runtimeRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.failure={phase,message:error.message,stack:error.stack};if(page){try{report.failure.body=(await page.locator('body').innerText()).slice(-6000);await page.screenshot({path:path.join(output,'failure.png')});}catch{}}console.error(error);process.exitCode=1;
}finally{persist();if(browser)await browser.close();if(server)await server.close();}})();
