import assert from 'node:assert/strict'
import test from 'node:test'
import { executeCalendarTool, readCalendar, validateCalendarView } from '../src/calendar/mcp.ts'
import { CALENDAR_MAX_CONTENT, CALENDAR_MAX_HISTORY, CALENDAR_MAX_NOTES, createCalendar, encodeCalendar } from '../src/calendar/model.ts'
import { CalendarSession } from '../src/calendar/session.ts'
import { calendarTools } from '../src/mcp/calendar-tools.ts'
import { catalogForKind, executeDocumentTool } from '../src/mcp/document-tools.ts'

const timestamp = '2026-11-04T10:00:00.000Z'
function item(id, date = '2026-11-04', extra = {}) {
 return { id, title: `事项 ${id}`, content: '', date, color: '#4376d4', type: '工作日', created_at: timestamp, ...extra }
}
function harness(notes = [], history = []) {
 const book = createCalendar('测试日历本'); book.notes = notes; book.history = history
 const session = new CalendarSession(encodeCalendar(book))
 let view = { month: '2026-11', selectedDate: '2026-11-04', selectedNoteId: null, search: '' }, changes = 0, stopped = false
 const guard = () => { if (stopped) throw Error('document changed') }
 const host = { session, view: () => ({ ...view }), setView: next => { view = { ...next } }, changed: () => { changes++ } }
 const handle = { mcpExecute: (name, args, check) => executeCalendarTool(host, name, args, check) }
 return { session, host, handle, guard, stop: () => { stopped = true }, changes: () => changes,
  run: (name, args = {}) => executeDocumentTool('calendar', handle, name, args, guard),
  edit: operations => executeDocumentTool('calendar', handle, 'calendar_edit', { operations }, guard),
 }
}

test('calendar catalog exposes bounded document-local tools and independent values', () => {
 const catalog = catalogForKind('calendar')
 assert.deepEqual(catalog.map(tool => tool.name), ['document_inspect', 'document_undo', 'document_redo', 'calendar_read', 'calendar_edit', 'calendar_set_view', 'calendar_export'])
 for (const definition of calendarTools) {
  assert.equal(definition.inputSchema.additionalProperties, false)
  assert.equal(definition.annotations.openWorldHint, false)
  assert.equal(definition.annotations.readOnlyHint, definition.name !== 'calendar_edit')
 }
 assert.equal(catalog.find(tool => tool.name === 'calendar_edit').annotations.destructiveHint, true)
 catalog.at(-1).inputSchema.properties.format.enum.push('shell')
 assert.deepEqual(catalogForKind('calendar').at(-1).inputSchema.properties.format.enum, ['json'])
})

test('queries intersect date/month/type filters, search body and paginate deterministic complete records', async () => {
 const h = harness([
  item('z', '2026-11-04', { title: 'Alpha', content: 'Meeting agenda' }),
  item('b', '2026-11-04', { title: 'Beta', content: 'MEETING 2', created_at: '2026-11-03T10:00:00.000Z' }),
  item('a', '2026-11-04', { title: 'Alpha', content: 'meeting 3' }),
  item('rest', '2026-11-05', { title: 'meeting break', type: '非工作日' }),
  item('old', '2026-10-31', { title: 'meeting before' }), item('later', '2026-11-06', { title: 'meeting later' }),
 ])
 const before = h.session.inspect()
 const options = { month: '2026-11', from: '2026-11-04', to: '2026-11-05', type: '工作日', query: ' meeting ', limit: 2 }
 const first = await h.run('calendar_read', options)
 assert.equal(first.total, 3); assert.deepEqual(first.notes.map(note => note.id), ['b', 'a'])
 assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 2)
 const second = await h.run('calendar_read', { ...options, offset: first.nextOffset })
 assert.deepEqual(second.notes.map(note => note.id), ['z']); assert.equal(second.hasMore, false); assert.equal(second.nextOffset, null)
 assert.ok(first.history.some(history => history.title === 'meeting before'))
 assert.ok(first.summary.some(summary => summary.title === 'meeting later'), 'whole-month summary ignores query/date filters')
 assert.ok(Math.abs(first.summary.reduce((sum, row) => sum + row.days, 0) - 2) < 1e-12)
 const empty = await h.run('calendar_read', { offset: 100, includeHistory: false, includeSummary: false })
 assert.equal(empty.total, 6); assert.deepEqual(empty.notes, []); assert.equal('history' in empty, false); assert.equal('summary' in empty, false)
 first.notes[0].content = 'not in the document'; first.history[0].title = 'detached'
 assert.equal(h.session.model.notes.find(note => note.id === 'b').content, 'MEETING 2')
 assert.deepEqual(h.session.inspect(), before); assert.equal(h.changes(), 0)
})

