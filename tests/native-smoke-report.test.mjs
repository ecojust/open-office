import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { REQUIRED_RUST_WORD_CHECKS, validateFrontendReport, validateRustWordEngineReport } from '../scripts/native-smoke.mjs';
import { REQUIRED_CHECKS } from '../scripts/word-package-native-smoke.mjs';
import { wordcraftReport } from './helpers/wordcraft-smoke-report.mjs';
import { gridcraftReport } from './helpers/gridcraft-smoke-report.mjs';

// These fixtures test the release report contract, not Office functionality.
// The native CI separately runs the actual packaged GUI and real file round trips.
function rustWordParts() {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // Hand-written OPC/XML fixtures. No product model, serializer, or parser.
  const run = (text, formatted) => `<w:r><w:rPr><w:rFonts w:ascii="DejaVu Sans" w:hAnsi="DejaVu Sans" w:eastAsia="DejaVu Sans" w:cs="DejaVu Sans"/><w:b w:val="${formatted ? 1 : 0}"/><w:i w:val="${formatted ? 1 : 0}"/><w:sz w:val="${formatted ? 28 : 24}"/><w:color w:val="${formatted ? 'C00000' : '20242B'}"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  return {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rel}"><Relationship Id="office" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${w}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('Rust 正文 中文😀', true)}</w:p><w:p><w:pPr><w:jc w:val="left"/></w:pPr>${run('Second paragraph', false)}</w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${rel}"><Relationship Id="settings" Type="${r}/settings" Target="settings.xml"/></Relationships>`,
    'word/settings.xml': `<w:settings xmlns:w="${w}"><w:defaultTabStop w:val="720"/></w:settings>`,
  };
}
function rustWordDocx(mutate = () => {}) {
  const parts = rustWordParts(); mutate(parts);
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])), { level: 0 })).toString('base64');
}
const RUST_WORD_DOCX = rustWordDocx();
function rustWordReport() {
  return { schemaVersion: 1, ok: true, transport: 'tauri-word-engine-request', checks: [...REQUIRED_RUST_WORD_CHECKS],
    paragraphs: 2, pages: 1, glyphPaths: 27, docxBase64: RUST_WORD_DOCX, cleanup: { attempted: 2, closed: 2, ok: true } };
}

function wordPackageReport() {
  const suffix = '\n上标中文😀下标中文😀\n明确取消中文😀取消高亮保留背景';
  return {
    schemaVersion: 1, kind: 'word-package-ipc', ok: true,
    userAgent: 'Native WebView contract test', elapsedMs: 125,
    checks: [...REQUIRED_CHECKS],
    roundTrips: [
      { docxBytes: 5000, text: '原文中文😀' + suffix },
      { docxBytes: 5100, text: '第二次保存中文😀 SECOND_SAVE_TOKEN' + suffix },
    ],
    formats: [
      { text: '上标中文😀', style: { fontSize: 18, underline: true, strike: 'double', verticalAlign: 'superscript', highlight: 'yellow', backgroundColor: '#13579B' } },
      { text: '下标中文😀', style: { fontSize: 14, strike: 'single', verticalAlign: 'subscript', highlight: 'cyan', backgroundColor: '#ABCDEF' } },
      { text: '明确取消中文😀', style: { fontSize: 18, strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' },
        directStyle: { strike: 'none', verticalAlign: 'baseline', highlight: 'none', backgroundColor: 'none' } },
      { text: '取消高亮保留背景', style: { fontSize: 18, strike: 'double', verticalAlign: 'superscript', highlight: 'none', backgroundColor: '#FEDCBA' } },
    ],
    rejections: [
      ['native-read-invalid-base64-rejected', 'DOCX ZIP Base64 编码无效。'],
      ['native-read-invalid-zip-rejected', 'DOCX 文件为空、损坏或超过 16 MiB。'],
      ['native-write-invalid-base64-rejected', 'DOCX ZIP 内容 Base64 编码无效。'],
      ['native-write-unsafe-name-rejected', 'DOCX 包含越界或保留的 ZIP 路径。'],
      ['native-write-duplicate-name-rejected', 'DOCX ZIP 包含重复或大小写歧义的文件。'],
    ].map(([check, error]) => ({ check, error })),
    resources: { observed: 7, forbidden: [], observation: 'Resource Timing entries since navigation; before Office mounting.' },
  };
}
function completeReport() {
  return {
    ok: true, crossOriginIsolated: true, sharedArrayBuffer: true,
    userAgent: 'Native WebView contract test',
    independentWordPackage: wordPackageReport(),
    rustWordEngine: rustWordReport(),
    wordcraft: wordcraftReport(),
    gridcraft: gridcraftReport(),
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
    'independentWordPackageIpc',
    'rustWordEngineIpc', 'rustWordEngineDocxReadback', 'rustWordEngineSessionCleanup',
    'wordcraftDefaultCanvas', 'wordcraftDomInput', 'wordcraftDocxReadback', 'wordcraftFailureAtomicity', 'wordcraftSessionCleanup',
    'gridcraftDefaultCanvas', 'gridcraftDomInput', 'gridcraftXlsxReadback', 'gridcraftFormulaRoundTrip', 'gridcraftFailureAtomicity', 'gridcraftSessionCleanup',
    'writerOriginalTextRoundTrip', 'writerPdfExport', 'calcFormulaRoundTrip', 'calcPdfExport',
    'pdfOriginalTextReplacementRoundTrip', 'impressOriginalTextRoundTrip', 'impressOdpRoundTrip',
    'impressPdfExport', 'impressPdfPageCount',
  ]) assert.equal(checks[required], true);
});

