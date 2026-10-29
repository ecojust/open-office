import test from 'node:test'
import assert from 'node:assert/strict'
import { clampDayWidth, wheelDayWidth, zoomAnchorScroll } from '../src/schedule/zoom.ts'
import { getEventVerticalLayout } from '../src/schedule/layout.ts'

test('day width stays bounded for wheel extremes and retains trackpad precision', () => {
 assert.equal(clampDayWidth(0), 36)
 assert.equal(clampDayWidth(999), 160)
 assert.equal(clampDayWidth(NaN), 64)
 assert.equal(clampDayWidth(64.1234), 64.12)
 assert.equal(wheelDayWidth(64, -10000, 0, 700), 160)
 assert.equal(wheelDayWidth(64, 10000, 0, 700), 36)
 assert.equal(wheelDayWidth(64, 0, 0, 700), 64)
 assert.equal(wheelDayWidth(64, Infinity, 0, 700), 64)
 assert.ok(wheelDayWidth(64, -.5, 0, 700) > 64)
})

test('pixel, line and page wheel deltas normalize to the same physical movement', () => {
 const pixel = wheelDayWidth(88, 48, 0, 800)
 assert.equal(wheelDayWidth(88, 3, 1, 800), pixel)
 assert.equal(wheelDayWidth(88, .06, 2, 800), pixel)
 assert.equal(wheelDayWidth(88, -.06, 2, 800), wheelDayWidth(88, -48, 0, 800))
})

test('zoom keeps the exact fractional date under different pointer anchors away from edges', () => {
 for (const old of [44, 64, 88, 127.5]) for (const next of [36, 56.25, 100, 160]) for (const anchor of [0, 73, 400, 760]) {
  const scroll = zoomAnchorScroll(old, next, 3600, anchor, 760, 180)
  assert.ok(Math.abs((scroll + anchor) / next - (3600 + anchor) / old) < 1e-10)
 }
})

test('rapid wheel events accumulate from the preceding logical width and scroll without drift', () => {
 const anchor = 350, originalDate = (640 + anchor) / 64
 let width = 64, scroll = 640
 for (const delta of [-2, -4, -8, -12, 3, 7, -20, 10, 5, 4]) {
  const next = wheelDayWidth(width, delta, 0, 600)
  scroll = zoomAnchorScroll(width, next, scroll, anchor, 760, 150)
  width = next
  assert.ok(Math.abs((scroll + anchor) / width - originalDate) < 1e-10)
 }
})

test('scroll edges and a calendar smaller than the viewport clamp instead of leaving blank space', () => {
 assert.equal(zoomAnchorScroll(160, 36, 0, 500, 760, 30), 0)
 assert.equal(zoomAnchorScroll(36, 160, 320, 760, 760, 30), 4040)
 assert.equal(zoomAnchorScroll(64, 36, 1000, 400, 760, 4), 0)
 assert.equal(zoomAnchorScroll(64, 160, 0, 400, 760, 0), 0)
 assert.equal(zoomAnchorScroll(64, 88, 100, -192, 760, 100), zoomAnchorScroll(64, 88, 100, 0, 760, 100))
})

test('morning and afternoon occupy matching halves at every permitted track height', () => {
 for (let height = 84; height <= 336; height += 28) {
  const full = getEventVerticalLayout(height, { height: 1, slot: 0 })
  const morning = getEventVerticalLayout(height, { height: .5, slot: 0 })
  const afternoon = getEventVerticalLayout(height, { height: .5, slot: 1 })
  assert.equal(full.top, 9)
  assert.equal(full.height, height - 18)
  assert.equal(morning.top, 9)
  assert.equal(morning.height, afternoon.height)
  assert.equal(morning.top + morning.height, afternoon.top)
  assert.equal(afternoon.top + afternoon.height, height - 9)
 }
})
