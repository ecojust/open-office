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
    'pdfOriginalTextReplacementRoundTrip', 'crossOriginIsolated', 'sharedArrayBuffer',
  ]) assert.equal(checks[required], true);
});

test('legacy engines and isolated IPC probes cannot substitute for any current editor', () => {
  for (const [key, label] of [['wordcraft', /WordCraft/], ['gridcraft', /GridCraft/], ['deckcraft', /DeckCraft/]]) {
    for (const value of [undefined, null, [], {}, { ok: true }, { ...completeReport()[key], transport: 'local-wasm-in-browser' }]) {
      const report = completeReport(); report[key] = value;
      report.office = { ok: true, engine: 'LibreOffice', writer: { ok: true }, calc: { ok: true }, impress: { ok: true } };
      report.rustWordEngine = { ok: true, transport: 'tauri-word-engine-request' };
      report.presentationWorkbench = { ok: true };
      assert.throws(() => validateFrontendReport(report), label);
    }
  }
});

test('current presentation success cannot bypass PDF reopen, exact replacement text or platform isolation', () => {
  for (const mutate of [
    report => { report.ok = false; }, report => { report.crossOriginIsolated = false; },
    report => { report.sharedArrayBuffer = false; }, report => { report.userAgent = ''; },
    report => { delete report.pdf; }, report => { report.pdf.ok = false; },
    report => { report.pdf.reopened = false; }, report => { report.pdf.removedOldText = false; },
    report => { report.pdf.newTextPresent = false; }, report => { report.pdf.metadata.pageCount = '1'; },
    report => { report.pdf.text = 'NEW_NATIVE_TEXT'; }, report => { report.pdf.text = '新的合同'; },
    report => { report.pdf.text += ' OLD_NATIVE_TEXT'; }, report => { report.pdf.text += ' 旧合同'; },
  ]) {
    const report = completeReport(); mutate(report);
    assert.throws(() => validateFrontendReport(report));
  }
});
