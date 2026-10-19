import type { NativeDocument } from '../../types'
import type { Appearance } from '../../shared/appearance'
import { base64ToBytes } from '../../shared/document'
import { createId } from '../../shared/id'
import { normalizePdfAuthor, pdfAuthorPreference } from '../author'
import type { OfficePdfEvent, OfficePdfFileAction, OfficePdfSnapshot } from './types'

interface OfficePdfHost {
  prepare(id: string, name: string, bytes: Uint8Array): string
  start(canvas: HTMLCanvasElement): Promise<void>
  activate(id: string): string
  inspect(id: string): string
  command(id: string, commandId: string, params: string): string
  exportFile(id: string, format: 'pdf'): Uint8Array
  flush(id: string): Promise<void>
  markSaved(id: string, documentId: number, revision: number): boolean
  discardChanges(id: string, documentId: number, revision: number): boolean
  close(id: string, documentId: number, revision: number, force: boolean): boolean
  drainDiscardedInput(): Promise<void>
  setActive(active: boolean): void
  setTheme(theme: Appearance): void
  destroy(): void
}
type Bindings = { default(options: { module_or_path: URL }): Promise<unknown>; createHost(callback: (event: string) => void): OfficePdfHost; inspectBytes(bytes: Uint8Array): string }
let runtime: Promise<OfficePdfHost> | undefined, host: OfficePdfHost | undefined
let inspectBytes: Bindings['inspectBytes'] | undefined
let canvas: HTMLCanvasElement | undefined, parking: HTMLElement | undefined, started: Promise<void> | undefined
let activeId: string | undefined, activation = 0, interactive = false, compositionId: string | undefined
let activationSessionId: string | undefined
let textAgent: HTMLInputElement | undefined, disableTimer: ReturnType<typeof setTimeout> | undefined
let queue: Promise<void> = Promise.resolve()
let interfaceTheme: Appearance = 'system'
const sessions = new Map<string, RustPdfSession>()
const fileActions = new Set<OfficePdfFileAction>(['new', 'open', 'save', 'saveAs', 'print', 'close'])
const pendingDecisionCommands = new Set(['ui.delete.confirm', 'ui.delete.cancel', 'ui.commentDraft.open', 'ui.commentDraft.submit', 'ui.commentDraft.discard', 'ui.commentDraft.return'])
/** These decisions resolve the very draft that prevents an ordinary flush. */
export function isPdfPendingDecisionCommand(command: string) { return pendingDecisionCommands.has(command) }

