import assert from 'node:assert/strict'
import test from 'node:test'
import { pdfReadbackText } from '../src/office/pdf-readback.ts'

test('PDF font spans on the same line preserve exact mixed-language text and spacing', () => {
  assert.equal(pdfReadbackText([
    { id: '0:0:0:0', text: 'Native Word heading ' },
    { id: '0:0:0:1', text: '中文' },
    { id: '0:0:0:2', text: ' · ' },
    { id: '0:0:0:3', text: 'SECOND_SAVE_TOKEN' },
  ]), 'Native Word heading 中文 · SECOND_SAVE_TOKEN')
})

test('PDF page, block and line boundaries remain distinct in extraction order', () => {
  assert.equal(pdfReadbackText([
    { id: '0:0:0:0', text: 'One' }, { id: '0:0:1:0', text: 'Two' },
    { id: '0:1:1:0', text: 'Three' }, { id: '1:1:1:0', text: 'Four' },
    { id: '0:0:0:1', text: 'Last, not moved' },
  ]), 'One\nTwo\nThree\nFour\nLast, not moved')
})

test('PDF spans without a trusted backend line ID are never silently joined', () => {
  assert.equal(pdfReadbackText([
    { text: 'One' }, { text: 'Two' }, { id: 'bad:id', text: 'Three' },
    { id: 'bad:id', text: 'Four' }, { id: '0:0:0:0', text: 'Five' },
  ]), 'One\nTwo\nThree\nFour\nFive')
  assert.equal(pdfReadbackText([]), '')
})

test('PDF readback retains old tokens and punctuation instead of hiding failed edits', () => {
  assert.equal(pdfReadbackText([
    { id: '0:0:0:0', text: 'ORIGINAL_' }, { id: '0:0:0:1', text: 'TOKEN' },
    { id: '0:0:1:0', text: 'REPLACED_TOKEN, ' }, { id: '0:0:1:1', text: '正文\t尾文' },
  ]), 'ORIGINAL_TOKEN\nREPLACED_TOKEN, 正文\t尾文')
})
