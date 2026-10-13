/* Real UI-only workbench regression: no synthetic engine state or UNO test hooks. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PRESENTATION_WORKBENCH_OUTPUT || path.join(root, 'test-results/presentation-workbench-ui'));
fs.mkdirSync(out, { recursive: true });
const report = { scope: 'Actual Vue controls and bundled Impress; exported PPTX independently inspected and reopened', checks: [], errors: [] };
const ok = name => { report.checks.push(name); console.log('PASS', name); };
let browser, page, diagnosticTimer;
async function idle() {
  await page.waitForFunction(() => document.querySelector('.error-banner') || (document.querySelector('.office-frame') && !document.querySelector('.office-frame.is-loading') && !document.querySelector('.office-loading') && !document.querySelector('.busy-overlay')), null, { timeout: 240000 });
  const error = page.locator('.error-banner');
  if (await error.count()) throw Error(await error.innerText());
  await page.locator('.pw-slide-card').first().waitFor();
}
async function click(locator) { console.log('CLICK', (await locator.textContent())?.trim() || await locator.getAttribute('aria-label')); await locator.click(); await idle(); console.log('DONE'); }
async function tab(name) { await page.getByRole('tab', { name, exact: true }).click(); }
async function newBlankSlide() { await tab('开始'); await click(page.locator('.pw-toolbar').getByRole('button', { name: '新建幻灯片', exact: true })); }
async function dataApply() {
  await page.getByRole('button', { name: '应用数据', exact: true }).click(); await idle();
  await page.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.equal(await page.locator('.pw-data-error').count(), 0);
}
async function objectPane() {
  if (!await page.locator('#pw-properties').isVisible()) await page.getByRole('button', { name: '属性', exact: true }).click();
  await page.locator('.pw-property-tabs').getByRole('button', { name: /对象/ }).click();
}
async function selectOnlyObject() { await objectPane(); const values = await page.locator('#pw-object-select option').evaluateAll(options => options.map(item => item.value).filter(Boolean)); assert.equal(values.length, 1); await page.locator('#pw-object-select').selectOption(values[0]); await idle(); }
function inspect(file) {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', String.raw`
import sys,json,zipfile,re,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 names=sorted(n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n))
 slides=[E.fromstring(z.read(n)) for n in names]
 texts=[''.join(e.text or '' for e in s.iter() if e.tag.endswith('}t')) for s in slides]
 notes=[' '.join(e.text or '' for e in E.fromstring(z.read(n)).iter() if e.tag.endswith('}t')) for n in z.namelist() if re.fullmatch(r'ppt/notesSlides/notesSlide\d+\.xml',n)]
 charts=[E.fromstring(z.read(n)) for n in z.namelist() if re.fullmatch(r'ppt/charts/chart\d+\.xml',n)]
 ns={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
 chart=[{'line':bool(c.findall('.//c:lineChart',ns)),'values':[n.text for n in c.findall('.//c:numCache/c:pt/c:v',ns)],'text':' '.join(e.text or '' for e in c.iter() if e.tag.endswith('}t') or e.tag.endswith('}v'))} for c in charts]
 print(json.dumps({'pages':len(slides),'texts':texts,'notes':notes,'charts':chart}))
`, file], { encoding: 'utf8' }));
}
(async () => { try {
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.WORKBENCH_CDP_PORT ? [`--remote-debugging-port=${process.env.WORKBENCH_CDP_PORT}`] : [])] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1080 }, acceptDownloads: true }); page.setDefaultTimeout(60000);
  // Keep Vite's socket open but disconnected: closing it triggers automatic page reloads.
  await page.routeWebSocket('**', () => {});
  page.on('response', response => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); });
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  page.on('pageerror', e => { report.errors.push(e.message); console.error('PAGEERROR', e.message); });
  diagnosticTimer = setInterval(() => { page.screenshot({ path: path.join(out, 'latest.png') }).catch(() => {}); }, 20000);
  await page.goto(process.env.PRESENTATION_WORKBENCH_URL || 'http://127.0.0.1:5198/');
  console.log('START new Impress document'); await page.locator('.create-card.presentation').click(); await idle(); console.log('READY new document');
  await tab('设计'); await page.locator('.pw-toolbar select').selectOption('20'); await idle();
  await tab('插入'); await click(page.locator('.pw-toolbar').getByRole('button', { name: '文本框', exact: true }));
  await page.getByLabel('文字内容', { exact: true }).fill('工作台真实编辑 · 下一步行动');
  assert.equal(await page.locator('.pw-slide-card').first().isDisabled(), true);
  await click(page.getByRole('button', { name: '应用文字', exact: true }));
  await page.locator('.pw-pending-hint').waitFor({ state: 'hidden' });
  await click(page.getByRole('button', { name: '加粗', exact: true }));
  await page.getByLabel('字号（磅）', { exact: true }).selectOption('32'); await idle();
  await page.getByRole('button', { name: '演讲备注', exact: true }).click();
  await page.getByLabel('当前幻灯片的演讲备注', { exact: true }).fill('先介绍目标，再展示季度销售数据。');
  await click(page.getByRole('button', { name: '应用备注', exact: true }));
  await page.locator('.pw-pending-hint').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(out, 'text-and-notes.png') });
  ok('Chinese text, formatting and speaker notes update the real document; unapplied text blocks page navigation');

  await newBlankSlide(); await tab('插入'); await click(page.locator('.pw-toolbar').getByRole('button', { name: /表格.*3/ }));
  await objectPane(); await page.getByRole('button', { name: '编辑表格数据', exact: true }).click();
  await page.getByLabel('第 1 行第 1 列', { exact: true }).fill('项目');
  await page.getByLabel('第 1 行第 2 列', { exact: true }).fill('结果');
  await page.getByLabel('第 2 行第 1 列', { exact: true }).fill('真实表格回读');
  await page.getByLabel('第 2 行第 2 列', { exact: true }).fill('42');
  await dataApply(); await page.screenshot({ path: path.join(out, 'table-data.png') });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  ok('Editable 3×3 table data applies and is verified through a fresh UNO data read');

  await newBlankSlide(); await tab('插入'); await click(page.locator('.pw-toolbar').getByRole('button', { name: '图表', exact: true }));
  await page.getByRole('button', { name: '编辑图表数据', exact: true }).click();
  await page.getByLabel('图表标题', { exact: true }).fill('季度营收核验');
  await page.locator('.pw-chart-settings select').selectOption('line');
  await page.getByLabel('类别 1 名称', { exact: true }).fill('一月');
  await page.getByLabel('系列 1 名称', { exact: true }).fill('营收');
  await page.getByLabel('类别 1，系列 1 数值', { exact: true }).fill('123.5');
  await page.getByLabel('类别 2，系列 1 数值', { exact: true }).fill('246');
  await dataApply(); await page.screenshot({ path: path.join(out, 'chart-data.png') });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  ok('Chart type, title, categories, series and numeric cells update and read back from the real model');

  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = path.join(out, 'workbench-edited.pptx'); await (await pending).saveAs(saved); await idle();
  const file = inspect(saved); report.file = file;
  assert.equal(file.pages, 3); assert.ok(file.texts[0].includes('工作台真实编辑 · 下一步行动')); assert.ok(file.texts[1].includes('真实表格回读')); assert.ok(file.texts[1].includes('42'));
  assert.ok(file.notes.join('\n').includes('先介绍目标，再展示季度销售数据。'));
  assert.equal(file.charts.length, 1); assert.equal(file.charts[0].line, true); assert.ok(file.charts[0].values.includes('123.5')); assert.ok(file.charts[0].values.includes('246')); assert.ok(file.charts[0].text.includes('季度营收核验'));
  ok('Saved PPTX independently contains three slides, modified text/table/notes and a real line chart with exact values');

  await page.getByTestId('document-open-input').setInputFiles(saved); await page.locator('.titlebar-context').filter({ hasText: 'workbench-edited.pptx' }).waitFor(); await idle();
  await click(page.locator('.pw-slide-card[data-page-index="0"]')); await selectOnlyObject();
  assert.equal(await page.getByLabel('文字内容', { exact: true }).inputValue(), '工作台真实编辑 · 下一步行动');
  assert.equal(await page.getByLabel('当前幻灯片的演讲备注', { exact: true }).inputValue(), '先介绍目标，再展示季度销售数据。');
  await click(page.locator('.pw-slide-card[data-page-index="1"]')); await selectOnlyObject(); await page.getByRole('button', { name: '编辑表格数据', exact: true }).click();
  assert.equal(await page.getByLabel('第 2 行第 1 列', { exact: true }).inputValue(), '真实表格回读');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await click(page.locator('.pw-slide-card[data-page-index="2"]')); await selectOnlyObject(); await page.getByRole('button', { name: '编辑图表数据', exact: true }).click();
  assert.equal(await page.locator('.pw-chart-settings select').inputValue(), 'line');
  assert.equal(await page.getByLabel('类别 1，系列 1 数值', { exact: true }).inputValue(), '123.5');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  ok('Exported PPTX reopens with editable text, speaker notes, table cells and line chart data intact');
  assert.deepEqual(report.errors, []); report.ok = true;
  if (process.env.WORKBENCH_REPAINT_PROBE === '1') {
    await click(page.locator('.pw-slide-card[data-page-index="0"]')); await selectOnlyObject();
    await page.getByLabel('文字内容', { exact: true }).fill('画布刷新核验 ABC123');
    await click(page.getByRole('button', { name: '应用文字', exact: true }));
    await page.waitForTimeout(1000); await page.screenshot({ path: path.join(out, 'repaint-before-focus.png') });
    await page.frameLocator('.office-frame').locator('canvas').first().click({ position: { x: 500, y: 450 } });
    await page.waitForTimeout(1000); await page.screenshot({ path: path.join(out, 'repaint-after-focus.png') });
    console.log('REPAINT_READY', process.env.WORKBENCH_CDP_PORT);
    const deadline = Date.now() + 300000;
    while (!fs.existsSync(path.join(out, 'stop-repaint')) && Date.now() < deadline) await page.waitForTimeout(1000);
  }
} catch (error) { report.ok = false; report.error = String(error.stack || error); console.error(error); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally { clearInterval(diagnosticTimer); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); } })();
