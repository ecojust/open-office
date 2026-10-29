import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSchedulePngLayout, fitSchedulePngDimensions, SCHEDULE_PNG_MAX_PIXELS, SCHEDULE_PNG_MAX_SIDE } from '../src/schedule/png-export.ts'
import { getEventVerticalLayout, SCHEDULE_HEADER_HEIGHT } from '../src/schedule/layout.ts'

function project() {
 return { format: 'open-office-schedule', version: 1, id: 'png_project', title: '完整排期导出', startDate: '2026-02-09', endDate: '2026-03-06', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'a', name: '小明', role: '研发', color: '#2563eb' }, { id: 'b', name: '小红', role: '设计', color: '#7c3aed' }], events: [
  { id: 'early', roleId: 'a', title: '首个任务', startDate: '2026-02-09', endDate: '2026-02-13', height: 1, slot: 0, notes: '' },
  { id: 'last', roleId: 'b', title: '最末任务', startDate: '2026-03-02', endDate: '2026-03-06', height: .5, slot: 0, notes: '' },
  { id: 'hidden', roleId: null, title: '隐藏任务', startDate: '2026-02-16', endDate: '2026-02-20', height: 1, slot: 0, notes: '' },
 ] }
}

test('PNG layout includes complete dates and every person with their saved track heights', () => {
 const source = project()
 source.layout = { trackHeights: { overall: 84, 'person-a': 168, 'person-b': 336, 'event-last': 280 } }
 const unchanged = structuredClone(source), plan = buildSchedulePngLayout(source, { mode: 'people', dayWidth: 64 })
 assert.deepEqual(plan.rows.map(row => row.key), ['overall', 'person-a', 'person-b'])
 assert.deepEqual(plan.rows.map(row => row.height), [84, 168, 336])
 assert.deepEqual(plan.rows.map(row => row.top), [88 + SCHEDULE_HEADER_HEIGHT, 244, 412])
 assert.equal(plan.calendar.days.at(-1).date, source.endDate)
 assert.equal(plan.rows.at(-1).events[0].event.id, 'last')
 assert.equal(plan.rows.at(-1).events[0].event.height, .5)
 assert.equal(plan.rows.at(-1).events[0].start + plan.rows.at(-1).events[0].count, plan.calendar.days.length)
 assert.equal(plan.hiddenEvents, 1)
 assert.equal(plan.tableBottom, 748)
 assert.equal(plan.logicalHeight, 796)
 assert.equal(plan.scale, 2)
 assert.deepEqual(source, unchanged)
 source.roles[0].name = '后续修改'; source.events.at(-1).title = '后续修改'; source.layout.trackHeights.overall = 112
 assert.equal(plan.project.roles[0].name, '小明'); assert.equal(plan.project.events.at(-1).title, '隐藏任务'); assert.equal(plan.rows[0].height, 84)
})

test('global PNG sorts all events and uses global-row heights independently from person tracks', () => {
 const source = project(); source.events.reverse(); source.layout = { trackHeights: { 'person-b': 336, 'event-last': 280 } }
 const plan = buildSchedulePngLayout(source, { mode: 'global' })
 assert.deepEqual(plan.rows.map(row => row.key), ['overall', 'event-early', 'event-last'])
 assert.deepEqual(plan.rows.map(row => row.height), [112, 112, 280])
 assert.equal(plan.rows.at(-1).subtitle, '小红 · 设计')
 assert.equal(plan.rows.at(-1).color, '#7c3aed')
})

test('afternoon PNG events use the lower half of their complete resized track in both modes', () => {
 const source = project(); source.events[1].slot = 1
 source.layout = { trackHeights: { 'person-b': 336, 'event-last': 280 } }
 for (const [mode, height] of [['people', 336], ['global', 280]]) {
  const plan = buildSchedulePngLayout(source, { mode }), row = plan.rows.at(-1), event = row.events[0].event
  assert.equal(event.slot, 1); assert.equal(event.height, .5); assert.equal(row.height, height)
  const afternoon = getEventVerticalLayout(row.height, event), morning = getEventVerticalLayout(row.height, { ...event, slot: 0 })
  assert.equal(afternoon.top, 9 + (height - 18) / 2); assert.equal(afternoon.height, (height - 18) / 2)
  assert.equal(afternoon.top + afternoon.height, height - 9)
  assert.equal(morning.top, 9); assert.equal(afternoon.top - morning.top, afternoon.height)
 }
})

