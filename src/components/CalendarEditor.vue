<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import CalendarWorkCapsule, { type AllocationCommit } from '../calendar/components/CalendarWorkCapsule.vue'
import { calendarId, encodeCalendar, historySuggestions, preserveHistory, rememberHistory, type CalendarAllocationDisplay, type CalendarBook, type CalendarHistoryItem, type CalendarNote, type CalendarWeekMode } from '../calendar/model'
import { dayAllocations, noteAllocationLimits, resizeAllocationBoundary, setNoteAllocation } from '../calendar/allocation'
import { CalendarSession } from '../calendar/session'
import { moveCalendarDate, normalizeVisibleDate, visibleMonthDays, monthSummary, shiftMonth, todayDate, validateMonth } from '../calendar/calendar'
import { loadCalendarAlmanac, type CalendarAlmanac, type CalendarDateDetails } from '../calendar/almanac'
import { executeCalendarTool } from '../calendar/mcp'
import { getHolidayClient, flushHolidayCache } from '../schedule/holiday-native'
import type { HolidayYears } from '../schedule/holidays'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { useDialogFocus } from '../shared/dialog-focus'
import { printHtml } from '../shared/printing'
import type { Appearance } from '../shared/appearance'
import type { NativeDocument } from '../types'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean; theme?: Appearance; focusMode?: boolean }>(), { active: true, disabled: false, theme: 'system', focusMode: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: 'new'|'open'|'save'|'saveAs'|'print'|'close'] }>()
const root = ref<HTMLElement>(), dialogElement = ref<HTMLElement>(), menuElement = ref<HTMLElement>()
useDialogFocus(dialogElement)
const model = shallowRef<CalendarBook>(), loading = ref(true), problem = ref('')
const month = ref(todayDate().slice(0, 7)), selectedDate = ref(todayDate()), selectedNoteId = ref<string|null>(null), query = ref('')
const canUndo = ref(false), canRedo = ref(false), historyQuery = ref('')
const dialog = ref<'note'|'delete'|'clear'|'almanac'|'day'|'settings'|'allocation'|'summary'|null>(null), dialogError = ref('')
const draft = ref<CalendarNote>(), editingNote = ref(false), titleDraft = ref('')
const workdayHoursDraft = ref(7), allocationBusy = ref(false), allocationCancelToken = ref(0)
const weekModeDraft = ref<CalendarWeekMode>('week'), allocationDisplayDraft = ref<CalendarAllocationDisplay>('percent')
const allocationValueDraft = ref<number|string>(''), allocationInitialValue = ref(0), allocationUnit = ref<CalendarAllocationDisplay>('percent'), allocationReturnToDay = ref(false)
const almanac = shallowRef<CalendarAlmanac>(), details = shallowRef<CalendarDateDetails>()
const menu = ref<{ x: number; y: number; date: string }>(), drag = ref<{ id: string; generation: number; copy: boolean; element: HTMLElement }>(), dropDate = ref('')
const holidayYears = shallowRef<HolidayYears>({}), holidayBusy = ref(false), holidayMessage = ref('自动更新中国大陆法定假日')
const palette = ['#ff5f8f', '#ff8a5c', '#ffc53d', '#ff6fb0', '#7c5cff', '#3dd6ff', '#3ce0a8', '#ff4d6d']
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
let session: CalendarSession | undefined, disposed = false, generation = 0, holidayRequest = 0
let lastExport: { generation: number; base64: string } | undefined
let timer: ReturnType<typeof setInterval> | undefined, menuTrigger: HTMLElement | undefined
const editable = computed(() => !!model.value && !loading.value && props.active && !props.disabled)
const controlsReady = computed(() => editable.value && !dialog.value && !drag.value && !allocationBusy.value)
const capsuleDisabled = computed(() => !editable.value || (!!dialog.value && dialog.value !== 'day'))
const days = computed(() => visibleMonthDays(month.value, model.value?.weekMode ?? 'week'))
const columns = computed(() => model.value?.weekMode === 'work' ? 5 : 7)
const visibleWeekdays = computed(() => weekdays.slice(0, columns.value))
const monthTitle = computed(() => `${Number(month.value.slice(0, 4))} 年 ${Number(month.value.slice(5))} 月`)
const summary = computed(() => model.value ? monthSummary(model.value, month.value) : [])
const selected = computed(() => model.value?.notes.find(note => note.id === selectedNoteId.value))
const notesInMonth = computed(() => model.value?.notes.filter(note => note.date.startsWith(`${month.value}-`)) ?? [])
const workByDate = computed(() => {
 const groups = new Map<string, CalendarNote[]>()
 for (const note of model.value?.notes ?? []) {
  if (note.type !== '工作日') continue
  const notes = groups.get(note.date) ?? []; notes.push(note); groups.set(note.date, notes)
 }
 return groups
})
const byDate = computed(() => {
 const map = new Map<string, CalendarNote[]>(), search = query.value.trim().toLocaleLowerCase()
 for (const note of model.value?.notes ?? []) {
  if (search && !`${note.title}\n${note.content}\n${note.type}`.toLocaleLowerCase().includes(search)) continue
  const notes = map.get(note.date) ?? []; notes.push(note); map.set(note.date, notes)
 }
 for (const notes of map.values()) notes.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
 return map
})
const matchedCount = computed(() => [...byDate.value].reduce((count, [date, notes]) => count + (date.startsWith(`${month.value}-`) ? notes.length : 0), 0))
const history = computed(() => model.value ? historySuggestions(model.value, historyQuery.value) : [])
const allDayNotes = computed(() => (model.value?.notes.filter(note => note.date === selectedDate.value) ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)))
const selectedLunar = computed(() => almanac.value?.day(selectedDate.value))
const visibleYears = computed(() => [...new Set(days.value.flatMap(day => day.date ? [Number(day.date.slice(0, 4))] : []))].sort((a, b) => a - b))
const dialogTitle = computed(() => dialog.value === 'note' ? editingNote.value ? '编辑事项' : '添加自定义事项' : dialog.value === 'clear' ? '清除当月事项' : dialog.value === 'delete' ? '删除事项' : dialog.value === 'day' ? `${selectedDate.value} 的事项` : dialog.value === 'settings' ? '日历本设置' : dialog.value === 'allocation' ? '修改工时分配' : dialog.value === 'summary' ? '全月工作汇总' : '日期详情')
const deletableNote = computed(() => selected.value)
const formatNumber = (value: number) => Number(value.toFixed(1)).toLocaleString('zh-CN')
function summaryWork(item: { days: number; hours: number }, display = model.value?.allocationDisplay) {
 return display === 'hours' ? `${formatNumber(item.hours)} 小时` : `${formatNumber(item.days)} 天`
}
const dayNotes = (date: string|null) => date ? byDate.value.get(date) ?? [] : []
const workNotes = (date: string|null) => date ? workByDate.value.get(date) ?? [] : []
const offNotes = (date: string|null) => dayNotes(date).filter(note => note.type === '非工作日')
const dailyAllocations = computed(() => model.value ? dayAllocations(model.value, selectedDate.value) : [])
const noteCounts = computed(() => {
 const counts = new Map<string, number>()
 for (const note of model.value?.notes ?? []) counts.set(note.date, (counts.get(note.date) ?? 0) + 1)
 return counts
})
const allocationLimits = computed(() => model.value && selectedNoteId.value && dialog.value === 'allocation'
 ? noteAllocationLimits(model.value, selectedDate.value, selectedNoteId.value, allocationUnit.value)
 : { maximum: 0, readonly: true })
