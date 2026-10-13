import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Load the actual release helper AND its production command eligibility/target
// module. Only unrelated PDF/export dependencies are doubles; none of the
// behavior under test is recreated here.
function moduleFromSource(source, require) {
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, { exports, require, TextDecoder })
  return exports
}
const unexpectedDependency = name => { throw Error(`Unexpected test dependency: ${name}`) }
const writerTypes = moduleFromSource(await readFile(new URL('../src/word/types.ts', import.meta.url), 'utf8'), unexpectedDependency)
const exports = moduleFromSource(await readFile(new URL('../src/office/native-workbench-smoke.ts', import.meta.url), 'utf8'), name => {
  if (name === '../word/types') return writerTypes
  if (name === '../shared/document') return { base64ToBytes: () => { throw Error('This test must not export a document') } }
  if (name === './pdf-readback') return { pdfReadbackText: () => { throw Error('This test must not open a PDF') } }
  return unexpectedDependency(name)
})
const plain = value => JSON.parse(JSON.stringify(value))
const writer = () => ({ documentId: 'word-1', revision: 4, dirty: true,
  selection: { id: 'cursor-1', text: 'Heading', truncated: false, collapsed: false, tableName: null, cellName: null },
  textStyle: { fontName: 'Carlito', fontSize: 12, bold: false, italic: false, underline: false, color: '#000000', highlight: null },
  paragraph: { styleName: 'Standard', align: 'left', outlineLevel: 0, leftIndent: 0, rightIndent: 0,
    firstLineIndent: 0, spaceAbove: 0, spaceBelow: 0, lineSpacingPercent: 100 },
  tables: [{ name: 'Table1', rows: 2, columns: 2 }],
  page: { styleId: 'page-style-1', styleName: 'Standard', width: 210, height: 297, landscape: false,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    headerEnabled: false, footerEnabled: false, headerText: '', footerText: '', headerTruncated: false, footerTruncated: false },
  styles: [{ name: 'Standard', label: 'Default Paragraph Style' }], outline: [], outlineTruncated: false,
  review: { recordChanges: false, showChanges: true, changeCount: 0, comments: [], footnoteCount: 0, indexCount: 0 }, message: '' })
const sheet = () => ({ documentId: 'sheet-1', revision: 4, dirty: true,
  sheets: [{ index: 0, name: 'Sheet1', visible: true }], activeSheetIndex: 0,
  selection: { sheetIndex: 0, address: 'A1' }, cell: { address: 'A1', formula: '=SUM(B1:B2)', value: 42 },
  format: { bold: false }, frozen: { columns: 0, rows: 0 } })

test('eligible Writer intent sends one production command with an independent target snapshot and no read RPC', async () => {
  const before = writer(), next = { ...structuredClone(before), revision: 5 }, calls = []
  const original = structuredClone(before)
  const editor = {
    async getWriterState() { calls.push('read'); throw Error('Writer commands must not perform a preliminary state read') },
    async writerAction() { calls.push('strict-action'); throw Error('Eligible command unexpectedly used the draft API') },
    async writerCommand(command) { calls.push(command); return next },
  }
  const intent = Object.freeze({ type: 'format-text', bold: true })
  assert.equal(await exports.submitNativeWriterAction(editor, before, intent), next)
  assert.equal(calls.length, 1)
  const command = calls[0]
  assert.deepEqual(plain(command.action), intent)
  assert.deepEqual(plain(command.target), {
    documentId: original.documentId, revision: original.revision, selection: original.selection,
    textStyle: original.textStyle, paragraph: original.paragraph, page: original.page, tables: original.tables,
  })
  assert.deepEqual(before, original, 'submitting a command must not mutate the displayed state')
  assert.deepEqual(intent, { type: 'format-text', bold: true })
  assert.notEqual(command.target, before)
  for (const key of ['selection', 'textStyle', 'paragraph', 'page', 'tables']) assert.notEqual(command.target[key], before[key])
  assert.notEqual(command.target.tables[0], before.tables[0])
  // Both directions matter: later refreshes must not rewrite an in-flight
  // baseline, and receiver-side updates must not rewrite the caller's state.
  before.selection.text = 'A later selection'
  before.textStyle.bold = true
  before.paragraph.styleName = 'Title'
  before.page.headerText = 'Later page content'
  before.tables[0].rows = 8
  assert.equal(command.target.selection.text, original.selection.text)
  assert.equal(command.target.textStyle.bold, original.textStyle.bold)
  assert.equal(command.target.paragraph.styleName, original.paragraph.styleName)
  assert.equal(command.target.page.headerText, original.page.headerText)
  assert.equal(command.target.tables[0].rows, original.tables[0].rows)
  command.target.tables[0].columns = 9
  command.target.page.marginLeft = 35
  assert.equal(before.tables[0].columns, original.tables[0].columns)
  assert.equal(before.page.marginLeft, original.page.marginLeft)
})

