/* Real Vue controls and bundled Writer. Run after WRITER_TARGET=completion.
 * No Vue internals or synthetic document state are used. */
const { chromium } = require('playwright')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { unzipSync, strFromU8 } = require('fflate')
const root=path.resolve(__dirname,'../..'),out=path.join(root,'test-results/writer-completion-ui')
fs.mkdirSync(out,{recursive:true})
const report={ok:false,checks:[],errors:[]};let browser,page
async function idle(){await page.waitForFunction(()=>document.querySelector('.error-banner')||document.querySelector('.office-frame:not(.is-loading)')&&!document.querySelector('.office-loading')&&!document.querySelector('.busy-overlay'),null,{timeout:240000});if(await page.locator('.error-banner').count())throw Error(await page.locator('.error-banner').innerText())}
async function act(locator){await locator.click();await idle()}
const tab=async name=>page.locator('.ow-word>.ow-ribbon').getByRole('tab',{name,exact:true}).click()
async function find(value){await tab('审阅');const panel=page.getByRole('complementary',{name:'查找与替换'});if(!await panel.count())await act(page.getByRole('button',{name:'查找与替换',exact:true}));await page.getByLabel('查找内容',{exact:true}).fill(value);await act(page.getByRole('button',{name:'查找下一处',exact:true}));await page.locator('.ow-word>.ow-status').getByText(`已选中 ${value.length} 字`,{exact:true}).waitFor()}
;(async()=>{try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
 page=await browser.newPage({viewport:{width:1600,height:1000},acceptDownloads:true});page.setDefaultTimeout(60000)
 page.on('pageerror',e=>report.errors.push(e.message));await page.routeWebSocket('**',()=>{})
 await page.route('**/__native-smoke/*',route=>route.fulfill({status:204,body:''}))
 await page.goto(process.env.OFFICE_WORKBENCH_URL||'http://127.0.0.1:5198/')
 await page.locator('input[type="file"][accept=".docx,.odt,.doc,.rtf"]').setInputFiles(path.join(root,'test-results/writer-completion/completion-formatted.docx'))
 await idle();await page.getByLabel('段落样式',{exact:true}).waitFor()
 await find('Beta');await page.getByLabel('替换为',{exact:true}).fill('Alpha');await act(page.getByRole('button',{name:'替换',exact:true}))
 await find('Alpha');await act(page.getByRole('button',{name:'替换',exact:true}));await page.getByLabel('替换为',{exact:true}).fill('alpha');await act(page.getByRole('button',{name:'替换',exact:true}));await act(page.getByRole('button',{name:'替换',exact:true}))
 report.checks.push('Same-text and case-only Replace clicks advance through repeated words')
 await find('链接正文');await tab('插入');await act(page.getByRole('button',{name:'超链接',exact:true}))
 assert.equal(await page.getByLabel('链接地址',{exact:true}).inputValue(),'https://example.com/article?x=1&y=2')
 await page.getByLabel('链接地址',{exact:true}).fill('https://example.org/edited')
 await page.getByTestId('word-draft-notice').waitFor();await act(page.getByRole('button',{name:'应用',exact:true}));await page.getByTestId('word-draft-notice').waitFor({state:'hidden'})
 assert.equal(await page.getByLabel('链接地址',{exact:true}).inputValue(),'https://example.org/edited')
 report.checks.push('Existing native link read, edited via Vue draft and acknowledged')
 await find('上标2');await tab('开始');assert.equal(await page.getByRole('button',{name:'上标',exact:true}).getAttribute('aria-pressed'),'true')
 await act(page.getByRole('button',{name:'上标',exact:true}));await page.waitForFunction(()=>document.querySelector('[aria-label="上标"]').getAttribute('aria-pressed')==='false');assert.equal(Number(await page.getByLabel('字号（磅）',{exact:true}).inputValue()),12)
 await act(page.getByRole('button',{name:'删除线',exact:true}));await page.waitForFunction(()=>document.querySelector('[aria-label="删除线"]').getAttribute('aria-pressed')==='true')
 report.checks.push('Toolbar reflects loaded superscript and writes normal baseline / strikeout')
 await find('高亮文字');await tab('开始');assert.equal((await page.getByLabel('高亮颜色',{exact:true}).inputValue()).toUpperCase(),'#FFF1A6')
 await act(page.getByRole('button',{name:'取消文字高亮',exact:true}));await page.getByRole('button',{name:'取消文字高亮',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'取消文字高亮',exact:true}).isDisabled(),true)
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();const saved=path.join(out,'ui-edited.docx');await(await download).saveAs(saved);await idle()
 const parts=unzipSync(fs.readFileSync(saved)),xml=strFromU8(parts['word/document.xml']),rels=strFromU8(parts['word/_rels/document.xml.rels'])
 assert.match(rels,/https:\/\/example.org\/edited/);assert.ok(xml.includes('链接正文'));assert.ok(!xml.includes('FFF1A6'));const bodyText=await page.evaluate(xml=>Array.from(new DOMParser().parseFromString(xml,'application/xml').getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main','t')).map(n=>n.textContent).join(''),xml);assert.match(bodyText,/alpha alpha/)
 report.checks.push('Saved real DOCX contains edited hyperlink and removed highlight')
 await page.screenshot({path:path.join(out,'writer-completion.png')})
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 report.checks.push('Writer controls remain within 390px and 320px windows')
 assert.deepEqual(report.errors,[]);report.ok=true
 }catch(error){report.error=String(error.stack||error);console.error(error);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1}
 finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();console.log(JSON.stringify({ok:report.ok,checks:report.checks}))}})()
