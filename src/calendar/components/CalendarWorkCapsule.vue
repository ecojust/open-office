<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import { dayAllocations, resizeAllocationBoundary } from '../allocation'
import type { CalendarBook, CalendarNote } from '../model'

const props = withDefaults(defineProps<{
 notes: CalendarNote[]; date: string; workdayHours: number; display: 'percent'|'hours'
 disabled?: boolean; dragEnabled?: boolean; selectedNoteId?: string|null; search?: string; expanded?: boolean; cancelToken?: number
}>(), { disabled: false, dragEnabled: true, selectedNoteId: null, search: '', expanded: false, cancelToken: 0 })
export type AllocationCommit = { date: string; leftNoteId: string; position: number; display: 'percent'|'hours' }
const emit = defineEmits<{
 select: [note: CalendarNote]; edit: [note: CalendarNote]; delete: [note: CalendarNote]
 dragstart: [event: DragEvent, note: CalendarNote]; dragend: []; contextmenu: [event: MouseEvent, note: CalendarNote]
 'allocation-start': []; 'allocation-commit': [value: AllocationCommit]; 'allocation-cancel': []
}>()
const capsule = ref<HTMLElement>()
const preview = shallowRef<ReturnType<typeof dayAllocations>>()
const activeBoundary = ref('')
type Gesture = { pointer: number; element: HTMLElement; leftNoteId: string; startX: number; startWeight: number; weightPerPixel: number; position: number; display: 'percent'|'hours'; book: CalendarBook; moved: boolean }
let gesture: Gesture | undefined
function bookFor(notes = props.notes): CalendarBook {
 return { format: 'open-office-calendar', version: 1, id: 'calendar-allocation-preview', title: '工时预览', notes, history: [], workdayHours: props.workdayHours, allocationDisplay: props.display, weekMode: 'week' }
}
const allocations = computed(() => preview.value ?? dayAllocations(bookFor(), props.date))
const noteById = computed(() => new Map(props.notes.map(note => [note.id, note])))
const entries = computed(() => allocations.value.map(item => ({ ...item, note: noteById.value.get(item.noteId)! })))
const number = (value: number, digits = 2) => Number(value.toFixed(digits)).toLocaleString('zh-CN')
function hoursText(hours: number) {
 const seconds = Math.round(hours * 3600), wholeHours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60
 return [wholeHours ? `${wholeHours} 小时` : '', minutes ? `${minutes} 分钟` : '', rest ? `${rest} 秒` : ''].filter(Boolean).join(' ') || '0 小时'
}
function matches(note: CalendarNote) { return !props.search.trim() || `${note.title}\n${note.content}\n${note.type}`.toLocaleLowerCase().includes(props.search.trim().toLocaleLowerCase()) }
function title(item: typeof entries.value[number]) { return `${item.title} · ${number(item.percent)}% · ${hoursText(item.hours)}${item.note.content ? '\n' + item.note.content : ''}` }
function cancel() {
 const current = gesture
 gesture = undefined; activeBoundary.value = ''; preview.value = undefined
 if (current) {
  if (current.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer)
  emit('allocation-cancel')
 }
}
function start(event: PointerEvent, leftNoteId: string) {
 if (props.disabled || event.button !== 0 || !event.isPrimary || gesture) return
 const items = allocations.value, index = items.findIndex(item => item.noteId === leftNoteId), left = items[index], right = items[index + 1]
 if (!left || !right) return
 const element = event.currentTarget as HTMLElement, segment = element.parentElement!, nextSegment = segment.nextElementSibling as HTMLElement|undefined
 const width = segment.getBoundingClientRect().width + (nextSegment?.getBoundingClientRect().width ?? 0)
 if (!width || left.weight + right.weight <= 0) return
 event.preventDefault(); event.stopPropagation(); element.focus({ preventScroll: true })
 try { element.setPointerCapture(event.pointerId) } catch { return }
 gesture = { pointer: event.pointerId, element, leftNoteId, startX: event.clientX, startWeight: left.end, weightPerPixel: (left.weight + right.weight) / width, position: left.end * (props.display === 'percent' ? 100 : props.workdayHours), display: props.display, book: bookFor(props.notes.map(note => ({ ...note }))), moved: false }
 activeBoundary.value = leftNoteId; emit('allocation-start')
}
function move(event: PointerEvent) {
 const current = gesture
 if (!current || current.pointer !== event.pointerId) return
 event.preventDefault(); event.stopPropagation()
 const position = (current.startWeight + (event.clientX - current.startX) * current.weightPerPixel) * (current.display === 'percent' ? 100 : props.workdayHours)
 current.position = position; current.moved ||= Math.abs(event.clientX - current.startX) >= 1
 resizeAllocationBoundary(current.book, props.date, current.leftNoteId, position, current.display)
 preview.value = dayAllocations(current.book, props.date)
}
function end(event: PointerEvent) {
 const current = gesture
 if (!current || current.pointer !== event.pointerId) return
 event.preventDefault(); event.stopPropagation()
 gesture = undefined; activeBoundary.value = ''; preview.value = undefined
 if (current.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer)
 if (current.moved) emit('allocation-commit', { date: props.date, leftNoteId: current.leftNoteId, position: current.position, display: current.display })
 else emit('allocation-cancel')
}
function keyboard(event: KeyboardEvent, leftNoteId: string) {
 if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); cancel(); return }
 if (props.disabled || gesture || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
 const items = allocations.value, index = items.findIndex(item => item.noteId === leftNoteId), left = items[index], right = items[index + 1]
 if (!left || !right) return
 event.preventDefault(); event.stopPropagation()
 const unit = props.display === 'percent' ? 100 : props.workdayHours, step = props.display === 'percent' ? 10 : .5
 const position = event.key === 'Home' ? 0 : event.key === 'End' ? unit : left.end * unit + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step)
 emit('allocation-commit', { date: props.date, leftNoteId, position, display: props.display })
}
watch(() => props.cancelToken, cancel)
watch(() => props.disabled, disabled => { if (disabled) cancel() })
watch(() => props.date, cancel)
onBeforeUnmount(cancel)
defineExpose({ cancel })
</script>

