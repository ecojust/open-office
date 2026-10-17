import type { ElementStyle, Point, Scene, SceneElement, ShapeElement, StrokeElement } from './types.ts'
import { edgePoints, pathMidpoint, pointsPath, sceneBounds, shapeOutline, isBraceShape, bracePath, braceTextBounds } from './geometry.ts'
import { anchoredPolygon, sketchEllipse, sketchPolyline } from './sketch.ts'
import { resolveStrokePattern } from './appearance.ts'
import { brushOutlinePath, brushPolyline, brushRadiusAt, rainbowSegments } from './brushes.ts'

export function escapeXml(value: unknown): string { return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '\uFFFD').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!) }
export function safeImageData(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)
}
function color(value: string): string { return /^(?:#[\da-f]{3,8}|[a-z]{1,24}|(?:rgba?|hsla?)\([\d.,%\s/]+\))$/i.test(value) ? escapeXml(value) : '#334155' }
function isSketch(style: ElementStyle): boolean { return style.roughness === 'sketch' && style.strokeWidth > 0 && !['none', 'transparent'].includes(style.stroke.toLowerCase()) }
function styleAttrs(style: ElementStyle, fill = style.fill, width = style.strokeWidth): string {
  const pattern = resolveStrokePattern(style), dash = pattern === 'dashed' ? ' stroke-dasharray="8 5"' : pattern === 'dotted' ? ` stroke-dasharray="0.01 ${Math.max(4, Math.min(100, style.strokeWidth) * 2.5)}"` : ''
  return `fill="${color(fill)}" stroke="${color(style.stroke)}" stroke-width="${Math.max(0, Math.min(100, width))}" opacity="${Math.max(0, Math.min(1, style.opacity))}"${dash} stroke-linejoin="round" stroke-linecap="round"`
}
function sketchMarkup(paths: string[], style: ElementStyle): string {
  if (!paths.length) return ''
  return `<g data-roughness="sketch" opacity="${Math.max(0, Math.min(1, style.opacity))}" pointer-events="none">${paths.map((d, index) => `<path data-sketch-pass="${index + 1}" d="${d}" ${styleAttrs({ ...style, opacity: index ? 0.5 : 1 }, 'none', style.strokeWidth * (index ? 0.72 : 1))}/>`).join('')}</g>`
}
function strokeMarkup(points: Point[], id: string, style: ElementStyle, closed = false): string {
  // A large freehand stroke already records the user's real gesture. Keep its exact
  // trajectory instead of multiplying a 100000-point drawing into cubic control data.
  return isSketch(style) && points.length <= 2048 ? sketchMarkup(sketchPolyline(points, id, style.strokeWidth, closed), style)
    : `<path d="${pointsPath(points)}${closed ? ' Z' : ''}" ${styleAttrs(style, 'none')}/>`
}
function brushMarkup(element: StrokeElement): string {
  const brush = element.brush ?? 'pen', opacity = Math.max(0, Math.min(1, element.style.opacity)), ink = color(element.style.stroke), width = Math.max(0, Math.min(100, element.style.strokeWidth))
  if (!element.points.length || !width) return ''
  let markup: string
  if (brush === 'pencil') {
    markup = `<path data-pencil-grain="base" d="${brushOutlinePath(element)}" fill="${ink}" fill-rule="evenodd" stroke="none" opacity=".16"/>` + [0, 1, 2].map(pass => {
      const points = element.points.map((point, index) => {
        const radius = brushRadiusAt(element, index), noise = Math.sin(index * 12.9898 + pass * 41.73) * .13
        return { x: point.x + (pass - 1 + noise) * radius * .36, y: point.y + (1 - pass + noise) * radius * .36 }
      })
      if (points.length === 1) points.push({ x: points[0]!.x + .01, y: points[0]!.y + .01 })
      return `<path data-pencil-pass="${pass + 1}" d="${brushPolyline(points)}${element.closed ? ' Z' : ''}" fill="none" stroke="${ink}" stroke-width="${width * .22}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${pass === 1 ? '1.7 .35' : '.7 .6'}" stroke-dashoffset="${pass * .37}" opacity="${pass === 1 ? .72 : .42}"/>`
    }).join('')
  } else if (brush === 'rainbow') {
    if (element.points.length === 1) markup = `<circle cx="${element.points[0]!.x}" cy="${element.points[0]!.y}" r="${brushRadiusAt(element, 0)}" fill="hsl(0 85% 55%)"/>`
    else markup = rainbowSegments(element).map(segment => `<path d="${brushOutlinePath({ ...element, brush: 'pen', points: segment.points, pressures: segment.pressures, closed: false })}" fill="hsl(${segment.hue} 85% 55%)" stroke="none"/>`).join('')
  } else markup = `<path d="${brushOutlinePath(element)}" fill="${ink}" fill-rule="evenodd" stroke="none"/>`
  return `<g data-brush="${escapeXml(brush)}" opacity="${opacity}">${brush === 'highlighter' ? `<g opacity=".32">${markup}</g>` : markup}</g>`
}
function boundAnchors(node: ShapeElement, scene: Scene): Point[] {
  const anchors: Point[] = []
  for (const edge of scene.elements) if (edge.type === 'edge' && (edge.from.nodeId === node.id || edge.to.nodeId === node.id)) {
    const points = edgePoints(edge, scene)
    if (edge.from.nodeId === node.id) anchors.push(points[0]!)
    if (edge.to.nodeId === node.id) anchors.push(points[points.length - 1]!)
  }
  return anchors
}
function sketchShape(node: ShapeElement, scene: Scene, hitTargets: boolean): string {
  const { x, y, width: w, height: h } = node
  const vertices = shapeOutline(node)
  const geometry = node.shape === 'ellipse' ? `ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"` : `path d="${pointsPath(vertices)} Z"`
  const fill = node.shape === 'frame' ? '' : `<${geometry} fill="${color(node.style.fill)}" stroke="none" opacity="${Math.max(0, Math.min(1, node.style.opacity))}"/>`
  const hit = hitTargets ? `<${geometry} fill="${node.shape === 'frame' ? 'none' : 'transparent'}" stroke="transparent" stroke-width="${Math.max(16, node.style.strokeWidth)}" pointer-events="${node.shape === 'frame' ? 'stroke' : 'all'}"/>` : ''
  const anchors = boundAnchors(node, scene), paths = node.shape === 'ellipse' ? sketchEllipse(node, anchors, node.id) : sketchPolyline(anchoredPolygon(vertices, anchors), node.id, node.style.strokeWidth, true)
  return fill + hit + sketchMarkup(paths, node.style)
}
function cylinderSeam(node: ShapeElement): string {
  const cap = Math.min(node.height * .18, node.width * .18)
  const points = Array.from({ length: 25 }, (_, index) => { const angle = index * Math.PI / 24; return { x: node.x + node.width / 2 + Math.cos(angle) * node.width / 2, y: node.y + cap + Math.sin(angle) * cap } })
  return strokeMarkup(points, `${node.id}:cap`, node.style)
}
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(1, width / Math.max(1, fontSize)), lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = '', used = 0
    for (const character of paragraph) { const size = /[\u0000-\u007f]/.test(character) ? 0.57 : 1; if (used + size > max && line) { lines.push(line); line = ''; used = 0 }; line += character; used += size }
    lines.push(line)
  }
  return lines
}
function textMarkup(node: ShapeElement): string {
  if (!node.text || node.shape === 'image') return ''
  if (isBraceShape(node.shape)) return textMarkup({ ...node, ...braceTextBounds(node), shape: 'text' })
  const fontSize = Math.max(1, Math.min(500, node.style.fontSize)), lineHeight = fontSize * 1.35
  const innerWidth = node.shape === 'diamond' ? node.width * .58 : node.shape === 'star' ? node.width * .46 : node.shape === 'triangle' ? node.width * .56 : ['cloud', 'parallelogram', 'hexagon'].includes(node.shape) ? node.width * .7 : node.width - 20
  const maxLines = node.shape === 'frame' ? 1 : Math.max(1, Math.floor((node.height - 12) / lineHeight))
  const wrapped = wrapText(node.text, innerWidth, fontSize), lines = wrapped.slice(0, maxLines)
  if (wrapped.length > maxLines) lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, -1)}…`
  const align = node.shape === 'frame' ? 'left' : node.style.textAlign, x = align === 'left' ? node.x + 12 : align === 'right' ? node.x + node.width - 10 : node.x + node.width / 2
  const y = node.shape === 'frame' ? node.y + Math.min(node.height, Math.max(28, fontSize * 1.5 + 12)) / 2 : node.y + node.height / 2 - (lines.length - 1) * lineHeight / 2
  const textColor = ['transparent', 'none'].includes(node.style.stroke.toLowerCase()) ? '#334155' : node.style.stroke
  return `<text fill="${color(textColor)}" opacity="${node.style.opacity}" font-family="'Office UI', 'Office UI CJK', system-ui, sans-serif" font-size="${fontSize}" text-anchor="${align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'}" dominant-baseline="central" pointer-events="none">${lines.map((line, i) => `<tspan x="${x}" y="${y + i * lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`
}
function braceLabelHitBounds(node: ShapeElement): ReturnType<typeof braceTextBounds> {
  const bounds = braceTextBounds(node), fontSize = Math.max(1, Math.min(500, node.style.fontSize)), lineHeight = fontSize * 1.35
  const lines = wrapText(node.text, bounds.width - 20, fontSize).slice(0, Math.max(1, Math.floor((bounds.height - 12) / lineHeight)))
  const width = Math.min(bounds.width, Math.max(8, ...lines.map(line => [...line].reduce((sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 1 : .57) * fontSize, 8))))
  const height = Math.min(bounds.height, Math.max(lineHeight, lines.length * lineHeight))
  return { x: node.style.textAlign === 'left' ? bounds.x + 8 : node.style.textAlign === 'right' ? bounds.x + bounds.width - width - 6 : bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height }
}
function arrowMarkup(at: Point, previous: Point, style: ElementStyle, id: string, hitTargets: boolean): string {
  const angle = Math.atan2(at.y - previous.y, at.x - previous.x), size = Math.max(8, style.strokeWidth * 3.5)
  const a = { x: at.x - Math.cos(angle - 0.45) * size, y: at.y - Math.sin(angle - 0.45) * size }, b = { x: at.x - Math.cos(angle + 0.45) * size, y: at.y - Math.sin(angle + 0.45) * size }
  const hit = hitTargets && isSketch(style) ? `<path d="${pointsPath([a, at, b])}" fill="none" stroke="transparent" stroke-width="${Math.max(16, style.strokeWidth)}"/>` : ''
  // The shaft carries the chosen pattern; a solid head keeps its direction legible.
  return hit + strokeMarkup([a, at, b], id, { ...style, strokePattern: 'solid', dashed: false })
}
export function elementToSvg(element: SceneElement, scene: Scene, hitTargets = false): string {
  if (element.type === 'stroke') {
    const points = element.points.length === 1 ? [element.points[0]!, { x: element.points[0]!.x + 0.01, y: element.points[0]!.y + 0.01 }] : element.points
    const closed = element.closed === true && points.length >= 3, d = pointsPath(points) + (closed ? ' Z' : '')
    const fill = closed ? `<path d="${d}" fill="${color(element.style.fill)}" stroke="none" opacity="${Math.max(0, Math.min(1, element.style.opacity))}"/>` : ''
    return `${fill}${hitTargets ? `<path d="${d}" fill="${closed ? 'transparent' : 'none'}" stroke="transparent" stroke-width="${Math.max(16, element.style.strokeWidth)}"/>` : ''}${element.brush || element.pressures ? brushMarkup(element) : strokeMarkup(points, element.id, element.style, closed)}`
  }
  if (element.type === 'edge') {
    const points = edgePoints(element, scene), d = pointsPath(points), middle = pathMidpoint(points)
    const start = points[0]!, end = points[points.length - 1]!
    const before = [...points].reverse().find(p => p.x !== end.x || p.y !== end.y) || start
    const after = points.find(p => p.x !== start.x || p.y !== start.y) || end
    const arrows = `${element.arrow !== 'none' ? arrowMarkup(end, before, element.style, `${element.id}:end`, hitTargets) : ''}${element.arrow === 'both' ? arrowMarkup(start, after, element.style, `${element.id}:start`, hitTargets) : ''}`
    const label = element.label ? `<text x="${middle.x}" y="${middle.y - 9}" font-size="${element.style.fontSize}" font-family="'Office UI', 'Office UI CJK', system-ui, sans-serif" text-anchor="middle" fill="${color(element.style.stroke)}" stroke="${color(scene.background)}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${escapeXml(element.label)}</text>` : ''
    return `${hitTargets ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(18, element.style.strokeWidth)}"/>` : ''}${strokeMarkup(points, element.id, element.style)}${arrows}${label}`
  }
  const { x, y, width: w, height: h, shape } = element, attrs = styleAttrs(element.style)
  let markup = ''
  if (isBraceShape(shape)) {
    const path = bracePath(element)
    if (hitTargets) {
      markup = `<path data-brace-hit="true" d="${path}" fill="none" stroke="transparent" stroke-width="${Math.max(16, element.style.strokeWidth)}" pointer-events="stroke"/>`
      if (element.text) { const bounds = braceLabelHitBounds(element); markup += `<rect data-brace-label-hit="true" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="transparent" stroke="none" pointer-events="all"/>` }
    }
    markup += isSketch(element.style) ? sketchMarkup(sketchPolyline(anchoredPolygon(shapeOutline(element), boundAnchors(element, scene), false), element.id, element.style.strokeWidth), element.style) : `<path d="${path}" ${styleAttrs(element.style, 'none')}/>`
  }
  else if (shape === 'frame') {
    const headerHeight = Math.min(h, Math.max(28, element.style.fontSize * 1.5 + 12))
    markup = isSketch(element.style) ? sketchShape(element, scene, hitTargets) : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${styleAttrs(element.style, 'none')}/>`
    if (hitTargets) markup += `<rect x="${x}" y="${y}" width="${w}" height="${headerHeight}" fill="transparent" pointer-events="all"/>`
  }
  else if (isSketch(element.style) && !['image', 'text'].includes(shape)) markup = sketchShape(element, scene, hitTargets)
  else if (shape === 'ellipse') markup = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`
  else if (shape === 'diamond') markup = `<path d="M${x + w / 2} ${y} L${x + w} ${y + h / 2} L${x + w / 2} ${y + h} L${x} ${y + h / 2} Z" ${attrs}/>`
  else if (['triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud'].includes(shape)) markup = `<path d="${pointsPath(shapeOutline(element))} Z" ${attrs}/>`
  else if (shape === 'image' && safeImageData(element.imageData)) markup = `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${escapeXml(element.imageData)}" preserveAspectRatio="xMidYMid meet" opacity="${element.style.opacity}"/>`
  else if (shape === 'text') markup = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`
  else markup = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${shape === 'note' ? 2 : 9}" ${attrs}/>${shape === 'note' ? `<path d="M${x + w - 18} ${y + h} L${x + w - 18} ${y + h - 18} L${x + w} ${y + h - 18}" fill="#0000000b" stroke="${color(element.style.stroke)}" stroke-opacity=".2"/>` : ''}`
  return markup + (shape === 'cylinder' ? cylinderSeam(element) : '') + textMarkup(element)
}
export function sceneToSvg(scene: Scene, options: { background?: boolean } = {}): string {
  const bounds = sceneBounds(scene), pad = Math.max(32, ...scene.elements.map(e => e.style.strokeWidth / 2 + 12 + (e.type === 'edge' && e.arrow !== 'none' ? Math.max(8, e.style.strokeWidth * 3.5) : 0))), x = bounds.x - pad, y = bounds.y - pad, width = Math.max(64, bounds.width + pad * 2), height = Math.max(64, bounds.height + pad * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="${x} ${y} ${width} ${height}" role="img" aria-label="Open Office 图表">${options.background === false ? '' : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color(scene.background)}"/>`}${scene.elements.map(element => `<g>${elementToSvg(element, scene)}</g>`).join('')}</svg>`
}
