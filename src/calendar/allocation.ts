import type { CalendarAllocationDisplay, CalendarBook, CalendarNote } from './model.ts'

const EPSILON = 1e-9
export type CalendarAllocation = { noteId: string; title: string; color: string; weight: number; percent: number; hours: number; start: number; end: number }
type AllocationContext = { before: CalendarBook; explicit: Map<string, string> }
const edits = new WeakMap<CalendarBook, AllocationContext>()
const workNotes = (book: CalendarBook, date: string) => book.notes.filter(note => note.date === date && note.type === '工作日')
const membership = (notes: readonly CalendarNote[]) => JSON.stringify(notes.map(note => note.id).sort())
function workGroups(book: CalendarBook): Map<string, CalendarNote[]> {
 const groups = new Map<string, CalendarNote[]>()
 for (const note of book.notes) {
  if (note.type !== '工作日') continue
  const group = groups.get(note.date)
  if (group) group.push(note); else groups.set(note.date, [note])
 }
 return groups
}

function weights(notes: readonly CalendarNote[]): number[] {
 if (!notes.length) return []
 const supplied = notes.filter(note => note.weight !== undefined)
 if (!supplied.length) return notes.map(() => 1 / notes.length)
 if (supplied.length !== notes.length || supplied.some(note => !Number.isFinite(note.weight) || note.weight! < 0 || note.weight! > 1) || Math.abs(supplied.reduce((total, note) => total + note.weight!, 0) - 1) > EPSILON) throw Error('同一天的工作事项须全部均分，或设置总和为 100% 的完整份额。')
 return supplied.map(note => note.weight!)
}
export function validateWorkdayAllocations(book: CalendarBook): void {
 const groups = new Map<string, CalendarNote[]>()
 for (const note of book.notes) {
  if (note.type !== '工作日') {
   if (Object.hasOwn(note, 'weight')) throw Error('非工作事项不能分配工时。')
   continue
  }
  const group = groups.get(note.date)
  if (group) group.push(note); else groups.set(note.date, [note])
 }
 for (const notes of groups.values()) weights(notes)
}
/** Stable document order is also the capsule's segment order. Zero shares stay
 * in the list so the editor can keep their controls keyboard-accessible. */
export function dayAllocations(book: CalendarBook, date: string): CalendarAllocation[] {
 const notes = workNotes(book, date), shares = weights(notes)
 let cursor = 0
 return notes.map((note, index) => {
  const weight = shares[index]!, start = cursor
  cursor += weight
  return { noteId: note.id, title: note.title, color: note.color, weight, percent: weight * 100, hours: weight * book.workdayHours, start, end: cursor }
 })
}
/** Explicit membership changes reset all work events on the affected dates. */
export function rebalanceWorkdays(book: CalendarBook, dates: Iterable<string>): void {
 const wanted = new Set(dates), groups = new Map<string, CalendarNote[]>()
 for (const date of wanted) edits.get(book)?.explicit.delete(date)
 for (const note of book.notes) {
  if (note.type !== '工作日' || !wanted.has(note.date)) continue
  const group = groups.get(note.date)
  if (group) group.push(note); else groups.set(note.date, [note])
 }
 for (const notes of groups.values()) for (const note of notes) note.weight = 1 / notes.length
}
/** Batched operations may use this after each membership change so an add
 * followed by a delete still resets the surviving events to equal shares. */
export function rebalanceDayAllocations(book: CalendarBook, date: string): void { rebalanceWorkdays(book, [date]) }
export function rebalanceChangedWorkdays(before: CalendarBook, after: CalendarBook): void {
 const previous = new Map(before.notes.map(note => [note.id, note]))
 const beforeGroups = workGroups(before), afterGroups = workGroups(after), days = new Set([...beforeGroups.keys(), ...afterGroups.keys()])
 const changed: string[] = [], context = edits.get(after)
 for (const date of days) {
  const current = membership(afterGroups.get(date) ?? [])
  if (membership(beforeGroups.get(date) ?? []) !== current && context?.explicit.get(date) !== current) changed.push(date)
 }
 rebalanceWorkdays(after, changed)
 for (const note of after.notes) if (note.type !== '工作日' && previous.get(note.id)?.type === '工作日') delete note.weight
}
/** Keep the last explicit allocation in a batch, unless a later operation
 * changes that day's membership again. Tracking is private to this draft. */
