<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import ScheduleTimeline from '../schedule/components/ScheduleTimeline.vue'
import { encodeSchedule, scheduleId, type ScheduleEvent, type ScheduleProject, type ScheduleRole } from '../schedule/model'
import { pruneTrackHeights, SCHEDULE_TRACK_HEIGHT } from '../schedule/layout'
import { exportSchedulePng } from '../schedule/png-export'
import { buildCalendar, projectedSpan } from '../schedule/calendar'
import type { HolidayYears } from '../schedule/holidays'
import { getHolidayClient, flushHolidayCache } from '../schedule/holiday-native'
import { ScheduleSession } from '../schedule/session'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { useDialogFocus } from '../shared/dialog-focus'
import type { Appearance } from '../shared/appearance'
import type { NativeDocument } from '../types'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; import: []; export: [format: 'json'|'png']; 'file-action': [action: 'new'|'open'|'save'|'saveAs'|'print'|'close'] }>()
const root = ref<HTMLElement>(), dialogElement = ref<HTMLElement>(), timeline = ref<InstanceType<typeof ScheduleTimeline>>()
useDialogFocus(dialogElement)
const model = shallowRef<ScheduleProject>(), mode = ref<'people'|'global'>('people'), selectedId = ref(''), dayWidth = ref(64)
const loading = ref(true), problem = ref(''), gestureBusy = ref(false), canUndo = ref(false), canRedo = ref(false)
const dialog = ref<'project'|'roles'|'calendar'|'event'|'delete'|null>(null), dialogError = ref(''), creatingProject = ref(false)
const projectDraft = ref({ title: '', startDate: '', endDate: '' }), rolesDraft = ref<ScheduleRole[]>([])
const holidayDraft = ref({ extra: '', excluded: '' }), eventDraft = ref<ScheduleEvent>(), editingEvent = ref(false)
const palette = ['#4376d4', '#2f9b7f', '#9b66c9', '#de8d37', '#c46180', '#438fba']
const holidayYears = shallowRef<HolidayYears>({}), holidayLoading = ref(false), holidayMessage = ref('')
let holidayRequest = 0, pendingHolidays: HolidayYears | undefined
let holidayTimer: ReturnType<typeof setInterval> | undefined
let session: ScheduleSession | undefined, disposed = false, generation = 0
let lastExport: { generation: number; base64: string } | undefined
const calendar = computed(() => model.value ? buildCalendar(model.value, holidayYears.value) : { days: [], weeks: [], hiddenCount: 0, unknownHolidayYears: [] })
const projectYears = computed(() => {
 if (!model.value) return []
 const first = Number(model.value.startDate.slice(0, 4)), last = Number(model.value.endDate.slice(0, 4))
 return Array.from({ length: last - first + 1 }, (_, index) => first + index)
})
const requestedYears = computed(() => {
 const years = new Set(projectYears.value)
 for (const year of projectYears.value) {
  if (year < 9999 && model.value!.startDate <= `${year}-12-31` && model.value!.endDate >= `${year}-12-01`) years.add(year + 1)
 }
 return [...years].sort((a, b) => a - b)
})
const editable = computed(() => !!model.value && !loading.value && props.active && !props.disabled)
const controlsReady = computed(() => editable.value && !dialog.value && !gestureBusy.value)
const selected = computed(() => model.value?.events.find(event => event.id === selectedId.value))
const hiddenEvents = computed(() => model.value?.events.filter(event => !projectedSpan(event, calendar.value.days)) ?? [])
const overall = computed(() => model.value?.events.filter(event => event.roleId === null).length ?? 0)
const holidayStatus = computed(() => holidayLoading.value ? '正在检查节假日更新…' : holidayMessage.value || (calendar.value.unknownHolidayYears.length && model.value?.calendar.hideHolidays ? `${calendar.value.unknownHolidayYears.join('、')} 年假日数据暂未取得，使用周末规则和手动假日。` : '自动更新中国大陆法定假日'))
const eventOwner = (event: ScheduleEvent) => event.roleId === null ? '整体计划' : model.value?.roles.find(role => role.id === event.roleId)?.name ?? '未知人员'
const dialogTitle = computed(() => dialog.value === 'project' ? creatingProject.value ? '新建项目排期' : '项目设置' : dialog.value === 'roles' ? '管理人员' : dialog.value === 'calendar' ? '假日设置' : dialog.value === 'delete' ? '删除事件' : editingEvent.value ? '编辑事件' : '添加事件')

