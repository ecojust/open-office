import type { SlideObject } from './types'
import type { RichParagraph, RichRun } from './rich-text'
import { effectiveRichText } from './rich-text.ts'
import { A, P, readXml, child, children } from './pptx-common.ts'
import { plainText } from './pptx-text.ts'
import { assertRangeTextBody, materializeTextBody, persistTextBody, textRangeBlockedReason, validateText } from './text-range-format.ts'
import { textEditSplices } from './text-diff.ts'
import type { TextSplice } from './text-diff'

const XML = 'http://www.w3.org/XML/1998/namespace', XMLNS = 'http://www.w3.org/2000/xmlns/'
function requireValue(value: unknown, message: string): asserts value { if (!value) throw Error(message) }
function wording(message: string) { return message.replaceAll('选区文字格式', '正文编辑').replaceAll('选区格式', '正文编辑') }
function emptyImportedShape(object: SlideObject): boolean {
  if (object.locked || object.hasAnimation || !object.capabilities.text || !['rectangle', 'ellipse', 'text'].includes(object.type)
    || object.text !== '' || object.textBodyOverride || !object.sourceXml || object.sourceXml.length > 2000000) return false
  if (object.richText && (object.richText.sourceText !== '' || object.richText.paragraphs.some(paragraph => paragraph.runs.some(run => run.text !== '')))) return false
  try {
    const source = readXml(object.sourceXml).documentElement
    return source.namespaceURI === P && source.localName === 'sp'
      && !Array.from(source.getElementsByTagName('*')).some(element => element.localName === 'txBody')
  } catch { return false }
}

/** Body edits use the same conservative XML boundary as character formatting.
 * Fields, hyperlinks, animation bindings and unique extension identities are
 * not silently converted to plain runs by a textarea commit. */
export function textContentBlockedReason(object: SlideObject): string | undefined {
  // A genuine empty ordinary shape has no text body yet. This differs from a
  // malformed/unparsed body and permits its first text to be generated safely.
  if (emptyImportedShape(object)) return
  const reason = textRangeBlockedReason(object)
  return reason ? wording(reason) : undefined
}

function signature(element: Element | undefined): string {
  const value = (node: Element): unknown => [node.namespaceURI, node.localName,
    Array.from(node.attributes).filter(attribute => attribute.namespaceURI !== XMLNS).map(attribute => [attribute.namespaceURI, attribute.localName, attribute.value]).sort(),
    Array.from(node.childNodes).map(child => child.nodeType === 1 ? value(child as Element) : [child.nodeType, child.nodeName, child.nodeValue])]
  return element ? JSON.stringify(value(element)) : ''
}
function paragraphSignature(paragraph: RichParagraph) {
  const { runs: _, ...properties } = paragraph
  return JSON.stringify(properties)
}

/** Adding/removing paragraph boundaries remains available when every original
 * paragraph is demonstrably the same one-run template. Mixed runs, manual
 * breaks and different paragraph properties require structural editing which
 * this plain-text input cannot express reliably. */
function uniformTemplate(body: Element, rich: RichParagraph[]): boolean {
  const paragraphs = children(body, 'p')
  const template = paragraphs[0]!, firstRich = rich[0]!
  const runs = paragraphs.flatMap(paragraph => children(paragraph, 'r'))
  const runSignature = signature(child(runs[0], 'rPr'))
  const templateRun = rich.flatMap(paragraph => paragraph.runs)[0]
  return paragraphs.every((paragraph, index) => {
    const skeleton = paragraph.cloneNode(true) as Element
    for (const run of children(skeleton, 'r')) run.remove()
    const reference = template.cloneNode(true) as Element
    for (const run of children(reference, 'r')) run.remove()
    return children(paragraph, 'r').length <= 1 && !children(paragraph, 'br').length
      && children(paragraph, 'r').every(run => !(child(run, 't')?.textContent || '').includes('\n') && signature(child(run, 'rPr')) === runSignature)
      && signature(skeleton) === signature(reference)
      && paragraphSignature(rich[index]!) === paragraphSignature(firstRich)
      && rich[index]!.runs.every(run => !run.kind && JSON.stringify({ ...run, text: '' }) === JSON.stringify({ ...templateRun, text: '' }))
  })
}