// Preserve no-op confirmation when the displayed initial value rounds just above the exact limit.
const allocationMaximum = computed(() => Math.max(allocationLimits.value.maximum, allocationInitialValue.value))
function noteAllocation(note: CalendarNote) { return dailyAllocations.value.find(item => item.noteId === note.id) }
function allocationLabel(note: CalendarNote) {
 const item = noteAllocation(note)
 return item ? `${formatNumber(item.percent)}% · ${Number(item.hours.toFixed(2))} 小时` : '不计入工作时长'
}
function cancelAllocation() { allocationBusy.value = false; allocationCancelToken.value++ }
function startAllocation() { allocationBusy.value = true; closeMenu(false) }
function commitAllocation(value: AllocationCommit) {
 allocationBusy.value = false
 if (!editable.value || (dialog.value && dialog.value !== 'day') || drag.value) return
 if (change(book => resizeAllocationBoundary(book, value.date, value.leftNoteId, value.position, value.display))) emit('status', '工时分配已更新，可通过一次撤销恢复。')
}
function report(cause: unknown) { if (!disposed) problem.value = cause instanceof Error ? cause.message : String(cause) }
function normalizeSelection(focusGrid = false) {
 if (!model.value) return
 const date = normalizeVisibleDate(selectedDate.value, model.value.weekMode, month.value)
 if (date === selectedDate.value) return
 selectedDate.value = date; selectedNoteId.value = null
 if (focusGrid) void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-calendar-day="${date}"]`)?.focus({ preventScroll: true }))
}
function accept() {
 if (!session) return
 const gridHadFocus = !!root.value?.querySelector('.calendar-grid')?.contains(document.activeElement)
 model.value = session.model
 const snapshot = session.inspect(); canUndo.value = snapshot.canUndo; canRedo.value = snapshot.canRedo
 if (selectedNoteId.value && !model.value.notes.some(note => note.id === selectedNoteId.value)) selectedNoteId.value = null
 normalizeSelection(gridHadFocus)
 emit('dirty', snapshot.dirty)
}
function change(edit: (book: CalendarBook) => void): boolean {
 if (!session) return false
 try { session.change(edit); accept(); problem.value = ''; return true } catch (cause) { report(cause); return false }
}
function requireReady() {
 if (!session || disposed || loading.value) throw Error('请等待日历本打开。')
 if (dialog.value) throw Error('请先完成或取消当前日历设置。')
 if (drag.value) throw Error('请先完成或取消当前拖动。')
 if (allocationBusy.value) throw Error('请先完成或取消当前工时分配。')
}
function view() { return { month: month.value, selectedDate: selectedDate.value, selectedNoteId: selectedNoteId.value, search: query.value } }
function closeMenu(restore = true) {
 const hadFocus = !!menuElement.value?.contains(document.activeElement)
 menu.value = undefined
 if (restore && hadFocus && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true })
}
function cancelDrag() { drag.value?.element.classList.remove('calendar-note-drag-source'); drag.value = undefined; dropDate.value = '' }
function selectDate(date: string) { if (controlsReady.value) { selectedDate.value = date; selectedNoteId.value = null; closeMenu(false) } }
function selectNote(note: CalendarNote) { if (controlsReady.value) { selectedDate.value = note.date; selectedNoteId.value = note.id; closeMenu(false) } }
function setMonth(value: string) {
 if (!controlsReady.value) return
 try {
  validateMonth(value); month.value = value; closeMenu(false)
  if (!selectedDate.value.startsWith(`${value}-`)) { selectedDate.value = `${value}-01`; selectedNoteId.value = null }
  normalizeSelection()
 } catch (cause) { report(cause) }
}
function navigate(delta: number) { try { setMonth(shiftMonth(month.value, delta)) } catch (cause) { report(cause) } }
function today() { if (controlsReady.value) { month.value = todayDate().slice(0, 7); selectedDate.value = todayDate(); selectedNoteId.value = null; normalizeSelection(); closeMenu(false) } }
function openDialog(kind: NonNullable<typeof dialog.value>) { closeMenu(); dialogError.value = ''; problem.value = ''; dialog.value = kind }
function openNote(date = selectedDate.value, id?: string) {
 if (!model.value || !controlsReady.value) return
 const original = id ? model.value.notes.find(note => note.id === id) : undefined
 if (id && !original) return
 selectedDate.value = original?.date ?? date; selectedNoteId.value = original?.id ?? null
 editingNote.value = !!original; historyQuery.value = ''
 draft.value = original ? { ...original } : { id: calendarId(), title: '', content: '', date, color: palette[0]!, type: '工作日', created_at: new Date().toISOString() }
 openDialog('note')
 void nextTick(() => dialogElement.value?.querySelector<HTMLInputElement>('[data-testid="calendar-note-title"]')?.focus())
}
function useHistory(item: CalendarHistoryItem) {
 if (!draft.value) return
 // Reuse classification only; a different day's private text is never copied.
 draft.value = { ...draft.value, title: item.title, color: item.color, type: item.type }
}
function addPreset(title: string) {
 if (!controlsReady.value) return
 const date = menu.value?.date ?? selectedDate.value
 const note: CalendarNote = { id: calendarId(), title, content: '', date, color: '#ff8a5c', type: '非工作日', created_at: new Date().toISOString() }
 closeMenu()
 if (change(book => { book.notes.push(note); rememberHistory(book, note) })) {
  selectedDate.value = date; selectedNoteId.value = note.id; emit('status', `已添加“${title}”，可以撤销。`)
 }
}
function askDelete(id: string) {
 if (!controlsReady.value || !model.value?.notes.some(note => note.id === id)) return
 selectedNoteId.value = id; openDialog('delete')
}
function clearMonth() { if (controlsReady.value && notesInMonth.value.length) openDialog('clear') }
function showDay(date: string) { if (controlsReady.value) { selectedDate.value = date; selectedNoteId.value = null; openDialog('day') } }
function showSummary() { if (controlsReady.value) openDialog('summary') }
function openAllocation(note: CalendarNote) {
 if (!model.value || !editable.value || drag.value || allocationBusy.value || (dialog.value && dialog.value !== 'day')) return
 const item = dayAllocations(model.value, note.date).find(item => item.noteId === note.id)
 if (!item) return
 allocationReturnToDay.value = dialog.value === 'day'
 selectedDate.value = note.date; selectedNoteId.value = note.id; allocationUnit.value = model.value.allocationDisplay
 allocationInitialValue.value = Number((allocationUnit.value === 'percent' ? item.percent : item.hours).toFixed(8))
 allocationValueDraft.value = allocationInitialValue.value
 openDialog('allocation')
 void nextTick(() => {
  const input = dialogElement.value?.querySelector<HTMLInputElement>('[data-testid="calendar-allocation-value"]')
  input?.focus(); input?.select()
 })
}
function editFromDay(id: string) { cancelDialog(); openNote(selectedDate.value, id) }
function settings() { if (controlsReady.value && model.value) { titleDraft.value = model.value.title; workdayHoursDraft.value = model.value.workdayHours; weekModeDraft.value = model.value.weekMode; allocationDisplayDraft.value = model.value.allocationDisplay; openDialog('settings') } }
async function showDateDetails(date = selectedDate.value) {
 if (!controlsReady.value) return
 selectedDate.value = date; details.value = undefined; openDialog('almanac')
 const owner = generation
 try {
  const provider = almanac.value ?? await loadCalendarAlmanac()
  if (disposed || owner !== generation || dialog.value !== 'almanac' || selectedDate.value !== date) return
  almanac.value = provider; details.value = provider.details(date)
 } catch { if (!disposed && owner === generation && dialog.value === 'almanac') dialogError.value = '此日期的农历详情暂不可用，日历事项不受影响。' }
}
function cancelDialog() {
 const returnToDay = dialog.value === 'allocation' && allocationReturnToDay.value
 cancelAllocation(); dialog.value = returnToDay ? 'day' : null; dialogError.value = ''; draft.value = undefined; details.value = undefined; allocationReturnToDay.value = false; accept()
 if (returnToDay) void nextTick(() => dialogElement.value?.querySelector<HTMLElement>(`[data-testid="calendar-note-value-${selectedNoteId.value}"]`)?.focus({ preventScroll: true }))
}
function deleteFromDay(id: string) { if (!allocationBusy.value) { cancelDialog(); askDelete(id) } }
function submitDialog() {
 if (!session || !editable.value) return
 try {
  const previousDate = selectedDate.value, settingWeekMode = dialog.value === 'settings'
  if (dialog.value === 'note' && draft.value) {
   const note = { ...draft.value, title: draft.value.title.trim() }
   session.change(book => {
    const index = book.notes.findIndex(item => item.id === note.id)
    if (editingNote.value && index < 0) throw Error('原事项已被删除，请重新打开。')
    if (index < 0) book.notes.push(note); else book.notes[index] = note
    rememberHistory(book, note)
   })
   selectedDate.value = note.date; selectedNoteId.value = note.id; month.value = note.date.slice(0, 7)
  } else if (dialog.value === 'delete' && selectedNoteId.value) {
   const id = selectedNoteId.value; session.change(book => { preserveHistory(book); book.notes = book.notes.filter(note => note.id !== id) })
  } else if (dialog.value === 'clear') {
   const prefix = `${month.value}-`; session.change(book => { preserveHistory(book); book.notes = book.notes.filter(note => !note.date.startsWith(prefix)) })
  } else if (dialog.value === 'settings') session.change(book => { book.title = titleDraft.value.trim(); book.workdayHours = workdayHoursDraft.value; book.weekMode = weekModeDraft.value; book.allocationDisplay = allocationDisplayDraft.value })
  else if (dialog.value === 'allocation') {
   const id = selectedNoteId.value, value = allocationValueDraft.value
   if (!id || typeof value !== 'number' || !Number.isFinite(value)) throw Error('请输入有效的工时数值。')
   // Opening and confirming a rounded display value must not change saved precision.
   if (value !== allocationInitialValue.value) session.change(book => setNoteAllocation(book, selectedDate.value, id, value, allocationUnit.value))
  }
  cancelDialog(); problem.value = ''; accept()
  if (settingWeekMode && previousDate !== selectedDate.value) void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-calendar-day="${selectedDate.value}"]`)?.focus({ preventScroll: true }))
 } catch (cause) { dialogError.value = cause instanceof Error ? cause.message : String(cause) }
}

