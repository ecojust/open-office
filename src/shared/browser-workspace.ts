/** Shared snapshots use the editors' editable formats, including imported documents. */
export type WorkspaceExtension = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export type WorkspaceKind = 'word' | 'sheet' | 'presentation' | 'pdf'

export interface WorkspaceDocumentSummary {
  id: string
  name: string
  extension: WorkspaceExtension
  kind: WorkspaceKind
  sha256: string
  sizeBytes: number
  version: number
  updatedBy: string
}

export interface WorkspaceDocument extends WorkspaceDocumentSummary {
  base64: string
}

export interface WorkspaceState {
  running: boolean
  revision: number
  documents: WorkspaceDocumentSummary[]
}

export interface WorkspacePublishRequest {
  id: string
  expectedVersion: number
  clientId: string
  name: string
  extension: WorkspaceExtension
  base64: string
}

export type WorkspacePublishResult = {
  status: 'accepted' | 'conflict'
  document: WorkspaceDocumentSummary
}

export interface BrowserServerStatus {
  running: boolean
  localUrl: string | null
  lanUrls: string[]
  revision: number
}

export type WorkspaceMethod = 'GET' | 'POST'
export type WorkspaceDispatcher = (
  method: WorkspaceMethod,
  path: string,
  body?: WorkspacePublishRequest,
) => Promise<{ statusCode: number; body: unknown }>

export const WORKSPACE_LIMITS = Object.freeze({
  documentBytes: 40 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  documents: 64,
  jsonBytes: 56 * 1024 * 1024,
  fileNameBytes: 240,
})

export type WorkspaceErrorCode =
  | 'invalid-request' | 'invalid-response' | 'forbidden' | 'not-found'
  | 'too-large' | 'unavailable' | 'timeout' | 'network' | 'http'

const ERROR_MESSAGES: Record<WorkspaceErrorCode, string> = {
  'invalid-request': '共享文档请求格式无效。',
  'invalid-response': '共享工作区返回了无效数据，当前文档已保留。',
  forbidden: '共享链接已失效或没有访问权限。',
  'not-found': '共享文档或工作区已不存在。',
  'too-large': '共享文档或工作区超过大小限制。',
  unavailable: '共享工作区暂时不可用。',
  timeout: '连接共享工作区超时，当前文档已保留。',
  network: '无法连接共享工作区，当前文档已保留。',
  http: '共享工作区请求未成功，当前文档已保留。',
}

/** Deliberately excludes remote error bodies, URLs, file names and document bytes. */
export class WorkspaceTransportError extends Error {
  readonly code: WorkspaceErrorCode
  readonly statusCode: number | undefined

  constructor(code: WorkspaceErrorCode, statusCode?: number) {
    super(ERROR_MESSAGES[code])
    this.name = 'WorkspaceTransportError'
    this.code = code
    this.statusCode = statusCode
  }
}

type RecordValue = Record<string, unknown>
type ValidationCode = 'invalid-request' | 'invalid-response'
const SUMMARY_KEYS = ['id', 'name', 'extension', 'kind', 'sha256', 'sizeBytes', 'version', 'updatedBy']
const REQUEST_KEYS = ['id', 'expectedVersion', 'clientId', 'name', 'extension', 'base64']
const KIND_BY_EXTENSION: Record<WorkspaceExtension, WorkspaceKind> = {
  docx: 'word', xlsx: 'sheet', pptx: 'presentation', pdf: 'pdf',
}
const encoder = new TextEncoder()

function invalid(code: ValidationCode): never {
  throw new WorkspaceTransportError(code)
}

function record(value: unknown, keys: readonly string[], code: ValidationCode): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code)
  const result = value as RecordValue
  const actual = Object.keys(result)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(code)
  return result
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[^A-Za-z0-9_-]/.test(value)
}

function identifier(value: unknown, code: ValidationCode): string {
  if (!isIdentifier(value)) invalid(code)
  return value
}

function integer(value: unknown, minimum: number, maximum: number, code: ValidationCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(code)
  return value
}

function extension(value: unknown, code: ValidationCode): WorkspaceExtension {
  if (value !== 'docx' && value !== 'xlsx' && value !== 'pptx' && value !== 'pdf') invalid(code)
  return value
}

function fileName(value: unknown, format: WorkspaceExtension, code: ValidationCode): string {
  if (typeof value !== 'string' || !value || value.length > WORKSPACE_LIMITS.fileNameBytes
    || value.trim() !== value || value.startsWith('.') || value.endsWith('.')
    || /[\x00-\x1f\x7f-\x9f/\\:<>"|?*]/.test(value)
    || encoder.encode(value).byteLength > WORKSPACE_LIMITS.fileNameBytes) invalid(code)
  // Reject unpaired UTF-16 surrogates before JSON serialization changes the name.
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) invalid(code)
  }
  const dot = value.lastIndexOf('.')
  if (dot <= 0 || value.slice(dot + 1).toLowerCase() !== format) invalid(code)
  const device = value.slice(0, dot).split('.')[0]!.trimEnd()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(device)) invalid(code)
  return value
}

