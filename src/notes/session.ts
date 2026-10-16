import { createNotebook, decodeNotebook, encodeNotebook, validateNotebook, type Notebook } from './model.ts'
let nextDocument = 0
export type NoteSnapshot = { documentId: number; revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean }
/** Saving never mutates the model/history. Only the exact exported revision can be acknowledged. */
export class NotebookSession {
 readonly documentId = ++nextDocument
 revision = 0
 private value: Notebook
 private baseline: string
 private history: string[]
 private cursor = 0
 private receipt?: { revision: number; bytes: Uint8Array }
 constructor(bytes?: Uint8Array, title?: string) {
  this.value = bytes?.length ? decodeNotebook(bytes) : createNotebook(title)
  this.baseline = JSON.stringify(this.value)
  this.history = [this.baseline]
 }
 get model(): Notebook { return this.value }
 inspect(): NoteSnapshot { return { documentId: this.documentId, revision: this.revision, dirty: JSON.stringify(this.value) !== this.baseline, canUndo: this.cursor > 0, canRedo: this.cursor < this.history.length - 1 } }
 change(edit: (copy: Notebook) => void): boolean {
  const copy = structuredClone(this.value)
  edit(copy)
  const value = validateNotebook(copy), json = JSON.stringify(value)
  if (json === JSON.stringify(this.value)) return false
  this.value = value; this.revision++
  this.history.splice(this.cursor + 1)
  this.history.push(json)
  // Cap retained snapshots by both count and approximate UTF-16 memory.
  let size = this.history.reduce((sum, item) => sum + item.length * 2, 0)
  while (this.history.length > 1 && (this.history.length > 100 || size > 32 * 1024 * 1024)) size -= this.history.shift()!.length * 2
  this.cursor = this.history.length - 1
  return true
 }
 undo(): boolean { if (!this.cursor) return false; this.value = JSON.parse(this.history[--this.cursor]); this.revision++; return true }
 redo(): boolean { if (this.cursor >= this.history.length - 1) return false; this.value = JSON.parse(this.history[++this.cursor]); this.revision++; return true }
 export(): { bytes: Uint8Array; snapshot: NoteSnapshot } {
  const bytes = encodeNotebook(this.value)
  this.receipt = { revision: this.revision, bytes: bytes.slice() }
  return { bytes, snapshot: this.inspect() }
 }
 validateReceipt(bytes?: Uint8Array): void {
  const receipt = this.receipt
  if (!receipt || receipt.revision !== this.revision || (bytes && (receipt.bytes.length !== bytes.length || receipt.bytes.some((value, index) => value !== bytes[index])))) throw Error('导出后笔记又有修改，请保存当前内容。')
 }
 markSaved(bytes: Uint8Array): void { this.validateReceipt(bytes); this.baseline = JSON.stringify(this.value) }
}
