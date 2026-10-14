/* Authorized diagnostic adapter: production public office protocol plus real UI
 * create/save/reopen. Reuses the release smoke helper without relaxing assertions.
 * It does not call Vue internals, Qt/UNO getters, or alter native freeze state.
 * Default: current production build, 1024x600 and 1024x640, no CSS injection.
 * Optional CALC_SHORT_NEGATIVE_CONTROL=1 adds a min-height:0 control expected
 * to fail the strict freeze assertion; each raw failure remains in its report. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const localPython=path.join(root,'pdf-backend','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.PDF_BACKEND_PYTHON||(fs.existsSync(localPython)?localPython:process.platform==='win32'?'python':'python3');
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid,out=path.join(root,'test-results/calc-short-viewport',runId);fs.mkdirSync(out,{recursive:true});
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const helper=path.join(root,'src/office/native-workbench-smoke.ts');
const bundled=esbuild.buildSync({entryPoints:[helper],bundle:true,write:false,platform:'browser',format:'iife',globalName:'CalcHeightSmoke',target:'es2022'}).outputFiles[0].text;
fs.writeFileSync(path.join(out,'release-smoke-helper.js'),bundled);fs.copyFileSync(__filename,path.join(out,'probe-script.cjs'));
const baseURL=process.env.OFFICE_WORKBENCH_URL||'http://127.0.0.1:4198/';
const negativeControl=process.env.CALC_SHORT_NEGATIVE_CONTROL==='1';
const report={runId,baseURL,negativeControl,scope:'Public-protocol diagnostic chain reusing unchanged release verifyNativeCalc; actual UI create/save/reopen. This is not an installed macOS run or a complete pointer UI acceptance test.',helper:{path:helper,sha256:sha(helper)},negativeControlCss:'.office-frame { min-height: 0 !important; }',cases:[],errors:[]};
let browser;
function installAdapter(){
 if(window!==top)return;
 const channel='open-office-engine',pending=new Map();let documentId=null;
 window.__heightTrace=[];
 const target=()=>{const frame=document.querySelector('iframe.office-frame');if(!frame?.src)return null;const url=new URL(frame.src,location.href);if(url.origin!==location.origin||url.pathname!=='/office/host.html')return null;const session=new URLSearchParams(url.hash.slice(1)).get('session');return session&&{frame,source:frame.contentWindow,session,origin:url.origin};};
 function geometry(stage,state){const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};const iframe=document.querySelector('iframe.office-frame'),canvas=iframe?.contentDocument?.querySelector('#qtcanvas');const data={at:Date.now(),stage,viewport:{width:innerWidth,height:innerHeight},nodes:Array.from(document.querySelectorAll('.editor-content,.ow-workbench,.ow-ribbon,.ow-cellbar,.sheet-format-note,.ow-notice,.office-editor,.office-viewport,.office-frame,.office-engine-caption,.ow-sheet-tabs,.ow-status')).map(n=>({className:String(n.className),rect:rect(n),clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop})),canvas:canvas&&{rect:rect(canvas),width:canvas.width,height:canvas.height},state:state&&{documentId:state.documentId,revision:state.revision,activeSheetIndex:state.activeSheetIndex,frozen:state.frozen,selection:state.selection?.address}};window.__heightTrace.push(data);return data;}
 window.__heightGeometry=geometry;
 addEventListener('message',event=>{const active=target(),m=event.data;if(!active||event.source!==active.source||event.origin!==active.origin||m?.channel!==channel||m.session!==active.session||!m.requestId)return;
  if(m.ok===true&&m.data?.selection&&Array.isArray(m.data.sheets))documentId=m.data.documentId;
  const request=pending.get(m.requestId);if(!request)return;pending.delete(m.requestId);clearTimeout(request.timer);
  if(request.source!==active.source||request.frame!==active.frame||request.session!==active.session||request.documentId!==documentId)return request.reject(Error('Document changed during diagnostic request'));
  if(m.ok!==true)return request.reject(Error(m.error||'Public request failed'));
  if(m.data?.documentId!==request.documentId||!Number.isSafeInteger(m.data?.revision))return request.reject(Error('Invalid diagnostic response identity/revision'));
  geometry(request.action+(request.data.type?':'+request.data.type:''),m.data);request.resolve(m.data);
 });
 window.__heightRequest=(action,data={})=>{if(!['sheet-state','sheet-action','sheet-data'].includes(action))return Promise.reject(Error('Unsupported diagnostic action'));const active=target();if(!active||!documentId)return Promise.reject(Error('No observed current document'));const requestId='height-diagnostic-'+crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Public diagnostic timeout'))},120000);pending.set(requestId,{...active,documentId,action,data,resolve,reject,timer});active.source.postMessage({channel,session:active.session,requestId,documentId,action,data},active.origin)});};
 window.__heightReady=()=>!!documentId;
}
function inspectXlsx(file){return JSON.parse(execFileSync(python,['-c',`import json,zipfile,posixpath,xml.etree.ElementTree as E,sys
z=zipfile.ZipFile(sys.argv[1]);ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
w=E.fromstring(z.read('xl/workbook.xml'));sheets=[dict(x.attrib) for x in w.findall('s:sheets/s:sheet',ns)];data=[]
rels={r.get('Id'):r.get('Target') for r in E.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
for sheet in sheets:
 target=rels[sheet['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']];name=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
 t=E.fromstring(z.read(name));data.append({'sheetName':sheet['name'],'part':name,'panes':[dict(p.attrib) for p in t.findall('.//s:pane',ns)],'cells':{c.attrib['r']:{'type':c.get('t'),'value':c.findtext('s:v',default='',namespaces=ns),'formula':c.findtext('s:f',default='',namespaces=ns)} for c in t.findall('.//s:c',ns)},'autoFilter':[dict(n.attrib) for n in t.findall('s:autoFilter',ns)]})
print(json.dumps({'sheets':sheets,'worksheets':data,'charts':[p for p in z.namelist() if p.startswith('xl/charts/chart') and p.endswith('.xml')],'pivots':[p for p in z.namelist() if p.startswith('xl/pivotTables/pivotTable') and p.endswith('.xml')]}))`,file],{encoding:'utf8',timeout:20000}));}
async function runCase(height,variant){
 const candidate=variant==='candidate',name=variant+'-'+height,dir=path.join(out,name);fs.mkdirSync(dir,{recursive:true});const result={name,height,variant,candidate,downloads:[],console:[],errors:[]};report.cases.push(result);
 const context=await browser.newContext({viewport:{width:1024,height},acceptDownloads:true,timezoneId:'Etc/UTC'});const page=await context.newPage();page.setDefaultTimeout(30000);let counter=0,phase='open';
 const idle=async()=>{await page.waitForFunction(()=>document.querySelector('.error-banner')||document.querySelector('.office-frame:not(.is-loading)')&&!document.querySelector('.office-loading,.busy-overlay'),null,{timeout:240000});if(await page.locator('.error-banner').count())throw Error(await page.locator('.error-banner').innerText());};
 page.on('pageerror',e=>result.errors.push({phase,message:e.message}));page.on('console',m=>{if(['warning','error'].includes(m.type()))result.console.push({phase,type:m.type(),text:m.text()})});
 try{
  await page.routeWebSocket('**',()=>{});await page.route('**/__native-smoke/*',r=>r.fulfill({status:204,body:''}));await page.addInitScript(installAdapter);
  if(variant==='control')await page.addInitScript(css=>{new MutationObserver(()=>{if(!document.head||document.getElementById('height-candidate-style'))return;const s=document.createElement('style');s.id='height-candidate-style';s.textContent=css;document.head.append(s)}).observe(document,{childList:true,subtree:true})},report.negativeControlCss);
  await page.goto(baseURL);await page.locator('.create-card.sheet').click();await idle();await page.waitForFunction(()=>window.__heightReady?.());
  await page.screenshot({path:path.join(dir,'initial.png'),scale:'css'});result.initial=await page.evaluate(()=>window.__heightGeometry('initial-before-chain'));
  result.candidateContract=await page.evaluate(()=>{const f=document.querySelector('.office-frame'),w=document.querySelector('.office-viewport'),o=document.querySelector('.office-editor');return {wrapperCount:document.querySelectorAll('.office-viewport').length,frameMinHeight:getComputedStyle(f).minHeight,wrapperOverflow:w&&getComputedStyle(w).overflow,outerOverflow:getComputedStyle(o).overflow}});
  if(candidate)assert.deepEqual(result.candidateContract,{wrapperCount:1,frameMinHeight:'360px',wrapperOverflow:'auto',outerOverflow:'hidden'});
  if(variant==='control')assert.equal(result.candidateContract.frameMinHeight,'0px');
  await page.exposeFunction('__heightSaveUi',async format=>{phase='export-'+format;const order=++counter;const downloading=page.waitForEvent('download',{timeout:120000});await page.getByRole('button',{name:format==='pdf'?'导出 PDF':'保存',exact:true}).click();const download=await downloading,file=path.join(dir,order+'-export.'+format);await download.saveAs(file);await idle();const bytes=fs.readFileSync(file);const record={file:path.relative(out,file),sha256:sha(file),bytes:bytes.length,format};if(format==='xlsx')record.independent=inspectXlsx(file);result.downloads.push(record);return {extension:format,base64:bytes.toString('base64')};});
  await page.exposeFunction('__heightReopenUi',async base64=>{phase='reopen';const file=path.join(dir,'reopen-'+counter+'.xlsx');fs.writeFileSync(file,Buffer.from(base64,'base64'));await page.getByTestId('document-open-input').setInputFiles(file);await idle();await page.waitForFunction(()=>window.__heightReady?.());await page.screenshot({path:path.join(dir,'reopened-'+counter+'.png'),scale:'css'});return true;});
  await page.exposeFunction('__heightInspectPdf',async base64=>{const file=path.join(dir,'readback.pdf');fs.writeFileSync(file,Buffer.from(base64,'base64'));return JSON.parse(execFileSync(python,['-c',"import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps({'pageCount':len(d),'text':'\\n'.join(p.get_text() for p in d)}))",file],{encoding:'utf8',timeout:20000}));});
  await page.addScriptTag({content:bundled});phase='verifyNativeCalc';
  result.nativeResult=await page.evaluate(async()=>{const editor={getCalcState:()=>window.__heightRequest('sheet-state'),calcAction:input=>window.__heightRequest('sheet-action',input),calcData:query=>window.__heightRequest('sheet-data',query),exportFile:async options=>{window.__heightGeometry('before-ui-export');return window.__heightSaveUi(options?.format||'xlsx')}};return CalcHeightSmoke.verifyNativeCalc({create:async()=>editor,reopen:async base64=>{await window.__heightReopenUi(base64);return editor},inspectPdf:base64=>window.__heightInspectPdf(base64)});});
  result.ok=!result.errors.length;
 }catch(error){result.ok=false;result.error={phase,message:error.stack||String(error)};}
 finally{result.trace=await page.evaluate(()=>window.__heightTrace||[]).catch(()=>[]);await page.screenshot({path:path.join(dir,'final.png'),scale:'css'}).catch(()=>{});result.final=await page.evaluate(()=>window.__heightGeometry('final-after-chain')).catch(()=>null);await context.close();fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(result,null,2)+'\n');console.log('CASE',JSON.stringify({name,ok:result.ok,error:result.error,downloads:result.downloads.map(d=>({file:d.file,panes:d.independent?.worksheets[0].panes})),report:path.join(dir,'report.json')}));}
}
(async()=>{try{report.servedAssets=await Promise.all(['office/office-worker.js','office/host.js','office-runtime/soffice.wasm'].map(async relative=>{const response=await fetch(new URL(relative,baseURL),{signal:AbortSignal.timeout(120000)});assert.ok(response.ok);const digest=createHash('sha256');let bytes=0;for await(const chunk of response.body){digest.update(chunk);bytes+=chunk.length}return {url:response.url,bytes,sha256:digest.digest('hex')}}));browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const scenarios=negativeControl?['control-600','candidate-600','candidate-640']:['candidate-600','candidate-640'];for(const scenario of scenarios){const [variant,height]=scenario.split('-');await runCase(Number(height),variant);}
 }catch(e){report.errors.push(String(e));process.exitCode=1;}finally{await browser?.close();report.helperUnchanged=sha(helper)===report.helper.sha256;for(const c of report.cases)if(c.variant==='control')c.expectedFreezeFailure=!c.ok&&/Calc frozen panes did not reopen|原生表格未能应用指定冻结位置/.test(c.error?.message||'');report.ok=report.helperUnchanged&&!report.errors.length&&report.cases.length===(negativeControl?3:2)&&report.cases.every(c=>c.variant==='control'?c.expectedFreezeFailure:c.ok);if(!report.ok)process.exitCode=1;report.artifacts=fs.readdirSync(out,{recursive:true}).filter(f=>fs.statSync(path.join(out,f)).isFile()).map(f=>({file:f,bytes:fs.statSync(path.join(out,f)).size,sha256:sha(path.join(out,f))}));fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('REPORT',path.join(out,'report.json'));}})();
