import { createId } from '../shared/id'

export interface PresentationTemplate {
  id: string
  name: string
  description: string
  slideCount: number
  createdAt?: string
  source: 'builtin' | 'custom'
  preview?: string
  accent: string
}

interface BuiltinTemplate extends PresentationTemplate { file: string }
interface TemplateData { id: string; bytes: ArrayBuffer }

export const MAX_PRESENTATION_TEMPLATE_BYTES = 40 * 1024 * 1024
const DATABASE_NAME = 'open-office-presentation-templates'
const METADATA_STORE = 'metadata'
const DATA_STORE = 'documents'
const CUSTOM_PREFIX = 'custom-'
let databasePromise: Promise<IDBDatabase> | undefined
let builtinPromise: Promise<BuiltinTemplate[]> | undefined

export function normalizePresentationTemplateName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('请输入模板名称。')
  if (Array.from(name).length > 60) throw new Error('模板名称不能超过 60 个字符。')
  return name
}

function validateSlideCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('模板至少需要一页幻灯片。')
  return value
}

function validateBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_PRESENTATION_TEMPLATE_BYTES) throw new Error('模板文件不能超过 40 MB。')
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error('模板文件不是有效的 PPTX 文档，请重新保存模板。')
  }
}

function decodeTemplate(base64: string): Uint8Array<ArrayBuffer> {
  if (typeof base64 !== 'string' || !base64 || base64.length % 4 !== 0) throw new Error('模板文档数据不完整，请重试。')
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if (base64.length / 4 * 3 - padding > MAX_PRESENTATION_TEMPLATE_BYTES) throw new Error('模板文件不能超过 40 MB。')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('模板文档数据格式无效，请重试。')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  validateBytes(bytes)
  return bytes
}

function encodeTemplate(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  return btoa(chunks.join(''))
}

function storageError(action: string, error: unknown): Error {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (name === 'QuotaExceededError') return new Error(`${action}：本地存储空间不足，请删除不用的模板或释放磁盘空间后重试。`)
  return new Error(`${action}：无法访问本地模板库，请检查磁盘空间或浏览器存储权限后重试。`)
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => { settled = true; reject(storageError('打开模板库失败', error)) }
    try {
      const request = indexedDB.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore(METADATA_STORE, { keyPath: 'id' })
        database.createObjectStore(DATA_STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => {
        const database = request.result
        if (settled) { database.close(); return }
        database.onversionchange = () => { database.close(); databasePromise = undefined }
        database.onclose = () => { databasePromise = undefined }
        settled = true
        resolve(database)
      }
      request.onerror = () => fail(request.error)
      request.onblocked = () => {
        settled = true
        reject(new Error('模板库暂时被其他窗口占用，请关闭其他窗口后重试。'))
      }
    } catch (error) { fail(error) }
  }).catch(error => { databasePromise = undefined; throw error })
  return databasePromise
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: string, work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    try {
      const tx = database.transaction(stores, mode)
      let result: T
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(storageError(action, tx.error))
      try { work(tx, value => { result = value }) }
      catch (error) { tx.abort(); reject(storageError(action, error)) }
    } catch (error) { reject(storageError(action, error)) }
  })
}

async function builtinTemplates(): Promise<BuiltinTemplate[]> {
  if (builtinPromise) return builtinPromise
  builtinPromise = (async () => {
    const directory = new URL('presentation-templates/', document.baseURI)
    const response = await fetch(new URL('manifest.json', directory))
    if (!response.ok) throw new Error('无法读取内置模板清单。')
    const manifest: unknown = await response.json()
    if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('内置模板清单无效。')
    const ids = new Set<string>()
    return manifest.map((entry): BuiltinTemplate => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(entry.id) || entry.id.startsWith(CUSTOM_PREFIX) || ids.has(entry.id)) throw new Error('内置模板标识无效。')
      if (typeof entry.file !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.pptx$/i.test(entry.file)) throw new Error('内置模板文件路径无效。')
      if (typeof entry.preview !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.(svg|png|webp)$/i.test(entry.preview)) throw new Error('内置模板预览路径无效。')
      if (typeof entry.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.accent)) throw new Error('内置模板颜色无效。')
      ids.add(entry.id)
      return {
        id: entry.id, name: normalizePresentationTemplateName(entry.name),
        description: typeof entry.description === 'string' ? entry.description : '',
        slideCount: validateSlideCount(entry.slideCount), source: 'builtin', accent: entry.accent,
        file: new URL(entry.file, directory).href, preview: new URL(entry.preview, directory).href,
      }
    })
  })().catch(() => { builtinPromise = undefined; throw new Error('读取内置模板失败，请重新打开模板栏；若仍失败，请重新安装应用。') })
  return builtinPromise
}

