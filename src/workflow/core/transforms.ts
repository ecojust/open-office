import type { EdgeElement, Point, Scene, SceneElement } from './types.ts'
import { center, combineBounds, edgePoints, elementBounds, normalizedRotation, rotatePoint, type Bounds } from './geometry.ts'

export type SelectionCorner = 'nw' | 'ne' | 'se' | 'sw'
const COORDINATE_LIMIT = 1_000_000

/** Explicit IDs preserve Alt-click's ability to edit one member of a group. */
export function canTransformSelection(scene: Scene, ids: readonly string[]): boolean {
  const selected = new Set(ids), members = scene.elements.filter(element => selected.has(element.id))
  if (!members.length || members.length !== selected.size || members.some(element => element.locked)) return false
  const groups = new Set(members.flatMap(element => element.groupId ? [element.groupId] : []))
  return !scene.elements.some(element => element.locked && element.groupId && groups.has(element.groupId))
}

export function selectionBounds(scene: Scene, ids: readonly string[]): Bounds | undefined {
  const selected = new Set(ids), members = scene.elements.filter(element => selected.has(element.id))
  if (!members.length) return undefined
  const bounds = combineBounds(members.map(element => element.type === 'edge' ? elementBounds({ ...element, type: 'stroke', points: edgePoints(element, scene) }) : elementBounds(element)))
  // A single unadorned point still needs a usable transform box.
  if (!bounds.width && !bounds.height) {
    const size = Math.max(1, ...members.map(element => element.style.strokeWidth))
    return { x: bounds.x - size / 2, y: bounds.y - size / 2, width: size, height: size }
  }
  return bounds
}

function validPoint(point: Point): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y) }
function checkPoint(point: Point): Point {
  if (!validPoint(point) || Math.abs(point.x) > COORDINATE_LIMIT + 1e-7 || Math.abs(point.y) > COORDINATE_LIMIT + 1e-7) throw Error('变换超出画布坐标范围，请缩小选区或移动到画布中间后重试。')
  return { x: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, point.x)), y: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, point.y)) }
}

/** Selected nodes keep their bindings; a selected connector detaches only its outside ends. */
function transformedEdge(edge: EdgeElement, scene: Scene, nodes: Set<string>, transform: (point: Point) => Point): EdgeElement {
  const points = edgePoints(edge, scene)
  const endpoint = (stored: EdgeElement['from'], rendered: Point): EdgeElement['from'] => stored.nodeId && nodes.has(stored.nodeId) ? stored : checkPoint(transform(rendered))
  return { ...edge, from: endpoint(edge.from, points[0]!), to: endpoint(edge.to, points.at(-1)!) }
}

/** Rotate the selection as a unit; unselected connectors continue following their nodes. */
export function rotateSelection(scene: Scene, ids: readonly string[], degrees = 5): Scene {
  const rotation = normalizedRotation(degrees)
  if (!rotation || !canTransformSelection(scene, ids)) return scene
  const bounds = selectionBounds(scene, ids)!, pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const selected = new Set(ids), nodes = new Set(scene.elements.flatMap(element => selected.has(element.id) && element.type === 'shape' ? [element.id] : []))
  const transform = (point: Point) => rotatePoint(point, pivot, rotation)
  const elements = scene.elements.map((element): SceneElement => {
    if (!selected.has(element.id)) return element
    if (element.type === 'shape') {
      const nextCenter = transform(center(element)), nextRotation = normalizedRotation((element.rotation ?? 0) + rotation)
      const { rotation: _oldRotation, ...node } = element
      return { ...node, ...checkPoint({ x: nextCenter.x - element.width / 2, y: nextCenter.y - element.height / 2 }), ...(nextRotation ? { rotation: nextRotation } : {}) }
    }
    if (element.type === 'stroke') return { ...element, points: element.points.map(point => checkPoint(transform(point))) }
    return transformedEdge(element, scene, nodes, transform)
  })
  return { ...scene, elements }
}

export function selectionScaleAnchor(bounds: Bounds, corner: SelectionCorner): Point {
  return { x: corner === 'nw' || corner === 'sw' ? bounds.x + bounds.width : bounds.x, y: corner === 'nw' || corner === 'ne' ? bounds.y + bounds.height : bounds.y }
}

