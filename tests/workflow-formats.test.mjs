import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser as XmlParser } from '@xmldom/xmldom'
import { deflateSync, strToU8 } from 'fflate'
import { importGraphXml, exportGraphXml } from '../src/workflow/formats/graph-xml.ts'
import { importBoardJson, exportBoardJson } from '../src/workflow/formats/board-json.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { applyGlobalLineStyle } from '../src/workflow/core/appearance.ts'

globalThis.DOMParser = class {
  parseFromString(value, mime) {
    return new XmlParser({ onError(_level, message) { throw new Error(message) } }).parseFromString(value, mime)
  }
}

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const shape = (id, kind, x, y, text = '') => ({ id, type: 'shape', shape: kind, x, y, width: 140, height: 80, text, style: { ...DEFAULT_STYLE }, locked: false })
const scene = () => ({ background: '#f8fafc', grid: true, elements: [
  shape('0', 'rectangle', 20, 40, '开始 & <确认>'),
  shape('decision', 'diamond', 250, 80, '是否通过？'),
  shape('note', 'note', 30, 240, '备注'),
  { ...shape('text', 'text', 220, 240, '独立文字'), style: { ...DEFAULT_STYLE, fill: 'transparent' } },
  { ...shape('image', 'image', 450, 40), imageData: pixel },
  { id: 'edge', type: 'edge', from: { nodeId: '0', x: 160, y: 80 }, to: { nodeId: 'decision', x: 250, y: 120 }, label: '审核', arrow: 'both', route: 'orthogonal', style: { ...DEFAULT_STYLE }, locked: true },
  { id: 'pen', type: 'stroke', points: [{ x: -30, y: 5 }, { x: -12, y: 10 }, { x: 30, y: -10 }], style: { ...DEFAULT_STYLE, stroke: '#ff0000', fill: 'transparent' }, locked: false },
] })
const model = content => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${content}</root></mxGraphModel>`
const vertex = '<mxCell id="a" value="中文节点" vertex="1" parent="1" style="ellipse;fillColor=#fed7aa;"><mxGeometry x="12" y="24" width="160" height="90" as="geometry"/></mxCell>'

test('line patterns, sketch mode and future-element defaults survive both interchange formats', () => {
  for (const strokePattern of ['solid', 'dashed', 'dotted']) {
    const expected = applyGlobalLineStyle(scene(), { roughness: 'sketch', strokePattern, strokeWidth: 3, stroke: '#123456' })
    for (const actual of [importGraphXml(exportGraphXml(expected, '风格'))[0], importBoardJson(exportBoardJson(expected))]) {
      assert.deepEqual(actual.scene.defaultStyle, expected.defaultStyle)
      for (const element of actual.scene.elements) {
        assert.equal(element.style.roughness, 'sketch')
        assert.equal(element.style.strokePattern, strokePattern)
        assert.equal(element.style.dashed, strokePattern !== 'solid')
        assert.equal(element.style.strokeWidth, 3)
      }
      assert.ok(actual.warnings.some(warning => warning.includes('手绘')))
    }
    const external = JSON.parse(exportBoardJson(expected))
    assert.ok(external.elements.every(element => element.roughness === 1 && element.strokeStyle === strokePattern))
    const xml = exportGraphXml(expected, '风格')
    assert.match(xml, /sketch=1/)
    if (strokePattern === 'dotted') assert.match(xml, /dashPattern=1 3/)
  }
})

test('external sketch and dotted styles map to native styles and custom dash spacing is disclosed', () => {
  const xml = importGraphXml(model(vertex.replace('ellipse;', 'ellipse;sketch=1;dashed=1;dashPattern=0 5;')))[0]
  assert.equal(xml.scene.elements[0].style.roughness, 'sketch')
  assert.equal(xml.scene.elements[0].style.strokePattern, 'dotted')
  assert.ok(xml.warnings.some(warning => warning.includes('间隔')))
  const board = importBoardJson(JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', width: 20, height: 20, roughness: 2, strokeStyle: 'dotted' }] }))
  assert.equal(board.scene.elements[0].style.roughness, 'sketch')
  assert.equal(board.scene.elements[0].style.strokePattern, 'dotted')
  assert.equal(board.scene.elements[0].style.dashed, true)
})

test('graph XML native round trip retains editable nodes, IDs, edge bindings, freehand and embedded images', () => {
  const expected = scene()
  const [result] = importGraphXml(exportGraphXml(expected, '测试 <第一版>'))
  assert.equal(result.title, '测试 <第一版>')
  assert.equal(result.scene.background, expected.background)
  assert.equal(result.scene.grid, true)
  assert.equal(result.scene.elements.length, expected.elements.length)
  for (const node of expected.elements.filter(element => element.type === 'shape')) assert.deepEqual(result.scene.elements.find(element => element.id === node.id), node)
  const edge = result.scene.elements.find(element => element.id === 'edge')
  assert.equal(edge.from.nodeId, '0')
  assert.equal(edge.to.nodeId, 'decision')
  assert.equal(edge.label, '审核')
  assert.equal(edge.arrow, 'both')
  assert.equal(edge.route, 'orthogonal')
  assert.equal(edge.locked, true)
  assert.deepEqual(result.scene.elements.find(element => element.id === 'pen'), expected.elements.at(-1))
  assert.deepEqual(result.warnings, [])
})

test('graph XML reads raw models, UTF-8 compressed pages and multiple pages', () => {
  const raw = model(vertex)
  const compressed = Buffer.from(deflateSync(strToU8(encodeURIComponent(raw)))).toString('base64')
  const result = importGraphXml(`<mxfile><diagram name="压缩中文">${compressed}</diagram><diagram name="普通页">${raw}</diagram></mxfile>`)
  assert.equal(result.length, 2)
  for (const page of result) assert.equal(page.scene.elements[0].text, '中文节点')
  assert.equal(result[0].scene.elements[0].shape, 'ellipse')
  assert.equal(importGraphXml(raw)[0].scene.elements[0].x, 12)
})

test('graph XML flattens groups to world coordinates and reports unsupported features', () => {
  const value = model('<mxCell id="g" vertex="1" parent="1" style="group;"><mxGeometry x="100" y="200" width="400" height="300"/></mxCell><mxCell id="a" vertex="1" parent="g" value="&lt;b&gt;标题&lt;/b&gt;&lt;br&gt;说明" style="shape=mxgraph.custom.server;rotation=30;html=1;"><mxGeometry x="10" y="20" width="90" height="50"/></mxCell>')
  const result = importGraphXml(value)[0]
  assert.equal(result.scene.elements.length, 1)
  assert.equal(result.scene.elements[0].x, 110)
  assert.equal(result.scene.elements[0].y, 220)
  assert.equal(result.scene.elements[0].text, '标题\n说明')
  assert.equal(result.scene.elements[0].shape, 'rectangle')
  assert.ok(result.warnings.some(value => value.includes('分组')))
  assert.ok(result.warnings.some(value => value.includes('旋转')))
  assert.ok(result.warnings.some(value => value.includes('mxgraph.custom.server')))
  assert.ok(result.warnings.some(value => value.includes('纯文本')))
})

test('graph XML wrapper IDs and source references are resolved after all nodes are read', () => {
  const value = model('<mxCell id="edge" edge="1" parent="1" source="a" target="b" style="endArrow=none;"><mxGeometry relative="1"/></mxCell><object id="a" label="来源"><mxCell vertex="1" parent="1"><mxGeometry x="30" y="50" width="100" height="60"/></mxCell></object><object id="b" label="目标"><mxCell vertex="1" parent="1"><mxGeometry x="250" y="50" width="100" height="60"/></mxCell></object>')
  const result = importGraphXml(value)[0]
  const edge = result.scene.elements.find(element => element.type === 'edge')
  assert.equal(edge.from.nodeId, 'a')
  assert.equal(edge.to.nodeId, 'b')
  assert.equal(edge.arrow, 'none')
  assert.equal(result.scene.elements.find(element => element.id === 'a').text, '来源')
})

test('graph XML refuses entity declarations, invalid structures, invalid numbers, duplicate IDs and broken compressed pages', () => {
  const invalid = [
    '<!DOCTYPE mxfile [<!ENTITY secret SYSTEM "file:///etc/passwd">]><mxfile/>',
    '<!ENTITY secret "value"><mxfile/>', '<html/>', '<mxfile/>',
    '<mxGraphModel><root></mxGraphModel>', model(vertex + vertex),
    model(vertex.replace('x="12"', 'x="NaN"')),
    '<mxfile><diagram>!!!</diagram></mxfile>',
    '<mxfile><diagram>eHh4eHh4eA==</diagram></mxfile>',
    model('<mxCell id="a" vertex="1" parent="b"/><mxCell id="b" vertex="1" parent="a"/>'),
  ]
  for (const value of invalid) assert.throws(() => importGraphXml(value), undefined, value)
})

test('graph XML never loads external images or permits executable color values', () => {
  const value = model('<mxCell id="a" vertex="1" parent="1" style="shape=image;image=https://example.invalid/a.png;fillColor=url(javascript:alert(1));"><mxGeometry x="0" y="0" width="100" height="100"/></mxCell>')
  const result = importGraphXml(value)[0]
  assert.equal(result.scene.elements[0].shape, 'rectangle')
  assert.equal(result.scene.elements[0].imageData, undefined)
  assert.equal(result.scene.elements[0].style.fill, DEFAULT_STYLE.fill)
  assert.ok(result.warnings.some(value => value.includes('外部图片')))
})

test('board JSON export/import keeps basic editable shapes, attached text, arrow IDs, images and strokes', () => {
  const expected = scene()
  const serialized = exportBoardJson(expected)
  const exported = JSON.parse(serialized)
  assert.equal(exported.type, 'excalidraw')
  assert.equal(exported.version, 2)
  assert.equal(exported.files['image-image'].dataURL, pixel)
  const result = importBoardJson(serialized)
  assert.equal(result.scene.elements.length, expected.elements.length)
  assert.equal(result.scene.background, expected.background)
  for (const element of expected.elements.filter(element => element.type !== 'edge')) assert.deepEqual(result.scene.elements.find(actual => actual.id === element.id), element)
  const edge = result.scene.elements.find(element => element.id === 'edge')
  assert.equal(edge.from.nodeId, '0')
  assert.equal(edge.to.nodeId, 'decision')
  assert.equal(edge.label, '审核')
  assert.equal(edge.arrow, 'both')
  assert.equal(edge.route, 'orthogonal')
  assert.equal(edge.locked, true)
})

test('board JSON binds text even when label appears before its container and removes stale bindings', () => {
  const result = importBoardJson(JSON.stringify({ type: 'excalidraw', version: 2, elements: [
    { id: 'label', type: 'text', containerId: 'shape', text: '先出现的标签', fontSize: 22 },
    { id: 'arrow', type: 'arrow', x: 10, y: 20, points: [[0, 0], [100, 40]], startBinding: { elementId: 'shape' }, endBinding: { elementId: 'missing' } },
    { id: 'shape', type: 'rectangle', x: 20, y: 50, width: 100, height: 80 },
  ] }))
  assert.equal(result.scene.elements.length, 2)
  assert.equal(result.scene.elements.find(element => element.id === 'shape').text, '先出现的标签')
  const edge = result.scene.elements.find(element => element.id === 'arrow')
  assert.equal(edge.from.nodeId, 'shape')
  assert.equal(edge.to.nodeId, undefined)
  assert.deepEqual(edge.to, { x: 110, y: 60 })
  assert.ok(result.warnings.some(value => value.includes('绑定')))
})

test('board JSON retains frames and flat groups while reporting rotation and non-safe images', () => {
  const result = importBoardJson(JSON.stringify({ type: 'excalidraw', elements: [
    { id: 'frame', type: 'frame', width: 100, height: 100 },
    { id: 'r', type: 'rectangle', x: 5, y: 6, width: 30, height: 50, angle: 0.5, groupIds: ['group'], roughness: 2, fillStyle: 'hachure' },
    { id: 'img', type: 'image', width: 40, height: 40, fileId: 'unsafe' },
    { id: 'deleted', type: 'rectangle', isDeleted: true },
  ], files: { unsafe: { dataURL: 'data:image/svg+xml;base64,PHN2Zy8+' } } }))
  assert.equal(result.scene.elements.length, 3)
  assert.equal(result.scene.elements.find(element => element.id === 'frame').shape, 'frame')
  assert.equal(result.scene.elements.find(element => element.id === 'r').groupId, 'group')
  assert.equal(result.scene.elements.find(element => element.id === 'img').shape, 'rectangle')
  for (const fragment of ['frame', '旋转', '纹理', 'SVG']) assert.ok(result.warnings.some(value => value.includes(fragment)), fragment)
})

test('board JSON rejects malformed JSON, wrong documents, duplicate IDs and unsafe numeric input', () => {
  for (const value of ['{', '{}', '{"type":"excalidraw","elements":{}}', JSON.stringify({ type: 'excalidraw', elements: [null] }), JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', x: 'NaN' }] }), JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle' }, { id: 'a', type: 'rectangle' }] }), JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a', type: 'arrow', points: [[0, 0]] }] })]) assert.throws(() => importBoardJson(value))
})

test('board JSON export computes current bound endpoints after nodes move', () => {
  const value = scene()
  value.elements.find(element => element.id === 'decision').x = 500
  const exported = JSON.parse(exportBoardJson(value)).elements.find(element => element.id === 'edge')
  const last = exported.points.at(-1)
  assert.ok(exported.x + last[0] >= 500)
})

test('both formats retain a single-point pencil mark rather than silently dropping it', () => {
  const value = { background: '#ffffff', grid: false, elements: [{ id: 'dot', type: 'stroke', points: [{ x: 20, y: 30 }], style: { ...DEFAULT_STYLE }, locked: false }] }
  assert.deepEqual(importGraphXml(exportGraphXml(value, '点'))[0].scene, value)
  assert.deepEqual(importBoardJson(exportBoardJson(value)).scene, value)
})

test('image size limits include base64 overhead and graph XML never silently drops an invalid image', () => {
  const image = { ...shape('large-image', 'image', 0, 0), imageData: `data:image/png;base64,${'A'.repeat(11 * 1024 * 1024)}` }
  const value = { background: '#ffffff', grid: false, elements: [image] }
  assert.ok(exportGraphXml(value, '大图片').includes('image=data:image/png,'))
  assert.ok(exportBoardJson(value).includes('data:image/png;base64,'))
  image.imageData = 'https://example.invalid/image.png'
  assert.throws(() => exportGraphXml(value, '拒绝外部图片'), /导出图片/)
  assert.throws(() => exportBoardJson(value), /导出图片/)
})
