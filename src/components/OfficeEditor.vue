<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { OfficeBridge } from '../office/bridge'
import { PresentationSession } from '../presentation/session'
import { base64ToBytes, bytesToBase64 } from '../shared/document'
import type { PresentationState, PresentationAction } from '../presentation/types'
import type { patchPptxPackage } from '../presentation/pptx-package'
import type { OfficeDocument, OfficeEvent, OfficeExportRequest, OfficeExportResult, OfficeNativeRequest } from '../office/types'

const props = defineProps<{ document: OfficeDocument; smokeMode?: boolean }>()
const emit = defineEmits<{
  dirty: [value: boolean]; ready: []; error: [message: string]; status: [message: string]; request: [request: OfficeNativeRequest]; 'presentation-state': [state: PresentationState]; 'presentation-features': [slide: ReturnType<PresentationSession['slide']>]
}>()
const frame = ref<HTMLIFrameElement>()
const loading = ref(true), problem = ref(''), status = ref('正在准备完整办公编辑器'), progress = ref(0)
const dirty = ref(false), confirmRetry = ref(false)
let bridge: OfficeBridge | null = null, generation = 0, disposed = false
let loaded: OfficeDocument | null = null, savedExport: { id: string; revision: number; featureRevision: number } | null = null
let opening: Promise<void> = Promise.resolve()
let presentation = new PresentationSession(), presentationState: PresentationState | null = null
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function emitFeatures() { emit('presentation-features', presentationState ? presentation.slide(presentationState.currentPage.id) : null) }
function schedulePresentationRefresh() {
  clearTimeout(refreshTimer)
  if (loaded?.kind === 'presentation') refreshTimer = setTimeout(() => { void getPresentationState().catch(error => emit('status', error instanceof Error ? error.message : String(error))) }, 400)
}
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  problem.value = message; emit('error', message)
}
function eventReceived(event: OfficeEvent) {
  if (event.documentId && event.documentId !== loaded?.id) return
  if (event.event === 'progress') {
    status.value = event.data.text; progress.value = Math.max(progress.value, event.data.percent || 0)
    emit('status', status.value)
  } else if (event.event === 'dirty') {
    dirty.value = !!event.data.dirty || presentation.dirty; emit('dirty', dirty.value); schedulePresentationRefresh()
  } else if (event.event === 'presentation-changed') schedulePresentationRefresh()
  else if (event.event === 'native-request') emit('request', event.data)
  else if (event.event === 'error') reportError(event.error)
}
function startBridge() {
  if (!frame.value) return
  bridge?.dispose(); bridge = new OfficeBridge(frame.value, eventReceived, { smokeMode: props.smokeMode || import.meta.env.DEV })
  frame.value.src = bridge.hostUrl
}
async function loadDocument(document: OfficeDocument, options: { discard?: boolean } = {}) {
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
    loaded = { ...document }; savedExport = null
    presentation = new PresentationSession(); presentationState = null
    if (document.kind === 'presentation') {
      const state = await client.request<PresentationState>('presentation-state', {}, document.id)
      if (disposed || token !== generation || bridge !== client) return
      await presentation.open(document.extension === 'pptx' && document.base64 ? base64ToBytes(document.base64) : null, state)
      presentationState = state; emit('presentation-state', state); emitFeatures()
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
  const format = options.format || loaded.extension
  if (state && format === 'odp' && source.requiresPptx(state)) throw Error('此文稿包含或修改过转场、动画或媒体，请先保存为 PPTX。若已移除所有效果，请重新打开保存后的 PPTX，再导出 ODP。')
  const result = await client.request<OfficeExportResult>('export', options, id)
  if (disposed || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('导出期间文档已切换，旧结果已丢弃。')
  if (state && result.revision !== state.revision) throw Error('导出期间幻灯片发生变化，请重新保存。')
  if (state && result.extension === 'pptx') result.base64 = bytesToBase64(await source.merge(base64ToBytes(result.base64), state))
  result.dirty ||= source.dirty
  if (featureRevision !== source.revision) throw Error('导出期间演示效果发生变化，请重新保存。')
  if (disposed || bridge !== client || loaded?.id !== id || props.document.id !== id || presentation !== source) throw Error('导出期间文档已切换，旧结果已丢弃。')
  if (result.extension !== 'pdf') savedExport = { id, revision: result.revision, featureRevision }
  return result
}
async function markSaved() {
  if (!bridge || !loaded || !savedExport || savedExport.id !== loaded.id || loaded.id !== props.document.id) return
  const id = loaded.id, client = bridge
  const result = await client.request<{ dirty: boolean }>('mark-saved', { revision: savedExport.revision }, id)
  if (bridge !== client || loaded?.id !== id || props.document.id !== id) return
  presentation.markSaved(savedExport.featureRevision)
  dirty.value = result.dirty || presentation.dirty; emit('dirty', dirty.value)
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (!bridge || !loaded) return
  if (loaded.id !== props.document.id) throw Error('当前标签未成功打开，不能放弃其他文档的修改。')
  const id = loaded.id, client = bridge
  if (!options.force && (!savedExport || savedExport.id !== id)) throw Error('请先导出当前内容，再切换文档；放弃修改需要明确确认。')
  if (!options.force && savedExport?.featureRevision !== presentation.revision) throw Error('演示效果已改变，请重新导出后再切换。')
  await client.request('discard', { revision: savedExport?.revision, force: options.force === true }, id)
  if (bridge !== client || loaded?.id !== id || props.document.id !== id) return
  presentation.discard(); dirty.value = false; emit('dirty', false)
}
async function command(action: string, data = {}) {
  await opening
  if (!bridge || !loaded || loading.value) return
  if (loaded.id !== props.document.id || problem.value) throw Error('当前标签未成功打开，已阻止操作其他文档。')
  try { return await bridge.request(action, data, loaded.id) }
  catch (error) { emit('error', error instanceof Error ? error.message : String(error)); throw error }
}
const undo = () => command('undo'), redo = () => command('redo')
const search = (query = '') => command('search', { query })
const insertImage = (image: { name: string; base64: string }) => command('insert-image', image)
const presentationObjectData = (query:{type:'table'|'chart';id:string}) => command('presentation-object-data', query)
const newSlide = () => presentationAction({ type: 'add-page' })
async function getPresentationState(): Promise<PresentationState> {
  if (!bridge || !loaded || loaded.kind !== 'presentation') throw Error('请先打开演示文稿。')
  const id = loaded.id, client = bridge
  const state = await client.request<PresentationState>('presentation-state', {}, id)
  if (disposed || loaded?.id !== id || bridge !== client || props.document.id !== id) throw Error('文档已切换，旧的幻灯片状态已丢弃。')
  presentationState = state; emit('presentation-state', state); emitFeatures()
  return state
}
async function presentationAction(action: PresentationAction) {
  const before = await getPresentationState()
  const origin = before.pages.find(page => page.index === ('pageIndex' in action ? action.pageIndex : before.currentPageIndex))
  const result = await command('presentation-action', action) as PresentationState | undefined
  if (!result) throw Error('演示文稿未准备好。')
  if (action.type === 'duplicate-page' && origin) {
    const added = result.pages.find(page => !before.pages.some(old => old.id === page.id))
    if (added) presentation.duplicate(origin.id, added.id)
  }
  presentationState = result; emit('presentation-state', result); emitFeatures()
  return result
}
async function presentationEdit(patch: Omit<Parameters<typeof patchPptxPackage>[1]['slides'][number], 'slideIndex'>) {
  if (loaded?.extension !== 'pptx') throw Error('请先导出并打开 PPTX 文件，再编辑转场和媒体。')
  const before = await getPresentationState(), source = presentation
  const exported = await exportFile({format: 'pptx'})
  const state = await getPresentationState()
  if (presentation !== source || state.documentId !== before.documentId || state.currentPage.id !== before.currentPage.id || state.revision !== exported.revision) throw Error('更新效果期间幻灯片发生变化，请在目标页面重试。')
  await source.edit(base64ToBytes(exported.base64), state, state.currentPage.id, patch)
  dirty.value = true; savedExport = null; emit('dirty', true); emitFeatures()
}
async function smokeTest() {
  if (!props.smokeMode && !import.meta.env.DEV) throw Error('引擎自测仅在开发或原生测试模式可用。')
  return command('smoke-test')
}
function retry(force = false) {
  if (dirty.value && !force) { confirmRetry.value = true; return }
  confirmRetry.value = false; generation++; loaded = null; savedExport = null
  dirty.value = false; emit('dirty', false); loading.value = true; problem.value = ''; progress.value = 0
  startBridge(); queueLoad(props.document)
}
onMounted(() => { startBridge(); queueLoad(props.document) })
watch(() => props.document.id, () => queueLoad(props.document))
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(refreshTimer); bridge?.dispose(); if (frame.value) frame.value.src = 'about:blank' })
defineExpose({ exportFile, markSaved, discardChanges, loadDocument, undo, redo, search, insertImage, newSlide, presentationObjectData, getPresentationState, presentationAction, presentationEdit, smokeTest, retry, focus: () => command('focus') })
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
