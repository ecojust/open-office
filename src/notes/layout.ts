import { NOTE_MAX_CANVAS, NOTE_MIN_REGION_HEIGHT, NOTE_MIN_REGION_WIDTH, type NoteRegion } from './model.ts'

export function moveRegion(region: NoteRegion, dx: number, dy: number): NoteRegion {
 const height = region.height ?? (region.blocks.length === 1 && region.blocks[0].type === 'image' ? region.width : NOTE_MIN_REGION_HEIGHT)
 return { ...region, x: Math.max(0, Math.min(NOTE_MAX_CANVAS - region.width, Math.round(region.x + dx))), y: Math.max(0, Math.min(NOTE_MAX_CANVAS - height, Math.round(region.y + dy))) }
}

/** Image dimensions change together; text regions only change their chosen line width. */
export function resizeRegion(region: NoteRegion, delta: number): NoteRegion {
 const image = region.blocks.length === 1 && region.blocks[0].type === 'image'
 const ratio = image ? (region.height ?? region.width) / region.width : 0
 const minimum = image ? Math.max(NOTE_MIN_REGION_WIDTH, NOTE_MIN_REGION_HEIGHT / ratio) : NOTE_MIN_REGION_WIDTH
 const maximum = Math.min(NOTE_MAX_CANVAS - region.x, image ? (NOTE_MAX_CANVAS - region.y) / ratio : NOTE_MAX_CANVAS)
 const width = Math.max(Math.min(minimum, maximum), Math.min(maximum, Math.round(region.width + delta)))
 return image ? { ...region, width, height: Math.min(NOTE_MAX_CANVAS - region.y, Math.max(NOTE_MIN_REGION_HEIGHT, width * ratio)) } : { ...region, width }
}

export function nextRegionPosition(regions: NoteRegion[], heights: ReadonlyMap<string, number> = new Map()): { x: number; y: number } {
 const bottom = Math.max(0, ...regions.map(region => region.y + (region.height ?? heights.get(region.id) ?? 80)))
 return { x: 24, y: Math.min(NOTE_MAX_CANVAS - 480, Math.max(24, bottom + 48)) }
}
