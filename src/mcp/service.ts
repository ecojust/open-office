import type { Kind } from '../shared/document'
import type { McpConfig } from './config'
import type { McpToolDefinition } from './document-tools'

export interface McpDocument { id: string; kind: Kind; title: string }
export interface McpStatus { running: boolean; sessionId: string | null; documentId: string | null; endpoint: string | null; port: number | null }
export interface McpRequest { sessionId: string; requestId: string; documentId: string; toolName: string; arguments: unknown; deadlineAt: number }
export interface McpResult { content: { type: 'text'; text: string }[]; isError?: boolean }
export interface McpTransport {
  start(config: McpConfig, document: McpDocument, tools: McpToolDefinition[]): Promise<McpStatus>
  stop(sessionId?: string): Promise<McpStatus>
  heartbeat(sessionId: string): Promise<McpStatus>
  claim(sessionId: string, requestId: string): Promise<boolean>
  complete(sessionId: string, requestId: string, result: McpResult): Promise<void>
  listen(callback: (request: McpRequest) => void): Promise<() => void>
}
export interface McpServiceState {
  phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  sessionId?: string; documentId?: string; endpoint?: string; error?: string
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** Own one explicitly started document session, never a global automation target. */
export function createMcpService(options: {
  transport: McpTransport
  currentDocument(): McpDocument | undefined
  execute(request: McpRequest, assertCurrent: () => void): Promise<unknown>
  changed(state: McpServiceState): void
  now?: () => number
}) {
  const { transport } = options, now = options.now ?? Date.now
  let state: McpServiceState = { phase: 'stopped' }, generation = 0, disposed = false
  let lifecycle: Promise<unknown> = Promise.resolve(), calls: Promise<unknown> = Promise.resolve()
  let listener: (() => void) | undefined, listening: Promise<void> | undefined
  let allowed = new Set<string>(), heartbeatPending = false
  let documentTitle: string | undefined
  const received = new Set<string>()
  function update(next: McpServiceState) { state = next; options.changed({ ...next }) }
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = lifecycle.then(work, work)
    lifecycle = result.catch(() => undefined)
    return result
  }
  function receive(request: McpRequest) {
    if (!disposed && state.phase === 'starting' && state.documentId === request.documentId) {
      // A client can connect as soon as the native socket opens, before the
      // start IPC reply reaches Vue. Keep that request until startup settles.
      const version = generation
      void lifecycle.then(() => { if (generation === version) receive(request) })
      return
    }
    if (disposed || state.phase !== 'running' || request.sessionId !== state.sessionId || received.has(request.requestId)) return
    received.add(request.requestId)
    // The native side bounds pending requests; bound duplicate bookkeeping too.
    if (received.size > 256) received.delete(received.values().next().value!)
    const version = generation
    const assertCurrent = () => {
      if (disposed || version !== generation || state.phase !== 'running' || state.sessionId !== request.sessionId ||
          request.documentId !== state.documentId || options.currentDocument()?.id !== request.documentId || now() >= request.deadlineAt)
        throw Error('MCP 会话已停止、文档已切换或请求已过期。')
    }
    const run = async () => {
      let result: McpResult
      try {
        assertCurrent()
        if (!allowed.has(request.toolName)) throw Error('当前 MCP 配置不允许此操作。')
        if (!await transport.claim(request.sessionId, request.requestId)) return
        assertCurrent()
        const value = await options.execute(request, assertCurrent)
        assertCurrent()
        result = { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] }
      } catch (cause) {
        result = { content: [{ type: 'text', text: message(cause) }], isError: true }
      }
      // A stopped server has already completed or cancelled its waiters.
      if (version === generation && state.sessionId === request.sessionId) {
        await transport.complete(request.sessionId, request.requestId, result).catch(() => undefined)
        // A tool may rename its own document. Deliver that result before
        // revoking the old advertised title and any queued requests.
        if (version === generation && state.sessionId === request.sessionId)
          await contextChanged().catch(() => undefined)
      }
    }
    calls = calls.then(run, run)
  }
  async function ensureListener() {
    if (!listening) listening = transport.listen(receive).then(off => {
      if (disposed) off(); else listener = off
    }).catch(cause => { listening = undefined; throw cause })
    await listening
  }
  function stop(): Promise<void> {
    ++generation // Revoke before any IPC await, even during a pending start.
    allowed.clear(); received.clear()
    if (state.phase === 'stopped') return Promise.resolve()
    update({ ...state, phase: 'stopping', error: undefined })
    return serialize(async () => {
      try {
        await transport.stop()
        update({ phase: 'stopped' })
      } catch (cause) {
        update({ ...state, phase: 'error', error: message(cause) })
        throw cause
      }
    })
  }
  async function start(config: McpConfig, document: McpDocument, tools: McpToolDefinition[]) {
    if (disposed || state.phase === 'starting' || state.phase === 'running') return
    if (state.phase === 'stopping' || state.phase === 'error') await stop()
    const version = ++generation, binding = { ...document }
    documentTitle = binding.title
    const ownsStart = () => !disposed && generation === version
    const current = () => ownsStart() && options.currentDocument()?.id === binding.id && options.currentDocument()?.title === binding.title
    const discardStaleStart = async (sessionId?: string | null) => {
      if (sessionId) await transport.stop(sessionId)
      // Also cover a name change during native startup before the host's
      // context watcher runs, without overwriting a newer lifecycle state.
      if (ownsStart()) { ++generation; allowed.clear(); received.clear(); update({ phase: 'stopped' }) }
    }
    update({ phase: 'starting', documentId: binding.id })
    return serialize(async () => {
      try {
        await ensureListener()
        if (!current()) { await discardStaleStart(); return }
        const permitted = config.allowEdits ? tools : tools.filter(tool => tool.annotations?.readOnlyHint === true)
        const next = await transport.start(config, binding, permitted)
        if (!current()) { await discardStaleStart(next.sessionId); return }
        if (!next.running || !next.sessionId || next.documentId !== binding.id || !next.endpoint) throw Error('MCP 服务未成功启动。')
        allowed = new Set(permitted.map(tool => tool.name))
        update({ phase: 'running', sessionId: next.sessionId, documentId: binding.id, endpoint: next.endpoint })
      } catch (cause) {
        if (ownsStart()) {
          // Cover partial native start failures before allowing another attempt.
          await transport.stop().catch(() => undefined)
          update({ phase: 'error', error: message(cause) })
          throw cause
        }
      }
    })
  }
  async function heartbeat() {
    const sessionId = state.sessionId, version = generation
    if (disposed || state.phase !== 'running' || !sessionId || heartbeatPending) return
    heartbeatPending = true
    try {
      const next = await transport.heartbeat(sessionId)
      if (generation !== version) return
      if (!next.running || next.sessionId !== sessionId) { ++generation; allowed.clear(); update({ phase: 'stopped' }) }
    } catch (cause) {
      if (generation === version) {
        await stop().catch(() => undefined)
        update({ ...state, phase: 'error', error: `MCP 连接已中断：${message(cause)}` })
      }
    } finally { heartbeatPending = false }
  }
  function contextChanged() {
    const current = options.currentDocument()
    if (state.phase !== 'stopped' && (state.documentId !== current?.id || documentTitle !== current?.title)) return stop()
    return Promise.resolve()
  }
  async function dispose() {
    disposed = true
    listener?.(); listener = undefined
    await stop()
  }
  return { start, stop, heartbeat, contextChanged, dispose, inspect: () => ({ ...state }) }
}
