import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser as XmlParser } from '@xmldom/xmldom'
import { importBoardJson, exportBoardJson } from '../src/workflow/formats/board-json.ts'
import { importGraphXml, exportGraphXml } from '../src/workflow/formats/graph-xml.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { shapeOutline, braceTextBounds, edgePoints } from '../src/workflow/core/geometry.ts'

globalThis.DOMParser = class {
  parseFromString(value, mime) {
    return new XmlParser({ onError(_level, message) { throw new Error(message) } }).parseFromString(value, mime)
  }
}

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const shape = (id, extra = {}) => ({ id, type: 'shape', shape: 'rectangle', x: 20, y: 40, width: 140, height: 80, text: '', style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const scene = elements => ({ elements, background: '#ffffff', grid: false })
const board = elements => JSON.stringify({ type: 'excalidraw', version: 2, elements })
const model = content => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${content}</root></mxGraphModel>`
const vertex = (rotation, extra = '') => `<mxCell id="node" vertex="1" parent="1" value="旋转标签" style="shape=rectangle;rotation=${rotation};${extra}"><mxGeometry x="20" y="40" width="140" height="80" as="geometry"/></mxCell>`
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`)
const closePoint = (actual, expected, message = '') => { close(actual.x, expected.x, `${message} x`); close(actual.y, expected.y, `${message} y`) }
const closePoints = (actual, expected, message = '') => {
  assert.equal(actual.length, expected.length, `${message} point count`)
  actual.forEach((point, index) => closePoint(point, expected[index], `${message} point ${index}`))
}
const rotate = (point, pivot, degrees) => {
  const angle = degrees * Math.PI / 180, dx = point.x - pivot.x, dy = point.y - pivot.y
  return { x: pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle) }
}
const center = node => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 })
const xmlDocument = text => new XmlParser().parseFromString(text, 'application/xml')
const xmlCell = (text, id) => [...xmlDocument(text).getElementsByTagName('mxCell')].find(cell => cell.getAttribute('openWorkflowId') === id)
const xmlGeometryPoints = cell => {
  const geometry = cell.getElementsByTagName('mxGeometry')[0]
  const points = [...geometry.getElementsByTagName('mxPoint')]
  const from = points.find(point => point.getAttribute('as') === 'sourcePoint')
  const to = points.find(point => point.getAttribute('as') === 'targetPoint')
  return [from, ...points.filter(point => point.parentNode.nodeName === 'Array'), to].map(point => ({ x: Number(point.getAttribute('x')), y: Number(point.getAttribute('y')) }))
}

test('both editable formats retain rotation, text, image data and flat groups across shape types', () => {
  const expected = scene(['rectangle', 'ellipse', 'diamond', 'note', 'triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'text', 'image', 'frame'].map((kind, index) => shape(kind, {
    shape: kind, x: index * 180, rotation: (index + 1) * 5, text: kind === 'image' ? '' : `名称 ${kind}`, groupId: 'group', ...(kind === 'image' ? { imageData: pixel } : {}), ...(kind === 'text' ? { style: { ...DEFAULT_STYLE, fill: 'transparent' } } : {}),
  })))
  for (const imported of [importBoardJson(exportBoardJson(expected)), importGraphXml(exportGraphXml(expected, '旋转场景'))[0]]) {
    assert.equal(imported.scene.elements.length, expected.elements.length)
    for (const original of expected.elements) {
      const actual = imported.scene.elements.find(element => element.id === original.id)
      for (const field of ['shape', 'x', 'y', 'width', 'height', 'text', 'groupId', 'imageData']) assert.equal(actual[field], original[field], `${original.id}.${field}`)
      close(actual.rotation, original.rotation, `${original.id} rotation`)
    }
    assert.ok(imported.warnings.every(warning => !warning.includes('旋转图形已转为未旋转')))
  }
})

test('board JSON exports radians while graph XML exports degrees, including bound text', () => {
  const node = shape('rotated', { rotation: 35, text: '跟随图形', groupId: 'group' })
  const exported = JSON.parse(exportBoardJson(scene([node]))).elements
  const body = exported.find(element => element.id === node.id), label = exported.find(element => element.containerId === node.id)
  close(body.angle, 35 * Math.PI / 180, 'body radians')
  close(label.angle, body.angle, 'bound text radians')
  closePoint(center(label), center(node), 'bound text rotates around the same center')
  assert.match(xmlCell(exportGraphXml(scene([node]), '旋转'), node.id).getAttribute('style'), /(?:^|;)rotation=35;/)
})