<template>
 <div class="calendar-work-scroll" :class="{'calendar-work-expanded':expanded,'calendar-work-static':!dragEnabled}">
  <div ref="capsule" class="calendar-work-capsule" :data-testid="`calendar-work-capsule-${date}`" :style="{'--capsule-min-width':`${Math.max(1,notes.length)*64}px`}" :aria-label="`${date} 工作分配，全天 ${workdayHours} 小时`">
   <div v-for="(item,index) in entries" :key="item.noteId" class="calendar-work-segment" :class="{'calendar-work-selected':selectedNoteId===item.noteId,'calendar-work-dimmed':!matches(item.note),'calendar-work-zero':item.weight===0}" :style="{'--note-color':item.color,flexGrow:item.weight,flexBasis:'0px'}" :data-testid="`calendar-note-${item.noteId}`" :data-note-id="item.noteId" :data-allocation-percent="item.percent" :data-allocation-hours="item.hours" :draggable="dragEnabled && !disabled && !activeBoundary" @dragstart="emit('dragstart',$event,item.note)" @dragend="emit('dragend')" @contextmenu.stop="emit('contextmenu',$event,item.note)" @dblclick.stop="emit('edit',item.note)">
    <button type="button" class="calendar-note-title" :data-testid="`calendar-note-title-${item.noteId}`" :title="title(item)" :disabled="disabled" @click.stop="emit('select',item.note)" @keydown.enter.stop.prevent="emit('edit',item.note)"><span>{{item.title}}</span><strong>{{display==='percent'?`${number(item.percent)}%`:`${number(item.hours)}h`}}</strong></button>
    <button type="button" class="calendar-work-delete" :data-testid="`calendar-note-delete-${item.noteId}`" :aria-label="`删除 ${item.title}`" :disabled="disabled || !!activeBoundary" @click.stop="emit('delete',item.note)" @dblclick.stop><Icon name="close" :size="11"/></button>
    <span v-if="index<entries.length-1" class="calendar-work-divider" :class="{'calendar-work-divider-active':activeBoundary===item.noteId}" :data-testid="`calendar-work-divider-${item.noteId}-${entries[index+1]!.noteId}`" role="slider" :tabindex="disabled?-1:0" aria-orientation="horizontal" :aria-label="`调整 ${item.title} 与 ${entries[index+1]!.title} 的工时分配`" :aria-valuemin="item.start*(display==='percent'?100:workdayHours)" :aria-valuemax="entries[index+1]!.end*(display==='percent'?100:workdayHours)" :aria-valuenow="item.end*(display==='percent'?100:workdayHours)" :aria-valuetext="`${item.title} ${number(item.percent)}%，${hoursText(item.hours)}；方向键每次${display==='percent'?'10%':'0.5 小时'}`" :aria-disabled="disabled" :title="`拖动分隔线调整工时；方向键每次${display==='percent'?'10%':'0.5 小时'}`" @pointerdown="start($event,item.noteId)" @pointermove="move" @pointerup="end" @pointercancel="cancel" @lostpointercapture="cancel" @keydown="keyboard($event,item.noteId)" @click.stop.prevent @dblclick.stop.prevent @dragstart.stop.prevent/>
   </div>
  </div>
 </div>