test('full release smoke requires the actual WordCraft default-canvas report independently of legacy IPC', () => {
  for (const value of [undefined, null, [], {}, { ok: true }, { ...wordcraftReport(), ok: false }]) {
    const report = completeReport(); report.wordcraft = value;
    assert.throws(() => validateFrontendReport(report), /WordCraft/);
  }
});

test('full release smoke requires the new real Rust Word engine IPC report', () => {
  for (const value of [undefined, null, [], {}, { ok: true }, { ...rustWordReport(), ok: false }]) {
    const report = completeReport(); report.rustWordEngine = value;
    assert.throws(() => validateFrontendReport(report), /Rust Word engine/);
  }
});

test('legacy Calc checks cannot replace the default GridCraft canvas and XLSX evidence', () => {
  for (const value of [undefined, null, [], {}, { ok: true }, { ...gridcraftReport(), transport: 'local-wasm-in-browser' }]) {
    const report = completeReport(); report.gridcraft = value;
    assert.throws(() => validateFrontendReport(report), /GridCraft/);
  }
});

test('Rust Word report cannot replace native transport, all five checks, layout, or cleanup with success flags', () => {
  for (const mutate of [
    word => { word.schemaVersion = 0; }, word => { word.transport = 'wasm-worker'; },
    word => { word.transport = 'rust-cli'; }, word => { word.checks.pop(); },
    word => { word.checks[4] = word.checks[0]; }, word => { word.checks.reverse(); },
    word => { word.paragraphs = '2'; }, word => { word.pages = 0; },
    word => { word.glyphPaths = '27'; }, word => { word.glyphPaths = 1.5; },
    word => { word.pages = Infinity; }, word => { delete word.cleanup; },
    word => { word.cleanup.closed = 1; }, word => { word.cleanup.attempted = 1; },
    word => { word.cleanup.ok = false; }, word => { word.closeError = 'close failed'; },
    word => { word.error = 'stale revision changed the document'; },
  ]) {
    const report = rustWordReport(); mutate(report);
    assert.throws(() => validateRustWordEngineReport(report), /Rust Word engine/);
  }
});

test('Rust Word independent ZIP/XML readback verifies the hand-written complete DOCX fixture', () => {
  const evidence = validateRustWordEngineReport(rustWordReport());
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.paragraphs, ['Rust 正文 中文😀', 'Second paragraph']);
  assert.equal(evidence.zipEntries.length, 5);
});

test('Rust Word DOCX evidence must contain a bounded, canonical and CRC-valid ZIP', () => {
  const crcInvalid = Buffer.from(RUST_WORD_DOCX, 'base64');
  const token = Buffer.from('Rust 正文 中文😀');
  const offset = crcInvalid.indexOf(token); assert.ok(offset > 0);
  crcInvalid[offset] = 0x42;
  for (const base64 of [undefined, '', '%%%invalid', RUST_WORD_DOCX + '\n', 'A'.repeat(1024 * 1024),
    Buffer.from('PK\x03\x04' + 'x'.repeat(200)).toString('base64'), crcInvalid.toString('base64'),
    Buffer.from(RUST_WORD_DOCX, 'base64').subarray(0, 250).toString('base64')]) {
    const report = rustWordReport(); report.docxBase64 = base64;
    assert.throws(() => validateRustWordEngineReport(report), /Rust Word engine/);
  }
});

