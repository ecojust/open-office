import { Inflate } from 'fflate'
import { inspectPptxZip, writePptxParts } from '../../presentation/pptx-package.ts'
import { AUTO_LINE_HEIGHT_LIMITS, createWordDocument, inheritedParagraphStyle, LETTER_SPACING_LIMITS, normalizeDocument, normalizeTextColor, normalizeUnderlineColor, normalizeSourceVerticalAlign, normalizeVerticalAlign, POINT_LINE_HEIGHT_LIMITS } from './model.ts'
import type { ParagraphMarkerFormat, ParagraphStyle, TextStyle, WordDocument, WordParagraph, WordRun } from './model.ts'
import { assertSupportedWordText } from './scripts.ts'
import { isHighlightColor } from './highlight.ts'
import { normalizeBackgroundColor } from './background.ts'
import { normalizePaperDimension } from './paper.ts'

// A deliberately small independent WordprocessingML codec. Unsupported semantic
// content is refused before a document reaches the editable model.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'
const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
const XML = 'http://www.w3.org/XML/1998/namespace'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const STYLE_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'
const METADATA = {
  fontTable: { namespace: W, root: 'fonts', path: 'word/fontTable.xml', type: `${R}/fontTable`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml' },
  theme: { namespace: A, root: 'theme', path: 'word/theme/theme1.xml', type: `${R}/theme`, mime: 'application/vnd.openxmlformats-officedocument.theme+xml' },
  coreProperties: { namespace: CP, root: 'coreProperties', path: 'docProps/core.xml', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', mime: 'application/vnd.openxmlformats-package.core-properties+xml' },
  extendedProperties: { namespace: EP, root: 'Properties', path: 'docProps/app.xml', type: `${R}/extended-properties`, mime: 'application/vnd.openxmlformats-officedocument.extended-properties+xml' },
} as const
type MetadataKey = keyof typeof METADATA
const LIMIT = { input: 16 * 1024 * 1024, expanded: 32 * 1024 * 1024, xml: 4 * 1024 * 1024, paragraphs: 10000, text: 1000000 }
const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export class WordDocumentError extends Error {
  constructor(message: string) { super(`${message} 请使用完整文字编辑器打开此文件。`); this.name = 'WordDocumentError' }
}
function fail(message: string): never { throw new WordDocumentError(message) }
function requireValue(value: unknown, message: string): asserts value { if (!value) fail(message) }
function unsupported(description: string): never { return fail(`独立文字编辑器暂不支持${description}，已停止导入以保护原文。`) }
function attributes(node: Element, allowed: string[] = [], namespace = W) {
  for (const attr of Array.from(node.attributes)) {
    if (attr.namespaceURI === XMLNS) continue
    if ((attr.namespaceURI || '') === namespace && allowed.includes(attr.localName)) continue
    if (attr.namespaceURI === W && /^rsid(?:R|RDefault|P|RPr|Sect)$/.test(attr.localName)) continue
    if (attr.namespaceURI === W14 && ['paraId', 'textId'].includes(attr.localName)) continue
    if (attr.namespaceURI === MC && attr.localName === 'Ignorable') continue
    unsupported(`属性 ${node.localName}/@${attr.name}`)
  }
}
function elements(node: Element): Element[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) requireValue(!child.textContent?.trim(), `DOCX 的 ${node.localName} 节点包含异常文本。`)
    else if (![Node.ELEMENT_NODE, Node.COMMENT_NODE].includes(child.nodeType as 1 | 8)) unsupported(`XML 节点 ${child.nodeName}`)
  }
  return Array.from(node.children)
}
function wordElements(node: Element): Element[] {
  const result = elements(node)
  for (const child of result) requireValue(child.namespaceURI === W, `DOCX 包含未知命名空间：${child.nodeName}。`)
  return result
}
function singletonChildren(node: Element): Map<string, Element> {
  const result = new Map<string, Element>()
  for (const child of wordElements(node)) { requireValue(!result.has(child.localName), `DOCX 包含重复的 ${child.localName} 格式。`); result.set(child.localName, child) }
  return result
}
function leaf(node: Element, allowed: string[] = ['val']) { attributes(node, allowed); requireValue(!elements(node).length, `DOCX 的 ${node.localName} 格式结构无效。`) }
function value(node: Element): string { const result = node.getAttributeNS(W, 'val'); requireValue(result !== null, `DOCX 的 ${node.localName} 缺少 val。`); return result }
function numberValue(raw: string | null, name: string, min: number, max: number): number {
  requireValue(raw !== null && (min < 0 ? /^-?\d+$/ : /^\d+$/).test(raw), `DOCX 的 ${name} 不是有效整数。`)
  const parsed = Number(raw); requireValue(parsed >= min && parsed <= max, `DOCX 的 ${name} 超出支持范围。`); return parsed
}
function onOff(node: Element): boolean {
  leaf(node); const raw = node.getAttributeNS(W, 'val')
  requireValue(raw === null || ['true', 'false', 'on', 'off', '0', '1'].includes(raw), 'DOCX 布尔格式无效。')
  return raw === null || ['true', 'on', '1'].includes(raw)
}
function xml(bytes: Uint8Array, path: string): Document {
  requireValue(bytes.length <= LIMIT.xml, `DOCX XML 过大：${path}。`)
  let source: string
  try {
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch { return fail(`DOCX XML 编码无效：${path}。`) }
  requireValue(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source), 'DOCX 不允许 DTD 或实体声明。')
  const document = new DOMParser().parseFromString(source, 'application/xml')
  requireValue(document.documentElement && !document.getElementsByTagNameNS('*', 'parsererror').length, `DOCX XML 无法解析：${path}。`)
  return document
}
/** One import owns one cache. Caller-owned Maps and bytes never retain DOMs,
 * so a later import validates changed entries from scratch. */
