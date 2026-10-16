import { invoke, isTauri } from '@tauri-apps/api/core'
import * as native from '../native'
import type { EditorHandle } from '../shared/document'
import type { NativeDocument, SaveDocumentRequest, SaveResult } from '../types'

export const NOTEBOOK_NATIVE_CHECKS = [
  'mounted-notebook-dom-input',
  'global-save-writes-approved-notebook-file',
  'native-file-readback-reopens-in-new-notebook-session',
  'notebook-tabs-and-editors-closed',
] as const
export const NOTEBOOK_NATIVE_LIMITATIONS = [
  'The isolated temporary file is provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM input in the installed native WebView; physical keyboard input and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
] as const
const PAGE_TITLE = '原生笔记 Native notebook'
const PAGE_TEXT = 'NATIVE_NOTEBOOK_EDIT 本地保存与重开'
type Snapshot = { documentId: number; revision: number; dirty: boolean }
type NotebookEditor = EditorHandle & { inspect(): Promise<Snapshot>; markSaved(base64: string): Promise<void> }
type SaveReceipt = {
  documentId?: string; extension: string; expectedSha256?: string; saveAs: boolean; status: string
  savedId?: string; savedSha256?: string; savedSizeBytes?: number
}
export interface NotebookNativeSmokeAdapter {
  open(source: NativeDocument): Promise<{ key: string; element: HTMLElement; editor: NotebookEditor }>
  bindTemporaryFile(key: string, file: NativeDocument): Promise<void>
  state(key: string): { active: boolean; ready: boolean; dirty: boolean; busy: boolean; fileId?: string; sha256: string; modal: boolean }
  autosaveEnabled(): boolean
  setAutosave(enabled: boolean): Promise<void>
  observeNativeSaves(observer: (request: SaveDocumentRequest, result: SaveResult) => void): () => void
  close(key: string): Promise<void>
}
export interface NotebookNativeSmokeReport {
  schemaVersion: 1; kind: 'notebook-native'; transport: 'native-webview-ipc'; ok: boolean
  native: { tauri: true; origin: string }; checks: string[]; limitations: string[]
  editing?: { title: string; text: string; bodyInputEvents: number; titleInputEvents: number; before: Snapshot; after: Snapshot }
  persistence?: { targetId: string; initialBase64: string; initialSha256: string; initialSizeBytes: number; readbackBase64: string; finalSha256: string; finalSizeBytes: number; saves: SaveReceipt[]; dialogObserved: boolean; saved: Snapshot }
  reopened?: { keyChanged: boolean; fileId: string; sha256: string; snapshot: Snapshot; exportedBase64: string; title: string; text: string }
  cleanup?: { closedDocuments: number }
  failedRunTemporaryFilesRemoved?: boolean
  error?: string; cleanupError?: string
}
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`Native notebook: ${message}`) }
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert(Date.now() < deadline, `${label} timed out`); await new Promise(resolve => setTimeout(resolve, 30)) }
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Native notebook: ${label} timed out`)), 20000) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
async function digest(base64: string) {
  const bytes = native.base64ToBytes(base64), hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.length }
}

/** Installed WebView + normal global Save + native disk readback, never a browser acceptance substitute. */
export async function runNotebookNativeSmoke(adapter: NotebookNativeSmokeAdapter): Promise<NotebookNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for notebook verification')
  const report: NotebookNativeSmokeReport = { schemaVersion: 1, kind: 'notebook-native', transport: 'native-webview-ipc', ok: false,
    native: { tauri: true, origin: location.origin }, checks: [], limitations: [...NOTEBOOK_NATIVE_LIMITATIONS] }
  const keys: string[] = [], preference = adapter.autosaveEnabled()
  let unobserve: (() => void) | undefined, closedDocuments = 0
  try {
    await adapter.setAutosave(false)
    const mounted = await bounded(adapter.open({ id: '', kind: 'note', extension: 'oonote', name: 'native-notebook.oonote', base64: '', sha256: '', sizeBytes: 0 }), 'new notebook')
    keys.push(mounted.key)
    const baseline = await bounded(mounted.editor.exportFile({ format: 'oonote' }), 'blank notebook export')
    const initial = await digest(baseline.base64)
    const temporary = await bounded(invoke<NativeDocument>('smoke_prepare_document', { base64: baseline.base64, extension: 'oonote' }), 'isolated notebook file')
    assert(temporary.kind === 'note' && temporary.extension === 'oonote' && temporary.sha256 === initial.sha256 && temporary.sizeBytes === initial.sizeBytes && temporary.base64 === baseline.base64, 'temporary file differs from blank notebook')
    await adapter.bindTemporaryFile(mounted.key, temporary)
    await mounted.editor.markSaved(baseline.base64)
    const before = await mounted.editor.inspect(), body = mounted.element.querySelector<HTMLElement>('[data-testid="notebook-content"]')
    const title = mounted.element.querySelector<HTMLInputElement>('[aria-label="页面标题"]')
    assert(body && title && mounted.element.isConnected && mounted.element.getBoundingClientRect().width > 0, 'mounted notebook controls missing')
    await waitFor(() => body.isContentEditable && !title.disabled && !adapter.state(mounted.key).busy, 'editable notebook controls')
    assert(!before.dirty && before.revision === 0 && !adapter.state(mounted.key).dirty && adapter.state(mounted.key).active, 'new notebook was not clean and active')
    let titleInputEvents = 0, bodyInputEvents = 0
    const titleInput = () => titleInputEvents++, bodyInput = () => bodyInputEvents++
    title.addEventListener('input', titleInput); body.addEventListener('input', bodyInput)
    try {
      title.focus(); title.value = PAGE_TITLE
      title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: PAGE_TITLE }))
      body.focus()
      const selection = window.getSelection(), range = document.createRange()
      assert(selection, 'native WebView selection unavailable')
      range.selectNodeContents(body.firstElementChild ?? body); selection.removeAllRanges(); selection.addRange(range)
      assert(document.execCommand('insertText', false, PAGE_TEXT), 'native contenteditable insertion failed')
      await waitFor(async () => (await mounted.editor.inspect()).dirty && adapter.state(mounted.key).dirty, 'notebook DOM input')
    } finally { title.removeEventListener('input', titleInput); body.removeEventListener('input', bodyInput) }
    const after = await mounted.editor.inspect()
    assert(bodyInputEvents > 0 && titleInputEvents > 0 && title.value === PAGE_TITLE && body.textContent === PAGE_TEXT && after.documentId === before.documentId && after.revision > before.revision, 'DOM input did not reach notebook model')
    report.editing = { title: title.value, text: body.textContent, bodyInputEvents, titleInputEvents, before, after }
    report.checks.push(NOTEBOOK_NATIVE_CHECKS[0])
    const saves: SaveReceipt[] = []
    unobserve = adapter.observeNativeSaves((request, result) => saves.push({ documentId: request.documentId, extension: request.extension,
      expectedSha256: request.expectedSha256, saveAs: request.saveAs === true, status: result.status,
      ...(result.status === 'saved' ? { savedId: result.document.id, savedSha256: result.document.sha256, savedSizeBytes: result.document.sizeBytes } : {}) }))
    const saveButton = document.querySelector<HTMLButtonElement>('[data-testid="shell-save"]')
    assert(saveButton && !saveButton.disabled, 'global save button unavailable')
    let dialogObserved = !!document.querySelector('[role="dialog"]')
    const observeDialogs = new MutationObserver(() => { dialogObserved ||= !!document.querySelector('[role="dialog"]') })
    observeDialogs.observe(document.body, { subtree: true, childList: true })
    try {
      saveButton.click()
      await waitFor(() => { const state = adapter.state(mounted.key); dialogObserved ||= state.modal
        return saves.length > 0 && !state.busy && !state.dirty && state.sha256 !== initial.sha256 }, 'global native notebook save')
    } finally { observeDialogs.disconnect() }
    unobserve(); unobserve = undefined
    const saved = await bounded(native.openRecent(temporary.id), 'notebook disk readback'), final = await digest(saved.base64)
    const savedSnapshot = await mounted.editor.inspect()
    assert(saved.id === temporary.id && saved.kind === 'note' && saved.extension === 'oonote' && saved.sha256 === final.sha256 && saved.sizeBytes === final.sizeBytes && final.sha256 !== initial.sha256, 'native notebook readback differs')
    assert(saves.length === 1 && saves[0]!.status === 'saved' && saves[0]!.documentId === temporary.id && saves[0]!.savedId === temporary.id && saves[0]!.expectedSha256 === initial.sha256 && saves[0]!.savedSha256 === final.sha256 && saves[0]!.savedSizeBytes === final.sizeBytes && !saves[0]!.saveAs, 'notebook save did not write its approved original file')
    assert(!dialogObserved && !savedSnapshot.dirty && savedSnapshot.documentId === after.documentId && savedSnapshot.revision === after.revision, 'notebook save acknowledgement or dialog state differs')
    report.persistence = { targetId: temporary.id, initialBase64: baseline.base64, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes,
      readbackBase64: saved.base64, finalSha256: final.sha256, finalSizeBytes: final.sizeBytes, saves, dialogObserved, saved: savedSnapshot }
    report.checks.push(NOTEBOOK_NATIVE_CHECKS[1])
    await bounded(adapter.close(mounted.key), 'close original notebook'); keys.pop(); closedDocuments++
    assert(!mounted.element.isConnected, 'closed notebook editor survived')
    const reopened = await bounded(adapter.open(saved), 'reopen notebook from disk'); keys.push(reopened.key)
    const snapshot = await reopened.editor.inspect(), exported = await reopened.editor.exportFile({ format: 'oonote' })
    const reopenedTitle = reopened.element.querySelector<HTMLInputElement>('[aria-label="页面标题"]')?.value
    const reopenedText = reopened.element.querySelector<HTMLElement>('[data-testid="notebook-content"]')?.textContent
    const reopenedState = adapter.state(reopened.key)
    assert(reopened.key !== mounted.key && snapshot.documentId !== after.documentId && !snapshot.dirty && snapshot.revision === 0 && reopenedState.active && !reopenedState.dirty && reopenedState.fileId === saved.id && reopenedState.sha256 === final.sha256, 'reopen reused a session or lost native file identity')
    assert(exported.base64 === saved.base64 && reopenedTitle === PAGE_TITLE && reopenedText === PAGE_TEXT, 'notebook reopen lost saved content')
    report.reopened = { keyChanged: true, fileId: saved.id, sha256: final.sha256, snapshot, exportedBase64: exported.base64, title: reopenedTitle, text: reopenedText }
    report.checks.push(NOTEBOOK_NATIVE_CHECKS[2])
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    unobserve?.()
    try {
      for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close notebook'); closedDocuments++ }
      report.cleanup = { closedDocuments }
      if (closedDocuments === 2) report.checks.push(NOTEBOOK_NATIVE_CHECKS[3])
    } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    // A failed notebook check aborts before the workspace check can remove the
    // shared fixture directory. Clean it here only on that failure path.
    if (report.error || report.cleanupError) {
      try {
        const cleanup = await bounded(invoke<{ temporaryFilesRemoved: boolean }>('smoke_cleanup_autosave'), 'failed notebook fixture cleanup')
        assert(cleanup.temporaryFilesRemoved, 'failed notebook fixture cleanup is incomplete')
        report.failedRunTemporaryFilesRemoved = true
      } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    }
    await adapter.setAutosave(preference)
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === NOTEBOOK_NATIVE_CHECKS.length
  return report
}
