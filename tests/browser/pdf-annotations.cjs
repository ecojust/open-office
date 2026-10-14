const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PDF_ANNOTATIONS_OUTPUT || path.join(root, 'test-results/pdf-annotations'));
const python = path.join(root, 'pdf-backend/.venv/bin/python');
const url = process.env.PDF_QA_URL || 'http://127.0.0.1:5198/';
fs.mkdirSync(out, { recursive: true });
execFileSync(python, ['-c', `import sys,base64;sys.path.insert(0,'pdf-backend/tests');from test_annotations import fixture;open(sys.argv[1],'wb').write(base64.b64decode(fixture()))`, out + '/fixture.pdf'], { cwd: root });
const report = { scope: 'Actual Vue UI + local PyMuPDF, serialized PDF independently reopened; no native package validation', checks: [], errors: [] };
let browser, page;
const ok = name => { report.checks.push(name); console.log('PASS', name); };
async function idle() {
  await page.getByTestId('pdf-busy').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.pdf-render-indicator'));
}
async function operation(name, action) {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/__pdf-dev') && r.request().postDataJSON()?.operation === name), action()]);
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); await idle(); return result;
}
async function waitItems(count) { await page.waitForFunction(n => document.querySelectorAll('[data-testid="pdf-annotation-item"]').length === n, count); }
async function save(file) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await (await download).saveAs(file);
}
(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(30000); await page.routeWebSocket('**', () => {});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(url);
    await page.getByTestId('document-open-input').setInputFiles(out + '/fixture.pdf');
    await page.getByTestId('pdf-editor').waitFor(); await idle();
    await page.getByTestId('pdf-annotations-tab').click(); await waitItems(4);
    await page.getByTestId('pdf-annotation-item').filter({ hasText: 'highlight' }).click();
    assert.equal(await page.getByTestId('pdf-annotation-content').inputValue(), 'highlight');
    assert.equal(await page.locator('.pdf-annotation-overlay button.chosen').count(), 1);
    ok('Current-page annotation list selects and locates existing highlights');
    await page.getByTestId('pdf-annotation-content').fill('中文审核：请复核此处');
    await page.getByTestId('pdf-annotation-author').fill('审阅者');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.getByTestId('pdf-page-number').inputValue(), '1');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未应用' }).waitFor();
    assert.equal(await page.getByTestId('pdf-annotation-content').inputValue(), '中文审核：请复核此处');
    ok('Unapplied annotation drafts prevent page switching and saving');
    await operation('update_annotation', () => page.getByTestId('pdf-annotation-apply').click());
    await waitItems(4); await page.getByTestId('pdf-annotation-item').filter({ hasText: '中文审核' }).waitFor();
    await page.getByTestId('pdf-annotation-item').filter({ hasText: '中文审核' }).click();
    await page.getByTestId('pdf-annotation-content').fill('未应用草稿');
    await page.getByTestId('pdf-undo').click();
    assert.equal(await page.getByTestId('pdf-annotation-content').inputValue(), '未应用草稿');
    await page.getByTestId('pdf-clear-placement').click();
    ok('Undo refuses to discard an unapplied annotation draft');
    await operation('inspect', () => page.getByTestId('pdf-undo').click());
    await page.getByTestId('pdf-annotation-item').filter({ hasText: 'highlight' }).waitFor();
    await operation('inspect', () => page.getByTestId('pdf-redo').click());
    await page.getByTestId('pdf-annotation-item').filter({ hasText: '中文审核' }).waitFor();
    ok('Remark edits participate in actual PDF undo and redo');
    await page.getByTestId('pdf-annotation-item').filter({ hasText: 'square' }).click();
    assert.equal(await page.getByTestId('pdf-annotation-content').isDisabled(), true);
    assert.equal(await page.getByTestId('pdf-annotation-delete').isDisabled(), true);
    ok('Unsupported annotation types remain explicitly read-only');
    await page.getByLabel('取消当前编辑', { exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await idle(); await waitItems(0);
    await page.getByTestId('pdf-tool-note').click(); await idle();
    await page.getByTestId('pdf-page-surface').click({ position: { x: 110, y: 170 } });
    await page.getByTestId('pdf-annotation-content').fill('第二页的便签\n检查日期和金额');
    await page.getByTestId('pdf-annotation-author').fill('本地审阅');
    await operation('add_note', () => page.getByTestId('pdf-note-apply').click()); await waitItems(1);
    await page.getByTestId('pdf-annotation-item').click();
    await page.screenshot({ path: out + '/pdf-annotation-editing.png', fullPage: true });
    await save(out + '/reviewed.pdf');
    execFileSync(python, ['-c', `import sys,pymupdf;d=pymupdf.open(sys.argv[1]);p=d[0];a=list(p.annots());assert len(a)==4;assert a[0].info['content']=='中文审核：请复核此处';assert a[0].info['title']=='审阅者';assert 'ORIGINAL BODY' in p.get_text();assert len(p.get_links())==1;assert next(p.widgets()).field_value=='KeptValue';p=d[1];a=list(p.annots());assert len(a)==1;assert a[0].info['content']=='第二页的便签\\n检查日期和金额';assert a[0].info['title']=='本地审阅';assert d.get_toc()==[[1,'Original bookmark',2]]`, out + '/reviewed.pdf']);
    ok('Added Chinese note and edited comment save as real annotations, preserving text, link, form and bookmark');
    await operation('delete_annotation', () => page.getByTestId('pdf-annotation-delete').click()); await waitItems(0);
    await operation('inspect', () => page.getByTestId('pdf-undo').click()); await waitItems(1);
    await operation('inspect', () => page.getByTestId('pdf-redo').click()); await waitItems(0);
    await save(out + '/removed.pdf');
    execFileSync(python, ['-c', `import sys,pymupdf;d=pymupdf.open(sys.argv[1]);assert len(list(d[0].annots()))==4;assert list(d[1].annots())==[];assert 'SECOND BODY' in d[1].get_text()`, out + '/removed.pdf']);
    ok('Deleting selected note preserves all other annotations and supports undo/redo');
    await page.getByTestId('document-open-input').setInputFiles(out + '/reviewed.pdf'); await idle();
    await page.getByTestId('pdf-annotations-tab').click(); await waitItems(4);
    await page.getByTestId('pdf-annotation-item').filter({ hasText: '中文审核' }).click();
    assert.equal(await page.getByTestId('pdf-annotation-author').inputValue(), '审阅者');
    ok('Saved PDF reopens with editable original comments');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await idle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/pdf-annotations-${width}.png`, fullPage: true });
    }
    ok('Annotation panel fits 390 px and 320 px windows');
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error); process.exitCode = 1; console.error(error);
    await page?.screenshot({ path: out + '/failure.png', fullPage: true }).catch(() => {});
  } finally {
    fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2)); await browser?.close();
  }
})();
