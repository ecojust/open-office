/* Real Rust ZIP CLI + Chromium DOM/TypeScript codec contract tests.
 * The native runtime branch uses a controlled invoke transport backed by the
 * actual Rust executable. This does NOT test real Tauri IPC, WebView, dialogs,
 * LibreOffice execution, UI editing or Microsoft Office compatibility.
 * Build word-package-cli first, then set WORD_PACKAGE_CLI if using a custom
 * Cargo target directory. Vite and Chromium are started and closed here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { zipSync, unzipSync, strToU8, strFromU8, Zip, ZipDeflate } = require('fflate');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.WORD_RUST_PACKAGE_OUTPUT || path.join(root, 'test-results/word-rust-package'));
const executable = process.platform === 'win32' ? 'word-package-cli.exe' : 'word-package-cli';
const cli = process.env.WORD_PACKAGE_CLI || [
  path.join(root, 'crates/word-package/target/debug', executable),
  path.join(root, 'src-tauri/target/debug', executable),
].find(file => fs.existsSync(file));
const report = {
  ok: false,
  scope: 'Actual Rust word-package-cli, real Chromium XML/OOXML codec, and native runtime branch with controlled invoke transport calling Rust',
  limitations: ['No real Tauri IPC or native WebView.', 'No app UI or native file dialogs.', 'Existing LibreOffice-authored corpus is read; this harness does not execute LibreOffice.'],
  cli, checks: [], transport: [], rustCalls: { read: 0, write: 0, accepted: 0, rejected: 0 }, corpus: [], files: [], pageErrors: [], externalRequests: [],
};
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pass = name => { report.checks.push(name); console.log('PASS', name); persist(); };
const b64 = bytes => Buffer.from(bytes).toString('base64');
const partRows = parts => Object.entries(parts).map(([name, data]) => ({ name, dataBase64: b64(data) }));
const rawParts = rows => Object.fromEntries(rows.map(part => [part.name, new Uint8Array(Buffer.from(part.dataBase64, 'base64'))]));
// Compare every semantic field, including independent marker effective/direct
// formatting and named-script provenance. Only generated paragraph IDs differ.
const semantic = model => JSON.parse(JSON.stringify(model, (key, value) => key === 'id' ? undefined : value));
const sourceFiles = ['src/word/core/docx.ts', 'src/word/core/model.ts', 'src/word/core/paper.ts', 'src/word/core/highlight.ts', 'src/word/core/background.ts', 'src/word/core/runtime.ts', 'src/word/core/scripts.ts', 'src/native.ts', 'src/shared/document.ts'];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceDigests = () => Object.fromEntries(sourceFiles.map(file => [file, digest(path.join(root, file))]));
const autoColorCorpus = path.join(root, 'tests/compatibility/independent-word-auto-color');
const autoColorInputs = ['tests/browser/word-rust-package.cjs', 'tests/compatibility/independent-word-auto-color/manifest.json', 'tests/compatibility/independent-word-auto-color/inspect_docx.py'];
const autoColorInputDigests = () => Object.fromEntries(autoColorInputs.map(file => [file, digest(path.join(root, file))]));
const colorDefaults = { color: 'auto', backgroundColor: 'none', highlight: 'none', fontSize: 12, underline: false, underlineColor: 'auto', strike: 'none', verticalAlign: 'baseline' };
const colorStyle = style => Object.fromEntries(Object.entries(colorDefaults).map(([key, value]) => [key, style?.[key] ?? value]));
const modelColors = model => model.paragraphs.map(paragraph => paragraph.runs.flatMap(run => Array.from(run.text, character => ({ character, ...colorStyle(run.style) }))));
const modelMarkers = model => model.paragraphs.map(paragraph => colorStyle(paragraph.marker?.style ?? paragraph.sourceRun));
function inspectColors(file) {
  const result = spawnSync(process.env.PYTHON || 'python3', [path.join(autoColorCorpus, 'inspect_docx.py'), file], { cwd: '/tmp', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function rust(request) {
  assert.ok(cli && fs.existsSync(cli), 'Build word-package-cli or set WORD_PACKAGE_CLI to its executable path');
  report.rustCalls[request.operation]++;
  const result = spawnSync(cli, [], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 30000 });
  if (result.error) throw result.error;
  assert.ok(!result.signal, `Rust CLI terminated by ${result.signal}`);
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw Error(`Rust CLI returned invalid JSON: ${result.stderr || result.stdout.slice(0, 300)}`); }
  assert.equal(result.status, response.ok ? 0 : 1, 'CLI exit status must match the response');
  report.rustCalls[response.ok ? 'accepted' : 'rejected']++;
  if (!response.ok) assert.ok(typeof response.error === 'string' && response.error.length > 0);
  return response;
}
function rustOk(request) { const response = rust(request); assert.equal(response.ok, true, response.error); return response; }
function rustReject(request) { const response = rust(request); assert.equal(response.ok, false, 'Malformed input must fail in Rust'); return response.error; }
function sameParts(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [name, bytes] of Object.entries(expected)) assert.deepEqual(Buffer.from(actual[name]), Buffer.from(bytes), name);
}
function centralEntries(input) {
  const bytes = Buffer.from(input), end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let at = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const nameLength = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42);
    entries.push({ at, local, name: bytes.toString('utf8', at + 46, at + 46 + nameLength), method: bytes.readUInt16LE(at + 10),
      data: local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28) });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}
function streamingZip(name, bytes) {
  const chunks = []; let finished = false;
  const archive = new Zip((error, chunk, final) => { if (error) throw error; chunks.push(chunk); finished ||= final; });
  const file = new ZipDeflate(name, { level: 6 }); archive.add(file);
  file.push(bytes.subarray(0, 17), false); file.push(bytes.subarray(17), true); archive.end();
  assert.equal(finished, true); return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

async function main() {
  let server, browser, forcedFailure;
  try {
    assert.ok(cli && fs.existsSync(cli), 'Build word-package-cli or set WORD_PACKAGE_CLI');
    report.startedAt = new Date().toISOString();
    report.sourceDigests = sourceDigests(); report.cliSha256 = digest(cli);
    report.autoColorInputDigests = autoColorInputDigests();
    const { createServer } = await import('vite');
    server = await createServer({ configFile: false, root, clearScreen: false,
      cacheDir: path.join(output, 'vite-cache'),
      optimizeDeps: { include: ['fflate', '@tauri-apps/api/core', '@tauri-apps/api/event'], noDiscovery: true, entries: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false,
        watch: { ignored: ['**/src-tauri/target/**', '**/crates/**/target/**', '**/test-results/**'] } },
      plugins: [{ name: 'word-package-contract-page', configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><title>Word Rust package contract</title>');
        });
      } }],
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); });
    await page.exposeFunction('__wordRustTransport', (command, args) => {
      assert.ok(['word_read_package', 'word_write_package'].includes(command), `Unexpected invoke: ${command}`);
      assert.deepEqual(Object.keys(args), [command === 'word_read_package' ? 'base64' : 'parts']);
      report.transport.push({ command, inputBytes: command === 'word_read_package' ? Buffer.from(args.base64, 'base64').length : args.parts.reduce((sum, part) => sum + Buffer.from(part.dataBase64, 'base64').length, 0), failedByTest: forcedFailure === command });
      if (forcedFailure === command) throw Error('Injected Rust transport failure; fallback forbidden');
      const result = rust(command === 'word_read_package' ? { operation: 'read', base64: args.base64 } : { operation: 'write', parts: args.parts });
      if (!result.ok) throw Error(result.error);
      return command === 'word_read_package' ? result.parts : result.base64;
    });
    await page.goto(origin);
    await page.evaluate(async () => {
      window.wordCodec = await import('/src/word/core/docx.ts');
      window.wordRuntime = await import('/src/word/core/runtime.ts');
      window.wordModel = await import('/src/word/core/model.ts');
      window.wordBytes = await import('/src/shared/document.ts');
      window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.__wordRustTransport(command, args) };
      window.isTauri = true;
    });
    const call = (operation, input) => page.evaluate(async ({ operation, input }) => {
      const decode = wordBytes.base64ToBytes, encode = wordBytes.bytesToBase64;
      if (operation === 'seed') {
        const model = wordModel.createWordDocument();
        model.page = { width: 792, height: 612, marginTop: 36, marginRight: 54, marginBottom: 72, marginLeft: 90, orientation: 'landscape' };
        model.paragraphs = [
          { id: 'title', style: { align: 'center', heading: 1, spaceAfter: 12 }, marker: { style: { fontSize: 48, color: '#CC0000', underline: false, verticalAlign: 'baseline', strike: 'none', highlight: 'none', backgroundColor: 'none' }, directStyle: { fontSize: 48, color: '#CC0000', underline: false, verticalAlign: 'baseline', strike: 'none', highlight: 'none', backgroundColor: 'none' } }, runs: [{ text: '包互通 Contract 中文', style: { bold: true, fontSize: 18, color: '#123456', underline: 'double', verticalAlign: 'superscript', strike: 'single', highlight: 'yellow', backgroundColor: '#E0F7FA' } }] },
          { id: 'text', style: { spaceBefore: 3, spaceAfter: 8 }, runs: [{ text: 'Tabs\tand\nline breaks 😀 & <XML>', style: { italic: true, underline: true, fontName: 'Noto Sans CJK SC', fontSize: 12.5, verticalAlign: 'subscript', strike: 'double', highlight: 'cyan', backgroundColor: '#D9EAF7' } }] },
          { id: 'reset', style: {}, sourceRun: { underline: 'double', verticalAlign: 'superscript', strike: 'double', highlight: 'red', backgroundColor: '#FEDCBA' }, runs: [{ text: 'Explicit baseline, no strike, highlight or background', style: { underline: false, verticalAlign: 'baseline', strike: 'none', highlight: 'none', backgroundColor: 'none' }, directStyle: { underline: false, verticalAlign: 'baseline', strike: 'none', highlight: 'none', backgroundColor: 'none' } }] },
          { id: 'legacy-empty-named-script-reset', style: {}, sourceRun: { fontSize: 12, verticalAlign: 'subscript' }, runs: [{ text: '', style: { fontSize: 18, verticalAlign: 'baseline', underline: 'double' }, directStyle: { fontSize: 18, verticalAlign: 'baseline', underline: 'double' }, sourceVerticalAlign: 'superscript' }] },
          { id: 'empty-marker-named-script-reset', style: {}, sourceRun: { fontSize: 12, verticalAlign: 'subscript', highlight: 'yellow' }, marker: { style: { fontSize: 24, verticalAlign: 'baseline', underline: false, highlight: 'none' }, directStyle: { fontSize: 24, verticalAlign: 'baseline', underline: false, highlight: 'none' }, sourceVerticalAlign: 'superscript' }, runs: [{ text: '', style: { fontSize: 24, verticalAlign: 'baseline', underline: false, highlight: 'none' }, directStyle: { fontSize: 24, verticalAlign: 'baseline', underline: false, highlight: 'none' }, sourceVerticalAlign: 'superscript' }] },
          { id: 'signed-baseline-offsets', style: {}, runs: [
            { text: 'Raised 中文😀', style: { fontSize: 12, verticalAlign: 25, underline: 'double', underlineColor: '#FF0000', strike: 'single' } },
            { text: ' lowered', style: { fontSize: 12, verticalAlign: -13 } },
          ] },
          { id: 'paragraph-spacing-auto', style: { spaceBefore: 0, spaceAfter: 6, lineHeight: 1.16, lineHeightRule: 'auto' }, runs: [{ text: 'Proportional\nspacing', style: {} }] },
          { id: 'paragraph-spacing-exact', sourceParagraph: { lineHeight: 24, lineHeightRule: 'exact', spaceBefore: 12 }, directStyle: { lineHeight: 400, spaceBefore: 0 }, style: { lineHeight: 400, lineHeightRule: 'exact', spaceBefore: 0 }, runs: [{ text: 'Inherited point units', style: {} }] },
          { id: 'paragraph-spacing-minimum', style: { lineHeight: 18, lineHeightRule: 'atLeast' }, runs: [{ text: 'Minimum spacing', style: { fontSize: 24 } }] },
        ];
        // Tracking stays independent from kerning and from marker formatting
        // while the same model crosses the real Rust ZIP boundary.
        model.paragraphs[0].runs[0].style.letterSpacing = 1.15;
        model.paragraphs[0].runs[0].style.kerning = 10;
        model.paragraphs[0].marker.style.letterSpacing = -20;
        model.paragraphs[0].marker.directStyle.letterSpacing = -20;
        model.paragraphs[1].runs[0].style.letterSpacing = -20;
        model.paragraphs[2].sourceRun.letterSpacing = 2;
        model.paragraphs[2].runs[0].style.letterSpacing = 0;
        model.paragraphs[2].runs[0].directStyle.letterSpacing = 0;
        model.paragraphs[4].marker.style.letterSpacing = 20;
        model.paragraphs[4].marker.directStyle.letterSpacing = 20;
        model.paragraphs[4].runs[0].style.letterSpacing = 20;
        model.paragraphs[4].runs[0].directStyle.letterSpacing = 20;
        // Case effects must cross Rust packaging without rewriting logical
        // Unicode text or merging an independent paragraph marker's format.
        model.paragraphs[0].runs[0].style.caseMap = 'upper';
        model.paragraphs[0].marker.style.caseMap = 'smallCaps';
        model.paragraphs[0].marker.directStyle.caseMap = 'smallCaps';
        model.paragraphs[1].runs[0].style.caseMap = 'smallCaps';
        model.paragraphs[1].runs.push({ text: ' Straße iıİ Σσς 中文', style: { caseMap: 'none' } });
        model.paragraphs[2].sourceRun.caseMap = 'upper';
        model.paragraphs[2].runs[0].style.caseMap = 'none';
        model.paragraphs[2].runs[0].directStyle.caseMap = 'none';
        model.paragraphs[4].marker.style.caseMap = 'upper';
        model.paragraphs[4].marker.directStyle.caseMap = 'upper';
        model.paragraphs[4].runs[0].style.caseMap = 'upper';
        model.paragraphs[4].runs[0].directStyle.caseMap = 'upper';
        // The raw OOXML kerning number stays independent of the Writer-style
        // display switch, tracking and paragraph-marker insertion format.
        model.paragraphs[1].runs[0].style.kerning = 400;
        model.paragraphs[2].sourceRun.kerning = 400;
        model.paragraphs[2].runs[0].style.kerning = 0;
        model.paragraphs[2].runs[0].directStyle.kerning = 0;
        model.paragraphs[4].marker.style.kerning = 0.5;
        model.paragraphs[4].marker.directStyle.kerning = 0.5;
        model.paragraphs[4].runs[0].style.kerning = 0.5;
        model.paragraphs[4].runs[0].directStyle.kerning = 0.5;
        // Underline ink stays independent from foreground, strike and the
        // paragraph marker across both package implementations.
        model.paragraphs[0].runs[0].style.underlineColor = '#FF0000';
        model.paragraphs[0].marker.style.underlineColor = '#0000FF';
        model.paragraphs[0].marker.directStyle.underlineColor = '#0000FF';
        model.paragraphs[1].runs[0].style.underlineColor = '#008000';
        model.paragraphs[2].sourceRun.underlineColor = '#FF0000';
        model.paragraphs[2].runs[0].style.underlineColor = 'auto';
        model.paragraphs[2].runs[0].directStyle.underlineColor = 'auto';
        model.paragraphs[4].marker.style.underlineColor = '#123456';
        model.paragraphs[4].marker.directStyle.underlineColor = '#123456';
        model.paragraphs[4].runs[0].style.underlineColor = '#123456';
        model.paragraphs[4].runs[0].directStyle.underlineColor = '#123456';
        return encode(wordCodec.exportWordDocument(model));
      }
      if (operation === 'browserRead') return wordCodec.importWordDocument(decode(input));
      if (operation === 'runtimeRead') return wordRuntime.importWordDocument(decode(input));
      if (operation === 'partsRead') return wordCodec.importWordParts(new Map(input.map(part => [part.name, decode(part.dataBase64)])));
      if (operation === 'partsWrite') return Array.from(wordCodec.exportWordParts(input), ([name, bytes]) => ({ name, dataBase64: encode(bytes) }));
      if (operation === 'browserWrite') return encode(wordCodec.exportWordDocument(input));
      if (operation === 'runtimeWrite') return encode(await wordRuntime.exportWordDocument(input));
      if (operation === 'oversizeRead') return wordRuntime.importWordDocument(new Uint8Array(16 * 1024 * 1024 + 1));
      if (operation === 'colorNativeEdit') {
        const controller = new wordModel.WordController(input.model);
        for (const action of input.actions) {
          if (action === 'end') {
            const end = { paragraph: 0, offset: wordModel.paragraphText(controller.model.paragraphs[0]).length };
            controller.setSelection({ anchor: end, focus: end });
          } else if (action === 'Enter') controller.replaceText(controller.selection, '\n');
          else if (action === 'type:x') controller.replaceText(controller.selection, 'x');
          else throw Error('Unknown native color editing action: ' + action);
        }
        return controller.model;
      }
      if (operation === 'edit') {
        const controller = new wordModel.WordController(input), first = controller.model.paragraphs[0];
        const length = wordModel.paragraphText(first).length;
        if (length) controller.formatText({ anchor: { paragraph: 0, offset: 0 }, focus: { paragraph: 0, offset: length } }, { color: '#2456AB', bold: true });
        controller.formatParagraph({ anchor: { paragraph: 0, offset: 0 }, focus: { paragraph: 0, offset: 0 } }, { align: 'right', spaceAfter: 15 });
        // Model-owned controller preserves named-style insertion semantics.
        const end = { paragraph: 0, offset: length };
        // Native saves may give ASCII numeric-offset text an unused CJK
        // family. Keep this interoperability edit within that documented
        // subset; the baseline suite separately checks non-ASCII rejection.
        const hasCustomOffset = controller.model.paragraphs[0].runs.some(run => typeof run.style.verticalAlign === 'number')
          || typeof controller.model.paragraphs[0].marker?.style.verticalAlign === 'number';
        controller.replaceText({ anchor: end, focus: end }, hasCustomOffset ? ' Rust-TS' : ' Rust↔TS');
        for (let paragraph = 0; paragraph < controller.model.paragraphs.length; paragraph++) {
          if (wordModel.paragraphText(controller.model.paragraphs[paragraph]).length) continue;
          const caret = { paragraph, offset: 0 };
          controller.formatText({ anchor: caret, focus: caret }, { underline: 'double' });
        }
        return controller.model;
      }
      if (operation === 'browserRuntimeRoundtrip') {
        window.isTauri = false;
        try { return encode(await wordRuntime.exportWordDocument(await wordRuntime.importWordDocument(decode(input)))); }
        finally { window.isTauri = true; }
      }
      if (operation === 'enterSparseMarker') {
        const model = wordModel.createWordDocument(), sourceRun = { fontSize: 12, color: '#000000' };
        model.paragraphs[0] = { id: 'sparse-enter', style: {}, sourceRun,
          marker: { style: { ...sourceRun, bold: true }, directStyle: { bold: true } },
          runs: [{ text: 'BODY', style: { fontSize: 24, italic: true, color: '#0044AA' }, directStyle: { fontSize: 24, italic: true, color: '#0044AA' } }] };
        const controller = new wordModel.WordController(model), end = { paragraph: 0, offset: 4 };
        controller.replaceText({ anchor: end, focus: end }, '\n');
        return controller.model;
      }
      throw Error(`Unknown contract operation ${operation}`);
    }, { operation, input });

    const raw = { 'word/': new Uint8Array(), 'word/正文.xml': strToU8('中文 😀\t\n'), 'empty.bin': new Uint8Array(), 'all-bytes.bin': Uint8Array.from({ length: 196609 }, (_, i) => (i * 131 + i % 31) & 255) };
    for (const level of [0, 6]) {
      const bytes = zipSync(raw, { level });
      const rows = rustOk({ operation: 'read', base64: b64(bytes) }).parts;
      sameParts(rawParts(rows), raw);
      const written = rustOk({ operation: 'write', parts: rows }).base64;
      sameParts(unzipSync(Buffer.from(written, 'base64')), raw);
      assert.equal(rustOk({ operation: 'write', parts: rows }).base64, written, 'Rust package output must be deterministic');
    }
    const streamedData = strToU8('descriptor 中文\n'.repeat(500));
    const streamed = streamingZip('stream/正文.xml', streamedData);
    sameParts(rawParts(rustOk({ operation: 'read', base64: b64(streamed) }).parts), { 'stream/正文.xml': streamedData });
    pass('Real Rust and fflate interoperate on stored/deflated ZIP, UTF-8 names, directories, empty/binary bytes, descriptors and deterministic output');

    const seed = await call('seed'), seedParts = unzipSync(Buffer.from(seed, 'base64'));
    const original = await call('browserRead', seed);
    for (const [index, backgroundColor, highlight] of [[0, '#E0F7FA', 'yellow'], [1, '#D9EAF7', 'cyan'], [2, 'none', 'none']]) {
      assert.equal(original.paragraphs[index].runs[0].style.backgroundColor, backgroundColor, 'Seed must retain its independent background layer');
      assert.equal(original.paragraphs[index].runs[0].style.highlight, highlight, 'Seed must retain its independent highlight layer');
    }
    assert.equal(original.paragraphs[2].sourceRun.backgroundColor, '#FEDCBA');
    assert.equal(original.paragraphs[2].runs[0].directStyle.backgroundColor, 'none', 'Explicit background reset must survive paragraph inheritance');
    assert.equal(original.paragraphs[0].marker.style.fontSize, 48, 'Independent marker size must survive beside an 18pt body');
    assert.equal(original.paragraphs[0].runs[0].style.fontSize, 18, 'Marker format must not become body inheritance');
    assert.equal(original.paragraphs[0].marker.style.underline, false);
    assert.equal(original.paragraphs[0].runs[0].style.underline, 'double');
    assert.equal(original.paragraphs[0].runs[0].style.letterSpacing, 1.15);
    assert.equal(original.paragraphs[0].runs[0].style.kerning, 10);
    assert.equal(original.paragraphs[0].marker.directStyle.letterSpacing, -20);
    assert.equal(original.paragraphs[1].runs[0].style.letterSpacing, -20);
    assert.equal(original.paragraphs[2].sourceRun.letterSpacing, 2);
    assert.equal(original.paragraphs[2].runs[0].directStyle.letterSpacing, 0);
    assert.equal(original.paragraphs[4].marker.directStyle.letterSpacing, 20);
    report.spacingSeed = { positive: 1.15, negativeAndMarker: -20, inherited: 2, explicitReset: 0, emptyMarker: 20, independentKerning: 10 };
    assert.equal(original.paragraphs[0].runs[0].style.caseMap, 'upper');
    assert.equal(original.paragraphs[0].marker.style.caseMap, 'smallCaps');
    assert.equal(original.paragraphs[1].runs[0].style.caseMap, 'smallCaps');
    assert.equal(original.paragraphs[1].runs[1].text, ' Straße iıİ Σσς 中文', 'Adjacent original-case Unicode must remain unchanged');
    assert.equal(original.paragraphs[1].runs[1].style.caseMap, 'none');
    assert.equal(original.paragraphs[2].sourceRun.caseMap, 'upper');
    assert.equal(original.paragraphs[2].runs[0].directStyle.caseMap, 'none');
    assert.equal(original.paragraphs[4].marker.directStyle.caseMap, 'upper');
    report.caseSeed = { body: ['upper', 'smallCaps', 'none'], independentMarker: 'smallCaps', inherited: 'upper', emptyMarker: 'upper', originalUnicodePreserved: true };
    assert.equal(original.paragraphs[1].runs[0].style.kerning, 400);
    assert.equal(original.paragraphs[2].sourceRun.kerning, 400);
    assert.equal(original.paragraphs[2].runs[0].directStyle.kerning, 0);
    assert.equal(original.paragraphs[4].marker.directStyle.kerning, 0.5);
    assert.equal(original.paragraphs[4].runs[0].style.kerning, 0.5);
    report.kerningSeed = { largeRawValue: 400, inheritedRawValue: 400, explicitReset: 0, emptyMarkerRawValue: 0.5 };
    assert.equal(original.paragraphs[0].runs[0].style.underlineColor, '#FF0000');
    assert.equal(original.paragraphs[0].runs[0].style.color, '#123456');
    assert.equal(original.paragraphs[0].marker.style.underlineColor, '#0000FF');
    assert.equal(original.paragraphs[1].runs[0].style.underlineColor, '#008000');
    assert.equal(original.paragraphs[2].sourceRun.underlineColor, '#FF0000');
    assert.equal(original.paragraphs[2].runs[0].style.underlineColor, 'auto');
    assert.equal(original.paragraphs[4].marker.style.underlineColor, '#123456');
    report.underlineColorSeed = { body: '#FF0000', marker: '#0000FF', text: '#123456', inherited: '#FF0000', explicitFollowText: 'auto', latentEmptyMarker: '#123456' };
    assert.equal(original.paragraphs[5].runs[0].style.verticalAlign, 25);
    assert.equal(original.paragraphs[5].runs[1].style.verticalAlign, -13);
    assert.equal(original.paragraphs[5].runs[0].style.fontSize, 12);
    assert.equal(original.paragraphs[5].runs[0].style.underlineColor, '#FF0000');
    report.baselineOffsetSeed = { positivePercent: 25, negativePercent: -13, logicalFontSize: 12, independentUnderline: '#FF0000' };
    assert.equal(original.paragraphs[6].style.lineHeight, 1.16);
    assert.equal(original.paragraphs[6].style.lineHeightRule, 'auto');
    assert.equal(original.paragraphs[7].style.lineHeight, 400);
    assert.equal(original.paragraphs[7].directStyle.lineHeightRule, 'exact');
    assert.equal(original.paragraphs[7].directStyle.spaceBefore, 0);
    assert.equal(original.paragraphs[8].style.lineHeightRule, 'atLeast');
    report.paragraphSpacingSeed = { proportional: 1.16, fixedPoints: 400, inheritedPointRule: true, explicitZeroBefore: true, minimumPoints: 18 };
    assert.deepEqual(original.page, { width: 792, height: 612, marginTop: 36, marginRight: 54, marginBottom: 72, marginLeft: 90, orientation: 'landscape' });
    report.pageSettingsSeed = original.page;
    for (const index of [3, 4]) {
      const paragraph = original.paragraphs[index];
      assert.equal(paragraph.marker.sourceVerticalAlign, 'superscript', 'Empty marker must retain its named-character script source');
      assert.equal(paragraph.marker.directStyle.verticalAlign, 'baseline', 'An explicit marker baseline must override the named source');
      assert.equal(paragraph.marker.style.verticalAlign, 'baseline');
      assert.equal(paragraph.runs[0].sourceVerticalAlign, 'superscript');
      assert.equal(paragraph.runs[0].directStyle.verticalAlign, 'baseline');
      assert.equal(paragraph.runs[0].text, '');
    }
    report.markerSeed = { independentBodyAndMarker: true, legacyEmptyNamedScriptReset: true, explicitEmptyMarkerNamedScriptReset: true };
    const unicodeParts = { ...seedParts };
    unicodeParts['word/正文.xml'] = unicodeParts['word/document.xml']; delete unicodeParts['word/document.xml'];
    unicodeParts['word/_rels/正文.xml.rels'] = unicodeParts['word/_rels/document.xml.rels']; delete unicodeParts['word/_rels/document.xml.rels'];
    unicodeParts['[Content_Types].xml'] = strToU8(strFromU8(unicodeParts['[Content_Types].xml']).replaceAll('word/document.xml', 'word/正文.xml'));
    unicodeParts['_rels/.rels'] = strToU8(strFromU8(unicodeParts['_rels/.rels']).replaceAll('word/document.xml', 'word/正文.xml'));
    const utf16Parts = { ...seedParts, 'word/document.xml': Buffer.concat([Buffer.from([255, 254]), Buffer.from(strFromU8(seedParts['word/document.xml']).replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]) };
    const fixtures = [
      ['stored', zipSync(seedParts, { level: 0 })], ['deflated', zipSync(seedParts, { level: 6 })],
      ['unicode-path', zipSync(unicodeParts)], ['utf16-xml', zipSync(utf16Parts)],
    ];
    for (const [name, bytes] of fixtures) {
      const rows = rustOk({ operation: 'read', base64: b64(bytes) }).parts;
      assert.deepEqual(semantic(await call('partsRead', rows)), semantic(original), `${name}: Rust parts retain XML semantics`);
      assert.deepEqual(semantic(await call('runtimeRead', b64(bytes))), semantic(original), `${name}: native runtime semantics`);
      const exportedRows = await call('partsWrite', original);
      const written = rustOk({ operation: 'write', parts: exportedRows }).base64;
      assert.deepEqual(semantic(await call('browserRead', written)), semantic(await call('browserRead', await call('browserWrite', original))), `${name}: Rust write is readable by the actual TS codec`);
    }
    pass('Native package parts and browser DOCX imports agree for stored/deflated data, Unicode part paths and UTF-16 XML');

    // Force the real browser-to-native Base64 helpers across several 32 KiB
    // chunks without relying on compressible ZIP bytes to exercise the path.
    const largeModel = structuredClone(original);
    largeModel.paragraphs[0].runs[0].text = '中文ABC😀'.repeat(12000);
    const largeParts = rawParts(await call('partsWrite', largeModel));
    assert.ok(largeParts['word/document.xml'].byteLength > 32768 * 4);
    const largeStored = zipSync(largeParts, { level: 0 });
    const largeImported = await call('runtimeRead', b64(largeStored));
    assert.deepEqual(semantic(largeImported), semantic(await call('browserRead', b64(largeStored))));
    const largeWritten = await call('runtimeWrite', largeImported);
    assert.deepEqual(semantic(await call('browserRead', largeWritten)), semantic(await call('browserRead', await call('browserWrite', largeImported))));
    pass('Native runtime Base64 encoding preserves multi-chunk Chinese, emoji and XML bytes on actual Rust read/write');

    const edited = await call('edit', original);
    const browserEdited = await call('browserWrite', edited), rustEdited = await call('runtimeWrite', edited);
    const canonicalEdited = await call('browserRead', browserEdited);
    assert.deepEqual(semantic(await call('runtimeRead', rustEdited)), semantic(canonicalEdited));
    assert.deepEqual(semantic(await call('browserRead', rustEdited)), semantic(canonicalEdited));
    assert.ok(canonicalEdited.paragraphs[0].runs.map(run => run.text).join('').endsWith(' Rust↔TS'));
    assert.equal(canonicalEdited.paragraphs[0].style.align, 'right');
    for (const index of [3, 4]) {
      const paragraph = canonicalEdited.paragraphs[index];
      assert.equal(paragraph.marker.directStyle.underline, 'double', 'Empty caret formatting must persist without typing');
      assert.equal(paragraph.marker.sourceVerticalAlign, 'superscript');
      assert.equal(paragraph.marker.directStyle.verticalAlign, 'baseline');
      assert.equal(paragraph.runs[0].text, '');
      assert.equal(paragraph.runs[0].style.underline, 'double');
    }
    report.markerSeed.emptyCaretSavedWithoutTyping = true;
    const entered = await call('enterSparseMarker');
    assert.deepEqual(entered.paragraphs[0].marker.directStyle, { bold: true }, 'End Enter must preserve the first independent marker');
    const enteredBytes = await call('runtimeWrite', entered);
    const reopenedEnter = await call('runtimeRead', enteredBytes);
    assert.deepEqual(semantic(reopenedEnter), semantic(await call('browserRead', await call('browserWrite', entered))));
    assert.equal(reopenedEnter.paragraphs[1].runs[0].text, '');
    assert.equal(reopenedEnter.paragraphs[1].marker.style.fontSize, 24);
    assert.equal(reopenedEnter.paragraphs[1].marker.style.italic, true);
    assert.equal(reopenedEnter.paragraphs[1].marker.style.color, '#0044AA');
    assert.equal(reopenedEnter.paragraphs[1].marker.style.bold, true);
    report.markerSeed.sparseEndEnterSavedWithoutTyping = true;
    fs.writeFileSync(path.join(output, 'rust-sparse-marker-enter-empty.docx'), Buffer.from(enteredBytes, 'base64')); report.files.push('rust-sparse-marker-enter-empty.docx');
    fs.writeFileSync(path.join(output, 'rust-edited.docx'), Buffer.from(rustEdited, 'base64')); report.files.push('rust-edited.docx');
    const callsBeforeBrowser = report.transport.length;
    assert.deepEqual(semantic(await call('browserRead', await call('browserRuntimeRoundtrip', seed))), semantic(await call('browserRead', await call('browserWrite', original))));
    assert.equal(report.transport.length, callsBeforeBrowser, 'Browser runtime branch must not invoke Rust');
    pass('Real native runtime read/write agrees with browser semantics after model-owned text/format edits; browser runtime stays local to its codec');

    const stored = Buffer.from(fixtures[0][1]), documentEntry = centralEntries(stored).find(entry => entry.name === 'word/document.xml');
    const badCrc = Buffer.from(stored); badCrc[documentEntry.data] ^= 1;
    const localMismatch = Buffer.from(stored); localMismatch[documentEntry.local + 14] ^= 1;
    for (const [name, bytes] of [['payload-crc', badCrc], ['local-central-mismatch', localMismatch], ['truncated', stored.subarray(0, stored.length - 7)]]) {
      rustReject({ operation: 'read', base64: b64(bytes) });
      const before = report.transport.length;
      await assert.rejects(call('runtimeRead', b64(bytes)), /DOCX|ZIP|校验|目录|文件头/);
      assert.equal(report.transport.length, before + 1, `${name}: exactly one native attempt`);
    }
    for (const command of ['word_read_package', 'word_write_package']) {
      forcedFailure = command; const before = report.transport.length;
      await assert.rejects(call(command === 'word_read_package' ? 'runtimeRead' : 'runtimeWrite', command === 'word_read_package' ? seed : edited), /Injected Rust transport failure/);
      assert.equal(report.transport.length, before + 1, 'Native failures must not retry or fall back'); forcedFailure = undefined;
    }
    pass('Corrupt ZIP and native transport errors reject once without a browser fallback');

    const seedDocumentXml = strFromU8(seedParts['word/document.xml']);
    const replaceParagraphSpacing = (index, attributes) => {
      let paragraphIndex = -1, replaced = false;
      const xml = seedDocumentXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, paragraph => {
        if (++paragraphIndex !== index) return paragraph;
        return paragraph.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (_, properties) => {
          // w:spacing also occurs inside marker rPr for character tracking.
          // Target only the paragraph spacing element, never that run property.
          const pattern = /<w:spacing\b(?=[^>]*\bw:(?:before|after|line|lineRule)=)[^>]*\/>/;
          assert.match(properties, pattern, 'Seed paragraph must have a paragraph-spacing control');
          replaced = true;
          return `<w:pPr>${properties.replace(pattern, `<w:spacing ${attributes}/>` )}</w:pPr>`;
        });
      });
      assert.ok(replaced, `Seed paragraph ${index} must be replaced`);
      return xml;
    };
    report.ruleOnly = [];
    for (const rule of ['auto', 'exact', 'atLeast']) {
      // The inherited value is exact 24pt. Native Writer creates a fresh
      // 240-twip distance for a rule-only direct override, not that 24pt value.
      const bytes = zipSync({ ...seedParts, 'word/document.xml': strToU8(replaceParagraphSpacing(7, `w:before="0" w:lineRule="${rule}"`)) });
      const rows = rustOk({ operation: 'read', base64: b64(bytes) }).parts;
      const models = [await call('browserRead', b64(bytes)), await call('partsRead', rows), await call('runtimeRead', b64(bytes))];
      for (const model of models) {
        const paragraph = model.paragraphs[7], value = rule === 'auto' ? 1 : 12;
        assert.equal(paragraph.sourceParagraph.lineHeight, 24); assert.equal(paragraph.sourceParagraph.lineHeightRule, 'exact');
        assert.equal(paragraph.style.lineHeight, value); assert.equal(paragraph.style.lineHeightRule, rule);
        assert.equal(paragraph.directStyle.lineHeight, value); assert.equal(paragraph.directStyle.lineHeightRule, rule);
        assert.equal(paragraph.style.spaceBefore, 0);
        assert.deepEqual(semantic(model.paragraphs.filter((_, i) => i !== 7)), semantic(original.paragraphs.filter((_, i) => i !== 7)), 'Rule-only import must preserve other paragraphs and markers');
        assert.deepEqual(semantic(model), semantic(models[0]));
      }
      const written = await call('runtimeWrite', models[2]);
      for (const operation of ['browserRead', 'runtimeRead']) assert.deepEqual(semantic(await call(operation, written)), semantic(models[0]), `${rule}: explicit rule-only reset survives Rust write/reopen`);
      const file = `rule-only-${rule}.docx`; fs.writeFileSync(path.join(output, file), Buffer.from(written, 'base64')); report.files.push(file);
      report.ruleOnly.push({ rule, inherited: { lineHeight: 24, lineHeightRule: 'exact' }, expected: { lineHeight: rule === 'auto' ? 1 : 12, lineHeightRule: rule }, output: file });
    }
    pass('Rule-only auto/exact/atLeast overrides materialize native 240-twip values and direct provenance across Rust/browser reads, writes and reopening');

    const withoutCase = seedDocumentXml.replace(/<w:(?:caps|smallCaps)\b[^>]*\/>/g, '');
    assert.notEqual(withoutCase, strFromU8(seedParts['word/document.xml']), 'Seed must contain case-effect properties');
    for (const [name, xml] of [
      ['invalid-xml', '<w:document>'],
      ['dtd', '<!DOCTYPE document [<!ENTITY injected "BAD">]>' + strFromU8(seedParts['word/document.xml'])],
      ['unsupported-table', strFromU8(seedParts['word/document.xml']).replace('<w:body>', '<w:body><w:tbl/>')],
      ['out-of-range-character-spacing', strFromU8(seedParts['word/document.xml']).replace('<w:spacing w:val="23"/>', '<w:spacing w:val="401"/>')],
      ['fractional-character-spacing-twips', strFromU8(seedParts['word/document.xml']).replace('<w:spacing w:val="23"/>', '<w:spacing w:val="0.5"/>')],
      ['out-of-range-kerning', strFromU8(seedParts['word/document.xml']).replace('<w:kern w:val="20"/>', '<w:kern w:val="801"/>')],
      ['fractional-kerning-half-points', strFromU8(seedParts['word/document.xml']).replace('<w:kern w:val="20"/>', '<w:kern w:val="1.5"/>')],
      ['malformed-underline-color', strFromU8(seedParts['word/document.xml']).replace(/<w:u\b[^>]*\/>/, '<w:u w:val="double" w:color="GG0000"/>')],
      ['unsupported-xml-auto-underline-color', strFromU8(seedParts['word/document.xml']).replace(/<w:u\b[^>]*\/>/, '<w:u w:val="double" w:color="auto"/>')],
      ['unsupported-theme-underline-color', strFromU8(seedParts['word/document.xml']).replace(/<w:u\b[^>]*\/>/, '<w:u w:val="double" w:color="FF0000" w:themeColor="accent1"/>')],
      ...[
        ['uppercase-auto', '<w:color w:val="AUTO"/>'], ['empty', '<w:color w:val=""/>'],
        ['short-rgb', '<w:color w:val="FFF"/>'], ['alpha-rgb', '<w:color w:val="FF000080"/>'],
        ['theme', '<w:color w:val="auto" w:themeColor="accent1"/>'], ['tint', '<w:color w:val="auto" w:themeTint="80"/>'],
        ['shade', '<w:color w:val="auto" w:themeShade="80"/>'], ['duplicate', '<w:color w:val="auto"/><w:color w:val="000000"/>'],
      ].map(([name, replacement]) => {
        const xml = seedDocumentXml.replace(/<w:color\b[^>]*\/>/, replacement);
        assert.notEqual(xml, seedDocumentXml, 'Color rejection must mutate actual character formatting');
        return ['invalid-foreground-' + name, xml];
      }),
      ['out-of-range-baseline-offset', strFromU8(seedParts['word/document.xml']).replace('<w:position w:val="6"/>', '<w:position w:val="201"/>')],
      ['fractional-baseline-offset', strFromU8(seedParts['word/document.xml']).replace('<w:position w:val="6"/>', '<w:position w:val="1.5"/>')],
      ['duplicate-baseline-offset', strFromU8(seedParts['word/document.xml']).replace('<w:position w:val="6"/>', '<w:position w:val="6"/><w:position w:val="-6"/>')],
      ['unstable-native-auto-line-spacing', replaceParagraphSpacing(7, 'w:line="802" w:lineRule="auto"')],
      ['overflow-native-fixed-line-spacing', replaceParagraphSpacing(7, 'w:line="18577" w:lineRule="exact"')],
      ['invalid-rule-only-line-spacing', replaceParagraphSpacing(7, 'w:lineRule="odd"')],
      ['empty-rule-only-line-spacing', replaceParagraphSpacing(7, 'w:lineRule=""')],
      ['empty-line-with-rule', replaceParagraphSpacing(7, 'w:line="" w:lineRule="exact"')],
      ['rule-only-unsupported-attribute', replaceParagraphSpacing(7, 'w:lineRule="atLeast" w:beforeAutospacing="1"')],
      ['invalid-page-orientation', strFromU8(seedParts['word/document.xml']).replace('w:orient="landscape"', 'w:orient="diagonal"')],
      ['unsupported-page-gutter', strFromU8(seedParts['word/document.xml']).replace('w:gutter="0"', 'w:gutter="720"')],
      ['ambiguous-case-effects', withoutCase.replace('<w:rPr>', '<w:rPr><w:caps/><w:smallCaps/>')],
      ['invalid-case-effect-boolean', withoutCase.replace('<w:rPr>', '<w:rPr><w:caps w:val="maybe"/>')],
      ['unsupported-case-mapping', strFromU8(seedParts['word/document.xml']).replace('Contract', 'Straße')],
      ['invalid-utf8', new Uint8Array([255, 255, 255])],
    ]) {
      const bytes = zipSync({ ...seedParts, 'word/document.xml': typeof xml === 'string' ? strToU8(xml) : xml });
      const rows = rustOk({ operation: 'read', base64: b64(bytes) }).parts;
      await assert.rejects(call('partsRead', rows), /XML|DTD|正文内容 tbl|编码|字符间距|字偶距|大写|布尔|开关|caps|下划线|颜色|属性|基线|重复的 (?:position|color)|段落|行距|纸张|装订线/);
      await assert.rejects(call('runtimeRead', b64(bytes)), /XML|DTD|正文内容 tbl|编码|字符间距|字偶距|大写|布尔|开关|caps|下划线|颜色|属性|基线|重复的 (?:position|color)|段落|行距|纸张|装订线/);
      report.checks.push(`Semantic rejection after successful Rust ZIP read: ${name}`);
    }
    pass('A valid Rust ZIP container cannot bypass TypeScript XML, DTD, encoding, underline-color, character-spacing bounds, case-effect or unsupported table validation');

    rustReject({ operation: 'read', base64: 'not-base64!' });
    rustReject({ operation: 'write', parts: [{ name: 'file', dataBase64: 'not-base64!' }] });
    rustReject({ operation: 'write', parts: [{ name: 'too-large', dataBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') }] });
    rustReject({ operation: 'write', parts: Array.from({ length: 257 }, (_, index) => ({ name: String(index), dataBase64: '' })) });
    for (const parts of [[{ name: '../escape', dataBase64: '' }], [{ name: 'A', dataBase64: '' }, { name: 'a', dataBase64: '' }]]) rustReject({ operation: 'write', parts });
    const beforeOversize = report.transport.length;
    await assert.rejects(call('oversizeRead'), /16 MiB/);
    assert.equal(report.transport.length, beforeOversize, 'Oversized native bytes must be rejected before Base64 transport');
    pass('Native Base64 protocol rejects malformed/oversized/ambiguous inputs, and runtime guards 16 MiB before invoking Rust');

    const corpusFiles = ['independent-word', 'independent-word-indentation', 'independent-word-character-format', 'independent-word-highlight', 'independent-word-background', 'independent-word-underline', 'independent-word-marker', 'independent-word-spacing', 'independent-word-case', 'independent-word-kerning', 'independent-word-underline-color', 'independent-word-baseline-offset', 'independent-word-paragraph-spacing', 'independent-word-page-settings', 'independent-word-line-rule', 'independent-word-auto-color'].flatMap(directory => {
      const corpus = path.join(root, 'tests/compatibility', directory);
      const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
      return [...manifest.fixtures, ...(manifest.editingFixtures || [])].flatMap(fixture => {
        const native = { name: `${directory}-${path.basename(fixture.docx)}`, file: path.join(corpus, fixture.docx), sha256: fixture.docxSha256, expectUnsupported: fixture.expectUnsupported };
        if (directory === 'independent-word-auto-color') {
          assert.ok(Array.isArray(fixture.sourceExpected) && Array.isArray(fixture.expected) && Array.isArray(fixture.sourceMarkers) && Array.isArray(fixture.expectedMarkers), `${fixture.name}: independent foreground and marker oracles are required`);
          return [
            { ...native, colorOracle: { characters: fixture.expected, markers: fixture.expectedMarkers } },
            { name: `${directory}-source-${path.basename(fixture.source)}`, file: path.join(corpus, fixture.source), sha256: fixture.sourceSha256,
              colorOracle: { characters: fixture.sourceExpected, markers: fixture.sourceMarkers }, colorEditing: fixture.actions ? { actions: fixture.actions, characters: fixture.expected, markers: fixture.expectedMarkers, typedColor: fixture.typedColor } : undefined },
            ...(fixture.secondDocx ? [{ name: `${directory}-second-${path.basename(fixture.secondDocx.path)}`, file: path.join(corpus, fixture.secondDocx.path), sha256: fixture.secondDocx.sha256, colorOracle: { characters: fixture.expected } }] : []),
          ];
        }
        if (directory !== 'independent-word-line-rule') return [native];
        // Native output materializes the missing line value. Also send every
        // original package through Rust so the actual rule-only XML is tested.
        assert.ok(Array.isArray(fixture.expected) && Array.isArray(fixture.sourceExpected) && Array.isArray(fixture.provenance), `${fixture.name}: independent line-rule oracle is required`);
        return [
          { ...native, expectedParagraphSpacing: fixture.expected },
          { name: `${directory}-source-${path.basename(fixture.source)}`, file: path.join(corpus, fixture.source), sha256: fixture.sourceSha256, expectedParagraphSpacing: fixture.sourceExpected, paragraphSpacingProvenance: fixture.provenance },
        ];
      });
    });
    for (const { name, file: sourceFile, sha256, expectUnsupported, expectedParagraphSpacing, paragraphSpacingProvenance, colorOracle, colorEditing } of corpusFiles) {
      report.activeFixture = name; persist();
      assert.equal(digest(sourceFile), sha256, `${name}: native corpus must remain byte-for-byte unchanged`);
      const bytes = fs.readFileSync(sourceFile);
      const rows = rustOk({ operation: 'read', base64: b64(bytes) }).parts;
      if (expectUnsupported) {
        await assert.rejects(call('browserRead', b64(bytes)), /WordDocumentError:.*请使用完整文字编辑器打开此文件/);
        await assert.rejects(call('partsRead', rows), /WordDocumentError:.*请使用完整文字编辑器打开此文件/);
        await assert.rejects(call('runtimeRead', b64(bytes)), /WordDocumentError:.*请使用完整文字编辑器打开此文件/);
        report.corpus.push({ name, sha256, packageAccepted: true, semanticsAccepted: false, expectUnsupported }); continue;
      }
      const model = await call('browserRead', b64(bytes)), nativeModel = await call('runtimeRead', b64(bytes));
      assert.deepEqual(semantic(await call('partsRead', rows)), semantic(model), `${name}: raw Rust part import`);
      assert.deepEqual(semantic(nativeModel), semantic(model), `${name}: native runtime import`);
      if (colorOracle) {
        const inspected = inspectColors(sourceFile), expectedMarkers = inspected.paragraphs.map(paragraph => colorStyle(paragraph.marker));
        assert.deepEqual(inspected.paragraphs.map(paragraph => paragraph.characters), colorOracle.characters, `${name}: immutable independent character oracle`);
        if (colorOracle.markers) assert.deepEqual(expectedMarkers, colorOracle.markers.map(colorStyle), `${name}: immutable independent marker oracle`);
        assert.deepEqual(modelColors(nativeModel), colorOracle.characters, `${name}: Rust import preserves automatic tokens and separate paint layers`);
        assert.deepEqual(modelMarkers(nativeModel), expectedMarkers, `${name}: Rust import preserves independent paragraph markers`);
        let cycle = nativeModel;
        for (let generation = 1; generation <= 2; generation++) {
          const saved = await call('runtimeWrite', cycle), file = `rust-color-${generation}-${name}`;
          fs.writeFileSync(path.join(output, file), Buffer.from(saved, 'base64')); report.files.push(file);
          const independent = inspectColors(path.join(output, file));
          assert.deepEqual(independent.paragraphs.map(paragraph => paragraph.characters), colorOracle.characters, `${name}: actual Rust ZIP output generation ${generation}`);
          assert.deepEqual(independent.paragraphs.map(paragraph => colorStyle(paragraph.marker)), expectedMarkers, `${name}: independent saved marker generation ${generation}`);
          cycle = await call('runtimeRead', saved);
          assert.deepEqual(modelColors(cycle), colorOracle.characters); assert.deepEqual(modelMarkers(cycle), expectedMarkers);
        }
        if (colorEditing) {
          const edited = await call('colorNativeEdit', { model: cycle, actions: colorEditing.actions });
          assert.deepEqual(modelColors(edited), colorEditing.characters, `${name}: controller actions agree with actual native keyboard control after two Rust cycles`);
          const saved = await call('runtimeWrite', edited), file = `rust-color-edit-${name}`;
          fs.writeFileSync(path.join(output, file), Buffer.from(saved, 'base64')); report.files.push(file);
          const independent = inspectColors(path.join(output, file));
          assert.deepEqual(independent.paragraphs.map(paragraph => paragraph.characters), colorEditing.characters, `${name}: independent native-edit output colors`);
          assert.deepEqual(independent.paragraphs.map(paragraph => colorStyle(paragraph.marker)), colorEditing.markers.map(colorStyle), `${name}: native-edit paragraph markers remain independent`);
          assert.deepEqual(modelColors(await call('runtimeRead', saved)), colorEditing.characters, `${name}: native-edit Rust reopen`);
          (report.autoColorEditing ||= []).push({ name, actions: colorEditing.actions, typedColor: colorEditing.typedColor, output: file });
        }
      }
      if (expectedParagraphSpacing) {
        const spacing = style => Object.fromEntries(['spaceBefore', 'spaceAfter', 'lineHeight', 'lineHeightRule'].filter(key => style?.[key] !== undefined).map(key => [key, style[key]]));
        assert.deepEqual(nativeModel.paragraphs.map(paragraph => ({ text: paragraph.runs.map(run => run.text).join(''), ...spacing(paragraph.style) })), expectedParagraphSpacing, `${name}: independent native spacing oracle`);
        if (paragraphSpacingProvenance) assert.deepEqual(nativeModel.paragraphs.map(paragraph => ({ source: spacing(paragraph.sourceParagraph), direct: spacing(paragraph.directStyle) })), paragraphSpacingProvenance, `${name}: independent original source/direct provenance`);
      }
      const changed = await call('edit', nativeModel), nativeOutput = await call('runtimeWrite', changed);
      const expected = await call('browserRead', await call('browserWrite', changed));
      assert.deepEqual(semantic(await call('browserRead', nativeOutput)), semantic(expected), `${name}: browser rereads Rust export`);
      assert.deepEqual(semantic(await call('runtimeRead', nativeOutput)), semantic(expected), `${name}: Rust rereads Rust export`);
      const file = `rust-${name}`; fs.writeFileSync(path.join(output, file), Buffer.from(nativeOutput, 'base64')); report.files.push(file);
      report.corpus.push({ name, sha256, packageAccepted: true, semanticsAccepted: true, paragraphs: model.paragraphs.length, markers: model.paragraphs.filter(paragraph => paragraph.marker).length, markerSemanticsCompared: true, independentSpacingCompared: !!expectedParagraphSpacing, sourceSpacingProvenanceCompared: !!paragraphSpacingProvenance, independentColorAndMarkerCompared: !!colorOracle, automaticColorSaveCycles: colorOracle ? 2 : 0, output: file });
    }
    const accepted = report.corpus.filter(fixture => fixture.semanticsAccepted).length;
    const rejected = report.corpus.filter(fixture => !fixture.semanticsAccepted).length;
    pass(`${accepted} original/native LibreOffice corpus packages agree across Rust/browser reads, edits and writes; ${rejected} unsupported fixtures remain rejected after Rust accepts their containers`);
    assert.equal(report.corpus.filter(fixture => fixture.independentColorAndMarkerCompared).length, 32, 'All 18 original/native color and 14 editing packages must traverse actual Rust');
    assert.equal(report.autoColorEditing.length, 7, 'All seven native color editing controls must retain their semantics after Rust saves');
    pass('32 automatic foreground packages retain semantic tokens, character paint and independent markers through two real Rust save cycles; seven native Enter/insertion controls agree after Rust reopening');
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
    assert.deepEqual(sourceDigests(), report.sourceDigests, 'Product sources changed during the contract run; rerun against stable inputs');
    assert.equal(digest(cli), report.cliSha256, 'Rust CLI changed during the contract run');
    assert.deepEqual(autoColorInputDigests(), report.autoColorInputDigests, 'Automatic color corpus/oracle/test changed during the run');
    delete report.activeFixture;
    report.ok = true; report.finishedAt = new Date().toISOString(); persist(); console.log(`Report: ${path.join(output, 'report.json')}`);
  } catch (error) { report.error = error.stack || String(error); persist(); throw error; }
  finally { await browser?.close(); await server?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
