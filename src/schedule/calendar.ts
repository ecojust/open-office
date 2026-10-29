import type { ScheduleEvent, ScheduleProject } from './model.ts'
import type { HolidayYears } from './holidays.ts'

const DAY = 86_400_000
export type IsoWeek = { weekYear: number; weekIndex: number }
/** weekIndex follows the selected numbering mode; weekYear always denotes the ISO week year. */
export type CalendarDay = { date: string; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; weekYear: number; weekIndex: number; holiday?: string }
export type CalendarWeek = { key: string; label: string; weekYear: number; startIndex: number; count: number }
export type ScheduleCalendar = { days: CalendarDay[]; weeks: CalendarWeek[]; hiddenCount: number; unknownHolidayYears: number[] }
/** Strict, timezone-independent civil dates; UTC is only the arithmetic representation. */
export function dayNumber(value: string): number {
 const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
 if (!match) throw Error('日期必须为 YYYY-MM-DD。')
 const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), time = Date.UTC(year, month - 1, day), parsed = new Date(time)
 if (year < 1900 || year > 9999 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw Error(`无效日期“${value}”。`)
 return time / DAY
}
export function dateFromDayNumber(value: number): string {
 if (!Number.isSafeInteger(value)) throw Error('日期天数必须为整数。')
 const date = new Date(value * DAY)
 if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999) throw Error('日期超出支持范围。')
 return date.toISOString().slice(0, 10)
}
export function addDays(date: string, delta: number): string { if (!Number.isSafeInteger(delta)) throw Error('只能按整天调整日期。'); return dateFromDayNumber(dayNumber(date) + delta) }
export function mondayOf(date: string): string { const day = dayNumber(date), weekday = new Date(day * DAY).getUTCDay(); return dateFromDayNumber(day - ((weekday + 6) % 7)) }
function weekFromDayNumber(day: number): IsoWeek {
 // ISO weeks belong to the year containing their Thursday. Arithmetic stays in
 // UTC day numbers so neither local DST nor out-of-range civil strings are used.
 const weekday = new Date(day * DAY).getUTCDay(), thursday = day + 3 - ((weekday + 6) % 7)
 const weekYear = new Date(thursday * DAY).getUTCFullYear()
 return { weekYear, weekIndex: Math.floor((thursday - Date.UTC(weekYear, 0, 1) / DAY) / 7) + 1 }
}
/** ISO 8601: Monday starts the week; W1 contains January 4, independent of project range. */
export function isoWeek(date: string): IsoWeek { return weekFromDayNumber(dayNumber(date)) }

