import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleTools } from '../src/mcp/schedule-tools.ts'
import { validateToolArguments } from '../src/mcp/tool-schema.ts'
import { editSchedule, importSchedule, readScheduleCalendar, readScheduleWorkload } from '../src/schedule/mcp.ts'
import { decodeSchedule, encodeSchedule } from '../src/schedule/model.ts'
import { ScheduleSession } from '../src/schedule/session.ts'

function project() {
 return { format: 'open-office-schedule', version: 1, id: 'project', title: '项目排期', startDate: '2026-07-06', endDate: '2026-07-17', dailyRate: 1200.35,
  calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] },
  roles: [{ id: 'alpha', name: '甲', role: '设计', color: '#4376d4' }, { id: 'beta', name: '乙', role: '开发', color: '#2f9b7f' }],
  events: [
   { id: 'plan', roleId: null, title: '整体计划', startDate: '2026-07-06', endDate: '2026-07-17', height: 1, slot: 0, notes: '' },
   { id: 'full', roleId: 'alpha', title: '设计', startDate: '2026-07-06', endDate: '2026-07-08', height: 1, slot: 0, notes: '交付设计稿' },
   { id: 'half', roleId: 'beta', title: '开发', startDate: '2026-07-06', endDate: '2026-07-09', height: .5, slot: 1, notes: '下午' },
  ], layout: { trackHeights: { 'person-alpha': 84, 'event-half': 168, overall: 112 } },
 }
}
const schema = name => scheduleTools.find(tool => tool.name === name).inputSchema
function edit(session, operations) {
 const args = validateToolArguments(schema('schedule_edit'), { operations })
 let result
 session.change(copy => { result = editSchedule(copy, args.operations) })
 return result
}
function session(value = project()) { return new ScheduleSession(encodeSchedule(value)) }

test('schedule MCP catalog exposes the complete bounded feature surface and destructive import', () => {
 assert.deepEqual(scheduleTools.map(tool => tool.name), ['schedule_read', 'schedule_read_calendar', 'schedule_read_workload', 'schedule_edit', 'schedule_set_view', 'schedule_import', 'schedule_export', 'schedule_refresh_holidays'])
 for (const tool of scheduleTools) {
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.equal(tool.annotations.readOnlyHint, !['schedule_edit', 'schedule_import'].includes(tool.name))
 }
 assert.equal(scheduleTools.find(tool => tool.name === 'schedule_import').annotations.destructiveHint, true)
 assert.equal(scheduleTools.find(tool => tool.name === 'schedule_edit').annotations.destructiveHint, true)
 assert.deepEqual(validateToolArguments(schema('schedule_import'), { project: project() }), { project: project() })
})

test('project, people, events, calendar and row edits form one saved undoable transaction', () => {
 const s = session(), before = structuredClone(s.model)
 const result = edit(s, [
  { op: 'project.update', patch: { title: '自动排期', endDate: '2026-07-24', dailyRate: 1000.01 } },
  { op: 'role.add', role: { id: 'gamma', name: '丙' }, index: 1 },
  { op: 'role.update', roleId: 'gamma', patch: { role: '测试', color: '#112233' } },
  { op: 'event.add', event: { id: 'qa', roleId: 'gamma', title: '验收', startDate: '2026-07-20', endDate: '2026-07-24' } },
  { op: 'calendar.update', patch: { weekNumbering: 'project', extraHolidays: ['2026-07-21'] } },
  { op: 'track.height', key: 'person-gamma', height: 140 },
  { op: 'role.reorder', roleIds: ['gamma', 'beta', 'alpha'] },
 ])
 assert.deepEqual(result.created, [{ type: 'role', id: 'gamma' }, { type: 'event', id: 'qa' }])
 assert.equal(s.inspect().revision, 1); assert.equal(s.inspect().dirty, true)
 assert.deepEqual(s.model.roles.map(role => role.id), ['gamma', 'beta', 'alpha'])
 assert.deepEqual(s.model.events.at(-1), { id: 'qa', roleId: 'gamma', title: '验收', startDate: '2026-07-20', endDate: '2026-07-24', height: 1, slot: 0, notes: '' })
 assert.equal(readScheduleWorkload(s.model).people[0].totalDays, 4)
 assert.deepEqual(decodeSchedule(s.export().bytes), s.model)
 s.undo(); assert.deepEqual(s.model, before); assert.equal(s.inspect().dirty, false)
 s.redo(); assert.equal(s.model.dailyRate, 1000.01)
})

