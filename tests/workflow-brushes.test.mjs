import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { BRUSH_PRESETS, brushPreset, brushRadiusAt, brushOutlinePath, rainbowSegments, readBrushData, normalizedPressure } from '../src/workflow/core/brushes.ts'
import { createDocument, serializeDocument, parseDocument, validateScene, contentKey, DocumentHistory } from '../src/workflow/core/documents.ts'
import { elementToSvg, sceneToSvg } from '../src/workflow/core/svg.ts'
import { elementBounds } from '../src/workflow/core/geometry.ts'
import { alignElements, hitTestElement } from '../src/workflow/core/board-tools.ts'
import { exportGraphXml, importGraphXml } from '../src/workflow/formats/graph-xml.ts'
import { exportBoardJson, importBoardJson } from '../src/workflow/formats/board-json.ts'

globalThis.DOMParser ??= DOMParser
const sceneOf = (...elements) => ({ elements, background: '#ffffff', grid: false })
const stroke = (brush = 'pen', overrides = {}) => ({ id: brush, type: 'stroke', brush, points: [{ x: 20, y: 30 }, { x: 100, y: 30 }, { x: 150, y: 80 }, { x: 200, y: 30 }], pressures: [.1, .5, 1, .2], style: { ...DEFAULT_STYLE, fill: 'none', strokeWidth: 20 }, locked: false, ...overrides })
const markup = element => elementToSvg(element, sceneOf(element))
const xml = text => new DOMParser().parseFromString(`<svg>${text}</svg>`, 'image/svg+xml')

test('six brush presets have distinct real geometry and paint, with bounded positive defaults', () => {
  assert.equal(BRUSH_PRESETS.length, 6)
  const outputs = new Set()
  for (const preset of BRUSH_PRESETS) {
    assert.equal(brushPreset(preset.id), preset)
    assert.ok(preset.width > 0 && preset.width <= 100)
    const svg = markup(stroke(preset.id)); outputs.add(svg.replace(/data-brush="[^"]+"/, ''))
    assert.ok(svg.includes(`data-brush="${preset.id}"`))
    assert.ok(!/NaN|Infinity|undefined/.test(svg))
  }
  assert.equal(outputs.size, 6)
  const pencil = xml(markup(stroke('pencil')))
  assert.equal([...pencil.getElementsByTagName('path')].filter(path => path.hasAttribute('data-pencil-pass')).length, 3)
  assert.ok(pencil.getElementsByTagName('path')[0].getAttribute('d').endsWith(' Z'))
  assert.ok(markup(stroke('marker')).includes('fill-rule="evenodd"'))
  assert.ok(!brushOutlinePath(stroke('marker')).includes('A'))
  assert.ok(markup(stroke('highlighter')).includes('<g opacity=".32">'))
  assert.ok(markup(stroke('rainbow')).includes('fill="hsl('))
})

test('round caps bulge outward at both endpoints, while flat nibs retain straight caps', () => {
  const horizontal = stroke('pen', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], pressures: [.5, .5] })
  assert.equal(brushOutlinePath(horizontal), 'M0 10 L100 10 A10 10 0 0 0 100 -10 L0 -10 A10 10 0 0 0 0 10 Z')
  assert.ok(!brushOutlinePath({ ...horizontal, brush: 'marker' }).includes('A'))
})

test('pressure changes actual widths; brush tips taper and a zero-pressure sample remains visible', () => {
  for (const kind of ['pen', 'pencil', 'marker', 'brush', 'highlighter', 'rainbow']) {
    const ink = stroke(kind, { points: Array.from({ length: 20 }, (_, x) => ({ x: x * 10, y: 0 })), pressures: Array(20).fill(.2) })
    const strong = { ...ink, pressures: Array(20).fill(1) }
    assert.ok(brushRadiusAt(strong, 10) > brushRadiusAt(ink, 10))
    assert.notEqual(markup(ink), markup(strong))
    assert.ok(brushRadiusAt({ ...ink, pressures: Array(20).fill(0) }, 10) > 0)
    if (kind === 'brush') assert.ok(brushRadiusAt(ink, 0) < brushRadiusAt(ink, 10))
  }
  assert.equal(normalizedPressure(NaN), .5); assert.equal(normalizedPressure(-1), 0); assert.equal(normalizedPressure(2), 1)
})

