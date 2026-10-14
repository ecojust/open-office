import type { SlideObject } from './types'
import { PptxPackageError, PPTX_LIMITS } from '../pptx-package.ts'

export const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
export const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
export const emu = (mm: number) => Math.round(mm * 36000)
export const xmlBytes = (value: string) => new TextEncoder().encode(value)
export function xmlEscape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
export function readXml(source: Uint8Array | string): Document {
  if (source instanceof Uint8Array) {
    if (source.byteLength > PPTX_LIMITS.xmlBytes) throw new PptxPackageError('XML_LIMIT', 'PPTX XML 超过安全限制。')
    source = source[0] === 255 && source[1] === 254 ? new TextDecoder('utf-16le', { fatal: true }).decode(source)
      : source[0] === 254 && source[1] === 255 ? new TextDecoder('utf-16be', { fatal: true }).decode(source) : new TextDecoder('utf-8', { fatal: true }).decode(source)
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new PptxPackageError('XML_ENTITY', 'PPTX XML 不允许 DTD 或实体声明。')
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new PptxPackageError('XML_INVALID', 'PPTX XML 内容无效。')
  return doc
}
export const writeXml = (node: Document | Element) => new XMLSerializer().serializeToString(node)
/** Preserve namespaces used lexically by mc:Ignorable/Choice Requires as well
 * as namespaces appearing in expanded XML names when copying a subtree. */
export function snapshotXml(element: Element): string {
  const namespaces = new Map<string, string>(), ancestry: Element[] = []
  for (let node: Element | null = element; node; node = node.parentElement) ancestry.unshift(node)
  for (const node of ancestry) for (const attr of Array.from(node.attributes)) if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') namespaces.set(attr.name, attr.value)
  const copy = element.cloneNode(true) as Element
  for (const [name, value] of namespaces) if (!copy.hasAttribute(name)) copy.setAttributeNS('http://www.w3.org/2000/xmlns/', name, value)
  return writeXml(copy)
}
export function children(node: Element | Document | undefined | null, local?: string): Element[] {
  return node ? Array.from(node.children).filter(child => !local || child.localName === local) : []
}
export const child = (node: Element | Document | undefined | null, local: string) => children(node, local)[0]
export const all = (node: Element | Document | undefined | null, local: string): Element[] => node ? Array.from(node.getElementsByTagNameNS('*', local)) : []
export const relPart = (part: string) => { const slash = part.lastIndexOf('/'); return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` }
export function resolvePart(part: string, target: string): string {
  let path: string
  try { path = decodeURIComponent(target) } catch { throw new PptxPackageError('RELATION_TARGET', 'PPTX 关系路径编码无效。') }
  if (!path || /[\\\x00-\x1f\x7f?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) throw new PptxPackageError('RELATION_TARGET', 'PPTX 内部关系路径无效。')
  const segments = path.startsWith('/') ? [] : part.split('/').slice(0, -1)
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) throw new PptxPackageError('RELATION_TARGET', 'PPTX 关系路径越界。'); segments.pop() } else segments.push(segment)
  }
  return segments.join('/')
}
export function relativePart(from: string, to: string): string {
  const a = from.split('/').slice(0, -1), b = to.split('/')
  while (a.length && a[0] === b[0]) { a.shift(); b.shift() }
  return [...a.map(() => '..'), ...b].join('/')
}
/** JSON captures all editable state while ignoring the immutable import record. */
export function objectFingerprint(object: SlideObject): string {
  return JSON.stringify(object, (key, value) => ['sourceXml', 'sourceFingerprint', 'sourcePart', 'warning', 'locked', 'diagramPreview', 'richText', 'tableCellText', 'tableLayout', 'smartArt'].includes(key) ? undefined : value)
}
