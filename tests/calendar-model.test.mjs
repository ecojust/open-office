import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createCalendar, validateCalendar, encodeCalendar, decodeCalendar, calendarId, rememberHistory, historySuggestions, CALENDAR_MAX_BYTES, CALENDAR_MAX_NOTES, CALENDAR_MAX_HISTORY } from '../src/calendar/model.ts'
import { dateNumber, validateMonth, monthDays, shiftMonth, todayDate, monthSummary } from '../src/calendar/calendar.ts'
import { dayAllocations, setDayAllocation, resizeAllocationBoundary } from '../src/calendar/allocation.ts'

function note(overrides = {}) { return { id: calendarId(), title: '项目会议', content: '现场记录\n下一步😀', date: '2026-11-04', color: '#4376d4', created_at: '2026-11-04T09:30:00.000Z', type: '工作日', ...overrides } }
function book() { const value = createCalendar('团队日历😀'); value.notes.push(note()); rememberHistory(value, value.notes[0], '2026-11-04T09:30:00.000Z'); return value }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`) }

test('legacy version-one files default to seven hours and equal shares without rewriting note weights', () => {
 const old = book(); delete old.workdayHours; delete old.allocationDisplay
 old.notes.push(note({ title: '研发' }), note({ title: '沟通' }), note({ title: '年假', type: '非工作日' }))
 const restored = decodeCalendar(new TextEncoder().encode(JSON.stringify(old)))
 assert.equal(restored.version, 1); assert.equal(restored.workdayHours, 7); assert.equal(restored.allocationDisplay, 'percent')
 assert.ok(restored.notes.every(item => !Object.hasOwn(item, 'weight')))
 const values = dayAllocations(restored, '2026-11-04')
 assert.equal(values.length, 3)
 for (const value of values) { close(value.weight, 1 / 3); close(value.hours, 7 / 3) }
 close(values.reduce((sum, value) => sum + value.hours, 0), 7)
 assert.deepEqual(decodeCalendar(encodeCalendar(restored)), restored)
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
 const script = `import {monthDays,shiftMonth,dateNumber,todayDate} from './src/calendar/calendar.ts'; console.log(JSON.stringify({grid:monthDays('2026-03','2026-03-08'),next:shiftMonth('2026-12',1),days:dateNumber('2026-11-02')-dateNumber('2026-10-31'),today:todayDate(new Date('2026-03-08T00:30:00Z'))}))`
 const results = ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai'].map(TZ => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' })))
 for (const result of results) { assert.deepEqual(result.grid, results[0].grid); assert.equal(result.next, '2027-01'); assert.equal(result.days, 2) }
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
