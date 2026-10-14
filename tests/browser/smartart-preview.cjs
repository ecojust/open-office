/* Cached SmartArt visual coverage is separate from SmartArt layout/editing support. */
const { chromium } = require('playwright');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'test-results/smartart-preview');
const fixtures = path.join(root, 'tests/compatibility/presentation-complex/fixtures/upstream/apache-poi');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const url = process.env.PRESENTATION_COMPLEX_URL || 'http://127.0.0.1:5198/';
const report = { scope: 'Embedded DrawingML cache preview, original package preservation and safe fallback; no layout regeneration or SmartArt node editing claim.', fixtures: [], adversarial: [], externalRequests: [], pageErrors: [] };
fs.mkdirSync(out, { recursive: true });
let browser;

async function exercise({ base64, name, full }) {
  console.info('SMARTART', name, 'import');
  const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
  const { PresentationController } = await import('/src/presentation/core/model.ts');
  const { slideSvg } = await import('/src/presentation/core/render.ts');
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const encode = value => { let result = ''; for (let offset = 0; offset < value.length; offset += 16384) result += String.fromCharCode(...value.subarray(offset, offset + 16384)); return btoa(result); };
  const source = decode(base64), captured = [], originalUrl = URL.createObjectURL;
  URL.createObjectURL = function(blob) { if (blob.type === 'image/svg+xml') captured.push(blob.text()); return originalUrl.call(URL, blob); };
  let model;
  try { model = await importPresentation(source); } finally { URL.createObjectURL = originalUrl; }
  const diagram = model.slides[0].objects.find(object => object.sourceXml?.includes('/diagram'));
  const summary = object => ({ locked: !!object.locked, warning: object.warning, preview: object.diagramPreview ? { drawingPart: object.diagramPreview.drawingPart,
    pixelWidth: object.diagramPreview.pixelWidth, pixelHeight: object.diagramPreview.pixelHeight, bytes: object.diagramPreview.dataUrl.length } : null });
  const result = { diagram: summary(diagram), artifacts: [], cacheSvg: await Promise.all(captured) };
  if (diagram.diagramPreview) {
    const image = new Image(); image.src = diagram.diagramPreview.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0, chromatic = 0; for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3] > 10) visible++; if (pixels[i + 3] > 10 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 30) chromatic++; }
    result.pixels = { visible, chromatic }; result.previewPng = diagram.diagramPreview.dataUrl.split(',')[1]; canvas.width = canvas.height = 0;
  }
  const editor = new PresentationController(model, 'smartart-' + name);
  for (const action of [{ type: 'update-object', id: diagram.id, text: 'MUST NOT MODIFY' }, { type: 'delete-objects', ids: [diagram.id] }]) {
    let rejected = false; try { editor.action(action); } catch { rejected = true; }
    if (!rejected) throw Error('Protected SmartArt unexpectedly allowed ' + action.type);
  }
  for (let cycle = 1; cycle <= (full ? 3 : 1); cycle++) {
    console.info('SMARTART', name, 'roundtrip', cycle);
    const bytes = await exportPresentation(model); model = await importPresentation(bytes);
    result.artifacts.push({ name: `noop-${cycle}.pptx`, base64: encode(bytes), reopenedPreview: !!model.slides[0].objects.find(o => o.diagramPreview), diagram: summary(model.slides[0].objects.find(o => o.sourceXml?.includes('/diagram'))) });
  }
  if (full) {
    editor.action({ type: 'insert-text', text: 'SmartArt preservation check', x: 2, y: model.height - 7, width: 50, height: 5 });
    const bytes = await exportPresentation(editor.model), reopened = await importPresentation(bytes);
    result.artifacts.push({ name: 'edited.pptx', base64: encode(bytes), reopenedPreview: !!reopened.slides[0].objects.find(o => o.diagramPreview) });
    const { exportPresentationPdf } = await import('/src/presentation/core/pdf.ts');
    console.info('SMARTART', name, 'pdf');
    result.pdf = encode(await exportPresentationPdf(model));
  }
  document.body.innerHTML = slideSvg(model, model.slides[0], { width: 1200, height: 800 });
  document.body.style.cssText = 'margin:0;background:white';
  result.renderedImages = document.querySelectorAll('svg image').length;
  return result;
}

function preserved(before, after) {
  const original = unzipSync(before), exported = unzipSync(after);
  const names = Object.keys(original).filter(name => name.startsWith('ppt/diagrams/') || name.startsWith('ppt/media/'));
  for (const name of names) assert.equal(digest(exported[name] || []), digest(original[name]), `Original diagram/image bytes changed: ${name}`);
  return names.length;
}

