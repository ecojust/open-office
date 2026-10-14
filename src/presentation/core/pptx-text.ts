import type { SlideObject } from './types.ts'
import { P, A, R, C, readXml, child, children, all, xmlEscape as esc, emu } from './pptx-common.ts'
import { patchPaintOpacity } from './paint-opacity.ts'
import { effectiveRichText } from './rich-text.ts'
import { underlineKind, strikeKind } from './text-decorations.ts'
import { patchTextHighlight, textHighlightXml } from './text-highlight.ts'

const NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:c="${C}"`
const CHARACTER_KEYS = ['fontName', 'fontSize', 'color', 'opacity', 'highlightColor', 'highlightOpacity', 'bold', 'italic', 'underline', 'underlineStyle', 'strike'] as const
export type DrawingCharacterStyle = Partial<Pick<SlideObject['textStyle'], typeof CHARACTER_KEYS[number]>>

function node(xml: string): Element { return readXml(`<p:root ${NS}>${xml}</p:root>`).documentElement.firstElementChild! }
function differs(object: SlideObject, previous: Partial<SlideObject> | undefined, key: keyof SlideObject) { return !previous || JSON.stringify(object[key]) !== JSON.stringify(previous[key]) }
function solid(value: string, opacity = 1) { return `<a:solidFill><a:srgbClr val="${esc((value || '000000').replace(/^#/, '').toUpperCase())}">${opacity !== 1 ? `<a:alpha val="${Math.round(opacity * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>` }

export function textParagraphs(text: string, object: SlideObject) {
  const style = object.textStyle, alignment = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[style.align]
  const properties = `lang="zh-CN" sz="${Math.round(style.fontSize * 100)}" b="${style.bold ? 1 : 0}" i="${style.italic ? 1 : 0}" u="${({ none: 'none', single: 'sng', double: 'dbl' } as const)[underlineKind(style)]}"${style.strike === undefined ? '' : ` strike="${({ none: 'noStrike', single: 'sngStrike', double: 'dblStrike' } as const)[strikeKind(style)]}"`}`
  const fonts = `<a:latin typeface="${esc(style.fontName)}"/><a:ea typeface="${esc(style.fontName)}"/><a:cs typeface="${esc(style.fontName)}"/>`
  const runProperties = `${solid(style.color, style.opacity)}${textHighlightXml(style)}${fonts}`
  // New text bodies need matching paragraph defaults and paragraph-end style;
  // otherwise empty paragraphs and later insertion revert to 18pt/theme fonts
  // when reopened, even though visible runs retained their chosen formatting.
  return text.split('\n').map(paragraph => `<a:p><a:pPr algn="${alignment}"><a:defRPr ${properties}>${runProperties}</a:defRPr></a:pPr><a:r><a:rPr ${properties}>${runProperties}</a:rPr><a:t xml:space="preserve">${esc(paragraph)}</a:t></a:r><a:endParaRPr ${properties}>${runProperties}</a:endParaRPr></a:p>`).join('')
}
function bodyProperties(object: SlideObject) {
  const layout = object.textLayout, insets = layout?.insets || { left: 1.3, right: 1.3, top: 1.3, bottom: 1.3 }
  return `<a:bodyPr wrap="${layout?.wrap === false ? 'none' : 'square'}" anchor="${({ top: 't', middle: 'ctr', bottom: 'b' } as const)[layout?.verticalAlign || 'top']}" lIns="${emu(insets.left)}" rIns="${emu(insets.right)}" tIns="${emu(insets.top)}" bIns="${emu(insets.bottom)}" rot="${Math.round((layout?.rotation || 0) * 60000)}"/>`
}
export function generatedTextBody(object: SlideObject, prefix = 'p', text = object.text) { return `<${prefix}:txBody>${bodyProperties(object)}<a:lstStyle/>${textParagraphs(text, object)}</${prefix}:txBody>` }