test('real date, month, pagination and strict nested schemas reject invalid requests without mutation', async () => {
 const h = harness([item('a')]), before = h.session.inspect()
 const invalid = [
  ['calendar_read', { from: '2026-02-30' }], ['calendar_read', { from: '1899-12-31' }],
  ['calendar_read', { month: '2026-13' }], ['calendar_read', { from: '2026-11-05', to: '2026-11-04' }],
  ['calendar_read', { limit: 501 }], ['calendar_read', { limit: 0 }], ['calendar_read', { offset: -1 }], ['calendar_read', { offset: 10001 }],
  ['calendar_read', { path: '/private/file' }], ['calendar_read', { type: 'weekend' }],
  ['calendar_edit', { operations: [] }], ['calendar_edit', { operations: Array(101).fill({ op: 'book.title', title: 'x' }) }],
  ['calendar_edit', { operations: [{ op: 'note.add', note: { title: 'x', date: '2026-11-04', created_at: timestamp } }] }],
  ['calendar_edit', { operations: [{ op: 'note.update', noteId: 'a', patch: { id: 'other' } }] }],
  ['calendar_edit', { operations: [{ op: 'note.update', noteId: 'a', patch: {} }] }],
  ['calendar_edit', { operations: [{ op: 'note.copy', noteId: 'a', patch: { color: 'red' } }] }],
  ['calendar_edit', { operations: [{ op: 'note.delete', noteId: 'a', all: true }] }],
  ['calendar_edit', { operations: [{ op: 'unknown' }] }], ['calendar_set_view', {}],
  ['calendar_set_view', { month: '2026-00' }], ['calendar_export', { format: 'png' }], ['calendar_export', { format: 'json', path: '/tmp/export' }],
  ['document_undo', { count: 100 }], ['schedule_read', {}],
  ['calendar_read', JSON.parse('{"__proto__":{"polluted":true}}')],
 ]
 for (const [name, args] of invalid) await assert.rejects(h.run(name, args), undefined, `${name} ${JSON.stringify(args).slice(0, 100)}`)
 assert.deepEqual(h.session.inspect(), before); assert.equal(h.changes(), 0)
})

