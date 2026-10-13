import type { OfficeEvent } from './types'
import { base64ToBytes, bytesToBase64 } from '../shared/document'

export const OFFICE_CHANNEL = 'open-office-engine'
export class OfficeBridge {
  readonly session = crypto.randomUUID()
  readonly hostUrl: string
  private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; binary: boolean }>()
  private disposed = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  readonly ready: Promise<void>
  private startupTimer: ReturnType<typeof setTimeout>

  constructor(private frame: HTMLIFrameElement | null, private onEvent: ((event: OfficeEvent) => void) | null, options: { smokeMode?: boolean } = {}) {
    const host = new URL('./office/host.html', document.baseURI)
    if (host.origin !== location.origin) throw Error('办公引擎必须与应用运行在同一本机来源。')
    if (options.smokeMode) host.searchParams.set('smoke', '1')
    host.hash = `session=${encodeURIComponent(this.session)}`
    this.hostUrl = host.href
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    // The caller can attach after the iframe has been assigned its source.
    void this.ready.catch(() => {})
    this.startupTimer = setTimeout(() => this.fail(Error('办公引擎启动超时。请检查本地资源是否完整，然后重试。')), 240000)
    window.addEventListener('message', this.receive)
  }
  private receive = (event: MessageEvent) => {
    if (this.disposed || event.origin !== location.origin || event.source !== this.frame?.contentWindow) return
    const message = event.data as OfficeEvent
    if (!message || message.channel !== OFFICE_CHANNEL || message.session !== this.session) return
    if (message.requestId) {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.requestId)
      if (message.ok) {
        try {
          if (pending.binary) {
            if (!(message.data?.buffer instanceof ArrayBuffer)) throw Error('办公引擎返回的文档数据无效。')
            const { buffer, ...metadata } = message.data
            pending.resolve({ ...metadata, base64: bytesToBase64(new Uint8Array(buffer)) })
          } else pending.resolve(message.data)
        } catch (error) { pending.reject(error instanceof Error ? error : Error(String(error))) }
      } else pending.reject(Error(message.error || '办公引擎操作失败。'))
      return
    }
    if (message.event === 'engine-ready') { clearTimeout(this.startupTimer); this.readyResolve() }
    if (message.event === 'error') this.fail(Error(message.error || '办公引擎加载失败。'))
    this.onEvent?.(message)
  }
  async request<T = any>(action: string, data: unknown = {}, documentId?: string): Promise<T> {
    await this.ready
    if (this.disposed || !this.frame) throw Error('此编辑器已关闭。')
    let payload = data
    const transfer: Transferable[] = []
    if ((action === 'open' || action === 'insert-image') && data && typeof data === 'object' && 'base64' in data) {
      if (typeof data.base64 !== 'string' || data.base64.length > 150000000) throw Error('文档数据无效或超过编辑器大小限制。')
      const bytes = base64ToBytes(data.base64)
      const { base64: _source, ...metadata } = data
      payload = { ...metadata, buffer: bytes.buffer }
      transfer.push(bytes.buffer as ArrayBuffer)
    } else if (action === 'export') payload = { ...(data as Record<string, unknown>), binary: true }
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('操作等待超时，文档仍保留在编辑器中。')) }, 120000)
      this.pending.set(requestId, { resolve, reject, timer, binary: action === 'export' })
      try {
        const target = this.frame?.contentWindow
        if (!target) throw Error('此编辑器已关闭。')
        target.postMessage({ channel: OFFICE_CHANNEL, session: this.session, requestId, action, documentId, data: payload }, location.origin, transfer)
      } catch (error) {
        clearTimeout(timer); this.pending.delete(requestId)
        reject(error instanceof Error ? error : Error(String(error)))
      }
    })
  }
  private fail(error: Error) {
    clearTimeout(this.startupTimer); this.readyReject(error)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; window.removeEventListener('message', this.receive)
    this.fail(Error('编辑器已关闭，旧响应已丢弃。'))
    const frame = this.frame
    this.frame = null; this.onEvent = null
    // Navigating away terminates the iframe's engine and workers. Drop our DOM
    // and component callback references as pending callers settle their errors.
    if (frame) frame.src = 'about:blank'
  }
}