</template>

<style scoped>
.calendar-work-scroll{min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;padding:3px 2px 6px}.calendar-work-capsule{min-width:var(--capsule-min-width);display:flex;align-items:stretch;min-height:43px;border-radius:22px;background:var(--ui-surface);box-shadow:0 0 0 1px var(--ui-line-strong);isolation:isolate}.calendar-work-segment{min-width:25px;position:relative;display:flex;align-items:stretch;background:color-mix(in srgb,var(--note-color) 30%,var(--ui-surface));color:var(--ui-text);cursor:grab}.calendar-work-segment:first-child{border-radius:22px 0 0 22px}.calendar-work-segment:last-child{border-radius:0 22px 22px 0}.calendar-work-segment:only-child{border-radius:22px}.calendar-work-selected{box-shadow:inset 0 0 0 2px var(--ui-accent);z-index:1}.calendar-work-dimmed{opacity:.45}.calendar-work-zero{background:var(--ui-surface-muted)}.calendar-note-title{display:flex;min-width:0;width:100%;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:2px;overflow:hidden;padding:6px 9px;cursor:grab;font-size:10px;line-height:1.25}.calendar-note-title span{max-width:100%;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.calendar-note-title strong{font-size:11px;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.calendar-work-delete{position:absolute;right:4px;top:1px;padding:1px;opacity:0;color:var(--ui-muted);background:var(--ui-surface);border-radius:50%;z-index:2}.calendar-work-segment:hover .calendar-work-delete,.calendar-work-segment:focus-within .calendar-work-delete{opacity:1}.calendar-work-delete:hover{color:var(--ui-danger)}.calendar-work-segment.calendar-note-drag-source .calendar-work-delete{opacity:0;visibility:hidden}.calendar-work-static .calendar-work-segment,.calendar-work-static .calendar-note-title{cursor:default}.calendar-work-divider{position:absolute;right:-6px;top:1px;bottom:1px;width:12px;cursor:ew-resize;touch-action:none;z-index:4;outline-offset:-1px}.calendar-work-divider:before{content:'';position:absolute;top:6px;bottom:6px;left:5px;width:2px;background:color-mix(in srgb,var(--ui-text) 30%,transparent);border-radius:1px}.calendar-work-divider:hover:before,.calendar-work-divider:focus-visible:before,.calendar-work-divider-active:before{background:var(--ui-accent);width:3px;left:4px}.calendar-work-divider-active{z-index:5}.calendar-work-expanded .calendar-work-capsule{min-height:60px}.calendar-work-expanded .calendar-note-title{font-size:12px}.calendar-work-expanded .calendar-note-title strong{font-size:13px}.calendar-work-expanded .calendar-work-scroll{padding-bottom:9px}
</style>
