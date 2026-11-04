import test from 'node:test'
import assert from 'node:assert/strict'
import { CalendarSession } from '../src/calendar/session.ts'
import { calendarId, createCalendar, decodeCalendar, encodeCalendar, rememberHistory, historySuggestions, preserveHistory } from '../src/calendar/model.ts'
import { dayAllocations, resizeAllocationBoundary, setDayAllocation, rebalanceDayAllocations } from '../src/calendar/allocation.ts'
import { monthSummary } from '../src/calendar/calendar.ts'

function note(overrides = {}) { return { id: calendarId(), title: '会议', content: '', date: '2026-11-04', color: '#4376d4', created_at: '2026-11-04T09:30:00.000Z', type: '工作日', ...overrides } }
function add(session, value) { session.change(copy => { copy.notes.push(value); rememberHistory(copy, value, value.created_at) }) }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`) }

test('Work is a saved undoable view setting that preserves weekend events, historical types and monthly totals', () => {
 const value = createCalendar()
 value.notes = [note({ title: '周五研发', date: '2026-11-06', weight: 0.7 }), note({ title: '周五会议', date: '2026-11-06', weight: 0.3 }), note({ title: '周末工作', date: '2026-11-07', weight: 1 })]
 for (const item of value.notes) rememberHistory(value, item, item.created_at)
 const session = new CalendarSession(encodeCalendar(value)), totals = monthSummary(session.model, '2026-11')
 session.change(copy => { copy.weekMode = 'work' })
 assert.equal(session.model.weekMode, 'work'); assert.equal(session.inspect().dirty, true)
 assert.deepEqual(session.model.notes, value.notes); assert.deepEqual(session.model.history, value.history)
 assert.deepEqual(monthSummary(session.model, '2026-11'), totals)
 close(totals.reduce((sum, item) => sum + item.hours, 0), 14)
 session.undo(); assert.equal(session.model.weekMode, 'week'); assert.equal(session.inspect().dirty, false)
 session.redo(); assert.equal(session.model.weekMode, 'work'); assert.deepEqual(session.model.notes, value.notes)
 const saved = session.export(); session.markSaved(saved.bytes)
 assert.deepEqual(new CalendarSession(saved.bytes).model, session.model)
 assert.throws(() => session.change(copy => { copy.weekMode = 'weekday' }), /Week/)
 assert.equal(session.inspect().dirty, false)
})

test('work event membership automatically rebalances while descriptive and duration edits retain shares', () => {
 const session = new CalendarSession(), first = note(), second = note({ title: '研发' }), third = note({ title: '设计' })
 add(session, first); assert.equal(session.model.notes[0].weight, 1)
 add(session, second); assert.deepEqual(session.model.notes.map(item => item.weight), [0.5, 0.5])
 session.change(copy => resizeAllocationBoundary(copy, first.date, first.id, 70))
 session.change(copy => { copy.notes[0].title = '改名'; copy.notes[0].content = '内容'; copy.notes[0].color = '#9b66c9'; copy.workdayHours = 8; copy.allocationDisplay = 'hours' })
 close(session.model.notes[0].weight, 0.7); close(dayAllocations(session.model, first.date)[0].hours, 5.6)
 add(session, third)
 for (const value of session.model.notes) close(value.weight, 1 / 3)
 session.change(copy => { copy.notes[1].type = '非工作日' })
 assert.equal(Object.hasOwn(session.model.notes[1], 'weight'), false)
 close(session.model.notes[0].weight, 0.5); close(session.model.notes[2].weight, 0.5)
 session.change(copy => { copy.notes = copy.notes.filter(item => item.id !== third.id) })
 assert.equal(session.model.notes[0].weight, 1)
 session.change(copy => { copy.notes[1].type = '工作日' })
 assert.deepEqual(session.model.notes.map(item => item.weight), [0.5, 0.5])
})

test('moving work events rebalances both dates and copying only rebalances the destination', () => {
 const session = new CalendarSession(), a = note({ title: 'A' }), b = note({ title: 'B' }), c = note({ title: 'C', date: '2026-11-05' })
 add(session, a); add(session, b); add(session, c)
 session.change(copy => resizeAllocationBoundary(copy, a.date, a.id, 70))
 const duplicateId = calendarId()
 session.change(copy => { copy.notes.push({ ...copy.notes[0], id: duplicateId, date: c.date }) })
 assert.deepEqual(dayAllocations(session.model, a.date).map(item => item.weight), [0.7, 0.30000000000000004])
 assert.deepEqual(dayAllocations(session.model, c.date).map(item => item.weight), [0.5, 0.5])
 session.change(copy => { copy.notes.find(item => item.id === a.id).date = c.date })
 assert.equal(dayAllocations(session.model, a.date)[0].weight, 1)
 for (const item of dayAllocations(session.model, c.date)) close(item.weight, 1 / 3)
 session.undo(); close(dayAllocations(session.model, a.date)[0].weight, 0.7)
})

test('manual shares, display units and day hours survive undo, save receipts and reopening', () => {
 const session = new CalendarSession(), a = note(), b = note({ title: '研发' })
 add(session, a); add(session, b)
 const before = session.export(); session.markSaved(before.bytes)
 session.change(copy => { copy.workdayHours = 8; copy.allocationDisplay = 'hours'; resizeAllocationBoundary(copy, a.date, a.id, 5.1) })
 close(dayAllocations(session.model, a.date)[0].hours, 5)
 assert.throws(() => session.markSaved(before.bytes), /回执/)
 const allocated = structuredClone(session.model)
 session.undo(); assert.equal(session.model.workdayHours, 7); assert.equal(session.inspect().dirty, false)
 session.redo(); assert.deepEqual(session.model, allocated)
 const exported = session.export(); session.markSaved(exported.bytes)
 assert.deepEqual(new CalendarSession(exported.bytes).model, allocated)
 assert.throws(() => { session.model.notes[0].weight = 1 }, TypeError)
})

test('batched add then allocation keeps the final explicit shares and the reverse order rebalances', () => {
 const session = new CalendarSession(), a = note(), b = note({ title: '研发' }), c = note({ title: '设计' })
 add(session, a)
 session.change(copy => {
  copy.notes.push(b)
  setDayAllocation(copy, a.date, [{ noteId: a.id, weight: 0.8 }, { noteId: b.id, weight: 0.2 }])
 })
 assert.deepEqual(dayAllocations(session.model, a.date).map(item => item.weight), [0.8, 0.2])
 session.change(copy => {
  setDayAllocation(copy, a.date, [{ noteId: a.id, weight: 0.6 }, { noteId: b.id, weight: 0.4 }])
  copy.notes.push(c)
 })
 for (const item of dayAllocations(session.model, a.date)) close(item.weight, 1 / 3)
 session.undo()
 session.change(copy => { copy.notes.push(c); resizeAllocationBoundary(copy, a.date, a.id, 40) })
 const actual = dayAllocations(session.model, a.date)
 close(actual[0].weight, 0.4); close(actual[1].weight, 2 / 3 - 0.4); close(actual[2].weight, 1 / 3)
})

test('per-operation rebalancing preserves batch order when intermediate members are removed again', () => {
 const session = new CalendarSession(), a = note(), b = note({ title: '研发' }), c = note({ title: '临时' })
 add(session, a); add(session, b)
 session.change(copy => resizeAllocationBoundary(copy, a.date, a.id, 80))
 session.change(copy => {
  setDayAllocation(copy, a.date, [{ noteId: a.id, weight: 0.7 }, { noteId: b.id, weight: 0.3 }])
  copy.notes.push(c); rebalanceDayAllocations(copy, a.date)
  copy.notes = copy.notes.filter(item => item.id !== c.id); rebalanceDayAllocations(copy, a.date)
 })
 assert.deepEqual(dayAllocations(session.model, a.date).map(item => item.weight), [0.5, 0.5])
})

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
