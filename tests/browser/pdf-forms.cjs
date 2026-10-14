const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PDF_FORMS_OUTPUT || path.join(root, 'test-results/pdf-forms'));
const python = path.join(root, 'pdf-backend/.venv/bin/python');
const url = process.env.PDF_QA_URL || 'http://127.0.0.1:5198/';
fs.mkdirSync(out, { recursive: true });
execFileSync(python, ['-c', `import sys,base64;sys.path.insert(0,'pdf-backend/tests');from test_forms import fixture;open(sys.argv[1],'wb').write(base64.b64decode(fixture()))`, out + '/fixture.pdf'], { cwd: root });
const report = { scope: 'Actual Vue + local backend, real exported bytes reopened independently with PyMuPDF and PDF.js; no desktop binary validation', checks: [], errors: [] };
let browser, page;
const ok = name => { report.checks.push(name); console.log('PASS', name); };
async function idle() { await page.getByTestId('pdf-busy').waitFor({ state: 'hidden' }); await page.waitForFunction(() => !document.querySelector('.pdf-render-indicator')); }
async function operation(name, action) {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/__pdf-dev') && r.request().postDataJSON()?.operation === name), action()]);
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); await idle(); return result;
}
async function items(count) { await page.waitForFunction(n => document.querySelectorAll('[data-testid="pdf-form-item"]').length === n, count); }
async function save(file) { const download = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click(); await (await download).saveAs(file); }
(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url); await page.getByTestId('document-open-input').setInputFiles(out + '/fixture.pdf');
    await page.getByTestId('pdf-editor').waitFor(); await idle();
    await page.getByTestId('pdf-forms-tab').click(); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Full name' }).click();
    assert.equal(await page.getByTestId('pdf-form-value').inputValue(), 'Original name');
    assert.equal(await page.locator('.pdf-form-overlay button.chosen').count(), 1);
    ok('Current-page field list locates the actual PDF widget');
    await page.getByTestId('pdf-form-value').fill('中文姓名 Alice');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.getByTestId('pdf-page-number').inputValue(), '1');
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Consent' }).click();
    assert.equal(await page.getByTestId('pdf-form-value').inputValue(), '中文姓名 Alice');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未应用' }).waitFor();
    ok('Unapplied text draft blocks pagination, selecting another field and saving');
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click()); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: '中文姓名 Alice' }).waitFor();
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Full name' }).click();
    await page.getByTestId('pdf-form-value').fill('Do not lose draft');
    await page.getByTestId('pdf-undo').click();
    assert.equal(await page.getByTestId('pdf-form-value').inputValue(), 'Do not lose draft');
    await page.getByTestId('pdf-clear-placement').click();
    await operation('inspect', () => page.getByTestId('pdf-undo').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Original name' }).waitFor();
    await operation('inspect', () => page.getByTestId('pdf-redo').click());
    await page.getByTestId('pdf-form-item').filter({ hasText: '中文姓名 Alice' }).waitFor();
    ok('Applied values participate in real PDF undo/redo; draft undo is refused');
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Details' }).click();
    await page.getByTestId('pdf-form-value').fill('第一行\nSecond line');
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click()); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Consent' }).click();
    await page.getByTestId('pdf-form-checkbox').check();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.getByTestId('pdf-page-number').inputValue(), '1');
    await operation('fill_field', () => page.getByTestId('pdf-form-apply').click()); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Consent' }).filter({ hasText: '已勾选' }).waitFor();
    ok('Multiline Unicode and custom-state checkbox apply to PDF bytes');
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Read only' }).click();
    assert.equal(await page.getByTestId('pdf-form-value').isDisabled(), true);
    assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    ok('Read-only field remains visible and cannot be changed');
    await page.getByLabel('取消当前编辑', { exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await idle(); await items(1);
    await page.getByTestId('pdf-form-item').click(); assert.equal(await page.getByTestId('pdf-form-value').inputValue(), 'Page two');
    await page.getByLabel('取消当前编辑', { exact: true }).click();
    await page.getByRole('button', { name: '上一页', exact: true }).click(); await idle(); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Full name' }).click();
    assert.equal(await page.getByTestId('pdf-form-apply').isDisabled(), true);
    if (await page.getByLabel('关闭错误提示').isVisible()) await page.getByLabel('关闭错误提示').click();
    await page.screenshot({ path: out + '/pdf-form-filling.png', fullPage: true });
    await save(out + '/filled.pdf');
    execFileSync(python, ['-c', `import sys,pymupdf;d=pymupdf.open(sys.argv[1]);p=d[0];w=list(p.widgets());assert w[0].field_value=='中文姓名 Alice';assert w[1].field_value=='第一行\\nSecond line';assert w[2].field_value=='Accepted';assert w[3].field_value=='Preserved';assert d.xref_get_key(w[2].xref,'AS')==('name','/Accepted');assert d.xref_get_key(w[0].xref,'DV')==('string','Default stays');assert '中文姓名 Alice' in p.get_text();assert next(p.annots()).info['content']=='Keep this note';assert len(p.get_links())==1;assert len(d.get_toc())==2`, out + '/filled.pdf']);
    ok('Independent PyMuPDF reopen verifies V/AS, real appearance text and preserved unrelated content');
    const readback = await page.evaluate(async base64 => {
      const pdfjs = await import('/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs';
      const data = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' }).promise;
      try {
        const fields = await doc.getFieldObjects(); const p = await doc.getPage(1); const annotations = await p.getAnnotations();
        const canvas = document.createElement('canvas'); const viewport = p.getViewport({ scale: 1 }); canvas.width = viewport.width; canvas.height = viewport.height;
        await p.render({ canvas, viewport }).promise;
        return { fields: fields ? Object.fromEntries(fields) : {}, annotations: annotations.filter(a => a.subtype === 'Widget').map(a => ({ name: a.fieldName, value: a.fieldValue, exportValue: a.exportValue, hasAppearance: a.hasAppearance })), image: canvas.toDataURL('image/png') };
      } finally { await doc.loadingTask.destroy(); }
    }, fs.readFileSync(out + '/filled.pdf').toString('base64'));
    assert.equal(readback.fields['Full name'][0].value, '中文姓名 Alice');
    assert.equal(readback.fields.Details[0].value, '第一行\nSecond line');
    assert.equal(readback.fields.Consent[0].value, 'Accepted');
    assert.equal(readback.annotations.find(a => a.name === 'Consent').exportValue, 'Accepted');
    assert.ok(readback.annotations.every(a => a.hasAppearance));
    fs.writeFileSync(out + '/pdfjs-independent.png', Buffer.from(readback.image.split(',')[1], 'base64'));
    delete readback.image; report.pdfjs = readback;
    ok('Independent PDF.js parser reads text/multiline/custom on-state and renders saved appearance streams');
    await page.getByTestId('document-open-input').setInputFiles(out + '/filled.pdf'); await idle();
    await page.getByTestId('pdf-forms-tab').click(); await items(4);
    await page.getByTestId('pdf-form-item').filter({ hasText: 'Full name' }).click();
    assert.equal(await page.getByTestId('pdf-form-value').inputValue(), '中文姓名 Alice');
    assert.equal(await page.getByTestId('pdf-form-value').isDisabled(), false);
    ok('Saved PDF reopens in the actual editor with editable form values');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await idle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/pdf-forms-${width}.png`, fullPage: true });
    }
    ok('Field panel and navigation fit 390 px and 320 px widths');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
    await page?.screenshot({ path: out + '/failure.png', fullPage: true }).catch(() => {});
  } finally { fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2)); await browser?.close(); }
})();
