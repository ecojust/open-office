import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendHistory, canvasOutputScale, historyBytes, MAX_CANVAS_DIMENSION, MAX_CANVAS_PIXELS,
  PDF_HISTORY_MAX_BYTES, PDF_HISTORY_MAX_ENTRIES, releaseCanvas, trimHistoryBudget,
} from '../src/pdf/resources.ts'

test('PDF backing pixels retain requested density for ordinary pages', () => {
  assert.equal(canvasOutputScale(612, 792, 2), 2)
  assert.equal(canvasOutputScale(960, 540, 1.25), 1.25)
})

test('large and unusually narrow PDF pages fit both canvas allocation limits', () => {
  for (const [width, height, density] of [[5000, 8000, 2], [10, 1_000_000, 2], [1_000_000, 10, 1], [1e12, 1e12, 2], [0.1, 50_000, 2]]) {
    const scale = canvasOutputScale(width, height, density)
    const pixels = [width, height].map(value => Math.max(1, Math.floor(value * scale)))
    assert.ok(Number.isFinite(scale) && scale > 0 && scale <= density, `${width} × ${height} scale`)
    assert.ok(pixels.every(value => value <= MAX_CANVAS_DIMENSION), `${pixels} edge budget`)
    assert.ok(pixels[0] * pixels[1] <= MAX_CANVAS_PIXELS, `${pixels} pixel budget`)
  }
})

test('a caller can reserve a smaller pixel budget for thumbnail canvases', () => {
  const limit = 100_000
  const scale = canvasOutputScale(104, 10_000, 1.5, limit)
  assert.ok(Math.max(1, Math.floor(104 * scale)) * Math.max(1, Math.floor(10_000 * scale)) <= limit)
})

test('invalid page dimensions fail before allocating a canvas', () => {
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => canvasOutputScale(invalid, 100, 2))
    assert.throws(() => canvasOutputScale(100, invalid, 2))
  }
})

test('canvas release drops the backing allocation and is safe to repeat', () => {
  const canvas = { width: 8192, height: 8192 }
  releaseCanvas(canvas)
  assert.deepEqual(canvas, { width: 1, height: 1 })
  releaseCanvas(canvas)
  releaseCanvas(null)
  releaseCanvas()
  assert.deepEqual(canvas, { width: 1, height: 1 })
})

test('PDF undo budgets account for the retained base64 strings and keep the latest contiguous states', () => {
  const before = ['AAAA', 'BBBB', 'CCCC']
  assert.equal(historyBytes(before), 24)
  assert.deepEqual(appendHistory(before, 'DDDD', 8, 16), ['CCCC', 'DDDD'])
  assert.deepEqual(appendHistory(before, 'DDDD', 2, 1000), ['CCCC', 'DDDD'])
  assert.deepEqual(appendHistory(before, 'TOO_BIG_FOR_THIS_HISTORY', 8, 16), ['TOO_BIG_FOR_THIS_HISTORY'])
  assert.deepEqual(appendHistory(before, 'DDDD', 0, 1000), [])
  assert.deepEqual(before, ['AAAA', 'BBBB', 'CCCC'])
})

test('undo and redo share their entry budget and trim the farthest unpreferred states first', () => {
  const undo = ['u1', 'u2', 'u3', 'u4', 'u5'], redo = ['r1', 'r2', 'r3', 'r4', 'r5']
  assert.deepEqual(trimHistoryBudget(undo, redo, 'undo'), { undo, redo: ['r3', 'r4', 'r5'] })
  assert.deepEqual(trimHistoryBudget(undo, redo, 'redo'), { undo: ['u3', 'u4', 'u5'], redo })
  assert.equal(undo.length + redo.length, 10)
  assert.equal(PDF_HISTORY_MAX_ENTRIES, 8)
})

