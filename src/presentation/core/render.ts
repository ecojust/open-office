import type { PresentationModel, SlideModel } from './types'
import { buildSlideScene, finite, numberText as n } from './scene.ts'
import type { SceneNode, SceneOptions, ScenePaint } from './scene.ts'

export interface SlideSvgOptions extends SceneOptions { width?: number; height?: number }
const escapeXml = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
const paint = (node: ScenePaint) => `fill="${node.fill ?? 'none'}" stroke="${node.stroke ?? 'none'}" stroke-width="${n(node.strokeWidth)}"`

/** Contains no source XML, CSS, event handlers, foreignObject, remote images or scripts. */
export function slideSvg(model: PresentationModel, slide: SlideModel, options: SlideSvgOptions = {}): string {
  let clipIndex = 0
  const render = (node: SceneNode): string => {
    if (node.kind === 'group') {
      const rotation = node.rotation ? ` transform="rotate(${n(node.rotation)} ${n(node.x + node.width / 2)} ${n(node.y + node.height / 2)})"` : ''
      const identity = node.id ? ` data-object-id="${escapeXml(node.id)}"${node.inherited ? ' data-inherited="true"' : ''}` : ''
      const opacity = node.opacity === undefined || node.opacity === 1 ? '' : ` opacity="${n(node.opacity)}"`
      const content = node.children.map(render).join('')
      if (!node.clip) return `<g${identity}${rotation}${opacity}>${content}</g>`
      // An SVG viewport provides local clipping without document-global fragment IDs.
      // Several slide thumbnails may live in the same HTML document.
      clipIndex++
      const b = node.clip
      return `<g${identity}${rotation}${opacity}><svg x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" viewBox="${n(b.x)} ${n(b.y)} ${n(b.width)} ${n(b.height)}" overflow="hidden" data-text-clip="${clipIndex}">${content}</svg></g>`
    }
    if (node.kind === 'rect') return `<rect x="${n(node.x)}" y="${n(node.y)}" width="${n(node.width)}" height="${n(node.height)}" ${paint(node)}/>`
    if (node.kind === 'ellipse') return `<ellipse cx="${n(node.x + node.width / 2)}" cy="${n(node.y + node.height / 2)}" rx="${n(node.width / 2)}" ry="${n(node.height / 2)}" ${paint(node)}/>`
    if (node.kind === 'path') return `<path d="${node.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ')}${node.closed ? ' Z' : ''}" ${paint(node)}/>`
    if (node.kind === 'image') return `<image x="${n(node.x)}" y="${n(node.y)}" width="${n(node.width)}" height="${n(node.height)}" href="${escapeXml(node.dataUrl)}" preserveAspectRatio="none"/>`
    return `<text x="${n(node.x)}" y="${n(node.y)}" font-family="${escapeXml(node.family)}, Noto Sans CJK SC, sans-serif" font-size="${n(node.size)}" font-weight="${node.bold ? '700' : '400'}" font-style="${node.italic ? 'italic' : 'normal'}" text-decoration="${node.underline ? 'underline' : 'none'}" fill="${node.color}" xml:space="preserve">${escapeXml(node.text)}</text>`
  }
  const width = Math.max(1, finite(model.width, 254)), height = Math.max(1, finite(model.height, 142.875))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width ? n(Math.max(1, finite(options.width))) : '100%'}" height="${options.height ? n(Math.max(1, finite(options.height))) : '100%'}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${escapeXml(slide.name || '幻灯片')}" overflow="hidden">${buildSlideScene(model, slide, options).map(render).join('')}</svg>`
}
