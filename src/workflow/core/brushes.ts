import type { BrushKind, Point, StrokeElement } from './types.ts'

export const BRUSH_PRESETS: readonly { id: BrushKind; label: string; width: number; opacity: number; color?: string }[] = [
  { id: 'pen', label: '圆头笔', width: 2.5, opacity: 1 },
  { id: 'pencil', label: '铅笔', width: 2, opacity: 1 },
  { id: 'marker', label: '马克笔', width: 12, opacity: 1 },
  { id: 'brush', label: '毛笔', width: 10, opacity: 1 },
  { id: 'highlighter', label: '荧光笔', width: 22, opacity: 1, color: '#facc15' },
  { id: 'rainbow', label: '彩虹笔', width: 6, opacity: 1 },
]
export function isBrushKind(value: unknown): value is BrushKind { return BRUSH_PRESETS.some(preset => preset.id === value) }
export function brushPreset(kind: BrushKind) { return BRUSH_PRESETS.find(preset => preset.id === kind) ?? BRUSH_PRESETS[0]! }
export function normalizedPressure(value: unknown, fallback = .5): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback }
/** Validate metadata separately so native and interchange readers share the same limits. */
export function readBrushData(brush: unknown, pressures: unknown, count: number): { brush?: BrushKind; pressures?: number[] } {
  if (brush !== undefined && !isBrushKind(brush)) throw new Error('笔触类型不受支持。')
  if (pressures !== undefined) {
    if (!Array.isArray(pressures) || pressures.length !== count || count > 100000) throw new Error('笔迹压感应与坐标逐点对应，且数值介于 0 与 1。')
    for (const pressure of pressures) if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure < 0 || pressure > 1) throw new Error('笔迹压感应与坐标逐点对应，且数值介于 0 与 1。')
  }
  return { ...(brush === undefined ? {} : { brush }), ...(pressures === undefined ? {} : { pressures: [...pressures as number[]] }) }
}
export function brushRadiusAt(stroke: StrokeElement, index: number): number {
  const radius = Math.max(0, Math.min(100, stroke.style.strokeWidth)) / 2
  if (!stroke.brush && !stroke.pressures) return radius
  const pressure = normalizedPressure(stroke.pressures?.[index])
  if (stroke.brush === 'brush') {
    const taper = stroke.closed || stroke.points.length === 1 ? 1 : Math.min(1, .25 + Math.min(index + 1, stroke.points.length - index) * .15)
    return radius * (.16 + .84 * pressure) * taper
  }
  if (stroke.brush === 'marker' || stroke.brush === 'highlighter') return radius * (.8 + .4 * pressure)
  return radius * (.65 + .7 * pressure)
}
const coordinate = (n: number): string => String(Math.round(n * 1000) / 1000)
const pair = (point: Point): string => `${coordinate(point.x)} ${coordinate(point.y)}`
export function brushPolyline(points: readonly Point[]): string { return points.map((point, index) => `${index ? 'L' : 'M'}${pair(point)}`).join(' ') }
/** A linear-size outline, with an elliptical nib for the flat marker. */
export function brushOutlinePath(stroke: StrokeElement): string {
  const points = stroke.points, count = points.length
  if (!count) return ''
  if (count === 1 || points.every(point => point.x === points[0]!.x && point.y === points[0]!.y)) {
    const p = points[0]!
    let r = 0
    for (let index = 0; index < count; index++) r = Math.max(r, brushRadiusAt(stroke, index))
    return `M${coordinate(p.x - r)} ${coordinate(p.y)} a${coordinate(r)} ${coordinate(r)} 0 1 0 ${coordinate(r * 2)} 0 a${coordinate(r)} ${coordinate(r)} 0 1 0 ${coordinate(-r * 2)} 0 Z`
  }
  const left: Point[] = [], right: Point[] = []
  for (let index = 0; index < count; index++) {
    const point = points[index]!, before = points[index ? index - 1 : stroke.closed ? count - 1 : 0]!, after = points[index + 1 < count ? index + 1 : stroke.closed ? 0 : count - 1]!
    let dx = after.x - before.x, dy = after.y - before.y
    if (!dx && !dy) { dx = after.x - point.x || point.x - before.x; dy = after.y - point.y || point.y - before.y }
    const length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length, radius = brushRadiusAt(stroke, index)
    let ox = nx * radius, oy = ny * radius
    if (stroke.brush === 'marker') {
      // Fixed diagonal ellipse: its support point makes direction-sensitive broad and fine strokes.
      const xx = .56125, xy = .43875, support = Math.sqrt(xx * nx * nx + 2 * xy * nx * ny + xx * ny * ny) || 1
      ox = radius * (xx * nx + xy * ny) / support; oy = radius * (xy * nx + xx * ny) / support
    }
    left.push({ x: point.x + ox, y: point.y + oy }); right.push({ x: point.x - ox, y: point.y - oy })
  }
  if (stroke.closed) return `${brushPolyline(left)} Z ${brushPolyline(right.reverse())} Z`
  const firstRadius = coordinate(brushRadiusAt(stroke, 0)), lastRadius = coordinate(brushRadiusAt(stroke, count - 1))
  const capEnd = stroke.brush === 'marker' ? `L${pair(right[count - 1]!)}` : `A${lastRadius} ${lastRadius} 0 0 0 ${pair(right[count - 1]!)}`
  const capStart = stroke.brush === 'marker' ? `L${pair(left[0]!)}` : `A${firstRadius} ${firstRadius} 0 0 0 ${pair(left[0]!)}`
  return `${brushPolyline(left)} ${capEnd} ${right.reverse().slice(1).map(point => `L${pair(point)}`).join(' ')} ${capStart} Z`
}

