import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocument, parseDocument, serializeDocument, contentKey, DocumentHistory, safeImage, validateDocument, validateScene } from '../src/workflow/core/documents.ts'
import { importText, exportDocument } from '../src/workflow/core/files.ts'

test('all document types roundtrip without changing their editable content', () => {
  for (const kind of ['flow', 'board', 'mermaid']) {
    const doc = createDocument(kind, true)
    assert.equal(contentKey(parseDocument(serializeDocument(doc))), contentKey(doc))
  }
})
test('history records transactions, undo branches discard obsolete redo', () => {
  const doc = createDocument('flow'); const history = new DocumentHistory(doc)
  doc.title = 'First'; history.commit(doc); history.commit(doc)
  doc.title = 'Second'; history.commit(doc)
  assert.equal(history.undo().title, 'First')
  assert.equal(history.undo().title, '未命名画布')
  assert.equal(history.undo(), null)
  assert.equal(history.redo().title, 'First')
  doc.title = 'Branch'; history.commit(doc)
  assert.equal(history.canRedo, false)
  assert.equal(history.undo().title, 'First')
})
test('reject invalid versions, dangling bindings, duplicate IDs, nonfinite geometry and unsafe images', () => {
  const doc = createDocument('flow', true)
  assert.throws(() => parseDocument(JSON.stringify({ ...doc, version: 2 })), /版本/)
  const duplicate = structuredClone(doc.scene); duplicate.elements.push(duplicate.elements[0])
  assert.throws(() => validateScene(duplicate), /重复/)
  const dangling = structuredClone(doc.scene); dangling.elements.find(e => e.type === 'edge').from.nodeId = 'missing'
  assert.throws(() => validateScene(dangling), /不存在/)
  const bad = structuredClone(doc.scene); bad.elements[0].x = Infinity
  assert.throws(() => validateScene(bad), /数值/)
  const image = structuredClone(doc.scene); image.elements[0].shape = 'image'; image.elements[0].imageData = 'https://example.com/a.svg'
  assert.throws(() => validateScene(image), /图片/)
})
test('external CSS paint resources and extra fields never enter document model', () => {
  const doc = createDocument('board', true)
  doc.scene.elements[0].style.fill = 'url(https://example.com/pixel)'
  doc.scene.elements[0].onclick = 'alert(1)'
  const restored = parseDocument(serializeDocument(doc))
  assert.equal(restored.scene.elements[0].style.fill, '#ffffff')
  assert.equal(restored.scene.elements[0].onclick, undefined)
})
test('native image validation checks base64 structure and decoded size consistently with interchange formats', () => {
  assert.equal(safeImage('data:image/png;base64,YQ=='), true)
  assert.equal(safeImage('data:image/png;base64,YQ=\n='), false)
  assert.equal(safeImage('data:image/png;base64,Y===Q'), false)
  assert.equal(safeImage('data:image/png;base64,A'), false)
  const overLimit = 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil((10 * 1024 * 1024 + 3) / 3))
  assert.equal(safeImage(overLimit), false)
})
test('history snapshots are isolated from later in-place edits', () => {
  const doc = createDocument('board', true); const history = new DocumentHistory(doc)
  const original = doc.scene.elements[0].text
  doc.scene.elements[0].text = 'Changed'; history.commit(doc)
  doc.scene.elements[0].text = 'Uncommitted'
  assert.equal(history.undo().scene.elements[0].text, original)
  assert.equal(history.redo().scene.elements[0].text, 'Changed')
})

test('writers reject content that the reader cannot reopen, before JSON can hide nonfinite numbers', () => {
  const oversizedText = createDocument('board', true)
  oversizedText.scene.elements[0].text = 'x'.repeat(100001)
  assert.throws(() => serializeDocument(oversizedText), /文本/)
  const nonfinite = createDocument('flow', true)
  nonfinite.scene.elements[0].x = NaN
  assert.throws(() => serializeDocument(nonfinite), /数值/)
  const dangling = createDocument('flow', true)
  dangling.scene.elements.find(element => element.type === 'edge').to.nodeId = 'missing'
  assert.throws(() => serializeDocument(dangling), /不存在/)
  assert.throws(() => serializeDocument({ ...createDocument('flow'), version: 2 }), /版本/)
  assert.throws(() => validateDocument(oversizedText), /文本/)
})

