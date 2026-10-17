import type { Point, ShapeElement } from './types.ts'

/** Small deterministic strokes of our own; no random global state or external renderer. */
function seededRandom(seed: string): () => number {
  let value = 2166136261
  for (let index = 0; index < seed.length; index++) value = Math.imul(value ^ seed.charCodeAt(index), 16777619)
  value ||= 0x6d2b79f5
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296 }
}
function control(value: number): string { return String(Math.round(value * 1000) / 1000) }
function point(point: Point): string { return `${point.x} ${point.y}` }
function amplitude(width: number, length: number): number { return Math.min(3.5, Math.max(3, Math.sqrt(Math.max(0, Math.min(100, width))) * 1.4), length * 0.075) }

/** Every original vertex is exact, including bound endpoints and inserted shape anchors. */
export function sketchPolyline(points: Point[], seed: string, width: number, closed = false): string[] {
  if (!points.length) return []
  const vertices = closed ? [...points, points[0]!] : points
  return [0, 1].map(pass => {
    const random = seededRandom(`${seed}:${pass}`)
    let path = `M${point(vertices[0]!)}`
    for (let index = 1; index < vertices.length; index++) {
      const start = vertices[index - 1]!, end = vertices[index]!, dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy)
      if (!length) continue
      const nx = -dy / length, ny = dx / length, amount = amplitude(width, length), first = (random() * 2 - 1) * amount, second = (random() * 2 - 1) * amount
      path += ` C${control(start.x + dx / 3 + nx * first)} ${control(start.y + dy / 3 + ny * first)} ${control(start.x + dx * 2 / 3 + nx * second)} ${control(start.y + dy * 2 / 3 + ny * second)} ${point(end)}`
    }
    return path + (closed ? ' Z' : '')
  })
}

/** Insert attached edge endpoints into a polygon, so both sketch passes meet the edge. */
export function anchoredPolygon(vertices: Point[], anchors: Point[], closed = true): Point[] {
  const result: Point[] = []
  for (let index = 0; index < vertices.length; index++) {
    if (!closed && index === vertices.length - 1) { result.push(vertices[index]!); break }
    const start = vertices[index]!, end = vertices[(index + 1) % vertices.length]!, dx = end.x - start.x, dy = end.y - start.y, squared = dx * dx + dy * dy
    result.push(start)
    if (!squared) continue
    const interior = anchors.map(anchor => ({ anchor, t: ((anchor.x - start.x) * dx + (anchor.y - start.y) * dy) / squared }))
      .filter(({ anchor, t }) => t > 1e-8 && t < 1 - 1e-8 && Math.abs((anchor.x - start.x) * dy - (anchor.y - start.y) * dx) / Math.sqrt(squared) < 0.01)
      .sort((a, b) => a.t - b.t)
    for (const { anchor } of interior) if (Math.hypot(anchor.x - result[result.length - 1]!.x, anchor.y - result[result.length - 1]!.y) > 0.001) result.push(anchor)
  }
  return result
}

/** Ellipse arcs keep the original tangents, with a bounded nudge of their control points. */
export function sketchEllipse(node: ShapeElement, anchors: Point[], seed: string): string[] {
  const rx = Math.max(0.5, node.width / 2), ry = Math.max(0.5, node.height / 2), cx = node.x + node.width / 2, cy = node.y + node.height / 2
  const full = Math.PI * 2, normalize = (angle: number) => (angle + full) % full
  const points = Array.from({ length: 8 }, (_, index) => { const angle = index * Math.PI / 4; return { angle, point: { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry } } })
  for (const anchor of anchors) {
    const angle = normalize(Math.atan2((anchor.y - cy) / ry, (anchor.x - cx) / rx)), existing = points.find(item => Math.abs(item.angle - angle) < 1e-8 || Math.abs(item.angle - angle) > full - 1e-8)
    if (existing) existing.point = anchor
    else points.push({ angle, point: anchor })
  }
  points.sort((a, b) => a.angle - b.angle)
  return [0, 1].map(pass => {
    const random = seededRandom(`${seed}:${pass}`)
    let path = `M${point(points[0]!.point)}`
    for (let index = 0; index < points.length; index++) {
      const start = points[index]!, end = points[(index + 1) % points.length]!, a = start.angle, b = end.angle + (index === points.length - 1 ? full : 0), k = 4 / 3 * Math.tan((b - a) / 4)
      const amount = amplitude(node.style.strokeWidth, Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y))
      const first = (random() * 2 - 1) * amount, second = (random() * 2 - 1) * amount
      path += ` C${control(start.point.x - Math.sin(a) * rx * k + Math.cos(a) * first)} ${control(start.point.y + Math.cos(a) * ry * k + Math.sin(a) * first)} ${control(end.point.x + Math.sin(b) * rx * k + Math.cos(b) * second)} ${control(end.point.y - Math.cos(b) * ry * k + Math.sin(b) * second)} ${point(end.point)}`
    }
    return path + ' Z'
  })
}