/** Count decoded bytes without allocating a second copy of a potentially large file. */
function base64Size(value: unknown, code: ValidationCode): number {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0) invalid(code)
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const size = value.length / 4 * 3 - padding
  if (size < 1 || size > WORKSPACE_LIMITS.documentBytes) invalid(code)
  const end = value.length - padding
  // Bounded regex inputs also avoid recursion/backtracking limits on large base64 strings.
  for (let offset = 0; offset < end; offset += 32768) {
    if (/[^A-Za-z0-9+/]/.test(value.slice(offset, Math.min(offset + 32768, end)))) invalid(code)
  }
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value[end - 1]!)
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) invalid(code)
  return size
}

function summary(value: unknown, code: ValidationCode = 'invalid-response', full = false): WorkspaceDocumentSummary {
  const data = record(value, full ? [...SUMMARY_KEYS, 'base64'] : SUMMARY_KEYS, code)
  const format = extension(data.extension, code)
  if (data.kind !== KIND_BY_EXTENSION[format]
    || typeof data.sha256 !== 'string' || data.sha256.length !== 64 || /[^a-f0-9]/.test(data.sha256)) invalid(code)
  return {
    id: identifier(data.id, code),
    name: fileName(data.name, format, code),
    extension: format,
    kind: KIND_BY_EXTENSION[format],
    sha256: data.sha256,
    sizeBytes: integer(data.sizeBytes, 1, WORKSPACE_LIMITS.documentBytes, code),
    version: integer(data.version, 1, Number.MAX_SAFE_INTEGER, code),
    updatedBy: identifier(data.updatedBy, code),
  }
}

function state(value: unknown): WorkspaceState {
  const data = record(value, ['running', 'revision', 'documents'], 'invalid-response')
  if (typeof data.running !== 'boolean' || !Array.isArray(data.documents)
    || data.documents.length > WORKSPACE_LIMITS.documents) invalid('invalid-response')
  const revision = integer(data.revision, 0, Number.MAX_SAFE_INTEGER, 'invalid-response')
  const documents = data.documents.map(item => summary(item))
  const ids = new Set<string>()
  let total = 0
  for (const item of documents) {
    if (ids.has(item.id) || item.version > revision) invalid('invalid-response')
    ids.add(item.id)
    total += item.sizeBytes
  }
  if (total > WORKSPACE_LIMITS.totalBytes) invalid('invalid-response')
  return { running: data.running, revision, documents }
}

function publishRequest(value: unknown): WorkspacePublishRequest {
  const data = record(value, REQUEST_KEYS, 'invalid-request')
  const format = extension(data.extension, 'invalid-request')
  base64Size(data.base64, 'invalid-request')
  return {
    id: identifier(data.id, 'invalid-request'),
    expectedVersion: integer(data.expectedVersion, 0, Number.MAX_SAFE_INTEGER, 'invalid-request'),
    clientId: identifier(data.clientId, 'invalid-request'),
    name: fileName(data.name, format, 'invalid-request'),
    extension: format,
    base64: data.base64 as string,
  }
}

function httpError(statusCode: number): WorkspaceTransportError {
  const code = statusCode === 401 || statusCode === 403 ? 'forbidden'
    : statusCode === 404 || statusCode === 410 ? 'not-found'
    : statusCode === 413 ? 'too-large'
    : statusCode === 408 || statusCode === 504 ? 'timeout'
    : statusCode === 429 || statusCode === 502 || statusCode === 503 ? 'unavailable' : 'http'
  return new WorkspaceTransportError(code, statusCode)
}

