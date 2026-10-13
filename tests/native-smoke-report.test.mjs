import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrontendReport } from '../scripts/native-smoke.mjs';

// These fixtures test the release report contract, not Office functionality.
// The native CI separately runs the actual packaged GUI and real file round trips.
function completeReport() {
  return {
    ok: true, crossOriginIsolated: true, sharedArrayBuffer: true,
    userAgent: 'Native WebView contract test',
    office: {
      ok: true, engine: 'ZetaOffice / LibreOffice 24.2.8.0',
      writer: {
        originalTextEdited: true, text: 'Open Office edited original text · 中文测试',
        macrosDisabled: true, linkUpdatesDisabled: true,
        docxBytes: 5000, pdfBytes: 12000, pdfHeader: '%PDF-',
      },
      calc: { a1: 40, a2: 2, formula: '=SUM(A1:A2)', value: 42, xlsxBytes: 5000, pdfBytes: 13000, pdfHeader: '%PDF-' },
      impress: {
        pptxReopened: true, odpReopened: true, originalTextEdited: true, slideCount: 2,
        texts: ['Open Office edited slide · 中文演示测试', 'Second slide · 第二页内容'],
        macrosDisabled: true, linkUpdatesDisabled: true,
        pptxBytes: 20000, odpBytes: 14000, pdfBytes: 17000, pdfHeader: '%PDF-', pdfPageCount: 2,
      },
    },
    pdf: {
      ok: true, reopened: true, removedOldText: true, newTextPresent: true,
      metadata: { pageCount: 1 }, text: 'NEW_NATIVE_TEXT 新的合同',
    },
  };
}

test('a complete four-workspace report preserves old checks and requires Impress round trips', () => {
  const checks = validateFrontendReport(completeReport());
  for (const required of [
    'writerOriginalTextRoundTrip', 'writerPdfExport', 'calcFormulaRoundTrip', 'calcPdfExport',
    'pdfOriginalTextReplacementRoundTrip', 'impressOriginalTextRoundTrip', 'impressOdpRoundTrip',
    'impressPdfExport', 'impressPdfPageCount',
  ]) assert.equal(checks[required], true);
});

test('an old Word/Excel/PDF-only success report cannot publish the PPT-capable app', () => {
  const report = completeReport();
  delete report.office.impress;
  assert.throws(() => validateFrontendReport(report), /Impress did not reopen/);
});

test('export alone does not satisfy PPTX or ODP reopening and original-text editing', () => {
  for (const flag of ['pptxReopened', 'odpReopened', 'originalTextEdited']) {
    const report = completeReport();
    report.office.impress[flag] = false;
    assert.throws(() => validateFrontendReport(report), /Impress/);
  }
});

test('missing slides, stale text and reordered pages fail even when every success flag is true', () => {
  for (const mutate of [
    impress => { impress.slideCount = 1; },
    impress => { impress.slideCount = '2'; },
    impress => { impress.texts[0] = 'Open Office original slide · 离线演示'; },
    impress => { impress.texts.reverse(); },
    impress => { impress.texts.pop(); },
    impress => { impress.texts[1] = impress.texts[0]; },
  ]) {
    const report = completeReport();
    mutate(report.office.impress);
    assert.throws(() => validateFrontendReport(report), /Impress/);
  }
});

test('all three presentation formats must contain real exported bytes', () => {
  for (const field of ['pptxBytes', 'odpBytes', 'pdfBytes']) {
    for (const badSize of [undefined, 0, 100, 101.5]) {
      const report = completeReport();
      report.office.impress[field] = badSize;
      assert.throws(() => validateFrontendReport(report), /Impress/);
    }
  }
});

test('presentation PDF requires a valid header and independent numeric two-page readback', () => {
  for (const mutate of [
    impress => { impress.pdfHeader = '<html'; },
    impress => { delete impress.pdfPageCount; },
    impress => { impress.pdfPageCount = 1; },
    impress => { impress.pdfPageCount = '2'; },
  ]) {
    const report = completeReport();
    mutate(report.office.impress);
    assert.throws(() => validateFrontendReport(report), /Impress PDF/);
  }
});

test('Impress imports must keep macros and external link updates disabled', () => {
  for (const flag of ['macrosDisabled', 'linkUpdatesDisabled']) {
    const report = completeReport();
    report.office.impress[flag] = false;
    assert.throws(() => validateFrontendReport(report), /Impress safe import/);
  }
});

test('successful Impress output cannot bypass earlier Writer, Calc, PDF or isolation failures', () => {
  for (const mutate of [
    report => { report.crossOriginIsolated = false; },
    report => { report.sharedArrayBuffer = false; },
    report => { report.office.writer.originalTextEdited = false; },
    report => { report.office.writer.text = 'wrong document'; },
    report => { report.office.calc.value = 41; },
    report => { report.office.calc.formula = '=40+2'; },
    report => { report.pdf.removedOldText = false; },
    report => { report.pdf.text += ' OLD_NATIVE_TEXT'; },
  ]) {
    const report = completeReport();
    mutate(report);
    assert.throws(() => validateFrontendReport(report));
  }
});
