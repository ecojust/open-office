<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ScheduleEvent, ScheduleProject } from '../model.ts'
import type { HolidayYears } from '../holidays.ts'
import { buildCalendar, moveScheduledEvent, projectedSpan, resizeScheduledEvent } from '../calendar.ts'
import { clampDayWidth, wheelDayWidth, zoomAnchorScroll } from '../zoom.ts'
import { eventPointerAction, eventResizeInsets, type EventPointerAction } from '../interaction.ts'
import { buildMonthlyWorkload, type MonthlyWorkloadCell } from '../workload.ts'
import { buildTimelineRows, getTrackHeight, getEventVerticalLayout, snapTrackHeight, SCHEDULE_LABEL_WIDTH as LABEL_WIDTH, SCHEDULE_HEADER_HEIGHT as HEADER_HEIGHT, SCHEDULE_EVENT_PADDING as PADDING, SCHEDULE_TRACK_HEIGHT as TRACK_HEIGHT, SCHEDULE_TRACK_STEP as TRACK_STEP, SCHEDULE_TRACK_MIN_HEIGHT as MIN_TRACK_HEIGHT, SCHEDULE_TRACK_MAX_HEIGHT as MAX_TRACK_HEIGHT, type DisplayEvent, type TimelineRow } from '../layout.ts'

const props = withDefaults(defineProps<{
 project: ScheduleProject
 mode: 'people' | 'global'
 disabled?: boolean
 active?: boolean
 selectedId?: string
 dayWidth?: number
 holidayYears?: HolidayYears
}>(), { disabled: false, active: true, selectedId: '', dayWidth: 64 })
const emit = defineEmits<{
 select: [id: string]
 edit: [id: string]
 change: [event: ScheduleEvent]
 copy: [event: ScheduleEvent]
 create: [position: { roleId: string | null; date: string; slot: 0 | 1 }]
 delete: [id: string]
 error: [message: string]
 gesture: [value: boolean]
 'track-height': [key: string, height: number]
 zoom: [width: number]
}>()