// Mainland China official days off, inclusive. Weekend make-up workdays remain
// weekends here. Sources and the holiday-cn MIT notice: docs/schedule-calendar.md.
const holidayRanges: Record<number, readonly (readonly [string, string, string])[]> = {
 2025: [['01-01', '01-01', '元旦'], ['01-28', '02-04', '春节'], ['04-04', '04-06', '清明节'], ['05-01', '05-05', '劳动节'], ['05-31', '06-02', '端午节'], ['10-01', '10-08', '国庆节、中秋节']],
 2026: [['01-01', '01-03', '元旦'], ['02-15', '02-23', '春节'], ['04-04', '04-06', '清明节'], ['05-01', '05-05', '劳动节'], ['06-19', '06-21', '端午节'], ['09-25', '09-27', '中秋节'], ['10-01', '10-07', '国庆节']],
}
export function buildCalendar(project: ScheduleProject, loaded: HolidayYears = {}): ScheduleCalendar {
 const start = dayNumber(project.startDate), end = dayNumber(project.endDate)
 if (end < start || end - start >= 1096) throw Error('项目日期范围无效或超过 3 年。')
 const extra = new Set(project.calendar.extraHolidays), excluded = new Set(project.calendar.excludedHolidays)
 const projectWeekAnchor = project.calendar.weekNumbering === 'project' ? dayNumber(mondayOf(project.startDate)) : undefined
 const days: CalendarDay[] = [], weeks: CalendarWeek[] = [], unknown = new Set<number>()
 const official = new Map<string, string | null>()
 // Include built-in fallbacks in source-year order too: an older downloaded
 // announcement must not override a newer built-in announcement across years.
 const sourceYears = new Set([...Object.keys(holidayRanges), ...Object.keys(loaded)].map(Number))
 for (const year of [...sourceYears].sort((a, b) => a - b)) {
  if (loaded[year]) {
   for (const [date, name] of Object.entries(loaded[year]!)) official.set(date, name)
  } else {
   for (const [first, last, name] of holidayRanges[year] ?? []) {
    const end = dayNumber(`${year}-${last}`)
    for (let date = dayNumber(`${year}-${first}`); date <= end; date++) official.set(dateFromDayNumber(date), name)
   }
  }
 }
 let hiddenCount = 0
 for (let number = start; number <= end; number++) {
  const date = dateFromDayNumber(number), year = Number(date.slice(0, 4)), weekday = new Date(number * DAY).getUTCDay() as CalendarDay['weekday']
  const ranges = holidayRanges[year]
  if (!ranges && !loaded[year]) unknown.add(year)
  const knownHoliday = official.get(date) ?? undefined
  const holiday = extra.has(date) ? '自定义假日' : excluded.has(date) ? undefined : knownHoliday
  if ((project.calendar.hideWeekends && (weekday === 0 || weekday === 6)) || (project.calendar.hideHolidays && holiday !== undefined)) { hiddenCount++; continue }
  const annual = weekFromDayNumber(number), weekYear = annual.weekYear
  const weekIndex = projectWeekAnchor === undefined ? annual.weekIndex : Math.floor((number - projectWeekAnchor) / 7) + 1
  const key = dateFromDayNumber(number - ((weekday + 6) % 7))
  if (weeks.at(-1)?.key === key) weeks.at(-1)!.count++
  else weeks.push({ key, label: `W${weekIndex}`, weekYear, startIndex: days.length, count: 1 })
  days.push({ date, weekday, weekYear, weekIndex, ...(holiday ? { holiday } : {}) })
 }
 return { days, weeks, hiddenCount, unknownHolidayYears: [...unknown] }
}
/** Projection never rewrites stored endpoints, including endpoints on hidden days. */
export function projectedSpan(event: Pick<ScheduleEvent, 'startDate' | 'endDate'>, days: readonly CalendarDay[]): { start: number; count: number } | null {
 const start = days.findIndex(day => day.date >= event.startDate)
 if (start < 0 || days[start].date > event.endDate) return null
 let end = start
 while (end + 1 < days.length && days[end + 1].date <= event.endDate) end++
 return { start, count: end - start + 1 }
}
function overlaps(a: ScheduleEvent, b: ScheduleEvent): boolean { return a.roleId === b.roleId && a.startDate <= b.endDate && b.startDate <= a.endDate }
function conflictError(project: ScheduleProject, event: ScheduleEvent, other: ScheduleEvent): Error {
 const track = event.roleId === null ? '整体计划' : project.roles.find(role => role.id === event.roleId)?.name ?? '该角色'
 return Error(`“${track}”轨道的“${event.title}”与“${other.title}”日期重叠，请调整日期或角色。半高事件也占用该日期。`)
}
/** One event per track and date; half height is visual and does not add capacity. */
export function validateEventConflicts(project: ScheduleProject): void {
 const lanes = new Map<string, ScheduleEvent[]>()
 for (const event of project.events) {
  const key = event.roleId ?? '', lane = lanes.get(key) ?? []
  lane.push(event); lanes.set(key, lane)
 }
 for (const lane of lanes.values()) {
  lane.sort((a, b) => a.startDate.localeCompare(b.startDate))
  for (let index = 1; index < lane.length; index++) if (lane[index].startDate <= lane[index - 1].endDate) throw conflictError(project, lane[index], lane[index - 1])
 }
}
function placedEvent(project: ScheduleProject, event: ScheduleEvent): ScheduleEvent {
 if (event.roleId !== null && !project.roles.some(role => role.id === event.roleId)) throw Error('目标角色不存在。')
 if ((event.height !== 1 && event.height !== .5) || (event.slot !== 0 && event.slot !== 1) || (event.height === 1 && event.slot !== 0)) throw Error('事件时段无效；整行事件使用全天，半高事件只能选择上午或下午。')
 if (event.startDate < project.startDate || event.endDate > project.endDate || event.startDate > event.endDate) throw Error('事件起止日期无效或超出项目范围。')
 const other = project.events.find(other => other.id !== event.id && overlaps(event, other))
 if (other) throw conflictError(project, event, other)
 return event
}
export function moveScheduledEvent(project: ScheduleProject, event: ScheduleEvent, deltaCols: number, targetRoleId: string | null, slot: 0 | 1, days: readonly CalendarDay[]): ScheduleEvent {
 if (!Number.isSafeInteger(deltaCols)) throw Error('只能按整天移动事件。')
 if (slot !== 0 && slot !== 1) throw Error('目标时段无效，请选择上午或下午。')
 const candidate = { ...event, roleId: targetRoleId, slot: event.height === .5 ? slot : 0 as const }
 // A track-only move must preserve hidden endpoints exactly.
 if (deltaCols === 0) return placedEvent(project, candidate)
 const span = projectedSpan(event, days)
 if (!span) throw Error('此事件仅覆盖隐藏日期，请先显示这些日期或修改起止日期。')
 const start = Math.max(0, Math.min(days.length - span.count, span.start + deltaCols))
 if (start !== span.start) { candidate.startDate = days[start].date; candidate.endDate = days[start + span.count - 1].date }
 return placedEvent(project, candidate)
}
export function resizeScheduledEvent(project: ScheduleProject, event: ScheduleEvent, edge: 'start' | 'end', deltaCols: number, days: readonly CalendarDay[]): ScheduleEvent {
 if (!Number.isSafeInteger(deltaCols) || (edge !== 'start' && edge !== 'end')) throw Error('只能按整天调整事件边界。')
 const candidate = { ...event }, span = projectedSpan(event, days)
 if (!span) throw Error('此事件仅覆盖隐藏日期，请先显示这些日期或修改起止日期。')
 const end = span.start + span.count - 1
 if (edge === 'start') {
  const start = Math.max(0, Math.min(end, span.start + deltaCols))
  if (start !== span.start) candidate.startDate = days[start].date
 } else {
  const finish = Math.max(span.start, Math.min(days.length - 1, end + deltaCols))
  if (finish !== end) candidate.endDate = days[finish].date
 }
 return placedEvent(project, candidate)
}
