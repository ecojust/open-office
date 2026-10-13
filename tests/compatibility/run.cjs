/* Actual bundled editor imports, edits and repeatedly reopens independent files.
 * No Office installation or network document service. Never treats an import
 * success alone as proof of preservation. Reports survive individual failures.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { compareInspections } = require('./compare.cjs');
const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const selected = process.env.COMPAT_CASES?.split(',');
const fixtures = manifest.fixtures.filter(item => !selected || selected.includes(item.id));
if (!fixtures.length || selected?.some(id => !fixtures.some(item => item.id === id))) throw Error('Unknown or empty compatibility selection');
const cycles = Number(process.env.COMPAT_CYCLES || 3);
if (!Number.isInteger(cycles) || cycles < 2 || cycles > 5) throw Error('Use 2–5 complete save/reopen cycles');
const out = path.join(root, 'test-results/compatibility', process.env.COMPAT_RUN || new Date().toISOString().replace(/[:.]/g, '-'));
const harness = path.join(out, 'harness');
if (fs.existsSync(path.join(out, 'report.json'))) throw Error('Choose a new COMPAT_RUN; existing evidence must not be overwritten');
fs.mkdirSync(harness, { recursive: true });
const route = '/' + path.relative(root, harness).split(path.sep).join('/');
const modern = {word:'docx',sheet:'xlsx',presentation:'pptx'};
const openDocument = {word:'odt',sheet:'ods',presentation:'odp'};
const report = {schemaVersion:1,startedAt:new Date().toISOString(),scope:'Actual Vue OfficeEditor + bundled WASM; independent XML/PDF readback; no original Office application interoperability claimed',cycles,cases:[],externalRequests:[],pageErrors:[]};
function implementationSnapshot() {
  const listing=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'});
  if(listing.status!==0)throw Error('Cannot record tested implementation');
  const files={};
  for(const file of [...new Set(listing.stdout.split('\0'))].filter(file=>/^(src\/|public\/office\/|vendor\/|package(?:-lock)?\.json$|vite\.config\.)/.test(file)).sort()){
    const full=path.join(root,file);if(fs.existsSync(full)&&fs.statSync(full).isFile())files[file]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return {sha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),files};
}
report.implementation=implementationSnapshot();
report.environment={node:process.version,platform:process.platform,arch:process.arch,headless:true};
let server, browser, page, currentId = '', currentPhase = '';
function persist() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report,null,2)); }
function inspect(file) {
  const result = spawnSync(process.env.COMPAT_PYTHON || 'python3', [path.join(__dirname,'inspect-output.py'), file], {encoding:'utf8',maxBuffer:24*1024*1024,timeout:60000});
  if (result.error) throw result.error;
  let value; try { value = JSON.parse(result.stdout); } catch { throw Error('Independent inspector did not return JSON: ' + result.stderr.slice(0,300)); }
  if (![0,2].includes(result.status)) throw Error('Independent inspection rejected file: ' + JSON.stringify(value).slice(0,500));
  return value;
}
const { checkAssertions } = require('./assertions.cjs');
fs.writeFileSync(path.join(harness,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><base href="/"><link rel="icon" href="data:,"><style>html,body,#app{width:100%;height:100%;margin:0}.qa-head{height:32px;background:#183e4a;color:white;padding:5px 14px;box-sizing:border-box;font:14px system-ui}.qa-editor{height:calc(100% - 32px)}</style></head><body><div id="app"></div><script type="module" src="${route}/main.js"></script></body></html>`);
fs.writeFileSync(path.join(harness,'main.js'),`
import {createApp,h,ref,shallowRef,nextTick} from 'vue';
import OfficeEditor from '/src/components/OfficeEditor.vue';
import {writerCommandTarget} from '/src/word/types.ts';
const model=shallowRef(null),editor=ref(null),locked=ref(false);let pending=null,serial=0;
async function transaction(fn){if(locked.value)throw Error('Overlapping operation');locked.value=true;try{document.activeElement?.blur?.();await nextTick();return await fn()}finally{locked.value=false}}
function ready(){if(pending?.id===model.value?.id){clearTimeout(pending.timer);pending.resolve();pending=null}}
function error(message){if(pending){clearTimeout(pending.timer);pending.reject(Error(message));pending=null}void window.compatError(message)}
createApp({setup:()=>()=>[h('header',{class:'qa-head'},model.value?.name || 'Office compatibility laboratory'),h('main',{class:'qa-editor',inert:locked.value},model.value?h(OfficeEditor,{ref:editor,document:model.value,smokeMode:true,onReady:ready,onError:error}):null)]}).mount('#app');
window.compat={
 async load(input){let done;await transaction(async()=>{if(model.value&&editor.value)await editor.value.discardChanges({force:true});const id='compat-'+(++serial);done=new Promise((resolve,reject)=>{pending={id,resolve,reject,timer:setTimeout(()=>{pending=null;reject(Error('Document open exceeded 150 seconds'))},150000)}});model.value={...input,id,sha256:'',sizeBytes:Math.floor(input.base64.length*.75)}});await nextTick();await done;return this.state()},
 async state(){const kind=model.value.kind;return kind==='word'?editor.value.getWriterState():kind==='sheet'?editor.value.getCalcState():editor.value.getPresentationState()},
 async audit(){const iframe=document.querySelector('.office-frame'),url=new URL(iframe.src),session=new URLSearchParams(url.hash.slice(1)).get('session'),requestId='compat-offline-'+(++serial);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Offline audit timeout'))},20000);function receive(event){const value=event.data;if(event.origin!==location.origin||event.source!==iframe.contentWindow||value?.channel!=='open-office-engine'||value.session!==session||value.requestId!==requestId)return;clearTimeout(timer);removeEventListener('message',receive);value.ok?resolve(value.data):reject(Error(value.error))}addEventListener('message',receive);iframe.contentWindow.postMessage({channel:'open-office-engine',session,requestId,action:'offline-audit',documentId:model.value.id,data:{}},location.origin)})},
 async edit(marker){return transaction(async()=>{const kind=model.value.kind;if(kind==='word'){const state=await editor.value.getWriterState();if(!state.selection.collapsed)throw Error('Refusing to overwrite an imported selection');return editor.value.writerCommand({action:{type:'insert-text',text:marker+'\\n',replaceSelection:false},target:writerCommandTarget(state)})}if(kind==='sheet'){await editor.value.calcAction({type:'add-sheet',name:'CompatEdit'});return editor.value.calcAction({type:'patch-cells',cells:[{address:'A1',kind:'text',value:marker}]})}const state=await editor.value.getPresentationState();return editor.value.presentationAction({type:'set-notes',pageIndex:state.currentPageIndex,text:state.currentPage.notes+'\\n'+marker})})},
 async save(format){return transaction(async()=>{const value=await editor.value.exportFile({format});if(format!=='pdf')await editor.value.markSaved();return value})},
 async cells(sheetIndex,range){return editor.value.calcData({type:'range',sheetIndex,range})},
 async showcase(){if(model.value.kind==='sheet')return editor.value.calcAction({type:'select-sheet',sheetIndex:0});if(model.value.kind==='presentation')return editor.value.presentationAction({type:'select-page',pageIndex:0})}
};
`);
async function launch() {
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  report.environment.chromium=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const origin='http://127.0.0.1:'+server.config.server.port;
  await context.route('**/*',async route=>{const url=route.request().url();if(/^https?:/.test(url)&&new URL(url).origin!==origin){report.externalRequests.push({case:currentId,phase:currentPhase,url});await route.abort('blockedbyclient')}else await route.continue()});
  page=await context.newPage();
  page.on('pageerror',error=>report.pageErrors.push({case:currentId,phase:currentPhase,message:error.message}));
  await page.exposeFunction('compatError',message=>{report.pageErrors.push({case:currentId,phase:currentPhase,message})});
  await page.goto(origin+route+'/index.html');await page.waitForFunction(()=>window.compat);
  if(!await page.evaluate(()=>crossOriginIsolated))throw Error('Office test must be cross-origin isolated');
}
async function evaluate(method,args=[]) {return page.evaluate(({method,args})=>window.compat[method](...args),{method,args});}
function phase(label){currentPhase=label;console.log(new Date().toISOString(),currentId,label)}
(async()=>{try{
 const {createServer}=await import('vite');
 server=await createServer({root,cacheDir:path.join(out,'vite-cache'),server:{host:'127.0.0.1',port:5292,strictPort:true,hmr:false,watch:{ignored:['**/*']}}});
 server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__native-smoke/'))return next();req.resume();res.statusCode=204;res.end()});
 await server.listen();await launch();
 for(const fixture of fixtures){
  currentId=fixture.id;const item={id:fixture.id,format:fixture.format,provenance:fixture.provenance,branches:[],failures:[],startedAt:new Date().toISOString()};report.cases.push(item);persist();
  const directory=path.join(out,fixture.id);fs.mkdirSync(directory,{recursive:true});
  try{
   const sourcePath=path.resolve(__dirname,fixture.path);if(!sourcePath.startsWith(__dirname+path.sep))throw Error('Invalid fixture path');
   const bytes=fs.readFileSync(sourcePath),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
   if(sha256!==fixture.sha256)throw Error('Fixture SHA256 does not match pinned corpus');
   const original={kind:fixture.kind,extension:fixture.format,name:path.basename(sourcePath),base64:bytes.toString('base64')};
   item.sourceInspection=inspect(sourcePath);fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify(item.sourceInspection,null,2));
   if(item.sourceInspection.inspection==='parsed'){
    item.sourceChecks=checkAssertions(item.sourceInspection,fixture.assertions||{},null);
    if(item.sourceChecks.some(check=>!check.ok))throw Error('Fixture assertions do not match original independent readback; correct the corpus before judging the editor');
   }
   const formats=process.env.COMPAT_MODERN_ONLY==='1'?[modern[fixture.kind]]:[modern[fixture.kind],openDocument[fixture.kind]];
   for(const format of formats){const branch={format,cycles:[],failures:[]};item.branches.push(branch);let input=original;
    try{
     for(let cycle=1;cycle<=cycles;cycle++){
      const result={cycle,checks:[]};branch.cycles.push(result);phase(format+':'+cycle+':import');
      result.importedState=await evaluate('load',[input]);
      if(cycle>1)branch.cycles[cycle-2].reopened=true;
      if(cycle===1&&format===formats[0]){
       item.offlineAudit=await evaluate('audit');const audit=item.offlineAudit;
       if(audit.missingDisabled?.length||audit.forbiddenMenuCommands?.length||!audit.localSavePresent||!audit.updatesDisabled||!audit.macrosDisabled||audit.dispatches?.length!==5||audit.dispatches.some(item=>!item.disabled))throw Error('Native offline audit failed');
       await page.screenshot({path:path.join(directory,'import.png')});
      }
      const marker='COMPAT-EDIT-'+fixture.id;
      if(cycle===2){phase(format+':'+cycle+':edit');result.editedState=await evaluate('edit',[marker])}
      phase(format+':'+cycle+':save');const exported=await evaluate('save',[format]);
      const file=path.join(directory,format+'-cycle-'+cycle+'.'+format);fs.writeFileSync(file,Buffer.from(exported.base64,'base64'));
      const info=inspect(file);fs.writeFileSync(file+'.json',JSON.stringify(info,null,2));
      result.checks=checkAssertions(info,fixture.assertions||{},cycle>=2?marker:null);
      result.preservation=compareInspections(item.sourceInspection,info,{cycle,expectedEditMarker:cycle>=2?marker:undefined});
      result.featureChanges=Object.entries(item.sourceInspection.features||{}).filter(([name,value])=>typeof value==='number'&&value>0&&typeof info.features?.[name]==='number'&&info.features[name]!==value).map(([name,before])=>({name,before,after:info.features[name]}));
      result.inspection=path.relative(out,file+'.json');result.bytes=fs.statSync(file).size;
      result.ok=result.checks.every(check=>check.ok)&&result.preservation.status!=='fail';
      result.status=!result.ok?'fail':result.preservation.status==='review'?'review':'pass';persist();
      input={...original,extension:format,name:path.basename(file),base64:exported.base64};
     }
     // The last saved bytes must be loaded as well; three exports alone are not
     // three complete save/reopen cycles.
     phase(format+':final-reopen');branch.finalState=await evaluate('load',[input]);branch.cycles.at(-1).reopened=true;
     const pdf=await evaluate('save',['pdf']);const pdfPath=path.join(directory,format+'-final.pdf');fs.writeFileSync(pdfPath,Buffer.from(pdf.base64,'base64'));branch.pdfInspection=inspect(pdfPath);
     if(!(branch.pdfInspection.pdf?.pageCount>0))branch.failures.push('PDF has no independently readable pages');
     await evaluate('showcase');await page.screenshot({path:path.join(directory,format+'-final.png')});
    }catch(error){branch.failures.push(String(error.stack||error));console.error(fixture.id,format,error.message);await page.screenshot({path:path.join(directory,format+'-failure.png')}).catch(()=>{});await browser.close();await launch()}
    branch.ok=branch.cycles.length===cycles&&branch.cycles.every(cycle=>cycle.ok)&&branch.failures.length===0;
    branch.status=!branch.ok?'fail':branch.cycles.some(cycle=>cycle.status==='review')?'review':'pass';persist();
   }
  }catch(error){item.failures.push(String(error.stack||error));console.error(fixture.id,error.message)}
  item.ok=item.branches.length>0&&item.branches.every(branch=>branch.ok)&&item.failures.length===0;
  item.status=!item.ok?'fail':item.branches.some(branch=>branch.status==='review')?'review':'pass';item.finishedAt=new Date().toISOString();persist();
 }
 report.implementationUnchanged=implementationSnapshot().sha256===report.implementation.sha256;
 report.finishedAt=new Date().toISOString();report.ok=report.implementationUnchanged&&report.cases.every(item=>item.status==='pass')&&!report.externalRequests.length&&!report.pageErrors.length;
 const branches=report.cases.flatMap(item=>item.branches),saved=branches.flatMap(branch=>branch.cycles);
 report.summary={fixtures:report.cases.length,passed:report.cases.filter(item=>item.status==='pass').length,needsReview:report.cases.filter(item=>item.status==='review').length,failed:report.cases.filter(item=>!item.ok).length,attemptedCycles:saved.length,savedCycles:saved.filter(cycle=>cycle.inspection).length,reopenedCycles:saved.filter(cycle=>cycle.reopened).length,completeCycles:saved.filter(cycle=>cycle.ok&&cycle.reopened).length,reopenedBranches:branches.filter(branch=>branch.finalState).length,externalRequests:report.externalRequests.length,pageErrors:report.pageErrors.length};
 console.log('COMPATIBILITY',JSON.stringify(report.summary));if(!report.ok)process.exitCode=1;
}catch(error){report.ok=false;report.error=String(error.stack||error);console.error(error);process.exitCode=1}
finally{persist();await browser?.close();await server?.close();fs.rmSync(harness,{recursive:true,force:true});console.log('REPORT',path.join(out,'report.json'))}})();
