import type { PresentationTextStyle } from '../types'
import { A, child, children } from './pptx-common.ts'
import { patchPaintOpacity } from './paint-opacity.ts'

type PaintPatch = Pick<Partial<PresentationTextStyle>, 'color' | 'opacity'>
const paintNames = new Set(['solidFill', 'noFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'])
function ownPaint(properties: Element | undefined): Element | undefined {
  const paints = children(properties).filter(node => paintNames.has(node.localName))
  if (paints.length > 1 || paints.some(node => node.namespaceURI !== A)) throw Error('文字填充结构有歧义，请先选择明确的文字颜色。')
  return paints[0]
}
function localPaint(body: Element, paragraph: Element, properties: Element): Element | undefined {
  const pPr = child(paragraph, 'pPr'), level = Number(pPr?.getAttribute('lvl') || 0)
  if (!Number.isInteger(level) || level < 0 || level > 8) throw Error('文字层级无效，无法安全修改透明度。')
  for (const source of [properties, child(pPr, 'defRPr'), child(child(child(body, 'lstStyle'), `lvl${level + 1}pPr`), 'defRPr')]) {
    const paint = ownPaint(source); if (paint) return paint
  }
}

/** Detached body only. Clone a proven body-local donor; never guess an external
 * master/fontRef paint from its resolved RGB preview. */
export function patchTextPaint(properties: Element, patch: PaintPatch, effective: PresentationTextStyle, body: Element, paragraph: Element, unsupported = false): void {
  if (patch.color === undefined && patch.opacity === undefined) return
  const opacity = patch.opacity ?? effective.opacity ?? 1
  if (patch.color !== undefined) {
    for (const node of children(properties)) if (paintNames.has(node.localName)) node.remove()
    const solid = properties.ownerDocument.createElementNS(A, 'a:solidFill'), color = properties.ownerDocument.createElementNS(A, 'a:srgbClr')
    color.setAttribute('val', patch.color.replace(/^#/, '').toUpperCase()); solid.append(color)
    if (opacity !== 1) { const alpha = properties.ownerDocument.createElementNS(A, 'a:alpha'); alpha.setAttribute('val', String(Math.round(opacity * 100000))); color.append(alpha) }
    properties.insertBefore(solid, children(properties).find(node => node.localName !== 'ln') || null)
    return
  }
  if (unsupported) throw Error('这段文字的填充未完整解析，请先选择明确的文字颜色。')
  const source = localPaint(body, paragraph, properties)
  if (!source || source.localName !== 'solidFill') throw Error('这段文字使用外部继承或高级填充，请先选择明确的文字颜色，再设置不透明度。')
  const own = ownPaint(properties)
  if (!own) properties.insertBefore(properties.ownerDocument.importNode(source, true), children(properties).find(node => node.localName !== 'ln') || null)
  if (!patchPaintOpacity(properties, 'fill', opacity)) throw Error('文字颜色结构或变换数量不支持追加透明度，请先选择明确的文字颜色。')
}

export function ensureRunProperties(run: Element): Element {
  let properties = child(run, 'rPr')
  if (!properties) { properties = run.ownerDocument.createElementNS(A, 'a:rPr'); run.insertBefore(properties, run.firstChild) }
  return properties
}
