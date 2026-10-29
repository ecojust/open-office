import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createSchedule, decodeSchedule, encodeSchedule, scheduleId, validateSchedule, SCHEDULE_MAX_BYTES } from '../src/schedule/model.ts'
import { addDays, buildCalendar, dateFromDayNumber, dayNumber, mondayOf, moveScheduledEvent, projectedSpan, resizeScheduledEvent } from '../src/schedule/calendar.ts'
import { ScheduleSession } from '../src/schedule/session.ts'

function project(startDate = '2026-02-09', endDate = '2026-03-06') {
 return { ...createSchedule('交付计划😀'), startDate, endDate, roles: [{ id: 'alice', name: '小明', role: '研发', color: '#2563eb' }, { id: 'bob', name: '小红', role: '设计', color: '#7c3aed' }] }
}
function event(overrides = {}) { return { id: scheduleId(), roleId: 'alice', title: '任务', startDate: '2026-02-13', endDate: '2026-02-24', height: 1, slot: 0, notes: '', ...overrides } }
function sessionFor(value) { return new ScheduleSession(encodeSchedule(value)) }

test('schedule starts with empty roles/events, local current Monday and eight-weeks-later Friday', () => {
 const value = createSchedule(), now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
 assert.equal(value.format, 'open-office-schedule'); assert.equal(value.version, 1)
 assert.deepEqual(value.roles, []); assert.deepEqual(value.events, [])
 assert.equal(value.startDate, mondayOf(today)); assert.equal(value.endDate, addDays(value.startDate, 60))
 assert.deepEqual(value.calendar, { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] })
})

test('UTF-8 round trip retains inclusive dates, half height, notes and the fixed overall track', () => {
 const value = project(); value.events = [event({ roleId: null, height: 0.5, notes: '说明\n第二行😀' })]
 assert.deepEqual(decodeSchedule(encodeSchedule(value)), value)
 assert.deepEqual(decodeSchedule(new Uint8Array([239, 187, 191, ...encodeSchedule(value)])), value)
 const enriched = { ...value, unsafe: 'ignored', roles: value.roles.map(role => ({ ...role, html: '<b>ignored</b>' })) }
 assert.equal(validateSchedule(enriched).unsafe, undefined); assert.equal(validateSchedule(enriched).roles[0].html, undefined)
})

test('morning and afternoon half-events round trip without changing legacy morning documents', () => {
 for (const slot of [0, 1]) {
  const value = project(); value.events = [event({ height: .5, slot, notes: slot ? '下午安排' : '上午安排' })]
  assert.deepEqual(decodeSchedule(encodeSchedule(value)), value)
  const session = sessionFor(value), receipt = session.export(); session.markSaved(receipt.bytes)
  assert.equal(session.inspect().dirty, false); assert.equal(session.model.events[0].slot, slot)
 }
 const value = project(); value.events = [event({ height: 1, slot: 1 })]
 assert.throws(() => validateSchedule(value), /时段无效/)
 for (const slot of [-1, 2, .5, '1', null, undefined]) {
  value.events = [event({ height: .5, slot })]
  assert.throws(() => validateSchedule(value), /时段无效/)
 }
})

test('civil date functions reject normalized invalid dates and fractional day changes', () => {
 for (const date of ['2026-02-29', '2025-04-31', '2026-00-01', '2026-01-00', '2026-13-01', '2026-1-01', '2026-01-01T00:00:00Z', '0099-01-01']) assert.throws(() => dayNumber(date))
 assert.equal(addDays('2024-02-28', 1), '2024-02-29'); assert.equal(addDays('2024-02-29', 1), '2024-03-01')
 assert.equal(mondayOf('2026-01-01'), '2025-12-29'); assert.equal(dateFromDayNumber(dayNumber('9999-12-31')), '9999-12-31')
 assert.throws(() => addDays('2026-01-01', 0.5)); assert.throws(() => addDays('9999-12-31', 1)); assert.throws(() => dateFromDayNumber(Infinity))
})