function contextMenu(event: MouseEvent, date: string) {
 event.preventDefault()
 if (!controlsReady.value) return
 selectedDate.value = date; selectedNoteId.value = null
 const target = event.currentTarget as HTMLElement
 menuTrigger = target.hasAttribute('tabindex') || target.matches('button,input,select,textarea,a[href]')
  ? target : target.querySelector<HTMLElement>('button:not(:disabled),[tabindex]') ?? target.closest<HTMLElement>('[data-calendar-day]') ?? target
 menu.value = { x: Math.max(8, Math.min(event.clientX, window.innerWidth - 218)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 198)), date }
 void nextTick(() => menuElement.value?.querySelector<HTMLButtonElement>('button')?.focus())
}
function keyboardMenu(event: KeyboardEvent, date: string) {
 const element = event.currentTarget as HTMLElement, rect = element.getBoundingClientRect()
 event.preventDefault(); event.stopPropagation()
 contextMenu({ preventDefault() {}, currentTarget: element, clientX: rect.left + 16, clientY: rect.top + 28 } as unknown as MouseEvent, date)
}
function menuKey(event: KeyboardEvent) {
 if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); closeMenu(); return }
 if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
 const items = [...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])], current = items.indexOf(document.activeElement as HTMLButtonElement)
 if (!items.length) return
 const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
 event.preventDefault(); items[index]?.focus()
}
function outsideMenu(event: PointerEvent) { if (menu.value && !menuElement.value?.contains(event.target as Node)) closeMenu(false) }
function startDrag(event: DragEvent, note: CalendarNote) {
 if (!controlsReady.value || !event.dataTransfer) { event.preventDefault(); return }
 selectedDate.value = note.date; selectedNoteId.value = note.id; closeMenu(false)
 const element = event.currentTarget as HTMLElement
 // Hide the delete button synchronously, before the browser captures its drag image.
 element.classList.add('calendar-note-drag-source')
 drag.value = { id: note.id, generation, copy: event.ctrlKey || event.metaKey, element }
 event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData('application/x-open-office-calendar-note', note.id)
 event.dataTransfer.dropEffect = drag.value.copy ? 'copy' : 'move'
 event.dataTransfer.setData('text/plain', note.title)
}
function dragOver(event: DragEvent, date: string) {
 if (!drag.value || !editable.value || dialog.value || drag.value.generation !== generation) return
 event.preventDefault(); drag.value.copy = event.ctrlKey || event.metaKey; dropDate.value = date
 if (event.dataTransfer) event.dataTransfer.dropEffect = drag.value.copy ? 'copy' : 'move'
}
function dragLeave(event: DragEvent, date: string) {
 if (dropDate.value !== date) return
 if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
 dropDate.value = ''
}
function drop(event: DragEvent, date: string) {
 if (!drag.value || !session || !editable.value || dialog.value || drag.value.generation !== generation) return
 event.preventDefault(); event.stopPropagation()
 const source = session.model.notes.find(note => note.id === drag.value!.id), copy = event.ctrlKey || event.metaKey
 cancelDrag()
 if (!source || (!copy && source.date === date)) return
 const note: CalendarNote = { ...source, date, ...(copy ? { id: calendarId(), created_at: new Date().toISOString() } : {}) }
 if (change(book => {
  if (copy) { book.notes.push(note); rememberHistory(book, note) }
  else { const index = book.notes.findIndex(item => item.id === note.id); if (index < 0) throw Error('原事项已被删除。'); book.notes[index] = note }
 })) { selectedDate.value = date; selectedNoteId.value = note.id; emit('status', `已${copy ? '复制' : '移动'}“${note.title}”到 ${date}。`) }
}
function dayKey(event: KeyboardEvent, date: string) {
 if (event.target !== event.currentTarget || !controlsReady.value) return
 if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { keyboardMenu(event, date); return }
 if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
  const next = moveCalendarDate(date, event.key as 'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown', model.value?.weekMode ?? 'week')
  event.preventDefault(); event.stopPropagation(); selectedDate.value = next; selectedNoteId.value = null
  if (!days.value.some(day => day.date === next)) month.value = next.slice(0, 7)
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-calendar-day="${next}"]`)?.focus({ preventScroll: true }))
 } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectDate(date) }
}
function keydown(event: KeyboardEvent) {
 if (!props.active || event.defaultPrevented || event.isComposing) return
 if (event.key === 'Escape' && allocationBusy.value) { event.preventDefault(); event.stopPropagation(); cancelAllocation(); return }
 if (event.key === 'Escape' && drag.value) { event.preventDefault(); event.stopPropagation(); cancelDrag(); return }
 if (event.key === 'Escape' && menu.value) { event.preventDefault(); event.stopPropagation(); closeMenu(); return }
 if (!controlsReady.value || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return
 if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
  event.preventDefault(); event.stopPropagation(); void (event.shiftKey || event.key.toLowerCase() === 'y' ? redo() : undo()).catch(report)
 } else if (event.key === 'Delete' && selectedNoteId.value) { event.preventDefault(); event.stopPropagation(); askDelete(selectedNoteId.value) }
}
function holiday(date: string) {
 let override: string|null|undefined
 for (const year of Object.keys(holidayYears.value).map(Number).sort((a, b) => a - b)) {
  const dates = holidayYears.value[year]
  if (dates && Object.hasOwn(dates, date)) override = dates[date]
 }
 if (override !== undefined) return { name: override ?? '调休上班', workday: override === null }
 return almanac.value?.day(date).holiday
}
async function refreshHolidays(force = false) {
 if (disposed || !props.active || !model.value) return
 const token = ++holidayRequest, years = visibleYears.value
 holidayBusy.value = true
 try {
  const client = await getHolidayClient()
  if (disposed || token !== holidayRequest) return
  holidayYears.value = client.read(years)
  const result = await client.load(years, force), persisted = await flushHolidayCache()
  if (disposed || token !== holidayRequest) return
  holidayYears.value = result.years
  holidayMessage.value = result.failedYears.length ? '部分年度公告暂未取得，继续显示本地节日信息。' : persisted ? '法定假日已更新并缓存。' : '法定假日已更新，本机缓存暂未写入。'
 } catch { if (!disposed && token === holidayRequest) holidayMessage.value = '假日更新暂不可用，继续使用已有数据。' }
 finally { if (!disposed && token === holidayRequest) holidayBusy.value = false }
}
async function undo() { requireReady(); if (session!.undo()) accept() }
async function redo() { requireReady(); if (session!.redo()) accept() }
async function inspect() { if (!session) throw Error('请等待日历本打开。'); return { ...session.inspect(), book: structuredClone(session.model), view: view(), gestureActive: allocationBusy.value } }
async function prepareDeactivate() { requireReady(); closeMenu(); return session!.inspect() }
async function canBackgroundExport() { return !!session && !disposed && !loading.value && !dialog.value && !drag.value && !allocationBusy.value }
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
 requireReady()
 if (options.format === 'json') {
  const snapshot = session!.inspect()
  return { base64: bytesToBase64(encodeCalendar(session!.model)), extension: 'json', saveAs: true, dirty: snapshot.dirty, revision: `${snapshot.documentId}:${snapshot.revision}` }
 }
 if (options.format && options.format !== 'oocalendar') throw Error('日历本支持保存为 .oocalendar。')
 const result = session!.export(), base64 = bytesToBase64(result.bytes)
 lastExport = { generation, base64 }
 return { base64, extension: 'oocalendar', name: props.document.name.replace(/\.[^.]+$/, '') + '.oocalendar', dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string) {
 requireReady()
 if (!lastExport || lastExport.generation !== generation || base64 !== lastExport.base64) throw Error('保存回执与当前日历不匹配，请重新保存。')
 session!.markSaved(base64ToBytes(base64)); accept()
}
async function discardChanges(options: { force?: boolean } = {}) {
 if (options.force) { cancelDrag(); cancelAllocation(); closeMenu(false); generation++; dialog.value = null; return }
 if ((await prepareDeactivate()).dirty) throw Error('日历本还有未保存的修改，请先保存或确认不保存后关闭。')
}
function focus() { root.value?.focus({ preventScroll: true }) }
async function search(value: string) { requireReady(); query.value = value; closeMenu(false) }
async function print() {
 requireReady()
 const book = session!.model, owner = generation, revision = session!.revision, currentMonth = month.value
 const cells = visibleMonthDays(currentMonth, book.weekMode), printColumns = book.weekMode === 'work' ? 5 : 7
 const visibleDates = new Set(cells.filter(cell => cell.date && cell.inMonth).map(cell => cell.date!))
 const notes = book.notes.filter(note => visibleDates.has(note.date)).slice().sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
 const allocationsByDate = new Map(cells.filter(cell => cell.date && cell.inMonth).map(cell => [cell.date!, dayAllocations(book, cell.date!)]))
 const allocationsById = new Map([...allocationsByDate.values()].flat().map(item => [item.noteId, item]))
 const monthlySummary = monthSummary(book, currentMonth)
 const precise = (value: number) => Number(value.toFixed(2)).toLocaleString('zh-CN')
 return printHtml({ title: `${book.title} · ${currentMonth}`, css: `@page{size:A4 landscape;margin:12mm}#office-print-root{width:1123px;padding:24px;font-family:var(--ui-font);font-size:12px}#office-print-root h1{font-size:22px;margin:0 0 16px}#office-print-root table{width:100%;border-collapse:collapse;table-layout:fixed}#office-print-root th,#office-print-root td{border:1px solid #ccd3dd;padding:7px;vertical-align:top}#office-print-root td{height:90px}#office-print-root strong{display:block;margin-bottom:5px}#office-print-root p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}#office-print-root article{break-inside:avoid;padding:8px 0;border-bottom:1px solid #dde1e8}#office-print-root h2{margin-top:24px}#office-print-root .note-title{padding-left:5px;border-left:3px solid}#office-print-root .work-capsule{display:flex;border:1px solid #ccd3dd;border-radius:14px;overflow:hidden;min-height:36px;margin:5px 0}#office-print-root .work-capsule>span{min-width:0;flex-basis:0;padding:5px 1px;font-size:9px;text-align:center;overflow:hidden;white-space:pre;text-overflow:ellipsis;border-right:1px solid #ccd3dd}#office-print-root .work-summary{font-size:10px;margin:8px 0 12px;line-height:1.6}`, render(document, container) {
  const node = (name: string, text?: string) => { const element = document.createElement(name); if (text !== undefined) element.textContent = text; return element }
  container.append(node('h1', `${book.title} · ${currentMonth}`))
  const summary = node('p', `全月工时统计${book.weekMode === 'work' ? '（包含隐藏的周末事项）' : ''} · ${monthlySummary.map(item => `${item.title} ${summaryWork(item, book.allocationDisplay)}（${precise(item.percent)}%）`).join('；') || '暂无工作事项'}`)
  summary.className = 'work-summary'; container.append(summary)
  container.append(node('p', book.weekMode === 'work' ? 'Work · 周一至周五，以下月历与事项清单仅列出当前视图日期。' : 'Week · 周一至周日'))
  const table = node('table'), header = node('tr')
  weekdays.slice(0, printColumns).forEach(day => header.append(node('th', day))); table.append(header)
  for (let row = 0; row < 6; row++) {
   const tr = node('tr')
   for (const cell of cells.slice(row * printColumns, (row + 1) * printColumns)) {
    const td = node('td')
    if (cell.date) {
     td.append(node('strong', cell.date))
     const onDay = notes.filter(note => note.date === cell.date)
     const work = allocationsByDate.get(cell.date) ?? [], off = onDay.filter(note => note.type === '非工作日')
     if (work.length) {
      const capsule = node('div'); capsule.className = 'work-capsule'
      for (const item of work) { const segment = node('span', `${item.title}\n${book.allocationDisplay === 'percent' ? `${precise(item.percent)}%` : `${precise(item.hours)}h`}`); segment.style.flexGrow = String(item.weight); segment.style.background = item.color + '35'; capsule.append(segment) }
      td.append(capsule)
     }
     off.slice(0, 2).forEach(note => { const title = node('p', note.title); title.className = 'note-title'; title.style.borderColor = note.color; td.append(title) })
     if (off.length > 2) td.append(node('p', `另有 ${off.length - 2} 项，见下方清单`))
    }
    tr.append(td)
   }
   table.append(tr)
  }
  container.append(table, node('h2', `当前视图事项清单（${notes.length}）`))
  for (const note of notes) { const article = node('article'), allocation = allocationsById.get(note.id); article.append(node('strong', `${note.date} · ${note.title} · ${allocation ? `${precise(allocation.percent)}% · ${precise(allocation.hours)} 小时 · ${precise(allocation.weight)} 天` : '不需要上班 · 不计工时'}`)); if (note.content) article.append(node('p', note.content)); container.append(article) }
 }, prepare() { if (disposed || owner !== generation || revision !== session?.revision) throw Error('打印准备期间日历本已变化，请重试。') } })
}
async function mcpExecute(name: string, args: Record<string, unknown>, assertCurrent: () => void): Promise<unknown> {
 const owner = generation
 const guard = () => { assertCurrent(); if (disposed || owner !== generation || !props.active) throw Error('MCP 日历本已切换，请重新开启服务。') }
 guard(); requireReady()
 const result = executeCalendarTool({ session: session!, view, setView(value) { month.value = value.month; selectedDate.value = value.selectedDate; selectedNoteId.value = value.selectedNoteId; query.value = value.search; normalizeSelection() }, changed: accept }, name, args, guard)
 closeMenu(); await nextTick(); guard(); return result
}

