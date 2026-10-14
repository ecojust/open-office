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
const corpus = path.join(root, 'tests/compatibility/independent-word-highlight');
const output = path.resolve(process.env.WORD_HIGHLIGHT_OUTPUT || path.join(root, 'test-results/independent-word-highlight'));
const soffice = process.env.SOFFICE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice';
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const fixture = manifest.fixtures.find(f => f.name === 'highlight');
const backgroundFixture = manifest.fixtures.find(f => f.name === 'unsupported-background');
const syntheticSource = path.join(corpus, fixture.source);
const PALETTE = manifest.palette;
const sourceFile = path.join(corpus, fixture.docx);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = ['src/word/core/background.ts', 'src/word/core/highlight.ts', 'src/word/core/model.ts', 'src/word/core/dom.ts', 'src/word/core/docx.ts', 'src/word/core/editor.css', 'src/components/StandaloneWordEditor.vue'];
const sourceHashes = () => Object.fromEntries(sources.map(p => [p, sha256(path.join(root, p))]));
const inspect = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(corpus, 'inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
// The background oracle resolves w:shd and w:pPr/w:rPr independently of body runs.
const inspectBackground = file => JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'tests/compatibility/independent-word-background/inspect.py'), file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const semantics = document => document.paragraphs.map(p => p.characters);
const texts = document => document.paragraphs.map(p => p.text);
const fullCharacters = paragraph => paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, ...Object.fromEntries(['highlight', 'fontSize', 'fontSizeCs', 'verticalAlign', 'strike', 'underline', 'color', 'kern', 'rFonts:ascii', 'rFonts:hAnsi', 'rFonts:eastAsia', 'rFonts:cs', 'lang:val', 'lang:eastAsia', 'lang:bidi'].map(key => [key, run.style[key] ?? null])), bold: !!run.style.bold, italic: !!run.style.italic })));
const fullBackgroundCharacters = paragraph => paragraph.runs.flatMap(run => fullCharacters({runs:[run]}).map(c=>({...c,backgroundColor:run.style.backgroundColor})));
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
const report = { scope: 'Independent highlight compatibility: synthetic authored OOXML -> untouched native LibreOffice DOCX -> real UI/save/native resave/reopen', limitations: ['One installed native LibreOffice build; no Microsoft Word runtime.', 'Native ODT character background is a separately supported standard-background layer; highlight source is explicitly synthetic OOXML.', 'Continuous CSS rendering, not native pixel or pagination fidelity.', 'Enter expectations come from pinned LibreOffice source; keystrokes run in Chromium, not LibreOffice.', 'insertText is not an operating-system IME test.'], corpus: { sha256: sha256(sourceFile), nativeVersion: manifest.libreoffice.version, sourceKind: fixture.sourceKind, sourceSha256: sha256(syntheticSource), shadingSha256: sha256(path.join(corpus,backgroundFixture.docx)) }, productBefore: sourceHashes(), checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [] };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'word-highlight-native-'));
  try {
    const result = await run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', destination, file], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const target = path.join(destination,path.basename(file)); assert.ok(fs.existsSync(target),result.stdout+result.stderr);
    return { file: target, sha256: sha256(target), stdout: result.stdout, stderr: result.stderr, document: inspect(target) };
  } finally { fs.rmSync(profile,{ recursive:true,force:true }); }
}
function chars(text, style) { return Array.from(text,character => ({ character, fontSize:12, strike:'none', verticalAlign:'baseline', underline:false, highlight:'none', ...style })); }
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
(async()=>{try{
  assert.equal(sha256(sourceFile),fixture.docxSha256);assert.equal(sha256(syntheticSource),fixture.sourceSha256);assert.equal(sha256(path.join(corpus,backgroundFixture.docx)),backgroundFixture.docxSha256);
  const original=inspect(sourceFile),expected=fixture.expectedSemantics.characters;
  assert.deepEqual(texts(original),fixture.expectedParagraphs);assert.deepEqual(semantics(original),expected);assert.deepEqual(semantics(inspect(syntheticSource)),expected);report.original=original;
  const {createServer}=await import('vite');server=await createServer({root,cacheDir:'node_modules/.vite-word-highlight-test',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:{ignored:['**/src-tauri/target/**','**/test-results/**']}}});await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}/`,origin=new URL(url).origin;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});page=await browser.newPage({viewport:{width:1360,height:1000},acceptDownloads:true});page.setDefaultTimeout(30000);await page.routeWebSocket('**',()=>{});
  page.on('request',request=>{const u=new URL(request.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)report.externalRequests.push(u.href);if(/office-runtime|office\/host|soffice|\.wasm(?:$|\?)/.test(u.href))report.runtimeRequests.push(u.href);});page.on('pageerror',e=>report.pageErrors.push({phase,message:e.message}));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({phase,message:m.text()});});
  await page.goto(url);await page.getByTestId('independent-word-open').waitFor();
  phase='native-palette-import';await open(sourceFile,true);
  report.visual=await content().evaluate(node=>[...node.children].slice(0,17).map(p=>{const run=p.querySelector('[data-word-highlight]')||p.firstElementChild;return {text:p.textContent,highlight:run?.dataset.wordHighlight||'none',background:run?getComputedStyle(run).backgroundColor:null};}));
  const css=color=>color===null?'rgba(0, 0, 0, 0)':`rgb(${[0,2,4].map(n=>parseInt(color.slice(n,n+2),16)).join(', ')})`;
  Object.entries(PALETTE).forEach(([name,color],i)=>{assert.equal(report.visual[i].highlight,name);assert.equal(report.visual[i].background,css(color));});
  const saved=await assertDownload('native-original-save.docx',expected);assert.deepEqual(saved.document.paragraphs.map(fullCharacters),original.paragraphs.map(fullCharacters),'All unchanged fonts/languages/logical sizes/script/strike/highlight must survive');
  await open(saved.file);await assertDownload('native-original-second-save.docx',expected);
  ok('All17 standard values render exact palette colors and survive two actual downloads/reopen, retaining other supported character properties');

  phase='controlled-character-style-ignore';await open(syntheticSource);await assertDownload('synthetic-source-imported.docx',expected);
  assert.ok(expected[18].every(c=>c.highlight==='none'));assert.ok(expected[19].every(c=>c.highlight==='yellow'));
  ok('Explicitly synthetic source confirms character-style highlight is ignored, paragraph highlight is retained and direct none clears inherited color');

  phase='native-ui-roundtrip';await open(sourceFile);await selectText(21,'Edit target');await highlight('yellow');await range(21,'Edit target'.length);await page.keyboard.type(' ASCII');await page.keyboard.insertText(' 中文😀');await idle();
  const changed=structuredClone(expected);changed[21]=chars('Edit target ASCII 中文😀',{highlight:'yellow'});
  const edited=await assertDownload('highlight-edited.docx',changed);report.nativeControl=await nativeRoundtrip(sourceFile,'control');report.nativeEdited=await nativeRoundtrip(edited.file,'edited');assert.deepEqual(semantics(report.nativeControl.document),expected);assert.deepEqual(semantics(report.nativeEdited.document),changed);assert.deepEqual(report.nativeEdited.document.paragraphs.slice(0,21).map(fullCharacters),report.nativeControl.document.paragraphs.slice(0,21).map(fullCharacters));await open(report.nativeEdited.file);await assertDownload('highlight-reopened.docx',changed);
  ok('Real menu and keyboard edit/download -> native LibreOffice resave -> UI reopen/download preserves per-character highlighting including explicit none');

  phase='palette-controls-history-and-mixed';await open(sourceFile);report.menuChoices=[];
  for(const name of Object.keys(PALETTE)){await selectText(21,'Edit target');await highlight(name);assert.equal(await page.getByTestId('word-highlight-menu-toggle').getAttribute('data-highlight'),name);const actual=await content().evaluate(n=>[...n.children[21].querySelectorAll('[data-word-highlight]')].map(e=>e.dataset.wordHighlight));assert.ok(actual.length&&actual.every(v=>v===name));report.menuChoices.push(name);}
  const ui=structuredClone(expected);ui[21]=chars('Edit target',{highlight:'lightGray'});await assertDownload('highlight-all-menu-choices.docx',ui);await undo();ui[21]=chars('Edit target',{highlight:'darkGray'});await assertDownload('highlight-menu-undo.docx',ui);await redo();ui[21]=chars('Edit target',{highlight:'lightGray'});await assertDownload('highlight-menu-redo.docx',ui);
  await range(17,0,fixture.expectedParagraphs[17].length);assert.equal(await page.getByTestId('word-highlight-menu-toggle').getAttribute('data-highlight'),'mixed');await highlight('none');ui[17]=expected[17].map(c=>({...c,highlight:'none'}));await assertDownload('highlight-clear-inherited.docx',ui);await undo();ui[17]=structuredClone(expected[17]);await assertDownload('highlight-clear-undo.docx',ui);
  await selectText(21,'Edit target');await page.getByTestId('word-highlight-menu-toggle').click();await page.keyboard.press('Home');await page.keyboard.press('Enter');await idle();ui[21]=chars('Edit target');await assertDownload('highlight-keyboard-none.docx',ui);
  await page.getByTestId('word-highlight-menu-toggle').click();await page.keyboard.press('Escape');assert.equal(await content().evaluate(n=>n===document.activeElement||n.contains(document.activeElement)),true);
  ok('All17 menu choices, mixed selection, explicit no-highlight over paragraph color, keyboard selection and one-step undo/redo retain intended values');

  phase='nested-wrapper-input-and-structural-edits';await open(sourceFile);const offset=fixture.expectedParagraphs[20].indexOf('中')+1;await range(20,offset);await page.keyboard.type('abc');await page.keyboard.insertText('汉😀');await idle();
  const combo={highlight:'cyan',fontSize:18,verticalAlign:'superscript',strike:'double',underline:true};const typed=replaceChars(expected,20,Array.from(fixture.expectedParagraphs[20].slice(0,offset)).length,0,'abc汉😀',combo);const nested=await assertDownload('highlight-nested-typing.docx',typed);await open(nested.file);await assertDownload('highlight-nested-reopened.docx',typed);
  await open(sourceFile);await range(20,3);await page.keyboard.press('Shift+Enter');await page.keyboard.type('X');await idle();const soft=replaceChars(expected,20,3,0,'\nX',combo);await assertDownload('highlight-softbreak.docx',soft);
  await open(sourceFile);await range(20,3);await page.keyboard.press('Enter');await idle();const mid=structuredClone(expected);mid.splice(20,1,expected[20].slice(0,3),expected[20].slice(3));await assertDownload('highlight-mid-enter.docx',mid);await undo();await assertDownload('highlight-mid-undo.docx',expected);
  await range(20,fixture.expectedParagraphs[20].length);await page.keyboard.press('Enter');await page.keyboard.type('next');await idle();const end=structuredClone(expected);end.splice(21,0,chars('next',{...combo,verticalAlign:'baseline'}));await assertDownload('highlight-end-enter.docx',end);
  await open(sourceFile);await range(18,0);await page.keyboard.press('Backspace');await idle();const merged=structuredClone(expected);merged.splice(17,2,[...expected[17],...expected[18]]);const merge=await assertDownload('highlight-backspace-merge.docx',merged);await undo();await assertDownload('highlight-merge-undo.docx',expected);await redo();await assertDownload('highlight-merge-redo.docx',merged);await open(merge.file);await assertDownload('highlight-merge-reopened.docx',merged);await open(sourceFile);await range(17,fixture.expectedParagraphs[17].length);await page.keyboard.press('Delete');await idle();await assertDownload('highlight-forward-merge.docx',merged);
  ok('Highlight survives actual nested CJK/emoji script typing, soft/middle/end breaks, opposing-color merges, history and reopen without changing logical18pt size');

  phase='empty-highlighted-script-insertion';
  const emptyFile=path.join(output,'synthetic-empty-highlighted-script.docx');fs.writeFileSync(emptyFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:dstrike/><w:sz w:val="36"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr><w:t/></w:r></w:p>')));await open(emptyFile);const emptySaved=await save('empty-highlighted-beforetyping.docx');await open(emptySaved);await content().focus();await page.keyboard.press('Control+Home');await page.keyboard.type('AB');await page.keyboard.insertText('中文😀');await idle();
  await assertDownload('empty-highlighted-insertion.docx',[chars('AB中文😀',{highlight:'yellow',fontSize:18,verticalAlign:'superscript',strike:'double',underline:true})]);
  ok('An imported empty highlighted/scripted run preserves insertion highlighting and logical18pt after own save/reopen and real typing');

  phase='owned-wrapper-background-import';
  report.domMutation=await page.evaluate(async bytes=>{const {importWordDocument}=await import('/src/word/core/docx.ts');const {renderWordDom,readWordDom}=await import('/src/word/core/dom.ts');const source=importWordDocument(Uint8Array.from(bytes));const host=document.createElement('div');document.body.append(host);const result=[];
    const flat=d=>d.paragraphs[20].runs.flatMap(r=>Array.from(r.text,c=>({c,highlight:r.style.highlight||'none',fontSize:r.style.fontSize,verticalAlign:r.style.verticalAlign,strike:r.style.strike,underline:r.style.underline})));
    try{for(const kind of ['script','strike','glyph','ordinary']){renderWordDom(host,source);const p=host.children[20];let target=kind==='ordinary'?null:kind==='glyph'?p.querySelector('[data-word-glyph-font]'):p.querySelector(`[data-word-visual="${kind}"]`);if(kind==='ordinary'){const text=p.querySelector('[data-word-visual="strike"]')||p.firstElementChild;target=document.createElement('span');while(text.firstChild)target.append(text.firstChild);text.append(target);}if(!target)throw Error('Missing wrapper '+kind);target.dataset.wordHighlight='yellow';target.style.backgroundColor='rgb(255, 255, 0)';let doc=readWordDom(host,source);const selected=flat(doc);if(!selected.some(x=>x.highlight==='yellow')||selected.some(x=>x.fontSize!==18||x.verticalAlign!=='superscript'||x.strike!=='double'||!x.underline))throw Error('Wrapper CSS lost semantics '+kind);for(let i=0;i<8;i++){renderWordDom(host,doc);doc=readWordDom(host,doc);}if(JSON.stringify(flat(doc))!==JSON.stringify(selected))throw Error('Wrapper unstable '+kind);result.push({kind,stableCycles:8,yellowCharacters:selected.filter(x=>x.highlight==='yellow').length});}
      const empty=structuredClone(source);empty.paragraphs=[structuredClone(source.paragraphs[20])];const emptyRun=structuredClone(source.paragraphs[20].runs[0]);emptyRun.text='';delete emptyRun.style.highlight;if(emptyRun.directStyle){delete emptyRun.directStyle.highlight;delete emptyRun.directStyle.verticalAlign;}emptyRun.sourceVerticalAlign='superscript';empty.paragraphs[0].runs=[emptyRun];
      for(const kind of ['script','strike']){renderWordDom(host,empty);const outer=host.children[0].firstElementChild;delete outer.dataset.wordHighlight;outer.style.backgroundColor='';const visual=outer.querySelector(`[data-word-visual="${kind}"]`);visual.dataset.wordHighlight='yellow';visual.style.backgroundColor='rgb(255, 255, 0)';const restored=readWordDom(host,empty);const run=restored.paragraphs[0].runs[0];if(run.text!==''||run.style.highlight!=='yellow'||run.style.fontSize!==18||run.sourceVerticalAlign!=='superscript'||run.directStyle?.fontSize!==18||run.directStyle?.strike!=='double')throw Error('Empty wrapper lost highlight or placeholder semantics '+kind);result.push({kind:'empty-'+kind,highlight:run.style.highlight,emptyText:true});}
      const trailing=structuredClone(empty);trailing.paragraphs[0].runs[0].text='A\n';trailing.paragraphs[0].runs[0].style.highlight='yellow';trailing.paragraphs[0].runs[0].directStyle.highlight='yellow';renderWordDom(host,trailing);const trailingRead=readWordDom(host,trailing);if(trailingRead.paragraphs[0].runs.map(r=>r.text).join('')!=='A\n'||trailingRead.paragraphs[0].runs.some(r=>r.style.highlight!=='yellow'))throw Error('Trailing soft break placeholder added text or lost highlight');result.push({kind:'trailing-softbreak',text:'A\n'});
      renderWordDom(host,source);let wrapper=host.children[20].querySelector('[data-word-visual="script"]');wrapper.style.backgroundColor='transparent';if(flat(readWordDom(host,source)).some(x=>x.highlight!=='cyan'))throw Error('Transparent wrapper cleared inherited color');
      wrapper.dataset.wordHighlight='none';if(!flat(readWordDom(host,source)).some(x=>x.highlight==='none'))throw Error('Explicit none failed to clear inherited color');
      renderWordDom(host,source);wrapper=host.children[20].querySelector('[data-word-visual="script"]');wrapper.style.backgroundColor='rgba(1, 2, 3, 0.5)';let rejected=false;try{readWordDom(host,source);}catch{rejected=true;}if(!rejected)throw Error('Translucent background silently accepted');return {cases:result,transparentInherited:true,explicitNone:true,partialAlphaRejected:true};
    }finally{host.remove();}},Array.from(fs.readFileSync(sourceFile)));
  ok('Real DOM mutations on script/strike/glyph/ordinary wrappers retain palette background through8cycles; transparent inherits, explicit none clears, partial alpha rejects');

  phase='negative-ooxml';report.negative=[];
  const invalid=[['unknown-enum','<w:highlight w:val="orange"/>'],['hex-color','<w:highlight w:val="FFFF00"/>'],['wrong-case','<w:highlight w:val="Yellow"/>'],['missing-value','<w:highlight/>'],['duplicate-property','<w:highlight w:val="yellow"/><w:highlight w:val="blue"/>'],['duplicate-attribute','<w:highlight w:val="yellow" w:val="blue"/>'],['unknown-attribute','<w:highlight w:val="yellow" w:foo="1"/>'],['nested-content','<w:highlight w:val="yellow"><w:b/></w:highlight>'],['patterned-shading','<w:shd w:val="pct15" w:fill="FFFF00"/>']];
  for(const[name,props]of invalid){const bytes=synthetic(`<w:p><w:r><w:rPr>${props}</w:rPr><w:t>Unsupported</w:t></w:r></w:p>`);const message=await page.evaluate(async bytes=>{try{(await import('/src/word/core/docx.ts')).importWordDocument(Uint8Array.from(bytes));return null;}catch(e){return e.message;}},bytes);assert.ok(message,`${name} was silently accepted`);report.negative.push({name,message});}
  ok('9 malformed or unsupported highlight/shading encodings are rejected explicitly');

  phase='native-independent-marker-shading';
  const markerFile=path.join(corpus,backgroundFixture.docx),markerOriginal=inspectBackground(markerFile);
  assert.deepEqual(texts(markerOriginal),backgroundFixture.expectedParagraphs);
  assert.deepEqual(markerOriginal.paragraphs.map(p=>p.paragraphMarkStyle),backgroundFixture.expectedParagraphMarkers);
  assert.ok(markerOriginal.paragraphs[0].characters.every(c=>c.backgroundColor==='#FFFF00'&&c.highlight==='none'));
  await open(markerFile);const markerSave=await save('native-marker-background-save.docx'),markerSaved=inspectBackground(markerSave);
  assert.deepEqual(markerSaved.paragraphs.map(fullBackgroundCharacters),markerOriginal.paragraphs.map(fullBackgroundCharacters));assertMarkerPreserved(markerSaved,markerOriginal);
  await open(markerSave);await range(0,0,3);await page.getByTestId('word-background-menu-toggle').click();await page.getByTestId('word-background-none').click();await idle();
  const markerBodyExpected=markerOriginal.paragraphs.map(fullBackgroundCharacters);markerBodyExpected[0]=markerBodyExpected[0].map((c,i)=>i<3?({...c,backgroundColor:'none'}):c);
  const markerEdited=await save('native-marker-background-body-cleared.docx'),markerEditedDocument=inspectBackground(markerEdited);
  assert.deepEqual(markerEditedDocument.paragraphs.map(fullBackgroundCharacters),markerBodyExpected);assertMarkerPreserved(markerEditedDocument,markerOriginal);
  // Native Writer adds a default kern=0 on a second save even without edits.
  // Compare against an untouched native control, retaining the stricter own-save checks above.
  report.nativeMarkerControl=await nativeRoundtrip(markerFile,'paragraph-marker-control');report.nativeMarkerControl.document=inspectBackground(report.nativeMarkerControl.file);
  assert.deepEqual(report.nativeMarkerControl.document.paragraphs.map(p=>p.paragraphMarkStyle),backgroundFixture.expectedParagraphMarkers);
  const nativeMarkerBodyExpected=report.nativeMarkerControl.document.paragraphs.map(fullBackgroundCharacters);nativeMarkerBodyExpected[0]=nativeMarkerBodyExpected[0].map((c,i)=>i<3?({...c,backgroundColor:'none'}):c);
  report.nativeMarker=await nativeRoundtrip(markerEdited,'paragraph-marker');report.nativeMarker.document=inspectBackground(report.nativeMarker.file);
  assert.deepEqual(report.nativeMarker.document.paragraphs.map(fullBackgroundCharacters),nativeMarkerBodyExpected);assertMarkerPreserved(report.nativeMarker.document,report.nativeMarkerControl.document);
  await open(report.nativeMarker.file);const markerReopened=inspectBackground(await save('native-marker-background-reopened.docx'));
  assert.deepEqual(markerReopened.paragraphs.map(fullBackgroundCharacters),nativeMarkerBodyExpected);assertMarkerPreserved(markerReopened,report.nativeMarkerControl.document);
  ok('Complete native ODT shading fixture retains independent yellow paragraph marker through partial-body background clearing, native resave and UI reopen');

  phase='patterned-marker-and-text-rejection';
  await open(sourceFile);await range(0,0);await page.keyboard.type('unsaved ');await idle();
  const patternFile=path.join(output,'synthetic-patterned-background.docx');fs.writeFileSync(patternFile,Buffer.from(synthetic('<w:p><w:r><w:rPr><w:shd w:val="pct15" w:fill="FFFF00"/></w:rPr><w:t>Unsupported pattern</w:t></w:r></w:p>')));
  const markerPatternFile=path.join(output,'synthetic-patterned-paragraph-marker.docx');fs.writeFileSync(markerPatternFile,Buffer.from(synthetic('<w:p><w:pPr><w:rPr><w:shd w:val="pct15" w:fill="FFFF00"/></w:rPr></w:pPr><w:r><w:t>Unsupported marker pattern</w:t></w:r></w:p>')));
  report.atomicRejections=[];for(const file of [markerPatternFile,patternFile]){const before=await content().innerHTML(),tabs=await page.locator('.document-tab').count();const chooser=page.waitForEvent('filechooser');await page.locator('.command-bar').getByRole('button',{name:'打开',exact:true}).click();await(await chooser).setFiles(file);await page.locator('.error-banner').waitFor();await page.locator('.busy-overlay').waitFor({state:'hidden'});assert.equal(await content().innerHTML(),before);assert.equal(await page.locator('.document-tab').count(),tabs);assert.equal(await page.locator('.document-tab[aria-selected="true"] .dirty-dot').count(),1);report.atomicRejections.push({name:path.basename(file),error:await page.locator('.error-banner').textContent()});await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();await idle();}
  ok('Synthetic patterned shading on paragraph markers and body text rejects atomically, preserving the unsaved document');
  await open(sourceFile);await selectText(21,'Edit target');await page.getByTestId('word-highlight-menu-toggle').click();await page.screenshot({path:path.join(output,'highlight-palette.png'),fullPage:true});await page.keyboard.press('Escape');await page.setViewportSize({width:800,height:1000});await page.getByTestId('word-highlight-menu-toggle').click();await page.screenshot({path:path.join(output,'highlight-narrow-palette.png'),fullPage:true});const bounds=await page.getByTestId('word-highlight-menu').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=800,'Palette overflows narrow viewport');await page.keyboard.press('Escape');
  report.productAfter=sourceHashes();assert.deepEqual(report.productAfter,report.productBefore,'Sources changed during regression; rerun after freeze');assert.equal(sha256(sourceFile),fixture.docxSha256);assert.equal(sha256(syntheticSource),fixture.sourceSha256);assert.equal(sha256(path.join(corpus,backgroundFixture.docx)),backgroundFixture.docxSha256);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.runtimeRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.failure={phase,message:error.message,stack:error.stack};if(page){try{report.failure.body=(await page.locator('body').innerText()).slice(-6000);await page.screenshot({path:path.join(output,'failure.png')});}catch{}}console.error(error);process.exitCode=1;
}finally{persist();if(browser)await browser.close();if(server)await server.close();}})();