const root = ref<HTMLElement>(), viewport = ref<HTMLElement>()
const scrollLeft = ref(0), viewportWidth = ref(900), viewportHeight = ref(0), zoomWidth = ref<number>()
let zoomScroll: number | undefined, zoomGeneration = 0
const preview = shallowRef<ScheduleEvent>(), previewPixels = ref<number>(), ghostStyle = ref<Record<string, string>>({})
const dragKind = ref<GestureKind>(), dragEventId = ref(''), copyMode = ref(false), announcement = ref('')
const hoverHit = shallowRef<{ id: string; kind: GestureKind; copy: boolean }>()
const lanes = new Map<string, HTMLElement>()
const daysOfWeek = ['日', '一', '二', '三', '四', '五', '六']
const calendar = computed(() => buildCalendar(props.project, props.holidayYears))
const weekNumbering = computed(() => props.project.calendar.weekNumbering ?? 'year')
const columnWidth = computed(() => clampDayWidth(zoomWidth.value ?? props.dayWidth))
const calendarWidth = computed(() => Math.max(columnWidth.value, calendar.value.days.length * columnWidth.value))
const contentWidth = computed(() => LABEL_WIDTH + calendarWidth.value)
const firstVisible = computed(() => Math.max(0, Math.floor(scrollLeft.value / columnWidth.value) - 2))
const lastVisible = computed(() => Math.min(calendar.value.days.length, Math.ceil((scrollLeft.value + viewportWidth.value - LABEL_WIDTH) / columnWidth.value) + 2))
const visibleDays = computed(() => calendar.value.days.slice(firstVisible.value, lastVisible.value).map((day, index) => ({ ...day, index: firstVisible.value + index })))
const visibleWeeks = computed(() => calendar.value.weeks.filter(week => week.startIndex < lastVisible.value && week.startIndex + week.count > firstVisible.value))
const roleById = computed(() => new Map(props.project.roles.map(role => [role.id, role])))
const rows = computed(() => buildTimelineRows(props.project, props.mode, calendar.value.days))
type WorkloadItem = MonthlyWorkloadCell & { month: string }
const workloadByRole = computed(() => {
 if (props.mode !== 'people') return new Map<string, WorkloadItem[]>()
 const result = buildMonthlyWorkload(props.project, props.holidayYears)
 return new Map(result.people.map(person => [person.roleId, person.months.map((cell, index) => ({ ...cell, month: result.months[index]!.key }))]))
})
const workloadPercent = (value: number | null) => value === null ? '—' : `${Number(value.toFixed(1))}%`
function workloadTitle(item: WorkloadItem): string {
 return `${item.month} 月度工时 ${workloadPercent(item.percentage)}\n已排 ${item.scheduledDays} 天 / 可排 ${item.availableDays} 天\n按当月项目范围内的工作日计算；全天 1 天，半天 0.5 天；不计周末和假日。${item.percentage === null ? '\n本月无可排工作日。' : ''}`
}
const trackPreview = shallowRef<{ key: string; height: number }>()
// Keep at least one minimum-height personnel row reachable below the fixed plan.
// In a short window the plan scrolls normally, so its resize handle stays reachable.
const overallSticky = computed(() => viewportHeight.value >= HEADER_HEIGHT + rowHeight('overall') + MIN_TRACK_HEIGHT)
const hiddenEvents = computed(() => props.project.events.filter(event => !projectedSpan(event, calendar.value.days)).length)
const previewColor = computed(() => preview.value?.roleId ? roleById.value.get(preview.value.roleId)?.color ?? 'var(--ui-accent)' : 'var(--ui-accent)')
const previewOwner = computed(() => preview.value?.roleId ? roleById.value.get(preview.value.roleId)?.name : '整体计划')
const today = (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` })()
type GestureKind = EventPointerAction
type PointerGesture = {
 kind: GestureKind; pointerId: number; element: HTMLElement; original: ScheduleEvent; base: ScheduleProject
 sourceKey: string; targetKey: string; startX: number; startY: number; x: number; y: number
 startScrollLeft: number; startHeight: number; grabRatio: number; moved: boolean; width: number
}
type TrackGesture = { pointerId: number; element: HTMLElement; key: string; name: string; base: ScheduleProject; startY: number; startHeight: number; moved: boolean }
let trackGesture: TrackGesture | undefined
let gesture: PointerGesture | undefined, frame = 0, frameTime = 0, observer: ResizeObserver | undefined, suppressClickUntil = 0
let suppressControlMenu: { id: string; until: number } | undefined

function setLane(key: string, element: unknown) {
 if (element instanceof HTMLElement) lanes.set(key, element)
 else lanes.delete(key)
}
function rowTestKey(row: TimelineRow): string {
 return props.mode === 'people' && row.roleId !== null ? (row.roleId === 'overall' ? 'person-overall' : row.roleId) : row.key
}
function rowHeight(key: string): number { return trackPreview.value?.key === key ? trackPreview.value.height : getTrackHeight(props.project, key) }
function fullHeight(key: string): number { return rowHeight(key) - PADDING * 2 }
function eventStyle(item: DisplayEvent, color: string, key: string) {
 const vertical = getEventVerticalLayout(rowHeight(key), item.event), width = Math.max(10, item.count * columnWidth.value - 6)
 const insets = eventResizeInsets(width, vertical.height)
 const hit = dragEventId.value === item.event.id ? { kind: dragKind.value, copy: copyMode.value } : hoverHit.value?.id === item.event.id ? hoverHit.value : undefined
 const cursor = hit?.kind === 'start' || hit?.kind === 'end' ? 'ew-resize' : hit?.kind === 'height' ? 'ns-resize' : hit?.copy ? 'copy' : dragEventId.value === item.event.id ? 'grabbing' : 'grab'
 return { top: `${vertical.top}px`, left: `${item.start * columnWidth.value + 3}px`, width: `${width}px`, height: `${vertical.height}px`, cursor, '--event-color': color, '--resize-side-width': `${insets.side}px`, '--resize-bottom-height': `${insets.bottom}px` }
}
function hoverEvent(event: PointerEvent, item: ScheduleEvent) {
 if (gesture || trackGesture) return
 if (!canEdit()) { hoverHit.value = undefined; return }
 const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
 const kind = eventPointerAction(bounds.width, bounds.height, event.clientX - bounds.left, event.clientY - bounds.top)
 const copy = kind === 'move' && event.ctrlKey
 if (hoverHit.value?.id === item.id && hoverHit.value.kind === kind && hoverHit.value.copy === copy) return
 hoverHit.value = { id: item.id, kind, copy }
}
function leaveEvent(id: string) { if (!gesture && hoverHit.value?.id === id) hoverHit.value = undefined }
function eventTitle(event: ScheduleEvent): string {
 const name = event.roleId ? roleById.value.get(event.roleId)?.name ?? '' : '整体计划'
 return `${event.title}\n${name} · ${event.startDate} 至 ${event.endDate}\n${event.height === 1 ? '全天' : event.slot === 1 ? '下午 · 半高' : '上午 · 半高'}${event.notes ? `\n${event.notes}` : ''}`
}
function sameEvent(a: ScheduleEvent, b: ScheduleEvent): boolean {
 return a.roleId === b.roleId && a.startDate === b.startDate && a.endDate === b.endDate && a.height === b.height && a.slot === b.slot
}
function canEdit(): boolean { return props.active && !props.disabled }
/** clientX is in viewport coordinates; omitted means the visible date area's centre. */
function zoomTo(width: number, clientX?: number): boolean {
 const scroll = viewport.value
 if (!scroll || !canEdit() || gesture || trackGesture) return false
 const current = columnWidth.value, next = clampDayWidth(width)
 if (current === next) return false
 const available = Math.max(0, scroll.clientWidth - LABEL_WIDTH)
 const anchor = clientX === undefined ? available / 2 : clientX - scroll.getBoundingClientRect().left - LABEL_WIDTH
 const desired = zoomAnchorScroll(current, next, zoomScroll ?? scroll.scrollLeft, anchor, available, calendar.value.days.length)
 const token = ++zoomGeneration
 // Multiple trackpad events can arrive before Vue renders the parent's width.
 // Carry both width and logical scroll forward so every event uses its predecessor.
 zoomWidth.value = next; zoomScroll = desired
 emit('zoom', next)
 void nextTick(() => {
  if (token !== zoomGeneration || !viewport.value) return
  if (canEdit()) { viewport.value.scrollLeft = desired; scrollLeft.value = viewport.value.scrollLeft }
  zoomWidth.value = undefined; zoomScroll = undefined
 })
 return true
}
function wheel(event: WheelEvent) {
 if (!event.ctrlKey) return
 // Suppress browser page zoom even while an edit/dialog temporarily blocks the
 // timeline. Plain wheel gestures keep the browser's native scrolling behavior.
 event.preventDefault(); event.stopPropagation()
 if (!canEdit() || gesture || trackGesture) return
 zoomTo(wheelDayWidth(columnWidth.value, event.deltaY, event.deltaMode, viewport.value?.clientHeight ?? 800), event.clientX)
}
function onScroll() {
 scrollLeft.value = viewport.value?.scrollLeft ?? 0
 if (gesture?.moved) updatePreview()
}
function targetRow(drag: PointerGesture): TimelineRow | undefined {
 const scroll = viewport.value
 if (!scroll) return undefined
 if (props.mode === 'global') return rows.value.find(row => row.key === drag.sourceKey)
 const bounds = scroll.getBoundingClientRect()
 const headerBottom = bounds.top + HEADER_HEIGHT, bottom = bounds.top + scroll.clientHeight
 if (drag.x < bounds.left + LABEL_WIDTH || drag.x > bounds.left + scroll.clientWidth || drag.y < headerBottom || drag.y >= bottom) return undefined
 // Test the overall row first when pinned, and exclude the area it covers from
 // personnel hit targets. When unpinned only the date header occludes rows.
 for (const row of rows.value) {
  const lane = lanes.get(row.key), rect = lane?.getBoundingClientRect()
  const coveredTop = headerBottom + (overallSticky.value && row.key !== 'overall' ? rowHeight('overall') : 0)
  if (rect && drag.y >= Math.max(rect.top, coveredTop) && drag.y < Math.min(rect.bottom, bottom)) return row
 }
 return undefined
}
function targetSlot(drag: PointerGesture): 0 | 1 {
 if (drag.original.height === 1) return 0
 const lane = lanes.get(drag.targetKey)
 if (!lane) return drag.original.slot
 // Preserve where the user grabbed the block, scaled to the destination row.
 // Purely horizontal movement therefore keeps even a bottom-edge grab in its
 // original period, while cross-row moves select by the block's new centre.
 const halfHeight = fullHeight(drag.targetKey) / 2
 const centre = drag.y - lane.getBoundingClientRect().top + (.5 - drag.grabRatio) * halfHeight
 return centre < rowHeight(drag.targetKey) / 2 ? 0 : 1
}
function placeGhost() {
 const drag = gesture, event = preview.value, wrapper = root.value
 if (!drag || !event || !wrapper) return
 const span = projectedSpan(event, calendar.value.days), lane = lanes.get(drag.targetKey)
 if (!span || !lane) return
 const bounds = wrapper.getBoundingClientRect(), rect = lane.getBoundingClientRect()
 const vertical = getEventVerticalLayout(rowHeight(drag.targetKey), event)
 const top = drag.kind === 'height' && drag.original.height === .5 && drag.original.slot === 1 && previewPixels.value !== undefined ? PADDING + fullHeight(drag.targetKey) - previewPixels.value : vertical.top
 ghostStyle.value = {
  left: `${rect.left - bounds.left + span.start * columnWidth.value + 3}px`,
  top: `${rect.top - bounds.top + top}px`,
  width: `${Math.max(10, span.count * columnWidth.value - 6)}px`,
  height: `${previewPixels.value ?? vertical.height}px`,
  '--event-color': previewColor.value,
 }
}
function updatePreview() {
 const drag = gesture
 if (!drag?.moved || !canEdit() || props.project !== drag.base) return
 const delta = Math.round((drag.x - drag.startX + (viewport.value?.scrollLeft ?? 0) - drag.startScrollLeft) / drag.width)
 // A preview can pass over occupied dates. The parent validates the single final
 // change and restores the original event if the destination is occupied.
 const previewProject = { ...drag.base, events: [] }
 try {
  if (drag.kind === 'move') {
   const target = targetRow(drag)
   if (target) drag.targetKey = target.key
   const roleId = props.mode === 'global' ? drag.original.roleId : (rows.value.find(row => row.key === drag.targetKey)?.roleId ?? null)
   preview.value = moveScheduledEvent(previewProject, drag.original, delta, roleId, targetSlot(drag), calendar.value.days)
  } else if (drag.kind === 'height') {
   const maximum = fullHeight(drag.sourceKey)
   const height = Math.max(maximum / 2, Math.min(maximum, drag.startHeight + drag.y - drag.startY))
   previewPixels.value = height
   const half = height < maximum * .75
   preview.value = { ...drag.original, height: half ? .5 : 1, slot: half ? drag.original.slot : 0 }
  } else preview.value = resizeScheduledEvent(previewProject, drag.original, drag.kind, delta, calendar.value.days)
  placeGhost()
 } catch (cause) { announcement.value = cause instanceof Error ? cause.message : String(cause) }
}
function autoScroll(now: number) {
 frame = 0
 const drag = gesture, scroll = viewport.value
 if (!drag || !scroll) return
 const elapsed = Math.min(32, now - (frameTime || now)); frameTime = now
 if (drag.moved && drag.kind !== 'height') {
  const rect = scroll.getBoundingClientRect(), left = rect.left + LABEL_WIDTH, right = rect.left + scroll.clientWidth, bottom = rect.top + scroll.clientHeight
  const speed = (position: number, start: number, end: number) => position < start + 38 ? -Math.min(1, (start + 38 - position) / 38) : position > end - 38 ? Math.min(1, (position - end + 38) / 38) : 0
  if (drag.y >= rect.top + HEADER_HEIGHT && drag.y < bottom) scroll.scrollLeft += speed(drag.x, left, right) * elapsed * .8
  if (drag.kind === 'move' && props.mode === 'people' && drag.x >= left && drag.x <= right) {
   const pinnedHeight = overallSticky.value ? rowHeight('overall') : 0, top = rect.top + HEADER_HEIGHT + pinnedHeight
   if (drag.y > rect.top + HEADER_HEIGHT + pinnedHeight / 2) scroll.scrollTop += speed(drag.y, top, bottom) * elapsed * .6
  }
  scrollLeft.value = scroll.scrollLeft
  updatePreview()
 }
 frame = requestAnimationFrame(autoScroll)
}
function startGesture(event: PointerEvent, item: ScheduleEvent, rowKey: string) {
 if (!canEdit() || gesture || trackGesture || !event.isPrimary) return
 const element = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-event-id]')
 if (!element) return
 const bounds = element.getBoundingClientRect(), grabRatio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)))
 const kind = eventPointerAction(bounds.width, bounds.height, event.clientX - bounds.left, event.clientY - bounds.top)
 // macOS can report Control + primary click as button 2. Accept that only for
 // the requested body-copy gesture; ordinary right-clicks keep native behavior.
 if (event.button !== 0 && !(event.button === 2 && event.ctrlKey && kind === 'move')) return
 event.preventDefault(); event.stopPropagation()
 emit('select', item.id); element.focus({ preventScroll: true })
 if (kind === 'move' && event.ctrlKey) suppressControlMenu = { id: item.id, until: performance.now() + 400 }
 gesture = { kind, pointerId: event.pointerId, element, original: { ...item }, base: props.project, sourceKey: rowKey, targetKey: rowKey, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, startScrollLeft: viewport.value?.scrollLeft ?? 0, startHeight: fullHeight(rowKey) * item.height, grabRatio, moved: false, width: columnWidth.value }
 dragKind.value = kind; dragEventId.value = item.id; copyMode.value = kind === 'move' && event.ctrlKey; announcement.value = ''
 try { element.setPointerCapture(event.pointerId) } catch { /* Window listeners cover devices without pointer capture. */ }
 element.addEventListener('lostpointercapture', cancelPointer)
 window.addEventListener('pointermove', movePointer, { passive: false })
 window.addEventListener('pointerup', finishPointer)
 window.addEventListener('pointercancel', cancelPointer)
 window.addEventListener('blur', cancelGesture)
 window.addEventListener('keydown', gestureKeyboard)
 window.addEventListener('keyup', gestureModifier)
 frameTime = 0; frame = requestAnimationFrame(autoScroll)
 emit('gesture', true)
}
function movePointer(event: PointerEvent) {
 const drag = gesture
 if (!drag || event.pointerId !== drag.pointerId) return
 if (!canEdit() || event.buttons === 0) { cancelGesture(); return }
 event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY; updateCopyMode(event.ctrlKey)
 if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4) return
 drag.moved = true; updatePreview()
}
function releaseGesture() {
 const drag = gesture
 if (drag?.kind === 'move' && copyMode.value) suppressControlMenu = { id: drag.original.id, until: performance.now() + 400 }
 gesture = undefined; preview.value = undefined; previewPixels.value = undefined; dragKind.value = undefined; dragEventId.value = ''; copyMode.value = false; hoverHit.value = undefined
 cancelAnimationFrame(frame); frame = 0; frameTime = 0
 window.removeEventListener('pointermove', movePointer)
 window.removeEventListener('pointerup', finishPointer)
 window.removeEventListener('pointercancel', cancelPointer)
 window.removeEventListener('blur', cancelGesture)
 window.removeEventListener('keydown', gestureKeyboard)
 window.removeEventListener('keyup', gestureModifier)
 if (drag) {
  drag.element.removeEventListener('lostpointercapture', cancelPointer)
  try { if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId) } catch { /* Capture may already have ended. */ }
  emit('gesture', false)
 }
 return drag
}
function finishPointer(event: PointerEvent) {
 const drag = gesture
 if (!drag || event.pointerId !== drag.pointerId) return
 drag.x = event.clientX; drag.y = event.clientY; updateCopyMode(event.ctrlKey)
 if (drag.moved) updatePreview()
 const changed = preview.value, valid = canEdit() && drag.base === props.project, copying = drag.kind === 'move' && copyMode.value
 if (drag.moved) suppressClickUntil = performance.now() + 300
 releaseGesture()
 if (valid && drag.moved && changed && copying) {
  // The parent assigns a new ID and validates the copy against the unchanged
  // source, then focuses the new block. Never focus or mutate the source here.
  emit('copy', { ...changed })
 } else if (valid && changed && !sameEvent(changed, drag.original)) {
  emit('change', { ...changed })
  announcement.value = `${changed.title}：${changed.startDate} 至 ${changed.endDate}，${changed.height === 1 ? '全天' : changed.slot === 1 ? '下午' : '上午'}。`
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-event-id="${changed.id}"]`)?.focus({ preventScroll: true }))
 }
}
function cancelGesture() {
 if (gesture) { releaseGesture(); announcement.value = '已取消调整。' }
 if (trackGesture) { releaseTrackGesture(); announcement.value = '已取消轨道高度调整。' }
}
function cancelPointer(event: PointerEvent) { if (event.pointerId === gesture?.pointerId) cancelGesture() }
function updateCopyMode(ctrlKey: boolean) {
 const next = gesture?.kind === 'move' && ctrlKey
 if (copyMode.value === next) return
 copyMode.value = next
 if (gesture?.moved) announcement.value = next ? '复制事件：松开鼠标创建副本，原事件保留。' : '移动事件：松开鼠标调整原事件。'
}
function gestureModifier(event: KeyboardEvent) { if (gesture) updateCopyMode(event.ctrlKey) }
function gestureKeyboard(event: KeyboardEvent) {
 if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); cancelGesture(); return }
 gestureModifier(event)
}
function selectEvent(event: MouseEvent, id: string) { event.stopPropagation(); if (performance.now() >= suppressClickUntil) emit('select', id) }
function editEvent(event: MouseEvent, id: string) { event.stopPropagation(); if (canEdit() && performance.now() >= suppressClickUntil) emit('edit', id) }
function eventContextMenu(event: MouseEvent, id: string) {
 const copying = gesture?.kind === 'move' && gesture.original.id === id
 if (event.ctrlKey && (copying || (suppressControlMenu?.id === id && performance.now() < suppressControlMenu.until))) event.preventDefault()
}
function createEvent(event: MouseEvent, row: TimelineRow) {
 if (!canEdit() || gesture || trackGesture || !calendar.value.days.length || (event.target as HTMLElement).closest('[data-event-id]')) return
 const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
 const index = Math.max(0, Math.min(calendar.value.days.length - 1, Math.floor((event.clientX - bounds.left) / columnWidth.value)))
 emit('create', { roleId: row.roleId, date: calendar.value.days[index].date, slot: 0 })
}
function eventKeyboard(event: KeyboardEvent, item: ScheduleEvent) {
 if (gesture || trackGesture || !canEdit() || event.ctrlKey || event.metaKey || event.altKey) return
 if (event.key === 'Enter') { event.preventDefault(); emit('edit', item.id); return }
 if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); emit('delete', item.id); return }
 if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
 event.preventDefault(); event.stopPropagation()
 try {
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  const delta = horizontal ? (event.key === 'ArrowLeft' ? -1 : 1) : 0
  let roleId = item.roleId
  if (!horizontal && event.shiftKey) {
   if (item.height !== .5) return
   const candidate = moveScheduledEvent(props.project, item, 0, item.roleId, event.key === 'ArrowUp' ? 0 : 1, calendar.value.days)
   if (!sameEvent(item, candidate)) emit('change', candidate)
   return
  }
  if (!horizontal) {
   if (props.mode === 'global') return
   const index = rows.value.findIndex(row => row.roleId === item.roleId), next = rows.value[index + (event.key === 'ArrowUp' ? -1 : 1)]
   if (!next) return
   roleId = next.roleId
  }
  const candidate = event.shiftKey && horizontal ? resizeScheduledEvent(props.project, item, 'end', delta, calendar.value.days) : moveScheduledEvent(props.project, item, delta, roleId, item.slot, calendar.value.days)
  if (!sameEvent(item, candidate)) emit('change', candidate)
 } catch (cause) { emit('error', cause instanceof Error ? cause.message : String(cause)) }
}
function startTrackGesture(event: PointerEvent, row: TimelineRow) {
 if (!canEdit() || gesture || trackGesture || event.button !== 0 || !event.isPrimary) return
 event.preventDefault(); event.stopPropagation()
 const element = event.currentTarget as HTMLElement
 element.focus({ preventScroll: true })
 trackGesture = { pointerId: event.pointerId, element, key: row.key, name: row.name, base: props.project, startY: event.clientY, startHeight: getTrackHeight(props.project, row.key), moved: false }
 trackPreview.value = { key: row.key, height: trackGesture.startHeight }
 announcement.value = `${row.name}轨道：${trackGesture.startHeight / TRACK_STEP} 格，每格 ${TRACK_STEP} 像素。`
 try { element.setPointerCapture(event.pointerId) } catch { /* Window listeners cover devices without pointer capture. */ }
 element.addEventListener('lostpointercapture', cancelTrackPointer)
 window.addEventListener('pointermove', moveTrackPointer, { passive: false })
 window.addEventListener('pointerup', finishTrackPointer)
 window.addEventListener('pointercancel', cancelTrackPointer)
 window.addEventListener('blur', cancelGesture)
 window.addEventListener('keydown', trackGestureKeyboard)
 emit('gesture', true)
}
function moveTrackPointer(event: PointerEvent) {
 const drag = trackGesture
 if (!drag || event.pointerId !== drag.pointerId) return
 if (!canEdit() || event.buttons === 0 || props.project !== drag.base) { cancelGesture(); return }
 event.preventDefault()
 if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return
 drag.moved = true
 trackPreview.value = { key: drag.key, height: snapTrackHeight(drag.startHeight + event.clientY - drag.startY) }
}
function releaseTrackGesture() {
 const drag = trackGesture
 trackGesture = undefined; trackPreview.value = undefined
 window.removeEventListener('pointermove', moveTrackPointer)
 window.removeEventListener('pointerup', finishTrackPointer)
 window.removeEventListener('pointercancel', cancelTrackPointer)
 window.removeEventListener('blur', cancelGesture)
 window.removeEventListener('keydown', trackGestureKeyboard)
 if (drag) {
  drag.element.removeEventListener('lostpointercapture', cancelTrackPointer)
  try { if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId) } catch { /* Capture may already have ended. */ }
  emit('gesture', false)
 }
 return drag
}
function finishTrackPointer(event: PointerEvent) {
 const drag = trackGesture
 if (!drag || event.pointerId !== drag.pointerId) return
 const valid = canEdit() && props.project === drag.base
 const height = drag.moved ? snapTrackHeight(drag.startHeight + event.clientY - drag.startY) : drag.startHeight
 releaseTrackGesture()
 if (valid && height !== drag.startHeight) {
  emit('track-height', drag.key, height)
  announcement.value = `${drag.name}轨道已设为 ${height / TRACK_STEP} 格，${height} 像素。`
 }
}
function cancelTrackPointer(event: PointerEvent) { if (event.pointerId === trackGesture?.pointerId) cancelGesture() }
function trackGestureKeyboard(event: KeyboardEvent) {
 if (event.key === 'Escape' && trackGesture) { event.preventDefault(); event.stopPropagation(); cancelGesture() }
}
function trackKeyboard(event: KeyboardEvent, row: TimelineRow) {
 if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
 event.preventDefault(); event.stopPropagation()
 if (!canEdit() || gesture || trackGesture) return
 const current = getTrackHeight(props.project, row.key)
 const height = event.key === 'Home' ? MIN_TRACK_HEIGHT : event.key === 'End' ? MAX_TRACK_HEIGHT : snapTrackHeight(current + (event.key === 'ArrowUp' ? -TRACK_STEP : TRACK_STEP))
 if (current === height) return
 emit('track-height', row.key, height)
 announcement.value = `${row.name}轨道已设为 ${height / TRACK_STEP} 格，${height} 像素。`
}
function focusSelected() {
 if (!props.selectedId || gesture || trackGesture) return
 void nextTick(() => {
  const event = root.value?.querySelector<HTMLElement>(`[data-event-id="${props.selectedId}"]`)
  if (!event || !viewport.value) return
  const item = props.project.events.find(item => item.id === props.selectedId), span = item && projectedSpan(item, calendar.value.days)
  if (!span) return
  const available = viewport.value.clientWidth - LABEL_WIDTH, start = span.start * columnWidth.value, end = (span.start + span.count) * columnWidth.value
  if (start < viewport.value.scrollLeft) viewport.value.scrollLeft = start
  else if (end > viewport.value.scrollLeft + available) viewport.value.scrollLeft = Math.max(0, Math.min(start, end - available))
 })
}
watch(() => [props.disabled, props.active, props.mode, props.dayWidth, props.project] as const, () => cancelGesture(), { flush: 'sync' })
watch(() => props.selectedId, focusSelected)
onMounted(() => {
 if (viewport.value) {
  viewport.value.addEventListener('wheel', wheel, { passive: false, capture: true })
  observer = new ResizeObserver(() => {
   viewportWidth.value = viewport.value?.clientWidth ?? 900
   viewportHeight.value = viewport.value?.clientHeight ?? 0
   // A row resize can introduce a vertical scrollbar. Its width change must not
   // cancel that row gesture; event drags still depend on viewport geometry.
   if (gesture) cancelGesture()
  })
  observer.observe(viewport.value); viewportWidth.value = viewport.value.clientWidth; viewportHeight.value = viewport.value.clientHeight
 }
})
onBeforeUnmount(() => { cancelGesture(); zoomGeneration++; viewport.value?.removeEventListener('wheel', wheel, { capture: true }); observer?.disconnect(); lanes.clear() })
defineExpose({ cancelGesture, zoomTo })
</script>

