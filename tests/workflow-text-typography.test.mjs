import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'
import { createDocument, serializeDocument, parseDocument, contentKey, validateElementStyle, DocumentHistory } from '../src/workflow/core/documents.ts'
import { documentScene, exportDocument } from '../src/workflow/core/files.ts'
import { elementToSvg, measureTextWidth, textHorizontalInsets } from '../src/workflow/core/svg.ts'

const node = (style = {}, text = 'Wide fields and comments') => ({
  id: 'text', type: 'shape', shape: 'text', x: 10, y: 20, width: 60, height: 50,
  text, style: { ...DEFAULT_STYLE, ...style }, locked: false,
})
const scene = element => ({ elements: [element], background: '#ffffff', grid: false })
const markup = element => new DOMParser().parseFromString(`<svg>${elementToSvg(element, scene(element))}</svg>`, 'image/svg+xml')

test('optional text typography roundtrips and changes history without changing legacy default identity', () => {
  const doc = createDocument('flow')
  doc.scene.elements = [node()]
  const legacyKey = contentKey(doc), history = new DocumentHistory(doc)
  assert.deepEqual(validateElementStyle(DEFAULT_STYLE), DEFAULT_STYLE)
  doc.scene.elements[0].style = { ...DEFAULT_STYLE, fontWeight: 'normal', fontStyle: 'normal', textWrap: 'wrap' }
  assert.equal(contentKey(doc), legacyKey)
  assert.equal(contentKey(parseDocument(serializeDocument(doc))), legacyKey)
  doc.scene.elements[0].style = { ...DEFAULT_STYLE, fontWeight: 'bold', fontStyle: 'italic', textWrap: 'nowrap' }
  const changedKey = contentKey(doc)
  assert.notEqual(changedKey, legacyKey)
  assert.deepEqual(parseDocument(serializeDocument(doc)).scene.elements[0].style, doc.scene.elements[0].style)
  history.commit(doc)
  assert.equal(contentKey(history.undo()), legacyKey)
  assert.equal(contentKey(history.redo()), changedKey)
  for (const [property, value] of [['fontWeight', 'bolder'], ['fontStyle', 'oblique'], ['textWrap', false]]) {
    assert.throws(() => validateElementStyle({ ...DEFAULT_STYLE, [property]: value }))
  }
})

test('nowrap preserves complete text on one SVG line with typography and alignment', () => {
  const label = 'Very long WMWM field\r\n数据库 😀 & <comment>\nlast line'
  const element = node({ fontWeight: 'bold', fontStyle: 'italic', textWrap: 'nowrap', textAlign: 'right' }, label)
  const rendered = markup(element), text = rendered.getElementsByTagName('text')[0]
  assert.equal(text.getAttribute('font-weight'), 'bold')
  assert.equal(text.getAttribute('font-style'), 'italic')
  assert.equal(text.getAttribute('text-anchor'), 'end')
  assert.equal(text.getElementsByTagName('tspan').length, 1)
  assert.equal(text.textContent, 'Very long WMWM field 数据库 😀 & <comment> last line')
  assert.ok(!text.textContent.includes('…'))
  assert.equal(Number(text.getElementsByTagName('tspan')[0].getAttribute('x')), element.x + element.width - textHorizontalInsets(element.style).right)
  const wrapping = markup(node({}, label)).getElementsByTagName('text')[0]
  assert.ok(wrapping.textContent.includes('…'), 'legacy wrapping and clipping are retained')
  assert.equal(wrapping.hasAttribute('font-weight'), false)
  assert.equal(wrapping.hasAttribute('font-style'), false)
})

test('nowrap italic text reserves side bearings while wrapped alignment stays unchanged', () => {
  assert.deepEqual(textHorizontalInsets({ fontSize: 48 }), { left: 12, right: 10 })
  assert.deepEqual(textHorizontalInsets({ fontSize: 48, fontStyle: 'italic', textWrap: 'wrap' }), { left: 12, right: 10 })
  assert.deepEqual(textHorizontalInsets({ fontSize: 48, fontStyle: 'normal', textWrap: 'nowrap' }), { left: 12, right: 10 })
  assert.deepEqual(textHorizontalInsets({ fontSize: 48, fontStyle: 'italic', textWrap: 'nowrap' }), { left: 29, right: 27 })
  for (const align of ['left', 'right']) {
    const element = node({ fontSize: 48, fontStyle: 'italic', textWrap: 'nowrap', textAlign: align }, '字段😀')
    element.width = 300; element.height = 100
    const x = Number(markup(element).getElementsByTagName('tspan')[0].getAttribute('x'))
    assert.equal(x, align === 'left' ? element.x + 29 : element.x + element.width - 27)
    element.style.textWrap = 'wrap'
    const wrappedX = Number(markup(element).getElementsByTagName('tspan')[0].getAttribute('x'))
    assert.equal(wrappedX, align === 'left' ? element.x + 12 : element.x + element.width - 10)
  }
})