watch(() => props.document.id, async () => {
 const owner = ++generation
 cancelDrag(); cancelAllocation(); closeMenu(false); loading.value = true; problem.value = ''; dialog.value = null; selectedNoteId.value = null; lastExport = undefined; query.value = ''
 try {
  const bytes = props.document.base64 ? base64ToBytes(props.document.base64) : undefined
  session = new CalendarSession(bytes, props.document.name.replace(/\.[^.]+$/, '') || '日历便笺')
  month.value = todayDate().slice(0, 7); selectedDate.value = todayDate()
  accept(); loading.value = false; await nextTick()
  if (disposed || owner !== generation) return
  emit('ready'); emit('status', '右键日期添加事项；单击选中日期，点击“日期详情”查看农历。')
  void refreshHolidays()
 } catch (cause) { report(cause); loading.value = false; emit('error', problem.value) }
}, { immediate: true })
watch(() => visibleYears.value.join(','), () => { void refreshHolidays() })
watch(() => props.active, active => { if (!active) { cancelDrag(); cancelAllocation(); closeMenu(false); holidayRequest++; holidayBusy.value = false } else void refreshHolidays() })
watch(() => props.disabled, disabled => { if (disabled) { cancelDrag(); cancelAllocation(); closeMenu(false) } })
watch(() => props.focusMode, () => { cancelAllocation(); closeMenu(false) })
onMounted(() => {
 window.addEventListener('pointerdown', outsideMenu)
 window.addEventListener('resize', closeOnResize)
 timer = setInterval(() => { if (props.active) void refreshHolidays() }, 24 * 60 * 60 * 1000)
 void loadCalendarAlmanac().then(provider => { if (!disposed) almanac.value = provider }).catch(() => {})
})
function closeOnResize() { closeMenu(false) }
onBeforeUnmount(() => { disposed = true; generation++; holidayRequest++; clearInterval(timer); window.removeEventListener('pointerdown', outsideMenu); window.removeEventListener('resize', closeOnResize); cancelDrag(); cancelAllocation(); session = undefined })
defineExpose({ mcpExecute, prepareDeactivate, exportFile, markSaved, discardChanges, inspect, syncRevision: inspect, canBackgroundExport, undo, redo, search, print, focus })
</script>

