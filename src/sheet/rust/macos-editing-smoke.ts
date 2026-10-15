import { isTauri } from '@tauri-apps/api/core'
import { smokeRequested, smokeStage } from '../../smoke'
import type { GridcraftSmokeEditor } from './gridcraft-native-smoke'
import type { WordcraftSmokeEditor } from '../../word/rust/wordcraft-native-smoke'

type Kind = 'sheet' | 'word'
type Snapshot = Awaited<ReturnType<GridcraftSmokeEditor['inspect']>> | Awaited<ReturnType<WordcraftSmokeEditor['inspect']>>
export interface EditingSmokeMount {
  key: string
  kind: Kind
  element: HTMLElement
  editor: {
    inspect(): Promise<Snapshot>
    command(id: string, params?: Record<string, unknown>): Promise<unknown>
    query?(id: string, params?: Record<string, unknown>): Promise<unknown>
  }
}
export interface EditingSmokeAdapter {
  open(kind: Kind, name: string): Promise<EditingSmokeMount>
  activate(key: string): Promise<void>
  activeKey(): string
  tabs(): Array<{ key: string; kind: string; dirty: boolean; ready: boolean }>
  shell(): { home: boolean; tabCount: number; workspaceDisplay: string; visibleTabCount: number }
  close(key: string): Promise<void>
}
export interface EditingInputRequest {
  actionId: string
  kind: 'click' | 'doubleClick' | 'type' | 'key'
  clientX?: number
  clientY?: number
  text?: string
  key?: 'Enter' | 'Escape' | 'F2'
  viewportWidth: number
  viewportHeight: number
}
interface Boot { bootId: string; timeOrigin: number }
interface RecordedEvent { type: string; isTrusted: boolean; target: string; key?: string; detail?: number; clientX?: number; clientY?: number }
interface Identity { key: string; kind: Kind; sessionId: string; documentId: number }
interface Action { actionId: string; kind: string; target: string; events: RecordedEvent[]; before: unknown; after?: unknown; completed: boolean }
interface DomTimelineScope { root: HTMLElement; canvas: Element | null; input: Element | null; actionId: string; sessionId: string }
export interface EditingSmokeOptions { editEntry?: 'doubleclick' | 'f2' | 'preselect' }
export interface MacosEditingReport {
  schemaVersion: 1
  kind: 'macos-editing'
  transport: 'local-wasm-in-native-webview' | 'local-wasm-in-browser'
  editEntry: 'doubleclick' | 'f2' | 'preselect'
  diagnosticOnly: boolean
  ok: boolean
  bootId: string
  timeOrigin: number
  checks: string[]
  sessions: Identity[]
  initialTabIds: string[]
  finalTabIds: string[]
  actions: Action[]
  observations: Record<string, unknown>
  preselectionHold?: { startedAtMs: number; finishedAtMs?: number; durationMs?: number }
  lastState?: unknown
  cleanup: { attempted: number; closed: number; ok: boolean }
  error?: string
  closeError?: string
}
export const MACOS_EDITING_CHECKS = [
  'two-cold-spreadsheet-sessions',
  'sheet-single-click-native-typing',
  'sheet-double-click-native-typing',
  'sheet-ribbon-native-formatting',
  'sheet-command-path-editing',
  'sheet-global-native-undo',
  'word-trusted-native-edit',
  'original-tabs-and-session-identities-preserved',
] as const
// The F2 control experiment cannot supply the double-click release check.
export const MACOS_EDITING_F2_CHECKS = MACOS_EDITING_CHECKS.map(check =>
  check === 'sheet-double-click-native-typing' ? 'sheet-f2-native-typing' : check)
