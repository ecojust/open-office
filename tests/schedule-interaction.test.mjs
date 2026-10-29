import test from 'node:test'
import assert from 'node:assert/strict'
import { eventPointerAction, eventResizeInsets } from '../src/schedule/interaction.ts'

test('unselected button borders and generous inner edges immediately select resize actions', () => {
 for (const [width, height] of [[30, 33], [58, 47], [186, 94], [700, 318]]) {
  assert.equal(eventPointerAction(width, height, .5, height / 2), 'start')
  assert.equal(eventPointerAction(width, height, width - .5, height / 2), 'end')
  assert.equal(eventPointerAction(width, height, width / 2, height - .5), 'height')
  const insets = eventResizeInsets(width, height)
  assert.equal(eventPointerAction(width, height, insets.side - .5, height / 2), 'start')
  assert.equal(eventPointerAction(width, height, width - insets.side + .5, height / 2), 'end')
  assert.equal(eventPointerAction(width, height, width / 2, height - insets.bottom + .5), 'height')
 }
})

test('minimum-size one-day half blocks retain a 12-pixel-wide central move region', () => {
 assert.deepEqual(eventResizeInsets(30, 33), { side: 9, bottom: 9.5 })
 for (const x of [9.1, 12, 15, 18, 20.9]) for (const y of [1, 10, 16.5, 23]) assert.equal(eventPointerAction(30, 33, x, y), 'move')
 assert.equal(eventPointerAction(30, 33, 15, 24), 'height')
})

test('date resize wins at lower corners while the bottom middle changes height', () => {
 assert.equal(eventPointerAction(186, 94, 1, 93), 'start')
 assert.equal(eventPointerAction(186, 94, 185, 93), 'end')
 assert.equal(eventPointerAction(186, 94, 93, 93), 'height')
 assert.equal(eventPointerAction(186, 94, 93, 1), 'move')
})

test('invalid event geometry cannot accidentally start resize', () => {
 for (const geometry of [[0, 33, 0, 0], [30, 0, 0, 0], [NaN, 33, 1, 1], [30, 33, Infinity, 1], [30, 33, 1, NaN]]) assert.equal(eventPointerAction(...geometry), 'move')
})
