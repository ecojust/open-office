import { isTauri } from '@tauri-apps/api/core'
import type { EditorHandle } from '../../shared/document'
import type { OfficeSheetSnapshot } from './office-sheet-types'

export interface OfficeSheetSmokeEditor extends EditorHandle {
  inspect(): Promise<OfficeSheetSnapshot>
  command(id: string, params?: Record<string, unknown>): Promise<OfficeSheetSnapshot>
  query(id: string, params?: Record<string, unknown>): Promise<unknown>
}
export interface MountedOfficeSheetSmokeEditor {
  key: string
  element: HTMLElement
  editor: OfficeSheetSmokeEditor
}
export interface OfficeSheetSmokeAdapter {
  open(base64: string, name: string): Promise<MountedOfficeSheetSmokeEditor>
  activeKey(): string
  close(key: string): Promise<void>
}
export interface OfficeSheetNativeSmokeReport {
  schemaVersion: 1
  kind: 'office-sheet-native'
  engine: 'office-sheet-wasm'
  transport: 'local-wasm-in-native-webview' | 'local-wasm-in-browser'
  ok: boolean
  checks: string[]
  limitations: string[]
  cleanup: { attempted: number; closed: number; ok: boolean; remainingCanvas: number; remainingInput: number }
  canvas?: { width: number; height: number; sheetCount: number; paintCalls: number }
  domInput?: { eventType: 'input'; isTrusted: false; text: string; accepted: true }
  resources?: { wasmLoaded: true; sameOrigin: true; wasmPath: '/office-sheet/office-sheet_bg.wasm'; manifestSha256: string; sourceHash: string; upstreamCommit: string; files: Record<'office-sheet.js' | 'office-sheet_bg.wasm', { sha256: string; bytes: number }> }
  format?: { bold: boolean }
  formula?: { input: string; value: number; inputs: number[] }
  failures?: { staleSaveRejected: boolean; invalidOpenRejected: boolean; preserved: boolean }
  text?: string
  reopenedText?: string
  xlsxBase64?: string
  reopenedXlsxBase64?: string
  error?: string
  closeError?: string
}
const inputText = 'Open Office 表格😀'
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`OfficeSheet native: ${message}`) }
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`OfficeSheet native: ${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const frame = () => bounded(new Promise<void>(resolve => requestAnimationFrame(() => resolve())), 'animation frame')
function boundedEditor(editor: OfficeSheetSmokeEditor): OfficeSheetSmokeEditor {
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
  throw Error(`OfficeSheet native: timed out waiting for ${label}`)
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
        if (this.canvas instanceof HTMLCanvasElement && this.canvas.dataset.testid === 'office-sheet-canvas') calls++
        return result
      } })
      restore.push(() => Object.defineProperty(prototype, name, descriptor))
    }
  }
  return { calls: () => calls, restore: () => { for (const reset of restore.reverse()) reset() } }
}
type CellState = { input: string; text: string; value: unknown; formula: string | null; style: { font: { bold: boolean } } }
const readCell = (mounted: MountedOfficeSheetSmokeEditor, cell: string) => mounted.editor.query('cell.get', { cell }) as Promise<CellState>
async function focusCanvas(mounted: MountedOfficeSheetSmokeEditor) {
  type CanvasUi = { visibleCells?: Array<{ cell: string; rect: number[] }> }
  const state = await eventually(() => mounted.editor.inspect(), value => !!(value.ui as CanvasUi | undefined)?.visibleCells?.some(cell => cell.cell === 'A1'), 'Rust cell layout')
  const canvas = mounted.element.querySelector<HTMLCanvasElement>('[data-testid="office-sheet-canvas"]')
  assert(canvas && canvas.width > 0 && canvas.height > 0, 'default editor has no visible drawing surface')
  const [x, y, width, height] = (state.ui as CanvasUi).visibleCells!.find(cell => cell.cell === 'A1')!.rect
  const box = canvas.getBoundingClientRect()
  assert(box.width > 100 && box.height > 100, 'default canvas is hidden')
  const clientX = box.x + x! + width! / 2, clientY = box.y + y! + height! / 2
  assert(document.elementFromPoint(clientX, clientY) === canvas, 'cell focus point is covered')
  canvas.focus({ preventScroll: true })
  const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX, clientY }
  canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 0 }))
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }))
  await frame()
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  await frame()
  return canvas
}

async function localResource(name: string, limit: number) {
  const url = new URL(`office-sheet/${name}`, document.baseURI)
  assert(url.origin === location.origin, 'OfficeSheet resource URL is not local')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    assert(response.ok, `OfficeSheet ${name} request failed (${response.status})`)
    const advertised = Number(response.headers.get('content-length'))
    assert(!advertised || advertised <= limit, `${name} exceeds the smoke resource bound`)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= limit, `${name} has an invalid resource size`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { bytes, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') }
  } finally { clearTimeout(timeout) }
}
async function verifyResources(): Promise<NonNullable<OfficeSheetNativeSmokeReport['resources']>> {
  const manifest = await localResource('manifest.json', 65536)
  const metadata = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { engine?: string; sourceHash?: string; upstreamCommit?: string; files?: Record<string, string> }
  assert(metadata.engine === 'Open Office' && /^[a-f0-9]{64}$/.test(metadata.sourceHash || '') && /^[a-f0-9]{40}$/.test(metadata.upstreamCommit || ''), 'OfficeSheet manifest metadata is invalid')
  const files = {} as NonNullable<OfficeSheetNativeSmokeReport['resources']>['files']
  for (const name of ['office-sheet.js', 'office-sheet_bg.wasm'] as const) {
    const resource = await localResource(name, name.endsWith('.wasm') ? 256 * 1024 * 1024 : 4 * 1024 * 1024)
    assert(metadata.files?.[name] === resource.sha256, `OfficeSheet ${name} does not match its packaged manifest`)
    files[name] = { sha256: resource.sha256, bytes: resource.bytes.byteLength }
  }
  return { wasmLoaded: true, sameOrigin: true, wasmPath: '/office-sheet/office-sheet_bg.wasm', manifestSha256: manifest.sha256, sourceHash: metadata.sourceHash!, upstreamCommit: metadata.upstreamCommit!, files }
}

/** Installed-app entry point never accepts a browser or a replacement IPC bridge. */
export async function runOfficeSheetNativeSmoke(adapter: OfficeSheetSmokeAdapter): Promise<OfficeSheetNativeSmokeReport> {
  assert(isTauri(), 'real native WebView is required')
  return verifyMountedOfficeSheetEditor(adapter)
}

/** The same mounted-editor checks also run in Chromium; the report identifies
 * that transport explicitly, and native release gates must reject it. */
export async function verifyMountedOfficeSheetEditor(adapter: OfficeSheetSmokeAdapter): Promise<OfficeSheetNativeSmokeReport> {
  const report: OfficeSheetNativeSmokeReport = {
    schemaVersion: 1, kind: 'office-sheet-native', engine: 'office-sheet-wasm', transport: isTauri() ? 'local-wasm-in-native-webview' : 'local-wasm-in-browser', ok: false, checks: [],
    limitations: ['Synthetic WebView input events are not a physical operating-system IME.', 'Save checks cover exported XLSX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.'],
    cleanup: { attempted: 0, closed: 0, ok: true, remainingCanvas: 0, remainingInput: 0 },
  }
  const opened: MountedOfficeSheetSmokeEditor[] = []
  const paint = observePaint()
  const passed = (name: string) => report.checks.push(name)
  async function open(base64: string, name: string) {
    const mounted = await bounded(adapter.open(base64, name), 'default editor ready', 120000)
    const value = { ...mounted, editor: boundedEditor(mounted.editor) }
    opened.push(value)
    return value
  }
  try {
    const first = await open('', 'Native spreadsheet smoke.xlsx')
    assert(first.element.dataset.engine === 'office-sheet-wasm', 'the default spreadsheet editor is not OfficeSheet')
    const canvas = await focusCanvas(first)
    await eventually(async () => paint.calls(), count => count > 0, 'actual WebGL drawing')
    let state = await first.editor.inspect()
    report.canvas = { width: canvas.width, height: canvas.height, sheetCount: state.sheets.length, paintCalls: paint.calls() }
    const assets = performance.getEntriesByType('resource').map(entry => new URL(entry.name, location.href)).filter(url => url.pathname.endsWith('/office-sheet/office-sheet_bg.wasm'))
    assert(assets.length > 0 && assets.every(url => url.origin === location.origin), 'local OfficeSheet WASM request was not observed')
    report.resources = await verifyResources()
    passed('default-mounted-local-wasm-canvas-painted')
    const agent = first.element.querySelector<HTMLInputElement>('[data-testid="office-sheet-input"]')
    assert(agent && document.querySelectorAll('[data-testid="office-sheet-input"]').length === 1, 'exactly one spreadsheet input agent is required')
    agent.focus({ preventScroll: true })
    assert(agent.value === '', 'new input agent contains unexpected text')
    agent.value = inputText
    agent.setSelectionRange(inputText.length, inputText.length)
    const event = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inputText, isComposing: false })
    assert(event.isTrusted === false, 'diagnostic input must be labelled synthetic')
    // The required token reaches the real egui input listener, never cell.set.
    agent.dispatchEvent(event)
    await frame(); await frame()
    // eframe treats keyCode 0/229 as an IME-in-progress signal. Synthetic DOM
    // KeyboardEvent defaults to zero, so supply the real Enter legacy code.
    agent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
    agent.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
    await eventually(() => readCell(first, 'A1'), value => value.value === inputText, 'DOM input committed into the Rust cell')
    assert((await first.editor.inspect()).dirty, 'committed input did not mark the workbook dirty')
    report.domInput = { eventType: 'input', isTrusted: false, text: inputText, accepted: true }
    passed('synthetic-dom-input-chinese-emoji')
    for (const [cell, input] of [['B1', '12'], ['B2', '30'], ['C1', '=SUM(B1:B2)']]) await first.editor.command('cell.set', { cell, input })
    await first.editor.command('home.bold', { range: 'A1', on: true })
    const formula = await readCell(first, 'C1'), styled = await readCell(first, 'A1')
    assert(formula.formula === '=SUM(B1:B2)' && formula.value === 42 && styled.style.font.bold, 'Rust formula calculation or cell formatting failed')
    report.formula = { input: formula.formula, value: 42, inputs: [12, 30] }
    report.format = { bold: styled.style.font.bold }
    passed('rust-formulas-and-cell-formatting')
    const exported = await first.editor.exportFile({ format: 'xlsx' })
    assert(exported.extension === 'xlsx' && exported.base64.length < 1024 * 1024 && atob(exported.base64).startsWith('PK'), 'export is not a bounded XLSX package')
    assert((await first.editor.inspect()).dirty, 'export marked the workbook saved prematurely')
    report.xlsxBase64 = exported.base64; report.text = styled.text
    await first.editor.markSaved?.(exported.base64)
    assert(!(await first.editor.inspect()).dirty, 'accepted save receipt did not clear workbook dirty state')
    passed('xlsx-export-and-save-receipt')
    await first.editor.command('cell.set', { cell: 'D1', input: 'POST_SAVE' })
    const beforeFailure = await first.editor.inspect()
    let staleSaveRejected = false
    try { await first.editor.markSaved?.(exported.base64) } catch (cause) {
      staleSaveRejected = cause instanceof Error && cause.message === '导出后工作簿又有修改，请再次保存当前内容。'
      if (!staleSaveRejected) throw cause
    }
    assert(staleSaveRejected, 'stale saved bytes cleared newer edits')
    let invalidOpenRejected = false
    try { await open(btoa('PK\u0003\u0004invalid-office-sheet-xlsx'), 'Invalid smoke.xlsx') } catch (cause) {
      if (cause instanceof Error && cause.message.includes('timed out')) throw cause
      invalidOpenRejected = true
    }
    const afterFailure = await first.editor.inspect()
    const preserved = adapter.activeKey() === first.key && afterFailure.documentId === beforeFailure.documentId && afterFailure.revision === beforeFailure.revision && afterFailure.dirty
      && (await readCell(first, 'A1')).value === inputText && (await readCell(first, 'D1')).value === 'POST_SAVE'
    assert(invalidOpenRejected && preserved, 'failed open or stale save changed the current workbook')
    report.failures = { staleSaveRejected, invalidOpenRejected, preserved }
    passed('stale-save-and-invalid-open-preserve-active-document')
    const reopened = await open(exported.base64, 'Native spreadsheet reopen.xlsx')
    await focusCanvas(reopened)
    state = await reopened.editor.inspect()
    const reopenedCell = await readCell(reopened, 'A1'), reopenedFormula = await readCell(reopened, 'C1')
    assert(reopenedCell.value === inputText && reopenedCell.style.font.bold && !state.dirty, 'saved XLSX text, bold formatting or clean baseline changed on reopen')
    assert(reopenedFormula.formula === '=SUM(B1:B2)' && reopenedFormula.value === 42 && (await readCell(reopened, 'B1')).value === 12 && (await readCell(reopened, 'B2')).value === 30, 'XLSX reopen lost formula, inputs or computed value')
    report.reopenedText = reopenedCell.text
    report.reopenedXlsxBase64 = (await reopened.editor.exportFile({ format: 'xlsx' })).base64
    passed('saved-xlsx-reopened-in-default-editor')
    report.ok = true
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    for (const mounted of opened.reverse()) {
      report.cleanup.attempted++
      try { await bounded(adapter.close(mounted.key), 'session cleanup'); report.cleanup.closed++ }
      catch (cause) { report.cleanup.ok = false; report.ok = false; report.closeError = cause instanceof Error ? cause.message : String(cause) }
    }
    paint.restore()
    report.cleanup.remainingCanvas = document.querySelectorAll('[data-testid="office-sheet-canvas"]').length
    report.cleanup.remainingInput = document.querySelectorAll('[data-testid="office-sheet-input"]').length
    if (report.cleanup.remainingCanvas || report.cleanup.remainingInput) { report.ok = false; report.cleanup.ok = false; report.closeError ||= 'OfficeSheet renderer or input agent remained after cleanup' }
  }
  return report
}
