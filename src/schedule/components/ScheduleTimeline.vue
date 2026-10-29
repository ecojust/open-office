<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ScheduleEvent, ScheduleProject } from '../model.ts'
import type { HolidayYears } from '../holidays.ts'
import { buildCalendar, moveScheduledEvent, projectedSpan, resizeScheduledEvent } from '../calendar.ts'

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
 create: [position: { roleId: string | null; date: string; slot: 0 | 1 }]
 delete: [id: string]
 error: [message: string]
 gesture: [value: boolean]
}>()

const LABEL_WIDTH = 192, HEADER_HEIGHT = 72, TRACK_HEIGHT = 112, PADDING = 9, FULL_HEIGHT = TRACK_HEIGHT - PADDING * 2
const root = ref<HTMLElement>(), viewport = ref<HTMLElement>()
const scrollLeft = ref(0), viewportWidth = ref(900)
const preview = shallowRef<ScheduleEvent>(), previewPixels = ref<number>(), ghostStyle = ref<Record<string, string>>({})
const dragKind = ref<GestureKind>(), announcement = ref('')
const lanes = new Map<string, HTMLElement>()
const daysOfWeek = ['日', '一', '二', '三', '四', '五', '六']
const calendar = computed(() => buildCalendar(props.project, props.holidayYears))
const columnWidth = computed(() => Math.max(36, Math.min(160, Number.isFinite(props.dayWidth) ? props.dayWidth : 64)))
const calendarWidth = computed(() => Math.max(columnWidth.value, calendar.value.days.length * columnWidth.value))
const contentWidth = computed(() => LABEL_WIDTH + calendarWidth.value)
const firstVisible = computed(() => Math.max(0, Math.floor(scrollLeft.value / columnWidth.value) - 2))
const lastVisible = computed(() => Math.min(calendar.value.days.length, Math.ceil((scrollLeft.value + viewportWidth.value - LABEL_WIDTH) / columnWidth.value) + 2))
const visibleDays = computed(() => calendar.value.days.slice(firstVisible.value, lastVisible.value).map((day, index) => ({ ...day, index: firstVisible.value + index })))
const visibleWeeks = computed(() => calendar.value.weeks.filter(week => week.startIndex < lastVisible.value && week.startIndex + week.count > firstVisible.value))
const roleById = computed(() => new Map(props.project.roles.map(role => [role.id, role])))
type DisplayEvent = { event: ScheduleEvent; start: number; count: number }
type TimelineRow = { key: string; roleId: string | null; name: string; subtitle: string; color: string; events: DisplayEvent[]; total: number }
const rows = computed<TimelineRow[]>(() => {
 const eventsByRole = new Map<string | null, ScheduleEvent[]>()
 for (const event of props.project.events) {
  const list = eventsByRole.get(event.roleId) ?? []
  list.push(event); eventsByRole.set(event.roleId, list)
 }
 const display = (events: ScheduleEvent[]): DisplayEvent[] => events.flatMap(event => {
  const span = projectedSpan(event, calendar.value.days)
  return span ? [{ event, ...span }] : []
 })
 const overall = eventsByRole.get(null) ?? []
 const result: TimelineRow[] = [{ key: 'overall', roleId: null, name: '整体计划', subtitle: '项目阶段与关键节点', color: 'var(--ui-accent)', events: display(overall), total: overall.length }]
 if (props.mode === 'people') {
  for (const role of props.project.roles) {
   const events = eventsByRole.get(role.id) ?? []
   result.push({ key: `person-${role.id}`, roleId: role.id, name: role.name, subtitle: role.role || '项目成员', color: role.color, events: display(events), total: events.length })
  }
 } else {
  for (const event of props.project.events.filter(event => event.roleId !== null).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.title.localeCompare(b.title))) {
   const role = roleById.value.get(event.roleId!)
   result.push({ key: `event-${event.id}`, roleId: event.roleId, name: event.title, subtitle: role ? `${role.name}${role.role ? ` · ${role.role}` : ''}` : '项目成员', color: role?.color ?? 'var(--ui-accent)', events: display([event]), total: 1 })
  }
 }
 return result
})
const hiddenEvents = computed(() => props.project.events.filter(event => !projectedSpan(event, calendar.value.days)).length)
const previewColor = computed(() => preview.value?.roleId ? roleById.value.get(preview.value.roleId)?.color ?? 'var(--ui-accent)' : 'var(--ui-accent)')
const previewOwner = computed(() => preview.value?.roleId ? roleById.value.get(preview.value.roleId)?.name : '整体计划')
const today = (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` })()
type GestureKind = 'move' | 'start' | 'end' | 'height'
type PointerGesture = {
 kind: GestureKind; pointerId: number; element: HTMLElement; original: ScheduleEvent; base: ScheduleProject
 sourceKey: string; targetKey: string; startX: number; startY: number; x: number; y: number
 startScrollLeft: number; startHeight: number; moved: boolean; width: number
}
let gesture: PointerGesture | undefined, frame = 0, frameTime = 0, observer: ResizeObserver | undefined, suppressClickUntil = 0

function setLane(key: string, element: unknown) {
 if (element instanceof HTMLElement) lanes.set(key, element)
 else lanes.delete(key)
}
function rowTestKey(row: TimelineRow): string {
 return props.mode === 'people' && row.roleId !== null ? (row.roleId === 'overall' ? 'person-overall' : row.roleId) : row.key
}
function eventStyle(item: DisplayEvent, color: string) {
 return { left: `${item.start * columnWidth.value + 3}px`, width: `${Math.max(10, item.count * columnWidth.value - 6)}px`, height: `${FULL_HEIGHT * item.event.height}px`, '--event-color': color }
}
function eventTitle(event: ScheduleEvent): string {
 const name = event.roleId ? roleById.value.get(event.roleId)?.name ?? '' : '整体计划'
 return `${event.title}\n${name} · ${event.startDate} 至 ${event.endDate}\n${event.height === 1 ? '整行高度' : '半行高度'}${event.notes ? `\n${event.notes}` : ''}`
}
function sameEvent(a: ScheduleEvent, b: ScheduleEvent): boolean {
 return a.roleId === b.roleId && a.startDate === b.startDate && a.endDate === b.endDate && a.height === b.height && a.slot === b.slot
}
function canEdit(): boolean { return props.active && !props.disabled }
function onScroll() {
 scrollLeft.value = viewport.value?.scrollLeft ?? 0
 if (gesture?.moved) updatePreview()
}
function targetRow(drag: PointerGesture): TimelineRow | undefined {
 const scroll = viewport.value
 if (!scroll) return undefined
 if (props.mode === 'global') return rows.value.find(row => row.key === drag.sourceKey)
 const bounds = scroll.getBoundingClientRect()
 if (drag.x < bounds.left + LABEL_WIDTH || drag.x > bounds.right || drag.y < bounds.top + HEADER_HEIGHT || drag.y > bounds.bottom) return undefined
 // The overall row is sticky and therefore wins over rows scrolling beneath it.
 for (const row of rows.value) {
  const lane = lanes.get(row.key), rect = lane?.getBoundingClientRect()
  if (rect && drag.y >= rect.top && drag.y < rect.bottom) return row
 }
 return undefined
}
function placeGhost() {
 const drag = gesture, event = preview.value, wrapper = root.value
 if (!drag || !event || !wrapper) return
 const span = projectedSpan(event, calendar.value.days), lane = lanes.get(drag.targetKey)
 if (!span || !lane) return
 const bounds = wrapper.getBoundingClientRect(), rect = lane.getBoundingClientRect()
 ghostStyle.value = {
  left: `${rect.left - bounds.left + span.start * columnWidth.value + 3}px`,
  top: `${rect.top - bounds.top + PADDING}px`,
  width: `${Math.max(10, span.count * columnWidth.value - 6)}px`,
  height: `${previewPixels.value ?? FULL_HEIGHT * event.height}px`,
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
   preview.value = moveScheduledEvent(previewProject, drag.original, delta, roleId, 0, calendar.value.days)
  } else if (drag.kind === 'height') {
   const height = Math.max(FULL_HEIGHT / 2, Math.min(FULL_HEIGHT, drag.startHeight + drag.y - drag.startY))
   previewPixels.value = height
   preview.value = { ...drag.original, height: height < FULL_HEIGHT * .75 ? .5 : 1, slot: 0 }
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
  const rect = scroll.getBoundingClientRect(), left = rect.left + LABEL_WIDTH, right = rect.right
  const speed = (position: number, start: number, end: number) => position < start + 38 ? -Math.min(1, (start + 38 - position) / 38) : position > end - 38 ? Math.min(1, (position - end + 38) / 38) : 0
  if (drag.y >= rect.top + HEADER_HEIGHT && drag.y <= rect.bottom) scroll.scrollLeft += speed(drag.x, left, right) * elapsed * .8
  if (drag.kind === 'move' && props.mode === 'people' && drag.x >= left && drag.x <= right) {
   const top = rect.top + HEADER_HEIGHT + TRACK_HEIGHT
   if (drag.y > rect.top + HEADER_HEIGHT + TRACK_HEIGHT / 2) scroll.scrollTop += speed(drag.y, top, rect.bottom) * elapsed * .6
  }
  scrollLeft.value = scroll.scrollLeft
  updatePreview()
 }
 frame = requestAnimationFrame(autoScroll)
}
function startGesture(event: PointerEvent, item: ScheduleEvent, rowKey: string, kind: GestureKind) {
 if (!canEdit() || gesture || event.button !== 0 || !event.isPrimary) return
 event.preventDefault(); event.stopPropagation()
 const element = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-event-id]')
 if (!element) return
 emit('select', item.id); element.focus({ preventScroll: true })
 gesture = { kind, pointerId: event.pointerId, element, original: { ...item }, base: props.project, sourceKey: rowKey, targetKey: rowKey, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, startScrollLeft: viewport.value?.scrollLeft ?? 0, startHeight: FULL_HEIGHT * item.height, moved: false, width: columnWidth.value }
 dragKind.value = kind; announcement.value = ''
 try { element.setPointerCapture(event.pointerId) } catch { /* Window listeners cover devices without pointer capture. */ }
 element.addEventListener('lostpointercapture', cancelPointer)
 window.addEventListener('pointermove', movePointer, { passive: false })
 window.addEventListener('pointerup', finishPointer)
 window.addEventListener('pointercancel', cancelPointer)
 window.addEventListener('blur', cancelGesture)
 window.addEventListener('keydown', gestureKeyboard)
 frameTime = 0; frame = requestAnimationFrame(autoScroll)
 emit('gesture', true)
}
function movePointer(event: PointerEvent) {
 const drag = gesture
 if (!drag || event.pointerId !== drag.pointerId) return
 if (!canEdit() || event.buttons === 0) { cancelGesture(); return }
 event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY
 if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4) return
 drag.moved = true; updatePreview()
}
function releaseGesture() {
 const drag = gesture
 gesture = undefined; preview.value = undefined; previewPixels.value = undefined; dragKind.value = undefined
 cancelAnimationFrame(frame); frame = 0; frameTime = 0
 window.removeEventListener('pointermove', movePointer)
 window.removeEventListener('pointerup', finishPointer)
 window.removeEventListener('pointercancel', cancelPointer)
 window.removeEventListener('blur', cancelGesture)
 window.removeEventListener('keydown', gestureKeyboard)
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
 drag.x = event.clientX; drag.y = event.clientY
 if (drag.moved) updatePreview()
 const changed = preview.value, valid = canEdit() && drag.base === props.project
 if (drag.moved) suppressClickUntil = performance.now() + 300
 releaseGesture()
 if (valid && changed && !sameEvent(changed, drag.original)) {
  emit('change', { ...changed, slot: 0 })
  announcement.value = `${changed.title}：${changed.startDate} 至 ${changed.endDate}，${changed.height === 1 ? '整行' : '半行'}高度。`
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-event-id="${changed.id}"]`)?.focus({ preventScroll: true }))
 }
}
function cancelGesture() { if (gesture) { releaseGesture(); announcement.value = '已取消调整。' } }
function cancelPointer(event: PointerEvent) { if (event.pointerId === gesture?.pointerId) cancelGesture() }
function gestureKeyboard(event: KeyboardEvent) { if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); cancelGesture() } }
function selectEvent(event: MouseEvent, id: string) { event.stopPropagation(); if (performance.now() >= suppressClickUntil) emit('select', id) }
function editEvent(event: MouseEvent, id: string) { event.stopPropagation(); if (canEdit() && performance.now() >= suppressClickUntil) emit('edit', id) }
function createEvent(event: MouseEvent, row: TimelineRow) {
 if (!canEdit() || gesture || !calendar.value.days.length || (event.target as HTMLElement).closest('[data-event-id]')) return
 const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
 const index = Math.max(0, Math.min(calendar.value.days.length - 1, Math.floor((event.clientX - bounds.left) / columnWidth.value)))
 emit('create', { roleId: row.roleId, date: calendar.value.days[index].date, slot: 0 })
}
function eventKeyboard(event: KeyboardEvent, item: ScheduleEvent) {
 if (gesture || !canEdit() || event.ctrlKey || event.metaKey || event.altKey) return
 if (event.key === 'Enter') { event.preventDefault(); emit('edit', item.id); return }
 if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); emit('delete', item.id); return }
 if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
 event.preventDefault(); event.stopPropagation()
 try {
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  const delta = horizontal ? (event.key === 'ArrowLeft' ? -1 : 1) : 0
  let roleId = item.roleId
  if (!horizontal) {
   if (props.mode === 'global') return
   const index = rows.value.findIndex(row => row.roleId === item.roleId), next = rows.value[index + (event.key === 'ArrowUp' ? -1 : 1)]
   if (!next) return
   roleId = next.roleId
  }
  const candidate = event.shiftKey && horizontal ? resizeScheduledEvent(props.project, item, 'end', delta, calendar.value.days) : moveScheduledEvent(props.project, item, delta, roleId, 0, calendar.value.days)
  if (!sameEvent(item, candidate)) emit('change', candidate)
 } catch (cause) { emit('error', cause instanceof Error ? cause.message : String(cause)) }
}
function focusSelected() {
 if (!props.selectedId || gesture) return
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
  observer = new ResizeObserver(() => { viewportWidth.value = viewport.value?.clientWidth ?? 900; if (gesture) cancelGesture() })
  observer.observe(viewport.value); viewportWidth.value = viewport.value.clientWidth
 }
})
onBeforeUnmount(() => { cancelGesture(); observer?.disconnect(); lanes.clear() })
defineExpose({ cancelGesture })
</script>

