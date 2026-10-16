import type { NativeDocument } from '../../types'
import type { Appearance } from '../../shared/appearance'
import { base64ToBytes } from '../../shared/document'
import { createId } from '../../shared/id'
import type { OfficeSheetEvent, OfficeSheetFileAction, OfficeSheetSnapshot } from './office-sheet-types'

interface OfficeSheetHost {
  prepare(id: string, name: string, bytes: Uint8Array): string
  start(canvas: HTMLCanvasElement): Promise<void>
  activate(id: string): string
  inspect(id: string): string
  command(id: string, commandId: string, params: string): string
  exportFile(id: string, format: 'xlsx' | 'csv' | 'tsv' | 'pdf'): Uint8Array
  flush(id: string): Promise<void>
  markSaved(id: string, documentId: number, revision: number): boolean
  discardChanges(id: string, documentId: number, revision: number): boolean
  close(id: string, documentId: number, revision: number, force: boolean): boolean
  setActive(active: boolean): void
  setTheme(theme: Appearance): void
  destroy(): void
}
type Bindings = { default(options: { module_or_path: URL }): Promise<unknown>; createHost(callback: (event: string) => void): OfficeSheetHost }
let runtime: Promise<OfficeSheetHost> | undefined, host: OfficeSheetHost | undefined
let canvas: HTMLCanvasElement | undefined, parking: HTMLElement | undefined, started: Promise<void> | undefined
let activeId: string | undefined, activation = 0, interactive = false, compositionId: string | undefined
let activationSessionId: string | undefined
let textAgent: HTMLInputElement | undefined, disableTimer: ReturnType<typeof setTimeout> | undefined
let queue: Promise<void> = Promise.resolve()
let interfaceTheme: Appearance = 'system'
const sessions = new Map<string, RustSheetSession>()
const fileActions = new Set<OfficeSheetFileAction>(['new', 'open', 'save', 'saveAs', 'exportPdf', 'print', 'close'])