test('date arithmetic and week labels remain stable across DST and host timezones', () => {
 const script = `import {addDays,mondayOf,dayNumber} from './src/schedule/calendar.ts'; console.log(JSON.stringify([addDays('2026-03-07',2),addDays('2026-10-31',2),mondayOf('2026-03-08'),dayNumber('2026-11-02')-dayNumber('2026-10-31')]))`
 const values = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai'].map(TZ => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' }).trim())
 assert.equal(new Set(values).size, 1)
 assert.deepEqual(JSON.parse(values[0]), ['2026-03-09', '2026-11-02', '2026-03-02', 2])
})

test('holiday and weekend filtering retains actual week numbers and hides makeup Saturdays', () => {
 const value = project(), calendar = buildCalendar(value)
 assert.equal(calendar.days.some(day => day.date === '2026-02-14'), false)
 assert.equal(calendar.days.some(day => day.date === '2026-02-28'), false)
 assert.equal(calendar.days.some(day => day.date === '2026-02-23'), false)
 assert.deepEqual(calendar.weeks.map(week => week.label), ['W1', 'W3', 'W4'])
 assert.deepEqual(calendar.weeks.map(week => [week.startIndex, week.count]), [[0, 5], [5, 4], [9, 5]])
 assert.deepEqual(projectedSpan(event(), calendar.days), { start: 4, count: 2 })
 assert.equal(projectedSpan(event({ startDate: '2026-02-15', endDate: '2026-02-23' }), calendar.days), null)
 for (const [year, count] of [[2025, 243], [2026, 242]]) {
  const fullYear = buildCalendar(project(`${year}-01-01`, `${year}-12-31`))
  assert.equal(fullYear.days.length, count); assert.equal(fullYear.hiddenCount, 365 - count)
 }
})

test('manual holidays can add/remove weekday holidays without unhiding weekends or moving events', () => {
 const value = project(), original = event(); value.events.push(original)
 value.calendar.extraHolidays = ['2026-02-24']; value.calendar.excludedHolidays = ['2026-02-14', '2026-02-23']
 const calendar = buildCalendar(value)
 assert.equal(calendar.days.some(day => day.date === '2026-02-23'), true)
 assert.equal(calendar.days.some(day => day.date === '2026-02-24'), false)
 assert.equal(calendar.days.some(day => day.date === '2026-02-14'), false)
 assert.deepEqual(value.events[0], original)
 value.calendar.hideHolidays = false
 assert.equal(buildCalendar(value).days.find(day => day.date === '2026-02-24').holiday, '自定义假日')
 value.calendar.hideWeekends = false
 assert.equal(buildCalendar(value).days.length, 26)
})

test('unknown years are reported without invented holiday data, including cross-year projects', () => {
 const value = project('2026-12-28', '2027-01-08'), calendar = buildCalendar(value)
 assert.deepEqual(calendar.unknownHolidayYears, [2027])
 assert.equal(calendar.days.some(day => day.date === '2027-01-01'), true)
 assert.deepEqual(calendar.weeks.map(week => week.label), ['W1', 'W2'])
 value.calendar.extraHolidays.push('2027-01-01')
 assert.equal(buildCalendar(value).days.some(day => day.date === '2027-01-01'), false)
})

test('downloaded announcements merge by source year with fallbacks and manual overrides', () => {
 const value = project('2026-01-01', '2027-01-08'), original = structuredClone(value)
 // An older announcement cannot remove a newer built-in year's New Year break.
 const older = { 2025: { '2025-01-01': '元旦', '2026-01-01': null } }
 assert.equal(buildCalendar(value, older).days.some(day => day.date === '2026-01-01'), false)
 const loaded = { ...older, 2026: { '2026-01-01': '元旦', '2026-12-31': '旧安排' }, 2027: { '2026-12-31': null, '2027-01-01': '元旦' } }
 const calendar = buildCalendar(value, loaded)
 assert.deepEqual(calendar.unknownHolidayYears, [])
 assert.equal(calendar.days.some(day => day.date === '2026-12-31'), true)
 assert.equal(calendar.days.some(day => day.date === '2027-01-01'), false)
 assert.deepEqual(value, original)
 value.calendar.extraHolidays = ['2026-12-31']; value.calendar.excludedHolidays = ['2027-01-01']
 assert.equal(buildCalendar(value, loaded).days.some(day => day.date === '2026-12-31'), false)
 assert.equal(buildCalendar(value, loaded).days.some(day => day.date === '2027-01-01'), true)
})

