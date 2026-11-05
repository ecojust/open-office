import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createCalendar, validateCalendar, encodeCalendar, decodeCalendar, calendarId, rememberHistory, historySuggestions, CALENDAR_MAX_BYTES, CALENDAR_MAX_NOTES, CALENDAR_MAX_HISTORY } from '../src/calendar/model.ts'
import { dateNumber, validateMonth, monthDays, visibleMonthDays, isVisibleCalendarDate, normalizeVisibleDate, moveCalendarDate, shiftMonth, todayDate, monthSummary } from '../src/calendar/calendar.ts'
import { dayAllocations, setDayAllocation, setNoteAllocation, noteAllocationLimits, resizeAllocationBoundary } from '../src/calendar/allocation.ts'
import { CalendarSession } from '../src/calendar/session.ts'

function note(overrides = {}) { return { id: calendarId(), title: '项目会议', content: '现场记录\n下一步😀', date: '2026-11-04', color: '#4376d4', created_at: '2026-11-04T09:30:00.000Z', type: '工作日', ...overrides } }
function book() { const value = createCalendar('团队日历😀'); value.notes.push(note()); rememberHistory(value, value.notes[0], '2026-11-04T09:30:00.000Z'); return value }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`) }

test('legacy version-one files default to seven hours and equal shares without rewriting note weights', () => {
 const old = book(); delete old.workdayHours; delete old.allocationDisplay; delete old.weekMode
 old.notes.push(note({ title: '研发' }), note({ title: '沟通' }), note({ title: '年假', type: '非工作日' }))
 const restored = decodeCalendar(new TextEncoder().encode(JSON.stringify(old)))
 assert.equal(restored.version, 1); assert.equal(restored.workdayHours, 7); assert.equal(restored.allocationDisplay, 'percent'); assert.equal(restored.weekMode, 'week')
 assert.ok(restored.notes.every(item => !Object.hasOwn(item, 'weight')))
 const values = dayAllocations(restored, '2026-11-04')
 assert.equal(values.length, 3)
 for (const value of values) { close(value.weight, 1 / 3); close(value.hours, 7 / 3) }
 close(values.reduce((sum, value) => sum + value.hours, 0), 7)
 assert.deepEqual(decodeCalendar(encodeCalendar(restored)), restored)
})

test('Week and Work share six calendar rows and only filter weekends, including compensatory workdays', () => {
 const week = visibleMonthDays('2026-11', 'week', '2026-11-04'), work = visibleMonthDays('2026-11', 'work', '2026-11-04')
 assert.deepEqual(week, monthDays('2026-11', '2026-11-04')); assert.equal(week.length, 42); assert.equal(work.length, 30)
 assert.deepEqual(work, week.filter(day => day.weekday < 5))
 for (let row = 0; row < 6; row++) assert.deepEqual(work.slice(row * 5, row * 5 + 5).map(day => day.weekday), [0, 1, 2, 3, 4])
 assert.equal(work[0].date, '2026-10-26'); assert.equal(work.at(-1).date, '2026-12-04')
 assert.equal(isVisibleCalendarDate('2026-10-01', 'work'), true, 'weekday legal holidays remain visible')
 assert.equal(isVisibleCalendarDate('2026-10-10', 'work'), false, 'Saturday compensatory workdays are still hidden')
 assert.equal(isVisibleCalendarDate('2026-10-10', 'week'), true)
 assert.equal(visibleMonthDays('9999-12', 'work', '9999-12-31').length, 30)
 assert.ok(visibleMonthDays('9999-12', 'work', '9999-12-31').some(day => day.date === null))
 for (const mode of [null, '', 'Work', 'days', 0, {}]) {
  const value = book(); value.weekMode = mode
  assert.throws(() => validateCalendar(value), /Week/)
  assert.throws(() => visibleMonthDays('2026-11', mode), /Week/)
 }
 const value = book(); value.weekMode = 'work'; assert.equal(decodeCalendar(encodeCalendar(value)).weekMode, 'work')
})

test('hidden weekend selections normalize within the displayed grid without losing month-edge focus', () => {
 assert.equal(normalizeVisibleDate('2026-11-01', 'work', '2026-11'), '2026-11-02')
 assert.equal(normalizeVisibleDate('2026-11-07', 'work', '2026-11'), '2026-11-09')
 assert.equal(normalizeVisibleDate('2026-11-08', 'work', '2026-11'), '2026-11-09')
 assert.equal(normalizeVisibleDate('2026-12-06', 'work', '2026-11'), '2026-12-04', 'last spillover weekend cannot move selection beyond the grid')
 assert.equal(normalizeVisibleDate('2026-11-07', 'week', '2026-11'), '2026-11-07')
 assert.equal(normalizeVisibleDate('2026-01-09', 'work', '2026-11'), '2026-11-02')
 assert.equal(normalizeVisibleDate('1900-01-01', 'work'), '1900-01-01')
 assert.equal(normalizeVisibleDate('9999-12-31', 'work'), '9999-12-31')
 for (const date of ['2026-11-01', '2026-11-07', '2026-12-06']) {
  const normalized = normalizeVisibleDate(date, 'work', '2026-11')
  assert.ok(visibleMonthDays('2026-11', 'work').some(day => day.date === normalized))
 }
})

test('Work arrow navigation skips weekends horizontally and preserves weekdays vertically at year boundaries', () => {
 assert.equal(moveCalendarDate('2026-11-06', 'ArrowRight', 'work'), '2026-11-09')
 assert.equal(moveCalendarDate('2026-11-09', 'ArrowLeft', 'work'), '2026-11-06')
 assert.equal(moveCalendarDate('2026-11-09', 'ArrowUp', 'work'), '2026-11-02')
 assert.equal(moveCalendarDate('2026-11-09', 'ArrowDown', 'work'), '2026-11-16')
 assert.equal(moveCalendarDate('2026-10-30', 'ArrowRight', 'work'), '2026-11-02')
 assert.equal(moveCalendarDate('2027-01-01', 'ArrowLeft', 'work'), '2026-12-31')
 assert.equal(moveCalendarDate('2026-11-06', 'ArrowRight', 'week'), '2026-11-07')
 assert.equal(moveCalendarDate('1900-01-01', 'ArrowLeft', 'work'), '1900-01-01')
 assert.equal(moveCalendarDate('1900-01-01', 'ArrowUp', 'work'), '1900-01-01')
 assert.equal(moveCalendarDate('9999-12-31', 'ArrowRight', 'work'), '9999-12-31')
 assert.equal(moveCalendarDate('9999-12-31', 'ArrowDown', 'work'), '9999-12-31')
 assert.throws(() => moveCalendarDate('2026-11-09', 'Home', 'work'), /方向/)
})

test('allocation validation rejects invalid settings, partial weights and non-conserving totals', () => {
 for (const mutate of [
  value => { value.workdayHours = 0 }, value => { value.workdayHours = 24.5 }, value => { value.workdayHours = 7.1 }, value => { value.workdayHours = Infinity }, value => { value.workdayHours = null },
  value => { value.allocationDisplay = 'days' }, value => { value.allocationDisplay = null },
  value => { value.notes[0].weight = null }, value => { value.notes[0].weight = NaN }, value => { value.notes[0].weight = -0.1 }, value => { value.notes[0].weight = 1.1 },
  value => { value.notes[0].weight = 0.5 },
  value => { value.notes[0].weight = 1; value.notes.push(note()) },
  value => { value.notes[0].weight = 1; value.notes[0].type = '非工作日' },
 ]) { const value = book(); mutate(value); assert.throws(() => validateCalendar(value)) }
 const value = book(); value.workdayHours = 0.5; value.allocationDisplay = 'hours'; value.notes[0].weight = 1
 assert.equal(validateCalendar(value).workdayHours, 0.5)
 value.workdayHours = 24; assert.equal(validateCalendar(value).workdayHours, 24)
 value.notes.push(note({ weight: 0 })); assert.equal(validateCalendar(value).notes[1].weight, 0)
})

test('capsule boundaries snap globally and conserve the adjacent pair in percent and hours', () => {
 const value = book(); value.notes.push(note({ title: '研发' }), note({ title: '设计' }))
 const ids = value.notes.map(item => item.id)
 resizeAllocationBoundary(value, '2026-11-04', ids[0], 47, 'percent')
 let shares = dayAllocations(value, '2026-11-04')
 close(shares[0].weight, 0.5); close(shares[1].weight, 1 / 6); close(shares[2].weight, 1 / 3)
 const first = shares[0].weight
 resizeAllocationBoundary(value, '2026-11-04', ids[1], 5.26, 'hours')
 shares = dayAllocations(value, '2026-11-04')
 close(shares[0].weight, first); close(shares[1].hours, 2); close(shares[2].hours, 1.5)
 close(shares.reduce((sum, item) => sum + item.hours, 0), 7)
 resizeAllocationBoundary(value, '2026-11-04', ids[0], -100, 'percent')
 shares = dayAllocations(value, '2026-11-04'); assert.equal(shares[0].weight, 0); close(shares[2].hours, 1.5)
 resizeAllocationBoundary(value, '2026-11-04', ids[0], 1000, 'hours')
 shares = dayAllocations(value, '2026-11-04'); assert.equal(shares[1].weight, 0); close(shares[2].hours, 1.5)
 validateCalendar(value)
 const before = structuredClone(value)
 assert.throws(() => resizeAllocationBoundary(value, '2026-11-04', ids[2], 20))
 assert.throws(() => resizeAllocationBoundary(value, '2026-11-04', ids[0], NaN))
 assert.throws(() => setDayAllocation(value, '2026-11-04', [{ noteId: ids[0], weight: 1 }]))
 assert.throws(() => setDayAllocation(value, '2026-11-04', [{ noteId: ids[0], weight: 0.5 }, { noteId: ids[0], weight: 0.5 }, { noteId: ids[2], weight: 0 }]))
 assert.deepEqual(value, before)
})

test('monthly day, hour and percentage summaries use actual weights and exclude non-work events', () => {
 const value = book(); value.workdayHours = 8
 value.notes = [note({ title: '研发', weight: 0.75 }), note({ title: '会议', weight: 0.25 }), note({ title: '研发', date: '2026-11-05', weight: 1 }), note({ title: '休假', type: '非工作日' })]
 const rows = monthSummary(value, '2026-11')
 assert.deepEqual(rows.map(({ title, days, hours, percent }) => ({ title, days, hours, percent })), [
  { title: '研发', days: 1.75, hours: 14, percent: 87.5 }, { title: '会议', days: 0.25, hours: 2, percent: 12.5 },
 ])
})

test('direct percentage edits preserve later proportions without divider snapping or unrelated changes', () => {
 const value = book(), date = value.notes[0].date
 value.notes = [note({ title: '设计', weight: .2 }), note({ title: '研发', weight: .3 }), note({ title: '测试', weight: .5 }), note({ date: '2026-11-05', weight: 1 }), note({ type: '非工作日' })]
 const before = structuredClone(value), target = value.notes[0].id
 setNoteAllocation(value, date, target, 12.5)
 const rows = dayAllocations(value, date)
 for (const [index, expected] of [.125, .328125, .546875].entries()) close(rows[index].weight, expected)
 assert.equal(rows[0].percent, 12.5); close(rows.reduce((sum, row) => sum + row.hours, 0), 7)
 assert.deepEqual(value.notes.slice(3), before.notes.slice(3)); assert.deepEqual(value.history, before.history)
 for (let index = 0; index < 3; index++) assert.deepEqual({ ...value.notes[index], weight: before.notes[index].weight }, before.notes[index])
 assert.deepEqual(decodeCalendar(encodeCalendar(value)), value)
})

test('direct hour edits use configured daily hours and accept precision beyond a half-hour step', () => {
 const value = book(); value.workdayHours = 7.5; value.allocationDisplay = 'hours'
 value.notes = [note({ weight: .2 }), note({ title: '研发', weight: .3 }), note({ title: '测试', weight: .5 })]
 const target = value.notes[0], date = target.date
 setNoteAllocation(value, date, target.id, 1.125)
 let rows = dayAllocations(value, date)
 close(rows[0].hours, 1.125); close(rows[0].weight, .15)
 close(rows[1].weight, .31875); close(rows[2].weight, .53125)
 close(rows.reduce((sum, row) => sum + row.hours, 0), 7.5)
 value.workdayHours = .5
 setNoteAllocation(value, date, target.id, .125, 'hours')
 rows = dayAllocations(value, date); close(rows[0].weight, .25); close(rows[1].weight, .28125); close(rows[2].weight, .46875)
 value.workdayHours = 24
 setNoteAllocation(value, date, target.id, 3.75, 'hours')
 rows = dayAllocations(value, date); close(rows[0].hours, 3.75); close(rows[1].weight, .31640625); close(rows[2].weight, .52734375)
 validateCalendar(value)
})

test('direct allocation allows zero and full-day values and shares an all-zero remainder equally', () => {
 const value = book(); value.notes = [note({ weight: 1 }), note({ title: '研发', weight: 0 }), note({ title: '测试', weight: 0 })]
 const [a, b, c] = value.notes, date = a.date
 setNoteAllocation(value, date, a.id, 25)
 assert.deepEqual(value.notes.map(item => item.weight), [.25, .375, .375])
 setNoteAllocation(value, date, a.id, 0)
 assert.deepEqual(value.notes.map(item => item.weight), [0, .5, .5])
 setNoteAllocation(value, date, a.id, 100)
 assert.deepEqual(value.notes.map(item => item.weight), [1, 0, 0])
 const full = structuredClone(value)
 assert.throws(() => setNoteAllocation(value, date, c.id, 25), /最后一项/)
 assert.throws(() => setNoteAllocation(value, date, b.id, 100), /最多/)
 assert.deepEqual(value, full)
 setNoteAllocation(value, date, a.id, 0)
 setNoteAllocation(value, date, b.id, 100)
 assert.deepEqual(value.notes.map(item => item.weight), [0, 1, 0]); validateCalendar(value)

 // Positive shares remain meaningful even when their sum is much smaller
 // than the file validator's tolerance; they are not an all-zero remainder.
 value.notes[0].weight = 1; value.notes[1].weight = 1e-300; value.notes[2].weight = 3e-300
 setNoteAllocation(value, date, a.id, 50)
 assert.deepEqual(value.notes.map(item => item.weight), [.5, .125, .375]); validateCalendar(value)
 value.notes[0].weight = 1 - Number.EPSILON; value.notes[1].weight = Number.EPSILON; value.notes[2].weight = 0
 setNoteAllocation(value, date, b.id, 0)
 assert.deepEqual(value.notes.map(item => item.weight), [1 - Number.EPSILON, 0, Number.EPSILON], 'explicit zero moves even a tiny share forward, without changing earlier work')
})

test('direct middle edits preserve every earlier share and distribute only to later work in capsule order', () => {
 const value = book()
 value.notes = [note({ weight: .2 }), note({ type: '非工作日' }), note({ title: '设计', weight: .3 }), note({ date: '2026-11-05', weight: 1 }), note({ title: '研发', weight: .1 }), note({ title: '测试', weight: .4 })]
 const [a, off, b, tomorrow, c, d] = value.notes, date = a.date, before = structuredClone(value)
 setNoteAllocation(value, date, b.id, 25)
 assert.deepEqual(value.notes[0], before.notes[0], 'preceding note and weight remain bit-for-bit unchanged')
 assert.deepEqual(value.notes[1], before.notes[1]); assert.deepEqual(value.notes[3], before.notes[3])
 for (const [index, expected] of [.2, .25, .11, .44].entries()) close(dayAllocations(value, date)[index].weight, expected)
 const prefix = structuredClone(value.notes.slice(0, 4))
 setNoteAllocation(value, date, c.id, 12.5)
 assert.deepEqual(value.notes.slice(0, 4), prefix)
 close(c.weight, .125); close(d.weight, .425)
 value.workdayHours = 7.5
 setNoteAllocation(value, date, b.id, 1.125, 'hours')
 assert.deepEqual(value.notes[0], before.notes[0]); close(b.weight, .15)
 close(c.weight / d.weight, .125 / .425); close(dayAllocations(value, date).reduce((sum, row) => sum + row.hours, 0), 7.5)
 validateCalendar(value)
})

test('sequential left-to-right edits keep accepted values and expose remaining capacity and a fixed final segment', () => {
 const value = book(); value.workdayHours = 8
 value.notes = [note({ weight: .2 }), note({ weight: .3 }), note({ weight: .1 }), note({ weight: .4 })]
 const [a, b, c, d] = value.notes, date = a.date
 assert.deepEqual(noteAllocationLimits(value, date, a.id), { maximum: 100, readonly: false })
 setNoteAllocation(value, date, a.id, 35)
 close(noteAllocationLimits(value, date, b.id).maximum, 65)
 setNoteAllocation(value, date, b.id, 30)
 close(noteAllocationLimits(value, date, c.id, 'hours').maximum, 2.8)
 setNoteAllocation(value, date, c.id, 1.2, 'hours')
 for (const [index, expected] of [.35, .3, .15, .2].entries()) close(value.notes[index].weight, expected)
 assert.equal(a.weight, .35); assert.equal(b.weight, .3)
 const limits = noteAllocationLimits(value, date, d.id); close(limits.maximum, 20); assert.equal(limits.readonly, true)
 const before = structuredClone(value)
 assert.throws(() => setNoteAllocation(value, date, c.id, 36), /最多/)
 assert.throws(() => setNoteAllocation(value, date, c.id, 2.81, 'hours'), /最多/)
 assert.throws(() => setNoteAllocation(value, date, d.id, 0), /最后一项/)
 assert.deepEqual(value, before)
 setNoteAllocation(value, date, d.id, 20)
 assert.deepEqual(value, before, 'the final segment also supports floating point no-op confirmation')
})

test('forward allocation handles zero suffixes, exact remaining boundaries and floating-point capacity without altering the prefix', () => {
 const value = book(); value.notes = [note({ weight: .25 }), note({ weight: .75 }), note({ weight: 0 }), note({ weight: 0 })]
 const [a, b, c, d] = value.notes, date = a.date
 setNoteAllocation(value, date, b.id, 25)
 assert.deepEqual(value.notes.map(item => item.weight), [.25, .25, .25, .25])
 setNoteAllocation(value, date, b.id, 75)
 assert.deepEqual(value.notes.map(item => item.weight), [.25, .75, 0, 0])
 setNoteAllocation(value, date, b.id, 0)
 assert.deepEqual(value.notes.map(item => item.weight), [.25, 0, .375, .375])
 value.notes = [a, b, c]; a.weight = .9; b.weight = .05; c.weight = .05
 setNoteAllocation(value, date, b.id, 10)
 assert.equal(a.weight, .9); close(b.weight, .1); assert.equal(c.weight, 0)
 const before = structuredClone(value)
 assert.throws(() => setNoteAllocation(value, date, b.id, 10.000001), /最多/)
 assert.deepEqual(value, before); validateCalendar(value)
})

test('direct allocation rejects invalid values or targets without changing any model data', () => {
 const value = book(); value.notes = [note({ weight: .4 }), note({ title: '研发', weight: .6 }), note({ type: '非工作日' })]
 const before = structuredClone(value), target = value.notes[0], date = target.date
 for (const invalid of [NaN, Infinity, -Infinity, -.01, 100.01, '25', null, undefined, {}, true]) {
  assert.throws(() => setNoteAllocation(value, date, target.id, invalid, 'percent')); assert.deepEqual(value, before)
 }
 for (const display of ['days', null, false, '', {}]) {
  assert.throws(() => setNoteAllocation(value, date, target.id, 20, display)); assert.deepEqual(value, before)
 }
 for (const [day, id] of [[date, 'missing'], ['2026-11-05', target.id], [date, value.notes[2].id]]) {
  assert.throws(() => setNoteAllocation(value, day, id, 20), /工作事项/); assert.deepEqual(value, before)
 }
 for (const invalid of [-.01, 7.01]) {
  assert.throws(() => setNoteAllocation(value, date, target.id, invalid, 'hours')); assert.deepEqual(value, before)
 }
})

test('a lone work event must retain the whole day and no-op edits preserve legacy and float bytes', () => {
 const single = book(), only = single.notes[0], before = structuredClone(single)
 assert.throws(() => setNoteAllocation(single, only.date, only.id, 50), /占满全天/)
 assert.throws(() => setNoteAllocation(single, only.date, only.id, 6.5, 'hours'), /占满全天/)
 setNoteAllocation(single, only.date, only.id, 100); setNoteAllocation(single, only.date, only.id, 7, 'hours')
 assert.deepEqual(single, before, 'single legacy event need not gain a weight property')

 const legacy = book(); legacy.notes.push(note({ title: '研发' }), note({ title: '测试' }))
 const session = new CalendarSession(encodeCalendar(legacy)), snapshot = session.inspect(), bytes = session.export().bytes
 assert.equal(session.change(copy => setNoteAllocation(copy, only.date, legacy.notes[0].id, 100 / 3)), false)
 assert.deepEqual(session.inspect(), snapshot); assert.deepEqual(session.export().bytes, bytes)
 const floating = book(); floating.notes = [note({ weight: .7 }), note({ title: '研发', weight: .30000000000000004 })]
 const floatSession = new CalendarSession(encodeCalendar(floating)), floatBytes = floatSession.export().bytes
 assert.equal(floatSession.change(copy => setNoteAllocation(copy, only.date, floating.notes[1].id, 30)), false)
 assert.deepEqual(floatSession.export().bytes, floatBytes); assert.equal(floatSession.inspect().dirty, false)
})

test('direct allocation commits once, can undo and redo, and survives a saved file in a new session', () => {
 const value = book(); value.notes = [note({ weight: .2 }), note({ title: '研发', weight: .3 }), note({ title: '测试', weight: .5 })]
 const target = value.notes[1], session = new CalendarSession(encodeCalendar(value)), before = session.export().bytes
 assert.equal(session.change(copy => setNoteAllocation(copy, target.date, target.id, 17.25)), true)
 assert.equal(session.revision, 1); assert.equal(session.inspect().dirty, true)
 close(dayAllocations(session.model, target.date)[1].percent, 17.25)
 assert.deepEqual(session.model.notes[0], value.notes[0], 'saving a middle edit preserves the already allocated prefix')
 const edited = structuredClone(session.model)
 assert.equal(session.undo(), true); assert.deepEqual(session.export().bytes, before); assert.equal(session.inspect().dirty, false)
 assert.equal(session.redo(), true); assert.deepEqual(session.model, edited)
 const saved = session.export(); session.markSaved(saved.bytes)
 const reopened = new CalendarSession(saved.bytes)
 assert.notEqual(reopened.documentId, session.documentId); assert.deepEqual(reopened.model, edited)
 const snapshot = session.inspect()
 assert.throws(() => session.change(copy => setNoteAllocation(copy, target.date, target.id, 101)))
 assert.deepEqual(session.inspect(), snapshot); assert.deepEqual(session.model, edited)
 session.validateReceipt(saved.bytes)
})

test('direct allocation honors batched membership order and validates before touching the draft', () => {
 const value = book(), a = value.notes[0], b = note({ title: '研发' }), c = note({ title: '测试' }), d = note({ title: '上线' })
 const session = new CalendarSession(encodeCalendar(value))
 session.change(copy => { copy.notes.push(b); setNoteAllocation(copy, a.date, a.id, 50) })
 assert.deepEqual(session.model.notes.map(item => item.weight), [.5, .5])
 session.change(copy => {
  copy.notes.push(c)
  const draft = structuredClone(copy)
  assert.throws(() => setNoteAllocation(copy, a.date, a.id, 101)); assert.deepEqual(copy, draft)
  setNoteAllocation(copy, a.date, a.id, 20)
 })
 assert.deepEqual(session.model.notes.map(item => item.weight), [.2, .4, .4])
 session.change(copy => { setNoteAllocation(copy, a.date, a.id, 70); copy.notes.push(d) })
 assert.deepEqual(session.model.notes.map(item => item.weight), [.25, .25, .25, .25])
 session.undo(); assert.deepEqual(session.model.notes.map(item => item.weight), [.2, .4, .4])
 session.change(copy => { copy.notes = copy.notes.filter(item => item.id !== b.id); setNoteAllocation(copy, a.date, a.id, 30) })
 assert.deepEqual(session.model.notes.map(item => item.weight), [.3, .7])
 session.change(copy => { copy.notes.push(d); setNoteAllocation(copy, a.date, c.id, 20) })
 close(session.model.notes[0].weight, 1 / 3)
 close(session.model.notes[1].weight, .2)
 close(session.model.notes[2].weight, 1 - 1 / 3 - .2)
 session.undo(); assert.deepEqual(session.model.notes.map(item => item.weight), [.3, .7])
})

test('calendar UTF-8 round trip keeps notes and independent reusable history', () => {
 const value = book(), copy = structuredClone(value)
 assert.equal(value.format, 'open-office-calendar'); assert.equal(value.version, 1)
 assert.deepEqual(decodeCalendar(encodeCalendar(value)), copy)
 assert.deepEqual(decodeCalendar(new Uint8Array([239, 187, 191, ...encodeCalendar(value)])), copy)
 assert.deepEqual(createCalendar('新日历').notes, []); assert.deepEqual(createCalendar('新日历').history, [])
 const enriched = structuredClone(value); enriched.notes[0].html = '<script>ignored</script>'; enriched.history[0].content = '不得复用的正文'; enriched.extra = 'ignored'
 const checked = validateCalendar(enriched)
 assert.equal(Object.hasOwn(checked, 'extra'), false); assert.equal(Object.hasOwn(checked.notes[0], 'html'), false)
 assert.equal(Object.hasOwn(checked.history[0], 'content'), false)
 assert.deepEqual(Object.keys(historySuggestions(enriched)[0]), ['title', 'color', 'type', 'lastUsedAt'])
 assert.deepEqual(value, copy, 'validation and suggestions cannot mutate the source')
})

test('calendar files reject unsupported versions, malformed arrays and unbounded envelopes', () => {
 for (const mutate of [
  x => { x.version = 2 }, x => { x.format = 'open-office-schedule' }, x => { delete x.history }, x => { x.history = null },
  x => { x.notes = {} }, x => { x.notes = Array(CALENDAR_MAX_NOTES + 1).fill(x.notes[0]) },
  x => { x.history = Array(CALENDAR_MAX_HISTORY + 1).fill(x.history[0]) },
 ]) { const value = book(); mutate(value); assert.throws(() => validateCalendar(value)) }
 for (const value of [null, [], false, 'calendar']) assert.throws(() => validateCalendar(value))
 assert.throws(() => decodeCalendar(new Uint8Array()), /为空/)
 assert.throws(() => decodeCalendar(new Uint8Array(CALENDAR_MAX_BYTES + 1)), /8 MiB/)
 assert.throws(() => decodeCalendar(new Uint8Array([0x7b, 0xff, 0x7d])), /UTF-8/)
 assert.throws(() => decodeCalendar(new TextEncoder().encode('{"format":')), /JSON/)
 const huge = createCalendar(); huge.notes = Array.from({ length: 420 }, () => note({ content: 'x'.repeat(20000) }))
 assert.throws(() => validateCalendar(huge), /8 MiB/)
})

test('calendar validates dates, identity, timestamps, text, type and color before opening', () => {
 for (const mutate of [
  x => { x.notes[0].id = x.id }, x => { x.notes.push({ ...x.notes[0] }) }, x => { x.id = '../book' },
  x => { x.notes[0].date = '2026-02-29' }, x => { x.notes[0].date = '1900-02-29' },
  x => { x.notes[0].date = '2026-13-01' }, x => { x.notes[0].date = '10000-01-01' },
  x => { x.notes[0].type = '未知' }, x => { x.notes[0].color = 'red' }, x => { x.notes[0].color = '#fff' },
  x => { x.notes[0].created_at = '2026-02-30T00:00:00.000Z' },
  x => { x.notes[0].created_at = '2026-11-04T09:30:00Z' }, x => { x.notes[0].created_at = '2026-11-04T25:00:00.000Z' },
  x => { x.history[0].lastUsedAt = 'not-a-time' }, x => { x.history.push({ ...x.history[0], title: ` ${x.history[0].title} ` }) },
  x => { x.title = '   ' }, x => { x.notes[0].title = '😀'.repeat(201) }, x => { x.notes[0].content = '中'.repeat(20001) },
  x => { x.notes[0].content = 'bad\u0000text' },
 ]) { const value = book(); mutate(value); assert.throws(() => validateCalendar(value)) }
 const value = book(); value.notes[0].date = '2000-02-29'; value.notes[0].title = '😀'.repeat(200); value.notes[0].content = '😀'.repeat(20000)
 assert.equal(validateCalendar(value).notes[0].content, value.notes[0].content)
 value.notes[0].date = '9999-12-31'; assert.equal(validateCalendar(value).notes[0].date, '9999-12-31')
})

test('history reuses attributes across months and retains them after original notes are deleted', () => {
 const value = createCalendar(), original = note({ title: '  出差  ', date: '2026-01-09', content: '私有正文不能复用' })
 value.notes.push(original)
 rememberHistory(value, original, '2026-01-09T12:00:00.000Z')
 const updated = note({ title: '出差', date: '2026-06-01', color: '#9b66c9', type: '非工作日' })
 value.notes.push(updated); rememberHistory(value, updated, '2026-06-01T12:00:00.000Z')
 value.notes = []
 assert.deepEqual(historySuggestions(value, ' 出差 '), [{ title: '出差', color: '#9b66c9', type: '非工作日', lastUsedAt: '2026-06-01T12:00:00.000Z' }])
 assert.deepEqual(historySuggestions(decodeCalendar(encodeCalendar(value))), historySuggestions(value))
 const selection = historySuggestions(value)[0]; selection.title = '只修改草稿'; selection.color = '#000000'
 assert.equal(value.history[0].title, '出差'); assert.equal(value.history[0].color, '#9b66c9')
 assert.deepEqual(historySuggestions(value, '不存在'), [])
})

test('history stays bounded and selecting an earlier title promotes its newest attributes', () => {
 const value = createCalendar()
 for (let index = 0; index < 120; index++) rememberHistory(value, note({ title: `事项-${index}` }), new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())
 assert.equal(value.history.length, 100); assert.equal(value.history[0].title, '事项-119'); assert.equal(value.history.at(-1).title, '事项-20')
 rememberHistory(value, note({ title: ' 事项-22 ', color: '#3ce0a8', type: '非工作日' }), '2026-02-02T00:00:00.000Z')
 assert.equal(value.history.length, 100); assert.equal(value.history[0].title, '事项-22'); assert.equal(value.history[0].type, '非工作日')
 assert.equal(value.history.filter(item => item.title === '事项-22').length, 1)
 assert.equal(historySuggestions(value).length, 100)
})

test('history can supplement imported live titles from other months without copying note text', () => {
 const value = createCalendar()
 value.notes = [note({ title: 'Planning', date: '2026-01-01', created_at: '2026-01-01T00:00:00.000Z' }), note({ title: 'Planning', color: '#ff8a5c', date: '2026-08-09', created_at: '2026-08-09T00:00:00.000Z' })]
 assert.deepEqual(historySuggestions(value, 'plan'), [{ title: 'Planning', color: '#ff8a5c', type: '工作日', lastUsedAt: '2026-08-09T00:00:00.000Z' }])
 assert.deepEqual(value.history, [], 'querying suggestions must not dirty the file')
})

test('month grid is Monday-first with 42 cells, leap days and inert maximum-year spillover', () => {
 const november = monthDays('2026-11', '2026-11-04')
 assert.equal(november.length, 42); assert.equal(november[0].date, '2026-10-26'); assert.equal(november[0].weekday, 0)
 assert.equal(november.at(-1).date, '2026-12-06'); assert.equal(november.at(-1).weekday, 6)
 assert.equal(november.filter(day => day.inMonth).length, 30)
 assert.deepEqual(november.filter(day => day.isToday).map(day => day.date), ['2026-11-04'])
 assert.equal(monthDays('2024-02', '2024-02-01').filter(day => day.inMonth).length, 29)
 assert.equal(monthDays('1900-01', '1900-01-01')[0].date, '1900-01-01')
 const last = monthDays('9999-12', '9999-12-31')
 assert.equal(last.length, 42); assert.equal(last.filter(day => day.inMonth).length, 31)
 assert.ok(last.some(day => day.date === null)); assert.ok(last.filter(day => day.date === null).every(day => day.day === 0 && !day.inMonth && !day.isToday))
})

test('month navigation and civil dates reject normalization, overflow and fractional moves', () => {
 assert.equal(shiftMonth('2026-12', 1), '2027-01'); assert.equal(shiftMonth('2026-01', -1), '2025-12'); assert.equal(shiftMonth('2026-11', 14), '2028-01')
 for (const args of [['1900-01', -1], ['9999-12', 1], ['2026-11', .5], ['2026-11', Infinity], ['2026-11', Number.MAX_SAFE_INTEGER]]) assert.throws(() => shiftMonth(...args))
 for (const value of ['2026-1', '2026-13', '1899-12', '10000-01', 'x']) assert.throws(() => validateMonth(value))
 for (const value of ['2026-04-31', '2026-02-29', '1900-02-29', '2026-01-00', '2026-1-01', '0099-01-01']) assert.throws(() => dateNumber(value))
 assert.equal(dateNumber('2024-03-01') - dateNumber('2024-02-28'), 2)
 assert.throws(() => todayDate(new Date(NaN)))
})

test('month grids and day arithmetic are timezone independent while today follows the user timezone', () => {
 const script = `import {monthDays,visibleMonthDays,moveCalendarDate,normalizeVisibleDate,shiftMonth,dateNumber,todayDate} from './src/calendar/calendar.ts'; console.log(JSON.stringify({grid:monthDays('2026-03','2026-03-08'),work:visibleMonthDays('2026-03','work','2026-03-08'),move:moveCalendarDate('2026-03-06','ArrowRight','work'),selection:normalizeVisibleDate('2026-03-08','work'),next:shiftMonth('2026-12',1),days:dateNumber('2026-11-02')-dateNumber('2026-10-31'),today:todayDate(new Date('2026-03-08T00:30:00Z'))}))`
 const results = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai'].map(TZ => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' })))
 for (const result of results) { assert.deepEqual(result.grid, results[0].grid); assert.deepEqual(result.work, results[0].work); assert.equal(result.move, '2026-03-09'); assert.equal(result.selection, '2026-03-09'); assert.equal(result.next, '2027-01'); assert.equal(result.days, 2) }
 assert.equal(results[0].today, '2026-03-08'); assert.equal(results[1].today, '2026-03-07'); assert.equal(results[3].today, '2026-03-08')
})

test('monthly work summary shares one day across work notes and excludes leave and other months', () => {
 const value = createCalendar()
 value.notes = [
  note({ title: '研发', date: '2026-11-01' }), note({ title: '会议', date: '2026-11-01' }), note({ title: '年假', date: '2026-11-01', type: '非工作日' }),
  note({ title: '研发', date: '2026-11-02' }), note({ title: '研发', date: '2026-11-02' }), note({ title: '年假', date: '2026-11-03', type: '非工作日' }),
  note({ title: '不属于本月', date: '2026-12-01' }),
 ]
 const result = monthSummary(value, '2026-11')
 assert.deepEqual(result.map(({ title, days, percent }) => ({ title, days, percent })), [{ title: '研发', days: 1.5, percent: 75 }, { title: '会议', days: .5, percent: 25 }])
 assert.equal(result.reduce((total, item) => total + item.days, 0), 2)
 assert.equal(result.reduce((total, item) => total + item.percent, 0), 100)
 assert.deepEqual(monthSummary(value, '2026-10'), [])
})