<template>
 <section ref="root" class="schedule-timeline" :class="{ 'is-dragging': preview, 'is-disabled': disabled }" :data-day-width="columnWidth" :data-track-height="TRACK_HEIGHT" data-testid="schedule-timeline" :style="{ '--schedule-label-width': `${LABEL_WIDTH}px`, '--schedule-day-width': `${columnWidth}px` }" aria-label="项目排期时间线">
  <div ref="viewport" class="schedule-timeline-scroll" data-testid="schedule-timeline-scroll" tabindex="0" @scroll="onScroll">
   <div class="schedule-timeline-content" :style="{ width: `${contentWidth}px` }">
    <div class="schedule-calendar-header">
     <div class="schedule-calendar-corner"><strong>{{ mode === 'people' ? '人员 / 角色' : '全局事件' }}</strong><span>{{ calendar.days.length }} 个显示日<span v-if="calendar.hiddenCount"> · 隐藏 {{ calendar.hiddenCount }} 天</span></span></div>
     <div class="schedule-date-header" :style="{ width: `${calendarWidth}px` }">
      <div class="schedule-week-header"><div v-for="week in visibleWeeks" :key="week.key" class="schedule-week" :style="{ left: `${week.startIndex * columnWidth}px`, width: `${week.count * columnWidth}px` }" :data-week="week.label"><strong>{{ week.label }}</strong><span>{{ calendar.days[week.startIndex]?.date.slice(5).replace('-', '/') }}</span></div></div>
      <div class="schedule-day-header"><div v-for="day in visibleDays" :key="day.date" class="schedule-day" :class="{ weekend: day.weekday === 0 || day.weekday === 6, holiday: day.holiday, today: day.date === today }" :style="{ left: `${day.index * columnWidth}px`, width: `${columnWidth}px` }" :data-date="day.date" :title="`${day.date} 周${daysOfWeek[day.weekday]}${day.holiday ? ` · ${day.holiday}` : ''}`"><span>{{ day.date.slice(5).replace('-', '/') }}</span><small>周{{ daysOfWeek[day.weekday] }}</small></div></div>
     </div>
    </div>
    <div v-for="row in rows" :key="row.key" class="schedule-track" :class="{ 'schedule-overall-track': row.key === 'overall' }" :data-testid="`schedule-track-${rowTestKey(row)}`" :data-role-id="row.roleId ?? 'overall'" :data-track-key="row.key">
     <div class="schedule-track-label" :data-testid="`schedule-label-${rowTestKey(row)}`" :style="{ '--role-color': row.color }"><span class="schedule-role-dot" /><div><strong :title="row.name">{{ row.name }}</strong><span :title="row.subtitle">{{ row.subtitle }}</span><small v-if="mode === 'people' || row.key === 'overall'">{{ row.total }} 个事件<span v-if="row.total > row.events.length"> · {{ row.total - row.events.length }} 个已隐藏</span></small></div></div>
     <div :ref="element => setLane(row.key, element)" class="schedule-track-lane" :style="{ width: `${calendarWidth}px` }" :data-testid="`schedule-lane-${rowTestKey(row)}`" :data-role-id="row.roleId ?? 'overall'" @dblclick="createEvent($event, row)">
      <span v-if="!row.total && calendar.days.length" class="schedule-lane-hint">双击日期空白处添加{{ row.key === 'overall' ? '整体计划' : '事件' }}</span>
      <span v-else-if="row.total && !row.events.length" class="schedule-lane-hint">事件日期已隐藏，可在事件列表中编辑</span>
      <button v-for="item in row.events" :key="item.event.id" type="button" class="schedule-event" :class="{ selected: selectedId === item.event.id, 'event-half': item.event.height === .5, 'event-drag-source': preview?.id === item.event.id }" :style="eventStyle(item, row.color)" :data-testid="`schedule-event-${item.event.id}`" :data-event-id="item.event.id" :data-role-id="item.event.roleId ?? 'overall'" :data-height="item.event.height" :data-start-date="item.event.startDate" :data-end-date="item.event.endDate" :aria-label="eventTitle(item.event)" :aria-pressed="selectedId === item.event.id" :title="eventTitle(item.event)" :disabled="disabled || !active" @pointerdown="startGesture($event, item.event, row.key, 'move')" @click="selectEvent($event, item.event.id)" @dblclick="editEvent($event, item.event.id)" @keydown="eventKeyboard($event, item.event)">
       <span class="schedule-resize-handle resize-start" data-testid="resize-start" data-resize="start" title="拖动调整开始日期" @pointerdown.stop="startGesture($event, item.event, row.key, 'start')" />
       <strong class="schedule-event-title">{{ item.event.title }}</strong>
       <span class="schedule-event-dates">{{ item.event.startDate.slice(5).replace('-', '/') }} — {{ item.event.endDate.slice(5).replace('-', '/') }}</span>
       <span v-if="mode === 'global' && item.event.roleId" class="schedule-event-owner">{{ roleById.get(item.event.roleId)?.name }}</span>
       <span class="schedule-resize-handle resize-end" data-testid="resize-end" data-resize="end" title="拖动调整结束日期" @pointerdown.stop="startGesture($event, item.event, row.key, 'end')" />
       <span class="schedule-resize-handle resize-height" data-testid="resize-height" data-resize="height" title="拖动调整为整行或半行高度" @pointerdown.stop="startGesture($event, item.event, row.key, 'height')" />
      </button>
     </div>
    </div>
    <div v-if="!calendar.days.length" class="schedule-calendar-empty">当前日期范围中的日期全部被隐藏，请调整日期范围或显示周末、节假日。</div>
    <div v-else-if="mode === 'people' && !project.roles.length" class="schedule-timeline-empty">先添加项目角色，再安排每个人的事件。</div>
    <div v-else-if="mode === 'global' && rows.length === 1" class="schedule-timeline-empty">人员事件会按开始日期汇总显示在这里。</div>
   </div>
  </div>
  <div v-if="preview" class="schedule-preview-overlay" aria-hidden="true"><div class="schedule-event schedule-event-ghost" :class="{ 'event-half': preview.height === .5 }" :style="ghostStyle"><strong class="schedule-event-title">{{ preview.title }}</strong><span class="schedule-event-dates">{{ preview.startDate.slice(5).replace('-', '/') }} — {{ preview.endDate.slice(5).replace('-', '/') }}</span><span class="schedule-event-owner">{{ dragKind === 'height' ? `${preview.height * 100}% 高度` : previewOwner }}</span></div></div>
  <div class="schedule-timeline-help"><span>双击添加或编辑 · 拖动移动 · 左右拉伸日期 · 底边调整高度</span><span v-if="hiddenEvents">{{ hiddenEvents }} 个事件日期已隐藏</span><span v-else>方向键微调 · Esc 取消</span></div>
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
.schedule-day-header { height: 44px; position: relative; }
.schedule-day { position: absolute; height: 44px; border-right: 1px solid var(--ui-line); display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.35; gap: 3px; font-size: 11px; font-variant-numeric: tabular-nums; }
.schedule-day small { color: var(--ui-subtle); font-size: 9px; }
.schedule-day.weekend,.schedule-day.holiday { background: var(--ui-surface-muted); color: var(--ui-muted); }
.schedule-day.today { color: var(--ui-accent); background: var(--ui-accent-soft); box-shadow: inset 0 -2px var(--ui-accent); font-weight: 600; }
.schedule-track { display: flex; position: relative; height: 112px; min-width: 100%; }
.schedule-overall-track { position: sticky; top: 72px; z-index: 8; box-shadow: 0 2px 0 var(--ui-line-strong); }
.schedule-track-label { position: sticky; left: 0; z-index: 5; flex: 0 0 var(--schedule-label-width); width: var(--schedule-label-width); height: 112px; background: var(--ui-surface); border-right: 1px solid var(--ui-line-strong); border-bottom: 1px solid var(--ui-line); padding: 16px 13px; display: flex; align-items: flex-start; gap: 9px; }
.schedule-overall-track .schedule-track-label { background: var(--ui-accent-soft); }
.schedule-track-label>div { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.schedule-track-label strong { font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-track-label>div>span { font-size: 10px; color: var(--ui-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-track-label small { font-size: 9px; color: var(--ui-subtle); margin-top: 4px; }
.schedule-role-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--role-color); }
.schedule-track-lane { position: relative; flex: none; height: 112px; border-bottom: 1px solid var(--ui-line); background-color: var(--ui-surface); background-image: linear-gradient(to right, transparent calc(100% - 1px), var(--ui-line) calc(100% - 1px)); background-size: var(--schedule-day-width) 100%; }
.schedule-overall-track .schedule-track-lane { background-color: color-mix(in srgb, var(--ui-accent-soft) 35%, var(--ui-surface)); }
.schedule-lane-hint { position: sticky; left: calc(var(--schedule-label-width) + 14px); display: inline-block; margin: 46px 14px 0; color: var(--ui-subtle); font-size: 10px; pointer-events: none; white-space: nowrap; }
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
.schedule-resize-handle { position: absolute; z-index: 4; touch-action: none; }
.resize-start,.resize-end { top: 0; bottom: 5px; width: 8px; cursor: ew-resize; }
.resize-start { left: 0; }.resize-end { right: 0; }
.resize-start::after,.resize-end::after { content: ''; position: absolute; top: 35%; bottom: 35%; width: 2px; background: var(--event-color); opacity: .6; border-radius: 2px; }
.resize-start::after { left: 2px; }.resize-end::after { right: 2px; }
.resize-height { height: 7px; bottom: 0; left: 8px; right: 8px; cursor: ns-resize; }
.resize-height::after { content: ''; position: absolute; left: calc(50% - 8px); width: 16px; height: 2px; bottom: 2px; border-radius: 2px; background: var(--event-color); opacity: .55; }
.schedule-preview-overlay { position: absolute; inset: 0 0 27px; overflow: hidden; pointer-events: none; z-index: 20; clip-path: inset(72px 0 0 192px); }
.schedule-event-ghost { pointer-events: none; outline: 2px solid var(--event-color); outline-offset: 1px; box-shadow: 0 4px 12px #0002; opacity: .95; }
.schedule-calendar-empty,.schedule-timeline-empty { position: sticky; left: 0; width: min(100%, 800px); padding: 30px 22px; font-size: 12px; color: var(--ui-muted); }
.schedule-timeline-help { flex: none; height: 27px; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 0 12px; border-top: 1px solid var(--ui-line); background: var(--ui-surface-muted); color: var(--ui-subtle); font-size: 9px; }
.schedule-timeline-help>span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.schedule-timeline-help>span:last-child { flex: none; }
.schedule-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.is-dragging { user-select: none; }
.is-disabled .schedule-track-lane { cursor: default; }
@media (max-width: 650px) { .schedule-timeline-help>span:last-child { display: none; } }
</style>
