import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectInstalledOfficePresentation, validateNativeOfficePresentationEvidence, validateOfficePresentationNativeReport, presentationSourceHash } from '../scripts/office-presentation-native-smoke.mjs';
import { presentationReport } from './helpers/office-presentation-smoke-report.mjs';
import { presentationPptx, OFFICE_PRESENTATION_PDF_STALE, OFFICE_PRESENTATION_PDF_MISSING_PAGE } from './helpers/office-presentation-smoke-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function installation() {
  const directory = mkdtempSync(join(tmpdir(), 'office-presentation-native-contract-'));
  const root = join(directory, 'checkout'), resourceRoot = join(directory, 'installed');
  for (const path of ['scripts', 'vendor/office-presentation/src', 'assets/fonts/open-office', 'assets/fonts/deck', 'src/icons/svg/sheet']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/build-office-presentation.mjs'), '// independently controlled fixture');
  writeFileSync(join(root, 'scripts/build-office-icons.mjs'), '// offline geometry compiler fixture');
  writeFileSync(join(root, 'src/icons/shared.json'), '{}');
  writeFileSync(join(root, 'src/icons/svg/sheet/names.json'), '["test"]');
  writeFileSync(join(root, 'src/icons/svg/sheet/test.svg'), '<svg/>');
  writeFileSync(join(root, 'vendor/office-presentation/src/lib.rs'), '// source fixture');
  writeFileSync(join(root, 'assets/fonts/open-office/license.txt'), 'font fixture');
  writeFileSync(join(root, 'assets/fonts/deck/license.txt'), 'deck font fixture');
  const assets = join(resourceRoot, 'frontend/office-presentation'); mkdirSync(assets, { recursive: true });
  const bytes = { 'office-presentation.js': Buffer.from('export const engine = "Open Office";'), 'office-presentation.d.ts': Buffer.from('export const engine: string;'),
    'office-presentation_bg.wasm': Buffer.from('0061736d01000000', 'hex'), 'office-presentation_bg.wasm.d.ts': Buffer.from('export const memory: WebAssembly.Memory;') };
  for (const [name, value] of Object.entries(bytes)) writeFileSync(join(assets, name), value);
  const manifest = { engine: 'Open Office', upstreamCommit: '9859da39255c0262cd592bb57101d7f2fa961f72', sourceHash: presentationSourceHash(root),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)])), sizeBytes: 8,
    target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129' };
  const writeManifest = () => writeFileSync(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); writeManifest();
  return { directory, root, resourceRoot, assets, manifest, writeManifest, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function boundReport(installed) {
  const manifest = JSON.parse(installed.manifestText);
  return { preflight: { presentation: installed }, frontend: { presentation: { resources: {
    wasmLoaded: true, sameOrigin: true, wasmPath: '/office-presentation/office-presentation_bg.wasm', manifestSha256: installed.manifestSha256,
    sourceHash: manifest.sourceHash, upstreamCommit: manifest.upstreamCommit,
    files: Object.fromEntries(['office-presentation.js', 'office-presentation_bg.wasm'].map(name => [name, structuredClone(installed.files[name])])),
  } } } };
}

test('installed assets bind exact manifest bytes, WASM/JS sizes and hashes to the WebView and checkout', () => {
  const fixture = installation();
  try {
    const installed = inspectInstalledOfficePresentation(fixture.resourceRoot, { root: fixture.root });
    assert.equal(installed.files['office-presentation_bg.wasm'].bytes, 8);
    const report = boundReport(installed);
    assert.deepEqual(validateNativeOfficePresentationEvidence(report, { root: fixture.root }), {
      presentationInstalledAssets: true, presentationRuntimeAssetDigests: true, presentationCheckoutSource: true,
    });
    for (const mutate of [
      item => { delete item.preflight.presentation; }, item => { delete item.frontend.presentation; },
      item => { item.preflight.presentation.verified = false; }, item => { item.preflight.presentation.manifestText += ' '; },
      item => { item.preflight.presentation.files['office-presentation.js'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.presentation.resources.manifestSha256 = 'e'.repeat(64); },
      item => { item.frontend.presentation.resources.files['office-presentation_bg.wasm'].sha256 = 'e'.repeat(64); },
      item => { item.frontend.presentation.resources.files['office-presentation.js'].bytes++; },
      item => { item.frontend.presentation.resources.sourceHash = 'e'.repeat(64); },
    ]) {
      const mutated = structuredClone(report); mutate(mutated);
      assert.throws(() => validateNativeOfficePresentationEvidence(mutated, { root: fixture.root }), /OfficePresentation/);
    }
    for (const path of ['assets/fonts/open-office/license.txt', 'assets/fonts/deck/license.txt', 'scripts/build-office-icons.mjs', 'src/icons/shared.json', 'src/icons/svg/sheet/test.svg', 'src/icons/svg/sheet/names.json']) {
      const source = readFileSync(join(fixture.root, path));
      writeFileSync(join(fixture.root, path), Buffer.concat([source, Buffer.from(' ')]));
      assert.throws(() => validateNativeOfficePresentationEvidence(report, { root: fixture.root }), /current checkout source/);
      writeFileSync(join(fixture.root, path), source);
    }
    writeFileSync(join(fixture.root, 'vendor/office-presentation/src/lib.rs'), '// modified after build');
    assert.throws(() => validateNativeOfficePresentationEvidence(report, { root: fixture.root }), /current checkout source/);
  } finally { fixture.cleanup(); }
});

test('installed preflight rejects missing, modified, stale or malformed assets without source fallback', () => {
  const mutations = [
    item => rmSync(join(item.assets, 'office-presentation.js')),
    item => writeFileSync(join(item.assets, 'office-presentation_bg.wasm'), Buffer.from('modified')),
    item => { item.manifest.sizeBytes++; item.writeManifest(); },
    item => { item.manifest.sourceHash = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.files['../escape'] = 'f'.repeat(64); item.writeManifest(); },
    item => { item.manifest.upstreamCommit = '0'.repeat(40); item.writeManifest(); },
    item => { item.manifest.wasmBindgenVersion = '0.0.0'; item.writeManifest(); },
    item => writeFileSync(join(item.assets, 'manifest.json'), '{invalid'),
    item => { const bytes = Buffer.from('not wasm'); writeFileSync(join(item.assets, 'office-presentation_bg.wasm'), bytes); item.manifest.files['office-presentation_bg.wasm'] = sha(bytes); item.writeManifest(); },
  ];
  for (const mutate of mutations) {
    const fixture = installation();
    try { mutate(fixture); assert.throws(() => inspectInstalledOfficePresentation(fixture.resourceRoot, { root: fixture.root })); }
    finally { fixture.cleanup(); }
  }
});

test('an installed symlink cannot redirect WASM to outside the application resources', { skip: process.platform === 'win32' }, () => {
  const fixture = installation();
  try {
    const path = join(fixture.assets, 'office-presentation_bg.wasm'), outside = join(fixture.directory, 'outside.wasm');
    writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
    assert.throws(() => inspectInstalledOfficePresentation(fixture.resourceRoot, { root: fixture.root }), /escapes/);
  } finally { fixture.cleanup(); }
});


test('Deck canvas evidence independently verifies both PPTX exports and its PDF page text', () => {
  const evidence = validateOfficePresentationNativeReport(presentationReport());
  assert.equal(evidence.exported.slides[0].text, 'Open Office 演示😀');
  assert.equal(evidence.reopened.slides[1].text, 'Second slide 第二页');
  assert.equal(evidence.pdf.pages.length, 2);
  assert.match(evidence.pdf.pages[0].text, /演示/);
});

test('Deck native evidence cannot substitute flags, browser execution, stale slides or missing PDF', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateOfficePresentationNativeReport(value), /OfficePresentation/);
  for (const mutate of [
    report => { report.transport = 'local-wasm-in-browser'; }, report => { report.engine = 'impress'; },
    report => { report.kind = 'presentation-workbench'; }, report => { report.ok = false; },
    report => { report.checks.pop(); }, report => { report.checks.reverse(); }, report => { report.limitations = []; },
    report => { report.cleanup.closed = 1; }, report => { report.cleanup.remainingCanvas = 1; }, report => { report.cleanup.remainingInput = 1; },
    report => { report.canvas.paintCalls = 0; }, report => { report.canvas.width = 1; }, report => { report.canvas.slideCount = '2'; },
    report => { report.domInput.isTrusted = true; }, report => { report.domInput.eventType = 'command'; },
    report => { report.slides.count = 1; }, report => { report.slides.activeIndex = 1; },
    report => { report.format.bold = false; }, report => { report.failures.preserved = false; },
    report => { report.secondSlideText = report.text; }, report => { report.error = 'engine failure'; },
    report => { report.resources.sameOrigin = false; }, report => { report.resources.wasmPath = 'https://other.test/editor.wasm'; },
    report => { report.pdf.pageCount = 1; }, report => { report.pdf.textVerified = false; },
    report => { report.pdfBase64 = Buffer.from('%PDF-' + 'not a PDF'.repeat(100)).toString('base64'); },
    report => { report.pdfBase64 = ''; },
  ]) {
    const report = presentationReport(); mutate(report);
    assert.throws(() => validateOfficePresentationNativeReport(report), /OfficePresentation/);
  }
});