<template>
 <section ref="root" class="schedule-timeline" :class="{ 'is-dragging': preview || trackPreview, 'is-copying': copyMode && dragKind === 'move', 'is-disabled': disabled }" :data-day-width="columnWidth" :data-track-height="TRACK_HEIGHT" :data-track-step="TRACK_STEP" :data-copy="copyMode" :data-gesture="dragKind" :data-overall-sticky="overallSticky" :data-viewport-height="viewportHeight" data-testid="schedule-timeline" :style="{ '--schedule-label-width': `${LABEL_WIDTH}px`, '--schedule-day-width': `${columnWidth}px` }" aria-label="项目排期时间线">
  <div ref="viewport" class="schedule-timeline-scroll" data-testid="schedule-timeline-scroll" tabindex="0" @scroll="onScroll">
   <div class="schedule-timeline-content" :style="{ width: `${contentWidth}px` }">
    <div class="schedule-calendar-header">
     <div class="schedule-calendar-corner"><strong>{{ mode === 'people' ? '人员 / 角色' : '全局事件' }}</strong><span>{{ calendar.days.length }} 个显示日<span v-if="calendar.hiddenCount"> · 隐藏 {{ calendar.hiddenCount }} 天</span></span></div>
     <div class="schedule-date-header" :style="{ width: `${calendarWidth}px` }">
      <div class="schedule-week-header" :data-week-numbering="weekNumbering">
       <div v-for="week in visibleWeeks" :key="week.key" class="schedule-week" :style="{ left: `${week.startIndex * columnWidth}px`, width: `${week.count * columnWidth}px` }" :class="{ 'schedule-week-compact': week.count * columnWidth < 96 }" :data-week="week.label" :data-week-year="weekNumbering === 'year' ? week.weekYear : undefined" :title="weekNumbering === 'year' ? `${week.weekYear} · ${week.label}（ISO 周历，周一开周）` : `项目 ${week.label}（开始日期所在周为 W1，周一开周）`" :aria-label="weekNumbering === 'year' ? `${week.weekYear} 年 ${week.label}` : `项目 ${week.label}`">
        <strong>{{ week.label }}</strong><span v-if="weekNumbering === 'year'">{{ week.count * columnWidth < 96 ? week.weekYear : `${week.weekYear} · ${calendar.days[week.startIndex]?.date.slice(5).replace('-', '/')}` }}</span><span v-else>{{ week.count * columnWidth < 96 ? '项目' : `项目 · ${calendar.days[week.startIndex]?.date.slice(5).replace('-', '/')}` }}</span>
       </div>
      </div>
      <div class="schedule-day-header"><div v-for="day in visibleDays" :key="day.date" class="schedule-day" :class="{ weekend: day.weekday === 0 || day.weekday === 6, holiday: day.holiday, today: day.date === today }" :style="{ left: `${day.index * columnWidth}px`, width: `${columnWidth}px` }" :data-date="day.date" :title="`${day.date} 周${daysOfWeek[day.weekday]}${day.holiday ? ` · ${day.holiday}` : ''}`"><span>{{ day.date.slice(5).replace('-', '/') }}</span><small>周{{ daysOfWeek[day.weekday] }}</small></div></div>
     </div>
    </div>
    <div v-for="row in rows" :key="row.key" class="schedule-track" :class="{ 'schedule-overall-track': row.key === 'overall', 'schedule-overall-pinned': row.key === 'overall' && overallSticky, 'track-resizing': trackPreview?.key === row.key }" :style="{ '--schedule-track-height': `${rowHeight(row.key)}px` }" :data-track-height="rowHeight(row.key)" :data-sticky="row.key === 'overall' && overallSticky" :data-testid="`schedule-track-${rowTestKey(row)}`" :data-role-id="row.roleId ?? 'overall'" :data-track-key="row.key">
     <div class="schedule-track-label" :class="{ 'has-workload': mode === 'people' && row.roleId !== null }" :data-testid="`schedule-label-${rowTestKey(row)}`" :style="{ '--role-color': row.color }"><span class="schedule-role-dot" /><div>
      <strong :title="`${row.name} · ${row.total} 个事件${row.total > row.events.length ? ` · ${row.total - row.events.length} 个已隐藏` : ''}`">{{ row.name }}</strong><span :title="row.subtitle">{{ row.subtitle }}</span>
      <ul v-if="mode === 'people' && row.roleId !== null" class="schedule-workload-list" :data-testid="`schedule-workload-${row.roleId}`" :aria-label="`${row.name}的月度工时占比`" title="月度工时：已排工作天数 / 当月项目范围内的工作日；月份较多时可滚动查看" tabindex="0">
       <li v-for="item in workloadByRole.get(row.roleId)" :key="item.month" :data-month="item.month" :data-scheduled-days="item.scheduledDays" :data-available-days="item.availableDays" :data-percentage="item.percentage" :title="workloadTitle(item)"><span>{{item.month}}</span><strong>{{workloadPercent(item.percentage)}}</strong></li>
      </ul>
      <small v-else-if="row.key === 'overall'">{{ row.total }} 个事件<span v-if="row.total > row.events.length"> · {{ row.total - row.events.length }} 个已隐藏</span></small>
     </div><div class="schedule-track-ruler" aria-hidden="true"><span v-for="tick in (trackPreview?.key === row.key ? rowHeight(row.key) / TRACK_STEP - 1 : 0)" :key="tick" :style="{ top: `${tick * TRACK_STEP}px` }">{{ tick }}</span></div><span class="schedule-track-height-label" aria-hidden="true">{{ rowHeight(row.key) / TRACK_STEP }} × {{ TRACK_STEP }} px</span></div>
     <div :ref="element => setLane(row.key, element)" class="schedule-track-lane" :style="{ width: `${calendarWidth}px` }" :data-testid="`schedule-lane-${rowTestKey(row)}`" :data-role-id="row.roleId ?? 'overall'" @dblclick="createEvent($event, row)">
      <span class="schedule-lane-midline" aria-hidden="true"/><span class="schedule-period-hint period-morning" aria-hidden="true">上午</span><span class="schedule-period-hint period-afternoon" aria-hidden="true">下午</span>
      <span v-if="!row.total && calendar.days.length" class="schedule-lane-hint">双击日期空白处添加{{ row.key === 'overall' ? '整体计划' : '事件' }}</span>
      <span v-else-if="row.total && !row.events.length" class="schedule-lane-hint">事件日期已隐藏，可在事件列表中编辑</span>
      <button v-for="item in row.events" :key="item.event.id" type="button" class="schedule-event" :class="{ selected: selectedId === item.event.id, 'event-half': item.event.height === .5, 'event-drag-source': preview?.id === item.event.id && !copyMode }" :style="eventStyle(item, row.color, row.key)" :data-testid="`schedule-event-${item.event.id}`" :data-event-id="item.event.id" :data-role-id="item.event.roleId ?? 'overall'" :data-height="item.event.height" :data-slot="item.event.slot" :data-start-date="item.event.startDate" :data-end-date="item.event.endDate" :aria-label="eventTitle(item.event)" :aria-pressed="selectedId === item.event.id" :title="eventTitle(item.event)" :disabled="disabled || !active" @pointerdown="startGesture($event, item.event, row.key)" @pointerenter="hoverEvent($event, item.event)" @pointermove="hoverEvent($event, item.event)" @pointerleave="leaveEvent(item.event.id)" @contextmenu="eventContextMenu($event, item.event.id)" @click="selectEvent($event, item.event.id)" @dblclick="editEvent($event, item.event.id)" @keydown="eventKeyboard($event, item.event)">
       <span class="schedule-resize-handle resize-start" data-testid="resize-start" data-resize="start" title="拖动调整开始日期" aria-hidden="true" />
       <strong class="schedule-event-title">{{ item.event.title }}</strong>
       <span class="schedule-event-dates">{{ item.event.startDate.slice(5).replace('-', '/') }} — {{ item.event.endDate.slice(5).replace('-', '/') }}</span>
       <span v-if="mode === 'global' && item.event.roleId" class="schedule-event-owner">{{ roleById.get(item.event.roleId)?.name }}</span>
       <span class="schedule-resize-handle resize-end" data-testid="resize-end" data-resize="end" title="拖动调整结束日期" aria-hidden="true" />
       <span class="schedule-resize-handle resize-height" data-testid="resize-height" data-resize="height" title="拖动调整为整行或半行高度" aria-hidden="true" />
      </button>
     </div>
     <button type="button" role="separator" aria-orientation="horizontal" class="schedule-track-resize" :data-testid="`track-resize-${rowTestKey(row)}`" :data-track-key="row.key" :aria-label="`调整${row.name}轨道高度`" :aria-valuemin="MIN_TRACK_HEIGHT" :aria-valuemax="MAX_TRACK_HEIGHT" :aria-valuenow="rowHeight(row.key)" :aria-valuetext="`${rowHeight(row.key) / TRACK_STEP} 格，每格 ${TRACK_STEP} 像素`" :title="`拖动调整轨道高度（每格 ${TRACK_STEP} px）；方向键逐格调整，Home / End 最小 / 最大`" :disabled="disabled || !active" @pointerdown="startTrackGesture($event, row)" @keydown="trackKeyboard($event, row)" @dblclick.stop @click.stop><span /></button>
    </div>
    <div v-if="!calendar.days.length" class="schedule-calendar-empty">当前日期范围中的日期全部被隐藏，请调整日期范围或显示周末、节假日。</div>
    <div v-else-if="mode === 'people' && !project.roles.length" class="schedule-timeline-empty">先添加项目角色，再安排每个人的事件。</div>
    <div v-else-if="mode === 'global' && rows.length === 1" class="schedule-timeline-empty">人员事件会按开始日期汇总显示在这里。</div>
   </div>
  </div>
  <div v-if="preview" class="schedule-preview-overlay" aria-hidden="true"><div class="schedule-event schedule-event-ghost" :class="{ 'event-half': preview.height === .5, 'event-copy-ghost': copyMode }" :style="ghostStyle" :data-slot="preview.slot" :data-copy="copyMode"><strong class="schedule-event-title">{{ preview.title }}</strong><span class="schedule-event-dates">{{ preview.startDate.slice(5).replace('-', '/') }} — {{ preview.endDate.slice(5).replace('-', '/') }}</span><span class="schedule-event-owner">{{ dragKind === 'height' ? `${preview.height * 100}% · ${preview.height === 1 ? '全天' : preview.slot === 1 ? '下午' : '上午'}` : `${previewOwner} · ${preview.height === 1 ? '全天' : preview.slot === 1 ? '下午' : '上午'}` }}</span></div><span v-if="copyMode" class="schedule-copy-preview" data-testid="schedule-copy-preview" :style="{ left: ghostStyle.left, top: ghostStyle.top }">复制</span></div>
  <div class="schedule-timeline-help"><span>双击添加或编辑 · 拖动移动 · Ctrl+拖动复制 · 边缘拉伸日期 · 事件底边调整比例 · 轨道底边按 28 px 吸附</span><span v-if="hiddenEvents">{{ hiddenEvents }} 个事件日期已隐藏</span><span v-else>Shift+↑↓ 切换上下午 · Ctrl+滚轮缩放</span></div>
  <span class="schedule-sr-only" role="status" aria-live="polite">{{ announcement }}</span>
 </section>
