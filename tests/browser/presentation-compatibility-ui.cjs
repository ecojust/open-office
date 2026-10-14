const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'test-results/presentation-compatibility-ui');
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [] };
let browser;
(async () => { try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(30000);
  await page.routeWebSocket('**', () => {});
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:5198/');
  async function open(file) {
    await page.getByTestId('document-open-input').setInputFiles(file);
    await page.locator('.titlebar-context').filter({ hasText: path.basename(file) }).waitFor();
    await page.locator('[data-testid="standalone-presentation-editor"][data-ready="true"]').waitFor();
  }
  const fixtures = path.join(root, 'tests/compatibility/presentation-complex/fixtures');
  await open(path.join(fixtures, 'upstream/apache-poi/smartart-simple.pptx'));
  assert.ok(await page.getByTestId('presentation-stage').locator('svg image').count() > 0);
  await page.locator('[data-testid="presentation-object"][data-kind="unknown"]').dblclick();
  assert.equal(await page.getByTestId('presentation-text-editor').count(), 0, 'Read-only SmartArt must not open the plain text editor');
  assert.equal(await page.getByTestId('presentation-width').isDisabled(), true, 'Protected SmartArt geometry inputs must not suggest unsupported edits');
  await page.screenshot({ path: path.join(out, 'smartart-editor.png') });
  report.checks.push('Real Vue editor shows cached SmartArt and protects its structure');

  await open(path.join(fixtures, 'generated/typography-rich.pptx'));
  const object = () => page.locator('[data-testid="presentation-object"][aria-label^="RICH_RUNS，"]');
  const styles = async () => {
    const id = await object().getAttribute('data-object-id');
    return page.getByTestId('presentation-stage').evaluate((stage, id) => {
      const group = [...stage.querySelectorAll('svg [data-object-id]')].find(node => node.getAttribute('data-object-id') === id);
      return [...group.querySelectorAll('text')].map(node => ({ text: node.textContent, weight: node.getAttribute('font-weight'), color: node.getAttribute('fill'), size: node.getAttribute('font-size') }));
    }, id);
  };
  const before = await styles();
  assert.ok(new Set(before.map(run => run.color)).size >= 3);
  assert.ok(new Set(before.map(run => run.size)).size >= 3);
  await page.screenshot({ path: path.join(out, 'rich-text-editor.png') });
  await object().click();
  await page.getByTitle('加粗', { exact: true }).click();
  await page.getByTitle('加粗', { exact: true }).click();
  assert.ok((await styles()).every(run => run.weight === '700'));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = path.join(out, 'toolbar-styled.pptx');
  await (await download).saveAs(saved);
  const parts = unzipSync(fs.readFileSync(saved));
  const xml = strFromU8(parts['ppt/slides/slide1.xml']);
  const rawBold = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const shape = [...doc.getElementsByTagNameNS('*', 'sp')].find(node => [...node.getElementsByTagNameNS('*', 'cNvPr')].some(n => n.getAttribute('name') === 'RICH_RUNS'));
    return [...shape.getElementsByTagNameNS('*', 'rPr')].map(node => node.getAttribute('b'));
  }, xml);
  assert.ok(rawBold.length >= 4 && rawBold.every(value => value === '1'));
  await open(saved);
  assert.ok((await styles()).every(run => run.weight === '700'));
  report.checks.push('Actual toolbar toggle back to initial bold value updates all runs in the downloaded PPTX and survives UI reopen');
  await object().dblclick();
  await page.getByTestId('presentation-rich-text-edit-notice').waitFor();
  await page.getByTestId('presentation-text-editor').waitFor();
  assert.ok(await page.getByTestId('presentation-rich-text-edit-notice').isVisible());
  report.checks.push('Mixed-format plain text editing has a visible format-preservation explanation');
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; console.error(error); }
finally { await browser?.close(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); } })();
