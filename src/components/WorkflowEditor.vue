<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Icon from './Icon.vue'
import SceneEditor from '../workflow/components/SceneEditor.vue'
import CodeDiagramEditor from '../workflow/components/CodeDiagramEditor.vue'
import { WorkflowSession } from '../workflow/session'
import { createDocument } from '../workflow/core/documents'
import { documentScene, exportDocument, importText, type ExportFormat } from '../workflow/core/files'
import { sceneToSvg } from '../workflow/core/svg'
import { clone, type Scene, type WorkflowDocument } from '../workflow/core/types'
import type { DiagramStyleId } from '../workflow/core/diagram-appearance'
import type { NativeDocument } from '../types'
import { base64ToBytes, bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { printHtml, type PrintOutcome } from '../shared/printing'

const props = withDefaults(defineProps<{ document: NativeDocument; active?: boolean; disabled?: boolean; theme?: 'light' | 'dark' }>(), { active: true, disabled: false, theme: 'light' })
const emit = defineEmits<{
 ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string];
 'file-action': [action: 'new' | 'open' | 'save' | 'saveAs' | 'print' | 'close'];
 'create-canvas': [document: WorkflowDocument]; export: [output: EditorExport];
}>()
const sceneEditor = ref<InstanceType<typeof SceneEditor>>(), codeEditor = ref<InstanceType<typeof CodeDiagramEditor>>()
const model = shallowRef<WorkflowDocument>(), loading = ref(true), problem = ref(''), pending = ref(false)
const canUndo = ref(false), canRedo = ref(false)
const interactive = computed(() => props.active && !props.disabled && !loading.value)
const diagram = computed(() => model.value?.kind === 'mermaid')
let session: WorkflowSession | undefined, disposed = false, token = 0
let lastExport: { token: number; base64: string } | undefined

