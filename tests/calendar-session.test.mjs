import test from 'node:test'
import assert from 'node:assert/strict'
import { CalendarSession } from '../src/calendar/session.ts'
import { calendarId, createCalendar, decodeCalendar, encodeCalendar, rememberHistory, historySuggestions, preserveHistory } from '../src/calendar/model.ts'

function note(overrides = {}) { return { id: calendarId(), title: '会议', content: '', date: '2026-11-04', color: '#4376d4', created_at: '2026-11-04T09:30:00.000Z', type: '工作日', ...overrides } }
function add(session, value) { session.change(copy => { copy.notes.push(value); rememberHistory(copy, value, value.created_at) }) }

test('deleting imported notes preserves empty-history suggestions atomically without replacing saved attributes', () => {
 const imported = createCalendar()
 imported.notes = [note({ title: '出差', content: '只属于原事项的正文', date: '2026-01-09' }), note({ title: '既有类型' })]
 const session = new CalendarSession(encodeCalendar(imported))
 const expected = historySuggestions(session.model)
 session.change(copy => { preserveHistory(copy); copy.notes = [] })
 assert.deepEqual(historySuggestions(session.model), expected)
 assert.ok(session.model.history.every(item => !Object.hasOwn(item, 'content')))
 assert.deepEqual(historySuggestions(decodeCalendar(session.export().bytes)), expected)
 assert.equal(session.undo(), true)
 assert.deepEqual(session.model, imported)
 assert.equal(session.inspect().dirty, false)
 assert.equal(session.redo(), true)
 assert.deepEqual(historySuggestions(session.model), expected)

 const withHistory = structuredClone(imported)
 rememberHistory(withHistory, { title: '既有类型', color: '#9b66c9', type: '非工作日' }, '2026-01-01T00:00:00.000Z')
 const persisted = { ...withHistory.history[0] }
 preserveHistory(withHistory)
 assert.deepEqual(withHistory.history[0], persisted, 'explicit saved attributes take priority even when a live note is newer')
 assert.deepEqual(withHistory.notes, imported.notes, 'preserving history cannot alter notes')
})

test('adding an event and its reusable history is one undoable edit that survives save/reopen', () => {
 const session = new CalendarSession(), value = note({ content: '不应带入历史选择的正文' })
 add(session, value)
 assert.equal(session.revision, 1); assert.equal(session.inspect().dirty, true)
 assert.equal(session.model.notes.length, 1); assert.equal(historySuggestions(session.model)[0].title, '会议')
 session.undo(); assert.equal(session.model.notes.length, 0); assert.equal(session.model.history.length, 0); assert.equal(session.inspect().dirty, false)
 session.redo(); assert.equal(session.model.notes[0].content, value.content); assert.equal(session.model.history.length, 1)
 const saved = session.export(); session.markSaved(saved.bytes)
 assert.equal(session.inspect().dirty, false)
 const reopened = new CalendarSession(saved.bytes)
 assert.deepEqual(reopened.model, session.model); assert.equal(reopened.inspect().canUndo, false)
 assert.notEqual(reopened.documentId, session.documentId)
})

test('editing attributes updates the reused title once; moving or deleting notes preserves history', () => {
 const session = new CalendarSession(), original = note()
 add(session, original)
 session.change(copy => {
  const event = copy.notes[0]; event.color = '#9b66c9'; event.type = '非工作日'
  rememberHistory(copy, event, '2026-11-05T00:00:00.000Z')
 })
 assert.equal(session.model.history.length, 1); assert.equal(session.model.history[0].color, '#9b66c9')
 session.undo(); assert.equal(session.model.history[0].color, '#4376d4'); assert.equal(session.model.notes[0].type, '工作日')
 session.redo()
 session.change(copy => { copy.notes[0].date = '2027-01-04' })
 session.change(copy => { copy.notes = [] })
 assert.equal(historySuggestions(session.model)[0].type, '非工作日')
 assert.equal(session.model.history[0].color, '#9b66c9')
 session.undo(); assert.equal(session.model.notes[0].date, '2027-01-04')
})