function serialize<T>(work: () => Promise<T> | T): Promise<T> {
  const result = queue.then(work)
  queue = result.then(() => undefined, () => undefined)
  return result
}
function snapshotOf(raw: string, sessionId: string): OfficeSheetSnapshot {
  const value = JSON.parse(raw) as OfficeSheetSnapshot
  if (value.sessionId !== sessionId || !Number.isSafeInteger(value.documentId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.dirty !== 'boolean' || !Array.isArray(value.sheets)) throw Error('表格编辑器返回了无效的工作簿状态。')
  return value
}
function receive(raw: string) {
  try {
    const event = JSON.parse(raw) as { type: string; sessionId: string; snapshot?: OfficeSheetSnapshot; action?: OfficeSheetFileAction | 'pickFile'; purpose?: string; revision?: number; documentId?: number; selection?: unknown; message?: string; error?: string }
    const session = sessions.get(event.sessionId)
    if (!session) return
    if (event.type === 'change' && event.snapshot) session.accept(snapshotOf(JSON.stringify(event.snapshot), session.id))
    else if (event.type === 'action' && event.action === 'pickFile' && activeId === session.id && interactive) session.event({ type: 'pick-file', sessionId: session.id, purpose: event.purpose ?? '', documentId: event.documentId ?? session.snapshot.documentId, revision: event.revision ?? session.snapshot.revision, selection: event.selection ?? session.snapshot.selection })
    else if (event.type === 'action' && event.action && event.action !== 'pickFile' && fileActions.has(event.action) && activeId === session.id && interactive) session.event({ type: 'file-action', sessionId: session.id, action: event.action })
    else if ((event.type === 'error' || event.type === 'status') && (event.message || event.error)) session.event({ type: event.type, sessionId: session.id, message: event.message || event.error! })
  } catch (cause) {
    const session = activeId ? sessions.get(activeId) : undefined
    session?.event({ type: 'error', sessionId: session.id, message: cause instanceof Error ? cause.message : String(cause) })
  }
}
async function loadHost(): Promise<OfficeSheetHost> {
  const url = new URL('office-sheet/office-sheet.js', document.baseURI)
  const bindings = await import(/* @vite-ignore */ url.href) as Bindings
  await bindings.default({ module_or_path: new URL('office-sheet/office-sheet_bg.wasm', document.baseURI) })
  host = bindings.createHost(receive)
  host.setTheme(interfaceTheme)
  return host
}
function getHost() { return runtime ??= loadHost().catch(cause => { runtime = undefined; throw cause }) }

/** Appearance changes never flush an editor draft or mutate a workbook. */
export function setRustSheetTheme(theme: Appearance): Promise<void> {
  interfaceTheme = theme
  return serialize(() => { host?.setTheme(interfaceTheme) })
}
function parkingElement() {
  if (!parking) {
    parking = document.createElement('div')
    parking.hidden = true
    parking.dataset.sheetParking = ''
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
  element.id = 'open-office-office-sheet-canvas'
  element.dataset.testid = 'office-sheet-canvas'
  element.setAttribute('aria-label', '工作簿与功能区')
  element.tabIndex = 0
  Object.assign(element.style, { display: 'block', width: '100%', height: '100%', outline: 'none' })
  return element
}

export class RustSheetSession {
  readonly id: string
  private closed = false
  private desiredInteractive = false
  private listeners = new Set<(snapshot: OfficeSheetSnapshot) => void>()
  private eventListeners = new Set<(event: OfficeSheetEvent) => void>()
  constructor(public snapshot: OfficeSheetSnapshot) { this.id = snapshot.sessionId }
  subscribe(listener: (snapshot: OfficeSheetSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onEvent(listener: (event: OfficeSheetEvent) => void) { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener) } }
  accept(snapshot: OfficeSheetSnapshot) {
    // Renderer notifications run in a later microtask than synchronous commands and
    // exports. A delayed frame must not replace their newer revision receipt.
    if (this.closed || snapshot.documentId !== this.snapshot.documentId || snapshot.revision < this.snapshot.revision) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
  event(event: OfficeSheetEvent) { if (!this.closed) for (const listener of this.eventListeners) listener(event) }
  private assertOpen() { if (this.closed || sessions.get(this.id) !== this) throw Error('此工作簿已关闭。') }
  async attach(container: HTMLElement, enabled: boolean): Promise<void> {
    this.desiredInteractive = enabled
    const token = ++activation
    activationSessionId = this.id
    await serialize(async () => {
      this.assertOpen()
      const api = await getHost()
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
        textAgent.dataset.testid = 'office-sheet-input'
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
      interactive = this.desiredInteractive
      this.accept(snapshotOf(api.activate(this.id), this.id))
      api.setActive(interactive)
      window.dispatchEvent(new Event('resize'))
    })
  }
  setInteractive(enabled: boolean) {
    this.desiredInteractive = enabled
    if (activeId !== this.id) return
    interactive = enabled
    if (disableTimer) { clearTimeout(disableTimer); disableTimer = undefined }
    if (enabled || compositionId !== this.id) host?.setActive(enabled)
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
  private async flushInput(api: OfficeSheetHost) {
    if (compositionId === this.id) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (compositionId === this.id) throw Error('请先确认输入法中的文字，再保存或切换工作簿。')
    }
    await api.flush(this.id)
    this.assertOpen()
    this.accept(snapshotOf(api.inspect(this.id), this.id))
  }
  settled(): Promise<void> {
    return serialize(async () => { this.assertOpen(); const api = await getHost(); await this.flushInput(api) })
  }
  inspect(): Promise<OfficeSheetSnapshot> {
    return serialize(async () => {
      this.assertOpen()
      this.accept(snapshotOf((await getHost()).inspect(this.id), this.id))
      return this.snapshot
    })
  }
  private backgroundExportReady(api: OfficeSheetHost): boolean {
    this.accept(snapshotOf(api.inspect(this.id), this.id))
    return compositionId !== this.id && this.snapshot.backgroundExportReady === true
  }
  canBackgroundExport(): Promise<boolean> {
    return serialize(async () => {
      this.assertOpen()
      return this.backgroundExportReady(await getHost())
    })
  }
  command(commandId: string, params: Record<string, unknown> = {}, expected?: Pick<OfficeSheetSnapshot, 'documentId' | 'revision' | 'selection'>): Promise<OfficeSheetSnapshot> {
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      await this.flushInput(api)
      if (expected && (expected.documentId !== this.snapshot.documentId || expected.revision !== this.snapshot.revision || JSON.stringify(expected.selection) !== JSON.stringify(this.snapshot.selection))) throw Error('选择文件期间工作簿或选区已有变化，请重新选择插入位置。')
      const result = JSON.parse(api.command(this.id, commandId, JSON.stringify(params))) as { ok: boolean; snapshot?: OfficeSheetSnapshot; error?: string }
      this.accept(snapshotOf(result.snapshot ? JSON.stringify(result.snapshot) : api.inspect(this.id), this.id))
      if (!result.ok) throw Error(result.error || '工作簿操作失败。')
      return this.snapshot
    })
  }
  query(commandId: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!['cell.get', 'sheet.read', 'document.inspect'].includes(commandId)) return Promise.reject(Error('此查询不在只读检查范围内。'))
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      const result = JSON.parse(api.command(this.id, commandId, JSON.stringify(params))) as { ok: boolean; result?: unknown; error?: string }
      if (!result.ok) throw Error(result.error || '工作簿查询失败。')
      return result.result
    })
  }
  export(format: 'xlsx' | 'csv' | 'tsv' | 'pdf' = 'xlsx', options: { background?: boolean } = {}): Promise<{ bytes: Uint8Array; snapshot: OfficeSheetSnapshot }> {
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      if (options.background) {
        if (!this.backgroundExportReady(api)) throw Error('请先完成当前编辑，工作簿将稍后自动保存。')
      } else await this.flushInput(api)
      // Both calls are synchronous: no input or other task can run between the
      // exported bytes and their revision receipt.
      const bytes = api.exportFile(this.id, format)
      const snapshot = snapshotOf(api.inspect(this.id), this.id)
      if (!bytes.length) throw Error('工作簿导出失败。')
      this.accept(snapshot)
      return { bytes, snapshot }
    })
  }
  markSaved(documentId: number, revision: number, options: { background?: boolean } = {}): Promise<void> {
    return serialize(async () => {
      this.assertOpen()
      const api = await getHost()
      if (options.background) {
        if (!this.backgroundExportReady(api)) throw Error('工作簿正在编辑，稍后将保存新的修改。')
      } else await this.flushInput(api)
      if (!api.markSaved(this.id, documentId, revision)) throw Error('导出后工作簿又有修改，请再次保存当前内容。')
      this.accept(snapshotOf(api.inspect(this.id), this.id))
    })
  }
  close(force = false): Promise<void> {
    return serialize(async () => {
      if (this.closed) return
      const api = await getHost()
      if (force) this.accept(snapshotOf(api.inspect(this.id), this.id))
      else await this.flushInput(api)
      if (!api.close(this.id, this.snapshot.documentId, this.snapshot.revision, force)) throw Error('工作簿仍有未保存修改，关闭已取消。')
      this.closed = true
      sessions.delete(this.id)
      this.listeners.clear(); this.eventListeners.clear()
      if (activeId === this.id) {
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
        api.destroy(); textAgent = undefined; host = undefined; runtime = undefined; started = undefined
        canvas?.remove(); canvas = undefined; parking?.remove(); parking = undefined
        compositionId = undefined
      }
    })
  }
}

