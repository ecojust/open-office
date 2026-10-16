<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { prepareRustSheetDocument, setRustSheetTheme, type PreparedRustSheetDocument, type RustSheetSession } from '../sheet/rust/client'
import type { OfficeSheetEvent, OfficeSheetFileAction, OfficeSheetSnapshot } from '../sheet/rust/office-sheet-types'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustSheetDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: OfficeSheetFileAction] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<OfficeSheetSnapshot>()
const pictureInput = ref<HTMLInputElement>()
const loading = ref(true), problem = ref('')
let session: RustSheetSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
let printUrl: string | undefined, printFrame: HTMLIFrameElement | undefined
let pictureRequest: { session: RustSheetSession; generation: number; expected: Extract<OfficeSheetEvent, { type: 'pick-file' }> } | undefined
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function accept(value: OfficeSheetSnapshot, token: number) {
  if (disposed || generation !== token) return
  snapshot.value = value
  emit('dirty', value.dirty)
}
async function attach() {
  await nextTick()
  if (!disposed && props.active && viewport.value && session) await session.attach(viewport.value, !props.disabled)
}
async function flush() {
  await opening
  if (!session) throw Error('请等待工作簿打开。')
  await session.settled()
}
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
  if (options.background) { await opening; if (!session) throw Error('请等待工作簿打开。') }
  else await flush()
  const format = options.format ?? 'xlsx'
  if (!['xlsx', 'csv', 'tsv', 'pdf'].includes(format)) throw Error('工作簿支持保存 XLSX 或导出 CSV、TSV 与 PDF。')
  const current = session!, token = generation
  const result = await current.export(format as 'xlsx' | 'csv' | 'tsv' | 'pdf', options)
  if (disposed || generation !== token || current !== session) throw Error('工作簿已切换，请重新保存。')
  const base64 = bytesToBase64(result.bytes)
  if (format === 'xlsx') lastExport = { generation: token, documentId: result.snapshot.documentId, revision: result.snapshot.revision, base64 }
  return { base64, extension: format, name: props.document.name.replace(/\.[^.]+$/, '') + '.' + format, dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string, options: { background?: boolean } = {}) {
  if (options.background) { await opening; if (!session) throw Error('请等待工作簿打开。') }
  else await flush()
  const receipt = lastExport
  if (!receipt || receipt.generation !== generation || base64 !== receipt.base64) throw Error('保存的文件与当前导出结果不同，请重新保存当前工作簿。')
  try { await session!.markSaved(receipt.documentId, receipt.revision, options) }
  catch (cause) { emit('dirty', true); throw cause }
}
async function prepareDeactivate() {
  const token = generation
  await flush()
  if (disposed || generation !== token || !session) throw Error('工作簿已切换，请重试。')
  const { documentId, revision, dirty } = session.snapshot
  return { documentId, revision, dirty }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) return
  if ((await prepareDeactivate()).dirty) throw Error('工作簿还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('edit.find', { what: value }) }
async function inspect() { await opening; if (!session) throw Error('请等待工作簿打开。'); return session.inspect() }
async function syncRevision() { return inspect() }
async function canBackgroundExport() {
  await opening
  return !disposed && !loading.value && !pictureRequest && !!session && await session.canBackgroundExport()
}
async function command(id: string, params: Record<string, unknown> = {}) { await flush(); return session!.command(id, params) }
async function query(id: string, params: Record<string, unknown> = {}) { await opening; if (!session) throw Error('请等待工作簿打开。'); return session.query(id, params) }
function focus() { session?.focus() }
function pickFile(event: Extract<OfficeSheetEvent, { type: 'pick-file' }>) {
  if (!session || !props.active || props.disabled) return
  if (event.purpose === 'document') { emit('file-action', 'open'); return }
  if (event.purpose !== 'picture') { emit('status', '此文件导入功能尚未接入，当前工作簿已保留。'); return }
  pictureRequest = { session, generation, expected: event }
  pictureInput.value?.click()
}
function cancelPicture() {
  const request = pictureRequest; pictureRequest = undefined
  if (!request || disposed || request.generation !== generation || request.session !== session) return
  void request.session.command('host.cancelPicture', {}, request.expected).catch(() => undefined)
}
async function insertPicture(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], request = pictureRequest
  if (!file) { input.value = ''; cancelPicture(); return }
  input.value = ''; pictureRequest = undefined
  if (!request) return
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('图片不能超过 10 MB。')
    if (!/\.(png|jpe?g)$/i.test(file.name)) throw Error('请选择 PNG 或 JPEG 图片。')
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
    if (disposed || request.generation !== generation || request.session !== session || !props.active) return
    await request.session.command('host.deliverPicture', { name: file.name, data }, request.expected)
    problem.value = ''; emit('status', '图片已更新')
  } catch (cause) {
    if (!disposed && request.generation === generation && request.session === session) {
      await request.session.command('host.cancelPicture', {}, request.expected).catch(() => undefined)
      report(cause)
    }
  }
}
async function print() {
  await flush()
  const token = generation, current = session!, result = await current.export('pdf')
  if (disposed || token !== generation || current !== session) throw Error('工作簿已切换，请重新打印。')
  printFrame?.remove()
  if (printUrl) URL.revokeObjectURL(printUrl)
  const bytes = result.bytes.slice()
  printUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }))
  printFrame = document.createElement('iframe')
  printFrame.title = '工作簿打印预览'
  Object.assign(printFrame.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' })
  const frame = printFrame
  frame.onload = () => {
    if (disposed || frame !== printFrame) return
    try { frame.contentWindow?.print() }
    catch { emit('status', '此浏览器未能打开打印对话框，请导出 PDF 后打印。') }
  }
  frame.src = printUrl
  document.body.append(frame)
}
async function load() {
  const token = ++generation, source = { ...props.document }, previous = session
  unsubscribe?.(); unlisten?.(); session = undefined; snapshot.value = undefined; lastExport = undefined
  loading.value = true; problem.value = ''
  let prepared: PreparedRustSheetDocument | undefined = props.prepared
  try {
    if (previous) await previous.close(true)
    let current = prepared?.take(source)
    if (!current) { prepared = await prepareRustSheetDocument(source); current = prepared.take(source) }
    if (!current) throw Error('工作簿准备失败。')
    if (disposed || token !== generation || source.id !== props.document.id) { await current.close(true); return }
    session = current
    unsubscribe = current.subscribe(value => accept(value, token))
    unlisten = current.onEvent(event => {
      if (disposed || token !== generation) return
      if (event.type === 'file-action' && props.active && !props.disabled) emit('file-action', event.action)
      else if (event.type === 'pick-file') pickFile(event)
      else if (event.type === 'error') report(event.message)
      else if (event.type === 'status') emit('status', event.message)
    })
    accept(current.snapshot, token)
    await attach()
    if (disposed || token !== generation) return
    loading.value = false; emit('ready'); emit('status', '工作簿已就绪')
  } catch (cause) { prepared?.discard(); if (token === generation) { loading.value = false; report(cause) } }
}
watch(() => props.theme, value => { void setRustSheetTheme(value).catch(report) }, { immediate: true })
watch(() => props.document.id, () => { opening = load() }, { immediate: true })
watch(() => props.active, value => {
  if (value) void attach().catch(report)
  else session?.deactivate()
})
watch(() => props.disabled, value => { if (props.active) session?.setInteractive(!value) })
onBeforeUnmount(() => {
  disposed = true; generation++; pictureRequest = undefined; unsubscribe?.(); unlisten?.(); props.prepared?.discard()
  session?.deactivate()
  void session?.close(true).catch(cause => console.error('OfficeSheet session cleanup failed', cause))
  printFrame?.remove(); if (printUrl) URL.revokeObjectURL(printUrl)
})
defineExpose({ prepareDeactivate, exportFile, markSaved, discardChanges, undo, redo, search, print, focus, inspect, syncRevision, canBackgroundExport, command, query })
</script>

<template>
  <section class="rust-sheet-editor" data-testid="rust-sheet-editor" data-engine="office-sheet-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-sheets="snapshot?.sheets.length" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div ref="viewport" class="office-sheet-viewport" data-testid="office-sheet-viewport" />
    <input ref="pictureInput" data-testid="office-sheet-picture-input" type="file" accept=".png,.jpg,.jpeg" hidden @change="insertPicture" @cancel="cancelPicture" />
    <div v-if="loading" class="office-sheet-loading" role="status"><span class="office-sheet-spinner" />正在打开工作簿…</div>
    <p v-if="problem" class="office-sheet-error" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.rust-sheet-editor{display:flex;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.office-sheet-viewport{position:absolute;inset:0;min-width:0;min-height:0}.office-sheet-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.office-sheet-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:office-sheet-spin .8s linear infinite}.office-sheet-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}@keyframes office-sheet-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.office-sheet-spinner{animation:none}}
</style>
