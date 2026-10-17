import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser as XmlParser } from '@xmldom/xmldom'
import { createDocument, parseDocument, serializeDocument, contentKey, validateScene } from '../src/workflow/core/documents.ts'
import { rectangleCornerRadius, shapeContainsPoint, shapeAnchor, outlineDistance } from '../src/workflow/core/geometry.ts'
import { elementToSvg } from '../src/workflow/core/svg.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { WorkflowSession } from '../src/workflow/session.ts'
import { importGraphXml, exportGraphXml } from '../src/workflow/formats/graph-xml.ts'
import { importBoardJson, exportBoardJson } from '../src/workflow/formats/board-json.ts'

globalThis.DOMParser = class {
  parseFromString(value, mime) {
    return new XmlParser({ onError(_level, message) { throw new Error(message) } }).parseFromString(value, mime)
  }
}
const rectangle = (extra = {}) => ({ id: 'rectangle', type: 'shape', shape: 'rectangle', x: 20, y: 40, width: 200, height: 100, text: '', style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const scene = node => ({ background: '#ffffff', grid: false, elements: [node] })
const document = node => ({ ...createDocument('board'), scene: scene(node) })
const xml = value => new XmlParser().parseFromString(value, 'image/svg+xml')

test('legacy rectangles and explicit zero remain square and have the same saved identity', () => {
  const legacy = document(rectangle()), explicit = structuredClone(legacy)
  explicit.scene.elements[0].cornerRadius = 0
  assert.equal(contentKey(explicit), contentKey(legacy))
  assert.equal(Object.hasOwn(parseDocument(serializeDocument(explicit)).scene.elements[0], 'cornerRadius'), false)
  const markup = xml(elementToSvg(legacy.scene.elements[0], legacy.scene)).getElementsByTagName('rect')[0]
  assert.equal(Number(markup.getAttribute('rx')), 0)
  assert.equal(Number(markup.getAttribute('ry')), 0)
  assert.equal(shapeContainsPoint(legacy.scene.elements[0], { x: 21, y: 41 }), true)
})

test('radius-only edits dirty the document and participate in save receipts, undo and redo', () => {
  const session = new WorkflowSession(document(rectangle()))
  const key = contentKey(session.model)
  assert.equal(session.change(doc => { doc.scene.elements[0].cornerRadius = 24.5 }), true)
  assert.notEqual(contentKey(session.model), key)
  assert.equal(session.inspect().dirty, true)
  const output = session.export()
  assert.equal(parseDocument(new TextDecoder().decode(output.bytes)).scene.elements[0].cornerRadius, 24.5)
  session.markSaved(output.bytes)
  assert.equal(session.inspect().dirty, false)
  assert.equal(session.undo(), true)
  assert.equal(session.model.scene.elements[0].cornerRadius ?? 0, 0)
  assert.equal(session.inspect().dirty, true)
  assert.equal(session.redo(), true)
  assert.equal(session.model.scene.elements[0].cornerRadius, 24.5)
  assert.equal(session.inspect().dirty, false)
})

test('native validation rejects malformed radii before saving and ignores unrelated shapes', () => {
  for (const cornerRadius of [-1, NaN, Infinity, -Infinity, '12', null]) {
    assert.throws(() => validateScene(scene(rectangle({ cornerRadius }))), /数值|圆角/, String(cornerRadius))
    assert.throws(() => serializeDocument(document(rectangle({ cornerRadius }))), /数值|圆角/, String(cornerRadius))
  }
  for (const shape of ['ellipse', 'diamond', 'note', 'text', 'frame']) {
    const node = rectangle({ shape, cornerRadius: 30 })
    assert.equal(Object.hasOwn(validateScene(scene(node)).elements[0], 'cornerRadius'), false)
    assert.equal(rectangleCornerRadius(node), 0)
    const before = document(node), after = structuredClone(before)
    delete after.scene.elements[0].cornerRadius
    assert.equal(contentKey(before), contentKey(after))
  }
})

test('oversized radii are limited for drawing without losing the saved setting after resize', () => {
  const doc = parseDocument(serializeDocument(document(rectangle({ cornerRadius: 120 }))))
  const node = doc.scene.elements[0]
  assert.equal(node.cornerRadius, 120)
  assert.equal(rectangleCornerRadius(node), 50)
  node.height = 40
  assert.equal(rectangleCornerRadius(node), 20)
  node.width = 400; node.height = 300
  assert.equal(rectangleCornerRadius(node), 120)
  const markup = xml(elementToSvg(node, doc.scene)).getElementsByTagName('rect')[0]
  assert.equal(Number(markup.getAttribute('rx')), 120)
  assert.equal(Number(markup.getAttribute('ry')), 120)
})

test('rounded corner hit testing and diagonal edge anchors follow the visible arc', () => {
  const node = rectangle({ x: 0, y: 0, width: 100, height: 100, cornerRadius: 30 })
  assert.equal(shapeContainsPoint(node, { x: 1, y: 1 }), false)
  assert.equal(shapeContainsPoint(node, { x: 15, y: 15 }), true)
  assert.equal(shapeContainsPoint(node, { x: 50, y: 0 }), true)
  assert.equal(shapeContainsPoint(node, { x: 50, y: -1 }), false)
  const expectedCornerDistance = Math.sqrt(30 ** 2 + 30 ** 2) - 30
  assert.ok(Math.abs(outlineDistance(node, { x: 0, y: 0 }) - expectedCornerDistance) < .15)
  const anchor = shapeAnchor(node, { x: -100, y: -100 })
  const expected = 30 - 30 / Math.sqrt(2)
  assert.ok(Math.abs(anchor.x - expected) < .1)
  assert.ok(Math.abs(anchor.y - expected) < .1)
  assert.deepEqual(shapeAnchor(node, { x: 150, y: 50 }), { x: 100, y: 50 })
})

test('clean and hand-drawn rectangle renderings both change with the corner setting', () => {
  for (const roughness of ['clean', 'sketch']) {
    const square = rectangle({ style: { ...DEFAULT_STYLE, roughness } })
    const rounded = { ...square, cornerRadius: 30 }
    const squareSvg = elementToSvg(square, scene(square)), roundedSvg = elementToSvg(rounded, scene(rounded))
    assert.notEqual(roundedSvg, squareSvg)
    assert.ok(!/NaN|Infinity/.test(roundedSvg))
    assert.equal(shapeContainsPoint(rounded, { x: 21, y: 41 }), false)
    assert.equal(shapeContainsPoint(rounded, { x: 120, y: 90 }), true)
  }
})

test('both interchange formats retain exact native radius settings for reopening', () => {
  for (const radius of [undefined, 0, 18.25, 120]) {
    const original = validateScene(scene(rectangle(radius === undefined ? {} : { cornerRadius: radius })))
    const graph = exportGraphXml(original, '圆角矩形'), board = exportBoardJson(original)
    for (const imported of [importGraphXml(graph)[0].scene, importBoardJson(board).scene]) {
      assert.deepEqual(validateScene(imported), original)
    }
    if (radius > 0) {
      assert.match(graph, /rounded=1/)
      const external = JSON.parse(board).elements.find(element => element.id === 'rectangle')
      assert.ok(external.roundness, 'External readers receive a compatible roundness hint')
    }
  }
})
