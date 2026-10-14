const {chromium}=require('playwright'),{unzipSync,strFromU8}=require('fflate');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'test-results/presentation-colors-ui');fs.mkdirSync(out,{recursive:true});
const url=process.env.PRESENTATION_URL||'http://127.0.0.1:5199/',fixture=path.join(root,'tests/compatibility/presentation-color-transforms/swatches.pptx');
const hash=b=>createHash('sha256').update(b).digest('hex'),sourceSha=hash(fs.readFileSync(fixture));
const report={scope:'Real Vue import, property edit, undo/redo, PPTX download/reopen and PDF download',checks:[],errors:[],external:[]};let page,browser;
const pass=label=>{report.checks.push(label);console.log('PASS',label)};
async function open(file){await page.getByTestId('document-open-input').setInputFiles(file);await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor();await page.getByTestId('presentation-object').first().click()}
async function save(name,role='保存'){const event=page.waitForEvent('download');await page.getByRole('button',{name:role,exact:true}).click();const file=path.join(out,name);await(await event).saveAs(file);return file}
async function audit(file){const parts=Object.fromEntries(Object.entries(unzipSync(fs.readFileSync(file))).filter(([n])=>/^ppt\/slides\/[^/]+\.xml$/.test(n)).map(([n,b])=>[n,strFromU8(b)]));return page.evaluate(parts=>{
 const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main';
 const doc=new DOMParser().parseFromString(Object.values(parts)[0],'application/xml');
 const canon=n=>[n.namespaceURI,n.localName,[...n.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI,a.localName,a.value]).sort(),[...n.childNodes].map(c=>c.nodeType===1?canon(c):c.nodeValue)];
 return [...doc.getElementsByTagNameNS(P,'sp')].map(sp=>({name:sp.getElementsByTagNameNS(P,'cNvPr')[0].getAttribute('name'),fill:canon(sp.getElementsByTagNameNS(A,'solidFill')[0])}));
 },parts)}
async function scene(){return page.getByTestId('presentation-stage').locator('svg').first().innerHTML()}
(async()=>{try{
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(45000);await page.routeWebSocket('**',()=>{});page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(url).origin)report.external.push(r.url())});await page.goto(url);
 await open(fixture);assert.equal(await page.getByTestId('presentation-object').count(),20);const source=await audit(fixture),initial=await scene();assert.ok(initial.toUpperCase().includes('#BEC6D4'));assert.ok(initial.toUpperCase().includes('#BCBCBC'));
 assert.deepEqual(await audit(await save('colors-noop.pptx')),source);pass('20 real shape swatches load and a no-op download preserves each color node and ordered modifiers');
 const width=page.getByTestId('presentation-width');assert.equal(await width.inputValue(),'46');await width.fill('50');await width.press('Tab');const edited=await scene();assert.notEqual(edited,initial);
 await page.getByTestId('standalone-presentation-editor').focus();await page.keyboard.press('Control+z');assert.equal(await scene(),initial);await page.keyboard.press('Control+Shift+z');assert.equal(await scene(),edited);pass('Actual geometry edit and undo/redo preserve corrected color rendering');
 const exported=await save('colors-edited.pptx');assert.deepEqual(await audit(exported),source);await open(exported);assert.equal(await scene(),edited);await page.screenshot({path:path.join(out,'colors-reopened.png')});pass('Downloaded edit retains original color XML and reopens with identical application SVG');
 await save('colors-edited.pdf','导出 PDF');pass('Actual PDF export contains the updated presentation for independent rendering audit');
 assert.equal(hash(fs.readFileSync(fixture)),sourceSha);assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.sourceSha256=sourceSha;report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(e);process.exitCode=1}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close()}})();