/** A stateless adapter: callers decide when a received snapshot may replace a local editor. */
export function createWorkspaceTransport(dispatch: WorkspaceDispatcher) {
  async function request(method: WorkspaceMethod, path: string, body?: WorkspacePublishRequest) {
    let result: Awaited<ReturnType<WorkspaceDispatcher>>
    try { result = await dispatch(method, path, body) } catch (error) {
      if (error instanceof WorkspaceTransportError) throw error
      throw new WorkspaceTransportError('network')
    }
    if (!result || typeof result !== 'object'
      || !Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) invalid('invalid-response')
    return result
  }

  return {
    async state(): Promise<WorkspaceState> {
      const result = await request('GET', '_sync/state')
      if (result.statusCode !== 200) throw httpError(result.statusCode)
      return state(result.body)
    },
    async document(id: string): Promise<WorkspaceDocument> {
      const safeId = identifier(id, 'invalid-request')
      const result = await request('GET', `_sync/documents/${safeId}`)
      if (result.statusCode !== 200) throw httpError(result.statusCode)
      const metadata = summary(result.body, 'invalid-response', true)
      const base64 = (result.body as RecordValue).base64
      if (metadata.id !== safeId || base64Size(base64, 'invalid-response') !== metadata.sizeBytes) invalid('invalid-response')
      return { ...metadata, base64: base64 as string }
    },
    async publish(value: WorkspacePublishRequest): Promise<WorkspacePublishResult> {
      const input = publishRequest(value)
      const result = await request('POST', '_sync/documents', input)
      if (result.statusCode !== 200 && result.statusCode !== 409) throw httpError(result.statusCode)
      const data = record(result.body, ['status', 'document'], 'invalid-response')
      const status = result.statusCode === 200 ? 'accepted' : 'conflict'
      if (data.status !== status) invalid('invalid-response')
      const document = summary(data.document)
      if (document.id !== input.id) invalid('invalid-response')
      if (status === 'accepted' && (document.name !== input.name || document.extension !== input.extension
        || document.sizeBytes !== base64Size(input.base64, 'invalid-request'))) invalid('invalid-response')
      return { status, document }
    },
  }
}

function currentLocation(): URL | undefined {
  return typeof location === 'undefined' ? undefined : new URL(location.href)
}

export function isSharedWorkspaceLocation(url: URL | undefined = currentLocation()): boolean {
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:')
    && !url.username && !url.password && url.searchParams.getAll('workspace').length === 1
    && url.searchParams.get('workspace') === 'shared'
    && /^\/[a-f0-9]{64}\/(?:index\.html)?$/.test(url.pathname)
}

function workspaceBase(url: URL): URL {
  if (!isSharedWorkspaceLocation(url)) invalid('invalid-request')
  const base = new URL(url.href)
  base.search = ''
  base.hash = ''
  if (base.pathname.endsWith('/index.html')) base.pathname = base.pathname.slice(0, -10)
  if (!base.pathname.endsWith('/') || base.pathname === '/') invalid('invalid-request')
  return base
}

export interface BrowserWorkspaceOptions {
  /** Injectable for transport tests; production uses the browser's fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Read JSON with an explicit byte limit, including streamed/chunked responses. */
async function responseJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length')
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if ((length !== null && (!length || /[^0-9]/.test(length) || Number(length) > limit))
    || mediaType !== 'application/json' || !response.body) {
    void response.body?.cancel().catch(() => {})
    invalid('invalid-response')
  }
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > limit) invalid('invalid-response')
      parts.push(decoder.decode(item.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return JSON.parse(parts.join('')) as unknown
  } catch (error) {
    // Do not wait for a hostile stream's cancel callback to settle.
    cancel()
    if (error instanceof WorkspaceTransportError) throw error
    throw new WorkspaceTransportError('invalid-response')
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Capture the capability directory once. Neither document names nor navigation can retarget it. */
export function browserWorkspaceDispatcher(
  url: URL | undefined = currentLocation(),
  options: BrowserWorkspaceOptions = {},
): WorkspaceDispatcher {
  if (!url) invalid('invalid-request')
  const base = workspaceBase(url)
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) invalid('invalid-request')

  return async (method, path, body) => {
    const readDocument = method === 'GET' && path.startsWith('_sync/documents/')
      && isIdentifier(path.slice('_sync/documents/'.length))
    const readState = method === 'GET' && path === '_sync/state'
    const writeDocument = method === 'POST' && path === '_sync/documents'
    if (!readDocument && !readState && !writeDocument) invalid('invalid-request')
    if (!writeDocument && body !== undefined) invalid('invalid-request')
    const serialized = writeDocument ? JSON.stringify(publishRequest(body)) : undefined
    const endpoint = new URL(path, base)
    if (endpoint.origin !== base.origin || !endpoint.pathname.startsWith(base.pathname)) invalid('invalid-request')

    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new WorkspaceTransportError('timeout'))
      }, timeoutMs)
    })
    const operation = (async () => {
      const response = await send(endpoint.href, {
        method, body: serialized, signal: controller.signal,
        mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: serialized === undefined ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      })
      if (response.redirected || (response.url && new URL(response.url).href !== endpoint.href)) {
        void response.body?.cancel().catch(() => {})
        invalid('invalid-response')
      }
      if (response.status !== 200 && !(writeDocument && response.status === 409)) {
        void response.body?.cancel().catch(() => {})
        return { statusCode: response.status, body: null }
      }
      const limit = readDocument ? WORKSPACE_LIMITS.jsonBytes : 128 * 1024
      return { statusCode: response.status, body: await responseJson(response, limit, controller.signal) }
    })()
    try { return await Promise.race([operation, deadline]) } catch (error) {
      if (timedOut) throw new WorkspaceTransportError('timeout')
      if (error instanceof WorkspaceTransportError) throw error
      throw new WorkspaceTransportError('network')
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
}
