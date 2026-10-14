import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresentation, PresentationController, PRESENTATION_LIMITS, imageDimensions } from '../src/presentation/core/model.ts'

const controller = () => new PresentationController(createPresentation(), 'model-test')
const current = c => c.model.slides[c.currentPageIndex]
const last = c => current(c).objects.at(-1)
const insert = (c, x = 10, y = 20, width = 30, height = 40) => {
  c.action({ type: 'insert-shape', shapeType: 'rectangle', x, y, width, height })
  return last(c).id
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg=='

test('ungroup records the removed source coordinate space and undo restores it without mutating XML', () => {
  const c = controller(), first = insert(c), second = insert(c, 50, 20, 30, 40)
  const original = '<source-local-transform/>'
  c.model.slides[0].objects[0].sourceXml = original
  c.action({ type: 'arrange-objects', ids: [first, second], operation: 'group' })
  const group = c.model.slides[0].objects[0]
  c.action({ type: 'arrange-objects', ids: [group.id], operation: 'ungroup' })
  assert.equal(c.model.slides[0].objects[0].sourceTransformDetached, true)
  assert.equal(c.model.slides[0].objects[1].sourceTransformDetached, undefined)
  assert.equal(c.model.slides[0].objects[0].sourceXml, original)
  c.undo()
  assert.equal(c.model.slides[0].objects[0].children[0].sourceTransformDetached, undefined)
  c.redo()
  assert.equal(c.model.slides[0].objects[0].sourceTransformDetached, true)
  assert.equal(c.model.slides[0].objects[0].sourceXml, original)
})

test('a new presentation has a complete detached workbench state and no runtime dependency', () => {
  const c = controller(), state = c.state()
  assert.equal(state.documentId, 'model-test')
  assert.equal(state.pageCount, 1)
  assert.equal(state.currentPage.id, state.pages[0].id)
  assert.equal(state.currentPage.background.type, 'solid')
  assert.equal(state.dirty, false)
  assert.equal(c.canUndo, false)
  assert.ok(state.pageSize.width > state.pageSize.height)
  c.assertNoPendingEdits()
  c.action({ type: 'insert-text', text: '可编辑文本', textStyle: { fontSize: 36, bold: true, color: '#112233' } })
  const objects = c.state().objects
  objects[0].textStyle.fontSize = 99
  objects[0].text = 'not canonical'
  assert.equal(last(c).text, '可编辑文本')
  assert.equal(last(c).textStyle.fontSize, 36)
})

test('slide creation, duplication, move, hide, layout, background, size, notes, and deletion commit canonical data', () => {
  const c = controller(), original = current(c).id
  c.batch([
    { type: 'rename-page', pageIndex: 0, name: '开场' },
    { type: 'set-background', pageIndex: 0, color: '#abcdef' },
    { type: 'set-notes', pageIndex: 0, text: '第一行\n第二行' },
    { type: 'set-page-size', width: 280, height: 157.5 },
    { type: 'set-hidden', pageIndex: 0, value: true },
    { type: 'set-layout', pageIndex: 0, layout: 1 },
  ])
  assert.equal(current(c).background, '#ABCDEF')
  assert.equal(c.state().currentPage.notes, '第一行\n第二行')
  assert.deepEqual(c.state().pageSize, { width: 280, height: 157.5 })
  assert.equal(current(c).hidden, true)
  assert.equal(current(c).layout, 1)
  c.action({ type: 'add-page', layout: 19 })
  assert.equal(c.currentPageIndex, 1)
  assert.equal(current(c).layout, 19)
  c.action({ type: 'duplicate-page', pageIndex: 0 })
  assert.equal(c.model.slides.length, 3)
  assert.notEqual(current(c).id, original)
  assert.equal(current(c).notes, '第一行\n第二行')
  c.action({ type: 'move-page', pageIndex: 1, direction: 'up' })
  assert.equal(c.currentPageIndex, 0)
  assert.equal(c.model.slides[1].id, original)
  c.action({ type: 'delete-page', pageIndex: 2 })
  assert.equal(c.model.slides.length, 2)
  c.action({ type: 'delete-page', pageIndex: 0 })
  assert.equal(current(c).id, original)
  assert.throws(() => c.action({ type: 'delete-page', pageIndex: 0 }), /至少/)
  c.undo()
  assert.equal(c.model.slides.length, 2)
})

test('selection updates revision without dirtying the file or recording an undo entry', () => {
  const c = controller(), one = insert(c)
  c.action({ type: 'add-page' }); c.markSaved()
  const revision = c.revision
  c.action({ type: 'select-page', pageIndex: 0 })
  c.action({ type: 'select-objects', ids: [one, one] })
  assert.equal(c.dirty, false)
  assert.equal(c.revision, revision + 2)
  assert.deepEqual(c.selectedObjectIds, [one])
  c.undo()
  assert.equal(c.model.slides.length, 1)
  assert.equal(c.dirty, true)
})

test('page layouts create editable title and content slots and preserve existing text', () => {
  const c = controller()
  c.action({ type: 'set-layout', pageIndex: 0, layout: 1 })
  assert.deepEqual(current(c).objects.map(o => o.name), ['标题', '内容'])
  const title = current(c).objects[0], body = current(c).objects[1]
  c.action({ type: 'update-object', id: title.id, text: '产品介绍' })
  c.action({ type: 'update-object', id: body.id, text: '保留我的内容' })
  const initialTitleY = title.y
  c.action({ type: 'set-layout', pageIndex: 0, layout: 0 })
  assert.notEqual(current(c).objects[0].y, initialTitleY)
  assert.equal(current(c).objects[0].text, '产品介绍')
  assert.equal(current(c).objects[1].text, '保留我的内容')
  c.action({ type: 'add-page', layout: 3 })
  assert.deepEqual(current(c).objects.map(o => o.name), ['标题', '内容', '内容 2'])
  assert.ok(current(c).objects.every(o => o.capabilities.text))
  c.undo(); assert.equal(c.model.slides.length, 1)
})

test('a batch drag is one undo step, and stale revisions reject selection and edits', () => {
  const c = controller(), one = insert(c, 10), two = insert(c, 60), revision = c.revision
  c.batch([
    { type: 'update-object', id: one, x: 20, y: 30, expectedRevision: revision },
    { type: 'update-object', id: two, x: 70, y: 30, expectedRevision: revision },
  ])
  assert.equal(c.revision, revision + 1)
  assert.deepEqual(current(c).objects.map(o => o.x), [20, 70])
  c.undo()
  assert.deepEqual(current(c).objects.map(o => o.x), [10, 60])
  c.redo()
  assert.deepEqual(current(c).objects.map(o => o.x), [20, 70])
  assert.throws(() => c.action({ type: 'select-page', pageIndex: 0, expectedRevision: revision }), /已更新/)
  assert.throws(() => c.action({ type: 'update-object', id: one, x: 200, expectedRevision: -1 }), /版本/)
  assert.equal(current(c).objects[0].x, 20)
})

test('a failed batch restores objects, page navigation, selection, history and revision atomically', () => {
  const c = controller(), one = insert(c)
  c.markSaved()
  const before = c.state(), model = c.model
  assert.throws(() => c.batch([
    { type: 'update-object', id: one, text: 'partial write', x: 44 },
    { type: 'add-page' },
    { type: 'insert-chart', chartType: 'pie', categories: ['one'], series: ['series'], values: [[-1]] },
  ]), /数值/)
  assert.deepEqual(c.state(), before)
  assert.equal(c.model, model)
  assert.equal(c.dirty, false)
  c.undo()
  assert.equal(current(c).objects.length, 0)
})

test('table and chart values are immediate export data and are isolated from callers', () => {
  const c = controller(), cells = [['指标', '收入'], ['Q1', '20']]
  c.action({ type: 'insert-table', rows: 2, columns: 2, cells })
  const tableId = last(c).id
  cells[0][0] = 'external edit'
  assert.equal(last(c).table.cells[0][0], '指标')
  c.action({ type: 'update-table', id: tableId, cells: [['指标', '收入'], ['Q1', '80']] })
  const data = c.objectData({ type: 'table', id: tableId })
  assert.deepEqual(data, { id: tableId, rows: 2, columns: 2, cells: [['指标', '收入'], ['Q1', '80']] })
  data.cells[1][1] = '1000'
  assert.equal(last(c).table.cells[1][1], '80')
  assert.throws(() => c.action({ type: 'update-table', id: tableId, cells: [['bad'], ['ragged', 'row']] }), /列数/)
  c.action({ type: 'insert-chart', chartType: 'column', categories: ['Q1', 'Q2'], series: ['收入', '成本'], values: [[5, 2], [8, 3]], title: '季度' })
  const chartId = last(c).id
  c.action({ type: 'update-chart', id: chartId, chartType: 'line', categories: ['Q3'], series: ['毛利'], values: [[12]], title: '更新' })
  assert.deepEqual(c.objectData({ type: 'chart', id: chartId }), { id: chartId, type: 'line', categories: ['Q3'], series: ['毛利'], values: [[12]], title: '更新' })
  c.undo()
  assert.deepEqual(last(c).chart.values, [[5, 2], [8, 3]])
  c.redo()
  assert.equal(last(c).chart.title, '更新')
  c.assertNoPendingEdits()
  assert.equal(c.model.slides[0].objects[0].table.cells[1][1], '80')
  assert.deepEqual(c.model.slides[0].objects[1].chart.values, [[12]])
})

test('font sizes, geometry and colors remain distinct units and reject invalid numeric bounds', () => {
  const c = controller()
  c.action({ type: 'insert-text', text: '标题', x: 12.5, y: 22, width: 150, height: 30, textStyle: { fontSize: 32 } })
  const objectId = last(c).id
  c.action({ type: 'update-object', id: objectId, rotation: 90, text: '内容', textStyle: { bold: true, italic: true, underline: true, align: 'center', fontName: 'Arial' }, fillColor: '#fefefe', lineColor: '#000000', lineWidth: 1.2 })
  assert.equal(last(c).x, 12.5)
  assert.equal(last(c).textStyle.fontSize, 32)
  assert.equal(last(c).fillColor, '#FEFEFE')
  const before = c.state()
  for (const patch of [{ x: NaN }, { x: Infinity }, { width: -1 }, { height: 5001 }, { rotation: 361 }, { lineWidth: 21 }, { textStyle: { fontSize: 0 } }, { fillColor: 'red' }, { text: 'x'.repeat(20001) }]) {
    assert.throws(() => c.action({ type: 'update-object', id: objectId, ...patch }))
    assert.deepEqual(c.state(), before)
  }
})

test('ordinary paint opacity is independent, bounded, undoable, and rejects unsupported objects atomically', () => {
  const c = controller(), objectId = insert(c), original = structuredClone(last(c))
  c.action({ type: 'update-object', id: objectId, fillOpacity: .1234567, lineOpacity: 0 })
  assert.equal(last(c).fillOpacity, .12346)
  assert.equal(last(c).lineOpacity, 0)
  assert.equal(last(c).opacity, undefined)
  c.undo(); assert.deepEqual(last(c), original)
  c.redo(); assert.equal(last(c).fillOpacity, .12346)
  const before = c.state()
  for (const field of ['fillOpacity', 'lineOpacity']) for (const value of [-.001, 1.001, NaN, Infinity, '0.5', null]) {
    assert.throws(() => c.action({ type: 'update-object', id: objectId, x: 32, [field]: value }))
    assert.deepEqual(c.state(), before)
  }
  c.action({ type: 'update-object', id: objectId, fillOpacity: 0, lineOpacity: 1 })
  assert.equal(last(c).fillOpacity, 0); assert.equal(last(c).lineOpacity, 1)
  c.action({ type: 'update-object', id: objectId, fillColor: null, lineColor: null })
  for (const field of ['fillOpacity', 'lineOpacity']) assert.throws(() => c.action({ type: 'update-object', id: objectId, [field]: .5 }), /先选择/)
  for (const type of ['table', 'image', 'chart', 'group']) {
    const source = last(c); source.type = type; source.fillColor = '#112233'; source.lineColor = '#445566'
    for (const field of ['fillOpacity', 'lineOpacity']) assert.throws(() => c.action({ type: 'update-object', id: objectId, [field]: .5 }), /普通实色/)
  }
})

test('explicit same-color replacement records paint intent and survives a later separate opacity edit', () => {
  const c = controller(), objectId = insert(c), source = last(c), originalFill = source.fillColor, originalLine = source.lineColor
  source.sourceXml = '<source-theme-reference/>'
  source.sourceFingerprint = JSON.stringify(source)
  c.action({ type: 'update-object', id: objectId, fillColor: originalFill, lineColor: originalLine })
  assert.equal(last(c).fillColorOverride, true); assert.equal(last(c).lineColorOverride, true)
  c.action({ type: 'update-object', id: objectId, fillOpacity: .5, lineOpacity: .25 })
  assert.equal(last(c).fillOpacity, .5); assert.equal(last(c).lineOpacity, .25)
  c.undo(); c.undo()
  assert.equal(last(c).fillColorOverride, undefined); assert.equal(last(c).lineColorOverride, undefined)
  c.redo(); assert.equal(last(c).fillColorOverride, true)
  assert.equal(last(c).sourceXml, '<source-theme-reference/>')
})

test('table grid edits can add and remove rows and columns as one atomic undoable operation', () => {
  const c = controller(), cells = [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']]
  c.action({ type: 'insert-table', rows: 3, columns: 3, cells })
  const tableId = last(c).id, before = c.objectData({ type: 'table', id: tableId })
  const expanded = [...cells.map(row => [...row, '新增列']), ['新增行', '7', '8', '9']]
  c.action({ type: 'update-table', id: tableId, cells: expanded })
  assert.deepEqual(c.objectData({ type: 'table', id: tableId }), { id: tableId, rows: 4, columns: 4, cells: expanded })
  c.undo()
  assert.deepEqual(c.objectData({ type: 'table', id: tableId }), before)
  c.redo()
  assert.equal(last(c).table.cells[3][3], '9')
  c.action({ type: 'update-table', id: tableId, cells: [['只留一格']] })
  assert.deepEqual(c.objectData({ type: 'table', id: tableId }), { id: tableId, rows: 1, columns: 1, cells: [['只留一格']] })
  const state = c.state()
  assert.throws(() => c.action({ type: 'update-table', id: tableId, cells: Array.from({ length: 31 }, () => ['too many']) }), /行数/)
  assert.throws(() => c.action({ type: 'update-table', id: tableId, cells: [Array(21).fill('too many')] }), /列数/)
  assert.deepEqual(c.state(), state)
})

test('shape ordering preserves relative selection order and contiguous zIndex values', () => {
  const c = controller(), a = insert(c), b = insert(c), d = insert(c), e = insert(c)
  const ids = () => current(c).objects.map(object => object.id)
  c.action({ type: 'arrange-objects', ids: [d, a], operation: 'front' })
  assert.deepEqual(ids(), [b, e, a, d])
  c.action({ type: 'arrange-objects', ids: [a, d], operation: 'backward' })
  assert.deepEqual(ids(), [b, a, d, e])
  c.action({ type: 'arrange-objects', ids: [d, a], operation: 'back' })
  assert.deepEqual(ids(), [a, d, b, e])
  c.action({ type: 'arrange-objects', ids: [a, d], operation: 'forward' })
  assert.deepEqual(ids(), [b, a, d, e])
  assert.deepEqual(current(c).objects.map(o => o.zIndex), [0, 1, 2, 3])
})

test('alignment and equal edge spacing update real geometry and support a single object aligned to page', () => {
  const c = controller(), a = insert(c, 10, 10, 10, 10), b = insert(c, 30, 30, 20, 10), d = insert(c, 100, 50, 30, 10)
  c.action({ type: 'arrange-objects', ids: [a, b, d], operation: 'align-bottom' })
  assert.deepEqual(current(c).objects.map(o => o.y), [50, 50, 50])
  c.action({ type: 'arrange-objects', ids: [d, a, b], operation: 'distribute-horizontal' })
  assert.deepEqual(current(c).objects.map(o => o.x), [10, 50, 100])
  c.action({ type: 'arrange-objects', ids: [a], operation: 'align-center' })
  assert.equal(current(c).objects[0].x, (c.model.width - 10) / 2)
  const before = c.state()
  assert.throws(() => c.action({ type: 'arrange-objects', ids: [a, b], operation: 'distribute-vertical' }), /三个/)
  assert.deepEqual(c.state(), before)
})

test('grouping, group translation and resizing, ungrouping and undo keep child geometry intact', () => {
  const c = controller(), a = insert(c, 10, 20, 20, 10), b = insert(c, 40, 20, 20, 10)
  c.action({ type: 'arrange-objects', ids: [b, a], operation: 'group' })
  assert.equal(current(c).objects.length, 1)
  const group = last(c)
  assert.equal(group.type, 'group')
  assert.deepEqual(group.children.map(o => o.id), [a, b])
  c.action({ type: 'update-object', id: group.id, x: 20, y: 30, width: 100, height: 20 })
  assert.deepEqual(last(c).children.map(o => [o.x, o.y, o.width, o.height]), [[20, 30, 40, 20], [80, 30, 40, 20]])
  c.action({ type: 'arrange-objects', ids: [group.id], operation: 'ungroup' })
  assert.deepEqual(current(c).objects.map(o => o.id), [a, b])
  assert.deepEqual(c.selectedObjectIds, [a, b])
  c.undo()
  assert.equal(last(c).type, 'group')
  assert.deepEqual(last(c).children.map(o => o.x), [20, 80])
  c.undo()
  assert.deepEqual(last(c).children.map(o => o.x), [10, 40])
})

test('group rotation is applied once on the parent and baked into child centers when ungrouped', () => {
  const c = controller(), a = insert(c, 0, 0, 10, 10), b = insert(c, 20, 0, 10, 10)
  c.action({ type: 'arrange-objects', ids: [a, b], operation: 'group' })
  const groupId = last(c).id
  c.action({ type: 'update-object', id: groupId, rotation: 90 })
  const children = last(c).children
  assert.equal(children[0].x, 0)
  assert.equal(children[0].y, 0)
  assert.equal(children[0].rotation, 0)
  const copied = c.copyObjects()
  c.pasteObjects(copied)
  const duplicate = last(c)
  assert.notEqual(duplicate.id, groupId)
  assert.ok(duplicate.children.every(o => ![a, b].includes(o.id)))
  assert.equal(duplicate.children[0].x, children[0].x + 5)
  duplicate.children[0].text = 'copy change'
  assert.equal(current(c).objects[0].children[0].text, '')
  c.action({ type: 'arrange-objects', ids: [groupId], operation: 'ungroup' })
  assert.ok(Math.abs(current(c).objects[0].x - 10) < 1e-10)
  assert.ok(Math.abs(current(c).objects[0].y + 10) < 1e-10)
  assert.equal(current(c).objects[0].rotation, 90)
})

test('duplicate slides and copied table/chart/image objects have independent data and IDs', () => {
  const c = controller()
  c.action({ type: 'insert-table', rows: 1, columns: 1, cells: [['before']] })
  c.action({ type: 'insert-chart', chartType: 'pie', categories: ['A'], series: ['one'], values: [[8]] })
  c.insertImage({ name: 'pixel.png', base64: png })
  const source = current(c), originals = source.objects.map(o => o.id)
  c.action({ type: 'duplicate-page', pageIndex: 0 })
  assert.ok(current(c).objects.every(o => !originals.includes(o.id)))
  assert.equal(last(c).image.mimeType, 'image/png')
  assert.ok(last(c).image.dataUrl.endsWith(png))
  c.action({ type: 'update-table', id: current(c).objects[0].id, cells: [['after']] })
  assert.equal(c.model.slides[0].objects[0].table.cells[0][0], 'before')
  c.copyObjects(current(c).objects.map(o => o.id))
  c.action({ type: 'select-page', pageIndex: 0 }); c.pasteObjects()
  assert.equal(current(c).objects.length, 6)
  assert.equal(new Set(current(c).objects.map(o => o.id)).size, 6)
  c.undo()
  assert.equal(current(c).objects.length, 3)
})

test('image insertion validates bytes and format and supports data URLs without loading an image runtime', () => {
  const c = controller()
  c.insertImage({ name: 'pixel.png', base64: `data:image/png;base64,${png}` })
  assert.equal(last(c).type, 'image')
  assert.equal(last(c).width, last(c).height)
  assert.equal(last(c).lineColor, null)
  const before = c.state()
  assert.throws(() => c.insertImage({ name: 'wrong.jpg', base64: png, mimeType: 'image/jpeg' }), /格式/)
  assert.throws(() => c.insertImage({ name: 'bad.png', base64: '<script>' }), /编码/)
  assert.deepEqual(c.state(), before)
})

test('transition and media patches form one undoable edit and validate before any partial commit', () => {
  const c = controller(), wav = Uint8Array.from('RIFF0000WAVE', value => value.charCodeAt(0))
  c.editFeatures({ transition: { type: 'push', direction: 'l', durationMs: 800, advanceAfterMs: 5000, advanceOnClick: false }, addMedia: [{ name: 'sound.wav', kind: 'audio', mimeType: 'audio/wav', data: wav, rect: { x: .1, y: .8, width: .2, height: .1 }, start: 'auto', loop: true }] })
  assert.equal(current(c).transition.type, 'push')
  assert.equal(current(c).transition.advanceAfterMs, 5000)
  assert.equal(current(c).media[0].loop, true)
  wav[0] = 0
  assert.equal(current(c).media[0].data[0], 82)
  const media = current(c).media[0], revision = c.revision, before = c.state()
  assert.throws(() => c.editFeatures({ transition: { type: 'fade' }, addMedia: [{ name: 'bad.wav', kind: 'audio', mimeType: 'audio/wav', data: wav, rect: { x: 0, y: 0, width: .1, height: .1 }, start: 'auto' }] }), /格式/)
  assert.deepEqual(c.state(), before)
  assert.equal(current(c).transition.type, 'push')
  assert.throws(() => c.editFeatures({ expectedRevision: revision - 1, name: 'stale' }), /已更新/)
  c.editFeatures({ removeMediaIds: [media.id] })
  assert.equal(current(c).media.length, 0)
  c.undo(); assert.equal(current(c).media[0].id, media.id)
  c.undo(); assert.equal(current(c).transition.type, 'none'); assert.equal(current(c).media.length, 0)
  c.redo(); assert.equal(current(c).media[0].id, media.id)
})

test('history shares source package and existing immutable media buffers while protecting editable data', () => {
  const model = createPresentation(), sourceParts = new Map([['ppt/source.xml', new Uint8Array([1, 2, 3])]])
  model.sourceParts = sourceParts
  const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])
  model.slides[0].media.push({ id: 'media-1', shapeId: 'shape-1', name: 'sound.wav', kind: 'audio', mimeType: 'audio/wav', data: bytes, rect: null, rotation: 0, start: 'click', startDelayMs: null, loop: false, external: false, partName: 'ppt/media/a.wav', warnings: [] })
  const c = new PresentationController(model, 'package')
  model.slides[0].name = 'external mutation'
  assert.notEqual(current(c).name, model.slides[0].name)
  c.action({ type: 'insert-text', text: 'one' }); c.action({ type: 'insert-text', text: 'two' }); c.undo(); c.redo()
  assert.equal(c.model.sourceParts, sourceParts)
  assert.equal(current(c).media[0].data, bytes)
  c.markSaved(); c.action({ type: 'set-notes', pageIndex: 0, text: 'new notes' }); c.discardChanges()
  assert.equal(c.model.sourceParts, sourceParts)
  assert.equal(current(c).media[0].data, bytes)
  assert.equal(current(c).notes, '')
})

