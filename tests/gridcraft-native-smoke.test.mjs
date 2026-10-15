import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstalledGridcraft, validateNativeGridcraftEvidence, validateGridcraftNativeReport, gridcraftSourceHash } from '../scripts/gridcraft-native-smoke.mjs';
import { gridcraftReport } from './helpers/gridcraft-smoke-report.mjs';
import { gridcraftXlsx } from './helpers/gridcraft-smoke-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function installation() {
  const directory = mkdtempSync(join(tmpdir(), 'gridcraft-native-contract-'));
  const root = join(directory, 'checkout'), resourceRoot = join(directory, 'installed');
  for (const path of ['scripts', 'vendor/gridcraft/src', 'crates/word-engine/fonts', 'src/icons/svg/sheet']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/build-gridcraft.mjs'), '// independently controlled fixture');
  writeFileSync(join(root, 'scripts/build-office-icons.mjs'), '// offline geometry compiler fixture');
  writeFileSync(join(root, 'src/icons/shared.json'), '{}');
  writeFileSync(join(root, 'src/icons/svg/sheet/names.json'), '["test"]');
  writeFileSync(join(root, 'src/icons/svg/sheet/test.svg'), '<svg/>');
  writeFileSync(join(root, 'vendor/gridcraft/src/lib.rs'), '// source fixture');
  writeFileSync(join(root, 'crates/word-engine/fonts/license.txt'), 'font fixture');
  const assets = join(resourceRoot, 'frontend/gridcraft'); mkdirSync(assets, { recursive: true });
  const bytes = { 'gridcraft.js': Buffer.from('export const engine = "GridCraft";'), 'gridcraft.d.ts': Buffer.from('export const engine: string;'),
    'gridcraft_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'gridcraft_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;') };
  for (const [name, value] of Object.entries(bytes)) writeFileSync(join(assets, name), value);
  const manifest = { engine: 'GridCraft', upstreamCommit: 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb', sourceHash: gridcraftSourceHash(root),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)])), sizeBytes: 8,
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' };
  const writeManifest = () => writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); writeManifest();
  return { directory, root, resourceRoot, assets, manifest, writeManifest, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function boundReport(installed) {
  const manifest = JSON.parse(installed.manifestText);
  return { preflight: { gridcraft: installed }, frontend: { gridcraft: { resources: {
    wasmLoaded: true, sameOrigin: true, wasmPath: '/gridcraft/gridcraft_bg.wasm', manifestSha256: installed.manifestSha256,
    sourceHash: manifest.sourceHash, upstreamCommit: manifest.upstreamCommit,
    files: Object.fromEntries(['gridcraft.js', 'gridcraft_bg.wasm'].map(name => [name, structuredClone(installed.files[name])])),
  } } } };
}

test('GridCraft default-canvas report independently checks both exported XLSX files', () => {
  const result = validateGridcraftNativeReport(gridcraftReport());
  assert.equal(result.exported.sheets[0].cells.A1.value, 'Open Office 表格😀');
  assert.deepEqual(result.exported.sheets[0].cells, result.reopened.sheets[0].cells);
});

test('the XLSX inspector preserves Unicode through a Windows legacy stdout encoding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gridcraft-legacy-encoding-'));
  const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const oracle = fileURLToPath(new URL('./browser/gridcraft-inspect-xlsx.py', import.meta.url));
  const inspect = args => JSON.parse(execFileSync(python, [oracle, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, PYTHONIOENCODING: 'cp1252:strict', PYTHONUTF8: '0' },
  }));
  try {
    const exported = join(directory, 'export.xlsx');
    writeFileSync(exported, Buffer.from(gridcraftXlsx(), 'base64'));
    const evidence = inspect([exported]);
    assert.equal(evidence.sheets[0].cells.A1.value, 'Open Office 表格😀');
    assert.equal(evidence.sheets[0].cells.C1.value, 42);
    const fixture = join(directory, 'fixture.xlsx');
    const created = inspect(['--fixture', fixture]);
    assert.deepEqual(created.sheets.map(sheet => sheet.name), ['销售', '预算']);
    assert.deepEqual(inspect([fixture]), created);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GridCraft canvas evidence cannot be replaced with old IPC or success flags', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateGridcraftNativeReport(value), /GridCraft/);
  for (const mutate of [
    report => { report.engine = 'rust-word'; }, report => { report.transport = 'tauri-word-engine-request'; },
    report => { report.transport = 'local-wasm-in-browser'; },
    report => { report.kind = 'core'; }, report => { report.schemaVersion = 0; }, report => { report.ok = false; },
    report => { report.checks.pop(); }, report => { report.checks.reverse(); }, report => { report.limitations = []; },
    report => { report.cleanup.closed = 1; }, report => { report.cleanup.remainingCanvas = 1; }, report => { report.cleanup.remainingInput = 1; },
    report => { report.canvas.paintCalls = 0; }, report => { report.canvas.width = 1; }, report => { report.canvas.sheetCount = '1'; },
    report => { report.domInput.isTrusted = true; }, report => { report.domInput.eventType = 'command'; },
    report => { report.formula.value = 43; }, report => { report.format.bold = false; }, report => { report.failures.preserved = false; },
    report => { report.reopenedText += 'duplicated'; }, report => { report.error = 'engine failure'; },
    report => { report.resources.sameOrigin = false; }, report => { report.resources.wasmPath = 'https://other.test/editor.wasm'; },
    report => { delete report.resources.files; }, report => { report.resources.files['gridcraft.js'].sha256 = ''; },
    report => { report.resources.files['gridcraft_bg.wasm'].bytes = Infinity; },
  ]) {
    const report = gridcraftReport(); mutate(report);
    assert.throws(() => validateGridcraftNativeReport(report), /GridCraft/);
  }
});

