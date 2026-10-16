import { invoke, isTauri } from '@tauri-apps/api/core'
import * as native from '../native'
import type { NativeDocument, SaveDocumentRequest, SaveResult } from '../types'
import { focusOfficeWordCanvas, type OfficeWordSmokeEditor } from '../word/rust/office-word-native-smoke'
import { AUTOSAVE_INTERVAL_MS } from './autosave'

export const WORKSPACE_NATIVE_CHECKS = [
  'real-autosave-timer-writes-approved-temporary-file',
  'saved-file-readback-reopened-in-rust',
  'native-temporary-file-and-session-cleanup',
] as const

export interface WorkspaceNativeSmokeReport {
  schemaVersion: 2
  kind: 'workspace-native'
  transport: 'native-webview-ipc'
  ok: boolean
  native: { tauri: true; origin: string }
  checks: string[]
  limitations: string[]
  autosave?: {
    intervalMs: number
    elapsedMs: number
    targetId: string
    initialBase64: string
    initialSha256: string
    initialSizeBytes: number
    finalSha256: string
    finalSizeBytes: number
    readbackBase64: string
    beforeRevision: number
    afterRevision: number
    beforeDirty: boolean
    afterDirty: boolean
    focusRetained: boolean
    blurEvents: number
    dialogObserved: boolean
    reopenedText: string
    expectedText: string
    saves: Array<{
      documentId?: string
      extension: string
      expectedSha256?: string
      saveAs: boolean
      status: string
      savedId?: string
      savedSha256?: string
      savedSizeBytes?: number
    }>
  }
  cleanup?: { temporaryFilesRemoved: boolean; closedDocuments: number }
  error?: string
  cleanupError?: string
}
export interface WorkspaceNativeSmokeAdapter {
  openWord(source: NativeDocument): Promise<{ key: string; editor: OfficeWordSmokeEditor }>
  /** Provision only the isolated smoke file capability; the save itself uses the normal scheduler. */
  bindTemporaryFile(key: string, file: NativeDocument): Promise<void>
  state(key: string): { active: boolean; dirty: boolean; ready: boolean; saving: boolean; fileId?: string; requiresSaveAs: boolean; sha256: string; modal: boolean }
  autosaveEnabled(): boolean
  setAutosave(enabled: boolean): Promise<void>
  observeNativeSaves(observer: (request: SaveDocumentRequest, result: SaveResult) => void): () => void
  close(key: string): Promise<void>
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(`Workspace native: ${message}`)
}
async function digest(base64: string) {
  const bytes = native.base64ToBytes(base64)
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.byteLength }
}
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Workspace native: ${label} timed out`)), milliseconds) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Runs only inside an installed native WebView; no browser success substitute. */
export async function runWorkspaceNativeSmoke(adapter: WorkspaceNativeSmokeAdapter): Promise<WorkspaceNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for workspace verification')
  const report: WorkspaceNativeSmokeReport = {
    schemaVersion: 2, kind: 'workspace-native', transport: 'native-webview-ipc', ok: false,
    native: { tauri: true, origin: location.origin }, checks: [],
    limitations: [
      'The temporary file capability is provisioned by a smoke-only native command; native file chooser interaction is not covered.',
      'Text edits use the real Rust command interface; physical keyboard input and operating-system IME are not covered.',
    ],
  }
  const keys: string[] = [], preference = adapter.autosaveEnabled()
  let unobserve: (() => void) | undefined, removeBlurListener: (() => void) | undefined
  let closedDocuments = 0
  try {
    await adapter.setAutosave(false)
    const mounted = await bounded(adapter.openWord({ id: '', kind: 'word', extension: 'docx', name: 'native-workspace.docx', base64: '', sha256: '', sizeBytes: 0 }), 'new autosave document')
    keys.push(mounted.key)
    const editor = mounted.editor
    const baselineText = 'NATIVE_AUTOSAVE_BASE 中文'
    const expectedText = `${baselineText} NATIVE_AUTOSAVE_EDIT 已保存`
    await bounded(editor.command('text.insert', { text: baselineText }), 'initial Rust text')
    assert(await editor.canBackgroundExport?.(), 'new Word model has an unfinished draft')
    const baseline = await bounded(editor.exportFile({ format: 'docx', background: true }), 'baseline DOCX export')
    const temporary = await bounded(invoke<NativeDocument>('smoke_prepare_document', { base64: baseline.base64, extension: 'docx' }), 'temporary approved file')
    const initial = await digest(baseline.base64)
    assert(temporary.sha256 === initial.sha256 && temporary.sizeBytes === initial.sizeBytes && temporary.base64 === baseline.base64, 'temporary file bytes differ from the exported baseline')
    await adapter.bindTemporaryFile(mounted.key, temporary)
    await editor.markSaved?.(baseline.base64, { background: true })

    await editor.command('caret.docEnd')
    const modified = await editor.command('text.insert', { text: ' NATIVE_AUTOSAVE_EDIT 已保存' })
    assert(modified.dirty && modified.text === expectedText, 'real Word edit did not become dirty')
    const saves: NonNullable<WorkspaceNativeSmokeReport['autosave']>['saves'] = []
    unobserve = adapter.observeNativeSaves((request, result) => {
      saves.push({ documentId: request.documentId, extension: request.extension, expectedSha256: request.expectedSha256, saveAs: request.saveAs === true, status: result.status,
        ...(result.status === 'saved' ? { savedId: result.document.id, savedSha256: result.document.sha256, savedSizeBytes: result.document.sizeBytes } : {}) })
    })
    const session = await editor.inspect()
    const element = [...document.querySelectorAll<HTMLElement>('[data-testid="rust-word-editor"]')].find(node => node.dataset.sessionId === session.sessionId)
    assert(element, 'mounted Word editor is missing before autosave')
    // DOM canvas focus alone does not establish Rust's editing focus. Reuse the
    // already verified pointer path, then observe the real text-input agent.
    // Its normal canvas-to-input handoff must finish before the save interval.
    await focusOfficeWordCanvas({ ...mounted, element })
    const focus = element.querySelector<HTMLInputElement>('[data-testid="office-word-input"]')
    assert(focus, 'native Word input agent is missing before autosave')
    focus.focus({ preventScroll: true })
    assert(document.activeElement === focus, 'native Word input did not retain focus')
    let blurEvents = 0, dialogObserved = false
    const onBlur = () => { blurEvents++ }
    focus?.addEventListener('blur', onBlur)
    removeBlurListener = () => focus?.removeEventListener('blur', onBlur)
    const beforeSave = await editor.inspect(), initialState = adapter.state(mounted.key)
    assert(initialState.active && initialState.fileId === temporary.id && !initialState.requiresSaveAs && initialState.dirty && initialState.ready && beforeSave.dirty, 'autosave has no approved dirty native target')
    const startedAt = Date.now()
    await adapter.setAutosave(true)
    const deadline = startedAt + AUTOSAVE_INTERVAL_MS + 20000
    while (true) {
      const state = adapter.state(mounted.key)
      dialogObserved ||= state.modal || !!document.querySelector('[role="dialog"]')
      assert(state.active && state.fileId === temporary.id, 'autosave changed the active target')
      // The saved receipt reaches the tab before refreshRecents finishes. Wait
      // for the scheduler transaction too, so reopening cannot race its lock.
      if (!state.dirty && !state.saving && state.sha256 !== initial.sha256) break
      assert(Date.now() < deadline, 'normal autosave timer did not persist the document')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const elapsedMs = Date.now() - startedAt
    await adapter.setAutosave(false)
    const afterSave = await editor.inspect()
    const saved = await bounded(native.openRecent(temporary.id), 'native saved-file readback')
    const final = await digest(saved.base64)
    assert(elapsedMs >= AUTOSAVE_INTERVAL_MS && saved.id === temporary.id && saved.sha256 === final.sha256 && saved.sizeBytes === final.sizeBytes && final.sha256 !== initial.sha256, 'autosave did not write and read back the approved file after the normal interval')
    assert(saves.length === 1 && saves[0]!.status === 'saved' && saves[0]!.documentId === temporary.id && saves[0]!.savedId === temporary.id && saves[0]!.expectedSha256 === initial.sha256 && saves[0]!.savedSha256 === final.sha256 && saves[0]!.saveAs === false, 'autosave bypassed the normal direct save request')
    report.autosave = { intervalMs: AUTOSAVE_INTERVAL_MS, elapsedMs, targetId: temporary.id, initialBase64: temporary.base64, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes, finalSha256: final.sha256, finalSizeBytes: final.sizeBytes,
      readbackBase64: saved.base64, beforeRevision: beforeSave.revision, afterRevision: afterSave.revision, beforeDirty: beforeSave.dirty, afterDirty: afterSave.dirty,
      focusRetained: document.activeElement === focus, blurEvents, dialogObserved, expectedText, reopenedText: '', saves }
    assert(!afterSave.dirty, 'autosave left the Rust document dirty after its saved receipt')
    assert(afterSave.revision === beforeSave.revision, 'autosave acknowledged a different edited revision')
    assert(!dialogObserved, 'autosave displayed a document dialog')
    assert(document.activeElement === focus, 'autosave changed the focused editor element')
    assert(blurEvents === 0, 'autosave blurred the focused editor element')
    report.checks.push(WORKSPACE_NATIVE_CHECKS[0])
    removeBlurListener(); removeBlurListener = undefined
    unobserve(); unobserve = undefined
    const reopened = await bounded(adapter.openWord(saved), 'saved file reopened in Rust')
    keys.push(reopened.key)
    const reopenedState = await reopened.editor.inspect()
    assert(reopenedState.text === expectedText, 'file readback lost the autosaved text')
    report.autosave.reopenedText = reopenedState.text
    report.checks.push(WORKSPACE_NATIVE_CHECKS[1])
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    removeBlurListener?.(); unobserve?.()
    try {
      await adapter.setAutosave(false)
      for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close smoke document'); closedDocuments++ }
      const cleanup = await bounded(invoke<{ temporaryFilesRemoved: boolean }>('smoke_cleanup_autosave'), 'native smoke cleanup')
      assert(cleanup.temporaryFilesRemoved, 'native smoke cleanup is incomplete')
      report.cleanup = { ...cleanup, closedDocuments }
      report.checks.push(WORKSPACE_NATIVE_CHECKS[2])
    } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    await adapter.setAutosave(preference)
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === WORKSPACE_NATIVE_CHECKS.length
  return report
}
