import type { PresentationTextStyle } from '../types'
import { A, children } from './pptx-common.ts'

type HighlightStyle = Pick<Partial<PresentationTextStyle>, 'highlightColor' | 'highlightOpacity'>

/** Null and zero alpha are visibly cleared; absence is still inheritance. */
export function textHighlightPaint(style: HighlightStyle): { color: string; opacity: number } | undefined {
  if (!style.highlightColor || !/^#[0-9a-f]{6}$/i.test(style.highlightColor)) return
  const opacity = style.highlightOpacity ?? 1
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return
  return { color: style.highlightColor, opacity }
}

/** CT_Color has no noFill value. A transparent explicit color overrides an
 * inherited marker; removing highlight would reveal the inherited marker. */
export function patchTextHighlight(properties: Element, style: HighlightStyle): void {
  if (style.highlightColor === undefined) return
  for (const highlight of children(properties, 'highlight')) highlight.remove()
  const paint = textHighlightPaint(style), highlight = properties.ownerDocument.createElementNS(A, 'a:highlight')
  const color = properties.ownerDocument.createElementNS(A, 'a:srgbClr')
  color.setAttribute('val', (paint?.color || '#000000').slice(1).toUpperCase())
  const opacity = paint?.opacity ?? 0
  if (opacity !== 1) {
    const alpha = properties.ownerDocument.createElementNS(A, 'a:alpha'); alpha.setAttribute('val', String(Math.round(opacity * 100000))); color.append(alpha)
  }
  highlight.append(color)
  const successors = ['uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']
  properties.insertBefore(highlight, children(properties).find(node => successors.includes(node.localName)) || null)
}

export function textHighlightXml(style: HighlightStyle): string {
  if (style.highlightColor === undefined) return ''
  const paint = textHighlightPaint(style), opacity = paint?.opacity ?? 0
  return `<a:highlight><a:srgbClr val="${(paint?.color || '#000000').slice(1).toUpperCase()}">${opacity === 1 ? '' : `<a:alpha val="${Math.round(opacity * 100000)}"/>`}</a:srgbClr></a:highlight>`
}
