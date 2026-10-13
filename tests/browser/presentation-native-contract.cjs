const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

// The same verifyNativePresentation helper used by release WebViews, exercised
// with a permanent real OfficeEditor and the shipped WASM engine. This browser
// check complements, and does not replace, native release smoke evidence.
const root=path.resolve(__dirname,'../..');
const out=path.resolve(process.env.PRESENTATION_NATIVE_QA_OUTPUT||path.join(root,'test-results/presentation-native-contract'));
const harness=path.join(out,'harness');
fs.mkdirSync(harness,{recursive:true});
const route='/'+path.relative(root,harness).replaceAll(path.sep,'/');
const report={scope:'Real OfficeEditor + bundled WASM + release native-smoke helper + SlidePreview in Chromium',phases:[],diagnostics:[],consoleErrors:[],pageErrors:[]};
let server,browser,page,fatalReject,deadlineTimer,phase='startup';
const fatal=new Promise((_,reject)=>{fatalReject=reject});
void fatal.catch(()=>{});
const failFast=error=>fatalReject(Error(`Fatal engine failure during ${phase}: ${error}`));
fs.writeFileSync(path.join(harness,'index.html'),`<!doctype html><html><head><base href="/"><link rel="icon" href="data:,"><style>html,body,#app{width:100%;height:100%;margin:0}body{font:14px system-ui}#contract-status{height:28px;box-sizing:border-box;padding:4px 16px;background:#21354e;color:white}.contract-editor{height:calc(100% - 28px);overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="${route}/main.js"></script></body></html>`);
fs.writeFileSync(path.join(harness,'main.js'),`
import {createApp,h,ref,shallowRef,nextTick} from 'vue';
import OfficeEditor from '/src/components/OfficeEditor.vue';
import SlidePreview from '/src/components/SlidePreview.vue';
import {verifyNativePresentation} from '/src/presentation/native-smoke.ts';
const documentValue=shallowRef(null),preview=shallowRef(null),editor=ref(null),status=ref('Waiting to run release helper');
let pendingReady=null,number=0;
const phase=async(label)=>{status.value=label;await window.qaPhase(label)};
function onReady(){if(pendingReady?.id===documentValue.value?.id){const pending=pendingReady;pendingReady=null;clearTimeout(pending.timer);pending.resolve()}}
function onError(message){if(pendingReady){const pending=pendingReady;pendingReady=null;clearTimeout(pending.timer);pending.reject(Error(message))}window.qa.errors.push(message);void window.qaError(message)}
const wrapped=()=>new Proxy(editor.value,{get(target,name){const value=target[name];if(typeof value!=='function')return value;return async(...args)=>{const detail=name==='presentationAction'?':'+args[0]?.type:name==='exportFile'?':'+(args[0]?.format||'original'):name==='presentationObjectData'?':'+args[0]?.type:'';await phase(String(name)+detail);const result=await value.apply(target,args);await phase(String(name)+detail+':complete');return result}}});
async function load(base64=''){
 if(editor.value&&documentValue.value){await phase('reopen:export-current');await editor.value.exportFile();await phase('reopen:discard-exported');await editor.value.discardChanges()}
 const id='release-contract-'+(++number);await phase(base64?'reopen:load-document':'create:load-document');
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingReady=null;reject(Error('OfficeEditor ready event timed out after 240 seconds'))},240000);pendingReady={id,resolve,reject,timer}});
 documentValue.value={id,name:'Release contract '+number+'.pptx',kind:'presentation',extension:'pptx',base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)};
 await nextTick();await ready;await phase('document-ready:'+id);return wrapped()
}
createApp({setup:()=>()=>[h('div',{id:'contract-status'},status.value),h('main',{class:'contract-editor'},documentValue.value?h(OfficeEditor,{ref:editor,document:documentValue.value,smokeMode:true,onReady,onError,onStatus:value=>{window.qa.status=value}}):null),preview.value?h(SlidePreview,{...preview.value,onClose:()=>{preview.value=null},onError}):null]}).mount('#app');
window.qa={errors:[],status:'',async run(){await phase('helper:start');const result=await verifyNativePresentation({create:()=>load(),reopen:base64=>load(base64),show:async(base64,presentation)=>{await phase('show:PDF-and-media');preview.value={base64,presentation,name:'Release helper built-in player',startPage:0};await nextTick();const deadline=Date.now()+25000;while(document.querySelector('[data-testid="slide-preview-canvas"]')?.dataset.pageIndex!=='0'||document.querySelector('[data-testid="slide-preview"]')?.dataset.rendering!=='false'){if(Date.now()>deadline)throw Error('Screenshot preparation exceeded 25 seconds');await new Promise(resolve=>setTimeout(resolve,100))}await window.qaCapture('player-first-slide')},close:()=>{preview.value=null;void phase('player:closed')}});await phase('helper:complete');return result}};
`);
(async()=>{try{
 const {createServer}=await import('vite');const {default:vue}=await import('@vitejs/plugin-vue');
 const diagnosticsPlugin={name:'contract-native-diagnostics',configureServer(vite){vite.middlewares.use((request,response,next)=>{
   if(!request.url?.startsWith('/__native-smoke/'))return next();
   let body='';request.on('data',chunk=>{if(body.length<65536)body+=chunk});request.on('end',()=>{try{const value=JSON.parse(body);report.diagnostics.push(value);if(value.ok===false||/unreachable|out of bounds/i.test(value.error||''))failFast(value.error||value.phase)}catch{}response.statusCode=204;response.end()});
 })}};
 server=await createServer({root,configFile:false,cacheDir:path.join(out,'vite-cache'),plugins:[vue(),diagnosticsPlugin],publicDir:path.join(root,'public'),server:{host:'127.0.0.1',port:5290,strictPort:true,hmr:false,watch:{ignored:['**/*']},headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}},optimizeDeps:{include:['vue','fflate','pdfjs-dist/legacy/build/pdf.mjs']}});
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
 page.on('pageerror',error=>{report.pageErrors.push({phase,error:error.message});failFast(error.message)});
 page.on('console',message=>{if(message.type()==='error'){const text=message.text();report.consoleErrors.push({phase,error:text});if(/unreachable|out of bounds|RuntimeError/i.test(text))failFast(text)}});
 await page.exposeFunction('qaPhase',label=>{phase=label;report.phases.push({phase:label,at:new Date().toISOString()});console.log('PHASE',label)});
 await page.exposeFunction('qaError',message=>{report.pageErrors.push({phase,error:message});if(/unreachable|out of bounds|RuntimeError/i.test(message))failFast(message)});
 await page.exposeFunction('qaCapture',name=>page.screenshot({path:path.join(out,name+'.png')}));
 await page.goto('http://127.0.0.1:5290'+route+'/index.html');await page.waitForFunction(()=>window.qa);
 assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 deadlineTimer=setTimeout(()=>failFast('release helper exceeded 8 minutes'),8*60*1000);
 report.result=await Promise.race([page.evaluate(()=>window.qa.run()),fatal]);
 assert.equal(report.result.ok,true);assert.equal(report.result.editableTable,true);assert.equal(report.result.editableChart,true);assert.equal(report.result.pageCount,3);assert.equal(report.result.mediaBytes,3244);
 await page.getByTestId('slide-preview').waitFor({state:'hidden'});assert.equal(await page.locator('.office-frame').count(),1);assert.deepEqual(report.pageErrors,[]);
 await page.screenshot({path:path.join(out,'editor-after-helper.png')});report.ok=true;console.log('PASS native release presentation helper');
}catch(error){report.ok=false;report.failedPhase=phase;report.error=String(error.stack||error);console.error(error);if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1}
finally{clearTimeout(deadlineTimer);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();fs.rmSync(harness,{recursive:true,force:true})}})();
