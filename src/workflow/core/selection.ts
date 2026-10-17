import { edgePoints } from './geometry.ts'
import { clone, type Scene } from './types.ts'

/** A detached scene suitable for exporting exactly the selected elements. */
export function selectionScene(scene: Scene, selectedIds: readonly string[]): Scene {
  const selected = new Set(selectedIds)
  const selectedShapes = new Set(scene.elements.filter(element => selected.has(element.id) && element.type === 'shape').map(element => element.id))
  return {
    ...scene,
    elements: scene.elements.filter(element => selected.has(element.id)).map(element => {
      const copy = clone(element)
      if (copy.type !== 'edge' || element.type !== 'edge') return copy
      const points = edgePoints(element, scene)
      if (copy.from.nodeId && !selectedShapes.has(copy.from.nodeId)) copy.from = { ...points[0]! }
      if (copy.to.nodeId && !selectedShapes.has(copy.to.nodeId)) copy.to = { ...points.at(-1)! }
      return copy
    }),
  }
}

export type ReorderOperation = 'front' | 'back' | 'forward' | 'backward'

/**
 * Move unlocked selected elements in stable z-order. A contiguous selected group
 * crosses one neighboring unselected element per step. Locked selected elements
 * are treated as unselected: they never enter the set that is moved explicitly.
 */
export function reorderElements(scene: Scene, ids: readonly string[], operation: ReorderOperation): Scene {
  const selected = new Set(ids)
  const movable = new Set(scene.elements.filter(element => selected.has(element.id) && !element.locked).map(element => element.id))
  const result = clone(scene)
  if (!movable.size) return result
  const elements = result.elements
  if (operation === 'front' || operation === 'back') {
    const moving = elements.filter(element => movable.has(element.id)), others = elements.filter(element => !movable.has(element.id))
    result.elements = operation === 'front' ? [...others, ...moving] : [...moving, ...others]
  } else if (operation === 'forward') {
    for (let index = elements.length - 2; index >= 0; index--) {
      if (movable.has(elements[index]!.id) && !movable.has(elements[index + 1]!.id)) [elements[index], elements[index + 1]] = [elements[index + 1]!, elements[index]!]
    }
  } else if (operation === 'backward') {
    for (let index = 1; index < elements.length; index++) {
      if (movable.has(elements[index]!.id) && !movable.has(elements[index - 1]!.id)) [elements[index], elements[index - 1]] = [elements[index - 1]!, elements[index]!]
    }
  }
  return result
}