test('external negative and multi-turn angles normalize without moving unrotated shape geometry', () => {
  for (const [degrees, expected] of [[-5, 355], [365, 5], [725, 5], [-725, 355]]) {
    const json = importBoardJson(board([{ id: 'node', type: 'rectangle', x: 20, y: 40, width: 140, height: 80, angle: degrees * Math.PI / 180 }])).scene.elements[0]
    const graph = importGraphXml(model(vertex(degrees)))[0].scene.elements[0]
    for (const actual of [json, graph]) {
      close(actual.rotation, expected)
      assert.deepEqual([actual.x, actual.y, actual.width, actual.height], [20, 40, 140, 80])
    }
  }
  for (const degrees of [0, 360, -720]) {
    for (const actual of [importBoardJson(board([{ id: 'node', type: 'rectangle', angle: degrees * Math.PI / 180 }])).scene.elements[0], importGraphXml(model(vertex(degrees)))[0].scene.elements[0]]) assert.equal(Object.hasOwn(actual, 'rotation'), false)
  }
})

test('board JSON rotates imported freehand world points around their actual point bounds', () => {
  const result = importBoardJson(board([{ id: 'stroke', type: 'freedraw', x: 100, y: 200, width: 20, height: 40, angle: Math.PI / 2, points: [[0, 0], [20, 0], [20, 40]], pressures: [.2, .5, .8] }])).scene.elements[0]
  assert.equal(result.type, 'stroke')
  closePoints(result.points, [{ x: 130, y: 210 }, { x: 130, y: 230 }, { x: 90, y: 230 }])
  assert.deepEqual(result.pressures, [.2, .5, .8])
  assert.equal(Object.hasOwn(result, 'rotation'), false)
  const exported = JSON.parse(exportBoardJson(scene([result]))).elements[0]
  assert.equal(exported.angle, 0)
  closePoints(exported.points.map(([x, y]) => ({ x: x + exported.x, y: y + exported.y })), result.points)
})

test('board JSON rotates negative-offset linear elements once before simplifying their path', () => {
  const result = importBoardJson(board([{ id: 'edge', type: 'line', x: 100, y: 200, width: 40, height: 20, angle: Math.PI / 2, points: [[0, 0], [-40, 0], [-40, 20]], endArrowhead: null }])).scene.elements[0]
  assert.equal(result.type, 'edge')
  closePoint(result.from, { x: 90, y: 230 })
  closePoint(result.to, { x: 70, y: 190 })
  const exported = JSON.parse(exportBoardJson(scene([result]))).elements[0]
  assert.equal(exported.angle, 0)
  closePoint({ x: exported.x, y: exported.y }, result.from)
  closePoint({ x: exported.x + exported.points.at(-1)[0], y: exported.y + exported.points.at(-1)[1] }, result.to)
})

test('graph XML bakes rotated line and freehand geometry into world coordinates', () => {
  const geometry = '<mxGeometry relative="1" as="geometry"><mxPoint x="100" y="200" as="sourcePoint"/><mxPoint x="60" y="220" as="targetPoint"/><Array as="points"><mxPoint x="60" y="200"/></Array></mxGeometry>'
  const edge = importGraphXml(model(`<mxCell id="edge" edge="1" parent="1" style="rotation=90;endArrow=none;">${geometry}</mxCell>`))[0].scene.elements[0]
  assert.equal(edge.type, 'edge')
  closePoint(edge.from, { x: 90, y: 230 }); closePoint(edge.to, { x: 70, y: 190 })
  const stroke = importGraphXml(model(`<mxCell id="stroke" edge="1" parent="1" openWorkflowType="stroke" openWorkflowPressures="[0.2,0.5,0.8]" style="rotation=90;endArrow=none;">${geometry}</mxCell>`))[0].scene.elements[0]
  assert.equal(stroke.type, 'stroke')
  closePoints(stroke.points, [{ x: 90, y: 230 }, { x: 90, y: 190 }, { x: 70, y: 190 }])
  assert.deepEqual(stroke.pressures, [.2, .5, .8])
  closePoints(xmlGeometryPoints(xmlCell(exportGraphXml(scene([stroke]), '笔迹'), stroke.id)), stroke.points)
})

