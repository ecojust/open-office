import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstalledOfficeSheet, validateNativeOfficeSheetEvidence, validateOfficeSheetNativeReport, sheetSourceHash } from '../scripts/office-sheet-native-smoke.mjs';
import { sheetReport } from './helpers/office-sheet-smoke-report.mjs';
import { sheetXlsx } from './helpers/office-sheet-smoke-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function installation() {
  const directory = mkdtempSync(join(tmpdir(), 'office-sheet-native-contract-'));
  const root = join(directory, 'checkout'), resourceRoot = join(directory, 'installed');
  for (const path of ['scripts', 'src/shared', 'assets/fonts/ui', 'assets/fonts/deck', 'vendor/office-sheet/src', 'assets/fonts/open-office', 'src/icons/svg/sheet']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/build-office-sheet.mjs'), '// independently controlled fixture');
  writeFileSync(join(root, 'scripts/build-office-icons.mjs'), '// offline geometry compiler fixture');
  writeFileSync(join(root, 'src/icons/shared.json'), '{}');
  writeFileSync(join(root, 'src/icons/svg/sheet/names.json'), '["test"]');
  writeFileSync(join(root, 'src/icons/svg/sheet/test.svg'), '<svg/>');
  writeFileSync(join(root, 'vendor/office-sheet/src/lib.rs'), '// source fixture');
  writeFileSync(join(root, 'assets/fonts/open-office/license.txt'), 'font fixture');
  writeFileSync(join(root, 'assets/fonts/ui/license.txt'), 'interface font fixture');
  writeFileSync(join(root, 'assets/fonts/deck/license.txt'), 'shared Latin font fixture');
  writeFileSync(join(root, 'src/shared/office-ui-fonts.rs'), '// shared interface typography');
  const assets = join(resourceRoot, 'frontend/office-sheet'); mkdirSync(assets, { recursive: true });
  const bytes = { 'office-sheet.js': Buffer.from('export const engine = "Open Office";'), 'office-sheet.d.ts': Buffer.from('export const engine: string;'),
    'office-sheet_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'office-sheet_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;') };
  for (const [name, value] of Object.entries(bytes)) writeFileSync(join(assets, name), value);
  const manifest = { engine: 'Open Office', upstreamCommit: 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb', sourceHash: sheetSourceHash(root),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)])), sizeBytes: 8,
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' };
  const writeManifest = () => writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); writeManifest();
  return { directory, root, resourceRoot, assets, manifest, writeManifest, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function boundReport(installed) {
  const manifest = JSON.parse(installed.manifestText);
  return { preflight: { sheet: installed }, frontend: { sheet: { resources: {
    wasmLoaded: true, sameOrigin: true, wasmPath: '/office-sheet/office-sheet_bg.wasm', manifestSha256: installed.manifestSha256,
    sourceHash: manifest.sourceHash, upstreamCommit: manifest.upstreamCommit,
    files: Object.fromEntries(['office-sheet.js', 'office-sheet_bg.wasm'].map(name => [name, structuredClone(installed.files[name])])),
  } } } };
}

test('OfficeSheet default-canvas report independently checks both exported XLSX files', () => {
  const result = validateOfficeSheetNativeReport(sheetReport());
  assert.equal(result.exported.sheets[0].cells.A1.value, 'Open Office 表格😀');
  assert.deepEqual(result.exported.sheets[0].cells, result.reopened.sheets[0].cells);
});

test('the XLSX inspector preserves Unicode through a Windows legacy stdout encoding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'office-sheet-legacy-encoding-'));
  const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const oracle = fileURLToPath(new URL('./browser/office-sheet-inspect-xlsx.py', import.meta.url));
  const inspect = args => JSON.parse(execFileSync(python, [oracle, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, PYTHONIOENCODING: 'cp1252:strict', PYTHONUTF8: '0' },
  }));
  try {
    const exported = join(directory, 'export.xlsx');
    writeFileSync(exported, Buffer.from(sheetXlsx(), 'base64'));
    const evidence = inspect([exported]);
    assert.equal(evidence.sheets[0].cells.A1.value, 'Open Office 表格😀');
    assert.equal(evidence.sheets[0].cells.C1.value, 42);
    const fixture = join(directory, 'fixture.xlsx');
    const created = inspect(['--fixture', fixture]);
    assert.deepEqual(created.sheets.map(sheet => sheet.name), ['销售', '预算']);
    assert.deepEqual(inspect([fixture]), created);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OfficeSheet canvas evidence cannot be replaced with old IPC or success flags', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateOfficeSheetNativeReport(value), /OfficeSheet/);
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
    report => { delete report.resources.files; }, report => { report.resources.files['office-sheet.js'].sha256 = ''; },
    report => { report.resources.files['office-sheet_bg.wasm'].bytes = Infinity; },
  ]) {
    const report = sheetReport(); mutate(report);
    assert.throws(() => validateOfficeSheetNativeReport(report), /OfficeSheet/);
  }
});