test('undo and redo use the saved content boundary, preserve history on save, and clear redo after a branch', () => {
  const c = controller()
  c.action({ type: 'insert-text', text: 'saved' })
  const textId = last(c).id
  c.markSaved()
  assert.equal(c.dirty, false)
  assert.equal(c.canUndo, true)
  c.action({ type: 'update-object', id: textId, text: 'later' })
  c.undo(); assert.equal(c.dirty, false); assert.equal(last(c).text, 'saved')
  c.undo(); assert.equal(c.dirty, true); assert.equal(current(c).objects.length, 0)
  c.redo(); assert.equal(c.dirty, false)
  c.redo(); assert.equal(c.dirty, true)
  c.undo(); c.action({ type: 'update-object', id: textId, text: 'branch' })
  assert.equal(c.canRedo, false)
  const revision = c.revision
  c.redo(); assert.equal(c.revision, revision)
  c.discardChanges()
  assert.equal(last(c).text, 'saved')
  assert.equal(c.dirty, false)
  assert.equal(c.canUndo, false)
})

test('a save completion from an older export cannot clear newer edits', () => {
  const c = controller()
  c.action({ type: 'insert-text', text: 'exported' })
  const exportedRevision = c.revision
  c.action({ type: 'update-object', id: last(c).id, text: 'typed during save' })
  c.markSaved(exportedRevision)
  assert.equal(c.dirty, true)
  c.markSaved(c.revision)
  assert.equal(c.dirty, false)
})

