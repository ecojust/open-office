import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compileCodeDiagram, lookupDiagramSource } from '../src/workflow/core/code-diagram.ts'
import { createDocument } from '../src/workflow/core/documents.ts'
import { documentScene, exportDocument, importText } from '../src/workflow/core/files.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'

const fixture = `erDiagram
CUSTOMER["客户"] {
  bigint customer_id PK "客户编号"
  varchar display_name "显示名称"
  string email UK
}
ORDER {
  bigint customer_id FK "关联客户"
}
CUSTOMER ||--o{ ORDER : places`
const texts = scene => scene.elements.filter(element => element.type === 'shape' && element.shape === 'text' && element.text)
const table = (scene, id = 'er-0') => scene.elements.find(element => element.id === id)
function text(scene, label) {
  const matches = texts(scene).filter(element => element.text === label)
  assert.equal(matches.length, 1, `Expected one independent text shape for ${JSON.stringify(label)}`)
  return matches[0]
}
function field(scene, name) {
  const matches = texts(scene).filter(element => new RegExp(`^\\S+\\s+${name}(?:\\s|$)`).test(element.text))
  assert.equal(matches.length, 1, `Expected one independent field shape for ${name}`)
  return matches[0]
}
const middle = shape => shape.y + shape.height / 2
function inside(shape, outer) {
  assert.ok(shape.x >= outer.x && shape.y >= outer.y, `${shape.text} starts inside ${outer.id}`)
  assert.ok(shape.x + shape.width <= outer.x + outer.width + .001, `${shape.text} fits table width`)
  assert.ok(shape.y + shape.height <= outer.y + outer.height + .001, `${shape.text} fits table height`)
}
function svgTexts(svg) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return Array.from(document.getElementsByTagName('text')).map(node => ({
    text: node.textContent,
    lines: node.getElementsByTagName('tspan').length,
    weight: node.getAttribute('font-weight') || 'normal',
    italic: node.getAttribute('font-style') || 'normal',
    anchor: node.getAttribute('text-anchor'),
    size: Number(node.getAttribute('font-size')),
    color: node.getAttribute('fill'),
  }))
}

test('ER table name appears bold above its optional comment and fields occupy independent left/right cells', () => {
  const { scene } = compileCodeDiagram(fixture)
  const name = text(scene, 'CUSTOMER'), comment = text(scene, '客户'), node = table(scene)
  assert.equal(name.style.fontWeight, 'bold')
  assert.ok(name.y + name.height <= comment.y, 'table name is above the table comment')
  assert.equal(node.groupId, 'er-0-card')
  const idField = texts(scene).find(element => element.groupId === node.groupId && /customer_id/.test(element.text))
  const idComment = text(scene, '客户编号')
  assert.match(idField.text, /bigint\s+customer_id\s+\[PK\]/)
  assert.equal(idField.style.textAlign, 'left')
  assert.equal(idComment.style.textAlign, 'right')
  assert.ok(idField.x + idField.width <= idComment.x, 'field and comment columns do not overlap')
  assert.equal(middle(idField), middle(idComment), 'field and comment share the same row center')
  assert.ok(comment.y + comment.height <= idField.y)
  for (const shape of texts(scene).filter(element => element.groupId === node.groupId)) {
    assert.equal(shape.style.textWrap, 'nowrap')
    inside(shape, node)
  }
})

test('long Latin, wide capitals, CJK, emoji and escaped comments grow tables beyond the old width cap without truncation', () => {
  const comment = 'WWMW宽字符😀 mixed Latin & <xml> '.repeat(12).trim()
  const source = `erDiagram\nWIDE_TABLE["${'WWWW数据表😀'.repeat(18)}"] {\n  varchar ${'WIDE_FIELD_'.repeat(14)} "${comment}"\n}`
  const { scene } = compileCodeDiagram(source, { erStyle: { title: { fontSize: 48 }, field: { fontSize: 32, fontWeight: 'bold' }, comment: { fontSize: 48, fontStyle: 'italic' } } })
  assert.ok(table(scene).width > 680)
  const rendered = svgTexts(sceneToSvg(scene))
  for (const shape of texts(scene)) {
    inside(shape, table(scene))
    assert.equal(rendered.find(item => item.text === shape.text)?.lines, 1, `Full single line: ${shape.text}`)
  }
  assert.equal(text(scene, comment).style.fontSize, 48)
  assert.ok(!rendered.some(item => item.text.includes('…')))
})

