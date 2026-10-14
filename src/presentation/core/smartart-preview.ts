import type { PresentationTextStyle } from '../types'
import { all, child, children, xmlEscape as escape } from './pptx-common'
import { safeImageDataUrl } from './scene'
import { applyDrawingColorTransforms, drawingColorModifiers } from './color-transforms'
import type { ResolvedDrawingColor } from './color-transforms'

const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram'
const num = (node: Element | undefined, key: string, fallback = 0) => {
  const value = node?.getAttribute(key)
  const result = value == null ? fallback : Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > 1e12) throw new Error('SmartArt 缓存坐标无效。')
  return result
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const n = (value: number) => String(Math.round(value * 100000) / 100000)
const box = (xfrm: Element | undefined) => ({ x: num(child(xfrm, 'off'), 'x') / 36000, y: num(child(xfrm, 'off'), 'y') / 36000,
  w: num(child(xfrm, 'ext'), 'cx') / 36000, h: num(child(xfrm, 'ext'), 'cy') / 36000, rot: num(xfrm, 'rot') / 60000 })
type Box = ReturnType<typeof box>
const rotate = (b: Box) => b.rot ? `rotate(${n(b.rot)} ${n(b.x + b.w / 2)} ${n(b.y + b.h / 2)})` : ''

export interface SmartArtPreviewReader {
  color(node: Element | undefined): string | null
  resolvedColor?(node: Element | undefined): ResolvedDrawingColor | null
  textStyle(shape: Element): PresentationTextStyle
  image(blip: Element): string | undefined
}

// The common bounded color pipeline keeps alpha independent of shape/text.
// The cache already contains layout geometry; this does not generate SmartArt layouts.
function cachedColor(node: Element | undefined, reader: SmartArtPreviewReader): { hex: string; alpha: number } {
  const names = ['srgbClr', 'schemeClr', 'scrgbClr', 'sysClr', 'prstClr'], sources = !node ? [] : names.includes(node.localName) ? [node] : children(node).filter(item => names.includes(item.localName))
  if (sources.length !== 1 || node && !names.includes(node.localName) && children(node).length !== 1) throw Error('SmartArt 缓存颜色节点缺失或不明确。')
  const source = sources[0]
  if (!source) throw Error('SmartArt 缓存颜色缺少可解析的基色。')
  if (source.namespaceURI !== 'http://schemas.openxmlformats.org/drawingml/2006/main') throw Error('SmartArt 缓存颜色命名空间无效。')
  if (source.localName === 'scrgbClr') return applyDrawingColorTransforms({ space: 'scRgb', components: [source.getAttribute('r') || '', source.getAttribute('g') || '', source.getAttribute('b') || ''] }, drawingColorModifiers(source))
  const bare = source.cloneNode(false) as Element
  // Resolve the base/theme color once, then apply this node's transforms once.
  const resolved = reader.resolvedColor?.(bare)
  if (reader.resolvedColor && !resolved) throw Error('SmartArt 缓存基色或主题色无法解析。')
  const base = resolved ? { space: 'sRgb' as const, components: resolved.rgb, alpha: resolved.alpha } : reader.color(bare)
  if (!base) throw Error('SmartArt 缓存基色或主题色无法解析。')
  return applyDrawingColorTransforms(base, drawingColorModifiers(source))
}