test('history has a fixed depth and rejects excess objects without partial mutation', () => {
  const c = controller()
  for (let i = 0; i < PRESENTATION_LIMITS.history + 10; i++) c.action({ type: 'set-notes', pageIndex: 0, text: `note ${i}` })
  let undone = 0
  while (c.canUndo) { c.undo(); undone++ }
  assert.equal(undone, PRESENTATION_LIMITS.history)
  assert.equal(current(c).notes, 'note 9')
  const c2 = controller(), one = insert(c2), object = current(c2).objects[0]
  const copies = Array.from({ length: PRESENTATION_LIMITS.objects }, () => object)
  const before = c2.state()
  assert.throws(() => c2.pasteObjects(copies), /上限/)
  assert.deepEqual(c2.state(), before)
  assert.deepEqual(c2.selectedObjectIds, [one])
})

test('locked objects, missing objects and invalid chart arrays cannot mutate a presentation', () => {
  const c = controller(), one = insert(c)
  current(c).objects[0].locked = true
  const before = c.state()
  assert.throws(() => c.action({ type: 'delete-objects', ids: [one] }), /锁定/)
  assert.throws(() => c.action({ type: 'update-object', id: one, x: 2 }), /锁定/)
  assert.throws(() => c.action({ type: 'select-objects', ids: ['missing'] }), /不存在/)
  assert.throws(() => c.action({ type: 'insert-chart', chartType: 'column', categories: ['A'], series: ['B'], values: [new Array(1)] }), /数值/)
  assert.throws(() => c.action({ type: 'insert-chart', chartType: 'pie', categories: ['A'], series: ['B'], values: [[0]] }), /正数/)
  assert.deepEqual(c.state(), before)
})

