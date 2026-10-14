// Exercises the real Vue controls; no component internals or development API.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const root=path.resolve(__dirname,'../..'),url=process.env.PRESENTATION_URL||'http://127.0.0.1:5198/';
const out=path.join(root,'test-results/presentation-paragraph-ui');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const report={checks:[],errors:[],externalRequests:[]};
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>report.errors.push(error.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(url).origin)report.externalRequests.push(r.url());});
  await page.goto(url);
  const open=async file=>{await page.getByTestId('document-open-input').setInputFiles(file);await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor();await page.locator('[data-testid="presentation-slide-thumbnail"][data-slide-index="2"]').click();await page.locator('[data-testid="presentation-object"][aria-label^="INHERITED，"]').click();};
  const scene=()=>page.getByTestId('presentation-stage').locator('svg').first().innerHTML();
  const dialog=()=>page.getByRole('dialog',{name:'段落与文本框',exact:true});
  await open(path.join(root,'tests/compatibility/presentation-typography/spacing-baseline.pptx'));
  const original=await scene();await page.getByTestId('presentation-paragraph-format').click();await dialog().waitFor();
  assert.equal(await page.getByTestId('presentation-paragraph-apply').isDisabled(),true);
  assert.equal(await dialog().locator('.pe-paragraph-picker input').count(),4);
  assert.match(await page.getByTestId('presentation-paragraph-1').locator('..').innerText(),/↵/);
  await page.getByTestId('presentation-paragraph-none').click();await page.getByTestId('presentation-paragraph-1').check();
  await page.getByTestId('presentation-paragraph-line-unit').selectOption('points');
  await page.getByTestId('presentation-paragraph-apply').click();await page.getByText('请填写有效的行距或段距数值',{exact:false}).first().waitFor();assert.equal(await dialog().isVisible(),true);
  await page.getByTestId('presentation-paragraph-line-value').fill('12');
  let unexpected=false;const listener=()=>{unexpected=true;};page.on('download',listener);await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('段落与文本框还有未确认的输入',{exact:false}).first().waitFor();assert.equal(unexpected,false);page.off('download',listener);
  if(await page.locator('.error-banner').count())await page.locator('.error-banner').getByRole('button',{name:'关闭错误提示',exact:true}).click();
  await page.getByTestId('presentation-paragraph-cancel').click();assert.equal(await scene(),original);
  while(await page.getByRole('button',{name:'关闭错误提示',exact:true}).count())await page.getByRole('button',{name:'关闭错误提示',exact:true}).first().click();
  report.checks.push('Four actual paragraphs include empty content and keep manual breaks inside their paragraph; missing values and pending save are blocked; cancel leaves scene unchanged');
  await page.getByTestId('presentation-paragraph-format').click();await page.getByTestId('presentation-paragraph-none').click();await page.getByTestId('presentation-paragraph-1').check();
  await page.getByTestId('presentation-paragraph-align').selectOption('right');await page.getByTestId('presentation-paragraph-line-unit').selectOption('points');await page.getByTestId('presentation-paragraph-line-value').fill('12');
  await page.getByTestId('presentation-paragraph-before-unit').selectOption('points');await page.getByTestId('presentation-paragraph-before-value').fill('0');
  await page.getByTestId('presentation-paragraph-after-unit').selectOption('percent');await page.getByTestId('presentation-paragraph-after-value').fill('150');await page.getByTestId('presentation-paragraph-outer').selectOption('true');
  await dialog().locator('.pe-layout-details summary').click();
  await page.getByTestId('presentation-layout-vertical').selectOption('bottom');await page.getByTestId('presentation-layout-wrap').selectOption('false');await page.getByTestId('presentation-layout-left').fill('0');await page.getByTestId('presentation-layout-right').fill('4');
  await page.screenshot({path:path.join(out,'paragraph-dialog.png')});await page.getByTestId('presentation-paragraph-apply').click();await dialog().waitFor({state:'hidden'});const edited=await scene();assert.notEqual(edited,original);
  await page.getByTestId('standalone-presentation-editor').focus();await page.keyboard.press('Control+z');assert.equal(await scene(),original);await page.keyboard.press('Control+Shift+z');assert.equal(await scene(),edited);
  report.checks.push('Paragraph and text-box controls commit one atomic undo/redo operation with explicit zero, fixed points and percentage values');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();const saved=path.join(out,'paragraph-ui-edited.pptx');await(await download).saveAs(saved);
  const parts=unzipSync(fs.readFileSync(saved));const data=await page.evaluate(xml=>{
   const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main',d=new DOMParser().parseFromString(xml,'application/xml');const shape=[...d.getElementsByTagNameNS(P,'sp')].find(s=>s.getElementsByTagNameNS(P,'cNvPr')[0].getAttribute('name')==='INHERITED'),body=shape.getElementsByTagNameNS(P,'txBody')[0],ps=[...body.children].filter(n=>n.localName==='p'),props=ps[1].getElementsByTagNameNS(A,'pPr')[0],bp=body.getElementsByTagNameNS(A,'bodyPr')[0];
   const amount=name=>{const n=props.getElementsByTagNameNS(A,name)[0].firstElementChild;return[n.localName,n.getAttribute('val')];};return{count:ps.length,align:props.getAttribute('algn'),line:amount('lnSpc'),before:amount('spcBef'),after:amount('spcAft'),outer:bp.getAttribute('spcFirstLastPara'),wrap:bp.getAttribute('wrap'),anchor:bp.getAttribute('anchor'),left:bp.getAttribute('lIns'),right:bp.getAttribute('rIns'),breaks:ps[1].getElementsByTagNameNS(A,'br').length};
  },strFromU8(parts['ppt/slides/slide3.xml']));
  assert.deepEqual(data,{count:4,align:'r',line:['spcPts','1200'],before:['spcPts','0'],after:['spcPct','150000'],outer:'1',wrap:'none',anchor:'b',left:'0',right:'144000',breaks:1});report.checks.push('Downloaded PPTX contains exact selected paragraph values, correct millimetre-to-EMU margins and original manual break');
  await open(saved);assert.equal(await scene(),edited);await page.screenshot({path:path.join(out,'paragraph-reopened.png')});report.checks.push('Actual downloaded file reopens with the same rendered scene');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.ok=true;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,checks:report.checks.length}));
 }catch(error){report.ok=false;report.error=error.stack;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
