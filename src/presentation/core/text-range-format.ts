import type { PresentationTextStyle } from '../types'
import type { SlideObject } from './types'
import type { RichParagraph, RichRun } from './rich-text'
import { effectiveRichText } from './rich-text.ts'
import { A, P, R, readXml, writeXml, snapshotXml, child, children, all } from './pptx-common.ts'
import { generatedTextBody, patchDrawingText, patchRunProperties, plainText } from './pptx-text.ts'
import type { DrawingCharacterStyle } from './pptx-text'
import { ensureRunProperties, patchTextPaint } from './text-paint.ts'

const XML = 'http://www.w3.org/XML/1998/namespace', XMLNS = 'http://www.w3.org/2000/xmlns/'
const LIMITS = { text: 100000, xml: 1000000, elements: 20000, runs: 10000 }
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function baseline(object: SlideObject): Partial<SlideObject> | undefined {
  try { return object.sourceFingerprint ? JSON.parse(object.sourceFingerprint) : undefined } catch { return undefined }
}
function generatedBody(object: SlideObject): Element {
  return readXml(`<p:root xmlns:p="${P}" xmlns:a="${A}">${generatedTextBody(object)}</p:root>`).documentElement.firstElementChild!
}

/** Explicitly bounded, plain DrawingML text only. Unknown legal rPr properties
 * (baseline, spacing, highlight, etc.) survive by cloning the original run.
 * Relationships/extensions can have nonlocal or unique identities; splitting
 * them is deliberately unsupported rather than silently losing their meaning. */
export function assertRangeTextBody(body: Element, namespace: typeof P | typeof A = P): void {
  requireValue(body.localName === 'txBody' && body.namespaceURI === namespace, '选区格式仅支持普通 DrawingML 文字。')
  const elements = [body, ...Array.from(body.getElementsByTagName('*'))]
  requireValue(elements.length <= LIMITS.elements && all(body, 'r').length <= LIMITS.runs, '文字节点数量超过选区格式的安全限制。')
  requireValue(snapshotXml(body).length <= LIMITS.xml, '文字 XML 超过选区格式的安全限制。')
  for (const element of elements) {
    requireValue(element === body || element.namespaceURI === A, '文字包含不支持的命名空间，无法安全设置选区格式。')
    requireValue(!['fld', 'hlinkClick', 'hlinkMouseOver', 'extLst', 'ext', 'buBlip', 'blip', 'blipFill', 'sym'].includes(element.localName), '字段、链接、图片项目符号、扩展或符号字体暂不支持选区格式。')
    for (const attribute of Array.from(element.attributes)) {
      requireValue(attribute.namespaceURI !== R && !/\/relationships$/.test(attribute.namespaceURI || ''), '文字包含部件关系，暂不支持选区格式。')
      requireValue(!attribute.namespaceURI || [XML, XMLNS].includes(attribute.namespaceURI), '文字包含扩展属性，暂不支持选区格式。')
      requireValue(!(attribute.namespaceURI === XML && attribute.localName === 'id'), '文字包含唯一标识，不能安全切分文字片段。')
    }
  }
  const paragraphs = children(body, 'p')
  requireValue(paragraphs.length > 0 && children(body).every(element => ['bodyPr', 'lstStyle', 'p'].includes(element.localName)), '文字段落结构不支持选区格式。')
  requireValue(children(body, 'bodyPr').length <= 1 && children(body, 'lstStyle').length <= 1, '文字属性重复，无法安全设置选区格式。')
  for (const paragraph of paragraphs) {
    requireValue(children(paragraph).every(element => ['pPr', 'r', 'br', 'endParaRPr'].includes(element.localName)) && children(paragraph, 'pPr').length <= 1 && children(paragraph, 'endParaRPr').length <= 1, '文字段落包含不可安全切分的内容。')
    for (const run of children(paragraph)) if (run.localName === 'r') {
      requireValue(children(run, 't').length === 1 && children(run, 'rPr').length <= 1 && children(run).every(element => ['rPr', 't'].includes(element.localName)), '文字片段结构不支持选区格式。')
      requireValue(Array.from(child(run, 't')!.childNodes).every(node => node.nodeType === 3 || node.nodeType === 4), '文字内容包含嵌套元素或特殊节点，不能安全切分。')
      requireValue(Array.from(run.attributes).every(attribute => attribute.namespaceURI === XMLNS), '文字片段包含未知标识，不能安全切分。')
      requireValue(Array.from(child(run, 't')!.attributes).every(attribute => attribute.namespaceURI === XMLNS || attribute.namespaceURI === XML && attribute.localName === 'space'), '文字内容包含不支持的扩展属性。')
    } else if (run.localName === 'br') requireValue(children(run).every(element => element.localName === 'rPr') && children(run, 'rPr').length <= 1, '换行节点结构不支持选区格式。')
  }
}