test('protected copies keep source geometry and copied media keep their page-local source shape identity', () => {
  const model = createPresentation()
  model.slides[0].media.push({ id: 'media-original', shapeId: '42', name: 'sound.wav', kind: 'audio', mimeType: 'audio/wav', data: new Uint8Array(12), rect: null, rotation: 0, start: 'click', startDelayMs: null, loop: false, external: false, partName: 'ppt/media/a.wav', warnings: [] })
  const c = new PresentationController(model, 'protected'), one = insert(c, 20, 30)
  last(c).locked = true
  c.duplicateObjects([one])
  assert.equal(last(c).x, 20)
  assert.equal(last(c).y, 30)
  assert.notEqual(last(c).id, one)
  c.action({ type: 'duplicate-page', pageIndex: 0 })
  assert.equal(current(c).media[0].shapeId, '42')
  assert.notEqual(current(c).media[0].id, 'media-original')
})

test('an explicit clear of an imported advanced background is an undoable export instruction', () => {
  const model = createPresentation()
  Object.assign(model.slides[0], { background: null, sourcePart: 'ppt/slides/slide1.xml', sourceFingerprint: JSON.stringify({ background: null }) })
  const c = new PresentationController(model, 'advanced-background')
  c.action({ type: 'set-background', pageIndex: 0, color: null })
  assert.equal(current(c).backgroundOverride, true)
  assert.equal(c.dirty, true)
  assert.equal(current(c).sourceFingerprint, model.slides[0].sourceFingerprint)
  c.undo()
  assert.equal(current(c).backgroundOverride, undefined)
  assert.equal(c.dirty, false)
})