function setRunText(run: Element, value: string) {
  const content = child(run, 't')!
  content.textContent = value
  if (/^\s|\s$/.test(value)) content.setAttributeNS(XML, 'xml:space', 'preserve')
}
function emptyRun(paragraph: Element, text: string): Element {
  const run = paragraph.ownerDocument.createElementNS(A, 'a:r'), content = paragraph.ownerDocument.createElementNS(A, 'a:t')
  content.textContent = text; run.appendChild(content)
  if (/^\s|\s$/.test(text)) content.setAttributeNS(XML, 'xml:space', 'preserve')
  return run
}
function rebuildUniform(body: Element, rich: RichParagraph[], text: string): RichParagraph[] {
  const originals = children(body, 'p'), template = originals[0]!, originalRun = originals.flatMap(paragraph => children(paragraph, 'r'))[0]
  const metadata = rich[0]!, donor = rich.flatMap(paragraph => paragraph.runs)[0] || metadata.defaultRun || { style: metadata.style, baseline: metadata.baseline }
  for (const paragraph of originals) paragraph.remove()
  return text.split('\n').map(value => {
    const paragraph = template.cloneNode(true) as Element
    for (const run of children(paragraph, 'r')) run.remove()
    const run = originalRun ? originalRun.cloneNode(true) as Element : emptyRun(paragraph, '')
    setRunText(run, value); paragraph.insertBefore(run, child(paragraph, 'endParaRPr') || null); body.appendChild(paragraph)
    return { ...metadata, runs: [{ ...donor, style: { ...donor.style }, text: value }] }
  })
}

type Item = { element: Element; run: RichRun; paragraph: Element; paragraphIndex: number; start: number; end: number; edits: TextSplice[] }
function spliceRuns(body: Element, rich: RichParagraph[], oldText: string, edits: TextSplice[]): RichParagraph[] {
  const output = rich.map(paragraph => ({ ...paragraph, runs: paragraph.runs.map(run => ({ ...run, style: { ...run.style } })) }))
  const paragraphs = children(body, 'p'), items: Item[] = [], bounds: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) cursor++
    const start = cursor, runs = children(paragraph).filter(element => ['r', 'br'].includes(element.localName))
    requireValue(runs.length === output[index]!.runs.length, '文字节点与排版数据不一致，原文档未改变。')
    for (const [runIndex, element] of runs.entries()) {
      const run = output[index]!.runs[runIndex]!, text = element.localName === 'br' ? '\n' : child(element, 't')!.textContent || ''
      requireValue(run.text === text && (element.localName === 'br') === (run.kind === 'break'), '文字节点与排版数据不一致，原文档未改变。')
      items.push({ element, run, paragraph, paragraphIndex: index, start: cursor, end: cursor + text.length, edits: [] }); cursor += text.length
    }
    bounds.push({ start, end: cursor })
  }
  requireValue(cursor === oldText.length, '正文位置校验失败，原文档未改变。')
  // Bound even adversarial many-run/many-edit documents. Failure happens on a
  // detached body, before persistence; there is no destructive fallback.
  requireValue((items.length + paragraphs.length + edits.length) * edits.length <= 2000000, '文字片段或修改位置过多，请分几次修改；原文档未改变。')
  for (const edit of edits) {
    const ordinary = items.filter(item => !item.run.kind)
    for (const item of ordinary) {
      const first = Math.max(edit.start, item.start), last = Math.min(edit.end, item.end)
      if (last > first) item.edits.push({ start: first - item.start, end: last - item.start, text: '' })
    }
    if (!edit.text) continue
    const lineStart = edit.start === 0 ? 0 : oldText.lastIndexOf('\n', edit.start - 1) + 1
    const nextLf = oldText.indexOf('\n', edit.start), lineEnd = nextLf < 0 ? oldText.length : nextLf
    // Product-defined insertion affinity: replacement uses its first removed
    // character's run. Zero-width insertion uses the left run in this line,
    // then the right run at line start. A textarea has no native active-run ID.
    let donor = edit.end > edit.start ? ordinary.find(item => item.start <= edit.start && item.end > edit.start) : undefined
    if (!donor) donor = ordinary.find(item => item.start < edit.start && item.end > edit.start)
    if (!donor && lineStart === lineEnd) donor = ordinary.find(item => item.start <= edit.start && item.end >= edit.start && item.run.text.includes('\n'))
    if (!donor && edit.start > lineStart) donor = ordinary.find(item => item.start < edit.start && item.end >= edit.start)
    if (!donor && edit.start < lineEnd) donor = ordinary.find(item => item.start <= edit.start && item.end > edit.start)
    if (!donor) donor = ordinary.find(item => item.start === edit.start && item.end === edit.start)
    if (!donor) {
      const paragraphIndex = bounds.findIndex(bound => bound.start <= edit.start && bound.end >= edit.start)
      requireValue(paragraphIndex >= 0, '插入位置不属于可编辑段落，原文档未改变。')
      const paragraph = paragraphs[paragraphIndex]!, metadata = output[paragraphIndex]!
      const nextItem = items.find(item => item.paragraphIndex === paragraphIndex && item.start >= edit.start)
      const element = emptyRun(paragraph, '')
      paragraph.insertBefore(element, nextItem?.element || child(paragraph, 'endParaRPr') || null)
      const template = metadata.defaultRun || { style: metadata.style, baseline: metadata.baseline }
      const run: RichRun = { ...template, style: { ...template.style }, text: '' }
      const index = nextItem ? metadata.runs.indexOf(nextItem.run) : metadata.runs.length
      metadata.runs.splice(index, 0, run)
      donor = { element, run, paragraph, paragraphIndex, start: edit.start, end: edit.start, edits: [] }; items.push(donor)
    }
    const offset = edit.start - donor.start, deletion = donor.edits.find(change => change.start === offset)
    if (deletion) deletion.text = edit.text
    else donor.edits.push({ start: offset, end: offset, text: edit.text })
  }
  for (const item of items) if (item.edits.length) {
    let text = '', position = 0
    for (const edit of item.edits.sort((a, b) => a.start - b.start)) {
      requireValue(edit.start >= position, '文字修改范围重叠，原文档未改变。')
      text += item.run.text.slice(position, edit.start) + edit.text; position = edit.end
    }
    text += item.run.text.slice(position)
    setRunText(item.element, text); item.run.text = text
  }
  return output
}