</template>

<style scoped>
.schedule-timeline { min-width: 0; min-height: 240px; flex: 1; display: flex; flex-direction: column; position: relative; border: 1px solid var(--ui-line); border-radius: 8px; overflow: hidden; background: var(--ui-surface); }
.schedule-timeline-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ui-line-strong) transparent; }
.schedule-timeline-content { min-width: 100%; min-height: 100%; position: relative; }
.schedule-calendar-header { height: 72px; position: sticky; top: 0; display: flex; z-index: 12; background: var(--ui-surface); box-shadow: 0 1px var(--ui-line-strong); }
.schedule-calendar-corner { width: var(--schedule-label-width); min-width: var(--schedule-label-width); height: 72px; position: sticky; left: 0; z-index: 14; background: var(--ui-surface-muted); border-right: 1px solid var(--ui-line-strong); padding: 14px 16px; display: flex; flex-direction: column; justify-content: center; gap: 5px; }
.schedule-calendar-corner strong { font-size: 12px; font-weight: 600; }
.schedule-calendar-corner>span { font-size: 10px; color: var(--ui-muted); white-space: nowrap; }
.schedule-date-header { flex: none; }
.schedule-week-header { height: 28px; position: relative; border-bottom: 1px solid var(--ui-line); background: var(--ui-surface-muted); }
.schedule-week { position: absolute; height: 28px; border-right: 1px solid var(--ui-line-strong); display: flex; align-items: center; gap: 8px; padding: 0 10px; overflow: hidden; white-space: nowrap; }
.schedule-week strong { font-size: 11px; color: var(--ui-accent); }
.schedule-week>span { color: var(--ui-subtle); font-size: 10px; }
.schedule-week-compact { flex-direction: column-reverse; justify-content: center; gap: 0; padding: 1px 3px; line-height: 12px; }.schedule-week-compact>span { font-size: 9px; line-height: 11px; }.schedule-week-compact strong { font-size: 11px; line-height: 12px; }
.schedule-day-header { height: 44px; position: relative; }
.schedule-day { position: absolute; height: 44px; border-right: 1px solid var(--ui-line); display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.35; gap: 3px; font-size: 11px; font-variant-numeric: tabular-nums; }
.schedule-day small { color: var(--ui-subtle); font-size: 9px; }
.schedule-day.weekend,.schedule-day.holiday { background: var(--ui-surface-muted); color: var(--ui-muted); }
.schedule-day.today { color: var(--ui-accent); background: var(--ui-accent-soft); box-shadow: inset 0 -2px var(--ui-accent); font-weight: 600; }
.schedule-track { display: flex; position: relative; height: var(--schedule-track-height); min-width: 100%; }
.schedule-overall-track { z-index: 8; box-shadow: 0 2px 0 var(--ui-line-strong); }
.schedule-overall-pinned { position: sticky; top: 72px; }
.schedule-track-label { overflow: hidden; position: sticky; left: 0; z-index: 5; flex: 0 0 var(--schedule-label-width); width: var(--schedule-label-width); height: var(--schedule-track-height); background: var(--ui-surface); border-right: 1px solid var(--ui-line-strong); border-bottom: 1px solid var(--ui-line); padding: 13px 20px 18px 13px; display: flex; align-items: flex-start; gap: 9px; }
.schedule-overall-track .schedule-track-label { background: var(--ui-accent-soft); }
.schedule-track-label>div:not(.schedule-track-ruler) { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.schedule-track-label strong { font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-track-label>div:not(.schedule-track-ruler)>span { font-size: 10px; color: var(--ui-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-track-label small { font-size: 9px; color: var(--ui-subtle); margin-top: 0; }
.schedule-track-label.has-workload{padding-top:8px;padding-bottom:20px}.schedule-track-label.has-workload>div:not(.schedule-track-ruler){height:100%;min-height:0;gap:2px}.has-workload>div>strong{line-height:16px;flex:none}.has-workload>div>span{line-height:12px;flex:none}
.schedule-workload-list{list-style:none;margin:2px 0 0;padding:0 3px 0 0;min-height:18px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;outline-offset:1px;font-variant-numeric:tabular-nums}.schedule-workload-list li{height:18px;display:flex;align-items:center;justify-content:space-between;gap:5px;white-space:nowrap;color:var(--ui-muted);font-size:10px}.schedule-workload-list li strong{font-size:10px;line-height:18px;color:var(--ui-text);flex:none}
.schedule-role-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--role-color); }
.schedule-track-lane { position: relative; flex: none; height: var(--schedule-track-height); border-bottom: 1px solid var(--ui-line); background-color: var(--ui-surface); background-image: linear-gradient(to right, transparent calc(100% - 1px), var(--ui-line) calc(100% - 1px)); background-size: var(--schedule-day-width) 100%; }
.schedule-overall-track .schedule-track-lane { background-color: color-mix(in srgb, var(--ui-accent-soft) 35%, var(--ui-surface)); }
.schedule-lane-midline { position: absolute; top: 50%; left: 0; right: 0; border-top: 1px dashed var(--ui-line); pointer-events: none; }
.schedule-period-hint { position: absolute; left: 5px; font-size: 8px; color: var(--ui-subtle); opacity: .7; pointer-events: none; }
.period-morning { top: 9px; }.period-afternoon { top: calc(50% + 3px); }
.schedule-lane-hint { position: sticky; left: calc(var(--schedule-label-width) + 14px); display: inline-block; margin: calc(var(--schedule-track-height) / 2 - 10px) 14px 0; color: var(--ui-subtle); font-size: 10px; pointer-events: none; white-space: nowrap; }
.schedule-event { position: absolute; top: 9px; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-width: 0; padding: 10px 11px; border: 1px solid color-mix(in srgb, var(--event-color) 50%, var(--ui-line)); border-left: 3px solid var(--event-color); border-radius: 6px; background: color-mix(in srgb, var(--event-color) 13%, var(--ui-surface)); color: var(--ui-text); cursor: grab; user-select: none; touch-action: none; overflow: hidden; text-align: left; z-index: 2; }
.schedule-event:hover { background: color-mix(in srgb, var(--event-color) 19%, var(--ui-surface)); border-color: var(--event-color); }
.schedule-event.selected { outline: 2px solid var(--event-color); outline-offset: 1px; z-index: 3; }
.schedule-event:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.schedule-event-title { width: 100%; min-height: 16px; font-size: 11px; line-height: 16px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; pointer-events: none; }
.schedule-event-dates { max-width: 100%; font-size: 9px; line-height: 12px; font-variant-numeric: tabular-nums; color: var(--ui-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; pointer-events: none; }
.schedule-event-owner { max-width: 100%; margin-top: auto; font-size: 9px; line-height: 13px; padding: 1px 5px; border-radius: 3px; color: var(--ui-text); background: color-mix(in srgb, var(--event-color) 12%, var(--ui-surface)); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; pointer-events: none; }
.schedule-event.event-half { padding-block: 6px; gap: 2px; }
.schedule-event.event-half .schedule-event-owner { position: absolute; right: 8px; top: 5px; max-width: 42%; }
.schedule-event.event-half:has(.schedule-event-owner) .schedule-event-title { padding-right: 45%; }
.schedule-event.event-drag-source { opacity: .22; }
.schedule-resize-handle { position: absolute; z-index: 4; pointer-events: none; }
.resize-start,.resize-end { top: 0; bottom: var(--resize-bottom-height); width: var(--resize-side-width); }
.resize-start { left: 0; }.resize-end { right: 0; }
.resize-start::after,.resize-end::after { content: ''; position: absolute; top: 35%; bottom: 35%; width: 3px; background: var(--event-color); opacity: .65; border-radius: 2px; }
.resize-start::after { left: 2px; }.resize-end::after { right: 2px; }
.resize-height { height: var(--resize-bottom-height); bottom: 0; left: var(--resize-side-width); right: var(--resize-side-width); }
.resize-height::after { content: ''; position: absolute; left: 50%; width: min(20px, 70%); transform: translateX(-50%); height: 3px; bottom: 2px; border-radius: 2px; background: var(--event-color); opacity: .65; }
.schedule-event:hover .schedule-resize-handle::after,.schedule-event:focus-visible .schedule-resize-handle::after { opacity: 1; }
.schedule-preview-overlay { position: absolute; inset: 0 0 27px; overflow: hidden; pointer-events: none; z-index: 20; clip-path: inset(72px 0 0 192px); }
.schedule-copy-preview { position: absolute; transform: translate(4px, 4px); padding: 2px 6px; border-radius: 4px; background: var(--ui-accent); color: white; font-size: 10px; font-weight: 600; box-shadow: 0 1px 4px #0002; white-space: nowrap; }
.event-copy-ghost { outline-style: dashed !important; }
.schedule-event-ghost { pointer-events: none; outline: 2px solid var(--event-color); outline-offset: 1px; box-shadow: 0 4px 12px #0002; opacity: .95; }
.schedule-calendar-empty,.schedule-timeline-empty { position: sticky; left: 0; width: min(100%, 800px); padding: 30px 22px; font-size: 12px; color: var(--ui-muted); }
.schedule-timeline-help { flex: none; height: 27px; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 0 12px; border-top: 1px solid var(--ui-line); background: var(--ui-surface-muted); color: var(--ui-subtle); font-size: 9px; }
.schedule-timeline-help>span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-timeline-help>span:last-child { flex: none; }
.schedule-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.schedule-track-ruler { position: absolute; top: 0; right: 0; bottom: 0; width: 16px; background: repeating-linear-gradient(to bottom, transparent 0 27px, var(--ui-line-strong) 27px 28px); color: var(--ui-subtle); font-size: 8px; pointer-events: none; }
.schedule-track-ruler>span { position: absolute; right: 0; width: 16px; height: 1px; border-top: 1px solid var(--ui-line-strong); text-align: left; line-height: 12px; }
.schedule-track-ruler>span { color: transparent; }
.track-resizing .schedule-track-ruler>span,.schedule-track:focus-within .schedule-track-ruler>span { color: var(--ui-muted); }
.schedule-track-height-label { position: absolute; bottom: 9px; right: 8px; font-size: 9px; color: var(--ui-subtle); pointer-events: none; font-variant-numeric: tabular-nums; }
.track-resizing .schedule-track-height-label { color: var(--ui-accent); font-weight: 600; }
.schedule-track-resize { position: absolute; left: 0; right: 0; bottom: -3px; height: 7px; padding: 0; border: 0; border-radius: 0; background: transparent; z-index: 7; cursor: ns-resize; touch-action: none; }
.schedule-track-resize>span { display: block; width: 100%; height: 2px; background: transparent; }
.schedule-track-resize:hover>span,.schedule-track-resize:focus-visible>span,.track-resizing .schedule-track-resize>span { background: var(--ui-accent); }
.schedule-track-resize:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }
.schedule-track-resize:disabled { cursor: default; }
.track-resizing .schedule-track-label { background-color: var(--ui-accent-soft); }
.is-dragging { user-select: none; }
.is-copying .schedule-timeline-scroll,.is-copying .schedule-timeline-scroll * { cursor: copy !important; }
.is-disabled .schedule-track-lane { cursor: default; }
@media (max-width: 650px) { .schedule-timeline-help>span:last-child { display: none; } }
</style>
