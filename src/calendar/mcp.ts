import { calendarTools } from '../mcp/calendar-tools.ts'
import { tool, validateToolArguments } from '../mcp/tool-schema.ts'
import { dateNumber, monthSummary, validateMonth } from './calendar.ts'
import { calendarId, historySuggestions, preserveHistory, rememberHistory, validateCalendar, type CalendarBook, type CalendarNote, type CalendarNoteType } from './model.ts'
import type { CalendarSession } from './session.ts'

type NotePatch = Partial<Pick<CalendarNote, 'title' | 'content' | 'date' | 'color' | 'type'>>
export type CalendarEditOperation =
 | { op: 'book.title'; title: string }
 | { op: 'note.add'; note: Pick<CalendarNote, 'title' | 'date'> & NotePatch & { id?: string } }
 | { op: 'note.update'; noteId: string; patch: NotePatch }
 | { op: 'note.delete'; noteId: string }
 | { op: 'note.move'; noteId: string; date: string }
 | { op: 'note.copy'; noteId: string; id?: string; patch?: NotePatch }
 | { op: 'notes.clear_month'; month: string }
export type CalendarView = { month: string; selectedDate: string; selectedNoteId: string | null; search: string }
export type CalendarMcpHost = { session: CalendarSession; view: () => CalendarView; setView: (view: CalendarView) => void; changed: () => void }
export type CalendarReadOptions = { month?: string; from?: string; to?: string; query?: string; type?: CalendarNoteType; offset?: number; limit?: number; includeHistory?: boolean; includeSummary?: boolean }

const definitions = [
 ...calendarTools,
 tool('document_inspect', '', true), tool('document_undo', '', false), tool('document_redo', '', false),
]
function argumentsFor(name: string, raw: unknown): Record<string, unknown> {
 const definition = definitions.find(item => item.name === name)
 if (!definition) throw Error('当前日历本不支持此 MCP 工具。')
 return validateToolArguments(definition.inputSchema, raw)
}
function note(book: CalendarBook, id: string): CalendarNote {
 const found = book.notes.find(item => item.id === id)
 if (!found) throw Error(`事项不存在：${id}`)
 return found
}

/** Apply only to a detached CalendarSession.change draft. The session validates
 * the whole result before committing, so edits and history share one undo step. */
export function editCalendar(book: CalendarBook, operations: readonly CalendarEditOperation[]) {
 const checked = argumentsFor('calendar_edit', { operations }).operations as CalendarEditOperation[]
 const created: { type: 'note'; id: string }[] = [], now = new Date().toISOString()
 for (const operation of checked) {
  switch (operation.op) {
   case 'book.title': book.title = operation.title; break
   case 'note.add': {
    const value: CalendarNote = { id: calendarId(), content: '', color: '#4376d4', type: '工作日', created_at: now, ...operation.note }
    dateNumber(value.date)
    book.notes.push(value); rememberHistory(book, value, now); created.push({ type: 'note', id: value.id }); break
   }
   case 'note.update': {
    const target = note(book, operation.noteId)
    if (operation.patch.date !== undefined) dateNumber(operation.patch.date)
    Object.assign(target, operation.patch); rememberHistory(book, target, now); break
   }
   case 'note.delete': {
    note(book, operation.noteId); preserveHistory(book)
    book.notes = book.notes.filter(item => item.id !== operation.noteId); break
   }
   case 'note.move': dateNumber(operation.date); note(book, operation.noteId).date = operation.date; break
   case 'note.copy': {
    const value = { ...note(book, operation.noteId), ...operation.patch, id: operation.id ?? calendarId(), created_at: now }
    dateNumber(value.date)
    book.notes.push(value); rememberHistory(book, value, now); created.push({ type: 'note', id: value.id }); break
   }
   case 'notes.clear_month': {
    validateMonth(operation.month)
    if (book.notes.some(item => item.date.startsWith(`${operation.month}-`))) {
     preserveHistory(book)
     book.notes = book.notes.filter(item => !item.date.startsWith(`${operation.month}-`))
    }
    break
   }
  }
 }
 return { created }
}

