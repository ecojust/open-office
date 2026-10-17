/* Real Vue notebook UI and clipboard-event routing in Chromium.
 * Native clipboard contents are stubbed; Finder/WKWebView require macOS verification.
 * Run: node tests/browser/notebook-clipboard.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.OFFICE_NOTE_CLIPBOARD_OUTPUT || path.join(root, 'test-results/notebook-clipboard'));
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], errors: [], consoleErrors: [], limitations: ['Chromium clipboard events use deterministic File payloads.', 'The native clipboard command is stubbed; this does not validate Finder or WKWebView on macOS.'] };
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let server, browser, page;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const canvas = () => page.getByTestId('notebook-canvas');
const images = () => page.locator('.note-region-image');
const body = () => page.getByTestId('notebook-content').first();
async function model() { return page.evaluate(async () => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((await window.__noteEditor.value.exportFile()).base64), c => c.charCodeAt(0))))); }
async function ready() {
 const deadline = Date.now() + 10000;
 while (!(await page.evaluate(async () => !!(await window.__noteEditor.value?.canBackgroundExport())))) {
  if (Date.now() >= deadline) throw Error('Notebook paste did not release the save barrier');
  await page.waitForTimeout(20);
 }
 await frame();
}
async function check(name, run) { report.stage = name; persist(); await run(); report.checks.push(name); persist(); }
async function blank() { await canvas().click({ position: { x: 700, y: 30 } }); await frame(); assert.equal(await page.locator('.note-region.selected').count(), 0); assert.equal(await canvas().evaluate(el => el === document.activeElement), true); }
async function paste(files = [], { text = '', html = '' } = {}) {
 await page.evaluate(({ files, text, html, png }) => {
  const data = new DataTransfer();
  for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.base64 || png), c => c.charCodeAt(0))], file.name, { type: file.type || '' }));
  if (text) data.setData('text/plain', text); if (html) data.setData('text/html', html);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
 }, { files, text, html, png });
}
async function expectImages(count) { await page.waitForFunction(count => document.querySelectorAll('.note-region-image').length === count, count); await ready(); }
async function configureNative(options) { await page.evaluate(options => Object.assign(window.__clipboardQa, options), options); }
async function pressPaste() { await canvas().dispatchEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true }); }
(async () => {
 try {
  const { createServer } = await import('vite');
  const harness = `import {createApp,h,ref} from 'vue'; import NotebookEditor from '/src/components/NotebookEditor.vue'; import {createNotebook} from '/src/notes/model.ts'; import {bytesToBase64} from '/src/shared/document.ts'; import '/src/style.css';
   window.__noteEditor=ref(); window.__noteDisabled=ref(false);
   const value=createNotebook('图片粘贴验证'), bytes=new TextEncoder().encode(JSON.stringify(value));
   createApp({setup(){return()=>h(NotebookEditor,{ref:window.__noteEditor,document:{id:'clipboard-note',name:'图片粘贴验证.oonote',kind:'note',extension:'oonote',base64:bytesToBase64(bytes),sha256:'test',sizeBytes:bytes.length},disabled:window.__noteDisabled.value,theme:'light'});}}).mount('#note-app');`;
  const html = '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body,#note-app{margin:0;width:100%;height:100%;overflow:hidden}#note-app{display:flex}.notebook-editor{width:100%;height:100%}</style></head><body><div id="note-app"></div><script type="module" src="/__note_clipboard__.js"></script></body></html>';
  server = await createServer({ root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'), plugins: [{ name: 'note-clipboard-harness', resolveId(id) { if (id === '/__note_clipboard__.js') return '\0note-clipboard-harness'; }, load(id) { if (id === '\0note-clipboard-harness') return harness; }, configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== '/__note-clipboard__') return next(); res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); }); } }], server: { host: '127.0.0.1', port: Number(process.env.OFFICE_NOTE_CLIPBOARD_PORT || 5351), strictPort: true, hmr: false, watch: { ignored: ['**/vendor/**', '**/target/**', '**/.build/**', '**/test-results/**'] } } });
  await server.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'zh-CN' });
  await context.route('**/src/native.ts', route => route.fulfill({ contentType: 'application/javascript', body: `window.__clipboardQa={native:false,images:[],reads:0,delay:0,error:''}; export const isTauri=()=>window.__clipboardQa.native; export async function clipboardImages(){const q=window.__clipboardQa; q.reads++; const images=structuredClone(q.images); await new Promise(r=>setTimeout(r,q.delay)); if(q.error) throw Error(q.error); return images;}` }));
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => report.errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') report.consoleErrors.push(e.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__note-clipboard__`); await ready();
  await check('blank-canvas-pastes-file-manager-image-with-empty-MIME', async () => {
   await body().click(); await blank(); await paste([{ name: '照片.PNG' }], { text: '照片.PNG' }); await expectImages(1);
   const regions = (await model()).sections[0].pages[0].regions; assert.equal(regions.at(-1).blocks[0].alt, '照片.PNG'); assert.equal(regions[0].blocks[0].content.length, 0);
  });
  await check('multiple-files-and-selected-image-paste-once-in-independent-regions', async () => {
   await images().first().click(); await paste([{ name: 'second.png', type: 'application/octet-stream' }, { name: 'third.png', type: 'image/png' }]); await expectImages(3);
   const regions = (await model()).sections[0].pages[0].regions; assert.deepEqual(regions.slice(-2).map(r => r.blocks[0].alt), ['second.png', 'third.png']); assert.notEqual(regions.at(-2).y, regions.at(-1).y);
  });
  await check('screenshot-file-pastes-in-text-region-without-duplicate-bubbling', async () => {
   await body().click(); await paste([{ name: 'image', type: 'image/png' }]); await expectImages(4);
  });
  const nativeImage = { name: 'Finder 照片.png', mimeType: 'image/png', base64: png };
  await check('native-file-clipboard-wins-over-filename-text', async () => {
   await configureNative({ native: true, images: [nativeImage], reads: 0 }); await blank(); await paste([], { text: 'Finder 照片.png' }); await expectImages(5);
   assert.equal(await page.evaluate(() => window.__clipboardQa.reads), 1); assert.equal((await model()).sections[0].pages[0].regions[0].blocks[0].content.length, 0);
  });
  await check('keyboard-fallback-pastes-when-webview-does-not-send-paste', async () => {
   await blank(); await pressPaste(); await expectImages(6); assert.equal(await page.evaluate(() => window.__clipboardQa.reads), 2);
  });
  await check('normal-paste-cancels-keyboard-fallback', async () => {
   await blank(); await pressPaste(); await paste([{ name: 'browser.png', type: 'image/png' }]); await expectImages(7); await page.waitForTimeout(160);
   assert.equal(await images().count(), 7); assert.equal(await page.evaluate(() => window.__clipboardQa.reads), 2);
  });
  await check('late-paste-replaces-inflight-fallback-without-double-insertion', async () => {
   await configureNative({ delay: 350 }); await blank(); await pressPaste(); await page.waitForFunction(() => window.__clipboardQa.reads === 3);
   await paste([{ name: 'late.png', type: 'image/png' }]); await expectImages(8); await page.waitForTimeout(450); assert.equal(await images().count(), 8); await configureNative({ delay: 0 });
  });
  await check('plain-text-rich-text-and-inline-browser-image-still-paste', async () => {
   await configureNative({ images: [] }); await body().click(); await paste([], { text: '中文粘贴' }); await ready(); assert.match(await body().innerText(), /中文粘贴/);
   await body().click(); await page.keyboard.press('End'); await paste([], { html: '<strong>加粗文本</strong>' }); await ready(); assert.equal(await body().locator('strong').innerText(), '加粗文本');
   await blank(); await paste([], { html: '<img src="data:image/png;base64,' + png + '" alt="网页图片">' }); await expectImages(9);
  });
  await check('native-clipboard-failure-does-not-block-normal-text', async () => {
   await configureNative({ images: [], error: 'Native clipboard unavailable' }); await body().click(); await paste([], { text: '文本仍可粘贴' }); await ready(); assert.match(await body().innerText(), /文本仍可粘贴/); await configureNative({ error: '' });
  });
  await check('delayed-native-lookup-keeps-original-text-destination-and-caret', async () => {
   await page.getByRole('button', { name: '添加文本区域', exact: true }).click(); await ready(); const other = page.getByTestId('notebook-content').last();
   await configureNative({ images: [], delay: 350 }); await body().click(); await body().evaluate(el => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node = walker.nextNode(), range = document.createRange(); range.setStart(node, 1); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); });
   const before = await body().innerText(), otherBefore = await other.innerText(); await paste([], { text: '定位' }); assert.equal(await page.evaluate(() => window.__noteEditor.value.canBackgroundExport()), false); await other.click(); await ready(); report.caretEvidence = await page.getByTestId('notebook-content').allInnerTexts(); persist(); assert.equal(await body().innerText(), before.slice(0, 1) + '定位' + before.slice(1)); assert.equal(await other.innerText(), otherBefore); await configureNative({ delay: 0 });
  });
  await check('invalid-image-is-rejected-without-document-mutation', async () => {
   await configureNative({ native: false }); await blank(); const before = await model(); await paste([{ name: 'fake.png', base64: Buffer.from('not an image').toString('base64') }]); await ready(); assert.deepEqual(await model(), before); assert.equal(await images().count(), 9);
  });
  await check('inactive-editor-and-inflight-clipboard-cannot-write', async () => {
   await configureNative({ native: true, images: [nativeImage], delay: 350 }); await blank(); const count = await page.evaluate(() => window.__clipboardQa.reads); await paste(); await page.waitForFunction(count => window.__clipboardQa.reads > count, count);
   await page.evaluate(() => { window.__noteDisabled.value = true; }); await frame(); await paste([{ name: 'blocked.png' }]); await frame(); assert.equal(await images().count(), 9);
   await page.evaluate(() => { window.__noteDisabled.value = false; }); await ready(); await page.waitForTimeout(400); assert.equal(await images().count(), 9, 'Reactivating does not revive the cancelled request');
  });
  await page.screenshot({ path: path.join(output, 'pasted-image-regions.png'), fullPage: true });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); report.ok = true; persist(); console.log(JSON.stringify({ ok: true, checks: report.checks.length, report: path.join(output, 'report.json') }));
 } catch (error) { report.error = error.stack; persist(); console.error(error); process.exitCode = 1; }
 finally { await browser?.close(); await server?.close(); }
})();
