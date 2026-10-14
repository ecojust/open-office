/* Real Chromium import instrumentation. Independent Python ZIP/zlib fixtures
 * verify stored/deflated/descriptor CRC and XML source bytes. No runtime mock. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { zipSync, strToU8 } = require('fflate');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.WORD_IMPORT_PERFORMANCE_OUTPUT || path.join(root, 'test-results/independent-word-import-performance'));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const productFiles = ['src/word/core/docx.ts', 'src/word/core/runtime.ts', 'src/word/core/prepared.ts', 'src/word/core/model.ts', 'src/App.vue', 'src/components/StandaloneWordEditor.vue'];
const productHashes = () => Object.fromEntries(productFiles.map(name => [name, sha(fs.readFileSync(path.join(root, name)))]));
const xml = (name, body) => `<?xml version="1.0" encoding="UTF-8"?><!-- ${name} -->${body}`;
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
const relationships = (name, rows) => xml(name, `<Relationships xmlns="${PR}">${rows.join('')}</Relationships>`);
function fixture(text) {
  const parts = {
    'word/document.xml': xml('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="13579B"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
    'word/styles.xml': xml('word/styles.xml', `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`),
    'word/settings.xml': xml('word/settings.xml', `<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/></w:settings>`),
    'word/numbering.xml': xml('word/numbering.xml', `<w:numbering xmlns:w="${W}"/>`),
    'word/fontTable.xml': xml('word/fontTable.xml', `<w:fonts xmlns:w="${W}"><w:font w:name="Arial"><w:family w:val="swiss"/></w:font></w:fonts>`),
    'word/theme/theme1.xml': xml('word/theme/theme1.xml', `<a:theme xmlns:a="${A}" name="Controlled"/>`),
    'docProps/core.xml': xml('docProps/core.xml', `<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Parser counter control</dc:title></cp:coreProperties>`),
    'docProps/app.xml': xml('docProps/app.xml', `<Properties xmlns="${EP}"><Application>Independent fixture</Application></Properties>`),
    'docProps/custom.xml': xml('docProps/custom.xml', `<Properties xmlns="${CUSTOM}"/>`),
  };
  const kinds = [
    ['word/document.xml', `${R}/officeDocument`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', true],
    ['word/styles.xml', `${R}/styles`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['word/settings.xml', `${R}/settings`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['word/numbering.xml', `${R}/numbering`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
    ['word/fontTable.xml', `${R}/fontTable`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
    ['word/theme/theme1.xml', `${R}/theme`, 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['docProps/core.xml', `${PR}/metadata/core-properties`, 'application/vnd.openxmlformats-package.core-properties+xml', true],
    ['docProps/app.xml', `${R}/extended-properties`, 'application/vnd.openxmlformats-officedocument.extended-properties+xml', true],
    ['docProps/custom.xml', `${R}/custom-properties`, 'application/vnd.openxmlformats-officedocument.custom-properties+xml', true],
  ];
  parts['[Content_Types].xml'] = xml('[Content_Types].xml', `<Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${kinds.map(([name, , mime]) => `<Override PartName="/${name}" ContentType="${mime}"/>`).join('')}</Types>`);
  parts['_rels/.rels'] = relationships('_rels/.rels', kinds.filter(k => k[3]).map(([name, type], i) => relationship(`r${i}`, type, name)));
  parts['word/_rels/document.xml.rels'] = relationships('word/_rels/document.xml.rels', kinds.filter(k => !k[3]).map(([name, type], i) => relationship(`r${i}`, type, name.slice(5))));
  return Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)]));
}
const smallText = 'AAAA 中文😀';
const largeText = Array.from({ length: 2048 }, (_, i) => crypto.createHash('sha256').update(`controlled-stream-${i}`).digest('hex')).join('');
const small = fixture(smallText), large = fixture(largeText);
const encodedParts = parts => Object.entries(parts).map(([name, bytes]) => [name, Array.from(bytes)]);
const report = { scope: 'Per-import XML cache, streamed CRC, and one-use real UI import handoff', productBefore: productHashes(), checks: [], parserCounts: [], xmlRejections: [], zipCases: [], app: {}, pageErrors: [], consoleErrors: [], externalRequests: [], runtimeRequests: [], limitations: ['Browser Chromium import paths only; native Rust package gates run separately.', 'Parser counts are deterministic work measures, not wall-clock performance claims.', 'App calls use actual runtime modules; import parser stacks are separated from export snapshot validation.'] };
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const pass = message => { report.checks.push(message); persist(); console.log('PASS', message); };
const pythonGenerator = String.raw`
import base64, io, json, struct, sys, zlib, zipfile
from pathlib import Path
from xml.etree import ElementTree as E
request=json.load(sys.stdin); out=Path(request['output']); rows=[]
class Unseekable(io.BytesIO):
 def seekable(self): return False
 def seek(self,*a): raise OSError('streaming descriptor fixture')
for size, entries in request['parts'].items():
 parts={name:base64.b64decode(data) for name,data in entries.items()}
 for data in parts.values(): E.fromstring(data)
 for method in [0,8]:
  for descriptor in [False,True]:
   buffer=Unseekable() if descriptor else io.BytesIO()
   with zipfile.ZipFile(buffer,'w',compression=method,compresslevel=6 if method else None) as archive:
    for name,data in parts.items(): archive.writestr(name,data)
   data=buffer.getvalue(); name=f'{size}-{"deflate" if method else "stored"}-{"descriptor" if descriptor else "header"}'
   with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.testzip() is None
    for member in archive.infolist(): assert archive.read(member)==parts[member.filename]
    member=archive.getinfo('word/document.xml'); compressed=member.compress_size
    assert bool(member.flag_bits&8)==descriptor
   assert size!='large' or compressed>4096
   (out/(name+'.docx')).write_bytes(data)
   bad=bytearray(data); end=len(bad)-22; directory=struct.unpack_from('<I',bad,end+16)[0]; cursor=directory
   for _ in parts:
    n,x,c=struct.unpack_from('<HHH',bad,cursor+28); filename=bad[cursor+46:cursor+46+n].decode()
    if filename=='word/document.xml':
     checksum=struct.unpack_from('<I',bad,cursor+16)[0]; assert checksum==zlib.crc32(parts[filename]); forged=checksum^1
     struct.pack_into('<I',bad,cursor+16,forged); local=struct.unpack_from('<I',bad,cursor+42)[0]
     if descriptor:
      localname,localextra=struct.unpack_from('<HH',bad,local+26); after=local+30+localname+localextra+compressed
      assert struct.unpack_from('<I',bad,after)[0]==0x08074b50;struct.pack_into('<I',bad,after+4,forged)
     else: struct.pack_into('<I',bad,local+14,forged)
     break
    cursor+=46+n+x+c
   with zipfile.ZipFile(io.BytesIO(bad)) as archive: assert archive.testzip()=='word/document.xml'
   (out/(name+'-bad-crc.docx')).write_bytes(bad)
   rows.append(dict(name=name,method=method,descriptor=descriptor,mainCompressedBytes=compressed,compressedInputChunks=(compressed+1023)//1024,expandedMainBytes=len(parts['word/document.xml']),oracle='Python zipfile byte comparison and zlib.crc32; bad file fails testzip at word/document.xml'))
print(json.dumps(rows))
`;
fs.writeFileSync(path.join(output, 'generate-zip-controls.py'), pythonGenerator);
const controls = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', pythonGenerator], { encoding: 'utf8', input: JSON.stringify({ output, parts: Object.fromEntries([['small', small], ['large', large]].map(([label, parts]) => [label, Object.fromEntries(Object.entries(parts).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]))])) }) }));
let server, browser, phase = 'startup';
function installCounter() {
  window.__wordParses = [];
  const parse = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function(source, type) {
    if (type === 'application/xml') window.__wordParses.push({ source: String(source), stack: new Error().stack });
    return parse.call(this, source, type);
  };
}
function assertOnce(records, parts, label) {
  assert.equal(records.length, Object.keys(parts).length, `${label}: parser count`);
  for (const [name, bytes] of Object.entries(parts)) assert.equal(records.filter(r => r.source === new TextDecoder().decode(bytes)).length, 1, `${label}: ${name}`);
  report.parserCounts.push({ label, total: records.length, byPart: Object.fromEntries(Object.entries(parts).map(([name, bytes]) => [name, records.filter(r => r.source === new TextDecoder().decode(bytes)).length])) });
}
function assertModel(model, text) {
  assert.equal(model.paragraphs.length, 1); assert.equal(model.paragraphs[0].runs.map(r => r.text).join(''), text);
  assert.equal(model.paragraphs[0].runs[0].style.bold, true); assert.equal(model.paragraphs[0].runs[0].style.fontSize, 13); assert.equal(model.paragraphs[0].runs[0].style.color, '#13579B');
}
(async () => { try {
  const { createServer } = await import('vite');
  server = await createServer({ root, cacheDir: 'node_modules/.vite-word-import-performance', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**'] } } });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true }); page.setDefaultTimeout(30000); await page.addInitScript(installCounter); await page.routeWebSocket('**', () => {});
    page.on('pageerror', e => report.pageErrors.push({ phase, message: e.message })); page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ phase, message: m.text() }); });
    page.on('request', request => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== origin) report.externalRequests.push(url.href); if (/office-runtime|office\/host|soffice|zetajs|\.wasm(?:$|\?)/.test(url.href)) report.runtimeRequests.push(url.href); });
    await page.goto(origin); await page.getByTestId('independent-word-open').waitFor(); return page;
  }
  const page = await newPage();
  phase = 'one-parse-per-part';
  for (const kind of ['zip', 'parts']) {
    const result = await page.evaluate(async ({ kind, bytes, entries }) => {
      const codec = await import('/src/word/core/docx.ts'); window.__wordParses = [];
      const model = kind === 'zip' ? codec.importWordDocument(Uint8Array.from(bytes)) : codec.importWordParts(new Map(entries.map(([name, data]) => [name, Uint8Array.from(data)])));
      return { model, records: window.__wordParses };
    }, { kind, bytes: Array.from(fs.readFileSync(path.join(output, 'small-deflate-header.docx'))), entries: encodedParts(small) });
    assertModel(result.model, smallText); assertOnce(result.records, small, kind);
  }
  pass('ZIP and external-parts import each parse every XML/rels exactly once, including all supported metadata and custom-properties branches');

  phase = 'import-local-cache';
  const cache = await page.evaluate(async entries => {
    const { importWordParts } = await import('/src/word/core/docx.ts'); const parts = new Map(entries.map(([name, bytes]) => [name, Uint8Array.from(bytes)])); const decoder = new TextDecoder(), encoder = new TextEncoder();
    const read = () => { window.__wordParses = []; const model = importWordParts(parts); return { text: model.paragraphs[0].runs.map(r => r.text).join(''), records: window.__wordParses.length }; };
    const results = [read()]; parts.set('word/document.xml', encoder.encode(decoder.decode(parts.get('word/document.xml')).replace('AAAA', 'BBBB'))); results.push(read());
    const same = parts.get('word/document.xml'); same.set(encoder.encode(decoder.decode(same).replace('BBBB', 'CCCC'))); results.push(read());
    const bad = decoder.decode(same).replace('</w:body>', '</w:bady>'); same.set(encoder.encode(bad)); let rejection; try { read(); } catch (e) { rejection = e.message; }
    same.set(encoder.encode(bad.replace('</w:bady>', '</w:body>').replace('CCCC', 'DDDD'))); results.push(read());
    return { results, rejection, sameArray: same === parts.get('word/document.xml') };
  }, encodedParts(small));
  assert.deepEqual(cache.results.map(r => r.text), ['AAAA 中文😀', 'BBBB 中文😀', 'CCCC 中文😀', 'DDDD 中文😀']); assert.ok(cache.sameArray); assert.match(cache.rejection, /XML 无法解析/); assert.ok(cache.results.every(r => r.records === Object.keys(small).length)); report.cacheIsolation = cache;
  pass('Separate calls never reuse stale DOM after Map byte replacement, in-place Uint8Array mutation, malformed input or repair of that same array');

  phase = 'unused-part-validation';
  const malformed = [
    ['malformed', strToU8('<root><broken></root>'), /XML 无法解析/],
    ['dtd', strToU8('<!DOCTYPE root [<!ENTITY x "hidden">]><root>&x;</root>'), /DTD/],
    ['utf8', Uint8Array.from([0x3c, 0x72, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x72, 0x3e]), /XML 编码无效/],
    ['utf16le', Uint8Array.from([0xff, 0xfe, 0x3c]), /XML 编码无效/],
    ['utf16be', Uint8Array.from([0xfe, 0xff, 0x00]), /XML 编码无效/],
  ];
  for (const suffix of ['xml', 'rels']) for (const [fault, bytes, expected] of malformed) {
    const name = `word/orphan-${fault}.${suffix}`, parts = { ...small, [name]: bytes }, packed = zipSync(parts), label = `${suffix}-${fault}`;
    fs.writeFileSync(path.join(output, `orphan-${label}.docx`), packed);
    for (const kind of ['zip', 'parts']) {
      const error = await page.evaluate(async ({ kind, bytes, entries }) => { const c = await import('/src/word/core/docx.ts'); try { kind === 'zip' ? c.importWordDocument(Uint8Array.from(bytes)) : c.importWordParts(new Map(entries.map(([name, data]) => [name, Uint8Array.from(data)]))); return null; } catch (e) { return e.message; } }, { kind, bytes: Array.from(packed), entries: encodedParts(parts) });
      assert.match(error || '', expected, `${kind}/${label}: must inspect malformed unused XML before unsupported-part rejection`); report.xmlRejections.push({ kind, label, error });
    }
  }
  pass('20 ZIP/parts negative paths still eagerly reject malformed XML, DTD and invalid UTF-8/UTF-16 in orphan XML and relationship parts');

  phase = 'streamed-crc';
  for (const control of controls) {
    const bytes = fs.readFileSync(path.join(output, `${control.name}.docx`)), bad = fs.readFileSync(path.join(output, `${control.name}-bad-crc.docx`));
    const result = await page.evaluate(async ({ bytes, bad }) => { const c = await import('/src/word/core/docx.ts'); window.__wordParses = []; const model = c.importWordDocument(Uint8Array.from(bytes)); const records = window.__wordParses; let error; window.__wordParses = []; try { c.importWordDocument(Uint8Array.from(bad)); } catch (e) { error = e.message; } return { model, records, error, badRecords: window.__wordParses.length }; }, { bytes: Array.from(bytes), bad: Array.from(bad) });
    const isLarge = control.name.startsWith('large'); assertModel(result.model, isLarge ? largeText : smallText); assertOnce(result.records, isLarge ? large : small, control.name); assert.match(result.error || '', /内容校验失败.*word\/document\.xml/); assert.equal(result.badRecords, 0, 'Corrupted first entry must reject before XML parsing');
    report.zipCases.push({ ...control, sha256: sha(bytes), badSha256: sha(bad), error: result.error });
  }
  pass('Eight independently generated stored/deflated/header/descriptor archives pass CRC and byte semantics; eight forged CRC controls reject, including large deflate across many 1024-byte input chunks');

  phase = 'app-one-use-handoff';
  const app = await newPage(); const fixturePath = path.join(output, 'small-deflate-header.docx');
  const imported = async () => app.evaluate(() => window.__wordParses.filter(r => /\bimportWord(?:Parts|Document)\b/.test(r.stack)));
  const reset = async () => app.evaluate(() => { window.__wordParses = []; });
  const ready = async () => app.waitForFunction(() => { if (document.querySelector('.error-banner')) throw Error(document.querySelector('.error-banner').textContent); return document.querySelector('[data-testid="standalone-word-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay'); });
  await reset(); let chooser = app.waitForEvent('filechooser'); await app.getByTestId('independent-word-open').click(); await (await chooser).setFiles(fixturePath); await ready();
  assertOnce(await imported(), small, 'app-first-open'); assert.equal(await app.getByTestId('word-content').innerText(), smallText); report.app.firstOpen = (await imported()).length;
  await app.getByTestId('word-content').click(); await app.keyboard.press('Control+End'); await app.keyboard.insertText(' KEEP'); await ready();
  await reset(); chooser = app.waitForEvent('filechooser'); await app.locator('.command-bar').getByRole('button', { name: '打开', exact: true }).click(); await (await chooser).setFiles(fixturePath); await ready();
  await app.waitForFunction(expected => document.querySelectorAll('.document-tab').length === 2 && document.querySelector('[data-testid="word-content"]')?.textContent === expected, smallText);
  assertOnce(await imported(), small, 'app-second-open'); report.app.secondOpen = (await imported()).length; assert.equal(await app.locator('.document-tab').count(), 2); assert.equal(await app.getByTestId('word-content').innerText(), smallText);
  await reset(); await app.locator('.document-tab').first().click(); await ready(); await app.waitForFunction(expected => document.querySelector('[data-testid="word-content"]')?.textContent === expected, smallText + ' KEEP'); assert.equal(await app.getByTestId('word-content').innerText(), smallText + ' KEEP');
  const restored = await imported(); assert.ok(restored.length > 0, 'Returning from a different Word controller imports the latest saved snapshot'); const counts = new Map(); for (const r of restored) counts.set(r.source, (counts.get(r.source) || 0) + 1); assert.ok([...counts.values()].every(n => n === 1), 'Snapshot import parses each XML once');
  report.app.snapshotRestore = { xmlParses: restored.length, sourceHashes: restored.map(r => sha(r.source)), text: await app.getByTestId('word-content').innerText() }; report.app.snapshotImportStack = (await app.evaluate(() => window.__wordParses)).find(r => /\bimportWord(?:Parts|Document)\b/.test(r.stack))?.stack;
  await app.screenshot({ path: path.join(output, 'restored-edited-tab.png'), fullPage: true }); await app.close();
  pass('Real app first and second filechooser opens each import once; switching Word controllers reloads the edited snapshot once and never restores the initial stale model');

  phase = 'stable-sources'; report.productAfter = productHashes(); assert.deepEqual(report.productAfter, report.productBefore); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.runtimeRequests, []); report.ok = true;
} catch (error) { report.ok = false; report.failure = { phase, message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally { persist(); if (browser) await browser.close(); if (server) await server.close(); } })();
