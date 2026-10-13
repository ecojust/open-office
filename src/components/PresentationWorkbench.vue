<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { PRESENTATION_LAYOUTS, type PresentationAction, type PresentationState, type PresentationShapeType, type PresentationShape, type PresentationObjectQuery, type PresentationObjectData } from '../presentation/types'
import '../presentation/workbench.css'

const props = withDefaults(defineProps<{ state?: PresentationState | null; busy?: boolean; active?: boolean; readObjectData?: (query: PresentationObjectQuery) => Promise<unknown> }>(), { busy: false, active: true })
const emit = defineEmits<{
  action: [action: PresentationAction]; refresh: []; 'insert-image': []; preview: [pageIndex: number]; 'draft-change': [pending: boolean]
}>()
const tabs = [{ id: 'home', name: '开始' }, { id: 'insert', name: '插入' }, { id: 'design', name: '设计' }, { id: 'show', name: '放映' }] as const
const tab = ref<(typeof tabs)[number]['id']>('home'), slidesOpen = ref(true), propertiesOpen = ref(false), notesOpen = ref(false)
const propertyTab = ref<'page' | 'object'>('page'), localError = ref(''), deletePageIndex = ref<number | null>(null)
const page = computed(() => props.state?.currentPage)
const selected = computed(() => props.state?.selectedObjectIds.length === 1 ? props.state.objects.find(object => object.id === props.state?.selectedObjectIds[0]) : undefined)
const ready = computed(() => !!props.state && !!page.value)
const objectNames: Record<PresentationShapeType, string> = { text: '文本框', rectangle: '矩形', ellipse: '椭圆', line: '线条', image: '图片', table: '表格', chart: '图表', group: '组合', custom: '自定义形状', unknown: '对象' }
const colors = ['#FFFFFF', '#F3F5F9', '#F4ECE3', '#EAF0F9', '#EDF4ED', '#21324B', '#373344', '#9D5E45']
const arrangements = [
  { value: 'align-left', label: '左对齐' }, { value: 'align-center', label: '水平居中' }, { value: 'align-right', label: '右对齐' },
  { value: 'align-top', label: '顶端对齐' }, { value: 'align-middle', label: '垂直居中' }, { value: 'align-bottom', label: '底端对齐' },
  { value: 'distribute-horizontal', label: '水平均匀分布' }, { value: 'distribute-vertical', label: '垂直均匀分布' },
] as const
const dataOpen = ref(false), dataLoading = ref(false), dataProblem = ref(''), dataDialog = ref<HTMLElement>()
const dataValue = ref<PresentationObjectData>(), chartValue = computed(() => dataValue.value && 'categories' in dataValue.value ? dataValue.value : undefined)
const tableValue = computed(() => dataValue.value && 'cells' in dataValue.value ? dataValue.value : undefined)
let dataRequest = 0, disposed = false, awaitingData = false
let dataOrigin: { documentId: string; revision: number; pageIndex: number; objectId: string } | undefined
type Group = 'name' | 'size' | 'notes' | 'text' | 'geometry' | 'data'
const groups: Record<Group, string[]> = { name: ['name'], size: ['width', 'height'], notes: ['notes'], text: ['text'], geometry: ['x', 'y', 'objectWidth', 'objectHeight', 'rotation'], data: ['data'] }
const drafts = reactive<Record<string, string>>({ name: '', width: '', height: '', notes: '', text: '', x: '', y: '', objectWidth: '', objectHeight: '', rotation: '', data: '' })
const baseline = reactive<Record<string, string>>({ ...drafts })
const scopes = new Map<Group, { documentId: string; revision: number; pageIndex: number; objectId?: string }>()
const dirtyGroup = computed(() => (Object.keys(groups) as Group[]).find(group => groups[group].some(key => drafts[key] !== baseline[key])))
const pending = computed(() => !!dirtyGroup.value)
const locked = computed(() => props.busy || !ready.value || pending.value)
const staleDraft = computed(() => {
  const group = dirtyGroup.value, scope = group && scopes.get(group), state = props.state
  return !!scope && (!state || scope.documentId !== state.documentId || scope.pageIndex !== state.currentPageIndex || scope.revision !== state.revision
    || (scope.objectId !== undefined && scope.objectId !== selected.value?.id))
})
const counter = computed(() => ready.value ? `${props.state!.currentPageIndex + 1} / ${props.state!.pageCount}` : '—')
function valuesFromState(): Record<string, string> {
  const state = props.state, object = selected.value
  const number = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : ''
  return { name: page.value?.name || '', width: number(state?.pageSize.width), height: number(state?.pageSize.height), notes: page.value?.notes || '',
    text: object?.text || '', x: number(object?.x), y: number(object?.y), objectWidth: number(object?.width), objectHeight: number(object?.height), rotation: number(object?.rotation), data: baseline.data || '' }
}
function syncDrafts(force = false) {
  const values = valuesFromState()
  for (const group of Object.keys(groups) as Group[]) {
    const keys = groups[group], isDirty = keys.some(key => drafts[key] !== baseline[key])
    const scope = scopes.get(group)
    const sameTarget = !scope || (scope.documentId === props.state?.documentId && scope.pageIndex === props.state?.currentPageIndex
      && (scope.objectId === undefined || scope.objectId === selected.value?.id))
    if (force || !isDirty || (sameTarget && keys.every(key => drafts[key] === values[key]))) {
      for (const key of keys) drafts[key] = baseline[key] = values[key] || ''
      scopes.delete(group)
    }
  }
}
function edit(group: Group, key: string, event: Event) {
  if (!props.state || (dirtyGroup.value && dirtyGroup.value !== group)) return
  if (!scopes.has(group)) scopes.set(group, { documentId: props.state.documentId, revision: props.state.revision, pageIndex: props.state.currentPageIndex,
    ...(['text', 'geometry', 'data'].includes(group) ? { objectId: selected.value?.id } : {}) })
  drafts[key] = (event.target as HTMLInputElement).value
  localError.value = ''
}
function disabledGroup(group: Group) { return props.busy || !ready.value || !!dirtyGroup.value && dirtyGroup.value !== group }
function send(action: PresentationAction, applying = false) {
  if (!props.state || props.busy || (pending.value && !applying)) return
  if (applying && staleDraft.value) { localError.value = '页面或对象已变化。请还原输入，刷新后重新编辑。'; return }
  localError.value = ''; deletePageIndex.value = null
  emit('action', { ...action, expectedRevision: props.state.revision })
}
function apply(group: Group) {
  if (dirtyGroup.value !== group || !props.state || !page.value) return
  if (group === 'name') {
    const name = drafts.name!.trim()
    if (!name || name.length > 150) { localError.value = '幻灯片名称需要 1–150 个字符。'; return }
    if (props.state.pages.some(item => item.index !== page.value!.index && item.name === name)) { localError.value = '已有同名幻灯片，请换一个名称。'; return }
    drafts.name = name; send({ type: 'rename-page', pageIndex: page.value.index, name }, true)
  } else if (group === 'size') {
    const width = Number(drafts.width), height = Number(drafts.height)
    if (![width, height].every(value => Number.isFinite(value) && value >= 50 && value <= 1000)) { localError.value = '页面宽高需要在 50–1000 毫米之间。'; return }
    drafts.width = String(Math.round(width * 100) / 100); drafts.height = String(Math.round(height * 100) / 100)
    send({ type: 'set-page-size', width: Number(drafts.width), height: Number(drafts.height) }, true)
  } else if (group === 'notes') send({ type: 'set-notes', pageIndex: page.value.index, text: drafts.notes! }, true)
  else if (group === 'text' && selected.value) send({ type: 'update-object', id: selected.value.id, text: drafts.text! }, true)
  else if (group === 'geometry' && selected.value) {
    const [x, y, width, height, rotation] = ['x', 'y', 'objectWidth', 'objectHeight', 'rotation'].map(key => Number(drafts[key]))
    if (groups.geometry.some(key => !drafts[key]?.trim()) || ![x, y, width, height, rotation].every(Number.isFinite)
      || Math.abs(x!) > 5000 || Math.abs(y!) > 5000 || width! < 0 || width! > 5000 || height! < 0 || height! > 5000 || Math.abs(rotation!) > 360) { localError.value = '位置范围 ±5000 毫米，尺寸 0–5000 毫米，角度 ±360°。'; return }
    for (const key of groups.geometry) drafts[key] = String(Math.round(Number(drafts[key]) * 100) / 100)
    send({ type: 'update-object', id: selected.value.id, x: Number(drafts.x), y: Number(drafts.y), width: Number(drafts.objectWidth), height: Number(drafts.objectHeight), rotation: Number(drafts.rotation) }, true)
  }
}
function discardDrafts() {
  const staleData = dirtyGroup.value === 'data' && staleDraft.value
  syncDrafts(true); localError.value = ''; dataProblem.value = ''; awaitingData = false
  if (staleData) {
    dataOpen.value = false; dataRequest++; dataLoading.value = false; dataValue.value = undefined
    drafts.data = baseline.data = ''; scopes.delete('data'); dataOrigin = undefined
  } else if (baseline.data) dataValue.value = JSON.parse(baseline.data)
}
function assertNoPendingEdits() { if (pending.value) throw Error('演示工作台中有尚未应用的输入，请先点击“应用”或“还原”。') }
function layoutName(value: number) { return PRESENTATION_LAYOUTS.find(layout => layout.value === value)?.label || '其他布局' }
function objectLabel(object: PresentationShape, index?: number) {
  return object.name && !object.name.startsWith('OpenOffice_') ? object.name : `${objectNames[object.type]}${index === undefined ? '' : ` ${index + 1}`}`
}
function currentAction(type: 'duplicate-page' | 'set-hidden' | 'move-page', direction?: 'up' | 'down') {
  if (!page.value) return
  if (type === 'set-hidden') send({ type, pageIndex: page.value.index, value: !page.value.hidden })
  else if (type === 'move-page') send({ type, pageIndex: page.value.index, direction: direction! })
  else send({ type, pageIndex: page.value.index })
}
function selectPage(index: number) { send({ type: 'select-page', pageIndex: index }) }
function listKey(event: KeyboardEvent, index: number) {
  const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (!direction || locked.value || !props.state) return
  event.preventDefault()
  const next = Math.max(0, Math.min(props.state.pageCount - 1, index + direction))
  selectPage(next)
  ;(event.currentTarget as HTMLElement).closest('ol')?.querySelector<HTMLButtonElement>(`button[data-page-index="${next}"]`)?.focus()
}
function tabKey(event: KeyboardEvent, index: number) {
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!direction) return
  event.preventDefault(); const next = (index + direction + tabs.length) % tabs.length
  tab.value = tabs[next]!.id
  ;(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}
