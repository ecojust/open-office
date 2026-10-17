import { contentKey, DocumentHistory, MAX_FILE_BYTES, parseDocument, serializeDocument, validateDocument } from './core/documents.ts'
import { clone, type WorkflowDocument } from './core/types.ts'

let nextDocumentId = 0
export type WorkflowSnapshot = { documentId: number; revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean }

/** UTF-8 size inside a JSON string, including JSON's escaped lone surrogates. */
function stringBytes(value: string): number {
 if (/^[\x20-\x21\x23-\x5b\x5d-\x7f]*$/.test(value)) return value.length
 let size = 0
 for (let index = 0; index < value.length; index++) {
  const code = value.charCodeAt(index)
  if (code === 34 || code === 92) size += 2
  else if (code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
  else if (code < 128) size++
  else if (code < 2048) size += 2
  else if (code >= 0xd800 && code <= 0xdbff) {
   const next = value.charCodeAt(index + 1)
   if (next >= 0xdc00 && next <= 0xdfff) { size += 4; index++ } else size += 6
  } else size += code >= 0xdc00 && code <= 0xdfff ? 6 : 3
 }
 return size
}

/** Keep large strings out of the temporary JSON and cache their exact byte size.
 * Moving an image must not serialize its base64 payload just to check the limit. */
export function workflowByteLength(document: WorkflowDocument, cache = new Map<string, number>()): number {
 let payloadSize = 0
 const retained = new Map<string, number>()
 const envelope = JSON.stringify(document, (_key, value: unknown) => {
  if (typeof value !== 'string' || value.length < 4096) return value
  const size = cache.get(value) ?? stringBytes(value)
  retained.set(value, size); payloadSize += size
  return ''
 }, 2)
 cache.clear()
 for (const [value, size] of retained) cache.set(value, size)
 return payloadSize + new TextEncoder().encode(envelope).byteLength
}

/** Each tab owns its history and save receipt; a delayed save never clears newer edits. */
export class WorkflowSession {
 readonly documentId = ++nextDocumentId
 private value: WorkflowDocument
 private history: DocumentHistory
 private baseline: string
 private revision = 0
 private receipt?: { bytes: Uint8Array; key: string }
 private sizeCache = new Map<string, number>()

 constructor(document: WorkflowDocument) {
  this.value = validateDocument(document)
  this.checkSize(this.value)
  this.history = new DocumentHistory(this.value)
  this.baseline = contentKey(this.value)
 }
 get model(): WorkflowDocument { return this.value }
 inspect(): WorkflowSnapshot {
  return { documentId: this.documentId, revision: this.revision, dirty: contentKey(this.value) !== this.baseline, canUndo: this.history.canUndo, canRedo: this.history.canRedo }
 }
 change(edit: (document: WorkflowDocument) => void): boolean {
  const draft = clone(this.value)
  edit(draft)
  const document = validateDocument(draft)
  this.checkSize(document)
  if (contentKey(document) === contentKey(this.value)) return false
  document.updatedAt = new Date().toISOString()
  this.history.commit(document); this.value = document; this.revision++
  return true
 }
 private checkSize(document: WorkflowDocument): void {
  if (workflowByteLength(document, this.sizeCache) > MAX_FILE_BYTES) throw Error('文档超过 50 MB，请减少图片或拆分画布。当前修改未应用。')
 }
 undo(): boolean {
  const document = this.history.undo()
  if (!document) return false
  this.value = document; this.revision++; return true
 }
 redo(): boolean {
  const document = this.history.redo()
  if (!document) return false
  this.value = document; this.revision++; return true
 }
 export(): { bytes: Uint8Array; snapshot: WorkflowSnapshot } {
  const bytes = new TextEncoder().encode(serializeDocument(this.value))
  this.receipt = { bytes: bytes.slice(), key: contentKey(this.value) }
  return { bytes, snapshot: this.inspect() }
 }
 markSaved(bytes: Uint8Array): void {
  const receipt = this.receipt
  if (!receipt || bytes.length !== receipt.bytes.length || bytes.some((byte, index) => byte !== receipt.bytes[index])) throw Error('保存回执与当前文档不匹配，请重新保存。')
  // Validate the receipt without replacing the live document or undo history.
  if (contentKey(parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !== receipt.key) throw Error('保存回执内容不完整，请重新保存。')
  this.baseline = receipt.key
 }
}
