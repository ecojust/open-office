import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { createDocument, validateScene, parseDocument, serializeDocument, contentKey } from '../src/workflow/core/documents.ts'
import { WorkflowSession } from '../src/workflow/session.ts'
import { center, edgePoints, elementBounds, localShapeOutline, normalizedRotation, outlineDistance, rotatePoint, shapeAnchor, shapeContainsPoint, shapeCorners, shapeOutline } from '../src/workflow/core/geometry.ts'
import { canTransformSelection, rotateSelection, scaleSelection, selectionBounds, selectionScaleAnchor, selectionScaleFactor } from '../src/workflow/core/transforms.ts'
import { expandedSelection, frameContents, groupElements, hitTestElement, ungroupElements } from '../src/workflow/core/board-tools.ts'
import { findBindingTarget } from '../src/workflow/core/binding.ts'
import { elementToSvg, sceneToSvg } from '../src/workflow/core/svg.ts'

const shape = (id, extra = {}) => ({ id, type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 100, height: 20, text: '', style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const stroke = (id, points, extra = {}) => ({ id, type: 'stroke', points, style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const edge = (id, from, to, extra = {}) => ({ id, type: 'edge', from, to, route: 'straight', arrow: 'end', label: '', style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const scene = (...elements) => ({ elements, background: '#ffffff', grid: false })
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const closePoint = (actual, expected) => { close(actual.x, expected.x); close(actual.y, expected.y) }

test('rotation is optional, normalized, saved and part of exact history receipts', () => {
  const original = { ...createDocument('board'), scene: scene(shape('a')) }
  const explicitZero = structuredClone(original); explicitZero.scene.elements[0].rotation = 360
  assert.equal(contentKey(original), contentKey(explicitZero))
  assert.equal(Object.hasOwn(parseDocument(serializeDocument(explicitZero)).scene.elements[0], 'rotation'), false)
  for (const bad of [NaN, Infinity, -Infinity, null, '5']) assert.throws(() => validateScene(scene(shape('a', { rotation: bad }))), /旋转|数值/)
  const session = new WorkflowSession(original)
  session.change(doc => { doc.scene = rotateSelection(doc.scene, ['a']) })
  assert.equal(session.model.scene.elements[0].rotation, 5)
  const exported = session.export(); session.markSaved(exported.bytes)
  assert.equal(session.inspect().dirty, false)
  assert.equal(parseDocument(new TextDecoder().decode(exported.bytes)).scene.elements[0].rotation, 5)
  session.undo(); assert.equal(session.model.scene.elements[0].rotation, undefined); assert.equal(session.inspect().dirty, true)
  session.redo(); assert.equal(session.inspect().dirty, false)
  assert.equal(normalizedRotation(-5), 355)
  assert.equal(validateScene(scene(shape('a', { rotation: 725 }))).elements[0].rotation, 5)
})

test('rotated bounds, outlines, hit tests and binding agree outside the old unrotated box', () => {
  const node = shape('a', { rotation: 90 }), drawing = scene(node)
  const bounds = elementBounds(node)
  close(bounds.x, 40); close(bounds.y, -40); close(bounds.width, 20); close(bounds.height, 100)
  closePoint(shapeOutline(node)[0], { x: 60, y: -40 })
  assert.deepEqual(localShapeOutline(node)[0], { x: 0, y: 0 })
  assert.equal(shapeContainsPoint(node, { x: 50, y: -30 }), true)
  assert.equal(shapeContainsPoint(node, { x: 5, y: 10 }), false)
  close(outlineDistance(node, { x: 65, y: 10 }), 5)
  closePoint(shapeAnchor(node, { x: 50, y: -100 }), { x: 50, y: -40 })
  assert.equal(hitTestElement(drawing, { x: 50, y: -30 }, 1)?.id, 'a')
  assert.equal(findBindingTarget(drawing, { x: 50, y: -30 }, 1)?.id, 'a')
  assert.equal(findBindingTarget(drawing, { x: 50, y: -55 }, 1), undefined)
})

test('curved shapes use inverse local coordinates for containment, distances and anchors', () => {
  for (const node of [shape('round', { rotation: 37, cornerRadius: 8 }), shape('ellipse', { shape: 'ellipse', rotation: 73 }), shape('brace', { shape: 'brace-left', rotation: 43, width: 80, height: 160 })]) {
    const unrotated = { ...node, rotation: 0 }, pivot = center(node), local = { x: node.x + 4, y: node.y + 5 }, world = rotatePoint(local, pivot, node.rotation)
    assert.equal(shapeContainsPoint(node, world), shapeContainsPoint(unrotated, local))
    close(outlineDistance(node, world), outlineDistance(unrotated, local))
    const toward = { x: node.x - 100, y: node.y - 70 }
    closePoint(shapeAnchor(node, rotatePoint(toward, pivot, node.rotation)), rotatePoint(shapeAnchor(unrotated, toward), pivot, node.rotation))
  }
})

test('SVG applies one rotation to each entire shape, including labels, image and sketch', () => {
  for (const node of [shape('a', { text: '旋转文字', rotation: 90 }), shape('b', { shape: 'triangle', rotation: 90 }), shape('c', { shape: 'rectangle', rotation: 90, style: { ...DEFAULT_STYLE, roughness: 'sketch' } }), shape('d', { shape: 'image', rotation: 90, imageData: 'data:image/png;base64,iVBORw0KGgo=' })]) {
    const markup = elementToSvg(node, scene(node), true)
    assert.equal((markup.match(/transform="rotate\(/g) ?? []).length, 1)
    assert.ok(markup.startsWith('<g transform="rotate(90 50 10)">'))
    if (node.text) assert.ok(markup.includes('旋转文字'))
    if (node.shape === 'image') assert.ok(markup.includes('<image x="0" y="0" width="100" height="20"'))
    if (node.shape === 'triangle') assert.ok(markup.includes('M50 0 L100 20 L0 20'))
  }
  const viewBox = /viewBox="([^"]+)"/.exec(sceneToSvg(scene(shape('a', { rotation: 90 }))))[1].split(' ').map(Number)
  close(viewBox[0], 8); close(viewBox[1], -72); close(viewBox[2], 84); close(viewBox[3], 164)
})

test('group transforms are rigid, selection is explicit and locked members prevent partial changes', () => {
  const original = scene(shape('a'), shape('b', { x: 200, y: 80, width: 60, height: 80 }))
  const grouped = groupElements(original, ['a', 'b']), ids = expandedSelection(grouped, ['a'])
  assert.deepEqual(ids, ['a', 'b'])
  const transformed = rotateSelection(grouped, ids, 90), bounds = selectionBounds(grouped, ids), pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  for (let i = 0; i < 2; i++) { closePoint(center(transformed.elements[i]), rotatePoint(center(grouped.elements[i]), pivot, 90)); assert.equal(transformed.elements[i].rotation, 90); assert.equal(transformed.elements[i].groupId, grouped.elements[i].groupId) }
  assert.equal(rotateSelection(grouped, ['a']).elements[1], grouped.elements[1], 'Alt-selected member does not change its sibling')
  const locked = structuredClone(grouped); locked.elements[1].locked = true
  assert.equal(canTransformSelection(locked, ['a']), false)
  assert.equal(rotateSelection(locked, ['a']), locked)
  assert.equal(scaleSelection(locked, ['a'], { x: 0, y: 0 }, 2), locked)
  const ungrouped = ungroupElements(transformed, ids)
  assert.ok(ungrouped.elements.every(element => !element.groupId))
  assert.equal(ungrouped.elements[0].rotation, 90)
  assert.equal(canTransformSelection(original, ['missing', 'a']), false)
})

test('72 five-degree rotations return a mixed group to its original geometry without mutation', () => {
  const original = scene(shape('a', { x: 12, y: 47 }), shape('b', { x: 230, y: 137, width: 71, height: 53, rotation: 35 }), stroke('ink', [{ x: 150, y: 130 }, { x: 170, y: 240 }, { x: 80, y: 167 }]))
  const snapshot = structuredClone(original), ids = original.elements.map(element => element.id)
  let current = original
  for (let i = 0; i < 72; i++) current = rotateSelection(current, ids)
  current.elements.forEach((element, index) => {
    const before = original.elements[index]
    if (element.type === 'shape') { closePoint(element, before); assert.equal(element.rotation ?? 0, before.rotation ?? 0); assert.equal(element.width, before.width); assert.equal(element.height, before.height) }
    else element.points.forEach((point, i) => closePoint(point, before.points[i]))
  })
  assert.deepEqual(original, snapshot)
})

test('all four corners scale rotated shapes and strokes about the fixed opposite corner', () => {
  const original = scene(shape('a', { x: 20, y: 30, rotation: 35, cornerRadius: 8 }), stroke('ink', [{ x: 180, y: 10 }, { x: 230, y: 80 }], { brush: 'pen', pressures: [.2, .8] }))
  const ids = ['a', 'ink'], bounds = selectionBounds(original, ids)
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const anchor = selectionScaleAnchor(bounds, corner)
    const at = { x: corner.includes('w') ? bounds.x : bounds.x + bounds.width, y: corner.includes('n') ? bounds.y : bounds.y + bounds.height }
    const pointer = { x: anchor.x + (at.x - anchor.x) * 1.8, y: anchor.y + (at.y - anchor.y) * 1.8 }
    close(selectionScaleFactor(bounds, corner, pointer), 1.8)
    const result = scaleSelection(original, ids, anchor, 1.8), node = result.elements[0], ink = result.elements[1]
    closePoint(node, { x: anchor.x + (20 - anchor.x) * 1.8, y: anchor.y + (30 - anchor.y) * 1.8 })
    close(node.width, 180); close(node.height, 36); close(node.cornerRadius, 14.4)
    assert.equal(node.rotation, 35); close(node.style.fontSize, 28.8); close(ink.style.strokeWidth, 3.6)
    assert.deepEqual(ink.pressures, [.2, .8])
    const after = selectionBounds(result, ids)
    close(after.width, bounds.width * 1.8); close(after.height, bounds.height * 1.8)
    closePoint(selectionScaleAnchor(after, corner), anchor)
    assert.ok(selectionScaleFactor(bounds, corner, { x: anchor.x - (at.x - anchor.x), y: anchor.y - (at.y - anchor.y) }) > 0)
  }
})

test('bound connectors follow transformed nodes once and selected outside endpoints detach', () => {
  const a = shape('a'), b = shape('b', { x: 200 }), outside = shape('outside', { x: 400, y: 80 })
  const internal = edge('internal', { x: 0, y: 0, nodeId: 'a' }, { x: 0, y: 0, nodeId: 'b' })
  const external = edge('external', { x: 0, y: 0, nodeId: 'a' }, { x: 0, y: 0, nodeId: 'outside' })
  const original = scene(a, b, outside, internal, external), points = edgePoints(internal, original)
  const scaled = scaleSelection(original, ['a', 'b', 'internal'], { x: 0, y: 0 }, 2)
  const scaledPoints = edgePoints(scaled.elements[3], scaled)
  scaledPoints.forEach((point, i) => closePoint(point, { x: points[i].x * 2, y: points[i].y * 2 }))
  assert.equal(scaled.elements[3].from.nodeId, 'a'); assert.equal(scaled.elements[3].to.nodeId, 'b')
  assert.equal(scaled.elements[4], external); assert.notDeepEqual(edgePoints(external, scaled), edgePoints(external, original))
  const selected = ['a', 'external'], bounds = selectionBounds(original, selected), pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const rendered = edgePoints(external, original), rotated = rotateSelection(original, selected, 5), connector = rotated.elements[4]
  assert.equal(connector.from.nodeId, 'a'); assert.equal(connector.to.nodeId, undefined)
  closePoint(connector.to, rotatePoint(rendered[1], pivot, 5))
  assert.equal(rotated.elements[2], outside)
})

test('scale limits apply to the entire selection and invalid transforms preserve the source', () => {
  const original = scene(shape('a', { style: { ...DEFAULT_STYLE, fontSize: 400 } }), shape('b', { x: 200, width: 200 }))
  const enlarged = scaleSelection(original, ['a', 'b'], { x: 0, y: 0 }, 100)
  close(enlarged.elements[0].width, 125); close(enlarged.elements[1].width, 250)
  assert.equal(enlarged.elements[0].style.fontSize, 500)
  validateScene(enlarged)
  const reduced = scaleSelection(original, ['a', 'b'], { x: 0, y: 0 }, 1e-20)
  validateScene(reduced); assert.ok(reduced.elements[1].style.fontSize >= 1)
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) assert.throws(() => scaleSelection(original, ['a'], { x: 0, y: 0 }, bad), /数值/)
  assert.throws(() => scaleSelection(original, ['a'], { x: Infinity, y: 0 }, 2), /数值/)
  assert.throws(() => rotateSelection(original, ['a'], NaN), /数值/)
  const extreme = scene(stroke('ink', [{ x: -1e6, y: -1e6 }, { x: 1e6, y: 1e6 }]))
  const snapshot = structuredClone(extreme)
  assert.throws(() => rotateSelection(extreme, ['ink'], 45), /范围/)
  assert.deepEqual(extreme, snapshot)
  assert.equal(scaleSelection(original, ['a'], { x: 0, y: 0 }, 1), original)
  assert.equal(rotateSelection(original, ['a'], 360), original)
})

test('rotated frames hit their rotated header and capture only fully enclosed contents', () => {
  const frame = shape('frame', { shape: 'frame', width: 100, height: 80, rotation: 45 }), pivot = center(frame)
  const localChild = shape('inside', { x: 25, y: 30, width: 20, height: 15 })
  const childCenter = rotatePoint(center(localChild), pivot, 45)
  const inside = { ...localChild, x: childCenter.x - 10, y: childCenter.y - 7.5, rotation: 45 }
  const outside = shape('outside', { x: -8, y: -18, width: 2, height: 2 })
  const drawing = scene(frame, inside, outside)
  assert.deepEqual(frameContents(drawing, 'frame'), ['inside'])
  assert.equal(hitTestElement(scene(frame), rotatePoint({ x: 50, y: 5 }, pivot, 45), 1)?.id, 'frame')
  assert.equal(hitTestElement(scene(frame), rotatePoint({ x: 50, y: 60 }, pivot, 45), 1), undefined)
  assert.equal(shapeCorners(inside).length, 4)
})
