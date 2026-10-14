/* Production DOCX import comparison. Baseline is an immutable source snapshot.
 * No Tauri/IPC timings, DOM rendering, or full-app latency are measured here.
 * WORD_IMPORT_BASELINE=/path/to/snapshot node scripts/benchmark-word-import.cjs
 * WORD_IMPORT_BENCH_SMOKE=1 runs short correctness/smoke measurements only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { unzipSync } = require('fflate');

const root = path.resolve(__dirname, '..');
const baseline = path.resolve(process.env.WORD_IMPORT_BASELINE || '/tmp/word-import-performance-baseline');
const smoke = process.env.WORD_IMPORT_BENCH_SMOKE === '1';
const output = path.resolve(process.env.WORD_IMPORT_BENCH_OUTPUT || path.join(root, 'test-results/word-import-performance'));
const warmups = smoke ? 1 : 5, samples = smoke ? 3 : 25;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));
const summarize = raw => {
  const sorted = [...raw].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], minMs: sorted[0], samplesMs: raw };
};
const report = {
  ok: false, smoke, startedAt: new Date().toISOString(), warmups, samples,
  scope: 'Same Chromium, same input bytes: frozen versus current production DOCX importWordDocument and importWordParts. DOMParser counts collected separately from timing.',
  limitations: [
    'importWordDocument includes browser ZIP inspection/inflate/CRC, XML validation and OOXML/model creation. importWordParts starts after native unpacking and base64 decoding.',
    'Does not measure Tauri IPC, Rust ZIP time, base64/JSON crossing, file IO, Vue mount, editor rendering or full-app opening latency.',
    'App/editor import handoff call-count evidence belongs to integration QA; it is not included in these codec timings.',
    'Single-machine diagnostic includes allocator/GC effects. P95 is nearest rank over batch means, not individual-call tail latency.',
    'Baseline docx.ts and model.ts are frozen; unchanged supporting modules are shared and their hashes are recorded.',
  ],
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(),
    memoryBytes: os.totalmem(), loadAverageStart: os.loadavg() },
  baselineDirectory: baseline, sourceDigests: {}, baselineManifest: {}, cases: [], checks: [], pageErrors: [], externalRequests: [],
};
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.(?:ts|vue)$/.test(name) ? [path.relative(root, name)] : [];
  });
}
const sourceNames = [...sourceFiles(path.join(root, 'src')), 'scripts/benchmark-word-import.cjs', 'package-lock.json', 'tests/compatibility/independent-word/manifest.json'].sort();
const sourceHashes = () => Object.fromEntries(sourceNames.map(name => [name, digest(path.join(root, name))]));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const baselineManifestFile = path.join(baseline, 'manifest.json');
  report.baselineManifest = JSON.parse(fs.readFileSync(baselineManifestFile, 'utf8'));
  for (const [name, expected] of Object.entries(report.baselineManifest)) {
    assert.equal(digest(path.join(baseline, name)), expected, `Frozen baseline changed: ${name}`);
    const archived = path.join(output, 'baseline-source', name);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    if (path.resolve(baseline, name) !== archived) fs.copyFileSync(path.join(baseline, name), archived);
  }
  fs.writeFileSync(path.join(output, 'baseline-source/manifest.json'), JSON.stringify(report.baselineManifest, null, 2) + '\n');
  report.archivedBaseline = 'baseline-source/manifest.json';
  const baselineSources = Object.fromEntries(['docx', 'model'].map(name => [name, fs.readFileSync(path.join(baseline, 'src/word/core', name + '.ts'), 'utf8')]));
  const frozenDocx = baselineSources.docx.replaceAll("'./model.ts'", "'./model.ts?word-import-bench=baseline'");
  assert.notEqual(frozenDocx, baselineSources.docx, 'Baseline module reference must be redirected to frozen model');
  report.baselineServedDigests = { docx: sha(frozenDocx), model: sha(baselineSources.model) };
  report.sourceDigests = sourceHashes();
  let browser, server;
  try {
    const { createServer } = await import('vite');
    server = await createServer({ configFile: false, root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { include: ['fflate'], noDiscovery: true, entries: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/target/**', '**/test-results/**'] } },
      plugins: [{ name: 'word-import-comparison', enforce: 'pre', transform(_code, id) {
        const name = /\/src\/word\/core\/(docx|model)\.ts\?word-import-bench=baseline$/.exec(id)?.[1];
        return name ? (name === 'docx' ? frozenDocx : baselineSources.model) : null;
      }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>Word import comparison</title>');
      }); } }],
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    await page.goto(origin);
    await page.evaluate(async () => {
      window.wordImportBench = {
        baseline: await import('/src/word/core/docx.ts?word-import-bench=baseline'),
        current: await import('/src/word/core/docx.ts'),
        model: await import('/src/word/core/model.ts?word-import-bench=baseline'),
        zip: await import('/node_modules/fflate/esm/browser.js'),
        bytes: await import('/src/shared/document.ts'),
      };
    });
    report.environment.chromium = await browser.version();
    report.environment.userAgent = await page.evaluate(() => navigator.userAgent);
    const corpus = JSON.parse(fs.readFileSync(path.join(root, 'tests/compatibility/independent-word/manifest.json'), 'utf8'));
    const fixture = corpus.fixtures.find(item => item.name === 'plain-text');
    const nativeBytes = fs.readFileSync(path.join(root, 'tests/compatibility/independent-word', fixture.docx));
    assert.equal(sha(nativeBytes), fixture.docxSha256);
    const cases = [{ name: 'libreoffice-plain-text', input: nativeBytes, provenance: corpus.provenance + ' ' + corpus.libreoffice.version }];
    for (const count of (smoke ? [100] : [100, 1000, 4000])) {
      const generated = await page.evaluate(count => {
        const { baseline: codec, model, zip, bytes } = window.wordImportBench;
        const document = model.createWordDocument();
        document.paragraphs = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, style: { align: i % 7 === 0 ? 'center' : 'left', spaceAfter: 8 }, runs: [
          { text: `第${String(i + 1).padStart(4, '0')}条 研发记录 `, style: { bold: i % 9 === 0, fontName: 'Liberation Serif', fontNameEastAsia: 'Noto Sans CJK SC' } },
          { text: `Document ${((i * 2654435761) >>> 0).toString(16)}: review, test and save. `, style: { color: i % 3 ? '#20242B' : '#0055AA', fontSize: 12 } },
        ] }));
        const parts = Object.fromEntries(codec.exportWordParts(document));
        const input = zip.zipSync(parts, { level: 1, mtime: new Date(1980, 0, 1) });
        if (model.documentText(codec.importWordDocument(input)) !== model.documentText(document)) throw Error('Generated document text changed');
        return { base64: bytes.bytesToBase64(input), textUtf16: model.documentText(document).length, paragraphs: count };
      }, count);
      cases.push({ name: `generated-${count}-paragraphs`, input: Buffer.from(generated.base64, 'base64'), textUtf16: generated.textUtf16, paragraphs: count,
        provenance: 'Project-authored deterministic bilingual supported runs; frozen baseline exportWordParts, fflate level 1, fixed ZIP timestamps. Not LibreOffice-authored.' });
    }
    for (const specimen of cases) {
      const raw = unzipSync(specimen.input);
      const repetitions = smoke ? 1 : specimen.input.length < 15000 ? 10 : 2;
      const entry = { name: specimen.name, provenance: specimen.provenance, inputSha256: sha(specimen.input), inputBytes: specimen.input.length,
        expandedBytes: Object.values(raw).reduce((sum, data) => sum + data.length, 0), parts: Object.keys(raw).length,
        base64PartsJsonBytes: Buffer.byteLength(JSON.stringify(Object.entries(raw).map(([name, data]) => ({ name, dataBase64: Buffer.from(data).toString('base64') })))),
        textUtf16: specimen.textUtf16, paragraphs: specimen.paragraphs, repetitions,
        partDigests: Object.fromEntries(Object.entries(raw).map(([name, data]) => [name, sha(data)])) };
      fs.writeFileSync(path.join(output, specimen.name + '.docx'), specimen.input);
      const result = await page.evaluate(({ base64, repetitions, warmups, samples }) => {
        const { baseline, current, zip, bytes } = window.wordImportBench;
        const input = bytes.base64ToBytes(base64), parts = new Map(Object.entries(zip.unzipSync(input)));
        const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
        const encodeModel = document => JSON.stringify(canonical(document));
        const functions = {
          baselineImportWordDocument: () => baseline.importWordDocument(input),
          currentImportWordDocument: () => current.importWordDocument(input),
          baselineImportWordParts: () => baseline.importWordParts(parts),
          currentImportWordParts: () => current.importWordParts(parts),
        };
        const serialized = Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, encodeModel(fn())]));
        const expected = serialized.baselineImportWordDocument;
        for (const [name, value] of Object.entries(serialized)) if (value !== expected) throw Error(`Full model mismatch: ${name}`);
        const counts = {};
        const originalParser = DOMParser.prototype.parseFromString;
        for (const [name, fn] of Object.entries(functions)) {
          let count = 0, sourceChars = 0;
          DOMParser.prototype.parseFromString = function(source, type) { count++; sourceChars += source.length; return originalParser.call(this, source, type); };
          try { fn(); counts[name] = { domParserCalls: count, sourceUtf16Chars: sourceChars }; }
          finally { DOMParser.prototype.parseFromString = originalParser; }
        }
        // No instrumentation, equality check, fixture decode or serialization inside the timed region.
        const timings = Object.fromEntries(Object.keys(functions).map(name => [name, []]));
        const names = Object.keys(functions); let sink;
        for (let batch = 0; batch < warmups + samples; batch++) {
          const order = batch % 2 ? [...names].reverse() : names;
          for (const name of order) {
            const start = performance.now();
            for (let i = 0; i < repetitions; i++) sink = functions[name]();
            if (batch >= warmups) timings[name].push((performance.now() - start) / repetitions);
          }
        }
        if (!sink?.paragraphs?.length) throw Error('Unused or invalid benchmark result');
        for (const [name, fn] of Object.entries(functions)) if (encodeModel(fn()) !== expected) throw Error(`Model changed after repetitions: ${name}`);
        return { timings, counts, canonicalModelJson: expected, paragraphs: sink.paragraphs.length,
          documentTextUtf16: window.wordImportBench.model.documentText(sink).length };
      }, { base64: specimen.input.toString('base64'), repetitions, warmups, samples });
      entry.metrics = Object.fromEntries(Object.entries(result.timings).map(([name, times]) => [name, summarize(times)]));
      entry.parseCounts = result.counts;
      entry.fullModelSha256 = sha(result.canonicalModelJson);
      entry.fullModelJsonBytes = Buffer.byteLength(result.canonicalModelJson);
      entry.paragraphs = result.paragraphs; entry.textUtf16 = result.documentTextUtf16;
      entry.validation = 'All four real import paths return identical full canonical model JSON before and after timed repetitions, including marker, direct/source styles and metadata; no model fields omitted.';
      report.cases.push(entry); persist();
      console.log(`PASS ${entry.name}: ${entry.paragraphs} paragraphs, ${entry.parts} parts; browser parses ${entry.parseCounts.baselineImportWordDocument.domParserCalls} -> ${entry.parseCounts.currentImportWordDocument.domParserCalls}, native semantic parses ${entry.parseCounts.baselineImportWordParts.domParserCalls} -> ${entry.parseCounts.currentImportWordParts.domParserCalls}`);
    }
    assert.deepEqual(report.sourceDigests, sourceHashes(), 'Current sources changed during benchmark');
    for (const [name, expected] of Object.entries(report.baselineManifest)) assert.equal(digest(path.join(baseline, name)), expected, `Baseline changed during benchmark: ${name}`);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
    report.checks = ['All current source hashes stable throughout the run', 'Frozen baseline manifest verified before and after run', 'Native DOCX hash matches original corpus manifest', 'Exact full-model equality across all four paths before and after repetitions', 'DOMParser instrumentation removed before all timings', 'No browser errors or external requests'];
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally {
    if (browser) await browser.close(); if (server) await server.close();
    report.finishedAt = new Date().toISOString(); report.environment.loadAverageEnd = os.loadavg(); persist();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
