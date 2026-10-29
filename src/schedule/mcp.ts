import { buildCalendar } from './calendar.ts'
import type { HolidayYears } from './holidays.ts'
import { pruneTrackHeights, trackKeys } from './layout.ts'
import { scheduleId, validateSchedule, type ScheduleCalendarSettings, type ScheduleEvent, type ScheduleProject, type ScheduleRole } from './model.ts'
import { buildMonthlyWorkload, buildWorkloadDates, calculateWorkloadBudget, type WorkloadBasis } from './workload.ts'

type EventPatch = Partial<Omit<ScheduleEvent, 'id'>>
export type ScheduleEditOperation =
 | { op: 'project.update'; patch: Partial<Pick<ScheduleProject, 'title' | 'startDate' | 'endDate'>> & { dailyRate?: number | null } }
 | { op: 'role.add'; role: Pick<ScheduleRole, 'name'> & Partial<ScheduleRole>; index?: number }
 | { op: 'role.update'; roleId: string; patch: Partial<Omit<ScheduleRole, 'id'>> }
 | { op: 'role.delete'; roleId: string }
 | { op: 'role.reorder'; roleIds: string[] }
 | { op: 'event.add'; event: Pick<ScheduleEvent, 'roleId' | 'title' | 'startDate' | 'endDate'> & Partial<ScheduleEvent> }
 | { op: 'event.update'; eventId: string; patch: EventPatch }
 | { op: 'event.delete'; eventId: string }
 | { op: 'event.copy'; eventId: string; id?: string; patch?: EventPatch }
 | { op: 'calendar.update'; patch: Partial<ScheduleCalendarSettings> }
 | { op: 'track.height'; key: string; height: number }
 | { op: 'track.reset'; key?: string }

function role(project: ScheduleProject, id: string): ScheduleRole {
 const found = project.roles.find(item => item.id === id)
 if (!found) throw Error(`人员不存在：${id}`)
 return found
}
function event(project: ScheduleProject, id: string): ScheduleEvent {
 const found = project.events.find(item => item.id === id)
 if (!found) throw Error(`事件不存在：${id}`)
 return found
}
function updateEvent(target: ScheduleEvent, patch: EventPatch) {
 Object.assign(target, patch)
 if (patch.height === 1 && patch.slot === undefined) target.slot = 0
}
function assertTrack(project: ScheduleProject, key: string) {
 if (!trackKeys(project).has(key)) throw Error(`轨道不存在：${key}`)
}

/** Apply only to a detached ScheduleSession.change draft; the session validates
 * once at commit so an invalid operation or final conflict rolls back the batch. */
export function editSchedule(project: ScheduleProject, operations: readonly ScheduleEditOperation[]) {
 if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw Error('一次排期编辑需要 1–100 项操作。')
 const created: { type: 'role' | 'event'; id: string }[] = []
 for (const operation of operations as readonly ScheduleEditOperation[]) {
  switch (operation.op) {
   case 'project.update': {
    const { dailyRate, ...patch } = operation.patch
    Object.assign(project, patch)
    if (dailyRate === null) delete project.dailyRate
    else if (dailyRate !== undefined) project.dailyRate = dailyRate
    break
   }
   case 'role.add': {
    const value: ScheduleRole = { id: scheduleId(), role: '', color: '#4376d4', ...operation.role }
    const index = operation.index ?? project.roles.length
    if (!Number.isInteger(index) || index < 0 || index > project.roles.length) throw Error('人员插入位置超出范围。')
    project.roles.splice(index, 0, value); created.push({ type: 'role', id: value.id }); break
   }
   case 'role.update': Object.assign(role(project, operation.roleId), operation.patch); break
   case 'role.delete': {
    role(project, operation.roleId)
    if (project.events.some(item => item.roleId === operation.roleId)) throw Error('这名人员还有事件，请先移动或删除这些事件。')
    project.roles = project.roles.filter(item => item.id !== operation.roleId); break
   }
   case 'role.reorder': {
    if (operation.roleIds.length !== project.roles.length || new Set(operation.roleIds).size !== project.roles.length) throw Error('人员排序必须且只能包含每一名现有人员一次。')
    project.roles = operation.roleIds.map(id => role(project, id)); break
   }
   case 'event.add': {
    const value: ScheduleEvent = { id: scheduleId(), height: 1, slot: 0, notes: '', ...operation.event }
    project.events.push(value); created.push({ type: 'event', id: value.id }); break
   }
   case 'event.update': updateEvent(event(project, operation.eventId), operation.patch); break
   case 'event.delete': {
    event(project, operation.eventId)
    project.events = project.events.filter(item => item.id !== operation.eventId); break
   }
   case 'event.copy': {
    const source = event(project, operation.eventId), copy = { ...source, id: operation.id ?? scheduleId() }
    if (operation.patch) updateEvent(copy, operation.patch)
    project.events.push(copy); created.push({ type: 'event', id: copy.id })
    const height = project.layout?.trackHeights[`event-${source.id}`]
    if (height !== undefined) project.layout!.trackHeights[`event-${copy.id}`] = height
    break
   }
   case 'calendar.update': Object.assign(project.calendar, structuredClone(operation.patch)); break
   case 'track.height': {
    assertTrack(project, operation.key)
    project.layout ??= { trackHeights: {} }; project.layout.trackHeights[operation.key] = operation.height; break
   }
   case 'track.reset': {
    if (operation.key === undefined) delete project.layout
    else { assertTrack(project, operation.key); if (project.layout) delete project.layout.trackHeights[operation.key] }
    break
   }
   default: throw Error('不支持的排期编辑操作。')
  }
 }
 pruneTrackHeights(project)
 return { created }
}

/** Replace content in an existing transaction without changing its identity. */
export function importSchedule(project: ScheduleProject, source: unknown): void {
 const imported = validateSchedule(source)
 const next = validateSchedule({ ...imported, id: project.id })
 delete project.dailyRate; delete project.layout
 Object.assign(project, next)
}

export function readScheduleCalendar(project: ScheduleProject, holidayYears: HolidayYears = {}) {
 return { ...buildCalendar(project, holidayYears), workingDates: buildWorkloadDates(project, holidayYears) }
}

/** Project-wide totals remain explicit when a caller narrows the person list. */
export function readScheduleWorkload(project: ScheduleProject, holidayYears: HolidayYears = {}, options: { roleId?: string; basis?: WorkloadBasis } = {}) {
 if (options.roleId !== undefined) role(project, options.roleId)
 const result = buildMonthlyWorkload(project, holidayYears, options.basis ?? 'project')
 const people = result.people.filter(person => options.roleId === undefined || person.roleId === options.roleId).map(person => ({ ...person, budget: calculateWorkloadBudget(person.totalDays, project.dailyRate) }))
 const totalDays = people.reduce((sum, person) => sum + person.totalDays, 0)
 const team = result.months.map((month, index) => {
  const scheduledDays = people.reduce((sum, person) => sum + person.months[index].scheduledDays, 0), availableDays = month.workingDays * people.length
  return { scheduledDays, availableDays, percentage: availableDays > 0 ? scheduledDays / availableDays * 100 : null }
 })
 return { basis: options.basis ?? 'project', currency: 'CNY', dailyRate: project.dailyRate ?? null, months: result.months, people, team, totalDays,
  budget: calculateWorkloadBudget(totalDays, project.dailyRate), projectTotalDays: result.totalDays, projectBudget: calculateWorkloadBudget(result.totalDays, project.dailyRate),
 }
}
