/* Actual Vue workbenches + bundled Writer/Calc. No synthetic UNO or DOM state.
 * Run with the dev server: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/word-sheet-ui.cjs
 */
const {chromium}=require('playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {unzipSync,strFromU8}=require('fflate')
const root=path.resolve(__dirname,'../..'),out=path.join(root,'test-results/word-sheet-ui')
fs.mkdirSync(out,{recursive:true})
let browser,page
const report={scope:'Real Vue controls, local Writer/Calc and independently inspected DOCX/XLSX',checks:[],errors:[],rpc:[],visual:[],httpFailures:[],nativeDiagnostics:[]}
const pass=name=>{report.checks.push(name);console.log('PASS',name)}
async function idle(){await page.waitForFunction(()=>document.querySelector('.error-banner')||document.querySelector('.office-frame:not(.is-loading)')&&!document.querySelector('.office-loading')&&!document.querySelector('.busy-overlay'),null,{timeout:240000});const error=page.locator('.error-banner');if(await error.count())throw Error(await error.innerText())}
async function action(button){await button.click();await idle()}
async function applyWordDraft(){
 const apply=page.getByRole('button',{name:'应用',exact:true}),recheck=page.getByRole('button',{name:'保留输入并重新核对',exact:true})
 const retained=await page.locator('.ow-word .ow-panel input,.ow-word .ow-panel textarea').evaluateAll(fields=>fields.map(field=>({value:field.value,checked:field.type==='checkbox'?field.checked:undefined})))
 if(await apply.isEnabled()){
  try{await action(apply);return}catch(error){if(!String(error).includes('文档已变化'))throw error}
 }
 // Follow the visible product recovery, never change a version or replay an RPC.
 // One new explicit decision only; a second concurrent conflict still fails.
 await recheck.waitFor();assert.deepEqual(await page.locator('.ow-word .ow-panel input,.ow-word .ow-panel textarea').evaluateAll(fields=>fields.map(field=>({value:field.value,checked:field.type==='checkbox'?field.checked:undefined}))),retained,'Conflict must retain the complete draft')
 await recheck.click();const review=page.getByTestId('word-draft-review');await review.waitFor();assert.match(await review.innerText(),/当前页面样式：/);assert.match(await review.innerText(),/保留输入：/)
 await page.getByRole('button',{name:'按当前文档应用',exact:true}).click();await idle();pass('A stale Writer draft was retained, explicitly compared with the current target, and applied only after a second user confirmation')
}
async function wordTab(name){await page.locator('.ow-word>.ow-ribbon').getByRole('tab',{name,exact:true}).click()}
async function sheetTab(name){await page.locator('.ow-sheet>.ow-ribbon').getByRole('tab',{name,exact:true}).click()}
async function save(extension){const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();const file=path.join(out,'ui-edited.'+extension);await(await download).saveAs(file);await idle();return unzipSync(fs.readFileSync(file))}
async function selectCell(address){await page.getByLabel('单元格地址',{exact:true}).fill(address);await page.getByLabel('单元格地址',{exact:true}).press('Enter');await idle();await page.locator('.ow-sheet>.ow-status').getByText(address,{exact:true}).waitFor()}
async function cell(address,input){await selectCell(address);await page.getByLabel('单元格内容或公式').fill(input);await action(page.getByRole('button',{name:'应用公式',exact:true}));await page.getByTestId('sheet-draft-notice').waitFor({state:'hidden'})}
async function screenshot(name){
 await page.waitForTimeout(1200);await page.screenshot({path:path.join(out,name+'.png')})
 const bytes=await page.locator('.office-frame').screenshot()
 const pixels=await page.evaluate(async base64=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'})),canvas=new OffscreenCanvas(80,60),context=canvas.getContext('2d');context.drawImage(bitmap,0,0,80,60);bitmap.close();const data=context.getImageData(0,0,80,60).data,colors=new Set();let visible=0;for(let i=0;i<data.length;i+=4){if(Math.max(data[i],data[i+1],data[i+2])>24)visible++;colors.add((data[i]>>4)+','+(data[i+1]>>4)+','+(data[i+2]>>4))}return{visible:visible/(80*60),colors:colors.size}},bytes.toString('base64'))
 report.visual.push({name,...pixels});assert.ok(pixels.visible>.25&&pixels.colors>8,`Actual ${name} canvas must contain rendered UI, not an all-black framebuffer`)
}
;(async()=>{try{
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
 page=await browser.newPage({viewport:{width:1600,height:1060},acceptDownloads:true});page.setDefaultTimeout(60000);await page.routeWebSocket('**',()=>{})
 // DEV enables the explicit local engine diagnostics. Collect only these exact
 // same-origin POST endpoints; missing fonts/assets and every other HTTP error
 // remain visible and fail the test.
 const baseUrl=process.env.OFFICE_WORKBENCH_URL||'http://127.0.0.1:5198/',diagnosticUrls=['progress','failure'].map(name=>new URL('./__native-smoke/'+name,baseUrl).href)
 await page.route(url=>diagnosticUrls.includes(url.href),async route=>{if(route.request().method()!=='POST')return route.continue();try{const data=route.request().postDataJSON();report.nativeDiagnostics.push({url:route.request().url(),...data});if(data.ok===false)report.errors.push(data.error||data.phase||'Native diagnostic failure')}catch(error){report.errors.push('Malformed native diagnostic: '+error.message)}await route.fulfill({status:204,body:''})})
 page.on('response',response=>{if(response.status()>=400){const item={status:response.status(),url:response.url(),resourceType:response.request().resourceType()};if(!report.httpFailures.some(old=>old.status===item.status&&old.url===item.url))report.httpFailures.push(item)}});
 page.on('pageerror',error=>{report.errors.push(error.message);console.error('PAGEERROR',error.message)})
 page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())})
 await page.addInitScript(()=>{addEventListener('message',event=>{const m=event.data;if(m?.channel!=='open-office-engine'||!(m.action?.startsWith('word-')||m.requestId||m.event==='dirty'))return;const d=m.data||{};console.log('WORKBENCH_RPC '+JSON.stringify({at:Date.now(),frame:location.pathname,action:m.action,requestId:m.requestId,event:m.event,ok:m.ok,error:m.error,type:d.type,revision:d.revision,expectedRevision:d.expectedRevision,selection:d.selection?.id,expectedSelectionId:d.expectedSelectionId,frozen:d.frozen,activeSheetIndex:d.activeSheetIndex,address:d.selection?.address}))})});
 page.on('console',m=>{if(m.text().startsWith('WORKBENCH_RPC ')){console.log(m.text());try{report.rpc.push(JSON.parse(m.text().slice(14)))}catch{}}});
 await page.goto(process.env.OFFICE_WORKBENCH_URL||'http://127.0.0.1:5198/')
 if(process.env.OFFICE_UI_FROM!=='sheet'){
 await page.getByTestId('legacy-word-new').click();await idle();await page.getByLabel('段落样式',{exact:true}).waitFor();await page.evaluate(()=>window.originalOfficeFrame=document.querySelector('.office-frame'))
 await wordTab('插入');await action(page.locator('.ow-word>.ow-ribbon').getByRole('button',{name:'文字',exact:true}))
 await page.getByLabel('文字内容',{exact:true}).fill('工作台真实文档 · 中文核验\n项目进展与行动计划。')
 await applyWordDraft();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 pass('Chinese text inserted through the Writer workbench and acknowledged')
 await wordTab('布局');await action(page.getByRole('button',{name:'纸张与页边距',exact:true}));const widthInput=page.getByLabel('纸张宽度 · 毫米');await widthInput.fill(Number(await widthInput.inputValue()).toFixed(3));await applyWordDraft();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 pass('Normalized page-size input does not leave a false pending draft')
 await wordTab('插入');await action(page.locator('.ow-word>.ow-ribbon').getByRole('button',{name:'页眉',exact:true}));await page.getByLabel('启用页眉').check();await page.getByLabel('页眉文字').fill('OPEN OFFICE · 本地办公');await applyWordDraft();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 await action(page.locator('.ow-word>.ow-ribbon').getByRole('button',{name:'表格',exact:true}));await page.getByLabel('行数',{exact:true}).fill('2');await page.getByLabel('列数',{exact:true}).fill('2');await action(page.getByRole('button',{name:'插入表格',exact:true}));await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 await wordTab('审阅');await action(page.getByRole('button',{name:'表格数据',exact:true}));const options=await page.getByLabel('选择表格').locator('option').evaluateAll(items=>items.map(i=>i.value).filter(Boolean));assert.ok(options.length);await page.getByLabel('选择表格').selectOption(options[0]);await page.getByLabel('第 1 行第 1 列',{exact:true}).waitFor();await page.getByLabel('第 1 行第 1 列',{exact:true}).fill('中文表格回读');await applyWordDraft();await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 const docx=await save('docx'),wordXml=strFromU8(docx['word/document.xml']),headers=Object.entries(docx).filter(([name])=>/^word\/header\d+\.xml$/.test(name)).map(([,v])=>strFromU8(v)).join('\n')
 assert.ok(wordXml.includes('工作台真实文档'));assert.ok(wordXml.includes('中文表格回读'));assert.ok(headers.includes('本地办公'));pass('Real DOCX contains Chinese text, a native editable table and header')
 await screenshot('writer')
 }else report.scope+=' (Calc entry only)'
 await page.locator('.brand').click();await page.locator('.create-card.sheet').click();await idle();await page.getByLabel('单元格内容或公式').waitFor();await page.evaluate(()=>window.originalOfficeFrame||=document.querySelector('.office-frame'))
 if(process.env.OFFICE_UI_VISUAL){await screenshot('calc-initial');const frame=page.frames().find(frame=>frame.url().includes('/office/host.html'));report.canvas=await frame.evaluate(()=>({viewport:[innerWidth,innerHeight,devicePixelRatio],canvases:[...document.querySelectorAll('canvas')].map(c=>({id:c.id,width:c.width,height:c.height,client:[c.clientWidth,c.clientHeight],rect:c.getBoundingClientRect().toJSON(),display:getComputedStyle(c).display,visibility:getComputedStyle(c).visibility})),body:document.body.getBoundingClientRect().toJSON()}));console.log('CANVAS',JSON.stringify(report.canvas));if(process.env.OFFICE_UI_VISUAL==='only'){report.ok=true;return}}
 await cell('A1','40');await cell('A2','2');await cell('A3','=SUM(A1:A2)');pass('Calc cell input and SUM formula applied through the formula bar')
 await sheetTab('插入');await action(page.locator('.ow-sheet>.ow-ribbon').getByRole('button',{name:'批量录入',exact:true}));await selectCell('A5');await page.getByLabel('批量数据',{exact:true}).fill('项目\t数额\n销售\t120\n退款\t-20');await action(page.getByRole('button',{name:'应用数据',exact:true}));await page.getByTestId('sheet-draft-notice').waitFor({state:'hidden'})
 await sheetTab('开始');await selectCell('A5:B5');await action(page.getByRole('button',{name:'单元格加粗',exact:true}));await sheetTab('视图');await action(page.getByRole('button',{name:'冻结首行',exact:true}));await page.getByText('已冻结 1 行 / 0 列',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('单元格地址',{exact:true}).inputValue(),'A5:B5');await page.locator('.ow-sheet>.ow-status').getByText('A5:B5',{exact:true}).waitFor();pass('Freezing the first row preserves the selected multi-cell A5:B5 range')
 await action(page.locator('.ow-sheet>.ow-ribbon').getByRole('button',{name:'工作表管理',exact:true}));await page.getByLabel('工作表名称',{exact:true}).fill('季度数据');await action(page.getByRole('button',{name:'重命名',exact:true}));await page.locator('.ow-sheet-tabs').getByRole('tab',{name:'季度数据',exact:true}).waitFor()
 await sheetTab('插入');await action(page.locator('.ow-sheet>.ow-ribbon').getByRole('button',{name:'批量录入',exact:true}));await selectCell('A1:A3');await action(page.getByRole('button',{name:'读取当前选区',exact:true}));await page.getByLabel('单元格 A3 内容').waitFor();assert.equal(await page.getByLabel('单元格 A3 类型').inputValue(),'formula');assert.equal(await page.getByLabel('单元格 A3 内容').inputValue(),'=SUM(A1:A2)');await page.getByLabel('单元格 A2 内容').fill('3');await action(page.getByRole('button',{name:'应用数据',exact:true}));await page.getByTestId('sheet-draft-notice').waitFor({state:'hidden'})
 pass('Typed range editing updates one numeric cell while retaining the untouched SUM formula')
 await selectCell('A5:B7');await action(page.locator('.ow-sheet>.ow-ribbon').getByRole('button',{name:'图表',exact:true}));await page.getByLabel('图表名称',{exact:true}).fill('收入图');await page.getByLabel('图表类型',{exact:true}).selectOption('line');await action(page.getByRole('button',{name:'插入图表',exact:true}));await action(page.getByRole('button',{name:'读取对象列表',exact:true}));await page.locator('.ow-panel-list').getByText('收入图',{exact:true}).waitFor()
 await action(page.locator('.ow-sheet>.ow-ribbon').getByRole('button',{name:'数据透视表',exact:true}));await page.getByLabel('透视表名称',{exact:true}).fill('收入汇总');await page.getByLabel('输出位置',{exact:true}).fill('E5');await action(page.getByRole('button',{name:'生成透视表',exact:true}));await action(page.getByRole('button',{name:'读取对象列表',exact:true}));await page.locator('.ow-panel-list').getByText('收入汇总',{exact:true}).waitFor();pass('Native editable chart and pivot table are created and read back through Chinese controls')
 const xlsx=await save('xlsx'),sheetXml=strFromU8(xlsx['xl/worksheets/sheet1.xml']),bookXml=strFromU8(xlsx['xl/workbook.xml'])
 assert.ok(bookXml.includes('季度数据'));assert.match(sheetXml,/<c\b[^>]*r="A3"[^>]*>[\s\S]*?<f[^>]*>SUM\(A1:A2\)<\/f>[\s\S]*?<v>43<\/v>/);assert.ok(sheetXml.includes('<v>120</v>'));assert.match(sheetXml,/<pane\b[^>]*ySplit="1"/);assert.ok(Object.keys(xlsx).some(name=>/^xl\/charts\/chart\d+\.xml$/.test(name)));assert.ok(Object.keys(xlsx).some(name=>/^xl\/pivotTables\/pivotTable\d+\.xml$/.test(name)))
 pass('Saved XLSX independently contains recalculated SUM=43, numeric batch data, renamed sheet and frozen first row')
 await screenshot('calc')
 const sheetTabName=await page.locator('.document-tab.active .tab-name').innerText()
 await page.locator('.brand').click();await page.locator('.create-card.pdf').click();await page.getByTestId('pdf-page-number').waitFor();await page.waitForFunction(()=>{const page=document.querySelector('[data-testid=pdf-page-number]');return page&&!page.disabled})
 await page.locator('.tab-name').filter({hasText:sheetTabName.trim()}).click();await idle();await page.getByLabel('单元格内容或公式').waitFor();assert.equal(await page.evaluate(()=>originalOfficeFrame===document.querySelector('.office-frame')),true);await selectCell('A3');assert.equal(await page.getByLabel('单元格内容或公式').inputValue(),'=SUM(A1:A2)');assert.equal(await page.locator('.ow-sheet-tabs').getByRole('tab',{name:'季度数据',exact:true}).getAttribute('aria-selected'),'true')
 pass('Calc → new PDF → retained Calc restores the real toolbar/formula state without remounting Office')
 await page.locator('.brand').click();await page.locator('.create-card.presentation').click();await idle();await page.locator('.pw-slide-card').first().waitFor();assert.equal(await page.locator('.pw-toolbar').getByRole('button',{name:'新建幻灯片',exact:true}).isEnabled(),true);const box=await page.locator('.office-frame').boundingBox();assert.ok(box&&box.width>500&&box.height>300);assert.equal(await page.evaluate(()=>originalOfficeFrame===document.querySelector('.office-frame')),true);await screenshot('presentation-layout')
 pass('New Impress retains its page toolbar and a usable visible canvas within the permanent nested workbenches')
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.httpFailures,[],'Unexpected missing application, runtime, font or document resources');report.ok=true
 }catch(error){report.ok=false;report.error=String(error.stack||error);console.error(error);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await page?.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))).catch(()=>{});await page?.waitForTimeout(1200);await page?.screenshot({path:path.join(out,'failure-stable.png')}).catch(()=>{});process.exitCode=1}
 finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close()}})()
