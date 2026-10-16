import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectInstalledPdf, inspectOfficePdfExports, validateInstalledPdfEvidence, validateNativePdfEvidence, validatePdfNativeReport } from '../scripts/office-pdf-native-smoke.mjs';
import { installPdfFixture, pdfBytes, pdfReport } from './helpers/pdf-smoke-report.mjs';

function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-pdf-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resourceRoot = join(root, 'installed');
  const installed = installPdfFixture(root, resourceRoot);
  return { root, resourceRoot, installed, report: { preflight: { pdf: installed }, frontend: { pdf: pdfReport(installed) } } };
}

test('PDF installed and WebView assets bind the exact current source and independent document readback', t => {
  const { root, report, installed } = installation(t);
  assert.equal(validateInstalledPdfEvidence(installed, { root }).engine, 'Open Office PDF');
  assert.deepEqual(validateNativePdfEvidence(report, { root }), { pdfInstalledAssets: true, pdfRuntimeAssetDigests: true, pdfCheckoutSource: true });
  const observed = validatePdfNativeReport(report.frontend.pdf);
  for (const evidence of Object.values(observed)) assert.match(evidence.pages[0].text, /NEW_NATIVE_TEXT\s+新的合同/);
});

test('PDF asset proof rejects modified installed files, stale source and differing runtime bytes', t => {
  const { root, resourceRoot, report } = installation(t);
  const runtime = structuredClone(report); runtime.frontend.pdf.resources.files['office_pdf_bg.wasm'].sha256 = '0'.repeat(64);
  assert.throws(() => validateNativePdfEvidence(runtime, { root }), /independently verified installed file/);
  const manifest = structuredClone(report); manifest.preflight.pdf.manifestText += ' ';
  assert.throws(() => validateNativePdfEvidence(manifest, { root }), /manifest digest/);
  writeFileSync(join(root, 'vendor/office-pdf/src/lib.rs'), 'new source');
  assert.throws(() => validateNativePdfEvidence(report, { root }), /current checkout source/);
  installPdfFixture(root, resourceRoot);
  writeFileSync(join(resourceRoot, 'frontend/office-pdf/office_pdf.js'), 'modified installed bridge');
  assert.throws(() => inspectInstalledPdf(resourceRoot, { root }), /digest differs/);
});

test('a digest-correct non-WASM payload cannot pass installation preflight', t => {
  const { root, resourceRoot } = installation(t), directory = join(resourceRoot, 'frontend/office-pdf');
  const bytes = Buffer.from('not wasm'), manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  manifest.files['office_pdf_bg.wasm'] = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'office_pdf_bg.wasm'), bytes); writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => inspectInstalledPdf(resourceRoot, { root }), /WASM header/);
});

test('installed PDF evidence cannot fall back to source assets through an escaping symlink', { skip: process.platform === 'win32' }, t => {
  const { root, resourceRoot } = installation(t), path = join(resourceRoot, 'frontend/office-pdf/office_pdf.js'), outside = join(root, 'outside.js');
  writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
  assert.throws(() => inspectInstalledPdf(resourceRoot, { root }), /escapes the application resources/);
});

test('PDF native acceptance rejects flags without canvas, real editing, cleanup and native provenance', () => {
  for (const change of [
    r => { r.transport = 'local-wasm-in-browser'; }, r => { r.engine = 'isolated-pdf-command'; },
    r => { r.canvas.paintCalls = 0; }, r => { r.canvas.width = 1; }, r => { r.canvas.pageCount = 2; },
    r => { r.checks.pop(); }, r => { r.checks.reverse(); }, r => { r.limitations = []; },
    r => { r.undoRedo.undo = false; }, r => { r.cleanup.closed = 1; }, r => { r.cleanup.remainingInput = 1; },
    r => { r.failures.staleSaveRejected = false; }, r => { r.failures.invalidOpenRejected = false; },
    r => { r.failures.preserved = false; }, r => { r.reopened = false; },
    r => { r.resources.sameOrigin = false; }, r => { r.resources.wasmPath = 'https://example.invalid/engine.wasm'; },
  ]) {
    const report = pdfReport(); change(report);
    assert.throws(() => validatePdfNativeReport(report));
  }
});

test('success flags and reported text cannot hide unchanged, corrupt or altered exported PDF bytes', () => {
  for (const field of ['pdfBase64', 'reopenedPdfBase64']) for (const bytes of [
    pdfBytes('OLD_NATIVE_TEXT', '旧合同'), pdfBytes('NEW_NATIVE_TEXT', '旧合同'),
    Buffer.from('%PDF-1.7\ninvalid export').toString('base64'),
  ]) {
    const report = pdfReport(); report[field] = bytes;
    assert.throws(() => validatePdfNativeReport(report));
  }
  const browser = pdfReport(); browser.transport = 'local-wasm-in-browser';
  assert.equal(inspectOfficePdfExports(browser).exported.pages.length, 1, 'Independent document checks remain usable without claiming native execution');
});