test('replacement, existing headers and truncated selections retain strict actions without command promotion', async () => {
  const cases = [
    { action: { type: 'insert-text', text: 'Replacement', replaceSelection: true }, prepare(state) { state.selection.collapsed = true; state.selection.text = '' } },
    { action: { type: 'insert-text', text: 'Text over a selection' } },
    { action: { type: 'set-header-footer', target: 'header', enabled: true, text: 'Changed header' },
      prepare(state) { state.page.headerEnabled = true; state.page.headerText = 'Existing native PAGE field' } },
    { action: { type: 'format-text', bold: true }, prepare(state) { state.selection.text = 'x'.repeat(20000); state.selection.truncated = true } },
    { action: { type: 'insert-break', kind: 'paragraph' } },
    { action: { type: 'insert-table', rows: 1, columns: 1 }, prepare(state) { state.selection.collapsed = true; state.selection.text = ''; state.selection.tableName = 'Table1'; state.selection.cellName = 'A1' } },
  ]
  for (const { action, prepare } of cases) {
    const state = writer(); prepare?.(state)
    const before = structuredClone(state), originalAction = structuredClone(action), calls = []
    const result = await exports.submitNativeWriterAction({
      async getWriterState() { throw Error('A strict action must not silently acquire a newer revision') },
      async writerCommand() { throw Error('Ineligible action was promoted to a command') },
      async writerAction(input) { calls.push(input); return state },
    }, state, action)
    assert.equal(result, state)
    assert.equal(calls.length, 1)
    assert.deepEqual(plain(calls[0]), { ...originalAction, expectedRevision: 4, expectedSelectionId: 'cursor-1' })
    assert.deepEqual(state, before)
    assert.deepEqual(action, originalAction)
  }
})

test('table edits preserve their strict revision and native-cell CAS payload', async () => {
  const state = writer(), calls = []
  const action = { type: 'update-table', name: 'Table1', cells: [['edited']], expectedTableId: 'native-table-1',
    expectedCells: [['original']], expectedCellSignatures: [['native-cell-signature']] }
  const before = structuredClone(action)
  await exports.submitNativeWriterAction({
    async getWriterState() { throw Error('Unexpected read') }, async writerCommand() { throw Error('Table edit must use strict/CAS handling') },
    async writerAction(input) { calls.push(input); return state },
  }, state, action)
  assert.equal(calls.length, 1)
  assert.deepEqual(plain(calls[0]), { ...before, expectedRevision: state.revision })
  assert.equal('expectedSelectionId' in calls[0], false)
  assert.deepEqual(action, before)
})

test('a rejected production command is propagated once without state reads, retries or strict fallback', async () => {
  const state = writer(), rejection = Error('command target changed'), calls = []
  await assert.rejects(exports.submitNativeWriterAction({
    async getWriterState() { calls.push('read'); return state },
    async writerAction() { calls.push('strict'); return state },
    async writerCommand() { calls.push('command'); throw rejection },
  }, state, { type: 'format-text', bold: true }), error => error === rejection)
  assert.deepEqual(calls, ['command'])
})

test('Calc verifies sheet/range/cell semantics before using a newly read revision', async () => {
  const before = sheet(), next = { ...structuredClone(before), revision: 6 }, calls = []
  const intent = { type: 'freeze', rows: 1, columns: 1 }
  const result = await exports.submitNativeCalcAction({ async getCalcState() { calls.push('read'); return next }, async calcAction(input) { calls.push(input); return next } }, before, intent)
  assert.equal(result, next)
  assert.deepEqual(plain(calls), ['read', { ...intent, expectedRevision: 6 }])
  assert.equal(before.revision, 4)
  for (const change of [s => { s.sheets[0].name = 'Other' }, s => { s.selection.address = 'B1' }, s => { s.cell.formula = 'Overwritten' }, s => { s.format.bold = true }]) {
    const altered = structuredClone(next); change(altered)
    let reads = 0, writes = 0
    await assert.rejects(exports.submitNativeCalcAction({ async getCalcState() { reads++; return altered }, async calcAction() { writes++; return altered } }, before, intent), /new action target/)
    assert.equal(reads, 1)
    assert.equal(writes, 0)
  }
})