test('atomic additions use defaults, return IDs, record only reusable attributes and share one undo step', async () => {
 const h = harness()
 const result = await h.edit([
  { op: 'book.title', title: '新日历本' },
  { op: 'note.add', note: { id: 'meeting', title: ' 例会 ', date: '2026-11-04', content: 'private agenda', color: '#ff3300', type: '非工作日' } },
  { op: 'note.add', note: { title: '开发', date: '2026-11-05' } },
 ])
 assert.equal(result.revision, 1); assert.equal(result.dirty, true); assert.equal(h.changes(), 1)
 assert.equal(result.created[0].id, 'meeting'); assert.equal(result.created.length, 2)
 const added = h.session.model.notes[1]
 assert.equal(added.id, result.created[1].id); assert.equal(added.content, ''); assert.equal(added.type, '工作日'); assert.equal(added.color, '#4376d4')
 assert.match(added.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
 const history = h.session.model.history.find(item => item.title === '例会')
 assert.deepEqual(Object.keys(history).sort(), ['color', 'lastUsedAt', 'title', 'type']); assert.equal(history.color, '#ff3300')
 await h.run('document_undo')
 assert.equal(h.session.model.notes.length, 0); assert.equal(h.session.model.history.length, 0); assert.equal(h.session.model.title, '测试日历本'); assert.equal(h.session.inspect().dirty, false)
 await h.run('document_redo')
 assert.equal(h.session.model.notes.length, 2); assert.equal(h.session.model.history.length, 2); assert.equal(h.session.inspect().revision, 3)
})

test('updates remember latest attributes across months, history reuse has blank body, copy preserves explicit source content', async () => {
 const h = harness([item('a', '2026-10-02', { title: '例会', content: 'private agenda' })])
 await h.edit([{ op: 'note.update', noteId: 'a', patch: { color: '#223344', type: '非工作日' } }])
 const read = await h.run('calendar_read', { month: '2026-11' })
 assert.equal(read.notes.length, 0)
 const { title, color, type } = read.history[0]
 await h.edit([{ op: 'note.add', note: { id: 'history_new', title, color, type, date: '2026-11-04' } }])
 assert.equal(h.session.model.notes.find(note => note.id === 'history_new').content, '')
 const result = await h.edit([{ op: 'note.copy', noteId: 'a', id: 'copy', patch: { date: '2026-11-05', title: '例会副本' } }])
 assert.deepEqual(result.created, [{ type: 'note', id: 'copy' }])
 const copy = h.session.model.notes.find(note => note.id === 'copy')
 assert.equal(copy.content, 'private agenda'); assert.equal(copy.color, color); assert.equal(copy.type, type); assert.equal(copy.date, '2026-11-05'); assert.notEqual(copy.created_at, timestamp)
 const originalHistoryTime = h.session.model.history.find(item => item.title === '例会').lastUsedAt
 await h.edit([{ op: 'note.move', noteId: 'a', date: '2027-01-02' }, { op: 'note.delete', noteId: 'copy' }, { op: 'notes.clear_month', month: '2026-11' }])
 assert.deepEqual(h.session.model.notes.map(note => [note.id, note.date]), [['a', '2027-01-02']])
 assert.equal(h.session.model.history.find(item => item.title === '例会').lastUsedAt, originalHistoryTime)
 assert.ok(h.session.model.history.some(item => item.title === '例会副本'), 'delete preserves reusable history')
})

test('deleting imported live-only history preserves reusable suggestions atomically and honors explicit saved attributes', async () => {
 for (const operation of [{ op: 'note.delete', noteId: 'imported' }, { op: 'notes.clear_month', month: '2026-11' }]) {
  for (const history of [[], [{ title: '导入事项', color: '#112233', type: '非工作日', lastUsedAt: '2026-11-01T00:00:00.000Z' }]]) {
   const h = harness([
    item('imported', '2026-11-04', { title: '导入事项', color: '#cc5500', content: 'never reuse this private text' }),
    item('another', '2026-12-04', { title: '另一个月', color: '#337711' }),
   ], history)
   const original = structuredClone(h.session.model), snapshot = h.session.inspect(), expectedHistory = (await h.run('calendar_read')).history
   await assert.rejects(h.edit([operation, { op: 'note.delete', noteId: 'missing' }]))
   assert.deepEqual(h.session.model, original); assert.deepEqual(h.session.inspect(), snapshot)
   const result = await h.edit([operation])
   assert.equal(result.revision, 1); assert.equal(h.changes(), 1)
   assert.deepEqual(h.session.model.notes.map(note => note.id), ['another'])
   assert.deepEqual(h.session.model.history, expectedHistory)
   assert.deepEqual((await h.run('calendar_read')).history, expectedHistory)
   assert.ok(h.session.model.history.every(row => !('content' in row) && !('date' in row)))
   if (history.length) assert.deepEqual(h.session.model.history[0], history[0])
   await h.run('document_undo'); assert.deepEqual(h.session.model, original)
   await h.run('document_redo'); assert.deepEqual(h.session.model.history, expectedHistory)
  }
 }
})

test('failure after a valid edit rolls back content, history, revision and undo state together', async () => {
 const h = harness([item('existing')]), initial = structuredClone(h.session.model), snapshot = h.session.inspect()
 const invalid = [
  { op: 'note.delete', noteId: 'missing' },
  { op: 'note.add', note: { id: 'existing', title: 'duplicate', date: '2026-11-04' } },
  { op: 'note.add', note: { id: h.session.model.id, title: 'book ID conflict', date: '2026-11-04' } },
  { op: 'note.add', note: { title: 'invalid date', date: '2026-02-30' } },
  { op: 'note.update', noteId: 'existing', patch: { title: '   ' } },
  { op: 'note.move', noteId: 'existing', date: '1899-12-31' },
  { op: 'notes.clear_month', month: '2026-13' },
 ]
 for (const operation of invalid) {
  await assert.rejects(h.edit([{ op: 'note.add', note: { id: 'valid', title: '会回滚', date: '2026-11-04' } }, operation]))
  assert.deepEqual(h.session.model, initial); assert.deepEqual(h.session.inspect(), snapshot); assert.equal(h.changes(), 0)
 }
})

test('view changes select dates and notes coherently, are detached and never dirty or create undo history', async () => {
 const h = harness([item('december', '2026-12-08')]), snapshot = h.session.inspect()
 let result = await h.run('calendar_set_view', { selectedNoteId: 'december', search: 'meeting' })
 assert.deepEqual(result.view, { month: '2026-12', selectedDate: '2026-12-08', selectedNoteId: 'december', search: 'meeting' })
 result = await h.run('calendar_set_view', { month: '2027-01' })
 assert.equal(result.view.selectedDate, '2027-01-01'); assert.equal(result.view.selectedNoteId, null)
 result = await h.run('calendar_set_view', { selectedDate: '2028-02-29' })
 assert.equal(result.view.month, '2028-02'); result.view.search = 'detached'; assert.equal(h.host.view().search, 'meeting')
 const before = h.host.view()
 for (const patch of [{ selectedDate: '2026-02-29' }, { selectedNoteId: 'missing' }, { selectedDate: '2026-11-04', month: '2026-12' }, { selectedNoteId: 'december', selectedDate: '2026-12-09' }, { selectedNoteId: 'december', month: '2026-11' }]) {
  await assert.rejects(h.run('calendar_set_view', patch)); assert.deepEqual(h.host.view(), before)
 }
 assert.deepEqual(h.session.inspect(), snapshot); assert.equal(h.changes(), 0)
 assert.equal(validateCalendarView(h.session.model, { ...before, selectedNoteId: 'removed' }, { search: '' }).selectedNoteId, null)
})

test('scope guards run before edits, undo, redo and selection changes; failed guard cannot publish a mutation', async () => {
 for (const [name, args] of [
  ['calendar_edit', { operations: [{ op: 'book.title', title: 'blocked' }] }],
  ['document_undo', {}], ['document_redo', {}], ['calendar_set_view', { month: '2027-01' }],
 ]) {
  const h = harness(); await h.edit([{ op: 'book.title', title: 'first' }])
  if (name === 'document_redo') await h.run('document_undo')
  const before = h.session.inspect(), book = structuredClone(h.session.model), view = h.host.view(), changes = h.changes()
  let checks = 0
  assert.throws(() => executeCalendarTool(h.host, name, args, () => { if (++checks === 2) throw Error('document changed') }), /document changed/)
  assert.equal(checks, 2); assert.deepEqual(h.session.inspect(), before); assert.deepEqual(h.session.model, book); assert.deepEqual(h.host.view(), view); assert.equal(h.changes(), changes)
 }
 const stopped = harness(); stopped.stop()
 await assert.rejects(stopped.run('calendar_read'), /document changed/)
 assert.equal(stopped.changes(), 0)
})

test('read-only JSON export is complete and detached and never manufactures a save receipt', async () => {
 const h = harness([item('original')])
 await h.edit([{ op: 'note.update', noteId: 'original', patch: { content: 'changed' } }])
 assert.throws(() => h.session.validateReceipt(), /回执/)
 const before = h.session.inspect(), result = await h.run('calendar_export', { format: 'json' })
 assert.equal(result.mimeType, 'application/json'); assert.equal(result.format, 'json'); assert.deepEqual(result.book, h.session.model)
 result.book.notes[0].content = 'detached'
 assert.equal(h.session.model.notes[0].content, 'changed'); assert.deepEqual(h.session.inspect(), before); assert.throws(() => h.session.validateReceipt(), /回执/)
 const saved = h.session.export(); h.session.markSaved(saved.bytes)
 await h.run('calendar_read'); await h.run('calendar_export', { format: 'json' })
 assert.equal(h.session.inspect().dirty, false); h.session.validateReceipt(saved.bytes)
})

test('workday settings persist as content and readers report actual whole-day shares independently of filtering', async () => {
 const h = harness([item('a', '2026-11-04', { title: 'Alpha' }), item('b', '2026-11-04', { title: 'Beta' }), item('leave', '2026-11-04', { type: '非工作日' })])
 let result = await h.run('calendar_read', { month: '2026-11', query: 'Alpha', limit: 1 })
 assert.equal(result.book.workdayHours, 7); assert.equal(result.book.allocationDisplay, 'percent')
 assert.equal(result.notes[0].share, .5); assert.equal(result.notes[0].days, .5); assert.equal(result.notes[0].hours, 3.5)
 assert.equal(result.summary.find(row => row.title === 'Beta').hours, 3.5)
 assert.equal((await h.run('calendar_read', { type: '非工作日' })).notes[0].hours, 0)
 const changed = await h.edit([{ op: 'book.settings', patch: { workdayHours: 8, allocationDisplay: 'hours' } }])
 assert.equal(changed.dirty, true); assert.equal(changed.revision, 1)
 result = await h.run('calendar_read', { month: '2026-11' })
 assert.equal(result.notes.find(note => note.id === 'a').hours, 4); assert.equal(result.notes.find(note => note.id === 'a').share, .5)
 assert.equal(result.book.allocationDisplay, 'hours')
 const exported = await h.run('calendar_export', { format: 'json' })
 assert.equal(exported.book.workdayHours, 8); assert.equal(exported.book.allocationDisplay, 'hours')
 await h.run('document_undo'); assert.equal(h.session.model.workdayHours, 7); assert.equal(h.session.inspect().dirty, false)
 await h.run('document_redo'); assert.equal(h.session.model.workdayHours, 8)
})

test('explicit day allocation and adjacent divider edits conserve the day and use percentage/hour snapping', async () => {
 const h = harness([item('a'), item('b'), item('c')])
 await h.edit([{ op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'c', weight: .4 }, { noteId: 'a', weight: .2 }, { noteId: 'b', weight: .4 }] }])
 let result = await h.run('calendar_read', { month: '2026-11' })
 assert.deepEqual(result.notes.map(note => note.share), [.2, .4, .4])
 await h.edit([{ op: 'day.adjust', date: '2026-11-04', leftNoteId: 'a', position: 39, display: 'percent' }])
 result = await h.run('calendar_read')
 assert.ok(Math.abs(result.notes[0].share - .4) < 1e-12); assert.ok(Math.abs(result.notes[1].share - .2) < 1e-12); assert.equal(result.notes[2].share, .4)
 await h.edit([{ op: 'book.settings', patch: { allocationDisplay: 'hours' } }, { op: 'day.adjust', date: '2026-11-04', leftNoteId: 'a', position: 2.26 }])
 result = await h.run('calendar_read')
 assert.ok(Math.abs(result.notes[0].hours - 2.5) < 1e-12); assert.ok(Math.abs(result.notes[1].hours - 1.7) < 1e-12); assert.ok(Math.abs(result.notes[2].hours - 2.8) < 1e-12)
 assert.ok(Math.abs(result.notes.reduce((sum, note) => sum + note.share, 0) - 1) < 1e-12)
 const weights = result.notes.map(note => note.share)
 await h.edit([{ op: 'note.update', noteId: 'a', patch: { title: 'renamed', content: 'new body', color: '#112233' } }, { op: 'book.settings', patch: { workdayHours: 10 } }])
 assert.deepEqual((await h.run('calendar_read')).notes.map(note => note.share), weights)
 const exported = await h.run('calendar_export', { format: 'json' })
 const reopened = new CalendarSession(encodeCalendar(exported.book))
 assert.deepEqual(reopened.model.notes.map(note => note.weight), h.session.model.notes.map(note => note.weight))
 const ordered = harness([item('z'), item('a'), item('m')])
 const sorted = (await ordered.run('calendar_read', { limit: 1 })).notes[0]
 assert.equal(sorted.id, 'a'); assert.equal(sorted.allocation.rightNoteId, 'm'); assert.ok(Math.abs(sorted.allocation.start - 1 / 3) < 1e-12)
 await ordered.edit([{ op: 'day.adjust', date: '2026-11-04', leftNoteId: sorted.id, position: 80 }])
 const untouched = (await ordered.run('calendar_read')).notes.find(note => note.id === 'z')
 assert.ok(Math.abs(untouched.share - 1 / 3) < 1e-12, 'divider neighbors use stable capsule order, independent of query sorting or pagination')
})