export const MACOS_EDITING_PRESELECT_CHECKS = MACOS_EDITING_CHECKS.map(check =>
  check === 'sheet-double-click-native-typing' ? 'sheet-preselect-native-typing' : check)

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`macOS editing: ${message}`) }
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 20000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error(`macOS editing: ${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timeout) }
}
async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean, label: string): Promise<T> {
  const deadline = performance.now() + 20000
  do { const value = await bounded(read(), label); if (valid(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)) } while (performance.now() < deadline)
  throw Error(`macOS editing: ${label} timed out`)
}
const frame = () => bounded(new Promise<void>(resolve => requestAnimationFrame(() => resolve())), 'rendered frame')

/** Diagnostic metadata only: never read an input value, selection text, key,
 * label, or arbitrary DOM attribute, and never change focus or event defaults. */
export function createEditingDomTimeline(bootId: string, enabled: boolean, emit: (detail: string) => void) {
  const names = ['pointerdown', 'pointerup', 'dblclick', 'focus', 'blur', 'selectionchange']
  let scope: DomTimelineScope | undefined, sequence = 0, listening = false, stopped = false
  function classify(target: EventTarget | null): string {
    if (!target) return 'none'
    if (target === scope?.canvas) return 'canvas'
    if (target === scope?.input) return 'input'
    if (target === document) return 'document'
    if (target === document.body) return 'body'
    return target instanceof Node && scope?.root.contains(target) ? 'sheet' : 'outside'
  }
  function record(type: string, trusted: boolean, target: string) {
    if (!scope || sequence >= 60) return
    const detail = JSON.stringify({ seq: sequence + 1, actionId: scope.actionId, type, trusted, target,
      activeElement: classify(document.activeElement), bootId, sessionId: scope.sessionId })
    // Native smoke notes cap detail at 400 characters. Keep complete identities
    // and valid JSON; never silently truncate an oversized identity.
    if (detail.length > 400) return
    sequence++
    emit(detail)
  }
  function capture(event: Event) {
    if (!scope || sequence >= 60) return
    const target = classify(event.target)
    if (event.type === 'selectionchange') {
      if (!['canvas', 'input', 'sheet'].includes(classify(document.activeElement))) return
    } else if (event.type === 'focus' || event.type === 'blur') {
      if (target !== 'canvas' && target !== 'input') return
    } else if (!['canvas', 'input', 'sheet'].includes(target)) return
    record(event.type, event.isTrusted, target)
  }
  return {
    begin(next: DomTimelineScope) {
      scope = undefined
      if (!enabled || stopped || sequence >= 60) return
      // The values are generated diagnostic IDs, not user-facing document names.
      if (!/^[a-zA-Z0-9-]{36}$/.test(bootId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(next.actionId)
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(next.sessionId)) return
      scope = next
      if (!listening) {
        for (const name of names) window.addEventListener(name, capture, { capture: true, passive: true })
        listening = true
      }
      record('action-start', false, 'sheet')
    },
    end() { record('action-end', false, 'sheet'); scope = undefined },
    stop() {
      scope = undefined; stopped = true
      if (listening) for (const name of names) window.removeEventListener(name, capture, true)
      listening = false
    },
  }
}

function readBoot(): Boot {
  const value = (window as Window & { __OPEN_OFFICE_DIAGNOSTIC_BOOT__?: Boot }).__OPEN_OFFICE_DIAGNOSTIC_BOOT__
  // WebKit converts its monotonic origin to wall time on each getter call:
  // https://github.com/WebKit/WebKit/blob/f38c61096af22dabaf3a5e97242e513c71f29c1e/Source/WebCore/page/Performance.cpp
  // GenericTimeMixin::approximate() samples both clocks again, so a repeated
  // performance.timeOrigin read need not equal the immutable captured value.
  // Identity remains exact against the initial marker and native startup event.
  const valid = value && typeof value.bootId === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId)
    && Number.isFinite(value.timeOrigin) && value.timeOrigin > 0
  if (!valid) {
    const detail = { markerType: typeof value, bootIdType: typeof value?.bootId,
      bootId: typeof value?.bootId === 'string' ? value.bootId.slice(0, 64).replace(/[^a-zA-Z0-9-]/g, '?') : null,
      storedTimeOrigin: typeof value?.timeOrigin === 'number' ? String(value.timeOrigin) : `<${typeof value?.timeOrigin}>` }
    assert(false, `native initialization boot marker is missing or invalid: ${JSON.stringify(detail)}`)
  }
  return value
}
function identity(mount: EditingSmokeMount, state: Snapshot): Identity { return { key: mount.key, kind: mount.kind, sessionId: state.sessionId, documentId: state.documentId } }
type Cell = { value: unknown; input: string; style: { font: { bold: boolean } } }
const cell = (mount: EditingSmokeMount, name: string) => bounded((mount.editor as GridcraftSmokeEditor).query('cell.get', { cell: name }), `read ${name}`) as Promise<Cell>
type SheetUi = { visibleCells?: Array<{ cell: string; rect: number[] }>; drawnChrome?: Array<{ id: string; rect: number[] }>; editor?: { cell: string } | null; mode?: string }
function point(canvas: HTMLCanvasElement, rect: number[]) {
  assert(rect.length === 4 && rect.every(Number.isFinite), 'invalid canvas target bounds')
  const bounds = canvas.getBoundingClientRect()
  const clientX = bounds.x + rect[0]! + rect[2]! / 2, clientY = bounds.y + rect[1]! + rect[3]! / 2
  assert(document.elementFromPoint(clientX, clientY) === canvas, 'canvas input target is hidden or covered')
  return { clientX, clientY }
}
async function sheetPoint(mount: EditingSmokeMount, name: string, chrome = false) {
  const canvas = mount.element.querySelector<HTMLCanvasElement>('[data-testid="gridcraft-canvas"]')
  assert(canvas, 'spreadsheet canvas is missing')
  const state = await until(() => mount.editor.inspect(), state => {
    const ui = state.ui as SheetUi
    return chrome ? !!ui?.drawnChrome?.some(item => item.id === name) : !!ui?.visibleCells?.some(item => item.cell === name)
  }, `visible ${name}`)
  const ui = state.ui as SheetUi
  const rect = chrome ? ui.drawnChrome!.find(item => item.id === name)!.rect : ui.visibleCells!.find(item => item.cell === name)!.rect
  return point(canvas, rect)
}

/** OS input is posted by the external diagnostic runner. No DOM focus, value
 * assignment, synthetic event, or replacement native IPC is used here. */
export async function runMacosEditingSmoke(adapter: EditingSmokeAdapter, options: EditingSmokeOptions = {}): Promise<MacosEditingReport> {
  assert(isTauri() && smokeRequested(), 'an opted-in native WebView is required')
  return verifyMacosEditing(adapter, request => { smokeStage('editing-input-request', JSON.stringify(request)) }, options)
}

/** A browser harness may drive the same scenario with trusted Playwright input;
 * its distinct transport must never satisfy the macOS native acceptance gate. */
export async function verifyMacosEditing(adapter: EditingSmokeAdapter, requestInput: (request: EditingInputRequest) => void | Promise<void>, options: EditingSmokeOptions = {}): Promise<MacosEditingReport> {
  const editEntry = options.editEntry ?? 'doubleclick'
  assert(editEntry === 'doubleclick' || editEntry === 'f2' || editEntry === 'preselect', 'unsupported diagnostic edit entry')
  const control = editEntry !== 'doubleclick', preselect = editEntry === 'preselect'
  const boot = readBoot()
  const report: MacosEditingReport = { schemaVersion: 1, kind: 'macos-editing', transport: isTauri() ? 'local-wasm-in-native-webview' : 'local-wasm-in-browser', editEntry, diagnosticOnly: control, ok: false, ...boot, checks: [], sessions: [], initialTabIds: [], finalTabIds: [], actions: [], observations: {}, cleanup: { attempted: 0, closed: 0, ok: true } }
  const opened: EditingSmokeMount[] = []
  const domTimeline = createEditingDomTimeline(boot.bootId, isTauri() && smokeRequested(), detail => smokeStage('editing-dom-event', detail))
  let currentEvents: RecordedEvent[] | undefined
  const eventNames = ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown', 'keyup', 'input']
  const capture = (event: Event) => {
    if (!currentEvents || currentEvents.length >= 100) return
    const target = event.target instanceof Element ? event.target : undefined
    const button = target?.closest('button')
    const label = button?.getAttribute('aria-label')
    const value: RecordedEvent = { type: event.type, isTrusted: event.isTrusted, target: label ? `button:${label}` : target?.getAttribute('data-testid') || target?.tagName || '' }
    if (event instanceof KeyboardEvent) value.key = event.key
    if (event instanceof MouseEvent) { value.detail = event.detail; value.clientX = event.clientX; value.clientY = event.clientY }
    currentEvents.push(value)
  }
  for (const name of eventNames) window.addEventListener(name, capture, true)
  async function state() {
    const current = readBoot()
    assert(current.bootId === boot.bootId && current.timeOrigin === boot.timeOrigin, 'WebView boot identity changed')
    return { activeKey: adapter.activeKey(), tabs: adapter.tabs(), shell: adapter.shell(), sessions: await Promise.all(opened.map(async mount => { const value = await bounded(mount.editor.inspect(), 'session inspection'); return { ...identity(mount, value), revision: value.revision, dirty: value.dirty } })) }
  }
  async function preserved() {
    const value = await state()
    report.lastState = value
    assert(JSON.stringify(value.tabs.map(tab => tab.key)) === JSON.stringify(opened.map(mount => mount.key)), 'original tabs disappeared or changed order')
    assert(value.tabs.every(tab => tab.ready), 'an existing tab lost its ready state')
    assert(!value.shell.home && value.shell.workspaceDisplay !== 'none' && value.shell.visibleTabCount === opened.length, 'editor workspace or tab bar became hidden')
    assert(value.sessions.every((actual, index) => actual.sessionId === report.sessions[index]?.sessionId && actual.documentId === report.sessions[index]?.documentId), 'an original Rust session or document was replaced')
    return value
  }
  async function open(kind: Kind, name: string) {
    smokeStage('editing-open', `${kind}:${name}`)
    const mount = await bounded(adapter.open(kind, name), `${kind} ready`, 120000)
    opened.push(mount)
    report.sessions.push(identity(mount, await bounded(mount.editor.inspect(), 'initial session')))
    await frame(); await frame()
    await preserved()
    return mount
  }
  async function preselectionProbe(sheet: EditingSmokeMount, phase: 'before-command' | 'after-command' | 'after-click', started?: number) {
    // Separate model/paint work from the pointer callback, without changing
    // focus, synthetic input, or the normal double-click acceptance scenario.
    if (started !== undefined) {
      while (performance.now() - started < 2500) await new Promise(resolve => setTimeout(resolve, Math.ceil(2500 - (performance.now() - started))))
      await frame(); await frame()
    }
    await preserved()
    const ui = (await bounded(sheet.editor.inspect(), 'preselection UI inspection')).ui as SheetUi
    const model = await bounded((sheet.editor as GridcraftSmokeEditor).query('document.inspect', {}), 'preselection active cell') as { activeCell?: string }
    const active = document.activeElement
    const focus = active === sheet.element.querySelector('[data-testid="gridcraft-canvas"]') ? 'canvas'
      : active === sheet.element.querySelector('[data-testid="gridcraft-input"]') ? 'input' : active === document.body ? 'body' : active ? 'other' : 'none'
    const probe = { phase, elapsedMs: started === undefined ? 0 : performance.now() - started,
      activeCell: model.activeCell, mode: ui?.mode, editor: ui?.editor, focus }
    const probes = (report.observations.preselection ??= []) as unknown[]
    probes.push(probe)
    smokeStage('editing-preselect', JSON.stringify(probe))
    assert(typeof probe.activeCell === 'string' && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(probe.activeCell)
      && (phase === 'before-command' || probe.activeCell === 'D6') && probe.mode === 'Ready'
      && probe.editor === null && probe.focus === 'canvas', `preselection ${phase} did not retain a Ready canvas: ${JSON.stringify(probe)}`)
  }
  async function input(actionId: string, target: string, value: Omit<EditingInputRequest, 'actionId' | 'viewportWidth' | 'viewportHeight'>) {
    const action: Action = { actionId, kind: value.kind, target, events: [], before: await preserved(), completed: false }
    report.actions.push(action)
    currentEvents = action.events
    const request: EditingInputRequest = { actionId, ...value, viewportWidth: innerWidth, viewportHeight: innerHeight }
    assert(new TextEncoder().encode(JSON.stringify(request)).length < 400, 'input request exceeds native stage bound')
    const activeSheet = target.startsWith('sheet:') && opened.find(mount => mount.kind === 'sheet' && mount.key === adapter.activeKey())
    const session = activeSheet && report.sessions.find(item => item.key === activeSheet.key)
    if (activeSheet && session) domTimeline.begin({ root: activeSheet.element,
      canvas: activeSheet.element.querySelector('[data-testid="gridcraft-canvas"]'),
      input: activeSheet.element.querySelector('[data-testid="gridcraft-input"]'), actionId, sessionId: session.sessionId })
    try {
      await bounded(Promise.resolve(requestInput(request)), `${actionId} dispatch`)
      await until(async () => action.events, events => {
        const trusted = events.filter(event => event.isTrusted)
        if (value.kind === 'type') return trusted.filter(event => event.type === 'keyup' && event.key?.length === 1).length >= value.text!.length
        if (value.kind === 'key') return trusted.some(event => event.type === 'keyup' && event.key === value.key)
        const atPoint = (event: RecordedEvent) => Math.abs((event.clientX ?? -1000) - value.clientX!) < 3 && Math.abs((event.clientY ?? -1000) - value.clientY!) < 3
        return trusted.some(event => event.type === (value.kind === 'doubleClick' ? 'dblclick' : 'click') && atPoint(event))
      }, `${actionId} trusted OS events`)
      await frame(); await frame()
      action.after = await preserved(); action.completed = true
      smokeStage('editing-input-complete', actionId)
    } finally { currentEvents = undefined; domTimeline.end() }
  }
  try {
    assert(adapter.tabs().length === 0, 'diagnostic must start from a cold empty workbench')
    // Keep both workbooks pristine: the first mutation must come from real OS
    // input, before Word or an engine command can warm the editing path.
    const first = await open('sheet', 'Cold first.xlsx')
    const sheet = await open('sheet', 'Cold second.xlsx')
    assert(!(await first.editor.inspect()).dirty && !(await sheet.editor.inspect()).dirty, 'cold spreadsheet fixture was edited before OS input')
    report.initialTabIds = opened.map(mount => mount.key)
    report.checks.push(MACOS_EDITING_CHECKS[0])
    await input('single-a1', 'sheet:A1', { kind: 'click', ...await sheetPoint(sheet, 'A1') })
    await input('type-a1', 'sheet:A1', { kind: 'type', text: '42' })
    await input('enter-a1', 'sheet:A1', { kind: 'key', key: 'Enter' })
    report.observations.singleClickValue = (await until(() => cell(sheet, 'A1'), value => value.value === 42, 'single-click edit committed')).value
    assert((await cell(first, 'A1')).value === null, 'editing second workbook changed first workbook')
    report.checks.push(MACOS_EDITING_CHECKS[1])
    if (preselect) {
      await preselectionProbe(sheet, 'before-command')
      smokeStage('editing-preselect-command', 'selection.set D6')
      const started = performance.now()
      await bounded(sheet.editor.command('selection.set', { cell: 'D6' }), 'preselect D6 model command')
      await preselectionProbe(sheet, 'after-command', started)
      // The preceding document.inspect query schedules a repaint. Observe its
      // aftermath before hit testing, further inspection, or native geometry.
      const hold = report.preselectionHold = { startedAtMs: performance.now() } as NonNullable<MacosEditingReport['preselectionHold']>
      smokeStage('editing-preselect-hold', JSON.stringify({ phase: 'begin', performanceMs: hold.startedAtMs }))
      while (performance.now() - hold.startedAtMs < 3000) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(3000 - (performance.now() - hold.startedAtMs))))
      }
      hold.finishedAtMs = performance.now(); hold.durationMs = hold.finishedAtMs - hold.startedAtMs
      smokeStage('editing-preselect-hold', JSON.stringify({ phase: 'end', performanceMs: hold.finishedAtMs, durationMs: hold.durationMs }))
    }
    if (control) {
      if (preselect) smokeStage('editing-preselect-click', 'single click already-selected D6')
      await input('single-d6', 'sheet:D6', { kind: 'click', ...await sheetPoint(sheet, 'D6') })
      if (preselect) await preselectionProbe(sheet, 'after-click', performance.now())
      await input('f2-d6', 'sheet:D6', { kind: 'key', key: 'F2' })
    } else {
      await input('double-d6', 'sheet:D6', { kind: 'doubleClick', ...await sheetPoint(sheet, 'D6') })
    }
    await until(() => sheet.editor.inspect(), value => (value.ui as SheetUi)?.editor?.cell === 'D6' && document.activeElement === sheet.element.querySelector('[data-testid="gridcraft-input"]'), `${editEntry} editor and natural input focus`)
    await input('type-d6', 'sheet:D6', { kind: 'type', text: 'sheetnative' })
    await input('enter-d6', 'sheet:D6', { kind: 'key', key: 'Enter' })
    report.observations[preselect ? 'preselectValue' : control ? 'f2Value' : 'doubleClickValue'] = (await until(() => cell(sheet, 'D6'), value => value.value === 'sheetnative', `${editEntry} edit committed`)).value
    report.checks.push(preselect ? 'sheet-preselect-native-typing' : control ? 'sheet-f2-native-typing' : MACOS_EDITING_CHECKS[2])
    await input('select-a1', 'sheet:A1', { kind: 'click', ...await sheetPoint(sheet, 'A1') })
    await input('ribbon-bold', 'sheet:home.bold', { kind: 'click', ...await sheetPoint(sheet, 'home.bold', true) })
    report.observations.ribbonBold = (await until(() => cell(sheet, 'A1'), value => value.style.font.bold === true, 'ribbon bold style committed')).style.font.bold
    report.checks.push(MACOS_EDITING_CHECKS[3])
    smokeStage('editing-command', 'cell.set B1 API_SENTINEL')
    await bounded(sheet.editor.command('cell.set', { cell: 'B1', input: 'API_SENTINEL' }), 'model command')
    report.observations.commandValue = (await cell(sheet, 'B1')).value
    assert(report.observations.commandValue === 'API_SENTINEL', 'Rust command did not persist its value')
    await preserved(); report.checks.push(MACOS_EDITING_CHECKS[4])
    const undo = document.querySelector<HTMLButtonElement>('[data-testid="global-toolbar"] button[aria-label="撤销"]')
    assert(undo && !undo.disabled, 'global undo button unavailable')
    const bounds = undo.getBoundingClientRect()
    await input('global-undo', 'shell:undo', { kind: 'click', clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 })
    report.observations.undoneValue = (await until(() => cell(sheet, 'B1'), value => value.value === null, 'global undo applied to current workbook')).value
    report.checks.push(MACOS_EDITING_CHECKS[5])
    const word = await open('word', 'Word input control.docx')
    const wordState = await until(() => word.editor.inspect(), value => !!(value.ui as { pages?: number[][] })?.pages?.length, 'Word page bounds')
    const canvas = word.element.querySelector<HTMLCanvasElement>('[data-testid="wordcraft-canvas"]')
    assert(canvas, 'Word canvas missing')
    const [x, y, width, height] = (wordState.ui as { pages: number[][] }).pages[0]!
    const box = canvas.getBoundingClientRect()
    const clientX = box.x + x! + width! * .6, clientY = box.y + Math.min(y! + Math.min(200, height! / 4), box.height - 50)
    assert(document.elementFromPoint(clientX, clientY) === canvas, 'Word click target covered')
    await input('word-click', 'word:page', { kind: 'click', clientX, clientY })
    await until(async () => document.activeElement, value => value === word.element.querySelector('[data-testid="wordcraft-input"]'), 'natural Word input focus')
    await input('word-type', 'word:page', { kind: 'type', text: 'wordnative' })
    const wordResult = await until(() => word.editor.inspect(), value => 'text' in value && value.text === 'wordnative', 'Word native typing control')
    report.observations.wordText = 'text' in wordResult ? wordResult.text : undefined
    report.checks.push(MACOS_EDITING_CHECKS[6])
    await bounded(adapter.activate(sheet.key), 'return to spreadsheet')
    await frame(); await frame()
    assert((await cell(sheet, 'A1')).value === 42 && (await cell(sheet, 'A1')).style.font.bold && (await cell(sheet, 'D6')).value === 'sheetnative' && (await cell(first, 'A1')).value === null, 'retained spreadsheet content or isolation changed')
    report.observations.retained = { a1: (await cell(sheet, 'A1')).value, bold: (await cell(sheet, 'A1')).style.font.bold, d6: (await cell(sheet, 'D6')).value, pristineA1: (await cell(first, 'A1')).value }
    const final = await preserved()
    // Newly created shell tabs are already unsaved. The Rust models distinguish
    // actual edits from the untouched workbook retained as the sentinel.
    assert(final.tabs.length === 3 && final.sessions.filter(session => session.dirty).length === 2, 'expected two edited models and one pristine sentinel')
    report.finalTabIds = final.tabs.map(tab => tab.key)
    report.checks.push(MACOS_EDITING_CHECKS[7]); report.ok = true
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause); report.finalTabIds = adapter.tabs().map(tab => tab.key) }
  finally {
    currentEvents = undefined
    domTimeline.stop()
    for (const name of eventNames) window.removeEventListener(name, capture, true)
    // Report captures the original identities before controlled fixture cleanup.
    smokeStage('editing-cleanup', `attempting ${opened.length} fixture tabs`)
    for (const mount of [...opened].reverse()) {
      report.cleanup.attempted++
      try { await bounded(adapter.close(mount.key), 'fixture cleanup'); report.cleanup.closed++ }
      catch (cause) { report.cleanup.ok = false; report.ok = false; report.closeError = String(cause) }
    }
  }
  return report
}