test('a tap is visible for every brush and zero user width still produces no ink', () => {
  for (const { id } of BRUSH_PRESETS) {
    const dot = stroke(id, { points: [{ x: 10, y: 10 }], pressures: [.5] })
    const result = markup(dot)
    assert.ok(result.includes('<path') || result.includes('<circle'))
    assert.ok(!/NaN|Infinity/.test(result))
    assert.equal(markup({ ...dot, style: { ...dot.style, strokeWidth: 0 } }), '')
  }
})

test('rainbow colors follow distance through turns and backtracking with at most 96 chunks', () => {
  const ink = stroke('rainbow', { points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 120 }], pressures: [.5, .5, .5, .5] })
  const segments = rainbowSegments(ink)
  assert.ok(segments.length >= 6 && segments.length <= 96)
  assert.equal(segments[0].hue, 0)
  assert.ok(segments.at(-1).hue > 250)
  assert.ok(segments.some(segment => segment.path.includes('120 0')))
  assert.ok(segments.some(segment => segment.hue > 0 && segment.path.includes('0 0')))
  assert.ok(segments.at(-1).path.endsWith('0 120'))
})

test('brush metadata is validated strictly alongside the shared total point budget', () => {
  for (const brush of ['water', '', null, '__proto__']) assert.throws(() => validateScene(sceneOf(stroke(brush, { id: 'invalid' }))), /笔触/)
  for (const pressures of [[], [1], Array(4), [0, 1, NaN, .5], [0, 1, Infinity, .5], [0, 1, -.1, .5], [0, 1, 1.1, .5], ['0', .1, .2, .3], null]) assert.throws(() => validateScene(sceneOf(stroke('pen', { pressures }))), /压感/)
  assert.deepEqual(readBrushData(undefined, undefined, 2), {})
  const large = stroke('pen', { points: Array.from({ length: 50001 }, (_, x) => ({ x, y: 0 })), pressures: Array(50001).fill(.5) })
  assert.throws(() => validateScene(sceneOf(large, { ...large, id: 'second' })), /100000/)
})

test('native save, content identity and undo retain brush and pressure without changing old ink keys', () => {
  const doc = createDocument('board'); doc.title = 'ink'; doc.scene = sceneOf(stroke('pen', { id: 'old', brush: undefined, pressures: undefined }))
  const oldStyle = ['#334155', 'none', 20, 16, 'center', 1, 'solid', 'clean']
  const defaultStyle = ['#334155', '#ffffff', 2, 16, 'center', 1, 'solid', 'clean']
  const oldKey = JSON.stringify(['ink', 'board', '#ffffff', false, defaultStyle, [['old', 'stroke', false, oldStyle, [[20, 30], [100, 30], [150, 80], [200, 30]]]], ''])
  assert.equal(contentKey(doc), oldKey)
  assert.equal(contentKey(parseDocument(serializeDocument(doc))), oldKey)
  const history = new DocumentHistory(doc)
  doc.scene.elements[0].brush = 'brush'; doc.scene.elements[0].pressures = [.1, .2, .3, .4]
  history.commit(doc)
  const firstKey = contentKey(doc)
  assert.notEqual(firstKey, oldKey)
  doc.scene.elements[0].pressures[1] = .9; history.commit(doc)
  assert.notEqual(contentKey(doc), firstKey)
  assert.equal(contentKey(history.undo()), firstKey); assert.equal(contentKey(history.undo()), oldKey)
  assert.equal(contentKey(history.redo()), firstKey)
  const restored = parseDocument(serializeDocument(doc))
  assert.equal(contentKey(restored), contentKey(doc)); assert.deepEqual(restored.scene.elements[0], doc.scene.elements[0])
})