<template>
 <section ref="root" class="calendar-editor" :class="{'calendar-focus-mode': focusMode,'calendar-work-mode':model?.weekMode==='work','calendar-dragging':!!drag}" :style="{'--calendar-columns':columns}" :data-week-mode="model?.weekMode" data-testid="calendar-editor" data-kind="calendar" :data-document-id="document.id" :data-document-key="document.id" :aria-label="model?.title || '日历便笺'" tabindex="-1" @keydown="keydown">
  <p v-if="loading" class="calendar-loading">正在打开日历本…</p>
  <template v-else-if="model">
   <header class="calendar-toolbar" role="toolbar" aria-label="日历工具">
    <div v-show="!focusMode" class="calendar-book-title" :title="model.title"><Icon name="schedule" :size="20"/><strong>{{model.title}}</strong></div>
    <div class="calendar-navigation"><button data-testid="calendar-prev" aria-label="上一月" :disabled="!controlsReady || month==='1900-01'" @click="navigate(-1)"><Icon name="chevron" :size="16" class="calendar-back"/></button><label class="calendar-month-label"><span>{{monthTitle}}</span><input data-testid="calendar-month" aria-label="选择月份" type="month" :value="month" min="1900-01" max="9999-12" :disabled="!controlsReady" @change="setMonth(($event.target as HTMLInputElement).value)"></label><button data-testid="calendar-next" aria-label="下一月" :disabled="!controlsReady || month==='9999-12'" @click="navigate(1)"><Icon name="chevron" :size="16"/></button><button data-testid="calendar-today" :disabled="!controlsReady" @click="today">今天</button></div>
    <div class="calendar-toolbar-actions"><button data-testid="calendar-settings" title="日历本设置" :disabled="!controlsReady" @click="settings">设置</button><button data-testid="calendar-add" class="calendar-primary" :disabled="!controlsReady" @click="openNote()"><Icon name="plus" :size="15"/>添加事项</button><button data-testid="calendar-undo" title="撤销" aria-label="撤销日历修改" :disabled="!controlsReady || !canUndo" @click="undo().catch(report)"><Icon name="undo" :size="15"/></button><button data-testid="calendar-redo" title="重做" aria-label="重做日历修改" :disabled="!controlsReady || !canRedo" @click="redo().catch(report)"><Icon name="redo" :size="15"/></button><button data-testid="calendar-clear-month" title="清除当前月所有事项" aria-label="清除当月事项" :disabled="!controlsReady || !notesInMonth.length" @click="clearMonth"><Icon name="trash" :size="15"/></button><label class="calendar-search"><Icon name="search" :size="14"/><input v-model="query" data-testid="calendar-search" type="search" aria-label="搜索当月事项" placeholder="搜索当月事项" maxlength="200" :disabled="!controlsReady"></label></div>
   </header>
   <div v-if="summary.length" class="calendar-summary" data-testid="calendar-summary"><span class="calendar-summary-label" :title="model.weekMode==='work'?'全月统计，包含隐藏的周末事项':'全月工作事项统计'">{{model.weekMode==='work'?'全月工作 · 含周末':'全月工作'}}</span><div class="calendar-summary-tags"><span v-for="item in summary" :key="item.title" class="calendar-summary-tag" :style="{'--note-color':item.color}" :title="`${item.title} · ${summaryWork(item)} · ${formatNumber(item.percent)}%（${model.weekMode==='work'?'全月统计，包含隐藏的周末事项':'按全月实际工时分配统计'}）`"><span class="calendar-color-dot"/><span class="calendar-summary-name">{{item.title}}</span><span>{{summaryWork(item)}}</span><strong>{{formatNumber(item.percent)}}%</strong></span></div><button type="button" class="calendar-summary-more" data-testid="calendar-summary-more" :disabled="!controlsReady" @click="showSummary">全部 {{summary.length}} 项</button></div>
   <p v-if="problem" class="calendar-error" role="alert" data-testid="calendar-error">{{problem}}<button aria-label="关闭提示" @click="problem=''">×</button></p>
   <div class="calendar-scroll">
    <div class="calendar-weekdays" role="row"><span v-for="(name,index) in visibleWeekdays" :key="name" role="columnheader" :class="{'calendar-weekend':index>=5}">{{name}}</span></div>
    <div class="calendar-grid" role="grid" :aria-label="monthTitle" aria-multiselectable="false">
     <template v-for="(day,index) in days" :key="day.date || index">
      <div v-if="day.date" :data-testid="`calendar-day-${day.date}`" :data-calendar-day="day.date" class="calendar-day" :class="{'calendar-other-month':!day.inMonth,'calendar-weekend':day.weekday>=5,'calendar-day-selected':selectedDate===day.date,'calendar-day-today':day.isToday,'calendar-drop-target':dropDate===day.date,'calendar-has-work':workNotes(day.date).length>0}" role="gridcell" :tabindex="selectedDate===day.date?0:-1" :aria-label="`${day.date}${day.isToday?' 今天':''}，${dayNotes(day.date).length} 个事项`" :aria-selected="selectedDate===day.date" @click="selectDate(day.date)" @dblclick="openNote(day.date)" @contextmenu="contextMenu($event,day.date)" @keydown="dayKey($event,day.date)" @dragenter="dragOver($event,day.date)" @dragover="dragOver($event,day.date)" @dragleave="dragLeave($event,day.date)" @drop="drop($event,day.date)">
       <div class="calendar-day-heading"><span class="calendar-day-number">{{day.day}}</span><span class="calendar-lunar" :title="almanac?.day(day.date).festival || almanac?.day(day.date).lunar">{{almanac?.day(day.date).festival || almanac?.day(day.date).lunar}}</span><span v-if="holiday(day.date)" class="calendar-holiday" :class="{'calendar-workday':holiday(day.date)?.workday}" :title="holiday(day.date)?.name">{{holiday(day.date)?.workday?'班':'休'}}</span><button v-if="noteCounts.get(day.date)" type="button" class="calendar-day-allocation" :data-testid="`calendar-day-allocation-${day.date}`" :aria-label="`查看 ${day.date} 的全部 ${noteCounts.get(day.date)} 项事项并调整工时`" :disabled="!controlsReady" @click.stop="showDay(day.date)" @dblclick.stop><span :data-testid="(noteCounts.get(day.date)??0)>2?`calendar-more-${day.date}`:undefined">{{noteCounts.get(day.date)}} 项</span><span>调整</span></button></div>
       <div class="calendar-day-notes">
        <CalendarWorkCapsule v-if="workNotes(day.date).length" :notes="workNotes(day.date)" :date="day.date" :workday-hours="model.workdayHours" :display="model.allocationDisplay" :disabled="capsuleDisabled" :selected-note-id="selectedNoteId" :search="query" :cancel-token="allocationCancelToken" @select="selectNote" @edit="openNote($event.date,$event.id)" @delete="askDelete($event.id)" @dragstart="startDrag" @dragend="cancelDrag" @contextmenu="(event,note)=>contextMenu(event,note.date)" @edit-allocation="openAllocation" @allocation-start="startAllocation" @allocation-commit="commitAllocation" @allocation-cancel="allocationBusy=false"/>
        <div v-for="note in offNotes(day.date).slice(0,2)" :key="note.id" :data-testid="`calendar-note-${note.id}`" :data-note-id="note.id" class="calendar-note" :class="{'calendar-note-selected':selectedNoteId===note.id,'calendar-note-off':note.type==='非工作日'}" :style="{'--note-color':note.color}" :draggable="editable && !dialog" @dragstart="startDrag($event,note)" @dragend="cancelDrag" @contextmenu.stop="contextMenu($event,note.date)" @dblclick.stop="openNote(note.date,note.id)">
         <button :data-testid="`calendar-note-title-${note.id}`" class="calendar-note-title" :title="`${note.title} · ${note.type==='工作日'?'需要上班':'不需要上班'}${note.content?'\n'+note.content:''}`" :disabled="!editable || !!dialog" @click.stop="selectNote(note)" @keydown.enter.stop.prevent="openNote(note.date,note.id)">{{note.title}}</button><button :data-testid="`calendar-note-delete-${note.id}`" class="calendar-note-delete" :aria-label="`删除 ${note.title}`" :disabled="!controlsReady" @click.stop="askDelete(note.id)" @dblclick.stop><Icon name="close" :size="12"/></button>
        </div>
       </div>
       <span v-if="dropDate===day.date && drag" class="calendar-drop-hint">{{drag.copy?'复制':'移动'}}到这一天</span>
      </div>
      <div v-else class="calendar-day calendar-invalid-day" role="gridcell" aria-disabled="true"/>
     </template>
    </div>
   </div>
   <footer class="calendar-selection" aria-live="polite"><strong>{{selectedDate}}</strong><span>{{selectedLunar?.lunar}}{{selectedLunar?.festival?' · '+selectedLunar.festival:''}}</span><span v-if="selected" class="calendar-selection-note" :title="selected.title">{{selected.title}}</span><button v-if="selected" data-testid="calendar-edit-selected" :disabled="!controlsReady" @click="openNote(selected.date,selected.id)">编辑事项</button><button data-testid="calendar-date-details" :disabled="!controlsReady" @click="showDateDetails()">日期详情</button><span class="calendar-selection-tail">{{allocationBusy?'释放保存 · Esc 取消':query?`${matchedCount} / ${notesInMonth.length} 项匹配`:`当月 ${notesInMonth.length} 项`}}</span><button class="calendar-holiday-status" data-testid="calendar-refresh-holidays" :title="holidayBusy?'正在更新节假日…':holidayMessage" aria-label="刷新法定节假日" :disabled="holidayBusy || !controlsReady" @click="refreshHolidays(true)"><Icon name="info" :size="14"/>{{holidayBusy?'更新中':'节假日'}}</button></footer>
  </template>
  <p v-else class="calendar-error" role="alert">{{problem || '无法打开日历本。'}}</p>
  <Teleport to="body">
   <div v-if="menu && active" ref="menuElement" class="calendar-context-menu" data-testid="calendar-context-menu" role="menu" aria-label="日期操作" :style="{left:`${menu.x}px`,top:`${menu.y}px`}" @keydown="menuKey" @contextmenu.prevent>
    <span class="calendar-menu-date">{{menu.date}}</span><button role="menuitem" data-testid="calendar-context-custom" @click="openNote(menu.date)"><Icon name="plus" :size="14"/>自定义</button><button role="menuitem" data-testid="calendar-context-annual-leave" @click="addPreset('年假')">年假</button><button role="menuitem" data-testid="calendar-context-sick-leave" @click="addPreset('病假')">病假</button><button role="menuitem" class="calendar-menu-secondary" data-testid="calendar-context-details" @click="showDateDetails(menu.date)">日期详情</button>
   </div>
   <div v-if="dialog && active" class="calendar-modal-backdrop" @keydown.esc.stop.prevent="cancelDialog">
    <form ref="dialogElement" class="calendar-dialog" :class="{'calendar-note-form':dialog==='note'}" role="dialog" aria-modal="true" :aria-label="dialogTitle" :data-testid="dialog==='note'?'calendar-note-dialog':dialog==='almanac'?'calendar-almanac-dialog':dialog==='day'?'calendar-day-dialog':dialog==='settings'?'calendar-settings-dialog':dialog==='allocation'?'calendar-allocation-dialog':dialog==='summary'?'calendar-summary-dialog':'calendar-delete-dialog'" @submit.prevent="submitDialog">
     <header><h2>{{dialogTitle}}</h2><button type="button" data-testid="calendar-note-cancel" aria-label="取消并关闭" @click="cancelDialog"><Icon name="close" :size="18"/></button></header>
     <template v-if="dialog==='note' && draft">
      <section class="calendar-history-section"><label class="calendar-field"><span>历史事项</span><input v-model="historyQuery" data-testid="calendar-history-search" type="search" placeholder="搜索以前用过的事项" maxlength="200" autocomplete="off"></label><div v-if="history.length" class="calendar-history-items"><button v-for="item in history" :key="item.title" type="button" data-testid="calendar-history-item" :data-history-title="item.title" class="calendar-history-item" :style="{'--note-color':item.color}" :aria-pressed="draft.title===item.title && draft.color===item.color && draft.type===item.type" @click="useHistory(item)"><span class="calendar-color-dot"/><span class="calendar-history-title">{{item.title}}</span><small>{{item.type==='工作日'?'需要上班':'不需要上班'}}</small></button></div><p v-else class="calendar-form-hint">{{historyQuery?'没有匹配的历史事项。':'创建的事项会保留在这里，跨月份也可复用。'}}</p><p class="calendar-form-hint">选择历史事项会带入标题、颜色和上班属性，保留当前填写的内容。</p></section>
      <label class="calendar-field"><span>标题</span><input v-model="draft.title" data-testid="calendar-note-title" required maxlength="200" autocomplete="off" placeholder="例如：项目会议"></label>
      <div class="calendar-form-columns"><label class="calendar-field"><span>日期</span><input v-model="draft.date" data-testid="calendar-note-date" type="date" min="1900-01-01" max="9999-12-31" required></label><label class="calendar-field"><span>事项属性</span><select v-model="draft.type" data-testid="calendar-note-type"><option value="工作日">需要上班</option><option value="非工作日">不需要上班</option></select></label></div>
      <label class="calendar-field"><span>内容</span><textarea v-model="draft.content" data-testid="calendar-note-content" maxlength="20000" rows="3" placeholder="可选，记录这一天的具体安排"/></label>
      <div class="calendar-field"><span>颜色</span><div class="calendar-colors"><button v-for="color in palette" :key="color" type="button" class="calendar-color-option" :style="{background:color}" :aria-label="`使用颜色 ${color}`" :aria-pressed="draft.color===color" @click="draft.color=color"><span v-if="draft.color===color">✓</span></button><input v-model="draft.color" data-testid="calendar-note-color" type="color" aria-label="自定义事项颜色"></div></div>
     </template>
     <template v-else-if="dialog==='delete'"><p>删除“{{deletableNote?.title}}”？</p><p class="calendar-form-hint">可通过撤销恢复。历史事项分类仍会保留。</p></template>
     <template v-else-if="dialog==='clear'"><p>清除 {{monthTitle}} 的 {{notesInMonth.length}} 个事项？</p><p class="calendar-form-hint">其他月份和历史事项保留，可通过一次撤销恢复。</p></template>
     <template v-else-if="dialog==='settings'"><p class="calendar-form-hint">应用于本日历本的所有日期，随日历本保存。</p><label class="calendar-field"><span>日历本名称</span><input v-model="titleDraft" data-testid="calendar-book-title" required maxlength="200" autocomplete="off"></label><div class="calendar-form-columns"><label class="calendar-field"><span>显示范围</span><select v-model="weekModeDraft" data-testid="calendar-week-mode"><option value="week">Week · 周一至周日</option><option value="work">Work · 周一至周五</option></select></label><label class="calendar-field"><span>工时显示</span><select v-model="allocationDisplayDraft" data-testid="calendar-allocation-display"><option value="percent">百分比</option><option value="hours">工时</option></select></label></div><label class="calendar-field"><span>每天工作时长（小时）</span><input v-model.number="workdayHoursDraft" data-testid="calendar-workday-hours" type="number" required min="0.5" max="24" step="0.5"></label><p class="calendar-form-hint">默认每天 7 小时。修改时长保留各事项比例；非工作事项不计工时。</p><p class="calendar-form-hint">Work 仅隐藏周末，保留事项和全月工时统计；法定假日仍按所在日期显示。</p></template>
     <template v-else-if="dialog==='day' && model"><section v-if="workNotes(selectedDate).length" class="calendar-day-allocation-panel"><div class="calendar-day-allocation-heading"><strong>全天 {{model.workdayHours}} 小时</strong><span>{{model.allocationDisplay==='percent'?'每格 10%':'每格 0.5 小时'}}</span></div><CalendarWorkCapsule :notes="workNotes(selectedDate)" :date="selectedDate" :workday-hours="model.workdayHours" :display="model.allocationDisplay" :disabled="!editable" :selected-note-id="selectedNoteId" :cancel-token="allocationCancelToken" :drag-enabled="false" expanded @edit="editFromDay($event.id)" @delete="deleteFromDay($event.id)" @edit-allocation="openAllocation" @allocation-start="startAllocation" @allocation-commit="commitAllocation" @allocation-cancel="allocationBusy=false"/><p class="calendar-form-hint">拖动相邻分隔线，或选中分隔线后按方向键调整。加入或移出工作事项后，当天重新均分。</p></section><div class="calendar-day-list"><button v-for="note in allDayNotes" :key="note.id" type="button" :data-note-id="note.id" :style="{'--note-color':note.color}" :disabled="allocationBusy" @click="editFromDay(note.id)"><span class="calendar-color-dot"/><span><strong>{{note.title}}</strong><small>{{note.type==='工作日'?allocationLabel(note):'不需要上班 · 不计工时'}}{{note.content?' · '+note.content:''}}</small></span><Icon name="chevron" :size="15"/></button></div><p v-if="!allDayNotes.length" class="calendar-form-hint">这一天还没有事项。</p></template>
     <template v-else-if="dialog==='allocation' && selected && model">
      <p><strong>{{selected.title}}</strong> · {{selectedDate}}</p>
      <label class="calendar-field"><span>{{allocationUnit==='percent'?'分配比例（%）':'工作时长（小时）'}}</span><input v-model.number="allocationValueDraft" data-testid="calendar-allocation-value" type="number" required min="0" :max="allocationMaximum" step="any" :readonly="allocationLimits.readonly" aria-describedby="calendar-allocation-hint"></label>
      <p id="calendar-allocation-hint" class="calendar-form-hint">{{dailyAllocations.length===1?'当天只有一项工作，固定占满全天；添加其他工作事项后即可调整。':allocationLimits.readonly?'最后一项保留剩余工时；要修改它，请先调整前面的事项。':'支持输入小数，前面的事项保持不变，当前事项不能超过剩余工时。确认后，仅后面的事项按原比例分配余量；原来都为 0 时平均分配。'}}</p>
      <p class="calendar-form-hint">输入时不重新分配，点击「确定」后更新，可撤销。当天合计保持 100%（{{model.workdayHours}} 小时）。</p>
     </template>
     <template v-else-if="dialog==='summary'"><p class="calendar-form-hint">{{monthTitle}} · 全月统计{{model?.weekMode==='work'?'，包含隐藏的周末事项':''}}</p><div class="calendar-summary-list"><span v-for="item in summary" :key="item.title" class="calendar-summary-tag" :style="{'--note-color':item.color}" :title="`${item.title} · ${summaryWork(item)} · ${formatNumber(item.percent)}%`"><span class="calendar-color-dot"/><span class="calendar-summary-name">{{item.title}}</span><span>{{summaryWork(item)}}</span><strong>{{formatNumber(item.percent)}}%</strong></span></div></template>
     <template v-else-if="dialog==='almanac'"><div v-if="details" class="calendar-almanac"><div class="calendar-almanac-heading"><strong>{{details.date}}</strong><span>{{details.weekday}} · {{details.lunarDate}}</span><span v-if="details.festival">{{details.festival}}</span></div><dl><dt>干支</dt><dd>{{details.stems}}</dd><dt>生肖 / 星座</dt><dd>{{details.zodiac}} · {{details.constellation}}</dd><dt>纳音</dt><dd>{{details.sounds}}</dd><dt>宜</dt><dd>{{details.suitable.join(' · ')}}</dd><dt>忌</dt><dd>{{details.avoid.join(' · ')}}</dd></dl><p class="calendar-form-hint">传统历法信息仅供查看，不影响事项和工作日统计。</p></div><p v-else-if="!dialogError" class="calendar-form-hint">正在读取日期详情…</p></template>
     <p v-if="dialogError" class="calendar-dialog-error" role="alert">{{dialogError}}</p>
     <footer><button type="button" @click="cancelDialog">{{dialog==='almanac'||dialog==='day'||dialog==='summary'?'关闭':'取消'}}</button><button v-if="dialog!=='almanac'&&dialog!=='day'&&dialog!=='summary'" type="submit" :data-testid="dialog==='note'?'calendar-note-confirm':dialog==='settings'?'calendar-settings-confirm':dialog==='allocation'?'calendar-allocation-confirm':'calendar-delete-confirm'" :class="dialog==='delete'||dialog==='clear'?'calendar-delete-confirm':'calendar-primary'" :disabled="dialog==='note' && !draft?.title.trim()">{{dialog==='delete'?'删除':dialog==='clear'?'清除当月':editingNote&&dialog==='note'?'保存修改':'确定'}}</button></footer>
    </form>
   </div>
  </Teleport>
 </section>