/** Indices refer to the original gesture; a closed gesture may end at points.length (point 0). */
export interface BrushPaintPass { path: string; start: number; end: number }
interface InkSample { point: Point; radius: number; index: number; distance: number }
interface InkSegment {
  a: InkSample; b: InkSample; index: number
  minX: number; minY: number; maxX: number; maxY: number
  minRadius: number; maxRadius: number
}
interface InkIndex {
  minX: number; minY: number; maxX: number; maxY: number
  firstDistance: number; lastDistance: number; minRadius: number; size: number
  segment?: InkSegment; left?: InkIndex; right?: InkIndex
}
function inkSegment(a: InkSample, b: InkSample, index: number): InkSegment {
  const maxRadius = Math.max(a.radius, b.radius)
  return { a, b, index, minX: Math.min(a.point.x, b.point.x) - maxRadius, minY: Math.min(a.point.y, b.point.y) - maxRadius,
    maxX: Math.max(a.point.x, b.point.x) + maxRadius, maxY: Math.max(a.point.y, b.point.y) + maxRadius,
    minRadius: Math.min(a.radius, b.radius), maxRadius }
}
/** A forest of balanced bounds trees: each recorded segment is merged only logarithmically. */
function indexInk(roots: InkIndex[], segment: InkSegment): void {
  let node: InkIndex = { ...segment, firstDistance: segment.a.distance, lastDistance: segment.b.distance, size: 1, segment }
  while (roots.length && roots[roots.length - 1]!.size === node.size) {
    const left = roots.pop()!, right = node
    node = { minX: Math.min(left.minX, right.minX), minY: Math.min(left.minY, right.minY), maxX: Math.max(left.maxX, right.maxX), maxY: Math.max(left.maxY, right.maxY),
      firstDistance: left.firstDistance, lastDistance: right.lastDistance, minRadius: Math.min(left.minRadius, right.minRadius), size: left.size + right.size, left, right }
  }
  roots.push(node)
}
function segmentsTouch(a: InkSegment, b: InkSegment, total: number, closed: boolean): boolean {
  // Closest points on two finite segments, including collinear and zero-length projections.
  const ux = a.b.point.x - a.a.point.x, uy = a.b.point.y - a.a.point.y
  const vx = b.b.point.x - b.a.point.x, vy = b.b.point.y - b.a.point.y
  const wx = a.a.point.x - b.a.point.x, wy = a.a.point.y - b.a.point.y
  const aa = ux * ux + uy * uy, bb = ux * vx + uy * vy, cc = vx * vx + vy * vy, dd = ux * wx + uy * wy, ee = vx * wx + vy * wy
  const determinant = aa * cc - bb * bb
  let s = determinant > aa * cc * 1e-12 ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / determinant)) : 0
  let t = cc ? (bb * s + ee) / cc : 0
  if (t < 0) { t = 0; s = aa ? Math.max(0, Math.min(1, -dd / aa)) : 0 }
  else if (t > 1) { t = 1; s = aa ? Math.max(0, Math.min(1, (bb - dd) / aa)) : 0 }
  const overlapsAt = (atA: number, atB: number): boolean => {
    const radius = a.a.radius + (a.b.radius - a.a.radius) * atA + b.a.radius + (b.b.radius - b.a.radius) * atB
    const gap = b.a.distance + (b.b.distance - b.a.distance) * atB - a.a.distance - (a.b.distance - a.a.distance) * atA
    if (gap <= 2 * radius || closed && total - gap <= 2 * radius) return false
    return Math.hypot(wx + atA * ux - atB * vx, wy + atA * uy - atB * vy) < radius - 1e-6
  }
  if (overlapsAt(s, t)) return true
  // Parallel returns have many equally close points. A local corner must not hide
  // the remote part of the same pair of long segments (e.g. a narrow U-shaped mark).
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return overlapsAt(0, cc ? clamp(ee / cc) : 0) || overlapsAt(1, cc ? clamp((bb + ee) / cc) : 0)
    || overlapsAt(aa ? clamp(-dd / aa) : 0, 0) || overlapsAt(aa ? clamp((bb - dd) / aa) : 0, 1)
}
function inkReturns(roots: InkIndex[], current: InkSegment, total: number, closed: boolean): boolean {
  const stack = [...roots]
  let visited = 0
  while (stack.length) {
    const node = stack.pop()!
    if (node.minX > current.maxX || node.maxX < current.minX || node.minY > current.maxY || node.maxY < current.minY) continue
    // Neighbouring samples are one application of ink, even when sampled very densely.
    const local = 2 * (node.minRadius + current.minRadius)
    if (current.b.distance - node.firstDistance <= local) continue
    if (closed && total - current.a.distance + node.lastDistance <= local) continue
    // A bounded search also handles malicious, densely oscillating imported gestures.
    // A conservative split retains all geometry instead of dropping points or blocking input.
    if (++visited > 512) return true
    if (node.segment) {
      const previous = node.segment
      if (previous.index + 1 === current.index) continue
      if (segmentsTouch(previous, current, total, closed)) return true
    } else { stack.push(node.left!, node.right!) }
  }
  return false
}
function sampleOffset(stroke: StrokeElement, sample: InkSample, before: Point, after: Point): Point {
  const inX = sample.point.x - before.x, inY = sample.point.y - before.y, outX = after.x - sample.point.x, outY = after.y - sample.point.y
  const inLength = Math.hypot(inX, inY) || 1, outLength = Math.hypot(outX, outY) || 1
  // Bisect directions rather than lengths: a sparse long segment must not flatten
  // its shorter neighbour's two cross sections onto that neighbour's centre line.
  let dx = inX / inLength + outX / outLength, dy = inY / inLength + outY / outLength
  if (!dx && !dy) { dx = after.x - sample.point.x || sample.point.x - before.x; dy = after.y - sample.point.y || sample.point.y - before.y }
  const length = Math.hypot(dx, dy) || 1, nx = -dy / length, ny = dx / length
  if (stroke.brush === 'marker') {
    const xx = .56125, xy = .43875, support = Math.sqrt(xx * nx * nx + 2 * xy * nx * ny + xx * ny * ny) || 1
    return { x: sample.radius * (xx * nx + xy * ny) / support, y: sample.radius * (xy * nx + xx * ny) / support }
  }
  return { x: nx * sample.radius, y: ny * sample.radius }
}
function markerPaintPath(stroke: StrokeElement, samples: InkSample[], start: number, end: number, split: boolean, reversals: Set<number>): string {
  const last = samples.length - 1, closed = stroke.closed === true, parts: string[] = []
  const at = (index: number) => samples[index]!
  const previous = (index: number) => at(index ? index - 1 : last - 1)
  const next = (index: number) => at(index < last ? index + 1 : 1)
  const cutStart = start > 0 || closed && split, cutEnd = end < last || closed && split
  const cut = (polygon: Point[], index: number, forward: boolean): Point[] => {
    if (reversals.has(index)) return polygon
    const center = at(index).point, before = previous(index).point, after = next(index).point
    const inLength = Math.hypot(center.x - before.x, center.y - before.y) || 1, outLength = Math.hypot(after.x - center.x, after.y - center.y) || 1
    const dx = (center.x - before.x) / inLength + (after.x - center.x) / outLength
    const dy = (center.y - before.y) / inLength + (after.y - center.y) / outLength
    const side = (point: Point) => ((point.x - center.x) * dx + (point.y - center.y) * dy) * (forward ? 1 : -1)
    const result: Point[] = []
    let a = polygon[polygon.length - 1]!, da = side(a)
    for (const b of polygon) {
      const db = side(b)
      if (da < 0 !== db < 0) { const t = da / (da - db); result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) }
      if (db >= 0) result.push(b)
      a = b; da = db
    }
    return result
  }
  const emit = (polygon: Point[]) => {
    if (polygon.length < 3) return
    let area = 0
    for (let index = 0; index < polygon.length; index++) { const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!; area += a.x * b.y - b.x * a.y }
    if (Math.abs(area) < 1e-8) return
    // Every component winds the same way: nonzero fill is a union, never an XOR.
    if (area > 0) polygon.reverse()
    parts.push(`${brushPolyline(polygon)} Z`)
  }
  for (let index = start; index < end; index++) {
    const a = at(index), b = at(index + 1)
    const ao = sampleOffset(stroke, a, a.point, b.point), bo = sampleOffset(stroke, b, a.point, b.point)
    let polygon = [{ x: a.point.x + ao.x, y: a.point.y + ao.y }, { x: b.point.x + bo.x, y: b.point.y + bo.y },
      { x: b.point.x - bo.x, y: b.point.y - bo.y }, { x: a.point.x - ao.x, y: a.point.y - ao.y }]
    if (index === start && cutStart) polygon = cut(polygon, start, true)
    if (index + 1 === end && cutEnd && polygon.length) polygon = cut(polygon, end, false)
    emit(polygon)
  }
  for (let index = start; index <= end; index++) {
    if (!closed && (index === 0 || index === last) || closed && !split && index === last) continue
    const sample = at(index), point = sample.point
    const incoming = sampleOffset(stroke, sample, previous(index).point, point), outgoing = sampleOffset(stroke, sample, point, next(index).point)
    // Connect the two elliptical support edges inside the nib. A single support
    // point at a sharp turn can swap the sides of a flat nib and pinch a long line.
    let polygon = [{ x: point.x + incoming.x, y: point.y + incoming.y }, { x: point.x + outgoing.x, y: point.y + outgoing.y },
      { x: point.x - incoming.x, y: point.y - incoming.y }, { x: point.x - outgoing.x, y: point.y - outgoing.y }]
    if (index === start && cutStart) polygon = cut(polygon, start, true)
    if (index === end && cutEnd && polygon.length) polygon = cut(polygon, end, false)
    emit(polygon)
  }
  return parts.join(' ')
}
/**
 * Paint each return over earlier ink separately, but keep consecutive samples in one fill.
 * Shared cross sections and flat internal caps avoid darker dots at the split boundaries.
 * Radius/taper and ordinary normals always come from the complete original gesture.
 */
