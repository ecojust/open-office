/* Vue-only interaction evidence. The PDF host is deliberately stubbed because this
 * check does not rebuild WASM or claim to verify PDF appearance/export fidelity. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/pdf-author-dialog');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, runtime: 'Vue in Chromium with a stub PDF host', checks: [], screenshots: [], errors: [], limitations: ['Does not exercise PDF WASM, stamp rendering, native WebView or filesystem saving.'] };
let server, browser;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app" style="height:100vh;display:flex"></div><script type="module">
import { createApp, h } from 'vue';
import Editor from '/src/components/RustPdfEditor.vue';
import '/src/style.css';
window.__authorUI = { statuses: [], authors: [], interactive: [], ready: false };
createApp({ render: () => h(Editor, { document: { id: 'pdf-author-ui', name: '署名示例.pdf', kind: 'pdf', extension: 'pdf', base64: '', sizeBytes: 0, sha256: '' }, active: true, onReady: () => window.__authorUI.ready = true, onStatus: value => window.__authorUI.statuses.push(value) }) }).mount('#app');
</script></body></html>`;
const mock = `import { normalizePdfAuthor, pdfAuthorPreference } from '/src/pdf/author.ts';
export async function setRustPdfTheme() {}
export async function prepareRustPdfDocument() {
 const session = { snapshot: { sessionId: 'pdf-author-ui', documentId: 1, revision: 1, dirty: false, pageCount: 1, pages: [{ index: 0 }] },
 subscribe: () => () => {}, onEvent: () => () => {}, settled: async () => {},
 attach: async element => { element.style.background = 'var(--ui-surface-muted)'; },
 setInteractive: value => window.__authorUI.interactive.push(value), deactivate() {}, close: async () => {},
 setAuthor: async value => { const author = normalizePdfAuthor(value); window.__authorUI.authors.push(author); return pdfAuthorPreference.save(author); },
 inspect: async () => session.snapshot, canBackgroundExport: async () => true,
 };
 return { take: () => session, discard() {} };
}`;
(async () => {
 try {
  const { createServer } = await import('vite');
  server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), optimizeDeps: { entries: ['index.html'] }, plugins: [{ name: 'pdf-author-ui-fixture', configureServer(instance) {
   instance.middlewares.use(async (request, response, next) => {
    if (request.url?.split('?')[0] !== '/pdf-author-test') return next();
    response.setHeader('Content-Type', 'text/html'); response.end(await instance.transformIndexHtml('/pdf-author-test', html));
   });
  } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_PDF_AUTHOR_PORT || 5326), strictPort: true, hmr: false, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] } } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: 'zh-CN' });
  await context.route('**/src/pdf/rust/client.ts', route => route.fulfill({ contentType: 'application/javascript', body: mock }));
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/pdf-author-test'); await page.waitForFunction(() => window.__authorUI?.ready);
  const trigger = page.getByRole('button', { name: '设置图章署名' }), input = page.getByRole('textbox', { name: '姓名或署名' });
  assert.match(await trigger.textContent(), /未设置/);
  await trigger.click(); await input.waitFor(); assert.equal(await input.evaluate(node => document.activeElement === node), true);
  await input.fill('取消的署名'); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
  assert.deepEqual(await page.evaluate(() => window.__authorUI.authors), []);
  report.checks.push('cancel-restores-focus-and-keeps-identity');
  await trigger.click(); await input.fill('陈江 · Open Office'); await page.getByRole('button', { name: '保存署名', exact: true }).click();
  assert.match(await trigger.textContent(), /陈江 · Open Office/);
  assert.equal(await page.evaluate(() => localStorage.getItem('open-office.pdf-author')), '陈江 · Open Office');
  assert.deepEqual(await page.evaluate(() => window.__authorUI.authors), ['陈江 · Open Office']);
  await page.reload(); await page.waitForFunction(() => window.__authorUI?.ready); assert.match(await trigger.textContent(), /陈江 · Open Office/);
  report.checks.push('unicode-author-saves-and-survives-reload');
  await trigger.click(); await input.fill('x'.repeat(201)); await page.getByRole('button', { name: '保存署名', exact: true }).click();
  assert.match(await page.getByRole('alert').textContent(), /200/); assert.equal(await input.getAttribute('aria-invalid'), 'true');
  await input.evaluate(node => { node.value = 'bad\u0000name'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.getByRole('button', { name: '保存署名', exact: true }).click(); assert.match(await page.getByRole('alert').textContent(), /控制字符/);
  assert.equal(await page.evaluate(() => localStorage.getItem('open-office.pdf-author')), '陈江 · Open Office');
  report.checks.push('invalid-author-is-explained-and-preserves-the-saved-choice');
  await input.fill('陈江 · Open Office');
  for (const [width, theme] of [[1100, 'light'], [360, 'light'], [360, 'dark']]) {
   await page.setViewportSize({ width, height: 760 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
   const box = await page.getByRole('dialog').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width, 'Dialog must fit the viewport');
   await page.getByRole('button', { name: '保存署名', exact: true }).focus(); await page.keyboard.press('Tab'); assert.equal(await input.evaluate(node => document.activeElement === node), true);
   const file = `author-${width}-${theme}.png`; await page.screenshot({ path: path.join(output, file) }); report.screenshots.push(file);
  }
  report.checks.push('dialog-fits-narrow-light-and-dark-screens-and-traps-tab');
  await input.fill(''); await page.getByRole('button', { name: '保存署名', exact: true }).click(); assert.match(await trigger.textContent(), /未设置/);
  assert.equal(await page.evaluate(() => localStorage.getItem('open-office.pdf-author')), '');
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
  report.checks.push('clear-removes-author-and-restores-focus');
  assert.deepEqual(report.errors, []); report.ok = true;
 } catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
 finally { report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); }
 console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
})();