/** Project the pointer onto the original diagonal; crossing the anchor never mirrors objects. */
export function selectionScaleFactor(bounds: Bounds, corner: SelectionCorner, point: Point): number {
  if (!validPoint(bounds) || !validPoint(point) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 0 || bounds.height < 0 || !['nw', 'ne', 'se', 'sw'].includes(corner)) throw Error('缩放位置不是有效数值。')
  const anchor = selectionScaleAnchor(bounds, corner)
  const dx = (corner === 'nw' || corner === 'sw' ? -1 : 1) * bounds.width, dy = (corner === 'nw' || corner === 'ne' ? -1 : 1) * bounds.height
  const length = dx * dx + dy * dy
  return length ? Math.max(1e-6, ((point.x - anchor.x) * dx + (point.y - anchor.y) * dy) / length) : 1
}

/** Scale from a gesture's original scene, with one common clamp for the whole selection. */
export function scaleSelection(scene: Scene, ids: readonly string[], anchor: Point, requestedFactor: number): Scene {
  if (!validPoint(anchor) || !Number.isFinite(requestedFactor) || requestedFactor <= 0) throw Error('缩放比例或锚点不是有效数值。')
  if (!canTransformSelection(scene, ids) || requestedFactor === 1) return scene
  const selected = new Set(ids), members = scene.elements.filter(element => selected.has(element.id))
  const nodes = new Set(members.flatMap(element => element.type === 'shape' ? [element.id] : []))
  let minimum = 1e-6, maximum = Infinity
  const linearLimit = (origin: number, delta: number, low: number, high: number) => {
    if (!delta) { if (origin < low || origin > high) throw Error('选区超出画布范围。'); return }
    const first = (low - origin) / delta, second = (high - origin) / delta
    minimum = Math.max(minimum, Math.min(first, second)); maximum = Math.min(maximum, Math.max(first, second))
  }
  const coordinateLimit = (point: Point) => {
    linearLimit(anchor.x, point.x - anchor.x, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    linearLimit(anchor.y, point.y - anchor.y, -COORDINATE_LIMIT, COORDINATE_LIMIT)
  }
  for (const element of members) {
    linearLimit(0, element.style.fontSize, 1, 500)
    linearLimit(0, element.style.strokeWidth, 0, 100)
    if (element.type === 'shape') {
      coordinateLimit(element); linearLimit(0, element.width, 1, 100_000); linearLimit(0, element.height, 1, 100_000)
      if (element.cornerRadius) linearLimit(0, element.cornerRadius, 0, Number.MAX_VALUE)
    } else if (element.type === 'stroke') element.points.forEach(coordinateLimit)
    else {
      const points = edgePoints(element, scene)
      if (!element.from.nodeId || !nodes.has(element.from.nodeId)) coordinateLimit(points[0]!)
      if (!element.to.nodeId || !nodes.has(element.to.nodeId)) coordinateLimit(points.at(-1)!)
    }
  }
  if (minimum > maximum || maximum <= 0) throw Error('选区超出可缩放范围。')
  const factor = Math.max(minimum, Math.min(maximum, requestedFactor))
  if (Math.abs(factor - 1) < 1e-12) return scene
  const transform = (point: Point): Point => ({ x: anchor.x + (point.x - anchor.x) * factor, y: anchor.y + (point.y - anchor.y) * factor })
  const elements = scene.elements.map((element): SceneElement => {
    if (!selected.has(element.id)) return element
    const style = { ...element.style, fontSize: Math.min(500, Math.max(1, element.style.fontSize * factor)), strokeWidth: Math.min(100, element.style.strokeWidth * factor) }
    if (element.type === 'shape') return { ...element, ...checkPoint(transform(element)), width: Math.min(100_000, Math.max(1, element.width * factor)), height: Math.min(100_000, Math.max(1, element.height * factor)), style, ...(element.cornerRadius ? { cornerRadius: element.cornerRadius * factor } : {}) }
    if (element.type === 'stroke') return { ...element, points: element.points.map(point => checkPoint(transform(point))), style }
    return { ...transformedEdge(element, scene, nodes, transform), style }
  })
  return { ...scene, elements }
}
