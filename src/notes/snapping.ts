import { NOTE_MAX_CANVAS } from './model.ts'

export const NOTE_GRID_SIZE = 10
const CAPTURE_PIXELS = 6, RELEASE_PIXELS = 9
const anchors = [0, 0.5, 1] as const
type Anchor = typeof anchors[number]
type Axis = 'x' | 'y'
export interface SnapRect { id: string; x: number; y: number; width: number; height: number }
interface SnapTarget { id: string; movingAnchor: Anchor; targetAnchor: Anchor }
export type SnapState = Partial<Record<Axis, SnapTarget>>
export interface SnapGuide { axis: Axis; position: number; start: number; end: number; targetId: string }
export interface SnapOptions { align: boolean; grid: boolean; zoom?: number; previous?: SnapState; bypass?: boolean }

const scale = (zoom = 1) => Number.isFinite(zoom) && zoom > 0 ? zoom : 1
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(Math.max(0, maximum), value))

/** Pointer coordinates stay in document units when the viewport is zoomed or scrolled. */
export function canvasPoint(client: { x: number; y: number }, origin: { left: number; top: number }, zoom = 1) {
 return { x: (client.x - origin.left) / scale(zoom), y: (client.y - origin.top) / scale(zoom) }
}

/** Pure drag geometry. Always use the unsnapped pointer position, never the previous result. */
export function snapRegionPosition(moving: SnapRect, position: { x: number; y: number }, others: readonly SnapRect[], options: SnapOptions) {
 const result = { x: clamp(position.x, NOTE_MAX_CANVAS - moving.width), y: clamp(position.y, NOTE_MAX_CANVAS - moving.height), state: {} as SnapState, guides: [] as SnapGuide[] }
 if (options.bypass) return result
 const neighbours = others.filter(region => region.id !== moving.id).slice().sort((a, b) => a.id.localeCompare(b.id))
 const zoom = scale(options.zoom)
 const chosen: Partial<Record<Axis, { region: SnapRect; target: SnapTarget; line: number }>> = {}
 for (const axis of ['x', 'y'] as const) {
  const size = axis === 'x' ? 'width' : 'height', maximum = NOTE_MAX_CANVAS - moving[size], raw = result[axis]
  let winner: { region: SnapRect; target: SnapTarget; line: number; value: number; distance: number; sameAnchor: boolean } | undefined
  const candidate = (region: SnapRect, movingAnchor: Anchor, targetAnchor: Anchor, tolerance: number) => {
   const line = region[axis] + region[size] * targetAnchor, value = line - moving[size] * movingAnchor, distance = Math.abs(value - raw)
   if (value < 0 || value > maximum || distance * zoom > tolerance) return
   return { region, target: { id: region.id, movingAnchor, targetAnchor }, line, value, distance, sameAnchor: movingAnchor === targetAnchor }
  }
  if (options.align) {
   // Keep an acquired guide through tiny pointer jitter instead of alternating neighbours.
   const previous = options.previous?.[axis], region = neighbours.find(region => region.id === previous?.id)
   if (previous && region) winner = candidate(region, previous.movingAnchor, previous.targetAnchor, RELEASE_PIXELS)
   if (!winner) for (const region of neighbours) for (const movingAnchor of anchors) for (const targetAnchor of anchors) {
    const next = candidate(region, movingAnchor, targetAnchor, CAPTURE_PIXELS)
    if (next && (!winner || next.distance < winner.distance - 1e-6 || (Math.abs(next.distance - winner.distance) <= 1e-6 && next.sameAnchor && !winner.sameAnchor))) winner = next
   }
  }
  if (winner) {
   result[axis] = winner.value; result.state[axis] = winner.target; chosen[axis] = winner
  } else if (options.grid && raw > 0 && raw < maximum) result[axis] = clamp(Math.round(raw / NOTE_GRID_SIZE) * NOTE_GRID_SIZE, maximum)
 }
 for (const axis of ['x', 'y'] as const) {
  const match = chosen[axis]; if (!match) continue
  const otherAxis = axis === 'x' ? 'y' : 'x', otherSize = axis === 'x' ? 'height' : 'width'
  result.guides.push({ axis, position: match.line, start: Math.max(0, Math.min(result[otherAxis], match.region[otherAxis]) - 8 / zoom), end: Math.min(NOTE_MAX_CANVAS, Math.max(result[otherAxis] + moving[otherSize], match.region[otherAxis] + match.region[otherSize]) + 8 / zoom), targetId: match.region.id })
 }
 return result
}
