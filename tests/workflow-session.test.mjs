import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowSession, workflowByteLength } from '../src/workflow/session.ts'
import { createDocument, parseDocument, serializeDocument, validateDocument } from '../src/workflow/core/documents.ts'
import { DEFAULT_STYLE } from '../src/workflow/core/types.ts'

test('workflow save receipts retain newer edits, while undo can return to the exact saved content', () => {
 const session = new WorkflowSession(createDocument('mermaid'))
 session.change(document => { document.source = 'flowchart LR\n A[开始] --> B[第一版]' })
 const saved = session.export(), revision = session.inspect().revision
 session.change(document => { document.source += '\n B --> C[后续修改]' })
 session.markSaved(saved.bytes)
 assert.equal(session.inspect().dirty, true)
 assert.equal(session.inspect().revision, revision + 1)
 assert.equal(session.undo(), true)
 assert.equal(session.inspect().dirty, false)
 assert.equal(session.redo(), true)
 assert.equal(session.inspect().dirty, true)
 const latest = session.export()
 assert.throws(() => session.markSaved(saved.bytes), /回执/)
 session.markSaved(latest.bytes)
 assert.equal(session.inspect().dirty, false)
 assert.equal(parseDocument(new TextDecoder().decode(latest.bytes)).source, session.model.source)
})

test('workflow histories and receipts stay independent across canvas and code tabs', () => {
 const canvas = new WorkflowSession(createDocument('board')), diagram = new WorkflowSession(createDocument('mermaid'))
 canvas.change(document => { document.scene.elements.push({ id: 'node', type: 'shape', shape: 'rectangle', x: 40, y: 80, width: 100, height: 60, text: '画布', style: { ...DEFAULT_STYLE }, locked: false }) })
 diagram.change(document => { document.source = 'pie\n title 测试\n "完成" : 80\n "待办" : 20' })
 const drawing = canvas.export(), source = diagram.export()
 assert.notEqual(canvas.inspect().documentId, diagram.inspect().documentId)
 assert.throws(() => canvas.markSaved(source.bytes), /回执/)
 canvas.markSaved(drawing.bytes)
 assert.equal(canvas.inspect().dirty, false)
 assert.equal(diagram.inspect().dirty, true)
 canvas.undo(); assert.equal(canvas.model.scene.elements.length, 0)
 assert.match(diagram.model.source, /^pie/)
})

test('workflow failed edits cannot corrupt the model, undo history, or prior receipt', () => {
 const session = new WorkflowSession(createDocument('board'))
 session.change(document => { document.title = '有效画布' })
 const saved = session.export(), before = session.inspect()
 assert.throws(() => session.change(document => { document.scene.elements.push({ type: 'shape', id: 'bad', x: NaN }) }))
 assert.deepEqual(session.inspect(), before)
 assert.equal(session.model.title, '有效画布')
 assert.equal(session.model.scene.elements.length, 0)
 session.markSaved(saved.bytes)
 assert.equal(session.inspect().dirty, false)
})

test('workflow style changes round-trip, deduplicate unchanged edits, and abandon redo branches', () => {
 const session = new WorkflowSession(createDocument('mermaid'))
 session.change(document => { document.diagramStyle = 'blueprint' })
 const before = session.inspect()
 assert.equal(session.change(document => { document.diagramStyle = 'blueprint'; document.updatedAt = new Date(0).toISOString() }), false)
 assert.deepEqual(session.inspect(), before)
 const saved = session.export()
 assert.equal(parseDocument(new TextDecoder().decode(saved.bytes)).diagramStyle, 'blueprint')
 session.undo()
 session.change(document => { document.diagramStyle = 'forest' })
 assert.equal(session.redo(), false)
 assert.equal(session.inspect().canRedo, false)
 assert.equal(session.model.diagramStyle, 'forest')
})

test('workflow byte budgeting exactly matches escaped UTF-8 serialization while retaining only current string sizes', () => {
 const cache = new Map()
 for (const text of ['A'.repeat(8192), '中文😀\n\t"\\\u0000'.repeat(600), '\ud800中\udfff'.repeat(1500)]) {
  const document = validateDocument(createDocument('mermaid'))
  document.source = text
  document.importSource = { name: '中文图表.mmd', format: 'mermaid', text }
  const expected = new TextEncoder().encode(serializeDocument(document)).byteLength
  assert.equal(workflowByteLength(document, cache), expected)
  assert.equal(workflowByteLength(document, cache), expected)
  assert.equal(cache.size, 1)
 }
 workflowByteLength(validateDocument(createDocument('board')), cache)
 assert.equal(cache.size, 0)
})

test('workflow refuses a structurally valid oversized image edit before it changes model or history', () => {
 const session = new WorkflowSession(createDocument('board'))
 session.change(document => { document.title = '原有画布' })
 const saved = session.export(), before = session.inspect()
 // Six individually permitted 9 MiB embedded payloads exceed the file envelope.
 const imageData = 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024)
 assert.throws(() => session.change(document => {
  document.scene.elements = Array.from({ length: 6 }, (_, index) => ({ id: `image-${index}`, type: 'shape', shape: 'image', x: index * 120, y: 20, width: 100, height: 80, text: '', imageData, style: { ...DEFAULT_STYLE }, locked: false }))
 }), /超过 50 MB/)
 assert.deepEqual(session.inspect(), before)
 assert.equal(session.model.title, '原有画布')
 assert.equal(session.model.scene.elements.length, 0)
 session.markSaved(saved.bytes)
 assert.equal(session.inspect().dirty, false)
 assert.equal(session.undo(), true)
 assert.equal(session.model.title, '未命名画布')
})
