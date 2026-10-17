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
