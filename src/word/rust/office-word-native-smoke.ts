import { isTauri } from '@tauri-apps/api/core'
import type { EditorHandle } from '../../shared/document'
import type { OfficeWordSnapshot } from './office-word-types'

export interface OfficeWordSmokeEditor extends EditorHandle {
  inspect(): Promise<OfficeWordSnapshot>
  command(id: string, params?: Record<string, unknown>): Promise<OfficeWordSnapshot>
}
export interface MountedOfficeWordSmokeEditor {
  key: string
  element: HTMLElement
  editor: OfficeWordSmokeEditor
}
export interface OfficeWordSmokeAdapter {
  open(base64: string, name: string): Promise<MountedOfficeWordSmokeEditor>
  activeKey(): string
  close(key: string): Promise<void>
}
export interface OfficeWordNativeSmokeReport {
  schemaVersion: 1
  kind: 'office-word-native'
  engine: 'office-word-wasm'
  transport: 'local-wasm-in-native-webview' | 'local-wasm-in-browser'
  ok: boolean
  checks: string[]
  limitations: string[]
  cleanup: { attempted: number; closed: number; ok: boolean; remainingCanvas: number; remainingInput: number }
  canvas?: { width: number; height: number; pageCount: number; paintCalls: number }
  domInput?: { eventType: 'input'; isTrusted: false; text: string; accepted: true }
  resources?: { wasmLoaded: true; sameOrigin: true; wasmPath: '/office-word/office-word_bg.wasm'; manifestSha256: string; sourceHash: string; upstreamCommit: string; files: Record<'office-word.js' | 'office-word_bg.wasm', { sha256: string; bytes: number }> }
  format?: { bold: boolean; italic: boolean; underline: boolean; size: number; color: string }
  failures?: { staleSaveRejected: boolean; invalidOpenRejected: boolean; preserved: boolean }
  text?: string
  reopenedText?: string
  docxBase64?: string
  reopenedDocxBase64?: string
  error?: string
  closeError?: string
}
const inputText = 'OfficeWord Native 中文😀'
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`OfficeWord native: ${message}`) }
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`OfficeWord native: ${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const frame = () => bounded(new Promise<void>(resolve => requestAnimationFrame(() => resolve())), 'animation frame')
function boundedEditor(editor: OfficeWordSmokeEditor): OfficeWordSmokeEditor {
  return new Proxy(editor, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? (...args: unknown[]) => bounded(Promise.resolve(Reflect.apply(value, target, args)), `editor ${String(key)}`) : value
  } })
}
async function eventually<T>(read: () => Promise<T>, valid: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20000
  do {
    const value = await read()
    if (valid(value)) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  } while (Date.now() < deadline)
  throw Error(`OfficeWord native: timed out waiting for ${label}`)
}
/** Observe real WebGL draw calls without changing their arguments or results. */
function observePaint() {
  let calls = 0
  const restore: Array<() => void> = []
  for (const constructor of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!constructor) continue
    const prototype = constructor.prototype as unknown as Record<string, unknown>
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      if (!descriptor || typeof descriptor.value !== 'function') continue
      const original = descriptor.value as (...args: unknown[]) => unknown
      Object.defineProperty(prototype, name, { ...descriptor, value: function (this: WebGLRenderingContext, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args)
        if (this.canvas instanceof HTMLCanvasElement && this.canvas.dataset.testid === 'office-word-canvas') calls++
        return result
      } })
      restore.push(() => Object.defineProperty(prototype, name, descriptor))
    }
  }
  return { calls: () => calls, restore: () => { for (const reset of restore.reverse()) reset() } }
}
async function focusCanvas(mounted: MountedOfficeWordSmokeEditor) {
  type CanvasUi = { pages?: number[][]; focused?: boolean }
  const state = await eventually(() => mounted.editor.inspect(), value => !!(value.ui as CanvasUi | undefined)?.pages?.length, 'Rust page layout')
  const canvas = mounted.element.querySelector<HTMLCanvasElement>('[data-testid="office-word-canvas"]')
  assert(canvas && canvas.width > 0 && canvas.height > 0, 'default editor has no visible drawing surface')
  const [x, y, width, height] = (state.ui as CanvasUi).pages![0]!
  const box = canvas.getBoundingClientRect()
  assert(box.width > 100 && box.height > 100, 'default canvas is hidden')
  const clientX = box.x + x! + width! * .7, clientY = box.y + Math.min(y! + Math.min(200, height! / 4), box.height - 50)
  assert(document.elementFromPoint(clientX, clientY) === canvas, 'document focus point is covered')
  canvas.focus({ preventScroll: true })
  const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX, clientY }
  canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 0 }))
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }))
  await frame()
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  await eventually(() => mounted.editor.inspect(), value => (value.ui as CanvasUi | undefined)?.focused === true, 'document canvas focus')
  return canvas
}

async function localResource(name: string, limit: number) {
  const url = new URL(`office-word/${name}`, document.baseURI)
  assert(url.origin === location.origin, 'OfficeWord resource URL is not local')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    assert(response.ok, `OfficeWord ${name} request failed (${response.status})`)
    const advertised = Number(response.headers.get('content-length'))
    assert(!advertised || advertised <= limit, `${name} exceeds the smoke resource bound`)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= limit, `${name} has an invalid resource size`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { bytes, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') }
  } finally { clearTimeout(timeout) }
}
async function verifyResources(): Promise<NonNullable<OfficeWordNativeSmokeReport['resources']>> {
  const manifest = await localResource('manifest.json', 65536)
  const metadata = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { engine?: string; sourceHash?: string; upstreamCommit?: string; files?: Record<string, string> }
  assert(metadata.engine === 'Open Office' && /^[a-f0-9]{64}$/.test(metadata.sourceHash || '') && /^[a-f0-9]{40}$/.test(metadata.upstreamCommit || ''), 'OfficeWord manifest metadata is invalid')
  const files = {} as NonNullable<OfficeWordNativeSmokeReport['resources']>['files']
  for (const name of ['office-word.js', 'office-word_bg.wasm'] as const) {
    const resource = await localResource(name, name.endsWith('.wasm') ? 256 * 1024 * 1024 : 4 * 1024 * 1024)
    assert(metadata.files?.[name] === resource.sha256, `OfficeWord ${name} does not match its packaged manifest`)
    files[name] = { sha256: resource.sha256, bytes: resource.bytes.byteLength }
  }
  return { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-word/office-word_bg.wasm', manifestSha256: manifest.sha256, sourceHash: metadata.sourceHash!, upstreamCommit: metadata.upstreamCommit!, files }
}

/** Installed-app entry point never accepts a browser or a replacement IPC bridge. */
export async function runOfficeWordNativeSmoke(adapter: OfficeWordSmokeAdapter): Promise<OfficeWordNativeSmokeReport> {
  assert(isTauri(), 'real native WebView is required')
  return verifyMountedOfficeWordEditor(adapter)
}

/** The same mounted-editor checks also run in Chromium; the report identifies
 * that transport explicitly, and native release gates must reject it. */
export async function verifyMountedOfficeWordEditor(adapter: OfficeWordSmokeAdapter): Promise<OfficeWordNativeSmokeReport> {
  const report: OfficeWordNativeSmokeReport = {
    schemaVersion: 1, kind: 'office-word-native', engine: 'office-word-wasm', transport: isTauri() ? 'local-wasm-in-native-webview' : 'local-wasm-in-browser', ok: false, checks: [],
    limitations: ['Synthetic WebView input events are not a physical operating-system IME.', 'Save checks cover exported DOCX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.'],
    cleanup: { attempted: 0, closed: 0, ok: true, remainingCanvas: 0, remainingInput: 0 },
  }
  const opened: MountedOfficeWordSmokeEditor[] = []
  const paint = observePaint()
  const passed = (name: string) => report.checks.push(name)
  async function open(base64: string, name: string) {
    const mounted = await bounded(adapter.open(base64, name), 'default editor ready', 120000)
    const value = { ...mounted, editor: boundedEditor(mounted.editor) }
    opened.push(value)
    return value
  }
  try {
    const first = await open('', 'OfficeWord native smoke.docx')
    assert(first.element.dataset.engine === 'office-word-wasm', 'the default editor is not OfficeWord')
    const canvas = await focusCanvas(first)
    await eventually(async () => paint.calls(), count => count > 0, 'actual WebGL drawing')
    let state = await first.editor.inspect()
    report.canvas = { width: canvas.width, height: canvas.height, pageCount: state.pages, paintCalls: paint.calls() }
    const assets = performance.getEntriesByType('resource').map(entry => new URL(entry.name, location.href)).filter(url => url.pathname.endsWith('/office-word/office-word_bg.wasm'))
    assert(assets.length > 0 && assets.every(url => url.origin === location.origin), 'local OfficeWord WASM request was not observed')
    report.resources = await verifyResources()
    passed('default-mounted-local-wasm-canvas-painted')
    const agent = first.element.querySelector<HTMLInputElement>('[data-testid="office-word-input"]')
    assert(agent && document.querySelectorAll('[data-testid="office-word-input"]').length === 1, 'exactly one native input agent is required')
    agent.focus({ preventScroll: true })
    // This intentionally traverses eframe's existing input listener. No engine
    // command inserts the required DOM-input token, and no listener is mocked.
    assert(agent.value === '', 'new input agent contains unexpected text')
    agent.value = inputText
    agent.setSelectionRange(inputText.length, inputText.length)
    const event = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inputText, isComposing: false })
    assert(event.isTrusted === false, 'diagnostic input must be labelled synthetic')
    agent.dispatchEvent(event)
    state = await eventually(() => first.editor.inspect(), value => value.text === inputText && value.dirty, 'DOM input in the real Rust document')
    report.domInput = { eventType: 'input', isTrusted: false, text: inputText, accepted: true }
    passed('synthetic-dom-input-chinese-emoji')
    await first.editor.command('select.text', { text: inputText })
    for (const id of ['format.bold', 'format.italic', 'format.underline']) await first.editor.command(id, { value: true })
    await first.editor.command('format.size', { size: 16 })
    state = await first.editor.command('format.color', { color: '336699' })
    const format = state.format as NonNullable<OfficeWordNativeSmokeReport['format']>
    assert(format.bold && format.italic && format.underline && format.size === 16 && format.color.toUpperCase().replace('#', '') === '336699', 'format commands did not reach the active document')
    report.format = { bold: format.bold, italic: format.italic, underline: format.underline, size: format.size, color: format.color.toUpperCase().replace('#', '') }
    passed('rust-character-formatting')
    const exported = await first.editor.exportFile({ format: 'docx' })
    assert(exported.extension === 'docx' && exported.base64.length < 1024 * 1024 && atob(exported.base64).startsWith('PK'), 'export is not a bounded DOCX package')
    assert((await first.editor.inspect()).dirty, 'export marked the document saved prematurely')
    report.docxBase64 = exported.base64; report.text = state.text
    await first.editor.markSaved?.(exported.base64)
    assert(!(await first.editor.inspect()).dirty, 'accepted save receipt did not clear editor dirty state')
    passed('docx-export-and-save-receipt')
    await first.editor.command('caret.docEnd')
    await first.editor.command('text.insert', { text: ' POST_SAVE' })
    const beforeFailure = await first.editor.inspect()
    let staleSaveRejected = false
    try { await first.editor.markSaved?.(exported.base64) } catch (cause) {
      staleSaveRejected = cause instanceof Error && cause.message === '导出后文稿又有修改，请再次保存当前内容。'
      if (!staleSaveRejected) throw cause
    }
    assert(staleSaveRejected, 'stale saved bytes cleared newer edits')
    let invalidOpenRejected = false
    try { await open(btoa('PK\u0003\u0004invalid-office-word-docx'), 'Invalid smoke.docx') } catch (cause) {
      // A stalled renderer is a failure, not evidence of parser rejection.
      if (cause instanceof Error && cause.message.includes('timed out')) throw cause
      invalidOpenRejected = true
    }
    const afterFailure = await first.editor.inspect()
    const preserved = adapter.activeKey() === first.key && afterFailure.documentId === beforeFailure.documentId && afterFailure.revision === beforeFailure.revision && afterFailure.text === beforeFailure.text && afterFailure.dirty
    assert(invalidOpenRejected && preserved, 'failed open or stale save changed the current document')
    report.failures = { staleSaveRejected, invalidOpenRejected, preserved }
    passed('stale-save-and-invalid-open-preserve-active-document')
    const reopened = await open(exported.base64, 'OfficeWord native reopen.docx')
    await focusCanvas(reopened)
    state = await reopened.editor.command('select.text', { text: inputText })
    const reopenedFormat = state.format as typeof format
    assert(state.text === inputText && !state.dirty, 'saved DOCX text or clean baseline changed on reopen')
    assert(reopenedFormat.bold && reopenedFormat.italic && reopenedFormat.underline && reopenedFormat.size === 16 && reopenedFormat.color.toUpperCase().replace('#', '') === '336699', 'DOCX reopen lost character formatting')
    report.reopenedText = state.text
    report.reopenedDocxBase64 = (await reopened.editor.exportFile({ format: 'docx' })).base64
    passed('saved-docx-reopened-in-default-editor')
    report.ok = true
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    for (const mounted of opened.reverse()) {
      report.cleanup.attempted++
      try { await bounded(adapter.close(mounted.key), 'session cleanup'); report.cleanup.closed++ }
      catch (cause) { report.cleanup.ok = false; report.ok = false; report.closeError = cause instanceof Error ? cause.message : String(cause) }
    }
    paint.restore()
    report.cleanup.remainingCanvas = document.querySelectorAll('[data-testid="office-word-canvas"]').length
    report.cleanup.remainingInput = document.querySelectorAll('[data-testid="office-word-input"]').length
    if (report.cleanup.remainingCanvas || report.cleanup.remainingInput) { report.ok = false; report.cleanup.ok = false; report.closeError ||= 'OfficeWord renderer or input agent remained after cleanup' }
  }
  return report
}
