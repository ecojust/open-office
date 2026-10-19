import { invoke, isTauri } from '@tauri-apps/api/core'
import { base64ToBytes } from '../native'
import type { NativeDocument } from '../types'
import type { OfficeWordSmokeEditor } from '../word/rust/office-word-native-smoke'
import type { McpServiceState, McpStatus } from './service'

export const MCP_NATIVE_TEXT = 'NATIVE_MCP_ROUNDTRIP 中文'
export const MCP_NATIVE_CHECKS = [
  'native-mcp-http-initialize-and-catalog',
  'native-mcp-event-edits-and-reads-current-document',
  'native-mcp-docx-export',
  'native-mcp-document-switch-closes-listener',
  'native-mcp-session-cleanup',
] as const
export const MCP_NATIVE_LIMITATIONS = [
  'The HTTP client is invoked by a smoke-only native command; external AI client applications are not exercised.',
  'Document edits use the actual MCP event bridge and Rust editor; physical keyboard input is not exercised.',
] as const

interface RpcResponse {
  jsonrpc: string
  id: number
  result?: { protocolVersion?: string; tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean }
  error?: unknown
}
interface ToolProbe {
  sessionId: string
  port: number
  httpSessionId: string
  initialized: RpcResponse
  catalog: RpcResponse
  response: RpcResponse
}
export interface McpNativeSmokeReport {
  schemaVersion: 1
  kind: 'mcp-native'
  transport: 'native-webview-ipc-http'
  ok: boolean
  native: { tauri: true; origin: string }
  checks: string[]
  limitations: string[]
  http?: { write: ToolProbe; read: ToolProbe }
  document?: {
    key: string; beforeDocumentId: number; afterDocumentId: number
    beforeRevision: number; afterRevision: number; beforeText: string; afterText: string; dirty: boolean
    base64: string; sha256: string; sizeBytes: number
  }
  service?: {
    sessionId: string; documentId: string; port: number; runningBefore: boolean; runningButton: boolean
    switchedDocumentId: string; stoppedAfter: boolean; closedProbe: { port: number; closed: boolean }
  }
  cleanup?: { closedDocuments: number; serviceStopped: boolean }
  error?: string
  cleanupError?: string
}
export interface McpNativeSmokeAdapter {
  openWord(source: NativeDocument): Promise<{ key: string; editor: OfficeWordSmokeEditor }>
  start(key: string): Promise<void>
  state(): McpServiceState
  stop(): Promise<void>
  close(key: string): Promise<void>
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(`Native MCP: ${message}`)
}
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 40000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Native MCP: ${label} timed out`)), milliseconds) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
function toolValue(probe: ToolProbe, tool: string, sessionId: string, port: number) {
  assert(probe.sessionId === sessionId && probe.port === port && typeof probe.httpSessionId === 'string' && probe.httpSessionId.length >= 32, 'HTTP tool targeted another service session')
  assert(probe.initialized.jsonrpc === '2.0' && probe.initialized.id === 1 && !probe.initialized.error && probe.initialized.result?.protocolVersion === '2025-03-26', 'real HTTP initialization failed')
  assert(probe.catalog.jsonrpc === '2.0' && probe.catalog.id === 2 && !probe.catalog.error && probe.catalog.result?.tools?.some(item => item.name === tool), 'requested tool was absent from the HTTP catalog')
  const response = probe.response
  assert(response.jsonrpc === '2.0' && response.id === 3 && !response.error && response.result?.isError !== true, 'HTTP tool failed')
  assert(response.result?.content?.length === 1 && response.result.content[0]?.type === 'text', 'HTTP tool returned invalid content')
  return JSON.parse(response.result.content[0].text) as Record<string, unknown>
}

/** Installed-app proof: real Tauri start/listener/claim/completion and loopback HTTP. */
export async function runMcpNativeSmoke(adapter: McpNativeSmokeAdapter): Promise<McpNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for MCP verification')
  const report: McpNativeSmokeReport = {
    schemaVersion: 1, kind: 'mcp-native', transport: 'native-webview-ipc-http', ok: false,
    native: { tauri: true, origin: location.origin }, checks: [], limitations: [...MCP_NATIVE_LIMITATIONS],
  }
  const keys: string[] = []
  let closedDocuments = 0
  const blank = (name: string): NativeDocument => ({ id: '', kind: 'word', extension: 'docx', name, base64: '', sha256: '', sizeBytes: 0 })
  try {
    const first = await bounded(adapter.openWord(blank('native-mcp.docx')), 'new document')
    keys.push(first.key)
    const before = await first.editor.inspect()
    assert(before.text === '', 'native MCP specimen must start blank')
    await bounded(adapter.start(first.key), 'normal MCP start')
    const status = await bounded(invoke<McpStatus>('mcp_status'), 'native service status')
    assert(status.running && status.sessionId && status.documentId === first.key && status.port, 'native service did not target the current document')
    assert(adapter.state().phase === 'running' && adapter.state().sessionId === status.sessionId, 'shell did not observe the native Running state')
    const button = document.querySelector<HTMLButtonElement>('[data-testid="document-mcp-toggle"]')
    const runningButton = button?.getAttribute('aria-pressed') === 'true' && button.classList.contains('running')
    assert(runningButton, 'document MCP button did not display Running')
    const probe = (toolName: string, args: Record<string, unknown>) => bounded(invoke<ToolProbe>('mcp_smoke_probe', { request: { action: 'tool', sessionId: status.sessionId, toolName, arguments: args } }), toolName)
    const write = await probe('word_insert_text', { text: MCP_NATIVE_TEXT })
    const writeValue = toolValue(write, 'word_insert_text', status.sessionId, status.port)
    const read = await probe('word_read', {})
    const readValue = toolValue(read, 'word_read', status.sessionId, status.port)
    report.http = { write, read }
    report.checks.push(MCP_NATIVE_CHECKS[0])
    const after = await first.editor.inspect()
    assert(after.documentId === before.documentId && after.revision > before.revision && after.dirty && after.text === MCP_NATIVE_TEXT, 'HTTP MCP edit did not change the real current Rust document')
    assert(writeValue.documentId === after.documentId && writeValue.revision === after.revision && writeValue.text === MCP_NATIVE_TEXT && writeValue.dirty === true, 'HTTP edit response differs from the Rust document')
    assert(readValue.text === MCP_NATIVE_TEXT && readValue.totalCharacters === MCP_NATIVE_TEXT.length && readValue.truncated === false, 'HTTP read did not observe the edited document')
    report.checks.push(MCP_NATIVE_CHECKS[1])
    const exported = await bounded(first.editor.exportFile({ format: 'docx', background: true }), 'MCP edited DOCX export')
    const bytes = base64ToBytes(exported.base64)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))
    report.document = { key: first.key, beforeDocumentId: before.documentId, afterDocumentId: after.documentId,
      beforeRevision: before.revision, afterRevision: after.revision, beforeText: before.text, afterText: after.text, dirty: after.dirty,
      base64: exported.base64, sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.length }
    assert(bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b, 'MCP edit did not export DOCX bytes')
    report.checks.push(MCP_NATIVE_CHECKS[2])
    const second = await bounded(adapter.openWord(blank('native-mcp-switch.docx')), 'switch current document')
    keys.push(second.key)
    assert(second.key !== first.key, 'switch did not open another document')
    const deadline = Date.now() + 10000
    while (adapter.state().phase !== 'stopped') {
      assert(Date.now() < deadline && adapter.state().phase !== 'error', 'document switch did not stop the MCP service')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const stopped = await bounded(invoke<McpStatus>('mcp_status'), 'stopped native service status')
    assert(!stopped.running && stopped.sessionId === null && stopped.documentId === null && stopped.port === null, 'native service survived document switch')
    const closedProbe = await bounded(invoke<{ port: number; closed: boolean }>('mcp_smoke_probe', { request: { action: 'stopped', port: status.port } }), 'closed MCP TCP listener')
    assert(closedProbe.closed && closedProbe.port === status.port, 'old MCP TCP listener remains open')
    report.service = { sessionId: status.sessionId, documentId: status.documentId, port: status.port, runningBefore: status.running,
      runningButton, switchedDocumentId: second.key, stoppedAfter: true, closedProbe }
    report.checks.push(MCP_NATIVE_CHECKS[3])
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    try {
      await bounded(adapter.stop(), 'final MCP stop')
      for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close MCP smoke document'); closedDocuments++ }
      const stopped = await bounded(invoke<McpStatus>('mcp_status'), 'cleanup native status')
      assert(!stopped.running && stopped.sessionId === null && adapter.state().phase === 'stopped', 'MCP cleanup left a live service')
      report.cleanup = { closedDocuments, serviceStopped: true }
      report.checks.push(MCP_NATIVE_CHECKS[4])
    } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === MCP_NATIVE_CHECKS.length
  return report
}
