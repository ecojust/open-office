import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compileCodeDiagram, lookupDiagramSource } from '../src/workflow/core/code-diagram.ts'
import { createDocument, serializeDocument, parseDocument, contentKey, validateScene } from '../src/workflow/core/documents.ts'
import { exportDocument } from '../src/workflow/core/files.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'

const cardIds = (result, id) => result.scene.elements.filter(element => element.groupId === `${id}-card`).map(element => element.id)
function definition(result, id) {
  assert.ok(Array.isArray(result.sourceDefinitions), 'ER compiler supplies reverse source locations')
  const matches = result.sourceDefinitions.filter(range => range.elementIds.includes(id))
  assert.equal(matches.length, 1, `One definition location for ${id}`)
  return matches[0]
}
function expectHeader(result, source, id, header) {
  const start = source.indexOf(header), range = definition(result, id)
  assert.notEqual(start, -1)
  assert.equal(range.start, start)
  assert.equal(range.end, start + header.length)
  assert.equal(source.slice(range.start, range.end), header)
  for (const member of cardIds(result, id)) assert.equal(definition(result, member), range, `${member} navigates to its owning table header`)
  return range
}

test('ER preview members resolve to their own table headers even when aliases and fields are identical', () => {
  const source = 'erDiagram\nA["Shared alias"] {\n string id PK "Shared comment"\n}\nB["Shared alias"] {\n string id PK "Shared comment"\n}\nA ||--o{ B : related'
  const result = compileCodeDiagram(source)
  assert.equal(result.sourceDefinitions.length, 2)
  for (const [id, header] of [['er-0', 'A["Shared alias"] {'], ['er-1', 'B["Shared alias"] {']]) {
    const range = expectHeader(result, source, id, header)
    assert.deepEqual(range.elementIds, cardIds(result, id))
    for (const role of ['title', 'tableComment', 'separator', 'field-0', 'comment-0']) assert.ok(range.elementIds.includes(`${id}-${role}`))
  }
  assert.notEqual(definition(result, 'er-0-field-0').start, source.indexOf('string id'))
  assert.ok(result.sourceDefinitions.every(range => range.elementIds.every(id => !id.startsWith('er-edge-'))))
})

test('explicit ER blocks take precedence over earlier relationships while implicit tables use their first reference', () => {
  const source = 'erDiagram\nA ||--o{ B : first reference\nB ||--o{ C : later reference\nA["Declared later"] {\n string id\n}\nC {\n}'
  const result = compileCodeDiagram(source)
  expectHeader(result, source, 'er-0', 'A["Declared later"] {')
  expectHeader(result, source, 'er-2', 'C {')
  const implicit = expectHeader(result, source, 'er-1', 'A ||--o{ B : first reference')
  assert.deepEqual(implicit.elementIds, cardIds(result, 'er-1'))
  const forward = lookupDiagramSource(result.sourceMap, source.indexOf('first reference'))
  assert.ok(forward.length && forward.every(id => id.startsWith('er-edge-0')), 'existing forward relationship mapping remains edge-only')
  assert.ok(!forward.includes('er-1'))
})

test('multiple implicit entities can share a fallback range without including edge decorations', () => {
  const source = 'erDiagram\nA ||--o{ B : both implicit\nB ||--o{ C : later'
  const result = compileCodeDiagram(source)
  const first = expectHeader(result, source, 'er-0', 'A ||--o{ B : both implicit')
  assert.equal(definition(result, 'er-1'), first)
  assert.deepEqual(new Set(first.elementIds), new Set([...cardIds(result, 'er-0'), ...cardIds(result, 'er-1')]))
  expectHeader(result, source, 'er-2', 'B ||--o{ C : later')
  assert.ok(result.sourceDefinitions.every(range => range.elementIds.every(id => !id.startsWith('er-edge-'))))
})

