import type { Point, Scene, ShapeElement } from './types.ts'
import { elementBounds, outlineDistance } from './geometry.ts'

/** The attraction area remains fourteen screen pixels at every canvas zoom. */
export const BINDING_DISTANCE_PX = 14

/**
 * Prefer the topmost actual interior hit; otherwise select the closest outline.
 * Equal exterior distances use reverse z-order. Locking protects edits, not
 * whether other elements may connect to a node. Standalone text is not a node.
 */
export function findBindingTarget(scene: Scene, point: Point, zoom: number, excludeIds: readonly string[] = []): ShapeElement | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const maximum = BINDING_DISTANCE_PX / scale
  const excluded = new Set(excludeIds)
  let closest: ShapeElement | undefined, distance = Infinity
  for (let index = scene.elements.length - 1; index >= 0; index--) {
    const node = scene.elements[index]!
    if (node.type !== 'shape' || node.shape === 'text' || excluded.has(node.id) || !(node.width > 0) || !(node.height > 0)) continue
    const bounds = elementBounds(node)
    if (point.x < bounds.x - maximum || point.x > bounds.x + bounds.width + maximum || point.y < bounds.y - maximum || point.y > bounds.y + bounds.height + maximum) continue
    const candidate = outlineDistance(node, point)
    if (candidate === 0) return node
    if (candidate <= maximum + 1e-9 && candidate < distance - 1e-9) { closest = node; distance = candidate }
  }
  return closest
}
