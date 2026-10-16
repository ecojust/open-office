/* Real Chromium IndexedDB persistence and rollback; no editor/WASM or native UI claim.
 * Run: node tests/browser/presentation-template-storage.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = process.env.OFFICE_TEMPLATE_STORAGE_OUTPUT
  ? path.resolve(process.env.OFFICE_TEMPLATE_STORAGE_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'open-office-template-storage-'));
fs.mkdirSync(output, { recursive: true });
const files = ['src/presentation/templates.ts', 'tests/browser/presentation-template-storage.cjs', 'public/presentation-templates/manifest.json'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/presentation-templates/manifest.json'), 'utf8'));
const fixture = fs.readFileSync(path.join(root, 'public/presentation-templates', manifest[0].file)).toString('base64');
const report = { ok: false, runtime: 'Real Chromium IndexedDB through the production template module', checks: [], errors: [], externalRequests: [], limitations: ['Does not exercise editor UI or native operating-system storage.', 'Quota and transaction failures are injected at the real IndexedDB request boundary.'] };
let server, browser, page;
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
async function check(name, action) {
  report.stage = name; persist();
  await action(); report.checks.push(name); persist();
}
async function importModule(target = page) { await target.evaluate(async () => { window.templates = await import('/src/presentation/templates.ts'); }); }
async function records() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('open-office-presentation-templates', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['metadata', 'documents'], 'readonly');
      const metadata = tx.objectStore('metadata').getAllKeys(), documents = tx.objectStore('documents').getAllKeys();
      tx.oncomplete = () => { db.close(); resolve({ metadata: metadata.result, documents: documents.result }); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({
      root, configFile: false, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [{ name: 'template-storage-test-page', configureServer(instance) {
        instance.middlewares.use((req, res, next) => {
          if (req.url !== '/__template-storage-test') return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><meta charset="utf-8"><title>Template storage regression</title>');
        });
      } }],
      server: { host: '127.0.0.1', port: crypto.randomInt(22000, 50000), strictPort: false, hmr: false,
        watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] },
        fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] },
      },
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ locale: 'zh-CN' });
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/__template-storage-test`); await importModule();
    let first, second;
    await check('ten-packaged-builtins-load-without-editor-or-network-dependencies', async () => {
      const templates = await page.evaluate(() => window.templates.listPresentationTemplates());
      assert.equal(templates.length, 10); assert.ok(templates.every(item => item.source === 'builtin' && item.slideCount === 3));
      for (const template of templates) {
        const loaded = await page.evaluate(value => window.templates.loadPresentationTemplate(value), template);
        const entry = manifest.find(item => item.id === template.id);
        assert.equal(loaded.base64, fs.readFileSync(path.join(root, 'public/presentation-templates', entry.file)).toString('base64'));
        assert.equal(new URL(template.preview).origin, origin);
      }
      assert.deepEqual(await records(), { metadata: [], documents: [] });
    });
    await check('save-commits-metadata-and-document-before-resolving', async () => {
      first = await page.evaluate(base64 => window.templates.savePresentationTemplate({ name: '  季度汇报  ', base64, slideCount: 3 }), fixture);
      assert.equal(first.name, '季度汇报'); assert.equal(first.source, 'custom');
      assert.match(first.id, /^custom-[\da-f-]+$/);
      assert.deepEqual(await records(), { metadata: [first.id], documents: [first.id] });
    });
    await check('reload-preserves-template-metadata-and-exact-pptx-bytes', async () => {
      await page.reload(); await importModule();
      const templates = await page.evaluate(() => window.templates.listPresentationTemplates());
      assert.deepEqual(templates.find(item => item.id === first.id), first);
      assert.equal((await page.evaluate(template => window.templates.loadPresentationTemplate(template), first)).base64, fixture);
    });
    await check('same-name-saves-create-independent-documents-and-are-shared-across-tabs', async () => {
      second = await page.evaluate(base64 => window.templates.savePresentationTemplate({ name: '季度汇报', base64, slideCount: 3 }), fixture);
      assert.notEqual(second.id, first.id); assert.equal(second.name, first.name);
      const other = await context.newPage();
      await other.goto(`${origin}/__template-storage-test`); await importModule(other);
      const saved = await other.evaluate(() => window.templates.listPresentationTemplates());
      assert.deepEqual(saved.filter(item => item.source === 'custom').map(item => item.id).sort(), [first.id, second.id].sort());
      assert.equal((await other.evaluate(template => window.templates.loadPresentationTemplate(template), first)).base64, fixture);
      await other.close();
    });
    await check('listing-never-reads-the-document-store', async () => {
      const result = await page.evaluate(async () => {
        const original = IDBTransaction.prototype.objectStore;
        IDBTransaction.prototype.objectStore = function(name) {
          if (name === 'documents') throw new Error('Listing must not access presentation bytes');
          return original.call(this, name);
        };
        try { return await window.templates.listPresentationTemplates(); }
        finally { IDBTransaction.prototype.objectStore = original; }
      });
      assert.equal(result.filter(item => item.source === 'custom').length, 2);
    });
    await check('quota-failure-after-metadata-write-rolls-back-with-no-orphan-records', async () => {
      const before = await records();
      const message = await page.evaluate(async base64 => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function(...args) {
          if (this.name === 'documents') throw new DOMException('Injected quota failure', 'QuotaExceededError');
          return original.apply(this, args);
        };
        try { await window.templates.savePresentationTemplate({ name: '配额失败', base64, slideCount: 3 }); return 'unexpected success'; }
        catch (error) { return error.message; }
        finally { IDBObjectStore.prototype.add = original; }
      }, fixture);
      assert.match(message, /保存模板失败.*本地存储空间不足/);
      assert.deepEqual(await records(), before);
    });
    await check('async-transaction-abort-after-successful-requests-rejects-and-rolls-back', async () => {
      const before = await records();
      const result = await page.evaluate(async base64 => {
        const original = IDBObjectStore.prototype.add;
        let succeeded = false;
        IDBObjectStore.prototype.add = function(...args) {
          const request = original.apply(this, args);
          if (this.name === 'documents') request.addEventListener('success', () => { succeeded = true; this.transaction.abort(); });
          return request;
        };
        try { await window.templates.savePresentationTemplate({ name: '事务中止', base64, slideCount: 3 }); return { message: 'unexpected success', succeeded }; }
        catch (error) { return { message: error.message, succeeded }; }
        finally { IDBObjectStore.prototype.add = original; }
      }, fixture);
      assert.equal(result.succeeded, true, 'The data request succeeded before the transaction aborted');
      assert.match(result.message, /保存模板失败/);
      assert.deepEqual(await records(), before);
    });
    await check('delete-is-atomic-and-preserves-the-other-same-name-template', async () => {
      const before = await records();
      const message = await page.evaluate(async id => {
        const original = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function(...args) {
          if (this.name === 'documents') throw new DOMException('Injected deletion failure', 'UnknownError');
          return original.apply(this, args);
        };
        try { await window.templates.deletePresentationTemplate(id); return 'unexpected success'; }
        catch (error) { return error.message; }
        finally { IDBObjectStore.prototype.delete = original; }
      }, first.id);
      assert.match(message, /删除模板失败/); assert.deepEqual(await records(), before);
      await page.evaluate(id => window.templates.deletePresentationTemplate(id), first.id);
      assert.deepEqual(await records(), { metadata: [second.id], documents: [second.id] });
      assert.equal((await page.evaluate(template => window.templates.loadPresentationTemplate(template), second)).base64, fixture);
      const missing = await page.evaluate(async template => {
        try { await window.templates.loadPresentationTemplate(template); return 'unexpected success'; }
        catch (error) { return error.message; }
      }, first);
      assert.match(missing, /已被删除/);
      await page.reload(); await importModule();
      const saved = await page.evaluate(() => window.templates.listPresentationTemplates());
      assert.deepEqual(saved.filter(item => item.source === 'custom').map(item => item.id), [second.id]);
    });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
    report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore);
    report.ok = true; report.finishedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ ok: true, checks: report.checks.length, report: path.join(output, 'report.json') }));
  } catch (error) {
    report.errors.push(error.stack || String(error)); persist(); console.error(error); process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
})();