function serialize<T>(work: () => Promise<T> | T): Promise<T> {
  const result = queue.then(work)
  queue = result.then(() => undefined, () => undefined)
  return result
}
function snapshotOf(raw: string, sessionId: string): OfficePdfSnapshot {
  const value = JSON.parse(raw) as OfficePdfSnapshot
  if (value.sessionId !== sessionId || !Number.isSafeInteger(value.documentId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.dirty !== 'boolean' || !Array.isArray(value.pages) || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pages.length !== value.pageCount) throw Error('PDF 编辑器返回了无效的 PDF 文档状态。')
  return value
}
function applyAuthor(api: OfficePdfHost, id: string, author: string): OfficePdfSnapshot {
  const result = JSON.parse(api.command(id, 'ui.set', JSON.stringify({ key: 'author', value: author }))) as { ok: boolean; snapshot?: OfficePdfSnapshot; error?: string }
  if (!result.ok) throw Error(result.error || 'PDF 署名设置失败。')
  return snapshotOf(result.snapshot ? JSON.stringify(result.snapshot) : api.inspect(id), id)
}
function receive(raw: string) {
  try {
    const event = JSON.parse(raw) as { type: string; sessionId: string; snapshot?: OfficePdfSnapshot; action?: OfficePdfFileAction; message?: string; error?: string }
    const session = sessions.get(event.sessionId)
    if (!session) return
    if ((event.type === 'state' || event.type === 'change') && event.snapshot) session.accept(snapshotOf(JSON.stringify(event.snapshot), session.id))
    else if (event.type === 'action' && event.action && fileActions.has(event.action) && activeId === session.id && interactive) session.event({ type: 'file-action', sessionId: session.id, action: event.action })
    else if ((event.type === 'error' || event.type === 'status') && (event.message || event.error)) session.event({ type: event.type, sessionId: session.id, message: event.message || event.error! })
  } catch (cause) {
    const session = activeId ? sessions.get(activeId) : undefined
    session?.event({ type: 'error', sessionId: session.id, message: cause instanceof Error ? cause.message : String(cause) })
  }
}
async function loadHost(): Promise<OfficePdfHost> {
  const url = new URL('office-pdf/office_pdf.js', document.baseURI)
  const bindings = await import(/* @vite-ignore */ url.href) as Bindings
  await bindings.default({ module_or_path: new URL('office-pdf/office_pdf_bg.wasm', document.baseURI) })
  inspectBytes = bindings.inspectBytes
  host = bindings.createHost(receive)
  host.setTheme(interfaceTheme)
  return host
}
function getHost() { return runtime ??= loadHost().catch(cause => { runtime = undefined; throw cause }) }

/** Appearance changes never flush an editor draft or mutate a document. */
export function setRustPdfTheme(theme: Appearance): Promise<void> {
  interfaceTheme = theme
  return serialize(() => { host?.setTheme(interfaceTheme) })
}
function parkingElement() {
  if (!parking) {
    parking = document.createElement('div')
    parking.hidden = true
    parking.dataset.officePdfParking = ''
    document.body.append(parking)
  }
  return parking
}
function startComposition(event: Event) { if (event.target === textAgent && interactive && activeId) compositionId = activeId }
function syncTextAgentFocus(event: Event) {
  if (event.target !== textAgent || !canvas?.isConnected || !interactive || !activeId || !sessions.has(activeId)) return
  // eframe observes focus on the canvas but not its hidden input. During the
  // canvas-to-input transition its blur handler sees BODY, so the runner drops
  // keys until the next paint. Notify its existing focus observer after the
  // real input gained focus; do not move DOM focus or synthesize keyboard input.
  canvas.dispatchEvent(new FocusEvent('focus'))
}
function endComposition(event: Event) {
  if (event.target !== textAgent) return
  compositionId = undefined
  // eframe receives the final input event after compositionend in some browsers.
  // Let that event enter the queue before disabling further input.
  if (!interactive) disableTimer = setTimeout(() => { if (!interactive) host?.setActive(false) }, 0)
}
function newCanvas() {
  const element = document.createElement('canvas')
  element.id = 'open-office-pdf-canvas'
  element.dataset.testid = 'pdf-canvas'
  element.setAttribute('aria-label', 'PDF 页面与编辑工具')
  element.tabIndex = 0
  Object.assign(element.style, { display: 'block', width: '100%', height: '100%', outline: 'none' })
  return element
}

export class RustPdfSession {
  readonly id: string
  private closed = false
  private desiredInteractive = false
  private authorReady = false
  private listeners = new Set<(snapshot: OfficePdfSnapshot) => void>()
  private eventListeners = new Set<(event: OfficePdfEvent) => void>()
  constructor(public snapshot: OfficePdfSnapshot) { this.id = snapshot.sessionId }
  subscribe(listener: (snapshot: OfficePdfSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onEvent(listener: (event: OfficePdfEvent) => void) { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener) } }
  accept(snapshot: OfficePdfSnapshot) {
    // Renderer notifications run in a later microtask than synchronous commands and
    // exports. A delayed frame must not replace their newer revision receipt.
    if (this.closed || snapshot.documentId !== this.snapshot.documentId || snapshot.revision < this.snapshot.revision) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
  event(event: OfficePdfEvent) { if (!this.closed) for (const listener of this.eventListeners) listener(event) }
  private assertOpen() { if (this.closed || sessions.get(this.id) !== this) throw Error('此 PDF 文档已关闭。') }
  async attach(container: HTMLElement, enabled: boolean): Promise<void> {
    this.desiredInteractive = enabled
    const token = ++activation
    activationSessionId = this.id
    await serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      if (token !== activation || !container.isConnected) return
      await api.drainDiscardedInput()
      if (token !== activation || !container.isConnected) return
      if (activeId && activeId !== this.id) await sessions.get(activeId)?.flushInput(api)
      if (token !== activation || !container.isConnected) return
      canvas ??= newCanvas()
      container.append(canvas)
      if (textAgent) container.append(textAgent)
      started ??= api.start(canvas).catch(cause => { started = undefined; throw cause })
      await started
      if (!textAgent && canvas.nextElementSibling instanceof HTMLInputElement) {
        textAgent = canvas.nextElementSibling
        textAgent.dataset.testid = 'pdf-input'
        // eframe's 1px input needs a real content box. The shell's border-box
        // reset plus default input padding otherwise leaves zero content width;
        // Chromium then keeps committed text's DOM caret at the start.
        Object.assign(textAgent.style, { boxSizing: 'content-box', padding: '0', margin: '0' })
        textAgent.addEventListener('compositionstart', startComposition, true)
        textAgent.addEventListener('compositionend', endComposition, true)
        textAgent.addEventListener('focus', syncTextAgentFocus)
      }
      if (token !== activation || this.closed || !container.isConnected) return
      activeId = this.id
      // Starting the WASM renderer is asynchronous. The shell may finish its
      // open/save task while it starts, so apply the latest input state here.
      interactive = false
      this.authorReady = false
      api.setActive(false)
      this.accept(snapshotOf(api.activate(this.id), this.id))
      // Each document owns its Rust preferences. Apply the shared explicit identity
      // before accepting input, including when an already-open tab becomes active.
      this.accept(applyAuthor(api, this.id, pdfAuthorPreference.read()))
      this.authorReady = true
      interactive = this.desiredInteractive
      api.setActive(interactive)
      window.dispatchEvent(new Event('resize'))
    })
  }
  setInteractive(enabled: boolean) {
    this.desiredInteractive = enabled
    if (activeId !== this.id) return
    interactive = enabled && this.authorReady
    if (disableTimer) { clearTimeout(disableTimer); disableTimer = undefined }
    if (interactive || compositionId !== this.id) host?.setActive(interactive)
  }
  deactivate() {
    // An old tab can unmount while the next tab's attach is awaiting its turn.
    // Cancel only this session's own request, never the newer tab's activation.
    if (activationSessionId === this.id) { ++activation; activationSessionId = undefined }
    this.setInteractive(false)
    if (activeId !== this.id) return
    if (document.activeElement === textAgent || document.activeElement === canvas) (document.activeElement as HTMLElement).blur()
  }
  focus() { if (activeId === this.id && interactive) canvas?.focus({ preventScroll: true }) }
  private async flushInput(api: OfficePdfHost) {
    if (compositionId === this.id) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (compositionId === this.id) throw Error('请先确认输入法中的文字，再保存或切换 PDF 文档。')
    }
    await api.flush(this.id)
    this.assertOpen()
    this.accept(snapshotOf(api.inspect(this.id), this.id))
  }
  settled(): Promise<void> {
    return serialize(async () => { this.assertOpen(); const api = await getHost(); await this.flushInput(api) })
  }
  inspect(): Promise<OfficePdfSnapshot> {
    return serialize(async () => {
      this.assertOpen()
      this.accept(snapshotOf((await getHost()).inspect(this.id), this.id))
      return this.snapshot
    })
  }
  private backgroundExportReady(api: OfficePdfHost): boolean {
    this.accept(snapshotOf(api.inspect(this.id), this.id))
    return compositionId !== this.id && this.snapshot.backgroundExportReady === true
  }
  canBackgroundExport(): Promise<boolean> {
    return serialize(async () => {
      this.assertOpen()
      return this.backgroundExportReady(await getHost())
    })
  }
  command(commandId: string, params: Record<string, unknown> = {}, assertCurrent?: () => void): Promise<OfficePdfSnapshot> {
    return serialize(async () => {
      assertCurrent?.()
      this.assertOpen()
      const api = await getHost()
      assertCurrent?.()
      // Only explicit pending-input decisions may bypass the save barrier.
      if (!isPdfPendingDecisionCommand(commandId)) await this.flushInput(api)
      assertCurrent?.()
      const result = JSON.parse(api.command(this.id, commandId, JSON.stringify(params))) as { ok: boolean; snapshot?: OfficePdfSnapshot; error?: string }
      this.accept(snapshotOf(result.snapshot ? JSON.stringify(result.snapshot) : api.inspect(this.id), this.id))
      if (!result.ok) throw Error(result.error || 'PDF 文档操作失败。')
      return this.snapshot
    })
  }
  setAuthor(value: string): Promise<boolean> {
    const author = normalizePdfAuthor(value)
    return serialize(async () => {
      this.assertOpen()
      if (activeId !== this.id) throw Error('请先切换到此 PDF 文档，再设置署名。')
      const api = await getHost()
      // Preference changes neither commit pending annotation text nor change a
      // document's revision. Existing annotations retain their original author.
      this.accept(applyAuthor(api, this.id, author))
      return pdfAuthorPreference.save(author)
    })
  }
  query(commandId: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!['document.inspect', 'ui.state', 'ui.inspect', 'ui.commands'].includes(commandId)) return Promise.reject(Error('此查询不在只读检查范围内。'))
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      const result = JSON.parse(api.command(this.id, commandId, JSON.stringify(params))) as { ok: boolean; result?: unknown; error?: string }
      if (!result.ok) throw Error(result.error || 'PDF 文档查询失败。')
      return result.result
    })
  }
  export(format: 'pdf' = 'pdf', options: { background?: boolean } = {}): Promise<{ bytes: Uint8Array; snapshot: OfficePdfSnapshot }> {
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      if (options.background) {
        if (!this.backgroundExportReady(api)) throw Error('请先完成当前编辑，PDF 文档将稍后自动保存。')
      } else await this.flushInput(api)
      // Both calls are synchronous: no input or other task can run between the
      // exported bytes and their revision receipt.
      const bytes = api.exportFile(this.id, format)
      const snapshot = snapshotOf(api.inspect(this.id), this.id)
      if (!bytes.length) throw Error('PDF 文档导出失败。')
      this.accept(snapshot)
      return { bytes, snapshot }
    })
  }
  markSaved(documentId: number, revision: number, options: { background?: boolean } = {}): Promise<void> {
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      if (options.background) {
        if (!this.backgroundExportReady(api)) throw Error('PDF 文档正在编辑，稍后将保存新的修改。')
      } else await this.flushInput(api)
      if (!api.markSaved(this.id, documentId, revision)) throw Error('导出后 PDF 文档又有修改，请再次保存当前内容。')
      this.accept(snapshotOf(api.inspect(this.id), this.id))
    })
  }
  close(force = false): Promise<void> {
    return serialize(async () => {
      if (this.closed) return
      const api = await getHost()
      if (force) {
        if (activeId === this.id && textAgent) {
          // A confirmed discard must also release the browser's pending IME
          // state. eframe treats deleteByCut as clearing its input buffer, with
          // no synthetic text edit. Never clear another tab's text agent.
          const input = textAgent
          const clearInput = () => {
            input.value = ''
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }))
          }
          clearInput()
          input.blur()
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          // A browser can write its final composition value during blur. Clear
          // that DOM value too; the host barrier drains any already-queued text.
          clearInput()
        }
        this.accept(snapshotOf(api.inspect(this.id), this.id))
      } else await this.flushInput(api)
      if (!api.close(this.id, this.snapshot.documentId, this.snapshot.revision, force)) throw Error('PDF 文档仍有未保存修改，关闭已取消。')
      this.closed = true
      if (compositionId === this.id) compositionId = undefined
      sessions.delete(this.id)
      this.listeners.clear(); this.eventListeners.clear()
      const wasActive = activeId === this.id
      try {
        if (wasActive && force) await api.drainDiscardedInput()
      } finally {
        if (wasActive) {
          activeId = undefined; interactive = false
          if (activationSessionId === this.id) { ++activation; activationSessionId = undefined }
          api.setActive(false)
          if (canvas) parkingElement().append(canvas)
          if (textAgent) parkingElement().append(textAgent)
        }
        if (!sessions.size) {
          textAgent?.removeEventListener('compositionstart', startComposition, true)
          textAgent?.removeEventListener('compositionend', endComposition, true)
          textAgent?.removeEventListener('focus', syncTextAgentFocus)
          if (disableTimer) { clearTimeout(disableTimer); disableTimer = undefined }
          api.destroy(); textAgent = undefined; host = undefined; runtime = undefined; started = undefined; inspectBytes = undefined
          canvas?.remove(); canvas = undefined; parking?.remove(); parking = undefined
          compositionId = undefined
        }
      }
    })
  }
}

