import type { CalendarBook } from './model.ts'

const DAY = 86_400_000
export type CalendarDay = { date: string | null; day: number; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; inMonth: boolean; isToday: boolean }
export type CalendarMonthSummary = { title: string; color: string; days: number; percent: number }

/** Civil date arithmetic uses UTC, never local midnight or a DST-sensitive duration. */
export function dateNumber(value: string): number {
 const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
 if (!match) throw Error('日期必须为 YYYY-MM-DD。')
 const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
 const time = Date.UTC(year, month - 1, day), parsed = new Date(time)
 if (year < 1900 || year > 9999 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw Error(`无效日期“${value}”。`)
 return time / DAY
}
export function validateMonth(month: string): string {
 if (!/^\d{4}-\d{2}$/.test(month)) throw Error('月份必须为 YYYY-MM。')
 dateNumber(`${month}-01`)
 return month
}
export function todayDate(now = new Date()): string {
 if (!Number.isFinite(now.getTime())) throw Error('当前日期无效。')
 const result = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
 dateNumber(result)
 return result
}
export function shiftMonth(month: string, delta: number): string {
 validateMonth(month)
 if (!Number.isSafeInteger(delta)) throw Error('只能按整月切换日期。')
 const serial = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta
 if (!Number.isSafeInteger(serial) || serial < 1900 * 12 || serial >= 10000 * 12) throw Error('月份超出支持范围（1900—9999 年）。')
 return `${String(Math.floor(serial / 12)).padStart(4, '0')}-${String(serial % 12 + 1).padStart(2, '0')}`
}
/** Always six Monday-first rows. Unsupported spillover dates remain inert cells. */
export function monthDays(month: string, today = todayDate()): CalendarDay[] {
 validateMonth(month); dateNumber(today)
 const first = dateNumber(`${month}-01`), weekday = (new Date(first * DAY).getUTCDay() + 6) % 7
 return Array.from({ length: 42 }, (_, index) => {
  const instant = new Date((first - weekday + index) * DAY), year = instant.getUTCFullYear()
  const date = year >= 1900 && year <= 9999 ? instant.toISOString().slice(0, 10) : null
  return { date, day: date === null ? 0 : instant.getUTCDate(), weekday: index % 7 as CalendarDay['weekday'], inMonth: date?.startsWith(`${month}-`) ?? false, isToday: date === today }
 })
}
/** Match CalendarNote: a date containing work notes contributes one day, shared
 * evenly by its work notes. Non-work notes and other months do not enter the denominator. */
export function monthSummary(book: CalendarBook, month: string): CalendarMonthSummary[] {
 validateMonth(month)
 const dates = new Map<string, typeof book.notes>()
 for (const note of book.notes) {
  if (note.type !== '工作日' || !note.date.startsWith(`${month}-`)) continue
  const notes = dates.get(note.date)
  if (notes) notes.push(note)
  else dates.set(note.date, [note])
 }
 const totals = new Map<string, { title: string; color: string; days: number; latest: string }>()
 for (const notes of dates.values()) {
  const weight = 1 / notes.length
  for (const note of notes) {
   const current = totals.get(note.title)
   if (current) {
    current.days += weight
    if (note.created_at >= current.latest) { current.color = note.color; current.latest = note.created_at }
   } else totals.set(note.title, { title: note.title, color: note.color, days: weight, latest: note.created_at })
  }
 }
 return [...totals.values()].sort((a, b) => b.days - a.days || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  .map(({ title, color, days }) => ({ title, color, days, percent: days / dates.size * 100 }))
}