function report(cause: unknown) {
 if (disposed) return
 problem.value = cause instanceof Error ? cause.message : String(cause)
 emit('error', problem.value)
}
function accept() {
 if (!session) return
 model.value = session.model
 const state = session.inspect()
 canUndo.value = state.canUndo; canRedo.value = state.canRedo
 emit('dirty', state.dirty || pending.value)
}
function setPending(value: boolean) { pending.value = value; accept() }
function change(edit: (document: WorkflowDocument) => void): boolean {
 if (!session || disposed) return false
 try { session.change(edit); problem.value = ''; accept(); return true } catch (cause) { report(cause); return false }
}
function changeScene(scene: Scene, label: string) {
 if (change(document => { document.scene = scene })) emit('status', label)
}
function changeSource(source: string) { change(document => { document.source = source }) }
function changeStyle(style: DiagramStyleId) { change(document => { document.diagramStyle = style }) }
function child() { return diagram.value ? codeEditor.value : sceneEditor.value }
function requireLoaded() {
 if (!session || loading.value || disposed) throw Error('请等待文档打开。')
 return session
}
async function flush() {
 requireLoaded()
 if (child()?.flush() === false) throw Error('请先完成输入法文字或当前画布操作，再保存或切换文档。')
 await nextTick()
 if (child()?.hasPendingEdits()) throw Error('请先完成当前编辑或关闭操作面板，再保存或切换文档。')
 pending.value = false; accept()
}
async function inspect() {
 const current = requireLoaded()
 return { ...current.inspect(), dirty: current.inspect().dirty || pending.value }
}
async function prepareDeactivate() { await flush(); return inspect() }
async function canBackgroundExport() {
 return !!session && !disposed && !loading.value && !pending.value && !child()?.hasPendingEdits()
}
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
 const current = requireLoaded()
 if (options.background) {
  if (!await canBackgroundExport()) throw Error('当前编辑尚未完成，请稍后自动保存。')
 } else await flush()
 const format = options.format ?? 'owflow'
 const name = props.document.name.replace(/\.[^.]+$/, '')
 if (format === 'owflow') {
  const output = current.export(), base64 = bytesToBase64(output.bytes)
  lastExport = { token, base64 }
  return { base64, extension: 'owflow', name: `${name}.owflow`, dirty: output.snapshot.dirty, revision: `${output.snapshot.documentId}:${output.snapshot.revision}` }
 }
 const formats = diagram.value ? ['svg', 'png', 'mmd'] : ['svg', 'png', 'drawio', 'excalidraw']
 if (!formats.includes(format)) throw Error('当前文档不支持导出为此格式。')
 const document = clone(current.model), snapshot = current.inspect()
 document.title = name.slice(0, 200)
 const output = await exportDocument(document, format as ExportFormat)
 return { base64: bytesToBase64(output.bytes), extension: format, name: output.name, saveAs: true, dirty: snapshot.dirty, revision: `${snapshot.documentId}:${snapshot.revision}` }
}
async function markSaved(base64?: string, _options: { background?: boolean } = {}) {
 const current = requireLoaded()
 if (!base64 || !lastExport || lastExport.token !== token || base64 !== lastExport.base64) throw Error('保存回执与当前文档不匹配，请重新保存。')
 current.markSaved(base64ToBytes(base64)); accept()
}
async function discardChanges(options: { force?: boolean } = {}) {
 if (options.force) { token++; lastExport = undefined; return }
 if ((await prepareDeactivate()).dirty) throw Error('文档还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function undo() { await flush(); if (requireLoaded().undo()) { accept(); await nextTick() } }
async function redo() { await flush(); if (requireLoaded().redo()) { accept(); await nextTick() } }
function keydown(event: KeyboardEvent) {
 if (!interactive.value || event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return
 if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
  event.preventDefault(); event.stopPropagation()
  void (event.shiftKey || event.key.toLowerCase() === 'y' ? redo() : undo()).catch(report)
 }
}
function createCanvas(scene: Scene) {
 if (!interactive.value) return
 const document = createDocument('board')
 document.title = `${model.value?.title ?? '代码图表'} · 画布`.slice(0, 200)
 document.scene = clone(scene)
 emit('create-canvas', document)
}
async function exportImage(format: 'svg' | 'png', selection?: Scene) {
 try {
  if (!interactive.value) return
  await flush()
  if (!selection) { emit('export', await exportFile({ format })); return }
  const document = clone(requireLoaded().model), snapshot = requireLoaded().inspect()
  document.kind = 'board'; document.scene = clone(selection)
  document.title = `${document.title} · 所选内容`.slice(0, 200)
  const output = await exportDocument(document, format)
  emit('export', { base64: bytesToBase64(output.bytes), extension: format, name: output.name, saveAs: true, dirty: snapshot.dirty, revision: `${snapshot.documentId}:${snapshot.revision}` })
 } catch (cause) { report(cause) }
}
async function print(): Promise<PrintOutcome> {
 await flush()
 const owner = token, current = clone(requireLoaded().model), svg = sceneToSvg(documentScene(current), { background: true })
 return await printHtml({
  title: current.title,
  css: '@media print{@page{size:landscape;margin:12mm}}#office-print-root{padding:0}#office-print-root svg{display:block;width:100%;height:auto;max-height:180mm}#office-print-root,#office-print-root *{print-color-adjust:exact;-webkit-print-color-adjust:exact}',
  render(output, container) {
   const art = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
   container.append(output.importNode(art, true))
  },
  prepare() {
   if (disposed || owner !== token) throw Error('文档已切换，请重新打印。')
  },
 })
}
async function inspectModel() { return clone(requireLoaded().model) }
function focus() { if (diagram.value) codeEditor.value?.focus() }

watch(() => props.document.id, async () => {
 const owner = ++token; loading.value = true; problem.value = ''; pending.value = false
 try {
  let document: WorkflowDocument
  if (props.document.base64) {
   const text = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(props.document.base64))
   const imported = importText(props.document.name, text)
   if (imported.documents.length !== 1) throw Error('请分别打开图形文件中的各个页面。')
   document = imported.documents[0]
   if (imported.warnings.length) emit('status', imported.warnings.join('；'))
  } else {
   document = createDocument(props.document.kind === 'diagram' ? 'mermaid' : 'board')
   document.title = props.document.name.replace(/\.[^.]+$/, '').slice(0, 200)
  }
  if ((document.kind === 'mermaid') !== (props.document.kind === 'diagram')) throw Error('文档内容与编辑器类型不匹配。')
  if (disposed || owner !== token) return
  session = new WorkflowSession(document); lastExport = undefined; accept()
  loading.value = false
  await nextTick(); emit('ready')
 } catch (cause) { report(cause) } finally { if (owner === token) loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; token++ })
defineExpose({ prepareDeactivate, exportFile, markSaved, discardChanges, inspect, inspectModel, syncRevision: inspect, canBackgroundExport, undo, redo, print, focus })
</script>

<template>
 <section class="workflow-editor" data-testid="workflow-editor" :data-kind="document.kind" :data-document-id="document.id" @keydown="keydown">
  <div v-if="loading" class="workflow-loading" role="status">正在打开文档…</div>
  <div v-if="problem" class="workflow-problem" role="alert"><span>{{ problem }}</span><button aria-label="关闭提示" @click="problem = ''"><Icon name="close" :size="16" /></button></div>
  <template v-if="model && !loading">
   <div class="workflow-history" aria-label="编辑历史">
    <button aria-label="撤销" title="撤销 (Ctrl/⌘ Z)" :disabled="!interactive || !canUndo && !pending" @mousedown.prevent @click="undo().catch(report)"><Icon name="undo" :size="17" /></button>
    <button aria-label="重做" title="重做 (Ctrl/⌘ Shift Z)" :disabled="!interactive || !canRedo" @mousedown.prevent @click="redo().catch(report)"><Icon name="redo" :size="17" /></button>
    <span>{{ diagram ? '修改源码，实时生成图表' : '自由排版 · 图形、连线与手绘' }}</span>
    <button v-if="!diagram" :disabled="!interactive" aria-label="适应画布" @click="sceneEditor?.fitCanvas()"><Icon name="search" :size="16" /><span>适应画布</span></button>
   </div>
   <CodeDiagramEditor v-if="diagram" ref="codeEditor" :source="model.source" :diagram-style="model.diagramStyle" :theme="theme" :active="active" :disabled="disabled" @change="changeSource" @change-style="changeStyle" @pending="setPending" @status="emit('status', $event)" @create-flow="createCanvas" @export="exportImage" />
   <SceneEditor v-else ref="sceneEditor" :scene="model.scene" :mode="model.kind === 'flow' ? 'flow' : 'board'" :theme="theme" :active="active" :disabled="disabled" @change="changeScene" @pending="setPending" @status="emit('status', $event)" @export="exportImage" />
  </template>
 </section>
</template>

<style scoped>
.workflow-editor{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;height:100%;overflow:hidden;background:var(--ui-bg);font-family:var(--ui-font);color:var(--ui-text)}
.workflow-editor>:deep(.diagram-editor),.workflow-editor>:deep(.scene-editor){flex:1;min-height:0}
.workflow-history{display:flex;align-items:center;gap:4px;flex:none;min-height:34px;padding:2px 12px;background:var(--ui-surface);border-bottom:1px solid var(--ui-line)}
.workflow-history button{display:flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:28px;padding:4px 7px;border-radius:var(--ui-radius);color:var(--ui-muted)}
.workflow-history button:hover:not(:disabled){background:var(--ui-accent-soft);color:var(--ui-accent)}
.workflow-history>span{font-size:var(--ui-font-small);color:var(--ui-muted);margin-left:8px;flex:1}
.workflow-history button span{font-size:var(--ui-font-small)}
.workflow-problem{display:flex;flex:none;align-items:center;gap:12px;padding:9px 16px;color:var(--ui-danger);background:var(--ui-danger-soft);border-bottom:1px solid var(--ui-line);font-size:13px}
.workflow-problem span{flex:1}.workflow-loading{padding:24px;color:var(--ui-muted)}
</style>
