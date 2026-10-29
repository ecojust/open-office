import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dayNumber } from '../src/schedule/calendar.ts'
import { buildMonthlyWorkload, calculateWorkloadBudget, formatWorkloadBudget, workloadProgress, workloadTotalTitle } from '../src/schedule/workload.ts'

function project() {
 return { format: 'open-office-schedule', version: 1, id: 'workload_project', title: '月度工时', startDate: '2026-02-09', endDate: '2026-03-06', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [
  { id: 'a', name: '小明', role: '研发', color: '#2563eb' }, { id: 'b', name: '小红', role: '设计', color: '#7c3aed' },
 ], events: [
  event('a_february', 'a', '2026-02-13', '2026-02-24'),
  event('a_march', 'a', '2026-03-04', '2026-03-06'),
  event('b_cross_month', 'b', '2026-02-24', '2026-03-03', .5, 1),
  event('overall', null, '2026-02-09', '2026-03-06'),
 ] }
}
function event(id, roleId, startDate, endDate, height = 1, slot = 0) { return { id, roleId, title: id, startDate, endDate, height, slot, notes: '' } }
function deepFreeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child); return Object.freeze(value) }
function weekdays(start, end) {
 let count = 0
 for (let day = dayNumber(start); day <= dayNumber(end); day++) { const weekday = new Date(day * 86_400_000).getUTCDay(); if (weekday !== 0 && weekday !== 6) count++ }
 return count
}

test('monthly workload splits full and half events across working days and ignores overall summaries', () => {
 const source = project(); source.events.push(event('duplicate_summary', null, source.startDate, source.endDate))
 const result = buildMonthlyWorkload(source)
 assert.deepEqual(result.months, [
  { key: '2026-02', startDate: '2026-02-09', endDate: '2026-02-28', workingDays: 9 },
  { key: '2026-03', startDate: '2026-03-01', endDate: '2026-03-06', workingDays: 5 },
 ])
 assert.deepEqual(result.people.map(person => [person.roleId, person.name, person.role, person.color]), [['a', '小明', '研发', '#2563eb'], ['b', '小红', '设计', '#7c3aed']])
 assert.deepEqual(result.people[0].months, [{ scheduledDays: 2, availableDays: 9, percentage: 2 / 9 * 100 }, { scheduledDays: 3, availableDays: 5, percentage: 60 }])
 assert.deepEqual(result.people[1].months, [{ scheduledDays: 2, availableDays: 9, percentage: 2 / 9 * 100 }, { scheduledDays: 1, availableDays: 5, percentage: 20 }])
 assert.deepEqual(result.team, [{ scheduledDays: 4, availableDays: 18, percentage: 4 / 18 * 100 }, { scheduledDays: 4, availableDays: 10, percentage: 40 }])
 assert.deepEqual(result.people.map(person => person.totalDays), [5, 3]); assert.equal(result.totalDays, 8)
})