function colorValue(event: Event) { return (event.target as HTMLInputElement).value.toUpperCase() }
function textStyle(update: Record<string, unknown>) { if (selected.value) send({ type: 'update-object', id: selected.value.id, textStyle: update }) }
function arrangeSelection(event: Event) {
  const input = event.target as HTMLSelectElement, option = arrangements.find(item => item.value === input.value), ids = props.state?.selectedObjectIds || []
  input.value = ''
  if (!option || ids.length < (option.value.startsWith('distribute') ? 3 : 2)) return
  send({ type: 'arrange-objects', ids: [...ids], operation: option.value })
}
function openObjectProperties() { propertyTab.value = 'object'; propertiesOpen.value = true }
function copyData(value: PresentationObjectData) { return JSON.parse(JSON.stringify(value)) as PresentationObjectData }
function dataQuery(value: PresentationObjectData): PresentationObjectQuery { return { type: 'cells' in value ? 'table' : 'chart', id: value.id } }
async function openDataEditor() {
  if (!selected.value || !props.state || locked.value || !props.readObjectData || !['table','chart'].includes(selected.value.type)) return
  const query = { type: selected.value.type as 'table' | 'chart', id: selected.value.id }, documentId = props.state.documentId, revision = props.state.revision, pageIndex = props.state.currentPageIndex
  const token = ++dataRequest
  dataOrigin = { documentId, revision, pageIndex, objectId: query.id }
  dataOpen.value = true; dataLoading.value = true; dataProblem.value = ''; dataValue.value = undefined
  await nextTick(); dataDialog.value?.focus()
  try {
    const response = await props.readObjectData(query) as PresentationObjectData
    if (disposed || token !== dataRequest || !dataOpen.value) return
    if (props.state?.documentId !== documentId || props.state.revision !== revision || props.state.currentPageIndex !== pageIndex || selected.value?.id !== query.id) throw Error('页面或对象已变化，请重新打开数据编辑。')
    if (!response || response.id !== query.id || (query.type === 'table' ? !('cells' in response) || !Array.isArray(response.cells) : !('values' in response) || !Array.isArray(response.values))) throw Error('未能读取此对象的数据。')
    dataValue.value = copyData(response); drafts.data = baseline.data = JSON.stringify(response)
    scopes.delete('data')
  } catch (error) { if (!disposed && token === dataRequest) dataProblem.value = error instanceof Error ? error.message : String(error) }
  finally { if (!disposed && token === dataRequest) dataLoading.value = false }
}
function changedData() {
  if (!props.state || !dataValue.value || props.busy) return
  if (!scopes.has('data') && dataOrigin) scopes.set('data', { ...dataOrigin })
  drafts.data = JSON.stringify(dataValue.value); dataProblem.value = ''
}
function chartValueInput(row: number, column: number, event: Event) {
  if (!chartValue.value) return
  const field = event.target as HTMLInputElement
  chartValue.value.values[row]![column] = field.value === '' ? NaN : Number(field.value)
  changedData()
}
function resizeChart(dimension: 'row' | 'series', remove = false) {
  const chart = chartValue.value
  if (!chart || props.busy) return
  if (dimension === 'row') {
    if (remove && chart.categories.length > 1) { chart.categories.pop(); chart.values.pop() }
    else if (!remove && chart.categories.length < 100) { chart.categories.push(`类别 ${chart.categories.length + 1}`); chart.values.push(chart.series.map(() => 0)) }
  } else if (remove && chart.series.length > 1) { chart.series.pop(); chart.values.forEach(row => row.pop()) }
  else if (!remove && chart.series.length < 20 && chart.type !== 'pie') { chart.series.push(`系列 ${chart.series.length + 1}`); chart.values.forEach(row => row.push(0)) }
  changedData()
}
function applyData() {
  const value = dataValue.value
  if (!value || dirtyGroup.value !== 'data' || props.busy || staleDraft.value) return
  if ('cells' in value) {
    if (value.cells.some(row => row.some(cell => cell.length > 2000))) { dataProblem.value = '每个单元格不能超过 2000 字。'; return }
    awaitingData = true; send({ type: 'update-table', id: value.id, cells: value.cells.map(row => [...row]) }, true)
  } else {
    if ([...value.categories,...value.series].some(name => !name.trim() || name.length > 120)) { dataProblem.value = '类别与系列名称需要 1–120 个字符。'; return }
    if (value.values.some(row => row.some(number => !Number.isFinite(number) || Math.abs(number) > 1e12))) { dataProblem.value = '请填入有效数值，范围为 ±1 万亿。'; return }
    if (value.type === 'pie' && (value.series.length !== 1 || value.values.some(row => row[0]! < 0) || !value.values.some(row => row[0]! > 0))) { dataProblem.value = '饼图需要一个系列，数据非负且至少有一个正数。'; return }
    awaitingData = true; send({ type: 'update-chart', id: value.id, chartType: value.type, categories: [...value.categories], series: [...value.series], values: value.values.map(row => [...row]), title: value.title }, true)
  }
}
async function verifyAppliedData() {
  if (!awaitingData || props.busy || !dataValue.value || !props.readObjectData) return
  awaitingData = false
  const expected = drafts.data, query = dataQuery(dataValue.value), documentId = props.state?.documentId, token = ++dataRequest
  dataLoading.value = true
  try {
    const response = await props.readObjectData(query) as PresentationObjectData
    if (disposed || token !== dataRequest || props.state?.documentId !== documentId || !dataOpen.value) return
    if (JSON.stringify(response) !== expected) throw Error('对象数据尚未与输入一致。请核对错误提示后重试，或还原输入。')
    dataValue.value = copyData(response); drafts.data = baseline.data = JSON.stringify(response); scopes.delete('data'); dataProblem.value = ''
    if (dataOrigin && props.state) dataOrigin.revision = props.state.revision
  } catch (error) { if (!disposed && token === dataRequest) dataProblem.value = error instanceof Error ? error.message : String(error) }
  finally { if (!disposed && token === dataRequest) dataLoading.value = false }
}
function closeDataEditor() {
  if (dirtyGroup.value === 'data') { dataProblem.value = '还有未应用的数据，请先应用或点击“还原”。'; return }
  dataOpen.value = false; dataRequest++; dataLoading.value = false; awaitingData = false; dataOrigin = undefined
  dataValue.value = undefined; drafts.data = baseline.data = ''; scopes.delete('data')
}
function dataKeyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDataEditor() }
  if (event.key === 'Tab') {
    const controls = [...(dataDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])], first = controls[0], last = controls.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dataDialog.value)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
