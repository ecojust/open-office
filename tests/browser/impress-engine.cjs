/* Real bundled WASM regression. Run after preparing the Office assets:
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/impress-engine.cjs
 * No mocked editor, injected UNO implementation, or remote document service.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('playwright')
const project = path.resolve(__dirname, '../..')
const publicRoot = path.join(project, 'public')
const output = path.join(project, 'test-results/impress-engine')
fs.mkdirSync(output, { recursive: true })
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
<iframe id="office" src="office/host.html?smoke=1#session=impress-test"></iframe><script>
window.events=[];window.pending=new Map();window.seq=0;
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==office.contentWindow)return;const m=e.data;if(m.channel!=='open-office-engine'||m.session!=='impress-test')return;
if(m.requestId&&pending.has(m.requestId)){const p=pending.get(m.requestId);pending.delete(m.requestId);clearTimeout(p.timer);m.ok?p.resolve(m.data):p.reject(Error(m.error));}
else events.push(m);});
window.request=(action,data={},documentId='impress-document')=>new Promise((resolve,reject)=>{const requestId='test-'+(++seq);
const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timed out: '+action))},150000);pending.set(requestId,{resolve,reject,timer});
office.contentWindow.postMessage({channel:'open-office-engine',session:'impress-test',requestId,action,data,documentId},location.origin);});
</script>`
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/__native-smoke/')) { req.resume(); res.writeHead(204); return res.end() }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html) }
  const local = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname))
  if (!local.startsWith(publicRoot + path.sep) || !fs.existsSync(local) || !fs.statSync(local).isFile()) { res.writeHead(404); return res.end() }
  const mime = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' }[path.extname(local)] || 'application/octet-stream'
  res.setHeader('Content-Type', mime); fs.createReadStream(local).pipe(res)
})
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  const errors = []
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForFunction(() => events.some(e => e.event === 'engine-ready' || e.event === 'error'), {}, { timeout: 180000 })
    const startup = await page.evaluate(() => ({ isolated: crossOriginIsolated, failure: events.find(e => e.event === 'error') }))
    assert.equal(startup.isolated, true); assert.equal(startup.failure, undefined)
    await page.evaluate(() => request('open', { id: 'impress-document', name: 'Presentation.pptx', kind: 'presentation', extension: 'pptx', base64: '', discard: false }))
    const smoke = await page.evaluate(() => request('smoke-test'))
    assert.equal(smoke.ok, true)
    assert.equal(smoke.impress.slideCount, 2)
    assert.equal(smoke.impress.pptxReopened, true); assert.equal(smoke.impress.odpReopened, true)
    assert.deepEqual(smoke.impress.texts, ['Open Office edited slide · 中文演示测试', 'Second slide · 第二页内容'])
    const pdf = Buffer.from(smoke.impress.pdfBase64, 'base64'); delete smoke.impress.pdfBase64
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    fs.writeFileSync(path.join(output, 'smoke-two-slides.pdf'), pdf)
    await page.evaluate(() => request('insert-image', { name: 'red.png', base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP476JEEmIY1TCqYfhqAACoHWUQpPZ5TgAAAABJRU5ErkJggg==' }))
    const exports = {}
    for (const format of ['pptx', 'odp', 'pdf']) {
      const exported = await page.evaluate(format => request('export', { format }), format)
      const bytes = Buffer.from(exported.base64, 'base64')
      assert.ok(bytes.length > 100); assert.equal(exported.dirty, true)
      fs.writeFileSync(path.join(output, 'image.' + format), bytes)
      exports[format] = { bytes: bytes.length, revision: exported.revision, dirty: exported.dirty }
    }
    const slide = await page.evaluate(() => request('new-slide'))
    assert.equal(slide.slideCount, 2); assert.equal(slide.dirty, true)
    await page.waitForTimeout(750)
    await page.frameLocator('#office').locator('canvas').click({ position: { x: 600, y: 500 } })
    await page.keyboard.press('F5'); await page.waitForTimeout(300)
    await page.keyboard.press('Shift+F5'); await page.waitForTimeout(300)
    const previews = await page.evaluate(() => events.filter(e => e.event === 'native-request' && e.data.type === 'presentation-preview'))
    assert.equal(previews.at(-2)?.data.pageIndex, 0); assert.equal(previews.at(-1)?.data.pageIndex, 1)
    const finalExport = await page.evaluate(() => request('export', { format: 'pptx' }))
    fs.writeFileSync(path.join(output, 'two-slides.pptx'), Buffer.from(finalExport.base64, 'base64'))
    assert.equal(finalExport.dirty, true, 'Preview must not acknowledge saving')
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(output, 'impress.png') })
    assert.deepEqual(errors, [])
    const failures = await page.evaluate(() => events.filter(e => e.event === 'error'))
    assert.deepEqual(failures, [])
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, engine: 'Real Chromium + bundled LibreOffice WASM', smoke, exports, slide, previews, errors }, null, 2))
    console.log('Impress real-engine regression passed: PPTX / ODP / PDF, two-slide text round trips, image insertion, new slide, safe F5 / Shift+F5 preview and export afterward.')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