test('saved identity ignores property insertion order and templates contain only native fields', () => {
  for (const kind of ['flow', 'board', 'mermaid']) {
    const doc = createDocument(kind, true)
    const reopened = parseDocument(serializeDocument(doc))
    assert.deepEqual(reopened, doc)
    const reordered = structuredClone(doc)
    reordered.scene.elements = reordered.scene.elements.map(element => Object.fromEntries(Object.entries(element).reverse()))
    assert.equal(contentKey(reordered), contentKey(doc))
    assert.equal(contentKey(reopened), contentKey(doc))
  }
  for (const shape of createDocument('flow', true).scene.elements.filter(element => element.type === 'shape')) assert.equal(Object.hasOwn(shape, 'fill'), false)
  for (const note of createDocument('board', true).scene.elements.filter(element => element.shape === 'note')) {
    assert.equal(note.style.stroke, '#334155')
    assert.equal(note.style.strokeWidth, 0)
  }
})

test('history budget includes preserved source and retains a usable undo for large documents', () => {
  const doc = createDocument('flow')
  doc.importSource = { name: 'source.drawio', format: 'drawio', text: 'x'.repeat(2 * 1024 * 1024) }
  const history = new DocumentHistory(doc)
  for (let index = 0; index < 14; index++) { doc.title = `Edit ${index}`; history.commit(doc) }
  let undos = 0
  for (let prior = history.undo(); prior; prior = history.undo()) {
    assert.equal(prior.importSource.text, doc.importSource.text)
    undos++
  }
  assert.ok(undos > 0 && undos <= 4, `24 MiB budget should evict source-bearing snapshots, got ${undos} undos`)
  assert.ok(history.canRedo)
  const large = createDocument('board')
  large.importSource = { name: 'big.drawio', format: 'drawio', text: 'x'.repeat(7 * 1024 * 1024) }
  const minimal = new DocumentHistory(large)
  large.title = 'Second'; minimal.commit(large)
  large.title = 'Third'; minimal.commit(large)
  assert.equal(minimal.undo().title, 'Second')
  assert.equal(minimal.undo(), null)
  assert.equal(minimal.redo().title, 'Third')
})

test('successful import results can be saved with their source and reopened', () => {
  const inputs = [
    ['source.mmd', 'flowchart TD\n  A[开始] --> B[完成]'],
    ['source.excalidraw', JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'n', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }] })],
    ['native.owflow', serializeDocument(createDocument('board', true))],
  ]
  for (const [name, source] of inputs) {
    const imported = importText(name, source)
    for (const doc of imported.documents) {
      assert.deepEqual(parseDocument(serializeDocument(doc)), doc)
      if (!imported.nativeFormat) assert.equal(doc.importSource.text, source)
    }
  }
})

test('an input below 50 MiB is rejected if converted scene plus preserved source cannot be saved', () => {
  const text = '字'.repeat(100000)
  const source = JSON.stringify({ type: 'excalidraw', version: 2, elements: Array.from({ length: 100 }, (_, index) => ({ id: `text-${index}`, type: 'text', x: index, y: 0, width: 100, height: 100, text })) })
  assert.ok(Buffer.byteLength(source) < 50 * 1024 * 1024)
  assert.throws(() => importText('large.excalidraw', source), /50 MB/)
})

test('code diagram source export refuses other document kinds instead of emitting an empty file', async () => {
  for (const kind of ['flow', 'board']) await assert.rejects(exportDocument(createDocument(kind), 'mmd'), /仅代码图表/)
  const doc = createDocument('mermaid')
  assert.equal(new TextDecoder().decode((await exportDocument(doc, 'mmd')).bytes), doc.source)
})
