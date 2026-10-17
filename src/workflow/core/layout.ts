import { clone, type Scene, type ShapeElement } from './types.ts'
/** Deterministic, dependency-free layered layout; cycles are retained in the final rank. */
export function layoutScene(scene: Scene, direction: 'TB' | 'LR' | 'BT' | 'RL' = 'TB'): Scene {
  const result = clone(scene), nodes = result.elements.filter((e): e is ShapeElement => e.type === 'shape')
  const ids = new Set(nodes.map(n => n.id)), incoming = new Map(nodes.map(n => [n.id, 0])), links = new Map<string, string[]>()
  for (const edge of result.elements) if (edge.type === 'edge' && edge.from.nodeId && edge.to.nodeId && edge.from.nodeId !== edge.to.nodeId && ids.has(edge.from.nodeId) && ids.has(edge.to.nodeId)) { links.set(edge.from.nodeId, [...(links.get(edge.from.nodeId) || []), edge.to.nodeId]); incoming.set(edge.to.nodeId, (incoming.get(edge.to.nodeId) || 0) + 1) }
  const ranks = new Map<string, number>(), queue = nodes.filter(n => !incoming.get(n.id)).map(n => n.id)
  for (const id of queue) ranks.set(id, 0)
  for (let i = 0; i < queue.length; i++) for (const next of links.get(queue[i]!) || []) { ranks.set(next, Math.max(ranks.get(next) || 0, (ranks.get(queue[i]!) || 0) + 1)); incoming.set(next, incoming.get(next)! - 1); if (!incoming.get(next)) queue.push(next) }
  let fallback = Math.max(0, ...ranks.values())
  for (const node of nodes) if (!ranks.has(node.id)) ranks.set(node.id, fallback++)
  const groups = new Map<number, ShapeElement[]>()
  for (const node of nodes) { const rank = ranks.get(node.id)!; groups.set(rank, [...(groups.get(rank) || []), node]) }
  const horizontal = direction === 'LR' || direction === 'RL', reversed = direction === 'BT' || direction === 'RL'
  let primary = 80
  const entries = [...groups.entries()].sort(([a], [b]) => a - b)
  if (reversed) entries.reverse()
  const maxSecondary = Math.max(0, ...entries.map(([, items]) => items.reduce((sum, node) => sum + (horizontal ? node.height : node.width), 0) + Math.max(0, items.length - 1) * 64))
  for (const [, items] of entries) {
    const total = items.reduce((sum, node) => sum + (horizontal ? node.height : node.width), 0) + Math.max(0, items.length - 1) * 64
    let secondary = 80 + (maxSecondary - total) / 2
    for (const node of items) { if (!node.locked) { node.x = horizontal ? primary : secondary; node.y = horizontal ? secondary : primary }; secondary += (horizontal ? node.height : node.width) + 64 }
    primary += Math.max(...items.map(n => horizontal ? n.width : n.height)) + 96
  }
  return result
}