test('animation target and trigger references block unsafe object operations atomically while safe edits and page copying work', () => {
  const c = controller(), target = insert(c), trigger = insert(c, 80)
  for (const object of current(c).objects) { object.hasAnimation = true; object.sourceCopy = false }
  c.markSaved()
  const before = c.state()
  for (const objectId of [target, trigger]) {
    assert.throws(() => c.action({ type: 'delete-objects', ids: [objectId] }), /动画或触发关系/)
    assert.throws(() => c.copyObjects([objectId]), /动画或触发关系/)
    assert.throws(() => c.duplicateObjects([objectId]), /动画或触发关系/)
    assert.throws(() => c.pasteObjects([current(c).objects.find(object => object.id === objectId)]), /动画或触发关系/)
    assert.deepEqual(c.state(), before)
  }
  assert.throws(() => c.batch([{ type: 'set-notes', pageIndex: 0, text: 'partial' }, { type: 'delete-objects', ids: [trigger] }]), /动画或触发关系/)
  assert.deepEqual(c.state(), before)
  c.action({ type: 'update-object', id: target, x: 22, fillColor: '#146CA4' })
  assert.equal(current(c).objects[0].fillColor, '#146CA4')
  c.action({ type: 'arrange-objects', ids: [target, trigger], operation: 'group' })
  const group = last(c)
  assert.throws(() => c.action({ type: 'arrange-objects', ids: [group.id], operation: 'ungroup' }), /动画或触发关系/)
  assert.throws(() => c.action({ type: 'delete-objects', ids: [group.id] }), /动画或触发关系/)
  c.action({ type: 'duplicate-page', pageIndex: 0 })
  assert.equal(c.model.slides.length, 2)
  assert.ok(last(c).children.every(object => object.sourceCopy === false && object.hasAnimation))
  c.action({ type: 'move-page', pageIndex: 1, direction: 'up' })
  assert.equal(c.currentPageIndex, 0)
})

