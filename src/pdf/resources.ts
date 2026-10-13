/** Bound raster memory independently of the document's page size or zoom level. */
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
export const MAX_CANVAS_DIMENSION = 16_384

export function canvasOutputScale(width: number, height: number, desiredScale: number, maxPixels = MAX_CANVAS_PIXELS): number {
  if (![width, height, desiredScale, maxPixels].every(value => Number.isFinite(value) && value > 0) || maxPixels < 1) {
    throw new Error('页面尺寸无效。')
  }
  return Math.min(desiredScale, Math.sqrt(maxPixels / width / height), Math.min(MAX_CANVAS_DIMENSION, maxPixels) / width, Math.min(MAX_CANVAS_DIMENSION, maxPixels) / height)
}

export function releaseCanvas(canvas?: { width: number; height: number } | null): void {
  if (!canvas) return
  // CSS preserves the displayed size; resetting dimensions discards pixel storage.
  if (canvas.width !== 1) canvas.width = 1
  if (canvas.height !== 1) canvas.height = 1
}

export const PDF_HISTORY_MAX_ENTRIES = 8
export const PDF_HISTORY_MAX_BYTES = 48 * 1024 * 1024

/** Account for retained base64 strings, conservatively allowing two bytes per character. */
export function historyBytes(history: readonly string[]): number {
  return history.reduce((sum, value) => sum + value.length * 2, 0)
}

/** maxBytes is a soft limit for the nearest state; maxEntries <= 0 disables history. */
export function appendHistory(history: string[], value: string, maxEntries = PDF_HISTORY_MAX_ENTRIES, maxBytes = PDF_HISTORY_MAX_BYTES): string[] {
  if (maxEntries <= 0) return []
  const next = [...history, value]
  let bytes = historyBytes(next)
  // The PDF backend bounds each input/output to 40 MiB. A single valid snapshot
  // may exceed the string budget; keep it so large documents remain undoable.
  while (next.length > 1 && (next.length > maxEntries || bytes > maxBytes)) bytes -= next.shift()!.length * 2
  return next
}

/** Undo and redo share one soft budget; always keep the nearest available state. */
export function trimHistoryBudget(undo: string[], redo: string[], preferred: 'undo' | 'redo') {
  const result = { undo: [...undo], redo: [...redo] }
  let bytes = historyBytes(undo) + historyBytes(redo)
  const first = preferred === 'undo' ? result.redo : result.undo
  const second = preferred === 'undo' ? result.undo : result.redo
  while (result.undo.length + result.redo.length > 1 && (result.undo.length + result.redo.length > PDF_HISTORY_MAX_ENTRIES || bytes > PDF_HISTORY_MAX_BYTES)) {
    const oldest = (first.length ? first : second).shift()
    if (oldest === undefined) break
    bytes -= oldest.length * 2
  }
  return result
}