test('successful IPC flags cannot hide altered text, format, OPC metadata, or unsupported extra content', () => {
  for (const mutate of [
    parts => { delete parts['[Content_Types].xml']; },
    parts => { parts['word/hidden.xml'] = '<secret/>'; },
    parts => { parts['_rels/.rels'] = parts['_rels/.rels'].replace('word/document.xml', 'other.xml'); },
    parts => { parts['_rels/.rels'] = parts['_rels/.rels'].replace('Target=', 'TargetMode="External" Target='); },
    parts => { parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('document.main+xml', 'template.main+xml'); },
    parts => { parts['word/settings.xml'] = parts['word/settings.xml'].replace('720', '360'); },
    ...[
      ['Rust 正文 中文😀', 'Rust 正文 中文'], ['Second paragraph', 'Stale paragraph'],
      ['w:val="center"', 'w:val="left"'], ['<w:b w:val="1"/>', '<w:b w:val="0"/>'],
      ['<w:i w:val="1"/>', '<w:i w:val="0"/>'], ['w:val="28"', 'w:val="14"'],
      ['w:val="C00000"', 'w:val="000000"'], ['w:val="C00000"', 'w:val="C00000" w:themeColor="accent1"'],
      ['w:val="20242B"', 'w:val="C00000"'], ['DejaVu Sans', 'Arial'],
      ['</w:body>', '<w:p/></w:body>'], ['</w:p>', '<w:hyperlink><w:r><w:t>hidden</w:t></w:r></w:hyperlink></w:p>'],
      ['<w:t xml:space="preserve">', '<evil:t xmlns:evil="urn:wrong">'],
      ['<w:document', '<!DOCTYPE document [<!ENTITY text "wrong">]><w:document'],
      ['w:w="11906"', 'w:w="1"'],
    ].map(([before, after]) => parts => { parts['word/document.xml'] = parts['word/document.xml'].replace(before, after); }),
  ]) {
    const report = rustWordReport(); report.docxBase64 = rustWordDocx(mutate);
    assert.throws(() => validateRustWordEngineReport(report), /Rust Word engine independent DOCX verification failed/);
  }
});

test('full release smoke cannot pass without the independent Word native package report', () => {
  for (const value of [undefined, null, {}, { ok: true }, { ...wordPackageReport(), ok: false, error: 'Rust package failed' }]) {
    const report = completeReport(); report.independentWordPackage = value;
    assert.throws(() => validateFrontendReport(report));
  }
  const report = completeReport(); delete report.independentWordPackage;
  assert.throws(() => validateFrontendReport(report), /Independent Word native IPC report is missing/);
});

test('native IPC success flags cannot substitute for both reopenings, semantic readback and Rust validation errors', () => {
  for (const mutate of [
    word => { word.schemaVersion = 0; }, word => { word.kind = 'browser-word'; },
    word => { word.checks.pop(); }, word => { word.checks.push(word.checks[0]); },
    word => { word.checks.reverse(); }, word => { word.userAgent = ''; }, word => { word.elapsedMs = -1; },
    word => { word.roundTrips.pop(); }, word => { word.roundTrips[1].text = word.roundTrips[0].text; },
    word => { word.roundTrips[0].text = word.roundTrips[0].text.replace('😀', ''); },
    word => { word.roundTrips[1].docxBytes = 100; }, word => { word.roundTrips[1].docxBytes = '5100'; },
    word => { word.formats.pop(); }, word => { word.formats[0].style.verticalAlign = 'baseline'; },
    word => { word.formats[1].style.backgroundColor = '#000000'; },
    word => { delete word.formats[2].directStyle.highlight; }, word => { word.formats[3].style.highlight = 'yellow'; },
    word => { word.rejections.pop(); }, word => { word.rejections[0].error = 'command not allowed'; },
    word => { word.rejections[4].check = word.rejections[0].check; },
    word => { word.resources.observed = 0; }, word => { word.resources.observed = '7'; },
    word => { word.resources.forbidden = ['/office/host.html']; },
    word => { word.resources.forbidden = ['/office-runtime/soffice.wasm']; },
    word => { delete word.resources.observation; },
  ]) {
    const report = completeReport(); mutate(report.independentWordPackage);
    assert.throws(() => validateFrontendReport(report));
  }
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
