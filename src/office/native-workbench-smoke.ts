import { base64ToBytes } from '../shared/document'
export { pdfReadbackText } from './pdf-readback'
import type { OfficeExportRequest, OfficeExportResult } from './types'
import type { WriterAction, WriterQuery, WriterState, WriterTableData } from '../word/types'
import type { CalcAction, CalcDataQuery, CalcState, CalcRangeData, CalcChartData, CalcPivotData, CalcRulesData } from '../sheet/types'

interface ExportingEditor { exportFile(options?: OfficeExportRequest): Promise<OfficeExportResult> }
interface WriterEditor extends ExportingEditor {
  getWriterState(): Promise<WriterState>
  writerAction(action: WriterAction): Promise<WriterState>
  writerData(query: WriterQuery): Promise<unknown>
}
interface CalcEditor extends ExportingEditor {
  getCalcState(): Promise<CalcState>
  calcAction(action: CalcAction): Promise<CalcState>
  calcData(query: CalcDataQuery): Promise<unknown>
}
interface Lifecycle<E> {
  create(): Promise<E>
  reopen(base64: string): Promise<E>
  inspectPdf(base64: string): Promise<{ pageCount: number; text: string }>
}
function check(value: unknown, message: string): asserts value { if (!value) throw Error(`Office workbench: ${message}`) }
function closeTo(actual: number, expected: number) { return Number.isFinite(actual) && Math.abs(actual - expected) < .05 }
// PDF text is split into font spans and visual lines. Preserve all characters
// and their order while treating layout whitespace consistently on both sides.
function pdfText(value: string) { return value.replace(/\s+/gu, ' ').trim() }
function outputBytes(output: OfficeExportResult, format: string) {
  check(output.extension === format, `expected an actual ${format} export`)
  const bytes = base64ToBytes(output.base64)
  check(bytes.length > 100, `${format} export is empty`)
  if (format === 'pdf') check(new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-', 'PDF header is invalid')
  else check(bytes[0] === 0x50 && bytes[1] === 0x4b, `${format} export is not an OOXML package`)
  return bytes.length
}

// Runs in the installed native WebView, through the real Vue editor and actual
// UNO objects. The injected lifecycle must reopen exported bytes, not fixtures.
export async function verifyNativeWord(options: Lifecycle<WriterEditor>) {
  let editor = await options.create(), state = await editor.getWriterState()
  const action = async (input: WriterAction) => {
    state = await editor.writerAction({ ...input, expectedRevision: state.revision, expectedSelectionId: state.selection.id })
    return state
  }
  const heading = 'Native Word heading 中文', body = 'Native body REPLACED_TOKEN 正文'
  await action({ type: 'insert-text', text: `${heading}\nNative body ORIGINAL_TOKEN 正文` })
  await action({ type: 'insert-break', kind: 'paragraph' })
  await action({ type: 'insert-table', rows: 2, columns: 2, cells: [['项目', '值'], ['Native table', '42']] })
  check(state.tables.length === 1, 'Writer table was not created as an editable object')
  await action({ type: 'set-page', marginLeft: 20, marginRight: 20, marginTop: 18, marginBottom: 18 })
  await action({ type: 'set-header-footer', target: 'header', enabled: true, text: 'Native header 页眉' })
  await action({ type: 'set-header-footer', target: 'footer', enabled: true, text: 'Native footer 页脚' })
  await action({ type: 'find-replace', search: heading })
  check(state.selection.text === heading, 'Writer did not select the original heading')
  const headingStyle = state.styles.find(style => style.name === 'Heading 1')
  check(headingStyle, 'Writer Heading 1 semantic style is missing')
  await action({ type: 'apply-style', name: headingStyle.name })
  await action({ type: 'format-text', bold: true, fontSize: 18, color: '#203A5D' })
  await action({ type: 'find-replace', search: 'ORIGINAL_TOKEN', replace: 'REPLACED_TOKEN', all: true })
  const first = await editor.exportFile({ format: 'docx' }); outputBytes(first, 'docx')
  editor = await options.reopen(first.base64); state = await editor.getWriterState()
  await action({ type: 'find-replace', search: heading })
  check(state.selection.text === heading && state.paragraph.outlineLevel === 1, 'Writer semantic heading did not reopen')
  check(state.textStyle.bold && closeTo(state.textStyle.fontSize, 18) && state.textStyle.color.toUpperCase() === '#203A5D', 'Writer text formatting did not reopen')
  const firstTable = state.tables[0]
  check(firstTable && firstTable.rows === 2 && firstTable.columns === 2, 'Writer reopened table dimensions differ')
  const data = await editor.writerData({ type: 'table', name: firstTable.name }) as WriterTableData
  check(JSON.stringify(data.cells) === JSON.stringify([['项目', '值'], ['Native table', '42']]), 'Writer table cells did not reopen')
  await action({ type: 'update-table', name: firstTable.name, cells: [['项目', '值'], ['Native edited table', '84']] })
  await action({ type: 'find-replace', search: 'REPLACED_TOKEN', replace: 'SECOND_SAVE_TOKEN', all: true })
  const second = await editor.exportFile({ format: 'docx' }), docxBytes = outputBytes(second, 'docx')
  editor = await options.reopen(second.base64); state = await editor.getWriterState()
  await action({ type: 'find-replace', search: heading })
  check(state.paragraph.outlineLevel === 1 && state.selection.text === heading, 'Writer heading was lost on second save')
  check(state.textStyle.bold && closeTo(state.textStyle.fontSize, 18) && state.textStyle.color.toUpperCase() === '#203A5D', 'Writer second save lost original text formatting')
  const finalStyle = { bold: state.textStyle.bold, fontSize: state.textStyle.fontSize, color: state.textStyle.color.toUpperCase(), outlineLevel: state.paragraph.outlineLevel }
  const table = state.tables[0]; check(table, 'Writer second save lost its table')
  const tableData = await editor.writerData({ type: 'table', name: table.name }) as WriterTableData
  check(JSON.stringify(tableData.cells) === JSON.stringify([['项目', '值'], ['Native edited table', '84']]), 'Writer table second edit was not persisted')
  const page = state.page
  check(closeTo(page.marginLeft, 20) && closeTo(page.marginRight, 20) && closeTo(page.marginTop, 18) && closeTo(page.marginBottom, 18), 'Writer page margins did not persist')
  check(page.headerEnabled && page.footerEnabled && page.headerText.includes('Native header 页眉') && page.footerText.includes('Native footer 页脚'), 'Writer header/footer did not persist')
  const finalBody = await action({ type: 'find-replace', search: body.replace('REPLACED_TOKEN', 'SECOND_SAVE_TOKEN') })
  check(finalBody.selection.text === 'Native body SECOND_SAVE_TOKEN 正文', 'Writer original body replacement did not persist')
  const pdf = await editor.exportFile({ format: 'pdf' }), pdfBytes = outputBytes(pdf, 'pdf'), inspected = await options.inspectPdf(pdf.base64)
  check(Number.isSafeInteger(inspected.pageCount) && inspected.pageCount >= 1, 'Writer exported PDF has no pages')
  const readback = pdfText(inspected.text)
  check([heading, 'SECOND_SAVE_TOKEN', 'Native edited table'].every(value => readback.includes(pdfText(value)))
    && !readback.includes(pdfText('ORIGINAL_TOKEN')) && !readback.includes(pdfText('REPLACED_TOKEN')), 'Writer independent PDF readback differs from the edited document')
  return { schemaVersion: 1, ok: true, reopenCount: 2, heading, body: finalBody.selection.text, textStyle: finalStyle,
    table: { rows: tableData.rows, columns: tableData.columns, cells: tableData.cells },
    margins: { left: page.marginLeft, right: page.marginRight, top: page.marginTop, bottom: page.marginBottom },
    headerText: page.headerText, footerText: page.footerText, docxBytes, pdfBytes, pdfPageCount: inspected.pageCount, pdfTextVerified: true }
}

export async function verifyNativeCalc(options: Lifecycle<CalcEditor>) {
  let editor = await options.create(), state = await editor.getCalcState()
  const action = async (input: CalcAction) => { state = await editor.calcAction({ ...input, expectedRevision: state.revision }); return state }
  await action({ type: 'rename-sheet', sheetIndex: 0, name: 'Native data 中文' })
  await action({ type: 'add-sheet', name: 'Native summary' })
  await action({ type: 'select-sheet', sheetIndex: 0 })
  await action({ type: 'set-matrix', sheetIndex: 0, range: 'A1:C4', cells: [['地区', '销量', '成本'], ['北', 12, 5], ['南', 24, 8], ['北', 18, 6]] })
  await action({ type: 'set-matrix', sheetIndex: 0, range: 'G1:G2', cells: [[40], [2]] })
  await action({ type: 'set-cell', sheetIndex: 0, address: 'G3', input: '=SUM(G1:G2)' })
  await action({ type: 'patch-cells', sheetIndex: 0, cells: [
    { address: 'H1', kind: 'text', value: '00123' }, { address: 'H2', kind: 'text', value: '=SUM(9,9)' },
  ] })
  await action({ type: 'format', sheetIndex: 0, range: 'A1:C1', bold: true, textColor: '#203A5D' })
  await action({ type: 'sort', sheetIndex: 0, range: 'A1:C4', column: 1, ascending: false, header: true })
  await action({ type: 'freeze', columns: 1, rows: 1 })
  await action({ type: 'insert-chart', sheetIndex: 0, range: 'A1:B4', name: 'NativeSalesChart', chartType: 'column', headerRow: true, headerColumn: true })
  await action({ type: 'insert-pivot', sheetIndex: 0, range: 'A1:C4', name: 'NativeSalesPivot', rowField: 0, dataField: 1, operation: 'sum', outputSheetIndex: 1, outputAddress: 'A1' })
  await action({ type: 'select-sheet', sheetIndex: 0 })
  await action({ type: 'filter', sheetIndex: 0, range: 'A1:C4', column: 0, operator: 'equal', value: '北', header: true })
  const first = await editor.exportFile({ format: 'xlsx' }); outputBytes(first, 'xlsx')
  editor = await options.reopen(first.base64); state = await editor.getCalcState()
  const before = await editor.calcData({ type: 'range', sheetIndex: 0, range: 'G1:G3' }) as CalcRangeData
  check(before.values[2]?.[0] === 42 && before.formulas[2]?.[0] === '=SUM(G1:G2)', 'Calc formula did not reopen')
  const firstRules = await editor.calcData({ type: 'rules', sheetIndex: 0, range: 'A1:C4' }) as CalcRulesData
  check(firstRules.filter?.enabled && firstRules.filter.header && firstRules.filter.fields.length === 1
    && firstRules.filter.fields[0]?.column === 0 && firstRules.filter.fields[0]?.operator === 'equal' && firstRules.filter.fields[0]?.value === '北', 'Calc saved filter criteria did not reopen')
  await action({ type: 'clear-filter', sheetIndex: 0, range: 'A1:C4' })
  await action({ type: 'patch-cells', sheetIndex: 0, cells: [{ address: 'G1', kind: 'number', value: 41 }] })
  const second = await editor.exportFile({ format: 'xlsx' }), xlsxBytes = outputBytes(second, 'xlsx')
  editor = await options.reopen(second.base64); state = await editor.getCalcState()
  check(state.sheets.length === 2 && state.sheets[0]?.name === 'Native data 中文' && state.sheets[1]?.name === 'Native summary', 'Calc sheet names/order did not survive two saves')
  await action({ type: 'select-sheet', sheetIndex: 0 })
  await action({ type: 'select-range', sheetIndex: 0, range: 'A1' })
  check(state.format.bold && state.format.textColor.toUpperCase() === '#203A5D', 'Calc header formatting did not reopen')
  check(state.frozen.rows === 1 && state.frozen.columns === 1, 'Calc frozen panes did not reopen')
  const matrix = await editor.calcData({ type: 'range', sheetIndex: 0, range: 'A1:C4' }) as CalcRangeData
  check(JSON.stringify(matrix.values) === JSON.stringify([['地区', '销量', '成本'], ['南', 24, 8], ['北', 18, 6], ['北', 12, 5]]), 'Calc saved row order/data differs from the actual sort')
  const sum = await editor.calcData({ type: 'range', sheetIndex: 0, range: 'G1:G3' }) as CalcRangeData
  check(sum.values[0]?.[0] === 41 && sum.values[1]?.[0] === 2 && sum.values[2]?.[0] === 43 && sum.formulas[2]?.[0] === '=SUM(G1:G2)', 'Calc second edit did not recalculate and persist')
  const typed = await editor.calcData({ type: 'range', sheetIndex: 0, range: 'H1:H2' }) as CalcRangeData
  check(typed.values[0]?.[0] === '00123' && typed.values[1]?.[0] === '=SUM(9,9)' && typed.cellTypes[0]?.[0] === 'text' && typed.cellTypes[1]?.[0] === 'text', 'Calc typed text was converted into a number or formula')
  const finalRules = await editor.calcData({ type: 'rules', sheetIndex: 0, range: 'A1:C4' }) as CalcRulesData
  check(finalRules.filter === null || (!finalRules.filter.enabled && finalRules.filter.fields.length === 0), 'Calc cleared filter reappeared after the second save')
  const charts = await editor.calcData({ type: 'charts', sheetIndex: 0 }) as CalcChartData
  // OOXML may assign a fresh embedded-object name (e.g. "Object 1"). The
  // unique real chart and its source/configuration are the persistence contract.
  const chart = charts.items[0]
  check(charts.items.length === 1 && chart && typeof chart.name === 'string' && chart.name.trim() && chart.chartType === 'column' && chart.headerRow && chart.headerColumn && chart.ranges.some(range => range.sheetIndex === 0 && range.startColumn === 0 && range.startRow === 0 && range.endColumn === 1 && range.endRow === 3), 'Calc editable chart source/configuration did not reopen')
  const pivots = await editor.calcData({ type: 'pivots', sheetIndex: 1 }) as CalcPivotData
  const pivot = pivots.items.find(item => item.name === 'NativeSalesPivot')
  check(pivot && pivot.source.sheetIndex === 0 && pivot.source.startColumn === 0 && pivot.source.startRow === 0 && pivot.source.endColumn === 2 && pivot.source.endRow === 3 && pivot.output.sheetIndex === 1,
    'Calc pivot source/output did not reopen')
  // Field captions can become "Sum - 销量" after XLSX import. Resolve them by
  // source-column index, whose exact headers/data were independently read above.
  check(pivot.fields.some(field => field.index === 0 && typeof field.name === 'string' && field.name.trim() && field.orientation === 'row') && pivot.fields.some(field => field.index === 1 && typeof field.name === 'string' && field.name.trim() && field.orientation === 'data' && field.operation === 'sum'), 'Calc pivot field semantics did not reopen')
  const pdf = await editor.exportFile({ format: 'pdf' }), pdfBytes = outputBytes(pdf, 'pdf'), inspected = await options.inspectPdf(pdf.base64)
  const readback = pdfText(inspected.text)
  check(Number.isSafeInteger(inspected.pageCount) && inspected.pageCount >= 1 && ['地区', '销量'].every(value => readback.includes(pdfText(value))), 'Calc independent PDF readback is missing worksheet content')
  return { schemaVersion: 1, ok: true, reopenCount: 2, sheetNames: state.sheets.map(sheet => sheet.name),
    sortedMatrix: matrix.values, formula: sum.formulas[2]![0], values: sum.values.map(row => row[0]),
    typedCells: { values: typed.values.map(row => row[0]), types: typed.cellTypes.map(row => row[0]) },
    savedFilter: firstRules.filter, clearedFilter: finalRules.filter,
    headerFormat: { bold: state.format.bold, textColor: state.format.textColor.toUpperCase() }, frozen: state.frozen,
    chartCount: charts.items.length, chart, pivot, xlsxBytes, pdfBytes, pdfPageCount: inspected.pageCount, pdfTextVerified: true }
}
