import { invoke, isTauri } from '@tauri-apps/api/core'
import * as native from '../native'
import type { EditorHandle } from '../shared/document'
import type { NativeDocument, SaveDocumentRequest, SaveResult } from '../types'

export const CALENDAR_NATIVE_CHECKS = [
  'mounted-calendar-dom-input',
  'global-save-writes-approved-calendar-file',
  'native-file-readback-reopens-in-new-calendar-session',
  'calendar-tabs-and-editors-closed',
] as const
export const CALENDAR_NATIVE_LIMITATIONS = [
  'The isolated temporary file is provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM input in the installed native WebView; physical keyboard input and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
] as const
const PAGE_TITLE = '原生日历 Native calendar'
const NOTE_DATE = '2026-11-04'
const NOTE_COLOR = '#3b82f6'
const NOTE_TYPE = '工作日'
const PAGE_TEXT = 'NATIVE_CALENDAR_EDIT 本地保存与重开'
type Snapshot = { documentId: number; revision: number; dirty: boolean }
type CalendarEditor = EditorHandle & { inspect(): Promise<Snapshot>; markSaved(base64: string): Promise<void> }
type SaveReceipt = {
  documentId?: string; extension: string; expectedSha256?: string; saveAs: boolean; status: string
  savedId?: string; savedKind?: string; savedSha256?: string; savedSizeBytes?: number
}
export interface CalendarNativeSmokeAdapter {
  open(source: NativeDocument): Promise<{ key: string; element: HTMLElement; editor: CalendarEditor }>
  bindTemporaryFile(key: string, file: NativeDocument): Promise<void>
  state(key: string): { active: boolean; ready: boolean; dirty: boolean; busy: boolean; fileId?: string; sha256: string; modal: boolean }
  autosaveEnabled(): boolean
  setAutosave(enabled: boolean): Promise<void>
  observeNativeSaves(observer: (request: SaveDocumentRequest, result: SaveResult) => void): () => void
  close(key: string): Promise<void>
}
export interface CalendarNativeSmokeReport {
  schemaVersion: 1; kind: 'calendar-native'; transport: 'native-webview-ipc'; ok: boolean
  native: { tauri: true; origin: string }; checks: string[]; limitations: string[]
  editing?: { title: string; text: string; date: string; color: string; type: string; bodyInputEvents: number; titleInputEvents: number; before: Snapshot; after: Snapshot }
  persistence?: { targetId: string; initialBase64: string; initialSha256: string; initialSizeBytes: number; readbackBase64: string; finalSha256: string; finalSizeBytes: number; saves: SaveReceipt[]; dialogObserved: boolean; saved: Snapshot }
  reopened?: { keyChanged: boolean; fileId: string; sha256: string; snapshot: Snapshot; exportedBase64: string; title: string; text: string; date: string }
  cleanup?: { closedDocuments: number }
  failedRunTemporaryFilesRemoved?: boolean
  error?: string; cleanupError?: string
}
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`Native calendar: ${message}`) }
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert(Date.now() < deadline, `${label} timed out`); await new Promise(resolve => setTimeout(resolve, 30)) }
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Native calendar: ${label} timed out`)), 20000) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
async function digest(base64: string) {
  const bytes = native.base64ToBytes(base64), hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return { sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.length }
}

/** Installed WebView + normal global Save + native disk readback, never a browser acceptance substitute. */
export async function runCalendarNativeSmoke(adapter: CalendarNativeSmokeAdapter): Promise<CalendarNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for calendar verification')
  const report: CalendarNativeSmokeReport = { schemaVersion: 1, kind: 'calendar-native', transport: 'native-webview-ipc', ok: false,
    native: { tauri: true, origin: location.origin }, checks: [], limitations: [...CALENDAR_NATIVE_LIMITATIONS] }
  const keys: string[] = [], preference = adapter.autosaveEnabled()
  let unobserve: (() => void) | undefined, closedDocuments = 0
  try {
    await adapter.setAutosave(false)
    const mounted = await bounded(adapter.open({ id: '', kind: 'calendar', extension: 'oocalendar', name: 'native-calendar.oocalendar', base64: '', sha256: '', sizeBytes: 0 }), 'new calendar')
    keys.push(mounted.key)
    const baseline = await bounded(mounted.editor.exportFile({ format: 'oocalendar' }), 'blank calendar export')
    const initial = await digest(baseline.base64)
    const temporary = await bounded(invoke<NativeDocument>('smoke_prepare_document', { base64: baseline.base64, extension: 'oocalendar' }), 'isolated calendar file')
    assert(temporary.kind === 'calendar' && temporary.extension === 'oocalendar' && temporary.sha256 === initial.sha256 && temporary.sizeBytes === initial.sizeBytes && temporary.base64 === baseline.base64, 'temporary file differs from blank calendar')
    await adapter.bindTemporaryFile(mounted.key, temporary)
    await mounted.editor.markSaved(baseline.base64)
    const before = await mounted.editor.inspect()
    assert(mounted.element.isConnected && mounted.element.getBoundingClientRect().width > 0, 'mounted calendar is missing')
    assert(!before.dirty && before.revision === 0 && !adapter.state(mounted.key).dirty && adapter.state(mounted.key).active, 'new calendar was not clean and active')
    const month = mounted.element.querySelector<HTMLInputElement>('[data-testid="calendar-month"]')
    assert(month && !month.disabled, 'month control missing')
    month.value = NOTE_DATE.slice(0, 7); month.dispatchEvent(new Event('input', { bubbles: true })); month.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => !!mounted.element.querySelector(`[data-testid="calendar-day-${NOTE_DATE}"]`), 'calendar target month')
    const day = mounted.element.querySelector<HTMLElement>(`[data-testid="calendar-day-${NOTE_DATE}"]`)!
    day.click()
    assert(!document.querySelector('[data-testid="calendar-almanac-dialog"]'), 'date click opened almanac')
    day.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: day.getBoundingClientRect().left + 12, clientY: day.getBoundingClientRect().top + 12 }))
    await waitFor(() => !!document.querySelector('[data-testid="calendar-context-custom"]'), 'custom note context menu')
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-context-custom"]')!.click()
    await waitFor(() => !!document.querySelector('[data-testid="calendar-note-dialog"]'), 'custom note form')
    const title = document.querySelector<HTMLInputElement>('[data-testid="calendar-note-title"]')
    const body = document.querySelector<HTMLTextAreaElement>('[data-testid="calendar-note-content"]')
    const color = document.querySelector<HTMLInputElement>('[data-testid="calendar-note-color"]')
    const type = document.querySelector<HTMLSelectElement>('[data-testid="calendar-note-type"]')
    assert(title && body && color && type, 'custom note fields missing')
    let titleInputEvents = 0, bodyInputEvents = 0
    const titleInput = () => titleInputEvents++, bodyInput = () => bodyInputEvents++
    title.addEventListener('input', titleInput); body.addEventListener('input', bodyInput)
    try {
      for (const [field, value] of [[title, PAGE_TITLE], [body, PAGE_TEXT], [color, NOTE_COLOR], [type, NOTE_TYPE]] as const) {
        field.focus(); field.value = value
        field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid="calendar-note-confirm"]')?.disabled === false, 'valid custom note form')
      document.querySelector<HTMLButtonElement>('[data-testid="calendar-note-confirm"]')!.click()
      await waitFor(async () => !document.querySelector('[data-testid="calendar-note-dialog"]') && (await mounted.editor.inspect()).dirty && adapter.state(mounted.key).dirty, 'calendar DOM input')
    } finally { title.removeEventListener('input', titleInput); body.removeEventListener('input', bodyInput) }
    const after = await mounted.editor.inspect()
    assert(bodyInputEvents > 0 && titleInputEvents > 0 && after.documentId === before.documentId && after.revision > before.revision, 'DOM input did not reach calendar model')
    report.editing = { title: PAGE_TITLE, text: PAGE_TEXT, date: NOTE_DATE, color: NOTE_COLOR, type: NOTE_TYPE, bodyInputEvents, titleInputEvents, before, after }
    report.checks.push(CALENDAR_NATIVE_CHECKS[0])
    const saves: SaveReceipt[] = []
    unobserve = adapter.observeNativeSaves((request, result) => saves.push({ documentId: request.documentId, extension: request.extension,
      expectedSha256: request.expectedSha256, saveAs: request.saveAs === true, status: result.status,
      ...(result.status === 'saved' ? { savedId: result.document.id, savedKind: result.document.kind, savedSha256: result.document.sha256, savedSizeBytes: result.document.sizeBytes } : {}) }))
    const saveButton = document.querySelector<HTMLButtonElement>('[data-testid="shell-save"]')
    assert(saveButton && !saveButton.disabled, 'global save button unavailable')
    let dialogObserved = !!document.querySelector('[role="dialog"]')
    const observeDialogs = new MutationObserver(() => { dialogObserved ||= !!document.querySelector('[role="dialog"]') })
    observeDialogs.observe(document.body, { subtree: true, childList: true })
    try {
      saveButton.click()
      await waitFor(() => { const state = adapter.state(mounted.key); dialogObserved ||= state.modal
        return saves.length > 0 && !state.busy && !state.dirty && state.sha256 !== initial.sha256 }, 'global native calendar save')
    } finally { observeDialogs.disconnect() }
    unobserve(); unobserve = undefined
    const saved = await bounded(native.openRecent(temporary.id), 'calendar disk readback'), final = await digest(saved.base64)
    const savedSnapshot = await mounted.editor.inspect()
    assert(saved.id === temporary.id && saved.kind === 'calendar' && saved.extension === 'oocalendar' && saved.sha256 === final.sha256 && saved.sizeBytes === final.sizeBytes && final.sha256 !== initial.sha256, 'native calendar readback differs')
    assert(saves.length === 1 && saves[0]!.status === 'saved' && saves[0]!.documentId === temporary.id && saves[0]!.savedId === temporary.id && saves[0]!.expectedSha256 === initial.sha256 && saves[0]!.savedSha256 === final.sha256 && saves[0]!.savedSizeBytes === final.sizeBytes && !saves[0]!.saveAs, 'calendar save did not write its approved original file')
    assert(!dialogObserved && !savedSnapshot.dirty && savedSnapshot.documentId === after.documentId && savedSnapshot.revision === after.revision, 'calendar save acknowledgement or dialog state differs')
    report.persistence = { targetId: temporary.id, initialBase64: baseline.base64, initialSha256: initial.sha256, initialSizeBytes: initial.sizeBytes,
      readbackBase64: saved.base64, finalSha256: final.sha256, finalSizeBytes: final.sizeBytes, saves, dialogObserved, saved: savedSnapshot }
    report.checks.push(CALENDAR_NATIVE_CHECKS[1])
    await bounded(adapter.close(mounted.key), 'close original calendar'); keys.pop(); closedDocuments++
    assert(!mounted.element.isConnected, 'closed calendar editor survived')
    const reopened = await bounded(adapter.open(saved), 'reopen calendar from disk'); keys.push(reopened.key)
    const snapshot = await reopened.editor.inspect(), exported = await reopened.editor.exportFile({ format: 'oocalendar' })
    const reopenedMonth = reopened.element.querySelector<HTMLInputElement>('[data-testid="calendar-month"]')
    assert(reopenedMonth, 'reopened month control missing')
    reopenedMonth.value = NOTE_DATE.slice(0, 7); reopenedMonth.dispatchEvent(new Event('input', { bubbles: true })); reopenedMonth.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => !!reopened.element.querySelector(`[data-testid="calendar-day-${NOTE_DATE}"] [data-note-id]`), 'reopened note cell')
    const reopenedNote = reopened.element.querySelector<HTMLElement>(`[data-testid="calendar-day-${NOTE_DATE}"] [data-note-id]`)!
    assert(reopenedNote.textContent?.includes(PAGE_TITLE), 'reopened note title differs')
    reopenedNote.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await waitFor(() => !!document.querySelector('[data-testid="calendar-note-dialog"]'), 'reopened note details')
    const reopenedTitle = document.querySelector<HTMLInputElement>('[data-testid="calendar-note-title"]')?.value
    const reopenedText = document.querySelector<HTMLTextAreaElement>('[data-testid="calendar-note-content"]')?.value
    const reopenedDate = document.querySelector<HTMLInputElement>('[data-testid="calendar-note-date"]')?.value
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-note-cancel"]')!.click()
    await waitFor(() => !document.querySelector('[data-testid="calendar-note-dialog"]'), 'close reopened details')
    const reopenedState = adapter.state(reopened.key)
    assert(reopened.key !== mounted.key && snapshot.documentId !== after.documentId && !snapshot.dirty && snapshot.revision === 0 && reopenedState.active && !reopenedState.dirty && reopenedState.fileId === saved.id && reopenedState.sha256 === final.sha256, 'reopen reused a session or lost native file identity')
    assert(exported.base64 === saved.base64 && reopenedTitle === PAGE_TITLE && reopenedText === PAGE_TEXT && reopenedDate === NOTE_DATE, 'calendar reopen lost saved content')
    report.reopened = { keyChanged: true, fileId: saved.id, sha256: final.sha256, snapshot, exportedBase64: exported.base64, title: reopenedTitle, text: reopenedText, date: reopenedDate }
    report.checks.push(CALENDAR_NATIVE_CHECKS[2])
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    unobserve?.()
    try {
      for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close calendar'); closedDocuments++ }
      report.cleanup = { closedDocuments }
      if (closedDocuments === 2) report.checks.push(CALENDAR_NATIVE_CHECKS[3])
    } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    // A failed calendar check aborts before the workspace check can remove the
    // shared fixture directory. Clean it here only on that failure path.
    if (report.error || report.cleanupError) {
      try {
        const cleanup = await bounded(invoke<{ temporaryFilesRemoved: boolean }>('smoke_cleanup_autosave'), 'failed calendar fixture cleanup')
        assert(cleanup.temporaryFilesRemoved, 'failed calendar fixture cleanup is incomplete')
        report.failedRunTemporaryFilesRemoved = true
      } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
    }
    await adapter.setAutosave(preference)
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === CALENDAR_NATIVE_CHECKS.length
  return report
}
