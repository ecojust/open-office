import { inflate, zlibSync } from 'fflate'
import { buildChartWorkbook } from './chart-workbook.ts'

export type TransitionType = 'none' | 'fade' | 'push' | 'wipe' | 'cover' | 'uncover' | 'split' | 'unknown'
export type TransitionDirection = 'l' | 'r' | 'u' | 'd' | 'lu' | 'ru' | 'ld' | 'rd' | 'in' | 'out'
export interface PptxTransition {
  type: TransitionType; rawType: string | null; supported: boolean
  durationMs: number | null; speed: 'slow' | 'med' | 'fast' | null
  advanceAfterMs: number | null; advanceOnClick: boolean
  direction?: TransitionDirection; orientation?: 'horz' | 'vert'
}
export interface PptxRect { x: number; y: number; width: number; height: number }
export interface PptxMedia {
  id: string; shapeId: string; name: string; kind: 'audio' | 'video'; mimeType: string
  data: Uint8Array | null; rect: PptxRect | null; rotation: number
  start: 'auto' | 'click' | 'unknown'; startDelayMs: number | null; loop: boolean
  external: boolean; partName: string | null; warnings: string[]
}
export interface PptxSlide {
  index: number; id: string; partName: string; name: string; title: string; notes: string; hidden: boolean
  transition: PptxTransition; media: PptxMedia[]; hasTransitionMetadata?: boolean; hasUnsupportedAnimations: boolean; warnings: string[]
}
export interface PptxPresentation {
  widthEmu: number; heightEmu: number; slides: PptxSlide[]; warnings: string[]
  hasMacros: boolean; hasDigitalSignatures: boolean
}
export interface TransitionPatch {
  type: Exclude<TransitionType, 'unknown'>; durationMs?: number
  advanceAfterMs?: number | null; advanceOnClick?: boolean
  direction?: TransitionDirection; orientation?: 'horz' | 'vert'
}
export interface NewPptxMedia {
  kind: 'audio' | 'video'; name: string; mimeType: string; data: Uint8Array
  rect: PptxRect; start: 'click' | 'auto'; loop?: boolean
}
export interface PptxPatch {
  slides: Array<{ slideIndex: number; name?: string; transition?: TransitionPatch; addMedia?: NewPptxMedia[]; removeMediaIds?: string[] }>
}
export interface PptxPackageOptions {
  signal?: AbortSignal
  xml?: { parse(source: string): Document; serialize(document: Document | Element): string }
}
export class PptxPackageError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'PptxPackageError' }
}
export const PPTX_LIMITS = Object.freeze({ inputBytes: 100 * 1024 * 1024, outputBytes: 100 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024, entries: 4096, xmlBytes: 8 * 1024 * 1024,
  mediaBytes: 64 * 1024 * 1024, slides: 500, inflateTimeoutMs: 15_000 })

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0 }
function fail(code: string, message: string): never { throw new PptxPackageError(code, message) }
function requireValue(condition: unknown, code: string, message: string): asserts condition { if (!condition) fail(code, message) }
function abort(options: PptxPackageOptions) { if (options.signal?.aborted) fail('ABORTED', 'PPTX 操作已取消。') }
function safeName(name: string) {
  requireValue(name && name.length <= 1024 && !/[\\\x00-\x1f\x7f:#?]/.test(name) && !name.startsWith('/') && !name.includes('//'), 'ZIP_PATH', 'PPTX 包含不安全的 ZIP 路径。')
  const parts = name.replace(/\/$/, '').split('/')
  requireValue(parts.every(part => part && part !== '.' && part !== '..'), 'ZIP_PATH', 'PPTX 包含越界 ZIP 路径。')
  requireValue(!['__proto__', 'prototype', 'constructor'].includes(name), 'ZIP_PATH', 'PPTX 包含保留路径。')
  return name
}
interface Entry { name: string; compressed: Uint8Array; method: number; size: number; crc: number; time: number; date: number; attrs: number; data?: Uint8Array }
type Archive = Map<string, Entry>

/** Inspect central and local headers before allocating or decompressing any member. ZIP64/encryption are deliberately unsupported. */
export function inspectPptxZip(input: Uint8Array | ArrayBuffer) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  requireValue(bytes.length >= 22 && bytes.length <= PPTX_LIMITS.inputBytes, 'ZIP_SIZE', 'PPTX 文件为空、损坏或超过 100 MiB。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break }
  }
  requireValue(end >= 0, 'ZIP_INVALID', '无法读取 PPTX 的 ZIP 目录。')
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true)
  requireValue(!view.getUint16(end + 4, true) && !view.getUint16(end + 6, true) && view.getUint16(end + 8, true) === count,
    'ZIP_MULTIDISK', '不支持分卷 PPTX。')
  requireValue(count > 0 && count <= PPTX_LIMITS.entries && directory + directorySize === end, 'ZIP_LIMIT', 'PPTX 目录无效或文件数量超过限制。')
  const entries: Entry[] = [], seen = new Set<string>(), ranges: Array<[number, number]> = []
  let offset = directory, total = 0
  for (let index = 0; index < count; index++) {
    requireValue(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50, 'ZIP_INVALID', 'PPTX 目录项损坏。')
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 24, true), compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true), attrs = view.getUint32(offset + 38, true)
    requireValue(!(flags & 1) && (method === 0 || method === 8) && size !== 0xffffffff && compressedSize !== 0xffffffff && local !== 0xffffffff,
      'ZIP_UNSUPPORTED', '不支持加密、ZIP64 或特殊压缩格式的 PPTX。')
    requireValue(offset + 46 + nameLength + extraLength + commentLength <= end && nameLength > 0, 'ZIP_INVALID', 'PPTX 文件名损坏。')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    requireValue((flags & 0x800) || nameBytes.every(byte => byte < 128), 'ZIP_ENCODING', 'PPTX ZIP 文件名必须采用 UTF-8。')
    let name: string
    try { name = safeName(textDecoder.decode(nameBytes)) } catch (error) { if (error instanceof PptxPackageError) throw error; fail('ZIP_ENCODING', 'PPTX 文件名编码无效。') }
    requireValue(!seen.has(name.toLowerCase()), 'ZIP_DUPLICATE', 'PPTX 包含重复或大小写歧义的文件。'); seen.add(name.toLowerCase())
    requireValue(((attrs >>> 16) & 0xf000) !== 0xa000, 'ZIP_SYMLINK', '不支持 PPTX 中的符号链接。')
    total += size
    requireValue(total <= PPTX_LIMITS.expandedBytes && size <= PPTX_LIMITS.mediaBytes, 'ZIP_EXPANSION', 'PPTX 解压内容超过安全限制。')
    requireValue(local + 30 <= directory && view.getUint32(local, true) === 0x04034b50, 'ZIP_INVALID', 'PPTX 本地文件头损坏。')
    const localNameLength = view.getUint16(local + 26, true), localExtraLength = view.getUint16(local + 28, true)
    const start = local + 30 + localNameLength + localExtraLength, stop = start + compressedSize
    requireValue(stop <= directory && localNameLength === nameLength && view.getUint16(local + 8, true) === method && view.getUint16(local + 6, true) === flags,
      'ZIP_INVALID', 'PPTX 压缩数据范围无效。')
    requireValue(bytes.subarray(local + 30, local + 30 + localNameLength).every((byte, i) => byte === nameBytes[i]), 'ZIP_INVALID', 'PPTX 文件头与目录文件名不一致。')
    requireValue(method !== 0 || size === compressedSize, 'ZIP_INVALID', 'PPTX 未压缩数据长度不一致。')
    ranges.push([local, stop])
    entries.push({ name, compressed: bytes.subarray(start, stop), method, size, crc: view.getUint32(offset + 16, true),
      time: view.getUint16(offset + 12, true), date: view.getUint16(offset + 14, true), attrs })
    offset += 46 + nameLength + extraLength + commentLength
  }
  requireValue(offset === end, 'ZIP_INVALID', 'PPTX 目录长度不一致。')
  ranges.sort((a, b) => a[0] - b[0]); for (let i = 1; i < ranges.length; i++) requireValue(ranges[i]![0] >= ranges[i - 1]![1], 'ZIP_OVERLAP', 'PPTX 文件数据范围重叠。')
  return { entries, expandedBytes: total }
}