test('moving preserves visible duration, exact dates for track-only moves and clamps at project bounds', () => {
 const value = project(), original = event({ startDate: '2026-02-14', endDate: '2026-02-25' }); value.events.push(original)
 const days = buildCalendar(value).days, span = projectedSpan(original, days)
 const across = moveScheduledEvent(value, original, 0, 'bob', 0, days)
 assert.equal(across.startDate, original.startDate); assert.equal(across.endDate, original.endDate); assert.equal(across.roleId, 'bob')
 const moved = moveScheduledEvent(value, original, 1, 'alice', 0, days)
 assert.equal(moved.startDate, '2026-02-25'); assert.equal(moved.endDate, '2026-02-26')
 assert.equal(projectedSpan(moved, days).count, span.count)
 const atEnd = moveScheduledEvent(value, original, 10000, null, 0, days)
 assert.equal(atEnd.endDate, value.endDate); assert.equal(projectedSpan(atEnd, days).count, span.count)
 assert.equal(original.startDate, '2026-02-14')
 assert.throws(() => moveScheduledEvent(value, original, 0.5, 'bob', 0, days), /整天/)
})

test('resizing changes inclusive boundaries by whole visible days and retains at least one visible date', () => {
 const value = project(), original = event(); value.events.push(original)
 const days = buildCalendar(value).days
 const shorter = resizeScheduledEvent(value, original, 'end', -1, days)
 assert.equal(shorter.startDate, '2026-02-13'); assert.equal(shorter.endDate, '2026-02-13')
 const minimum = resizeScheduledEvent(value, original, 'start', 1000, days)
 assert.equal(minimum.startDate, '2026-02-24'); assert.equal(projectedSpan(minimum, days).count, 1)
 assert.equal(resizeScheduledEvent(value, original, 'end', 1000, days).endDate, value.endDate)
 assert.deepEqual(resizeScheduledEvent(value, original, 'end', 0, days), original)
 assert.throws(() => resizeScheduledEvent(value, event({ startDate: '2026-02-15', endDate: '2026-02-23' }), 'end', 1, days), /隐藏日期/)
})

test('same-role overlaps are rejected for full and half events, including hidden dates and shared endpoints', () => {
 for (const height of [1, 0.5]) {
  const value = project(); value.events = [event({ height }), event({ title: '冲突', startDate: '2026-02-24', endDate: '2026-02-25', height: 0.5 })]
  assert.throws(() => validateSchedule(value), /日期重叠/)
  value.events[1].roleId = 'bob'; assert.doesNotThrow(() => validateSchedule(value))
 }
 const hidden = project(); hidden.events = [event({ startDate: '2026-02-15', endDate: '2026-02-16', height: 0.5 }), event({ startDate: '2026-02-16', endDate: '2026-02-17', height: 0.5 })]
 assert.throws(() => validateSchedule(hidden), /日期重叠/)
 hidden.events[1].startDate = '2026-02-17'; assert.doesNotThrow(() => validateSchedule(hidden))
 const overall = project(); overall.events = [event({ roleId: null }), event({ roleId: null })]; assert.throws(() => validateSchedule(overall), /整体计划/)
})

test('cross-role moves reject collisions without overwriting either event', () => {
 const value = project(); value.events = [event(), event({ roleId: 'bob', title: '既有任务', height: 0.5 })]
 const before = JSON.stringify(value), days = buildCalendar(value).days
 assert.throws(() => moveScheduledEvent(value, value.events[0], 0, 'bob', 0, days), /既有任务/)
 assert.equal(JSON.stringify(value), before)
 const moved = moveScheduledEvent(value, value.events[0], 0, null, 1, days)
 assert.equal(moved.slot, 0); assert.equal(moved.roleId, null)
})

