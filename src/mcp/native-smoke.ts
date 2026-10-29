import { invoke, isTauri } from '@tauri-apps/api/core'
import { base64ToBytes } from '../native'
import type { DocumentKind, NativeDocument } from '../types'
import type { McpServiceState, McpStatus } from './service'

export const MCP_NATIVE_TEXT = 'NATIVE_MCP_ROUNDTRIP 中文'
export const MCP_NATIVE_CHECKS = [
  'native-mcp-http-initialize-and-catalog',
  'native-mcp-event-edits-and-reads-current-document',
  'native-mcp-docx-export',
  'native-mcp-document-switch-closes-listener',
  'native-mcp-seven-editor-edit-query-export',
  'native-mcp-word-format-undo-redo',
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
export interface ToolProbe {
  sessionId: string
  port: number
  httpSessionId: string
  initialized: RpcResponse
  catalog: RpcResponse
  response: RpcResponse
}
type Snapshot = { documentId: number; revision: number; dirty: boolean; [key: string]: unknown }
interface SmokeEditor {
  inspect(): Promise<Snapshot>
  exportFile(options?: { background?: boolean }): Promise<{ base64: string; extension: string }>
}
export interface McpNativeEditorEvidence {
  kind: DocumentKind; key: string; service: { sessionId: string; port: number }
  before: Snapshot; after: Snapshot; shellDirty: boolean; actual: unknown; visibleText?: string
  edit: { tool: string; arguments: Record<string, unknown>; probe: ToolProbe }
  query: { tool: string; arguments: Record<string, unknown>; probe: ToolProbe }
  exported: { base64: string; extension: string; sha256: string; sizeBytes: number }
  history?: { select: ToolProbe; before: ToolProbe; undo: ToolProbe; undone: ToolProbe; redo: ToolProbe; redone: ToolProbe }
}
export interface McpNativeSmokeReport {
  schemaVersion: 2
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
  editors?: McpNativeEditorEvidence[]
  cleanup?: { closedDocuments: number; serviceStopped: boolean }
  error?: string
  cleanupError?: string
}
export interface McpNativeSmokeAdapter {
  open(source: NativeDocument): Promise<{ key: string; editor: SmokeEditor; read(): Promise<unknown> }>
  start(key: string): Promise<void>
  documentState(key: string): { active: boolean; dirty: boolean }
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

const extensions = { word: 'docx', sheet: 'xlsx', presentation: 'pptx', pdf: 'pdf', note: 'oonote', canvas: 'owflow', diagram: 'owflow' } as const
const markers = { word: MCP_NATIVE_TEXT, sheet: 'NATIVE_MCP_SHEET', presentation: 'NATIVE_MCP_PRESENTATION', pdf: 'NATIVE_MCP_PDF', note: 'NATIVE_MCP_NOTE', canvas: 'NATIVE_MCP_CANVAS', diagram: 'NATIVE_MCP_DIAGRAM' } as const
type McpSmokeKind = Exclude<DocumentKind, 'schedule'>
const blank = (kind: McpSmokeKind, name = `native-mcp-${kind}`): NativeDocument => ({ id: '', kind, extension: extensions[kind], name: `${name}.${extensions[kind]}`, base64: '', sha256: '', sizeBytes: 0 })
const json = (value: unknown) => JSON.stringify(value)
async function exportEvidence(editor: SmokeEditor) {
  const exported = await bounded(editor.exportFile({ background: true }), 'edited document export')
  const bytes = base64ToBytes(exported.base64)
  assert(bytes.length > 100 && bytes.length <= 8 * 1024 * 1024, 'edited specimen has an invalid export size')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))
  return { base64: exported.base64, extension: exported.extension, sizeBytes: bytes.length,
    sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join('') }
}
async function editingEvidence(adapter: McpNativeSmokeAdapter, opened: Awaited<ReturnType<McpNativeSmokeAdapter['open']>>, kind: McpSmokeKind, status: McpStatus): Promise<McpNativeEditorEvidence> {
  assert(status.running && status.sessionId && status.port && status.documentId === opened.key, 'editing specimen service is not active')
  const sessionId = status.sessionId, port = status.port
  const probe = (toolName: string, args: Record<string, unknown>) => bounded(invoke<ToolProbe>('mcp_smoke_probe', {
    request: { action: 'tool', sessionId, toolName, arguments: args },
  }), `${kind} ${toolName}`)
  let editTool: string, editArgs: Record<string, unknown>, queryTool: string, queryArgs: Record<string, unknown>
  let history: McpNativeEditorEvidence['history']
  let selected: ToolProbe | undefined, beforeQuery: ToolProbe | undefined
  if (kind === 'word') {
    selected = await probe('word_select_text', { text: MCP_NATIVE_TEXT })
    toolValue(selected, 'word_select_text', sessionId, port)
    beforeQuery = await probe('word_query', { command: 'document.inspect', params: { text: true } })
    editTool = 'word_execute_command'; editArgs = { command: 'format.set', params: { props: { bold: true, size: 22, color: 'D52B3F' } } }
    queryTool = 'word_query'; queryArgs = { command: 'document.inspect', params: { text: true } }
  } else if (kind === 'sheet') {
    editTool = 'sheet_execute_command'; editArgs = { command: 'range.setValues', params: { range: 'A1:B2', values: [[markers.sheet, 17], ['MCP', 29]] } }
    queryTool = 'sheet_query'; queryArgs = { command: 'cell.get', params: { cell: 'A1' } }
  } else if (kind === 'presentation') {
    editTool = 'presentation_execute_command'; editArgs = { command: 'shape.insert', params: { preset: 'rect', rect: [80, 100, 300, 100], text: markers.presentation } }
    queryTool = 'presentation_query'; queryArgs = { command: 'slide.inspect', params: { index: 0 } }
  } else if (kind === 'pdf') {
    editTool = 'pdf_execute_command'; editArgs = { command: 'page_add_text', params: { page: 1, text: markers.pdf, at: [40, 120], size: 20, bold: true } }
    queryTool = 'pdf_query'; queryArgs = { command: 'content_list' }
  } else if (kind === 'note') {
    editTool = 'note_edit'; editArgs = { operations: [
      { op: 'section.add', id: 'native_mcp_section', title: 'MCP' },
      { op: 'page.add', sectionId: 'native_mcp_section', id: 'native_mcp_page', title: 'MCP native page' },
      { op: 'region.add', pageId: 'native_mcp_page', region: { id: 'native_mcp_region', x: 40, y: 50, width: 480,
        blocks: [{ id: 'native_mcp_block', type: 'heading', level: 2, content: [{ text: markers.note }] }] } },
    ], selectPageId: 'native_mcp_page' }
    queryTool = 'note_read'; queryArgs = {}
  } else if (kind === 'canvas') {
    editTool = 'canvas_edit'; editArgs = { operations: [{ op: 'add', element: { id: 'native_mcp_shape', type: 'shape', shape: 'rectangle', x: 40, y: 40, width: 280, height: 100, text: markers.canvas } }] }
    queryTool = 'canvas_read'; queryArgs = {}
  } else {
    editTool = 'diagram_update'; editArgs = { source: `sequenceDiagram\n  Alice->>Bob: ${markers.diagram}`, style: 'blueprint' }
    queryTool = 'diagram_read'; queryArgs = {}
  }
  const before = await opened.editor.inspect()
  const edit = await probe(editTool, editArgs), edited = toolValue(edit, editTool, sessionId, port)
  const query = await probe(queryTool, queryArgs), queried = toolValue(query, queryTool, sessionId, port)
  assert(json(queried).includes(markers[kind]), `${kind} native query did not observe the edited content`)
  if (kind === 'word') {
    const original = toolValue(beforeQuery!, queryTool, sessionId, port)
    assert(json(queried.blocks) !== json(original.blocks), 'Word format command did not change the actual runs')
    const undo = await probe('document_undo', {}); toolValue(undo, 'document_undo', sessionId, port)
    const undone = await probe(queryTool, queryArgs)
    assert(json(toolValue(undone, queryTool, sessionId, port).blocks) === json(original.blocks), 'Word native MCP undo did not restore run formatting')
    const redo = await probe('document_redo', {}); toolValue(redo, 'document_redo', sessionId, port)
    const redone = await probe(queryTool, queryArgs)
    assert(json(toolValue(redone, queryTool, sessionId, port).blocks) === json(queried.blocks), 'Word native MCP redo did not restore edited runs')
    history = { select: selected!, before: beforeQuery!, undo, undone, redo, redone }
  }
  const after = await opened.editor.inspect(), actual = await opened.read()
  assert(after.documentId === before.documentId && after.revision > before.revision && after.dirty, `${kind} did not mutate the same actual editor`)
  const resultSnapshot = (edited.snapshot || edited) as Record<string, unknown>
  assert(resultSnapshot.documentId === after.documentId && Number(resultSnapshot.revision) > before.revision, `${kind} HTTP edit differs from the actual document`)
  const state = adapter.documentState(opened.key)
  assert(state.active && state.dirty, `${kind} shell did not receive the actual edited state`)
  assert(json(actual).includes(markers[kind]), `${kind} actual editor did not expose the updated content`)
  const selector = kind === 'note' ? '[data-testid="notebook-content"]' : kind === 'canvas' ? '[data-testid="canvas-stage"]' : kind === 'diagram' ? '[data-testid="diagram-preview"]' : undefined
  const visibleText = selector ? [...document.querySelectorAll(selector)].map(element => element.textContent || '').join('\n') : undefined
  if (selector) assert(visibleText?.includes(markers[kind]), `${kind} actual page did not redraw the edit`)
  return { kind, key: opened.key, service: { sessionId, port }, before, after, shellDirty: state.dirty, actual, visibleText,
    edit: { tool: editTool, arguments: editArgs, probe: edit }, query: { tool: queryTool, arguments: queryArgs, probe: query }, history,
    exported: await exportEvidence(opened.editor) }
}