export function editWithAllocationTracking(before: CalendarBook, draft: CalendarBook, edit: () => void): void {
 edits.set(draft, { before, explicit: new Map() })
 try { edit(); rebalanceChangedWorkdays(before, draft) } finally { edits.delete(draft) }
}
export function setDayAllocation(book: CalendarBook, date: string, allocations: readonly { noteId: string; weight: number }[]): void {
 const notes = workNotes(book, date), byId = new Map(allocations.map(item => [item.noteId, item.weight]))
 if (!notes.length || allocations.length !== notes.length || byId.size !== notes.length || notes.some(note => !byId.has(note.id)) || allocations.some(item => !Number.isFinite(item.weight) || item.weight < 0 || item.weight > 1) || Math.abs(allocations.reduce((sum, item) => sum + item.weight, 0) - 1) > EPSILON) throw Error('请为当天每个工作事项设置唯一份额，总和必须为 100%。')
 for (const note of notes) note.weight = byId.get(note.id)!
 edits.get(book)?.explicit.set(date, membership(notes))
}
/** Set one event exactly, without the divider's snapping. The other events
 * retain their relative shares of the remaining day; a previously empty
 * remainder is shared equally. Validate before changing this draft. */
export function setNoteAllocation(book: CalendarBook, date: string, noteId: string, value: number, display: CalendarAllocationDisplay = book.allocationDisplay): void {
 if (!Number.isFinite(value) || (display !== 'percent' && display !== 'hours')) throw Error('请输入有效的工时数值和显示单位。')
 const scale = display === 'percent' ? 100 : book.workdayHours
 if (!Number.isFinite(scale) || scale <= 0 || value < 0 || value > scale) throw Error(`请输入 0 到 ${scale} ${display === 'percent' ? '%' : '小时'}之间的数值。`)
 const notes = workNotes(book, date), index = notes.findIndex(note => note.id === noteId)
 if (index < 0) throw Error('请选择当天已有的工作事项。')
 if (notes.length === 1 && value !== scale) throw Error('当天只有一项工作，须占满全天；添加其他工作事项后可调整。')
 const context = edits.get(book), current = membership(notes)
 const membershipChanged = !!context && context.explicit.get(date) !== current && membership(workNotes(context.before, date)) !== current
 const shares = membershipChanged ? notes.map(() => 1 / notes.length) : weights(notes)
 const currentValue = shares[index]! * scale
 // A displayed floating-point round trip must not dirty an unchanged book,
 // including legacy files that have no explicit weight properties yet.
 const unchanged = value === currentValue || (value > 0 && value < scale && Math.abs(value - currentValue) <= Number.EPSILON * Math.max(Math.abs(value), Math.abs(currentValue)) * 4)
 if (!membershipChanged && unchanged) return
 const target = value / scale, remaining = 1 - target
 const otherIndices = notes.map((_, position) => position).filter(position => position !== index)
 const otherTotal = otherIndices.reduce((sum, position) => sum + shares[position]!, 0)
 const remainderIndex = otherIndices.reduce((largest, position) => shares[position]! > shares[largest]! ? position : largest, otherIndices[0] ?? index)
 const allocated = notes.map(note => ({ noteId: note.id, weight: 0 }))
 allocated[index]!.weight = target
 let assigned = 0
 for (const position of otherIndices) {
  if (position === remainderIndex) continue
  const weight = remaining * (otherTotal > 0 ? shares[position]! / otherTotal : 1 / otherIndices.length)
  allocated[position]!.weight = weight; assigned += weight
 }
 if (otherIndices.length) allocated[remainderIndex]!.weight = remaining - assigned
 setDayAllocation(book, date, allocated)
}
/** position is the boundary measured from the beginning of the whole day, in
 * percentage points or hours. Snap globally, then clamp to the adjacent pair. */
export function resizeAllocationBoundary(book: CalendarBook, date: string, leftNoteId: string, position: number, display: CalendarAllocationDisplay = book.allocationDisplay): void {
 if (!Number.isFinite(position) || (display !== 'percent' && display !== 'hours')) throw Error('请输入有效的分隔线位置和显示单位。')
 const notes = workNotes(book, date), index = notes.findIndex(note => note.id === leftNoteId)
 if (index < 0 || index >= notes.length - 1) throw Error('请选择相邻两个工作事项之间的分隔线。')
 const context = edits.get(book), current = membership(notes)
 if (context && context.explicit.get(date) !== current && membership(workNotes(context.before, date)) !== current) rebalanceWorkdays(book, [date])
 const values = dayAllocations(book, date)
 const left = values[index]!, right = values[index + 1]!
 const scale = display === 'percent' ? 100 : book.workdayHours, step = display === 'percent' ? 10 : 0.5
 const snapped = Math.round(position / step) * step / scale
 const leftWeight = Math.min(left.weight + right.weight, Math.max(0, snapped - left.start))
 const allocated = values.map(item => ({ noteId: item.noteId, weight: item.weight }))
 allocated[index]!.weight = leftWeight
 allocated[index + 1]!.weight = left.weight + right.weight - leftWeight
 setDayAllocation(book, date, allocated)
}