test('full-month capacity expands only the denominator and leaves scheduled person-days unchanged', () => {
 const source = project(), within = buildMonthlyWorkload(source), full = buildMonthlyWorkload(source, {}, 'month')
 assert.deepEqual(full.months, [
  { key: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', workingDays: 14 },
  { key: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31', workingDays: 22 },
 ])
 assert.deepEqual(full.people.map(person => person.months.map(cell => cell.scheduledDays)), within.people.map(person => person.months.map(cell => cell.scheduledDays)))
 assert.equal(full.people[0].months[0].percentage, 2 / 14 * 100)
 assert.equal(full.team[1].percentage, 4 / 44 * 100)
 assert.equal(full.totalDays, within.totalDays); assert.deepEqual(full.people.map(person => person.totalDays), within.people.map(person => person.totalDays))
})

test('morning and afternoon each count half a person-day independent of display modes and row sizes', () => {
 const source = project(); source.startDate = '2026-06-01'; source.endDate = '2026-06-05'
 source.events = [event('full', 'a', '2026-06-01', '2026-06-01'), event('morning', 'a', '2026-06-02', '2026-06-02', .5), event('afternoon', 'a', '2026-06-03', '2026-06-03', .5, 1)]
 const first = buildMonthlyWorkload(source)
 assert.deepEqual(first.people[0].months, [{ scheduledDays: 2, availableDays: 5, percentage: 40 }])
 assert.deepEqual(first.people[1].months, [{ scheduledDays: 0, availableDays: 5, percentage: 0 }])
 assert.deepEqual(first.people.map(person => person.totalDays), [2, 0]); assert.equal(first.totalDays, 2)
 source.calendar.hideWeekends = false; source.calendar.hideHolidays = false; source.calendar.weekNumbering = 'project'
 source.layout = { trackHeights: { overall: 84, 'person-a': 336, 'event-afternoon': 168 } }
 const before = structuredClone(source); deepFreeze(source)
 assert.deepEqual(buildMonthlyWorkload(source), first); assert.deepEqual(source, before)
})

test('holiday rules exclude weekends and official/custom holidays while explicit exclusions win', () => {
 const source = project(); source.startDate = '2026-06-15'; source.endDate = '2026-06-21'
 source.events = [event('week', 'a', source.startDate, source.endDate)]
 assert.equal(buildMonthlyWorkload(source).months[0].workingDays, 4, 'built-in Dragon Boat holiday is excluded')
 source.calendar.extraHolidays = ['2026-06-16']; source.calendar.excludedHolidays = ['2026-06-19', '2026-06-20']
 const custom = buildMonthlyWorkload(source)
 assert.equal(custom.months[0].workingDays, 4); assert.equal(custom.people[0].months[0].scheduledDays, 4)
 source.calendar.excludedHolidays.push('2026-06-16')
 const loaded = { 2026: { '2026-06-17': '临时假日', '2026-06-19': '端午节', '2026-06-20': null } }
 const result = buildMonthlyWorkload(source, loaded)
 assert.equal(result.months[0].workingDays, 4, '16/19 restored, 17 hidden; excluded Saturday remains a weekend')
 assert.equal(result.people[0].months[0].scheduledDays, 4)
 assert.equal(buildMonthlyWorkload(source).months[0].workingDays, 5, 'explicit exclusion takes priority over extra holiday')
})

test('zero-capacity months and teams with no people use null percentages instead of NaN', () => {
 const source = project(); source.startDate = '2026-02-16'; source.endDate = '2026-02-20'; source.events = [event('holiday', 'a', source.startDate, source.endDate)]
 const emptyDays = buildMonthlyWorkload(source)
 assert.equal(emptyDays.months.length, 1); assert.equal(emptyDays.months[0].workingDays, 0)
 assert.deepEqual(emptyDays.people.map(person => person.months[0]), [{ scheduledDays: 0, availableDays: 0, percentage: null }, { scheduledDays: 0, availableDays: 0, percentage: null }])
 assert.deepEqual(emptyDays.team, [{ scheduledDays: 0, availableDays: 0, percentage: null }])
 source.startDate = '2026-06-01'; source.endDate = '2026-06-05'; source.roles = []; source.events = [event('overall', null, source.startDate, source.endDate)]
 const noPeople = buildMonthlyWorkload(source)
 assert.equal(noPeople.months[0].workingDays, 5); assert.deepEqual(noPeople.people, []); assert.deepEqual(noPeople.team, [{ scheduledDays: 0, availableDays: 0, percentage: null }])
 assert.equal(emptyDays.totalDays, 0); assert.equal(noPeople.totalDays, 0)
})

test('cross-year statistics include all months and unknown holiday years use existing calendar fallback', () => {
 const source = project(); source.startDate = '2026-12-28'; source.endDate = '2027-01-08'
 source.events = [event('new-year', 'a', source.startDate, source.endDate, .5, 1)]
 const fallback = buildMonthlyWorkload(source)
 assert.deepEqual(fallback.months.map(month => [month.key, month.workingDays]), [['2026-12', 4], ['2027-01', 6]])
 assert.deepEqual(fallback.people[0].months.map(cell => cell.scheduledDays), [2, 3])
 const downloaded = buildMonthlyWorkload(source, { 2027: { '2026-12-31': '跨年假日', '2027-01-01': '元旦' } })
 assert.deepEqual(downloaded.months.map(month => month.workingDays), [3, 5]); assert.deepEqual(downloaded.people[0].months.map(cell => cell.scheduledDays), [1.5, 2.5])
})

test('maximum-length project can expand to full months without exceeding one calendar request range', () => {
 const source = project(); source.startDate = '2028-01-31'; source.endDate = addDays(source.startDate, 1095)
 source.events = [event('long-project', 'a', source.startDate, source.endDate)]
 const result = buildMonthlyWorkload(source, {}, 'month')
 assert.equal(result.months.length, 37)
 assert.equal(result.months[0].startDate, '2028-01-01'); assert.equal(result.months.at(-1).endDate, '2031-01-31')
 assert.ok(dayNumber(result.months.at(-1).endDate) - dayNumber(result.months[0].startDate) + 1 > 1096)
 assert.equal(result.people[0].months.reduce((sum, cell) => sum + cell.scheduledDays, 0), weekdays(source.startDate, source.endDate))
 assert.equal(result.people[0].totalDays, weekdays(source.startDate, source.endDate)); assert.equal(result.totalDays, result.people[0].totalDays)
 assert.equal(result.people[0].months.reduce((sum, cell) => sum + cell.availableDays, 0), weekdays('2028-01-01', '2031-01-31'))
 assert.ok(result.team.every(cell => Number.isFinite(cell.percentage)))
})

test('budget uses integer price cents and rounds once after accumulating full and half days', () => {
 assert.equal(calculateWorkloadBudget(3.5, 1200.35), 4201.23)
 assert.equal(calculateWorkloadBudget(.5, .29), .15, 'half cent rounds up without binary float drift')
 assert.equal(calculateWorkloadBudget(.5, 2.01), 1.01)
 assert.equal(calculateWorkloadBudget(1, 2.01), 2.01, 'two half days are summed before rounding')
 assert.equal(calculateWorkloadBudget(0, 1200), 0)
 assert.equal(calculateWorkloadBudget(12.5, 0), 0)
 assert.equal(calculateWorkloadBudget(12.5), null)
 assert.equal(calculateWorkloadBudget(1096 * 100, 1_000_000), 109600000000)
 for (const [days, rate] of [[Infinity, 10], [NaN, 10], [-1, 10], [1, Infinity], [1, NaN], [1, -10]]) assert.equal(calculateWorkloadBudget(days, rate), null)
 assert.equal(formatWorkloadBudget(4201.23), '¥4,201.23')
 assert.equal(formatWorkloadBudget(0), '¥0.00')
 assert.equal(formatWorkloadBudget(null), '未设置')
 assert.equal(workloadTotalTitle(3.5, 1200.35), '总工时：3.5 人天\n总预算：3.5 人天 × ¥1,200.35 / 人天 = ¥4,201.23')
 assert.match(workloadTotalTitle(0, 0), /总预算：0 人天 × ¥0.00 \/ 人天 = ¥0.00/)
 assert.match(workloadTotalTitle(8), /总工时：8 人天\n.*项目设置/)
})

test('workload progress preserves fractional percentages and bounds invalid or overloaded values', () => {
 for (const [input, expected] of [[0, 0], [25, 25], [66.6666666667, 66.6666666667], [100, 100], [250, 100], [-5, 0], [null, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) assert.equal(workloadProgress(input), expected)
})

test('minimum and maximum supported dates expand months without producing an unsupported date', () => {
 for (const [date, startDate, endDate] of [['1900-01-01', '1900-01-01', '1900-01-31'], ['9999-12-31', '9999-12-01', '9999-12-31']]) {
  const source = project(); source.startDate = date; source.endDate = date; source.events = [event('boundary', 'a', date, date)]
  const partial = buildMonthlyWorkload(source), full = buildMonthlyWorkload(source, {}, 'month')
  assert.equal(partial.months[0].workingDays, 1); assert.equal(partial.people[0].months[0].percentage, 100)
  assert.deepEqual(full.months[0], { key: date.slice(0, 7), startDate, endDate, workingDays: weekdays(startDate, endDate) })
  assert.equal(full.people[0].months[0].scheduledDays, 1)
 }
 const source = project()
 assert.throws(() => buildMonthlyWorkload(source, {}, 'invalid'), /口径无效/)
 assert.throws(() => buildMonthlyWorkload({ ...source, endDate: '2030-01-01' }), /3 年/)
 assert.throws(() => buildMonthlyWorkload({ ...source, endDate: '2025-01-01' }), /日期范围无效/)
})
