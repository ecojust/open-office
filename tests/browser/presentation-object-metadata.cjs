/* Real import/controller/export/reopen with independent OOXML assertions.
 * No Office runtime is loaded. The generated fixture uses ordinary object
 * links, accessibility metadata, locks and a placeholder on two slides. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'test-results/presentation-object-metadata');
const port = Number(process.env.METADATA_TEST_PORT || 5298);
const origin = `http://127.0.0.1:${port}`;
fs.mkdirSync(out, { recursive: true });
(async () => {
 const { createServer } = await import('vite');
 const server = await createServer({ configFile: false, root, cacheDir: '/tmp/vite-object-metadata',
  optimizeDeps: { include: ['fflate'], noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{ name: 'blank-test-page', configureServer(s) { s.middlewares.use((req, res, next) => {
   if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Object metadata regression</title>'); } else next();
  }); } }] });
 let browser;
 try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage(), errors = [], externalRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin) externalRequests.push(r.url()); });
  await page.goto(origin);
  const result = await page.evaluate(async () => {
   const { createPresentation, PresentationController } = await import('/src/presentation/core/model.ts');
   const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
   const { unzipSync, zipSync } = await import('/node_modules/fflate/esm/browser.js');
   const { P, A, R, PR, readXml, writeXml, relPart, resolvePart, child, children } = await import('/src/presentation/core/pptx-common.ts');
   const check = (value, message) => { if (!value) throw Error(message); checks.push(message); }, checks = [], files = [];
   const bytes = doc => new TextEncoder().encode(writeXml(doc));
   const encode = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
   const store = (name, b) => files.push([name, encode(b)]);
   const c = new PresentationController(createPresentation(), 'object-metadata');
   c.action({ type: 'insert-chart', chartType: 'column', categories: ['Alpha', 'Beta'], series: ['Revenue'], values: [[2], [3]], title: 'Revenue' });
   c.action({ type: 'insert-table', rows: 1, columns: 2, cells: [['A', 'B']] });
   const png = document.createElement('canvas'); png.width = 2; png.height = 2;
   png.getContext('2d').fillRect(0, 0, 2, 2);
   c.insertImage({ name: 'Metadata image', base64: png.toDataURL().split(',')[1] });
   c.action({ type: 'add-page', layout: 20 });
   c.action({ type: 'insert-text', text: 'Destination slide' });
   const parts = unzipSync(await exportPresentation(c.model));
   const slides = Object.keys(parts).filter(p => /^ppt\/slides\/[^/]+\.xml$/.test(p));
   const part = slides[0], destination = slides[1], doc = readXml(parts[part]), rels = readXml(parts[relPart(part)]);
   const frames = [...doc.getElementsByTagNameNS(P, 'graphicFrame'), ...doc.getElementsByTagNameNS(P, 'pic')];
   const expected = [];
   for (const [i, frame] of frames.entries()) {
    const container = child(frame, frame.localName === 'pic' ? 'nvPicPr' : 'nvGraphicFramePr'), meta = child(container, 'cNvPr');
    meta.setAttribute('name', `metadata-${i}`); meta.setAttribute('descr', `Description 中文 ${i}`); meta.setAttribute('title', `Title ${i}`);
    const appendLink = (kind, rid, target, external) => {
     const link = doc.createElementNS(A, `a:${kind}`); link.setAttributeNS(R, 'r:id', rid); link.setAttribute('tooltip', `Tooltip ${i} ${kind}`);
     if (!external) link.setAttribute('action', 'ppaction://hlinksldjump'); meta.appendChild(link);
     const rel = rels.createElementNS(PR, 'Relationship'); rel.setAttribute('Id', rid); rel.setAttribute('Type', R + (external ? '/hyperlink' : '/slide')); rel.setAttribute('Target', target);
     if (external) rel.setAttribute('TargetMode', 'External'); rels.documentElement.appendChild(rel);
    };
    appendLink('hlinkClick', `rIdKeep${i}`, `https://example.invalid/metadata/${i}`, true);
    appendLink('hlinkMouseOver', `rIdHover${i}`, destination.split('/').at(-1), false);
    const ext = doc.createElementNS(A, 'a:extLst'), entry = doc.createElementNS(A, 'a:ext'); entry.setAttribute('uri', 'urn:object-metadata-regression');
    const marker = doc.createElementNS('urn:object-metadata', 'm:keep'); marker.setAttribute('value', `opaque-${i}`); entry.appendChild(marker); ext.appendChild(entry); meta.appendChild(ext);
    const locks = doc.createElementNS(A, frame.localName === 'pic' ? 'a:picLocks' : 'a:graphicFrameLocks'); locks.setAttribute('noMove', '1');
    child(container, frame.localName === 'pic' ? 'cNvPicPr' : 'cNvGraphicFramePr').appendChild(locks);
    const ph = doc.createElementNS(P, 'p:ph'); ph.setAttribute('type', 'obj'); ph.setAttribute('idx', String(70 + i)); child(container, 'nvPr').appendChild(ph);
    expected.push({ name: meta.getAttribute('name'), descr: meta.getAttribute('descr'), title: meta.getAttribute('title'), index: i });
   }
   parts[part] = bytes(doc); parts[relPart(part)] = bytes(rels);
   // Force relationship ID collisions on the destination. Copied links must
   // point to the source object's targets, not these unrelated entries.
   const destRels = readXml(parts[relPart(destination)]);
   for (let i = 0; i < frames.length; i++) for (const prefix of ['rIdKeep', 'rIdHover']) {
    const rel = destRels.createElementNS(PR, 'Relationship'); rel.setAttribute('Id', prefix + i); rel.setAttribute('Type', R + '/hyperlink');
    rel.setAttribute('Target', `https://example.invalid/wrong/${prefix}${i}`); rel.setAttribute('TargetMode', 'External'); destRels.documentElement.appendChild(rel);
   }
   parts[relPart(destination)] = bytes(destRels);
   const source = zipSync(parts), sourceCopy = source.slice(); store('source.pptx', source);
   function inspect(b, label, minimum) {
    const allParts = unzipSync(b); let inspected = 0;
    // Only active slide parts count; retained unused source parts are not proof.
    const presentation = readXml(allParts['ppt/presentation.xml']), pRels = readXml(allParts['ppt/_rels/presentation.xml.rels']);
    for (const slide of children(child(presentation.documentElement, 'sldIdLst'))) {
     const rid = slide.getAttributeNS(R, 'id'), rel = children(pRels.documentElement).find(n => n.getAttribute('Id') === rid);
     const name = resolvePart('ppt/presentation.xml', rel.getAttribute('Target')), d = readXml(allParts[name]), rr = readXml(allParts[relPart(name)]);
     const ids = [...d.getElementsByTagNameNS(P, 'cNvPr')].map(n => n.getAttribute('id')); check(new Set(ids).size === ids.length, `${label}: ${name} has unique shape IDs`);
     for (const frame of [...d.getElementsByTagNameNS(P, 'graphicFrame'), ...d.getElementsByTagNameNS(P, 'pic')]) {
      const nv = child(frame, frame.localName === 'pic' ? 'nvPicPr' : 'nvGraphicFramePr'), meta = child(nv, 'cNvPr');
      const e = expected.find(item => item.name === meta.getAttribute('name')); if (!e) continue;
      check(meta.getAttribute('descr') === e.descr && meta.getAttribute('title') === e.title, `${label}: ${name}/${e.name} keeps accessibility text`);
      check(nv.getElementsByTagNameNS(A, frame.localName === 'pic' ? 'picLocks' : 'graphicFrameLocks')[0]?.getAttribute('noMove') === '1', `${label}: ${name}/${e.name} keeps locks`);
      check(nv.getElementsByTagNameNS(P, 'ph')[0]?.getAttribute('idx') === String(70 + e.index), `${label}: ${name}/${e.name} keeps placeholder`);
      check(meta.getElementsByTagNameNS('urn:object-metadata', 'keep')[0]?.getAttribute('value') === `opaque-${e.index}`, `${label}: ${name}/${e.name} keeps opaque extension`);
      for (const kind of ['hlinkClick', 'hlinkMouseOver']) {
       const link = child(meta, kind), target = link && children(rr.documentElement).find(n => n.getAttribute('Id') === link.getAttributeNS(R, 'id'));
       check(link?.getAttribute('tooltip') === `Tooltip ${e.index} ${kind}` && !!target, `${label}: ${name}/${e.name} keeps ${kind} and resolves relationship`);
       check(kind === 'hlinkClick' ? target.getAttribute('TargetMode') === 'External' && target.getAttribute('Target') === `https://example.invalid/metadata/${e.index}` : target.getAttribute('TargetMode') !== 'External' && resolvePart(name, target.getAttribute('Target')) === destination && link.getAttribute('action') === 'ppaction://hlinksldjump', `${label}: ${name}/${e.name} retains correct ${kind} target`);
      }
      inspected++;
     }
    }
    check(inspected === minimum, `${label}: exactly ${minimum} active metadata-bearing objects checked`);
   }
   const imported = await importPresentation(source); inspect(await exportPresentation(imported), 'noop', 3);
   let editor = new PresentationController(imported, 'metadata-edit');
   for (let cycle = 1; cycle <= 3; cycle++) {
    const chart = editor.model.slides[0].objects.find(o => o.type === 'chart'), table = editor.model.slides[0].objects.find(o => o.type === 'table');
    editor.action({ type: 'update-chart', id: chart.id, chartType: 'column', categories: ['Alpha', 'Beta'], series: ['Revenue'], values: [[99 + cycle], [3]], title: 'Changed data' });
    const cells = [['A', 'B'], ...Array.from({ length: cycle }, (_, r) => [`row-${r}`, String(cycle)])];
    editor.action({ type: 'update-table', id: table.id, cells });
    const output = await exportPresentation(editor.model); inspect(output, `cycle-${cycle}`, 3); store(`cycle-${cycle}.pptx`, output);
    const reopened = await importPresentation(output);
    check(reopened.slides[0].objects.find(o => o.type === 'chart').chart.values[0][0] === 99 + cycle, `cycle-${cycle}: new chart data survives`);
    check(JSON.stringify(reopened.slides[0].objects.find(o => o.type === 'table').table.cells) === JSON.stringify(cells), `cycle-${cycle}: new table dimensions/content survive`);
    editor = new PresentationController(reopened, `cycle-${cycle}`);
   }
   const copy = editor.copyObjects(editor.model.slides[0].objects.filter(o => ['chart', 'table'].includes(o.type)).map(o => o.id));
   editor.action({ type: 'select-page', pageIndex: 1 }); editor.pasteObjects(copy);
   const copiedChart = editor.model.slides[1].objects.find(o => o.type === 'chart'), copiedTable = editor.model.slides[1].objects.find(o => o.type === 'table');
   editor.action({ type: 'update-chart', id: copiedChart.id, chartType: 'line', categories: ['X', 'Y'], series: ['Copy'], values: [[7], [8]], title: 'Cross-slide' });
   editor.action({ type: 'update-table', id: copiedTable.id, cells: [['copy', 'only', 'extra-column']] });
   const copied = await exportPresentation(editor.model); inspect(copied, 'cross-slide-collision', 5); store('cross-slide.pptx', copied);
   inspect(await exportPresentation(await importPresentation(copied)), 'cross-slide-reopen', 5);
   // Image replacement is a codec-level model check; there is no image replace
   // button in this pass. The new pixels must not erase the picture's metadata.
   const imageModel = await importPresentation(source), image = imageModel.slides[0].objects.find(o => o.type === 'image');
   png.getContext('2d').fillStyle = '#e32020'; png.getContext('2d').fillRect(0, 0, 2, 2);
   image.image = { ...image.image, dataUrl: png.toDataURL() };
   const imageOutput = await exportPresentation(imageModel); inspect(imageOutput, 'image-payload', 3); store('image-payload.pptx', imageOutput);
   const reopenedImage = (await importPresentation(imageOutput)).slides[0].objects.find(o => o.type === 'image');
   check(reopenedImage.image.dataUrl === image.image.dataUrl, 'Image payload replacement keeps new pixels');
   check(source.every((b, i) => b === sourceCopy[i]), 'Original input bytes remain unchanged');
   return { checks, files };
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const artifacts = result.files.map(([name, base64]) => { const b = Buffer.from(base64, 'base64'); fs.writeFileSync(path.join(out, name), b); return { name, sha256: crypto.createHash('sha256').update(b).digest('hex') }; });
  const report = { ok: true, checks: result.checks, errors, externalRequests, artifacts, scope: 'Real browser core/controller and saved OOXML; not a UI click or native-rendering test.' };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS ${result.checks.length} object metadata assertions`);
 } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