watch(() => props.state, () => {
  syncDrafts(); deletePageIndex.value = null
  if (dataOpen.value && dataOrigin && !pending.value && !awaitingData && (dataOrigin.documentId !== props.state?.documentId
    || dataOrigin.revision !== props.state?.revision || dataOrigin.pageIndex !== props.state?.currentPageIndex || dataOrigin.objectId !== selected.value?.id)) closeDataEditor()
}, { deep: true, immediate: true })
watch(() => [props.busy, props.state?.revision], () => { if (!props.busy && awaitingData) void verifyAppliedData() })
watch(pending, value => emit('draft-change', value), { immediate: true })
onBeforeUnmount(() => { disposed = true; dataRequest++ })
defineExpose({ hasPendingEdits: () => pending.value, assertNoPendingEdits, discardDrafts })
</script>

<template>
  <section class="presentation-workbench" :class="{ 'pw-active': active, 'pw-slides-closed': !slidesOpen, 'pw-properties-open': propertiesOpen, 'pw-notes-open': notesOpen }" :aria-label="active ? '演示文稿工作台' : undefined">
    <header v-if="active" class="pw-ribbon">
      <div class="pw-ribbon-top">
        <div class="pw-brand-mark" aria-hidden="true">P</div>
        <div class="pw-tabs" role="tablist" aria-label="演示工具">
          <button v-for="(item, index) in tabs" :key="item.id" :id="`pw-tab-${item.id}`" role="tab" :aria-selected="tab === item.id" aria-controls="pw-toolbar" :tabindex="tab === item.id ? 0 : -1" @click="tab = item.id" @keydown="tabKey($event,index)">{{ item.name }}</button>
        </div>
        <span class="pw-ribbon-spacer" />
        <slot name="toolbar-extra" />
        <button class="pw-icon-button" :class="{ 'is-active': slidesOpen }" :aria-pressed="slidesOpen" aria-label="显示幻灯片列表" title="幻灯片列表" @click="slidesOpen = !slidesOpen"><Icon name="menu" :size="17" /></button>
        <button class="pw-property-toggle" :class="{ 'is-active': propertiesOpen }" :aria-expanded="propertiesOpen" aria-controls="pw-properties" @click="propertiesOpen = !propertiesOpen"><Icon name="more" :size="17" /><span>属性</span></button>
      </div>
      <div id="pw-toolbar" class="pw-toolbar" role="tabpanel" :aria-labelledby="`pw-tab-${tab}`">
        <template v-if="tab === 'home'">
          <button class="pw-command pw-command-primary" :disabled="locked" @click="send({type:'add-page',layout:page?.layout})"><Icon name="plus" :size="19" />新建幻灯片</button>
          <button class="pw-command" :disabled="locked" @click="currentAction('duplicate-page')"><span class="pw-glyph" aria-hidden="true">▣</span>复制</button>
          <button class="pw-command" :disabled="locked || (state?.pageCount || 0) <= 1" @click="deletePageIndex = page?.index ?? null"><Icon name="close" :size="17" />删除</button>
          <span class="pw-divider" />
          <button class="pw-command" :disabled="locked || state?.currentPageIndex === 0" @click="currentAction('move-page','up')"><span aria-hidden="true">↑</span>上移</button>
          <button class="pw-command" :disabled="locked || state?.currentPageIndex === (state?.pageCount || 0) - 1" @click="currentAction('move-page','down')"><span aria-hidden="true">↓</span>下移</button>
          <button class="pw-command" :disabled="locked" @click="currentAction('set-hidden')">{{ page?.hidden ? '取消隐藏' : '隐藏幻灯片' }}</button>
        </template>
        <template v-else-if="tab === 'insert'">
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-text',text:'双击编辑文字'});openObjectProperties()"><span class="pw-text-glyph" aria-hidden="true">T</span>文本框</button>
          <button class="pw-command" :disabled="locked" @click="emit('insert-image')"><Icon name="image" :size="18" />图片</button>
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-table',rows:3,columns:3});openObjectProperties()"><Icon name="sheet" :size="17" />表格 <small>3 × 3</small></button>
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-chart',chartType:'column',categories:['第一季度','第二季度','第三季度'],series:['销售额'],values:[[36],[52],[68]],title:'季度销售额'});openObjectProperties()"><span class="pw-chart-glyph" aria-hidden="true">▂▅▇</span>图表</button>
          <span class="pw-divider" />
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-shape',shapeType:'rectangle',fillColor:'#DDE7F2',lineColor:'#55738D'})"><span class="pw-shape-glyph" aria-hidden="true" />矩形</button>
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-shape',shapeType:'ellipse',fillColor:'#E8D9CC',lineColor:'#A37655'})"><span class="pw-shape-glyph pw-ellipse" aria-hidden="true" />椭圆</button>
          <button class="pw-command" :disabled="locked" @click="send({type:'insert-shape',shapeType:'line',lineColor:'#3D5068'})"><span class="pw-line-glyph" aria-hidden="true" />线条</button>
        </template>
        <template v-else-if="tab === 'design'">
          <label class="pw-inline-label">页面布局<span class="pw-select-wrap"><select :value="page?.layout" :disabled="locked" @change="send({type:'set-layout',pageIndex:page!.index,layout:Number(($event.target as HTMLSelectElement).value)})"><option v-if="page && !PRESENTATION_LAYOUTS.some(item => item.value === page!.layout)" :value="page.layout">当前布局 · {{ page.layout }}</option><option v-for="layout in PRESENTATION_LAYOUTS" :key="layout.value" :value="layout.value">{{ layout.label }}</option></select></span></label>
          <span class="pw-divider" />
          <button class="pw-command" :disabled="locked" @click="send({type:'set-page-size',width:338.67,height:190.5})">宽屏 <small>16:9</small></button>
          <button class="pw-command" :disabled="locked" @click="send({type:'set-page-size',width:254,height:190.5})">标准 <small>4:3</small></button>
          <button class="pw-command" @click="propertyTab='page';propertiesOpen=true">背景与尺寸 <Icon name="chevron" :size="14" /></button>
        </template>
        <template v-else>
          <button class="pw-command pw-command-primary" :disabled="locked" @click="emit('preview',0)"><Icon name="presentation" :size="19" />从头预览</button>
          <button class="pw-command" :disabled="locked" @click="emit('preview',state!.currentPageIndex)">从当前页预览</button>
          <span class="pw-toolbar-caption">Esc 返回编辑</span><slot name="presentation-settings" />
        </template>
      </div>
    </header>

    <aside v-if="active && slidesOpen" class="pw-slides" aria-label="幻灯片列表">
      <div class="pw-section-heading"><strong>幻灯片 <span>{{ state?.pageCount || '—' }}</span></strong><button class="pw-icon-button" :disabled="locked" aria-label="刷新幻灯片和所选对象" title="刷新" @click="emit('refresh')"><span aria-hidden="true">↻</span></button></div>
      <p v-if="!state" class="pw-empty">正在读取演示文稿…</p>
      <ol v-else class="pw-slide-list">
        <li v-for="slide in state.pages" :key="`${state.documentId}-${slide.id}`" :class="{ 'is-current': slide.index === state.currentPageIndex, 'is-hidden': slide.hidden }">
          <button class="pw-slide-card" :data-page-index="slide.index" :disabled="locked" :aria-current="slide.index === state.currentPageIndex ? 'page' : undefined" :aria-label="`第 ${slide.index + 1} 页，${slide.title || slide.name}${slide.hidden ? '，已隐藏' : ''}`" @click="selectPage(slide.index)" @keydown="listKey($event, slide.index)">
            <span class="pw-slide-number">{{ String(slide.index + 1).padStart(2,'0') }}</span>
            <span class="pw-slide-content"><strong>{{ slide.title || slide.name || '空白幻灯片' }}</strong><small>{{ slide.name || layoutName(slide.layout) }}</small><span class="pw-slide-tag">{{ slide.hidden ? '已隐藏' : layoutName(slide.layout) }}</span></span>
          </button>
        </li>
      </ol>
      <button class="pw-add-bottom" :disabled="locked" @click="send({type:'add-page',layout:page?.layout})"><Icon name="plus" :size="17" />添加幻灯片</button>
    </aside>

    <!-- Keep this node and its slot mounted when active changes. One WASM engine
         is shared by Writer, Calc and Impress; never key this slot by kind. -->
    <div class="pw-canvas"><slot /></div>

    <aside v-show="active && propertiesOpen" id="pw-properties" class="pw-properties" aria-label="演示属性">
      <div class="pw-section-heading"><strong>设计与属性</strong><button class="pw-icon-button" aria-label="收起属性面板" @click="propertiesOpen=false"><Icon name="close" :size="16" /></button></div>
      <div class="pw-property-tabs"><button :class="{'is-active':propertyTab==='page'}" :aria-pressed="propertyTab==='page'" @click="propertyTab='page'">页面</button><button :class="{'is-active':propertyTab==='object'}" :aria-pressed="propertyTab==='object'" @click="propertyTab='object'">对象 <span v-if="state?.selectedObjectIds.length">{{ state.selectedObjectIds.length }}</span></button></div>
      <div v-if="!ready" class="pw-empty">等待文稿就绪</div>
      <div v-show="ready && propertyTab==='page'" class="pw-property-content">
        <form class="pw-field-section" @submit.prevent="apply('name')"><label for="pw-page-name">幻灯片名称</label><input id="pw-page-name" :value="drafts.name" :disabled="disabledGroup('name')" maxlength="150" @input="edit('name','name',$event)" /><div v-if="dirtyGroup==='name'" class="pw-apply-row"><button type="button" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || staleDraft">应用</button></div></form>
        <div class="pw-field-section"><label for="pw-layout">页面布局</label><span class="pw-select-wrap"><select id="pw-layout" :value="page?.layout" :disabled="locked" @change="send({type:'set-layout',pageIndex:page!.index,layout:Number(($event.target as HTMLSelectElement).value)})"><option v-if="page && !PRESENTATION_LAYOUTS.some(item => item.value === page!.layout)" :value="page.layout">当前布局 · {{ page.layout }}</option><option v-for="layout in PRESENTATION_LAYOUTS" :key="layout.value" :value="layout.value">{{ layout.label }}</option></select></span><p class="pw-field-help">调整布局会改变占位符的位置。</p></div>
        <div class="pw-field-section"><span class="pw-field-label">页面背景</span><div class="pw-color-swatches"><button v-for="color in colors" :key="color" :style="{background:color}" :disabled="locked" :aria-label="`背景颜色 ${color}`" :aria-pressed="page?.background.color?.toUpperCase()===color" @click="send({type:'set-background',pageIndex:page!.index,color})"><span v-if="page?.background.color?.toUpperCase()===color" aria-hidden="true">✓</span></button></div><div class="pw-color-row"><label class="pw-color-picker">自定颜色<input type="color" :value="page?.background.color || '#FFFFFF'" :disabled="locked" @change="send({type:'set-background',pageIndex:page!.index,color:colorValue($event)})" /></label><button class="pw-text-button" :disabled="locked" @click="send({type:'set-background',pageIndex:page!.index,color:null})">使用母版背景</button></div><p v-if="page?.background.type==='other'" class="pw-field-help">当前包含渐变或图片背景；选择颜色将替换为纯色。</p></div>
        <form class="pw-field-section" @submit.prevent="apply('size')"><span class="pw-field-label">画布尺寸 <small>毫米</small></span><div class="pw-number-grid"><label>宽度<input type="number" min="50" max="1000" step="0.01" :value="drafts.width" :disabled="disabledGroup('size')" @input="edit('size','width',$event)" /></label><label>高度<input type="number" min="50" max="1000" step="0.01" :value="drafts.height" :disabled="disabledGroup('size')" @input="edit('size','height',$event)" /></label></div><p class="pw-field-help">将应用于整份演示文稿。</p><div v-if="dirtyGroup==='size'" class="pw-apply-row"><button type="button" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || staleDraft">应用尺寸</button></div></form>
        <slot name="effects" />
      </div>
      <div v-show="ready && propertyTab==='object'" class="pw-property-content">
        <div class="pw-field-section"><label for="pw-object-select">当前页对象</label><span class="pw-select-wrap"><select id="pw-object-select" :value="selected?.id || ''" :disabled="locked" @change="send({type:'select-objects',ids:[($event.target as HTMLSelectElement).value]})"><option value="" disabled>选择一个对象</option><option v-for="(object,index) in state?.objects" :key="object.id" :value="object.id">{{ objectLabel(object,index) }}</option></select></span><p v-if="!state?.objects.length" class="pw-field-help">当前页还没有对象，可从“插入”添加。</p><button class="pw-text-button pw-refresh-selection" :disabled="locked" @click="emit('refresh')">刷新画布中的选择 ↻</button></div>
        <div v-if="(state?.selectedObjectIds.length || 0) > 1" class="pw-field-section"><span class="pw-field-label">已选中 {{ state!.selectedObjectIds.length }} 个对象</span><div class="pw-arrange-grid"><button :disabled="locked" @click="send({type:'arrange-objects',ids:state!.selectedObjectIds,operation:'group'})">组合对象</button></div><span class="pw-select-wrap pw-multi-arrange"><select aria-label="多个对象对齐与分布" :disabled="locked" value="" @change="arrangeSelection"><option value="" disabled>对齐与分布…</option><option v-for="item in arrangements" :key="item.value" :value="item.value" :disabled="item.value.startsWith('distribute') && (state?.selectedObjectIds.length || 0) < 3">{{ item.label }}</option></select></span><p class="pw-field-help">选择单个对象，可编辑其文字与尺寸。</p></div>
        <div v-if="!selected && !(state?.selectedObjectIds.length)" class="pw-empty pw-object-empty"><Icon name="plus" :size="25" /><strong>让内容成为主角</strong><p>选中一个文本框、图片或形状，即可调整它的属性。</p></div>
        <template v-if="selected">
          <div class="pw-object-kind">{{ objectNames[selected.type] }}<span>{{ objectLabel(selected) }}</span></div>
          <button v-if="selected.type==='group'" class="pw-text-button" :disabled="locked" @click="send({type:'arrange-objects',ids:[selected!.id],operation:'ungroup'})">取消组合</button>
          <button v-if="['table','chart'].includes(selected.type) && readObjectData" class="pw-edit-data-button" :disabled="locked" @click="openDataEditor"><Icon name="sheet" :size="16" />编辑{{ selected.type==='table' ? '表格' : '图表' }}数据</button>
          <form v-if="selected.capabilities.text" class="pw-field-section" @submit.prevent="apply('text')"><label for="pw-object-text">文字内容</label><textarea id="pw-object-text" rows="4" maxlength="20000" :value="drafts.text" :disabled="disabledGroup('text')" @input="edit('text','text',$event)" /><p class="pw-field-help">应用后使用当前对象的文字样式。</p><div v-if="dirtyGroup==='text'" class="pw-apply-row"><button type="button" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || staleDraft">应用文字</button></div></form>
          <div v-if="selected.capabilities.text" class="pw-field-section"><span class="pw-field-label">文字格式</span><div class="pw-font-controls"><span class="pw-select-wrap"><select aria-label="字体" :disabled="locked" :value="selected.textStyle.fontName" @change="textStyle({fontName:($event.target as HTMLSelectElement).value})"><option v-if="!['Noto Sans CJK SC','Carlito'].includes(selected.textStyle.fontName)" :value="selected.textStyle.fontName">{{ selected.textStyle.fontName || '当前字体' }}</option><option value="Noto Sans CJK SC">思源黑体</option><option value="Carlito">Carlito</option></select></span><span class="pw-select-wrap"><select aria-label="字号（磅）" :disabled="locked" :value="selected.textStyle.fontSize" @change="textStyle({fontSize:Number(($event.target as HTMLSelectElement).value)})"><option v-if="![8,10,12,14,16,18,20,24,28,32,36,44,54,60,72,96].includes(selected.textStyle.fontSize)" :value="selected.textStyle.fontSize">{{ selected.textStyle.fontSize }}</option><option v-for="size in [8,10,12,14,16,18,20,24,28,32,36,44,54,60,72,96]" :key="size" :value="size">{{ size }}</option></select></span></div><div class="pw-format-row"><button :disabled="locked" :aria-pressed="selected.textStyle.bold" aria-label="加粗" @click="textStyle({bold:!selected.textStyle.bold})"><b>B</b></button><button :disabled="locked" :aria-pressed="selected.textStyle.italic" aria-label="斜体" @click="textStyle({italic:!selected.textStyle.italic})"><i>I</i></button><button :disabled="locked" :aria-pressed="selected.textStyle.underline" aria-label="下划线" @click="textStyle({underline:!selected.textStyle.underline})"><u>U</u></button><label class="pw-text-color" aria-label="文字颜色">A<input type="color" :disabled="locked" :value="selected.textStyle.color || '#000000'" aria-label="文字颜色" @change="textStyle({color:colorValue($event)})" /></label></div><label class="pw-sr-only" for="pw-text-align">文字对齐</label><span class="pw-select-wrap"><select id="pw-text-align" :disabled="locked" :value="selected.textStyle.align" @change="textStyle({align:($event.target as HTMLSelectElement).value})"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></span></div>
          <form v-if="selected.capabilities.geometry" class="pw-field-section" @submit.prevent="apply('geometry')"><span class="pw-field-label">位置与尺寸 <small>毫米</small></span><div class="pw-number-grid"><label v-for="field in [{key:'x',label:'横向位置'},{key:'y',label:'纵向位置'},{key:'objectWidth',label:'宽度'},{key:'objectHeight',label:'高度'},{key:'rotation',label:'旋转 / °'}]" :key="field.key">{{ field.label }}<input type="number" step="0.1" :value="drafts[field.key]" :disabled="disabledGroup('geometry')" @input="edit('geometry',field.key,$event)" /></label></div><div v-if="dirtyGroup==='geometry'" class="pw-apply-row"><button type="button" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || staleDraft">应用位置</button></div></form>
          <div v-if="selected.capabilities.fill || selected.capabilities.line" class="pw-field-section"><span class="pw-field-label">形状颜色</span><div class="pw-color-row"><label v-if="selected.capabilities.fill" class="pw-color-picker">填充<input type="color" :value="selected.fillColor || '#FFFFFF'" :disabled="locked" @change="send({type:'update-object',id:selected!.id,fillColor:colorValue($event)})" /></label><label v-if="selected.capabilities.line" class="pw-color-picker">描边<input type="color" :value="selected.lineColor || '#000000'" :disabled="locked" @change="send({type:'update-object',id:selected!.id,lineColor:colorValue($event)})" /></label></div><button v-if="selected.capabilities.fill" class="pw-text-button" :disabled="locked" @click="send({type:'update-object',id:selected!.id,fillColor:null})">无填充</button></div>
          <div class="pw-field-section"><span class="pw-field-label">对象层级</span><div class="pw-arrange-grid"><button v-for="item in [{operation:'front',name:'置于顶层'},{operation:'back',name:'置于底层'},{operation:'forward',name:'上移一层'},{operation:'backward',name:'下移一层'}] as const" :key="item.operation" :disabled="locked" @click="send({type:'arrange-objects',ids:[selected!.id],operation:item.operation})">{{ item.name }}</button></div></div>
        </template>
      </div>
    </aside>

    <footer v-if="active" class="pw-footer">
      <div v-if="deletePageIndex !== null" class="pw-confirm-delete" role="alert"><span>删除第 {{ deletePageIndex + 1 }} 页？</span><button @click="deletePageIndex=null">取消</button><button class="pw-danger" :disabled="locked" @click="send({type:'delete-page',pageIndex:deletePageIndex!})">确认删除</button></div>
      <div v-if="localError || staleDraft" class="pw-inline-error" role="alert">{{ localError || '页面或对象已变化，请还原未应用输入后继续。' }}<button v-if="pending" @click="discardDrafts">还原输入</button></div>
      <div class="pw-footer-bar"><button class="pw-notes-toggle" :aria-expanded="notesOpen" aria-controls="pw-notes" @click="notesOpen=!notesOpen"><Icon name="file" :size="15" />演讲备注<span v-if="dirtyGroup==='notes'" class="pw-unsaved-dot" aria-label="有未应用输入" /><span class="pw-chevron" :class="{'is-open':notesOpen}" aria-hidden="true">⌃</span></button><span v-if="pending" class="pw-pending-hint" role="status">输入尚未应用</span><span class="pw-footer-spacer" /><span class="pw-page-counter">幻灯片 {{ counter }}</span><button class="pw-icon-button" :disabled="locked" aria-label="从当前页预览" title="从当前页预览" @click="emit('preview',state!.currentPageIndex)"><Icon name="presentation" :size="16" /></button></div>
      <form v-if="notesOpen" id="pw-notes" class="pw-notes" @submit.prevent="apply('notes')"><label class="pw-sr-only" for="pw-notes-text">当前幻灯片的演讲备注</label><textarea id="pw-notes-text" :value="drafts.notes" :disabled="disabledGroup('notes')" maxlength="50000" rows="3" placeholder="记录这一页想说的话…" @input="edit('notes','notes',$event)" /><div class="pw-notes-actions"><span>{{ drafts.notes?.length || 0 }} 字</span><template v-if="dirtyGroup==='notes'"><button type="button" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || staleDraft">应用备注</button></template><span v-else class="pw-notes-status">与演示文稿一同保存</span></div></form>
    </footer>
    <div v-if="active && dataOpen" class="pw-data-backdrop">
      <section ref="dataDialog" class="pw-data-dialog" role="dialog" aria-modal="true" aria-labelledby="pw-data-title" tabindex="-1" @keydown="dataKeyboard">
        <header><div><span class="pw-data-eyebrow">CONTENT & DATA</span><h2 id="pw-data-title">{{ chartValue ? '图表数据' : '表格数据' }}</h2></div><button class="pw-icon-button" aria-label="关闭数据编辑" @click="closeDataEditor"><Icon name="close" :size="20" /></button></header>
        <div v-if="dataLoading" class="pw-data-message" role="status">正在读取对象数据…</div>
        <template v-else-if="dataValue">
          <div v-if="chartValue" class="pw-chart-settings"><label>图表标题<input v-model="chartValue.title" maxlength="300" :disabled="busy" @input="changedData" /></label><label>图表类型<span class="pw-select-wrap"><select v-model="chartValue.type" aria-label="图表类型" :disabled="busy" @change="changedData"><option value="column">柱状图</option><option value="bar">条形图</option><option value="line">折线图</option><option value="pie">饼图</option></select></span></label></div>
          <div class="pw-data-grid-wrap"><table class="pw-data-grid" v-if="tableValue"><thead><tr><th scope="col">行</th><th v-for="column in tableValue.columns" :key="column" scope="col">{{ String.fromCharCode(64+column) }}</th></tr></thead><tbody><tr v-for="(row,rowIndex) in tableValue.cells" :key="rowIndex"><th scope="row">{{ rowIndex+1 }}</th><td v-for="(_,columnIndex) in row" :key="columnIndex"><input v-model="tableValue.cells[rowIndex]![columnIndex]" :aria-label="`第 ${rowIndex+1} 行第 ${columnIndex+1} 列`" maxlength="2000" :disabled="busy" @input="changedData" /></td></tr></tbody></table><table v-else-if="chartValue" class="pw-data-grid"><thead><tr><th scope="col">类别</th><th v-for="(_,column) in chartValue.series" :key="column" scope="col"><input v-model="chartValue.series[column]" :aria-label="`系列 ${column+1} 名称`" maxlength="120" :disabled="busy" @input="changedData" /></th></tr></thead><tbody><tr v-for="(_,row) in chartValue.categories" :key="row"><th scope="row"><input v-model="chartValue.categories[row]" :aria-label="`类别 ${row+1} 名称`" maxlength="120" :disabled="busy" @input="changedData" /></th><td v-for="(_,column) in chartValue.series" :key="column"><input type="number" step="any" :value="Number.isFinite(chartValue.values[row]![column]) ? chartValue.values[row]![column] : ''" :aria-label="`类别 ${row+1}，系列 ${column+1} 数值`" :disabled="busy" @input="chartValueInput(row,column,$event)" /></td></tr></tbody></table></div>
          <div v-if="chartValue" class="pw-chart-size-actions"><button :disabled="busy || chartValue.categories.length>=100" @click="resizeChart('row')">＋ 类别</button><button :disabled="busy || chartValue.categories.length<=1" @click="resizeChart('row',true)">－ 类别</button><span /><button :disabled="busy || chartValue.series.length>=20 || chartValue.type==='pie'" @click="resizeChart('series')">＋ 系列</button><button :disabled="busy || chartValue.series.length<=1" @click="resizeChart('series',true)">－ 系列</button></div>
        </template>
        <p v-if="dataProblem || staleDraft" class="pw-data-error" role="alert">{{ dataProblem || '文稿已变化，请还原输入后重新打开数据编辑。' }}</p>
        <footer><p>{{ dirtyGroup==='data' ? '尚有修改未应用到幻灯片' : '直接编辑对象数据，保存后仍可修改' }}</p><button :disabled="busy || dataLoading || dirtyGroup!=='data'" @click="discardDrafts">还原</button><button class="pw-apply" :disabled="busy || dataLoading || dirtyGroup!=='data' || staleDraft" @click="applyData">应用数据</button><button v-if="dirtyGroup!=='data'" :disabled="busy" @click="closeDataEditor">完成</button></footer>
      </section>
    </div>
  </section>
</template>