test('row centers and nonoverlapping columns survive independent role fonts and alignment', () => {
  const source = 'erDiagram\nACCOUNT["账户"] {\n  int first PK "第一行"\n  string second "second 😀"\n  string third\n}'
  for (const [fieldSize, commentSize] of [[10, 48], [48, 10], [27, 41]]) {
    const erStyle = {
      title: { fontSize: 35, fontWeight: 'normal', fontStyle: 'italic', textAlign: 'left' },
      tableComment: { fontSize: 11, fontWeight: 'bold', textAlign: 'right' },
      field: { fontSize: fieldSize, fontWeight: 'bold', textAlign: 'center' },
      comment: { fontSize: commentSize, fontStyle: 'italic', textAlign: 'left' },
    }
    const { scene } = compileCodeDiagram(source, { erStyle })
    const first = field(scene, 'first'), second = field(scene, 'second'), third = field(scene, 'third')
    for (const [cell, label] of [[first, '第一行'], [second, 'second 😀']]) {
      const annotation = text(scene, label)
      assert.equal(middle(cell), middle(annotation))
      assert.equal(cell.style.fontSize, fieldSize)
      assert.equal(annotation.style.fontSize, commentSize)
      assert.equal(cell.style.fontWeight, 'bold')
      assert.equal(cell.style.textAlign, 'center')
      assert.equal(annotation.style.fontStyle, 'italic')
      assert.equal(annotation.style.textAlign, 'left')
      assert.ok(cell.x + cell.width <= annotation.x)
    }
    assert.ok(first.y + first.height <= second.y)
    assert.ok(second.y + second.height <= third.y)
    assert.equal(text(scene, 'ACCOUNT').style.fontWeight, 'normal')
    assert.equal(text(scene, '账户').style.fontSize, 11)
    for (const shape of texts(scene)) inside(shape, table(scene))
  }
})

test('changing only comment style preserves the other three roles and relation bindings', () => {
  const before = compileCodeDiagram(fixture).scene
  const after = compileCodeDiagram(fixture, { erStyle: { comment: { fontSize: 48, fontWeight: 'bold', fontStyle: 'italic', textAlign: 'center', color: '#a12345' } } }).scene
  for (const label of ['CUSTOMER', '客户', 'ORDER']) assert.deepEqual(text(after, label).style, text(before, label).style)
  const beforeFields = texts(before).filter(element => /customer_id|display_name|email/.test(element.text))
  for (const shape of beforeFields) assert.deepEqual(after.elements.find(element => element.id === shape.id).style, shape.style)
  assert.ok(table(after).height > table(before).height, 'taller comments enlarge the rows')
  for (const scene of [before, after]) {
    const edge = scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.from.nodeId, 'er-0')
    assert.equal(edge.to.nodeId, 'er-1')
  }
})

test('entities without comments and empty entities have no phantom header or comment rows', () => {
  const { scene } = compileCodeDiagram('erDiagram\nEMPTY\nEMPTY_BLOCK {\n}\nPLAIN {\n  int id PK\n  string name ""\n}\nANNOTATED["说明"] {\n}')
  for (const [index, title, expected] of [[0, 'EMPTY', 1], [1, 'EMPTY_BLOCK', 1], [2, 'PLAIN', 3], [3, 'ANNOTATED', 2]]) {
    const node = table(scene, `er-${index}`), members = texts(scene).filter(element => element.groupId === node.groupId)
    assert.equal(members.length, expected, title)
    assert.ok(members.some(element => element.text === title))
    for (const shape of members) inside(shape, node)
  }
  assert.equal(table(scene, 'er-0').height, table(scene, 'er-1').height)
  assert.ok(table(scene, 'er-3').height > table(scene, 'er-0').height)
})

