import { createCalendar, decodeCalendar, validateCalendar, type CalendarBook } from './model.ts'
import { editWithAllocationTracking } from './allocation.ts'

let nextDocument = 0
export type CalendarSnapshot = { documentId: number; revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean }
/** Owned models are immutable. Dirty/inspection reads can reuse the serialized
 * revision instead of serializing thousands of notes on every UI/autosave poll. */
function own(book: CalendarBook): CalendarBook {
 for (const note of book.notes) Object.freeze(note)
 for (const item of book.history) Object.freeze(item)
 Object.freeze(book.notes); Object.freeze(book.history)
 return Object.freeze(book)
}
export class CalendarSession {
 readonly documentId = ++nextDocument
 revision = 0
 private value: CalendarBook
 private content: string
 private baseline: string
 private history: string[]
 private cursor = 0
 private receipt?: { revision: number; bytes: Uint8Array; content: string }
 constructor(bytes?: Uint8Array, title?: string) {
  const value = bytes === undefined ? createCalendar(title) : decodeCalendar(bytes)
  this.value = own(title === undefined ? value : validateCalendar({ ...value, title }))
  this.content = JSON.stringify(this.value)
  this.baseline = this.content
  this.history = [this.content]
 }
 get model(): CalendarBook { return this.value }
 inspect(): CalendarSnapshot { return { documentId: this.documentId, revision: this.revision, dirty: this.content !== this.baseline, canUndo: this.cursor > 0, canRedo: this.cursor < this.history.length - 1 } }
 change(edit: (copy: CalendarBook) => void): boolean {
  const copy = structuredClone(this.value), revision = this.revision
  editWithAllocationTracking(this.value, copy, () => edit(copy))
  if (revision !== this.revision) throw Error('编辑期间日历本已有其他修改，请重试。')
  const value = validateCalendar(copy), content = JSON.stringify(value)
  if (content === this.content) return false
  this.value = own(value); this.content = content; this.revision++
  this.history.splice(this.cursor + 1); this.history.push(content)
  let size = this.history.reduce((total, entry) => total + entry.length * 2, 0)
  while (this.history.length > 1 && (this.history.length > 100 || size > 16 * 1024 * 1024)) size -= this.history.shift()!.length * 2
  this.cursor = this.history.length - 1
  return true
 }
 undo(): boolean {
  if (!this.cursor) return false
  this.content = this.history[--this.cursor]; this.value = own(JSON.parse(this.content)); this.revision++; return true
 }
 redo(): boolean {
  if (this.cursor >= this.history.length - 1) return false
  this.content = this.history[++this.cursor]; this.value = own(JSON.parse(this.content)); this.revision++; return true
 }
 export(): { bytes: Uint8Array; snapshot: CalendarSnapshot } {
  const bytes = new TextEncoder().encode(this.content)
  this.receipt = { revision: this.revision, bytes: bytes.slice(), content: this.content }
  return { bytes, snapshot: this.inspect() }
 }
 validateReceipt(bytes?: Uint8Array): void {
  const receipt = this.receipt
  if (!receipt || receipt.revision !== this.revision || receipt.content !== this.content || (bytes && (receipt.bytes.length !== bytes.length || receipt.bytes.some((value, index) => value !== bytes[index])))) throw Error('导出后日历本又有修改或保存回执不匹配，请保存当前内容。')
 }
 markSaved(bytes: Uint8Array): void { this.validateReceipt(bytes); this.baseline = this.content }
}
