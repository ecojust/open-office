import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveNativeDiagnostics, validateFrontendReport } from '../scripts/native-smoke.mjs';
import { wordReport } from './helpers/office-word-smoke-report.mjs';
import { sheetReport } from './helpers/office-sheet-smoke-report.mjs';
import { pdfReport } from './helpers/pdf-smoke-report.mjs';
import { presentationReport } from './helpers/office-presentation-smoke-report.mjs';
import { workspaceReport } from './helpers/workspace-smoke-report.mjs';

function completeReport() {
  return {
    ok: true, crossOriginIsolated: true, sharedArrayBuffer: true,
    userAgent: 'Native WebView contract test',
    word: wordReport(), sheet: sheetReport(), presentation: presentationReport(),
    pdf: pdfReport(), workspace: workspaceReport(),
  };
}

test('successful native runs preserve host lifecycle bytes before temporary cleanup', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, 'private-run'); mkdirSync(temporary);
  const diagnostics = { schemaVersion: 1, scope: 'full', generation: 1, terminations: 0,
    events: [{ phase: 'document-start', detail: 'first', elapsedMs: 0, generation: 1 },
      { phase: 'report-written', detail: 'passed', elapsedMs: 1000, generation: 1 }] };
  const bytes = Buffer.from(JSON.stringify(diagnostics) + '\n');
  writeFileSync(join(temporary, 'diagnostics.json'), bytes);
  const report = { ok: true, errors: [] };
  preserveNativeDiagnostics(temporary, root, 'macos-arm64', report);
  rmSync(temporary, { recursive: true });
  assert.deepEqual(report.nativeDiagnostics, diagnostics);
  assert.deepEqual(readFileSync(join(root, report.nativeDiagnosticsArtifact)), bytes);
  assert.equal(report.nativeDiagnosticsError, undefined);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test('missing or malformed successful-run diagnostics stay observational outside the macOS 26 gate', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-lifecycle-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const platform of ['windows-x64', 'macos-x64', 'macos-arm64']) {
    const report = { ok: true, errors: [] };
    preserveNativeDiagnostics(join(root, 'absent'), root, platform, report);
    assert.match(report.nativeDiagnosticsError, /did not produce/);
    assert.equal(report.nativeDiagnostics, undefined);
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ schemaVersion: 1, events: [null] }));
  const report = { ok: true, errors: [] };
  preserveNativeDiagnostics(root, root, 'macos-arm64', report);
  assert.match(report.nativeDiagnosticsError, /could not be preserved/);
  assert.equal(report.nativeDiagnostics, undefined);
  assert.equal(report.ok, true);
});

test('release evidence requires four Rust canvases, PDF text replacement, and native autosave', () => {
  const checks = validateFrontendReport(completeReport());
  for (const required of [
    'wordDefaultCanvas', 'wordDomInput', 'wordDocxReadback', 'wordFailureAtomicity', 'wordSessionCleanup',
    'sheetDefaultCanvas', 'sheetDomInput', 'sheetXlsxReadback', 'sheetFormulaRoundTrip', 'sheetFailureAtomicity', 'sheetSessionCleanup',
    'presentationDefaultCanvas', 'presentationDomInput', 'presentationPptxReadback', 'presentationPdfReadback', 'presentationFailureAtomicity', 'presentationSessionCleanup',
    'pdfOriginalTextReplacementRoundTrip', 'pdfDefaultCanvas', 'pdfUndoRedo', 'pdfFailureAtomicity', 'pdfSessionCleanup', 'crossOriginIsolated',
    'workspaceLocalAutosave', 'workspaceSavedFileReadback', 'workspaceSessionCleanup',
  ]) assert.equal(checks[required], true);
  assert.equal(Object.hasOwn(checks, 'sharedArrayBuffer'), false);
});

test('editor evidence cannot substitute for missing native autosave or different saved-file bytes', () => {
  for (const mutate of [
    report => { delete report.workspace; },
    report => { report.workspace = { ok: true, transport: 'browser' }; },
    report => { report.workspace.autosave.readbackBase64 = report.word.reopenedDocxBase64; },
  ]) {
    const report = completeReport(); mutate(report);
    assert.throws(() => validateFrontendReport(report), /workspace/i);
  }
});

test('shared memory availability is recorded without substituting for editor acceptance', () => {
  const expected = validateFrontendReport(completeReport());
  for (const available of [true, false]) {
    const report = completeReport(); report.sharedArrayBuffer = available;
    assert.deepEqual(validateFrontendReport(report), expected);
    assert.equal(report.sharedArrayBuffer, available, 'capability evidence must retain the actual availability');
  }
  for (const invalid of [undefined, null, 0, 1, 'false', 'true', {}]) {
    const report = completeReport(); report.sharedArrayBuffer = invalid;
    assert.throws(() => validateFrontendReport(report), /SharedArrayBuffer capability/);
  }
});

test('legacy engines and isolated IPC probes cannot substitute for any current editor', () => {
  for (const available of [true, false]) for (const [key, label] of [['word', /OfficeWord/], ['sheet', /OfficeSheet/], ['presentation', /OfficePresentation/], ['pdf', /Open Office PDF/]]) {
    for (const value of [undefined, null, [], {}, { ok: true }, { ...completeReport()[key], transport: 'local-wasm-in-browser' }]) {
      const report = completeReport(); report.sharedArrayBuffer = available; report[key] = value;
      report.office = { ok: true, engine: 'LibreOffice', writer: { ok: true }, calc: { ok: true }, impress: { ok: true } };
      report.rustWordEngine = { ok: true, transport: 'tauri-word-engine-request' };
      report.presentationWorkbench = { ok: true };
      assert.throws(() => validateFrontendReport(report), label);
    }
  }
});

test('unavailable shared memory cannot bypass failed-open protection or exported document validation', () => {
  for (const [key, bytes] of [['word', 'reopenedDocxBase64'], ['sheet', 'reopenedXlsxBase64'], ['presentation', 'reopenedPptxBase64'], ['pdf', 'reopenedPdfBase64']]) {
    for (const mutate of [
      editor => { editor.checks.pop(); },
      editor => { editor.failures.invalidOpenRejected = false; },
      editor => { editor.failures.staleSaveRejected = false; },
      editor => { editor.failures.preserved = false; },
      editor => { editor[bytes] = Buffer.from('invalid saved document').toString('base64'); },
    ]) {
      const report = completeReport(); report.sharedArrayBuffer = false; mutate(report[key]);
      assert.throws(() => validateFrontendReport(report));
    }
  }
});

test('current presentation success cannot bypass PDF reopen, exact replacement text or platform isolation', () => {
  for (const available of [true, false]) for (const mutate of [
    report => { report.ok = false; }, report => { report.crossOriginIsolated = false; },
    report => { report.userAgent = ''; },
    report => { delete report.pdf; }, report => { report.pdf.ok = false; },
    report => { report.pdf.reopened = false; }, report => { report.pdf.removedOldText = false; },
    report => { report.pdf.newTextPresent = false; }, report => { report.pdf.metadata.pageCount = '1'; },
    report => { report.pdf.text = 'NEW_NATIVE_TEXT'; }, report => { report.pdf.text = '新的合同'; },
    report => { report.pdf.text += ' OLD_NATIVE_TEXT'; }, report => { report.pdf.text += ' 旧合同'; },
  ]) {
    const report = completeReport(); report.sharedArrayBuffer = available; mutate(report);
    assert.throws(() => validateFrontendReport(report));
  }
});
