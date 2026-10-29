import { buildCalendar, dayNumber } from './calendar.ts'
import type { HolidayYears } from './holidays.ts'
import { SCHEDULE_MAX_DAYS, type ScheduleProject } from './model.ts'

export type WorkloadBasis = 'project' | 'month'
export type MonthlyWorkloadCell = { scheduledDays: number; availableDays: number; percentage: number | null }
export type MonthlyWorkload = {
 /** Bounds describe the denominator's actual interval, inclusive at both ends. */
 months: { key: string; startDate: string; endDate: string; workingDays: number }[]
 people: { roleId: string; name: string; role: string; color: string; months: MonthlyWorkloadCell[] }[]
 team: MonthlyWorkloadCell[]
}

function percentage(scheduledDays: number, availableDays: number): MonthlyWorkloadCell {
 return { scheduledDays, availableDays, percentage: availableDays > 0 ? scheduledDays / availableDays * 100 : null }
}
function bound(dates: readonly string[], value: string, after: boolean): number {
 let low = 0, high = dates.length
 while (low < high) {
  const middle = (low + high) >>> 1
  if (dates[middle] < value || (after && dates[middle] === value)) low = middle + 1
  else high = middle
 }
 return low
}

/** Monthly person-days: display filters never change capacity or scheduled work. */
export function buildMonthlyWorkload(project: ScheduleProject, holidayYears: HolidayYears = {}, basis: WorkloadBasis = 'project'): MonthlyWorkload {
 if (basis !== 'project' && basis !== 'month') throw Error('工时统计口径无效，请选择项目范围或完整月份。')
 const duration = dayNumber(project.endDate) - dayNumber(project.startDate) + 1
 if (duration < 1 || duration > SCHEDULE_MAX_DAYS) throw Error('项目日期范围无效或超过 3 年。')
 const firstMonth = Number(project.startDate.slice(0, 4)) * 12 + Number(project.startDate.slice(5, 7)) - 1
 const lastMonth = Number(project.endDate.slice(0, 4)) * 12 + Number(project.endDate.slice(5, 7)) - 1
 const excluded = new Set(project.calendar.excludedHolidays)
 const workCalendar = { ...project.calendar, hideWeekends: true, hideHolidays: true,
  // Valid saved documents cannot contain both; retaining explicit exclusion
  // precedence also keeps calculation deterministic for intermediate callers.
  extraHolidays: project.calendar.extraHolidays.filter(date => !excluded.has(date)),
 }
 const months: MonthlyWorkload['months'] = [], scheduledDates: string[][] = []
 for (let index = firstMonth; index <= lastMonth; index++) {
  const year = Math.floor(index / 12), month = index % 12 + 1
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
  const monthStart = `${key}-01`, monthEnd = `${key}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`
  const startDate = basis === 'project' && project.startDate > monthStart ? project.startDate : monthStart
  const endDate = basis === 'project' && project.endDate < monthEnd ? project.endDate : monthEnd
  // Expand one month at a time: a maximum-length project can span portions of
  // 37 months whose full expansion exceeds the calendar's 1096-day limit.
  const days = buildCalendar({ ...project, startDate, endDate, calendar: workCalendar }, holidayYears).days.map(day => day.date)
  months.push({ key, startDate, endDate, workingDays: days.length })
  scheduledDates.push(days.filter(date => date >= project.startDate && date <= project.endDate))
 }
 const people = project.roles.map(role => ({ roleId: role.id, name: role.name, role: role.role, color: role.color,
  months: months.map(month => percentage(0, month.workingDays)),
 }))
 const peopleById = new Map(people.map(person => [person.roleId, person]))
 for (const event of project.events) {
  // Overall-plan blocks are summaries, not additional person-days, even when
  // their periods duplicate individual tasks or other overall-plan blocks.
  if (event.roleId === null) continue
  const person = peopleById.get(event.roleId)
  if (!person) continue
  for (let index = 0; index < months.length; index++) {
   const dates = scheduledDates[index]
   if (!dates.length || event.endDate < dates[0] || event.startDate > dates[dates.length - 1]) continue
   const count = Math.max(0, bound(dates, event.endDate, true) - bound(dates, event.startDate, false))
   person.months[index].scheduledDays += count * event.height
  }
 }
 for (const person of people) person.months = person.months.map(cell => percentage(cell.scheduledDays, cell.availableDays))
 const team = months.map((month, index) => percentage(people.reduce((sum, person) => sum + person.months[index].scheduledDays, 0), month.workingDays * people.length))
 return { months, people, team }
}