test('member-changing operations and explicit allocations honor batch order with one atomic undo step', async () => {
 const h = harness([item('a'), item('b'), item('other', '2026-12-04')])
 const allocate = allocations => ({ op: 'day.allocate', date: '2026-11-04', allocations: allocations.map(([noteId, weight]) => ({ noteId, weight })) })
 await h.edit([allocate([['a', .2], ['b', .8]])])
 const snapshot = h.session.inspect()
 await h.edit([{ op: 'note.add', note: { id: 'c', title: 'third', date: '2026-11-04' } }, allocate([['a', .1], ['b', .2], ['c', .7]])])
 let notes = (await h.run('calendar_read', { month: '2026-11' })).notes
 assert.deepEqual(Object.fromEntries(notes.map(note => [note.id, note.share])), { c: .7, a: .1, b: .2 }); assert.equal(h.session.inspect().revision, snapshot.revision + 1)
 await h.run('document_undo'); assert.deepEqual((await h.run('calendar_read', { month: '2026-11' })).notes.map(note => note.share), [.2, .8])
 await h.edit([allocate([['a', .3], ['b', .7]]), { op: 'note.add', note: { id: 'c', title: 'third', date: '2026-11-04' } }])
 notes = (await h.run('calendar_read', { month: '2026-11' })).notes
 assert.ok(notes.every(note => Math.abs(note.share - 1 / 3) < 1e-12))
 await h.edit([allocate([['a', .1], ['b', .2], ['c', .7]]), { op: 'note.move', noteId: 'c', date: '2026-12-04' }])
 assert.deepEqual((await h.run('calendar_read', { month: '2026-11' })).notes.map(note => note.share), [.5, .5])
 assert.deepEqual((await h.run('calendar_read', { month: '2026-12' })).notes.map(note => note.share), [.5, .5])
 await h.edit([{ op: 'note.copy', noteId: 'a', id: 'copy' }])
 assert.ok((await h.run('calendar_read', { month: '2026-11' })).notes.every(note => Math.abs(note.share - 1 / 3) < 1e-12))
 await h.edit([{ op: 'note.update', noteId: 'copy', patch: { type: '非工作日' } }])
 assert.deepEqual((await h.run('calendar_read', { month: '2026-11', type: '工作日' })).notes.map(note => note.share), [.5, .5])
 await h.edit([{ op: 'note.delete', noteId: 'b' }])
 assert.equal((await h.run('calendar_read', { month: '2026-11', type: '工作日' })).notes[0].share, 1)
 const cycle = harness([item('a'), item('b')])
 await cycle.edit([allocate([['a', .2], ['b', .8]])])
 await cycle.edit([allocate([['a', .3], ['b', .7]]), { op: 'note.add', note: { id: 'temporary', title: 'temp', date: '2026-11-04' } }, { op: 'note.delete', noteId: 'temporary' }])
 assert.deepEqual((await cycle.run('calendar_read')).notes.map(note => note.share), [.5, .5], 'transient membership changes still rebalance in operation order')
 await cycle.edit([allocate([['a', .2], ['b', .8]]), { op: 'note.copy', noteId: 'a', id: 'off_copy', patch: { type: '非工作日' } }])
 const copied = (await cycle.run('calendar_read')).notes.find(note => note.id === 'off_copy')
 assert.equal(copied.share, 0); assert.equal('weight' in copied, false)
 assert.deepEqual((await cycle.run('calendar_read', { type: '工作日' })).notes.map(note => note.share), [.2, .8])
})

