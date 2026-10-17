import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasPoint, NOTE_GRID_SIZE, snapRegionPosition } from '../src/notes/snapping.ts'

const moving = { id: 'moving', x: 24, y: 24, width: 100, height: 80 }
const target = { id: 'target', x: 203, y: 157, width: 160, height: 120 }
const options = { align: true, grid: true }

test('grid uses document coordinates and leaves source geometry unchanged', () => {
 const before = structuredClone(moving)
 const result = snapRegionPosition(moving, { x: 47, y: 84 }, [], options)
 assert.equal(NOTE_GRID_SIZE, 10)
 assert.equal(result.x, 50); assert.equal(result.y, 80); assert.deepEqual(result.guides, [])
 assert.deepEqual(moving, before)
})

test('nearby block edges override the grid and expose only the aligned axis', () => {
 const result = snapRegionPosition(moving, { x: 207, y: 400 }, [target], options)
 assert.equal(result.x, 203); assert.equal(result.y, 400)
 assert.deepEqual(result.guides, [{ axis: 'x', position: 203, start: 149, end: 488, targetId: 'target' }])
})

test('different-sized regions align their centres and bottom edges using measured dimensions', () => {
 const result = snapRegionPosition(moving, { x: 236, y: 194 }, [target], options)
 assert.equal(result.x + moving.width / 2, target.x + target.width / 2)
 assert.equal(result.y + moving.height, target.y + target.height)
 assert.equal(result.state.x.movingAnchor, 0.5); assert.equal(result.state.x.targetAnchor, 0.5)
 assert.equal(result.state.y.movingAnchor, 1); assert.equal(result.state.y.targetAnchor, 1)
 assert.equal(result.guides.length, 2)
})

test('capture tolerance remains six screen pixels at different zoom levels', () => {
 const position = { x: 207, y: 400 }
 const normal = snapRegionPosition(moving, position, [target], { align: true, grid: false, zoom: 1 })
 const enlarged = snapRegionPosition(moving, position, [target], { align: true, grid: false, zoom: 2 })
 assert.equal(normal.x, 203); assert.equal(enlarged.x, 207); assert.deepEqual(enlarged.guides, [])
 const reduced = snapRegionPosition(moving, { x: 213, y: 400 }, [target], { align: true, grid: false, zoom: 0.5 })
 assert.equal(reduced.x, 203)
})

test('acquired guide survives small jitter and neighbour reordering then releases beyond nine screen pixels', () => {
 const neighbour = { ...target, id: 'other', x: 209 }
 const first = snapRegionPosition(moving, { x: 204, y: 400 }, [target, neighbour], options)
 assert.equal(first.state.x.id, 'target')
 const sticky = snapRegionPosition(moving, { x: 211, y: 400 }, [neighbour, target], { ...options, previous: first.state })
 assert.equal(sticky.x, 203); assert.equal(sticky.state.x.id, 'target')
 const released = snapRegionPosition(moving, { x: 213, y: 400 }, [neighbour, target], { ...options, previous: sticky.state })
 assert.equal(released.x, 209); assert.equal(released.state.x.id, 'other')
})

test('equal candidates resolve consistently regardless of document order', () => {
 const one = { ...target, id: 'a', x: 203 }, two = { ...target, id: 'b', x: 207 }
 const a = snapRegionPosition(moving, { x: 205, y: 400 }, [one, two], options)
 const b = snapRegionPosition(moving, { x: 205, y: 400 }, [two, one], options)
 assert.deepEqual(a, b); assert.equal(a.state.x.id, 'a')
})

test('the moving region never snaps to its own starting edges', () => {
 const result = snapRegionPosition(moving, { x: 26, y: 26 }, [moving], { align: true, grid: false })
 assert.equal(result.x, 26); assert.equal(result.y, 26); assert.deepEqual(result.guides, [])
})

test('free placement and Alt bypass skip both snapping modes and clear old guides', () => {
 const prior = snapRegionPosition(moving, { x: 207, y: 194 }, [target], options)
 for (const settings of [{ align: false, grid: false }, { ...options, previous: prior.state, bypass: true }]) {
  const result = snapRegionPosition(moving, { x: 207.25, y: 194.5 }, [target], settings)
  assert.equal(result.x, 207.25); assert.equal(result.y, 194.5)
  assert.deepEqual(result.state, {}); assert.deepEqual(result.guides, [])
 }
})

test('canvas bounds win over grid rounding and invalid alignment candidates', () => {
 const large = { ...moving, width: 103, height: 87 }
 const result = snapRegionPosition(large, { x: 40000, y: 40000 }, [], options)
 assert.equal(result.x, 19897); assert.equal(result.y, 19913)
 const outside = snapRegionPosition(moving, { x: -20, y: -20 }, [{ ...target, x: -3, y: -3 }], { align: true, grid: false })
 assert.equal(outside.x, 0); assert.equal(outside.y, 0); assert.deepEqual(outside.guides, [])
})

test('pointer conversion compensates zoom and a moving scroll origin', () => {
 const before = canvasPoint({ x: 260, y: 180 }, { left: 60, top: 80 }, 2)
 const scrolled = canvasPoint({ x: 280, y: 200 }, { left: 20, top: 40 }, 2)
 assert.deepEqual(before, { x: 100, y: 50 })
 assert.deepEqual(scrolled, { x: 130, y: 80 })
 assert.deepEqual(canvasPoint({ x: 20, y: 30 }, { left: 10, top: 10 }, 0), { x: 10, y: 20 })
})
