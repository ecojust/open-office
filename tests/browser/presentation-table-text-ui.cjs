// Real Vue table-cell editing, downloads and independently parsed OOXML.
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/presentation-table-text-ui');
const url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5199/';
const fixture = path.join(root, 'tests/compatibility/presentation-table-text/mixed-cell.pptx');
fs.mkdirSync(output, { recursive: true });
const report = { scope: 'Actual Vue UI, real download, active-slide OOXML audit and reopened rendering; no native-package claim', checks: [], errors: [], external: [] };
let browser, page;
const pass = name => { report.checks.push(name); console.log('PASS', name); };
async function open(file, index = 0) {
  await page.getByTestId('document-open-input').setInputFiles(file);
  await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor();
  await page.getByTestId('presentation-object').nth(index).click();
}
async function dialog() {
  await page.getByTestId('presentation-edit-data').click();
  const modal = page.getByRole('dialog', { name: '编辑表格数据', exact: true });
  await modal.waitFor(); return modal;
}
async function save(name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const file = path.join(output, name); await (await event).saveAs(file); return file;
}
async function tableXml(file) {
  const parts = unzipSync(fs.readFileSync(file));
  const text = Object.fromEntries(Object.entries(parts).filter(([name]) => name.endsWith('.xml') || name.endsWith('.rels')).map(([name, value]) => [name, strFromU8(value)]));
  return page.evaluate(parts => {
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', XMLNS = 'http://www.w3.org/2000/xmlns/';
    const parse = value => new DOMParser().parseFromString(value, 'application/xml');
    const element = (parent, local) => [...parent.children].find(child => child.localName === local);
    const canonical = node => [node.namespaceURI, node.localName, [...node.attributes].filter(attribute => attribute.namespaceURI !== XMLNS).map(attribute => [attribute.namespaceURI, attribute.localName, attribute.value]).sort(), [...node.childNodes].map(child => child.nodeType === 1 ? canonical(child) : child.nodeValue)];
    const roster = parse(parts['ppt/presentation.xml']).getElementsByTagNameNS(P, 'sldId');
    const links = [...parse(parts['ppt/_rels/presentation.xml.rels']).documentElement.children];
    const target = links.find(link => link.getAttribute('Id') === roster[0].getAttributeNS(R, 'id')).getAttribute('Target');
    const segments = (target.startsWith('/') ? target.slice(1) : 'ppt/' + target).split('/'), resolved = [];
    for (const segment of segments) { if (segment === '..') resolved.pop(); else if (segment && segment !== '.') resolved.push(segment); }
    const slide = parse(parts[resolved.join('/')]);
    return [...slide.getElementsByTagNameNS(A, 'tbl')].map(table => {
      const rows = [...table.children].filter(node => node.localName === 'tr');
      return { grid: canonical(element(table, 'tblGrid')), heights: rows.map(row => row.getAttribute('h')), rows: rows.map(row => [...row.children].filter(node => node.localName === 'tc').map(cell => {
        const body = element(cell, 'txBody');
        return { body: canonical(body), properties: canonical(element(cell, 'tcPr')), paragraphs: body.getElementsByTagNameNS(A, 'p').length, breaks: body.getElementsByTagNameNS(A, 'br').length,
          runs: [...body.getElementsByTagNameNS(A, 'r')].map(run => ({ text: element(run, 't').textContent, properties: element(run, 'rPr') ? canonical(element(run, 'rPr')) : null })) };
      })) };
    });
  }, text);
}
(async () => {
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(30000);
    await page.routeWebSocket('**', () => {});
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) report.external.push(request.url()); });
    await page.goto(url); await open(fixture);
    // The loss-reproduction fixture deliberately has a short original row.
    // Enlarge via the real UI before this visual test so edited runs are visible.
    await page.getByTestId('presentation-height').fill('110');
    await page.getByTestId('presentation-height').press('Tab');
    const baselineFile = await save('table-text-ui-baseline.pptx');
    const before = (await tableXml(baselineFile))[0];
    const scene = () => page.getByTestId('presentation-stage').locator('svg').first().innerHTML();
    const initialScene = await scene();
    let modal = await dialog(), cell = modal.getByLabel('第 1 行第 1 列', { exact: true });
    assert.equal(await cell.inputValue(), 'Red Blue\nGreen\nTail');
    assert.equal(await modal.locator('textarea').count(), 4);
    assert.equal(await modal.getByRole('button', { name: '＋ 添加行', exact: true }).isDisabled(), true);
    assert.equal(await modal.getByRole('button', { name: '＋ 添加列', exact: true }).isDisabled(), true);
    await cell.fill('Bed Blue\nGreen\nTail!');
    await page.getByTestId('presentation-data-apply').click(); await modal.waitFor({ state: 'hidden' });
    const editedScene = await scene(); assert.notEqual(editedScene, initialScene);
    await page.getByTestId('standalone-presentation-editor').focus();
    await page.keyboard.press('Control+z'); assert.equal(await scene(), initialScene);
    await page.keyboard.press('Control+Shift+z'); assert.equal(await scene(), editedScene);
    pass('One multiline cell is edited without splitting its text into rows, with one undo/redo action');
    const edited = await save('table-text-ui-edited.pptx'), after = (await tableXml(edited))[0];
    assert.deepEqual(after.grid, before.grid); assert.deepEqual(after.heights, before.heights);
    assert.deepEqual(after.rows[0][0].properties, before.rows[0][0].properties);
    assert.equal(after.rows[0][0].paragraphs, 2); assert.equal(after.rows[0][0].breaks, 1);
    assert.deepEqual(after.rows[0][0].runs.map(run => run.text), ['Bed ', 'Blue', 'Green', 'Tail!']);
    assert.deepEqual(after.rows[0][0].runs.map(run => run.properties), before.rows[0][0].runs.map(run => run.properties));
    for (const [r, c] of [[0, 1], [1, 0], [1, 1]]) assert.deepEqual(after.rows[r][c], before.rows[r][c]);
    pass('Actual downloaded OOXML retains all run properties, manual break, paragraphs, cell properties, grid and untouched cells');
    await open(edited); assert.equal(await scene(), editedScene);
    await page.screenshot({ path: path.join(output, 'table-text-reopened.png') });
    pass('Downloaded file reopens with the same rendered table');
    modal = await dialog(); cell = modal.getByLabel('第 1 行第 1 列', { exact: true });
    await cell.fill('Bed Blue\nGreen\nTail!\nUnsupported line');
    await page.getByTestId('presentation-data-apply').click();
    await page.getByText('暂不能增删换行', { exact: false }).first().waitFor();
    assert.equal(await cell.inputValue(), 'Bed Blue\nGreen\nTail!\nUnsupported line');
    let downloaded = false; const listener = () => { downloaded = true; }; page.on('download', listener);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await modal.isVisible(), true); assert.equal(downloaded, false); page.off('download', listener);
    await modal.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await scene(), editedScene);
    pass('Unsupported mixed paragraph restructure keeps the draft, prevents saving and cancels without changing the document');
    while (await page.getByRole('button', { name: '关闭错误提示', exact: true }).count()) await page.getByRole('button', { name: '关闭错误提示', exact: true }).first().click();
    await page.getByTestId('presentation-insert-table').click();
    await page.getByTestId('presentation-data-input').fill('Alpha\tBeta\nGamma\tDelta');
    await page.getByTestId('presentation-data-apply').click();
    modal = await dialog();
    await modal.getByRole('button', { name: '＋ 添加行', exact: true }).click();
    await modal.getByRole('button', { name: '＋ 添加列', exact: true }).click();
    assert.equal(await modal.locator('textarea').count(), 9);
    await modal.getByLabel('第 3 行第 3 列', { exact: true }).fill('新单元格');
    await page.getByTestId('presentation-data-apply').click();
    const expanded = await save('table-text-ui-basic-expanded.pptx');
    const basic = (await tableXml(expanded))[1]; assert.equal(basic.rows.length, 3); assert.equal(basic.rows[0].length, 3);
    assert.equal(basic.rows[2][2].runs.map(run => run.text).join(''), '新单元格');
    await open(expanded, 1); modal = await dialog();
    await modal.getByRole('button', { name: '－ 末行', exact: true }).click();
    await modal.getByRole('button', { name: '－ 末列', exact: true }).click();
    assert.equal(await modal.locator('textarea').count(), 4);
    await modal.getByLabel('第 1 行第 1 列', { exact: true }).fill('Alpha\n第二行');
    await page.getByTestId('presentation-data-apply').click();
    const resized = await save('table-text-ui-basic-resized.pptx');
    const final = (await tableXml(resized))[1]; assert.equal(final.rows.length, 2); assert.equal(final.rows[0].length, 2);
    assert.equal(final.rows[0][0].paragraphs, 2);
    assert.deepEqual(final.rows[0][0].runs.map(run => run.text), ['Alpha', '第二行']);
    pass('New and saved basic tables still add/remove rows and columns and keep multiline cell content');
    await dialog();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, `table-cell-dialog-${width}.png`), fullPage: true });
    }
    pass('Cell editing dialog scrolls inside 390px and 320px windows without page overflow');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  } finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); }
})();
