import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrontendReport } from '../scripts/native-smoke.mjs';
import { wordcraftReport } from './helpers/wordcraft-smoke-report.mjs';
import { gridcraftReport } from './helpers/gridcraft-smoke-report.mjs';
import { deckcraftReport } from './helpers/deckcraft-smoke-report.mjs';

function completeReport() {
  return {
    ok: true, crossOriginIsolated: true, sharedArrayBuffer: true,
    userAgent: 'Native WebView contract test',
    wordcraft: wordcraftReport(), gridcraft: gridcraftReport(), deckcraft: deckcraftReport(),
    pdf: { ok: true, reopened: true, removedOldText: true, newTextPresent: true,
      metadata: { pageCount: 1 }, text: 'NEW_NATIVE_TEXT 新的合同' },
  };
}

test('release evidence requires all three current Rust canvases and real PDF text replacement', () => {
  const checks = validateFrontendReport(completeReport());
  for (const required of [
    'wordcraftDefaultCanvas', 'wordcraftDomInput', 'wordcraftDocxReadback', 'wordcraftFailureAtomicity', 'wordcraftSessionCleanup',
    'gridcraftDefaultCanvas', 'gridcraftDomInput', 'gridcraftXlsxReadback', 'gridcraftFormulaRoundTrip', 'gridcraftFailureAtomicity', 'gridcraftSessionCleanup',
    'deckcraftDefaultCanvas', 'deckcraftDomInput', 'deckcraftPptxReadback', 'deckcraftPdfReadback', 'deckcraftFailureAtomicity', 'deckcraftSessionCleanup',
    'pdfOriginalTextReplacementRoundTrip', 'crossOriginIsolated',
  ]) assert.equal(checks[required], true);
  assert.equal(Object.hasOwn(checks, 'sharedArrayBuffer'), false);
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
  for (const available of [true, false]) for (const [key, label] of [['wordcraft', /WordCraft/], ['gridcraft', /GridCraft/], ['deckcraft', /DeckCraft/]]) {
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
  for (const [key, bytes] of [['wordcraft', 'reopenedDocxBase64'], ['gridcraft', 'reopenedXlsxBase64'], ['deckcraft', 'reopenedPptxBase64']]) {
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
