const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Actual Vue components and PDF.js rendering, isolated from the Office WASM
// engine. PDF.js methods below are observed, never replaced with fake results.
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PDF_MEMORY_QA_OUTPUT || path.join(root, 'test-results/pdf-memory'));
const harness = path.join(out, 'harness');
fs.mkdirSync(harness, { recursive: true });
const fixturePath = '/' + path.relative(root, harness).replaceAll(path.sep, '/');
const report = { scope: 'Actual PDF editor + PDF.js resource lifecycle, with browser preview backend', checks: [], failures: [], pageErrors: [] };
let server, browser, page;

function makePdf(count, width = 612, height = 792) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  for (let index = 0; index < count; index++) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    const content = `${index % 2 ? '0.15 0.6 0.2' : '0.8 0.15 0.1'} rg 0 0 ${width} ${height} re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`;
  let text = '%PDF-1.7\n', offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text).toString('base64');
}
const pdf64 = makePdf(100);
fs.writeFileSync(path.join(harness, 'index.html'), `<!doctype html><html><head><base href="/"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="${fixturePath}/main.js"></script></body></html>`);
fs.writeFileSync(path.join(harness, 'main.js'), `
import {createApp,h,shallowRef,nextTick} from 'vue';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import PdfEditor from '/src/components/PdfEditor.vue';
import {MAX_CANVAS_PIXELS,MAX_CANVAS_DIMENSION} from '/src/pdf/resources.ts';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const state=shallowRef(null);
window.qa={ready:0,errors:[],cleanups:[],destroys:0,cancelledThumbnails:0,holdThumbnails:false,held:[],MAX_CANVAS_PIXELS,MAX_CANVAS_DIMENSION,
 async mount(document){state.value=null;await nextTick();state.value=document;await nextTick()},
 async unmount(){state.value=null;await nextTick()},
 resumeThumbnails(){this.holdThumbnails=false;for(const item of this.held.splice(0))if(!item.cancelled)item.continue()}};
const calibration=pdfjs.getDocument({data:Uint8Array.from(atob('${makePdf(1)}'),c=>c.charCodeAt(0))});
const sample=await calibration.promise, samplePage=await sample.getPage(1);
const loadingPrototype=Object.getPrototypeOf(calibration),originalDestroy=loadingPrototype.destroy;
loadingPrototype.destroy=function(...args){window.qa.destroys++;return originalDestroy.apply(this,args)};
const pagePrototype=Object.getPrototypeOf(samplePage),originalCleanup=pagePrototype.cleanup,originalRender=pagePrototype.render;
pagePrototype.cleanup=function(...args){const result=originalCleanup.apply(this,args);window.qa.cleanups.push({page:this.pageNumber,result});return result};
pagePrototype.render=function(options){
 const task=originalRender.call(this,options);
 if(options.canvas?.closest('.pdf-thumbnail-list')){
  const item={cancelled:false,continue:null},cancel=task.cancel;
  task.cancel=function(...args){if(!item.cancelled)window.qa.cancelledThumbnails++;item.cancelled=true;return cancel.apply(this,args)};
  task.onContinue=continuation=>{if(window.qa.holdThumbnails){item.continue=continuation;window.qa.held.push(item)}else continuation()};
 }
 return task;
};
await calibration.destroy();window.qa.destroys=0;
createApp({setup:()=>()=>state.value?h(PdfEditor,{document:state.value,onReady(){window.qa.ready++},onError(message){window.qa.errors.push(message)}}):null}).mount('#app');
window.qa.booted=true;
`);