/** Return fresh XML. The original shape and package bytes are never mutated.
 * A range override stores text/style only; imported body layout remains based
 * on the original import, so subsequent body-layout changes can be reversed. */
export function materializeTextBody(object: SlideObject, original?: Element, previous = baseline(object), includeLayout = true): Element {
  let body: Element, generated = false
  const override = object.textBodyOverride
  if (override) {
    requireValue(typeof override.xml === 'string' && override.xml.length <= LIMITS.xml, '已保存的选区格式 XML 无效或超过限制。')
    body = readXml(override.xml).documentElement
    assertRangeTextBody(body)
    requireValue(plainText(body) === override.text, '已保存的选区格式与文字不一致，原文档未改变。')
  } else if (original) body = original.cloneNode(true) as Element
  else if (object.sourceXml) {
    requireValue(object.sourceXml.length <= LIMITS.xml * 2, '原始对象 XML 超过选区格式的安全限制。')
    const source = readXml(object.sourceXml).documentElement
    const originalBody = child(source, 'txBody')
    generated = !originalBody; body = originalBody || generatedBody(object)
  } else { body = generatedBody(object); generated = true }
  const textPrevious = override ? { ...previous, textStyle: override.baseStyle, textStyleOverrides: undefined }
    : generated ? { ...previous, textStyle: object.textStyle, textStyleOverrides: object.textStyleOverrides } : previous
  patchDrawingText(body, object, textPrevious, object.text, { layout: false })
  if (includeLayout) {
    // Use original layout baseline, not a style rebase. Formatting a character
    // never commits unrelated body-layout properties into the override.
    patchDrawingText(body, object, { ...textPrevious, textStyle: object.textStyle, textStyleOverrides: object.textStyleOverrides }, object.text, { layout: true })
  }
  return body
}

function validXmlCharacters(value: string): boolean {
  // XML 1.0 allows supplementary-plane characters but not unpaired UTF-16
  // surrogates or the two forbidden BMP noncharacters. Validate before adding
  // a typeface attribute so a successful action always remains serializable.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
export function validateText(text: string): void {
  requireValue(typeof text === 'string' && text.length <= LIMITS.text, '文字长度超过选区格式的安全限制。')
  requireValue(!text.includes('\r'), '含回车符的文字暂不支持选区格式，请先规范为普通换行。')
  requireValue(validXmlCharacters(text), '文字含无效 Unicode 或 XML 字符，无法安全设置选区格式。')
}
function boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}
function sourceBody(object: SlideObject): Element {
  if (object.textBodyOverride) {
    requireValue(object.textBodyOverride.xml.length <= LIMITS.xml, '文字 XML 超过选区格式的安全限制。')
    return readXml(object.textBodyOverride.xml).documentElement
  }
  if (object.sourceXml) {
    requireValue(object.sourceXml.length <= LIMITS.xml * 2, '原始对象 XML 超过选区格式的安全限制。')
    const body = child(readXml(object.sourceXml).documentElement, 'txBody')
    requireValue(body, '原始对象没有可安全编辑的文字正文。')
    return body
  }
  return generatedBody(object)
}

/** Optional preflight for UI hints. Final action repeats all checks atomically. */
export function textRangeBlockedReason(object: SlideObject): string | undefined {
  try {
    requireValue(!object.locked && object.capabilities.text && !['table', 'chart', 'group', 'image', 'unknown'].includes(object.type), '此对象不支持选区文字格式。')
    requireValue(!object.hasAnimation, '带原有动画关系的文字暂不支持选区格式，以免改变动画文字片段。')
    requireValue(!object.sourceXml || object.richText, '原始文字未完整解析，暂不支持选区格式。')
    validateText(object.text)
    assertRangeTextBody(sourceBody(object))
  } catch (error) { return error instanceof Error ? error.message : '文字结构不支持选区格式。' }
}