/** Installed-app proof: real Tauri start/listener/claim/completion and loopback HTTP. */
export async function runMcpNativeSmoke(adapter: McpNativeSmokeAdapter): Promise<McpNativeSmokeReport> {
  if (!isTauri()) throw Error('A real native WebView is required for MCP verification')
  const report: McpNativeSmokeReport = {
    schemaVersion: 2, kind: 'mcp-native', transport: 'native-webview-ipc-http', ok: false, editors: [],
    native: { tauri: true, origin: location.origin }, checks: [], limitations: [...MCP_NATIVE_LIMITATIONS],
  }
  const keys: string[] = []
  let closedDocuments = 0
  try {
    const first = await bounded(adapter.open(blank('word')), 'new document')
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
    const exported = await bounded(first.editor.exportFile({ background: true }), 'MCP edited DOCX export')
    const bytes = base64ToBytes(exported.base64)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))
    report.document = { key: first.key, beforeDocumentId: before.documentId, afterDocumentId: after.documentId,
      beforeRevision: before.revision, afterRevision: after.revision, beforeText: before.text, afterText: after.text, dirty: after.dirty,
      base64: exported.base64, sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.length }
    assert(bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b, 'MCP edit did not export DOCX bytes')
    report.checks.push(MCP_NATIVE_CHECKS[2])
    report.editors!.push(await editingEvidence(adapter, first, 'word', status))
    const second = await bounded(adapter.open(blank('word', 'native-mcp-switch')), 'switch current document')
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
    // Close each specimen before opening another editor to keep the installed
    // seven-editor smoke inside the existing memory and 300-second budget.
    while (keys.length) { await bounded(adapter.close(keys[keys.length - 1]!), 'close Word specimen'); keys.pop(); closedDocuments++ }
    for (const kind of ['sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram'] as const) {
      const opened = await bounded(adapter.open(blank(kind)), `${kind} native document`)
      keys.push(opened.key)
      await bounded(adapter.start(opened.key), `${kind} native MCP start`)
      const service = await bounded(invoke<McpStatus>('mcp_status'), `${kind} native status`)
      report.editors!.push(await editingEvidence(adapter, opened, kind, service))
      await bounded(adapter.stop(), `${kind} stop`)
      await bounded(adapter.close(opened.key), `${kind} close`); keys.pop(); closedDocuments++
    }
    report.checks.push(MCP_NATIVE_CHECKS[4], MCP_NATIVE_CHECKS[5])
  } catch (cause) { report.error = cause instanceof Error ? cause.message : String(cause) }
  finally {
    try {
      await bounded(adapter.stop(), 'final MCP stop')
      for (const key of keys.reverse()) { await bounded(adapter.close(key), 'close MCP smoke document'); closedDocuments++ }
      const stopped = await bounded(invoke<McpStatus>('mcp_status'), 'cleanup native status')
      assert(!stopped.running && stopped.sessionId === null && adapter.state().phase === 'stopped', 'MCP cleanup left a live service')
      report.cleanup = { closedDocuments, serviceStopped: true }
      report.checks.push(MCP_NATIVE_CHECKS[6])
    } catch (cause) { report.cleanupError = cause instanceof Error ? cause.message : String(cause) }
  }
  report.ok = !report.error && !report.cleanupError && report.checks.length === MCP_NATIVE_CHECKS.length
  return report
}
