import { createSchedule, decodeSchedule, encodeSchedule, scheduleId, validateSchedule, type ScheduleEvent, type ScheduleProject } from './model.ts'

let nextDocument = 0
export type ScheduleSnapshot = { documentId: number; revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean }
/** Each tab owns its model, history and exact export receipt. Failed edits are atomic. */
export class ScheduleSession {
 readonly documentId = ++nextDocument
 revision = 0
 private value: ScheduleProject
 private baseline: string
 private history: string[]
 private cursor = 0
 private receipt?: { revision: number; bytes: Uint8Array; content: string }
 constructor(bytes?: Uint8Array, title?: string) {
  this.value = bytes === undefined ? createSchedule(title) : decodeSchedule(bytes)
  this.baseline = JSON.stringify(this.value)
  this.history = [this.baseline]
 }
 get model(): ScheduleProject { return this.value }
 inspect(): ScheduleSnapshot { return { documentId: this.documentId, revision: this.revision, dirty: JSON.stringify(this.value) !== this.baseline, canUndo: this.cursor > 0, canRedo: this.cursor < this.history.length - 1 } }
 change(edit: (copy: ScheduleProject) => void): boolean {
  const copy = structuredClone(this.value), revision = this.revision
  edit(copy)
  if (revision !== this.revision) throw Error('编辑期间排期已有其他修改，请重试。')
  const value = validateSchedule(copy), json = JSON.stringify(value)
  if (json === JSON.stringify(this.value)) return false
  this.value = value; this.revision++
  this.history.splice(this.cursor + 1); this.history.push(json)
  let size = this.history.reduce((sum, item) => sum + item.length * 2, 0)
  while (this.history.length > 1 && (this.history.length > 100 || size > 16 * 1024 * 1024)) size -= this.history.shift()!.length * 2
  this.cursor = this.history.length - 1
  return true
 }
 /** Copy a live source into a new placement in one validated, undoable edit. */
 copyEvent(placement: ScheduleEvent): ScheduleEvent {
  const source = this.value.events.find(event => event.id === placement.id)
  if (!source) throw Error('原事件已被删除，无法复制。')
  const duplicate: ScheduleEvent = { ...source, id: scheduleId(), roleId: placement.roleId, startDate: placement.startDate, endDate: placement.endDate, slot: source.height === 1 ? 0 : placement.slot }
  this.change(copy => {
   copy.events.push(duplicate)
   const height = copy.layout?.trackHeights[`event-${source.id}`]
   if (height !== undefined) copy.layout!.trackHeights[`event-${duplicate.id}`] = height
  })
  return this.value.events.find(event => event.id === duplicate.id)!
 }
 undo(): boolean { if (!this.cursor) return false; this.value = JSON.parse(this.history[--this.cursor]); this.revision++; return true }
 redo(): boolean { if (this.cursor >= this.history.length - 1) return false; this.value = JSON.parse(this.history[++this.cursor]); this.revision++; return true }
 export(): { bytes: Uint8Array; snapshot: ScheduleSnapshot } {
  const bytes = encodeSchedule(this.value)
  this.receipt = { revision: this.revision, bytes: bytes.slice(), content: JSON.stringify(this.value) }
  return { bytes, snapshot: this.inspect() }
 }
 validateReceipt(bytes?: Uint8Array): void {
  const receipt = this.receipt
  if (!receipt || receipt.revision !== this.revision || receipt.content !== JSON.stringify(this.value) || (bytes && (receipt.bytes.length !== bytes.length || receipt.bytes.some((value, index) => value !== bytes[index])))) throw Error('导出后排期又有修改或保存回执不匹配，请保存当前内容。')
 }
 markSaved(bytes: Uint8Array): void { this.validateReceipt(bytes); this.baseline = JSON.stringify(this.value) }
}
