export const SCHEDULE_DAY_MIN_WIDTH = 36
export const SCHEDULE_DAY_MAX_WIDTH = 160

export function clampDayWidth(value: number): number {
 return Math.max(SCHEDULE_DAY_MIN_WIDTH, Math.min(SCHEDULE_DAY_MAX_WIDTH, Number.isFinite(value) ? Math.round(value * 100) / 100 : 64))
}
/** Pixel, line and page wheel devices share the same smooth exponential scale. */
export function wheelDayWidth(current: number, deltaY: number, deltaMode: number, pageHeight: number): number {
 if (!Number.isFinite(deltaY)) return clampDayWidth(current)
 const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, Number.isFinite(pageHeight) ? pageHeight : 800) : 1
 const pixels = Math.max(-1200, Math.min(1200, deltaY * unit))
 return clampDayWidth(clampDayWidth(current) * Math.exp(-pixels * .002))
}
/** Keep the same fractional date under the pointer unless a scroll edge clamps it. */
export function zoomAnchorScroll(oldWidth: number, newWidth: number, scrollLeft: number, anchor: number, availableWidth: number, dayCount: number): number {
 const old = clampDayWidth(oldWidth), next = clampDayWidth(newWidth)
 const visible = Math.max(0, availableWidth), point = Math.max(0, Math.min(visible, anchor))
 const maximum = Math.max(0, Math.max(1, dayCount) * next - visible)
 return Math.max(0, Math.min(maximum, (Math.max(0, scrollLeft) + point) * next / old - point))
}
