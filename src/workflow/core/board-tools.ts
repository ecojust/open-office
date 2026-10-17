import { newId, type EdgeElement, type Point, type Scene, type SceneElement } from './types.ts'
import { combineBounds, distanceToSegment, edgePoints, elementBounds, outlineDistance, pointInPolygon, pointInside, shapeContainsPoint, type Bounds } from './geometry.ts'
import { brushHit } from './brushes.ts'

/** Return a stable, scene-ordered selection, expanding the scene's flat groups. */
export function expandedSelection(scene: Scene, ids: readonly string[]): string[] {
  const selected = new Set(ids)
  const groups = new Set(scene.elements.filter(element => selected.has(element.id) && element.groupId).map(element => element.groupId!))
  return scene.elements.filter(element => selected.has(element.id) || (element.groupId && groups.has(element.groupId))).map(element => element.id)
}

/** Groups are flat. Regrouping merges selected groups without changing locked members. */
export function groupElements(scene: Scene, ids: readonly string[]): Scene {
  const selected = new Set(expandedSelection(scene, ids))
  const members = scene.elements.filter(element => selected.has(element.id) && !element.locked)
  if (members.length < 2) return scene
  const existing = members[0]!.groupId
  if (existing && members.every(element => element.groupId === existing)) return scene
  const groupId = newId('group')
  const movable = new Set(members.map(element => element.id))
  return { ...scene, elements: scene.elements.map(element => movable.has(element.id) ? { ...element, groupId } : element) }
}

export function ungroupElements(scene: Scene, ids: readonly string[]): Scene {
  const selected = new Set(expandedSelection(scene, ids))
  let changed = false
  const elements = scene.elements.map(element => {
    if (!selected.has(element.id) || element.locked || !element.groupId) return element
    const { groupId: _groupId, ...ungrouped } = element
    changed = true
    return ungrouped
  })
  return changed ? { ...scene, elements } : scene
}

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributionAxis = 'horizontal' | 'vertical'

function renderedBounds(element: SceneElement, scene: Scene): Bounds {
  return element.type === 'edge' ? elementBounds({ type: 'stroke', id: element.id, points: edgePoints(element, scene), style: element.style, locked: element.locked }) : elementBounds(element)
}

interface MoveUnit { elements: SceneElement[]; bounds: Bounds; locked: boolean }

function movementUnits(scene: Scene, ids: readonly string[]): MoveUnit[] {
  const selected = new Set(expandedSelection(scene, ids))
  const nodes = new Set(scene.elements.filter(element => element.type === 'shape').map(element => element.id))
  const groups = new Map<string, SceneElement[]>()
  const units: SceneElement[][] = []
  for (const element of scene.elements) {
    if (!selected.has(element.id)) continue
    // A connector whose two ends are bound follows its nodes. Treating it as an
    // independent object would distort alignment bounds while not moving it.
    if (element.type === 'edge' && !element.groupId && element.from.nodeId && nodes.has(element.from.nodeId) && element.to.nodeId && nodes.has(element.to.nodeId)) continue
    if (!element.groupId) { units.push([element]); continue }
    let group = groups.get(element.groupId)
    if (!group) { group = []; groups.set(element.groupId, group); units.push(group) }
    group.push(element)
  }
  return units.map(elements => ({ elements, bounds: combineBounds(elements.map(element => renderedBounds(element, scene))), locked: elements.some(element => element.locked) }))
}

function translated(element: SceneElement, offset: Point, nodes: Set<string>): SceneElement {
  if (element.locked || (!offset.x && !offset.y)) return element
  if (element.type === 'shape') return { ...element, x: element.x + offset.x, y: element.y + offset.y }
  if (element.type === 'stroke') return { ...element, points: element.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y })) }
  const endpoint = (point: EdgeElement['from']): EdgeElement['from'] => point.nodeId && nodes.has(point.nodeId) ? point : { ...point, x: point.x + offset.x, y: point.y + offset.y }
  const from = endpoint(element.from), to = endpoint(element.to)
  return from === element.from && to === element.to ? element : { ...element, from, to }
}

function applyOffsets(scene: Scene, offsets: Map<string, Point>): Scene {
  const nodes = new Set(scene.elements.filter(element => element.type === 'shape').map(element => element.id))
  let changed = false
  const elements = scene.elements.map(element => {
    const offset = offsets.get(element.id)
    const result = offset ? translated(element, offset, nodes) : element
    changed ||= result !== element
    return result
  })
  return changed ? { ...scene, elements } : scene
}