function openArchive(input: Uint8Array | ArrayBuffer): Archive { return new Map(inspectPptxZip(input).entries.map(entry => [entry.name, entry])) }
async function get(archive: Archive, name: string, options: PptxPackageOptions, limit = PPTX_LIMITS.mediaBytes): Promise<Uint8Array> {
  abort(options)
  const entry = archive.get(name); requireValue(entry, 'PART_MISSING', `PPTX 缺少文件：${name}`)
  requireValue(entry.size <= limit, 'PART_LIMIT', `PPTX 文件过大：${name}`)
  if (entry.data) return entry.data
  const data = entry.method === 0 ? entry.compressed.slice() : await new Promise<Uint8Array>((resolve, reject) => {
    let stop: (() => void) | undefined, done = false
    const finish = (error: unknown, result?: Uint8Array) => {
      if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled)
      if (error) { stop?.(); reject(error) } else resolve(result!)
    }
    const cancelled = () => finish(new PptxPackageError('ABORTED', 'PPTX 操作已取消。'))
    const timer = setTimeout(() => finish(new PptxPackageError('ZIP_TIMEOUT', 'PPTX 解压超时，已停止处理。')), PPTX_LIMITS.inflateTimeoutMs)
    options.signal?.addEventListener('abort', cancelled, { once: true })
    try { stop = inflate(entry.compressed.slice(), { size: entry.size, consume: true }, (error, result) => finish(error, result)) }
    catch (error) { finish(error) }
  })
  requireValue(data.length === entry.size && crc32(data) === entry.crc, 'ZIP_CRC', `PPTX 内容校验失败：${name}`)
  entry.data = data; return data
}
function put(archive: Archive, name: string, data: Uint8Array) {
  safeName(name); const previous = archive.get(name)
  archive.set(name, { name, compressed: data, data, method: 0, size: data.length, crc: crc32(data), time: previous?.time ?? 0,
    date: previous?.date ?? 33, attrs: previous?.attrs ?? 0 })
}
function saveArchive(archive: Archive) {
  requireValue(archive.size <= PPTX_LIMITS.entries, 'ZIP_LIMIT', '修改后 PPTX 的文件数量超过限制。')
  const parts = [...archive.values()], names = parts.map(entry => textEncoder.encode(entry.name))
  const total = parts.reduce((sum, entry, i) => sum + 76 + names[i]!.length * 2 + entry.compressed.length, 22)
  requireValue(total <= PPTX_LIMITS.outputBytes && parts.reduce((sum, entry) => sum + entry.size, 0) <= PPTX_LIMITS.expandedBytes,
    'OUTPUT_LIMIT', '修改后 PPTX 超过大小限制；原文件未修改。')
  const output = new Uint8Array(total), view = new DataView(output.buffer), positions: number[] = []
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!, name = names[i]!; positions.push(cursor)
    view.setUint32(cursor, 0x04034b50, true); view.setUint16(cursor + 4, 20, true); view.setUint16(cursor + 6, 0x800, true)
    view.setUint16(cursor + 8, entry.method, true); view.setUint16(cursor + 10, entry.time, true); view.setUint16(cursor + 12, entry.date, true)
    view.setUint32(cursor + 14, entry.crc, true); view.setUint32(cursor + 18, entry.compressed.length, true); view.setUint32(cursor + 22, entry.size, true)
    view.setUint16(cursor + 26, name.length, true); output.set(name, cursor + 30); output.set(entry.compressed, cursor + 30 + name.length)
    cursor += 30 + name.length + entry.compressed.length
  }
  const directory = cursor
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!, name = names[i]!
    view.setUint32(cursor, 0x02014b50, true); view.setUint16(cursor + 4, 0x314, true); view.setUint16(cursor + 6, 20, true); view.setUint16(cursor + 8, 0x800, true)
    view.setUint16(cursor + 10, entry.method, true); view.setUint16(cursor + 12, entry.time, true); view.setUint16(cursor + 14, entry.date, true)
    view.setUint32(cursor + 16, entry.crc, true); view.setUint32(cursor + 20, entry.compressed.length, true); view.setUint32(cursor + 24, entry.size, true)
    view.setUint16(cursor + 28, name.length, true); view.setUint32(cursor + 38, entry.attrs, true); view.setUint32(cursor + 42, positions[i]!, true)
    output.set(name, cursor + 46); cursor += 46 + name.length
  }
  view.setUint32(cursor, 0x06054b50, true); view.setUint16(cursor + 8, parts.length, true); view.setUint16(cursor + 10, parts.length, true)
  view.setUint32(cursor + 12, cursor - directory, true); view.setUint32(cursor + 16, directory, true)
  return output
}

function parser(options: PptxPackageOptions) {
  if (options.xml) return options.xml
  requireValue(typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined', 'XML_ENVIRONMENT', '需要浏览器 XML 解析器。')
  return { parse: (source: string) => new DOMParser().parseFromString(source, 'application/xml'), serialize: (document: Document | Element) => new XMLSerializer().serializeToString(document) }
}
function readXmlString(source: string, options: PptxPackageOptions) {
  requireValue(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source), 'XML_ENTITY', 'PPTX XML 不允许 DTD 或实体声明。')
  const doc = parser(options).parse(source)
  requireValue(doc.documentElement && !doc.getElementsByTagName('parsererror').length, 'XML_INVALID', 'PPTX XML 内容无效。')
  return doc
}
async function xml(archive: Archive, name: string, options: PptxPackageOptions) {
  const data = await get(archive, name, options, PPTX_LIMITS.xmlBytes)
  let source: string
  try { source = data[0] === 255 && data[1] === 254 ? new TextDecoder('utf-16le', { fatal: true }).decode(data)
    : data[0] === 254 && data[1] === 255 ? new TextDecoder('utf-16be', { fatal: true }).decode(data) : textDecoder.decode(data) }
  catch { fail('XML_ENCODING', 'PPTX XML 编码无效。') }
  return readXmlString(source, options)
}
function putXml(archive: Archive, name: string, document: Document, options: PptxPackageOptions) { put(archive, name, textEncoder.encode(parser(options).serialize(document))) }

/** Read a bounded, CRC-checked package for the independent presentation editor.
 * Every XML member is checked, including extensions that the editor preserves.
 * Returned buffers are detached copies; callers never receive archive internals. */
export async function readPptxParts(input: Uint8Array | ArrayBuffer, options: PptxPackageOptions = {}): Promise<Map<string, Uint8Array>> {
  const archive = openArchive(input), parts = new Map<string, Uint8Array>()
  for (const name of archive.keys()) {
    const isXml = /(?:\.xml|\.rels)$/i.test(name)
    const bytes = await get(archive, name, options, isXml ? PPTX_LIMITS.xmlBytes : PPTX_LIMITS.mediaBytes)
    if (isXml) await xml(archive, name, options)
    parts.set(name, bytes.slice())
  }
  return parts
}

