import { isTauri } from '@tauri-apps/api/core'
import type { EditorHandle } from '../../shared/document'
import type { DeckcraftSnapshot } from './deckcraft-types'

export interface DeckcraftSmokeEditor extends EditorHandle {
  inspect(): Promise<DeckcraftSnapshot>
  command(id: string, params?: Record<string, unknown>): Promise<DeckcraftSnapshot>
  query(id: string, params?: Record<string, unknown>): Promise<unknown>
}
export interface MountedDeckcraftSmokeEditor {
  key: string
  element: HTMLElement
  editor: DeckcraftSmokeEditor
}
export interface DeckcraftSmokeAdapter {
  open(base64: string, name: string): Promise<MountedDeckcraftSmokeEditor>
  activeKey(): string
  close(key: string): Promise<void>
}
export interface DeckcraftNativeSmokeReport {
  schemaVersion: 1
  kind: 'deckcraft-native'
  engine: 'deckcraft-wasm'
  transport: 'local-wasm-in-native-webview' | 'local-wasm-in-browser'
  ok: boolean
  checks: string[]
  limitations: string[]
  cleanup: { attempted: number; closed: number; ok: boolean; remainingCanvas: number; remainingInput: number }
  canvas?: { width: number; height: number; slideCount: number; paintCalls: number }
  domInput?: { eventType: 'input'; isTrusted: false; text: string; accepted: true }
  resources?: { wasmLoaded: true; sameOrigin: true; wasmPath: '/deckcraft/deckcraft_bg.wasm'; manifestSha256: string; sourceHash: string; upstreamCommit: string; files: Record<'deckcraft.js' | 'deckcraft_bg.wasm', { sha256: string; bytes: number }> }
  format?: { bold: boolean }
  slides?: { count: number; activeIndex: number }
  secondSlideText?: string
  pdf?: { pageCount: number; textVerified: boolean }
  failures?: { staleSaveRejected: boolean; invalidOpenRejected: boolean; preserved: boolean }
  text?: string
  reopenedText?: string
  pptxBase64?: string
  reopenedPptxBase64?: string
  pdfBase64?: string
  error?: string
  closeError?: string
}
const inputText = 'Open Office 演示😀'
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`DeckCraft native: ${message}`) }
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`DeckCraft native: ${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const frame = () => bounded(new Promise<void>(resolve => requestAnimationFrame(() => resolve())), 'animation frame')
function boundedEditor(editor: DeckcraftSmokeEditor): DeckcraftSmokeEditor {
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
  throw Error(`DeckCraft native: timed out waiting for ${label}`)
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
        if (this.canvas instanceof HTMLCanvasElement && this.canvas.dataset.testid === 'deckcraft-canvas') calls++
        return result
      } })
      restore.push(() => Object.defineProperty(prototype, name, descriptor))
    }
  }
  return { calls: () => calls, restore: () => { for (const reset of restore.reverse()) reset() } }
}
async function localResource(name: string, limit: number) {
  const url = new URL(`deckcraft/${name}`, document.baseURI)
  assert(url.origin === location.origin, 'DeckCraft resource URL is not local')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    assert(response.ok, `DeckCraft ${name} request failed (${response.status})`)
    const advertised = Number(response.headers.get('content-length'))
    assert(!advertised || advertised <= limit, `${name} exceeds the smoke resource bound`)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= limit, `${name} has an invalid resource size`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { bytes, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') }
  } finally { clearTimeout(timeout) }
}
async function verifyResources(): Promise<NonNullable<DeckcraftNativeSmokeReport['resources']>> {
  const manifest = await localResource('manifest.json', 65536)
  const metadata = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { engine?: string; sourceHash?: string; upstreamCommit?: string; files?: Record<string, string> }
  assert(metadata.engine === 'DeckCraft' && /^[a-f0-9]{64}$/.test(metadata.sourceHash || '') && /^[a-f0-9]{40}$/.test(metadata.upstreamCommit || ''), 'DeckCraft manifest metadata is invalid')
  const files = {} as NonNullable<DeckcraftNativeSmokeReport['resources']>['files']
  for (const name of ['deckcraft.js', 'deckcraft_bg.wasm'] as const) {
    const resource = await localResource(name, name.endsWith('.wasm') ? 256 * 1024 * 1024 : 4 * 1024 * 1024)
    assert(metadata.files?.[name] === resource.sha256, `DeckCraft ${name} does not match its packaged manifest`)
    files[name] = { sha256: resource.sha256, bytes: resource.bytes.byteLength }
  }
  return { wasmLoaded: true, sameOrigin: true, wasmPath: '/deckcraft/deckcraft_bg.wasm', manifestSha256: manifest.sha256, sourceHash: metadata.sourceHash!, upstreamCommit: metadata.upstreamCommit!, files }
}

type SlideSummary = { shapes: Array<{ id: number; text?: string }> }
type ShapeDetails = { shape: { text?: { paragraphs: Array<{ runs: Array<{ text: string; props?: { bold?: boolean } }> }> } } }
const secondSlideText = 'Second slide 第二页'
const readSlide = (mounted: MountedDeckcraftSmokeEditor, index: number) => mounted.editor.query('slide.inspect', { index }) as Promise<SlideSummary>
const readText = (mounted: MountedDeckcraftSmokeEditor, id: number) => mounted.editor.query('text.get', { id }) as Promise<{ text: string }>
async function isBold(mounted: MountedDeckcraftSmokeEditor, id: number) {
  const details = await mounted.editor.query('shape.inspect', { id }) as ShapeDetails
  const runs = details.shape.text?.paragraphs.flatMap(paragraph => paragraph.runs).filter(run => run.text.length)
  return !!runs?.length && runs.every(run => run.props?.bold === true)
}
async function addTextBox(mounted: MountedDeckcraftSmokeEditor, index: number, text: string) {
  const before = new Set((await readSlide(mounted, index)).shapes.map(shape => shape.id))
  await mounted.editor.command('insert.textBox', { rect: [80, 80, 500, 90], text })
  const inserted = (await readSlide(mounted, index)).shapes.filter(shape => !before.has(shape.id))
  assert(inserted.length === 1, 'Rust text box insertion did not create exactly one shape')
  return inserted[0]!.id
}
async function focusCanvas(mounted: MountedDeckcraftSmokeEditor) {
  type CanvasUi = { canvasRect?: number[] }
  const state = await eventually(() => mounted.editor.inspect(), value => (value.ui as CanvasUi | undefined)?.canvasRect?.length === 4, 'Rust slide layout')
  const canvas = mounted.element.querySelector<HTMLCanvasElement>('[data-testid="deckcraft-canvas"]')
  assert(canvas && canvas.width > 0 && canvas.height > 0, 'default editor has no visible drawing surface')
  const [x, y, width, height] = (state.ui as CanvasUi).canvasRect!
  const box = canvas.getBoundingClientRect()
  assert(box.width > 100 && box.height > 100 && width! > 100 && height! > 100, 'default canvas is hidden')
  const clientX = box.x + x! + width! / 2, clientY = box.y + y! + height! / 2
  assert(document.elementFromPoint(clientX, clientY) === canvas, 'slide focus point is covered')
  canvas.focus({ preventScroll: true })
  const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX, clientY }
  canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 0 }))
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }))
  await frame()
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  await frame()
  return canvas
}
async function inspectPdf(base64: string): Promise<{ pageCount: number; texts: string[] }> {
  if (isTauri()) {
    const { requestPdf } = await import('../../pdf/protocol')
    const result = await bounded(requestPdf('inspect', base64), 'native PDF readback', 60000)
    assert(result.metadata?.pageCount === 2, 'native PDF engine did not find two slides')
    return { pageCount: result.metadata.pageCount, texts: [0, 1].map(index => (result.textBlocks ?? []).filter(block => block.pageIndex === index).map(block => block.text).join('')) }
  }
  // Browser verification uses an independent parser and reports browser transport.
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  const { base64ToBytes } = await import('../../shared/document')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: base64ToBytes(base64), cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href, cMapPacked: true, standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href, wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href })
  try {
    const pdf = await bounded(task.promise, 'browser PDF readback')
    const texts = []
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index), content = await page.getTextContent()
      texts.push(content.items.map(item => 'str' in item ? item.str : '').join(''))
    }
    return { pageCount: pdf.numPages, texts }
  } finally { await task.destroy() }
}

/** Installed-app entry point rejects browser execution or an alternate IPC bridge. */
export async function runDeckcraftNativeSmoke(adapter: DeckcraftSmokeAdapter): Promise<DeckcraftNativeSmokeReport> {
  assert(isTauri(), 'real native WebView is required')
  return verifyMountedDeckcraftEditor(adapter)
}

/** Exercise the default mounted canvas. Every report labels synthetic DOM input
 * and its actual transport; release gates independently inspect exported files. */
export async function verifyMountedDeckcraftEditor(adapter: DeckcraftSmokeAdapter): Promise<DeckcraftNativeSmokeReport> {
  const report: DeckcraftNativeSmokeReport = {
    schemaVersion: 1, kind: 'deckcraft-native', engine: 'deckcraft-wasm', transport: isTauri() ? 'local-wasm-in-native-webview' : 'local-wasm-in-browser', ok: false, checks: [],
    limitations: ['Synthetic WebView input events are not a physical operating-system IME.', 'Save checks cover exported PPTX bytes and editor save receipts; native file dialogs and filesystem persistence are not exercised.'],
    cleanup: { attempted: 0, closed: 0, ok: true, remainingCanvas: 0, remainingInput: 0 },
  }
  const opened: MountedDeckcraftSmokeEditor[] = [], paint = observePaint()
  const passed = (name: string) => report.checks.push(name)
  async function open(base64: string, name: string) {
    const mounted = await bounded(adapter.open(base64, name), 'default editor ready', 120000)
    const value = { ...mounted, editor: boundedEditor(mounted.editor) }
    opened.push(value)
    return value
  }
  try {
    const first = await open('', 'Native presentation smoke.pptx')
    assert(first.element.dataset.engine === 'deckcraft-wasm', 'the default presentation editor is not the Rust engine')
    const canvas = await focusCanvas(first)
    await eventually(async () => paint.calls(), count => count > 0, 'actual WebGL drawing')
    const assets = performance.getEntriesByType('resource').map(entry => new URL(entry.name, location.href)).filter(url => url.pathname.endsWith('/deckcraft/deckcraft_bg.wasm'))
    assert(assets.length > 0 && assets.every(url => url.origin === location.origin), 'local presentation WASM request was not observed')
    report.resources = await verifyResources()
    passed('default-mounted-local-wasm-canvas-painted')
    const firstShape = await addTextBox(first, 0, '')
    await first.editor.command('text.edit', { id: firstShape, end: true })
    await frame(); await frame()
    const agent = first.element.querySelector<HTMLInputElement>('[data-testid="deckcraft-input"]')
    assert(agent && document.querySelectorAll('[data-testid="deckcraft-input"]').length === 1, 'exactly one presentation input agent is required')
    agent.focus({ preventScroll: true })
    assert(agent.value === '', 'new input agent contains unexpected text')
    agent.value = inputText
    agent.setSelectionRange(inputText.length, inputText.length)
    const event = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inputText, isComposing: false })
    assert(event.isTrusted === false, 'diagnostic input must be labelled synthetic')
    // The required token reaches egui through its actual input listener, not text.set.
    agent.dispatchEvent(event)
    await frame(); await frame()
    await eventually(() => readText(first, firstShape), value => value.text === inputText, 'DOM input committed into the Rust slide')
    assert((await first.editor.inspect()).dirty, 'committed input did not mark the presentation dirty')
    report.domInput = { eventType: 'input', isTrusted: false, text: inputText, accepted: true }
    passed('synthetic-dom-input-chinese-emoji')
    await first.editor.command('text.selectAll')
    await first.editor.command('format.bold', { on: true })
    assert(await isBold(first, firstShape), 'Rust text formatting was not applied to the full run')
    await first.editor.command('text.exit')
    await first.editor.command('slide.new', { layout: 'blank' })
    await addTextBox(first, 1, secondSlideText)
    await first.editor.command('slide.go', { index: 0 })
    const state = await first.editor.inspect()
    assert(state.slides.length === 2 && state.activeSlide === 0, 'Rust slide creation or navigation failed')
    report.format = { bold: true }; report.slides = { count: state.slides.length, activeIndex: state.activeSlide }
    report.secondSlideText = (await readSlide(first, 1)).shapes.find(shape => shape.text === secondSlideText)?.text
    assert(report.secondSlideText === secondSlideText, 'second slide text was not preserved')
    report.canvas = { width: canvas.width, height: canvas.height, slideCount: state.slides.length, paintCalls: paint.calls() }
    passed('rust-slide-editing-and-text-formatting')
    const exported = await first.editor.exportFile({ format: 'pptx' })
    assert(exported.extension === 'pptx' && exported.base64.length < 1024 * 1024 && atob(exported.base64).startsWith('PK'), 'export is not a bounded PPTX package')
    assert((await first.editor.inspect()).dirty, 'export marked the presentation saved prematurely')
    report.pptxBase64 = exported.base64; report.text = (await readText(first, firstShape)).text
    await first.editor.markSaved?.(exported.base64)
    assert(!(await first.editor.inspect()).dirty, 'accepted save receipt did not clear presentation dirty state')
    passed('pptx-export-and-save-receipt')
    await first.editor.command('slide.notes', { index: 0, text: 'POST_SAVE' })
    const beforeFailure = await first.editor.inspect()
    let staleSaveRejected = false
    try { await first.editor.markSaved?.(exported.base64) } catch (cause) {
      staleSaveRejected = cause instanceof Error && cause.message === '导出后演示文稿又有修改，请再次保存当前内容。'
      if (!staleSaveRejected) throw cause
    }
    assert(staleSaveRejected, 'stale saved bytes cleared newer edits')
    let invalidOpenRejected = false
    try { await open(btoa('PK\u0003\u0004invalid-deck-pptx'), 'Invalid smoke.pptx') } catch (cause) {
      if (cause instanceof Error && cause.message.includes('timed out')) throw cause
      invalidOpenRejected = true
    }
    const afterFailure = await first.editor.inspect()
    const currentSlide = await first.editor.query('slide.inspect', { index: 0 }) as SlideSummary & { notes?: string }
    const preserved = adapter.activeKey() === first.key && afterFailure.documentId === beforeFailure.documentId && afterFailure.revision === beforeFailure.revision && afterFailure.dirty
      && (await readText(first, firstShape)).text === inputText && currentSlide.notes === 'POST_SAVE'
    assert(invalidOpenRejected && preserved, 'failed open or stale save changed the current presentation')
    report.failures = { staleSaveRejected, invalidOpenRejected, preserved }
    passed('stale-save-and-invalid-open-preserve-active-document')
    const reopened = await open(exported.base64, 'Native presentation reopen.pptx')
    await focusCanvas(reopened)
    const reopenedState = await reopened.editor.inspect(), firstSlide = await readSlide(reopened, 0)
    const reopenedShape = firstSlide.shapes.find(shape => shape.text === inputText)
    assert(reopenedShape && await isBold(reopened, reopenedShape.id) && !reopenedState.dirty && reopenedState.slides.length === 2, 'saved PPTX text, bold formatting or clean baseline changed on reopen')
    assert((await readSlide(reopened, 1)).shapes.some(shape => shape.text === secondSlideText), 'PPTX reopen lost second slide text')
    report.reopenedText = (await readText(reopened, reopenedShape.id)).text
    report.reopenedPptxBase64 = (await reopened.editor.exportFile({ format: 'pptx' })).base64
    passed('saved-pptx-reopened-in-default-editor')
    const pdf = await reopened.editor.exportFile({ format: 'pdf' })
    assert(pdf.extension === 'pdf' && pdf.base64.length < 8 * 1024 * 1024 && atob(pdf.base64).startsWith('%PDF-'), 'export is not a bounded PDF file')
    const independent = await inspectPdf(pdf.base64), text = independent.texts.map(value => value.replace(/\s/g, ''))
    assert(independent.pageCount === 2 && text[0]?.includes('OpenOffice') && text[0]?.includes('演示') && text[1]?.includes('Secondslide') && text[1]?.includes('第二页'), 'independent PDF readback lost page count or Chinese text')
    report.pdfBase64 = pdf.base64; report.pdf = { pageCount: independent.pageCount, textVerified: true }
    passed('pdf-export-and-independent-readback')
    report.ok = true
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    for (const mounted of opened.reverse()) {
      report.cleanup.attempted++
      try { await bounded(adapter.close(mounted.key), 'session cleanup'); report.cleanup.closed++ }
      catch (cause) { report.cleanup.ok = false; report.ok = false; report.closeError = cause instanceof Error ? cause.message : String(cause) }
    }
    paint.restore()
    report.cleanup.remainingCanvas = document.querySelectorAll('[data-testid="deckcraft-canvas"]').length
    report.cleanup.remainingInput = document.querySelectorAll('[data-testid="deckcraft-input"]').length
    if (report.cleanup.remainingCanvas || report.cleanup.remainingInput) { report.ok = false; report.cleanup.ok = false; report.closeError ||= 'Presentation renderer or input agent remained after cleanup' }
  }
  return report
}