test('graph XML group styles do not rotate ordinary child coordinates or edge points a second time', () => {
  const group = '<mxCell id="group" vertex="1" parent="1" style="group;rotation=90;"><mxGeometry x="100" y="200" width="400" height="300"/></mxCell>'
  const child = '<mxCell id="child" vertex="1" parent="group" style="shape=rectangle;rotation=30;"><mxGeometry x="10" y="20" width="90" height="50"/></mxCell>'
  const line = '<mxCell id="line" edge="1" parent="group" style="endArrow=none;"><mxGeometry relative="1"><mxPoint x="10" y="20" as="sourcePoint"/><mxPoint x="110" y="20" as="targetPoint"/></mxGeometry></mxCell>'
  const imported = importGraphXml(model(group + child + line))[0].scene
  assert.equal(imported.elements.length, 2)
  const node = imported.elements.find(element => element.id === 'child'), edge = imported.elements.find(element => element.id === 'line')
  closePoint(node, { x: 110, y: 220 }); close(node.rotation, 30)
  assert.deepEqual([node.width, node.height], [90, 50])
  closePoint(edge.from, { x: 110, y: 220 }); closePoint(edge.to, { x: 210, y: 220 })
})

test('graph XML retains geometry and child angles already baked by mxVertexHandler.rotateCell', () => {
  // A 90° group rotation has already rotated the child's center (55,45)
  // about the group center (200,150), and changed its own angle 30° -> 120°.
  // The group style must not apply that operation again while importing.
  const group = '<mxCell id="group" vertex="1" parent="1" style="group;rotation=90;"><mxGeometry x="100" y="200" width="400" height="300"/></mxCell>'
  const child = '<mxCell id="child" vertex="1" parent="group" style="shape=rectangle;rotation=120;"><mxGeometry x="260" y="-20" width="90" height="50"/></mxCell>'
  const line = '<mxCell id="line" edge="1" parent="group" style="endArrow=none;"><mxGeometry relative="1"><mxPoint x="330" y="-40" as="sourcePoint"/><mxPoint x="330" y="60" as="targetPoint"/></mxGeometry></mxCell>'
  const imported = importGraphXml(model(group + child + line))[0].scene
  const node = imported.elements.find(element => element.id === 'child'), edge = imported.elements.find(element => element.id === 'line')
  closePoint(node, { x: 360, y: 180 }); close(node.rotation, 120)
  closePoint(edge.from, { x: 430, y: 160 }); closePoint(edge.to, { x: 430, y: 260 })
  const restored = importGraphXml(exportGraphXml(imported, '已旋转分组'))[0].scene
  assert.deepEqual(restored, imported)
})

test('graph XML relative ports rotate display positions without rotating their logical origin or descendants', () => {
  // mxGraphView.updateVertexState rotates only a relative vertex's displayed
  // center; updateCellState retains origin for ordinary descendants and edges.
  const group = '<mxCell id="group" vertex="1" parent="1" style="group;rotation=90;"><mxGeometry x="100" y="200" width="400" height="300"/></mxCell>'
  const port = '<mxCell id="port" vertex="1" parent="group" style="shape=rectangle;rotation=15;"><mxGeometry relative="1" x="1" y="0.5" width="20" height="10"><mxPoint x="-10" y="-5" as="offset"/></mxGeometry></mxCell>'
  const child = '<mxCell id="child" vertex="1" parent="port" style="shape=rectangle;"><mxGeometry x="3" y="4" width="4" height="6"/></mxCell>'
  const line = '<mxCell id="line" edge="1" parent="port" style="edgeStyle=orthogonalEdgeStyle;endArrow=none;"><mxGeometry relative="1"><mxPoint x="0" y="0" as="sourcePoint"/><mxPoint x="10" y="20" as="targetPoint"/></mxGeometry></mxCell>'
  const imported = importGraphXml(model(group + port + child + line))[0].scene
  const node = imported.elements.find(element => element.id === 'port'), nested = imported.elements.find(element => element.id === 'child'), edge = imported.elements.find(element => element.id === 'line')
  closePoint(node, { x: 290, y: 545 }); close(node.rotation, 15)
  closePoint(nested, { x: 493, y: 349 }); assert.equal(nested.rotation, undefined)
  closePoint(edge.from, { x: 490, y: 345 }); closePoint(edge.to, { x: 500, y: 365 })
  assert.equal(edge.route, 'orthogonal', 'the parent port angle must not rotate the edge route')
})