test('invalid allocations and workday settings reject the whole batch without changing content, history or receipt', async () => {
 const h = harness([item('a'), item('b'), item('leave', '2026-11-04', { type: '非工作日' })]), before = structuredClone(h.session.model), snapshot = h.session.inspect()
 const invalid = [
  { op: 'book.settings', patch: { workdayHours: 7.25 } }, { op: 'book.settings', patch: { workdayHours: 0 } }, { op: 'book.settings', patch: { workdayHours: 24.5 } },
  { op: 'book.settings', patch: { allocationDisplay: 'days' } }, { op: 'book.settings', patch: {} },
  { op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'a', weight: 1 }] },
  { op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'a', weight: .5 }, { noteId: 'a', weight: .5 }] },
  { op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'a', weight: .5 }, { noteId: 'leave', weight: .5 }] },
  { op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'a', weight: .4 }, { noteId: 'b', weight: .5 }] },
  { op: 'day.allocate', date: '2026-11-04', allocations: [{ noteId: 'a', weight: -.2 }, { noteId: 'b', weight: 1.2 }] },
  { op: 'day.allocate', date: '2026-11-05', allocations: [{ noteId: 'a', weight: .5 }, { noteId: 'b', weight: .5 }] },
  { op: 'day.adjust', date: '2026-11-04', leftNoteId: 'b', position: 50 },
  { op: 'day.adjust', date: '2026-11-04', leftNoteId: 'a', position: 101 },
  { op: 'note.update', noteId: 'a', patch: { weight: .3 } },
 ]
 for (const operation of invalid) {
  await assert.rejects(h.edit([{ op: 'book.title', title: 'must roll back' }, operation]), undefined, operation.op)
  assert.deepEqual(h.session.model, before); assert.deepEqual(h.session.inspect(), snapshot)
 }
 await assert.rejects(h.run('calendar_set_view', { workdayHours: 8 }))
 assert.equal(h.changes(), 0)
})