export function inspectOfficePdfSession(id: string): Promise<OfficePdfSnapshot> {
  const session = sessions.get(id)
  return session ? session.inspect() : Promise.reject(Error('此 PDF 文档尚未打开。'))
}
export function queryOfficePdfSession(id: string, commandId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const session = sessions.get(id)
  return session ? session.query(commandId, params) : Promise.reject(Error('此 PDF 文档尚未打开。'))
}
type Source = Pick<NativeDocument, 'id' | 'name' | 'base64' | 'extension'>
export interface PreparedRustPdfDocument {
  take(source: Pick<NativeDocument, 'id' | 'base64'>): RustPdfSession | undefined
  discard(): void
  readonly warnings: string[]
}
export async function prepareRustPdfDocument(source: Source): Promise<PreparedRustPdfDocument> {
  // A file dialog or reactive shell may replace its source while WASM loads.
  // The receipt must remain tied to the exact bytes that were prepared.
  source = { ...source }
  if (source.extension !== 'pdf') throw Error('此编辑器支持 PDF 文档。')
  if (source.base64.length > Math.ceil(40 * 1024 * 1024 / 3) * 4) throw Error('请选择不超过 40 MB 的 PDF 文档。')
  const bytes = base64ToBytes(source.base64)
  if (bytes.length > 40 * 1024 * 1024) throw Error('请选择不超过 40 MB 的 PDF 文档。')
  const session = await serialize(async () => {
    const api = await getHost(), id = `pdf-${createId()}`
    const next = new RustPdfSession(snapshotOf(api.prepare(id, source.name, bytes), id))
    sessions.set(id, next)
    return next
  })
  let pending: RustPdfSession | undefined = session
  const id = source.id, base64 = source.base64
  return {
    warnings: session.snapshot.warnings ?? [],
    take(candidate) {
      const value = pending; pending = undefined
      if (candidate.id === id && candidate.base64 === base64) return value
      void value?.close(true).catch(() => undefined)
      return undefined
    },
    discard() { const value = pending; pending = undefined; void value?.close(true).catch(() => undefined) },
  }
}

/** Read back exported PDF bytes with the local Rust parser, without touching tabs. */
export async function inspectPdfBytes(base64: string): Promise<{ pageCount: number; texts: string[] }> {
  if (base64.length > Math.ceil(40 * 1024 * 1024 / 3) * 4) throw Error('PDF 超过 40 MB 的检查范围。')
  const bytes = base64ToBytes(base64)
  return serialize(async () => {
    await getHost()
    if (!inspectBytes) throw Error('PDF 检查接口未能加载。')
    const result = JSON.parse(inspectBytes(bytes)) as { pageCount: number; texts: string[] }
    if (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1 || !Array.isArray(result.texts) || result.texts.length !== result.pageCount || result.texts.some(text => typeof text !== 'string')) throw Error('PDF 检查结果无效。')
    return result
  })
}
