<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { prepareRustPdfDocument, setRustPdfTheme, type PreparedRustPdfDocument, type RustPdfSession } from '../pdf/rust/client'
import type { OfficePdfFileAction, OfficePdfSnapshot } from '../pdf/rust/types'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustPdfDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: OfficePdfFileAction] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<OfficePdfSnapshot>()
const loading = ref(true), problem = ref('')
let session: RustPdfSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
let printUrl: string | undefined, printFrame: HTMLIFrameElement | undefined
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function accept(value: OfficePdfSnapshot, token: number) {
  if (disposed || generation !== token) return
  snapshot.value = value
  emit('dirty', value.dirty)
}
function listen(current: RustPdfSession, token: number) {
  unsubscribe?.(); unlisten?.()
  unsubscribe = current.subscribe(value => accept(value, token))
  unlisten = current.onEvent(event => {
    if (disposed || token !== generation) return
    if (event.type === 'file-action' && props.active && !props.disabled) emit('file-action', event.action)
    else if (event.type === 'error') report(event.message)
    else if (event.type === 'status') emit('status', event.message)
  })
}
async function attach() {
  await nextTick()
  if (!disposed && props.active && viewport.value && session) await session.attach(viewport.value, !props.disabled)
}
async function flush() {
  await opening
  if (!session) throw Error('请等待 PDF 文档打开。')
  await session.settled()
}
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
  if (options.background) { await opening; if (!session) throw Error('请等待 PDF 文档打开。') }
  else await flush()
  const format = options.format ?? 'pdf'
  if (format !== 'pdf') throw Error('PDF 文档支持保存为 PDF。')
  const current = session!, token = generation
  const result = await current.export('pdf', options)
  if (disposed || generation !== token || current !== session) throw Error('PDF 文档已切换，请重新保存。')
  const base64 = bytesToBase64(result.bytes)
  lastExport = { generation: token, documentId: result.snapshot.documentId, revision: result.snapshot.revision, base64 }
  return { base64, extension: format, name: (result.snapshot.name || props.document.name).replace(/\.[^.]+$/, '') + '.' + format, dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string, options: { background?: boolean } = {}) {
  if (options.background) { await opening; if (!session) throw Error('请等待 PDF 文档打开。') }
  else await flush()
  const receipt = lastExport
  if (!receipt || receipt.generation !== generation || base64 !== receipt.base64) throw Error('保存的文件与当前导出结果不同，请重新保存当前 PDF 文档。')
  try { await session!.markSaved(receipt.documentId, receipt.revision, options) }
  catch (cause) { emit('dirty', true); throw cause }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) {
    // The shell activates the next tab before this component unmounts. Release
    // confirmed-discarded drafts now so they cannot block that tab's activation.
    await opening
    await session?.close(true)
    return
  }
  await flush()
  const receipt = lastExport, current = await session!.inspect()
  // App calls this after an in-memory tab snapshot as well as a saved file.
  // Validate its receipt only; retain the live document and undo history.
  if (!receipt || receipt.generation !== generation || receipt.documentId !== current.documentId || receipt.revision !== current.revision) throw Error('导出后 PDF 文档又有修改，请先保存当前内容，再切换 PDF 文档。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('edit.find', { query: value }) }
async function inspect() { await opening; if (!session) throw Error('请等待 PDF 文档打开。'); return session.inspect() }
async function syncRevision() { return inspect() }
async function canBackgroundExport() {
  await opening
  return !disposed && !loading.value && !!session && await session.canBackgroundExport()
}
async function command(id: string, params: Record<string, unknown> = {}) { await flush(); return session!.command(id, params) }
async function query(id: string, params: Record<string, unknown> = {}) { await opening; if (!session) throw Error('请等待 PDF 文档打开。'); return session.query(id, params) }
function focus() { session?.focus() }
async function print() {
  await flush()
  const token = generation, current = session!, result = await current.export('pdf')
  if (disposed || token !== generation || current !== session) throw Error('PDF 文档已切换，请重新打印。')
  printFrame?.remove()
  if (printUrl) URL.revokeObjectURL(printUrl)
  const bytes = result.bytes.slice()
  printUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }))
  printFrame = document.createElement('iframe')
  printFrame.title = 'PDF 文档打印预览'
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
  loading.value = true; problem.value = ''
  let prepared: PreparedRustPdfDocument | undefined = props.prepared
  try {
    let current = prepared?.take(source)
    if (!current) { prepared = await prepareRustPdfDocument(source); current = prepared.take(source) }
    if (!current) throw Error('PDF 文档准备失败。')
    if (disposed || token !== generation || source.id !== props.document.id) { await current.close(true); return }
    // Parse and validate the candidate while the previous PDF remains
    // intact. Shell preflight normally provides this handoff; direct mounting
    // must obey the same rule if an import fails.
    if (previous) await previous.close(true)
    if (disposed || token !== generation) { await current.close(true); return }
    session = current
    lastExport = undefined
    listen(current, token)
    accept(current.snapshot, token)
    await attach()
    if (disposed || token !== generation) return
    loading.value = false; emit('ready'); emit('status', 'PDF 文档已就绪')
  } catch (cause) {
    prepared?.discard()
    if (token === generation) {
      if (session) { listen(session, token); accept(session.snapshot, token) }
      loading.value = false; report(cause)
    }
  }
}
watch(() => props.theme, value => { void setRustPdfTheme(value).catch(report) }, { immediate: true })
watch(() => props.document.id, () => { opening = load() }, { immediate: true })
watch(() => props.active, value => {
  if (value) void attach().catch(report)
  else {
    session?.deactivate()
  }
})
watch(() => props.disabled, value => { if (props.active) session?.setInteractive(!value) })
onBeforeUnmount(() => {
  disposed = true; generation++; unsubscribe?.(); unlisten?.(); props.prepared?.discard()
  session?.deactivate()
  void session?.close(true).catch(cause => console.error('PDF session cleanup failed', cause))
  printFrame?.remove(); if (printUrl) URL.revokeObjectURL(printUrl)
})
defineExpose({ exportFile, markSaved, discardChanges, undo, redo, search, print, focus, inspect, syncRevision, canBackgroundExport, command, query })
</script>

<template>
  <section class="rust-pdf-editor" data-testid="rust-pdf-editor" data-engine="office-pdf-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-pages="snapshot?.pageCount" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div ref="viewport" class="pdf-viewport" data-testid="pdf-viewport" />
    <div v-if="loading" class="pdf-loading" role="status"><span class="pdf-spinner" />正在打开 PDF 文档…</div>
    <p v-if="problem" class="pdf-error" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.rust-pdf-editor{display:flex;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.pdf-viewport{position:absolute;inset:0;min-width:0;min-height:0}.pdf-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.pdf-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:pdf-spin .8s linear infinite}.pdf-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}@keyframes pdf-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.pdf-spinner{animation:none}}
</style>