async function check(name, work) {
  try { await work(); report.checks.push(name); console.log('PASS', name); }
  catch (error) { report.failures.push({ name, error: String(error.stack || error) }); console.error('FAIL', name, error); }
}
async function mount(base64 = pdf64) {
  const before = await page.evaluate(async base64 => {
    const count = window.qa.ready;
    await window.qa.mount({ id: crypto.randomUUID(), name: 'Memory regression.pdf', extension: 'pdf', kind: 'pdf', base64, sizeBytes: base64.length * .75, sha256: '' });
    return count;
  }, base64);
  await page.waitForFunction(before => window.qa.ready > before, before);
  await idle();
}
async function idle() {
  await page.waitForFunction(() => !document.querySelector('[data-testid="pdf-busy"]') && !document.querySelector('.pdf-render-indicator') && document.querySelector('[data-testid="pdf-canvas"]')?.width > 1);
}
async function waitForThumb(index) {
  await page.waitForFunction(index => {
    const canvas = document.querySelector('[data-testid="pdf-page-' + index + '"] canvas');
    if (!canvas || canvas.width < 2) return false;
    const pixel = canvas.getContext('2d').getImageData(10, 10, 1, 1).data;
    return pixel[3] === 255 && pixel[0] !== 0;
  }, index);
}
async function scrollThumbnails(fraction) {
  await page.locator('.pdf-thumbnail-list').evaluate((element, fraction) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction;
    element.dispatchEvent(new Event('scroll'));
  }, fraction);
}
async function thumbAllocation() {
  return page.locator('.pdf-thumbnail-list canvas').evaluateAll(canvases => ({
    count: canvases.filter(canvas => canvas.width > 1 || canvas.height > 1).length,
    pixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
  }));
}