test('half-event moves retain explicit time period across roles, dates and left/right resizing', () => {
 const value = project(), original = event({ height: .5, slot: 1 }); value.events = [original]
 const days = buildCalendar(value).days
 const across = moveScheduledEvent(value, original, 0, 'bob', original.slot, days)
 assert.equal(across.slot, 1); assert.equal(across.roleId, 'bob'); assert.equal(across.startDate, original.startDate); assert.equal(across.endDate, original.endDate)
 const moved = moveScheduledEvent(value, original, 1, 'alice', original.slot, days)
 assert.equal(moved.slot, 1); assert.notEqual(moved.startDate, original.startDate)
 const morning = moveScheduledEvent(value, original, 0, 'alice', 0, days)
 assert.equal(morning.slot, 0); assert.equal(morning.startDate, original.startDate)
 for (const edge of ['start', 'end']) assert.equal(resizeScheduledEvent(value, original, edge, 1, days).slot, 1)
 for (const slot of [-1, 2, .5, '1', undefined]) {
  assert.throws(() => moveScheduledEvent(value, original, 0, 'bob', slot, days), /目标时段无效/)
  assert.throws(() => moveScheduledEvent(value, { ...original, height: 1, slot: 0 }, 0, 'bob', slot, days), /目标时段无效/)
 }
 assert.equal(original.slot, 1)
})

test('morning and afternoon remain mutually exclusive on the same track and date', () => {
 const value = project(); value.events = [event({ height: .5, slot: 0 }), event({ id: 'afternoon', title: '下午任务', height: .5, slot: 1 })]
 assert.throws(() => validateSchedule(value), /日期重叠/)
 value.events[1].roleId = 'bob'; assert.doesNotThrow(() => validateSchedule(value))
 const before = structuredClone(value), days = buildCalendar(value).days
 assert.throws(() => moveScheduledEvent(value, value.events[1], 0, 'alice', 1, days), /日期重叠/)
 assert.deepEqual(value, before)
 value.events[0].roleId = null; value.events[1].roleId = null
 assert.throws(() => validateSchedule(value), /整体计划/)
})

test('time period edits participate in history and exact save receipts', () => {
 const value = project(); value.events = [event({ height: .5 })]
 const session = sessionFor(value), morningReceipt = session.export()
 session.change(copy => { copy.events[0].slot = 1 })
 assert.equal(session.inspect().dirty, true); assert.equal(session.model.events[0].slot, 1)
 assert.throws(() => session.markSaved(morningReceipt.bytes), /又有修改/)
 session.undo(); assert.equal(session.model.events[0].slot, 0); assert.equal(session.inspect().dirty, false)
 session.redo(); assert.equal(session.model.events[0].slot, 1)
 const afternoonReceipt = session.export(); session.markSaved(afternoonReceipt.bytes)
 assert.equal(session.inspect().dirty, false); assert.equal(decodeSchedule(afternoonReceipt.bytes).events[0].slot, 1)
})

test('decoder rejects malformed files, identifiers, dates, colors, references, slots and quantities', () => {
 for (const bytes of [new Uint8Array(), new Uint8Array([255]), new TextEncoder().encode('{bad'), new Uint8Array(SCHEDULE_MAX_BYTES + 1)]) assert.throws(() => decodeSchedule(bytes))
 const changes = [
  v => v.version = 2, v => v.format = 'other', v => v.id = 'bad:id', v => v.roles[0].id = v.id,
  v => v.startDate = '2026-02-30', v => v.endDate = '2026-02-01', v => v.endDate = '2030-02-01',
  v => v.roles[0].color = 'red', v => v.roles[0].color = '#fff', v => v.roles[0].name = '',
  v => v.events[0].roleId = 'missing', v => v.events[0].slot = 1, v => v.events[0].height = 0.25,
  v => v.events[0].endDate = '2026-04-01', v => v.events[0].startDate = '2026-03-01',
  v => v.calendar.hideWeekends = 'true', v => v.calendar.extraHolidays = ['2026-02-30'],
  v => v.calendar.extraHolidays = ['2026-02-11', '2026-02-11'],
  v => { v.calendar.extraHolidays = ['2026-02-11']; v.calendar.excludedHolidays = ['2026-02-11'] },
  v => v.roles = Array.from({ length: 101 }, (_, i) => ({ ...v.roles[0], id: `r_${i}` })),
  v => v.events = Array.from({ length: 2001 }, (_, i) => ({ ...v.events[0], id: `e_${i}` })),
 ]
 for (const change of changes) { const value = project(); value.events = [event()]; change(value); assert.throws(() => validateSchedule(value)) }
})

