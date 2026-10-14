const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const root = path.resolve(__dirname, '../..');
const childMode = process.env.SMARTART_PRODUCTION_CHILD === '1';
const shapeId = childMode ? '{61DE9095-EDBC-BD41-B4E7-31F95E7FE489}' : '{DB1843D3-471D-3D4F-8D9B-C7F506BC5FEE}';
const contentId = childMode ? '{4B8CF4D2-89EC-1B47-AC03-D01035EB640C}' : '{63986E3B-5608-7F48-A1F2-C2D1F88EED58}';
const selector = `[data-testid="presentation-smartart-node"][data-node-id="${shapeId}"]`;
const out = path.join(root, childMode ? 'test-results/smartart-child-production' : 'test-results/smartart-text-production');
fs.mkdirSync(out,{recursive:true});
const report = { scope:'Production bundle through real UI without dev imports or Vue internals',checks:[],errors:[],externalRequests:[] };
let browser;
(async()=>{try{
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith('http://127.0.0.1:4198/'))report.externalRequests.push(r.url())});
  await page.goto('http://127.0.0.1:4198/');
  const open=async file=>{await page.getByTestId('document-open-input').setInputFiles(file);await page.locator('.titlebar-context').filter({hasText:path.basename(file)}).waitFor();await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor()};
  await open(path.join(root,'tests/compatibility/presentation-complex/fixtures/upstream/apache-poi',childMode?'smartart-rotated-text.pptx':'smartart-simple.pptx'));
  await page.locator('[data-testid="presentation-object"][data-kind="unknown"]').click();
  const node=page.locator(selector);
  const preview=()=>page.getByTestId('presentation-stage').locator('svg image').first().getAttribute('href');
  const before=await preview();
  await node.click();await page.getByTestId('presentation-smartart-input').fill('Q4');await page.getByTestId('presentation-smartart-apply').click();
  await page.getByRole('dialog',{name:'编辑图示节点文字'}).waitFor({state:'hidden'});
  assert.match(await node.innerText(),/Q4/);assert.notEqual(await preview(),before);
  report.checks.push('Built production UI applies node text and refreshes its cached preview');
  await page.getByTestId('standalone-presentation-editor').focus();await page.keyboard.press('Control+z');
  await page.waitForFunction(({selector,text})=>document.querySelector(selector).textContent.includes(text),{selector,text:childMode?'jkl':'abc'});
  assert.equal(await preview(),before);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(selector=>document.querySelector(selector).textContent.includes('Q4'),selector);
  report.checks.push('Production keyboard undo and redo restore text and artwork');
  await page.screenshot({path:path.join(out,'edited-node.png')});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();
  const saved=path.join(out,'edited.pptx');await(await download).saveAs(saved);
  const parts=unzipSync(fs.readFileSync(saved));
  const values=await page.evaluate(xmls=>xmls.map(({xml,tag,id})=>{const d=new DOMParser().parseFromString(xml,'application/xml');const n=[...d.getElementsByTagNameNS('*',tag)].find(n=>n.getAttribute('modelId')===id);return [...n.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main','t')].map(n=>n.textContent).join('')}),[
    {xml:strFromU8(parts['ppt/diagrams/data1.xml']),tag:'pt',id:contentId},
    {xml:strFromU8(parts['ppt/diagrams/drawing1.xml']),tag:'sp',id:shapeId}]);
  assert.deepEqual(values,['Q4','Q4']);
  if(childMode){
    const parent=await page.evaluate(xml=>{const d=new DOMParser().parseFromString(xml,'application/xml');const n=[...d.getElementsByTagNameNS('*','pt')].find(n=>n.getAttribute('modelId')==='{DD222F8A-487E-1E41-BC99-A4B3A9454AE8}');return [...n.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main','t')].map(n=>n.textContent).join('')},strFromU8(parts['ppt/diagrams/data1.xml']));
    assert.equal(parent,'ghi');report.checks.push('Child edit leaves parent data text unchanged in the real download');
  }
  await open(saved);await page.locator('[data-testid="presentation-object"][data-kind="unknown"]').click();assert.match(await node.innerText(),/Q4/);
  report.checks.push('Production Save writes source data and drawing cache; the downloaded file reopens with the edit');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;console.error(error)}finally{await browser?.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))}})();
