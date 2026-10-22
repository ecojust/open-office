import { installWasmCompatSources } from './helpers/wasm-compat-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectInstalledOfficeWord, validateNativeOfficeWordEvidence, validateOfficeWordNativeReport, wordSourceHash } from '../scripts/office-word-native-smoke.mjs';
import { wordReport } from './helpers/office-word-smoke-report.mjs';
import { wordDocx } from './helpers/office-word-smoke-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function installation() {
  const directory = mkdtempSync(join(tmpdir(), 'office-word-native-contract-'));
  const root = join(directory, 'checkout'), resourceRoot = join(directory, 'installed');
  for (const path of ['scripts', 'src/shared', 'assets/fonts/ui', 'assets/fonts/deck', 'vendor/office-word/src', 'assets/fonts/open-office', 'src/icons/svg/word']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/build-office-word.mjs'), '// independently controlled fixture');
  writeFileSync(join(root, 'scripts/build-office-icons.mjs'), '// offline geometry compiler fixture');
  writeFileSync(join(root, 'src/icons/shared.json'), '{}');
  writeFileSync(join(root, 'src/icons/svg/word/names.json'), '["test"]');
  writeFileSync(join(root, 'src/icons/svg/word/test.svg'), '<svg/>');
  writeFileSync(join(root, 'vendor/office-word/src/lib.rs'), '// source fixture');
  writeFileSync(join(root, 'assets/fonts/open-office/license.txt'), 'font fixture');
  writeFileSync(join(root, 'assets/fonts/ui/license.txt'), 'interface font fixture');
  writeFileSync(join(root, 'assets/fonts/deck/license.txt'), 'shared Latin font fixture');
  writeFileSync(join(root, 'src/shared/office-ui-fonts.rs'), '// shared interface typography');
  installWasmCompatSources(root);
  const assets = join(resourceRoot, 'frontend/office-word'); mkdirSync(assets, { recursive: true });
  const bytes = { 'office-word.js': Buffer.from('export const engine = "Open Office";'), 'office-word.d.ts': Buffer.from('export const engine: string;'),
    'office-word_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'office-word_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;') };
  for (const [name, value] of Object.entries(bytes)) writeFileSync(join(assets, name), value);
  const manifest = { engine: 'Open Office', upstreamCommit: '3292ba05d3c15c003823be6849e87a1c6e205242', sourceHash: wordSourceHash(root),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)])), sizeBytes: 8,
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' };
  const writeManifest = () => writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); writeManifest();
  return { directory, root, resourceRoot, assets, manifest, writeManifest, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function boundReport(installed) {
  const manifest = JSON.parse(installed.manifestText);
  return { preflight: { word: installed }, frontend: { word: { resources: {
    wasmLoaded: true, sameOrigin: true, wasmPath: '/office-word/office-word_bg.wasm', manifestSha256: installed.manifestSha256,
    sourceHash: manifest.sourceHash, upstreamCommit: manifest.upstreamCommit,
    files: Object.fromEntries(['office-word.js', 'office-word_bg.wasm'].map(name => [name, structuredClone(installed.files[name])])),
  } } } };
}

test('OfficeWord default-canvas report independently checks both exported DOCX files', () => {
  const result = validateOfficeWordNativeReport(wordReport());
  assert.equal(result.exported.text, 'OfficeWord Native 中文😀');
  assert.deepEqual(result.exported.format, result.reopened.format);
});

test('OfficeWord canvas evidence cannot be replaced with old IPC or success flags', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateOfficeWordNativeReport(value), /OfficeWord/);
  for (const mutate of [
    report => { report.engine = 'rust-word'; }, report => { report.transport = 'tauri-word-engine-request'; },
    report => { report.transport = 'local-wasm-in-browser'; },
    report => { report.kind = 'core'; }, report => { report.schemaVersion = 0; }, report => { report.ok = false; },
    report => { report.checks.pop(); }, report => { report.checks.reverse(); }, report => { report.limitations = []; },
    report => { report.cleanup.closed = 1; }, report => { report.cleanup.remainingCanvas = 1; }, report => { report.cleanup.remainingInput = 1; },
    report => { report.canvas.paintCalls = 0; }, report => { report.canvas.width = 1; }, report => { report.canvas.pageCount = '1'; },
    report => { report.domInput.isTrusted = true; }, report => { report.domInput.eventType = 'command'; },
    report => { report.format.bold = false; }, report => { report.failures.preserved = false; },
    report => { report.reopenedText += 'duplicated'; }, report => { report.error = 'engine failure'; },
    report => { report.resources.sameOrigin = false; }, report => { report.resources.wasmPath = 'https://other.test/editor.wasm'; },
    report => { delete report.resources.files; }, report => { report.resources.files['office-word.js'].sha256 = ''; },
    report => { report.resources.files['office-word_bg.wasm'].bytes = Infinity; },
  ]) {
    const report = wordReport(); mutate(report);
    assert.throws(() => validateOfficeWordNativeReport(report), /OfficeWord/);
  }
});