test('rotated containers keep connected edges bound to their visible outlines in both formats', () => {
  const a = shape('a', { x: 0, y: 0, width: 100, height: 50, rotation: 90 })
  const b = shape('b', { x: 200, y: 0, width: 100, height: 50 })
  const edge = { id: 'edge', type: 'edge', from: { nodeId: 'a', x: 100, y: 25 }, to: { nodeId: 'b', x: 200, y: 25 }, label: '连接', arrow: 'end', route: 'straight', style: { ...DEFAULT_STYLE }, locked: false }
  const original = scene([a, b, edge])
  const jsonEdge = JSON.parse(exportBoardJson(original)).elements.find(element => element.id === 'edge')
  closePoint({ x: jsonEdge.x, y: jsonEdge.y }, { x: 75, y: 25 })
  closePoint(xmlGeometryPoints(xmlCell(exportGraphXml(original, '绑定'), 'edge'))[0], { x: 75, y: 25 })
  for (const imported of [importBoardJson(exportBoardJson(original)).scene, importGraphXml(exportGraphXml(original, '绑定'))[0].scene]) {
    const actual = imported.elements.find(element => element.id === 'edge')
    assert.equal(actual.from.nodeId, 'a'); assert.equal(actual.to.nodeId, 'b')
    const points = edgePoints(actual, imported)
    closePoint(points[0], { x: 75, y: 25 })
    closePoint(points.at(-1), { x: 200, y: 25 })
  }
})

test('rotated braces export already-transformed paths and preserve editable geometry on return', () => {
  for (const kind of ['brace-left', 'brace-right', 'brace-top', 'brace-bottom']) {
    const node = shape(kind, { shape: kind, width: 150, height: 180, rotation: 35, text: '括弧标签', groupId: 'brace-group', style: { ...DEFAULT_STYLE, fill: 'none' } })
    const unrotated = { ...node, rotation: 0 }
    const expected = shapeOutline(unrotated).map(point => rotate(point, center(node), node.rotation))
    const json = JSON.parse(exportBoardJson(scene([node]))), path = json.elements.find(element => element.id === node.id)
    assert.equal(path.type, 'freedraw')
    assert.equal(path.angle, 0, 'baked brace path must not rotate a second time')
    closePoints(path.points.map(([x, y]) => ({ x: x + path.x, y: y + path.y })), expected, kind)
    const label = json.elements.find(element => element.type === 'text')
    const textBounds = braceTextBounds(unrotated)
    closePoint(center(label), rotate(center(textBounds), center(node), node.rotation), `${kind} label position`)
    close(label.angle, node.rotation * Math.PI / 180, `${kind} label angle`)
    const graph = exportGraphXml(scene([node]), kind), cell = xmlCell(graph, node.id)
    closePoints(xmlGeometryPoints(cell), expected, `${kind} graph path`)
    assert.ok(!/(?:^|;)rotation=(?!0(?:;|$))[^;]+/.test(cell.getAttribute('style')), 'baked graph edge must not rotate a second time')
    const graphLabel = [...xmlDocument(graph).getElementsByTagName('mxCell')].find(element => element.getAttribute('vertex') === '1')
    assert.ok(graphLabel, 'rotated brace has an independent rotated graph label')
    assert.match(graphLabel.getAttribute('style'), /(?:^|;)rotation=35;/)
    const labelGeometry = graphLabel.getElementsByTagName('mxGeometry')[0]
    const graphTextBounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(labelGeometry.getAttribute(key))]))
    closePoint(center(graphTextBounds), rotate(center(textBounds), center(node), node.rotation), `${kind} graph label position`)
    for (const importedScene of [importBoardJson(JSON.stringify(json)).scene, importGraphXml(graph)[0].scene]) {
      assert.equal(importedScene.elements.length, 1, 'the fallback label merges back into the native brace')
      const imported = importedScene.elements[0]
      for (const field of ['shape', 'x', 'y', 'width', 'height', 'text', 'groupId']) assert.equal(imported[field], node[field], `${kind}.${field}`)
      close(imported.rotation, node.rotation, `${kind} restored rotation`)
    }
  }
})

test('generated graph brace labels cannot collide with native IDs or existing XML IDs', () => {
  for (const conflictingIds of [['wf-brace__label'], ['brace__label', 'wf-brace__label_']]) {
    const brace = shape('brace', { shape: 'brace-left', rotation: 35, text: '括弧名称', style: { ...DEFAULT_STYLE, fill: 'none' } })
    const original = scene([brace, ...conflictingIds.map((id, index) => shape(id, { x: 300 + index * 180, text: `保留图形 ${index}` }))])
    const exported = exportGraphXml(original, '名称碰撞')
    const cells = [...xmlDocument(exported).getElementsByTagName('mxCell')], ids = cells.map(cell => cell.getAttribute('id'))
    assert.equal(new Set(ids).size, ids.length, 'XML IDs remain unique')
    const caption = cells.find(cell => cell.getAttribute('openWorkflowBraceLabelFor'))
    assert.ok(caption)
    assert.ok(!conflictingIds.includes(caption.getAttribute('id')), 'the fallback text cannot shadow a native target ID')
    const imported = importGraphXml(exported)[0].scene
    assert.equal(imported.elements.length, original.elements.length)
    for (const node of original.elements) {
      const actual = imported.elements.find(element => element.id === node.id)
      assert.ok(actual, `preserved ${node.id}`)
      assert.equal(actual.text, node.text)
      assert.equal(actual.shape, node.shape)
      close(actual.rotation ?? 0, node.rotation ?? 0)
    }
  }
})