test('4 MiB UTF-8 budget is checked on validated in-memory models as well as incoming bytes', () => {
 const value = project('2026-01-01', '2026-12-31')
 value.events = Array.from({ length: 80 }, (_, index) => event({ startDate: addDays(value.startDate, index), endDate: addDays(value.startDate, index), notes: '中'.repeat(20000) }))
 assert.throws(() => validateSchedule(value), /4 MiB/)
})

test('session failures and no-ops preserve model, revision, history and export receipt', () => {
 const value = project(); value.events = [event()]
 const session = sessionFor(value), saved = session.export(), before = session.inspect()
 assert.equal(session.change(() => {}), false)
 assert.throws(() => session.change(copy => { copy.events.push(event({ height: 0.5 })) }), /日期重叠/)
 assert.deepEqual(session.inspect(), before); assert.deepEqual(session.model, value); session.markSaved(saved.bytes)
 assert.throws(() => new ScheduleSession(new Uint8Array()))
})

test('save receipts reject old or altered exports, including edits during save and undo/redo reentry', () => {
 const session = sessionFor(project()); session.change(copy => { copy.title = 'first' }); const first = session.export()
 session.change(copy => { copy.title = 'second' }); assert.throws(() => session.markSaved(first.bytes), /又有修改/)
 const second = session.export(), modified = second.bytes.slice(); modified[0] ^= 1
 assert.throws(() => session.markSaved(modified), /回执/); assert.throws(() => session.markSaved(first.bytes), /回执/)
 const snapshot = session.inspect(); session.markSaved(second.bytes)
 assert.equal(session.inspect().dirty, false); assert.equal(session.revision, snapshot.revision)
 assert.equal(session.undo(), true); assert.equal(session.inspect().dirty, true)
 assert.equal(session.redo(), true); assert.equal(session.inspect().dirty, false)
 assert.throws(() => session.markSaved(second.bytes), /又有修改/)
 const latest = session.export(); session.markSaved(latest.bytes)
 assert.equal(sessionFor(decodeSchedule(latest.bytes)).inspect().dirty, false)
 session.model.title = 'out-of-band mutation'; assert.throws(() => session.markSaved(latest.bytes), /又有修改/)
})

test('reentrant changes cannot overwrite a newer committed edit; new branches discard redo', () => {
 const session = sessionFor(project())
 assert.throws(() => session.change(copy => { copy.title = 'outer'; session.change(inner => { inner.title = 'inner' }) }), /其他修改/)
 assert.equal(session.model.title, 'inner'); assert.equal(session.revision, 1)
 session.change(copy => { copy.title = 'next' }); session.undo(); session.change(copy => { copy.title = 'branch' })
 assert.equal(session.redo(), false)
})

test('history retains at most 100 snapshots and at most 16 MiB of UTF-16 snapshots', () => {
 const small = sessionFor(project())
 for (let index = 0; index < 110; index++) small.change(copy => { copy.title = `版本${index}` })
 let count = 0; while (small.undo()) count++
 assert.equal(count, 99)
 const value = project(); value.events = Array.from({ length: 10 }, (_, index) => event({ startDate: addDays(value.startDate, index), endDate: addDays(value.startDate, index), notes: 'x'.repeat(20000) }))
 const large = sessionFor(value)
 for (let index = 0; index < 45; index++) large.change(copy => { copy.title = `版本${index}` })
 count = 0; while (large.undo()) count++
 assert.ok(count > 1 && count < 44, `Memory cap should evict old snapshots; retained ${count + 1}`)
})
