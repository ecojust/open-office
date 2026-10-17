import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DIAGRAM_TEMPLATES, DIAGRAM_KIND_LABELS } from '../src/workflow/core/diagrams/catalog.ts'
import { compileCodeDiagram, DiagramSyntaxError } from '../src/workflow/core/code-diagram.ts'
import { createDocument, serializeDocument, parseDocument, validateScene } from '../src/workflow/core/documents.ts'
import { sceneToSvg } from '../src/workflow/core/svg.ts'
import { applyDiagramStyle, DIAGRAM_STYLES } from '../src/workflow/core/diagram-appearance.ts'

test('the searchable catalog exposes a unique working template for every supported diagram kind', () => {
  assert.equal(Object.keys(DIAGRAM_KIND_LABELS).length, 22)
  assert.equal(new Set(DIAGRAM_TEMPLATES.map(template => template.id)).size, DIAGRAM_TEMPLATES.length)
  assert.deepEqual(new Set(DIAGRAM_TEMPLATES.map(template => template.kind)), new Set(Object.keys(DIAGRAM_KIND_LABELS)))
  for (const kind of Object.keys(DIAGRAM_KIND_LABELS)) assert.ok(DIAGRAM_TEMPLATES.filter(template => template.kind === kind).length >= 2, `${kind}: complementary syntax examples`)
  for (const template of DIAGRAM_TEMPLATES) {
    assert.ok(template.title && template.description && template.category, template.id)
    const result = compileCodeDiagram(template.source)
    assert.equal(result.kind, template.kind, template.id)
    assert.ok(result.scene.elements.length > 0, template.id)
    assert.deepEqual(compileCodeDiagram(template.source), result, template.id)
    const doc = createDocument('mermaid')
    doc.source = template.source
    doc.scene = result.scene
    const reopened = parseDocument(serializeDocument(doc))
    assert.deepEqual(reopened.scene, validateScene(result.scene), template.id)
    assert.equal(reopened.source, template.source, template.id)
    const errors = []
    const xml = new DOMParser({ onError: (level, message) => errors.push({ level, message }) }).parseFromString(sceneToSvg(result.scene), 'image/svg+xml')
    assert.equal(xml.documentElement.nodeName, 'svg', template.id)
    assert.deepEqual(errors, [], template.id)
    assert.ok(!/NaN|Infinity/.test(sceneToSvg(result.scene)), template.id)
  }
})

test('comprehensive examples retain valid geometry and text in all drawing styles', () => {
  for (const template of DIAGRAM_TEMPLATES) {
    const scene = compileCodeDiagram(template.source).scene, original = structuredClone(scene)
    for (const style of DIAGRAM_STYLES) {
      const painted = applyDiagramStyle(scene, style.id), validated = validateScene(painted), svg = sceneToSvg(validated)
      assert.equal(validated.elements.length, scene.elements.length, `${template.id}/${style.id}`)
      assert.ok(!/NaN|Infinity/.test(svg), `${template.id}/${style.id}: finite export`)
      assert.deepEqual(validated.elements.filter(element => element.type === 'shape').map(element => element.text), scene.elements.filter(element => element.type === 'shape').map(element => element.text), `${template.id}/${style.id}: labels survive styling`)
      assert.ok(svg.startsWith('<svg'), `${template.id}/${style.id}: SVG export`)
    }
    assert.deepEqual(scene, original, `${template.id}: styling does not mutate compiler output`)
  }
})

test('every diagram parser preserves source line numbers and rejects executable configuration', () => {
  for (const template of DIAGRAM_TEMPLATES) {
    const source = `%% safe comment\n\n%%{init: {securityLevel: "loose"}}%%\n${template.source}`
    assert.throws(() => compileCodeDiagram(source), error => error instanceof DiagramSyntaxError && error.line === 3, template.id)
    const prefixed = '\uFEFF%% safe comment\r\n\r\n' + template.source.replaceAll('\n', '\r\n')
    assert.equal(compileCodeDiagram(prefixed).kind, template.kind, template.id)
  }
})