/** Custom documents stay in a separate store, so listing never reads their bytes. */
export async function listPresentationTemplates(): Promise<PresentationTemplate[]> {
  const [builtins, custom] = await Promise.all([
    builtinTemplates(),
    transaction<PresentationTemplate[]>([METADATA_STORE], 'readonly', '读取模板失败', (tx, result) => {
      const request = tx.objectStore(METADATA_STORE).getAll()
      request.onsuccess = () => result(request.result)
    }),
  ])
  custom.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
  return [...builtins.map(({ file: _file, ...metadata }) => metadata), ...custom]
}

export async function loadPresentationTemplate(template: PresentationTemplate): Promise<{ base64: string }> {
  if (template.source === 'builtin') {
    const builtin = (await builtinTemplates()).find(item => item.id === template.id)
    if (!builtin) throw new Error('找不到该内置模板，请重新打开模板栏。')
    let buffer: ArrayBuffer
    try {
      const response = await fetch(builtin.file)
      if (!response.ok) throw new Error('读取失败')
      const size = Number(response.headers.get('content-length'))
      if (size > MAX_PRESENTATION_TEMPLATE_BYTES) throw new Error('文件过大')
      buffer = await response.arrayBuffer()
    } catch { throw new Error('读取内置模板文件失败，请重试或重新安装应用。') }
    const bytes = new Uint8Array(buffer)
    validateBytes(bytes)
    return { base64: encodeTemplate(bytes) }
  }
  if (!template.id.startsWith(CUSTOM_PREFIX)) throw new Error('自定义模板标识无效。')
  const data = await transaction<TemplateData | undefined>([DATA_STORE], 'readonly', '读取模板失败', (tx, result) => {
    const request = tx.objectStore(DATA_STORE).get(template.id)
    request.onsuccess = () => result(request.result)
  })
  if (!data) throw new Error('该模板已被删除，请重新打开模板栏。')
  const bytes = new Uint8Array(data.bytes)
  validateBytes(bytes)
  return { base64: encodeTemplate(bytes) }
}

/** Names may repeat; each save creates an independent template and never overwrites one. */
export async function savePresentationTemplate(input: { name: string; base64: string; slideCount: number }): Promise<PresentationTemplate> {
  const name = normalizePresentationTemplateName(input.name)
  const slideCount = validateSlideCount(input.slideCount)
  const bytes = decodeTemplate(input.base64)
  const metadata: PresentationTemplate = {
    id: `${CUSTOM_PREFIX}${createId()}`, name, description: '从当前演示文稿保存',
    slideCount, createdAt: new Date().toISOString(), source: 'custom', accent: '#6576c8',
  }
  return transaction<PresentationTemplate>([METADATA_STORE, DATA_STORE], 'readwrite', '保存模板失败', (tx, result) => {
    tx.objectStore(METADATA_STORE).add(metadata)
    tx.objectStore(DATA_STORE).add({ id: metadata.id, bytes: bytes.buffer } satisfies TemplateData)
    result(metadata)
  })
}

export async function deletePresentationTemplate(id: string): Promise<void> {
  if (!id.startsWith(CUSTOM_PREFIX)) throw new Error('内置模板不能删除。')
  return transaction<void>([METADATA_STORE, DATA_STORE], 'readwrite', '删除模板失败', (tx, result) => {
    tx.objectStore(METADATA_STORE).delete(id)
    tx.objectStore(DATA_STORE).delete(id)
    result(undefined)
  })
}