test('combined undo and redo string storage stays below 48 MiB through repeated transfers', () => {
  const state = 'A'.repeat(4 * 1024 * 1024)
  let undo = ['oldest', state, state, state], redo = [state, state, state, 'newest']
  const initialUndo = undo, initialRedo = redo
  ;({ undo, redo } = trimHistoryBudget(undo, redo, 'undo'))
  assert.ok(historyBytes(undo) + historyBytes(redo) <= PDF_HISTORY_MAX_BYTES)
  assert.deepEqual(undo, initialUndo)
  assert.deepEqual(redo, [state, state, 'newest'])
  assert.equal(initialRedo.length, 4)
  for (let index = 0; index < 12; index++) {
    if (undo.length) { redo.push(undo.pop()); ({ undo, redo } = trimHistoryBudget(undo, redo, 'redo')) }
    if (redo.length) { undo.push(redo.pop()); ({ undo, redo } = trimHistoryBudget(undo, redo, 'undo')) }
    assert.ok(undo.length + redo.length <= PDF_HISTORY_MAX_ENTRIES)
    assert.ok(historyBytes(undo) + historyBytes(redo) <= PDF_HISTORY_MAX_BYTES)
  }
})

test('20–40 MiB PDF edits retain a usable undo and redo snapshot above the soft string budget', () => {
  for (const sizeMiB of [20, 32, 40]) {
    const bytes = sizeMiB * 1024 * 1024
    const length = Math.ceil(bytes / 3) * 4, padding = (3 - bytes % 3) % 3
    const snapshot = marker => marker + 'A'.repeat(length - 4 - padding) + '='.repeat(padding)
    const original = snapshot('AAAA'), edited = snapshot('BAAA')
    assert.ok(historyBytes([original]) > PDF_HISTORY_MAX_BYTES)
    let current = edited, undo = appendHistory(['older state'], original), redo = []
    assert.deepEqual(undo, [original])
    // Follow PdfEditor's actual restore order: take the target, append the
    // current document to the opposite stack, then apply their shared budget.
    for (let cycle = 0; cycle < 3; cycle++) {
      const beforeUndo = current
      current = undo.at(-1)
      undo = undo.slice(0, -1)
      redo = appendHistory(redo, beforeUndo)
      ;({ undo, redo } = trimHistoryBudget(undo, redo, 'redo'))
      assert.equal(current, original)
      assert.deepEqual({ undo, redo }, { undo: [], redo: [edited] })
      const beforeRedo = current
      current = redo.at(-1)
      redo = redo.slice(0, -1)
      undo = appendHistory(undo, beforeRedo)
      ;({ undo, redo } = trimHistoryBudget(undo, redo, 'undo'))
      assert.equal(current, edited)
      assert.deepEqual({ undo, redo }, { undo: [original], redo: [] })
    }
    assert.deepEqual(appendHistory(undo, edited, 0), [])
  }
})

test('a lone oversized preferred snapshot evicts all farther undo and redo states', () => {
  const oversized = 'A'.repeat(PDF_HISTORY_MAX_BYTES / 2 + 4)
  assert.deepEqual(trimHistoryBudget(['old', oversized], ['redo'], 'undo'), { undo: [oversized], redo: [] })
  assert.deepEqual(trimHistoryBudget(['undo'], ['old', oversized], 'redo'), { undo: [], redo: [oversized] })
  assert.deepEqual(trimHistoryBudget([oversized], [], 'redo'), { undo: [oversized], redo: [] })
  assert.deepEqual(trimHistoryBudget([], [], 'undo'), { undo: [], redo: [] })
})

test('switching between large and small PDF states keeps the immediately reversible document', () => {
  const large = 'A'.repeat(PDF_HISTORY_MAX_BYTES / 2 + 4), small = 'c21hbGw='
  for (const [original, edited] of [[large, small], [small, large]]) {
    let undo = appendHistory(['older'], original), redo = []
    const restored = undo.at(-1)
    ;({ undo, redo } = trimHistoryBudget(undo.slice(0, -1), appendHistory(redo, edited), 'redo'))
    assert.equal(restored, original)
    assert.deepEqual(redo, [edited])
    const redone = redo.at(-1)
    ;({ undo, redo } = trimHistoryBudget(appendHistory(undo, restored), redo.slice(0, -1), 'undo'))
    assert.equal(redone, edited)
    assert.equal(undo.at(-1), original)
    assert.ok(historyBytes(undo) <= PDF_HISTORY_MAX_BYTES || undo.length === 1)
  }
  assert.deepEqual(appendHistory([large], small), [small])
  assert.deepEqual(appendHistory([small], large, 8, 0), [large])
})