export function plainText(parent: Element | undefined) {
  return parent ? all(parent, 'p').map(paragraph => children(paragraph).map(run => run.localName === 'br' ? '\n' : all(run, 't').map(t => t.textContent || '').join('')).join('')).join('\n') : ''
}

/** Patch only explicitly supplied modeled character properties. Unmodeled
 * attributes, links, effects and extension elements remain on the original rPr. */
export function patchRunProperties(property: Element, style: DrawingCharacterStyle) {
  if (style.fontSize !== undefined) property.setAttribute('sz', String(Math.round(style.fontSize * 100)))
  if (style.bold !== undefined) property.setAttribute('b', style.bold ? '1' : '0')
  if (style.italic !== undefined) property.setAttribute('i', style.italic ? '1' : '0')
  if (style.underline !== undefined || style.underlineStyle !== undefined) property.setAttribute('u', ({ none: 'none', single: 'sng', double: 'dbl' } as const)[underlineKind(style)])
  if (style.strike !== undefined) property.setAttribute('strike', ({ none: 'noStrike', single: 'sngStrike', double: 'dblStrike' } as const)[strikeKind(style)])
  patchTextHighlight(property, style)
  if (style.color !== undefined) {
    for (const fill of children(property)) if (['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(fill.localName)) fill.remove()
    property.insertBefore(property.ownerDocument.importNode(node(solid(style.color, style.opacity)), true), children(property).find(element => element.localName !== 'ln') || null)
  }
  else if (style.opacity !== undefined && !patchPaintOpacity(property, 'fill', style.opacity)) throw Error('文字透明度需要明确的实色来源；请通过受限文字格式操作修改。')
  if (style.fontName !== undefined) for (const [fontName, successors] of [['latin', ['ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']], ['ea', ['cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']], ['cs', ['sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']]] as const) {
    let font = child(property, fontName)
    if (!font) { font = property.ownerDocument.createElementNS(A, `a:${fontName}`); property.insertBefore(font, children(property).find(element => (successors as readonly string[]).includes(element.localName)) || null) }
    font.setAttribute('typeface', style.fontName)
  }
}

/** Keep paragraph/run structure, links, fields and all unmodeled formatting.
 * The editor changes only the explicitly modified character attributes. */
function patchTextStyle(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  const style = object.textStyle, before = previous?.textStyle
  const changed = (key: keyof SlideObject['textStyle']) => Object.hasOwn(object.textStyleOverrides || {}, key) || !before || style[key] !== before[key]
  const paragraphs = children(body, 'p')
  for (const paragraph of paragraphs) {
    let properties = child(paragraph, 'pPr')
    if (!properties) { properties = paragraph.ownerDocument.createElementNS(A, 'a:pPr'); paragraph.insertBefore(properties, paragraph.firstChild) }
    if (changed('align')) properties.setAttribute('algn', { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[style.align])
    if (!child(properties, 'defRPr')) {
      const defaults = properties.ownerDocument.createElementNS(A, 'a:defRPr'); properties.insertBefore(defaults, child(properties, 'extLst') || null)
    }
    for (const run of children(paragraph).filter(element => ['r', 'fld', 'br'].includes(element.localName))) if (!child(run, 'rPr')) {
      const properties = run.ownerDocument.createElementNS(A, 'a:rPr'); run.insertBefore(properties, run.firstChild)
    }
    if (!child(paragraph, 'endParaRPr')) paragraph.appendChild(paragraph.ownerDocument.importNode(node('<a:endParaRPr/>'), true))
  }
  const patch = Object.fromEntries(CHARACTER_KEYS.filter(changed).map(key => [key, style[key]])) as DrawingCharacterStyle
  const rich = patch.color !== undefined ? effectiveRichText(object) : undefined
  if (rich) {
    if (rich.length !== paragraphs.length) throw Error('文字段落与颜色数据不一致，原文件未改变。')
    const { color: _color, opacity: _opacity, ...attributes } = patch
    for (const property of [...all(body, 'rPr'), ...all(body, 'defRPr'), ...all(body, 'endParaRPr')]) patchRunProperties(property, attributes)
    for (const [index, paragraph] of paragraphs.entries()) {
      const metadata = rich[index]!, runs = children(paragraph).filter(element => ['r', 'fld', 'br'].includes(element.localName))
      if (runs.length !== metadata.runs.length) throw Error('文字片段与颜色数据不一致，原文件未改变。')
      const paint = (property: Element, alpha: number | undefined) => patchRunProperties(property, { color: patch.color, opacity: patch.opacity ?? alpha ?? 1 })
      for (const [runIndex, run] of runs.entries()) paint(child(run, 'rPr')!, metadata.runs[runIndex]!.style.opacity)
      paint(child(child(paragraph, 'pPr'), 'defRPr')!, metadata.defaultRun ? metadata.defaultRun.style.opacity : metadata.style.opacity)
      paint(child(paragraph, 'endParaRPr')!, metadata.style.opacity)
    }
  } else for (const property of [...all(body, 'rPr'), ...all(body, 'defRPr'), ...all(body, 'endParaRPr')]) patchRunProperties(property, patch)
}

function patchTextLayout(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined) {
  if (!differs(object, previous, 'textLayout')) return
  const generated = node(bodyProperties(object)), existing = child(body, 'bodyPr')
  if (!existing) { body.insertBefore(body.ownerDocument.importNode(generated, true), body.firstChild); return }
  // bodyPr may also contain vertical text, columns, fitting and 3D settings.
  // Updating the modeled fields never replaces those unrelated settings.
  const before = previous?.textLayout, current = object.textLayout
  const changed: Record<string, boolean> = {
    anchor: !before || current?.verticalAlign !== before.verticalAlign,
    wrap: !before || current?.wrap !== before.wrap,
    rot: !before || current?.rotation !== before.rotation,
    lIns: !before || current?.insets?.left !== before.insets?.left,
    rIns: !before || current?.insets?.right !== before.insets?.right,
    tIns: !before || current?.insets?.top !== before.insets?.top,
    bIns: !before || current?.insets?.bottom !== before.insets?.bottom,
  }
  for (const attribute of Array.from(generated.attributes)) if (!attribute.namespaceURI && changed[attribute.name]) existing.setAttribute(attribute.name, attribute.value)
}

export function patchDrawingText(body: Element, object: SlideObject, previous: Partial<SlideObject> | undefined, text = object.text, { layout = true }: { layout?: boolean } = {}) {
  if (plainText(body) !== text) {
    const originals = children(body, 'p'), paragraphs = text.split('\n')
    for (const paragraph of originals) paragraph.remove()
    paragraphs.forEach((value, index) => {
      const original = originals[Math.min(index, originals.length - 1)], paragraph = original ? original.cloneNode(true) as Element : node('<a:p/>')
      // Retain every run when the paragraph's text has not changed. Edited
      // plain text uses its paragraph and first run formatting as a template.
      const oldText = original ? children(original).map(run => run.localName === 'br' ? '\n' : all(run, 't').map(element => element.textContent || '').join('')).join('') : undefined
      if (oldText !== value) {
        const firstRun = children(paragraph).find(run => ['r', 'fld', 'br'].includes(run.localName))
        const runProperties = child(firstRun, 'rPr')?.cloneNode(true) as Element | undefined
        for (const run of children(paragraph)) if (['r', 'fld', 'br'].includes(run.localName)) run.remove()
        const run = paragraph.ownerDocument.createElementNS(A, 'a:r')
        if (runProperties) run.appendChild(runProperties)
        const content = paragraph.ownerDocument.createElementNS(A, 'a:t'); content.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); content.textContent = value; run.appendChild(content)
        paragraph.insertBefore(run, child(paragraph, 'endParaRPr') || null)
      }
      body.appendChild(body.ownerDocument.importNode(paragraph, true))
    })
  }
  if (differs(object, previous, 'textStyle') || differs(object, previous, 'textStyleOverrides')) patchTextStyle(body, object, previous)
  if (layout) patchTextLayout(body, object, previous)
}