/** Align groups as rigid units. Locked units contribute a reference but never move. */
export function alignElements(scene: Scene, ids: readonly string[], mode: Alignment): Scene {
  const units = movementUnits(scene, ids)
  if (units.length < 2) return scene
  const fixed = units.filter(unit => unit.locked)
  const bounds = combineBounds((fixed.length ? fixed : units).map(unit => unit.bounds))
  const offsets = new Map<string, Point>()
  for (const unit of units) {
    if (unit.locked) continue
    const b = unit.bounds
    const x = mode === 'left' ? bounds.x - b.x : mode === 'center' ? bounds.x + bounds.width / 2 - b.x - b.width / 2 : mode === 'right' ? bounds.x + bounds.width - b.x - b.width : 0
    const y = mode === 'top' ? bounds.y - b.y : mode === 'middle' ? bounds.y + bounds.height / 2 - b.y - b.height / 2 : mode === 'bottom' ? bounds.y + bounds.height - b.y - b.height : 0
    for (const element of unit.elements) offsets.set(element.id, { x, y })
  }
  return applyOffsets(scene, offsets)
}

/** Equalize edge-to-edge gaps between fixed endpoints, splitting at locked units. */
export function distributeElements(scene: Scene, ids: readonly string[], axis: DistributionAxis): Scene {
  const position = axis === 'horizontal' ? 'x' : 'y'
  const size = axis === 'horizontal' ? 'width' : 'height'
  const units = movementUnits(scene, ids).sort((a, b) => a.bounds[position] - b.bounds[position])
  if (units.length < 3) return scene
  const anchors = units.flatMap((unit, index) => index === 0 || index === units.length - 1 || unit.locked ? [index] : [])
  const offsets = new Map<string, Point>()
  for (let index = 1; index < anchors.length; index++) {
    const first = anchors[index - 1]!, last = anchors[index]!
    if (last - first < 2) continue
    const start = units[first]!.bounds, end = units[last]!.bounds
    let occupied = start[size]
    for (let i = first + 1; i < last; i++) occupied += units[i]!.bounds[size]
    const gap = (end[position] - start[position] - occupied) / (last - first)
    let next = start[position] + start[size] + gap
    for (let i = first + 1; i < last; i++) {
      const unit = units[i]!, delta = next - unit.bounds[position]
      const offset = axis === 'horizontal' ? { x: delta, y: 0 } : { x: 0, y: delta }
      for (const element of unit.elements) offsets.set(element.id, offset)
      next += unit.bounds[size] + gap
    }
  }
  return applyOffsets(scene, offsets)
}

function pathHit(points: readonly Point[], point: Point, tolerance: number, closed = false): boolean {
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y) <= tolerance
  for (let index = 1; index < points.length; index++) if (distanceToSegment(point, points[index - 1]!, points[index]!) <= tolerance) return true
  return closed && points.length > 1 && distanceToSegment(point, points[points.length - 1]!, points[0]!) <= tolerance
}

/** Geometric hit testing in reverse paint order, with a six-screen-pixel halo. */
export function hitTestElement(scene: Scene, point: Point, zoom: number): SceneElement | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  for (let index = scene.elements.length - 1; index >= 0; index--) {
    const element = scene.elements[index]!
    const tolerance = 6 / scale + Math.max(0, element.style.strokeWidth) / 2
    if (element.type === 'shape') {
      if (point.x < element.x - tolerance || point.x > element.x + element.width + tolerance || point.y < element.y - tolerance || point.y > element.y + element.height + tolerance) continue
      if (element.shape === 'frame') {
        const { x, y, width, height } = element
        const titleHeight = Math.min(height, Math.max(28, element.style.fontSize * 1.5 + 12))
        if (pointInside(point, { x, y, width, height: titleHeight }) || pathHit([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], point, tolerance, true)) return element
      } else if (shapeContainsPoint(element, point) || outlineDistance(element, point) <= tolerance) return element
    } else if (element.type === 'edge') {
      if (pathHit(edgePoints(element, scene), point, tolerance)) return element
    } else {
      if (element.brush || element.pressures ? brushHit(element, point, 6 / scale) : pathHit(element.points, point, tolerance, element.closed)) return element
      if (element.closed && element.points.length > 2 && element.style.fill !== 'none' && element.style.fill !== 'transparent' && pointInPolygon(point, element.points)) return element
    }
  }
  return undefined
}

/** Capture fully enclosed contents; connections outside the frame keep following their bound nodes. */
export function frameContents(scene: Scene, frameId: string): string[] {
  const frame = scene.elements.find(element => element.id === frameId)
  if (frame?.type !== 'shape' || frame.shape !== 'frame') return []
  const bounds = elementBounds(frame)
  return scene.elements.filter(element => {
    if (element.id === frameId || (element.type === 'shape' && element.shape === 'frame')) return false
    if (element.type === 'shape') {
      const b = elementBounds(element)
      return pointInside({ x: b.x, y: b.y }, bounds) && pointInside({ x: b.x + b.width, y: b.y + b.height }, bounds)
    }
    const points = element.type === 'edge' ? edgePoints(element, scene) : element.points
    return points.length > 0 && points.every(point => pointInside(point, bounds))
  }).map(element => element.id)
}