test('ordinary object copies mark sourceCopy but whole-slide copying preserves source ownership metadata', () => {
  const c = controller(), objectId = insert(c)
  last(c).sourceCopy = false
  c.duplicateObjects([objectId])
  assert.deepEqual(current(c).objects.map(object => object.sourceCopy), [false, true])
  c.action({ type: 'duplicate-page', pageIndex: 0 })
  assert.deepEqual(current(c).objects.map(object => object.sourceCopy), [false, true])
  assert.notEqual(current(c).objects[0].id, c.model.slides[0].objects[0].id)
})

test('free connector and endpoint copies are refused without blocking complete groups or a lone connector', () => {
  const c = controller(), a = insert(c), b = insert(c, 80)
  c.action({ type: 'insert-shape', shapeType: 'line' }); const connector = last(c).id
  for (const [i,object] of current(c).objects.entries()) {
    object.sourcePart = 'ppt/slides/slide1.xml'
    object.sourceXml = `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="Shape"/>${i === 2 ? '<a:stCxn id="2" idx="1"/><a:endCxn id="3" idx="2"/>' : ''}</p:nvSpPr></p:sp>`
  }
  const before = c.state()
  assert.throws(() => c.copyObjects([a,b,connector]), /先组合/)
  assert.throws(() => c.duplicateObjects([a,b,connector]), /先组合/)
  assert.throws(() => c.pasteObjects(current(c).objects), /先组合/)
  assert.deepEqual(c.state(), before)
  assert.equal(c.copyObjects([connector]).length, 1)
  c.action({ type: 'arrange-objects', ids: [a,b,connector], operation: 'group' })
  c.duplicateObjects()
  assert.equal(current(c).objects.length, 2)
  assert.equal(last(c).children.length, 3)
})

