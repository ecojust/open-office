import test from 'node:test'
import assert from 'node:assert/strict'
import { createSchedule, decodeSchedule, encodeSchedule, validateSchedule } from '../src/schedule/model.ts'
import { buildCalendar } from '../src/schedule/calendar.ts'
import { ScheduleSession } from '../src/schedule/session.ts'
import { buildTimelineRows, getTrackHeight, pruneTrackHeights, snapTrackHeight, SCHEDULE_TRACK_STEP } from '../src/schedule/layout.ts'

function fixture() {
 const project = createSchedule('轨道高度')
 Object.assign(project, { startDate: '2026-06-01', endDate: '2026-06-12', roles: [{ id: 'alice', name: '小明', role: '开发', color: '#4376d4' }, { id: 'bob', name: '小红', role: '设计', color: '#9b66c9' }], events: [
  { id: 'late', roleId: 'alice', title: '开发', startDate: '2026-06-04', endDate: '2026-06-05', height: .5, slot: 0, notes: '半高仍独占日期' },
  { id: 'early', roleId: 'bob', title: '设计', startDate: '2026-06-01', endDate: '2026-06-03', height: 1, slot: 0, notes: '' },
  { id: 'phase', roleId: null, title: '整体', startDate: '2026-06-01', endDate: '2026-06-12', height: 1, slot: 0, notes: '' },
 ] })
 return project
}

test('existing schedules retain their exact data and clean state without layout metadata', () => {
 const project = fixture(), bytes = encodeSchedule(project), session = new ScheduleSession(bytes)
 assert.deepEqual(decodeSchedule(bytes), project)
 assert.equal('layout' in session.model, false)
 assert.equal(getTrackHeight(session.model, 'overall'), 112)
 assert.equal(getTrackHeight(session.model, 'person-alice'), 112)
 assert.equal(session.inspect().dirty, false)
 assert.deepEqual(session.export().bytes, bytes)
})

test('track heights snap to bounded 28-pixel units, including rounding and invalid previews', () => {
 assert.equal(snapTrackHeight(125), 112)
 assert.equal(snapTrackHeight(126), 140)
 assert.equal(snapTrackHeight(10), 84)
 assert.equal(snapTrackHeight(9999), 336)
 assert.equal(snapTrackHeight(Infinity), 112)
 assert.equal(snapTrackHeight(NaN), 112)
 for (let value = -200; value <= 600; value += .5) {
  const height = snapTrackHeight(value)
  assert.equal(height % SCHEDULE_TRACK_STEP, 0)
  assert.ok(height >= 84 && height <= 336)
 }
})

test('each view retains independent track heights through save, undo and redo without changing events', () => {
 const project = fixture(), originalEvents = structuredClone(project.events), session = new ScheduleSession(encodeSchedule(project))
 session.change(copy => { copy.layout = { trackHeights: { overall: 84, 'person-alice': 140, 'person-bob': 336, 'event-late': 196 } } })
 assert.equal(session.inspect().dirty, true)
 assert.equal(getTrackHeight(session.model, 'person-alice'), 140)
 assert.equal(getTrackHeight(session.model, 'event-late'), 196)
 assert.deepEqual(session.model.events, originalEvents)
 const saved = session.export().bytes
 session.markSaved(saved)
 assert.equal(session.inspect().dirty, false)
 assert.equal(getTrackHeight(new ScheduleSession(saved).model, 'event-late'), 196)
 session.undo()
 assert.equal('layout' in session.model, false)
 assert.equal(session.inspect().dirty, true)
 session.redo()
 assert.deepEqual(session.export().bytes, saved)
 assert.equal(session.inspect().dirty, false)
 assert.deepEqual(session.model.events, originalEvents)
})

test('untrusted imports reject fractional, out-of-range, dangling and malformed track metadata atomically', () => {
 const project = fixture(), session = new ScheduleSession(encodeSchedule(project)), before = session.inspect()
 for (const height of [0, -28, 28, 56, 85, 111, 113, 126, 364, 112.1, NaN, Infinity, '112', null, undefined]) {
  assert.throws(() => session.change(copy => { copy.layout = { trackHeights: { 'person-alice': height } } }), /轨道高度/)
  assert.deepEqual(session.inspect(), before)
  assert.deepEqual(session.model, project)
 }
 for (const key of ['alice', 'person-missing', 'event-missing', 'constructor', '__proto__']) {
  assert.throws(() => validateSchedule({ ...project, layout: { trackHeights: JSON.parse(`{"${key}":112}`) } }), /不存在/)
 }
 for (const layout of [null, [], { trackHeights: [] }, { trackHeights: null }, {}]) assert.throws(() => validateSchedule({ ...project, layout }))
})

test('removing an event or person prunes only its saved heights inside the same undoable edit', () => {
 const project = fixture()
 project.layout = { trackHeights: { overall: 140, 'person-alice': 168, 'person-bob': 84, 'event-late': 196, 'event-early': 224 } }
 const session = new ScheduleSession(encodeSchedule(project))
 session.change(copy => { copy.events = copy.events.filter(event => event.roleId !== 'alice'); copy.roles = copy.roles.filter(role => role.id !== 'alice'); pruneTrackHeights(copy) })
 assert.deepEqual(session.model.layout.trackHeights, { overall: 140, 'person-bob': 84, 'event-early': 224 })
 session.undo()
 assert.deepEqual(session.model, project)
 const empty = fixture(); empty.layout = { trackHeights: { 'person-gone': 112 } }; pruneTrackHeights(empty)
 assert.equal('layout' in empty, false)
})

test('interactive and exported rows share owner colors, global ordering and holiday projection', () => {
 const project = fixture(), days = buildCalendar(project).days
 const people = buildTimelineRows(project, 'people', days)
 assert.deepEqual(people.map(row => row.key), ['overall', 'person-alice', 'person-bob'])
 assert.deepEqual(people[1].events[0], { event: project.events[0], start: 3, count: 2 })
 const global = buildTimelineRows(project, 'global', days)
 assert.deepEqual(global.map(row => row.key), ['overall', 'event-early', 'event-late'])
 assert.equal(global[1].subtitle, '小红 · 设计')
 assert.equal(global[1].color, '#9b66c9')
 assert.deepEqual(project.events.map(event => event.id), ['late', 'early', 'phase'])
 const hidden = buildTimelineRows(project, 'people', [])
 assert.equal(hidden[1].total, 1)
 assert.equal(hidden[1].events.length, 0)
})
