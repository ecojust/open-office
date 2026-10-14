/* Diagnostic package microbenchmark. Requires release word-package-bench and
 * word-package-cli. Not Tauri IPC, native WebView, app latency or Word fidelity.
 * Build: cargo build --release --locked --manifest-path crates/word-package/Cargo.toml --bins
 * Run: WORD_PACKAGE_BENCH=/path/to/release/word-package-bench node scripts/benchmark-word-package.cjs
 * WORD_PACKAGE_BENCH_SMOKE=1 performs short correctness/smoke measurements only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const { unzipSync } = require('fflate');

const root = path.resolve(__dirname, '..');
const smoke = process.env.WORD_PACKAGE_BENCH_SMOKE === '1';
const output = path.resolve(process.env.WORD_PACKAGE_BENCH_OUTPUT || path.join(root, 'test-results/word-package-performance'));
const bench = process.env.WORD_PACKAGE_BENCH || path.join(root, 'crates/word-package/target/release/word-package-bench');
const cli = process.env.WORD_PACKAGE_CLI || path.join(path.dirname(bench), 'word-package-cli');
const warmups = smoke ? 1 : 5, samples = smoke ? 3 : 25;
const sha = data => createHash('sha256').update(data).digest('hex');
const digest = name => sha(fs.readFileSync(name));
const summarize = raw => { const sorted = [...raw].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], minMs: sorted[0], samplesMs: raw }; };
const report = { schemaVersion: 2, ok: false, smoke, startedAt: new Date().toISOString(), warmups, samples,
  scope: 'Release Rust ZIP core and wrappers versus Chromium fflate; persistent Node stdin JSON bridge and one-shot CLI startup measured separately.',
  limitations: ['Not Tauri IPC, native WebView, OS file IO, full Vue app, XML/OOXML semantic parsing, or Microsoft Office.', 'Compression backends and validation work differ. Level 1 is analogous, not identical compression.', 'P95 uses nearest rank over 25 samples (3 in smoke); batches report per-operation times, not individual-call tail latency.', 'Results are a single-machine diagnostic and include allocator/GC behavior.'],
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, v8: process.versions.v8, cpus: os.cpus().length, availableParallelism: os.availableParallelism(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), fflate: '0.8.2', loadAverageStart: os.loadavg() },
  limits: { zipBytes: 16 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, partBytes: 4 * 1024 * 1024, entries: 256, nameUtf8Bytes: 1024, paragraphs: 5000, textUtf16: 250000 },
  browserVariants: { table: 'Production ZIP reader with table CRC; XML is validated by the semantic importer.', bitwise: 'Diagnostic variant replacing only the CRC loop with the previous bitwise algorithm.', xml: 'Production ZIP reader followed by one XML syntax pass per XML/relationships part; diagnostic composition, not the complete importer.' },
  sourceDigests: {}, cases: [], pageErrors: [], externalRequests: [], checks: [] };
const sources = ['crates/word-package/Cargo.toml', 'crates/word-package/Cargo.lock', 'crates/word-package/src/lib.rs', 'crates/word-package/src/bin/word-package-bench.rs', 'crates/word-package/src/bin/word-package-cli.rs', 'scripts/benchmark-word-package.cjs', 'src/word/core/docx.ts', 'src/word/core/model.ts', 'src/presentation/pptx-package.ts', 'src/shared/document.ts', 'tests/compatibility/independent-word/manifest.json'];
const sourceHashes = () => Object.fromEntries(sources.map(file => [file, digest(path.join(root, file))]));
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function sameParts(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [name, data] of Object.entries(expected)) assert.deepEqual(Buffer.from(actual[name]), Buffer.from(data), name);
}
const rows = raw => Object.entries(raw).map(([name, data]) => ({ name, dataBase64: Buffer.from(data).toString('base64') }));
const unrows = parts => Object.fromEntries(parts.map(part => [part.name, Buffer.from(part.dataBase64, 'base64')]));
function corruptCrc(input) {
  const bytes = Buffer.from(input), end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const central = bytes.readUInt32LE(end + 16), local = bytes.readUInt32LE(central + 42);
  const crc = (bytes.readUInt32LE(central + 16) ^ 0x01000000) >>> 0;
  bytes.writeUInt32LE(crc, central + 16); bytes.writeUInt32LE(crc, local + 14);
  return bytes;
}
function adapter() {
  const child = spawn(bench, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = []; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const next = pending.shift();
    if (!next) return;
    try { next.resolve(JSON.parse(line)); } catch (error) { next.reject(error); }
  });
  child.on('error', error => { for (const request of pending.splice(0)) request.reject(error); });
  child.on('exit', (code, signal) => { for (const request of pending.splice(0)) request.reject(Error(`Rust exit ${code}/${signal}: ${stderr}`)); });
  return { child, call(request) { return new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(request) + '\n');
  }); } };
}
async function timedAsync(fn, repetitions = 1) {
  const times = [];
  for (let i = 0; i < warmups + samples; i++) {
    const start = performance.now();
    for (let j = 0; j < repetitions; j++) await fn();
    if (i >= warmups) times.push((performance.now() - start) / repetitions);
  }
  return summarize(times);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert.ok(fs.existsSync(bench) && fs.existsSync(cli), 'Build both release binaries first');
  assert.ok(bench.includes('/release/'), 'Use a release optimized benchmark binary');
  report.sourceDigests = sourceHashes(); report.binaries = { bench, benchSha256: digest(bench), cli, cliSha256: digest(cli) };
  report.build = { profile: 'Cargo default release (opt-level=3, no custom RUSTFLAGS requested)', rustc: spawnSync(process.env.RUSTC || 'rustc', ['--version', '--verbose'], { encoding: 'utf8' }).stdout?.trim() || null };
  let browser, server, native;
  try {
    const docxSource = fs.readFileSync(path.join(root, 'src/word/core/docx.ts'), 'utf8');
    const bitCrc = 'for (const byte of chunk) { checksum ^= byte; for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0) }';
    const tableCrc = 'for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 255]! ^ (checksum >>> 8)';
    assert.equal(docxSource.split(tableCrc).length, 2, 'Current Word CRC loop must match; re-audit benchmark if product changes');
    const packageReader = docxSource.slice(docxSource.indexOf('function readParts('), docxSource.indexOf('function partXml('));
    assert.ok(packageReader.length > 0 && !/\bxml\(/.test(packageReader), 'Package timing must not include hidden XML parsing');
    const transformed = mode => {
      let source = mode === 'bitwise' ? docxSource.replace(tableCrc, bitCrc) : docxSource;
      source += mode === 'xml'
        ? '\nexport function benchmarkReadParts(input: Uint8Array) { const parts = readParts(input); for (const [name, bytes] of parts) if (/\\.(?:xml|rels)$/i.test(name)) xml(bytes, name); return parts }\n'
        : '\nexport { readParts as benchmarkReadParts };\n';
      return source;
    };
    report.transformDigests = Object.fromEntries(['xml', 'bitwise', 'table'].map(mode => [mode, sha(transformed(mode))]));
    const { createServer } = await import('vite');
    server = await createServer({ configFile: false, root, clearScreen: false, cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { include: ['fflate'], noDiscovery: true, entries: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/target/**', '**/test-results/**'] } },
      plugins: [{ name: 'word-package-benchmark', enforce: 'pre', transform(_source, id) {
        const mode = /docx\.ts\?word-package-bench=(xml|bitwise|table)$/.exec(id)?.[1];
        return mode ? transformed(mode) : null;
      }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>Word package diagnostic</title>');
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
      window.codec = await import('/src/word/core/docx.ts');
      window.model = await import('/src/word/core/model.ts');
      window.bytes = await import('/src/shared/document.ts');
      window.packageCodec = await import('/src/presentation/pptx-package.ts');
      window.zip = await import('/node_modules/fflate/esm/browser.js');
      window.readers = {};
      for (const mode of ['xml', 'bitwise', 'table']) readers[mode] = (await import(`/src/word/core/docx.ts?word-package-bench=${mode}`)).benchmarkReadParts;
    });
    report.environment.chromium = await browser.version();
    report.environment.userAgent = await page.evaluate(() => navigator.userAgent);
    native = adapter(); assert.equal((await native.call({ operation: 'ping' })).ok, true);
    report.nodeOneShotProcessPing = await timedAsync(() => {
      const result = spawnSync(bench, [], { input: '{"operation":"ping"}\n', encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/compatibility/independent-word/manifest.json'), 'utf8'));
    const cases = manifest.fixtures.filter(f => !f.expectUnsupported).map(f => {
      const input = fs.readFileSync(path.join(root, 'tests/compatibility/independent-word', f.docx));
      assert.equal(sha(input), f.docxSha256);
      return { name: `libreoffice-${f.name}`, provenance: manifest.libreoffice.version, input };
    });
    for (const count of (smoke ? [100] : [100, 1000, 4000])) {
      const generated = await page.evaluate(count => {
        const doc = model.createWordDocument();
        doc.paragraphs = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, style: { align: i % 7 === 0 ? 'center' : 'left', spaceAfter: 8 }, runs: [
          { text: `第${String(i + 1).padStart(4, '0')}条 研发记录 `, style: { bold: i % 9 === 0, fontName: 'Liberation Serif', fontNameEastAsia: 'Noto Sans CJK SC' } },
          { text: `Document ${((i * 2654435761) >>> 0).toString(16)}: review, test and save. `, style: { color: i % 3 ? '#20242B' : '#0055AA', fontSize: 12 } },
        ] }));
        const parts = Object.fromEntries(codec.exportWordParts(doc));
        const input = zip.zipSync(parts, { level: 1, mtime: new Date(1980, 0, 1) });
        const reopened = codec.importWordDocument(input);
        if (model.documentText(reopened) !== model.documentText(doc)) throw Error('Generated document text changed');
        return { base64: bytes.bytesToBase64(input), textUtf16: model.documentText(doc).length, paragraphs: count };
      }, count);
      cases.push({ name: `generated-${count}-paragraphs`, provenance: 'Deterministic project-authored bilingual supported text/runs; DOCX exported through real OOXML codec, fflate level 1 package. Not LibreOffice-authored.', input: Buffer.from(generated.base64, 'base64'), textUtf16: generated.textUtf16, paragraphs: count });
    }
    for (const specimen of cases) {
      const raw = unzipSync(specimen.input), base64 = specimen.input.toString('base64'), partRows = rows(raw);
      const repetitions = smoke ? 1 : specimen.input.length < 15000 ? 10 : 2;
      const entry = { name: specimen.name, provenance: specimen.provenance, inputSha256: sha(specimen.input), inputBytes: specimen.input.length,
        expandedBytes: Object.values(raw).reduce((sum, value) => sum + value.length, 0), parts: Object.keys(raw).length,
        maxPartBytes: Math.max(...Object.values(raw).map(value => value.length)), textUtf16: specimen.textUtf16, paragraphs: specimen.paragraphs, repetitions,
        partDigests: Object.fromEntries(Object.entries(raw).map(([name, data]) => [name, sha(data)])) };
      fs.writeFileSync(path.join(output, `${specimen.name}.docx`), specimen.input);
      const rust = await native.call({ operation: 'benchmark', base64, warmups, samples, repetitions });
      assert.equal(rust.ok, true, rust.error);
      const rustBytes = Buffer.from(rust.base64, 'base64'); sameParts(unzipSync(rustBytes), raw);
      entry.rust = Object.fromEntries(Object.entries(rust.metrics).map(([key, value]) => [key, summarize(value)]));
      entry.rustOutputBytes = rustBytes.length; entry.rustOutputSha256 = sha(rustBytes);
      const browserMetrics = await page.evaluate(({ base64, rustBase64, warmups, samples, repetitions }) => {
        const input = bytes.base64ToBytes(base64), raw = zip.unzipSync(input), map = new Map(Object.entries(raw));
        const encodedRows = Array.from(map, ([name, data]) => ({ name, dataBase64: bytes.bytesToBase64(data) }));
        let sink;
        const measure = fn => { const out = []; for (let i = 0; i < warmups + samples; i++) { const start = performance.now(); for (let j = 0; j < repetitions; j++) sink = fn(); if (i >= warmups) out.push((performance.now() - start) / repetitions); } return out; };
        const equal = parts => { if (parts.size !== map.size) throw Error('Part count mismatch'); for (const [name, data] of map) { const found = parts.get(name); if (!found || found.length !== data.length || data.some((value, index) => found[index] !== value)) throw Error(`Part mismatch ${name}`); } };
        for (const read of Object.values(readers)) { equal(read(input)); equal(read(bytes.base64ToBytes(rustBase64))); }
        const result = {
          checkedPackageTableCrcWithXml: measure(() => readers.xml(input)),
          checkedPackageBitwiseCrc: measure(() => readers.bitwise(input)),
          checkedPackageTableCrc: measure(() => readers.table(input)),
          rawFflateUnzipNoCrcValidation: measure(() => zip.unzipSync(input)),
          rawFflateZipLevel1: measure(() => zip.zipSync(raw, { level: 1, mtime: new Date(1980, 0, 1) })),
          actualStoredWritePartsWithXml: measure(() => packageCodec.writePptxParts(map)),
          browserZipEncodeBase64: measure(() => bytes.bytesToBase64(input)),
          browserPartsDecodeBase64: measure(() => encodedRows.map(part => ({ name: part.name, data: bytes.base64ToBytes(part.dataBase64) }))),
          browserPartsEncodeBase64: measure(() => Array.from(map, ([name, data]) => ({ name, dataBase64: bytes.bytesToBase64(data) }))),
          browserZipDecodeBase64: measure(() => bytes.base64ToBytes(base64)),
        };
        if (!sink) throw Error('Benchmark result unused');
        const fflateOutput = zip.zipSync(raw, { level: 1, mtime: new Date(1980, 0, 1) });
        const storedOutput = packageCodec.writePptxParts(map);
        equal(readers.bitwise(fflateOutput)); equal(readers.table(storedOutput));
        return { metrics: result, fflateOutputBytes: fflateOutput.length, storedOutputBytes: storedOutput.length };
      }, { base64, rustBase64: rust.base64, warmups, samples, repetitions });
      entry.browser = Object.fromEntries(Object.entries(browserMetrics.metrics).map(([key, value]) => [key, summarize(value)]));
      entry.fflateOutputBytes = browserMetrics.fflateOutputBytes; entry.storedOutputBytes = browserMetrics.storedOutputBytes;
      const readRequest = { operation: 'read', base64 }, writeRequest = { operation: 'write', parts: partRows };
      entry.nodePersistentBridgeRead = await timedAsync(async () => { const r = await native.call(readRequest); assert.equal(r.ok, true); });
      entry.nodePersistentBridgeWrite = await timedAsync(async () => { const r = await native.call(writeRequest); assert.equal(r.ok, true); });
      const bridgeRead = await native.call(readRequest); sameParts(unrows(bridgeRead.parts), raw);
      const bridgeWrite = await native.call(writeRequest); sameParts(unzipSync(Buffer.from(bridgeWrite.base64, 'base64')), raw);
      entry.nodeOneShotCliRead = await timedAsync(() => {
        const result = spawnSync(cli, [], { input: JSON.stringify(readRequest), encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 30000 });
        assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
      });
      const corrupted = corruptCrc(rustBytes).toString('base64');
      assert.equal((await native.call({ operation: 'read', base64: corrupted })).ok, false, 'Rust must reject corrupted CRC');
      await page.evaluate(base64 => { for (const [name, read] of Object.entries(readers)) { let failed = false; try { read(bytes.base64ToBytes(base64)); } catch { failed = true; } if (!failed) throw Error(`${name} accepted corrupted CRC`); } }, corrupted);
      entry.validation = 'Original/fflate/Rust parts byte-equal; browser three readers equal on input and Rust output; core and bridge roundtrips equal; CRC-corrupted output rejected by Rust and all checked browser readers.';
      report.cases.push(entry); persist(); console.log(`PASS ${entry.name}: ${entry.inputBytes} ZIP / ${entry.expandedBytes} expanded bytes`);
    }
    assert.deepEqual(report.sourceDigests, sourceHashes(), 'Benchmark sources changed during run');
    assert.equal(report.binaries.benchSha256, digest(bench)); assert.equal(report.binaries.cliSha256, digest(cli));
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
    report.checks = ['Source and executable hashes stable for entire run', 'Real LibreOffice corpus hashes match manifest', 'Generated DOCX accepted by real OOXML codec with exact text', 'Every cross-engine package byte roundtrip and corrupted CRC check passed', 'No browser errors or external requests'];
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { if (native) native.child.stdin.end(); if (browser) await browser.close(); if (server) await server.close(); report.finishedAt = new Date().toISOString(); report.environment.loadAverageEnd = os.loadavg(); persist(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
