import type { SlideObject } from './types'
import { A, P, children, readXml } from './pptx-common.ts'

type PaintKind = 'fill' | 'line'
const alphaNames = new Set(['alpha', 'alphaMod', 'alphaOff'])
const direct = (node: Element | undefined, namespace: string, name: string) => children(node).filter(child => child.namespaceURI === namespace && child.localName === name)
function solidColor(properties: Element, kind: PaintKind): Element | undefined {
  const lines = children(properties).filter(node => node.localName === 'ln')
  if (kind === 'line' && (lines.length !== 1 || lines[0]!.namespaceURI !== A)) return
  const holder = kind === 'line' ? lines[0] : properties
  const fills = children(holder).filter(node => /^(solidFill|noFill|gradFill|pattFill|blipFill|grpFill)$/.test(node.localName))
  if (fills.length !== 1 || fills[0]!.namespaceURI !== A || fills[0]!.localName !== 'solidFill') return
  const colors = children(fills[0])
  const color = colors.length === 1 && colors[0]!.namespaceURI === A && ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr'].includes(colors[0]!.localName) ? colors[0] : undefined
  // The shared color resolver accepts at most 32 transforms. Leave room for
  // the absolute alpha before offering an edit; never export a broken chain.
  return color && children(color).filter(node => node.namespaceURI !== A || !alphaNames.has(node.localName)).length < 32 ? color : undefined
}

export function paintOpacityEditable(object: SlideObject, kind: PaintKind, explicitlyChangedColor = false): boolean {
  if (!object.sourceXml || explicitlyChangedColor || (kind === 'fill' ? object.fillColorOverride : object.lineColorOverride)) return true
  const key = kind === 'fill' ? 'fillColor' : 'lineColor'
  try {
    if (object.sourceFingerprint && JSON.parse(object.sourceFingerprint)[key] !== object[key]) return true
    if (object.sourceXml.length > 2000000) return false
    const source = readXml(object.sourceXml).documentElement, properties = direct(source, P, 'spPr')
    return properties.length === 1 && !!solidColor(properties[0]!, kind)
  } catch { return false }
}

/** An opacity-only edit keeps the original base color and non-alpha transforms.
 * The final absolute alpha replaces all previous alpha operations, including a
 * theme base alpha, without baking the theme into a preview RGB color. */
export function patchPaintOpacity(properties: Element, kind: PaintKind, opacity: number): boolean {
  const color = solidColor(properties, kind)
  if (!color) return false
  for (const node of children(color)) if (node.namespaceURI === A && alphaNames.has(node.localName)) node.remove()
  const alpha = color.ownerDocument.createElementNS(A, 'a:alpha')
  alpha.setAttribute('val', String(Math.round(opacity * 100000))); color.append(alpha)
  return true
}
