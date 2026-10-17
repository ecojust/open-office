import type { EdgeElement, Point, Scene, SceneElement, ShapeElement } from './types.ts'
import { brushRadiusAt } from './brushes.ts'

export interface Bounds { x: number; y: number; width: number; height: number }
export function elementBounds(element: SceneElement): Bounds {
  if (element.type === 'shape') return { x: element.x, y: element.y, width: element.width, height: element.height }
  const points = element.type === 'stroke' ? element.points : [element.from, element.to]
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!, radius = element.type === 'stroke' && (element.brush || element.pressures) ? brushRadiusAt(element, index) : 0
    x = Math.min(x, point.x - radius); y = Math.min(y, point.y - radius); right = Math.max(right, point.x + radius); bottom = Math.max(bottom, point.y + radius)
  }
  return { x, y, width: right - x, height: bottom - y }
}
export function combineBounds(bounds: Bounds[]): Bounds {
  if (!bounds.length) return { x: 0, y: 0, width: 800, height: 600 }
  const x = Math.min(...bounds.map(b => b.x)), y = Math.min(...bounds.map(b => b.y))
  return { x, y, width: Math.max(...bounds.map(b => b.x + b.width)) - x, height: Math.max(...bounds.map(b => b.y + b.height)) - y }
}
export function center(node: ShapeElement): Point { return { x: node.x + node.width / 2, y: node.y + node.height / 2 } }
/** Keep the stored preference when resizing, but never draw past half the short side. */
export function rectangleCornerRadius(node: ShapeElement): number {
  if (node.shape !== 'rectangle' || !Number.isFinite(node.cornerRadius) || !Number.isFinite(node.width) || !Number.isFinite(node.height)) return 0
  return Math.max(0, Math.min(node.cornerRadius ?? 0, node.width / 2, node.height / 2))
}
function roundedRectangleDistance(node: ShapeElement, point: Point, radius: number): number {
  const qx = Math.abs(point.x - node.x - node.width / 2) - (node.width / 2 - radius)
  const qy = Math.abs(point.y - node.y - node.height / 2) - (node.height / 2 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}
function roundedRectangleOutline(node: ShapeElement, radius: number, anchors: Point[]): Point[] {
  const { x, y, width: w, height: h } = node
  const corners = [{ x: x + w - radius, y: y + radius }, { x: x + w - radius, y: y + h - radius }, { x: x + radius, y: y + h - radius }, { x: x + radius, y: y + radius }]
  const points: Point[] = []
  for (let corner = 0; corner < 4; corner++) {
    const c = corners[corner]!, start = (corner - 1) * Math.PI / 2
    const arc = Array.from({ length: 17 }, (_, index) => { const angle = start + index * Math.PI / 32; return { angle, point: { x: c.x + Math.cos(angle) * radius, y: c.y + Math.sin(angle) * radius } } })
    // Insert exact circular boundary anchors before sketching. Projecting them
    // onto the sampled chords would leave visible gaps at a diagonal connector.
    for (const anchor of anchors) {
      if (Math.abs(Math.hypot(anchor.x - c.x, anchor.y - c.y) - radius) > 1e-6) continue
      let angle = Math.atan2(anchor.y - c.y, anchor.x - c.x)
      if (angle < start - 1e-8) angle += Math.PI * 2
      if (angle < start - 1e-8 || angle > start + Math.PI / 2 + 1e-8) continue
      const existing = arc.find(item => Math.abs(item.angle - angle) < 1e-8)
      if (existing) existing.point = anchor
      else arc.push({ angle, point: anchor })
    }
    arc.sort((a, b) => a.angle - b.angle)
    points.push(...arc.map(item => item.point))
  }
  return points
}
export function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y, squared = dx * dx + dy * dy
  const t = squared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / squared)) : 0
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy)
}
export function pointInPolygon(point: Point, points: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
    const a = points[previous]!, b = points[i]!
    if (distanceToSegment(point, a, b) < 1e-8) return true
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
function normalizedOutline(points: Point[], node: ShapeElement): Point[] {
  const bounds = elementBounds({ id: '', type: 'stroke', points, style: node.style, locked: false })
  return points.map(p => ({ x: node.x + (p.x - bounds.x) / (bounds.width || 1) * node.width, y: node.y + (p.y - bounds.y) / (bounds.height || 1) * node.height }))
}
export type BraceShape = Extract<ShapeElement['shape'], `brace-${string}`>
export function isBraceShape(shape: unknown): shape is BraceShape {
  return shape === 'brace-left' || shape === 'brace-right' || shape === 'brace-top' || shape === 'brace-bottom'
}
type Cubic = [Point, Point, Point, Point]
/** Braces are open curves; the rest of the node is an intentionally empty label area. */
function braceCurves(node: ShapeElement): Cubic[] {
  const curves = [
    [[1, 0], [.5, 0], [.5, .1], [.5, .25]],
    [[.5, .25], [.5, .4], [.5, .46], [0, .5]],
    [[0, .5], [.5, .54], [.5, .6], [.5, .75]],
    [[.5, .75], [.5, .9], [.5, 1], [1, 1]],
  ]
  const convert = ([across, along]: number[]): Point => {
    let u: number, v: number
    if (node.shape === 'brace-right') { u = 1 - across! * .25; v = along! }
    else if (node.shape === 'brace-top') { u = along!; v = across! * .3 }
    else if (node.shape === 'brace-bottom') { u = along!; v = 1 - across! * .3 }
    else { u = across! * .25; v = along! }
    return { x: node.x + u * node.width, y: node.y + v * node.height }
  }
  return curves.map(curve => curve.map(convert) as Cubic)
}
export function bracePath(node: ShapeElement): string {
  const curves = braceCurves(node), first = curves[0]![0]
  return `M${first.x} ${first.y}` + curves.map(([, a, b, end]) => ` C${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`).join('')
}
export function braceTextBounds(node: ShapeElement): Bounds {
  if (node.shape === 'brace-left') return { x: node.x + node.width * .3, y: node.y, width: node.width * .7, height: node.height }
  if (node.shape === 'brace-right') return { x: node.x, y: node.y, width: node.width * .7, height: node.height }
  if (node.shape === 'brace-top') return { x: node.x, y: node.y + node.height * .36, width: node.width, height: node.height * .64 }
  if (node.shape === 'brace-bottom') return { x: node.x, y: node.y, width: node.width, height: node.height * .64 }
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}
function braceOutline(node: ShapeElement): Point[] {
  const curves = braceCurves(node), result: Point[] = [curves[0]![0]]
  const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  function flatten([a, b, c, d]: Cubic, depth: number): void {
    if (depth >= 12 || Math.max(distanceToSegment(b, a, d), distanceToSegment(c, a, d)) <= .12) { result.push(d); return }
    const ab = middle(a, b), bc = middle(b, c), cd = middle(c, d), abc = middle(ab, bc), bcd = middle(bc, cd), center = middle(abc, bcd)
    flatten([a, ab, abc, center], depth + 1); flatten([center, bcd, cd, d], depth + 1)
  }
  for (const curve of curves) flatten(curve, 0)
  return result
}
function nearestOnPolyline(points: Point[], point: Point): Point {
  let closest = points[0]!, distance = Infinity
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!, dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy
    const t = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0
    const candidate = { x: a.x + dx * t, y: a.y + dy * t }, next = Math.hypot(candidate.x - point.x, candidate.y - point.y)
    if (next < distance) { distance = next; closest = candidate }
  }
  return { ...closest }
}

