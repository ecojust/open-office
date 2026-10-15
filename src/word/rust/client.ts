import { invoke, isTauri } from '@tauri-apps/api/core'
import type { NativeDocument } from '../../types'
import type { RustWordCommand, RustWordRequest, RustWordResponse, RustWordSnapshot } from './types'

let worker: Worker | undefined, requestId = 0, transportError: Error | undefined
const requests = new Map<number, { resolve(value: RustWordResponse): void; reject(cause: Error): void }>()
function browserRequest(request: RustWordRequest): Promise<RustWordResponse> {
  if (transportError) return Promise.reject(transportError)
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; response?: RustWordResponse; error?: string }>) => {
      const pending = requests.get(event.data.id)
      if (!pending) return
      requests.delete(event.data.id)
      if (event.data.response) pending.resolve(event.data.response)
      else pending.reject(Error(event.data.error || '文字编辑器未返回结果。'))
    }
    worker.onerror = event => {
      transportError = Error(event.message || '文字编辑器意外停止，请重新加载应用。')
      for (const pending of requests.values()) pending.reject(transportError)
      requests.clear(); worker?.terminate(); worker = undefined
    }
  }
  const id = ++requestId, url = new URL('word-engine/word_engine.wasm', document.baseURI).href
  return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker!.postMessage({ id, url, request }) })
}
async function request(value: RustWordRequest): Promise<RustWordResponse> {
  const result = isTauri() ? await invoke<RustWordResponse>('word_engine_request', { request: value }) : await browserRequest(value)
  if (!result || result.ok !== true) throw Error(result?.error || '文字文稿操作失败。')
  return result
}
function snapshotOf(response: RustWordResponse, sessionId: string): RustWordSnapshot {
  const snapshot = response.snapshot
  if (!snapshot || snapshot.sessionId !== sessionId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw Error('文字编辑器返回了无效的文稿状态。')
  return snapshot
}

/** All positions/history belong to Rust. Commands are evaluated against the
 * preceding acknowledged state, including rapid input before a paint update. */
export class RustWordSession {
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private listeners = new Set<(snapshot: RustWordSnapshot) => void>()
  constructor(public snapshot: RustWordSnapshot) {}
  subscribe(listener: (snapshot: RustWordSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(Error('此文稿已关闭。'))
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  private accept(response: RustWordResponse): RustWordSnapshot {
    this.snapshot = snapshotOf(response, this.snapshot.sessionId)
    for (const listener of this.listeners) listener(this.snapshot)
    return this.snapshot
  }
  command(command: RustWordCommand): Promise<RustWordSnapshot> {
    return this.enqueue(async () => this.accept(await request({ op: 'command', sessionId: this.snapshot.sessionId, expectedRevision: this.snapshot.revision, command })))
  }
  export(): Promise<{ base64: string; snapshot: RustWordSnapshot }> {
    return this.enqueue(async () => {
      const result = await request({ op: 'export', sessionId: this.snapshot.sessionId, expectedRevision: this.snapshot.revision })
      if (typeof result.base64 !== 'string') throw Error('文字文稿导出失败。')
      return { base64: result.base64, snapshot: this.accept(result) }
    })
  }
  async settled(): Promise<void> { await this.tail }
  close(): Promise<void> {
    if (this.closing) return this.tail
    this.closing = true; this.listeners.clear()
    this.tail = this.tail.then(async () => { await request({ op: 'close', sessionId: this.snapshot.sessionId }) })
    return this.tail
  }
}
type Source = Pick<NativeDocument, 'id' | 'base64' | 'extension'>
export interface PreparedRustWordDocument {
  take(source: Pick<NativeDocument, 'id' | 'base64'>): RustWordSession | undefined
  discard(): void
}
export async function prepareRustWordDocument(source: Source): Promise<PreparedRustWordDocument> {
  if (source.extension !== 'docx') throw Error('此文字编辑器目前支持 DOCX 文稿。')
  const sessionId = `word-${crypto.randomUUID()}`
  const response = await request(source.base64 ? { op: 'open', sessionId, base64: source.base64 } : { op: 'create', sessionId })
  let pending: RustWordSession | undefined = new RustWordSession(snapshotOf(response, sessionId))
  const id = source.id, base64 = source.base64
  return {
    take(candidate) {
      const value = pending; pending = undefined
      if (candidate.id === id && candidate.base64 === base64) return value
      void value?.close().catch(() => undefined)
      return undefined
    },
    discard() { const value = pending; pending = undefined; void value?.close().catch(() => undefined) },
  }
}