test('history and note count limits come from the same model and failed oversized batches remain atomic', async () => {
 const h = harness()
 await h.edit(Array.from({ length: 100 }, (_, index) => ({ op: 'note.add', note: { id: `a${index}`, title: `历史${index}`, date: '2026-11-04' } })))
 await h.edit([{ op: 'note.add', note: { title: '最新', date: '2026-11-04' } }])
 assert.equal(h.session.model.history.length, CALENDAR_MAX_HISTORY); assert.equal(h.session.model.history[0].title, '最新'); assert.equal(h.session.model.history.some(row => row.title === '历史0'), false)
 const full = harness(Array.from({ length: CALENDAR_MAX_NOTES }, (_, index) => item(`n${index}`))), before = full.session.inspect()
 await assert.rejects(full.edit([{ op: 'book.title', title: 'must roll back' }, { op: 'note.add', note: { title: 'too many', date: '2026-11-04' } }]), /10000/)
 assert.deepEqual(full.session.inspect(), before); assert.equal(full.session.model.title, '测试日历本'); assert.equal(full.session.model.history.length, 0)
})

test('large books remain pageable; oversized full results and model byte limits fail explicitly', async () => {
 const content = 'x'.repeat(CALENDAR_MAX_CONTENT)
 const h = harness(Array.from({ length: 400 }, (_, index) => item(`large${index}`, '2026-11-04', { content }))), before = h.session.inspect()
 await assert.rejects(h.run('calendar_export', { format: 'json' }), /内容过多/)
 const page = await h.run('calendar_read', { limit: 10, includeHistory: false })
 assert.equal(page.total, 400); assert.equal(page.notes.length, 10); assert.equal(page.nextOffset, 10); assert.equal(page.notes[0].content.length, CALENDAR_MAX_CONTENT)
 await assert.rejects(h.edit(Array.from({ length: 30 }, (_, index) => ({ op: 'note.add', note: { title: `excess ${index}`, content, date: '2026-11-05' } }))), /8 MiB/)
 assert.deepEqual(h.session.inspect(), before); assert.equal(h.session.model.notes.length, 400); assert.equal(h.session.model.history.length, 0)
 assert.throws(() => h.session.validateReceipt(), /回执/)
})

test('standalone read helpers reject invalid limits instead of relying on caller schemas', () => {
 const book = createCalendar()
 assert.throws(() => readCalendar(book, { limit: Infinity }))
 assert.throws(() => readCalendar(book, { month: '2026-02', from: '2026-02-30' }))
 assert.throws(() => readCalendar(book, { command: 'shell' }))
})
