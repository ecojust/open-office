/* Actual production PDF WASM regression. This isolates the engine/host bridge;
 * mcp-editors.cjs covers the production HTTP transport and visible Vue editor.
 * It does not substitute for installed macOS/Windows WebView verification. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/office-pdf-mcp-engine');
const assetRoot = path.join(root, 'public/office-pdf');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const products = () => Object.fromEntries(['manifest.json', 'office_pdf.js', 'office_pdf_bg.wasm'].map(file => [file, hash(path.join(assetRoot, file))]));
const report = { ok: false, runtime: 'Production PDF Rust WASM host in Chromium, without a UI runner', checks: [], pageErrors: [],
  limitations: ['This is an engine/host regression; the HTTP and visible UI suite is separate. Installed WebViews are not covered.'] };
fs.mkdirSync(output, { recursive: true });
let server, browser;
(async () => {
  try {
    report.artifactCheck = execFileSync(process.execPath, ['scripts/build-office-pdf.mjs', '--check'], { cwd: root, encoding: 'utf8' }).trim();
    report.productsBefore = products();
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>PDF engine regression</title>'); return; }
      const file = path.resolve(assetRoot, '.' + pathname.replace(/^\/office-pdf/, ''));
      if (!pathname.startsWith('/office-pdf/') || !file.startsWith(assetRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
      fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const png = new PNG({ width: 32, height: 32 });
    for (let index = 0; index < 32 * 32; index++) png.data.set([15, 100, 190, 255], index * 4);
    const result = await page.evaluate(async image => {
      const bindings = await import('/office-pdf/office_pdf.js');
      await bindings.default({ module_or_path: new URL('/office-pdf/office_pdf_bg.wasm', location.origin) });
      const host = bindings.createHost(() => {}), checks = [];
      const check = (condition, message) => { if (!condition) throw Error(message); checks.push(message); };
      const raw = (id, command, params = {}) => JSON.parse(host.command(id, command, JSON.stringify(params)));
      const run = (id, command, params = {}, assets) => {
        const response = raw(id, 'mcp.execute', { command, params, ...(assets ? { assets } : {}) });
        if (!response.ok) throw Error(command + ': ' + response.error);
        return response;
      };
      const query = (id, command, params = {}) => {
        const response = raw(id, 'mcp.query', { command, params });
        if (!response.ok) throw Error(command + ': ' + response.error);
        return response.result;
      };
      const inspect = id => JSON.parse(host.inspect(id));
      const base64 = bytes => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
      const before = JSON.parse(host.prepare('main', 'Test.pdf', new Uint8Array()));
      const catalog = raw('main', 'mcp.commands').result.commands;
      check(catalog.length > 100 && !catalog.some(tool => ['doc_open', 'doc_save', 'js_run'].includes(tool.command)), 'Discovery exposes document commands and excludes system/file/script tools');
      check(catalog.every(tool => !tool.inputSchema.properties.doc), 'Current document identity cannot be supplied by the caller');
      const missing = raw('main', 'mcp.execute', { command: 'page_add_text', params: {} });
      check(!missing.ok && inspect('main').revision === before.revision, 'Missing arguments fail before creating a draft or changing the revision');
      run('main', 'page_add_text', { page: 1, text: 'Editable text', at: [40, 80], size: 18 });
      run('main', 'content_update', { page: 1, index: 1, text: 'Updated text', bold: true, color: '#ff0000' });
      check(query('main', 'content_list').items.some(item => item.text === 'Updated text' && item.bold), 'Existing added text is edited in the live document');
      run('main', 'comment_add', { page: 1, type: 'stamp', at: [220, 220], stamp: 'approved', dynamic: true, author: 'Open Office' });
      run('main', 'fill_sign_add', { page: 1, type: 'signature', at: [80, 300], text: 'Open Office', author: 'Open Office' });
      const comments = query('main', 'comment_list');
      check(JSON.stringify(comments).includes('Open Office'), 'Stamp and typed signature preserve their explicit author');
      run('main', 'page_insert_blank', { at: 2 });
      check(inspect('main').pageCount === 2, 'Page insertion updates the host snapshot');
      run('main', 'page_delete', { pages: [2] });
      check(inspect('main').pageCount === 1, 'Page deletion executes without a modal confirmation');
      run('main', 'edit_undo');
      check(inspect('main').pageCount === 2, 'Undo restores the deleted page through the same history');
      run('main', 'edit_redo');
      check(inspect('main').pageCount === 1, 'Redo reapplies the deletion');
      run('main', 'edit_undo');
      check(inspect('main').documentId === before.documentId && inspect('main').dirty, 'Editing preserves document identity and sets dirty state');
      const bytes = host.exportFile('main', 'pdf');
      check(JSON.parse(bindings.inspectBytes(bytes)).texts.join('').includes('Updated text'), 'Exported PDF contains the edited text');
      host.prepare('saved', 'Saved.pdf', bytes);
      check(inspect('saved').pageCount === 2 && JSON.stringify(query('saved', 'comment_list')).includes('Open Office'), 'Reopening exported bytes retains page structure, stamp and signature');

      const revision = inspect('main').revision;
      for (const [command, params] of [['page_add_text', { page: 1, text: 'Blocked', at: [40, 80] }], ['page_delete', { pages: [1] }], ['content_update', { page: 1, index: 1, text: 'Blocked' }]]) {
        check(!raw('main', 'mcp.query', { command, params }).ok, 'Read-only query rejects ' + command);
      }
      for (const payload of [
        { command: 'doc_open', params: { path: '/tmp/example.pdf' } },
        { command: 'js_run', params: { script: '1+1' } },
        { command: 'doc_save', params: {} },
        { command: 'page_add_image', params: { page: 1, path: '/tmp/example.png' } },
        { command: 'doc_info', params: { doc: 999 } },
        { command: 'page_add_image', params: { page: 1, path: 'image.png' }, assets: { '../image.png': image } },
        { command: 'page_add_image', params: { page: 1, path: 'image.png' }, assets: { 'image.png': 'not base64!' } },
      ]) check(!raw('main', 'mcp.execute', payload).ok, 'Reject unsafe or invalid input: ' + payload.command + ' ' + JSON.stringify(payload.params));
      check(inspect('main').revision === revision, 'Rejected operations leave document revision unchanged');
      host.prepare('source', 'Source.pdf', new Uint8Array());
      run('main', 'page_insert_file', { at: 3, path: 'source.pdf' }, { 'source.pdf': base64(host.exportFile('source', 'pdf')) });
      check(inspect('main').pageCount === 3, 'Inline PDF asset inserts pages without filesystem access');
      run('main', 'page_add_image', { page: 1, path: 'image.png', rect: [320, 40, 400, 120] }, { 'image.png': image });
      run('main', 'fill_sign_add', { page: 1, type: 'signature', at: [320, 260], path: 'image.png', author: 'Image signature' }, { 'image.png': image });
      run('main', 'stamp_custom', { page: 1, at: [320, 400], path: 'image.png', name: 'Custom', author: 'Custom stamp' }, { 'image.png': image });
      check(query('main', 'content_list').items.some(item => item.type === 'image'), 'Inline image is actual editable page content');
      const finalComments = JSON.stringify(query('main', 'comment_list'));
      check(finalComments.includes('Image signature') && finalComments.includes('Custom stamp'), 'Inline image signature and custom stamp are actual annotations');
      const final = inspect('main');
      const exported = host.exportFile('main', 'pdf');
      host.prepare('assets-saved', 'Assets.pdf', exported);
      check(inspect('assets-saved').pageCount === 3 && JSON.stringify(query('assets-saved', 'comment_list')).includes('Custom stamp'), 'Final export/reopen preserves inline assets and all three pages');
      host.destroy();
      return { checks, catalogCount: catalog.length, before, final, exported: base64(exported) };
    }, PNG.sync.write(png).toString('base64'));
    fs.writeFileSync(path.join(output, 'edited.pdf'), Buffer.from(result.exported, 'base64'));
    report.checks = result.checks;
    report.catalogCount = result.catalogCount;
    report.final = result.final;
    report.productsAfter = products();
    assert.deepEqual(report.productsAfter, report.productsBefore, 'WASM artifacts must remain unchanged throughout testing');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, checks: report.checks.length, catalogCount: report.catalogCount, finalPages: report.final.pageCount }));
  } catch (error) {
    report.error = error.stack || String(error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})();