test('ER definition ranges retain original BOM, CRLF, non-BMP offsets and exclude trailing hash comments', () => {
  const source = '\uFEFF# source 😀\r\nerDiagram # header\r\n  A["同名😀"] { # table note 😀\r\n    string name "field 😀" # field note\r\n  }\r\n  B["同名😀"] {\r\n  }\r\n  A ||--o{ B : relation 😀 # relationship note'
  const result = compileCodeDiagram(source)
  expectHeader(result, source, 'er-0', 'A["同名😀"] {')
  expectHeader(result, source, 'er-1', 'B["同名😀"] {')
  for (const range of result.sourceDefinitions) {
    assert.ok(range.start >= 0 && range.end <= source.length && range.start < range.end)
    assert.equal(source.slice(range.start, range.end).trim(), source.slice(range.start, range.end))
    assert.ok(!source.slice(range.start, range.end).includes('#'))
  }
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('field 😀')), cardIds(result, 'er-0'))
  for (const comment of ['source 😀', 'table note', 'field note', 'relationship note']) assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf(comment)), [])
  assert.deepEqual(lookupDiagramSource(result.sourceDefinitions, source.indexOf('field 😀')), [], 'reverse definitions do not replace the existing field source ranges')
})

test('empty block and bare ER entities have complete navigation identities', () => {
  const source = 'erDiagram\nEMPTY {\n}\nBARE\nNAMED["Empty alias"] {\n}'
  const result = compileCodeDiagram(source)
  for (const [id, header] of [['er-0', 'EMPTY {'], ['er-1', 'BARE'], ['er-2', 'NAMED["Empty alias"] {']]) {
    assert.deepEqual(expectHeader(result, source, id, header).elementIds, cardIds(result, id))
  }
  assert.ok(result.scene.elements.every(element => !element.id.includes('-field-')))
  assert.deepEqual(lookupDiagramSource(result.sourceMap, source.indexOf('}')), [])
})

test('definition metadata stays outside saved content and SVG file exports', async () => {
  const source = 'erDiagram\nA["表😀"] {\n string id "comment"\n}'
  const result = compileCodeDiagram(source), original = structuredClone(result)
  const doc = createDocument('mermaid')
  doc.source = source; doc.scene = result.scene
  const key = contentKey(doc), plainSvg = sceneToSvg(result.scene)
  // Even accidental attachment to a document is discarded by the native schema.
  doc.sourceDefinitions = result.sourceDefinitions
  assert.equal(contentKey(doc), key)
  const native = serializeDocument(doc), reopened = parseDocument(native)
  assert.ok(!native.includes('sourceDefinitions') && !native.includes('sourceMap'))
  assert.deepEqual(reopened.scene, validateScene(result.scene))
  assert.equal(contentKey(reopened), key)
  assert.equal(new TextDecoder().decode((await exportDocument(doc, 'svg')).bytes), plainSvg)
  assert.ok(!plainSvg.includes('data-element-id') && !plainSvg.includes('sourceDefinitions'))
  for (const member of cardIds(result, 'er-0')) definition(result, member)
  sceneToSvg(result.scene, { interactive: true })
  assert.deepEqual(result, original, 'navigation and interactive rendering leave compiler metadata and scene untouched')
})

test('interactive SVG identifies outer element groups safely while normal exports keep their original markup', () => {
  const ids = ['table " & < > \' 😀', '"></g><script data-injected="yes">alert(1)</script>']
  const scene = { background: '#ffffff', grid: false, elements: ids.map((id, index) => ({
    id, type: 'shape', shape: index ? 'text' : 'rectangle', x: index * 200, y: 20, width: 180, height: 80,
    text: `element ${index}`, style: { ...DEFAULT_STYLE }, locked: false,
  })) }
  const before = structuredClone(scene), plain = sceneToSvg(scene), interactive = sceneToSvg(scene, { interactive: true })
  const errors = [], parsed = new DOMParser({ onError: (level, message) => errors.push({ level, message }) }).parseFromString(interactive, 'image/svg+xml')
  assert.deepEqual(errors, [])
  const groups = Array.from(parsed.getElementsByTagName('g')).filter(group => group.hasAttribute('data-element-id'))
  assert.deepEqual(groups.map(group => group.getAttribute('data-element-id')), ids)
  assert.ok(groups.every(group => group.parentNode === parsed.documentElement), 'identities belong to each element’s outer group')
  assert.equal(parsed.getElementsByTagName('script').length, 0)
  assert.ok(Array.from(parsed.getElementsByTagName('*')).every(element => !element.hasAttribute('data-injected')))
  assert.equal(sceneToSvg(scene, { interactive: false }), plain)
  assert.ok(!plain.includes('data-element-id'))
  assert.equal(sceneToSvg(scene, { interactive: true, background: false }).includes('data-element-id'), true)
  assert.equal(sceneToSvg(scene, { background: false }).includes('data-element-id'), false)
  assert.deepEqual(scene, before)
})
