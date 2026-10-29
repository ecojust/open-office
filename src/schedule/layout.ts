import type { ScheduleEvent, ScheduleProject } from './model.ts'
import { projectedSpan, type CalendarDay } from './calendar.ts'

export const SCHEDULE_TRACK_STEP = 28
export const SCHEDULE_TRACK_HEIGHT = 112
export const SCHEDULE_TRACK_MIN_HEIGHT = 84
export const SCHEDULE_TRACK_MAX_HEIGHT = 336
export const SCHEDULE_LABEL_WIDTH = 192
export const SCHEDULE_HEADER_HEIGHT = 72
export const SCHEDULE_EVENT_PADDING = 9

export type DisplayEvent = { event: ScheduleEvent; start: number; count: number }
export type TimelineRow = { key: string; roleId: string | null; name: string; subtitle: string; color: string; events: DisplayEvent[]; total: number }

export function snapTrackHeight(value: number): number {
 if (!Number.isFinite(value)) return SCHEDULE_TRACK_HEIGHT
 return Math.max(SCHEDULE_TRACK_MIN_HEIGHT, Math.min(SCHEDULE_TRACK_MAX_HEIGHT, Math.round(value / SCHEDULE_TRACK_STEP) * SCHEDULE_TRACK_STEP))
}
export function getTrackHeight(project: ScheduleProject, key: string): number {
 return project.layout?.trackHeights[key] ?? SCHEDULE_TRACK_HEIGHT
}
/** Half-height events use the upper/lower half for morning/afternoon. */
export function getEventVerticalLayout(trackHeight: number, event: Pick<ScheduleEvent, 'height' | 'slot'>): { top: number; height: number } {
 const fullHeight = trackHeight - SCHEDULE_EVENT_PADDING * 2
 return { top: SCHEDULE_EVENT_PADDING + (event.height === .5 && event.slot === 1 ? fullHeight / 2 : 0), height: fullHeight * event.height }
}
export function trackKeys(project: Pick<ScheduleProject, 'roles' | 'events'>): Set<string> {
 return new Set(['overall', ...project.roles.map(role => `person-${role.id}`), ...project.events.map(event => `event-${event.id}`)])
}
/** Run within the same edit that removes roles/events, retaining other view heights. */
export function pruneTrackHeights(project: ScheduleProject): void {
 if (!project.layout) return
 const keys = trackKeys(project)
 for (const key of Object.keys(project.layout.trackHeights)) if (!keys.has(key)) delete project.layout.trackHeights[key]
 if (!Object.keys(project.layout.trackHeights).length) delete project.layout
}
/** Shared row order and date projection for the interactive timeline and full PNG. */
export function buildTimelineRows(project: ScheduleProject, mode: 'people' | 'global', days: readonly CalendarDay[]): TimelineRow[] {
 const roles = new Map(project.roles.map(role => [role.id, role]))
 const eventsByRole = new Map<string | null, ScheduleEvent[]>()
 for (const event of project.events) {
  const list = eventsByRole.get(event.roleId) ?? []
  list.push(event); eventsByRole.set(event.roleId, list)
 }
 const display = (events: ScheduleEvent[]): DisplayEvent[] => events.flatMap(event => {
  const span = projectedSpan(event, days)
  return span ? [{ event, ...span }] : []
 })
 const overall = eventsByRole.get(null) ?? []
 const result: TimelineRow[] = [{ key: 'overall', roleId: null, name: '整体计划', subtitle: '项目阶段与关键节点', color: 'var(--ui-accent)', events: display(overall), total: overall.length }]
 if (mode === 'people') {
  for (const role of project.roles) {
   const events = eventsByRole.get(role.id) ?? []
   result.push({ key: `person-${role.id}`, roleId: role.id, name: role.name, subtitle: role.role || '项目成员', color: role.color, events: display(events), total: events.length })
  }
 } else {
  for (const event of project.events.filter(event => event.roleId !== null).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.title.localeCompare(b.title))) {
   const role = roles.get(event.roleId!)
   result.push({ key: `event-${event.id}`, roleId: event.roleId, name: event.title, subtitle: role ? `${role.name}${role.role ? ` · ${role.role}` : ''}` : '项目成员', color: role?.color ?? 'var(--ui-accent)', events: display([event]), total: 1 })
  }
 }
 return result
}
