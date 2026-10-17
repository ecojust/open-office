export const AUTOSAVE_INTERVAL_MS = 10_000
export const AUTOSAVE_DEFER_MS = 1_200
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
   * Return true only after the exact exported revision has been acknowledged.
   * Return 'deferred' for an unfinished editor draft; it will be checked again
   * shortly without reporting a successful save or increasing failure backoff.
   */
  save(target: AutosaveTarget): Promise<boolean | 'deferred'>
  onError?(error: unknown, target: AutosaveTarget | undefined, retryInMs: number): void
  intervalMs?: number
  maxBackoffMs?: number
  clock?: AutosaveClock
}

export interface AutosaveTiming {
  readonly status: 'disabled' | 'idle' | 'waiting' | 'due' | 'deferred' | 'retrying' | 'running' | 'disposed'
  /** The captured save target, including while another tab becomes active. */
  readonly target?: AutosaveTarget
  /** Earliest attempt on the existing timer cadence, including file backoff. */
  readonly nextAttemptAt?: number
  readonly remainingMs?: number
}

export interface AutosaveScheduler {
  /** Call after preference changes. Other state is also checked at each tick. */
  notify(): void
  /** Stops future work; an already started shell transaction is not cancelled. */
  dispose(): void
  readonly running: boolean
  /** Read-only UI snapshot; polling never schedules work or postpones a tick. */
  inspectTiming(): AutosaveTiming
}

const defaultClock: AutosaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function eligibleTarget(state: AutosaveState, allowTransient = false): AutosaveTarget | undefined {
  if (state.enabled !== true || state.native !== true || state.dirty !== true || state.ready !== true ||
      state.canSaveDirectly !== true || state.requiresSaveAs !== false || state.remoteEditing !== false ||
      (!allowTransient && (state.busy !== false || state.modal !== false || state.composing !== false)) ||
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
  let scheduledAt: number | undefined
  let running = false
  let runningTarget: AutosaveTarget | undefined
  let deferredId: string | undefined
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
    scheduledAt = undefined
    deferredId = undefined
    timer = undefined
  }

  function inspectTiming(): AutosaveTiming {
    if (disposed) return { status: 'disposed' }
    if (running) return { status: 'running', target: runningTarget }
    let state: AutosaveState | undefined
    // Inspecting the countdown must not trigger error callbacks or new timers.
    try { state = options.readState() } catch { return { status: 'idle' } }
    if (state.enabled === false) return { status: 'disabled' }
    const target = eligibleTarget(state, true)
    if (!target || !scheduled || scheduledAt === undefined) return { status: 'idle' }
    const id = JSON.stringify([target.key, target.fileId]), retry = retries.get(id)
    // Retry eligibility is checked at periodic ticks. With a custom backoff cap,
    // its deadline may fall between ticks; show the actual following attempt.
    const nextAttemptAt = scheduledAt + Math.max(0, Math.ceil(((retry?.notBefore ?? 0) - scheduledAt) / intervalMs)) * intervalMs
    const remainingMs = Math.max(0, nextAttemptAt - clock.now())
    const status = deferredId === id ? 'deferred' : retry ? 'retrying' : remainingMs === 0 ? 'due' : 'waiting'
    return { status, target, nextAttemptAt, remainingMs }
  }

  function notify(delay = intervalMs) {
    if (disposed) return
    const state = readState()
    if (disposed) return
    if (state?.enabled === false) { cancelTimer(); return }
    if (running || scheduled) return
    // Poll transient busy/IME/modal states without requiring a renderer watcher
    // for every state transition. Notifications never postpone a pending tick.
    scheduled = true
    scheduledAt = clock.now() + delay
    timer = clock.setTimeout(() => {
      scheduled = false
      scheduledAt = undefined
      timer = undefined
      void attempt()
    }, delay)
  }

  async function attempt() {
    if (disposed || running) return
    const state = readState()
    const target = state && eligibleTarget(state)
    if (disposed) return
    // Once due, a short typing burst or dialog must not cost another full
    // interval. Keep drafts intact and retry as soon as the editor is ready.
    if (!target) {
      const blocked = state && eligibleTarget(state, true)
      deferredId = blocked && JSON.stringify([blocked.key, blocked.fileId])
      notify(blocked ? Math.min(intervalMs, AUTOSAVE_DEFER_MS) : intervalMs)
      return
    }
    const id = JSON.stringify([target.key, target.fileId])
    deferredId = undefined
    if ((retries.get(id)?.notBefore ?? 0) > clock.now()) { notify(); return }
    running = true
    runningTarget = target
    let deferred = false
    try {
      const result = await options.save(target)
      if (result === 'deferred') deferred = true
      else if (result !== true) throw Error('自动保存未完成，稍后重试。')
      else if (!disposed) retries.delete(id)
    } catch (error) {
      if (!disposed) {
        const failures = Math.min((retries.get(id)?.failures ?? 0) + 1, 32)
        const retryInMs = Math.min(maxBackoffMs, intervalMs * 2 ** (failures - 1))
        retries.set(id, { failures, notBefore: clock.now() + retryInMs })
        report(error, target, retryInMs)
      }
    } finally {
      running = false
      runningTarget = undefined
      deferredId = deferred ? id : undefined
      notify(deferred ? Math.min(intervalMs, AUTOSAVE_DEFER_MS) : intervalMs)
    }
  }

  const scheduler: AutosaveScheduler = {
    notify,
    dispose() { disposed = true; cancelTimer(); retries.clear() },
    get running() { return running },
    inspectTiming,
  }
  notify()
  return scheduler
}