export function inspectOfficeSheetSession(id: string): Promise<OfficeSheetSnapshot> {
  const session = sessions.get(id)
  return session ? session.inspect() : Promise.reject(Error('此工作簿尚未打开。'))
}
export function queryOfficeSheetSession(id: string, commandId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const session = sessions.get(id)
  return session ? session.query(commandId, params) : Promise.reject(Error('此工作簿尚未打开。'))
}
type Source = Pick<NativeDocument, 'id' | 'name' | 'base64' | 'extension'>
export interface PreparedRustSheetDocument {
  take(source: Pick<NativeDocument, 'id' | 'base64'>): RustSheetSession | undefined
  discard(): void
  readonly warnings: string[]
}
export async function prepareRustSheetDocument(source: Source): Promise<PreparedRustSheetDocument> {
  if (!['xlsx', 'csv', 'tsv'].includes(source.extension)) throw Error('此表格编辑器支持 XLSX、CSV 与 TSV 工作簿。')
  if (source.base64.length > Math.ceil(40 * 1024 * 1024 / 3) * 4) throw Error('请选择不超过 40 MB 的工作簿。')
  const bytes = base64ToBytes(source.base64)
  if (bytes.length > 40 * 1024 * 1024) throw Error('请选择不超过 40 MB 的工作簿。')
  const session = await serialize(async () => {
    const api = await getHost(), id = `sheet-${createId()}`
    const next = new RustSheetSession(snapshotOf(api.prepare(id, source.name, bytes), id))
    sessions.set(id, next)
    return next
  })
  let pending: RustSheetSession | undefined = session
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