/** One shared outline is used for rendering, binding, and pointer hit testing. */
export function shapeOutline(node: ShapeElement, anchors: Point[] = []): Point[] {
  const { x, y, width: w, height: h } = node
  if (isBraceShape(node.shape)) return braceOutline(node)
  const radius = rectangleCornerRadius(node)
  if (radius) return roundedRectangleOutline(node, radius, anchors)
  let points: Point[]
  if (node.shape === 'ellipse') return Array.from({ length: 64 }, (_, index) => { const angle = index * Math.PI / 32; return { x: x + w / 2 + Math.cos(angle) * w / 2, y: y + h / 2 + Math.sin(angle) * h / 2 } })
  if (node.shape === 'diamond') points = [{ x: .5, y: 0 }, { x: 1, y: .5 }, { x: .5, y: 1 }, { x: 0, y: .5 }]
  else if (node.shape === 'triangle') points = [{ x: .5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  else if (node.shape === 'hexagon') points = [{ x: .25, y: 0 }, { x: .75, y: 0 }, { x: 1, y: .5 }, { x: .75, y: 1 }, { x: .25, y: 1 }, { x: 0, y: .5 }]
  else if (node.shape === 'parallelogram') points = [{ x: .22, y: 0 }, { x: 1, y: 0 }, { x: .78, y: 1 }, { x: 0, y: 1 }]
  else if (node.shape === 'star') {
    points = Array.from({ length: 10 }, (_, index) => { const angle = -Math.PI / 2 + index * Math.PI / 5, radius = index % 2 ? .43 : 1; return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius } })
    return normalizedOutline(points, node)
  } else if (node.shape === 'cylinder') {
    const cap = Math.min(h * .18, w * .18)
    points = [{ x: x + w, y: y + cap }, { x: x + w, y: y + h - cap }]
    for (let index = 1; index <= 24; index++) { const angle = index * Math.PI / 24; points.push({ x: x + w / 2 + Math.cos(angle) * w / 2, y: y + h - cap + Math.sin(angle) * cap }) }
    points.push({ x, y: y + cap })
    for (let index = 1; index < 24; index++) { const angle = Math.PI + index * Math.PI / 24; points.push({ x: x + w / 2 + Math.cos(angle) * w / 2, y: y + cap + Math.sin(angle) * cap }) }
    return points
  } else if (node.shape === 'cloud') {
    const curves = [
      [.22, .92, .08, .92, 0, .83, 0, .70], [0, .70, 0, .57, .06, .48, .16, .45],
      [.16, .45, .12, .35, .13, .26, .20, .20], [.20, .20, .28, .12, .40, .14, .47, .21],
      [.47, .21, .52, .07, .61, 0, .73, .03], [.73, .03, .86, .05, .93, .16, .91, .29],
      [.91, .29, 1, .32, 1, .44, .97, .53], [.97, .53, 1, .58, 1, .65, .99, .70],
      [.99, .70, .99, .84, .89, .92, .77, .92],
    ]
    points = []
    for (const curve of curves) for (let step = 0; step < 12; step++) { const t = step / 12, u = 1 - t; points.push({ x: u ** 3 * curve[0]! + 3 * u * u * t * curve[2]! + 3 * u * t * t * curve[4]! + t ** 3 * curve[6]!, y: u ** 3 * curve[1]! + 3 * u * u * t * curve[3]! + 3 * u * t * t * curve[5]! + t ** 3 * curve[7]! }) }
    points.push({ x: .77, y: .92 })
    return normalizedOutline(points, node)
  } else points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  return points.map(p => ({ x: x + p.x * w, y: y + p.y * h }))
}
export function shapeContainsPoint(node: ShapeElement, point: Point): boolean {
  if (node.width <= 0 || node.height <= 0) return false
  const radius = rectangleCornerRadius(node)
  if (radius) return roundedRectangleDistance(node, point, radius) <= 1e-10
  if (isBraceShape(node.shape)) return outlineDistance(node, point) <= Math.max(0.25, node.style.strokeWidth / 2)
  if (node.shape === 'ellipse') return ((point.x - node.x - node.width / 2) / (node.width / 2)) ** 2 + ((point.y - node.y - node.height / 2) / (node.height / 2)) ** 2 <= 1 + 1e-10
  return pointInPolygon(point, shapeOutline(node))
}
/** Exterior distance; a frame's empty interior deliberately is not an attachment target. */
export function outlineDistance(node: ShapeElement, point: Point): number {
  const radius = rectangleCornerRadius(node)
  if (radius) return Math.max(0, roundedRectangleDistance(node, point, radius))
  if (node.shape !== 'frame' && !isBraceShape(node.shape) && shapeContainsPoint(node, point)) return 0
  if (node.shape === 'ellipse') {
    const rx = node.width / 2, ry = node.height / 2, x = Math.abs(point.x - node.x - rx), y = Math.abs(point.y - node.y - ry), xx = rx * rx, yy = ry * ry
    const equation = (t: number) => (rx * x / (t + xx)) ** 2 + (ry * y / (t + yy)) ** 2
    let low = 0, high = Math.max(rx * x, ry * y, 1)
    while (equation(high) > 1) high *= 2
    for (let i = 0; i < 52; i++) { const middle = (low + high) / 2; if (equation(middle) > 1) low = middle; else high = middle }
    const t = (low + high) / 2
    return Math.hypot(x - xx * x / (t + xx), y - yy * y / (t + yy))
  }
  const points = shapeOutline(node)
  let minimum = Infinity
  const segments = isBraceShape(node.shape) ? points.length - 1 : points.length
  for (let i = 0; i < segments; i++) minimum = Math.min(minimum, distanceToSegment(point, points[i]!, points[(i + 1) % points.length]!))
  return minimum
}
/** Ray/shape intersection makes an edge follow its node without storing stale anchors. */
export function shapeAnchor(node: ShapeElement, toward: Point): Point {
  if (isBraceShape(node.shape)) return nearestOnPolyline(shapeOutline(node), toward)
  const c = center(node), dx = toward.x - c.x, dy = toward.y - c.y
  if (!dx && !dy) return shapeAnchor(node, { x: c.x, y: c.y + 1 })
  const radius = rectangleCornerRadius(node)
  if (radius) {
    const length = Math.hypot(dx, dy), vx = Math.abs(dx) / length, vy = Math.abs(dy) / length
    const rx = node.width / 2, ry = node.height / 2, cx = rx - radius, cy = ry - radius
    let distance = Math.min(vx ? rx / vx : Infinity, vy ? ry / vy : Infinity)
    if (vx * distance > cx && vy * distance > cy) {
      const projection = vx * cx + vy * cy, perpendicular = vx * cy - vy * cx
      distance = projection + Math.sqrt(Math.max(0, radius * radius - perpendicular * perpendicular))
    }
    return { x: c.x + dx / length * distance, y: c.y + dy / length * distance }
  }
  if (!['rectangle', 'ellipse', 'diamond', 'note', 'text', 'image', 'frame'].includes(node.shape)) {
    const points = shapeOutline(node)
    let distance = Infinity
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!, vx = b.x - a.x, vy = b.y - a.y, denominator = dx * vy - dy * vx
      if (Math.abs(denominator) < 1e-12) continue
      const t = ((a.x - c.x) * vy - (a.y - c.y) * vx) / denominator, u = ((a.x - c.x) * dy - (a.y - c.y) * dx) / denominator
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) distance = Math.min(distance, t)
    }
    if (Number.isFinite(distance)) return { x: c.x + dx * distance, y: c.y + dy * distance }
  }
  const rx = Math.max(1, node.width / 2), ry = Math.max(1, node.height / 2)
  const t = node.shape === 'ellipse' ? 1 / Math.sqrt(dx * dx / (rx * rx) + dy * dy / (ry * ry))
    : node.shape === 'diamond' ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
    : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity)
  return { x: c.x + dx * t, y: c.y + dy * t }
}
/** Strict interior intersection: touching an outline at an anchor is allowed. */
function routeCrossesBounds(points: Point[], bounds: Bounds, skipFirst = false, skipLast = false): boolean {
  const epsilon = 1e-7, right = bounds.x + bounds.width, bottom = bounds.y + bounds.height
  for (let index = 1; index < points.length; index++) {
    if ((skipFirst && index === 1) || (skipLast && index === points.length - 1)) continue
    const a = points[index - 1]!, b = points[index]!
    if (a.x === b.x && a.x > bounds.x + epsilon && a.x < right - epsilon && Math.max(a.y, b.y) > bounds.y + epsilon && Math.min(a.y, b.y) < bottom - epsilon) return true
    if (a.y === b.y && a.y > bounds.y + epsilon && a.y < bottom - epsilon && Math.max(a.x, b.x) > bounds.x + epsilon && Math.min(a.x, b.x) < right - epsilon) return true
  }
  return false
}
/** Try four bounded outside lanes when an orthogonal edge crosses a node. */
function avoidNodeObstacles(points: Point[], fromNode: ShapeElement, toNode: ShapeElement, shapes: ShapeElement[]): Point[] {
  // Captions and enclosing frames must not turn an ordinary edge into a diagram-sized detour.
  const obstacles = shapes.filter(node => node !== fromNode && node !== toNode && node.shape !== 'text' && node.shape !== 'frame' && !isBraceShape(node.shape))
  if (!obstacles.some(node => routeCrossesBounds(points, node))) return points
  const bounds = combineBounds([fromNode, toNode, ...obstacles]), fromCenter = center(fromNode), toCenter = center(toNode)
  const candidates: Point[][] = []
  for (const y of [bounds.y - 44, bounds.y + bounds.height + 44]) {
    const from = shapeAnchor(fromNode, { x: fromCenter.x, y }), to = shapeAnchor(toNode, { x: toCenter.x, y })
    candidates.push([from, { x: from.x, y }, { x: to.x, y }, to])
  }
  for (const x of [bounds.x - 44, bounds.x + bounds.width + 44]) {
    const from = shapeAnchor(fromNode, { x, y: fromCenter.y }), to = shapeAnchor(toNode, { x, y: toCenter.y })
    candidates.push([from, { x, y: from.y }, { x, y: to.y }, to])
  }
  let shortest = Infinity, result = points
  for (const candidate of candidates) {
    if (obstacles.some(node => routeCrossesBounds(candidate, { x: node.x - 6, y: node.y - 6, width: node.width + 12, height: node.height + 12 }))) continue
    // A departure may touch its own bounding box for nonrectangular shapes, but the
    // rest of the detour must not pass through either endpoint node.
    if (routeCrossesBounds(candidate, fromNode, true) || routeCrossesBounds(candidate, toNode, false, true)) continue
    let length = 0
    for (let index = 1; index < candidate.length; index++) length += Math.abs(candidate[index]!.x - candidate[index - 1]!.x) + Math.abs(candidate[index]!.y - candidate[index - 1]!.y)
    if (length < shortest) { shortest = length; result = candidate }
  }
  return result
}
export function edgePoints(edge: EdgeElement, scene: Scene): Point[] {
  const shapes = scene.elements.filter((item): item is ShapeElement => item.type === 'shape')
  const fromNode = shapes.find(n => n.id === edge.from.nodeId), toNode = shapes.find(n => n.id === edge.to.nodeId)
  const fromCenter = fromNode ? center(fromNode) : edge.from, toCenter = toNode ? center(toNode) : edge.to
  if (fromNode && fromNode === toNode) {
    const right = fromNode.x + fromNode.width + 44, top = fromNode.y - 32
    const start = shapeAnchor(fromNode, { x: right, y: fromCenter.y }), end = shapeAnchor(fromNode, { x: fromCenter.x, y: top })
    return [start, { x: right, y: start.y }, { x: right, y: top }, { x: end.x, y: top }, end]
  }
  if (edge.route === 'orthogonal') {
    const horizontal = Math.abs(toCenter.x - fromCenter.x) > Math.abs(toCenter.y - fromCenter.y)
    const returning = horizontal ? fromCenter.x > toCenter.x : fromCenter.y > toCenter.y
    const finishRoute = (points: Point[]) => fromNode && toNode ? avoidNodeObstacles(points, fromNode, toNode, shapes) : points
    if (fromNode && toNode) {
      const reverse = scene.elements.some(other => other.type === 'edge' && other.id !== edge.id && other.from.nodeId === toNode.id && other.to.nodeId === fromNode.id)
      // Keep the forward route direct and put its reciprocal on a separate outside lane.
      // Cardinal anchors remain on the real outline for rectangles, diamonds, and ellipses.
      if (reverse && returning) {
        if (horizontal) {
          const y = Math.min(fromNode.y, toNode.y) - 44
          const from = shapeAnchor(fromNode, { x: fromCenter.x, y }), to = shapeAnchor(toNode, { x: toCenter.x, y })
          return finishRoute([from, { x: from.x, y }, { x: to.x, y }, to])
        }
        const x = Math.max(fromNode.x + fromNode.width, toNode.x + toNode.width) + 44
        const from = shapeAnchor(fromNode, { x, y: fromCenter.y }), to = shapeAnchor(toNode, { x, y: toCenter.y })
        return finishRoute([from, { x, y: from.y }, { x, y: to.y }, to])
      }
      // A return from the lower-right branch leaves its top and enters the earlier
      // step on the right, rather than retracing the branch's left-side incoming line.
      if (fromCenter.x > toNode.x + toNode.width && fromNode.y > toCenter.y) {
        const from = shapeAnchor(fromNode, { x: fromCenter.x, y: toCenter.y }), to = shapeAnchor(toNode, { x: fromCenter.x, y: toCenter.y })
        return finishRoute([from, { x: from.x, y: to.y }, to])
      }
    }
    const from = fromNode ? shapeAnchor(fromNode, horizontal ? { x: toCenter.x, y: fromCenter.y } : { x: fromCenter.x, y: toCenter.y }) : fromCenter
    const to = toNode ? shapeAnchor(toNode, horizontal ? { x: fromCenter.x, y: toCenter.y } : { x: toCenter.x, y: fromCenter.y }) : toCenter
    if (horizontal) { const x = (from.x + to.x) / 2; return finishRoute([from, { x, y: from.y }, { x, y: to.y }, to]) }
    const y = (from.y + to.y) / 2; return finishRoute([from, { x: from.x, y }, { x: to.x, y }, to])
  }
  return [fromNode ? shapeAnchor(fromNode, toCenter) : fromCenter, toNode ? shapeAnchor(toNode, fromCenter) : toCenter]
}
export function sceneBounds(scene: Scene): Bounds {
  return combineBounds(scene.elements.map(element => {
    if (element.type !== 'edge') return elementBounds(element)
    const points = edgePoints(element, scene), bounds = elementBounds({ ...element, type: 'stroke', points })
    if (!element.label) return bounds
    const midpoint = pathMidpoint(points), width = [...element.label].reduce((total, character) => total + (/[\u0000-\u007f]/.test(character) ? 0.65 : 1.05) * element.style.fontSize, 0)
    return combineBounds([bounds, { x: midpoint.x - width / 2 - 4, y: midpoint.y - 12 - element.style.fontSize, width: width + 8, height: element.style.fontSize * 1.4 + 6 }])
  }))
}
export function pointInside(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
}
export function snap(value: number, enabled: boolean, step = 20): number { return enabled ? Math.round(value / step) * step : value }
export function pointsPath(points: Point[]): string { return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') }
export function pathMidpoint(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 }
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  let remainder = lengths.reduce((a, b) => a + b, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (length && remainder <= length) { const a = points[i]!, b = points[i + 1]!; return { x: a.x + (b.x - a.x) * remainder / length, y: a.y + (b.y - a.y) * remainder / length } }
    remainder -= length
  }
  return points[0]!
}