test('auto IDs and defaults are reported and can be used by later calls', () => {
 const s = session(), added = edit(s, [{ op: 'role.add', role: { name: '新增人员' } }]).created[0]
 assert.equal(added.type, 'role'); assert.match(added.id, /^[A-Za-z0-9_-]+$/)
 assert.deepEqual(s.model.roles.at(-1), { id: added.id, name: '新增人员', role: '', color: '#4376d4' })
 const addedEvent = edit(s, [{ op: 'event.add', event: { roleId: added.id, title: '工作', startDate: '2026-07-10', endDate: '2026-07-10' } }]).created[0]
 assert.equal(addedEvent.type, 'event'); assert.notEqual(addedEvent.id, added.id)
 assert.equal(s.model.events.at(-1).id, addedEvent.id)
})

test('invalid dates, duplicate IDs, rate, conflicts and missing references roll back the entire batch', () => {
 const s = session(), before = structuredClone(s.model), state = s.inspect()
 const invalid = [
  { op: 'project.update', patch: { startDate: '2026-07-20' } },
  { op: 'project.update', patch: { dailyRate: 0.001 } },
  { op: 'event.update', eventId: 'full', patch: { endDate: '2026-02-30' } },
  { op: 'event.update', eventId: 'full', patch: { roleId: 'absent' } },
  { op: 'event.copy', eventId: 'half' },
  { op: 'role.add', role: { id: 'alpha', name: '重复' } },
  { op: 'role.delete', roleId: 'alpha' },
  { op: 'role.reorder', roleIds: ['alpha', 'alpha'] },
  { op: 'role.reorder', roleIds: ['alpha'] },
  { op: 'role.reorder', roleIds: ['alpha', 'absent'] },
  { op: 'track.height', key: 'person-absent', height: 112 },
  { op: 'track.reset', key: 'event-absent' },
  { op: 'calendar.update', patch: { extraHolidays: ['2026-07-07'], excludedHolidays: ['2026-07-07'] } },
 ]
 for (const operation of invalid) {
  assert.throws(() => edit(s, [{ op: 'project.update', patch: { title: '不应保存' } }, operation]))
  assert.deepEqual(s.model, before); assert.deepEqual(s.inspect(), state)
 }
})

test('batch validates final state so owners can be swapped without transient conflict failures', () => {
 const s = session()
 edit(s, [{ op: 'event.update', eventId: 'full', patch: { roleId: 'beta' } }, { op: 'event.update', eventId: 'half', patch: { roleId: 'alpha' } }])
 assert.equal(s.model.events.find(event => event.id === 'full').roleId, 'beta')
 assert.equal(s.model.events.find(event => event.id === 'half').roleId, 'alpha')
 assert.equal(s.inspect().revision, 1)
})

test('copy preserves source content and event height; dates, target owner and slot can be changed', () => {
 const s = session(), source = structuredClone(s.model.events.find(event => event.id === 'half'))
 edit(s, [{ op: 'event.copy', eventId: 'half', id: 'copy', patch: { roleId: 'alpha', startDate: '2026-07-13', endDate: '2026-07-16', slot: 0 } }])
 const duplicate = s.model.events.find(event => event.id === 'copy')
 assert.deepEqual(s.model.events.find(event => event.id === 'half'), source)
 assert.deepEqual(duplicate, { ...source, id: 'copy', roleId: 'alpha', startDate: '2026-07-13', endDate: '2026-07-16', slot: 0 })
 assert.equal(s.model.layout.trackHeights['event-copy'], 168)
 edit(s, [{ op: 'event.update', eventId: 'half', patch: { height: 1 } }])
 assert.equal(s.model.events.find(event => event.id === 'half').slot, 0)
 assert.throws(() => edit(s, [{ op: 'event.update', eventId: 'half', patch: { height: 1, slot: 1 } }]), /时段/)
})

test('explicitly move/delete events before deleting people and prune only orphaned track heights', () => {
 const s = session()
 edit(s, [{ op: 'event.delete', eventId: 'half' }, { op: 'event.update', eventId: 'full', patch: { roleId: 'beta' } }, { op: 'role.delete', roleId: 'alpha' }])
 assert.deepEqual(s.model.roles.map(role => role.id), ['beta'])
 assert.deepEqual(s.model.layout, { trackHeights: { overall: 112 } })
 edit(s, [{ op: 'track.height', key: 'person-beta', height: 336 }, { op: 'track.reset', key: 'overall' }])
 assert.deepEqual(s.model.layout, { trackHeights: { 'person-beta': 336 } })
 edit(s, [{ op: 'track.reset' }]); assert.equal(Object.hasOwn(s.model, 'layout'), false)
})

test('rate can be cleared and set to zero without confusing zero with no price', () => {
 const s = session()
 edit(s, [{ op: 'project.update', patch: { dailyRate: null } }])
 assert.equal(Object.hasOwn(s.model, 'dailyRate'), false); assert.equal(readScheduleWorkload(s.model).budget, null)
 edit(s, [{ op: 'project.update', patch: { dailyRate: 0 } }])
 assert.equal(s.model.dailyRate, 0); assert.equal(readScheduleWorkload(s.model).budget, 0)
})