test('ungrouping a protected affine source group fails without blocking ordinary group edits', () => {
  const c = controller(), a = insert(c), b = insert(c, 80)
  c.action({ type: 'arrange-objects', ids: [a,b], operation: 'group' })
  last(c).hasComplexGroupTransform = true
  const groupId = last(c).id, before = c.state()
  assert.throws(() => c.action({ type: 'arrange-objects', ids: [groupId], operation: 'ungroup' }), /非等比缩放和旋转/)
  assert.deepEqual(c.state(), before)
  c.action({ type: 'update-object', id: groupId, x: 24 })
  assert.equal(last(c).x, 24)
  delete last(c).hasComplexGroupTransform
  c.action({ type: 'arrange-objects', ids: [groupId], operation: 'ungroup' })
  assert.equal(current(c).objects.length, 2)
})

// Real 13 by 29 raster fixtures generated with Pillow, including EXIF orientation and all WebP encodings.
const portraitImageFixtures = [
  {
    "format": "JPEG",
    "mimeType": "image/jpeg",
    "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAdAA0DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3EKKKKAP/2Q=="
  },
  {
    "format": "GIF",
    "mimeType": "image/gif",
    "base64": "R0lGODdhDQAdAIEAAP8AAAAAAAAAAAAAACwAAAAADQAdAAAIIQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatQYEAA7"
  },
  {
    "format": "WEBP",
    "mimeType": "image/webp",
    "base64": "UklGRkgAAABXRUJQVlA4IDwAAAAwAwCdASoNAB0APm0skUWkIqGYBABABsSgC7LoB+AACEUAAP7wm0P/kFywuuRr/8gP+QH/ID/+PgIkAAA="
  },
  {
    "format": "BMP",
    "mimeType": "image/bmp",
    "base64": "Qk2+BAAAAAAAADYAAAAoAAAADQAAAB0AAAABABgAAAAAAIgEAADEDgAAxA4AAAAAAAAAAAAAAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wA="
  },
  {
    "format": "WEBP_LOSSLESS",
    "mimeType": "image/webp",
    "base64": "UklGRhwAAABXRUJQVlA4TA8AAAAvDAAHAAcQ/Y/+ByKi/wEA"
  },
  {
    "format": "WEBP_EXTENDED",
    "mimeType": "image/webp",
    "base64": "UklGRmYAAABXRUJQVlA4WAoAAAAIAAAADAAAHAAAVlA4IDwAAAAwAwCdASoNAB0APm0skUWkIqGYBABABsSgC7LoB+AACEUAAP7wm0P/kFywuuRr/8gP+QH/ID/+PgIkAABFWElGBAAAAHRlc3Q="
  },
  {
    "format": "JPEG_EXIF_90",
    "mimeType": "image/jpeg",
    "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAANAB0DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3EKKKKAP/2Q=="
  }
]

