<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { OfficeBridge } from '../office/bridge'
import { PresentationSession } from '../presentation/session'
import type { ChartSourceProof } from '../presentation/pptx-package'
import { base64ToBytes, bytesToBase64, defaultSaveExtension } from '../shared/document'
import type { PresentationState, PresentationAction } from '../presentation/types'
import type { WriterState, WriterAction, WriterCommand, WriterQuery } from '../word/types'
import type { CalcState, CalcAction, CalcDataQuery } from '../sheet/types'
import type { patchPptxPackage } from '../presentation/pptx-package'
import type { OfficeDocument, OfficeEvent, OfficeExportRequest, OfficeExportResult, OfficeNativeRequest } from '../office/types'

const props = defineProps<{ document: OfficeDocument; smokeMode?: boolean }>()
const emit = defineEmits<{
  dirty: [value: boolean]; ready: []; error: [message: string]; status: [message: string]; request: [request: OfficeNativeRequest]; 'presentation-state': [state: PresentationState]; 'presentation-features': [slide: ReturnType<PresentationSession['slide']>]; 'word-state': [state: WriterState]; 'sheet-state': [state: CalcState]
}>()
const frame = ref<HTMLIFrameElement>()
const loading = ref(true), problem = ref(''), status = ref('正在准备完整办公编辑器'), progress = ref(0)
const dirty = ref(false), confirmRetry = ref(false)
let bridge: OfficeBridge | null = null, generation = 0, disposed = false
// The tab owns the import bytes. Retaining another full document here would
// keep obsolete base64 alive after the tab has captured a newer snapshot.
let loaded: Pick<OfficeDocument, 'id' | 'kind' | 'extension'> | null = null, savedExport: { id: string; revision: number; featureRevision: number } | null = null
let opening: Promise<void> = Promise.resolve()
let presentation = new PresentationSession(), presentationState: PresentationState | null = null
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let refreshRunning = false, refreshQueued = false
function emitFeatures() { emit('presentation-features', presentationState ? presentation.slide(presentationState.currentPage.id) : null) }
function scheduleWorkbenchRefresh() {
  clearTimeout(refreshTimer)
  if (loaded && !disposed) refreshTimer = setTimeout(() => { void refreshWorkbench() }, 400)
}
async function refreshWorkbench() {
  if (!loaded || disposed) return
  if (refreshRunning) { refreshQueued = true; return }
  refreshRunning = true
  const id = loaded.id, token = generation
  try {
    await (loaded.kind === 'presentation' ? getPresentationState() : loaded.kind === 'word' ? getWriterState() : getCalcState())
  } catch (error) {
    if (!disposed && generation === token && loaded?.id === id) emit('status', error instanceof Error ? error.message : String(error))
  } finally {
    refreshRunning = false
    if (refreshQueued) { refreshQueued = false; scheduleWorkbenchRefresh() }
  }
}
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  problem.value = message; emit('error', message)
}
function eventReceived(event: OfficeEvent) {
  if (disposed) return
  if (event.documentId && event.documentId !== loaded?.id) return
  if (event.event === 'progress') {
    status.value = event.data.text; progress.value = Math.max(progress.value, event.data.percent || 0)
    emit('status', status.value)
  } else if (event.event === 'dirty') {
    dirty.value = !!event.data.dirty || presentation.dirty; emit('dirty', dirty.value); scheduleWorkbenchRefresh()
  } else if (event.event === 'presentation-changed' || event.event === 'workbench-changed') scheduleWorkbenchRefresh()
  else if (event.event === 'native-request') emit('request', event.data)
  else if (event.event === 'error') reportError(event.error)
}
function startBridge() {
  if (!frame.value) return
  bridge?.dispose(); bridge = new OfficeBridge(frame.value, eventReceived, { smokeMode: props.smokeMode || import.meta.env.DEV })
  frame.value.src = bridge.hostUrl
}
async function loadDocument(document: OfficeDocument, options: { discard?: boolean } = {}) {
  if (disposed) return
  const token = ++generation
  if (!bridge) throw Error('办公编辑器尚未准备好。')
  if (loaded?.id === document.id) {
    problem.value = ''; loading.value = false; emit('dirty', dirty.value); emit('ready'); return
  }
  if (dirty.value && !options.discard) throw Error('请先保存或放弃当前文档修改，再打开其他文档。')
  loading.value = true; problem.value = ''; status.value = '正在打开文档'; emit('status', status.value)
  const client = bridge
  try {
    await client.request('open', { ...document, discard: options.discard === true })
    if (disposed || token !== generation || bridge !== client) return
    loaded = { id: document.id, kind: document.kind, extension: document.extension }; savedExport = null
    const source = presentation = new PresentationSession(); presentationState = null
    if (document.kind === 'presentation') {
      const state = await client.request<PresentationState>('presentation-state', {}, document.id)
      if (disposed || token !== generation || bridge !== client) return
      await source.open(document.extension === 'pptx' && document.base64 ? base64ToBytes(document.base64) : null, state)
      if (disposed || token !== generation || bridge !== client || presentation !== source) return
      presentationState = state; emit('presentation-state', state); emitFeatures()
    } else {
      await (document.kind === 'word' ? getWriterState() : getCalcState())
      if (disposed || token !== generation || bridge !== client) return
    }
    dirty.value = false; loading.value = false; progress.value = 100
    status.value = '完整编辑器已就绪 · 文件仅在本机处理'
    emit('dirty', false); emit('status', status.value); emit('ready')
  } catch (error) { if (!disposed && token === generation) { loading.value = false; reportError(error) } throw error }
}
function queueLoad(document: OfficeDocument) {
  opening = opening.catch(() => {}).then(() => loadDocument(document))
  void opening.catch(() => {})
}
async function exportFile(options: OfficeExportRequest = {}): Promise<OfficeExportResult> {
  await opening
  if (!bridge || !loaded || loading.value) throw Error('请等待文档打开后再保存。')
  if (loaded.id !== props.document.id || problem.value) throw Error('当前标签未成功打开，已阻止导出其他文档。请重新打开此文档。')
  const id = loaded.id, client = bridge, source = presentation
  const state = loaded.kind === 'presentation' ? await getPresentationState() : null
  const featureRevision = source.revision
  const format = options.format || defaultSaveExtension(loaded.extension)
  if (state && format === 'odp' && source.requiresPptx(state)) throw Error('此文稿包含或修改过转场、动画或媒体，请先保存为 PPTX。若已移除所有效果，请重新打开保存后的 PPTX，再导出 ODP。')
  const result = await client.request<OfficeExportResult>('export', { ...options, format }, id)
  if (disposed || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('导出期间文档已切换，旧结果已丢弃。')
  if (state && result.revision !== state.revision) throw Error('导出期间幻灯片发生变化，请重新保存。')
  if (state && result.extension === 'pptx') result.base64 = bytesToBase64(await source.merge(base64ToBytes(result.base64), state,
    (result as OfficeExportResult & { chartProof?: ChartSourceProof[] }).chartProof || []))
  result.dirty ||= source.dirty
  if (featureRevision !== source.revision) throw Error('导出期间演示效果发生变化，请重新保存。')
  if (disposed || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('导出期间文档已切换，旧结果已丢弃。')
  if (result.extension !== 'pdf') savedExport = { id, revision: result.revision, featureRevision }
  return result
}
async function markSaved() {
  if (!bridge || !loaded || !savedExport || savedExport.id !== loaded.id || loaded.id !== props.document.id) return
  const id = loaded.id, client = bridge, token = generation, source = presentation, exported = savedExport
  const result = await client.request<{ dirty: boolean }>('mark-saved', { revision: exported.revision }, id)
  if (disposed || generation !== token || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) return
  source.markSaved(exported.featureRevision)
  dirty.value = result.dirty || source.dirty; emit('dirty', dirty.value)
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (!bridge || !loaded) return
  if (loaded.id !== props.document.id) throw Error('当前标签未成功打开，不能放弃其他文档的修改。')
  const id = loaded.id, client = bridge, token = generation, source = presentation, exported = savedExport, featureRevision = source.revision
  if (!options.force && (!exported || exported.id !== id)) throw Error('请先导出当前内容，再切换文档；放弃修改需要明确确认。')
  if (!options.force && exported?.featureRevision !== featureRevision) throw Error('演示效果已改变，请重新导出后再切换。')
  await client.request('discard', { revision: exported?.revision, force: options.force === true }, id)
  if (disposed || generation !== token || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('文档已切换，旧的放弃操作已取消。')
  if (source.revision !== featureRevision) throw Error('演示效果已改变，已保留新修改。请重新导出后再切换。')
  source.discard(); dirty.value = false; emit('dirty', false)
}
async function command(action: string, data = {}) {
  const id = props.document.id, token = generation
  await opening
  if (disposed || generation !== token || props.document.id !== id) throw Error('文档已切换，旧的编辑操作已取消。')
  if (!bridge || !loaded || loading.value) return
  if (loaded.id !== id || problem.value) throw Error('当前标签未成功打开，已阻止操作其他文档。')
  const client = bridge
  const current = () => !disposed && generation === token && bridge === client && loaded?.id === id && props.document.id === id
  try {
    const result = await client.request(action, data, id)
    if (!current()) throw Error('文档已切换，旧的编辑响应已丢弃。')
    return result
  } catch (error) { if (current()) emit('error', error instanceof Error ? error.message : String(error)); throw error }
}
const undo = () => command('undo'), redo = () => command('redo')
const search = (query = '') => command('search', { query })
const insertImage = (image: { name: string; base64: string }) => command('insert-image', image)
const presentationObjectData = (query:{type:'table'|'chart';id:string}) => command('presentation-object-data', query)
const newSlide = () => presentationAction({ type: 'add-page' })
async function toolRequest<T>(kind: 'word' | 'sheet', operation: 'state' | 'action' | 'data' | 'command', data: unknown = {}): Promise<T> {
  if (!bridge || !loaded || loaded.kind !== kind || loaded.id !== props.document.id) throw Error('请先打开对应的文档。')
  if (operation !== 'state' && (loading.value || problem.value)) throw Error('请等待文档成功打开后再操作。')
  const id = loaded.id, client = bridge, token = generation
  const result = await client.request<T>(`${kind}-${operation}`, data, id)
  if (disposed || generation !== token || bridge !== client || loaded?.id !== id || props.document.id !== id) throw Error('文档已切换，旧的工作台响应已丢弃。')
  const state = result as {documentId?:string;revision?:number;dirty?:boolean} | null
  if (!state || state.documentId !== id || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || (operation !== 'data' && typeof state.dirty !== 'boolean')) throw Error('工作台返回的文档版本无效，已忽略响应。')
  return result
}
async function getWriterState() {
  const state = await toolRequest<WriterState>('word', 'state')
  emit('word-state', state); return state
}
async function getCalcState() {
  const state = await toolRequest<CalcState>('sheet', 'state')
  emit('sheet-state', state); return state
}
async function writerAction(action: WriterAction) {
  const id = props.document.id, token = generation
  await opening
  if (props.document.id !== id || generation !== token) throw Error('文档已切换，旧的编辑操作已取消。')
  const state = await toolRequest<WriterState>('word', 'action', action)
  emit('word-state', state); return state
}
async function writerCommand(input: WriterCommand) {
  const id = props.document.id, token = generation
  await opening
  if (props.document.id !== id || generation !== token) throw Error('文档已切换，旧的即时命令已取消。')
  const state = await toolRequest<WriterState>('word', 'command', input)
  emit('word-state', state); return state
}
async function calcAction(action: CalcAction) {
  const id = props.document.id, token = generation
  await opening
  if (props.document.id !== id || generation !== token) throw Error('文档已切换，旧的编辑操作已取消。')
  const state = await toolRequest<CalcState>('sheet', 'action', action)
  emit('sheet-state', state); return state
}
const writerData = (query: WriterQuery) => toolRequest<unknown>('word', 'data', query)
const calcData = (query: CalcDataQuery) => toolRequest<unknown>('sheet', 'data', query)
async function getPresentationState(): Promise<PresentationState> {
  if (!bridge || !loaded || loaded.kind !== 'presentation') throw Error('请先打开演示文稿。')
  const id = loaded.id, client = bridge, token = generation
  const state = await client.request<PresentationState>('presentation-state', {}, id)
  if (disposed || generation !== token || loaded?.id !== id || bridge !== client || props.document.id !== id) throw Error('文档已切换，旧的幻灯片状态已丢弃。')
  presentationState = state; emit('presentation-state', state); emitFeatures()
  return state
}
async function presentationAction(action: PresentationAction) {
  const id = props.document.id, token = generation, source = presentation
  const before = await getPresentationState()
  if (disposed || generation !== token || props.document.id !== id || presentation !== source) throw Error('文档已切换，旧的幻灯片操作已取消。')
  const origin = before.pages.find(page => page.index === ('pageIndex' in action ? action.pageIndex : before.currentPageIndex))
  const result = await command('presentation-action', action) as PresentationState | undefined
  if (!result) throw Error('演示文稿未准备好。')
  if (disposed || generation !== token || props.document.id !== id || presentation !== source) throw Error('文档已切换，旧的幻灯片响应已丢弃。')
  if (action.type === 'duplicate-page' && origin) {
    const added = result.pages.find(page => !before.pages.some(old => old.id === page.id))
    if (added) source.duplicate(origin.id, added.id)
  }
  presentationState = result; emit('presentation-state', result); emitFeatures()
  return result
}
async function presentationEdit(patch: Omit<Parameters<typeof patchPptxPackage>[1]['slides'][number], 'slideIndex'>) {
  const id = props.document.id, token = generation
  if (loaded?.extension !== 'pptx') throw Error('请先导出并打开 PPTX 文件，再编辑转场和媒体。')
  const before = await getPresentationState(), source = presentation
  const exported = await exportFile({format: 'pptx'})
  const state = await getPresentationState()
  if (generation !== token || presentation !== source || state.documentId !== before.documentId || state.currentPage.id !== before.currentPage.id || state.revision !== exported.revision) throw Error('更新效果期间幻灯片发生变化，请在目标页面重试。')
  await source.edit(base64ToBytes(exported.base64), state, state.currentPage.id, patch)
  if (disposed || generation !== token || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('文档已切换，旧的演示效果响应已丢弃。')
  dirty.value = true; savedExport = null; emit('dirty', true); emitFeatures()
}
async function smokeTest() {
  if (!props.smokeMode && !import.meta.env.DEV) throw Error('引擎自测仅在开发或原生测试模式可用。')
  return command('smoke-test')
}
function retry(force = false) {
  if (dirty.value && !force) { confirmRetry.value = true; return }
  confirmRetry.value = false; generation++; releaseDocumentState()
  dirty.value = false; emit('dirty', false); loading.value = true; problem.value = ''; progress.value = 0
  startBridge(); queueLoad(props.document)
}
function releaseDocumentState() {
  clearTimeout(refreshTimer); refreshTimer = undefined; refreshQueued = false
  loaded = null; savedExport = null; presentationState = null
  presentation = new PresentationSession()
  emitFeatures()
}
onMounted(() => { startBridge(); queueLoad(props.document) })
watch(() => props.document.id, () => queueLoad(props.document))
onBeforeUnmount(() => {
  disposed = true; generation++; releaseDocumentState()
  bridge?.dispose(); bridge = null; opening = Promise.resolve()
})
defineExpose({ exportFile, markSaved, discardChanges, loadDocument, undo, redo, search, insertImage, newSlide, presentationObjectData, getPresentationState, presentationAction, presentationEdit, getWriterState, writerAction, writerCommand, writerData, getCalcState, calcAction, calcData, smokeTest, retry, focus: () => command('focus') })
</script>

<template>
  <section class="office-editor" aria-label="Word、Excel 与 PPT 完整编辑器">
    <iframe ref="frame" title="完整办公编辑画布" class="office-frame" :class="{ 'is-loading': loading }" allow="clipboard-read; clipboard-write" />
    <div v-if="loading || problem" class="office-loading" role="status">
      <div class="office-loading-card">
        <span class="office-loading-emblem" :class="props.document.kind">{{ {word:'W',sheet:'X',presentation:'P'}[props.document.kind] }}</span>
        <h2>{{ problem ? '编辑器暂时无法继续' : '正在打开你的办公桌' }}</h2>
        <p>{{ problem || status }}</p>
        <template v-if="!problem"><div class="office-loading-track"><i :style="{ width: `${Math.max(7, progress)}%` }" /></div><small>使用本机完整办公引擎 · 文档不会上传到云端</small></template>
        <template v-else>
          <p v-if="dirty" class="office-retry-warning">当前有尚未保存的修改。重启编辑器会丢弃这些修改，请优先尝试保存。</p>
          <div v-if="confirmRetry" class="office-retry-actions"><button @click="retry(true)">放弃修改并重新打开</button><button @click="confirmRetry = false">保留当前内容</button></div>
          <button v-else @click="retry()">重新加载编辑器</button>
        </template>
      </div>
    </div>
    <p class="office-engine-caption">完整办公内核 · 内置菜单当前为 English · 中文文档与输入受支持</p>
  </section>
</template>

<style scoped>
.office-editor{position:relative;display:flex;flex-direction:column;min-width:0;min-height:240px;height:100%;background:#edf0f4;overflow:hidden}.office-frame{border:0;flex:1;width:100%;min-height:0;display:block;background:#edf0f4}.office-frame.is-loading{visibility:hidden}.office-engine-caption{font:11px/1.5 system-ui,sans-serif;color:#7d8797;margin:0;padding:5px 16px;background:#fafbfc;border-top:1px solid #e7eaf0;flex:none}.office-loading{position:absolute;inset:0;display:grid;place-items:center;padding:24px;background:rgba(245,247,251,.98)}.office-loading-card{width:min(440px,90%);text-align:center;color:#24364e;font-family:system-ui,sans-serif}.office-loading-emblem{display:grid;place-items:center;width:62px;height:70px;border-radius:14px;background:linear-gradient(150deg,#2f6cd9,#3655aa);color:white;font-size:31px;font-weight:750;margin:0 auto 22px;box-shadow:0 12px 24px #2f6cd927}.office-loading h2{font-size:21px;font-weight:650;letter-spacing:.02em;margin:0 0 12px}.office-loading p{font-size:13px;line-height:1.8;color:#6b788c;overflow-wrap:anywhere}.office-loading small{color:#8995a5;font-size:11px}.office-loading-track{height:5px;border-radius:4px;overflow:hidden;background:#e1e7f0;margin:24px 0 15px}.office-loading-track i{height:100%;display:block;background:#4778cd;transition:width .35s}.office-loading button{margin-top:14px;padding:10px 18px;border:1px solid #ccd8e8;border-radius:8px;background:white;color:#315a9e;cursor:pointer}.office-retry-warning{color:#a06328!important}.office-retry-actions{display:flex;justify-content:center;gap:10px}
.office-loading-emblem.presentation{background:linear-gradient(150deg,#c9854b,#b46436);box-shadow:0 12px 24px #b4643627}
.office-loading-emblem.sheet{background:linear-gradient(150deg,#398f76,#2b715f)}
</style>
