/* Real Vue PDF editor + actual local PyMuPDF, with three saved-file reopens.
 * The input is an original generated fixture. This does not validate Acrobat,
 * native file dialogs, certificate signatures, or form editing support.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PDF_COMPLEX_OUTPUT || path.join(root, 'test-results/pdf-complex', new Date().toISOString().replace(/[:.]/g, '-')));
const url = process.env.PDF_COMPLEX_URL || 'http://127.0.0.1:5198/';
const origin = new URL(url).origin;
const python = process.env.PDF_COMPLEX_PYTHON || path.join(root, 'pdf-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const fixtureScript = path.join(__dirname, 'generate-complex-pdf.py');
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(python)) throw Error('Run npm run pdf:ensure before this regression.');
const runPython = args => JSON.parse(execFileSync(python, [fixtureScript, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 }));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Real Vue App/PdfEditor in Chromium, actual local PDF backend, independent PyMuPDF saved-file readback; no native-dialog or Acrobat interoperability claim',
  fixture: runPython(['generate', out]), rounds: [], checks: [], requests: [], externalRequests: [], externalSockets: [], httpFailures: [], pageErrors: [] };
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let browser, page, activeName = '', phase = 'startup';
function ok(name, detail = {}) { report.checks.push({ name, ...detail }); console.log('PASS', name); persist(); }

async function idle() {
  await page.getByTestId('pdf-busy').waitFor({ state: 'hidden', timeout: 45000 });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden', timeout: 45000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="pdf-canvas"]');
    return canvas?.width > 0 && canvas?.height > 0 && !document.querySelector('.pdf-render-indicator');
  }, null, { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('pdf-error').count(), 0, 'The PDF editor must not contain an operation error');
  assert.equal(await page.locator('.error-banner').count(), 0, 'The shell must not contain a save/import error');
}

async function requestOperation(operation, action) {
  const [raw] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/__pdf-dev' && response.request().postDataJSON()?.operation === operation),
    action(),
  ]);
  assert.equal(raw.ok(), true, `Local ${operation} HTTP request failed`);
  const response = await raw.json();
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.protocolVersion, 1);
  await idle();
  return response;
}

async function openFile(file) {
  phase = `open ${path.basename(file)}`; console.log('PHASE', phase);
  const result = await requestOperation('inspect', async () => {
    await page.getByTestId('document-open-input').setInputFiles(file);
    await page.getByTestId('pdf-editor').waitFor();
  });
  activeName = path.basename(file);
  assert.equal(result.metadata.pageCount, 12);
  assert.equal(await page.getByTestId('pdf-page-12').count(), 1);
  assert.equal(await page.getByTestId('pdf-tool-text').isEnabled(), true);
  assert.equal(await page.locator('.document-tab').count(), 1, 'A reopen must create a fresh PDF editor after closing the prior tab');
}

async function goTo(number) {
  await page.getByTestId(`pdf-page-${number}`).click();
  await page.waitForFunction(expected => document.querySelector('[data-testid="pdf-page-number"]')?.value === String(expected), number);
  await idle();
}

async function screenshot(name) {
  await idle();
  const pixels = await page.getByTestId('pdf-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d'), bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0, ink = 0, samples = 0;
    for (let offset = 0; offset < bytes.length; offset += 40) {
      samples++;
      if (bytes[offset] > 225 && bytes[offset + 1] > 225 && bytes[offset + 2] > 225) light++;
      if (bytes[offset] < 150 && bytes[offset + 1] < 170 && bytes[offset + 2] < 190) ink++;
    }
    return { width: canvas.width, height: canvas.height, light, ink, samples };
  });
  assert.ok(pixels.light > pixels.samples * .4 && pixels.ink > 50, 'The real PDF canvas must contain a light page and visible nonblank ink');
  await page.screenshot({ path: path.join(out, name), fullPage: true });
  return pixels;
}

async function replace(pageNumber, replacement) {
  phase = `replace page ${pageNumber}`; console.log('PHASE', phase);
  await goTo(pageNumber);
  const original = `ORIGINAL-${String(pageNumber).padStart(2, '0')}`;
  await page.getByTestId('pdf-text-block').filter({ hasText: original }).click();
  await page.getByTestId('pdf-text-input').fill(replacement);
  await page.getByTestId('pdf-region-width').fill('440');
  await page.getByTestId('pdf-region-width').press('Tab');
  await page.getByTestId('pdf-region-height').fill('33');
  await page.getByTestId('pdf-region-height').press('Tab');
  const response = await requestOperation('replace_text', () => page.getByTestId('pdf-apply-text').click());
  const text = response.textBlocks.filter(block => block.pageIndex === pageNumber - 1).map(block => block.text).join('\n');
  assert.ok(text.includes(replacement), 'The backend must return the actual replacement text');
  assert.ok(!text.includes(original), 'The original text must be removed, not covered by a rectangle');
  // Successful mutations already clear their placement; only dismiss a panel
  // if the component still shows a selection, without waiting for a stale one.
  if (await page.getByTestId('pdf-clear-placement').count()) await page.getByTestId('pdf-clear-placement').click();
}

async function saveRound(round) {
  phase = `save round ${round}`; console.log('PHASE', phase);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const download = await downloadPromise;
  const file = path.join(out, `complex-round-${round}.pdf`);
  await download.saveAs(file);
  assert.equal(await download.failure(), null);
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent?.trim() === '已保存');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.subarray(0, 8).toString().startsWith('%PDF-'));
  const result = runPython(['verify', out, '--file', file, '--round', String(round)]);
  report.rounds.push({ ...result, file: path.basename(file) });
  ok(`Round ${round}: real saved PDF independently verified`, { sha256: result.fileSha256 });
  // Closing releases the PDF.js document; reopening reads the downloaded bytes
  // through the application's actual file input, not a cached response object.
  await page.getByRole('button', { name: `关闭 ${activeName}`, exact: true }).click();
  await page.locator('.document-tab').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog', { name: '保存你的修改？' }).count(), 0);
  await openFile(file);
  ok(`Round ${round}: downloaded file reopened through Vue PDF editor`);
  return file;
}

(async () => {
  try {
    persist();
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== origin) {
        report.externalRequests.push({ url: requestUrl.href, type: route.request().resourceType(), phase });
        await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(45000);
    await page.routeWebSocket('**', socket => {
      if (new URL(socket.url()).host !== new URL(url).host) report.externalSockets.push({ url: socket.url(), phase });
      socket.close(); // Disable only Vite HMR as well, keeping the tested source fixed.
    });
    page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
    page.on('request', request => {
      const parsed = new URL(request.url());
      if (['http:', 'https:'].includes(parsed.protocol)) report.requests.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin });
    });
    page.on('response', response => { if (response.status() >= 400) report.httpFailures.push({ status: response.status(), url: response.url(), phase }); });
    await page.goto(url);
    await openFile(path.join(out, 'complex-original.pdf'));
    await page.getByTestId('pdf-outline-tab').click();
    assert.equal(await page.getByTestId('pdf-outline-item').count(), 5);
    await page.getByTestId('pdf-outline-item').filter({ hasText: '附录 Appendix' }).click();
    await idle(); assert.equal(await page.getByTestId('pdf-page-number').inputValue(), '12');
    await page.locator('.pdf-sidebar-tabs').getByRole('button', { name: '页面', exact: true }).click();
    await goTo(1);
    const initialPixels = await screenshot('complex-original.png');
    ok('12-page complex PDF renders; actual bookmark navigation reaches page 12', { pixels: initialPixels });

    await replace(1, 'ROUND1 EDITED 中文');
    await screenshot('round-1-edit.png');
    await saveRound(1);
    await goTo(1);
    assert.equal(await page.getByTestId('pdf-text-block').filter({ hasText: 'ROUND1 EDITED 中文' }).count(), 1);

    await replace(5, 'ROUND2 EDITED 旋转');
    const rotatedPixels = await screenshot('round-2-rotated-edit.png');
    assert.ok(rotatedPixels.width > rotatedPixels.height, 'The 90-degree page should render in landscape');
    await saveRound(2);
    await goTo(5);
    assert.equal(await page.getByTestId('pdf-text-block').filter({ hasText: 'ROUND2 EDITED 旋转' }).count(), 1);

    await replace(12, 'ROUND3 EDITED 完成');
    await page.getByTestId('pdf-watermark').click();
    await page.getByTestId('pdf-watermark-text').fill('本地复核');
    await page.getByTestId('pdf-stamp-size').fill('24');
    await page.getByTestId('pdf-stamp-scope').selectOption('selected');
    await requestOperation('watermark', () => page.getByTestId('pdf-apply-stamp').click());
    await page.getByTestId('pdf-stamp-dialog').waitFor({ state: 'hidden' });
    const finalFile = await saveRound(3);
    await goTo(12);
    assert.equal(await page.getByTestId('pdf-text-block').filter({ hasText: 'ROUND3 EDITED 完成' }).count(), 1);
    assert.equal(await page.getByTestId('pdf-text-block').filter({ hasText: '本地复核' }).count(), 1);
    await screenshot('complex-final-page-12.png');
    await goTo(3); await screenshot('complex-preserved-table-and-form.png');
    await page.getByTestId('pdf-outline-tab').click();
    assert.equal(await page.getByTestId('pdf-outline-item').count(), 5);
    await page.getByTestId('pdf-outline-item').filter({ hasText: '项目总览 Overview' }).click();
    await idle(); assert.equal(await page.getByTestId('pdf-page-number').inputValue(), '1');
    await screenshot('complex-final-overview.png');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(finalFile)).digest('hex'), report.rounds[2].fileSha256);
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.externalSockets, []);
    assert.deepEqual(report.httpFailures, []); assert.deepEqual(report.pageErrors, []);
    ok('All three rounds preserve unrelated-page pixels, original images/tables/text, bookmarks, links, forms and annotations');
    ok('No external HTTP or WebSocket request attempted; all actual backend calls remain local');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = { phase, message: String(error.stack || error) };
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); persist(); await browser?.close();
    console.log('REPORT', path.join(out, 'report.json'));
  }
})();