test('invalid edits and imported data cannot partially replace notes, history or a saved receipt', () => {
 const session = new CalendarSession(); add(session, note())
 const saved = session.export(), before = structuredClone(session.model), state = session.inspect()
 assert.throws(() => session.change(copy => {
  copy.title = '不能提交的标题'; copy.notes[0].date = '2026-02-30'
  rememberHistory(copy, note({ title: '不能提交的历史' }))
 }), /日期/)
 assert.deepEqual(session.model, before); assert.deepEqual(session.inspect(), state)
 assert.throws(() => session.change(copy => {
  const imported = decodeCalendar(new TextEncoder().encode('{"version":2}'))
  Object.assign(copy, imported)
 }))
 assert.deepEqual(session.model, before); assert.deepEqual(session.inspect(), state)
 session.markSaved(saved.bytes); assert.equal(session.inspect().dirty, false)
})

test('a save receipt cannot clear edits made while the file write was pending', () => {
 const session = new CalendarSession(); add(session, note())
 const pending = session.export(), revision = session.revision
 session.change(copy => { copy.notes[0].content = '导出之后的新修改' })
 assert.throws(() => session.markSaved(pending.bytes), /回执/)
 assert.equal(session.inspect().dirty, true); assert.equal(session.revision, revision + 1)
 session.undo()
 assert.throws(() => session.markSaved(pending.bytes), /回执/, 'returning to identical content cannot revive a receipt for an earlier revision')
 const latest = session.export(); session.markSaved(latest.bytes)
 assert.equal(session.inspect().dirty, false)
 session.redo(); assert.equal(session.inspect().dirty, true)
})

test('receipts reject foreign bytes and mutations of an exported byte array', () => {
 const first = new CalendarSession(), second = new CalendarSession()
 add(first, note()); add(second, note({ title: '其他日历' }))
 const a = first.export(), b = second.export()
 assert.throws(() => first.markSaved(b.bytes), /回执/)
 const modified = a.bytes.slice(); modified[0] ^= 1
 assert.throws(() => first.markSaved(modified), /回执/)
 first.markSaved(a.bytes)
 assert.equal(first.inspect().dirty, false); assert.equal(second.inspect().dirty, true)
 first.undo(); assert.equal(second.model.notes.length, 1)
})

test('owned models and query results cannot mutate a live session behind its revision counter', () => {
 const session = new CalendarSession(); add(session, note())
 const state = session.inspect()
 assert.throws(() => { session.model.title = 'untracked change' }, TypeError)
 assert.throws(() => { session.model.notes[0].content = 'untracked change' }, TypeError)
 assert.throws(() => { session.model.history.push({}) }, TypeError)
 const suggestion = historySuggestions(session.model)[0]; suggestion.color = '#000000'
 assert.equal(session.model.history[0].color, '#4376d4'); assert.deepEqual(session.inspect(), state)
 const saved = session.export(); assert.deepEqual(decodeCalendar(saved.bytes), session.model)
})

test('no-op edits retain receipts and new edits abandon redo without losing the saved baseline', () => {
 const session = new CalendarSession(), exported = session.export()
 assert.equal(session.change(copy => { copy.title = copy.title }), false)
 session.markSaved(exported.bytes); assert.equal(session.revision, 0)
 session.change(copy => { copy.title = '第一次' }); session.change(copy => { copy.title = '第二次' })
 session.undo(); assert.equal(session.inspect().canRedo, true)
 session.change(copy => { copy.title = '另一分支' }); assert.equal(session.redo(), false)
 session.undo(); session.undo(); assert.equal(session.inspect().dirty, false)
})

test('history is bounded and remains usable after many changes', () => {
 const session = new CalendarSession(encodeCalendar(createCalendar('初始日历')))
 for (let index = 0; index < 130; index++) session.change(copy => { copy.title = `第 ${index} 次` })
 let count = 0
 while (session.undo()) count++
 assert.equal(count, 99); assert.equal(session.model.title, '第 30 次')
 while (session.redo()) {}
 assert.equal(session.model.title, '第 129 次'); assert.equal(session.revision, 328)
})

test('reentrant edits preserve the committed inner operation and reject the stale outer copy', () => {
 const session = new CalendarSession()
 assert.throws(() => session.change(copy => {
  copy.title = '不得覆盖'
  session.change(inner => { inner.title = '已经提交的修改' })
 }), /已有其他修改/)
 assert.equal(session.model.title, '已经提交的修改'); assert.equal(session.revision, 1)
 session.undo(); assert.equal(session.model.title, '日历便笺')
})
