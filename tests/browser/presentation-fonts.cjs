const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {unzipSync,strFromU8}=require('fflate');
const root=path.resolve(__dirname,'../..');
const out=path.join(root,'test-results/presentation-fonts');fs.mkdirSync(out,{recursive:true});
const missing='OpenOffice-Missing-Font-8a6b25';
let browser;
const report={checks:[],errors:[],externalRequests:[]};
const check=(value,message)=>{assert.ok(value,message);report.checks.push(message);};
(async()=>{try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
 await page.routeWebSocket('**',()=>{});
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('request',request=>{if(!/^(http:\/\/127\.0\.0\.1:5198\/|blob:|data:)/.test(request.url()))report.externalRequests.push(request.url());});
 await page.goto('http://127.0.0.1:5198/');
 const initial=await page.evaluate(async missing=>{
  const {createPresentation,PresentationController}=await import('/src/presentation/core/model.ts');
  const {exportPresentation}=await import('/src/presentation/core/pptx.ts');
  const {probeFontAvailability}=await import('/src/presentation/core/font-diagnostics.ts');
  const ctx=document.createElement('canvas').getContext('2d');
  const snapshots={};
  for(const [name,font]of [['missing',missing],['generic','monospace']]){
   const c=new PresentationController(createPresentation(),name);
   c.action({type:'insert-text',text:'Font compatibility 中文测试'});
   const id=c.state().selectedObjectIds[0];c.action({type:'update-object',id,textStyle:{fontName:font}});
   const a=await exportPresentation(c.model);let s='';for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode(...a.subarray(i,i+8192));snapshots[name]=btoa(s);
  }
  return{snapshots,probe:{missing:probeFontAvailability(missing,ctx),generic:probeFontAvailability('monospace',ctx),injection:probeFontAvailability('serif", monospace, "',ctx)},fontsCheck:document.fonts.check(`16px "${missing}"`)};
 },missing);
 for(const [name,value]of Object.entries(initial.snapshots))fs.writeFileSync(path.join(out,`${name}.pptx`),Buffer.from(value,'base64'));
 check(initial.probe.missing==='possibly-substituted','Invented font is conservatively flagged by actual canvas probing');
 check(initial.probe.generic==='available','Generic monospace is available without claiming a particular installed face');
 check(initial.probe.injection!=='available','A font name cannot inject a CSS fallback stack into the probe');
 report.fontFaceSetCheckForInventedName=initial.fontsCheck;
 async function open(name){
  await page.getByTestId('document-open-input').setInputFiles(path.join(out,`${name}.pptx`));
  await page.locator('.titlebar-context').filter({hasText:`${name}.pptx`}).waitFor();
  await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor();
 }
 const notice=()=>page.locator('[data-testid="presentation-font-notice"]:visible');
 await open('missing');await notice().waitFor();
 await notice().locator('summary').click();
 check((await notice().innerText()).includes(missing),'Actual editor identifies the possibly substituted document font');
 check((await notice().innerText()).includes('PDF 使用随包字体'),'Actual notice describes the PDF font difference');
 const state=await page.evaluate(async()=>document.querySelector('[data-testid="standalone-presentation-editor"]').__vueParentComponent.exposed.getPresentationState());
 check(state.dirty===false && state.revision===0,'Read-only font diagnostics leave the editor clean with revision zero (browser file imports separately require a save destination)');
 await page.screenshot({path:path.join(out,'missing-font-notice.png')});
 const dl=page.waitForEvent('download');await page.getByRole('button',{name:'保存',exact:true}).click();
 const saved=path.join(out,'diagnosed-save.pptx');await(await dl).saveAs(saved);
 const parts=unzipSync(fs.readFileSync(saved));
 const slideXml=Object.entries(parts).filter(([name])=>/^ppt\/slides\/[^/]+\.xml$/.test(name)).map(([,data])=>strFromU8(data));
 check(slideXml.length===1 && slideXml[0].includes(missing),'Saving after diagnostics preserves the source font name');
 const object=page.locator('[data-testid="presentation-object"][data-kind="text"]').filter({hasText:''}).last();
 await object.click();
 const fontInput=page.locator('input[list="pe-fonts"]');await fontInput.fill('monospace');await fontInput.press('Tab');
 await page.waitForFunction(missing=>![...document.querySelectorAll('[data-testid="presentation-font-notice"]')].some(node=>node.getBoundingClientRect().height>0&&node.textContent.includes(missing)),missing);
 check(true,'Explicit font replacement removes stale original-run warnings');
 // A second document must not inherit an earlier async result or probe cache notice.
 await open('generic');await page.waitForTimeout(400);
 check(await notice().count()===0,'Switching documents does not leak a prior missing-font notice');
 await page.evaluate(()=>document.fonts.dispatchEvent(new Event('loadingdone')));await page.waitForTimeout(300);
 check(await notice().count()===0,'Font loading completion rechecks without stale cross-document results');
 await page.setViewportSize({width:640,height:900});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Font notice integration keeps the narrow editor within the viewport');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;console.error(error);process.exitCode=1;}
finally{await browser?.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}})();