</template>

<style scoped>
.calendar-day-allocation{display:flex;align-items:center;justify-content:space-between;gap:3px;padding:0 3px;min-width:0;font-size:9px;color:var(--ui-muted);text-align:left}.calendar-day-allocation>span:first-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.calendar-day-allocation>span:last-child{color:var(--ui-accent);flex:none}.calendar-day-allocation:hover{color:var(--ui-accent)}.calendar-day-allocation-heading{display:flex;align-items:center;justify-content:space-between;font-size:12px;gap:10px;margin-bottom:9px}.calendar-day-allocation-heading>span{color:var(--ui-muted);font-size:11px}.calendar-day-allocation-panel{min-width:0;padding:12px;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-surface-muted)}

.calendar-editor{height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--ui-surface);color:var(--ui-text);outline:none}.calendar-loading{padding:24px;color:var(--ui-muted)}
.calendar-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:none;padding:10px 14px;border-bottom:1px solid var(--ui-line)}.calendar-toolbar button,.calendar-selection button{min-height:30px;padding:4px 8px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:12px;white-space:nowrap}.calendar-toolbar button:hover:not(:disabled),.calendar-selection button:hover:not(:disabled){background:var(--ui-accent-soft);color:var(--ui-accent)}.calendar-book-title{display:flex;align-items:center;gap:6px;min-width:0;max-width:220px;padding-left:0!important}.calendar-book-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.calendar-book-title svg{color:var(--ui-accent)}.calendar-navigation{display:flex;align-items:center;gap:3px}.calendar-back{transform:rotate(180deg)}.calendar-month-label{position:relative;min-width:125px;height:30px;display:flex;align-items:center;justify-content:center;font-weight:600}.calendar-month-label input{position:absolute;inset:0;width:100%;opacity:0;cursor:pointer}.calendar-month-label:focus-within{outline:2px solid var(--ui-accent);outline-offset:2px;border-radius:3px}.calendar-toolbar-actions{display:flex;align-items:center;gap:3px;margin-left:auto}.calendar-primary{background:var(--ui-accent)!important;color:var(--ui-on-accent)!important}.calendar-search{display:flex;align-items:center;gap:5px;border:1px solid var(--ui-line);border-radius:5px;padding:3px 7px;margin-left:7px;color:var(--ui-muted)}.calendar-search input{width:145px;height:23px;border:0;background:transparent;color:var(--ui-text);outline:none;font-size:12px}.calendar-search:focus-within{border-color:var(--ui-accent)}
.calendar-summary{flex:none;display:flex;align-items:center;gap:10px;padding:7px 14px;min-width:0;border-bottom:1px solid var(--ui-line);background:var(--ui-surface-muted)}.calendar-summary-label{font-size:11px;color:var(--ui-muted);flex:none}.calendar-summary-tags{display:flex;gap:7px;overflow-x:auto;scrollbar-width:thin;min-width:0}.calendar-summary-tag{display:flex;align-items:center;gap:6px;border:1px solid var(--ui-line);border-radius:20px;padding:3px 9px;font-size:11px;background:var(--ui-surface);white-space:nowrap;flex:none;max-width:300px}.calendar-summary-name{max-width:130px;overflow:hidden;text-overflow:ellipsis}.calendar-color-dot{width:7px;height:7px;background:var(--note-color);border-radius:50%;flex:none;display:inline-block}
.calendar-error{margin:0;padding:8px 14px;display:flex;justify-content:space-between;gap:8px;background:var(--ui-danger-soft);color:var(--ui-danger);font-size:12px;flex:none}.calendar-scroll{flex:1;min-height:0;overflow:auto}.calendar-weekdays{display:grid;grid-template-columns:repeat(var(--calendar-columns,7),minmax(0,1fr));min-width:var(--calendar-min-width,630px);position:sticky;top:0;z-index:2;background:var(--ui-surface-muted);border-bottom:1px solid var(--ui-line)}.calendar-weekdays span{padding:7px 10px;text-align:right;font-size:11px;color:var(--ui-muted)}.calendar-grid{display:grid;grid-template-columns:repeat(var(--calendar-columns,7),minmax(0,1fr));grid-template-rows:repeat(6,minmax(100px,1fr));min-width:var(--calendar-min-width,630px);min-height:calc(100% - 32px)}.calendar-day{min-width:0;position:relative;border-right:1px solid var(--ui-line);border-bottom:1px solid var(--ui-line);padding:7px 6px;cursor:default;background:var(--ui-surface);display:flex;flex-direction:column;gap:5px;outline-offset:-3px}.calendar-editor:not(.calendar-work-mode) .calendar-day:nth-child(7n),.calendar-work-mode .calendar-day:nth-child(5n){border-right:0}.calendar-day:hover{background:var(--ui-surface-muted)}.calendar-day-selected{background:var(--ui-accent-soft)!important;box-shadow:inset 0 0 0 1px var(--ui-accent)}.calendar-day-heading{display:flex;align-items:center;gap:5px;min-height:24px;min-width:0}.calendar-day-number{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;margin-left:auto;order:3;flex:none}.calendar-day-today .calendar-day-number{background:var(--ui-accent);color:var(--ui-on-accent)}.calendar-lunar{font-size:10px;color:var(--ui-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.calendar-weekend .calendar-day-number{color:var(--ui-danger)}.calendar-weekend.calendar-day-today .calendar-day-number{color:var(--ui-on-accent)}.calendar-other-month{background:var(--ui-surface-muted)}.calendar-other-month .calendar-day-heading{opacity:.55}.calendar-holiday{font-size:9px;color:var(--ui-danger);background:var(--ui-danger-soft);border-radius:3px;padding:0 3px;flex:none}.calendar-workday{color:var(--ui-success);background:var(--ui-success-soft)}.calendar-day-notes{display:flex;flex-direction:column;gap:4px;min-width:0}.calendar-note{display:flex;align-items:center;min-width:0;border-left:3px solid var(--note-color);border-radius:3px;background:color-mix(in srgb,var(--note-color) 15%,var(--ui-surface));box-shadow:0 0 0 1px color-mix(in srgb,var(--note-color) 22%,transparent);cursor:grab;height:25px;flex:none}.calendar-note-selected{outline:1px solid var(--ui-accent);outline-offset:1px}.calendar-note-off{border-left-style:dashed}.calendar-note-title{display:block;min-width:0;flex:1;text-align:left;padding:3px 5px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab;height:100%}.calendar-note-delete{padding:3px;display:flex;flex:none;opacity:0;border-radius:3px}.calendar-note:hover .calendar-note-delete,.calendar-note:focus-within .calendar-note-delete{opacity:1}.calendar-note-delete:hover{color:var(--ui-danger);background:var(--ui-surface)}.calendar-more-notes{text-align:left;font-size:10px;color:var(--ui-accent);padding:1px 4px;min-height:20px}.calendar-more-notes:hover{text-decoration:underline}.calendar-drop-target{outline:2px dashed var(--ui-accent);outline-offset:-3px;background:var(--ui-accent-soft)!important}.calendar-drop-hint{position:absolute;bottom:3px;left:5px;font-size:10px;color:var(--ui-accent);background:var(--ui-surface);padding:1px 3px;border-radius:3px;pointer-events:none}.calendar-invalid-day{background:var(--ui-surface-muted)}
.calendar-dragging .calendar-day :deep(button),.calendar-dragging .calendar-day :deep(.calendar-work-divider){pointer-events:none}.calendar-dragging .calendar-day :deep(.calendar-work-delete),.calendar-dragging .calendar-note-delete,.calendar-note.calendar-note-drag-source .calendar-note-delete{opacity:0;visibility:hidden}
.calendar-selection{height:40px;min-height:40px;display:flex;align-items:center;gap:10px;padding:0 12px;font-size:11px;border-top:1px solid var(--ui-line);flex:none;overflow:hidden;white-space:nowrap}.calendar-selection>span{color:var(--ui-muted)}.calendar-selection-note{max-width:160px;overflow:hidden;text-overflow:ellipsis}.calendar-selection-tail{margin-left:auto}.calendar-holiday-status{color:var(--ui-muted)}.calendar-focus-mode .calendar-toolbar{padding:5px 10px}.calendar-focus-mode .calendar-selection{height:34px;min-height:34px}
.calendar-context-menu{position:fixed;width:210px;padding:5px;background:var(--ui-surface);color:var(--ui-text);border:1px solid var(--ui-line-strong);border-radius:7px;box-shadow:0 8px 28px #0002;z-index:75;display:flex;flex-direction:column;gap:2px}.calendar-menu-date{padding:4px 8px;font-size:10px;color:var(--ui-muted)}.calendar-context-menu button{display:flex;align-items:center;gap:7px;text-align:left;min-height:31px;padding:5px 9px;border-radius:4px;font-size:12px}.calendar-context-menu button:hover,.calendar-context-menu button:focus-visible{background:var(--ui-accent-soft);color:var(--ui-accent)}.calendar-menu-secondary{border-top:1px solid var(--ui-line);border-radius:0!important;margin-top:3px;color:var(--ui-muted)}
.calendar-modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:#0006;z-index:80}.calendar-dialog{width:min(540px,100%);max-height:calc(100dvh - 40px);overflow:auto;display:flex;flex-direction:column;gap:15px;background:var(--ui-surface);color:var(--ui-text);border:1px solid var(--ui-line);border-radius:10px;padding:22px;box-shadow:0 18px 70px #0004}.calendar-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:15px}.calendar-dialog h2{font-size:18px;line-height:1.4;margin:0}.calendar-dialog>header button{padding:4px;display:flex;border-radius:4px}.calendar-dialog button:hover{background:var(--ui-accent-soft)}.calendar-dialog p{margin:0}.calendar-field{display:flex;flex-direction:column;gap:6px;font-size:12px}.calendar-field>span{font-weight:600}.calendar-field input,.calendar-field textarea,.calendar-field select{width:100%;border:1px solid var(--ui-line-strong);background:var(--ui-surface);color:var(--ui-text);border-radius:5px;padding:8px;font-size:13px;min-height:35px}.calendar-field input:not([type=color]),.calendar-field select{height:var(--ui-control-height-form);min-height:var(--ui-control-height-form);padding:0 8px}.calendar-field textarea{resize:vertical}.calendar-form-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.calendar-history-section{background:var(--ui-surface-muted);border:1px solid var(--ui-line);border-radius:6px;padding:11px;display:flex;flex-direction:column;gap:8px}.calendar-history-items{display:flex;flex-wrap:wrap;gap:5px;max-height:116px;overflow:auto}.calendar-history-item{max-width:100%;display:flex;align-items:center;gap:6px;border:1px solid var(--ui-line-strong);border-radius:20px;min-height:29px;padding:4px 9px;background:var(--ui-surface);font-size:11px}.calendar-history-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}.calendar-history-item small{font-size:10px;color:var(--ui-muted);white-space:nowrap}.calendar-history-item[aria-pressed=true]{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.calendar-form-hint{font-size:11px!important;line-height:1.65;color:var(--ui-muted)}.calendar-colors{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.calendar-color-option{height:26px;width:26px;padding:0;border:2px solid transparent;border-radius:50%;color:#142239;font-size:14px;text-shadow:0 0 2px white}.calendar-color-option[aria-pressed=true]{outline:2px solid var(--ui-accent);outline-offset:2px}.calendar-colors input[type=color]{width:32px;height:30px;min-height:30px;padding:2px}.calendar-dialog>footer{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--ui-line);padding-top:13px}.calendar-dialog>footer button{padding:7px 15px;border-radius:5px;font-size:12px;min-height:34px}.calendar-delete-confirm{background:var(--ui-danger)!important;color:var(--ui-surface)!important}.calendar-dialog-error{padding:8px 10px;border-radius:5px;background:var(--ui-danger-soft);color:var(--ui-danger);font-size:12px}.calendar-day-list{display:flex;flex-direction:column;gap:5px;max-height:400px;overflow:auto}.calendar-day-list>button{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--ui-line);border-radius:5px;text-align:left}.calendar-day-list>button>span:nth-child(2){min-width:0;flex:1}.calendar-day-list strong,.calendar-day-list small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.calendar-day-list small{font-size:11px;color:var(--ui-muted);margin-top:3px}.calendar-almanac-heading{display:flex;flex-direction:column;gap:6px;padding-bottom:15px;border-bottom:1px solid var(--ui-line)}.calendar-almanac-heading strong{font-size:22px;color:var(--ui-accent)}.calendar-almanac-heading span{font-size:12px;color:var(--ui-muted)}.calendar-almanac dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px 8px;font-size:12px;margin:18px 0}.calendar-almanac dt{color:var(--ui-muted)}.calendar-almanac dd{margin:0;overflow-wrap:anywhere;line-height:1.7}
@media(max-width:900px){.calendar-toolbar{gap:7px;padding:7px 9px}.calendar-toolbar-actions{margin-left:0;flex:1}.calendar-search{margin-left:auto}.calendar-book-title{max-width:150px}.calendar-summary{padding:6px 9px}.calendar-selection{gap:6px;padding:0 8px}.calendar-selection-note{display:none}}@media(max-width:600px){.calendar-book-title{max-width:180px}.calendar-toolbar-actions{flex-basis:100%}.calendar-search input{width:125px}.calendar-modal-backdrop{padding:12px}.calendar-dialog{padding:16px;max-height:calc(100dvh - 24px)}.calendar-form-columns{grid-template-columns:1fr}.calendar-selection>span:not(.calendar-selection-tail){display:none}.calendar-selection button{padding:4px}.calendar-holiday-status{display:none!important}}
/* Keep all six weeks inside the available workspace. Each cell reserves its
 * header action before progressively revealing event previews. Full lists
 * remain available through that action, regardless of the preview density. */
.calendar-editor{overflow:hidden}
.calendar-scroll{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.calendar-weekdays{flex:none;position:static;min-width:0;width:100%}
.calendar-weekdays span{padding:4px 6px}
.calendar-grid{flex:1;min-height:0;min-width:0;width:100%;grid-template-rows:repeat(6,minmax(0,1fr));overflow:hidden}
.calendar-day{min-height:0;padding:2px 3px;gap:1px;overflow:hidden;container:calendar-cell / size}
.calendar-day-heading{height:16px;min-height:16px;flex:none;gap:3px}
.calendar-day-number{height:16px;width:18px;font-size:11px}
.calendar-lunar{flex:1;font-size:9px}
.calendar-holiday{font-size:8px;padding:0 2px}
.calendar-day-allocation{flex:none;display:inline-flex;justify-content:center;gap:3px;max-width:calc(100% - 22px);height:16px;min-height:16px;padding:0 2px;border-radius:3px;white-space:nowrap;line-height:16px}
.calendar-day-allocation:hover{background:var(--ui-accent-soft)}
.calendar-day-notes{flex:1;min-height:0;gap:2px;overflow:hidden}
.calendar-day .calendar-note-off{display:none;height:20px}
.calendar-day .calendar-note-off .calendar-note-title{padding:1px 4px;font-size:12px;line-height:18px}
.calendar-grid :deep(.calendar-work-scroll){flex:none;min-height:0;overflow:hidden;padding:1px 2px}
.calendar-grid :deep(.calendar-work-capsule){width:100%;min-width:0;height:20px;min-height:20px}
.calendar-grid :deep(.calendar-work-segment){min-width:0}
.calendar-grid :deep(.calendar-note-main){flex-direction:row;align-items:center;min-width:0;overflow:hidden;padding:0}
.calendar-grid :deep(.calendar-note-main .calendar-note-title){display:flex;flex:1;height:20px;min-height:0;padding:0 2px;font-size:11px;line-height:20px}
.calendar-grid :deep(.calendar-work-value){width:auto;max-width:100%;height:20px;min-height:0;padding:0 2px;line-height:20px;overflow:hidden}
.calendar-grid :deep(.calendar-work-value strong){display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:10px;line-height:20px}
.calendar-grid :deep(.calendar-work-divider){top:0;bottom:0;width:8px;right:-4px}
.calendar-grid :deep(.calendar-work-divider:before){left:3px;top:4px;bottom:4px}
.calendar-grid :deep(.calendar-work-divider:hover:before),.calendar-grid :deep(.calendar-work-divider:focus-visible:before),.calendar-grid :deep(.calendar-work-divider-active:before){left:2px}
.calendar-summary-tags{flex:1;overflow:hidden}
.calendar-summary-more{flex:none;min-height:24px;padding:3px 6px;border-radius:4px;font-size:11px;color:var(--ui-accent);white-space:nowrap}
.calendar-summary-more:hover{background:var(--ui-accent-soft)}
.calendar-summary-list{display:flex;flex-direction:column;gap:7px;min-width:0}
.calendar-summary-list .calendar-summary-tag{max-width:none;flex-wrap:wrap;white-space:normal;padding:7px 9px}
.calendar-summary-list .calendar-summary-name{flex:1 1 100px;max-width:none;white-space:normal;overflow-wrap:anywhere}
@container calendar-cell (min-height:40px){
 .calendar-day:not(.calendar-has-work) .calendar-note-off:first-of-type{display:flex}
}
@container calendar-cell (min-height:60px){
 .calendar-day-heading{height:18px;min-height:18px}
 .calendar-day-number{height:18px;width:20px}
 .calendar-day-allocation{height:18px;min-height:18px;line-height:18px}
 .calendar-day-notes{gap:3px}
}
@container calendar-cell (min-height:58px){
 .calendar-grid :deep(.calendar-work-capsule){height:36px;min-height:36px}
 .calendar-grid :deep(.calendar-note-main){flex-direction:column;align-items:stretch}
 .calendar-grid :deep(.calendar-note-main .calendar-note-title){flex:none;min-height:15px;height:15px;padding:0 3px;font-size:11px;line-height:15px}
 .calendar-grid :deep(.calendar-work-value){width:100%;height:19px;line-height:19px}
 .calendar-grid :deep(.calendar-work-value strong){line-height:19px}
}
@container calendar-cell (min-height:62px){
 .calendar-day:not(.calendar-has-work) .calendar-note-off{display:flex}
}
@container calendar-cell (min-height:86px){
 .calendar-day.calendar-has-work .calendar-note-off:nth-of-type(2){display:flex}
}
@container calendar-cell (min-height:110px){
 .calendar-day-heading{height:24px;min-height:24px}
 .calendar-day-number{height:24px;width:24px;font-size:13px}
 .calendar-lunar{font-size:10px}
 .calendar-grid :deep(.calendar-work-capsule){height:43px;min-height:43px}
 .calendar-grid :deep(.calendar-note-main .calendar-note-title){height:21px;min-height:21px;font-size:12px;line-height:21px}
 .calendar-grid :deep(.calendar-work-value){height:22px;line-height:22px}
 .calendar-grid :deep(.calendar-work-value strong){font-size:11px;line-height:22px}
}
@container calendar-cell (min-height:124px){
 .calendar-day.calendar-has-work .calendar-note-off{display:flex}
}
</style>