test('GridCraft native export and reopened bytes each must pass XML rather than declared format/text', () => {
  const corruptions = [
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('Open Office', 'Different engine'); },
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('SUM(B1:B2)', 'SUM(B1:B1)'); },
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<v>42</v>', '<v>43</v>'); },
    parts => { parts['xl/styles.xml'] = parts['xl/styles.xml'].replace('<b/>', '<b val="0"/>'); },
    parts => { parts['xl/_rels/workbook.xml.rels'] = parts['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"', 'Target="https://outside.invalid/sheet.xml" TargetMode="External"'); },
  ].map(mutate => gridcraftXlsx(mutate));
  for (const key of ['xlsxBase64', 'reopenedXlsxBase64']) {
    for (const invalid of [undefined, '', '%%%invalid', 'A'.repeat(1024 * 1024), ...corruptions]) {
      const report = gridcraftReport(); report[key] = invalid;
      assert.throws(() => validateGridcraftNativeReport(report), /GridCraft/);
    }
  }
});

test('installed assets bind exact manifest bytes, WASM/JS sizes and hashes to the WebView and checkout', () => {
  const fixture = installation();
  try {
    const installed = inspectInstalledGridcraft(fixture.resourceRoot, { root: fixture.root });
    assert.equal(installed.files['gridcraft_bg.wasm'].bytes, 8);
    const report = boundReport(installed);
    assert.deepEqual(validateNativeGridcraftEvidence(report, { root: fixture.root }), {
      gridcraftInstalledAssets: true, gridcraftRuntimeAssetDigests: true, gridcraftCheckoutSource: true,
    });
    for (const mutate of [
      item => { delete item.preflight.gridcraft; }, item => { delete item.frontend.gridcraft; },
      item => { item.preflight.gridcraft.verified = false; }, item => { item.preflight.gridcraft.manifestText += ' '; },
      item => { item.preflight.gridcraft.files['gridcraft.js'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.gridcraft.resources.manifestSha256 = 'e'.repeat(64); },
      item => { item.frontend.gridcraft.resources.files['gridcraft_bg.wasm'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.gridcraft.resources.files['gridcraft.js'].bytes++; },
      item => { item.frontend.gridcraft.resources.sourceHash = 'e'.repeat(64); },
    ]) {
      const mutated = structuredClone(report); mutate(mutated);
      assert.throws(() => validateNativeGridcraftEvidence(mutated, { root: fixture.root }), /GridCraft/);
    }
    for (const path of ['scripts/build-office-icons.mjs', 'src/icons/shared.json', 'src/icons/svg/sheet/test.svg', 'src/icons/svg/sheet/names.json']) {
      const source = readFileSync(join(fixture.root, path));
      writeFileSync(join(fixture.root, path), Buffer.concat([source, Buffer.from(' ')]));
      assert.throws(() => validateNativeGridcraftEvidence(report, { root: fixture.root }), /current checkout source/);
      writeFileSync(join(fixture.root, path), source);
    }
    writeFileSync(join(fixture.root, 'vendor/gridcraft/src/lib.rs'), '// modified after build');
    assert.throws(() => validateNativeGridcraftEvidence(report, { root: fixture.root }), /current checkout source/);
  } finally { fixture.cleanup(); }
});

test('installed preflight rejects missing, modified, stale or malformed assets without source fallback', () => {
  const mutations = [
    item => rmSync(join(item.assets, 'gridcraft.js')),
    item => writeFileSync(join(item.assets, 'gridcraft_bg.wasm'), Buffer.from('modified')),
    item => { item.manifest.sizeBytes++; item.writeManifest(); },
    item => { item.manifest.sourceHash = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.files['../escape'] = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.upstreamCommit = '0'.repeat(40); item.writeManifest(); },
    item => { item.manifest.wasmBindgenVersion = '0.0.0'; item.writeManifest(); },
    item => writeFileSync(join(item.assets, 'manifest.json'), '{invalid'),
    item => { const bytes = Buffer.from('not wasm'); writeFileSync(join(item.assets, 'gridcraft_bg.wasm'), bytes); item.manifest.files['gridcraft_bg.wasm'] = sha(bytes); item.writeManifest(); },
  ];
  for (const mutate of mutations) {
    const fixture = installation();
    try { mutate(fixture); assert.throws(() => inspectInstalledGridcraft(fixture.resourceRoot, { root: fixture.root })); }
    finally { fixture.cleanup(); }
  }
});

test('an installed symlink cannot redirect WASM to outside the application resources', { skip: process.platform === 'win32' }, () => {
  const fixture = installation();
  try {
    const path = join(fixture.assets, 'gridcraft_bg.wasm'), outside = join(fixture.directory, 'outside.wasm');
    writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    assert.throws(() => inspectInstalledGridcraft(fixture.resourceRoot, { root: fixture.root }), /escapes/);
  } finally { fixture.cleanup(); }
});