test('OfficeSheet native export and reopened bytes each must pass XML rather than declared format/text', () => {
  const corruptions = [
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('Open Office', 'Different engine'); },
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('SUM(B1:B2)', 'SUM(B1:B1)'); },
    parts => { parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<v>42</v>', '<v>43</v>'); },
    parts => { parts['xl/styles.xml'] = parts['xl/styles.xml'].replace('<b/>', '<b val="0"/>'); },
    parts => { parts['xl/_rels/workbook.xml.rels'] = parts['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"', 'Target="https://outside.invalid/sheet.xml" TargetMode="External"'); },
  ].map(mutate => sheetXlsx(mutate));
  for (const key of ['xlsxBase64', 'reopenedXlsxBase64']) {
    for (const invalid of [undefined, '', '%%%invalid', 'A'.repeat(1024 * 1024), ...corruptions]) {
      const report = sheetReport(); report[key] = invalid;
      assert.throws(() => validateOfficeSheetNativeReport(report), /OfficeSheet/);
    }
  }
});

test('installed assets bind exact manifest bytes, WASM/JS sizes and hashes to the WebView and checkout', () => {
  const fixture = installation();
  try {
    const installed = inspectInstalledOfficeSheet(fixture.resourceRoot, { root: fixture.root });
    assert.equal(installed.files['office-sheet_bg.wasm'].bytes, 8);
    const report = boundReport(installed);
    assert.deepEqual(validateNativeOfficeSheetEvidence(report, { root: fixture.root }), {
      sheetInstalledAssets: true, sheetRuntimeAssetDigests: true, sheetCheckoutSource: true,
    });
    for (const mutate of [
      item => { delete item.preflight.sheet; }, item => { delete item.frontend.sheet; },
      item => { item.preflight.sheet.verified = false; }, item => { item.preflight.sheet.manifestText += ' '; },
      item => { item.preflight.sheet.files['office-sheet.js'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.sheet.resources.manifestSha256 = 'e'.repeat(64); },
      item => { item.frontend.sheet.resources.files['office-sheet_bg.wasm'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.sheet.resources.files['office-sheet.js'].bytes++; },
      item => { item.frontend.sheet.resources.sourceHash = 'e'.repeat(64); },
    ]) {
      const mutated = structuredClone(report); mutate(mutated);
      assert.throws(() => validateNativeOfficeSheetEvidence(mutated, { root: fixture.root }), /OfficeSheet/);
    }
    for (const path of ['src/shared/office-ui-fonts.rs', 'assets/fonts/ui/license.txt', 'scripts/build-office-icons.mjs', 'src/icons/shared.json', 'src/icons/svg/sheet/test.svg', 'src/icons/svg/sheet/names.json']) {
      const source = readFileSync(join(fixture.root, path));
      writeFileSync(join(fixture.root, path), Buffer.concat([source, Buffer.from(' ')]));
      assert.throws(() => validateNativeOfficeSheetEvidence(report, { root: fixture.root }), /current checkout source/);
      writeFileSync(join(fixture.root, path), source);
    }
    writeFileSync(join(fixture.root, 'vendor/office-sheet/src/lib.rs'), '// modified after build');
    assert.throws(() => validateNativeOfficeSheetEvidence(report, { root: fixture.root }), /current checkout source/);
  } finally { fixture.cleanup(); }
});

test('installed preflight rejects missing, modified, stale or malformed assets without source fallback', () => {
  const mutations = [
    item => rmSync(join(item.assets, 'office-sheet.js')),
    item => writeFileSync(join(item.assets, 'office-sheet_bg.wasm'), Buffer.from('modified')),
    item => { item.manifest.sizeBytes++; item.writeManifest(); },
    item => { item.manifest.sourceHash = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.files['../escape'] = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.upstreamCommit = '0'.repeat(40); item.writeManifest(); },
    item => { item.manifest.wasmBindgenVersion = '0.0.0'; item.writeManifest(); },
    item => writeFileSync(join(item.assets, 'manifest.json'), '{invalid'),
    item => { const bytes = Buffer.from('not wasm'); writeFileSync(join(item.assets, 'office-sheet_bg.wasm'), bytes); item.manifest.files['office-sheet_bg.wasm'] = sha(bytes); item.writeManifest(); },
  ];
  for (const mutate of mutations) {
    const fixture = installation();
    try { mutate(fixture); assert.throws(() => inspectInstalledOfficeSheet(fixture.resourceRoot, { root: fixture.root })); }
    finally { fixture.cleanup(); }
  }
});

test('an installed symlink cannot redirect WASM to outside the application resources', { skip: process.platform === 'win32' }, () => {
  const fixture = installation();
  try {
    const path = join(fixture.assets, 'office-sheet_bg.wasm'), outside = join(fixture.directory, 'outside.wasm');
    writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    assert.throws(() => inspectInstalledOfficeSheet(fixture.resourceRoot, { root: fixture.root }), /escapes/);
  } finally { fixture.cleanup(); }
});