export function brushPaintPasses(stroke: StrokeElement): BrushPaintPass[] {
  if (!stroke.points.length) return []
  const samples: InkSample[] = []
  let distance = 0
  for (let index = 0; index < stroke.points.length; index++) {
    const point = stroke.points[index]!, radius = brushRadiusAt(stroke, index), previous = samples[samples.length - 1]
    if (previous && previous.point.x === point.x && previous.point.y === point.y) { previous.radius = Math.max(previous.radius, radius); continue }
    if (previous) distance += Math.hypot(point.x - previous.point.x, point.y - previous.point.y)
    samples.push({ point, radius, index, distance })
  }
  if (samples.length < 2) return [{ path: brushOutlinePath(stroke), start: 0, end: stroke.points.length - 1 }]
  const closed = stroke.closed === true
  if (closed) {
    const first = samples[0]!, last = samples[samples.length - 1]!
    distance += Math.hypot(first.point.x - last.point.x, first.point.y - last.point.y)
    if (last.point.x === first.point.x && last.point.y === first.point.y) { first.radius = last.radius = Math.max(first.radius, last.radius); last.index = stroke.points.length }
    else samples.push({ ...first, index: stroke.points.length, distance })
  }
  const lastIndex = samples.length - 1, roots: InkIndex[] = [], cuts = [0], reversals = new Set<number>()
  const reverses = (previous: Point, at: Point, next: Point): boolean => {
    const ax = at.x - previous.x, ay = at.y - previous.y, bx = next.x - at.x, by = next.y - at.y
    return ax * bx + ay * by < -.95 * Math.hypot(ax, ay) * Math.hypot(bx, by)
  }
  if (closed && reverses(samples[lastIndex - 1]!.point, samples[0]!.point, samples[1]!.point)) { reversals.add(0); reversals.add(lastIndex) }
  for (let index = 0; index < lastIndex; index++) {
    const current = inkSegment(samples[index]!, samples[index + 1]!, index)
    const reversal = index > 0 && reverses(samples[index - 1]!.point, samples[index]!.point, samples[index + 1]!.point)
    if (index > cuts[cuts.length - 1]! && (reversal || inkReturns(roots, current, distance, closed))) {
      cuts.push(index); roots.length = 0
      if (reversal) reversals.add(index)
    }
    indexInk(roots, current)
  }
  cuts.push(lastIndex)
  const offsets = samples.map((sample, index) => sampleOffset(stroke, sample,
    samples[index ? index - 1 : closed ? lastIndex - 1 : 0]!.point,
    samples[index < lastIndex ? index + 1 : closed ? 1 : lastIndex]!.point))
  const result: BrushPaintPass[] = []
  for (let part = 0; part < cuts.length - 1; part++) {
    const start = cuts[part]!, end = cuts[part + 1]!, left: Point[] = [], right: Point[] = []
    const startPoint = start === 0 ? 0 : samples[start]!.index, endPoint = end === lastIndex ? closed ? stroke.points.length : stroke.points.length - 1 : samples[end]!.index
    if (stroke.brush === 'marker') {
      result.push({ path: markerPaintPath(stroke, samples, start, end, cuts.length > 2, reversals), start: startPoint, end: endPoint }); continue
    }
    for (let index = start; index <= end; index++) {
      const sample = samples[index]!
      // At a U-turn, incoming and outgoing tangents use the same physical cross section
      // in opposite directions; averaging them would fold the outline into a bow-tie.
      const offset = reversals.has(index) && (index === start || index === end)
        ? sampleOffset(stroke, sample, samples[index === start ? index : index - 1]!.point, samples[index === start ? index + 1 : index]!.point)
        : offsets[index]!
      left.push({ x: sample.point.x + offset.x, y: sample.point.y + offset.y }); right.push({ x: sample.point.x - offset.x, y: sample.point.y - offset.y })
    }
    let path: string
    if (closed && cuts.length === 2) path = `${brushPolyline(left)} Z ${brushPolyline(right.reverse())} Z`
    else {
      const endRadius = coordinate(samples[end]!.radius), startRadius = coordinate(samples[start]!.radius)
      const capEnd = !closed && end === lastIndex ? `A${endRadius} ${endRadius} 0 0 0 ${pair(right[right.length - 1]!)}` : `L${pair(right[right.length - 1]!)}`
      const capStart = !closed && start === 0 ? `A${startRadius} ${startRadius} 0 0 0 ${pair(left[0]!)}` : `L${pair(left[0]!)}`
      path = `${brushPolyline(left)} ${capEnd} ${right.reverse().slice(1).map(point => `L${pair(point)}`).join(' ')} ${capStart} Z`
    }
    result.push({ path, start: startPoint, end: endPoint })
  }
  return result
}
/** At most 96 colored chunks, distributed by travelled distance rather than screen axes. */
export function rainbowSegments(stroke: StrokeElement): { path: string; hue: number; points: Point[]; pressures: number[] }[] {
  const points = stroke.closed ? [...stroke.points, stroke.points[0]!] : stroke.points
  const pressures = points.map((_, index) => normalizedPressure(stroke.pressures?.[index % stroke.points.length]))
  if (points.length < 2) return [{ path: brushPolyline(points), hue: 0, points, pressures }]
  let length = 0
  for (let index = 1; index < points.length; index++) length += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y)
  if (!length) return [{ path: brushPolyline(points), hue: 0, points, pressures }]
  const count = Math.max(6, Math.min(96, Math.ceil(length / 10))), step = length / count, result: { path: string; hue: number; points: Point[]; pressures: number[] }[] = []
  let current: Point[] = [points[0]!], currentPressures = [pressures[0]!], travelled = 0, boundary = step
  const emit = () => result.push({ path: brushPolyline(current), hue: result.length / count * 300, points: current, pressures: currentPressures })
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!, segment = Math.hypot(b.x - a.x, b.y - a.y)
    while (segment && boundary < travelled + segment && result.length < count - 1) {
      const t = (boundary - travelled) / segment, point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const pressure = pressures[index - 1]! + (pressures[index]! - pressures[index - 1]!) * t
      current.push(point); currentPressures.push(pressure); emit(); current = [point]; currentPressures = [pressure]; boundary += step
    }
    current.push(b); currentPressures.push(pressures[index]!); travelled += segment
  }
  emit()
  return result
}
/** Distance to the visible ink edge; constant work per recorded point. */
export function brushHit(stroke: StrokeElement, point: Point, halo: number): boolean {
  if (stroke.points.length === 1) return Math.hypot(point.x - stroke.points[0]!.x, point.y - stroke.points[0]!.y) <= brushRadiusAt(stroke, 0) + halo
  const count = stroke.points.length, segments = stroke.closed ? count : count - 1
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % count, a = stroke.points[index]!, b = stroke.points[next]!, dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy
    const t = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0
    const radius = brushRadiusAt(stroke, index) * (1 - t) + brushRadiusAt(stroke, next) * t
    if (Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t) <= radius + halo) return true
  }
  return false
}
