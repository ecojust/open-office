import test from 'node:test'
import assert from 'node:assert/strict'
import { blankRegion, NOTE_MAX_CANVAS, NOTE_MIN_REGION_WIDTH, NOTE_MIN_REGION_HEIGHT } from '../src/notes/model.ts'
import { moveRegion, nextRegionPosition, resizeRegion } from '../src/notes/layout.ts'

const image = () => ({ id:'image_region', x:24, y:24, width:320, height:180, blocks:[{id:'image_block',type:'image',dataUrl:'',alt:''}] })

test('region moves clamp to the canvas and leave the source and every other region untouched', () => {
 const original = image(), before = structuredClone(original)
 assert.deepEqual(moveRegion(original, -100, -100), { ...original, x:0, y:0 })
 assert.deepEqual(moveRegion(original, 40000, 40000), { ...original, x:19680, y:19820 })
 assert.deepEqual(original, before)
})

test('image resize preserves proportions and obeys both minimum dimensions and canvas edges', () => {
 for (const original of [image(), {...image(),width:80,height:900}, {...image(),x:19000.3,y:19500.2,width:320,height:180}]) {
  const ratio = original.height / original.width
  for (const delta of [-40000,-20,20,40000]) {
   const result = resizeRegion(original, delta)
   assert.ok(result.width >= NOTE_MIN_REGION_WIDTH)
   assert.ok(result.height >= NOTE_MIN_REGION_HEIGHT)
   assert.ok(result.x + result.width <= NOTE_MAX_CANVAS)
   assert.ok(result.y + result.height <= NOTE_MAX_CANVAS)
   assert.ok(Math.abs(result.height / result.width - ratio) < 1e-10)
   assert.equal(result.x, original.x); assert.equal(result.y, original.y)
  }
 }
})

test('resizing a text region changes its chosen line width without moving it or neighboring content', () => {
 const original = blankRegion(200, 100), neighbor = blankRegion(700, 100)
 const copy = structuredClone(neighbor), changed = resizeRegion(original, 120)
 assert.equal(changed.width, 600); assert.equal(changed.height, undefined)
 assert.equal(changed.x, 200); assert.equal(changed.y, 100); assert.deepEqual(neighbor, copy)
 assert.equal(resizeRegion(original,-900).width,80)
})

test('new regions are placed below measured text content and explicit image dimensions', () => {
 const first = blankRegion(24,24), second = {...image(),y:140}
 assert.deepEqual(nextRegionPosition([]),{x:24,y:48})
 assert.deepEqual(nextRegionPosition([first,second],new Map([[first.id,900]])),{x:24,y:972})
 assert.deepEqual(nextRegionPosition([{...second,y:19820}]),{x:24,y:19520})
})
