/* Real bundled WASM regression. Run after preparing the Office assets:
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/presentation-workbench.cjs
 * No mocked editor, injected UNO implementation, or remote document service.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('playwright')
const project = path.resolve(__dirname, '../..')
const publicRoot = path.join(project, 'public')
const output = path.join(project, 'test-results/presentation-workbench')
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
    const call = (action, data = {}, id = 'impress-document') => page.evaluate(({ action, data, id }) => request(action, data, id), { action, data, id })
    const act = data => { console.log('ACTION', data.type); return call('presentation-action', data) }
    console.log('ENGINE_OPENED')
    const initial = await call('presentation-state')
    assert.equal(initial.pageCount, 1); assert.equal(initial.dirty, false)
    assert.equal((await call('presentation-state')).pages[0].id, initial.pages[0].id)
    for (const data of [{ type: 'delete-page' }, { type: 'set-layout', layout: 21 }, { type: 'set-page-size', width: -1, height: 200 }]) await assert.rejects(act(data))
    await assert.rejects(call('presentation-action', { type: 'add-page' }, 'wrong-document'))
    assert.equal((await call('presentation-state')).dirty, false)
    await act({ type: 'set-layout', layout: 20 })
    await act({ type: 'rename-page', name: 'Introduction' })
    await act({ type: 'set-page-size', width: 320, height: 180 })
    await act({ type: 'set-background', color: '#224466' })
    await act({ type: 'set-notes', text: 'First notes · 第一页备注' })
    let state = await act({ type: 'insert-text', text: 'Workbench first slide · 第一页', x: 20, y: 12, width: 250, height: 25, textStyle: { fontSize: 24, color: '#FFFFFF' } })
    const textId = state.selectedObjectIds[0]
    assert.ok(textId); assert.ok(state.objects.some(o => o.id === textId && o.text.includes('第一页')))
    state = await act({ type: 'update-object', id: textId, text: 'Edited first slide · 已修改第一页', textStyle: { bold: true } })
    await act({ type: 'insert-shape', shapeType: 'rectangle', x: 20, y: 55, width: 40, height: 30, fillColor: '#4477AA' })
    state = await act({ type: 'insert-table', rows: 2, columns: 3, cells: [['A', 'B', 'C'], ['1', '2', '3']], x: 85, y: 60, width: 90, height: 40 })
    const tableId = state.selectedObjectIds[0]
    assert.deepEqual((await call('presentation-object-data', { type: 'table', id: tableId })).cells, [['A', 'B', 'C'], ['1', '2', '3']])
    await act({ type: 'update-table', id: tableId, cells: [['甲', '乙', '丙'], ['4', '5', '6']] })
    state = await act({ type: 'insert-chart', chartType: 'column', categories: ['Jan', 'Feb'], series: ['Sales'], values: [[12], [24]], title: 'Quarter', x: 180, y: 50, width: 120, height: 90 })
    const chartId = state.selectedObjectIds[0]
    assert.equal((await call('presentation-object-data', { type: 'chart', id: chartId })).type, 'column')
    await act({ type: 'update-chart', id: chartId, chartType: 'line', categories: ['一月', '二月'], series: ['销量'], values: [[18], [36]], title: '营收趋势' })
    await assert.rejects(act({ type: 'update-object', id: textId, text: 'stale', expectedRevision: initial.revision }))
    state = await act({ type: 'add-page', layout: 20 })
    const secondId = state.currentPage.id
    await act({ type: 'insert-text', text: 'Second slide · 第二页', x: 20, y: 20, width: 230, height: 30 })
    await act({ type: 'set-notes', text: 'Second notes · 第二页备注' })
    state = await act({ type: 'duplicate-page' })
    const copyId = state.currentPage.id
    assert.notEqual(copyId, secondId); assert.equal(state.pageCount, 3)
    state = await act({ type: 'move-page', direction: 'up' })
    assert.deepEqual(state.pages.map(p => p.id), [initial.pages[0].id, copyId, secondId])
    state = await act({ type: 'move-page', direction: 'down' })
    assert.deepEqual(state.pages.map(p => p.id), [initial.pages[0].id, secondId, copyId])
    await act({ type: 'set-hidden', value: true })
    await act({ type: 'add-page', layout: 1 })
    state = await act({ type: 'delete-page' }); assert.equal(state.pageCount, 3)
    const snapshots = []
    for (let index = 0; index < 3; index++) snapshots.push(await act({ type: 'select-page', pageIndex: index }))
    await act({ type: 'select-page', pageIndex: 0 })
    const beforeReads = await call('presentation-state')
    for (let index = 0; index < 100; index++) {
      const read = await call('presentation-state')
      assert.equal(read.revision, beforeReads.revision, 'Reading metadata must not modify the document')
      assert.equal(read.currentPage.id, beforeReads.currentPage.id)
      assert.equal(read.objects.length, beforeReads.objects.length)
      if ((index + 1) % 20 === 0) console.log('METADATA_READS', index + 1)
    }
    const exported = {}
    for (const format of ['pptx', 'odp', 'pdf']) {
      console.log('EXPORT', format); exported[format] = await call('export', { format })
      fs.writeFileSync(path.join(output, 'workbench.' + format), Buffer.from(exported[format].base64, 'base64')); assert.equal(exported[format].dirty, true)
    }
    const roundtrips = {}
    for (const format of ['pptx', 'odp']) {
      console.log('REOPEN', format); const id = 'readback-' + format
      await call('open', { id, name: 'workbench.' + format, kind: 'presentation', extension: format, base64: exported[format].base64, discard: true })
      const pages = []
      for (let index = 0; index < 3; index++) pages.push(await call('presentation-action', { type: 'select-page', pageIndex: index }, id))
      assert.equal(pages[0].pageCount, 3)
      assert.ok(Math.abs(pages[0].pageSize.width - 320) <= 0.02); assert.ok(Math.abs(pages[0].pageSize.height - 180) <= 0.02)
      assert.equal(pages[0].currentPage.background.color, '#224466')
      assert.equal(pages[0].currentPage.notes, 'First notes · 第一页备注')
      assert.equal(pages[1].currentPage.notes, 'Second notes · 第二页备注')
      assert.equal(pages[2].currentPage.notes, 'Second notes · 第二页备注')
      assert.equal(pages[2].currentPage.hidden, true)
      assert.ok(pages[0].objects.some(o => o.text === 'Edited first slide · 已修改第一页'))
      await call('presentation-action', { type: 'select-page', pageIndex: 0 }, id)
      const table = pages[0].objects.find(o => o.type === 'table'), chart = pages[0].objects.find(o => o.type === 'chart')
      assert.ok(table); assert.ok(chart)
      // Object IDs are current-page scoped; reacquire after changing slides.
      const current = await call('presentation-state', {}, id)
      const tableData = await call('presentation-object-data', { type: 'table', id: current.objects.find(o => o.type === 'table').id }, id)
      assert.deepEqual(tableData.cells, [['甲', '乙', '丙'], ['4', '5', '6']])
      const chartData = await call('presentation-object-data', { type: 'chart', id: current.objects.find(o => o.type === 'chart').id }, id)
      assert.equal(chartData.type, 'line'); assert.equal(chartData.title, '营收趋势'); assert.deepEqual(chartData.values, [[18], [36]])
      await assert.rejects(call('presentation-action', { type: 'update-object', id: textId, text: 'old model id' }, id))
      roundtrips[format] = { pages, tableData, chartData }
    }
    await page.screenshot({ path: path.join(output, 'workbench.png') }); assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, engine: 'Real Chromium + bundled LibreOffice WASM', metadataReads: 100, initial, snapshots, roundtrips,
      exports: Object.fromEntries(Object.entries(exported).map(([key, value]) => [key, { bytes: Buffer.from(value.base64, 'base64').length, dirty: value.dirty }])) }, null, 2))
    console.log('Presentation workbench real-engine regression passed: slide ordering/properties, native object editing and PPTX/ODP round trips. Independently inspect workbench.pdf for hidden-page count.')
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, message: error.message, errors }, null, 2))
    throw error
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
