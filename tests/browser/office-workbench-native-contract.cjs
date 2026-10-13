const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Execute the same Word/Calc checks used by the release WebViews through the
// actual permanent Vue OfficeEditor, bundled WASM and independent PDF backend.
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'test-results/office-workbench-native-contract');
const harness = path.join(out, 'harness');
fs.mkdirSync(harness, { recursive: true });
const route = '/' + path.relative(root, harness).replaceAll(path.sep, '/');
const report = { scope: 'Actual Vue OfficeEditor, bundled WASM, release Word/Calc helper and PyMuPDF PDF readback', phases: [], pageErrors: [] };
let server, browser, page, deadline, phase = 'startup';
let rejectFatal;
const fatal = new Promise((_, reject) => { rejectFatal = reject; });
void fatal.catch(() => {});
const fail = message => rejectFatal(Error(`${phase}: ${message}`));
fs.writeFileSync(path.join(harness, 'index.html'), `<!doctype html><html><head><base href="/"><link rel="icon" href="data:,"><style>html,body,#app{width:100%;height:100%;margin:0}body{font:14px system-ui}#qa-status{height:30px;padding:5px 16px;box-sizing:border-box;background:#254b42;color:#fff}.qa-editor{height:calc(100% - 30px);overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="${route}/main.js"></script></body></html>`);
fs.writeFileSync(path.join(harness, 'main.js'), `
import {createApp,h,ref,shallowRef,nextTick} from 'vue';
import OfficeEditor from '/src/components/OfficeEditor.vue';
import {verifyNativeWord,verifyNativeCalc,pdfReadbackText} from '/src/office/native-workbench-smoke.ts';
import {requestPdf} from '/src/pdf/protocol.ts';
const model=shallowRef(null),editor=ref(null),status=ref('Ready');let readyWaiter,serial=0;
async function phase(label){status.value=label;await window.qaPhase(label)}
function onReady(){if(readyWaiter?.id===model.value?.id){const task=readyWaiter;readyWaiter=null;clearTimeout(task.timer);task.resolve()}}
function onError(message){if(readyWaiter){const task=readyWaiter;readyWaiter=null;clearTimeout(task.timer);task.reject(Error(message))}void window.qaFailure(message)}
function wrapped(){return new Proxy(editor.value,{get(target,name){const value=target[name];if(typeof value!=='function')return value;return async(...args)=>{const detail=/Action$|Data$/.test(name)?':'+args[0]?.type:name==='exportFile'?':'+args[0]?.format:'';await phase(String(name)+detail);const result=await value.apply(target,args);await phase(String(name)+detail+':complete');return result}}})}
async function load(kind,base64=''){
 if(editor.value&&model.value){await editor.value.exportFile();await editor.value.discardChanges()}
 const id='office-contract-'+(++serial),extension=kind==='word'?'docx':'xlsx';
 await phase(kind+(base64?':reopen':':create'));
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{readyWaiter=null;reject(Error('Editor startup exceeded 240 seconds'))},240000);readyWaiter={id,resolve,reject,timer}});
 model.value={id,kind,extension,name:'Native '+kind+'.'+extension,base64,sha256:'',sizeBytes:Math.floor(base64.length*.75)};
 await nextTick();await ready;return wrapped()
}
async function inspectPdf(base64){const first=await requestPdf('inspect',base64,{pageIndices:[0]});const pageCount=first.metadata?.pageCount||0;if(!pageCount||pageCount>20)throw Error('Unexpected PDF size');let text=pdfReadbackText(first.textBlocks||[]);for(let pageIndex=1;pageIndex<pageCount;pageIndex++){const page=await requestPdf('inspect',base64,{pageIndices:[pageIndex]});text+='\\n'+pdfReadbackText(page.textBlocks||[])}await window.qaPdfReadback({base64,pageCount,text});return {pageCount,text}}
createApp({setup:()=>()=>[h('div',{id:'qa-status'},status.value),h('main',{class:'qa-editor'},model.value?h(OfficeEditor,{ref:editor,document:model.value,smokeMode:true,onReady,onError}):null)]}).mount('#app');
window.qa={async run(){const word=await verifyNativeWord({create:()=>load('word'),reopen:base64=>load('word',base64),inspectPdf});await window.qaCapture('word-verified');await phase('word:passed');const sheet=await verifyNativeCalc({create:()=>load('sheet'),reopen:base64=>load('sheet',base64),inspectPdf});await window.qaCapture('sheet-verified');await phase('sheet:passed');return {word,sheet}}};
`);

(async () => {
  try {
    const { createServer } = await import('vite');
    server = await createServer({ root, cacheDir: path.join(out, 'vite-cache'), server: { host: '127.0.0.1', port: 5291, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } } });
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/__native-smoke/')) return next();
      let body = '';
      req.on('data', chunk => { if (body.length < 65536) body += chunk; });
      req.on('end', () => { try { const item = JSON.parse(body); if (item.ok === false) fail(item.error || item.phase); } catch {} res.statusCode = 204; res.end(); });
    });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => { report.pageErrors.push({ phase, error: error.message }); fail(error.message); });
    await page.exposeFunction('qaPhase', label => { phase = label; report.phases.push({ phase, at: new Date().toISOString() }); console.log('PHASE', phase); });
    await page.exposeFunction('qaFailure', message => { report.pageErrors.push({ phase, error: message }); fail(message); });
    await page.exposeFunction('qaPdfReadback', ({ base64, pageCount, text }) => {
      const index = (report.pdfReadbacks ||= []).length;
      fs.writeFileSync(path.join(out, `readback-${index}.pdf`), Buffer.from(base64, 'base64'));
      report.pdfReadbacks.push({ pageCount, text });
    });
    await page.exposeFunction('qaCapture', name => page.screenshot({ path: path.join(out, name + '.png') }));
    await page.goto('http://127.0.0.1:5291' + route + '/index.html');
    await page.waitForFunction(() => window.qa);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    deadline = setTimeout(() => fail('Word/Calc release checks exceeded 8 minutes'), 480000);
    report.result = await Promise.race([page.evaluate(() => window.qa.run()), fatal]);
    assert.equal(report.result.word.ok, true); assert.equal(report.result.sheet.ok, true);
    const { validateOfficeWorkbenches } = await import('../../scripts/native-smoke.mjs');
    report.releaseContract = validateOfficeWorkbenches({ wordWorkbench: report.result.word, sheetWorkbench: report.result.sheet });
    assert.equal(await page.locator('.office-frame').count(), 1);
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log('PASS Word and Calc release workbench helpers');
  } catch (error) {
    report.ok = false; report.failedPhase = phase; report.error = String(error.stack || error);
    console.error(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    clearTimeout(deadline);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await server?.close(); fs.rmSync(harness, { recursive: true, force: true });
  }
})();