test('PNG uses the current loaded/manual holiday projection without modifying event endpoints', () => {
 const source = project()
 source.calendar.extraHolidays = ['2026-03-02']; source.calendar.excludedHolidays = ['2026-02-17']
 const plan = buildSchedulePngLayout(source, { mode: 'people', holidayYears: { 2026: { '2026-02-17': '假日', '2026-03-03': '自动假日' } } })
 assert.ok(plan.calendar.days.some(day => day.date === '2026-02-17'))
 assert.ok(!plan.calendar.days.some(day => day.date === '2026-03-02'))
 assert.ok(!plan.calendar.days.some(day => day.date === '2026-03-03'))
 assert.equal(plan.rows.at(-1).events[0].event.startDate, '2026-03-02')
 assert.equal(plan.rows.at(-1).events[0].count, 3)
})

test('PNG carries annual week years even for single-column partial weeks and across December', () => {
 const source = project(); source.startDate = '2027-01-01'; source.endDate = '2027-01-04'; source.events = []
 const plan = buildSchedulePngLayout(source, { mode: 'people', dayWidth: 36 })
 assert.deepEqual(plan.calendar.weeks.map(week => [week.label, week.weekYear, week.count * plan.dayWidth]), [['W53', 2026, 36], ['W1', 2027, 36]])
 source.startDate = '2024-12-30'; source.endDate = '2024-12-31'
 const december = buildSchedulePngLayout(source, { mode: 'global' })
 assert.deepEqual(december.calendar.weeks.map(week => [week.label, week.weekYear]), [['W1', 2025]])
})

test('PNG follows saved project numbering without relabeling it as an annual ISO week', () => {
 const source = project(); source.calendar.weekNumbering = 'project'
 const relative = buildSchedulePngLayout(source, { mode: 'people' })
 assert.equal(relative.project.calendar.weekNumbering, 'project')
 assert.deepEqual(relative.calendar.weeks.map(week => week.label), ['W1', 'W3', 'W4'])
 source.calendar.weekNumbering = 'year'
 const annual = buildSchedulePngLayout(source, { mode: 'people' })
 assert.equal(annual.project.calendar.weekNumbering, 'year')
 assert.deepEqual(annual.calendar.weeks.map(week => week.label), ['W7', 'W9', 'W10'])
 assert.deepEqual(relative.rows, annual.rows); assert.equal(relative.width, annual.width); assert.equal(relative.height, annual.height)
 source.startDate = '2027-01-01'; source.endDate = '2027-01-04'; source.events = []; source.calendar.weekNumbering = 'project'
 const partial = buildSchedulePngLayout(source, { mode: 'global', dayWidth: 36 })
 assert.deepEqual(partial.calendar.weeks.map(week => [week.label, week.weekYear, week.count * partial.dayWidth]), [['W1', 2026, 36], ['W2', 2027, 36]])
})

test('PNG remains a complete bounded table when all dates are hidden', () => {
 const source = project(); source.startDate = '2026-02-16'; source.endDate = '2026-02-20'; source.events = [source.events.at(-1)]
 const plan = buildSchedulePngLayout(source, { mode: 'people' })
 assert.equal(plan.calendar.days.length, 0); assert.equal(plan.rows.length, 3); assert.equal(plan.hiddenEvents, 1)
 assert.ok(plan.width >= 600); assert.ok(plan.height > 0); assert.ok(plan.scale > 0)
})

test('PNG bitmap limits preserve both dimensions for wide, tall and large square tables', () => {
 for (const [width, height] of [[600, 400], [175600, 440], [800, 672500], [175600, 672500], [10000, 10000]]) {
  const result = fitSchedulePngDimensions(width, height)
  assert.ok(result.width <= SCHEDULE_PNG_MAX_SIDE); assert.ok(result.height <= SCHEDULE_PNG_MAX_SIDE)
  assert.ok(result.width * result.height <= SCHEDULE_PNG_MAX_PIXELS)
  assert.ok(width * result.scale <= result.width + 1e-8); assert.ok(height * result.scale <= result.height + 1e-8)
  assert.ok(result.scale > 0 && result.scale <= 2)
  assert.ok(result.width - width * result.scale < 4); assert.ok(result.height - height * result.scale < 4)
 }
 for (const size of [[0, 10], [-1, 10], [Infinity, 20], [30, NaN]]) assert.throws(() => fitSchedulePngDimensions(...size), /尺寸无效/)
})

test('PNG input validates schema and clamps nonfinite or extreme day widths', () => {
 const source = project()
 for (const value of [NaN, Infinity, undefined]) assert.equal(buildSchedulePngLayout(source, { mode: 'people', dayWidth: value }).dayWidth, 64)
 assert.equal(buildSchedulePngLayout(source, { mode: 'people', dayWidth: 1 }).dayWidth, 36)
 assert.equal(buildSchedulePngLayout(source, { mode: 'people', dayWidth: 1000 }).dayWidth, 160)
 assert.throws(() => buildSchedulePngLayout(source, { mode: 'unknown' }), /视图模式无效/)
 assert.throws(() => buildSchedulePngLayout({ ...source, endDate: '2030-01-01' }, { mode: 'people' }), /3 年/)
})