function formattedParagraphs(paragraphs: RichParagraph[], start: number, end: number, style: DrawingCharacterStyle): RichParagraph[] {
  let cursor = 0
  return paragraphs.map((paragraph, index) => {
    if (index) cursor++
    const runs: RichRun[] = []
    for (const run of paragraph.runs) {
      const first = Math.max(0, start - cursor), last = Math.min(run.text.length, end - cursor)
      if (run.kind === 'break' || last <= first) runs.push({ ...run, style: { ...run.style } })
      else {
        if (first) runs.push({ ...run, text: run.text.slice(0, first), style: { ...run.style } })
        const selected = { ...run, text: run.text.slice(first, last), style: { ...run.style, ...style } }
        if (style.color !== undefined) delete selected.paintUnsupported
        runs.push(selected)
        if (last < run.text.length) runs.push({ ...run, text: run.text.slice(last), style: { ...run.style } })
      }
      cursor += run.text.length
    }
    return { ...paragraph, style: { ...paragraph.style }, ...(paragraph.defaultRun ? { defaultRun: { ...paragraph.defaultRun, style: { ...paragraph.defaultRun.style } } } : {}), runs }
  })
}

/** Persist a format-only change. XML chunks inherit their exact rPr contents;
 * no paragraph/body properties or original package parts are reconstructed. */
export function formatTextRange(object: SlideObject, start: number, end: number, style: DrawingCharacterStyle): void {
  requireValue(style.fontName === undefined || typeof style.fontName === 'string' && validXmlCharacters(style.fontName), '字体名称含无效 Unicode 或 XML 字符。')
  const reason = textRangeBlockedReason(object)
  requireValue(!reason, reason || '')
  requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= object.text.length, '请选择有效的非空文字范围。')
  requireValue(boundary(object.text, start) && boundary(object.text, end), '选区边界不能切开一个 Unicode 字符。')
  const body = materializeTextBody(object, undefined, undefined, false)
  assertRangeTextBody(body)
  requireValue(plainText(body) === object.text, '文字位置与当前正文不一致，原文档未改变。')
  const current = effectiveRichText(object) || object.text.split('\n').map(text => ({ style: { ...object.textStyle }, defaultRun: { style: { ...object.textStyle } }, runs: [{ text, style: { ...object.textStyle } }] }))
  requireValue(current.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') === object.text, '文字预览与正文位置不一致，原文档未改变。')
  let cursor = 0, changed = 0
  for (const [index, paragraph] of children(body, 'p').entries()) {
    if (index) cursor++
    let metadataIndex = 0
    for (const run of children(paragraph)) {
      if (run.localName === 'br') { cursor++; metadataIndex++; continue }
      if (run.localName !== 'r') continue
      const metadata = current[index]?.runs[metadataIndex++]
      requireValue(metadata, '文字片段与预览不一致，原文档未改变。')
      const content = child(run, 't')!, text = content.textContent || '', first = Math.max(0, start - cursor), last = Math.min(text.length, end - cursor)
      if (last > first) {
        const pieces = [[text.slice(0, first), false], [text.slice(first, last), true], [text.slice(last), false]] as const
        for (const [value, selected] of pieces) if (value) {
          const copy = run.cloneNode(true) as Element, copyText = child(copy, 't')!
          copyText.textContent = value
          if (/^\s|\s$/.test(value)) copyText.setAttributeNS(XML, 'xml:space', 'preserve')
          if (selected) {
            const properties = ensureRunProperties(copy)
            patchTextPaint(properties, style, metadata.style, body, paragraph, 'paintUnsupported' in metadata && !!metadata.paintUnsupported)
            const { color: _color, opacity: _opacity, ...attributes } = style
            patchRunProperties(properties, attributes); changed++
          }
          paragraph.insertBefore(copy, run)
        }
        run.remove()
      }
      cursor += text.length
    }
  }
  requireValue(changed > 0, '选区需要包含普通文字，不能只有段落分隔或换行标记。')
  requireValue(cursor === object.text.length, '文字位置校验失败，原文档未改变。')
  assertRangeTextBody(body)
  persistTextBody(object, body, formattedParagraphs(current, start, end, style))
}

/** Commit only a validated detached text body; character and paragraph tools
 * share the same durable XML and formatting rebase policy. */
export function persistTextBody(object: SlideObject, body: Element, paragraphs: RichParagraph[], spaceFirstLastParagraph = object.richText?.spaceFirstLastParagraph): void {
  assertRangeTextBody(body)
  requireValue(plainText(body) === object.text && paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') === object.text, '文字正文与排版数据不一致，原文档未改变。')
  const baseStyle: PresentationTextStyle = { ...object.textStyle }
  object.textBodyOverride = { xml: snapshotXml(body), text: object.text, baseStyle }
  object.richText = { sourceText: object.text, sourceStyle: { ...baseStyle }, paragraphs, ...(spaceFirstLastParagraph === undefined ? {} : { spaceFirstLastParagraph }) }
  delete object.textStyleOverrides
}