test('Deck exported and reopened PPTX require actual editable text, formatting and safe OPC relationships', () => {
  const corruptions = [
    parts => { parts['ppt/slides/slide1.xml'] = parts['ppt/slides/slide1.xml'].replace('Open Office', 'Stale contents'); },
    parts => { parts['ppt/slides/slide1.xml'] = parts['ppt/slides/slide1.xml'].replace('😀', ''); },
    parts => { parts['ppt/slides/slide1.xml'] = parts['ppt/slides/slide1.xml'].replace('b="1"', 'b="0"'); },
    parts => { parts['ppt/slides/slide2.xml'] = parts['ppt/slides/slide2.xml'].replace('Second slide', 'First slide'); },
    parts => { parts['ppt/presentation.xml'] = parts['ppt/presentation.xml'].replace('r:id="slide1"', 'r:id="slide2"'); },
    parts => { parts['ppt/_rels/presentation.xml.rels'] = parts['ppt/_rels/presentation.xml.rels'].replace('Target="slides/slide1.xml"', 'Target="https://outside.invalid/slide.xml" TargetMode="External"'); },
    parts => { parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('presentation.main+xml', 'template.main+xml'); },
    parts => { parts['ppt/slides/slide1.xml'] = '<!DOCTYPE test [<!ENTITY payload "x">]>' + parts['ppt/slides/slide1.xml']; },
    parts => { parts['ppt/vbaProject.bin'] = 'unexpected macros'; },
    parts => { parts['../unsafe.xml'] = '<unsafe/>'; },
    parts => { delete parts['ppt/slides/slide2.xml']; },
  ].map(mutate => presentationPptx(mutate));
  for (const key of ['pptxBase64', 'reopenedPptxBase64']) {
    for (const invalid of [undefined, '', '%%%invalid', 'A'.repeat(1024 * 1024), ...corruptions]) {
      const report = presentationReport(); report[key] = invalid;
      assert.throws(() => validateOfficePresentationNativeReport(report), /OfficePresentation/);
    }
  }
});

test('the presentation oracle preserves Unicode on Windows redirected stdout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'office-presentation-legacy-encoding-'));
  try {
    const path = join(directory, 'export.pptx'); writeFileSync(path, Buffer.from(presentationPptx(), 'base64'));
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const oracle = fileURLToPath(new URL('../scripts/office-presentation-inspect-presentation.py', import.meta.url));
    const evidence = JSON.parse(execFileSync(python, [oracle, path], { encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, PYTHONIOENCODING: 'cp1252:strict', PYTHONUTF8: '0' } }));
    assert.equal(evidence.slides[0].text, 'Open Office 演示😀');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('valid PDF containers with stale text or missing pages cannot satisfy presentation evidence', () => {
  for (const pdfBase64 of [OFFICE_PRESENTATION_PDF_STALE, OFFICE_PRESENTATION_PDF_MISSING_PAGE]) {
    const report = presentationReport(); report.pdfBase64 = pdfBase64;
    assert.throws(() => validateOfficePresentationNativeReport(report), /OfficePresentation PDF/);
  }
});