test('bounds and eraser hit testing include visible width and follow pressure after movement', () => {
  const ink = stroke('pen', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], pressures: [0, 1] })
  const bounds = elementBounds(ink)
  assert.equal(bounds.x, -6.5); assert.equal(bounds.y, -13.5)
  assert.equal(bounds.width, 120); assert.equal(bounds.height, 27)
  assert.equal(hitTestElement(sceneOf(ink), { x: 100, y: 17 }, 1)?.id, ink.id)
  assert.equal(hitTestElement(sceneOf(ink), { x: 0, y: 17 }, 1), undefined)
  const shape = { id: 'reference', type: 'shape', shape: 'rectangle', x: 200, y: 0, width: 100, height: 100, text: '', style: { ...DEFAULT_STYLE }, locked: true }
  const aligned = alignElements(sceneOf(ink, shape), [ink.id, shape.id], 'left').elements[0]
  assert.deepEqual(aligned.pressures, ink.pressures); assert.equal(aligned.brush, ink.brush)
  assert.equal(elementBounds(aligned).x, 200)
  assert.equal(hitTestElement(sceneOf(aligned), { x: aligned.points[1].x, y: 17 }, 1)?.id, ink.id)
})

test('compatible formats preserve six brushes and pressures with disclosed external limitations', () => {
  for (const { id } of BRUSH_PRESETS) {
    const ink = stroke(id, { locked: true, groupId: 'ink-group' })
    const graph = exportGraphXml(sceneOf(ink), 'ink'), board = exportBoardJson(sceneOf(ink))
    assert.ok(graph.includes(`openWorkflowBrush="${id}"`)); assert.ok(graph.includes('openWorkflowCompatibility='))
    assert.ok(JSON.parse(board).elements[0].customData.openWorkflow.compatibility)
    for (const imported of [importGraphXml(graph)[0], importBoardJson(board)]) {
      assert.deepEqual(imported.scene.elements[0], { ...ink, style: { ...ink.style, fill: 'transparent' } })
      assert.ok(imported.warnings.some(warning => warning.includes('笔触') && warning.includes('外部软件')))
      assert.doesNotThrow(() => validateScene(imported.scene))
    }
  }
  const closed = stroke('brush', { closed: true })
  assert.deepEqual(importBoardJson(exportBoardJson(sceneOf(closed))).scene.elements[0], { ...closed, style: { ...closed.style, fill: 'transparent' } })
  const dot = stroke('marker', { points: [{ x: 5, y: 6 }], pressures: [.8] })
  assert.deepEqual(importGraphXml(exportGraphXml(sceneOf(dot), 'dot'))[0].scene.elements[0], { ...dot, style: { ...dot.style, fill: 'transparent' } })
})

test('external pressure samples remain editable and malicious brush metadata is rejected', () => {
  const json = JSON.parse(exportBoardJson(sceneOf(stroke('pen')))); delete json.elements[0].customData
  const imported = importBoardJson(JSON.stringify(json)).scene.elements[0]
  assert.equal(imported.brush, undefined); assert.deepEqual(imported.pressures, [.1, .5, 1, .2])
  assert.ok(markup(imported).includes('data-brush="pen"'))
  json.elements[0].pressures = [1]; assert.throws(() => importBoardJson(JSON.stringify(json)), /压感/)
  const graph = exportGraphXml(sceneOf(stroke('pen')), 'ink')
  assert.throws(() => importGraphXml(graph.replace('openWorkflowBrush="pen"', 'openWorkflowBrush="unknown"')), /笔触/)
  const unsafe = stroke('pen', { id: '"><script>', style: { ...DEFAULT_STYLE, stroke: 'url(https://example.invalid/pixel)' } })
  assert.ok(!markup(unsafe).includes('example.invalid')); assert.ok(!markup(unsafe).includes('<script'))
})

test('100000-point ink stays valid, renders linearly and produces a bounded number of SVG paths', () => {
  const points = Array.from({ length: 100000 }, (_, index) => ({ x: index * 2, y: Math.sin(index / 100) * 100 }))
  const pressures = points.map((_, index) => .2 + index % 60 / 100)
  for (const { id } of BRUSH_PRESETS) {
    const ink = stroke(id, { points, pressures }), scene = validateScene(sceneOf(ink)), start = performance.now()
    const output = sceneToSvg(scene)
    assert.ok(performance.now() - start < 5000, `${id} must keep linear work`)
    assert.ok(output.length < points.length * 180, `${id} output must stay proportional to input`)
    assert.ok((output.match(/<path /g) ?? []).length <= 96)
    assert.ok(!/NaN|Infinity/.test(output))
    assert.equal(scene.elements[0].points.length, 100000)
  }
})
