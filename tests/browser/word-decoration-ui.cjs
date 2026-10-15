/* Real Vue toolbar, bundled Writer, native undo and DOCX/ODT reopening.
 * No worker hooks, no document patch-back and no external link navigation. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const {installOfficeStateReader,readOfficeState}=require('./office-state-reader.cjs')
const {waitForOfficeViewport}=require('./office-viewport.cjs')
const root=path.resolve(__dirname,'../..'),out=path.resolve(process.env.WORD_DECORATION_UI_OUTPUT||path.join(root,'test-results/decoration-word-followup')),fixture=path.join(root,'tests/compatibility/word-decorations/rich-decorations.docx')
const sha=b=>createHash('sha256').update(b).digest('hex')
fs.mkdirSync(out,{recursive:true});const report={scope:'Real Vue header/footer controls and bundled Writer DOCX/ODT roundtrips; no worker hooks',checks:[],errors:[],files:[],sourceSha256:sha(fs.readFileSync(fixture)),writerToolsSha256:sha(fs.readFileSync(root+'/public/office/writer-tools.js')),wordWorkbenchSha256:sha(fs.readFileSync(root+'/src/components/WordWorkbench.vue'))};let browser,page,phase='startup'
const pass=s=>{report.checks.push(s);console.log('PASS',s)}
async function idle(){await page.waitForFunction(()=>document.querySelector('.error-banner')||document.querySelector('.office-frame:not(.is-loading)')&&!document.querySelector('.office-loading')&&!document.querySelector('.busy-overlay'),null,{timeout:240000});if(await page.locator('.error-banner').count())throw Error(await page.locator('.error-banner').innerText())}
async function state(){return readOfficeState(page,'word-state')}
async function save(name,format='docx'){
 const downloading=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:'另存为',exact:true}).click();await page.getByTestId('save-format-'+format).check();await page.getByTestId('save-format-confirm').click()
 const file=path.join(out,name+'.'+format);await(await downloading).saveAs(file);await idle();report.files.push({name:path.basename(file),sha256:sha(fs.readFileSync(file))});return file
}
async function open(file){await page.locator('input[type="file"][accept=".docx,.odt,.doc,.rtf"]').setInputFiles(file);await idle();await page.locator('.ow-word>.ow-ribbon').getByRole('tab',{name:'开始',exact:true}).click();await page.getByLabel('段落样式',{exact:true}).waitFor()}
async function panel(target){await page.locator('.ow-word>.ow-ribbon').getByRole('tab',{name:'插入',exact:true}).click();await page.locator('.ow-word>.ow-ribbon').getByRole('button',{name:target==='header'?'页眉':'页脚',exact:true}).click();await idle();await page.getByLabel(target==='header'?'页眉文字':'页脚文字',{exact:true}).waitFor()}
async function applyDraft(){
 const apply=page.getByRole('button',{name:'应用',exact:true}),recheck=page.getByRole('button',{name:'保留输入并重新核对',exact:true})
 if(await apply.isEnabled()){try{await apply.click();await idle();return}catch(error){if(!String(error).includes('文档已变化'))throw error}}
 await recheck.waitFor();await recheck.click();await page.getByTestId('word-draft-review').waitFor();await page.getByRole('button',{name:'按当前文档应用',exact:true}).click();await idle()
}
async function edit(target,from,to){const field=page.getByLabel(target==='header'?'页眉文字':'页脚文字',{exact:true}),previous=await field.inputValue();assert.ok(previous.includes(from));await field.fill(previous.replace(from,to));await applyDraft();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'});assert.equal((await state()).page[target+'Text'],previous.replace(from,to))}
async function reject(next,label){
 const previous=(await state()).page.footerText,field=page.getByLabel('页脚文字',{exact:true});await field.fill(next);let error
 try{await applyDraft()}catch(e){error=String(e)}assert.match(error||'',/此改动跨越格式、字段、链接或复杂内容/);assert.equal(await field.inputValue(),next,'Rejected edit retains draft');assert.equal((await state()).page.footerText,previous,'Rejected edit does not change native footer')
 await page.getByRole('button',{name:'关闭错误提示',exact:true}).click();await page.getByTestId('word-draft-notice').getByRole('button',{name:'还原',exact:true}).click();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'});assert.equal(await field.inputValue(),previous);pass(label)
}
;(async()=>{try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage({viewport:{width:1560,height:1000},acceptDownloads:true});page.setDefaultTimeout(60000);await page.routeWebSocket('**',()=>{});page.on('pageerror',e=>report.errors.push(e.message));await page.route('**/__native-smoke/*',r=>r.fulfill({status:204,body:''}))
 await installOfficeStateReader(page);await page.goto(process.env.APP_URL||'http://127.0.0.1:5199');await open(fixture);await save('ui-baseline');report.before=(await state()).page;assert.match(report.before.headerText,/Memo Page \d+ Help tail/);assert.match(report.before.footerText,/Report Page \d+ Help tail/);pass('Actual DOCX import contains rich header and footer with visible PAGE field and link text')
 phase='footer edit';await panel('footer');assert.match(await page.locator('.ow-panel').innerText(),/关闭页脚仍会删除其中全部内容/);await edit('footer','Report','Review');pass('Actual footer sidebar edits one ordinary run while retaining expanded PAGE and hyperlink text')
 phase='undo redo';await page.getByTitle('撤销',{exact:true}).click();await idle();assert.match((await state()).page.footerText,/^Report /);await page.getByTitle('重做',{exact:true}).click();await idle();assert.match((await state()).page.footerText,/^Review /);pass('Native toolbar Undo and Redo restore and repeat the scoped footer edit')
 phase='header edit';await panel('header');await edit('header','Memo','Note');await save('ui-edited');pass('Actual header sidebar edits its ordinary label through the same protected path')
 phase='rejections';await panel('footer');const original=(await state()).page.footerText
 await reject(original.replace(/Page \d+/,'Page 2'),'Editing the PAGE result is rejected without native mutation')
 await reject(original.replace('Help','Docs'),'Editing hyperlink text is rejected without native mutation')
 await reject(original.replace('Review Page','New heading'),'Editing across formatting runs is rejected without native mutation')
 await reject(original.replace('Review','Re\nview'),'Adding a paragraph or line break is rejected without native mutation')
 await reject('','Clearing a rich footer is rejected and the existing explicit removal warning remains')
 await save('ui-rejected');const odt=await save('ui-edited','odt')
 phase='docx reopen';await open(path.join(out,'ui-edited.docx'));assert.match((await state()).page.footerText,/^Review Page \d+ Help tail$/);assert.match((await state()).page.headerText,/^Note Page \d+ Help tail$/);await save('ui-reopened');pass('Exported DOCX reopens with edited header/footer, PAGE result and hyperlink text')
 phase='odt reopen';await open(odt);assert.match((await state()).page.footerText,/^Review Page \d+ Help tail$/);assert.match((await state()).page.headerText,/^Note Page \d+ Help tail$/);await save('ui-from-odt');pass('Exported ODT reopens in the native engine and exports the same edited decorations back to DOCX')
 await panel('footer');report.viewport=await waitForOfficeViewport(page);await page.screenshot({path:path.join(out,'writer-decorations.png')});assert.equal(sha(fs.readFileSync(fixture)),report.sourceSha256);assert.deepEqual(report.errors,[]);pass('Original fixture remains unchanged; no runtime page errors or external link activation');report.ok=true
 }catch(error){report.ok=false;report.phase=phase;report.error=String(error.stack||error);console.error(phase,error);process.exitCode=1;await page?.screenshot({path:path.join(out,'ui-failure.png')}).catch(()=>{})}finally{fs.writeFileSync(path.join(out,'ui-report.json'),JSON.stringify(report,null,2));await browser?.close()}})()