(async () => {
  try {
    const { createServer } = await import('vite');
    const { default: vue } = await import('@vitejs/plugin-vue');
    server = await createServer({ root, configFile: false, plugins: [vue()], cacheDir: path.join(out, 'vite-cache'), publicDir: path.join(root, 'public'),
      define: { 'import.meta.env.DEV': 'false' },
      server: { host: '127.0.0.1', port: Number(process.env.PDF_MEMORY_QA_PORT || 5291), strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
      optimizeDeps: { include: ['vue', 'pdfjs-dist/legacy/build/pdf.mjs'] } });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${fixturePath}/index.html`);
    await page.waitForFunction(() => window.qa?.booted);

    await check('A 100-page PDF allocates thumbnail pixels only near the visible viewport', async () => {
      await mount(); await waitForThumb(1);
      const initial = await thumbAllocation();
      report.thumbnailSamples = [{ position: 'start', ...initial }];
      assert.ok(initial.count > 0 && initial.count < 12, JSON.stringify(initial));
      assert.ok(initial.pixels < 500_000, JSON.stringify(initial));
      for (const fraction of [.2, .4, .6, .8, 1]) {
        await scrollThumbnails(fraction);
        await page.waitForFunction(() => {
          const list = document.querySelector('.pdf-thumbnail-list'), box = list.getBoundingClientRect();
          return [...list.querySelectorAll('canvas')].some(canvas => canvas.getBoundingClientRect().top > box.top && canvas.getBoundingClientRect().bottom < box.bottom && canvas.width > 1);
        });
        const current = await thumbAllocation();
        report.thumbnailSamples.push({ position: fraction, ...current });
        assert.ok(current.count < 12 && current.pixels < 500_000, JSON.stringify(current));
      }
      await waitForThumb(100);
      assert.deepEqual(await page.getByTestId('pdf-page-1').locator('canvas').evaluate(canvas => [canvas.width, canvas.height]), [1, 1]);
      await scrollThumbnails(0); await waitForThumb(1);
      assert.deepEqual(await page.getByTestId('pdf-page-100').locator('canvas').evaluate(canvas => [canvas.width, canvas.height]), [1, 1]);
      report.thumbnailSamples.push({ position: 'return', ...await thumbAllocation() });
      report.thumbnailPeakSample = { count: Math.max(...report.thumbnailSamples.map(sample => sample.count)), pixels: Math.max(...report.thumbnailSamples.map(sample => sample.pixels)) };
    });
    await check('Hiding the page list or selecting outline releases all thumbnail backing stores', async () => {
      await mount(); await waitForThumb(1);
      await page.getByRole('button', { name: '页面列表', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.pdf-thumbnail-list canvas')].every(canvas => canvas.width === 1 && canvas.height === 1));
      await page.getByRole('button', { name: '页面列表', exact: true }).click(); await waitForThumb(1);
      await page.getByTestId('pdf-outline-tab').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.pdf-thumbnail-list canvas')].every(canvas => canvas.width === 1 && canvas.height === 1));
      await page.locator('.pdf-sidebar-tabs').getByRole('button', { name: '页面', exact: true }).click(); await waitForThumb(1);
    });
    await check('Leaving the thumbnail viewport cancels pending rendering and can repaint on return', async () => {
      await page.evaluate(() => { window.qa.holdThumbnails = true; window.qa.held = []; });
      await mount(); await page.waitForFunction(() => window.qa.held.length > 0);
      const before = await page.evaluate(() => window.qa.cancelledThumbnails);
      await scrollThumbnails(1);
      await page.waitForFunction(before => window.qa.cancelledThumbnails > before, before);
      await page.evaluate(() => window.qa.resumeThumbnails());
      await waitForThumb(100);
      await scrollThumbnails(0); await waitForThumb(1);
    });
    await check('Completed PDF page rendering requests page cache cleanup', async () => {
      const before = await page.evaluate(() => window.qa.cleanups.length);
      await mount(makePdf(2)); await waitForThumb(1);
      await page.getByTestId('pdf-page-2').click(); await idle();
      await page.waitForFunction(before => window.qa.cleanups.slice(before).some(call => call.page === 2 && call.result === true), before);
      const rgb = await page.getByTestId('pdf-canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]);
      assert.ok(rgb[1] > 120 && rgb[0] < 80, `${rgb}`);
    });
    await check('Large PDF zoom respects pixel and dimension budgets without changing document layout', async () => {
      await mount(makePdf(1, 5000, 8000));
      for (let index = 0; index < 12; index++) await page.getByRole('button', { name: '放大 PDF', exact: true }).click();
      await idle();
      const allocation = await page.getByTestId('pdf-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height, maxPixels: window.qa.MAX_CANVAS_PIXELS, maxDimension: window.qa.MAX_CANVAS_DIMENSION }));
      report.largePageAllocation = allocation;
      assert.ok(allocation.width * allocation.height <= allocation.maxPixels, JSON.stringify(allocation));
      assert.ok(Math.max(allocation.width, allocation.height) <= allocation.maxDimension, JSON.stringify(allocation));
      assert.ok(allocation.cssWidth > allocation.width && allocation.cssHeight > allocation.height, JSON.stringify(allocation));
    });
    await check('Unmount clears retained main and thumbnail canvases and destroys its PDF task', async () => {
      await mount(); await waitForThumb(1);
      const before = await page.evaluate(() => {
        window.retainedCanvases = [...document.querySelectorAll('.pdf-editor canvas')];
        return window.qa.destroys;
      });
      await page.evaluate(() => window.qa.unmount());
      await page.waitForFunction(before => window.qa.destroys > before && window.retainedCanvases.every(canvas => canvas.width === 1 && canvas.height === 1), before);
    });
    await check('Rejected PDF loading destroys its worker task while the error view remains open', async () => {
      const before = await page.evaluate(() => window.qa.destroys);
      await page.evaluate(base64 => window.qa.mount({ id: crypto.randomUUID(), name: 'Invalid.pdf', extension: 'pdf', kind: 'pdf', base64, sizeBytes: 8, sha256: '' }), Buffer.from('not a pdf').toString('base64'));
      await page.getByTestId('pdf-error').waitFor();
      await page.waitForFunction(before => window.qa.destroys > before, before);
      assert.equal(await page.getByTestId('pdf-editor').count(), 1);
    });
  } catch (error) { report.failures.push({ name: 'test harness', error: String(error.stack || error) }); console.error(error); }
  finally {
    report.ok = !report.failures.length && !report.pageErrors.length;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await server?.close();
    if (!report.ok) process.exitCode = 1;
  }
})();
