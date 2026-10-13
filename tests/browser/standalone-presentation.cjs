/* Full application UI regression for the independent presentation editor.
 * One Chromium process, real fixture imports and real downloads; no fake editor
 * state, intercepted document responses, Office iframe, or private Vue hooks.
 * Run only after the new presentation route is integrated and a Vite server is
 * available. This complements native release validation; it does not replace it.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.STANDALONE_PRESENTATION_OUTPUT || path.join(root, 'test-results/standalone-presentation'));
const url = process.env.STANDALONE_PRESENTATION_URL || 'http://127.0.0.1:5198/';
const python = process.env.PYTHON || path.join(root, 'pdf-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const fixtures = path.join(root, 'tests/compatibility/fixtures/generated');
const editedText = '独立演示真实编辑 中文 QA';
const withoutWhitespace = value => value.replace(/\s+/g, '');
const report = {
  scope: 'Full Vue application in Chromium; independent presentation UI, real OOXML/PDF downloads and independent readback',
  limitations: ['Chromium JS heap is not native WebView process memory or total application memory.', 'No Windows/macOS native dialog or packaged WebView claim.'],
  checks: [], operations: [], heap: [], screenshots: [], pageErrors: [], consoleErrors: [], failedRequests: [],
  externalRequests: [], officeRuntimeRequests: [], allowedPdfFontRequests: [], files: {},
};
let browser, page, cdp, phase = 'startup';
fs.mkdirSync(out, { recursive: true });
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const ok = name => { report.checks.push(name); console.log('PASS', name); persist(); };
async function stage(name, work) {
  phase = name; console.log('PHASE', name); const start = performance.now();
  const value = await work();
  report.operations.push({ name, milliseconds: Math.round(performance.now() - start) }); persist(); return value;
}
async function idle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner');
    if (error) throw Error(error.textContent || 'Application error');
    const editor = document.querySelector('[data-testid="standalone-presentation-editor"]');
    return editor?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay') && document.querySelector('[data-testid="presentation-stage"]')
      && document.querySelector('[data-testid="presentation-slide-thumbnail"]');
  });
  await page.getByRole('button', { name: '保存', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0, 'PPT session must contain no iframe');
}
const thumbs = () => page.getByTestId('presentation-slide-thumbnail');
const object = id => page.locator(`[data-testid="presentation-object"][data-object-id="${id}"]`);
async function selectSlide(index) {
  await page.locator(`[data-testid="presentation-slide-thumbnail"][data-slide-index="${index}"]`).click();
  await idle();
}
async function screenshot(name) {
  const file = `${name}.png`; await page.screenshot({ path: path.join(out, file) }); report.screenshots.push(file);
}
async function snapshotHeap(name) {
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  report.heap.push({ name, scope: 'Chromium page JS heap, not process/native memory',
    usedBytes: metrics.JSHeapUsedSize, totalBytes: metrics.JSHeapTotalSize, nodes: metrics.Nodes, documents: metrics.Documents,
    performanceMemory: await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null),
    iframeCount: await page.locator('iframe').count(), workers: page.workers().map(worker => worker.url()) }); persist();
}
async function open(file) {
  const started = performance.now();
  await page.getByTestId('document-open-input').setInputFiles(file);
  await page.locator('.titlebar-context').filter({ hasText: path.basename(file) }).waitFor(); await idle();
  report.operations.push({ name: 'import-to-editor-ready', file: path.basename(file), milliseconds: Math.round(performance.now() - started) });
}
async function download(name, action) {
  const pending = page.waitForEvent('download'); await action();
  const file = path.join(out, name); await (await pending).saveAs(file); await idle(); return file;
}
const save = name => download(name, () => page.getByRole('button', { name: '保存', exact: true }).click());
async function geometry(id) {
  return object(id).evaluate(node => Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(node.dataset[key])])));
}
async function selectedId() {
  const selected = page.locator('[data-testid="presentation-object"][aria-selected="true"], [data-testid="presentation-object"].is-selected');
  if (await selected.count()) return selected.first().getAttribute('data-object-id');
  const objects = page.getByTestId('presentation-object'); return objects.last().getAttribute('data-object-id');
}
async function editText(value) {
  const textarea = page.getByTestId('presentation-text-editor'); await textarea.fill(value); await textarea.blur(); await idle();
}
async function dataApply() { await page.getByTestId('presentation-data-apply').click(); await idle(); }
function inspectPptx(file) {
  return JSON.parse(execFileSync(python, ['-c', String.raw`
import json,posixpath,re,sys,zipfile,xml.etree.ElementTree as E
ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main','c':'http://schemas.openxmlformats.org/drawingml/2006/chart','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
with zipfile.ZipFile(sys.argv[1]) as z:
 names=set(z.namelist()); assert '[Content_Types].xml' in names and 'ppt/presentation.xml' in names
 rels={r.attrib['Id']:r.attrib['Target'] for r in E.fromstring(z.read('ppt/_rels/presentation.xml.rels'))}
 presentation=E.fromstring(z.read('ppt/presentation.xml'))
 slide_paths=[posixpath.normpath(posixpath.join('ppt',rels[n.attrib['{'+ns['r']+'}id']])) for n in presentation.findall('./p:sldIdLst/p:sldId',ns)]
 slides=[];charts=[];notes=[]
 for name in slide_paths:
  slide=E.fromstring(z.read(name)); objects=[]
  for graphic in slide.findall('.//a:graphicData',ns):
   if graphic.find('a:tbl',ns) is not None:assert graphic.attrib.get('uri')=='http://schemas.openxmlformats.org/drawingml/2006/table','Table graphicData must use the standard OOXML URI'
   if graphic.find('c:chart',ns) is not None:assert graphic.attrib.get('uri')==ns['c'],'Chart graphicData must use the standard OOXML URI'
  slide_rel_path=posixpath.join(posixpath.dirname(name),'_rels',posixpath.basename(name)+'.rels')
  slide_rels={r.attrib['Id']:r.attrib for r in E.fromstring(z.read(slide_rel_path))} if slide_rel_path in names else {}
  for reference in slide.findall('.//c:chart',ns):
   relationship=slide_rels[reference.attrib['{'+ns['r']+'}id']]
   chart_name=posixpath.normpath(posixpath.join(posixpath.dirname(name),relationship['Target']))
   chart=E.fromstring(z.read(chart_name)); charts.append({'part':chart_name,'text':'\n'.join(n.text or '' for n in chart.iter() if n.tag.rsplit('}',1)[-1] in ['t','v']),'values':[n.text for n in chart.findall('.//c:numCache/c:pt/c:v',ns)]})
  for relationship in slide_rels.values():
   if relationship.get('Type','').endswith('/notesSlide'):
    notes_name=posixpath.normpath(posixpath.join(posixpath.dirname(name),relationship['Target']))
    notes.append('\n'.join(n.text or '' for n in E.fromstring(z.read(notes_name)).findall('.//a:t',ns)))
  for node in slide.findall('./p:cSld/p:spTree/*',ns):
   tags=node.tag.rsplit('}',1)[-1]
   if tags not in ['sp','pic','graphicFrame','grpSp','cxnSp']:continue
   xfrm=node.find('.//a:xfrm',ns)
   if xfrm is None:xfrm=node.find('./p:xfrm',ns)
   rect={}
   if xfrm is not None:
    off=xfrm.find('a:off',ns); ext=xfrm.find('a:ext',ns)
    if off is not None:rect.update(x=int(off.attrib['x'])/36000,y=int(off.attrib['y'])/36000)
    if ext is not None:rect.update(width=int(ext.attrib['cx'])/36000,height=int(ext.attrib['cy'])/36000)
   objects.append({'tag':tags,'text':'\n'.join(n.text or '' for n in node.findall('.//a:t',ns)),'rect':rect,'table':node.find('.//a:tbl',ns) is not None,'chart':node.find('.//c:chart',ns) is not None})
  slides.append({'part':name,'hidden':slide.attrib.get('show')=='0','text':'\n'.join(n.text or '' for n in slide.findall('.//a:t',ns)),'objects':objects})
 print(json.dumps({'pages':len(slides),'slides':slides,'charts':charts,'notes':notes,'imageParts':sum(n.startswith('ppt/media/') for n in names),'zipEntries':len(names)},ensure_ascii=False))
`, file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
function inspectPdf(file) {
  return JSON.parse(execFileSync(python, ['-c', 'import pymupdf,json,sys;d=pymupdf.open(sys.argv[1]);print(json.dumps({"pages":len(d),"texts":[p.get_text() for p in d],"pageSizes":[list(p.rect) for p in d]},ensure_ascii=False))', file], { encoding: 'utf8' }));
}
async function assertLayout(width) {
  await page.setViewportSize({ width, height: 920 }); await idle();
  if (width <= 640) await page.locator('.pe-properties').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-testid="presentation-stage"]'), box = stage.getBoundingClientRect();
    return stage.contains(document.elementFromPoint(box.right - 12, box.y + box.height / 2));
  });
  const layout = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="presentation-stage"]').getBoundingClientRect();
    const toolbarRows = [...new Set([...document.querySelectorAll('.command-bar button,.pe-toolbar button,.pe-toolbar select')].filter(node => node.getClientRects().length).map(node => Math.round(node.getBoundingClientRect().top / 4) * 4))].length;
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, toolbarRowsExcludingTitleAndTabs: toolbarRows,
      stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height, right: stage.right, bottom: stage.bottom } };
  });
  assert.ok(layout.documentWidth <= width + 1, `Horizontal document overflow at ${width}px: ${JSON.stringify(layout)}`);
  assert.ok(layout.stage.width > 160 && layout.stage.height > 90 && layout.stage.x >= -1 && layout.stage.right <= width + 1,
    `Slide canvas is not usable at ${width}px: ${JSON.stringify(layout)}`);
  await screenshot(`layout-${width}`); report.operations.push({ name: `layout-${width}`, layout });
}

(async () => { try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1360, height: 920 }, acceptDownloads: true }); page.setDefaultTimeout(30000);
  cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  // Keeping Vite's socket disconnected prevents unrelated source edits from
  // reloading a document during this single, serial browser acceptance run.
  await page.routeWebSocket('**', () => {});
  const origin = new URL(url).origin;
  page.on('request', request => {
    const requested = new URL(request.url());
    if (/^https?:$/.test(requested.protocol) && requested.origin !== origin) report.externalRequests.push({ phase, url: requested.href });
    if (requested.pathname === '/office-runtime/NotoSansCJKsc-Regular.otf') report.allowedPdfFontRequests.push({ phase, url: requested.href });
    else if (/^\/(office|office-runtime)\//.test(requested.pathname) || /soffice|\.wasm(?:$|\?)/i.test(requested.href)) report.officeRuntimeRequests.push({ phase, url: requested.href });
  });
  page.on('pageerror', error => { report.pageErrors.push({ phase, error: error.message }); console.error('PAGEERROR', error.message); });
  page.on('console', message => { if (message.type() === 'error') { report.consoleErrors.push({ phase, error: message.text() }); console.error('CONSOLE', message.text()); } });
  page.on('requestfailed', request => report.failedRequests.push({ phase, url: request.url(), error: request.failure()?.errorText }));

  if (process.env.STANDALONE_PRESENTATION_MODE === 'codec') {
    report.scope = 'Targeted production codec fixture regression in one real browser page, with independent embedded XLSX inspection';
    await page.goto(url); await page.locator('.create-card.presentation').waitFor();
    await stage('codec-final-contract', async () => {
      const { runCodecChecks } = require('./standalone-presentation-codec.cjs'); await runCodecChecks(page, fixtures, report);
    });
    assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(report.officeRuntimeRequests, []);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    report.ok = true; return;
  }

  if (['layout', 'final'].includes(process.env.STANDALONE_PRESENTATION_MODE)) {
    report.scope = 'Targeted real application regression after narrow property drawer and editable data grid changes';
    await stage('home', async () => { await page.goto(url); await page.locator('.create-card.presentation').waitFor(); });
    await stage('twenty-slide-import', () => open(path.join(fixtures, 'presentation-20-slides.pptx')));
    for (const width of [640, 900, 1360]) await assertLayout(width);
    await stage('editable-data-grid', async () => {
      await selectSlide(0); await page.locator('[data-testid="presentation-object"][data-kind="table"]').click();
      await page.getByTestId('presentation-edit-data').click();
      await page.getByLabel('第 1 行第 1 列', { exact: true }).fill('网格真实编辑');
      await page.getByRole('button', { name: '＋ 添加行', exact: true }).click();
      await page.getByRole('button', { name: '＋ 添加列', exact: true }).click();
      await page.getByLabel('第 4 行第 4 列', { exact: true }).fill('网格新增'); await dataApply();
      await selectSlide(1); await page.locator('[data-testid="presentation-object"][data-kind="chart"]').click();
      await page.getByTestId('presentation-edit-data').click();
      await page.getByLabel('第 2 行第 2 列', { exact: true }).fill('321.5');
      await page.getByRole('button', { name: '＋ 添加列', exact: true }).click();
      await page.getByLabel('第 2 行第 3 列', { exact: true }).fill('89.25');
      await page.getByRole('button', { name: '＋ 添加行', exact: true }).click();
      await screenshot('editable-data-grid'); await dataApply();
      report.files.grid = inspectPptx(await save('grid-edited.pptx'));
      assert.ok(report.files.grid.slides[0].text.includes('网格真实编辑'));
      assert.ok(report.files.grid.slides[0].text.includes('网格新增'));
      assert.ok(report.files.grid.charts.some(chart => chart.values.includes('321.5') && chart.values.includes('89.25')));
    });
    if (process.env.STANDALONE_PRESENTATION_MODE === 'final') {
      await stage('codec-final-contract', async () => {
        const { runCodecChecks } = require('./standalone-presentation-codec.cjs'); await runCodecChecks(page, fixtures, report);
      });
      await stage('preview-preparation-guards-edits', async () => {
        const id = await selectedId(), before = await geometry(id), count = await page.getByTestId('presentation-object').count();
        await page.getByTestId('presentation-present').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="standalone-presentation-editor"]')?.hasAttribute('inert'));
        await page.keyboard.press('Delete'); await page.keyboard.press('ArrowRight');
        await page.getByTestId('slide-preview-canvas').waitFor();
        await page.waitForFunction(() => document.querySelector('[data-testid="slide-preview"]')?.getAttribute('data-rendering') === 'false');
        await screenshot('final-slideshow'); await page.keyboard.press('Escape');
        await page.getByTestId('slide-preview').waitFor({ state: 'hidden' });
        assert.equal(await page.getByTestId('presentation-object').count(), count); assert.deepEqual(await geometry(id), before);
      });
      await stage('presentation-documentation-screenshot', async () => {
        await open(path.join(__dirname, 'fixtures/presentation.pptx')); await selectSlide(0);
        assert.ok((await page.getByTestId('presentation-stage').textContent()).includes('成为下一步行动'));
        await screenshot('presentation-editor-clean');
      });
    }
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.officeRuntimeRequests, []); assert.deepEqual(report.externalRequests, []);
    ok('All layouts expose the full slide canvas; editable grid cells and added rows/columns persist to real PPTX, with no iframe/Office/external requests or page errors');
    report.ok = true; return;
  }

  await stage('home', async () => { await page.goto(url); await page.locator('.create-card.presentation').waitFor(); await snapshotHeap('home'); });
  await stage('new-presentation-ready', async () => { await page.locator('.create-card.presentation').click(); await idle(); });
  assert.equal(await thumbs().count(), 1); await snapshotHeap('new-presentation'); await screenshot('new-presentation');
  report.files.blank = inspectPptx(await save('blank.pptx')); assert.equal(report.files.blank.pages, 1);
  ok('New presentation opens independently and saves a real one-slide PPTX ZIP');

  await stage('text-edit-geometry-history', async () => {
    await page.getByTestId('presentation-insert-text').click(); await idle(); const id = await selectedId();
    await editText(editedText); assert.ok(withoutWhitespace(await page.getByTestId('presentation-stage').textContent()).includes(withoutWhitespace(editedText)));
    const before = await geometry(id); await object(id).click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    const nudged = await geometry(id); assert.ok(nudged.x > before.x && nudged.y > before.y, 'Arrow keys must move the selected object');
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
    assert.deepEqual(await geometry(id), before, 'Undo must restore both object moves');
    await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+Shift+z');
    assert.deepEqual(await geometry(id), nudged, 'Redo must restore both object moves');
    const box = await object(id).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 25, { steps: 6 }); await page.mouse.up();
    const dragged = await geometry(id); assert.ok(dragged.x > nudged.x && dragged.y > nudged.y, 'Pointer drag must move the actual object');
    const width = page.getByTestId('presentation-width'); await width.fill(String(Math.round(dragged.width + 12))); await width.blur();
    const sized = await geometry(id); assert.ok(sized.width > dragged.width + 10, 'Resize control must update object geometry');
    const handle = await page.getByTestId('presentation-resize-se').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 24, handle.y + handle.height / 2 + 15, { steps: 5 }); await page.mouse.up();
    const resized = await geometry(id); assert.ok(resized.width > sized.width && resized.height > sized.height, 'Pointer resize handle must update both dimensions');
    report.textObject = { id, before, nudged, dragged, resized }; await screenshot('text-edit-geometry');
  });
  ok('Text editing, arrow movement, pointer dragging, resizing and undo/redo change the actual slide');

  await stage('editable-table-chart', async () => {
    await page.getByTestId('presentation-new-slide').click(); await idle();
    await page.getByTestId('presentation-insert-table').click(); await idle();
    await page.getByTestId('presentation-data-input').fill('真实表格中文\t结果\n本地编辑\t42'); await dataApply();
    await page.getByTestId('presentation-new-slide').click(); await idle();
    await page.getByTestId('presentation-insert-chart').click(); await idle();
    await page.getByTestId('presentation-chart-title').fill('季度营收核验');
    await page.getByTestId('presentation-data-input').fill('类别\t营收\t成本\n一月\t123.5\t82\n二月\t246\t96'); await dataApply();
    await screenshot('chart-data');
    await page.getByTestId('presentation-duplicate-slide').click(); assert.equal(await thumbs().count(), 4);
    await page.getByTestId('presentation-hide-slide').check();
    assert.match(await thumbs().last().getAttribute('aria-label'), /已隐藏/);
    await page.getByTitle('当前页上移', { exact: true }).click();
    assert.equal(await page.getByTestId('standalone-presentation-editor').getAttribute('data-slide-index'), '2');
    await page.getByTestId('presentation-delete-slide').click(); assert.equal(await thumbs().count(), 3);
  });
  const edited = await stage('save-edited-pptx', () => save('edited.pptx'));
  const parsed = report.files.edited = inspectPptx(edited);
  assert.equal(parsed.pages, 3); assert.ok(parsed.slides[0].text.includes(editedText));
  assert.ok(parsed.slides[1].text.includes('真实表格中文')); assert.ok(parsed.slides[1].objects.some(item => item.table));
  assert.ok(parsed.slides[2].objects.some(item => item.chart)); assert.ok(parsed.charts.some(item => item.values.includes('123.5') && item.text.includes('季度营收核验')));
  const savedText = parsed.slides[0].objects.find(item => item.text.includes(editedText));
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(savedText.rect[key] - report.textObject.resized[key]) < .02, `Exported ${key} differs from edited object`);
  ok('Saved OOXML independently contains edited text, exact geometry, a native table and chart values');

  await stage('save-reopen-editable', async () => {
    await open(edited); assert.equal(await thumbs().count(), 3); await selectSlide(0);
    await page.getByTestId('presentation-object').last().dblclick();
    assert.equal(await page.getByTestId('presentation-text-editor').inputValue(), editedText);
    await editText(`${editedText} 重开可编辑`);
    await selectSlide(1); await page.locator('[data-testid="presentation-object"][data-kind="table"]').click();
    await page.getByRole('button', { name: '编辑表格数据', exact: true }).click();
    assert.equal(await page.getByTestId('presentation-data-input').inputValue(), '真实表格中文\t结果\n本地编辑\t42'); await dataApply();
    await selectSlide(2); await page.locator('[data-testid="presentation-object"][data-kind="chart"]').click();
    await page.getByRole('button', { name: '编辑图表数据', exact: true }).click();
    assert.equal(await page.getByTestId('presentation-data-input').inputValue(), '类别\t营收\t成本\n一月\t123.5\t82\n二月\t246\t96'); await dataApply();
    report.files.reopened = inspectPptx(await save('reopened-edited.pptx'));
    assert.ok(report.files.reopened.slides[0].text.includes('重开可编辑'));
  });
  ok('Saved PPTX reopens with editable text, table cells and chart values; a second save retains edits');

  await stage('pdf-independent-readback', async () => {
    const pdf = await download('edited.pdf', () => page.getByRole('button', { name: '导出 PDF', exact: true }).click());
    assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-'); report.files.pdf = inspectPdf(pdf);
    assert.equal(report.files.pdf.pages, 3); assert.ok(withoutWhitespace(report.files.pdf.texts.join('\n')).includes(withoutWhitespace(editedText)));
    assert.ok(report.files.pdf.texts.join('\n').includes('真实表格中文'));
  });
  ok('Exported PDF independently reopens with three readable pages and searchable Chinese text');

  await stage('rich-original-pptx-import', async () => {
    await open(path.join(fixtures, 'presentation-rich.pptx')); assert.equal(await thumbs().count(), 3);
    await selectSlide(1); assert.equal(await page.locator('[data-testid="presentation-object"][data-kind="table"]').count(), 1);
    assert.equal(await page.locator('[data-testid="presentation-object"][data-kind="chart"]').count(), 1);
    await selectSlide(2); assert.ok(await page.locator('[data-testid="presentation-object"][data-kind="image"]').count() >= 1);
    await screenshot('rich-import'); const file = await save('rich-roundtrip.pptx'); report.files.rich = inspectPptx(file);
    assert.equal(report.files.rich.pages, 3); assert.ok(report.files.rich.imageParts >= 1);
    assert.ok(report.files.rich.slides[0].text.includes('COMPAT-PRESENTATION-RICH'));
    assert.ok(report.files.rich.notes.join('\n').includes('SPEAKER-NOTE-ONE'));
  });
  ok('Original rich PPTX imports three slides with real image, table, chart and preserved notes');

  await stage('twenty-slide-import', async () => {
    await open(path.join(fixtures, 'presentation-20-slides.pptx')); assert.equal(await thumbs().count(), 20);
    await selectSlide(19); assert.ok((await page.getByTestId('presentation-stage').textContent()).includes('DECK-PAGE-20'));
    await selectSlide(0); await snapshotHeap('twenty-slides'); await screenshot('twenty-slides');
    report.files.twenty = inspectPptx(await save('twenty-roundtrip.pptx'));
    assert.equal(report.files.twenty.pages, 20); assert.deepEqual(report.files.twenty.slides.map((s, i) => s.hidden ? i : -1).filter(i => i >= 0), [5, 11]);
  });
  ok('Twenty-slide PPTX imports, selects its last slide and preserves both hidden slides in saved OOXML');

  await stage('slideshow-hidden-and-shortcuts', async () => {
    await selectSlide(4); await page.keyboard.press('Shift+F5'); await page.getByTestId('slide-preview').waitFor();
    await page.getByTestId('slide-preview-next').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index') === '6');
    await screenshot('slideshow-hidden-skipped'); await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index') === '0');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index') === '19');
    await page.keyboard.press('Escape'); await page.getByTestId('slide-preview').waitFor({ state: 'hidden' });
    await page.keyboard.press('F5'); await page.getByTestId('slide-preview').waitFor();
    await page.keyboard.press('Escape'); await page.getByTestId('slide-preview').waitFor({ state: 'hidden' });
  });
  ok('Shift+F5, next/hidden-page skipping, Home, End, Escape and F5 use the built-in slideshow');

  await stage('responsive-layouts', async () => { for (const width of [640, 900, 1360]) await assertLayout(width); });
  ok('Editor remains usable without document overflow at 640, 900 and 1360 pixels');

  await stage('dirty-switch-and-close', async () => {
    await selectSlide(0); await page.getByTestId('presentation-insert-text').click(); await editText('切换标签保留修改');
    const activeName = (await page.locator('.document-tab.active .tab-name').innerText()).trim();
    await page.locator('.document-tab:not(.active) .tab-name').first().click(); await idle();
    await page.locator('.document-tab').filter({ hasText: activeName }).locator('.tab-name').click(); await idle();
    assert.ok((await page.getByTestId('presentation-stage').textContent()).includes('切换标签保留修改'));
    await page.locator('.document-tab.active .tab-close').click(); const dialog = page.getByRole('dialog', { name: '保存你的修改？' }); await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await idle();
    assert.ok((await page.getByTestId('presentation-stage').textContent()).includes('切换标签保留修改'));
    await page.locator('.document-tab.active .tab-close').click(); await dialog.waitFor();
    const closed = await download('saved-on-close.pptx', () => dialog.getByRole('button', { name: '保存并关闭', exact: true }).click());
    assert.ok(inspectPptx(closed).slides[0].text.includes('切换标签保留修改'));
    await open(closed); assert.ok((await page.getByTestId('presentation-stage').textContent()).includes('切换标签保留修改'));
    await page.getByTestId('presentation-insert-text').click(); await editText('明确放弃的临时文字');
    await page.locator('.document-tab.active .tab-close').click(); await dialog.waitFor();
    await dialog.getByRole('button', { name: '不保存', exact: true }).click(); await idle();
  });
  ok('Unsaved tab switching preserves edits; close cancel keeps them, save closes a real file, and discard closes explicitly');

  await stage('codec-independent-contract', async () => {
    const { runCodecChecks } = require('./standalone-presentation-codec.cjs');
    await runCodecChecks(page, fixtures, report);
  });
  ok('Production codec passes direct fixture round trips and independent embedded-workbook readback in the same browser');

  await snapshotHeap('final');
  assert.equal(await page.locator('iframe').count(), 0); assert.deepEqual(report.officeRuntimeRequests, []);
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  assert.equal(await page.locator('.error-banner').count(), 0);
  ok('Entire PPT session has zero iframes, Office/WASM runtime loads, external requests and page/console errors');
  report.ok = true;
} catch (error) {
  report.ok = false; report.failedPhase = phase; report.error = String(error.stack || error); console.error(error);
  if (page) await screenshot('failure').catch(() => {}); process.exitCode = 1;
} finally { persist(); await browser?.close(); } })();
