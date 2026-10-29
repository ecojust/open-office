import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays } from '../src/schedule/calendar.ts'
import { decodeSchedule, encodeSchedule } from '../src/schedule/model.ts'
import { ScheduleSession } from '../src/schedule/session.ts'

function fixture() {
 return { format: 'open-office-schedule', version: 1, id: 'copy_project', title: '复制排期', startDate: '2026-09-21', endDate: '2026-11-30', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'alice', name: '小明', role: '设计', color: '#345678' }, { id: 'bob', name: '小红', role: '开发', color: '#876543' }], events: [{ id: 'source', roleId: 'alice', title: '设计交付', startDate: '2026-09-23', endDate: '2026-09-25', height: .5, slot: 1, notes: '保留备注\n😀' }] }
}
function session(project = fixture()) { return new ScheduleSession(encodeSchedule(project)) }

test('copy creates a distinct event at the new placement while preserving source content and period', () => {
 const current = session(), source = structuredClone(current.model.events[0])
 const duplicate = current.copyEvent({ ...source, roleId: 'bob', title: '不能替换源标题', notes: '不能替换源备注', height: 1 })
 assert.notEqual(duplicate.id, source.id)
 assert.deepEqual(duplicate, { ...source, id: duplicate.id, roleId: 'bob' })
 assert.deepEqual(current.model.events[0], source)
 assert.equal(current.model.events.length, 2)
 assert.equal(current.inspect().revision, 1)
 assert.equal(current.inspect().dirty, true)
 const another = current.copyEvent({ ...source, startDate: '2026-10-12', endDate: '2026-10-14' })
 assert.notEqual(another.id, duplicate.id)
 assert.equal(another.roleId, 'alice'); assert.equal(another.slot, 1)
 assert.deepEqual(current.model.events[0], source)
})

test('copy is one undoable edit and round-trips through the exported schedule bytes', () => {
 const project = fixture(); project.layout = { trackHeights: { 'event-source': 196, 'person-alice': 168 } }
 const current = session(project), original = structuredClone(current.model)
 const duplicate = current.copyEvent({ ...current.model.events[0], roleId: 'bob', slot: 0 })
 assert.equal(current.model.layout.trackHeights[`event-${duplicate.id}`], 196)
 assert.equal(current.model.layout.trackHeights['person-alice'], 168)
 const copied = structuredClone(current.model)
 assert.equal(current.undo(), true); assert.deepEqual(current.model, original); assert.equal(current.inspect().dirty, false)
 assert.equal(current.redo(), true); assert.deepEqual(current.model, copied)
 const exported = current.export(); current.markSaved(exported.bytes)
 assert.equal(current.inspect().dirty, false); assert.deepEqual(decodeSchedule(exported.bytes), copied)
 assert.equal(session(decodeSchedule(exported.bytes)).model.events[1].id, duplicate.id)
})

test('copy into the source or occupied dates rejects atomically, including the other half of a day', () => {
 const current = session(), original = structuredClone(current.model), before = current.inspect(), receipt = current.export()
 for (const placement of [current.model.events[0], { ...current.model.events[0], slot: 0 }, { ...current.model.events[0], startDate: '2026-09-25', endDate: '2026-09-28' }]) {
  assert.throws(() => current.copyEvent(placement), /日期重叠/)
  assert.deepEqual(current.model, original); assert.deepEqual(current.inspect(), before)
  current.validateReceipt(receipt.bytes)
 }
})

test('missing sources and invalid copy destinations leave data, history and receipts intact', () => {
 const current = session(), original = structuredClone(current.model), before = current.inspect(), receipt = current.export()
 for (const change of [{ id: 'deleted' }, { roleId: 'missing' }, { roleId: 'bob', startDate: '2026-01-01' }, { roleId: 'bob', slot: 2 }]) {
  assert.throws(() => current.copyEvent({ ...current.model.events[0], ...change }))
  assert.deepEqual(current.model, original); assert.deepEqual(current.inspect(), before); current.validateReceipt(receipt.bytes)
 }
})

test('copying a whole-day event stays whole-day and does not introduce layout metadata', () => {
 const project = fixture(); project.events[0].height = 1; project.events[0].slot = 0
 const current = session(project), copied = current.copyEvent({ ...current.model.events[0], roleId: null, slot: 1 })
 assert.equal(copied.height, 1); assert.equal(copied.slot, 0)
 assert.equal('layout' in current.model, false)
 const receipt = current.export()
 current.copyEvent({ ...copied, roleId: 'bob' })
 assert.throws(() => current.markSaved(receipt.bytes), /回执/)
})

test('copy cannot exceed the project event limit or damage an existing large schedule', () => {
 const project = fixture(); project.endDate = addDays(project.startDate, 999)
 project.events = Array.from({ length: 2000 }, (_, index) => ({ ...project.events[0], id: `event_${index}`, roleId: index % 2 ? 'alice' : 'bob', startDate: addDays(project.startDate, Math.floor(index / 2)), endDate: addDays(project.startDate, Math.floor(index / 2)) }))
 const current = session(project), before = current.inspect(), original = structuredClone(current.model)
 assert.throws(() => current.copyEvent({ ...current.model.events[0], roleId: null }), /2000/)
 assert.deepEqual(current.model, original); assert.deepEqual(current.inspect(), before)
})
