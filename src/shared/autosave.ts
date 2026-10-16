export const AUTOSAVE_INTERVAL_MS = 30_000
export const AUTOSAVE_MAX_BACKOFF_MS = 300_000

/** The shell supplies current state; this module never opens a dialog or a file. */
export interface AutosaveState {
  enabled: boolean
  native: boolean
  key?: string
  fileId?: string
  dirty: boolean
  ready: boolean
  requiresSaveAs: boolean
  /** False for format conversion, protected imports, or a missing editor. */
  canSaveDirectly: boolean
  busy: boolean
  modal: boolean
  composing: boolean
  remoteEditing: boolean
}

export interface AutosaveTarget {
  readonly key: string
  readonly fileId: string
}

export interface AutosaveClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(timer: unknown): void
}

export interface AutosaveOptions {
  readState(): AutosaveState
  /**
   * Start the shell's save transaction synchronously, and recheck the captured
   * key/fileId after exporting. Reject Save As / conversion requests instead of
   * opening a dialog, and never route this callback to a browser download.
   * Return true after the exact exported revision has been acknowledged, or
   * when an unfinished editor draft safely defers this tick without exporting.
   */
  save(target: AutosaveTarget): Promise<boolean>
  onError?(error: unknown, target: AutosaveTarget | undefined, retryInMs: number): void
  intervalMs?: number
  maxBackoffMs?: number
  clock?: AutosaveClock
}

export interface AutosaveScheduler {
  /** Call after preference changes. Other state is also checked at each tick. */
  notify(): void
  /** Stops future work; an already started shell transaction is not cancelled. */
  dispose(): void
  readonly running: boolean
}

const defaultClock: AutosaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function eligibleTarget(state: AutosaveState): AutosaveTarget | undefined {
  if (state.enabled !== true || state.native !== true || state.dirty !== true || state.ready !== true ||
      state.canSaveDirectly !== true || state.requiresSaveAs !== false || state.busy !== false ||
      state.modal !== false || state.composing !== false || state.remoteEditing !== false ||
      !state.key?.trim() || !state.fileId?.trim()) return
  // Capture values, not the reactive document object that the shell may replace.
  return Object.freeze({ key: state.key, fileId: state.fileId })
}

/** Periodic local saves, with one in-flight transaction and per-file backoff. */
export function createAutosaveScheduler(options: AutosaveOptions): AutosaveScheduler {
  const intervalMs = options.intervalMs ?? AUTOSAVE_INTERVAL_MS
  const maxBackoffMs = options.maxBackoffMs ?? Math.max(intervalMs, AUTOSAVE_MAX_BACKOFF_MS)
  for (const milliseconds of [intervalMs, maxBackoffMs]) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
      throw new RangeError('自动保存等待时间无效。')
    }
  }
  if (maxBackoffMs < intervalMs) throw new RangeError('自动保存重试上限不能小于保存间隔。')
  const clock = options.clock ?? defaultClock
  const retries = new Map<string, { failures: number; notBefore: number }>()
  let timer: unknown
  let scheduled = false
  let running = false
  let disposed = false

  function report(error: unknown, target: AutosaveTarget | undefined, retryInMs: number) {
    if (disposed) return
    // A UI notification failure must not leak an unhandled timer rejection or
    // defeat the save backoff. File errors remain owned by the shell callback.
    try { options.onError?.(error, target, retryInMs) } catch { /* keep the scheduler alive */ }
  }

  function readState(): AutosaveState | undefined {
    try { return options.readState() } catch (error) { report(error, undefined, intervalMs) }
  }

  function cancelTimer() {
    if (scheduled) clock.clearTimeout(timer)
    scheduled = false
    timer = undefined
  }

  function notify() {
    if (disposed) return
    const state = readState()
    if (disposed) return
    if (state?.enabled === false) { cancelTimer(); return }
    if (running || scheduled) return
    // Poll transient busy/IME/modal states without requiring a renderer watcher
    // for every state transition. Notifications never postpone a pending tick.
    scheduled = true
    timer = clock.setTimeout(() => {
      scheduled = false
      timer = undefined
      void attempt()
    }, intervalMs)
  }

  async function attempt() {
    if (disposed || running) return
    const state = readState()
    const target = state && eligibleTarget(state)
    if (disposed) return
    if (!target) { notify(); return }
    const id = JSON.stringify([target.key, target.fileId])
    if ((retries.get(id)?.notBefore ?? 0) > clock.now()) { notify(); return }
    running = true
    try {
      if (!await options.save(target)) throw Error('自动保存未完成，稍后重试。')
      if (!disposed) retries.delete(id)
    } catch (error) {
      if (!disposed) {
        const failures = Math.min((retries.get(id)?.failures ?? 0) + 1, 32)
        const retryInMs = Math.min(maxBackoffMs, intervalMs * 2 ** (failures - 1))
        retries.set(id, { failures, notBefore: clock.now() + retryInMs })
        report(error, target, retryInMs)
      }
    } finally {
      running = false
      notify()
    }
  }

  const scheduler: AutosaveScheduler = {
    notify,
    dispose() { disposed = true; cancelTimer(); retries.clear() },
    get running() { return running },
  }
  notify()
  return scheduler
}