/** Read an immutable session model without changing its history or save receipt. */
export function readCalendar(book: CalendarBook, raw: CalendarReadOptions = {}) {
 const options = argumentsFor('calendar_read', raw) as CalendarReadOptions
 if (options.month !== undefined) validateMonth(options.month)
 if (options.from !== undefined) dateNumber(options.from)
 if (options.to !== undefined) dateNumber(options.to)
 if (options.from !== undefined && options.to !== undefined && options.from > options.to) throw Error('起始日期不能晚于结束日期。')
 const query = (options.query ?? '').trim().toLowerCase(), offset = options.offset ?? 0, limit = options.limit ?? 200
 const matches = book.notes.filter(item =>
  (options.month === undefined || item.date.startsWith(`${options.month}-`)) &&
  (options.from === undefined || item.date >= options.from) && (options.to === undefined || item.date <= options.to) &&
  (options.type === undefined || item.type === options.type) && (!query || item.title.toLowerCase().includes(query) || item.content.toLowerCase().includes(query)),
 ).sort((a, b) => compare(a.date, b.date) || compare(a.created_at, b.created_at) || compare(a.id, b.id))
 const hasMore = offset + limit < matches.length
 return {
  book: { format: book.format, version: book.version, id: book.id, title: book.title },
  notes: matches.slice(offset, offset + limit).map(item => ({ ...item })), total: matches.length, offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null,
  ...(options.includeHistory === false ? {} : { history: historySuggestions(book) }),
  ...(options.month === undefined || options.includeSummary === false ? {} : { summary: monthSummary(book, options.month) }),
 }
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

/** Validate all selectors together before any visible selection is changed. */
export function validateCalendarView(book: CalendarBook, current: CalendarView, raw: Partial<CalendarView>): CalendarView {
 const patch = argumentsFor('calendar_set_view', raw) as Partial<CalendarView>
 if (patch.month !== undefined) validateMonth(patch.month)
 if (patch.selectedDate !== undefined) dateNumber(patch.selectedDate)
 const next = { ...current, ...patch }
 if (patch.selectedNoteId !== undefined && patch.selectedNoteId !== null) {
  const selected = note(book, patch.selectedNoteId)
  if ((patch.selectedDate !== undefined && patch.selectedDate !== selected.date) || (patch.month !== undefined && patch.month !== selected.date.slice(0, 7))) throw Error('选中事项、日期和月份必须一致。')
  next.selectedDate = selected.date; next.month = selected.date.slice(0, 7)
 } else if (patch.selectedDate !== undefined) {
  if (patch.month !== undefined && patch.month !== patch.selectedDate.slice(0, 7)) throw Error('选中日期必须属于指定月份。')
  next.month = patch.selectedDate.slice(0, 7)
 } else if (patch.month !== undefined && !next.selectedDate.startsWith(`${patch.month}-`)) next.selectedDate = `${patch.month}-01`
 if (next.selectedNoteId !== null && !book.notes.some(item => item.id === next.selectedNoteId && item.date === next.selectedDate)) next.selectedNoteId = null
 return next
}

/** The editor owns busy/dialog checks. Every state mutation has a fresh guard;
 * callers can bind it to active document/generation without mounting the UI. */
export function executeCalendarTool(host: CalendarMcpHost, name: string, raw: unknown, guard: () => void): unknown {
 guard()
 const args = argumentsFor(name, raw), session = host.session
 if (name === 'document_inspect') return { ...session.inspect(), book: structuredClone(session.model), view: { ...host.view() } }
 if (name === 'calendar_read') return { ...readCalendar(session.model, args), state: session.inspect(), view: { ...host.view() } }
 if (name === 'calendar_export') return { format: 'json', mimeType: 'application/json', book: validateCalendar(session.model) }
 if (name === 'calendar_set_view') {
  const next = validateCalendarView(session.model, host.view(), args)
  guard(); host.setView(next)
  return { ...session.inspect(), view: { ...host.view() } }
 }
 let result: { created?: { type: 'note'; id: string }[] } = {}, changed = false
 if (name === 'calendar_edit') {
  guard(); changed = session.change(copy => { result = editCalendar(copy, args.operations as CalendarEditOperation[]) })
 } else if (name === 'document_undo') { guard(); changed = session.undo() }
 else if (name === 'document_redo') { guard(); changed = session.redo() }
 if (changed) host.changed()
 return { ...session.inspect(), view: { ...host.view() }, ...result }
}
