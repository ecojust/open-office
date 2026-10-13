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
    presentationWorkbench: {ok:true,pageCount:3,hiddenPageIndex:2,slideName:'Native saved page 中文',notes:'Native notes persisted 备注',editableTable:true,editableChart:true,transition:'fade',mediaBytes:3244,mediaDuration:.2,pdfCanvasPages:[0,1]},
    wordWorkbench: {
      schemaVersion: 1, ok: true, reopenCount: 2, heading: 'Native Word heading 中文', body: 'Native body SECOND_SAVE_TOKEN 正文',
      textStyle: { bold: true, fontSize: 18, color: '#203A5D', outlineLevel: 1 },
      table: { rows: 2, columns: 2, cells: [['项目', '值'], ['Native edited table', '84']] },
      margins: { left: 20, right: 20, top: 18, bottom: 18 }, headerText: 'Native header 页眉', footerText: 'Native footer 页脚',
      docxBytes: 16000, pdfBytes: 12000, pdfPageCount: 1, pdfTextVerified: true,
    },
    sheetWorkbench: {
      schemaVersion: 1, ok: true, reopenCount: 2, sheetNames: ['Native data 中文', 'Native summary'],
      sortedMatrix: [['地区', '销量', '成本'], ['南', 24, 8], ['北', 18, 6], ['北', 12, 5]],
      formula: '=SUM(G1:G2)', values: [41, 2, 43], headerFormat: { bold: true, textColor: '#203A5D' }, frozen: { rows: 1, columns: 1 },
      typedCells: { values: ['00123', '=SUM(9,9)'], types: ['text', 'text'] },
      savedFilter: { enabled: true, header: true, fields: [{ column: 0, operator: 'equal', value: '北' }] }, clearedFilter: null,
      chartCount: 1, chart: { name: 'NativeSalesChart', chartType: 'column', headerRow: true, headerColumn: true,
        ranges: [{ sheetIndex: 0, startColumn: 0, startRow: 0, endColumn: 1, endRow: 3 }] },
      pivot: { name: 'NativeSalesPivot', source: { sheetIndex: 0, startColumn: 0, startRow: 0, endColumn: 2, endRow: 3 },
        output: { sheetIndex: 1, startColumn: 0, startRow: 0, endColumn: 1, endRow: 3 },
        fields: [{ name: '地区', index: 0, orientation: 'row', operation: 'other' }, { name: '销量', index: 1, orientation: 'data', operation: 'sum' }] },
      xlsxBytes: 16000, pdfBytes: 12000, pdfPageCount: 2, pdfTextVerified: true,
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


test('new presentation release requires editable object, media metadata and actual canvas evidence', () => {
  for (const mutate of [
    report => {delete report.presentationWorkbench},
    report => {report.presentationWorkbench.editableChart = false},
    report => {report.presentationWorkbench.notes = ''},
    report => {report.presentationWorkbench.mediaDuration = '0.2'},
    report => {report.presentationWorkbench.mediaBytes = 0},
    report => {report.presentationWorkbench.pdfCanvasPages = [0,2]},
  ]) {
    const report = completeReport(); mutate(report)
    assert.throws(() => validateFrontendReport(report), /Presentation workbench/)
  }
})

test('old basic Word and SUM reports cannot substitute for the new real workbench contract', () => {
  for (const key of ['wordWorkbench', 'sheetWorkbench']) {
    const report = completeReport(); delete report[key];
    assert.throws(() => validateFrontendReport(report), /workbench/);
  }
  const checks = validateFrontendReport(completeReport());
  for (const key of ['wordWorkbenchSecondSave', 'wordEditableTable', 'wordTextAndPageFormatting', 'wordIndependentPdfReadback', 'calcWorkbenchSecondSave', 'calcEditableChart', 'calcPivotSemantics', 'calcSortAndFreeze', 'calcTypedTextPreserved', 'calcFilterPersistence', 'calcIndependentPdfReadback']) assert.equal(checks[key], true);
});

test('Word workbench rejects flattened objects, stale second saves and missing independent PDF evidence', () => {
  for (const mutate of [
    word => { word.reopenCount = 1; }, word => { word.schemaVersion = 0; },
    word => { word.body = 'Native body REPLACED_TOKEN 正文'; }, word => { word.textStyle.bold = false; },
    word => { word.textStyle.fontSize = '18'; }, word => { word.textStyle.outlineLevel = 0; },
    word => { word.table.cells[1][1] = '42'; }, word => { word.table.rows = '2'; },
    word => { word.margins.left = '20'; }, word => { word.margins.top = NaN; },
    word => { word.headerText = ''; }, word => { word.footerText = ''; },
    word => { word.docxBytes = 0; }, word => { word.pdfPageCount = 0; }, word => { word.pdfTextVerified = false; },
  ]) {
    const report = completeReport(); mutate(report.wordWorkbench);
    assert.throws(() => validateFrontendReport(report), /Word workbench/);
  }
});

test('Calc workbench requires persisted formula, actual sorting, editable chart and pivot configuration', () => {
  for (const mutate of [
    sheet => { sheet.reopenCount = 1; }, sheet => { sheet.schemaVersion = 0; },
    sheet => { sheet.values = [41, 2, 42]; }, sheet => { sheet.formula = '=43'; },
    sheet => { sheet.sortedMatrix[1][1] = 12; }, sheet => { sheet.sheetNames.reverse(); },
    sheet => { sheet.headerFormat.bold = false; }, sheet => { sheet.frozen.rows = 0; },
    sheet => { sheet.chart = { name: 'NativeSalesChart' }; }, sheet => { sheet.chart.ranges[0].endRow = 2; },
    sheet => { sheet.chartCount = 0; }, sheet => { sheet.chartCount = 2; }, sheet => { sheet.chart.name = ' '; },
    sheet => { sheet.pivot.fields = []; }, sheet => { sheet.pivot.fields[1].operation = 'count'; },
    sheet => { sheet.pivot.fields[1].index = 2; }, sheet => { sheet.pivot.fields[0].index = 1; }, sheet => { sheet.pivot.fields[1].name = ''; },
    sheet => { sheet.pivot.source.sheetIndex = 1; }, sheet => { sheet.pivot.output.sheetIndex = 0; },
    sheet => { sheet.typedCells.values[0] = 123; }, sheet => { sheet.typedCells.types[1] = 'formula'; },
    sheet => { sheet.savedFilter.fields = []; }, sheet => { sheet.savedFilter.fields[0].value = '南'; },
    sheet => { delete sheet.clearedFilter; }, sheet => { sheet.clearedFilter = { enabled: true, fields: [] }; },
    sheet => { sheet.xlsxBytes = 0; }, sheet => { sheet.pdfPageCount = '2'; }, sheet => { sheet.pdfTextVerified = false; },
  ]) {
    const report = completeReport(); mutate(report.sheetWorkbench);
    assert.throws(() => validateFrontendReport(report), /Calc workbench/);
  }
});

test('Calc accepts native XLSX object names and pivot captions while retaining source identity', () => {
  const report = completeReport();
  report.sheetWorkbench.chart.name = 'Object 1';
  report.sheetWorkbench.pivot.fields[1].name = 'Sum - 销量';
  const checks = validateFrontendReport(report);
  assert.equal(checks.calcEditableChart, true);
  assert.equal(checks.calcPivotSemantics, true);
});
