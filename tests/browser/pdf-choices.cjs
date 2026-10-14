/** Real Vue field controls + local PDF backend; independently audited saved PDF. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PDF_CHOICES_OUTPUT || path.join(root, 'test-results/pdf-choices/ui'));
const python = path.join(root, 'pdf-backend/.venv/bin/python');
const url = process.env.PDF_QA_URL || 'http://127.0.0.1:5199/';
fs.mkdirSync(out, { recursive: true });
execFileSync(python, ['tests/compatibility/pdf-choices/make-fixture.py', out], { cwd: root });
const report = { scope: 'Real Vue UI and local PDF backend; saved output independently parsed with pypdf. No installed desktop package validation.', checks: [], errors: [] };
let browser, page;
const ok = name => { report.checks.push(name); console.log('PASS', name); };
async function idle() { await page.getByTestId('pdf-busy').waitFor({ state: 'hidden' }); await page.waitForFunction(() => !document.querySelector('.pdf-render-indicator')); }
async function operation(name, action) {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/__pdf-dev') && r.request().postDataJSON()?.operation === name), action()]);
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); await idle(); return result;
}
async function choose(name) { await page.getByTestId('pdf-form-item').filter({ hasText: name }).click(); }
async function save(file) { const event = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click(); await (await event).saveAs(file); }
(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url); await page.getByTestId('document-open-input').setInputFiles(out + '/choice-source.pdf');
    await page.getByTestId('pdf-editor').waitFor(); await idle(); await page.getByTestId('pdf-forms-tab').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pdf-form-item"]').length === 5);
    await choose('City'); const choice = page.getByTestId('pdf-form-choice');
    assert.equal(await choice.inputValue(), '0');
    assert.deepEqual(await choice.locator('option').allTextContents(), ['北京 Beijing', '上海 Shanghai', '广州 Guangzhou']);
    assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    ok('Combo control shows display labels while its values retain export codes');
    await choice.selectOption('1'); await choose('Department');
    assert.equal(await choice.inputValue(), '1');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未应用' }).waitFor();
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: '上海 Shanghai' }).waitFor();
    ok('Unapplied selection blocks switching fields and saving; applying updates the actual PDF');
    await choose('Department'); assert.equal(await choice.getAttribute('size'), '3');
    await choice.selectOption('2'); await operation('fill_field', () => page.getByTestId('pdf-form-apply').click());
    await operation('inspect', () => page.getByTestId('pdf-undo').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Front desk' }).waitFor();
    await operation('inspect', () => page.getByTestId('pdf-redo').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Night team' }).waitFor();
    ok('List selection applies and participates in real PDF byte-history undo/redo');
    await choose('Plain choice'); await choice.selectOption('1');
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click());
    for (const name of ['Multiple choice', 'Locked choice']) {
      await choose(name); assert.equal(await choice.isDisabled(), true); assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    }
    ok('Multi-select and read-only choice fields remain visible and explicitly disabled');
    assert.ok(await page.getByTestId('pdf-form-item').filter({ hasText: 'Multiple choice' }).innerText().then(text => text.includes('多选值（只读）')));
    if (await page.getByLabel('关闭错误提示').isVisible()) await page.getByLabel('关闭错误提示').click();
    await choose('Department'); await page.screenshot({ path: out + '/pdf-choice-fields.png', fullPage: true });
    await save(out + '/choice-ui-filled.pdf');
    execFileSync('python3', ['tests/compatibility/pdf-choices/audit.py', out + '/choice-source.pdf', out + '/choice-ui-filled.pdf', out + '/independent-ui-audit.json'], { cwd: root });
    ok('Saved UI output passes the independent 59-check pypdf value, appearance and preservation audit');
    await page.getByTestId('document-open-input').setInputFiles(out + '/choice-ui-filled.pdf'); await idle(); await page.getByTestId('pdf-forms-tab').click();
    for (const [name, value] of [['City', '1'], ['Department', '2'], ['Plain choice', '1']]) {
      await choose(name); assert.equal(await choice.inputValue(), value); assert.equal(await choice.isDisabled(), false);
    }
    ok('Actual saved file reopens with all three selections still editable');
    await choose('Department');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await idle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/pdf-choices-${width}.png`, fullPage: true });
    }
    ok('Selection controls fit 390 px and 320 px windows without page overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByTestId('document-open-input').setInputFiles(out + '/choice-empty-source.pdf'); await idle(); await page.getByTestId('pdf-forms-tab').click();
    await choose('City'); assert.equal(await choice.inputValue(), '');
    assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    await choice.selectOption('0'); assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), false);
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: 'No preference' }).waitFor();
    await save(out + '/choice-empty-ui-filled.pdf');
    execFileSync('python3', ['-c', `import sys;from pypdf import PdfReader;d=PdfReader(sys.argv[1]);w=d.pages[0]['/Annots'][0].get_object();assert str(w['/V'])=='';assert list(w['/I'])==[0]`, out + '/choice-empty-ui-filled.pdf']);
    await page.getByTestId('document-open-input').setInputFiles(out + '/choice-empty-ui-filled.pdf'); await idle(); await page.getByTestId('pdf-forms-tab').click(); await choose('City');
    assert.equal(await choice.inputValue(), '0'); assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    ok('An unselected field can explicitly choose an empty export value, save and reopen without placeholder collision');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
    await page?.screenshot({ path: out + '/failure.png', fullPage: true }).catch(() => {});
  } finally { fs.writeFileSync(out + '/ui-report.json', JSON.stringify(report, null, 2)); await browser?.close(); }
})();
