<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { prepareRustWordDocument, setRustWordTheme, type PreparedRustWordDocument, type RustWordSession } from '../word/rust/client'
import type { WordcraftEvent, WordcraftFileAction, WordcraftSnapshot } from '../word/rust/wordcraft-types'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustWordDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: WordcraftFileAction] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<WordcraftSnapshot>()
const pictureInput = ref<HTMLInputElement>()
const loading = ref(true), problem = ref('')
let session: RustWordSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
let printUrl: string | undefined, printFrame: HTMLIFrameElement | undefined
let pictureRequest: { session: RustWordSession; generation: number; expected: Extract<WordcraftEvent, { type: 'pick-file' }> } | undefined
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function accept(value: WordcraftSnapshot, token: number) {
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
  if (!session) throw Error('请等待文字文稿打开。')
  await session.settled()
}
async function exportFile(options: { format?: Extension } = {}): Promise<EditorExport> {
  await flush()
  const format = options.format ?? 'docx'
  if (format !== 'docx' && format !== 'pdf') throw Error('文字文稿支持保存 DOCX 或导出 PDF。')
  const current = session!, token = generation
  const result = await current.export(format)
  if (disposed || generation !== token || current !== session) throw Error('文稿已切换，请重新保存。')
  const base64 = bytesToBase64(result.bytes)
  if (format === 'docx') lastExport = { generation: token, documentId: result.snapshot.documentId, revision: result.snapshot.revision, base64 }
  return { base64, extension: format, name: props.document.name.replace(/\.[^.]+$/, '') + '.' + format, dirty: result.snapshot.dirty }
}
async function markSaved(base64?: string) {
  await flush()
  const receipt = lastExport
  if (!receipt || receipt.generation !== generation || base64 !== receipt.base64) throw Error('保存的文件与当前导出结果不同，请重新保存当前文稿。')
  try { await session!.markSaved(receipt.documentId, receipt.revision) }
  catch (cause) { emit('dirty', true); throw cause }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) return
  await flush()
  const receipt = lastExport, current = await session!.inspect()
  // App calls this after an in-memory tab snapshot as well as a saved file.
  // Validate its receipt only; retain the live document and undo history.
  if (!receipt || receipt.generation !== generation || receipt.documentId !== current.documentId || receipt.revision !== current.revision) throw Error('导出后文稿又有修改，请先保存当前内容，再切换文稿。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('edit.find', { text: value }) }
async function inspect() { await flush(); return session!.inspect() }
async function command(id: string, params: Record<string, unknown> = {}) { await flush(); return session!.command(id, params) }
function focus() { session?.focus() }
function pickFile(event: Extract<WordcraftEvent, { type: 'pick-file' }>) {
  if (!session || !props.active || props.disabled) return
  if (event.purpose === 'document') { emit('file-action', 'open'); return }
  if (event.purpose !== 'picture') { emit('status', '此文件导入功能尚未接入，当前文稿已保留。'); return }
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
    if (!/\.(png|jpe?g|gif|webp|bmp|wmf|emf)$/i.test(file.name)) throw Error('请选择 PNG、JPEG、GIF、WebP、BMP、WMF 或 EMF 图片。')
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
    if (disposed || request.generation !== generation || request.session !== session || !props.active) return
    await request.session.command('host.deliverPicture', { data }, request.expected)
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
  if (disposed || token !== generation || current !== session) throw Error('文稿已切换，请重新打印。')
  printFrame?.remove()
  if (printUrl) URL.revokeObjectURL(printUrl)
  const bytes = result.bytes.slice()
  printUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }))
  printFrame = document.createElement('iframe')
  printFrame.title = '文稿打印预览'
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
  if (previous) await previous.close(true)
  let prepared: PreparedRustWordDocument | undefined = props.prepared
  try {
    let current = prepared?.take(source)
    if (!current) { prepared = await prepareRustWordDocument(source); current = prepared.take(source) }
    if (!current) throw Error('文字文稿准备失败。')
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
    loading.value = false; emit('ready'); emit('status', '文字文稿已就绪')
  } catch (cause) { prepared?.discard(); if (token === generation) { loading.value = false; report(cause) } }
}
watch(() => props.theme, value => { void setRustWordTheme(value).catch(report) }, { immediate: true })
watch(() => props.document.id, () => { opening = load() }, { immediate: true })
watch(() => props.active, value => {
  if (value) void attach().catch(report)
  else session?.deactivate()
})
watch(() => props.disabled, value => { if (props.active) session?.setInteractive(!value) })
onBeforeUnmount(() => {
  disposed = true; generation++; pictureRequest = undefined; unsubscribe?.(); unlisten?.(); props.prepared?.discard()
  session?.deactivate()
  void session?.close(true).catch(cause => console.error('WordCraft session cleanup failed', cause))
  printFrame?.remove(); if (printUrl) URL.revokeObjectURL(printUrl)
})
defineExpose({ exportFile, markSaved, discardChanges, undo, redo, search, print, focus, inspect, command })
</script>

<template>
  <section class="rust-word-editor" data-testid="rust-word-editor" data-engine="wordcraft-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-pages="snapshot?.pages" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div ref="viewport" class="wordcraft-viewport" data-testid="wordcraft-viewport" />
    <input ref="pictureInput" data-testid="wordcraft-picture-input" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.wmf,.emf" hidden @change="insertPicture" @cancel="cancelPicture" />
    <div v-if="loading" class="wordcraft-loading" role="status"><span class="wordcraft-spinner" />正在打开文字文稿…</div>
    <p v-if="problem" class="wordcraft-error" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.rust-word-editor{display:flex;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.wordcraft-viewport{position:absolute;inset:0;min-width:0;min-height:0}.wordcraft-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.wordcraft-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:wordcraft-spin .8s linear infinite}.wordcraft-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}@keyframes wordcraft-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.wordcraft-spinner{animation:none}}
</style>