test('all ER layout directions keep enlarged tables separate and relationships bound to their original IDs', () => {
  for (const direction of ['LR', 'RL', 'TB', 'BT']) {
    const { scene } = compileCodeDiagram(fixture.replace('erDiagram', `erDiagram\ndirection ${direction}`), { erStyle: { title: { fontSize: 48 }, comment: { fontSize: 48 } } })
    const a = table(scene), b = table(scene, 'er-1'), edge = scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.from.nodeId, a.id)
    assert.equal(edge.to.nodeId, b.id)
    if (direction === 'LR') assert.ok(a.x + a.width < b.x)
    if (direction === 'RL') assert.ok(b.x + b.width < a.x)
    if (direction === 'TB') assert.ok(a.y + a.height < b.y)
    if (direction === 'BT') assert.ok(b.y + b.height < a.y)
    assert.equal(a.groupId, 'er-0-card')
    assert.equal(b.groupId, 'er-1-card')
  }
})

test('ER source locations retain UTF-16/CRLF offsets and the complete owning card after splitting text cells', () => {
  const source = '\uFEFF#说明😀\r\nerDiagram\r\nCUSTOMER["客户"] {\r\n string display_name "名字😀" # 尾注\r\n}\r\nORDER\r\nCUSTOMER ||--o{ ORDER : 订单'
  const result = compileCodeDiagram(source)
  const ids = result.scene.elements.filter(element => element.groupId === 'er-0-card').map(element => element.id)
  assert.ok(ids.includes('er-0'))
  for (const token of ['CUSTOMER[', '客户', 'display_name', '名字😀']) assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf(token)), ids)
  for (const token of ['说明', '尾注', '}']) assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf(token)), [])
  assert.ok(lookupDiagramSource(result.sourceMap, source.indexOf('订单')).every(id => id.startsWith('er-edge-0')))
})

test('quoted line breaks render as spaces while original source and exported source remain verbatim', async () => {
  const source = 'erDiagram\r\nCUSTOMER["客户\\n账户"] {\r\n string name "first\\n第二行\\r\\n😀 <literal>"\r\n}'
  const document = importText('comments.mmd', source).documents[0]
  const scene = documentScene(document)
  const rendered = svgTexts(sceneToSvg(scene))
  assert.ok(rendered.some(item => item.text === '客户 账户' && item.lines === 1))
  assert.ok(rendered.some(item => item.text === 'first 第二行 😀 <literal>' && item.lines === 1))
  assert.equal(document.source, source)
  assert.deepEqual((await exportDocument(document, 'mmd')).bytes, new TextEncoder().encode(source))
})

test('SVG file export preserves the full ER table geometry, text and role appearance after a theme', async () => {
  const document = createDocument('mermaid')
  document.source = fixture
  document.diagramStyle = 'midnight'
  document.erStyle = { title: { fontSize: 31, fontWeight: 'bold', color: '#ffcc88' }, tableComment: { fontStyle: 'italic' }, field: { textAlign: 'left' }, comment: { fontSize: 26, fontStyle: 'italic', textAlign: 'right', color: '#ff88cc' } }
  const scene = documentScene(document), exported = new TextDecoder().decode((await exportDocument(document, 'svg')).bytes)
  assert.equal(exported, sceneToSvg(scene, { background: true }))
  const rendered = svgTexts(exported), name = rendered.find(item => item.text === 'CUSTOMER'), comment = rendered.find(item => item.text === '客户编号')
  assert.deepEqual({ size: name.size, weight: name.weight, color: name.color }, { size: 31, weight: 'bold', color: '#ffcc88' })
  assert.deepEqual({ size: comment.size, italic: comment.italic, anchor: comment.anchor, color: comment.color }, { size: 26, italic: 'italic', anchor: 'end', color: '#ff88cc' })
  for (const shape of texts(scene)) assert.equal(rendered.find(item => item.text === shape.text)?.lines, 1)
})

test('ER-specific style options do not alter class cards or other diagram families', () => {
  const erStyle = { title: { fontSize: 48, fontWeight: 'bold' }, field: { fontSize: 48 }, comment: { fontSize: 48, color: '#ee1122' } }
  for (const source of ['classDiagram\nclass CUSTOMER["客户"] {\n+String name\n+run()\n}', 'flowchart LR\nA[客户] --> B[订单]', 'requirementDiagram\nrequirement A {\nid: R1\ntext: 客户资料\n}']) {
    assert.deepEqual(compileCodeDiagram(source, { erStyle }), compileCodeDiagram(source))
  }
})
