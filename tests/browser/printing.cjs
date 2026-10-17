/* Real Vue shell, notebook/workflow components and shared printing service in Chromium.
 * Native printing is stubbed. Four editor adapters use deterministic session
 * exports at the Rust boundary; the available presentation WASM is also exercised.
 * No build step is run and this is not an operating-system print-dialog test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_PRINT_OUTPUT || path.join(root, 'test-results/printing'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], consoleErrors: [], pdfs: [], limitations: ['Native printer dialogs and physical printing are stubbed, not validated on macOS.', 'Word, sheet, presentation and PDF component adapter tests use prepared session stubs returning independently generated PDF bytes; only the additional presentation check loads a real Rust engine.', 'Browser PDF viewer behavior is browser-specific.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let server, browser, page;
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function tick() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ready(kind) { await page.waitForFunction(kind => { const a = document.querySelector('#app')?.__vue_app__?._instance.setupState; return a && !a.busy && a.active?.ready && a.active.document.kind === kind; }, kind, { timeout: 90000 }); }
async function q(values) { await page.evaluate(values => Object.assign(window.__printQa, values), values); }
async function idle() { await page.waitForFunction(() => !document.querySelector('#app')?.__vue_app__?._instance.setupState.busy); }
async function printClick() { await page.getByTestId('shell-print').click(); await idle(); }
async function newDocument(kind) { await page.evaluate(kind => document.querySelector('#app').__vue_app__._instance.setupState.newDocument(kind), kind); await ready(kind); }
async function recordPdf(bytes, filename, minPages = 1) {
 const pdf = await PDFDocument.load(bytes); assert.ok(pdf.getPageCount() >= minPages); fs.writeFileSync(path.join(output, filename), bytes);
 report.pdfs.push({ file: filename, bytes: bytes.length, pages: pdf.getPageCount() }); persist(); return pdf;
}
const nativeStub = `
export {bytesToBase64,base64ToBytes} from '/src/shared/document.ts';
window.__printQa={native:true,html:[],pdf:[],status:'completed',error:'',hold:false,release:null,nextOpen:null,decodeHold:false,decodeWaiters:[],decodes:0};
const q=window.__printQa;
export const isTauri=()=>q.native;
export const bootstrap=async()=>({origin:location.origin,basePath:'/',platform:'print-browser-stub',smokeMode:false});
export const listRecentDocuments=async()=>[];
export const onCloseRequested=async()=>()=>{};
export const openDocument=async()=>{const value=q.nextOpen;q.nextOpen=null;return value;};
export const openRecent=async()=>{throw Error('Unexpected openRecent');};
export const pickImage=async()=>null;
export const clipboardImages=async()=>[];
export const confirmClose=async()=>{};
export const saveDocument=async()=>{throw Error('Printing must not save the document');};
async function outcome(){if(q.hold)await new Promise(resolve=>q.release=resolve);if(q.error)throw Error(q.error);return {status:q.status};}
export async function printPdf(base64,title){q.pdf.push({base64,title});return outcome();}
export async function printHtml(){const root=document.querySelector('#office-print-root');q.html.push({title:document.title,html:root?.outerHTML,text:root?.textContent,images:[...root.querySelectorAll('img')].map(i=>({complete:i.complete,width:i.naturalWidth})),decodes:q.decodes});return outcome();}
const decode=HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode=async function(){q.decodes++;if(q.decodeHold)await new Promise(resolve=>q.decodeWaiters.push(resolve));return decode.call(this);};
`;
(async () => {
 try {
  const sample = await PDFDocument.create(), font = await sample.embedFont(StandardFonts.Helvetica);
  sample.addPage([400, 300]).drawText('Independent print adapter payload', { x: 20, y: 240, size: 16, font });
  sample.addPage([400, 300]).drawText('Second printable page', { x: 20, y: 240, size: 16, font });
  const sampleBytes = await sample.save(), sampleBase64 = Buffer.from(sampleBytes).toString('base64');
  const { createServer } = await import('vite');
  const harness = `import {createApp,h,ref} from 'vue';import Word from '/src/components/RustWordEditor.vue';import Sheet from '/src/components/RustSheetEditor.vue';import Presentation from '/src/components/RustPresentationEditor.vue';import Pdf from '/src/components/RustPdfEditor.vue';import '/src/style.css';
  const components={word:Word,sheet:Sheet,presentation:Presentation,pdf:Pdf};window.__adapters={};window.__adapterCalls=[];window.__adapterError='';window.__adapterHold=false;window.__adapterRelease=null;
  const bytes=Uint8Array.from(atob('${sampleBase64}'),c=>c.charCodeAt(0));
  for(const kind of Object.keys(components)){
   const reference=ref(), element=document.createElement('div');element.id='adapter-'+kind;element.style.cssText='height:160px;display:flex';document.body.append(element);
   const snapshot={documentId:1,revision:4,dirty:true,sessionId:kind,pages:[],sheets:[],slides:[],pageCount:2,ui:{dialog:null,showing:null,home:false}};
   const session={snapshot,subscribe:()=>()=>{},onEvent:()=>()=>{},attach:async()=>{},deactivate:()=>{},close:async()=>{},setInteractive:()=>{},setTemplatePanelOpen:async()=>{},settled:async()=>window.__adapterCalls.push({kind,action:'settled'}),export:async format=>{window.__adapterCalls.push({kind,action:'export',format});if(window.__adapterHold)await new Promise(r=>window.__adapterRelease=r);if(window.__adapterError)throw Error(window.__adapterError);return {bytes:bytes.slice(),snapshot};},canBackgroundExport:async()=>true};
   const extension={word:'docx',sheet:'xlsx',presentation:'pptx',pdf:'pdf'}[kind];const sourceDocument={id:kind,name:kind+' 实际打印内容.'+extension,extension,kind,base64:'',sha256:'',sizeBytes:0};
   const app=createApp({setup:()=>()=>h(components[kind],{ref:reference,document:sourceDocument,prepared:{take:()=>session,discard:()=>{}},active:true,theme:'light'})});app.mount(element);window.__adapters[kind]={reference,app,snapshot};
  }`;
  server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'printing-adapters', resolveId(id) { if (id === '/__printing_adapters__.js') return '\0printing-adapters'; }, load(id) { if (id === '\0printing-adapters') return harness; }, configureServer(instance) { instance.middlewares.use((req,res,next)=>{if(req.url!=='/__printing_adapters__')return next();res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><script type="module" src="/__printing_adapters__.js"></script></body></html>');}); } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/vendor/**','**/target/**','**/test-results/**'] } } });
  await server.listen(); const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1400,height:1000},locale:'zh-CN'});
  await context.route('**/src/native.ts',route=>route.fulfill({contentType:'application/javascript',body:nativeStub}));
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(e.message));page.on('console',e=>{if(e.type()==='error')report.consoleErrors.push(e.text());});
  await page.goto(origin);await page.getByTestId('home-new-note').waitFor();
  await check('service-pdf-preserves-all-bytes-title-and-native-outcome',async()=>{
   const result=await page.evaluate(async base64=>{const p=await import('/src/shared/printing.ts');return p.printPdf(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),'两页打印.pdf');},sampleBase64);
   assert.deepEqual(result,{status:'completed'});const value=await page.evaluate(()=>window.__printQa.pdf.at(-1));assert.equal(value.base64,sampleBase64);assert.equal(value.title,'两页打印.pdf');await recordPdf(Buffer.from(value.base64,'base64'),'service-two-pages.pdf',2);
  });
  await check('service-rejects-invalid-pdf-before-native-call',async()=>{
   const before=await page.evaluate(()=>window.__printQa.pdf.length);const error=await page.evaluate(async()=>{try{await(await import('/src/shared/printing.ts')).printPdf(new TextEncoder().encode('not pdf'),'invalid');return '';}catch(e){return e.message;}});assert.match(error,/PDF/);assert.equal(await page.evaluate(()=>window.__printQa.pdf.length),before);
  });
  await check('preparing-print-is-exclusive-and-failure-cleans-up',async()=>{
   await q({hold:true,error:'打印设备暂时不可用'});await page.evaluate(async()=>{const p=await import('/src/shared/printing.ts');window.__job=p.printHtml({title:'失败路径',css:'',render(d,c){c.append(d.createTextNode('保留到结果'));}}).catch(e=>({error:e.message}));});
   await page.waitForFunction(()=>!!window.__printQa.release);assert.equal(await page.locator('#office-print-root').count(),1);
   const error=await page.evaluate(async()=>{try{await(await import('/src/shared/printing.ts')).printHtml({title:'重复',css:'',render(){}});return '';}catch(e){return e.message;}});assert.match(error,/正在准备|正在打印/);
   await page.evaluate(()=>window.__printQa.release());assert.deepEqual(await page.evaluate(()=>window.__job),{error:'打印设备暂时不可用'});assert.equal(await page.locator('#office-print-root').count(),0);await q({hold:false,error:'',release:null});
  });
  await check('html-waits-for-decode-before-prepare-and-native-print',async()=>{
   const before=await page.evaluate(()=>window.__printQa.html.length);await q({decodeHold:true});await page.evaluate(async png=>{const p=await import('/src/shared/printing.ts');window.__prepared=false;window.__job=p.printHtml({title:'等图片',css:'',render(d,c){const image=d.createElement('img');image.src='data:image/png;base64,'+png;c.append(image);},prepare(){window.__prepared=true;}});},png);
   await page.waitForFunction(()=>window.__printQa.decodeWaiters.length>0);assert.equal(await page.evaluate(()=>window.__prepared),false);assert.equal(await page.evaluate(()=>window.__printQa.html.length),before);
   await page.evaluate(()=>{window.__printQa.decodeHold=false;window.__printQa.decodeWaiters.splice(0).forEach(r=>r());});assert.deepEqual(await page.evaluate(()=>window.__job),{status:'completed'});assert.equal(await page.evaluate(()=>window.__prepared),true);assert.equal(await page.locator('#office-print-root').count(),0);
  });
  await check('opened-html-remains-until-afterprint-and-only-content-is-printable',async()=>{
   await q({status:'opened'});await page.evaluate(async()=>{await(await import('/src/shared/printing.ts')).printHtml({title:'独立打印内容',css:'#office-print-root p{color:rgb(10,20,30)}',render(d,c){const p=d.createElement('p');p.textContent='只打印这段内容';c.append(p);}});});
   assert.equal(await page.locator('#office-print-root').count(),1);await page.emulateMedia({media:'print'});
   assert.equal(await page.locator('#app').evaluate(el=>getComputedStyle(el).display),'none');assert.equal(await page.locator('#office-print-root').evaluate(el=>getComputedStyle(el).display),'block');assert.equal(await page.locator('#office-print-root p').innerText(),'只打印这段内容');await page.screenshot({path:path.join(output,'html-print-content-only.png')});
   await page.emulateMedia({media:'screen'});await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));assert.equal(await page.locator('#office-print-root').count(),0);await q({status:'completed'});
  });
  await check('browser-html-uses-main-window-and-retains-source',async()=>{
   await q({native:false});await page.evaluate(async()=>{const original=window.print;window.__browserPrints=0;window.print=()=>{window.__browserPrints++;};try{window.__result=await(await import('/src/shared/printing.ts')).printHtml({title:'浏览器打印',css:'',render(d,c){c.textContent='浏览器正文';}});}finally{window.print=original;}});
   assert.deepEqual(await page.evaluate(()=>window.__result),{status:'opened'});assert.equal(await page.evaluate(()=>window.__browserPrints),1);assert.equal(await page.locator('#office-print-root').count(),1);await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));assert.equal(await page.locator('#office-print-root').count(),0);await q({native:true});
  });
  await check('notebook-print-commits-title-and-pending-body-without-save',async()=>{
   await newDocument('note');await page.getByRole('textbox',{name:'页面标题',exact:true}).fill('打印当前笔记页');const body=page.getByTestId('notebook-content').first();await body.click();await page.keyboard.insertText('正文修改直接进入打印快照');await printClick();
   const printed=await page.evaluate(()=>window.__printQa.html.at(-1));assert.equal(printed.title,'打印当前笔记页');assert.match(printed.text,/正文修改直接进入打印快照/);assert.match(printed.html,/note-print-page/);assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.active.dirty),true);assert.equal(await page.locator('#office-print-root').count(),0);
  });
  await check('shell-print-rejection-shows-error-and-cancellation-shows-status',async()=>{
   await q({error:'测试：打印机连接失败'});await printClick();assert.match(await page.locator('.error-banner').innerText(),/打印机连接失败/);assert.equal(await page.locator('#office-print-root').count(),0);await q({error:'',status:'cancelled'});await printClick();assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.status),'已取消打印');await q({status:'completed'});
  });
  await check('notebook-print-waits-for-its-image-and-retains-region-geometry',async()=>{
   const record=await page.evaluate(async png=>{const m=await import('/src/notes/model.ts');const n=m.createNotebook('图片笔记');n.sections[0].pages[0].title='图片及布局';n.sections[0].pages[0].regions=[{id:m.noteId(),x:600,y:160,width:320,height:200,blocks:[{id:m.noteId(),type:'image',dataUrl:'data:image/png;base64,'+png,alt:'打印图片'}]}];const b=new TextEncoder().encode(JSON.stringify(n));return {id:'image-note',name:'图片笔记.oonote',kind:'note',extension:'oonote',sha256:'test',sizeBytes:b.length,base64:(await import('/src/shared/document.ts')).bytesToBase64(b)};},png);
   await q({nextOpen:record});await page.getByTestId('shell-open').click();await ready('note');const before=await page.evaluate(()=>window.__printQa.html.length);await q({decodeHold:true});await page.getByTestId('shell-print').click();await page.waitForFunction(()=>window.__printQa.decodeWaiters.length>0);assert.equal(await page.evaluate(()=>window.__printQa.html.length),before);
   await page.evaluate(()=>{window.__printQa.decodeHold=false;window.__printQa.decodeWaiters.splice(0).forEach(r=>r());});await idle();const value=await page.evaluate(()=>window.__printQa.html.at(-1));assert.equal(value.images[0].width,1);assert.match(value.html.replace(/\s+/g,''),/left:600px;top:160px;width:320px;height:200px/);assert.match(value.html,/zoom:/);
  });
  await check('canvas-print-waits-for-svg-image-resources',async()=>{
   const record=await page.evaluate(async png=>{const {createDocument}=await import('/src/workflow/core/documents.ts');const doc=createDocument('board');doc.title='画布图片打印';doc.scene.elements.push({id:'print-image',type:'shape',shape:'image',x:50,y:40,width:200,height:140,text:'',imageData:'data:image/png;base64,'+png,locked:false,style:{stroke:'#123456',fill:'#fff',strokeWidth:1,fontSize:16,textAlign:'center',opacity:1,dashed:false}});const b=new TextEncoder().encode(JSON.stringify(doc));return {id:'image-canvas',name:'画布图片打印.owflow',kind:'canvas',extension:'owflow',sha256:'test',sizeBytes:b.length,base64:(await import('/src/shared/document.ts')).bytesToBase64(b)};},png);
   await q({nextOpen:record});await page.getByTestId('shell-open').click();await ready('canvas');const before=await page.evaluate(()=>window.__printQa.html.length);await q({decodeHold:true});await page.getByTestId('shell-print').click();await page.waitForFunction(()=>window.__printQa.decodeWaiters.length>0);assert.equal(await page.evaluate(()=>window.__printQa.html.length),before);
   await page.evaluate(()=>{window.__printQa.decodeHold=false;window.__printQa.decodeWaiters.splice(0).forEach(r=>r());});await idle();const value=await page.evaluate(()=>window.__printQa.html.at(-1));assert.match(value.html,/<svg/);assert.match(value.html,/<image/);
  });
  await check('diagram-print-flushes-current-source-and-keeps-vector-output',async()=>{
   await newDocument('diagram');await page.getByTestId('diagram-source').fill('sequenceDiagram\n participant A as 打印用户\n participant B as 文档服务\n A->>B: 最新源码打印');await printClick();const value=await page.evaluate(()=>window.__printQa.html.at(-1));assert.match(value.html,/<svg/);assert.match(value.text,/最新源码打印/);assert.match(value.text,/打印用户/);assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.active.dirty),true);
  });
  const appPage=page;
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(origin+'/__printing_adapters__');await page.waitForFunction(()=>window.__adapters&&Object.keys(window.__adapters).length===4&&Object.values(window.__adapters).every(a=>a.reference.value));await tick();
  for(const kind of ['word','sheet','presentation','pdf'])await check(kind+'-component-flushes-exports-pdf-and-forwards-exact-content',async()=>{
   const result=await page.evaluate(kind=>window.__adapters[kind].reference.value.print(),kind);assert.deepEqual(result,{status:'completed'});
   const value=await page.evaluate(()=>window.__printQa.pdf.at(-1));assert.equal(value.base64,sampleBase64);assert.match(value.title,new RegExp('^'+kind));assert.deepEqual(await page.evaluate(kind=>window.__adapterCalls.filter(c=>c.kind===kind),kind),[{kind,action:'settled'},{kind,action:'export',format:'pdf'}]);assert.equal(await page.evaluate(kind=>window.__adapters[kind].snapshot.dirty,kind),true);await recordPdf(Buffer.from(value.base64,'base64'),kind+'-adapter-print.pdf',2);
  });
  await check('rust-export-failure-is-propagated-and-does-not-call-printer',async()=>{
   const before=await page.evaluate(()=>window.__printQa.pdf.length);const error=await page.evaluate(async()=>{window.__adapterError='导出失败';try{await window.__adapters.word.reference.value.print();return '';}catch(e){return e.message;}finally{window.__adapterError='';}});assert.equal(error,'导出失败');assert.equal(await page.evaluate(()=>window.__printQa.pdf.length),before);
  });
  await check('rust-document-disposed-during-export-cannot-print-stale-bytes',async()=>{
   const before=await page.evaluate(()=>window.__printQa.pdf.length);await page.evaluate(()=>{window.__adapterHold=true;window.__job=window.__adapters.word.reference.value.print().catch(e=>e.message);});await page.waitForFunction(()=>!!window.__adapterRelease);await page.evaluate(()=>{window.__adapters.word.app.unmount();window.__adapterRelease();});assert.match(await page.evaluate(()=>window.__job),/已切换/);assert.equal(await page.evaluate(()=>window.__printQa.pdf.length),before);
  });
  await page.close();page=appPage;
  if(fs.existsSync(path.join(root,'public/office-presentation/office-presentation_bg.wasm')))await check('available-rust-presentation-engine-prints-real-three-page-pdf',async()=>{
   await newDocument('presentation');const before=await page.evaluate(()=>window.__printQa.pdf.length);await printClick();const values=await page.evaluate(()=>window.__printQa.pdf);assert.equal(values.length,before+1);const value=values.at(-1);await recordPdf(Buffer.from(value.base64,'base64'),'real-presentation-print.pdf',3);assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.active.dirty),true);
  });
  else report.limitations.push('No presentation WASM available; real Rust print export skipped.');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.ok=true;persist();console.log(JSON.stringify({ok:true,checks:report.checks.length,report:path.join(output,'report.json')}));
 }catch(error){report.error=error.stack;persist();console.error(error);process.exitCode=1;}
 finally{await browser?.close();await server?.close();}
})();