/** Apply a committed textarea edit once, preserving all equal character spans
 * and every unaffected run's unmodeled properties. XML and display metadata are
 * committed together; later edits never replay offsets against imported text. */
export function replaceTextContent(object: SlideObject, text: string): void {
  if (text === object.text) return
  requireValue(!object.locked && object.capabilities.text && !['table', 'chart', 'group', 'image', 'unknown'].includes(object.type), '此对象不支持正文编辑。')
  try { validateText(text) } catch (error) { throw Error(wording(error instanceof Error ? error.message : String(error))) }
  // New, uniformly styled shapes have no imported structure to preserve and
  // remain usable in the non-DOM model API. Their native body is generated on
  // export using the selected complete uniform style.
  if (!object.sourceXml && !object.richText && !object.textBodyOverride) { object.text = text; return }
  const reason = textContentBlockedReason(object); requireValue(!reason, reason || '')
  const oldText = object.text, body = materializeTextBody(object, undefined, undefined, false)
  assertRangeTextBody(body)
  const rich = effectiveRichText(object) || (emptyImportedShape(object) ? [{ style: { ...object.textStyle }, defaultRun: { style: { ...object.textStyle } }, runs: [{ text: '', style: { ...object.textStyle } }] }] : undefined)
  requireValue(rich && rich.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') === oldText && plainText(body) === oldText, '正文与排版数据不一致，原文档未改变。')
  const paragraphs = replaceDrawingTextContent(body, rich, oldText, text)
  object.text = text
  persistTextBody(object, body, paragraphs)
}

/** Shared detached-body transformation. Callers validate the shape/cell XML
 * boundary and atomically persist the matching XML and display metadata. */
export function replaceDrawingTextContent(body: Element, rich: RichParagraph[], oldText: string, text: string): RichParagraph[] {
  validateText(text)
  requireValue(rich.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') === oldText && plainText(body) === oldText, '正文与排版数据不一致，原文档未改变。')
  let paragraphs: RichParagraph[]
  if (oldText.split('\n').length !== text.split('\n').length) {
    requireValue(uniformTemplate(body, rich), '这段文字包含独立格式或手动换行，暂不能增删换行；可在原有行内修改，原文档未改变。')
    paragraphs = rebuildUniform(body, rich, text)
  } else paragraphs = spliceRuns(body, rich, oldText, textEditSplices(oldText, text))
  requireValue(plainText(body) === text && paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') === text, '正文与排版数据不一致，原文档未改变。')
  return paragraphs
}