test('independently rotated bound connectors retain their visible endpoints instead of snapping back to nodes', () => {
  const a = shape('a', { x: 0, y: 0, width: 100, height: 50 }), b = shape('b', { x: 200, y: 0, width: 100, height: 50 })
  const json = board([
    ...[a, b].map(node => ({ id: node.id, type: 'rectangle', x: node.x, y: node.y, width: node.width, height: node.height })),
    { id: 'edge', type: 'arrow', x: 100, y: 25, width: 100, height: 0, points: [[0, 0], [100, 0]], angle: Math.PI / 2, startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } },
  ])
  const vertices = [a, b].map(node => `<mxCell id="${node.id}" vertex="1" parent="1"><mxGeometry x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"/></mxCell>`).join('')
  const graph = model(`${vertices}<mxCell id="edge" edge="1" parent="1" source="a" target="b" style="rotation=90;endArrow=block;"><mxGeometry relative="1"><mxPoint x="100" y="25" as="sourcePoint"/><mxPoint x="200" y="25" as="targetPoint"/></mxGeometry></mxCell>`)
  for (const imported of [importBoardJson(json), importGraphXml(graph)[0]]) {
    const edge = imported.scene.elements.find(element => element.id === 'edge')
    assert.equal(edge.from.nodeId, undefined); assert.equal(edge.to.nodeId, undefined)
    closePoints(edgePoints(edge, imported.scene), [{ x: 150, y: -25 }, { x: 150, y: 75 }])
    assert.ok(imported.warnings.some(warning => warning.includes('独立旋转') && warning.includes('自由端点')))
    for (const node of [a, b]) closePoint(imported.scene.elements.find(element => element.id === node.id), node)
    for (const reopened of [importBoardJson(exportBoardJson(imported.scene)).scene, importGraphXml(exportGraphXml(imported.scene, '保留连线位置'))[0].scene]) {
      const restored = reopened.elements.find(element => element.id === 'edge')
      closePoints(edgePoints(restored, reopened), [{ x: 150, y: -25 }, { x: 150, y: 75 }])
    }
  }
})

test('right-angle connector rotations retain orthogonal routing while other angles disclose a straight fallback', () => {
  for (const degrees of [0, 90, -90, 180, 270, 360, 5, 95]) {
    const json = board([{ id: 'edge', type: 'arrow', x: 0, y: 0, width: 120, height: 80, points: [[0, 0], [0, 80], [120, 80]], angle: degrees * Math.PI / 180, elbowed: true }])
    const graph = model(`<mxCell id="edge" edge="1" parent="1" style="rotation=${degrees};edgeStyle=orthogonalEdgeStyle;endArrow=block;"><mxGeometry relative="1"><mxPoint x="0" y="0" as="sourcePoint"/><mxPoint x="120" y="80" as="targetPoint"/><Array as="points"><mxPoint x="0" y="80"/></Array></mxGeometry></mxCell>`)
    const rightAngle = degrees % 90 === 0, pivot = { x: 60, y: 40 }
    for (const imported of [importBoardJson(json), importGraphXml(graph)[0]]) {
      const edge = imported.scene.elements[0]
      assert.equal(edge.route, rightAngle ? 'orthogonal' : 'straight', `routing at ${degrees} degrees`)
      closePoint(edge.from, rotate({ x: 0, y: 0 }, pivot, degrees))
      closePoint(edge.to, rotate({ x: 120, y: 80 }, pivot, degrees))
      assert.equal(imported.warnings.some(warning => /旋转.*正交.*直线/.test(warning)), !rightAngle, `conversion warning at ${degrees} degrees`)
    }
  }
})

test('malformed external angles fail import instead of silently discarding the rotation', () => {
  for (const angle of ['NaN', 'Infinity', '1e309', 'not-an-angle']) assert.throws(() => importGraphXml(model(vertex(angle))))
  for (const angle of ['0.5', 'NaN', {}, []]) assert.throws(() => importBoardJson(board([{ id: 'node', type: 'rectangle', angle }])))
  assert.throws(() => importBoardJson('{"type":"excalidraw","elements":[{"id":"node","type":"rectangle","angle":1e309}]}'))
})