function report(cause: unknown) { if (!disposed) problem.value = cause instanceof Error ? cause.message : String(cause) }
function applyHolidays(years: HolidayYears) {
 if (gestureBusy.value) pendingHolidays = years
 else { holidayYears.value = years; pendingHolidays = undefined }
}
async function refreshHolidays(force = false) {
 if (disposed || !model.value) return
 const token = ++holidayRequest, years = requestedYears.value
 holidayLoading.value = true; holidayMessage.value = ''
 try {
  const client = await getHolidayClient()
  if (disposed || token !== holidayRequest) return
  applyHolidays(client.read(years))
  const result = await client.load(years, force)
  const persisted = await flushHolidayCache()
  if (disposed || token !== holidayRequest) return
  applyHolidays(result.years)
  const failed = result.failedYears
  holidayMessage.value = failed.length ? `${failed.join('、')} 年公告暂未取得新数据，继续使用本地假日；稍后可重试。` : '假日数据已更新并缓存。'
  if (!persisted) holidayMessage.value += '本机缓存未写入磁盘，当前会话仍可使用。'
 } catch {
  if (!disposed && token === holidayRequest) holidayMessage.value = '假日更新暂不可用，继续使用本地数据。'
 } finally { if (!disposed && token === holidayRequest) holidayLoading.value = false }
}
watch(() => requestedYears.value.join(','), () => { void refreshHolidays() })
function accept() {
 if (!session) return
 model.value = session.model
 const snapshot = session.inspect(); canUndo.value = snapshot.canUndo; canRedo.value = snapshot.canRedo
 if (selectedId.value && !model.value.events.some(event => event.id === selectedId.value)) selectedId.value = ''
 // A gesture preview is not an edit. Shell actions may cancel the preview;
 // cancelled gestures must not dirty the saved document.
 emit('dirty', snapshot.dirty)
}
function change(edit: (copy: ScheduleProject) => void): boolean {
 if (!session) return false
 try { session.change(edit); accept(); problem.value = ''; return true } catch (cause) { report(cause); return false }
}
function requireReady() {
 if (!session || disposed || loading.value) throw Error('请等待排期打开。')
 if (gestureBusy.value) throw Error('请先完成或取消当前拖动。')
 if (dialog.value) throw Error('请先完成或取消当前排期设置。')
}
function closeMenus() { root.value?.querySelectorAll<HTMLDetailsElement>('.schedule-menu[open]').forEach(menu => { menu.open = false }) }
function outsideMenu(event: PointerEvent) { if (!(event.target instanceof Element) || !event.target.closest('.schedule-menu')) closeMenus() }
function toggleMenu(event: Event) {
 const menu = event.target as HTMLDetailsElement
 if (menu.open) root.value?.querySelectorAll<HTMLDetailsElement>('.schedule-menu[open]').forEach(other => { if (other !== menu) other.open = false })
}
function requestImport() { if (controlsReady.value) { closeMenus(); emit('import') } }
function requestExport(format: 'json'|'png') { if (controlsReady.value) { closeMenus(); emit('export', format) } }
function openDialog(kind: NonNullable<typeof dialog.value>) { closeMenus(); dialogError.value = ''; problem.value = ''; dialog.value = kind }
function settings(create = false) {
 if (!model.value || (!create && !controlsReady.value)) return
 creatingProject.value = create
 projectDraft.value = { title: model.value.title, startDate: model.value.startDate, endDate: model.value.endDate }
 openDialog('project')
}
function manageRoles() {
 if (!model.value || !controlsReady.value) return
 rolesDraft.value = model.value.roles.map(role => ({ ...role })); openDialog('roles')
}
function addRole() {
 if (rolesDraft.value.length >= 100) { dialogError.value = '每个项目最多添加 100 名人员。'; return }
 rolesDraft.value.push({ id: scheduleId(), name: '', role: '', color: palette[rolesDraft.value.length % palette.length]! })
 nextTick(() => dialogElement.value?.querySelector<HTMLInputElement>('[data-role-draft]:last-child [data-testid="role-name"]')?.focus())
}
function removeRole(id: string) {
 const count = model.value?.events.filter(event => event.roleId === id).length ?? 0
 if (count) { dialogError.value = `这名人员还有 ${count} 个事件，请先移动或删除这些事件。`; return }
 rolesDraft.value = rolesDraft.value.filter(role => role.id !== id); dialogError.value = ''
}
function holidaySettings() {
 if (!model.value || !controlsReady.value) return
 holidayDraft.value = { extra: model.value.calendar.extraHolidays.join('\n'), excluded: model.value.calendar.excludedHolidays.join('\n') }; openDialog('calendar')
}
function openEvent(id?: string, point?: { roleId: string|null; date: string; slot: 0|1 }) {
 if (!model.value || !controlsReady.value) return
 const original = id ? model.value.events.find(event => event.id === id) : undefined
 if (id && !original) return
 editingEvent.value = !!original
 const date = point?.date ?? calendar.value.days[0]?.date ?? model.value.startDate
 eventDraft.value = original ? { ...original } : { id: scheduleId(), roleId: point ? point.roleId : model.value.roles[0]?.id ?? null, title: '', startDate: date, endDate: date, height: 1, slot: 0, notes: '' }
 openDialog('event')
}
function askDelete(id: string) { if (!controlsReady.value) return; selectedId.value = id; if (selected.value) openDialog('delete') }
function cancelDialog() { dialog.value = null; dialogError.value = ''; eventDraft.value = undefined; creatingProject.value = false; accept() }
function submitDialog() {
 if (!session || !editable.value) return
 try {
  const kind = dialog.value
  if (kind === 'project') session.change(copy => { copy.title = projectDraft.value.title.trim(); copy.startDate = projectDraft.value.startDate; copy.endDate = projectDraft.value.endDate })
  if (kind === 'roles') session.change(copy => { copy.roles = rolesDraft.value.map(role => ({ ...role, name: role.name.trim(), role: role.role.trim() })); pruneTrackHeights(copy) })
  if (kind === 'calendar') {
   const dates = (value: string) => [...new Set(value.split(/[\s,，;；]+/).filter(Boolean))].sort()
   session.change(copy => { copy.calendar.extraHolidays = dates(holidayDraft.value.extra); copy.calendar.excludedHolidays = dates(holidayDraft.value.excluded) })
  }
  if (kind === 'event' && eventDraft.value) {
   const event = { ...eventDraft.value, title: eventDraft.value.title.trim(), slot: eventDraft.value.height === 1 ? 0 as const : eventDraft.value.slot }
   session.change(copy => { const index = copy.events.findIndex(value => value.id === event.id); if (index < 0) copy.events.push(event); else copy.events[index] = event })
   selectedId.value = event.id
  }
  if (kind === 'delete' && selected.value) { const id = selected.value.id; session.change(copy => { copy.events = copy.events.filter(event => event.id !== id); pruneTrackHeights(copy) }) }
  cancelDialog(); problem.value = ''; accept()
 } catch (cause) { dialogError.value = cause instanceof Error ? cause.message : String(cause) }
}
function updateEvent(event: ScheduleEvent) {
 if (!editable.value || dialog.value) return
 if (change(copy => { const index = copy.events.findIndex(item => item.id === event.id); if (index < 0) throw Error('事件已被删除，请重新操作。'); copy.events[index] = { ...event, slot: event.height === 1 ? 0 : event.slot } })) {
  selectedId.value = event.id; emit('status', `${event.title} · ${event.startDate} — ${event.endDate} · ${event.height === 1 ? '全天' : event.slot === 1 ? '下午' : '上午'} · 高度 ${event.height * 100}%`)
 }
}
function copyEvent(event: ScheduleEvent) {
 if (!session || !editable.value || dialog.value) return
 try {
  const copied = session.copyEvent(event)
  accept(); selectedId.value = copied.id; problem.value = ''
  emit('status', `已复制“${copied.title}” · ${copied.startDate} — ${copied.endDate} · ${copied.height === 1 ? '全天' : copied.slot === 1 ? '下午' : '上午'}`)
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-event-id="${copied.id}"]`)?.focus({ preventScroll: true }))
 } catch (cause) { report(cause) }
}
function toggleCalendar(field: 'hideWeekends'|'hideHolidays', event: Event) {
 if (controlsReady.value) change(copy => { copy.calendar[field] = !(event.target as HTMLInputElement).checked })
}
function setWeekNumbering(event: Event) {
 const value = (event.target as HTMLSelectElement).value
 if (!controlsReady.value || (value !== 'year' && value !== 'project') || value === (model.value?.calendar.weekNumbering ?? 'year')) return
 if (change(copy => { copy.calendar.weekNumbering = value })) emit('status', value === 'year' ? '周号按全年 ISO 周历显示。' : '周号从项目开始日期所在周记为 W1。')
}
function zoom(width: number) { if (controlsReady.value && Number.isFinite(width)) dayWidth.value = Math.max(36, Math.min(160, width)) }
function updateTrackHeight(key: string, height: number) {
 if (!editable.value || dialog.value) return
 if (change(copy => {
  const trackHeights = { ...copy.layout?.trackHeights }
  if (height === SCHEDULE_TRACK_HEIGHT) delete trackHeights[key]
  else trackHeights[key] = height
  if (Object.keys(trackHeights).length) copy.layout = { trackHeights }
  else delete copy.layout
 })) emit('status', `轨道高度 ${height}px，已对齐 28px 刻度。`)
}
function gesture(active: boolean) {
 gestureBusy.value = active; accept()
 if (!active && pendingHolidays) {
  // Finish the pointer's date commit before replacing its calendar projection.
  void nextTick(() => { if (!disposed && !gestureBusy.value && pendingHolidays) applyHolidays(pendingHolidays) })
 }
}
async function undo() { requireReady(); if (session!.undo()) accept() }
async function redo() { requireReady(); if (session!.redo()) accept() }
async function inspect() { if (!session) throw Error('请等待排期打开。'); return { ...session.inspect(), dirty: session.inspect().dirty || gestureBusy.value } }
async function prepareDeactivate() { requireReady(); return session!.inspect() }
async function canBackgroundExport() { return !!session && !disposed && !loading.value && !gestureBusy.value && !dialog.value }
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
 requireReady()
 if (options.format === 'json' || options.format === 'png') {
  const current = generation, snapshot = session!.inspect(), project = session!.model
  const bytes = options.format === 'json' ? encodeSchedule(project) : (await exportSchedulePng(project, { mode: mode.value, dayWidth: dayWidth.value, holidayYears: holidayYears.value })).bytes
  if (disposed || current !== generation || snapshot.revision !== session?.revision) throw Error('导出期间排期已变化，请重试。')
  return { base64: bytesToBase64(bytes), extension: options.format, saveAs: true, dirty: snapshot.dirty, revision: `${snapshot.documentId}:${snapshot.revision}` }
 }
 if (options.format && options.format !== 'ooschedule') throw Error('排期支持保存为 .ooschedule。')
 const result = session!.export(), base64 = bytesToBase64(result.bytes)
 lastExport = { generation, base64 }
 return { base64, extension: 'ooschedule', name: props.document.name.replace(/\.[^.]+$/, '') + '.ooschedule', dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string) {
 requireReady()
 if (!lastExport || lastExport.generation !== generation || base64 !== lastExport.base64) throw Error('保存回执与当前排期不匹配，请重新保存。')
 session!.markSaved(base64ToBytes(base64)); accept()
}
async function discardChanges(options: { force?: boolean } = {}) {
 if (options.force) { timeline.value?.cancelGesture(); generation++; dialog.value = null; gestureBusy.value = false; return }
 if ((await prepareDeactivate()).dirty) throw Error('排期还有未保存的修改，请先保存或确认不保存后关闭。')
}
function keydown(event: KeyboardEvent) {
 if (!props.active || event.defaultPrevented || event.isComposing) return
 if (event.key === 'Escape' && dialog.value) { event.preventDefault(); event.stopPropagation(); cancelDialog(); return }
 if (event.key === 'Escape' && root.value?.querySelector('.schedule-menu[open]')) {
  const menu = root.value.querySelector<HTMLDetailsElement>('.schedule-menu[open]')
  closeMenus(); menu?.querySelector('summary')?.focus(); event.preventDefault(); event.stopPropagation(); return
 }
 if (!controlsReady.value || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return
 if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z','y'].includes(event.key.toLowerCase())) {
  event.preventDefault(); event.stopPropagation(); void ((event.shiftKey || event.key.toLowerCase() === 'y') ? redo() : undo()).catch(report)
 }
}
function focus() { root.value?.focus({ preventScroll: true }) }
watch(() => props.document.id, async () => {
 const current = ++generation
 timeline.value?.cancelGesture(); loading.value = true; problem.value = ''; dialog.value = null; selectedId.value = ''; lastExport = undefined
 try {
  const bytes = props.document.base64 ? base64ToBytes(props.document.base64) : undefined
  session = new ScheduleSession(bytes, props.document.name.replace(/\.[^.]+$/, '') || '项目排期')
  accept(); loading.value = false; await nextTick()
  if (disposed || current !== generation) return
  emit('ready'); emit('status', '按周安排项目，拖动事件调整日期和负责人。')
  if (!bytes) settings(true)
 } catch (cause) { report(cause); loading.value = false; emit('error', problem.value) }
}, { immediate: true })
watch(() => props.active, active => { if (!active) { timeline.value?.cancelGesture(); closeMenus() } else void refreshHolidays() })
watch(controlsReady, ready => { if (!ready) closeMenus() })
onMounted(() => { holidayTimer = setInterval(() => { if (props.active) void refreshHolidays() }, 24 * 60 * 60 * 1000); window.addEventListener('pointerdown', outsideMenu) })
onBeforeUnmount(() => { disposed = true; generation++; holidayRequest++; clearInterval(holidayTimer); window.removeEventListener('pointerdown', outsideMenu); timeline.value?.cancelGesture(); session = undefined })
defineExpose({ prepareDeactivate, exportFile, markSaved, discardChanges, inspect, syncRevision: inspect, canBackgroundExport, undo, redo, focus })
</script>

<template>
 <section ref="root" class="schedule-editor" data-testid="schedule-editor" :data-document-id="document.id" :aria-label="model?.title || '计划排期'" tabindex="-1" @keydown="keydown">
  <div v-if="loading" class="schedule-loading">正在打开排期…</div>
  <template v-else-if="model">
   <header class="schedule-heading" data-testid="schedule-toolbar" role="toolbar" aria-label="排期工具">
    <div class="schedule-project-name"><span class="schedule-heading-icon"><Icon name="schedule" :size="23"/></span><div><h1>{{model.title}}</h1><p>{{model.startDate}} — {{model.endDate}}<span> · {{calendar.days.length}} 个可见日</span></p></div></div>
    <div class="schedule-modes" role="group" aria-label="排期视图"><button data-testid="schedule-mode-people" :aria-pressed="mode==='people'" :disabled="!controlsReady" @click="mode='people'">人员</button><button data-testid="schedule-mode-global" :aria-pressed="mode==='global'" :disabled="!controlsReady" @click="mode='global'">事件</button></div>
    <div class="schedule-history"><button data-testid="schedule-undo" title="撤销" aria-label="撤销排期修改" :disabled="!controlsReady || !canUndo" @click="undo().catch(report)"><Icon name="undo" :size="16"/></button><button data-testid="schedule-redo" title="重做" aria-label="重做排期修改" :disabled="!controlsReady || !canRedo" @click="redo().catch(report)"><Icon name="redo" :size="16"/></button></div>
    <details class="schedule-menu" @toggle="toggleMenu"><summary data-testid="schedule-view-menu" :aria-disabled="!controlsReady" @click="!controlsReady && $event.preventDefault()">视图 <Icon name="chevron-down" :size="12"/></summary><div class="schedule-menu-panel schedule-view-panel">
     <label class="schedule-week-numbering">周号 <select data-testid="schedule-week-numbering" aria-label="周号模式" :value="model.calendar.weekNumbering ?? 'year'" :disabled="!controlsReady" @change="setWeekNumbering"><option value="year">按年</option><option value="project">按项目</option></select></label>
     <label class="schedule-check"><input data-testid="schedule-show-weekends" type="checkbox" :checked="!model.calendar.hideWeekends" :disabled="!controlsReady" @change="toggleCalendar('hideWeekends',$event)">显示周末</label>
     <label class="schedule-check"><input data-testid="schedule-show-holidays" type="checkbox" :checked="!model.calendar.hideHolidays" :disabled="!controlsReady" @change="toggleCalendar('hideHolidays',$event)">显示法定假日</label>
     <label class="schedule-zoom">日宽 <select v-model.number="dayWidth" aria-label="日期列宽" :disabled="!controlsReady"><option :value="44">紧凑 · 69%</option><option :value="64">标准 · 100%</option><option :value="88">宽松 · 138%</option><option v-if="![44,64,88].includes(dayWidth)" :value="dayWidth">{{Math.round(dayWidth/64*100)}}%</option></select></label><small class="schedule-zoom-hint">Ctrl + 滚轮缩放时间轴</small>
     <button data-testid="schedule-calendar-settings" :disabled="!controlsReady" @click="holidaySettings()">假日设置</button>
     <button data-testid="schedule-refresh-holidays" :disabled="!controlsReady || holidayLoading" @click="refreshHolidays(true)">{{holidayLoading?'正在更新假日…':'更新假日'}}</button>
    </div></details>
    <div class="schedule-actions"><button data-testid="schedule-settings" :disabled="!controlsReady" @click="settings()"><Icon name="settings" :size="15"/>项目设置</button><button data-testid="schedule-roles" :disabled="!controlsReady" @click="manageRoles()">管理人员 <span class="schedule-count">{{model.roles.length}}</span></button><button class="schedule-primary" data-testid="schedule-add-event" :disabled="!controlsReady" @click="openEvent()"><Icon name="plus" :size="16"/>添加事件</button></div>
    <div class="schedule-data-actions"><button data-testid="schedule-import" title="导入 .ooschedule 或 JSON 排期，在新标签中打开" :disabled="!controlsReady" @click="requestImport"><Icon name="folder" :size="15"/>导入</button><details class="schedule-menu" @toggle="toggleMenu"><summary data-testid="schedule-export-menu" :aria-disabled="!controlsReady" @click="!controlsReady && $event.preventDefault()"><Icon name="download" :size="15"/>导出 <Icon name="chevron-down" :size="12"/></summary><div class="schedule-menu-panel schedule-export-panel"><button data-testid="schedule-export-json" :disabled="!controlsReady" @click="requestExport('json')">排期数据（JSON）<small>保留人员、事件、日历及轨道高度</small></button><button data-testid="schedule-export-png" :disabled="!controlsReady" @click="requestExport('png')">整张排期表（PNG）<small>当前模式的全部日期和轨道</small></button></div></details></div>
   </header>
   <p class="schedule-holiday-status" role="status" data-testid="schedule-holiday-status" :title="holidayStatus">{{holidayStatus}}</p>
   <p v-if="problem" class="schedule-error" role="alert" data-testid="schedule-error">{{problem}}<button aria-label="关闭提示" @click="problem=''">×</button></p>
   <div v-if="!model.roles.length && mode==='people'" class="schedule-empty-roles"><div><strong>为项目添加人员</strong><p>填写姓名、职能和颜色，每人拥有一条专属轨道。上方整体计划始终固定。</p></div><button :disabled="!controlsReady" @click="manageRoles()">添加第一位人员</button></div>
   <ScheduleTimeline ref="timeline" :project="model" :holiday-years="holidayYears" :mode="mode" :active="active" :disabled="!editable || !!dialog" :selected-id="selectedId" :day-width="dayWidth" @select="selectedId=$event" @edit="openEvent($event)" @create="openEvent(undefined,$event)" @change="updateEvent" @copy="copyEvent" @track-height="updateTrackHeight" @zoom="zoom" @error="report" @gesture="gesture" @delete="askDelete"/>
   <div class="schedule-selection" aria-live="polite">
    <template v-if="selected"><span class="schedule-selection-dot" :style="{background: model.roles.find(role=>role.id===selected?.roleId)?.color || 'var(--ui-accent)'}"/><strong>{{selected.title}}</strong><span>{{eventOwner(selected)}} · {{selected.startDate}} — {{selected.endDate}} · {{selected.height===1?'全天':selected.slot===1?'下午':'上午'}} · {{selected.height*100}}%</span><button data-testid="schedule-edit-event" :disabled="!controlsReady" @click="openEvent(selected.id)">编辑</button><button class="schedule-danger" data-testid="schedule-delete-event" :disabled="!controlsReady" @click="askDelete(selected.id)">删除</button></template>
    <template v-else><span>{{mode==='people'?'双击空白轨道添加事件，拖动可更换人员。':'所有人员的事件按开始日期汇总；双击事件编辑负责人。'}}</span><span class="schedule-selection-tail">{{overall}} 个整体计划 · {{model.events.length-overall}} 个人员事件</span></template>
   </div>
   <div v-if="hiddenEvents.length" class="schedule-hidden-events" data-testid="schedule-hidden-events"><span>{{hiddenEvents.length}} 个事件仅覆盖隐藏日期：</span><button v-for="event in hiddenEvents" :key="event.id" :disabled="!controlsReady" @click="openEvent(event.id)">{{event.title}} · {{event.startDate}}</button></div>
   <footer class="schedule-hint">边缘直接拉伸 · Ctrl + 拖动复制 · Ctrl + 滚轮缩放 · 半高上上午、下下午 · 同人同日一个事件</footer>
  </template>
  <p v-else class="schedule-error" role="alert">{{problem || '无法打开排期。'}}</p>

  <div v-if="dialog" class="schedule-modal-backdrop" @keydown.esc.stop.prevent="cancelDialog">
   <form ref="dialogElement" class="schedule-dialog" :class="{'schedule-dialog-wide':dialog==='roles'}" role="dialog" aria-modal="true" :aria-label="dialogTitle" :data-testid="`schedule-${dialog}-dialog`" @submit.prevent="submitDialog">
    <header><div><span class="schedule-eyebrow">项目排期</span><h2>{{dialogTitle}}</h2></div><button type="button" aria-label="取消并关闭" @click="cancelDialog"><Icon name="close" :size="18"/></button></header>
    <template v-if="dialog==='project'"><label>项目名称<input v-model="projectDraft.title" data-testid="schedule-project-title" required maxlength="200" autocomplete="off" placeholder="例如：新产品上线计划"></label><div class="schedule-form-columns"><label>开始日期<input v-model="projectDraft.startDate" data-testid="schedule-project-start" type="date" required></label><label>结束日期<input v-model="projectDraft.endDate" data-testid="schedule-project-end" type="date" required></label></div><p class="schedule-form-hint">周号可在「视图」中选择按年或按项目，两种模式均从周一开周。缩小范围时，已有事件必须仍在项目日期内。</p></template>
    <template v-if="dialog==='roles'"><p class="schedule-form-hint">每位人员一条轨道，事件沿用人员颜色。角色可以填写产品、设计、开发等职能。</p><div class="schedule-role-labels"><span>名称</span><span>角色 / 职能</span><span>颜色</span><span/></div><div class="schedule-role-list"><div v-for="role in rolesDraft" :key="role.id" class="schedule-role-draft" :data-role-draft="role.id"><input v-model="role.name" data-testid="role-name" aria-label="人员名称" required maxlength="100" placeholder="姓名"><input v-model="role.role" data-testid="role-job" aria-label="角色职能" maxlength="100" placeholder="例如：设计"><input v-model="role.color" data-testid="role-color" aria-label="人员颜色" type="color"><button type="button" :aria-label="`移除 ${role.name || '人员'}`" @click="removeRole(role.id)"><Icon name="close" :size="15"/></button></div></div><p v-if="!rolesDraft.length" class="schedule-form-hint">还没有人员，点击下方按钮添加。</p><button type="button" data-testid="schedule-role-add" class="schedule-add-role" @click="addRole"><Icon name="plus" :size="15"/>添加人员</button></template>
    <template v-if="dialog==='calendar'"><p class="schedule-form-hint">自动获取中国大陆官方放假安排，每 24 小时检查更新；断网使用缓存或内置数据。周末开关独立生效，调休上班的周六、周日也默认隐藏。</p><label>新增假日<textarea v-model="holidayDraft.extra" data-testid="schedule-extra-holidays" rows="4" placeholder="每行一个日期，例如 2027-01-01"/></label><label>排除已收录的假日<textarea v-model="holidayDraft.excluded" data-testid="schedule-excluded-holidays" rows="3" placeholder="需要显示为普通日期的官方假日，每行一个"/></label><p class="schedule-form-hint">日期格式为 YYYY-MM-DD。手动设置优先于自动数据；更新和显示开关不改写事件的起止日期。</p></template>
    <template v-if="dialog==='event' && eventDraft"><label>事件名称<input v-model="eventDraft.title" data-testid="schedule-event-title" required maxlength="200" autocomplete="off" placeholder="例如：完成交互设计"></label><label>负责人 / 轨道<select v-model="eventDraft.roleId" data-testid="schedule-event-role"><option :value="null">整体计划（固定轨道）</option><option v-for="role in model?.roles" :key="role.id" :value="role.id">{{role.name}}{{role.role?' · '+role.role:''}}</option></select></label><div class="schedule-form-columns"><label>开始日期<input v-model="eventDraft.startDate" data-testid="schedule-event-start" type="date" :min="model?.startDate" :max="model?.endDate" required></label><label>结束日期<input v-model="eventDraft.endDate" data-testid="schedule-event-end" type="date" :min="model?.startDate" :max="model?.endDate" required></label></div><label>显示高度<select v-model.number="eventDraft.height" data-testid="schedule-event-height" @change="eventDraft.height===1 && (eventDraft.slot=0)"><option :value="1">100% · 全天</option><option :value="0.5">50% · 上午或下午</option></select></label><label v-if="eventDraft.height===0.5">时段<select v-model.number="eventDraft.slot" data-testid="schedule-event-slot"><option :value="0">上午 · 轨道上半部</option><option :value="1">下午 · 轨道下半部</option></select></label><label>备注<textarea v-model="eventDraft.notes" data-testid="schedule-event-notes" rows="3" maxlength="20000" placeholder="可选，记录交付要求或协作事项"/></label><p class="schedule-form-hint">起止日期包含当天。半高事件可选择上午或下午；同一人员同一天仍只允许一个事件。</p></template>
    <p v-if="dialog==='delete'">确定删除“{{selected?.title}}”？删除后可使用撤销恢复。</p>
    <p v-if="dialogError" class="schedule-dialog-error" role="alert">{{dialogError}}</p>
    <footer><button type="button" :data-testid="`schedule-${dialog}-cancel`" @click="cancelDialog">取消</button><button type="submit" class="schedule-primary" :class="{'schedule-delete-confirm':dialog==='delete'}" :data-testid="`schedule-${dialog}-confirm`" :disabled="!editable">{{dialog==='delete'?'删除事件':dialog==='project'&&creatingProject?'创建项目':'确定'}}</button></footer>
   </form>
  </div>
 </section>
</template>

<style scoped>
.schedule-editor{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;background:var(--ui-surface);color:var(--ui-text);font-family:var(--ui-font);position:relative;overflow:hidden;outline:none}
.schedule-heading{padding:8px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--ui-line);flex-wrap:wrap;flex-shrink:0;position:relative;z-index:20}
.schedule-project-name{display:flex;align-items:center;gap:8px;min-width:180px;flex:1 1 200px;max-width:360px}.schedule-project-name>div{min-width:0}.schedule-project-name h1{font-size:15px;line-height:1.4;margin:0 0 2px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.schedule-project-name p{color:var(--ui-muted);font-size:10px;margin:0;white-space:nowrap}.schedule-project-name p>span{display:none}.schedule-heading-icon{display:grid;place-items:center;width:32px;height:32px;flex:none;background:var(--ui-accent-soft);color:var(--ui-accent);border-radius:6px}
.schedule-editor button,.schedule-menu>summary{min-height:30px;padding:5px 8px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;font-size:12px;line-height:18px}.schedule-editor button:hover:not(:disabled),.schedule-menu>summary:hover{background:var(--ui-surface-muted)}.schedule-editor button.schedule-primary{background:var(--ui-accent);color:var(--ui-on-accent);padding:5px 9px}.schedule-actions,.schedule-history,.schedule-data-actions{display:flex;align-items:center;gap:3px;flex:none}.schedule-data-actions{margin-left:auto;border-left:1px solid var(--ui-line);padding-left:6px}.schedule-count{font-size:10px;border-radius:4px;padding:0 4px;background:var(--ui-surface-muted);color:var(--ui-muted)}
.schedule-modes{display:flex;background:var(--ui-surface-muted);padding:2px;border-radius:6px;border:1px solid var(--ui-line);flex:none}.schedule-modes button{min-height:26px;padding:3px 8px}.schedule-modes button[aria-pressed=true]{background:var(--ui-surface);box-shadow:0 1px 3px #00000012;color:var(--ui-accent);font-weight:600}
.schedule-menu{position:relative;flex:none}.schedule-menu>summary{list-style:none;cursor:pointer;user-select:none}.schedule-menu>summary::-webkit-details-marker{display:none}.schedule-menu>summary[aria-disabled=true]{opacity:.45;cursor:default}.schedule-menu[open]>summary{background:var(--ui-surface-muted)}.schedule-menu-panel{position:absolute;top:calc(100% + 6px);right:0;min-width:190px;display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid var(--ui-line-strong);border-radius:8px;background:var(--ui-surface);box-shadow:0 8px 26px #0002;z-index:35}.schedule-view-panel{left:auto;right:0}.schedule-menu-panel>button{justify-content:flex-start}.schedule-check{display:flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap;min-height:30px;padding:4px 8px}.schedule-check input{margin:0}.schedule-week-numbering,.schedule-zoom{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 8px;font-size:12px;color:var(--ui-muted);border-bottom:1px solid var(--ui-line);padding-bottom:9px;margin-bottom:3px}.schedule-week-numbering select,.schedule-zoom select{height:28px;background:var(--ui-surface);color:var(--ui-text);border:1px solid var(--ui-line);border-radius:4px}.schedule-zoom-hint{font-size:10px;color:var(--ui-muted);padding:0 8px 5px}.schedule-export-panel{min-width:250px}.schedule-export-panel>button{display:flex;flex-direction:column;align-items:flex-start;padding:8px;gap:2px}.schedule-export-panel small{font-size:10px;color:var(--ui-muted);font-weight:400}
.schedule-holiday-status{box-sizing:border-box;height:23px;line-height:15px;padding:4px 12px;margin:0;border-bottom:1px solid var(--ui-line);font-size:11px;color:var(--ui-muted);flex-shrink:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.schedule-error{padding:9px 20px;margin:0;flex-shrink:0;font-size:12px;color:var(--ui-danger);background:var(--ui-danger-soft);display:flex;justify-content:space-between;align-items:center;gap:12px}.schedule-empty-roles{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:14px 22px;background:var(--ui-surface-muted);border-bottom:1px solid var(--ui-line);flex-shrink:0}.schedule-empty-roles p{margin:3px 0 0;color:var(--ui-muted);font-size:12px}.schedule-empty-roles button{border:1px solid var(--ui-line-strong);white-space:nowrap}.schedule-loading{padding:40px;color:var(--ui-muted)}
.schedule-selection{display:flex;align-items:center;gap:10px;padding:7px 18px;min-height:43px;border-top:1px solid var(--ui-line);flex-shrink:0;font-size:12px;flex-wrap:wrap}.schedule-selection strong{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.schedule-selection>span:not(.schedule-selection-dot){color:var(--ui-muted)}.schedule-selection-tail{margin-left:auto}.schedule-selection-dot{width:8px;height:8px;border-radius:3px;flex:none}.schedule-danger{color:var(--ui-danger)}.schedule-hint{padding:7px 18px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:11px;flex-shrink:0}.schedule-hidden-events{display:flex;align-items:center;flex-wrap:wrap;gap:3px;padding:4px 18px;font-size:11px;background:var(--ui-warning-soft);color:var(--ui-warning);max-height:80px;overflow:auto;flex-shrink:0}.schedule-hidden-events button{text-decoration:underline;min-height:23px;font-size:11px}
.schedule-modal-backdrop{position:absolute;inset:0;background:#10182750;backdrop-filter:blur(3px);z-index:60;display:grid;place-items:center;padding:18px;overflow:auto}.schedule-dialog{background:var(--ui-surface);border:1px solid var(--ui-line-strong);border-radius:10px;box-shadow:0 18px 70px #00000025;width:min(460px,100%);max-height:100%;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:14px}.schedule-dialog-wide{width:min(680px,100%)}.schedule-dialog>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}.schedule-eyebrow{text-transform:uppercase;letter-spacing:2px;color:var(--ui-subtle);font-size:10px}.schedule-dialog h2{font-size:19px;margin:4px 0 0}.schedule-dialog label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600}.schedule-dialog input,.schedule-dialog select,.schedule-dialog textarea{width:100%;border:1px solid var(--ui-line-strong);background:var(--ui-surface);color:var(--ui-text);border-radius:5px;padding:9px;font-size:13px;min-height:36px;outline-offset:2px}.schedule-dialog textarea{resize:vertical}.schedule-form-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.schedule-form-hint{margin:0;font-size:12px;line-height:1.65;color:var(--ui-muted)}.schedule-dialog>footer{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--ui-line);padding-top:15px;margin-top:3px}.schedule-dialog-error{margin:0;padding:10px;border-radius:5px;color:var(--ui-danger);background:var(--ui-danger-soft);font-size:12px}.schedule-role-list{max-height:330px;overflow:auto;display:grid;gap:8px}.schedule-role-labels,.schedule-role-draft{display:grid;grid-template-columns:minmax(90px,1fr) minmax(90px,1fr) 44px 30px;gap:10px;align-items:center}.schedule-role-labels{font-size:11px;color:var(--ui-muted)}.schedule-role-draft input[type=color]{height:36px;padding:3px}.schedule-add-role{border:1px dashed var(--ui-line-strong)}.schedule-editor .schedule-delete-confirm{background:var(--ui-danger)!important;color:white!important}
@media(max-width:760px){.schedule-heading{padding:8px;gap:6px}.schedule-project-name{flex-basis:100%;max-width:none}.schedule-menu-panel{position:fixed;top:auto;left:12px;right:12px;margin-top:6px;min-width:0}.schedule-data-actions{margin-left:0}.schedule-dialog{padding:18px}.schedule-hint{font-size:10px}.schedule-selection-tail{margin-left:0}.schedule-empty-roles{padding:10px 12px}.schedule-role-labels,.schedule-role-draft{gap:6px;grid-template-columns:minmax(70px,1fr) minmax(70px,1fr) 36px 25px}.schedule-selection{padding:6px 12px}}
.schedule-selection{box-sizing:border-box;height:46px;min-height:46px;flex-wrap:nowrap;overflow:hidden}.schedule-selection button{flex-shrink:0}.schedule-selection>span:not(.schedule-selection-dot){min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.schedule-selection strong{min-width:0}
</style>