/** Write copies of validated package members without mutating the source map. */
export function writePptxParts(parts: Map<string, Uint8Array>): Uint8Array {
  const archive: Archive = new Map()
  for (const [name, bytes] of parts) {
    requireValue(bytes instanceof Uint8Array && bytes.byteLength <= PPTX_LIMITS.mediaBytes, 'PART_LIMIT', `PPTX 文件过大：${name}`)
    if (/(?:\.xml|\.rels)$/i.test(name)) {
      requireValue(bytes.byteLength <= PPTX_LIMITS.xmlBytes, 'PART_LIMIT', `PPTX XML 文件过大：${name}`)
      const source = bytes[0] === 255 && bytes[1] === 254 ? new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
        : bytes[0] === 254 && bytes[1] === 255 ? new TextDecoder('utf-16be', { fatal: true }).decode(bytes) : textDecoder.decode(bytes)
      readXmlString(source, {})
    }
    put(archive, name, bytes)
  }
  return saveArchive(archive)
}
function children(node: Element | Document, local?: string) { return Array.from(node.children).filter(child => !local || child.localName === local) }
function descendants(node: Element | Document, local: string) { return Array.from(node.getElementsByTagNameNS('*', local)) }
function child(node: Element | Document, local: string) { return children(node, local)[0] }
function attribute(node: Element, local: string, ns = R) { return node.getAttributeNS(ns, local) || Array.from(node.attributes).find(attr => attr.localName === local && /\/relationships$/.test(attr.namespaceURI || ''))?.value || '' }
function element(document: Document, local: string, ns = P, prefix = 'p') { return document.createElementNS(ns, `${prefix}:${local}`) }
function append(parent: Element, local: string, attributes: Record<string, string | number> = {}, ns = P, prefix = 'p') {
  const node = element(parent.ownerDocument, local, ns, prefix); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); parent.appendChild(node); return node
}
function relationPart(part: string) { const slash = part.lastIndexOf('/'); return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` }
function resolvePart(part: string, target: string) {
  requireValue(target && !/[\\\x00-\x1f\x7f?#]/.test(target) && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('//'), 'RELATION_TARGET', 'PPTX 内部关系指向无效路径。')
  let decoded: string; try { decoded = decodeURIComponent(target) } catch { fail('RELATION_TARGET', 'PPTX 关系路径编码无效。') }
  requireValue(!/[\\\x00-\x1f\x7f?#]/.test(decoded) && !/^[a-z][a-z\d+.-]*:/i.test(decoded) && !decoded.startsWith('//'), 'RELATION_TARGET', 'PPTX 解码后的关系路径无效。')
  const output = decoded.startsWith('/') ? [] : part.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { requireValue(output.length, 'RELATION_TARGET', 'PPTX 关系路径越界。'); output.pop() } else output.push(segment)
  }
  return safeName(output.join('/'))
}
function relativePart(from: string, to: string) { const a = from.split('/').slice(0, -1), b = to.split('/'); while (a.length && a[0] === b[0]) { a.shift(); b.shift() }; return [...a.map(() => '..'), ...b].join('/') }
interface Relationship { id: string; type: string; target: string; external: boolean; node: Element }
async function relationships(archive: Archive, part: string, options: PptxPackageOptions) {
  const path = part ? relationPart(part) : '_rels/.rels'
  const doc = archive.has(path) ? await xml(archive, path, options) : readXmlString(`<Relationships xmlns="${PR}"/>`, options)
  requireValue(doc.documentElement.localName === 'Relationships', 'RELATION_XML', 'PPTX 关系文件无效。')
  const map = new Map<string, Relationship>()
  for (const node of children(doc.documentElement, 'Relationship')) {
    const id = node.getAttribute('Id') || '', target = node.getAttribute('Target') || ''
    requireValue(id && target && !map.has(id), 'RELATION_DUPLICATE', 'PPTX 关系编号无效或重复。')
    map.set(id, { id, type: node.getAttribute('Type') || '', target, external: node.getAttribute('TargetMode') === 'External', node })
  }
  return { path, doc, map }
}
async function contents(archive: Archive, options: PptxPackageOptions) {
  const doc = await xml(archive, '[Content_Types].xml', options)
  return { doc, type(part: string) { return children(doc.documentElement, 'Override').find(n => n.getAttribute('PartName') === '/' + part)?.getAttribute('ContentType')
    || children(doc.documentElement, 'Default').find(n => n.getAttribute('Extension')?.toLowerCase() === part.split('.').at(-1)?.toLowerCase())?.getAttribute('ContentType') || 'application/octet-stream' } }
}
async function structure(archive: Archive, options: PptxPackageOptions) {
  const root = await relationships(archive, '', options), office = [...root.map.values()].find(rel => rel.type.endsWith('/officeDocument'))
  requireValue(office && !office.external, 'PRESENTATION_MISSING', '文件不包含本地 PPTX 演示文稿。')
  const part = resolvePart('', office.target), doc = await xml(archive, part, options), rels = await relationships(archive, part, options)
  const size = child(doc.documentElement, 'sldSz'), width = Number(size?.getAttribute('cx')), height = Number(size?.getAttribute('cy'))
  requireValue(width > 0 && height > 0 && width < 1e9 && height < 1e9, 'SLIDE_SIZE', '无法读取有效幻灯片尺寸。')
  const nodes = child(doc.documentElement, 'sldIdLst'), ordered = nodes ? children(nodes, 'sldId') : []
  requireValue(ordered.length > 0 && ordered.length <= PPTX_LIMITS.slides, 'SLIDE_LIMIT', 'PPTX 必须包含 1–500 页。')
  const used = new Set<string>(), slides = ordered.map((node, index) => {
    const rel = rels.map.get(attribute(node, 'id')); requireValue(rel && !rel.external && rel.type.endsWith('/slide'), 'SLIDE_RELATION', '幻灯片关系无效。')
    const path = resolvePart(part, rel.target); requireValue(!used.has(path), 'SLIDE_DUPLICATE', '幻灯片顺序包含重复页面。'); used.add(path)
    return { index, id: node.getAttribute('id') || String(index), partName: path }
  })
  return { widthEmu: width, heightEmu: height, slides }
}
function milliseconds(value: string | null): number | null { if (value === null || value === '') return null; const result = Number(value); return Number.isFinite(result) && result >= 0 && result <= 86400000 ? result : null }
function transitionFor(doc: Document): PptxTransition {
  const node = child(doc.documentElement, 'transition') || descendants(doc.documentElement, 'transition')[0]
  if (!node) return { type: 'none', rawType: null, supported: true, durationMs: 0, speed: null, advanceAfterMs: null, advanceOnClick: true }
  const effect = children(node).find(n => !['sndAc', 'extLst'].includes(n.localName)), rawType = effect?.localName || null
  const supported = (!rawType || ['fade', 'push', 'wipe', 'cover', 'uncover', 'split'].includes(rawType)) && !['1','true'].includes(effect?.getAttribute('thruBlk') || '')
  const direction = effect?.getAttribute('dir'), orientation = effect?.getAttribute('orient'), speed = node.getAttribute('spd')
  const result: PptxTransition = { type: supported ? (rawType || 'none') as TransitionType : 'unknown', rawType,
    supported, durationMs: milliseconds(node.getAttributeNS(P14, 'dur')),
    speed: speed === 'slow' || speed === 'med' || speed === 'fast' ? speed : null,
    advanceAfterMs: milliseconds(node.getAttribute('advTm')), advanceOnClick: !['0', 'false'].includes(node.getAttribute('advClick') || '') }
  if (direction && ['l','r','u','d','lu','ru','ld','rd','in','out'].includes(direction)) result.direction = direction as TransitionDirection
  if (orientation === 'horz' || orientation === 'vert') result.orientation = orientation
  return result
}
function hasTransitionMetadata(doc: Document) {
  return descendants(doc, 'transition').some(node => children(node).length > 0 || Array.from(node.attributes).some(attr =>
    attr.namespaceURI !== XMLNS && !(attr.namespaceURI === P14 && attr.localName === 'dur')
    && !(!attr.namespaceURI && ['advClick','advTm','spd'].includes(attr.localName))))
}
function textOf(node: Element) { return descendants(node, 'p').map(p => descendants(p, 't').map(t => t.textContent || '').join('')).join('\n').trim() }
function mediaShapes(doc: Document) { return descendants(doc.documentElement, 'pic').filter(pic => descendants(pic, 'audioFile').length || descendants(pic, 'videoFile').length || descendants(pic, 'media').length) }
function mediaTiming(doc: Document, shapeId: string) {
  for (const node of [...descendants(doc, 'audio'), ...descendants(doc, 'video')]) {
    const media = child(node, 'cMediaNode'); if (!media || descendants(media, 'spTgt')[0]?.getAttribute('spid') !== shapeId) continue
    const timing = child(media, 'cTn'), conditions = timing && child(timing, 'stCondLst'), condition = conditions && child(conditions, 'cond')
    const delay = condition ? milliseconds(condition.getAttribute('delay')) : null, evt = condition?.getAttribute('evt')
    let start: PptxMedia['start'] = evt === 'onClick' ? 'click' : !evt && delay !== null ? 'auto' : 'unknown'
    for (let ancestor = media.parentElement; ancestor && ancestor.localName !== 'timing'; ancestor = ancestor.parentElement) {
      if (ancestor.getAttribute('nodeType') === 'clickEffect') start = 'click'
    }
    return { start, startDelayMs: delay, loop: timing?.getAttribute('repeatCount') === 'indefinite' }
  }
  return { start: 'unknown' as const, startDelayMs: null, loop: false }
}
function mediaRect(shape: Element, width: number, height: number): { rect: PptxRect | null; rotation: number } {
  const xfrm = child(shape, 'spPr') && child(child(shape, 'spPr')!, 'xfrm'), off = xfrm && child(xfrm, 'off'), ext = xfrm && child(xfrm, 'ext')
  if (!off || !ext) return { rect: null, rotation: 0 }
  let x = Number(off.getAttribute('x')), y = Number(off.getAttribute('y')), w = Number(ext.getAttribute('cx')), h = Number(ext.getAttribute('cy'))
  for (let parent = shape.parentElement; parent?.localName === 'grpSp'; parent = parent.parentElement) {
    const groupProperties = child(parent, 'grpSpPr'), transform = groupProperties && child(groupProperties, 'xfrm')
    if (!transform || Number(transform.getAttribute('rot') || 0) || transform.getAttribute('flipH') === '1' || transform.getAttribute('flipV') === '1') return { rect: null, rotation: 0 }
    const origin = child(transform, 'off'), extent = child(transform, 'ext'), chOrigin = child(transform, 'chOff'), chExtent = child(transform, 'chExt')
    if (!origin || !extent || !chOrigin || !chExtent) return { rect: null, rotation: 0 }
    const sx = Number(extent.getAttribute('cx')) / Number(chExtent.getAttribute('cx')), sy = Number(extent.getAttribute('cy')) / Number(chExtent.getAttribute('cy'))
    x = Number(origin.getAttribute('x')) + (x - Number(chOrigin.getAttribute('x'))) * sx; y = Number(origin.getAttribute('y')) + (y - Number(chOrigin.getAttribute('y'))) * sy; w *= sx; h *= sy
  }
  if (![x,y,w,h].every(Number.isFinite) || w <= 0 || h <= 0) return { rect: null, rotation: 0 }
  return { rect: { x: x / width, y: y / height, width: w / width, height: h / height }, rotation: Number(xfrm?.getAttribute('rot') || 0) / 60000 }
}

export async function parsePptxPackage(input: Uint8Array | ArrayBuffer, options: PptxPackageOptions = {}): Promise<PptxPresentation> {
  const archive = openArchive(input), layout = await structure(archive, options), types = await contents(archive, options), slides: PptxSlide[] = []
  for (const definition of layout.slides) {
    abort(options)
    const doc = await xml(archive, definition.partName, options), rels = await relationships(archive, definition.partName, options)
    const shapes = descendants(doc, 'sp'), titleShape = shapes.find(shape => ['title','ctrTitle'].includes(descendants(shape, 'ph')[0]?.getAttribute('type') || ''))
    const media: PptxMedia[] = [], warnings: string[] = []; let notes = ''
    const noteRelation = [...rels.map.values()].find(rel => rel.type.endsWith('/notesSlide'))
    if (noteRelation && !noteRelation.external) {
      const note = await xml(archive, resolvePart(definition.partName, noteRelation.target), options)
      notes = descendants(note, 'sp').filter(shape => !['sldImg','sldNum','dt','ftr','hdr'].includes(descendants(shape, 'ph')[0]?.getAttribute('type') || '')).map(textOf).filter(Boolean).join('\n')
    }
    for (const shape of mediaShapes(doc)) {
      const meta = descendants(shape, 'cNvPr')[0], shapeId = meta?.getAttribute('id') || '', file = descendants(shape, 'videoFile')[0] || descendants(shape, 'audioFile')[0]
      const embedded = descendants(shape, 'media')[0], id = embedded ? attribute(embedded, 'embed') : file ? attribute(file, 'link') : ''
      const rel = rels.map.get(id), external = rel?.external ?? true, partName = rel && !external ? resolvePart(definition.partName, rel.target) : null
      const mimeType = partName ? types.type(partName) : 'application/octet-stream', ownWarnings: string[] = []
      const kind = file?.localName === 'videoFile' || mimeType.startsWith('video/') ? 'video' : 'audio'
      const geometry = mediaRect(shape, layout.widthEmu, layout.heightEmu), timing = mediaTiming(doc, shapeId)
      if (external) ownWarnings.push('外部链接媒体已禁用，不会联网加载。')
      if (!geometry.rect) ownWarnings.push('无法可靠映射媒体位置；未猜测组合或母版坐标。')
      if (timing.start === 'unknown') ownWarnings.push('媒体开始时序未识别；需手动播放。')
      media.push({ id: shapeId, shapeId, name: meta?.getAttribute('name') || `${kind}-${shapeId}`, kind, mimeType,
        data: partName ? await get(archive, partName, options) : null, ...geometry, ...timing, external, partName, warnings: ownWarnings })
    }
    const unsupported = descendants(doc, 'timing').some(timing => descendants(timing, 'anim').length || descendants(timing, 'animEffect').length
      || descendants(timing, 'animClr').length || descendants(timing, 'bldLst').length || descendants(timing, 'animMotion').length || descendants(timing, 'animRot').length || descendants(timing, 'animScale').length || descendants(timing, 'set').length || descendants(timing, 'cmd').length)
    if (unsupported) warnings.push('此页包含尚未实现的对象动画；原始动画 XML 会保留，放映不伪装执行。')
    const transition = transitionFor(doc); if (!transition.supported) warnings.push(`未实现原始转场：${transition.rawType || 'unknown'}。`)
    if (descendants(doc,'transition').some(node => descendants(node,'sndAc').length)) warnings.push('此页转场声音尚不在内置放映中播放；保存时保留原声音与设置。')
    slides.push({ ...definition, name: child(doc.documentElement, 'cSld')?.getAttribute('name') || '', title: textOf(titleShape || shapes.find(shape => textOf(shape)) || doc.documentElement).slice(0, 1000), notes,
      hidden: ['0','false'].includes(doc.documentElement.getAttribute('show') || ''), transition, media, hasTransitionMetadata: hasTransitionMetadata(doc), hasUnsupportedAnimations: unsupported, warnings })
  }
  return { ...layout, slides, warnings: [], hasMacros: [...archive.keys()].some(name => /vbaProject\.bin$/i.test(name)),
    hasDigitalSignatures: [...archive.keys()].some(name => name.startsWith('_xmlsignatures/')) }
}

function checkEditable(archive: Archive) { requireValue(![...archive.keys()].some(name => name.startsWith('_xmlsignatures/')), 'SIGNED_PACKAGE', '此 PPTX 含数字签名，修改会使签名失效。请先在原编辑器另存未签名副本。') }
function uniquePart(archive: Archive, stem: string, extension: string) { for (let id = 1; id <= PPTX_LIMITS.entries; id++) { const name = `${stem}${id}.${extension}`; if (!archive.has(name)) return name }; return fail('ZIP_LIMIT', '无法分配新的 PPTX 文件名。') }
function addRelation(rels: Awaited<ReturnType<typeof relationships>>, type: string, target: string) {
  let counter = 1; while (rels.map.has(`rIdOpenOffice${counter}`)) counter++
  const id = `rIdOpenOffice${counter}`, node = rels.doc.createElementNS(PR, 'Relationship')
  for (const [key, value] of Object.entries({ Id: id, Type: type, Target: target })) node.setAttribute(key, value)
  rels.doc.documentElement.appendChild(node); rels.map.set(id, { id, type, target, external: false, node }); return id
}
function overrideType(doc: Document, part: string, mime: string) {
  const existing = children(doc.documentElement, 'Override').find(node => node.getAttribute('PartName') === '/' + part)
  const node = existing || doc.createElementNS(CT, 'Override'); node.setAttribute('PartName', '/' + part); node.setAttribute('ContentType', mime)
  if (!existing) doc.documentElement.appendChild(node)
}
function insertSlideChild(root: Element, node: Element, name: 'transition' | 'timing') {
  const after = name === 'transition' ? ['timing','extLst'] : ['extLst']
  root.insertBefore(node, children(root).find(child => after.includes(child.localName)) || null)
}
function writeTransition(doc: Document, patch: TransitionPatch) {
  requireValue(['none','fade','push','wipe','cover','uncover','split'].includes(patch.type), 'TRANSITION_TYPE', '不支持指定的转场类型。')
  for (const value of [patch.durationMs, patch.advanceAfterMs]) requireValue(value == null || Number.isSafeInteger(value) && value >= 0 && value <= 86400000, 'TRANSITION_TIME', '转场或切页时间无效。')
  for (const old of featureRoots(doc, 'transition')) old.remove()
  const node = element(doc, 'transition', doc.documentElement.namespaceURI || P)
  node.setAttribute('advClick', patch.advanceOnClick === false ? '0' : '1')
  if (patch.durationMs !== undefined) { allowP14(doc); node.setAttributeNS(P14, 'p14:dur', String(patch.durationMs)); node.setAttribute('spd', patch.durationMs <= 500 ? 'fast' : patch.durationMs <= 1000 ? 'med' : 'slow') }
  if (patch.advanceAfterMs != null) node.setAttribute('advTm', String(patch.advanceAfterMs))
  if (patch.type !== 'none') {
    const effect = append(node, patch.type)
    if (patch.direction) { const allowed = patch.type === 'split' ? ['in','out'] : ['cover','uncover'].includes(patch.type) ? ['l','r','u','d','lu','ru','ld','rd'] : ['push','wipe'].includes(patch.type) ? ['l','r','u','d'] : []; requireValue(allowed.includes(patch.direction), 'TRANSITION_DIRECTION', '此转场不支持指定方向。'); effect.setAttribute('dir', patch.direction) }
    if (patch.orientation) { requireValue(patch.type === 'split' && (patch.orientation === 'horz' || patch.orientation === 'vert'), 'TRANSITION_DIRECTION', '拆分方向无效。'); effect.setAttribute('orient', patch.orientation) }
  }
  insertSlideChild(doc.documentElement, node, 'transition')
}
function allowP14(doc: Document) {
  doc.documentElement.setAttributeNS(XMLNS, 'xmlns:p14', P14)
  doc.documentElement.setAttributeNS(XMLNS, 'xmlns:mc', MC)
  const names = new Set((doc.documentElement.getAttributeNS(MC, 'Ignorable') || '').split(/\s+/).filter(Boolean)); names.add('p14')
  doc.documentElement.setAttributeNS(MC, 'mc:Ignorable', [...names].join(' '))
}
function nextNumericId(doc: Element | Document, name: string) {
  let id = 0; for (const node of descendants(doc, name)) {
    const value = Number(node.getAttribute('id'))
    requireValue(Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff, 'SHAPE_ID', 'PPTX 形状或动画编号无效。')
    id = Math.max(id, value)
  }
  return id + 1
}
function poster() {
  const width = 96, height = 60, raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 4 + 1) + 1 + x * 4, play = x >= 37 && x <= 62 && Math.abs(y - 30) <= (62 - x) * 0.65
    raw.set(play ? [245,247,250,255] : [32,45,65,255], offset) }
  const u32 = (value: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b }
  const chunk = (name: string, data: Uint8Array) => { const type = textEncoder.encode(name), content = new Uint8Array(type.length + data.length); content.set(type); content.set(data, 4); const out = new Uint8Array(data.length + 12); out.set(u32(data.length)); out.set(content, 4); out.set(u32(crc32(content)), out.length - 4); return out }
  const ihdr = new Uint8Array(13); ihdr.set(u32(width)); ihdr.set(u32(height),4); ihdr.set([8,6,0,0,0],8)
  const chunks = [new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlibSync(raw)),chunk('IEND',new Uint8Array())]
  const out = new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0)); let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length};return out
}
const mediaTypes: Record<string, { extension: string; kind: NewPptxMedia['kind'] }> = {
  'audio/mpeg': { extension: 'mp3', kind: 'audio' }, 'audio/wav': { extension: 'wav', kind: 'audio' },
  'audio/ogg': { extension: 'ogg', kind: 'audio' }, 'video/mp4': { extension: 'mp4', kind: 'video' }, 'video/webm': { extension: 'webm', kind: 'video' },
}
function validateMedia(media: NewPptxMedia) {
  const format = mediaTypes[media.mimeType]; requireValue(format && format.kind === media.kind, 'MEDIA_TYPE', '请选择支持的本地 MP3/WAV/OGG 音频或 MP4/WebM 视频。')
  requireValue(media.data instanceof Uint8Array && media.data.length >= 12 && media.data.length <= PPTX_LIMITS.mediaBytes, 'MEDIA_SIZE', '媒体为空、无效或超过 64 MiB。')
  const r = media.rect; requireValue(r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, 'MEDIA_RECT', '媒体位置必须在幻灯片范围内。')
  requireValue(media.start === 'click' || media.start === 'auto', 'MEDIA_START', '媒体启动方式无效。')
  const b = media.data, prefix = new TextDecoder('latin1').decode(b.subarray(0, 12))
  const valid = format.extension === 'wav' ? prefix.startsWith('RIFF') && prefix.slice(8) === 'WAVE'
    : format.extension === 'mp3' ? prefix.startsWith('ID3') || b[0] === 255 && (b[1]! & 0xe0) === 0xe0
    : format.extension === 'ogg' ? prefix.startsWith('OggS') : format.extension === 'mp4' ? prefix.slice(4,8) === 'ftyp'
    : b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
  requireValue(valid, 'MEDIA_SIGNATURE', '媒体文件内容与所选格式不一致。'); return format
}
async function addMedia(archive: Archive, part: string, doc: Document, media: NewPptxMedia, width: number, height: number, types: Document, options: PptxPackageOptions) {
  allowP14(doc)
  const format = validateMedia(media), mediaPart = uniquePart(archive, 'ppt/media/openoffice-media-', format.extension)
  put(archive, mediaPart, media.data.slice()); overrideType(types, mediaPart, media.mimeType)
  const posterPart = uniquePart(archive, 'ppt/media/openoffice-poster-', 'png'); put(archive, posterPart, poster()); overrideType(types, posterPart, 'image/png')
  const rels = await relationships(archive, part, options), legacy = addRelation(rels, `${R}/${media.kind}`, relativePart(part, mediaPart))
  const embedded = addRelation(rels, 'http://schemas.microsoft.com/office/2007/relationships/media', relativePart(part, mediaPart)), image = addRelation(rels, `${R}/image`, relativePart(part, posterPart))
  const next = nextNumericId(doc, 'cNvPr')
  const tree = descendants(doc, 'spTree')[0]; requireValue(tree, 'SLIDE_STRUCTURE', '幻灯片缺少形状容器。')
  const pic = append(tree, 'pic'), nv = append(pic, 'nvPicPr'), meta = append(nv, 'cNvPr', { id: next, name: `OpenOfficeMedia-${next}-${media.name.slice(0,120)}` })
  const click = append(meta, 'hlinkClick', { action: 'ppaction://media' }, A, 'a'); click.setAttributeNS(R, 'r:id', '')
  append(nv, 'cNvPicPr'); const nvPr = append(nv, 'nvPr'), file = append(nvPr, `${media.kind}File`, {}, A, 'a'); file.setAttributeNS(R, 'r:link', legacy)
  const ext = append(append(nvPr, 'extLst'), 'ext', { uri: '{DAA4B4D4-6D71-4841-9C94-3DE7FCFB2936}' }), p14 = append(ext, 'media', {}, P14, 'p14'); p14.setAttributeNS(R, 'r:embed', embedded)
  const fill = append(pic, 'blipFill'), blip = append(fill, 'blip', {}, A, 'a'); blip.setAttributeNS(R, 'r:embed', image); append(append(fill, 'stretch', {}, A, 'a'), 'fillRect', {}, A, 'a')
  const spPr = append(pic, 'spPr'), transform = append(spPr, 'xfrm', {}, A, 'a')
  append(transform, 'off', { x: Math.round(media.rect.x * width), y: Math.round(media.rect.y * height) }, A, 'a')
  append(transform, 'ext', { cx: Math.round(media.rect.width * width), cy: Math.round(media.rect.height * height) }, A, 'a')
  append(append(spPr, 'prstGeom', { prst: 'rect' }, A, 'a'), 'avLst', {}, A, 'a')
  let timing = child(doc.documentElement, 'timing'); if (!timing) { timing = element(doc, 'timing'); insertSlideChild(doc.documentElement, timing, 'timing') }
  let root = descendants(timing, 'cTn').find(n => n.getAttribute('nodeType') === 'tmRoot')
  if (!root) { let list = child(timing, 'tnLst'); if (!list) list = append(timing, 'tnLst'); root = append(append(list, 'par'), 'cTn', { id: nextNumericId(timing,'cTn'), dur: 'indefinite', restart: 'never', nodeType: 'tmRoot' }) }
  let list = child(root, 'childTnLst'); if (!list) list = append(root, 'childTnLst')
  const mediaNode = append(append(list, media.kind), 'cMediaNode', { vol: 100000, showWhenStopped: 1 }), node = append(mediaNode, 'cTn', { id: nextNumericId(timing,'cTn'), fill: 'hold', display: 0 })
  if (media.loop) node.setAttribute('repeatCount', 'indefinite')
  const condition = append(append(node,'stCondLst'),'cond',{ delay:0,...(media.start==='click'?{evt:'onClick'}:{}) })
  if (media.start==='click') append(append(condition,'tgtEl'),'spTgt',{spid:next})
  append(append(mediaNode,'tgtEl'),'spTgt',{spid:next})
  putXml(archive, rels.path, rels.doc, options)
}

export async function patchPptxPackage(input: Uint8Array | ArrayBuffer, patch: PptxPatch, options: PptxPackageOptions = {}): Promise<Uint8Array> {
  const archive = openArchive(input); checkEditable(archive)
  const layout = await structure(archive, options), types = await contents(archive, options), seen = new Set<number>()
  requireValue(Array.isArray(patch.slides) && patch.slides.length <= layout.slides.length, 'PATCH_INVALID', '页面修改列表无效。')
  for (const change of patch.slides) {
    requireValue(Number.isInteger(change.slideIndex) && !seen.has(change.slideIndex) && layout.slides[change.slideIndex], 'PATCH_INDEX', '页面修改编号无效或重复。'); seen.add(change.slideIndex)
    const part = layout.slides[change.slideIndex]!.partName, doc = await xml(archive, part, options)
    if (change.transition || change.addMedia?.length) requireValue(doc.documentElement.namespaceURI === P, 'STRICT_OOXML', '严格 OOXML 可读取与保留，添加效果请先另存为标准 PPTX。')
    if (change.name !== undefined) {
      requireValue(typeof change.name === 'string' && change.name.length <= 1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(change.name), 'SLIDE_NAME', '页面名称过长或包含非法字符。')
      const content = child(doc.documentElement, 'cSld'); requireValue(content, 'SLIDE_STRUCTURE', '幻灯片缺少内容容器。'); content.setAttribute('name', change.name)
    }
    if (change.transition) writeTransition(doc, change.transition)
    for (const id of change.removeMediaIds || []) {
      const shapes = mediaShapes(doc).filter(shape => descendants(shape,'cNvPr')[0]?.getAttribute('id') === id)
      requireValue(shapes.length === 1, 'MEDIA_ID', '无法唯一定位要删除的媒体。'); shapes[0]!.remove()
      for (const node of [...descendants(doc,'audio'),...descendants(doc,'video')]) if (descendants(node,'spTgt').some(target=>target.getAttribute('spid')===id)) node.remove()
    }
    requireValue((change.addMedia?.length || 0) <= 32, 'MEDIA_LIMIT', '单次最多添加 32 个媒体文件。')
    for (const media of change.addMedia || []) await addMedia(archive, part, doc, media, layout.widthEmu, layout.heightEmu, types.doc, options)
    putXml(archive, part, doc, options)
  }
  putXml(archive, '[Content_Types].xml', types.doc, options); abort(options); return saveArchive(archive)
}

export async function patchPptxPageNames(input: Uint8Array | ArrayBuffer, names: string[], options: PptxPackageOptions = {}) {
  const layout = await structure(openArchive(input), options)
  requireValue(Array.isArray(names) && names.length === layout.slides.length, 'SLIDE_MAPPING', '页面名称数量与 PPTX 页数不一致。')
  return patchPptxPackage(input, { slides: names.map((name, slideIndex) => ({ slideIndex, name })) }, options)
}

export interface PptxSlideMapping { sourceIndex: number; targetIndex: number }
function featureRoots(doc: Document, kind?: 'transition' | 'timing') {
  const names = kind ? [kind] : ['transition', 'timing']
  return children(doc.documentElement).filter(node => names.includes(node.localName as 'transition' | 'timing')
    || node.localName === 'AlternateContent' && names.some(name => descendants(node, name).length))
}
function shapeForMeta(meta: Element): Element | null {
  const wrapper = meta.parentElement, shape = wrapper?.parentElement
  return shape && ['sp','pic','graphicFrame','cxnSp','grpSp'].includes(shape.localName) ? shape : null
}
function shapeNames(doc: Document) {
  const names = new Map<string, Element[]>()
  for (const meta of descendants(doc, 'cNvPr')) {
    const name = meta.getAttribute('name'); if (!name || !shapeForMeta(meta)) continue
    names.set(name, [...(names.get(name) || []), meta])
  }
  return names
}
function relationshipAttributes(root: Element) {
  return [root,...Array.from(root.getElementsByTagName('*'))].flatMap(node => Array.from(node.attributes)
    .filter(attr => /\/relationships$/.test(attr.namespaceURI || '') && ['id','embed','link'].includes(attr.localName) && attr.value)
    .map(attr => ({ node, attr })))
}
function copyNamespaceContext(from: Document, to: Document) {
  // Choice/@Requires and mc:Ignorable contain prefix strings; DOM import alone
  // cannot infer and retain the namespace declarations these strings refer to.
  for (const attr of Array.from(from.documentElement.attributes)) if (attr.namespaceURI === XMLNS && attr.localName !== 'xmlns') {
    const present = to.documentElement.getAttributeNS(XMLNS, attr.localName)
    requireValue(!present || present === attr.value, 'NAMESPACE_MAPPING', `原效果命名空间 ${attr.localName} 与目标冲突，已停止合并。`)
    to.documentElement.setAttributeNS(XMLNS, attr.name, attr.value)
  }
  const values = new Set([from,to].flatMap(doc => (doc.documentElement.getAttributeNS(MC,'Ignorable') || '').split(/\s+/).filter(Boolean)))
  if (values.size) { to.documentElement.setAttributeNS(XMLNS,'xmlns:mc',MC); to.documentElement.setAttributeNS(MC,'mc:Ignorable',[...values].join(' ')) }
}

/**
 * Preserve authoritative slide effects after an editor re-exports its ordinary shapes.
 * Never guess page order or non-media animation targets. Named shapes must match uniquely.
 * Unrecognised animation XML is retained, not simulated. External relationships are retained
 * as links only; no request is made to them. Unmapped target pages remain unchanged.
 */
export async function transplantPresentationFeatures(sourceInput: Uint8Array | ArrayBuffer,
  targetInput: Uint8Array | ArrayBuffer, mapping?: PptxSlideMapping[], options: PptxPackageOptions = {}): Promise<Uint8Array> {
  const source = openArchive(sourceInput), target = openArchive(targetInput); checkEditable(target)
  const sourceLayout = await structure(source, options), targetLayout = await structure(target, options)
  const sourceTypes = await contents(source, options), targetTypes = await contents(target, options)
  if (!mapping) requireValue(sourceLayout.slides.length === targetLayout.slides.length, 'SLIDE_MAPPING', '页面数量变化，请提供明确的原页与新页对应关系。')
  const pairs = mapping || sourceLayout.slides.map((slide, index) => ({ sourceIndex: slide.index, targetIndex: index }))
  requireValue(Array.isArray(pairs) && pairs.length <= PPTX_LIMITS.slides, 'SLIDE_MAPPING', '页面对应关系无效。')
  const mappedTargets = new Set<number>(), copied = new Map<string, string>()
  async function copyPart(name: string): Promise<string> {
    abort(options)
    const prior = copied.get(name); if (prior) return prior
    const entry = source.get(name); requireValue(entry, 'PART_MISSING', `原始特性缺少依赖文件：${name}`)
    if (!source.has(relationPart(name))) for (const candidate of target.values()) {
      if (candidate.size !== entry.size || candidate.crc !== entry.crc || target.has(relationPart(candidate.name)) || sourceTypes.type(name) !== targetTypes.type(candidate.name)) continue
      const exactCompressed = candidate.method === entry.method && candidate.compressed.length === entry.compressed.length && candidate.compressed.every((byte,index)=>byte===entry.compressed[index])
      const originalData = exactCompressed ? null : await get(source,name,options)
      const identical = exactCompressed || (await get(target,candidate.name,options)).every((byte,index)=>byte===originalData![index])
      if (identical) { copied.set(name,candidate.name); return candidate.name }
    }
    const suffix = name.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'part.bin'
    const destination = uniquePart(target, 'ppt/openoffice-preserved/part-', suffix)
    copied.set(name, destination)
    // Retain original compressed bytes, including unknown binary parts. No macro is run.
    target.set(destination, { ...entry, name: destination })
    overrideType(targetTypes.doc, destination, sourceTypes.type(name))
    if (source.has(relationPart(name))) {
      const rels = await relationships(source, name, options)
      for (const rel of rels.map.values()) if (!rel.external) {
        const dependency = await copyPart(resolvePart(name, rel.target))
        rel.node.setAttribute('Target', relativePart(destination, dependency))
      }
      const path = relationPart(destination); putXml(target, path, rels.doc, options)
      overrideType(targetTypes.doc, path, 'application/vnd.openxmlformats-package.relationships+xml')
    }
    return destination
  }
  for (const pair of pairs) {
    abort(options)
    requireValue(Number.isInteger(pair.sourceIndex) && Number.isInteger(pair.targetIndex) && sourceLayout.slides[pair.sourceIndex]
      && targetLayout.slides[pair.targetIndex] && !mappedTargets.has(pair.targetIndex), 'SLIDE_MAPPING', '页面对应编号越界或目标页重复。')
    mappedTargets.add(pair.targetIndex)
    const sourcePart = sourceLayout.slides[pair.sourceIndex]!.partName, targetPart = targetLayout.slides[pair.targetIndex]!.partName
    const from = await xml(source, sourcePart, options), to = await xml(target, targetPart, options)
    requireValue(from.documentElement.namespaceURI === to.documentElement.namespaceURI, 'OOXML_DIALECT', '原始与导出的 PPTX 命名空间不同，无法安全合并；请先另存为标准 PPTX。')
    copyNamespaceContext(from,to)
    const fromRels = await relationships(source, sourcePart, options), toRels = await relationships(target, targetPart, options)
    const idMap = new Map<string, string>(), sourceNames = shapeNames(from), media = mediaShapes(from)
    const tree = descendants(to, 'spTree')[0]; requireValue(tree, 'SLIDE_STRUCTURE', '目标页缺少形状容器。')
    // Source features are authoritative, including an explicit removal. Ordinary pictures stay.
    for (const shape of mediaShapes(to)) shape.remove()
    for (const picture of descendants(to, 'pic')) if (/^OpenOfficeMedia-\d+-/.test(descendants(picture,'cNvPr')[0]?.getAttribute('name') || '')) picture.remove()
    for (const sourceMedia of media) {
      const name = descendants(sourceMedia, 'cNvPr')[0]?.getAttribute('name') || ''
      if (!name) continue
      const candidates = shapeNames(to).get(name) || []
      requireValue(candidates.length <= 1 && (sourceNames.get(name)?.length || 0) === 1, 'MEDIA_MAPPING', `第 ${pair.targetIndex + 1} 页媒体名称“${name}”重复，无法安全替换。请给媒体设置唯一名称。`)
      if (candidates[0]) shapeForMeta(candidates[0])!.remove()
    }
    const targetNames = shapeNames(to)
    for (const [name, originals] of sourceNames) {
      const matches = targetNames.get(name)
      if (originals.length === 1 && matches?.length === 1) {
        const a = originals[0]!.getAttribute('id'), b = matches[0]!.getAttribute('id')
        if (a && b) idMap.set(a, b)
      }
    }
    let nextId = nextNumericId(to, 'cNvPr')
    const clones: Element[] = []
    for (const sourceMedia of media) {
      const clone = to.importNode(sourceMedia, true), meta = descendants(clone, 'cNvPr')[0]
      const oldId = meta?.getAttribute('id'); requireValue(oldId && !idMap.has(oldId), 'MEDIA_MAPPING', '媒体形状编号缺失或重复，不能安全保留。')
      const newId = String(nextId++); meta!.setAttribute('id', newId); idMap.set(oldId, newId)
      // Grouped media is flattened only when its complete transform is known.
      const geometry = mediaRect(sourceMedia, sourceLayout.widthEmu, sourceLayout.heightEmu)
      requireValue(geometry.rect, 'MEDIA_TRANSFORM', `第 ${pair.sourceIndex + 1} 页媒体包含无法保留的组合旋转或母版位置。请先在原编辑器取消组合。`)
      const properties = child(clone, 'spPr'), xfrm = properties && child(properties, 'xfrm')
      const off = xfrm && child(xfrm, 'off'), ext = xfrm && child(xfrm, 'ext')
      requireValue(off && ext, 'MEDIA_TRANSFORM', '媒体位置缺失，无法安全复制。')
      off.setAttribute('x', String(Math.round(geometry.rect.x * targetLayout.widthEmu))); off.setAttribute('y', String(Math.round(geometry.rect.y * targetLayout.heightEmu)))
      ext.setAttribute('cx', String(Math.round(geometry.rect.width * targetLayout.widthEmu))); ext.setAttribute('cy', String(Math.round(geometry.rect.height * targetLayout.heightEmu)))
      tree.appendChild(clone); clones.push(clone)
    }
    for (const existing of featureRoots(to)) existing.remove()
    for (const feature of featureRoots(from)) {
      const clone = to.importNode(feature, true)
      for (const node of [clone,...Array.from(clone.getElementsByTagName('*'))]) {
        if (node.hasAttribute('spid')) {
          const old = node.getAttribute('spid')!, mapped = idMap.get(old)
          requireValue(mapped, 'ANIMATION_MAPPING', `第 ${pair.sourceIndex + 1} 页动画引用的形状 ${old} 未在导出页找到唯一同名对象。为保护原效果，本次保存已停止；请恢复对象名称或在原编辑器删除该动画。`)
          node.setAttribute('spid', mapped)
        }
      }
      insertSlideChild(to.documentElement, clone, clone.localName === 'timing' || descendants(clone, 'timing').length ? 'timing' : 'transition')
      clones.push(clone)
    }
    const relIds = new Map<string, string>()
    for (const clone of clones) for (const { node, attr } of relationshipAttributes(clone)) {
      let newId = relIds.get(attr.value)
      if (!newId) {
        const rel = fromRels.map.get(attr.value); requireValue(rel, 'RELATION_MISSING', `原始动画或媒体关系 ${attr.value} 缺失。`)
        const destination = rel.external ? rel.target : relativePart(targetPart, await copyPart(resolvePart(sourcePart, rel.target)))
        newId = addRelation(toRels, rel.type, destination)
        if (rel.external) { const fresh = toRels.map.get(newId)!; fresh.external = true; fresh.node.setAttribute('TargetMode', 'External') }
        relIds.set(attr.value, newId)
      }
      node.setAttributeNS(attr.namespaceURI, attr.name, newId)
    }
    // The editor owns the current slide's visibility, text, notes, layout and order.
    // Only effects/media come from the authoritative original package.
    putXml(target, targetPart, to, options); putXml(target, toRels.path, toRels.doc, options)
  }
  putXml(target, '[Content_Types].xml', targetTypes.doc, options); abort(options); return saveArchive(target)
}

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const chartDataSlots = ['tx','cat','val','xVal','yVal','bubbleSize'] as const
interface ChartCacheField { node: Element; ref: Element | null; values: Array<string | number | null>; numeric: boolean }
function chartField(series: Element, slot: string): ChartCacheField | null {
  const node = child(series, slot)
  if (!node) return null
  const direct = child(node, 'v')
  if (direct) return { node, ref: null, values: [direct.textContent || ''], numeric: false }
  const ref = children(node).find(item => ['strRef','numRef'].includes(item.localName)) || null
  const cache = ref ? children(ref).find(item => ['strCache','numCache'].includes(item.localName))
    : children(node).find(item => ['strLit','numLit'].includes(item.localName))
  requireValue(cache, 'CHART_DATA', '图表数据包含无缓存引用或多级分类，不能保证可编辑数据完整，已停止保存。')
  const countText = child(cache, 'ptCount')?.getAttribute('val') || ''
  requireValue(/^\d+$/.test(countText), 'CHART_DATA', '图表缓存缺少有效数量。')
  const count = Number(countText)
  requireValue(Number.isInteger(count) && count >= 0 && count <= 1000, 'CHART_DATA', '图表缓存数量无效或超过 1000 项。')
  const numeric = ['numCache','numLit'].includes(cache.localName), values: Array<string | number | null> = Array(count).fill(null), indices = new Set<number>()
  for (const point of children(cache, 'pt')) {
    const indexText = point.getAttribute('idx') || ''
    requireValue(/^\d+$/.test(indexText), 'CHART_DATA', '图表缓存缺少有效索引。')
    const index = Number(indexText), value = child(point, 'v')?.textContent
    requireValue(Number.isInteger(index) && index >= 0 && index < count && !indices.has(index) && value !== undefined && value !== null,
      'CHART_DATA', '图表缓存缺值、重复或越界，已停止保存。')
    indices.add(index)
    requireValue(value.length <= 10000, 'CHART_DATA', '图表数据文本过长。')
    if (numeric) { requireValue(value.trim() !== '' && Number.isFinite(Number(value)), 'CHART_DATA', '图表含无法安全写入 Excel 的数值。'); values[index] = Number(value) }
    else values[index] = value
  }
  return { node, ref, values, numeric }
}
function chartSeries(doc: Document) {
  const series = Array.from(doc.getElementsByTagNameNS(C, 'ser'))
  requireValue(series.length > 0 && series.length <= 100, 'CHART_DATA', '图表序列为空或超过 100 项，不能安全保存数据源。')
  return series.map(node => ({ node, fields: Object.fromEntries(chartDataSlots.map(slot => [slot, chartField(node, slot)])) as Record<typeof chartDataSlots[number], ChartCacheField | null> }))
}
function chartSignature(series: ReturnType<typeof chartSeries>) {
  return JSON.stringify(series.map(item => chartDataSlots.map(slot => {
    const field = item.fields[slot]; return field ? [slot, field.numeric, field.values] : [slot, null]
  })))
}
function chartColumn(index: number) { let value = ''; for (let n = index; n; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + (n - 1) % 26) + value; return value }
export interface ChartSourceProof { pageId: string; shapeName: string; sourceShapeName?: string; sourceEligible: boolean }
export interface PptxChartRepairOptions extends PptxPackageOptions {
  sourceEligibleCharts?: Array<{ targetIndex: number; name: string }>
  chartMappings?: Array<{ targetIndex: number; name: string; sourceName: string }>
}

/** Preserve original workbook bindings for unchanged data, and create an actual
 * embedded XLSX for changed/new basic charts. Never reuse stale source values.
 * The target chart, shape geometry, title and formatting remain editor-owned. */
export async function repairPresentationChartData(sourceInput: Uint8Array | null, targetInput: Uint8Array,
  mapping: PptxSlideMapping[], options: PptxChartRepairOptions = {}): Promise<Uint8Array> {
  const source = sourceInput ? openArchive(sourceInput) : null, target = openArchive(targetInput); checkEditable(target)
  if (source) checkEditable(source)
  const sourceLayout = source ? await structure(source, options) : null, targetLayout = await structure(target, options)
  const sourceTypes = source ? await contents(source, options) : null, targetTypes = await contents(target, options)
  const copied = new Map<string, string>(), handled = new Set<string>(), targets = new Set<number>()
  let changed = false
  async function copyDependency(name: string): Promise<string> {
    const prior = copied.get(name); if (prior) return prior
    requireValue(source && sourceTypes && source.has(name), 'CHART_WORKBOOK', '图表原工作簿或依赖缺失，已停止保存。')
    // Validate CRC before preserving an opaque embedded workbook/relationship graph.
    await get(source, name, options)
    const destination = uniquePart(target, 'ppt/embeddings/openoffice-chart-source-', name.split('.').at(-1)!.replace(/[^a-zA-Z0-9]/g, '') || 'bin')
    copied.set(name, destination); target.set(destination, { ...source.get(name)!, name: destination })
    overrideType(targetTypes.doc, destination, sourceTypes.type(name))
    if (source.has(relationPart(name))) {
      const rels = await relationships(source, name, options)
      for (const relation of rels.map.values()) if (!relation.external) relation.node.setAttribute('Target', relativePart(destination, await copyDependency(resolvePart(name, relation.target))))
      putXml(target, relationPart(destination), rels.doc, options)
    }
    return destination
  }
  async function charts(archive: Archive, part: string) {
    const doc = await xml(archive, part, options), rels = await relationships(archive, part, options), found = new Map<string, { part: string; doc: Document }>()
    for (const shape of descendants(doc, 'graphicFrame')) {
      const references = Array.from(shape.getElementsByTagNameNS(C, 'chart'))
      requireValue(references.length || !descendants(shape, 'graphicData').some(node => /chart/i.test(node.getAttribute('uri') || '')),
        'CHART_DATA', '图表使用尚未验证的新扩展格式，不能保证数据源完整，已停止保存。')
      if (!references.length) continue
      const name = descendants(shape, 'cNvPr')[0]?.getAttribute('name') || ''
      requireValue(name && references.length === 1 && !found.has(name), 'CHART_MAPPING', '图表名称缺失或重复，无法安全对应数据源。请给图表设置唯一名称。')
      const relation = rels.map.get(attribute(references[0]!, 'id'))
      requireValue(relation && !relation.external && relation.type.endsWith('/chart'), 'CHART_MAPPING', '图表关系缺失或不是内嵌图表。')
      const chartPart = resolvePart(part, relation.target)
      found.set(name, { part: chartPart, doc: await xml(archive, chartPart, options) })
    }
    return { doc, found }
  }
  for (const pair of mapping) {
    abort(options)
    requireValue(Number.isInteger(pair.targetIndex) && targetLayout.slides[pair.targetIndex] && !targets.has(pair.targetIndex), 'CHART_MAPPING', '图表目标页面映射无效。')
    targets.add(pair.targetIndex)
    const to = await charts(target, targetLayout.slides[pair.targetIndex]!.partName)
    const original = source && sourceLayout ? await charts(source, sourceLayout.slides[pair.sourceIndex]?.partName || fail('CHART_MAPPING', '图表原页面映射无效。')) : null
    // Native default names can change when moving a slide. Only a monitor's
    // same-UNO-object mapping may bridge that rename; never guess by position
    // or cached values. New/copy/replaced shapes have no source mapping.
    const sourceName = (name: string) => options.chartMappings?.find(item => item.targetIndex === pair.targetIndex && item.name === name)?.sourceName || name
    const mappedNames = [...to.found.keys()].map(sourceName)
    requireValue(new Set(mappedNames).size === mappedNames.length, 'CHART_MAPPING', '多个当前图表指向同一原图表，不能安全恢复工作簿。')
    const missingOriginals = original ? [...original.found.keys()].filter(name => !mappedNames.includes(name)) : []
    const newNames = [...to.found.keys()].filter(name => !original?.found.has(sourceName(name)))
    requireValue(!missingOriginals.length || !newNames.length, 'CHART_MAPPING', '图表名称发生歧义，无法判断是重命名还是替换，已停止保存以保护原工作簿。')
    for (const name of missingOriginals) requireValue(!shapeNames(to.doc).has(name), 'CHART_MAPPING', `图表“${name}”已变成非图表对象，不能静默丢弃其工作簿。`)
    for (const [name, chart] of to.found) {
      requireValue(!handled.has(chart.part), 'CHART_MAPPING', '多个对象共用同一图表文件，无法独立确认数据编辑，已停止保存。')
      handled.add(chart.part)
      const old = original?.found.get(sourceName(name))
      const chartRels = await relationships(target, chart.part, options)
      const liveExternal = child(chart.doc.documentElement, 'externalData'), liveRelation = liveExternal ? chartRels.map.get(attribute(liveExternal, 'id')) : null
      const liveFormulas = Array.from(chart.doc.getElementsByTagNameNS(C, 'f')).map(node => node.textContent?.trim() || '')
      // New or edited authoritative target bindings win even if their cached
      // values happen to equal the original. Never restore an old same-value
      // range/workbook over an intact current binding.
      if (liveRelation?.type.endsWith('/package') && liveFormulas.length && liveFormulas.every(formula => formula && !/^(?:label \d+|categories|\d+)$/i.test(formula))) {
        if (!liveRelation.external) {
          const workbook = await get(target, resolvePart(chart.part, liveRelation.target), options)
          const inspected = inspectPptxZip(workbook)
          requireValue(inspected.entries.some(entry => entry.name === 'xl/workbook.xml'), 'CHART_WORKBOOK', '当前图表引用的工作簿容器无效。')
        }
        continue
      }
      const currentSeries = chartSeries(chart.doc), oldSeries = old ? chartSeries(old.doc) : null
      const oldExternal = old ? child(old.doc.documentElement, 'externalData') : null
      const unchanged = !!old && !!oldSeries && chartSignature(oldSeries) === chartSignature(currentSeries)
      let relationId: string
      if (unchanged && oldExternal && source) {
        requireValue(options.sourceEligibleCharts?.some(item => item.targetIndex === pair.targetIndex && item.name === name),
          'CHART_EDIT_PROOF', '无法确认此图表在导入后未修改数据源；已停止保存，避免用原工作簿覆盖同值但不同范围的编辑。')
        const oldRels = await relationships(source, old!.part, options), relation = oldRels.map.get(attribute(oldExternal, 'id'))
        requireValue(relation && relation.type.endsWith('/package'), 'CHART_WORKBOOK', '原图表的 Excel 工作簿关系无效。')
        const destination = relation.external ? relation.target : relativePart(chart.part, await copyDependency(resolvePart(old!.part, relation.target)))
        relationId = addRelation(chartRels, relation.type, destination)
        if (relation.external) chartRels.map.get(relationId)!.node.setAttribute('TargetMode', 'External')
        // Keep current caches/format codes; restore only valid original formulas.
        for (let index = 0; index < currentSeries.length; index++) for (const slot of chartDataSlots) {
          const from = oldSeries![index]!.fields[slot], toField = currentSeries[index]!.fields[slot]
          if (!from || !toField) continue
          if (from.ref && toField.ref && from.ref.localName === toField.ref.localName) {
            requireValue(children(from.ref).every(node => ['f','strCache','numCache'].includes(node.localName)), 'CHART_DATA', '原图表数据引用含未知扩展，不能安全恢复。')
            const formula = child(from.ref, 'f'); requireValue(formula?.textContent, 'CHART_WORKBOOK', '原图表引用公式缺失。')
            const oldFormula = child(toField.ref, 'f'); if (oldFormula) oldFormula.remove()
            toField.ref.insertBefore(chart.doc.importNode(formula, true), toField.ref.firstChild)
          } else {
            // Literal series labels have no workbook reference to invent.
            requireValue(!from.ref, 'CHART_WORKBOOK', '原图表引用类型变化，无法保证原工作簿绑定完整。')
            requireValue(children(from.node).every(node => ['v','strLit','numLit'].includes(node.localName))
              && children(toField.node).every(node => ['v','strLit','numLit','strRef','numRef'].includes(node.localName)),
              'CHART_DATA', '图表文字数据含无法无损替换的扩展，已停止保存。')
            toField.node.parentNode!.replaceChild(chart.doc.importNode(from.node, true), toField.node)
          }
        }
      } else {
        requireValue(currentSeries.every(series => !series.fields.xVal && !series.fields.yVal && !series.fields.bubbleSize
          && series.fields.tx?.values.length === 1 && typeof series.fields.tx.values[0] === 'string'
          && series.fields.cat && !series.fields.cat.numeric && series.fields.cat.values.every(value => typeof value === 'string')
          && series.fields.val?.numeric), 'CHART_DATA', '当前图表的数据源不是受支持的完整文本分类/数值序列，已停止保存；散点、多级分类或缺失缓存需要保留原格式处理。')
        const categories = currentSeries[0]!.fields.cat!.values as string[]
        requireValue(currentSeries.every(series => JSON.stringify(series.fields.cat!.values) === JSON.stringify(categories)
          && series.fields.val!.values.length === categories.length), 'CHART_DATA', '图表各序列分类不一致，不能安全生成工作簿。')
        const workbook = buildChartWorkbook({ categories, series: currentSeries.map(series => series.fields.tx!.values[0] as string),
          values: categories.map((_, index) => currentSeries.map(series => series.fields.val!.values[index] as number | null)) })
        const workbookPart = uniquePart(target, 'ppt/embeddings/openoffice-chart-data-', 'xlsx')
        put(target, workbookPart, workbook); overrideType(targetTypes.doc, workbookPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        relationId = addRelation(chartRels, `${R}/package`, relativePart(chart.part, workbookPart))
        currentSeries.forEach((series, index) => {
          const column = chartColumn(index + 2)
          for (const [slot, formula, referenceType] of [['tx', `Sheet1!$${column}$1`, 'strRef'],
            ['cat', `Sheet1!$A$2:$A$${categories.length + 1}`, 'strRef'],
            ['val', `Sheet1!$${column}$2:$${column}$${categories.length + 1}`, 'numRef']] as const) {
            const field = series.fields[slot]!
            requireValue(children(field.node).every(node => ['strRef','numRef','strLit','numLit','v'].includes(node.localName)),
              'CHART_DATA', '图表数据含未知扩展，不能安全更新工作簿。')
            if (field.ref) {
              requireValue(field.ref.localName === referenceType && children(field.ref).every(node => ['f','strCache','numCache'].includes(node.localName)),
                'CHART_DATA', '图表引用格式含未知扩展，已停止保存。')
              const oldFormula = child(field.ref, 'f'); if (oldFormula) oldFormula.remove()
              const newFormula = element(chart.doc, 'f', C, 'c'); newFormula.textContent = formula
              field.ref.insertBefore(newFormula, field.ref.firstChild)
            } else {
              const reference = element(chart.doc, referenceType, C, 'c'); append(reference, 'f', {}, C, 'c').textContent = formula
              const numeric = slot === 'val', literal = children(field.node).find(node => node.localName === (numeric ? 'numLit' : 'strLit'))
              const cache = append(reference, numeric ? 'numCache' : 'strCache', {}, C, 'c')
              if (literal) {
                for (const attr of Array.from(literal.attributes)) cache.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
                for (const node of Array.from(literal.childNodes)) cache.appendChild(chart.doc.importNode(node, true))
              } else {
                append(cache, 'ptCount', { val: field.values.length }, C, 'c')
                field.values.forEach((value, i) => { if (value !== null) append(append(cache, 'pt', { idx: i }, C, 'c'), 'v', {}, C, 'c').textContent = String(value) })
              }
              for (const existing of children(field.node)) existing.remove()
              field.node.appendChild(reference)
            }
          }
        })
      }
      for (const existing of children(chart.doc.documentElement, 'externalData')) existing.remove()
      const external = element(chart.doc, 'externalData', C, 'c'); external.setAttributeNS(R, 'r:id', relationId)
      append(external, 'autoUpdate', { val: 0 }, C, 'c')
      chart.doc.documentElement.insertBefore(external, children(chart.doc.documentElement).find(node => ['printSettings','userShapes','extLst'].includes(node.localName)) || null)
      putXml(target, chart.part, chart.doc, options); putXml(target, chartRels.path, chartRels.doc, options); changed = true
    }
  }
  if (!changed) return targetInput
  putXml(target, '[Content_Types].xml', targetTypes.doc, options); return saveArchive(target)
}