test('import validates first, replaces all content but retains current project identity and can be undone', () => {
 const s = session(), before = structuredClone(s.model), incoming = project(); incoming.id = 'external'; incoming.title = '导入的项目'
 delete incoming.dailyRate; delete incoming.layout; incoming.events = []; incoming.roles = []
 const raw = structuredClone(incoming)
 s.change(copy => importSchedule(copy, incoming))
 assert.deepEqual(s.model, { ...incoming, id: before.id }); assert.deepEqual(incoming, raw)
 assert.deepEqual(decodeSchedule(s.export().bytes), s.model)
 s.undo(); assert.deepEqual(s.model, before)
 const state = s.inspect(), collision = project(); collision.id = 'external'; collision.roles[0].id = before.id; collision.events[1].roleId = before.id; delete collision.layout
 assert.throws(() => s.change(copy => importSchedule(copy, collision)), /标识/)
 assert.deepEqual(s.model, before); assert.deepEqual(s.inspect(), state)
})

test('readers use the same working-day rules, totals and budget without modifying the source', () => {
 const value = project(), before = structuredClone(value), result = readScheduleWorkload(value)
 assert.equal(result.totalDays, 5); assert.equal(result.projectTotalDays, 5); assert.equal(result.budget, 6001.75)
 assert.deepEqual(result.people.map(person => person.totalDays), [3, 2]); assert.equal(result.currency, 'CNY')
 const one = readScheduleWorkload(value, {}, { roleId: 'beta', basis: 'month' })
 assert.equal(one.people.length, 1); assert.equal(one.totalDays, 2); assert.equal(one.budget, 2400.7)
 assert.equal(one.projectTotalDays, 5); assert.equal(one.projectBudget, 6001.75)
 assert.equal(one.team[0].availableDays, 23); assert.equal(one.team[0].scheduledDays, 2)
 assert.throws(() => readScheduleWorkload(value, {}, { roleId: 'missing' }), /不存在/)
 const holidays = { 2026: { '2026-07-07': '测试假日' } }
 assert.equal(readScheduleWorkload(value, holidays).totalDays, 3.5); assert.equal(readScheduleWorkload(value, holidays).budget, 4201.23)
 const calendar = readScheduleCalendar(value, holidays)
 assert.equal(calendar.days.length, 9); assert.equal(calendar.workingDates.length, 9)
 const visible = { ...value, calendar: { ...value.calendar, hideWeekends: false, hideHolidays: false } }
 assert.equal(readScheduleCalendar(visible, holidays).days.length, 12); assert.equal(readScheduleCalendar(visible, holidays).workingDates.length, 9)
 assert.deepEqual(readScheduleWorkload(visible, holidays), readScheduleWorkload(value, holidays))
 assert.deepEqual(value, before)
})

test('strict schemas reject unknown fields, impossible heights, malformed imports and remote paths', () => {
 for (const args of [
  { operations: [] }, { operations: Array.from({ length: 101 }, () => ({ op: 'track.reset' })) },
  { operations: [{ op: 'event.update', eventId: 'full', patch: { id: 'replacement' } }] },
  { operations: [{ op: 'project.update', patch: {} }] },
  { operations: [{ op: 'role.add', role: { name: 'x', path: '/tmp/private' } }] },
  { operations: [{ op: 'event.add', event: { title: 'x', startDate: '2026-07-06', endDate: '2026-07-06' } }] },
  { operations: [{ op: 'track.height', key: 'person-alpha', height: 100 }] },
  { operations: [{ op: 'track.height', key: 'person-alpha', height: 364 }] },
  { operations: [{ op: 'calendar.update', patch: { url: 'https://example.com' } }] },
  { operations: [{ op: 'project.update', patch: { dailyRate: Infinity } }] },
 ]) assert.throws(() => validateToolArguments(schema('schedule_edit'), args))
 for (const args of [{}, { mode: 'events' }, { dayWidth: 35 }, { selectedEventId: 3 }, { script: 'alert(1)' }]) assert.throws(() => validateToolArguments(schema('schedule_set_view'), args))
 assert.deepEqual(validateToolArguments(schema('schedule_set_view'), { mode: 'global', selectedEventId: null, dayWidth: 36 }), { mode: 'global', selectedEventId: null, dayWidth: 36 })
 assert.throws(() => validateToolArguments(schema('schedule_refresh_holidays'), { url: 'https://example.com' }))
 assert.throws(() => validateToolArguments(schema('schedule_export'), { format: 'png', path: '/tmp/export.png' }))
 assert.throws(() => validateToolArguments(schema('schedule_import'), { project: { ...project(), script: 'alert(1)' } }))
 assert.throws(() => validateToolArguments(schema('schedule_import'), { project: { ...project(), dailyRate: null } }))
})