test('JPEG, GIF, BMP and WebP insertion preserves decoded portrait dimensions, including EXIF rotation', () => {
  for (const fixture of portraitImageFixtures) {
    const c = controller(), bytes = Uint8Array.from(Buffer.from(fixture.base64, 'base64'))
    assert.deepEqual(imageDimensions(bytes, fixture.mimeType), { width: 13, height: 29 }, fixture.format)
    c.insertImage({ name: fixture.format, base64: fixture.base64, mimeType: fixture.mimeType })
    assert.ok(Math.abs(last(c).width / last(c).height - 13 / 29) < 1e-10, fixture.format)
    assert.ok(last(c).width <= c.model.width * .8 && last(c).height <= c.model.height * .8 + 1e-10, fixture.format)
    assert.equal(last(c).image.mimeType, fixture.mimeType)
    c.undo()
    assert.equal(current(c).objects.length, 0)
  }
})

test('truncated and zero-sized image headers fail atomically', () => {
  const c = controller(), before = c.state()
  const pngBytes = Uint8Array.from(Buffer.from(png, 'base64'))
  pngBytes.fill(0, 16, 20)
  assert.throws(() => c.insertImage({ name: 'zero.png', base64: Buffer.from(pngBytes).toString('base64') }), /尺寸/)
  for (const fixture of portraitImageFixtures) {
    const bytes = Uint8Array.from(Buffer.from(fixture.base64, 'base64')).subarray(0, 8)
    assert.throws(() => imageDimensions(bytes, fixture.mimeType), /尺寸/, fixture.format)
  }
  assert.deepEqual(c.state(), before)
})