test('OfficeWord native export and reopened bytes each must pass XML rather than declared format/text', () => {
  const wrongText = wordDocx(parts => { parts['word/document.xml'] = parts['word/document.xml'].replace('OfficeWord Native', 'Different engine'); });
  for (const key of ['docxBase64', 'reopenedDocxBase64']) {
    for (const invalid of [undefined, '', '%%%invalid', 'A'.repeat(1024 * 1024), wrongText]) {
      const report = wordReport(); report[key] = invalid;
      assert.throws(() => validateOfficeWordNativeReport(report), /OfficeWord/);
    }
  }
});

test('installed assets bind exact manifest bytes, WASM/JS sizes and hashes to the WebView and checkout', () => {
  const fixture = installation();
  try {
    const installed = inspectInstalledOfficeWord(fixture.resourceRoot, { root: fixture.root });
    assert.equal(installed.files['office-word_bg.wasm'].bytes, 8);
    const report = boundReport(installed);
    assert.deepEqual(validateNativeOfficeWordEvidence(report, { root: fixture.root }), {
      wordInstalledAssets: true, wordRuntimeAssetDigests: true, wordCheckoutSource: true,
    });
    for (const mutate of [
      item => { delete item.preflight.word; }, item => { delete item.frontend.word; },
      item => { item.preflight.word.verified = false; }, item => { item.preflight.word.manifestText += ' '; },
      item => { item.preflight.word.files['office-word.js'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.word.resources.manifestSha256 = 'e'.repeat(64); },
      item => { item.frontend.word.resources.files['office-word_bg.wasm'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.word.resources.files['office-word.js'].bytes++; },
      item => { item.frontend.word.resources.sourceHash = 'e'.repeat(64); },
    ]) {
      const mutated = structuredClone(report); mutate(mutated);
      assert.throws(() => validateNativeOfficeWordEvidence(mutated, { root: fixture.root }), /OfficeWord/);
    }
    for (const path of ['src/shared/office-ui-fonts.rs', 'assets/fonts/ui/license.txt', 'scripts/build-office-icons.mjs', 'src/icons/shared.json', 'src/icons/svg/word/test.svg', 'src/icons/svg/word/names.json']) {
      const source = readFileSync(join(fixture.root, path));
      writeFileSync(join(fixture.root, path), Buffer.concat([source, Buffer.from(' ')]));
      assert.throws(() => validateNativeOfficeWordEvidence(report, { root: fixture.root }), /current checkout source/);
      writeFileSync(join(fixture.root, path), source);
    }
    writeFileSync(join(fixture.root, 'vendor/office-word/src/lib.rs'), '// modified after build');
    assert.throws(() => validateNativeOfficeWordEvidence(report, { root: fixture.root }), /current checkout source/);
  } finally { fixture.cleanup(); }
});

test('installed preflight rejects missing, modified, stale or malformed assets without source fallback', () => {
  const mutations = [
    item => rmSync(join(item.assets, 'office-word.js')),
    item => writeFileSync(join(item.assets, 'office-word_bg.wasm'), Buffer.from('modified')),
    item => { item.manifest.sizeBytes++; item.writeManifest(); },
    item => { item.manifest.sourceHash = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.files['../escape'] = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.upstreamCommit = '0'.repeat(40); item.writeManifest(); },
    item => { item.manifest.wasmBindgenVersion = '0.0.0'; item.writeManifest(); },
    item => writeFileSync(join(item.assets, 'manifest.json'), '{invalid'),
    item => { const bytes = Buffer.from('not wasm'); writeFileSync(join(item.assets, 'office-word_bg.wasm'), bytes); item.manifest.files['office-word_bg.wasm'] = sha(bytes); item.writeManifest(); },
  ];
  for (const mutate of mutations) {
    const fixture = installation();
    try { mutate(fixture); assert.throws(() => inspectInstalledOfficeWord(fixture.resourceRoot, { root: fixture.root })); }
    finally { fixture.cleanup(); }
  }
});

test('an installed symlink cannot redirect WASM to outside the application resources', { skip: process.platform === 'win32' }, () => {
  const fixture = installation();
  try {
    const path = join(fixture.assets, 'office-word_bg.wasm'), outside = join(fixture.directory, 'outside.wasm');
    writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    assert.throws(() => inspectInstalledOfficeWord(fixture.resourceRoot, { root: fixture.root }), /escapes/);
  } finally { fixture.cleanup(); }
});
