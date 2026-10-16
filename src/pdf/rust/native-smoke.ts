import { isTauri } from '@tauri-apps/api/core'
import type { EditorHandle } from '../../shared/document'
import { inspectPdfBytes } from './client'
import type { OfficePdfSnapshot } from './types'

export interface OfficePdfSmokeEditor extends EditorHandle {
  inspect(): Promise<OfficePdfSnapshot>
  command(id: string, params?: Record<string, unknown>): Promise<OfficePdfSnapshot>
  query(id: string, params?: Record<string, unknown>): Promise<unknown>
}
export interface MountedOfficePdfSmokeEditor { key: string; element: HTMLElement; editor: OfficePdfSmokeEditor }
export interface OfficePdfSmokeAdapter {
  open(base64: string, name: string): Promise<MountedOfficePdfSmokeEditor>
  activeKey(): string
  close(key: string): Promise<void>
  verifyMounted?(): Promise<void>
}
export interface OfficePdfNativeSmokeReport {
  schemaVersion: 1
  kind: 'pdf-native'
  engine: 'office-pdf-wasm'
  transport: 'local-wasm-in-native-webview' | 'local-wasm-in-browser'
  ok: boolean
  checks: string[]
  limitations: string[]
  cleanup: { attempted: number; closed: number; ok: boolean; remainingCanvas: number; remainingInput: number }
  canvas?: { width: number; height: number; pageCount: number; paintCalls: number }
  resources?: { wasmLoaded: true; sameOrigin: true; wasmPath: '/office-pdf/office_pdf_bg.wasm'; manifestSha256: string; sourceHash: string; upstreamCommit: string; files: Record<'office_pdf.js' | 'office_pdf_bg.wasm', { sha256: string; bytes: number }> }
  reopened?: true
  removedOldText?: boolean
  newTextPresent?: boolean
  text?: string
  metadata?: { pageCount: number }
  undoRedo?: { undo: true; redo: true }
  failures?: { staleSaveRejected: boolean; invalidOpenRejected: boolean; preserved: boolean }
  pdfBase64?: string
  reopenedPdfBase64?: string
  error?: string
  closeError?: string
}
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`PDF native: ${message}`) }
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`PDF native: ${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function eventually<T>(read: () => Promise<T>, valid: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30000
  do {
    const value = await read()
    if (valid(value)) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  } while (Date.now() < deadline)
  throw Error(`PDF native: timed out waiting for ${label}`)
}
function boundedEditor(editor: OfficePdfSmokeEditor): OfficePdfSmokeEditor {
  return new Proxy(editor, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? (...args: unknown[]) => bounded(Promise.resolve(Reflect.apply(value, target, args)), `editor ${String(key)}`) : value
  } })
}
/** Observe actual WebGL calls without altering rendering or input. */
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
        if (this.canvas instanceof HTMLCanvasElement && this.canvas.dataset.testid === 'pdf-canvas') calls++
        return result
      } })
      restore.push(() => Object.defineProperty(prototype, name, descriptor))
    }
  }
  return { calls: () => calls, restore: () => { for (const reset of restore.reverse()) reset() } }
}
async function localResource(name: string, limit: number) {
  const url = new URL(`office-pdf/${name}`, document.baseURI)
  assert(url.origin === location.origin, 'PDF resource URL is not local')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    assert(response.ok, `PDF ${name} request failed (${response.status})`)
    const advertised = Number(response.headers.get('content-length'))
    assert(!advertised || advertised <= limit, `${name} exceeds the smoke resource bound`)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= limit, `${name} has an invalid resource size`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { bytes, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') }
  } finally { clearTimeout(timeout) }
}
async function verifyResources(): Promise<NonNullable<OfficePdfNativeSmokeReport['resources']>> {
  const manifest = await localResource('manifest.json', 65536)
  const metadata = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { engine?: string; sourceHash?: string; upstreamCommit?: string; files?: Record<string, string> }
  assert(metadata.engine === 'Open Office PDF' && /^[a-f0-9]{64}$/.test(metadata.sourceHash || '') && /^[a-f0-9]{40}$/.test(metadata.upstreamCommit || ''), 'PDF manifest metadata is invalid')
  const files = {} as NonNullable<OfficePdfNativeSmokeReport['resources']>['files']
  for (const name of ['office_pdf.js', 'office_pdf_bg.wasm'] as const) {
    const resource = await localResource(name, name.endsWith('.wasm') ? 256 * 1024 * 1024 : 4 * 1024 * 1024)
    assert(metadata.files?.[name] === resource.sha256, `PDF ${name} does not match its packaged manifest`)
    files[name] = { sha256: resource.sha256, bytes: resource.bytes.byteLength }
  }
  return { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-pdf/office_pdf_bg.wasm', manifestSha256: manifest.sha256, sourceHash: metadata.sourceHash!, upstreamCommit: metadata.upstreamCommit!, files }
}
const oldText = 'OLD_NATIVE_TEXT 旧合同', newText = 'NEW_NATIVE_TEXT 新的合同'
async function textOf(editor: OfficePdfSmokeEditor) {
  const value = await editor.query('document.inspect') as { pageCount: number; texts: string[] }
  assert(value.pageCount === 1 && Array.isArray(value.texts), 'PDF has no single-page text model')
  return value.texts.join('\n')
}
function contains(text: string, required: string) { return text.replace(/\s/g, '').includes(required.replace(/\s/g, '')) }

export async function runOfficePdfNativeSmoke(adapter: OfficePdfSmokeAdapter): Promise<OfficePdfNativeSmokeReport> {
  assert(isTauri(), 'real native WebView is required')
  return verifyMountedOfficePdfEditor(adapter)
}

/** Exercise the same mounted canvas and revision-bound save path as the shell. */
export async function verifyMountedOfficePdfEditor(adapter: OfficePdfSmokeAdapter): Promise<OfficePdfNativeSmokeReport> {
  const report: OfficePdfNativeSmokeReport = {
    schemaVersion: 1, kind: 'pdf-native', engine: 'office-pdf-wasm', transport: isTauri() ? 'local-wasm-in-native-webview' : 'local-wasm-in-browser', ok: false, checks: [],
    limitations: ['PDF edit checks use the mounted editor command interface; they are not physical keyboard or IME input.', 'Save checks cover exported PDF bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.'],
    cleanup: { attempted: 0, closed: 0, ok: true, remainingCanvas: 0, remainingInput: 0 },
  }
  const opened: MountedOfficePdfSmokeEditor[] = [], paint = observePaint()
  const passed = (name: string) => report.checks.push(name)
  async function open(base64: string, name: string) {
    const mounted = await bounded(adapter.open(base64, name), 'default PDF editor ready', 120000)
    const value = { ...mounted, editor: boundedEditor(mounted.editor) }
    opened.push(value)
    return value
  }
  try {
    const first = await open('', 'Native PDF smoke.pdf')
    assert(first.element.dataset.engine === 'office-pdf-wasm', 'the default PDF editor is not the Rust engine')
    const canvas = first.element.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"]')
    assert(canvas && canvas.width > 0 && canvas.height > 0, 'PDF editor has no drawing surface')
    const box = canvas.getBoundingClientRect()
    assert(box.width > 100 && box.height > 100, 'PDF canvas is hidden')
    await eventually(async () => paint.calls(), count => count > 0, 'actual PDF WebGL drawing')
    const assets = performance.getEntriesByType('resource').map(entry => new URL(entry.name, location.href)).filter(url => url.pathname.endsWith('/office-pdf/office_pdf_bg.wasm'))
    assert(assets.length > 0 && assets.every(url => url.origin === location.origin), 'local PDF WASM request was not observed')
    await eventually(async () => first.editor.query('ui.state') as Promise<{ active?: { pages_on_screen?: unknown[]; page_errors?: unknown[] } }>, ui => !!ui.active?.pages_on_screen?.length && !ui.active?.page_errors?.length, 'visible PDF page without rendering errors')
    report.canvas = { width: canvas.width, height: canvas.height, pageCount: (await first.editor.inspect()).pageCount, paintCalls: paint.calls() }
    passed('default-mounted-local-wasm-canvas-painted')
    report.resources = await verifyResources()
    passed('packaged-pdf-wasm-manifest-verified')
    await first.editor.command('pdf.addText', { page: 0, text: oldText, rect: [72, 650, 432, 720], size: 18 })
    assert(contains(await textOf(first.editor), oldText), 'PDF text insertion did not enter the model')
    const beforeEdit = await first.editor.exportFile({ format: 'pdf' })
    await first.editor.markSaved?.(beforeEdit.base64)
    assert(!(await first.editor.inspect()).dirty, 'accepted save receipt did not clear PDF dirty state')
    await first.editor.command('pdf.updateText', { page: 0, index: 0, text: newText })
    assert(contains(await textOf(first.editor), newText), 'PDF replacement did not enter the model')
    passed('pdf-content-insert-and-replace')
    let staleSaveRejected = false
    try { await first.editor.markSaved?.(beforeEdit.base64) } catch (cause) {
      staleSaveRejected = cause instanceof Error && cause.message === '导出后 PDF 文档又有修改，请再次保存当前内容。'
      if (!staleSaveRejected) throw cause
    }
    assert(staleSaveRejected && (await first.editor.inspect()).dirty, 'old save receipt cleared newer PDF edits')
    passed('stale-save-receipt-rejected')
    await first.editor.undo?.()
    assert(contains(await textOf(first.editor), oldText) && !contains(await textOf(first.editor), newText), 'PDF undo did not restore original text')
    await first.editor.redo?.()
    assert(contains(await textOf(first.editor), newText) && !contains(await textOf(first.editor), oldText), 'PDF redo did not restore replacement text')
    report.undoRedo = { undo: true, redo: true }
    passed('undo-redo-preserves-real-text')
    const exported = await first.editor.exportFile({ format: 'pdf' })
    assert(exported.extension === 'pdf' && exported.base64.length < 16 * 1024 * 1024 && atob(exported.base64).startsWith('%PDF-'), 'PDF export is invalid or unbounded')
    const readback = await bounded(inspectPdfBytes(exported.base64), 'PDF export readback')
    report.text = readback.texts.join('\n')
    report.removedOldText = !report.text.includes('OLD_NATIVE_TEXT') && !report.text.includes('旧合同')
    report.newTextPresent = report.text.includes('NEW_NATIVE_TEXT') && report.text.includes('新的合同')
    report.metadata = { pageCount: readback.pageCount }
    assert(report.removedOldText && report.newTextPresent && readback.pageCount === 1, 'replacement PDF did not preserve page count and edited text')
    report.pdfBase64 = exported.base64
    const reopened = await open(exported.base64, 'Native PDF reopen.pdf')
    const reopenedState = await reopened.editor.inspect()
    assert(!reopenedState.dirty && contains(await textOf(reopened.editor), newText), 'PDF reopen lost text or clean baseline')
    report.reopened = true
    passed('pdf-export-reopened')
    assert((await first.editor.inspect()).documentId !== reopenedState.documentId, 'PDF tabs share a mutable document')
    passed('two-live-pdf-sessions')
    await reopened.editor.command('pdf.editText', { page: 0, line: 0, text: 'REOPEN_NATIVE_TEXT 再次编辑' })
    assert(contains(await textOf(reopened.editor), 'REOPEN_NATIVE_TEXT'), 'reopened original PDF text is not editable')
    await reopened.editor.undo?.()
    assert(contains(await textOf(reopened.editor), newText), 'reopened PDF edit undo lost original content')
    passed('reopened-content-editable')
    report.reopenedPdfBase64 = (await reopened.editor.exportFile({ format: 'pdf' })).base64
    const beforeFailure = await reopened.editor.inspect()
    let invalidOpenRejected = false
    try { await open(btoa('%PDF-1.7\ninvalid-pdf'), 'Invalid smoke.pdf') } catch (cause) {
      if (cause instanceof Error && cause.message.includes('timed out')) throw cause
      invalidOpenRejected = true
    }
    const afterFailure = await reopened.editor.inspect()
    const preserved = adapter.activeKey() === reopened.key && afterFailure.documentId === beforeFailure.documentId && afterFailure.revision === beforeFailure.revision && afterFailure.dirty === beforeFailure.dirty && contains(await textOf(reopened.editor), newText)
    assert(invalidOpenRejected && preserved, 'failed PDF open changed or closed an existing document')
    report.failures = { staleSaveRejected, invalidOpenRejected, preserved }
    passed('invalid-open-preserves-active-session')
    // Browser interaction checks have their own deadline. Never run them inside
    // close(), whose short deadline protects cleanup of the actual sessions.
    if (adapter.verifyMounted) await bounded(adapter.verifyMounted(), 'mounted PDF interaction verification', 120000)
    report.ok = true
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    for (const mounted of opened.reverse()) {
      report.cleanup.attempted++
      try { await bounded(adapter.close(mounted.key), 'PDF session cleanup'); report.cleanup.closed++ }
      catch (cause) { report.cleanup.ok = false; report.ok = false; report.closeError = cause instanceof Error ? cause.message : String(cause) }
    }
    paint.restore()
    report.cleanup.remainingCanvas = document.querySelectorAll('[data-testid="pdf-canvas"]').length
    report.cleanup.remainingInput = document.querySelectorAll('[data-testid="pdf-input"]').length
    if (report.cleanup.remainingCanvas || report.cleanup.remainingInput) { report.ok = false; report.cleanup.ok = false; report.closeError ||= 'PDF renderer or input agent remained after cleanup' }
    if (report.cleanup.ok && report.cleanup.closed === 2) passed('session-cleanup-complete')
  }
  return report
}
