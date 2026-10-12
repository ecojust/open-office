import type { OfficeEvent } from './types'

export const OFFICE_CHANNEL = 'open-office-engine'
export class OfficeBridge {
  readonly session = crypto.randomUUID()
  readonly hostUrl: string
  private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private disposed = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  readonly ready: Promise<void>
  private startupTimer: ReturnType<typeof setTimeout>

  constructor(private frame: HTMLIFrameElement, private onEvent: (event: OfficeEvent) => void, options: { smokeMode?: boolean } = {}) {
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
    if (this.disposed || event.origin !== location.origin || event.source !== this.frame.contentWindow) return
    const message = event.data as OfficeEvent
    if (!message || message.channel !== OFFICE_CHANNEL || message.session !== this.session) return
    if (message.requestId) {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.requestId)
      if (message.ok) pending.resolve(message.data)
      else pending.reject(Error(message.error || '办公引擎操作失败。'))
      return
    }
    if (message.event === 'engine-ready') { clearTimeout(this.startupTimer); this.readyResolve() }
    if (message.event === 'error') this.fail(Error(message.error || '办公引擎加载失败。'))
    this.onEvent(message)
  }
  async request<T = any>(action: string, data: unknown = {}, documentId?: string): Promise<T> {
    await this.ready
    if (this.disposed) throw Error('此编辑器已关闭。')
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('操作等待超时，文档仍保留在编辑器中。')) }, 120000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.frame.contentWindow?.postMessage({ channel: OFFICE_CHANNEL, session: this.session, requestId, action, documentId, data }, location.origin)
    })
  }
  private fail(error: Error) {
    clearTimeout(this.startupTimer); this.readyReject(error)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
  dispose() {
    this.disposed = true; window.removeEventListener('message', this.receive)
    this.fail(Error('编辑器已关闭，旧响应已丢弃。'))
  }
}
