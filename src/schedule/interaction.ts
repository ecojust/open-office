export type EventPointerAction = 'move' | 'start' | 'end' | 'height'

/** Leave a usable middle even in a one-day, half-height block at minimum zoom. */
export function eventResizeInsets(width: number, height: number): { side: number; bottom: number } {
 return { side: Math.max(0, Math.min(12, (width - 12) / 2)), bottom: Math.max(0, Math.min(10, (height - 14) / 2)) }
}
/** Coordinates include the actual button border, not only its child handles. */
export function eventPointerAction(width: number, height: number, x: number, y: number): EventPointerAction {
 if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) return 'move'
 const hit = eventResizeInsets(width, height)
 if (x <= hit.side) return 'start'
 if (x >= width - hit.side) return 'end'
 if (y >= height - hit.bottom) return 'height'
 return 'move'
}