test('edge labels use persisted text typography too', () => {
  const element = { id: 'edge', type: 'edge', from: { x: 0, y: 0 }, to: { x: 100, y: 100 },
    label: 'one\ntwo', arrow: 'none', route: 'straight', locked: false,
    style: { ...DEFAULT_STYLE, fontWeight: 'bold', fontStyle: 'italic', textWrap: 'nowrap' } }
  const text = markup(element).getElementsByTagName('text')[0]
  assert.equal(text.getAttribute('font-weight'), 'bold')
  assert.equal(text.getAttribute('font-style'), 'italic')
  assert.equal(text.textContent, 'one two')
})

test('text measurement leaves room for wide glyphs, font size and italic overhang', () => {
  const text = 'WWWW 数据库 😀'
  assert.equal(measureTextWidth('', 16), 0)
  assert.ok(measureTextWidth('WWWW', 16) > measureTextWidth('iiii', 16))
  assert.ok(measureTextWidth(text, 32) > measureTextWidth(text, 16))
  assert.ok(measureTextWidth(text, 16, 'bold') > measureTextWidth(text, 16))
  assert.ok(measureTextWidth(text, 16, 'bold', 'italic') > measureTextWidth(text, 16, 'bold'))
  assert.equal(measureTextWidth('first\r\nsecond\nthird', 16), measureTextWidth('first second third', 16))
  assert.ok(Number.isFinite(measureTextWidth(text, 16)))
})

test('Canvas measurement reserves space for both webfonts and standalone export fonts', async () => {
  // A separate module instance keeps this fake browser context out of later tests.
  const { measureTextWidth: measure } = await import('../src/workflow/core/svg.ts?canvas-font-fallback')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let mode = 'fallback', canvases = 0
  const fonts = [], values = [], context = {
    font: '',
    measureText(value) {
      fonts.push(this.font); values.push(value)
      const office = this.font.includes('Office UI')
      const width = mode === 'fallback' ? office ? 100 : 180 : office ? 200 : 120
      return { width, actualBoundingBoxLeft: mode === 'ink' ? 10 : 0, actualBoundingBoxRight: mode === 'ink' && !office ? 230 : width }
    },
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag) { assert.equal(tag, 'canvas'); canvases++; return { getContext: () => context } },
  } })
  try {
    assert.equal(measure('field\r\ncomment', 16, 'bold', 'italic'), 185, 'system fallback can be wider than the app font')
    assert.deepEqual(fonts, ["italic bold 16px 'Office UI', 'Office UI CJK', system-ui, sans-serif", 'italic bold 16px system-ui, sans-serif'])
    assert.deepEqual(values, ['field comment', 'field comment'])
    mode = 'office'
    assert.equal(measure('field', 16), 201, 'the app font can be wider than the system fallback')
    mode = 'ink'
    assert.equal(measure('field', 16, 'normal', 'italic'), 245, 'ink overhang is included independently of text advance')
    assert.equal(canvases, 1, 'font comparisons reuse one Canvas context')
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globalThis.document
  }
})

test('legacy ER role configuration is ignored without altering source, scene typography or content identity', async () => {
  const doc = createDocument('mermaid')
  doc.source = '\uFEFF# Original source 😀\r\nerDiagram\r\nTABLE["表说明"] {\r\n string id PK "字段说明"\r\n}\r\n'
  doc.diagramStyle = 'midnight'
  doc.scene.elements = [node({ fontWeight: 'bold', fontStyle: 'italic', textWrap: 'nowrap' }, 'Saved canvas typography')]
  const original = structuredClone(doc), originalKey = contentKey(doc), originalRendered = documentScene(doc)
  doc.erStyle = {
    title: { fontSize: 48, fontWeight: 'normal', textAlign: 'right', color: '#ff0000' },
    tableComment: { fontSize: 10, fontStyle: 'italic' },
    field: { fontSize: 32, fontWeight: 'bold', textAlign: 'center' },
    comment: { fontSize: 48, fontStyle: 'italic', color: '#abcdef' },
  }
  assert.equal(contentKey(doc), originalKey)
  assert.deepEqual(documentScene(doc), originalRendered, 'legacy settings cannot affect rendering even before native validation')
  const restored = parseDocument(JSON.stringify(doc))
  assert.equal(Object.hasOwn(restored, 'erStyle'), false)
  assert.deepEqual(restored, original)
  assert.deepEqual(restored.scene.elements[0].style, doc.scene.elements[0].style)
  assert.equal(contentKey(restored), originalKey)
  assert.deepEqual(documentScene(restored), originalRendered)
  const saved = serializeDocument(doc), reopened = parseDocument(saved)
  assert.equal(saved.includes('"erStyle"'), false)
  assert.deepEqual(reopened, restored)
  assert.equal(contentKey(reopened), originalKey)
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode((await exportDocument(reopened, 'mmd')).bytes), original.source)
  assert.deepEqual((await exportDocument(doc, 'svg')).bytes, (await exportDocument(reopened, 'svg')).bytes)
})
