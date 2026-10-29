import { addDays, dayNumber, mondayOf, validateEventConflicts } from './calendar.ts'
import { SCHEDULE_TRACK_MAX_HEIGHT, SCHEDULE_TRACK_MIN_HEIGHT, SCHEDULE_TRACK_STEP, trackKeys } from './layout.ts'

export type ScheduleCalendarSettings = { hideWeekends: boolean; hideHolidays: boolean; extraHolidays: string[]; excludedHolidays: string[]; weekNumbering?: 'year' | 'project' }
export type ScheduleRole = { id: string; name: string; role: string; color: string }
/** Half-height events use slot 0 for morning and 1 for afternoon; full height always uses 0. */
export type ScheduleEvent = { id: string; roleId: string | null; title: string; startDate: string; endDate: string; height: 1 | 0.5; slot: 0 | 1; notes: string }
/** Dates include both endpoints. null roleId denotes the permanent overall-plan track. */
export type ScheduleProject = { format: 'open-office-schedule'; version: 1; id: string; title: string; startDate: string; endDate: string; dailyRate?: number; calendar: ScheduleCalendarSettings; roles: ScheduleRole[]; events: ScheduleEvent[]; layout?: { trackHeights: Record<string, number> } }
export const SCHEDULE_MAX_BYTES = 4 * 1024 * 1024
export const SCHEDULE_MAX_DAYS = 1096
export const SCHEDULE_MAX_ROLES = 100
export const SCHEDULE_MAX_EVENTS = 2000
/** Project-wide price in CNY per person-day; omission means no price was set. */
export const MAX_SCHEDULE_DAILY_RATE = 1_000_000
let sequence = 0
export function scheduleId(): string { return `s_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}_${(++sequence).toString(36)}`}` }
export function createSchedule(title = '项目排期'): ScheduleProject {
 const now = new Date(), today = `${now.getFullYear().toString().padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
 const startDate = mondayOf(today)
 return validateSchedule({ format: 'open-office-schedule', version: 1, id: scheduleId(), title, startDate, endDate: addDays(startDate, 60), calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [], events: [] })
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('排期文件结构不正确。'); return value as Record<string, unknown> }
function text(value: unknown, max: number, name: string, required = false): string {
 if (typeof value !== 'string' || value.length > max * 2 || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) throw Error(`${name}不能为空、包含无效文字或超过 ${max} 字。`)
 return value
}
function date(value: unknown): string { if (typeof value !== 'string') throw Error('排期日期必须为 YYYY-MM-DD。'); dayNumber(value); return value }
function list(value: unknown, max: number, name: string): unknown[] { if (!Array.isArray(value) || value.length > max) throw Error(`${name}数量不能超过 ${max}。`); return value }
export function validateSchedule(value: unknown): ScheduleProject {
 const root = object(value), ids = new Set<string>()
 const id = (raw: unknown): string => { if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw) || ids.has(raw)) throw Error('排期标识无效或重复。'); ids.add(raw); return raw }
 if (root.format !== 'open-office-schedule' || root.version !== 1) throw Error('此排期格式或版本暂不支持。请选择 .ooschedule 文件。')
 const startDate = date(root.startDate), endDate = date(root.endDate), duration = dayNumber(endDate) - dayNumber(startDate) + 1
 if (duration < 1 || duration > SCHEDULE_MAX_DAYS) throw Error('项目结束日期不能早于开始日期，且项目范围最多为 3 年（1096 天）。')
 const rawCalendar = object(root.calendar)
 if (typeof rawCalendar.hideWeekends !== 'boolean' || typeof rawCalendar.hideHolidays !== 'boolean') throw Error('排期日历隐藏设置无效。')
 if (rawCalendar.weekNumbering !== undefined && rawCalendar.weekNumbering !== 'year' && rawCalendar.weekNumbering !== 'project') throw Error('周编号模式无效，请选择按年或按项目。')
 const holidayList = (raw: unknown): string[] => {
  const dates = list(raw, SCHEDULE_MAX_DAYS, '自定义假日').map(date)
  if (new Set(dates).size !== dates.length) throw Error('自定义假日日期不能重复。')
  return dates
 }
 const extraHolidays = holidayList(rawCalendar.extraHolidays), excludedHolidays = holidayList(rawCalendar.excludedHolidays)
 if (extraHolidays.some(day => excludedHolidays.includes(day))) throw Error('同一天不能同时添加和排除为假日。')
 const result: ScheduleProject = { format: 'open-office-schedule', version: 1, id: id(root.id), title: text(root.title, 200, '项目名称', true), startDate, endDate, calendar: { hideWeekends: rawCalendar.hideWeekends, hideHolidays: rawCalendar.hideHolidays, extraHolidays, excludedHolidays }, roles: [], events: [] }
 if (root.dailyRate !== undefined) {
  if (typeof root.dailyRate !== 'number' || !Number.isFinite(root.dailyRate) || root.dailyRate < 0 || root.dailyRate > MAX_SCHEDULE_DAILY_RATE || Math.round(root.dailyRate * 100) / 100 !== root.dailyRate) throw Error('工时价格须为 0 至 1,000,000 元/人天，最多保留两位小数。')
  result.dailyRate = root.dailyRate === 0 ? 0 : root.dailyRate
 }
 if (rawCalendar.weekNumbering !== undefined) result.calendar.weekNumbering = rawCalendar.weekNumbering
 result.roles = list(root.roles, SCHEDULE_MAX_ROLES, '角色').map(raw => {
  const role = object(raw)
  if (typeof role.color !== 'string' || !/^#[\da-fA-F]{6}$/.test(role.color)) throw Error('角色颜色必须为 #RRGGBB。')
  return { id: id(role.id), name: text(role.name, 100, '角色名称', true), role: text(role.role, 100, '职能'), color: role.color }
 })
 const roleIds = new Set(result.roles.map(role => role.id))
 result.events = list(root.events, SCHEDULE_MAX_EVENTS, '事件').map(raw => {
  const event = object(raw), eventId = id(event.id), eventStart = date(event.startDate), eventEnd = date(event.endDate)
  if (event.roleId !== null && (typeof event.roleId !== 'string' || !roleIds.has(event.roleId))) throw Error('事件引用的角色不存在。')
  if (eventStart > eventEnd || eventStart < startDate || eventEnd > endDate) throw Error('事件起止日期无效或超出项目范围。')
  if (event.height !== 1 && event.height !== 0.5) throw Error('事件高度只支持整行或半行。')
  if ((event.slot !== 0 && event.slot !== 1) || (event.height === 1 && event.slot !== 0)) throw Error('事件时段无效；整行事件使用全天，半高事件只能选择上午或下午。')
  return { id: eventId, roleId: event.roleId as string | null, title: text(event.title, 200, '事件名称', true), startDate: eventStart, endDate: eventEnd, height: event.height, slot: event.slot, notes: text(event.notes, 20000, '事件备注') }
 })
 if (root.layout !== undefined) {
  const values = object(object(root.layout).trackHeights), keys = trackKeys(result), trackHeights: Record<string, number> = {}
  for (const [key, height] of Object.entries(values)) {
   if (!keys.has(key)) throw Error('轨道高度引用的人员或事件不存在。')
   if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < SCHEDULE_TRACK_MIN_HEIGHT || height > SCHEDULE_TRACK_MAX_HEIGHT || height % SCHEDULE_TRACK_STEP !== 0) throw Error(`轨道高度必须是 ${SCHEDULE_TRACK_STEP} 像素的整数倍，范围为 ${SCHEDULE_TRACK_MIN_HEIGHT} 至 ${SCHEDULE_TRACK_MAX_HEIGHT} 像素。`)
   trackHeights[key] = height
  }
  result.layout = { trackHeights }
 }
 validateEventConflicts(result)
 if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SCHEDULE_MAX_BYTES) throw Error('排期文件不能超过 4 MiB。')
 return result
}
export function decodeSchedule(bytes: Uint8Array): ScheduleProject {
 if (!bytes.byteLength || bytes.byteLength > SCHEDULE_MAX_BYTES) throw Error('排期文件为空或超过 4 MiB。')
 let value: unknown
 try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw Error('排期文件不是有效的 UTF-8 JSON。') }
 return validateSchedule(value)
}
export function encodeSchedule(project: ScheduleProject): Uint8Array { return new TextEncoder().encode(JSON.stringify(validateSchedule(project))) }