/** Produce only our own SVG elements/attributes; never insert imported XML into DOM. */
export function smartArtCacheSvg(drawing: Document, width: number, height: number, reader: SmartArtPreviewReader): string {
  if (drawing.documentElement.namespaceURI !== DSP || drawing.documentElement.localName !== 'drawing') throw new Error('SmartArt 绘图缓存格式不支持。')
  if (!(width > 0 && height > 0) || width > 10000 || height > 10000) throw new Error('SmartArt 预览尺寸无效。')
  const definitions: string[] = [], resources = new Set<string>()
  let serial = 0, count = 0, imageBytes = 0
  function shapeGeometry(shape: Element, b: Box): string {
    const properties = child(shape, 'spPr'), geom = child(properties, 'prstGeom'), preset = geom?.getAttribute('prst')
    if (child(properties, 'custGeom')) throw new Error('SmartArt 缓存包含暂不支持的自定义路径。')
    if (preset === 'ellipse') return `<ellipse cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" rx="${n(b.w / 2)}" ry="${n(b.h / 2)}"/>`
    if (preset === 'hexagon') {
      const adjustment = children(child(geom, 'avLst'), 'gd').find(item => item.getAttribute('name') === 'adj')?.getAttribute('fmla')?.match(/^val\s+(-?\d+)$/)?.[1]
      const inset = Math.min(b.w / 2, Math.min(b.w, b.h) * Math.max(0, Number(adjustment ?? 25000)) / 100000)
      return `<polygon points="${[[b.x + inset, b.y], [b.x + b.w - inset, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w - inset, b.y + b.h], [b.x + inset, b.y + b.h], [b.x, b.y + b.h / 2]].map(p => p.map(n).join(',')).join(' ')}"/>`
    }
    if (shape.localName === 'cxnSp' || preset === 'line') return `<path d="M${n(b.x)} ${n(b.y)} L${n(b.x + b.w)} ${n(b.y + b.h)}"/>`
    if (preset && !['rect', 'roundRect'].includes(preset)) throw new Error(`SmartArt 缓存形状 ${preset} 暂不支持预览。`)
    return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"${preset === 'roundRect' ? ` rx="${n(Math.min(b.w, b.h) * .1667)}"` : ''}/>`
  }
  function text(shape: Element, shapeBox: Box): string {
    const body = child(shape, 'txBody'), properties = child(body, 'bodyPr'), tx = child(shape, 'txXfrm')
    const b = tx ? box(tx) : shapeBox, style = reader.textStyle(shape)
    const left = num(properties, 'lIns', 91440) / 36000, right = num(properties, 'rIns', 91440) / 36000
    const top = num(properties, 'tIns', 45720) / 36000, bottom = num(properties, 'bIns', 45720) / 36000
    const paragraphs = children(body, 'p'), lines: Array<{ content: string; align: string; size: number; height: number; after: number }> = []
    for (const paragraph of paragraphs) {
      const pPr = child(paragraph, 'pPr'), rPr = all(paragraph, 'rPr')[0] || child(paragraph, 'endParaRPr')
      const size = num(rPr, 'sz', style.fontSize * 100) / 100 * 25.4 / 72
      const spacing = child(pPr, 'lnSpc'), lineHeight = child(spacing, 'spcPts') ? num(child(spacing, 'spcPts'), 'val') / 100 * 25.4 / 72 : size * 1.2 * num(child(spacing, 'spcPct'), 'val', 100000) / 100000
      const after = child(child(pPr, 'spcAft'), 'spcPts') ? num(child(child(pPr, 'spcAft'), 'spcPts'), 'val') / 100 * 25.4 / 72 : size * num(child(child(pPr, 'spcAft'), 'spcPct'), 'val') / 100000
      const content = children(paragraph).map(run => run.localName === 'br' ? '\n' : ['r', 'fld'].includes(run.localName) ? all(run, 't').map(t => t.textContent || '').join('') : '').join('')
      for (const line of content.split('\n')) lines.push({ content: line, align: pPr?.getAttribute('algn') || style.align, size, height: lineHeight, after })
    }
    if (!lines.some(line => line.content)) return ''
    const clip = `text${++serial}`, contentHeight = lines.reduce((sum, line, index) => sum + line.height + (index === lines.length - 1 ? 0 : line.after), 0)
    definitions.push(`<clipPath id="${clip}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(Math.max(0, b.w))}" height="${n(Math.max(0, b.h))}"/></clipPath>`)
    const anchor = properties?.getAttribute('anchor'), available = b.h - top - bottom
    let y = b.y + top + (anchor === 'ctr' ? (available - contentHeight) / 2 : anchor === 'b' ? available - contentHeight : 0)
    const output = lines.map(line => {
      const centered = ['ctr', 'center'].includes(line.align), rightAligned = ['r', 'right'].includes(line.align)
      const x = b.x + (centered ? (left + b.w - right) / 2 : rightAligned ? b.w - right : left)
      y += line.height
      return `<text x="${n(x)}" y="${n(y - (line.height - line.size) / 2 - line.size * .15)}" font-family="${escape(style.fontName)}, Arial, sans-serif" font-size="${n(line.size)}" font-weight="${style.bold ? 700 : 400}" font-style="${style.italic ? 'italic' : 'normal'}" fill="${escape(style.color)}" text-anchor="${centered ? 'middle' : rightAligned ? 'end' : 'start'}" xml:space="preserve">${escape(line.content)}</text>` + (y += line.after, '')
    }).join('')
    const clipped = properties?.getAttribute('horzOverflow') === 'clip' || properties?.getAttribute('vertOverflow') === 'clip'
    return `<g transform="${rotate({ ...b, rot: b.rot + (tx ? shapeBox.rot : 0) + num(properties, 'rot') / 60000 })}"${clipped ? ` clip-path="url(#${clip})"` : ''}>${output}</g>`
  }
  function render(shape: Element, depth = 0): string {
    if (++count > 2000 || depth > 20) throw new Error('SmartArt 缓存超过预览复杂度限制。')
    if (shape.namespaceURI !== DSP && shape.namespaceURI !== 'http://schemas.openxmlformats.org/presentationml/2006/main') throw new Error('SmartArt 缓存包含未知扩展形状。')
    if (shape.localName === 'grpSp') {
      const xfrm = child(child(shape, 'grpSpPr'), 'xfrm'), b = box(xfrm), off = child(xfrm, 'chOff'), ext = child(xfrm, 'chExt')
      if (!xfrm || !child(xfrm, 'ext') || !ext || num(ext, 'cx') <= 0 || num(ext, 'cy') <= 0) throw new Error('SmartArt 缓存分组变换不完整。')
      const sx = b.w * 36000 / num(ext, 'cx', 1), sy = b.h * 36000 / num(ext, 'cy', 1)
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) throw new Error('SmartArt 缓存分组坐标无效。')
      return `<g transform="${rotate(b)} translate(${n(b.x)} ${n(b.y)}) scale(${n(sx)} ${n(sy)}) translate(${n(-num(off, 'x') / 36000)} ${n(-num(off, 'y') / 36000)})">${children(shape).filter(item => !['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(item.localName)).map(item => render(item, depth + 1)).join('')}</g>`
    }
    if (!['sp', 'cxnSp', 'pic'].includes(shape.localName)) throw new Error('SmartArt 缓存对象类型暂不支持。')
    const properties = child(shape, 'spPr'), b = box(child(properties, 'xfrm'))
    if (b.w < 0 || b.h < 0) throw new Error('SmartArt 缓存形状尺寸无效。')
    if (['1', 'true'].includes(child(properties, 'xfrm')?.getAttribute('flipH') || '') || ['1', 'true'].includes(child(properties, 'xfrm')?.getAttribute('flipV') || '')) throw new Error('SmartArt 翻转缓存暂不支持预览。')
    const geometry = shapeGeometry(shape, b), fill = children(properties).find(item => ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill'].includes(item.localName)) || child(shape, 'blipFill')
    let paint = 'fill="none"', image = ''
    if (fill?.localName === 'solidFill') { const color = cachedColor(fill, reader); paint = `fill="${color.hex}" fill-opacity="${n(color.alpha)}"` }
    else if (fill?.localName === 'gradFill') {
      const stops = children(child(fill, 'gsLst'), 'gs').sort((a, b) => num(a, 'pos') - num(b, 'pos'))
      if (!stops.length || stops.length > 64 || child(fill, 'path')) throw new Error('SmartArt 渐变缓存暂不支持预览。')
      const id = `gradient${++serial}`, angle = num(child(fill, 'lin'), 'ang') / 60000 * Math.PI / 180
      const dx = Math.cos(angle), dy = Math.sin(angle), span = Math.abs(dx) + Math.abs(dy)
      definitions.push(`<linearGradient id="${id}" x1="${n(.5 - dx * span / 2)}" y1="${n(.5 - dy * span / 2)}" x2="${n(.5 + dx * span / 2)}" y2="${n(.5 + dy * span / 2)}">${stops.map(stop => { const color = cachedColor(stop, reader); return `<stop offset="${n(clamp(num(stop, 'pos') / 100000))}" stop-color="${color.hex}" stop-opacity="${n(color.alpha)}"/>` }).join('')}</linearGradient>`)
      paint = `fill="url(#${id})"`
    } else if (fill?.localName === 'blipFill') {
      const blip = child(fill, 'blip'), url = blip ? reader.image(blip) : undefined
      if (!safeImageDataUrl(url)) throw new Error('SmartArt 缓存图片缺失、链接到外部或编码不支持；未联网加载。')
      imageBytes += url!.length
      if (imageBytes > 20_000_000) throw new Error('SmartArt 缓存预览超过图片资源大小限制。')
      resources.add(url!); const id = `image${++serial}`, rect = child(child(fill, 'stretch'), 'fillRect'), source = child(fill, 'srcRect')
      if (source && Array.from(source.attributes).some(attribute => Number(attribute.value))) throw new Error('SmartArt 缓存图片裁剪暂不支持预览。')
      definitions.push(`<clipPath id="${id}">${geometry}</clipPath>`)
      const l = num(rect, 'l') / 100000, r = num(rect, 'r') / 100000, t = num(rect, 't') / 100000, bottom = num(rect, 'b') / 100000
      image = `<image x="${n(b.x + b.w * l)}" y="${n(b.y + b.h * t)}" width="${n(Math.max(0, b.w * (1 - l - r)))}" height="${n(Math.max(0, b.h * (1 - t - bottom)))}" href="${escape(url)}" preserveAspectRatio="none" clip-path="url(#${id})"/>`
    } else if (fill?.localName === 'pattFill') throw new Error('SmartArt 图案填充暂不支持预览。')
    const line = child(properties, 'ln'), lineFill = child(line, 'solidFill'), stroke = lineFill ? cachedColor(lineFill, reader) : null
    const linePaint = stroke ? `stroke="${stroke.hex}" stroke-opacity="${n(stroke.alpha)}" stroke-width="${n(num(line, 'w', 12700) / 36000)}"` : 'stroke="none"'
    // txXfrm is a separate absolute text transform in the drawing's local space.
    return `<g transform="${rotate(b)}"><g ${paint} stroke="none">${geometry}</g>${image}<g fill="none" ${linePaint}>${geometry}</g></g>${text(shape, b)}`
  }
  const tree = child(drawing.documentElement, 'spTree')
  const rootTransform = child(child(tree, 'grpSpPr'), 'xfrm')
  if (rootTransform) {
    const off = child(rootTransform, 'off'), childOff = child(rootTransform, 'chOff'), ext = child(rootTransform, 'ext'), childExt = child(rootTransform, 'chExt')
    const identity = num(off, 'x') === num(childOff, 'x') && num(off, 'y') === num(childOff, 'y')
      && num(ext, 'cx') > 0 && num(ext, 'cy') > 0 && num(ext, 'cx') === num(childExt, 'cx') && num(ext, 'cy') === num(childExt, 'cy')
      && num(rootTransform, 'rot') % 21600000 === 0 && !['1', 'true'].includes(rootTransform.getAttribute('flipH') || '') && !['1', 'true'].includes(rootTransform.getAttribute('flipV') || '')
    if (!identity) throw new Error('SmartArt 顶层缓存分组变换暂不支持预览。')
  }
  const fragments: string[] = []
  let svgBytes = 0
  for (const item of children(tree).filter(item => !['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(item.localName))) {
    const fragment = render(item)
    svgBytes += fragment.length
    if (svgBytes > 24_000_000) throw new Error('SmartArt 缓存预览超过图片资源大小限制。')
    fragments.push(fragment)
  }
  const content = fragments.join('')
  if (!count) throw new Error('SmartArt 绘图缓存为空。')
  if (resources.size > 64) throw new Error('SmartArt 缓存图片数量超过限制。')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}"><defs>${definitions.join('')}</defs>${content}</svg>`
}

/** Raster isolates cached drawing previews from editable slide objects and original XML. */
export function smartArtPreviewSize(width: number, height: number): { pixelWidth: number; pixelHeight: number } {
  const longest = Math.max(width, height), scale = Math.max(1024, Math.min(2048, longest * 8)) / longest
  return { pixelWidth: Math.max(1, Math.round(width * scale)), pixelHeight: Math.max(1, Math.round(height * scale)) }
}
export async function rasterizeSmartArt(svg: string, width: number, height: number): Promise<{ dataUrl: string; pixelWidth: number; pixelHeight: number }> {
  const { pixelWidth, pixelHeight } = smartArtPreviewSize(width, height)
  const source = svg.replace(/ width="[^"]+" height="[^"]+" viewBox=/, ` width="${pixelWidth}" height="${pixelHeight}" viewBox=`)
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' })), image = new Image(), canvas = document.createElement('canvas')
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    image.src = url
    await Promise.race([image.decode(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('SmartArt 缓存预览生成超时。')), 5000) })])
    canvas.width = pixelWidth; canvas.height = pixelHeight
    const context = canvas.getContext('2d'); if (!context) throw new Error('当前环境无法生成 SmartArt 缓存预览。')
    context.drawImage(image, 0, 0, pixelWidth, pixelHeight)
    return { dataUrl: canvas.toDataURL('image/png'), pixelWidth, pixelHeight }
  } finally { if (timeout) clearTimeout(timeout); image.src = ''; URL.revokeObjectURL(url); canvas.width = canvas.height = 0 }
}
