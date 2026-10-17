import { invoke, isTauri } from '@tauri-apps/api/core'
import * as native from '../native'
import type { EditorHandle } from '../shared/document'
import type { NativeDocument, SaveDocumentRequest, SaveResult } from '../types'

export const WORKFLOW_NATIVE_CHECKS = [
  'mounted-canvas-dom-input',
  'global-save-writes-approved-canvas-file',
  'native-file-readback-reopens-in-new-canvas-session',
  'canvas-tabs-and-editors-closed',
  'mounted-diagram-dom-input',
  'global-save-writes-approved-diagram-file',
  'native-file-readback-reopens-in-new-diagram-session',
  'diagram-tabs-and-editors-closed',
] as const
export const WORKFLOW_NATIVE_LIMITATIONS = [
  'The isolated temporary files are provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM mouse and text input in the installed native WebView; physical input devices and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
] as const
const CANVAS_TEXT = '原生画布保存重开'
const DIAGRAM_SOURCE = 'flowchart LR\n  start[原生代码图表] --> done[本地保存与重开]'
type WorkflowKind = 'canvas' | 'diagram'
type Snapshot = { documentId: number; revision: number; dirty: boolean }
type WorkflowEditor = EditorHandle & { inspect(): Promise<Snapshot>; markSaved(base64: string): Promise<void> }
type SaveReceipt = {
  documentId?: string; extension: string; expectedSha256?: string; saveAs: boolean; status: string
  savedId?: string; savedKind?: string; savedSha256?: string; savedSizeBytes?: number
}
export interface WorkflowNativeSmokeAdapter {
  open(source: NativeDocument): Promise<{ key: string; element: HTMLElement; editor: WorkflowEditor }>
  bindTemporaryFile(key: string, file: NativeDocument): Promise<void>
  state(key: string): { active: boolean; ready: boolean; dirty: boolean; busy: boolean; fileId?: string; sha256: string; modal: boolean }
  autosaveEnabled(): boolean
  setAutosave(enabled: boolean): Promise<void>
  observeNativeSaves(observer: (request: SaveDocumentRequest, result: SaveResult) => void): () => void
  close(key: string): Promise<void>
}
interface DocumentReport {
  kind: WorkflowKind
  editing?: { text: string; inputEvents: number; doubleClickEvents: number; before: Snapshot; after: Snapshot; visibleText: string }
  persistence?: { targetId: string; initialBase64: string; initialSha256: string; initialSizeBytes: number; readbackBase64: string; finalSha256: string; finalSizeBytes: number; saves: SaveReceipt[]; dialogObserved: boolean; saved: Snapshot }
  reopened?: { keyChanged: boolean; fileId: string; kind: WorkflowKind; sha256: string; snapshot: Snapshot; exportedBase64: string; text: string; visibleText: string }
  cleanup?: { closedDocuments: number }
}
export interface WorkflowNativeSmokeReport {
  schemaVersion: 1; kind: 'workflow-native'; transport: 'native-webview-ipc'; ok: boolean
  native: { tauri: true; origin: string }; checks: string[]; limitations: string[]; documents: DocumentReport[]
  cleanup?: { closedDocuments: number }; failedRunTemporaryFilesRemoved?: boolean; error?: string; cleanupError?: string
}
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`Native workflow: ${message}`) }
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000
  while (!await predicate()) { assert(Date.now() < deadline, `${label} timed out`); await new Promise(resolve => setTimeout(resolve, 30)) }
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Native workflow: ${label} timed out`)), 20000) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
async function digest(base64: string) {
  const bytes = native.base64ToBytes(base64), hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.length }
}
function visibleText(element: HTMLElement, kind: WorkflowKind): string {
  return element.querySelector(kind === 'canvas' ? '[data-testid="canvas-stage"] [data-element-id] text' : '[data-testid="diagram-preview"] svg')?.textContent ?? ''
}
function hasExpectedText(text: string, kind: WorkflowKind) { return kind === 'canvas' ? text === CANVAS_TEXT : text.includes('原生代码图表') && text.includes('本地保存与重开') }

/** Mounted native WebView editing and approved original-file saves with real disk readback. */
export async function runWorkflowNativeSmoke(adapter: WorkflowNativeSmokeAdapter): Promise<WorkflowNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for workflow verification')
  const report: WorkflowNativeSmokeReport = { schemaVersion: 1, kind: 'workflow-native', transport: 'native-webview-ipc', ok: false,
    native: { tauri: true, origin: location.origin }, checks: [], limitations: [...WORKFLOW_NATIVE_LIMITATIONS], documents: [] }
  const keys: string[] = [], preference = adapter.autosaveEnabled()
  let unobserve: (() => void) | undefined, closedDocuments = 0
  try {
    await adapter.setAutosave(false)
    for (const [index, kind] of (['canvas', 'diagram'] as const).entries()) {
      const result: DocumentReport = { kind }, check = index * 4
      report.documents.push(result)
      const mounted = await bounded(adapter.open({ id: '', kind, extension: 'owflow', name: `native-${kind}.owflow`, base64: '', sha256: '', sizeBytes: 0 }), `new ${kind}`)
      keys.push(mounted.key)
      const baseline = await bounded(mounted.editor.exportFile({ format: 'owflow' }), `blank ${kind} export`), initial = await digest(baseline.base64)
      const temporary = await bounded(invoke<NativeDocument>('smoke_prepare_document', { base64: baseline.base64, extension: 'owflow' }), `isolated ${kind} file`)
      assert(temporary.kind === kind && temporary.extension === 'owflow' && temporary.base64 === baseline.base64 && temporary.sha256 === initial.sha256 && temporary.sizeBytes === initial.sizeBytes, `${kind} temporary file differs`)
      await adapter.bindTemporaryFile(mounted.key, temporary); await mounted.editor.markSaved(baseline.base64)
      const before = await mounted.editor.inspect()
      await waitFor(() => adapter.state(mounted.key).ready && !adapter.state(mounted.key).busy, `${kind} editable controls`)
      assert(mounted.element.isConnected && mounted.element.dataset.kind === kind && mounted.element.getBoundingClientRect().width > 0 && !before.dirty && before.revision === 0 && !adapter.state(mounted.key).dirty && adapter.state(mounted.key).active, `${kind} is not mounted, clean and active`)
      let inputEvents = 0, doubleClickEvents = 0
      const input = () => inputEvents++, doubleClick = () => doubleClickEvents++
      mounted.element.addEventListener('input', input); mounted.element.addEventListener('dblclick', doubleClick)
      const text = kind === 'canvas' ? CANVAS_TEXT : DIAGRAM_SOURCE
      try {
        if (kind === 'canvas') {
          const stage = mounted.element.querySelector<HTMLElement>('[data-testid="canvas-stage"]'), box = stage?.getBoundingClientRect()
          assert(stage && box && box.width > 400 && box.height > 220, 'visible canvas stage unavailable')
          stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2, clientX: box.left + 200, clientY: box.top + 160 }))
          await waitFor(() => !!mounted.element.querySelector('[aria-label="编辑图形文字"]'), 'canvas inline text control')
        }
        const control = mounted.element.querySelector<HTMLTextAreaElement>(kind === 'canvas' ? '[aria-label="编辑图形文字"]' : '[data-testid="diagram-source"]')
        assert(control && !control.disabled, `${kind} text control unavailable`)
        control.focus(); control.value = text
        control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); control.blur()
        await waitFor(async () => { const state = await mounted.editor.inspect(); return state.dirty && state.revision > before.revision && adapter.state(mounted.key).dirty && hasExpectedText(visibleText(mounted.element, kind), kind) }, `${kind} DOM input and rendered content`)
      } finally { mounted.element.removeEventListener('input', input); mounted.element.removeEventListener('dblclick', doubleClick) }
      const after = await mounted.editor.inspect()
      assert(inputEvents === 1 && doubleClickEvents === (kind === 'canvas' ? 1 : 0) && after.documentId === before.documentId, `${kind} input did not reach its session`)
      result.editing = { text, inputEvents, doubleClickEvents, before, after, visibleText: visibleText(mounted.element, kind) }
      report.checks.push(WORKFLOW_NATIVE_CHECKS[check]!)
      const saves: SaveReceipt[] = []
      unobserve = adapter.observeNativeSaves((request, receipt) => saves.push({ documentId: request.documentId, extension: request.extension,
        expectedSha256: request.expectedSha256, saveAs: request.saveAs === true, status: receipt.status,
        ...(receipt.status === 'saved' ? { savedId: receipt.document.id, savedKind: receipt.document.kind, savedSha256: receipt.document.sha256, savedSizeBytes: receipt.document.sizeBytes } : {}) }))
      const saveButton = document.querySelector<HTMLButtonElement>('[data-testid="shell-save"]')
      assert(saveButton && !saveButton.disabled, 'global save button unavailable')
      let dialogObserved = !!document.querySelector('[role="dialog"]')
      const dialogs = new MutationObserver(() => { dialogObserved ||= !!document.querySelector('[role="dialog"]') })
      dialogs.observe(document.body, { subtree: true, childList: true })
      try {
        saveButton.click()
        await waitFor(() => { const state = adapter.state(mounted.key); dialogObserved ||= state.modal
          return saves.length > 0 && !state.busy && !state.dirty && state.sha256 !== initial.sha256 }, `${kind} global original-file save`)
      } finally { dialogs.disconnect() }
      unobserve(); unobserve = undefined
      const saved = await bounded(native.openRecent(temporary.id), `${kind} native disk readback`), final = await digest(saved.base64), savedSnapshot = await mounted.editor.inspect()
      assert(saved.id === temporary.id && saved.kind === kind && saved.extension === 'owflow' && saved.sha256 === final.sha256 && saved.sizeBytes === final.sizeBytes && final.sha256 !== initial.sha256, `${kind} readback identity or bytes differ`)
      assert(saves.length === 1 && saves[0]!.status === 'saved' && saves[0]!.documentId === temporary.id && saves[0]!.savedId === temporary.id && saves[0]!.savedKind === kind && saves[0]!.extension === 'owflow' && saves[0]!.expectedSha256 === initial.sha256 && saves[0]!.savedSha256 === final.sha256 && saves[0]!.savedSizeBytes === final.sizeBytes && !saves[0]!.saveAs, `${kind} did not save its approved original file`)
      assert(!dialogObserved && !savedSnapshot.dirty && savedSnapshot.documentId === after.documentId && savedSnapshot.revision === after.revision, `${kind} save acknowledged another revision or opened a dialog`)
      result.persistence = { targetId: temporary.id, initialBase64: baseline.base64, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes,
        readbackBase64: saved.base64, finalSha256: final.sha256, finalSizeBytes: final.sizeBytes, saves, dialogObserved, saved: savedSnapshot }
      report.checks.push(WORKFLOW_NATIVE_CHECKS[check + 1]!)
      await bounded(adapter.close(mounted.key), `close original ${kind}`); keys.pop(); closedDocuments++
      assert(!mounted.element.isConnected, `${kind} editor survived closing`)
      const reopened = await bounded(adapter.open(saved), `reopen ${kind} from disk`); keys.push(reopened.key)
      await waitFor(() => hasExpectedText(visibleText(reopened.element, kind), kind), `${kind} reopened rendered content`)
      const snapshot = await reopened.editor.inspect(), exported = await reopened.editor.exportFile({ format: 'owflow' }), state = adapter.state(reopened.key)
      const reopenedText = kind === 'canvas' ? visibleText(reopened.element, kind) : reopened.element.querySelector<HTMLTextAreaElement>('[data-testid="diagram-source"]')?.value
      assert(reopened.key !== mounted.key && snapshot.documentId !== after.documentId && snapshot.revision === 0 && !snapshot.dirty && state.active && state.ready && !state.dirty && state.fileId === saved.id && state.sha256 === final.sha256, `${kind} reopen reused a session or lost its file identity`)
      assert(exported.base64 === saved.base64 && reopenedText === text && reopened.element.dataset.kind === kind, `${kind} reopen lost content or classification`)
      result.reopened = { keyChanged: true, fileId: saved.id, kind, sha256: final.sha256, snapshot, exportedBase64: exported.base64, text: reopenedText, visibleText: visibleText(reopened.element, kind) }
      report.checks.push(WORKFLOW_NATIVE_CHECKS[check + 2]!)
      await bounded(adapter.close(reopened.key), `close reopened ${kind}`); keys.pop(); closedDocuments++
      assert(!reopened.element.isConnected, `${kind} reopened editor survived closing`)
      result.cleanup = { closedDocuments: 2 }; report.checks.push(WORKFLOW_NATIVE_CHECKS[check + 3]!)
    }
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    unobserve?.()
    try { for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close workflow'); closedDocuments++ } report.cleanup = { closedDocuments } }
    catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    if (report.error || report.cleanupError) {
      try {
        const cleanup = await bounded(invoke<{ temporaryFilesRemoved: boolean }>('smoke_cleanup_autosave'), 'failed workflow fixture cleanup')
        assert(cleanup.temporaryFilesRemoved, 'failed workflow fixture cleanup is incomplete'); report.failedRunTemporaryFilesRemoved = true
      } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    }
    await adapter.setAutosave(preference)
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === WORKFLOW_NATIVE_CHECKS.length
  return report
}
