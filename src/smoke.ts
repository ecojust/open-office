// Only the process-launched native smoke URL opts into diagnostics. The native
// server separately requires its smoke environment and same-origin secret path.
export function smokeRequested(): boolean {
  return typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('nativeSmoke') === '1'
}

export function smokeFeatures() {
  let sharedMemory = false
  try { sharedMemory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer instanceof SharedArrayBuffer } catch {}
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    secureContext: globalThis.isSecureContext,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    canvasTransfer: typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype,
    sharedMemory,
    userAgent: navigator.userAgent,
  }
}

async function send(path: 'progress' | 'failure', body: unknown): Promise<void> {
  if (!smokeRequested()) return
  const endpoint = new URL(`./__native-smoke/${path}`, window.location.href)
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000)
  try {
    await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal})
  } catch { /* Diagnostics cannot alter production behavior or replace a pass. */ }
  finally { clearTimeout(timeout) }
}

export function smokeStage(phase: string, detail = ''): void {
  void send('progress', {phase: phase.slice(0, 80), detail: detail.slice(0, 400)})
}

export async function smokeFailure(error: unknown, phase: string): Promise<void> {
  await send('failure', {ok: false, phase, error: String(error instanceof Error ? error.message : error).slice(0, 4000), ...smokeFeatures()})
}

export async function smokeAwait<T>(phase: string, action: () => Promise<T>, seconds = 20): Promise<T> {
  if (!smokeRequested()) return action()
  smokeStage(phase, 'begin')
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([action(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error(`${phase} timed out after ${seconds}s`)), seconds * 1000)
    })])
    smokeStage(phase, 'complete')
    return result
  } finally { clearTimeout(timeout) }
}