class ParsedParts extends Map<string, Uint8Array> {
  private readonly documents = new Map<string, Document>()
  document(name: string): Document {
    const cached = this.documents.get(name)
    if (cached) return cached
    const bytes = this.get(name); requireValue(bytes, `DOCX 缺少 ${name}。`)
    const document = xml(bytes, name)
    this.documents.set(name, document)
    return document
  }
}
function readParts(input: Uint8Array): Map<string, Uint8Array> {
  requireValue(input.byteLength <= LIMIT.input, '独立文字编辑器支持不超过 16 MiB 的 DOCX。')
  const inspected = inspectPptxZip(input)
  requireValue(inspected.entries.length <= 256 && inspected.expandedBytes <= LIMIT.expanded, 'DOCX 解压内容超过独立文字编辑器的限制。')
  const parts = new Map<string, Uint8Array>()
  for (const entry of inspected.entries) {
    requireValue(entry.size <= LIMIT.xml, `DOCX 文件过大：${entry.name}。`)
    const data = new Uint8Array(entry.size)
    let count = 0, checksum = 0xffffffff
    const consume = (chunk: Uint8Array) => {
      requireValue(count + chunk.length <= data.length, 'DOCX 解压长度与文件目录不符。')
      data.set(chunk, count); count += chunk.length
      for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 255]! ^ (checksum >>> 8)
    }
    if (entry.method === 0) consume(entry.compressed)
    else {
      // Small synchronous chunks cap transient inflate allocation even when a
      // forged ZIP header advertises a much smaller uncompressed length.
      const inflater = new Inflate(consume)
      for (let offset = 0; offset < entry.compressed.length; offset += 1024) inflater.push(entry.compressed.subarray(offset, offset + 1024), offset + 1024 >= entry.compressed.length)
    }
    requireValue(count === entry.size && ((checksum ^ 0xffffffff) >>> 0) === entry.crc, `DOCX 内容校验失败：${entry.name}。`)
    // importWordParts validates every XML/relationships part once, including
    // unused parts, then reuses those DOMs for the semantic readers.
    parts.set(entry.name, data)
  }
  return parts
}
function partXml(parts: ParsedParts, name: string, namespace: string, root: string): Element {
  const element = parts.document(name).documentElement
  requireValue(element.namespaceURI === namespace && element.localName === root, `DOCX 的 ${name} 根节点或命名空间无效。`)
  return element
}
interface Relationship { type: string; target: string }
function resolveTarget(base: string, target: string): string {
  requireValue(target.length > 0 && !/[\\?#:%\x00-\x20]/.test(target), 'DOCX 包含无效或外部关系路径。')
  const segments = target.startsWith('/') ? [] : base.split('/').slice(0, -1)
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') { requireValue(segments.length > 0, 'DOCX 关系路径越界。'); segments.pop() }
    else { requireValue(segment !== '' && segment !== '.', 'DOCX 关系路径无效。'); segments.push(segment) }
  }
  return segments.join('/')
}
function relationships(parts: ParsedParts, path: string, base: string): Relationship[] {
  if (!parts.has(path)) return []
  const root = partXml(parts, path, PR, 'Relationships'); attributes(root, [], '')
  const result: Relationship[] = [], ids = new Set<string>()
  for (const node of elements(root)) {
    requireValue(node.namespaceURI === PR && node.localName === 'Relationship', 'DOCX 关系命名空间或节点无效。')
    attributes(node, ['Id', 'Type', 'Target', 'TargetMode'], '')
    requireValue(!elements(node).length, 'DOCX 关系节点无效。')
    const id = node.getAttribute('Id'), type = node.getAttribute('Type'), target = node.getAttribute('Target'), mode = node.getAttribute('TargetMode')
    requireValue(id && !ids.has(id) && type && target, 'DOCX 关系标识无效或重复。'); ids.add(id)
    if (mode && mode !== 'Internal') unsupported('外部链接关系')
    result.push({ type, target: resolveTarget(base, target) })
  }
  return result
}
function contentTypes(parts: ParsedParts): Map<string, string> {
  const root = partXml(parts, '[Content_Types].xml', CT, 'Types'); attributes(root, [], '')
  const types = new Map<string, string>(), extensions = new Set<string>()
  for (const node of elements(root)) {
    requireValue(node.namespaceURI === CT && ['Default', 'Override'].includes(node.localName) && !elements(node).length, 'DOCX 内容类型节点无效。')
    const isOverride = node.localName === 'Override'; attributes(node, isOverride ? ['PartName', 'ContentType'] : ['Extension', 'ContentType'], '')
    const type = node.getAttribute('ContentType'); requireValue(type, 'DOCX 内容类型缺失。')
    if (isOverride) {
      const name = node.getAttribute('PartName'); requireValue(name && name.startsWith('/'), 'DOCX 内容类型路径无效。')
      const resolved = resolveTarget('', name); requireValue(!types.has(resolved), 'DOCX 内容类型重复。'); types.set(resolved, type)
    } else {
      const extension = node.getAttribute('Extension')?.toLowerCase(); requireValue(extension && !extensions.has(extension), 'DOCX 默认内容类型重复或无效。'); extensions.add(extension)
      if (['xml', 'rels'].includes(extension)) requireValue(type === (extension === 'rels' ? 'application/vnd.openxmlformats-package.relationships+xml' : 'application/xml'), 'DOCX 默认内容类型无效。')
      else requireValue(/^[a-z0-9]+$/.test(extension) && ![...parts.keys()].some(name => name.toLowerCase().endsWith(`.${extension}`)), 'DOCX 包含未支持的资源类型。') // Unused declarations do not introduce resources.
    }
  }
  return types
}

/** These preserved parts cannot introduce body content or external resources.
 * A theme is retained as metadata only: all theme references in body/used styles
 * remain unsupported until there is an actual theme-property resolver. */
function metadataXml(root: Element, kind: MetadataKey): string {
  const spec = METADATA[kind]
  requireValue(root.namespaceURI === spec.namespace && root.localName === spec.root, `DOCX ${spec.path} 的根节点或命名空间无效。`)
  if (kind === 'fontTable') {
    attributes(root)
    for (const font of wordElements(root)) {
      requireValue(font.localName === 'font', 'DOCX 字体表包含未知节点。'); attributes(font, ['name'])
      const name = font.getAttributeNS(W, 'name'); requireValue(name && name.length <= 200, 'DOCX 字体表名称无效。')
      for (const [local, child] of singletonChildren(font)) {
        if (['altName', 'charset', 'family', 'pitch', 'panose1'].includes(local)) leaf(child)
        else if (local === 'sig') leaf(child, ['usb0', 'usb1', 'usb2', 'usb3', 'csb0', 'csb1'])
        else unsupported(`字体表内容 ${local}（含嵌入字体）`)
      }
    }
  } else {
    const namespaces = kind === 'theme' ? [A] : kind === 'coreProperties'
      ? [CP, 'http://purl.org/dc/elements/1.1/', 'http://purl.org/dc/terms/']
      : [EP, 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes']
    for (const node of [root, ...Array.from(root.getElementsByTagName('*'))]) {
      requireValue(namespaces.includes(node.namespaceURI || ''), `DOCX ${kind} 包含未知命名空间。`)
      for (const attr of Array.from(node.attributes)) {
        if (attr.namespaceURI === XMLNS || attr.namespaceURI === XML) continue
        requireValue(!attr.namespaceURI || (kind === 'coreProperties' && attr.namespaceURI === 'http://www.w3.org/2001/XMLSchema-instance' && attr.localName === 'type'), `DOCX ${kind} 包含未支持的属性或资源关系。`)
      }
      if (kind === 'theme') requireValue(!['blip', 'blipFill', 'ext', 'extLst'].includes(node.localName), 'DOCX 主题包含未支持的图片或扩展依赖。')
    }
  }
  return new XMLSerializer().serializeToString(root)
}

interface DocumentSettings { defaultTabStop: number; autoHyphenation: boolean }
function readSettings(parts: ParsedParts, path?: string): DocumentSettings {
  const result = { defaultTabStop: 36, autoHyphenation: false }; if (!path) return result
  const root = partXml(parts, path, W, 'settings'); attributes(root)
  for (const [name, node] of singletonChildren(root)) {
    if (name === 'defaultTabStop') { leaf(node); result.defaultTabStop = numberValue(value(node), '默认制表位', 1, 31680) / 20 }
    else if (name === 'autoHyphenation') result.autoHyphenation = onOff(node)
    else if (name === 'hyphenationZone') { leaf(node); requireValue(numberValue(value(node), '断词区域', 0, 31680) === 0, '独立文字编辑器暂不支持自定义断词区域。') }
    else if (name === 'zoom') { leaf(node, ['percent', 'val']); if (node.hasAttributeNS(W, 'percent')) numberValue(node.getAttributeNS(W, 'percent'), '缩放比例', 10, 500) }
    else if (name === 'themeFontLang') { leaf(node, ['val', 'eastAsia', 'bidi']); for (const attr of ['val', 'eastAsia', 'bidi']) requireValue(!node.getAttributeNS(W, attr), '独立文字编辑器暂不支持主题字体语言映射。') }
    else if (name === 'compat') {
      attributes(node); let modeSeen = false; const settings = new Set<string>()
      for (const child of wordElements(node)) {
        if (child.localName === 'adjustLineHeightInTable') { onOff(child); continue } // Tables themselves are rejected.
        requireValue(child.localName === 'compatSetting', '独立文字编辑器暂不支持此兼容性排版设置。')
        leaf(child, ['name', 'uri', 'val'])
        const setting = child.getAttributeNS(W, 'name'); requireValue(setting && !settings.has(setting) && child.getAttributeNS(W, 'uri') === 'http://schemas.microsoft.com/office/word', 'DOCX 兼容性设置无效或重复。'); settings.add(setting)
        if (setting === 'compatibilityMode') { requireValue(['12', '15'].includes(value(child)) && !modeSeen, '独立文字编辑器暂不支持此兼容模式。'); modeSeen = true }
        else requireValue(['useWord2013TrackBottomHyphenation', 'allowHyphenationAtTrackBottom'].includes(setting) && ['0', '1'].includes(value(child)), '独立文字编辑器暂不支持此兼容性设置。')
      }
    } else unsupported(`文档设置 ${name}`)
  }
  return result
}

function readNumbering(parts: ParsedParts, path?: string): Numbering {
  const result: Numbering = new Map(); if (!path) return result
  const root = partXml(parts, path, W, 'numbering'); attributes(root)
  const abstracts = new Map<string, Set<number>>(), pending: Array<[string, string]> = []
  for (const node of wordElements(root)) {
    if (node.localName === 'abstractNum') {
      attributes(node, ['abstractNumId']); const id = String(numberValue(node.getAttributeNS(W, 'abstractNumId'), '抽象编号标识', 0, 2147483647))
      requireValue(!abstracts.has(id), 'DOCX 抽象编号标识重复。'); const levels = new Set<number>()
      for (const level of wordElements(node)) {
        requireValue(level.localName === 'lvl', '独立文字编辑器暂不支持此抽象编号结构。'); attributes(level, ['ilvl'])
        const index = numberValue(level.getAttributeNS(W, 'ilvl'), '编号级别', 0, 8); requireValue(!levels.has(index), 'DOCX 编号级别重复。')
        const properties = singletonChildren(level)
        for (const [key, property] of properties) {
          if (key === 'pPr') {
            attributes(property)
            for (const [pKey, pNode] of singletonChildren(property)) {
              if (pKey === 'ind') { leaf(pNode, ['start', 'left', 'hanging', 'firstLine', 'end', 'right']); for (const attr of Array.from(pNode.attributes)) if (attr.namespaceURI === W) requireValue(attr.value === '0', '独立文字编辑器暂不支持编号缩进。') }
              else if (pKey === 'tabs') {
                attributes(pNode)
                for (const tab of wordElements(pNode)) { requireValue(tab.localName === 'tab', 'DOCX 编号制表位无效。'); leaf(tab, ['val', 'pos']); requireValue(value(tab) === 'num' && tab.getAttributeNS(W, 'pos') === '0', '独立文字编辑器暂不支持编号制表位置。') }
              } else unsupported(`编号段落格式 ${pKey}`)
            }
          } else if (key === 'rPr') {
            // Native Writer can emit an empty formatting container even for a
            // no-numbering level. Only this empty case is neutral; the level
            // must still pass the explicit none/text/suffix/layout checks.
            leaf(property, [])
          } else {
            leaf(property)
            if (key === 'numFmt') requireValue(value(property) === 'none', '独立文字编辑器暂不支持可见编号。')
            else if (key === 'lvlText') requireValue(value(property) === '', '独立文字编辑器暂不支持编号文本。')
            else if (key === 'suff') requireValue(value(property) === 'nothing', '独立文字编辑器暂不支持编号后缀。')
            else if (key === 'start') numberValue(value(property), '编号起始值', 0, 2147483647)
            else if (key === 'lvlJc') requireValue(['start', 'left'].includes(value(property)), '独立文字编辑器暂不支持编号对齐。')
            else if (key !== 'pStyle') unsupported(`编号格式 ${key}`)
          }
        }
        requireValue(properties.get('numFmt') && value(properties.get('numFmt')!) === 'none' && properties.get('lvlText') && value(properties.get('lvlText')!) === '' && properties.get('suff') && value(properties.get('suff')!) === 'nothing', 'DOCX 编号不是明确的无编号样式。')
        levels.add(index)
      }
      abstracts.set(id, levels)
    } else if (node.localName === 'num') {
      attributes(node, ['numId']); const id = String(numberValue(node.getAttributeNS(W, 'numId'), '编号标识', 1, 2147483647)), children = singletonChildren(node)
      requireValue(children.size === 1 && children.has('abstractNumId') && !pending.some(([existing]) => existing === id), 'DOCX 编号引用无效或有覆盖格式。')
      const reference = children.get('abstractNumId')!; leaf(reference); pending.push([id, value(reference)])
    } else unsupported(`编号部件内容 ${node.localName}`)
  }
  for (const [id, abstract] of pending) { const levels = abstracts.get(abstract); requireValue(levels, 'DOCX 编号引用缺失。'); result.set(id, levels) }
  return result
}

interface RunProperties { style: TextStyle; reference?: string; positionHalfPoints?: number }
function runProperties(node?: Element): RunProperties {
  if (!node) return { style: {} }
  attributes(node); const style: TextStyle = {}; let reference: string | undefined, strike: boolean | undefined, doubleStrike: boolean | undefined, caps: boolean | undefined, smallCaps: boolean | undefined, positionHalfPoints: number | undefined
  for (const [name, child] of singletonChildren(node)) {
    switch (name) {
      case 'rStyle': leaf(child); reference = value(child); break
      case 'b': style.bold = onOff(child); break
      case 'i': style.italic = onOff(child); break
      case 'highlight': {
        leaf(child); const color = value(child)
        requireValue(isHighlightColor(color), 'DOCX 文字高亮颜色无效。')
        style.highlight = color; break
      }
      case 'shd': {
        leaf(child, ['val', 'fill', 'color'])
        requireValue(value(child) === 'clear', '独立文字编辑器暂只支持纯色文字底纹。')
        const fill = child.getAttributeNS(W, 'fill'), foreground = child.getAttributeNS(W, 'color')
        requireValue(fill !== null && (fill === 'auto' || /^[a-f0-9]{6}$/i.test(fill)), 'DOCX 文字底纹必须明确指定六位 RGB 颜色或 auto。')
        requireValue(foreground === null || foreground === 'auto' || /^[a-f0-9]{6}$/i.test(foreground), 'DOCX 文字底纹前景颜色无效。')
        // A clear fill ignores the validated foreground. Other patterns and
        // missing fills have different native semantics and stay unsupported.
        style.backgroundColor = normalizeBackgroundColor(fill === 'auto' ? 'none' : `#${fill}`); break
      }
      case 'strike': strike = onOff(child); break
      case 'dstrike': doubleStrike = onOff(child); break
      case 'caps': caps = onOff(child); break
      case 'smallCaps': smallCaps = onOff(child); break
      case 'vertAlign': {
        leaf(child); const alignment = value(child)
        requireValue(['baseline', 'superscript', 'subscript'].includes(alignment), 'DOCX 上下标格式无效。')
        style.verticalAlign = alignment as NonNullable<TextStyle['verticalAlign']>; break
      }
      case 'position': {
        leaf(child)
        // Native Writer emits position=0 with baseline and explicitly ignores
        // zero on import. It must not clear an inherited superscript/subscript.
        const position = numberValue(value(child), '文字基线偏移', -31680, 31680)
        if (position !== 0) positionHalfPoints = position
        break
      }
      case 'u': {
        leaf(child, ['val', 'color']); const underline = value(child)
        requireValue(['single', 'double', 'none'].includes(underline), '独立文字编辑器暂只支持单下划线、双下划线或无下划线。')
        style.underline = underline === 'double' ? 'double' : underline === 'single'
        const color = child.getAttributeNS(W, 'color')
        // Writer imports OOXML's auto token as white, unlike Word's automatic
        // text-color semantics. Keep that ambiguous encoding out of this subset.
        requireValue(color === null || /^[a-f0-9]{6}$/i.test(color), '独立文字编辑器暂只支持六位 RGB 下划线颜色；跟随文字请省略颜色属性。')
        if (color !== null) style.underlineColor = normalizeUnderlineColor(`#${color}`)
        break
      }
      case 'sz': leaf(child); style.fontSize = numberValue(value(child), '字号', 2, 800) / 2; break
      case 'szCs': leaf(child); style.fontSizeCs = numberValue(value(child), '复杂文字字号', 2, 800) / 2; break
      case 'kern': leaf(child); style.kerning = numberValue(value(child), '字偶距阈值', 0, 800) / 2; break
      case 'spacing': leaf(child); style.letterSpacing = numberValue(value(child), '字符间距', LETTER_SPACING_LIMITS.min * 20, LETTER_SPACING_LIMITS.max * 20) / 20; break
      case 'lang':
        leaf(child, ['val', 'eastAsia', 'bidi'])
        for (const [attribute, property] of [['val', 'language'], ['eastAsia', 'languageEastAsia'], ['bidi', 'languageBidi']] as const) {
          const language = child.getAttributeNS(W, attribute)
          if (language !== null) { requireValue(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language), 'DOCX 文字语言标识无效。'); style[property] = language }
        }
        break
      case 'rFonts': {
        leaf(child, ['ascii', 'hAnsi', 'eastAsia', 'cs'])
        const ascii = child.getAttributeNS(W, 'ascii'), hAnsi = child.getAttributeNS(W, 'hAnsi')
        requireValue(ascii === hAnsi, '独立文字编辑器暂不支持不同的 ASCII 与高位拉丁字体。')
        for (const [font, property] of [[ascii, 'fontName'], [child.getAttributeNS(W, 'eastAsia'), 'fontNameEastAsia'], [child.getAttributeNS(W, 'cs'), 'fontNameCs']] as const) {
          if (font !== null) { requireValue(font.length > 0 && font.length <= 200, 'DOCX 字体名称无效。'); style[property] = font }
        }
        break
      }
      case 'color': {
        leaf(child); const color = value(child)
        requireValue(color === 'auto' || /^[a-f0-9]{6}$/i.test(color), 'DOCX 文字颜色必须是六位 RGB 颜色或自动颜色。')
        style.color = normalizeTextColor(color === 'auto' ? color : `#${color}`)
        break
      }
      default: unsupported(`文字格式 ${name}`)
    }
  }
  // Writer maps both properties onto one strikeout enum. Either true wins over
  // false in the same rPr; two true values depend on XML order and are refused.
  requireValue(!(strike && doubleStrike), '独立文字编辑器暂不支持同时启用单删除线与双删除线。')
  if (strike !== undefined || doubleStrike !== undefined) style.strike = strike ? 'single' : doubleStrike ? 'double' : 'none'
  // Writer uses one case-map enum. A true smallCaps combined with either
  // caps value depends on XML order; refuse that ambiguous representation.
  // caps=true plus smallCaps=false is stable, and native reset writes both false.
  requireValue(!(smallCaps && caps !== undefined), '独立文字编辑器暂不支持同时设置冲突的大写与小型大写格式。')
  if (caps !== undefined || smallCaps !== undefined) style.caseMap = caps ? 'upper' : smallCaps ? 'smallCaps' : 'none'
  return { style, reference, ...(positionHalfPoints !== undefined ? { positionHalfPoints } : {}) }
}
type Numbering = Map<string, Set<number>>
interface ParagraphProperties {
  style: ParagraphStyle
  reference?: string
  marker?: ReturnType<typeof runProperties>
  /** Resolve only after paragraph inheritance determines omitted lineRule. */
  line?: { value: number; rule?: ParagraphStyle['lineHeightRule'] }
}
function resolvedParagraphProperties(properties: ParagraphProperties, inherited: ParagraphStyle): ParagraphStyle {
  const style = { ...properties.style }
  if (properties.line) {
    const rule = properties.line.rule ?? inherited.lineHeightRule ?? 'auto'
    requireValue(properties.line.value <= POINT_LINE_HEIGHT_LIMITS.max * 20, '此行距超出独立文字编辑器已验证的原生兼容范围。')
    style.lineHeightRule = rule
    // Writer first interprets a fresh spacing item's line in integer mm100,
    // then converts auto spacing to an integer percentage of a 240-twip line.
    // This deliberately makes raw 277 become 116%, matching native Writer.
    style.lineHeight = rule === 'auto'
      ? Math.round(Math.round(properties.line.value * 127 / 72) * 100 / Math.round(240 * 127 / 72)) / 100
      : properties.line.value / 20
    if (rule === 'auto') requireValue(style.lineHeight >= AUTO_LINE_HEIGHT_LIMITS.min && style.lineHeight <= AUTO_LINE_HEIGHT_LIMITS.max,
      '倍数行距超出独立文字编辑器支持的 0.01 至 3.33 倍原生兼容范围。')
  }
  return style
}
function paragraphIndents(node: Element): ParagraphStyle {
  leaf(node, ['start', 'left', 'end', 'right', 'hanging', 'firstLine'])
  const result: ParagraphStyle = {}
  for (const [physical, logical, key] of [['left', 'start', 'indentLeft'], ['right', 'end', 'indentRight']] as const) {
    const physicalValue = node.hasAttributeNS(W, physical) ? numberValue(node.getAttributeNS(W, physical), `段落缩进 ${physical}`, -31680, 31680) : undefined
    const logicalValue = node.hasAttributeNS(W, logical) ? numberValue(node.getAttributeNS(W, logical), `段落缩进 ${logical}`, -31680, 31680) : undefined
    // OOXML precedence and native Writer's observed behavior differ for
    // conflicting aliases. Refuse ambiguity rather than change the layout.
    requireValue(physicalValue === undefined || logicalValue === undefined || physicalValue === logicalValue, '独立文字编辑器暂不支持相互冲突的段落缩进属性。')
    const twips = logicalValue ?? physicalValue
    if (twips !== undefined) result[key] = twips / 20
  }
  const firstLine = node.hasAttributeNS(W, 'firstLine') ? numberValue(node.getAttributeNS(W, 'firstLine'), '首行缩进', 0, 31680) : undefined
  const hanging = node.hasAttributeNS(W, 'hanging') ? numberValue(node.getAttributeNS(W, 'hanging'), '悬挂缩进', 0, 31680) : undefined
  requireValue(firstLine === undefined || hanging === undefined || (firstLine === 0 && hanging === 0), '独立文字编辑器暂不支持同时指定首行和悬挂缩进。')
  // These are two encodings of one inherited property. In particular a direct
  // firstLine=0 clears an inherited hanging indent, and vice versa.
  if (firstLine !== undefined || hanging !== undefined) result.indentFirstLine = (firstLine !== undefined ? firstLine : hanging === 0 ? 0 : -hanging!) / 20
  return result
}
function paragraphProperties(node?: Element, numbering: Numbering = new Map(), allowMarker = false): ParagraphProperties {
  if (!node) return { style: {} }
  attributes(node); const style: ParagraphStyle = {}; let reference: string | undefined, marker: ReturnType<typeof runProperties> | undefined, line: ParagraphProperties['line']
  for (const [name, child] of singletonChildren(node)) {
    switch (name) {
      case 'pStyle': leaf(child); reference = value(child); break
      case 'jc': leaf(child); requireValue(['left', 'center', 'right', 'both', 'start', 'end'].includes(value(child)), '独立文字编辑器暂不支持此段落对齐方式。'); style.align = value(child) === 'both' ? 'justify' : value(child) === 'start' ? 'left' : value(child) === 'end' ? 'right' : value(child) as 'left' | 'center' | 'right'; break
      case 'bidi': requireValue(!onOff(child), '独立文字编辑器暂不支持从右到左段落。'); break
      case 'ind': Object.assign(style, paragraphIndents(child)); break
      case 'widowControl': style.widowControl = onOff(child); break
      case 'keepNext': style.keepNext = onOff(child); break
      case 'keepLines': style.keepLines = onOff(child); break
      case 'suppressAutoHyphens': style.suppressAutoHyphens = onOff(child); break
      case 'rPr': {
        attributes(child)
        if (!wordElements(child).length) break
        requireValue(allowMarker, '独立文字编辑器暂不支持样式定义中的段落标记格式。')
        marker = runProperties(child); break
      }
      case 'numPr': {
        attributes(child); const values = singletonChildren(child)
        requireValue(values.size <= 2 && [...values.keys()].every(key => ['numId', 'ilvl'].includes(key)), '独立文字编辑器暂不支持此编号属性。')
        const id = values.get('numId'); requireValue(id, 'DOCX 段落编号缺少标识。'); leaf(id)
        const level = values.get('ilvl'); if (level) leaf(level)
        const ilvl = level ? numberValue(value(level), '编号级别', 0, 8) : 0
        const numId = String(numberValue(value(id), '编号标识', 0, 2147483647))
        requireValue(numId === '0' || numbering.get(numId)?.has(ilvl), '独立文字编辑器暂不支持可见编号或带缩进的编号。'); break
      }
      case 'outlineLvl': { leaf(child); const level = numberValue(value(child), '标题级别', 0, 9); requireValue(level < 3 || level === 9, '独立文字编辑器暂支持一至三级标题。'); style.heading = level === 9 ? 0 : (level + 1) as 1 | 2 | 3; break }
      case 'spacing': {
        leaf(child, ['before', 'after', 'line', 'lineRule'])
        if (child.hasAttributeNS(W, 'before')) style.spaceBefore = numberValue(child.getAttributeNS(W, 'before'), '段前间距', 0, 31680) / 20
        if (child.hasAttributeNS(W, 'after')) style.spaceAfter = numberValue(child.getAttributeNS(W, 'after'), '段后间距', 0, 31680) / 20
        const hasLine = child.hasAttributeNS(W, 'line'), rule = child.getAttributeNS(W, 'lineRule')
        if (hasLine || rule !== null) {
          requireValue(rule === null || ['auto', 'exact', 'atLeast'].includes(rule), 'DOCX 行距规则无效。')
          // Writer starts a fresh line-spacing item at exact 12pt. A rule
          // alone reinterprets that 240-twip value, not the ancestor's height.
          // Keep omitted line distinct from an explicitly empty/invalid value.
          line = { value: hasLine ? numberValue(child.getAttributeNS(W, 'line'), '行距', 1, 31680) : 240, ...(rule !== null ? { rule: rule as ParagraphStyle['lineHeightRule'] } : {}) }
        }
        break
      }
      default: unsupported(`段落格式 ${name}`)
    }
  }
  return { style, reference, ...(marker ? { marker } : {}), ...(line ? { line } : {}) }
}
interface ResolvedStyle { paragraph: ParagraphStyle; runLayers: TextStyle[]; nextId?: string }
interface Styles {
  defaultRun: TextStyle; defaultParagraph: ParagraphStyle; defaultId?: string; defaultCharacterId?: string
  get(id: string, type: 'paragraph' | 'character'): ResolvedStyle
  next(id: string): WordParagraph['nextParagraphStyle']
}
function readStyles(parts: ParsedParts, path?: string, numbering: Numbering = new Map()): Styles {
  const definitions = new Map<string, Element>(), resolved = new Map<string, ResolvedStyle>(), resolving = new Set<string>()
  // Missing OOXML foreground is automatic too: unlike explicit black it
  // becomes white over a dark character background in native Writer.
  const styles: Styles = { defaultRun: { color: 'auto' }, defaultParagraph: { spaceBefore: 0, spaceAfter: 0, lineHeight: 1, lineHeightRule: 'auto', widowControl: true }, get, next }
  if (path) {
    const root = partXml(parts, path, W, 'styles'); attributes(root)
    let defaultsSeen = false
    for (const node of wordElements(root)) {
      if (node.localName === 'docDefaults') {
        requireValue(!defaultsSeen, 'DOCX 文档默认格式重复。'); defaultsSeen = true; attributes(node)
        for (const [name, child] of singletonChildren(node)) {
          attributes(child); const inner = singletonChildren(child)
          if (name === 'rPrDefault') {
            requireValue(inner.size <= 1 && [...inner.keys()].every(key => key === 'rPr'), 'DOCX 默认文字格式无效。')
            const parsed = runProperties(inner.get('rPr')); requireValue(!parsed.reference, 'DOCX 默认文字格式不能引用字符样式。')
            requireValue(parsed.positionHalfPoints === undefined, '独立文字编辑器暂不支持文档默认格式中的自定义基线偏移。')
            // Native Writer changes document-default shading on its first
            // save; accepting it would promise unstable initial appearance.
            requireValue(parsed.style.backgroundColor === undefined, '独立文字编辑器暂不支持文档默认文字底纹。')
            styles.defaultRun = { ...styles.defaultRun, ...parsed.style }
          } else if (name === 'pPrDefault') {
            requireValue(inner.size <= 1 && [...inner.keys()].every(key => key === 'pPr'), 'DOCX 默认段落格式无效。')
            const parsed = paragraphProperties(inner.get('pPr'), numbering); requireValue(!parsed.reference, 'DOCX 默认段落格式不能引用段落样式。'); styles.defaultParagraph = { ...styles.defaultParagraph, ...resolvedParagraphProperties(parsed, styles.defaultParagraph) }
          } else unsupported(`默认样式 ${name}`)
        }
      } else if (node.localName === 'style') {
        attributes(node, ['type', 'styleId', 'default', 'customStyle'])
        const id = node.getAttributeNS(W, 'styleId'); requireValue(id && !definitions.has(id), 'DOCX 样式标识无效或重复。'); definitions.set(id, node)
        const isDefault = node.getAttributeNS(W, 'default')
        requireValue(isDefault === null || ['0', '1', 'false', 'true', 'off', 'on'].includes(isDefault), 'DOCX 默认样式标记无效。')
        if (['1', 'true', 'on'].includes(isDefault || '') && node.getAttributeNS(W, 'type') === 'paragraph') {
          requireValue(!styles.defaultId, 'DOCX 存在多个默认段落样式。'); styles.defaultId = id
        } else if (['1', 'true', 'on'].includes(isDefault || '') && node.getAttributeNS(W, 'type') === 'character') {
          requireValue(!styles.defaultCharacterId, 'DOCX 存在多个默认字符样式。'); styles.defaultCharacterId = id
        }
      } else if (node.localName === 'latentStyles') {
        // Style gallery visibility metadata does not affect document content.
        attributes(node, ['defLockedState', 'defUIPriority', 'defSemiHidden', 'defUnhideWhenUsed', 'defQFormat', 'count'])
        for (const child of wordElements(node)) {
          requireValue(child.localName === 'lsdException', 'DOCX 潜在样式节点无效。')
          leaf(child, ['name', 'locked', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat'])
        }
      } else unsupported(`样式节点 ${node.localName}`)
    }
  }
  function get(id: string, type: 'paragraph' | 'character'): ResolvedStyle {
    const key = `${type}:${id}`, cached = resolved.get(key); if (cached) return cached
    requireValue(!resolving.has(key) && resolving.size < 64, 'DOCX 样式继承存在循环或层级过深。'); resolving.add(key)
    const node = definitions.get(id); requireValue(node && node.getAttributeNS(W, 'type') === type, `DOCX 引用了缺失或类型不符的样式：${id}。`)
    const children = singletonChildren(node); let base: ResolvedStyle = { paragraph: {}, runLayers: [] }
    const basedOn = children.get('basedOn'); if (basedOn) { leaf(basedOn); base = get(value(basedOn), type) }
    for (const [name, child] of children) {
      if (['pPr', 'rPr', 'basedOn'].includes(name)) continue
      if (['name', 'aliases', 'uiPriority', 'rsid', 'next'].includes(name)) leaf(child)
      else if (['qFormat', 'semiHidden', 'unhideWhenUsed'].includes(name)) onOff(child)
      else unsupported(`样式 ${id} 中的 ${name}`)
    }
    const p = paragraphProperties(children.get('pPr'), numbering), r = runProperties(children.get('rPr'))
    requireValue(r.positionHalfPoints === undefined, '独立文字编辑器暂不支持样式定义中的自定义基线偏移。')
    requireValue(!p.reference && !r.reference && (type === 'paragraph' || !children.has('pPr')), 'DOCX 样式包含不支持的嵌套引用。')
    // Writer ignores highlight in character styles. Still validate the XML,
    // then omit the ineffective property instead of promoting it to direct
    // formatting (which would create a visible highlight on save).
    if (type === 'character') delete r.style.highlight
    const result: ResolvedStyle = { paragraph: { ...base.paragraph, ...resolvedParagraphProperties(p, { ...styles.defaultParagraph, ...base.paragraph }) }, runLayers: [...base.runLayers, r.style], ...(children.has('next') ? { nextId: value(children.get('next')!) } : {}) }
    resolving.delete(key); resolved.set(key, result); return result
  }
  function next(id: string): WordParagraph['nextParagraphStyle'] {
    const current = get(id, 'paragraph'); if (!current.nextId || current.nextId === id) return undefined
    const target = get(current.nextId, 'paragraph')
    requireValue(!target.nextId || target.nextId === current.nextId, '独立文字编辑器暂不支持多级后续段落样式链。')
    const characterLayers = styles.defaultCharacterId ? get(styles.defaultCharacterId, 'character').runLayers : []
    return { paragraph: { ...styles.defaultParagraph, ...target.paragraph }, run: paragraphRunBase(styles.defaultRun, target.runLayers, characterLayers), sourceRun: paragraphRunBase(styles.defaultRun, current.runLayers, characterLayers) }
  }
  return styles
}
function applyStyleLayers(style: TextStyle, layers: TextStyle[]): TextStyle {
  const output = { ...style }
  for (const layer of layers) {
    // Native Writer resolves strike/dstrike and caps/smallCaps as ordinary
    // enums across style chains; do not apply the b/i toggles to them.
    const { bold, italic, ...ordinary } = layer; Object.assign(output, ordinary)
    // WordprocessingML b/i are toggle properties in style definitions only.
    if (bold) output.bold = !output.bold
    if (italic) output.italic = !output.italic
  }
  return output
}
function paragraphRunBase(style: TextStyle, paragraphLayers: TextStyle[], characterLayers: TextStyle[]): TextStyle {
  const paragraph = applyStyleLayers(style, paragraphLayers), result = applyStyleLayers(paragraph, implicitCharacterLayers(characterLayers))
  // Explicit named character script provenance lives on the run/mark, separate
  // from paragraph inheritance and hard escapement. A default character style
  // is validated but cannot introduce implicit attributes here.
  if (paragraph.verticalAlign === undefined) delete result.verticalAlign
  else result.verticalAlign = paragraph.verticalAlign
  return result
}
function implicitCharacterLayers(_layers: TextStyle[]): TextStyle[] {
  // Writer applies document rPrDefault, but a character style marked
  // w:default is not an implicit style of every run/paragraph mark. Resolve
  // its definition for validation, then apply it only through explicit rStyle.
  return []
}
function readParagraph(node: Element, index: number, styles: Styles, numbering: Numbering): WordParagraph {
  attributes(node); const nodes = wordElements(node); const pPr = nodes[0]?.localName === 'pPr' ? nodes.shift() : undefined
  const direct = paragraphProperties(pPr, numbering, true), styleId = direct.reference || styles.defaultId
  const inherited = styleId ? styles.get(styleId, 'paragraph') : { paragraph: {}, runLayers: [] }
  const sourceRun = paragraphRunBase(styles.defaultRun, inherited.runLayers, styles.defaultCharacterId ? styles.get(styles.defaultCharacterId, 'character').runLayers : [])
  const sourceParagraph = { ...styles.defaultParagraph, ...inherited.paragraph }
  const directStyle = resolvedParagraphProperties(direct, sourceParagraph)
  const paragraph: WordParagraph = { id: `paragraph-${index + 1}`, sourceRun, sourceParagraph, directStyle, style: { ...sourceParagraph, ...directStyle }, runs: [] }
  const nextStyle = styleId ? styles.next(styleId) : undefined; if (nextStyle) paragraph.nextParagraphStyle = nextStyle
  // Marker formatting follows its own character cascade. It never changes
  // sourceRun or a nonempty body run, even when its size/paint differs.
  function resolveCharacters(directRun: ReturnType<typeof runProperties>, isMarker = false, hasBodyText = true): ParagraphMarkerFormat {
    const baseRun = applyStyleLayers(styles.defaultRun, inherited.runLayers)
    let runStyle = { ...baseRun }
    const characterId = directRun.reference || styles.defaultCharacterId
    const selectedLayers = characterId ? styles.get(characterId, 'character').runLayers : []
    const characterLayers = directRun.reference ? selectedLayers : implicitCharacterLayers(selectedLayers)
    const characterSource = applyStyleLayers({}, characterLayers)
    const sourceVerticalAlign = characterSource.verticalAlign === undefined ? undefined : normalizeSourceVerticalAlign(characterSource.verticalAlign)
    const sourceColor = characterSource.color
    if (characterId) runStyle = applyStyleLayers(runStyle, characterLayers)
    // A named style's underline item starts from docDefaults, then inherits
    // paint only within its own basedOn chain. A missing color on its w:u
    // cannot borrow the paragraph style's independently colored underline.
    if (characterSource.underline !== undefined) {
      const color = characterSource.underlineColor ?? styles.defaultRun.underlineColor ?? 'auto'
      if (color !== 'auto' || runStyle.underlineColor !== undefined) runStyle.underlineColor = color
    }
    const directRunStyle = { ...directRun.style }
    // Position has no native effect on a paragraph mark or an empty run.
    // A session's empty insertion offset can therefore be saved but is lost
    // on reopen, just as in native Writer.
    if (directRun.positionHalfPoints !== undefined && !isMarker && hasBodyText) {
      const fontSize = directRun.style.fontSize ?? runStyle.fontSize
      requireValue(fontSize !== undefined, '自定义基线偏移需要正文、字符样式、段落样式或文档默认格式明确指定字号。')
      // Writer defers position until the final font size is known. It wins
      // over same-rPr vertAlign regardless of XML order, retains full-size
      // glyphs and stores an integer percent using C++ round (ties away from 0).
      directRunStyle.verticalAlign = normalizeVerticalAlign(roundAwayFromZero(directRun.positionHalfPoints * 50 / fontSize))
    }
    if (directRunStyle.underline !== undefined && directRunStyle.underlineColor === undefined) {
      const color = styles.defaultRun.underlineColor ?? 'auto'
      if (color !== 'auto' || runStyle.underlineColor !== undefined) directRunStyle.underlineColor = color
    }
    // Writer only cancels an active case map when an explicitly selected
    // character style and the paragraph style resolve to the same mode.
    // Within each basedOn chain it is an ordinary override, and any direct
    // case-map property takes priority over this paragraph/character toggle.
    if (directRun.style.caseMap === undefined && characterSource.caseMap !== undefined && characterSource.caseMap !== 'none' && characterSource.caseMap === baseRun.caseMap) runStyle.caseMap = 'none'
    const directStyle: TextStyle = { ...directRunStyle }
    for (const key of Object.keys(runStyle) as Array<keyof TextStyle>) if (!(key === 'verticalAlign' && sourceVerticalAlign !== undefined) && !(key === 'color' && sourceColor !== undefined) && runStyle[key] !== sourceRun[key] && directStyle[key] === undefined) Object.assign(directStyle, { [key]: runStyle[key] })
    // Explicit named-character tracking continues through Enter even when it
    // equals the paragraph base. Flatten that source into a direct override
    // before a following paragraph style can change its inherited value.
    if (directStyle.letterSpacing === undefined && characterLayers.some(layer => layer.letterSpacing !== undefined)) directStyle.letterSpacing = runStyle.letterSpacing
    // Named kerning, including an explicit zero equal to the paragraph base,
    // must continue through a following style. Preserve its original OOXML
    // threshold even though Writer renders every positive value as enabled.
    if (directStyle.kerning === undefined && characterSource.kerning !== undefined) directStyle.kerning = runStyle.kerning
    // Named foreground survives Enter independently of hard color: the body
    // keeps the character style while the new mark follows its paragraph.
    // Keep even a same-value source instead of flattening it into directStyle.
    // Keep the resolved character-style case map (including a toggle/reset)
    // explicit so Enter cannot replace it with the following paragraph base.
    if (directStyle.caseMap === undefined && characterSource.caseMap !== undefined) directStyle.caseMap = runStyle.caseMap
    // Named underline is one persistent item, including same-value line and
    // color. Keeping both prevents a following paragraph style replacing
    // either member after Enter. Colorless legacy items may remain sparse.
    if (characterSource.underline !== undefined) {
      if (directStyle.underline === undefined) directStyle.underline = runStyle.underline
      if (directStyle.underlineColor === undefined && runStyle.underlineColor !== undefined) directStyle.underlineColor = runStyle.underlineColor
    }
    if (isMarker) for (const layer of characterLayers) for (const key of Object.keys(layer) as Array<keyof TextStyle>) {
      // End insertion overlays the mark's explicit properties onto adjacent
      // text. A named marker size equal to the paragraph base must therefore
      // still override a differently sized body run. Keep script provenance
      // separate; false b/i style values do not toggle the inherited value.
      if (key === 'verticalAlign' || key === 'color' || ((key === 'bold' || key === 'italic') && !layer[key])) continue
      if (directStyle[key] === undefined && runStyle[key] !== undefined) Object.assign(directStyle, { [key]: runStyle[key] })
    }
    return { style: { ...runStyle, ...directRunStyle }, directStyle, ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}), ...(sourceColor !== undefined ? { sourceColor } : {}) }
  }
  if (direct.marker) paragraph.marker = resolveCharacters(direct.marker, true)
  for (const run of nodes) {
    if (run.localName !== 'r') unsupported(`正文内容 ${run.localName}`)
    attributes(run); const children = wordElements(run), properties = children[0]?.localName === 'rPr' ? children.shift() : undefined
    const parsedProperties = runProperties(properties); let text = ''
    for (const child of children) {
      if (child.localName === 't') {
        attributes(child, ['space'], XML); requireValue(!child.children.length, 'DOCX 文本节点包含嵌套元素。')
        const space = child.getAttributeNS(XML, 'space'); requireValue(space === null || ['default', 'preserve'].includes(space), 'DOCX xml:space 无效。')
        const content = child.textContent || ''
        requireValue(!/[\t\r\n]/.test(content), 'DOCX 文本节点含有非标准换行或制表符。')
        text += space === 'preserve' ? content : content.replace(/^ +| +$/g, '')
      } else if (child.localName === 'tab') { leaf(child, []); text += '\t' }
      else if (child.localName === 'br') {
        leaf(child, ['type']); const type = child.getAttributeNS(W, 'type'); if (type && type !== 'textWrapping') unsupported('分页符或分栏符'); text += '\n'
      } else if (child.localName === 'cr') { leaf(child, []); text += '\n' }
      else unsupported(`文字内容 ${child.localName}`)
    }
    assertSupportedWordText(text)
    requireValue(text.length > 0 || parsedProperties.positionHalfPoints === undefined
      || (parsedProperties.style.verticalAlign === undefined && parsedProperties.reference === undefined),
    '独立文字编辑器暂不支持空文字片段同时设置基线偏移与上下标或字符样式。')
    const format = resolveCharacters(parsedProperties, false, text.length > 0)
    paragraph.runs.push({ text, ...format })
  }
  if (!paragraph.runs.length) {
    const style = applyStyleLayers(styles.defaultRun, inherited.runLayers)
    const characterLayers = implicitCharacterLayers(styles.defaultCharacterId ? styles.get(styles.defaultCharacterId, 'character').runLayers : [])
    const characterScript = applyStyleLayers({}, characterLayers).verticalAlign
    const sourceVerticalAlign = characterScript === undefined ? undefined : normalizeSourceVerticalAlign(characterScript)
    paragraph.runs.push({ text: '', style: applyStyleLayers(style, characterLayers), directStyle: {}, ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}) })
  }
  return paragraph
}
function readPage(section: Element | undefined): WordDocument['page'] {
  // Native Writer's missing section/page attributes use Letter and one-inch
  // margins, independently of this application's A4 new-document preset.
  const page: WordDocument['page'] = { width: 612, height: 792, marginTop: 72, marginRight: 72, marginBottom: 72, marginLeft: 72, orientation: 'portrait' }
  if (!section) return page
  attributes(section)
  for (const [name, child] of singletonChildren(section)) {
    if (name === 'pgSz') {
      leaf(child, ['w', 'h', 'orient']); const orient = child.getAttributeNS(W, 'orient')
      requireValue(orient === null || ['portrait', 'landscape'].includes(orient), 'DOCX 纸张方向无效。')
      // Orientation is a separate OOXML/Writer flag. Contradictory width and
      // height remain authoritative dimensions and must never be swapped.
      page.orientation = (orient ?? 'portrait') as 'portrait' | 'landscape'
      if (child.hasAttributeNS(W, 'w')) page.width = numberValue(child.getAttributeNS(W, 'w'), '纸张宽度', 1440, 31680) / 20
      if (child.hasAttributeNS(W, 'h')) page.height = numberValue(child.getAttributeNS(W, 'h'), '纸张高度', 1440, 31680) / 20
    } else if (name === 'pgMar') {
      leaf(child, ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'])
      for (const key of ['top', 'right', 'bottom', 'left'] as const) {
        const field = `margin${key[0]!.toUpperCase()}${key.slice(1)}` as 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'
        if (child.hasAttributeNS(W, key)) page[field] = numberValue(child.getAttributeNS(W, key), `页边距 ${key}`, 0, 31680) / 20
      }
      if (child.hasAttributeNS(W, 'gutter')) requireValue(numberValue(child.getAttributeNS(W, 'gutter'), '装订线', 0, 31680) === 0, '独立文字编辑器暂不支持装订线。')
      for (const key of ['header', 'footer']) if (child.hasAttributeNS(W, key)) numberValue(child.getAttributeNS(W, key), key, 0, 31680)
    } else if (name === 'type') { leaf(child); requireValue(['nextPage', 'continuous'].includes(value(child)), '独立文字编辑器暂不支持此分节类型。') }
    else if (name === 'pgNumType') { leaf(child, ['fmt']); requireValue(child.getAttributeNS(W, 'fmt') === 'decimal', '独立文字编辑器暂不支持此页码设置。') }
    else if (name === 'formProt') requireValue(!onOff(child), '独立文字编辑器不能编辑受保护的文档。')
    else if (name === 'textDirection') { leaf(child); requireValue(value(child) === 'lrTb', '独立文字编辑器暂不支持竖排或从右到左版式。') }
    else if (name === 'docGrid') {
      leaf(child, ['type', 'linePitch', 'charSpace']); requireValue(child.getAttributeNS(W, 'type') === 'default', '独立文字编辑器暂不支持文档网格。')
      // OOXML type=default disables grid snapping; pitch/space do not apply.
      for (const attr of ['linePitch', 'charSpace']) if (child.hasAttributeNS(W, attr)) numberValue(child.getAttributeNS(W, attr), '未启用网格参数', 0, 2147483647)
    } else unsupported(`分节格式 ${name}`)
  }
  page.width = normalizePaperDimension(page.width)
  page.height = normalizePaperDimension(page.height)
  const pageTwips = (value: number) => Math.round(value * 20)
  requireValue(pageTwips(page.marginLeft) + pageTwips(page.marginRight) < pageTwips(page.width)
    && pageTwips(page.marginTop) + pageTwips(page.marginBottom) < pageTwips(page.height), 'DOCX 页边距没有留下有效正文区域。')
  return page
}

export function importWordDocument(input: Uint8Array): WordDocument {
  try {
    return importWordParts(readParts(input))
  } catch (error) {
    if (error instanceof WordDocumentError) throw error
    return fail(error instanceof Error ? error.message.replaceAll('PPTX', 'DOCX') : '无法读取 DOCX 文件。')
  }
}
/** Semantic validation remains in this codec even when native Rust reads ZIP. */
export function importWordParts(input: Map<string, Uint8Array>): WordDocument {
  try {
    requireValue(input instanceof Map && input.size > 0 && input.size <= 256, 'DOCX 文件数量无效或超过限制。')
    const parts = new ParsedParts(input)
    let total = 0; const seen = new Set<string>()
    for (const [name, bytes] of parts) {
      requireValue(typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\\\x00-\x1f\x7f:#?]/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..'), 'DOCX 包含不安全的文件路径。')
      requireValue(!seen.has(name.toLowerCase()) && !['__proto__', 'prototype', 'constructor'].includes(name), 'DOCX 包含重复、保留或大小写歧义的文件路径。'); seen.add(name.toLowerCase())
      requireValue(bytes instanceof Uint8Array && bytes.byteLength <= LIMIT.xml, `DOCX 文件过大或无效：${name}。`)
      total += bytes.byteLength; requireValue(total <= LIMIT.expanded, 'DOCX 解压内容超过限制。')
      if (/\.(?:xml|rels)$/i.test(name)) parts.document(name)
    }
    const types = contentTypes(parts), rootRelations = relationships(parts, '_rels/.rels', '')
    const mainRelations = rootRelations.filter(relation => relation.type === `${R}/officeDocument`)
    requireValue(mainRelations.length === 1, 'DOCX 必须包含唯一的主文档关系。')
    const main = mainRelations[0]!.target; requireValue(types.get(main) === MAIN_TYPE, '文件不是受支持的 DOCX 主文档，或包含宏。')
    const allowedParts = new Set(['[Content_Types].xml', '_rels/.rels', main]), packageMetadata: NonNullable<WordDocument['packageMetadata']> = {}
    let emptyCustomSeen = false
    for (const relation of rootRelations) {
      if (relation.type === `${R}/officeDocument`) continue
      if (relation.type === `${R}/custom-properties`) {
        requireValue(!emptyCustomSeen && types.get(relation.target) === 'application/vnd.openxmlformats-officedocument.custom-properties+xml', 'DOCX 自定义属性关系重复或内容类型错误。'); emptyCustomSeen = true
        const custom = partXml(parts, relation.target, 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties', 'Properties'); attributes(custom, [], '')
        requireValue(!elements(custom).length, '独立文字编辑器暂不支持非空自定义文档属性。'); allowedParts.add(relation.target); continue
      }
      const kind = (['coreProperties', 'extendedProperties'] as const).find(kind => METADATA[kind].type === relation.type)
      requireValue(kind && packageMetadata[kind] === undefined, 'DOCX 包含未支持或重复的包关系。')
      const bytes = parts.get(relation.target); requireValue(bytes && types.get(relation.target) === METADATA[kind].mime, 'DOCX 元数据关系缺少目标文件或内容类型错误。')
      packageMetadata[kind] = metadataXml(parts.document(relation.target).documentElement, kind); allowedParts.add(relation.target)
    }
    const slash = main.lastIndexOf('/'), mainRels = `${slash >= 0 ? main.slice(0, slash + 1) : ''}_rels/${main.slice(slash + 1)}.rels`
    allowedParts.add(mainRels); let stylePart: string | undefined, settingsPart: string | undefined, numberingPart: string | undefined
    for (const relation of relationships(parts, mainRels, main)) {
      if (relation.type === `${R}/styles`) {
        requireValue(!stylePart && types.get(relation.target) === STYLE_TYPE, 'DOCX 样式关系重复或内容类型错误。'); stylePart = relation.target
      } else if (relation.type === `${R}/settings`) {
        requireValue(!settingsPart && types.get(relation.target) === 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', 'DOCX 设置关系重复或内容类型错误。'); settingsPart = relation.target
      } else if (relation.type === `${R}/numbering`) {
        requireValue(!numberingPart && types.get(relation.target) === 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', 'DOCX 编号关系重复或内容类型错误。'); numberingPart = relation.target
      } else {
        const kind = (['fontTable', 'theme'] as const).find(kind => METADATA[kind].type === relation.type)
        if (!kind) unsupported(`文档关系 ${relation.type.split('/').at(-1)}`)
        const bytes = parts.get(relation.target); requireValue(bytes && packageMetadata[kind] === undefined && types.get(relation.target) === METADATA[kind].mime, 'DOCX 元数据关系重复、内容类型错误或目标缺失。')
        packageMetadata[kind] = metadataXml(parts.document(relation.target).documentElement, kind)
      }
      allowedParts.add(relation.target)
    }
    for (const path of parts.keys()) if (!allowedParts.has(path)) unsupported(`文档附加内容 ${path}`)
    for (const path of types.keys()) requireValue(parts.has(path), 'DOCX 内容类型引用了缺失的文件。')
    const document = partXml(parts, main, W, 'document'); attributes(document)
    const documentChildren = wordElements(document)
    requireValue(documentChildren.length === 1 && documentChildren[0]!.localName === 'body', 'DOCX 必须包含唯一正文。')
    const body = documentChildren[0]!; attributes(body); const children = wordElements(body)
    const section = children.at(-1)?.localName === 'sectPr' ? children.pop() : undefined
    requireValue(children.length <= LIMIT.paragraphs, 'DOCX 段落数量超过限制。')
    const numbering = readNumbering(parts, numberingPart), settings = readSettings(parts, settingsPart), styles = readStyles(parts, stylePart, numbering); let textLength = 0
    const paragraphs = children.map((node, index) => {
      if (node.localName !== 'p') unsupported(`正文内容 ${node.localName}`)
      const paragraph = readParagraph(node, index, styles, numbering); textLength += paragraph.runs.reduce((sum, run) => sum + run.text.length, 0)
      requireValue(!settings.autoHyphenation || paragraph.style.suppressAutoHyphens === true, '独立文字编辑器暂不支持启用自动断词的段落。')
      requireValue(!settings.autoHyphenation || !paragraph.nextParagraphStyle || paragraph.nextParagraphStyle.paragraph.suppressAutoHyphens === true, '独立文字编辑器暂不支持启用自动断词的后续段落样式。')
      requireValue(textLength <= LIMIT.text, 'DOCX 正文超过 100 万字符限制。'); return paragraph
    })
    return normalizeDocument({ paragraphs: paragraphs.length ? paragraphs : createWordDocument().paragraphs, page: readPage(section), defaultTabStop: settings.defaultTabStop, autoHyphenation: settings.autoHyphenation, ...(Object.keys(packageMetadata).length ? { packageMetadata } : {}) })
  } catch (error) {
    if (error instanceof WordDocumentError) throw error
    return fail(error instanceof Error ? error.message.replaceAll('PPTX', 'DOCX') : '无法读取 DOCX 文件。')
  }
}
function escape(text: string): string {
  requireValue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text), '正文包含 XML 无法保存的控制字符。')
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
function tag(name: string, val: string | number): string { return `<w:${name} w:val="${escape(String(val))}"/>` }
function roundAwayFromZero(value: number): number { return Math.sign(value) * Math.round(Math.abs(value)) }
function serializeRunProperties(style: TextStyle, direct = false, effective: TextStyle = style): string {
  const props: string[] = [], fonts: string[] = []
  if (style.fontName !== undefined) fonts.push(`w:ascii="${escape(style.fontName)}" w:hAnsi="${escape(style.fontName)}"`)
  const eastAsia = style.fontNameEastAsia ?? (direct ? undefined : style.fontName), cs = style.fontNameCs ?? (direct ? undefined : style.fontName)
  if (eastAsia !== undefined) fonts.push(`w:eastAsia="${escape(eastAsia)}"`)
  if (cs !== undefined) fonts.push(`w:cs="${escape(cs)}"`)
  if (fonts.length) props.push(`<w:rFonts ${fonts.join(' ')}/>`)
  if (style.bold !== undefined) props.push(tag('b', style.bold ? 1 : 0))
  if (style.italic !== undefined) props.push(tag('i', style.italic ? 1 : 0))
  if (style.strike !== undefined) {
    props.push(tag('strike', style.strike === 'single' ? 1 : 0))
    props.push(tag('dstrike', style.strike === 'double' ? 1 : 0))
  }
  if (style.caseMap === 'upper') props.push(tag('caps', 1))
  else if (style.caseMap === 'smallCaps') props.push(tag('smallCaps', 1))
  else if (style.caseMap === 'none') props.push(tag('smallCaps', 0), tag('caps', 0))
  if (style.color !== undefined) props.push(tag('color', style.color === 'auto' ? 'auto' : style.color.slice(1).toUpperCase()))
  if (style.kerning !== undefined) props.push(tag('kern', Math.round(style.kerning * 2)))
  if (style.letterSpacing !== undefined) props.push(tag('spacing', Math.round(style.letterSpacing * 20)))
  if (style.fontSize !== undefined) props.push(tag('sz', Math.round(style.fontSize * 2)))
  if (style.fontSizeCs !== undefined) props.push(tag('szCs', Math.round(style.fontSizeCs * 2)))
  if (style.highlight !== undefined) props.push(tag('highlight', style.highlight))
  if (style.underline !== undefined || style.underlineColor !== undefined) {
    // DOCX cannot express a color-only override: omitting val creates a
    // disabled line in Writer. Emit the complete effective underline item.
    const underline = style.underline ?? effective.underline ?? false, color = style.underlineColor ?? effective.underlineColor
    props.push(`<w:u w:val="${underline === 'double' ? 'double' : underline ? 'single' : 'none'}"${color && color !== 'auto' ? ` w:color="${color.slice(1)}"` : ''}/>`)
  }
  if (style.backgroundColor !== undefined) props.push(`<w:shd w:val="clear" w:fill="${style.backgroundColor === 'none' ? 'auto' : style.backgroundColor.slice(1)}"/>`)
  if (typeof style.verticalAlign === 'number') {
    const fontSize = effective.fontSize ?? 12
    props.push(tag('position', roundAwayFromZero(fontSize * style.verticalAlign / 50)))
    // Newly created models may rely on the editor's 12pt default. Make that
    // size explicit wherever a custom offset needs it for deterministic import.
    if (effective.fontSize === undefined) props.push(tag('sz', fontSize * 2))
    // A small nonzero percentage can round to position=0. Native Writer emits
    // only that ignored value, so reopening can restore an inherited script;
    // adding vertAlign=baseline here would incorrectly change native behavior.
  } else if (style.verticalAlign !== undefined) props.push(tag('vertAlign', style.verticalAlign))
  const languages = [['val', style.language], ['eastAsia', style.languageEastAsia], ['bidi', style.languageBidi]].filter(([, language]) => language !== undefined)
  if (languages.length) props.push(`<w:lang ${languages.map(([name, language]) => `w:${name}="${escape(language!)}"`).join(' ')}/>`)
  return props.join('')
}
function serializeRun(run: WordRun, direct = false): string {
  // Only the actual paragraph mark can carry an empty insertion format.
  // Native Writer ignores position on empty runs; emitting it beside rStyle
  // would also create the unsupported empty-run compound rejected on import.
  const props = serializeCharacterFormat(run, direct, !run.text && typeof run.style.verticalAlign === 'number')
  const content = run.text.split(/([\t\n])/).map(text => text === '\t' ? '<w:tab/>' : text === '\n' ? '<w:br/>' : `<w:t xml:space="preserve">${escape(text)}</w:t>`).join('')
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${content}</w:r>`
}
function characterStyleId(format: ParagraphMarkerFormat): string | undefined {
  if (format.sourceColor !== undefined) return `IndependentColor${format.sourceColor === 'auto' ? 'Auto' : format.sourceColor.slice(1)}${format.sourceVerticalAlign === undefined ? '' : `Script${format.sourceVerticalAlign}`}`
  return format.sourceVerticalAlign !== undefined ? `IndependentScript${format.sourceVerticalAlign}` : undefined
}
function serializeCharacterFormat(format: ParagraphMarkerFormat, direct = false, omitEmptyOffset = false): string {
  const characterStyle = characterStyleId(format)
  const style = direct || characterStyle ? format.directStyle ?? format.style : format.style
  const exportedStyle = omitEmptyOffset && typeof style.verticalAlign === 'number' ? { ...style, verticalAlign: undefined } : style
  return (characterStyle ? tag('rStyle', characterStyle) : '') + serializeRunProperties(exportedStyle, direct || Boolean(characterStyle), format.style)
}
function serializeParagraphProperties(style: ParagraphStyle): string {
  const props: string[] = []
  for (const key of ['keepNext', 'keepLines', 'widowControl', 'suppressAutoHyphens'] as const) if (style[key] !== undefined) props.push(tag(key, style[key] ? 1 : 0))
  if (style.spaceBefore !== undefined || style.spaceAfter !== undefined || style.lineHeight !== undefined) {
    const spacing: string[] = []
    if (style.spaceBefore !== undefined) spacing.push(`w:before="${Math.round(style.spaceBefore * 20)}"`)
    if (style.spaceAfter !== undefined) spacing.push(`w:after="${Math.round(style.spaceAfter * 20)}"`)
    if (style.lineHeight !== undefined) { const rule = style.lineHeightRule || 'auto'; spacing.push(`w:lineRule="${rule}" w:line="${Math.round(style.lineHeight * (rule === 'auto' ? 240 : 20))}"`) }
    props.push(`<w:spacing ${spacing.join(' ')}/>`)
  }
  const indents: string[] = []
  if (style.indentLeft !== undefined) indents.push(`w:left="${Math.round(style.indentLeft * 20)}"`)
  if (style.indentRight !== undefined) indents.push(`w:right="${Math.round(style.indentRight * 20)}"`)
  if (style.indentFirstLine !== undefined) indents.push(`w:${style.indentFirstLine < 0 ? 'hanging' : 'firstLine'}="${Math.abs(Math.round(style.indentFirstLine * 20))}"`)
  if (indents.length) props.push(`<w:ind ${indents.join(' ')}/>`)
  if (style.align !== undefined) props.push(tag('jc', style.align === 'justify' ? 'both' : style.align))
  if (style.heading !== undefined) props.push(tag('outlineLvl', style.heading ? style.heading - 1 : 9))
  return props.join('')
}
function serializeParagraph(paragraph: WordParagraph, styleId?: string): string {
  // Writer discards formatting held only on an empty run. Migrate older
  // in-memory/own-export empty paragraphs to the actual paragraph mark.
  const marker = paragraph.marker ?? (paragraph.runs.every(run => !run.text) ? paragraph.runs[0] : undefined)
  const markerProperties = marker ? serializeCharacterFormat(marker, Boolean(styleId)) : ''
  const props = (styleId ? tag('pStyle', styleId) : '') + serializeParagraphProperties(styleId ? paragraph.directStyle ?? paragraph.style : paragraph.style) + (markerProperties ? `<w:rPr>${markerProperties}</w:rPr>` : '')
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${paragraph.runs.map(run => serializeRun(run, Boolean(styleId))).join('')}</w:p>`
}
export function exportWordParts(input: WordDocument): Map<string, Uint8Array> {
  const model = normalizeDocument(input), page = model.page
  requireValue(page.width <= 1584 && page.height <= 1584, 'DOCX 纸张尺寸不能超过 1584 磅（22 英寸）。')
  requireValue(model.paragraphs.length <= LIMIT.paragraphs && model.paragraphs.reduce((sum, p) => sum + p.runs.reduce((n, r) => n + r.text.length, 0), 0) <= LIMIT.text, '文档超过独立文字编辑器的保存限制。')
  const orientation = page.orientation ?? (page.width > page.height ? 'landscape' : 'portrait')
  const section = `<w:sectPr><w:pgSz w:w="${Math.round(page.width * 20)}" w:h="${Math.round(page.height * 20)}" w:orient="${orientation}"/><w:pgMar w:top="${Math.round(page.marginTop * 20)}" w:right="${Math.round(page.marginRight * 20)}" w:bottom="${Math.round(page.marginBottom * 20)}" w:left="${Math.round(page.marginLeft * 20)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`
  const styleIds = new Map<string, string>(), namedStyles: string[] = []
  const characterFormats = new Map<string, ParagraphMarkerFormat>()
  for (const paragraph of model.paragraphs) for (const format of [...paragraph.runs, ...(paragraph.marker ? [paragraph.marker] : [])]) {
    const id = characterStyleId(format)
    if (id) characterFormats.set(id, format)
  }
  for (const [id, format] of characterFormats) {
    const properties = (format.sourceVerticalAlign === undefined ? '' : tag('vertAlign', format.sourceVerticalAlign))
      + (format.sourceColor === undefined ? '' : tag('color', format.sourceColor === 'auto' ? 'auto' : format.sourceColor.slice(1)))
    namedStyles.push(`<w:style w:type="character" w:styleId="${id}">${tag('name', id)}<w:rPr>${properties}</w:rPr></w:style>`)
  }
  for (const [index, paragraph] of model.paragraphs.entries()) {
    requireValue(!model.autoHyphenation || paragraph.style.suppressAutoHyphens === true, '独立文字编辑器暂不支持启用自动断词的段落。')
    const next = paragraph.nextParagraphStyle; if (!next && !paragraph.sourceRun && !paragraph.sourceParagraph) continue
    requireValue(!model.autoHyphenation || !next || next.paragraph.suppressAutoHyphens === true, '独立文字编辑器暂不支持启用自动断词的后续段落样式。')
    const currentId = `IndependentParagraph${index + 1}`, nextId = `IndependentNext${index + 1}`
    styleIds.set(paragraph.id, currentId)
    namedStyles.push(`<w:style w:type="paragraph" w:styleId="${currentId}">${tag('name', currentId)}${next ? tag('next', nextId) : ''}<w:pPr>${serializeParagraphProperties(inheritedParagraphStyle(paragraph))}</w:pPr><w:rPr>${serializeRunProperties(paragraph.sourceRun ?? next?.sourceRun ?? {})}</w:rPr></w:style>`)
    if (next) namedStyles.push(`<w:style w:type="paragraph" w:styleId="${nextId}">${tag('name', nextId)}<w:pPr>${serializeParagraphProperties(next.paragraph)}</w:pPr><w:rPr>${serializeRunProperties(next.run)}</w:rPr></w:style>`)
  }
  const rootRelationships = [`<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>`]
  const documentRelationships = [`<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`, `<Relationship Id="rId2" Type="${R}/settings" Target="settings.xml"/>`]
  const overrides = [`<Override PartName="/word/document.xml" ContentType="${MAIN_TYPE}"/>`, `<Override PartName="/word/styles.xml" ContentType="${STYLE_TYPE}"/>`, '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>']
  const sources = new Map<string, string>()
  for (const kind of Object.keys(METADATA) as MetadataKey[]) {
    const source = model.packageMetadata?.[kind]; if (source === undefined) continue
    const spec = METADATA[kind], validated = metadataXml(xml(encoder.encode(source), spec.path).documentElement, kind)
    sources.set(spec.path, validated); overrides.push(`<Override PartName="/${spec.path}" ContentType="${spec.mime}"/>`)
    const isRoot = kind === 'coreProperties' || kind === 'extendedProperties', relations = isRoot ? rootRelationships : documentRelationships
    relations.push(`<Relationship Id="rId${relations.length + 1}" Type="${spec.type}" Target="${isRoot ? spec.path : spec.path.slice(5)}"/>`)
  }
  sources.set('[Content_Types].xml', `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`)
  sources.set('_rels/.rels', `<Relationships xmlns="${PR}">${rootRelationships.join('')}</Relationships>`)
  sources.set('word/_rels/document.xml.rels', `<Relationships xmlns="${PR}">${documentRelationships.join('')}</Relationships>`)
  sources.set('word/styles.xml', `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:color w:val="20242B"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>${namedStyles.join('')}</w:styles>`)
  sources.set('word/settings.xml', `<w:settings xmlns:w="${W}">${tag('defaultTabStop', Math.round((model.defaultTabStop ?? 36) * 20))}${tag('autoHyphenation', model.autoHyphenation ? 1 : 0)}${tag('hyphenationZone', 0)}</w:settings>`)
  sources.set('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${model.paragraphs.map(paragraph => serializeParagraph(paragraph, styleIds.get(paragraph.id))).join('')}${section}</w:body></w:document>`)
  const parts = new Map<string, Uint8Array>()
  for (const [name, source] of sources) {
    const bytes = encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${source}`)
    requireValue(bytes.length <= LIMIT.xml, `DOCX XML 过大：${name}。`); xml(bytes, name); parts.set(name, bytes)
  }
  return parts
}
export function exportWordDocument(input: WordDocument): Uint8Array {
  try { return writePptxParts(exportWordParts(input)) }
  catch (error) { return fail(error instanceof Error ? error.message.replaceAll('PPTX', 'DOCX') : '无法保存 DOCX 文件。') }
}