(async () => { try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('console', message => { if (message.text().startsWith('SMARTART')) console.log(message.text()); });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.route('**/*', route => { const requested = route.request().url(); if (/^https?:/.test(requested) && new URL(requested).origin !== new URL(url).origin) { report.externalRequests.push(requested); return route.abort(); } return route.continue(); });
  await page.goto(url);
  for (const name of ['smartart-simple.pptx', 'smartart-rotated-text.pptx', 'SmartArt.pptx']) {
    const source = fs.readFileSync(path.join(fixtures, name));
    const result = await page.evaluate(exercise, { base64: source.toString('base64'), name, full: true });
    assert.ok(result.diagram.preview, name + ' must render drawing cache');
    assert.equal(result.diagram.locked, true); assert.ok(result.renderedImages >= 1);
    assert.ok(result.pixels.visible > 1000 && result.pixels.chromatic > 1000, 'Preview must contain visible colored geometry');
    assert.ok(result.diagram.preview.pixelWidth <= 2048 && result.diagram.preview.pixelHeight <= 2048);
    const directory = path.join(out, name.replace('.pptx', '')); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'preview.png'), Buffer.from(result.previewPng, 'base64')); delete result.previewPng;
    fs.writeFileSync(path.join(directory, 'preview.pdf'), Buffer.from(result.pdf, 'base64')); delete result.pdf;
    const svg = result.cacheSvg.join('\n'); fs.writeFileSync(path.join(directory, 'cache.svg'), svg);
    assert.ok(!/<script|foreignObject|onload=|https?:\/\/[^\s"']+\.(?:png|jpg)/i.test(svg));
    if (name === 'smartart-simple.pptx') {
      assert.equal((svg.match(/<image /g) || []).length, 1); assert.ok(svg.includes('linearGradient'));
      assert.ok(svg.indexOf('offset="0"') < svg.indexOf('offset="1"'), 'Gradient stops must be sorted');
      assert.ok(svg.includes('fill-opacity="0.5"')); assert.ok(svg.includes('>abc</text>') && svg.includes('>def</text>') && svg.includes('>ghi</text>'));
    }
    if (name === 'smartart-rotated-text.pptx') {
      const rotations = [...svg.matchAll(/rotate\(([-.\d]+)/g)].map(match => Number(match[1]));
      for (const expected of [-41.3187166667, 49.1811833333, 29.5140833333]) assert.ok(rotations.some(angle => Math.abs(angle - expected) < .0001), 'Expected additive cached text rotation ' + expected);
      for (const text of ['abc', 'def', 'ghi']) assert.match(svg, new RegExp(`<text[^>]*fill="#FFFFFF"[^>]*>${text}</text>`), 'Cached fontRef must override slide defaults');
    }
    result.cacheSvg = { bytes: svg.length, file: path.relative(out, path.join(directory, 'cache.svg')) };
    for (const artifact of result.artifacts) {
      const bytes = Buffer.from(artifact.base64, 'base64'); delete artifact.base64;
      artifact.preservedParts = preserved(source, bytes); assert.equal(artifact.reopenedPreview, true);
      fs.writeFileSync(path.join(directory, artifact.name), bytes);
    }
    await page.screenshot({ path: path.join(directory, 'slide.png') });
    report.fixtures.push({ name, ...result }); console.log('PASS', name);
  }
  const original = fs.readFileSync(path.join(fixtures, 'smartart-simple.pptx'));
  const mutate = callback => { const parts = unzipSync(original); callback(parts); return Buffer.from(zipSync(parts)); };
  const adversarial = [
    ['missing-cache', parts => { delete parts['ppt/diagrams/drawing1.xml']; }],
    ['external-image', parts => { const key = 'ppt/diagrams/_rels/drawing1.xml.rels'; parts[key] = strToU8(strFromU8(parts[key]).replace('Target="../media/image1.jpeg"', 'Target="https://example.invalid/never-fetch.jpeg" TargetMode="External"')); }],
    ['external-cache', parts => { const key = 'ppt/slides/_rels/slide1.xml.rels'; parts[key] = strToU8(strFromU8(parts[key]).replace('Target="../diagrams/drawing1.xml"', 'Target="https://example.invalid/never-fetch.xml" TargetMode="External"')); }],
    ['injected-script', parts => { const key = 'ppt/diagrams/drawing1.xml'; parts[key] = strToU8(strFromU8(parts[key]).replace('</dsp:spTree>', '<script xmlns="http://www.w3.org/2000/svg">window.__malicious=true</script></dsp:spTree>')); }],
    ['unknown-shape', parts => { const key = 'ppt/diagrams/drawing1.xml'; parts[key] = strToU8(strFromU8(parts[key]).replace('prst="ellipse"', 'prst="unknownUnsupportedShape"')); }],
    ['oversize-image', parts => {
      const bytes = parts['ppt/media/image1.jpeg'];
      for (let offset = 2; offset + 8 < bytes.length; offset++) if (bytes[offset] === 255 && [0xc0, 0xc2].includes(bytes[offset + 1])) { bytes[offset + 5] = bytes[offset + 6] = bytes[offset + 7] = bytes[offset + 8] = 255; return; }
      throw Error('Fixture JPEG frame marker absent');
    }],
    ['identity-root-transform', parts => { const key = 'ppt/diagrams/drawing1.xml'; parts[key] = strToU8(strFromU8(parts[key]).replace('<dsp:grpSpPr/>', '<dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1439862" cy="939800"/><a:chOff x="0" y="0"/><a:chExt cx="1439862" cy="939800"/></a:xfrm></dsp:grpSpPr>')); }, true],
    ['escaped-script-text', parts => { const key = 'ppt/diagrams/drawing1.xml'; parts[key] = strToU8(strFromU8(parts[key]).replace('>abc</a:t>', '>&lt;script&gt;window.__malicious=true&lt;/script&gt;</a:t>')); }, true],
  ];
  for (const [name, mutation, preview = false] of adversarial) {
    const bytes = mutate(mutation), result = await page.evaluate(exercise, { base64: bytes.toString('base64'), name, full: false });
    assert.equal(!!result.diagram.preview, preview, name + ' preview/fallback expectation'); assert.equal(result.diagram.locked, true);
    if (!preview) assert.ok(result.diagram.warning.includes('占位')); assert.equal(await page.evaluate(() => !!window.__malicious), false);
    preserved(bytes, Buffer.from(result.artifacts[0].base64, 'base64'));
    report.adversarial.push({ name, warning: result.diagram.warning, safelyPreserved: true }); console.log('PASS', name);
  }
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []);
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); } })();
