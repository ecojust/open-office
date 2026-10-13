const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const out=path.resolve(process.env.PDF_QA_OUTPUT || path.join(root,'test-results/pdf-ui'));
const url=process.env.PDF_QA_URL || 'http://127.0.0.1:5198/';
const python=path.join(root,'pdf-backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
fs.mkdirSync(out,{recursive:true});
if(!fs.existsSync(python))throw new Error('Run npm run pdf:ensure to prepare the actual local PDF engine.');
execFileSync(python,[path.join(__dirname,'pdf-fixtures.py'),out],{stdio:'inherit'});
const report={scope:'Real Chromium + actual local PyMuPDF 1.28.2; native dialogs not claimed',checks:[],errors:[]};
const ok=(name,extra={})=>{report.checks.push({name,...extra});console.log('PASS',name);fs.writeFileSync(out+'/pdf-ui-report.json',JSON.stringify(report,null,2));};
let browser,page;
async function idle(){await page.getByTestId('pdf-busy').waitFor({state:'hidden',timeout:45000});await page.waitForFunction(()=>!document.querySelector('.pdf-render-indicator'),null,{timeout:30000});}
async function operation(name,action){const [raw]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/__pdf-dev')&&r.request().postDataJSON()?.operation===name),action()]);const response=await raw.json();assert.equal(response.ok,true,JSON.stringify(response.error));await idle();return response;}
async function openFile(file){await page.getByTestId('document-open-input').setInputFiles(out+'/'+file);await page.getByTestId('pdf-editor').waitFor();await idle();}
async function drag(x0,y0,x1,y1){const zoom=Number((await page.locator('.pdf-zoom-value').textContent()).replace('%',''))/100;await page.locator('.pdf-stage').evaluate((element,top)=>{element.scrollTop=top},Math.max(0,y0*zoom-100));const box=await page.getByTestId('pdf-page-surface').boundingBox();await page.mouse.move(box.x+x0*zoom,box.y+y0*zoom);await page.mouse.down();await page.mouse.move(box.x+x1*zoom,box.y+y1*zoom,{steps:15});await page.mouse.up();}
(async()=>{try{
browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(45000);page.on('pageerror',e=>report.errors.push(e.message));
await page.goto(url);await openFile('fixture.pdf');
await page.getByTestId('pdf-tool-text').waitFor({state:'visible'});assert.equal(await page.getByTestId('pdf-tool-text').isEnabled(),true);assert.equal(await page.getByTestId('pdf-page-3').count(),1);ok('Existing 3-page PDF renders; editing tools enabled');
await page.getByTestId('pdf-text-block').filter({hasText:'ORIGINAL PAGE 1'}).click();
await page.getByTestId('pdf-text-input').fill('REPLACED 中文');await page.getByTestId('pdf-region-width').fill('400');await page.getByTestId('pdf-region-width').press('Tab');await page.getByTestId('pdf-region-height').fill('38');await page.getByTestId('pdf-region-height').press('Tab');
let result=await operation('replace_text',()=>page.getByTestId('pdf-apply-text').click());let texts=result.textBlocks.map(b=>b.text).join('\n');assert.ok(texts.includes('REPLACED 中文'));assert.ok(!texts.includes('ORIGINAL PAGE 1'));assert.ok(texts.includes('KEEP THIS NEIGHBOR'));ok('Original text truly replaced, Chinese survives, neighboring text retained');
await operation('inspect',()=>page.getByTestId('pdf-undo').click());assert.equal(await page.getByTestId('pdf-text-block').filter({hasText:'ORIGINAL PAGE 1'}).count(),1);await operation('inspect',()=>page.getByTestId('pdf-redo').click());assert.equal(await page.getByTestId('pdf-text-block').filter({hasText:'REPLACED 中文'}).count(),1);ok('Undo / redo restores actual PDF snapshots');
await page.getByTestId('pdf-tool-text').click();await idle();await drag(60,270,470,350);await page.getByTestId('pdf-text-input').fill('ADDED TEXT 新增');result=await operation('add_text',()=>page.getByTestId('pdf-apply-text').click());assert.ok(result.textBlocks.some(b=>b.text.includes('ADDED TEXT 新增')));ok('Add text with drawn placement');
await page.getByTestId('pdf-tool-highlight').click();await idle();await drag(45,110,240,128);result=await operation('highlight',()=>page.getByTestId('pdf-apply-highlight').click());ok('Actual PDF highlight annotation');
await page.getByTestId('pdf-tool-ink').click();await idle();await drag(70,390,280,420);result=await operation('ink',()=>page.getByTestId('pdf-apply-ink').click());ok('Actual PDF ink signature annotation');
const picker=page.waitForEvent('filechooser');await page.getByTestId('pdf-tool-image').click();await(await picker).setFiles(out+'/image.png');await idle();await drag(60,460,220,630);result=await operation('add_image',()=>page.getByTestId('pdf-apply-image').click());ok('Image file inserted into PDF');
await page.getByLabel('取消当前编辑',{exact:true}).click();
await page.getByTestId('pdf-search-toggle').click();await page.getByTestId('pdf-search-input').fill('unique-3');await page.getByTestId('pdf-search-submit').click();await page.waitForFunction(()=>document.querySelector('[data-testid="pdf-page-number"]').value==='3');await idle();assert.match(await page.locator('.pdf-search-results').textContent(),/1 页匹配/);ok('Search indexes all pages and navigates to result');
await page.getByTestId('pdf-search-toggle').click();
result=await operation('rotate',()=>page.getByTestId('pdf-rotate').click());assert.equal(result.metadata.pages[2].rotation,90);ok('Rotate selected page');
result=await operation('reorder',()=>page.getByTestId('pdf-move-up').click());assert.equal(result.metadata.pages[1].rotation,90);ok('Move selected page forwards');
await page.getByTestId('pdf-page-1').click();await idle();await page.getByLabel('选择第 2 页',{exact:true}).check();
const extracted=page.waitForEvent('download');await operation('extract',()=>page.getByTestId('pdf-extract').click());await(await extracted).saveAs(out+'/extracted.pdf');ok('Multi-page selection and extract to PDF');
await page.getByTestId('pdf-page-3').click();await idle();result=await operation('delete',()=>page.getByTestId('pdf-delete').click());assert.equal(result.metadata.pageCount,2);ok('Delete page preserves at least one page');
const mergePicker=page.waitForEvent('filechooser');await page.getByTestId('pdf-merge').click();await(await mergePicker).setFiles(out+'/fixture.pdf');await page.getByTestId('pdf-merge-dialog').waitFor();result=await operation('merge',()=>page.getByTestId('pdf-confirm-merge').click());assert.equal(result.metadata.pageCount,5);ok('Merge another real PDF and retain all pages');
const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();await(await download).saveAs(out+'/edited.pdf');ok('Export edited PDF through application save');
execFileSync(python,[path.join(__dirname,'pdf-verify.py'),out],{stdio:'inherit'});ok('Independently reopen exported PDF: removed text, annotations, image, background and page count verified');
await page.getByTestId('pdf-page-1').click();await idle();
await page.screenshot({path:out+'/pdf-desktop.png',fullPage:true});
await page.getByTestId('pdf-text-block').filter({hasText:'REPLACED 中文'}).click();await page.getByTestId('pdf-text-input').fill('UNAPPLIED DRAFT');await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent?.includes('尚未保存'));
await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').filter({hasText:'未应用'}).waitFor();assert.equal(await page.getByTestId('pdf-text-input').inputValue(),'UNAPPLIED DRAFT');
await page.getByRole('button',{name:'关闭 fixture.pdf',exact:true}).click();await page.getByRole('dialog',{name:'保存你的修改？'}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByTestId('pdf-clear-placement').click();ok('Unapplied text marks dirty, prevents saving and requires close confirmation');
await openFile('protected.pdf');await page.getByTestId('pdf-password-dialog').waitFor();await page.getByTestId('pdf-password').fill('wrong');await page.getByTestId('pdf-unlock').click();await page.getByTestId('pdf-error').filter({hasText:'密码不正确'}).waitFor();await page.getByTestId('pdf-password').fill('test123');await page.getByTestId('pdf-unlock').click();await idle();assert.equal(await page.getByTestId('pdf-tool-text').isDisabled(),true);assert.equal(await page.getByTestId('pdf-rotate').isDisabled(),true);ok('Encrypted PDF password validation and editing restrictions');
await openFile('scanned.pdf');assert.match(await page.getByTestId('pdf-context-hint').textContent(),/扫描页/);assert.equal(await page.getByTestId('pdf-text-block').count(),0);ok('Scanned page explicitly has no editable original text');
await openFile('cropped.pdf');await page.getByTestId('pdf-text-block').filter({hasText:'CROPPED ORIGINAL'}).click();await page.getByTestId('pdf-text-input').fill('CROPPED CHANGED');await page.getByTestId('pdf-region-width').fill('300');await page.getByTestId('pdf-region-width').press('Tab');await page.getByTestId('pdf-region-height').fill('35');await page.getByTestId('pdf-region-height').press('Tab');result=await operation('replace_text',()=>page.getByTestId('pdf-apply-text').click());assert.ok(result.textBlocks.some(b=>b.text==='CROPPED CHANGED'));ok('Cropped + rotated page text hit coordinates and replacement');
await page.getByLabel('取消当前编辑',{exact:true}).click().catch(()=>{});
for(const width of [390,320]){await page.setViewportSize({width,height:844});await idle();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);await page.screenshot({path:`${out}/pdf-mobile-${width}.png`,fullPage:true});ok('No page horizontal overflow',{width});}
await page.close();page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(45000);page.on('pageerror',e=>report.errors.push(e.message));await page.goto(url);
await operation('new',()=>page.locator('.create-card.pdf').click());await page.getByTestId('pdf-tool-text').click();await idle();await drag(60,60,420,150);await page.getByTestId('pdf-text-input').fill('TAB ONE KEPT');await operation('add_text',()=>page.getByTestId('pdf-apply-text').click());await page.getByLabel('取消当前编辑',{exact:true}).click();
await page.getByRole('button',{name:'返回工作台',exact:true}).click();await page.locator('.create-card.pdf').click();await page.locator('.document-tab .tab-name').first().click();await idle();
if(!(await page.getByTestId('pdf-text-block').filter({hasText:'TAB ONE KEPT'}).count())){await page.locator('.document-tab .tab-name').first().click();await idle();}
assert.equal(await page.getByTestId('pdf-text-block').filter({hasText:'TAB ONE KEPT'}).count(),1);ok('New PDF1 edit → PDF2 → return PDF1 retains real document contents');
assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.ok=false;report.failure=String(error.stack||error);if(page)await page.screenshot({path:out+'/pdf-failure.png',fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}finally{fs.writeFileSync(out+'/pdf-ui-report.json',JSON.stringify(report,null,2));await browser?.close();}})();
