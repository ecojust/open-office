import { dateNumber } from './calendar.ts'
import { validateWorkdayAllocations } from './allocation.ts'

export type CalendarNoteType = '工作日' | '非工作日'
export type CalendarAllocationDisplay = 'percent' | 'hours'
export type CalendarWeekMode = 'week' | 'work'
export type CalendarNote = { id: string; title: string; content: string; date: string; color: string; created_at: string; type: CalendarNoteType; weight?: number }
export type CalendarHistoryItem = { title: string; color: string; type: CalendarNoteType; lastUsedAt: string }
export type CalendarBook = { format: 'open-office-calendar'; version: 1; id: string; title: string; workdayHours: number; allocationDisplay: CalendarAllocationDisplay; weekMode: CalendarWeekMode; notes: CalendarNote[]; history: CalendarHistoryItem[] }
export const CALENDAR_MAX_BYTES = 8 * 1024 * 1024
export const CALENDAR_MAX_NOTES = 10000
export const CALENDAR_MAX_HISTORY = 100
export const CALENDAR_MAX_TITLE = 200
export const CALENDAR_MAX_CONTENT = 20000

let sequence = 0
export function calendarId(): string { return `c_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}_${(++sequence).toString(36)}`}` }
export function createCalendar(title = '日历便笺'): CalendarBook {
 return validateCalendar({ format: 'open-office-calendar', version: 1, id: calendarId(), title, notes: [], history: [] })
}
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('日历本文件结构不正确。')
 return value as Record<string, unknown>
}
function text(value: unknown, max: number, label: string, required = false): string {
 if (typeof value !== 'string' || value.length > max * 2 || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) throw Error(`${label}不能为空、包含无效文字或超过 ${max} 字。`)
 return required ? value.trim() : value
}
function color(value: unknown): string {
 if (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/.test(value)) throw Error('事项颜色必须为 #RRGGBB。')
 return value
}
function noteType(value: unknown): CalendarNoteType {
 if (value !== '工作日' && value !== '非工作日') throw Error('事项属性请选择需要上班或不需要上班。')
 return value
}
function timestamp(value: unknown): string {
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw Error('事项时间必须为包含毫秒的 UTC ISO 时间。')
 const parsed = new Date(value)
 if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw Error('事项时间无效。')
 dateNumber(value.slice(0, 10))
 return value
}
function list(value: unknown, max: number, label: string): unknown[] {
 if (!Array.isArray(value) || value.length > max) throw Error(`${label}数量不能超过 ${max}。`)
 return value
}
function historyItem(value: unknown): CalendarHistoryItem {
 const item = object(value)
 return { title: text(item.title, CALENDAR_MAX_TITLE, '历史事项名称', true), color: color(item.color), type: noteType(item.type), lastUsedAt: timestamp(item.lastUsedAt) }
}
/** Validate and copy the complete file before it can replace any live editing state. */
export function validateCalendar(value: unknown): CalendarBook {
 const root = object(value), ids = new Set<string>()
 if (root.format !== 'open-office-calendar' || root.version !== 1) throw Error('此日历本格式或版本暂不支持。请选择 .oocalendar 文件。')
 const id = (raw: unknown): string => {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw) || ids.has(raw)) throw Error('日历本或事项标识无效、重复。')
  ids.add(raw); return raw
 }
 const workdayHours = root.workdayHours === undefined ? 7 : root.workdayHours
 if (typeof workdayHours !== 'number' || !Number.isFinite(workdayHours) || workdayHours < 0.5 || workdayHours > 24 || !Number.isInteger(workdayHours * 2)) throw Error('每天工时应为 0.5—24 小时，按 0.5 小时递增。')
 const allocationDisplay = root.allocationDisplay === undefined ? 'percent' : root.allocationDisplay
 if (allocationDisplay !== 'percent' && allocationDisplay !== 'hours') throw Error('工时显示请选择百分比或小时。')
 const weekMode = root.weekMode === undefined ? 'week' : root.weekMode
 if (weekMode !== 'week' && weekMode !== 'work') throw Error('周视图请选择 Week 或 Work。')
 const result: CalendarBook = { format: 'open-office-calendar', version: 1, id: id(root.id), title: text(root.title, CALENDAR_MAX_TITLE, '日历本名称', true), workdayHours, allocationDisplay, weekMode, notes: [], history: [] }
 result.notes = list(root.notes, CALENDAR_MAX_NOTES, '事项').map(raw => {
  const note = object(raw)
  if (typeof note.date !== 'string') throw Error('事项日期必须为 YYYY-MM-DD。')
  dateNumber(note.date)
  if (Object.hasOwn(note, 'weight') && (typeof note.weight !== 'number' || !Number.isFinite(note.weight) || note.weight < 0 || note.weight > 1)) throw Error('工作事项份额应为 0—1。')
  return { id: id(note.id), title: text(note.title, CALENDAR_MAX_TITLE, '事项名称', true), content: text(note.content, CALENDAR_MAX_CONTENT, '事项内容'), date: note.date, color: color(note.color), created_at: timestamp(note.created_at), type: noteType(note.type), ...(Object.hasOwn(note, 'weight') ? { weight: note.weight as number } : {}) }
 })
 validateWorkdayAllocations(result)
 const titles = new Set<string>()
 result.history = list(root.history, CALENDAR_MAX_HISTORY, '历史事项').map(raw => {
  const item = historyItem(raw)
  if (titles.has(item.title)) throw Error('历史事项名称不能重复。')
  titles.add(item.title); return item
 })
 if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CALENDAR_MAX_BYTES) throw Error('日历本文件不能超过 8 MiB。')
 return result
}
export function decodeCalendar(bytes: Uint8Array): CalendarBook {
 if (!bytes.byteLength || bytes.byteLength > CALENDAR_MAX_BYTES) throw Error('日历本文件为空或超过 8 MiB。')
 let value: unknown
 try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw Error('日历本文件不是有效的 UTF-8 JSON。') }
 return validateCalendar(value)
}
export function encodeCalendar(book: CalendarBook): Uint8Array { return new TextEncoder().encode(JSON.stringify(validateCalendar(book))) }

/** Call within the same session.change as a successful add/edit. Content and
 * dates are deliberately excluded, so choosing a history item cannot reuse private text. */
export function rememberHistory(book: CalendarBook, note: Pick<CalendarNote, 'title' | 'color' | 'type'>, now = new Date().toISOString()): void {
 const item = historyItem({ title: note.title, color: note.color, type: note.type, lastUsedAt: now })
 book.history = [item, ...book.history.filter(previous => previous.title.trim() !== item.title)].slice(0, CALENDAR_MAX_HISTORY)
}
/** Persisted history keeps deleted notes available. Fill in unrecorded live
 * titles from every month, using the latest created note's attributes. */
export function historySuggestions(book: CalendarBook, query = ''): CalendarHistoryItem[] {
 const items = new Map(book.history.map(item => [item.title, { title: item.title, color: item.color, type: item.type, lastUsedAt: item.lastUsedAt }]))
 const missing = new Map<string, CalendarHistoryItem>()
 for (const note of book.notes) {
  if (items.has(note.title)) continue
  const previous = missing.get(note.title)
  if (!previous || note.created_at >= previous.lastUsedAt) missing.set(note.title, { title: note.title, color: note.color, type: note.type, lastUsedAt: note.created_at })
 }
 for (const item of [...missing.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))) items.set(item.title, item)
 const term = query.trim().toLowerCase()
 return [...items.values()].filter(item => !term || item.title.toLowerCase().includes(term)).slice(0, CALENDAR_MAX_HISTORY)
}
/** Materialize imported notes' reusable classifications before deleting them.
 * Call within the deletion's session.change to keep preservation undoable. */
export function preserveHistory(book: CalendarBook): void { book.history = historySuggestions(book) }
