<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { printPdf, type PrintOutcome } from '../shared/printing'
import { prepareRustPresentationDocument, setRustPresentationTheme, type PreparedRustPresentationDocument, type RustPresentationSession } from '../presentation/rust/client'
import type { OfficePresentationEvent, OfficePresentationFileAction, OfficePresentationSnapshot } from '../presentation/rust/office-presentation-types'
import { validatePresentationMedia } from '../presentation/rust/media'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustPresentationDocument; active?: boolean; disabled?: boolean; theme?: Appearance; templatesOpen?: boolean }>(), { active: true, disabled: false, theme: 'system', templatesOpen: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: OfficePresentationFileAction]; 'toggle-templates': [] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<OfficePresentationSnapshot>()
const mediaInput = ref<HTMLInputElement>()
const loading = ref(true), problem = ref('')
let session: RustPresentationSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
let mediaRequest: { session: RustPresentationSession; generation: number; expected: Extract<OfficePresentationEvent, { type: 'pick-file' }> } | undefined
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function accept(value: OfficePresentationSnapshot, token: number) {
  if (disposed || generation !== token) return
  snapshot.value = value
  emit('dirty', value.dirty)
}
function listen(current: RustPresentationSession, token: number) {
  unsubscribe?.(); unlisten?.()
  unsubscribe = current.subscribe(value => accept(value, token))
  unlisten = current.onEvent(event => {
    if (disposed || token !== generation) return
    if (event.type === 'file-action' && props.active && !props.disabled) emit('file-action', event.action)
    else if (event.type === 'toggle-templates' && props.active && !props.disabled) emit('toggle-templates')
    else if (event.type === 'pick-file') pickFile(event)
    else if (event.type === 'error') report(event.message)
    else if (event.type === 'status') emit('status', event.message)
  })
}
async function attach() {
  await nextTick()
  if (!disposed && props.active && viewport.value && session) {
    const current = session
    await current.attach(viewport.value, !props.disabled)
    if (!disposed && props.active && current === session) await current.setTemplatePanelOpen(props.templatesOpen)
  }
}
async function flush() {
  await opening
  if (!session) throw Error('请等待演示文稿打开。')
  await session.settled()
}
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
  if (options.background) {
    await opening
    if (!session) throw Error('请等待演示文稿打开。')
  } else await flush()
  const format = options.format ?? 'pptx'
  if (!['pptx', 'pdf'].includes(format)) throw Error('演示文稿支持保存 PPTX 或导出 PDF。')
  const current = session!, token = generation
  const result = await current.export(format as 'pptx' | 'pdf', options)
  if (disposed || generation !== token || current !== session) throw Error('演示文稿已切换，请重新保存。')
  const base64 = bytesToBase64(result.bytes)
  if (format === 'pptx') lastExport = { generation: token, documentId: result.snapshot.documentId, revision: result.snapshot.revision, base64 }
  return { base64, extension: format, name: (result.snapshot.name || props.document.name).replace(/\.[^.]+$/, '') + '.' + format, dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string, options: { background?: boolean } = {}) {
  if (options.background) {
    await opening
    if (!session) throw Error('请等待演示文稿打开。')
  } else await flush()
  const receipt = lastExport
  if (!receipt || receipt.generation !== generation || base64 !== receipt.base64) throw Error('保存的文件与当前导出结果不同，请重新保存当前演示文稿。')
  try { await session!.markSaved(receipt.documentId, receipt.revision, options) }
  catch (cause) { emit('dirty', true); throw cause }
}
async function prepareDeactivate() {
  const token = generation
  await flush()
  if (disposed || generation !== token || !session) throw Error('演示文稿已切换，请重试。')
  const { documentId, revision, dirty } = session.snapshot
  return { documentId, revision, dirty }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) return
  if ((await prepareDeactivate()).dirty) throw Error('演示文稿还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('text.find', { text: value }) }
async function present() { await flush(); await session!.command('show.start', { from: 0 }) }
async function stopPresentation() { await opening; if (session && props.active) await session.command('show.end') }
async function inspect() { await opening; if (!session) throw Error('请等待演示文稿打开。'); return session.inspect() }
async function syncRevision() { return inspect() }
async function canBackgroundExport() { await opening; return !disposed && !loading.value && !mediaRequest && !!session && session.canBackgroundExport() }
async function command(id: string, params: Record<string, unknown> = {}) { await flush(); return session!.command(id, params) }
async function applyTemplate(base64: string) {
  await flush()
  const value = await session!.command('template.applyBytes', { data: base64 })
  lastExport = undefined
  return value
}
async function query(id: string, params: Record<string, unknown> = {}) { await opening; if (!session) throw Error('请等待演示文稿打开。'); return session.query(id, params) }
function focus() { session?.focus() }
function pickFile(event: Extract<OfficePresentationEvent, { type: 'pick-file' }>) {
  if (!session || !props.active || props.disabled) return
  if (event.purpose === 'document' || event.purpose === 'open') { emit('file-action', 'open'); return }
  if (!['picture', 'audio', 'video'].includes(event.purpose)) { emit('status', '此文件导入功能尚未接入，当前演示文稿已保留。'); return }
  mediaRequest = { session, generation, expected: event }
  if (mediaInput.value) {
    mediaInput.value.accept = event.purpose === 'audio' ? '.mp3,.wav,.m4a,.ogg,.flac' : event.purpose === 'video' ? '.mp4,.webm,.mov,.m4v' : '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg'
    mediaInput.value.click()
  }
}
function cancelMedia() {
  const request = mediaRequest; mediaRequest = undefined
  if (!request || disposed || request.generation !== generation || request.session !== session) return
  // Cancellation is pinned to the picker identity, even if the selection moved.
  // Only delivery requires the captured document/revision/selection receipt.
  void request.session.command('host.cancelFile', { requestId: request.expected.requestId }).catch(() => undefined)
}
async function insertMedia(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], request = mediaRequest
  if (!file) { input.value = ''; cancelMedia(); return }
  input.value = ''; mediaRequest = undefined
  if (!request) return
  try {
    validatePresentationMedia(file, request.expected.purpose)
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
    if (disposed || request.generation !== generation || request.session !== session || !props.active) {
      await request.session.command('host.cancelFile', { requestId: request.expected.requestId }).catch(() => undefined)
      return
    }
    await request.session.command('host.deliverFile', { name: file.name, data, requestId: request.expected.requestId }, request.expected)
    problem.value = ''; emit('status', '媒体已插入')
  } catch (cause) {
    if (!disposed && request.generation === generation && request.session === session) {
      await request.session.command('host.cancelFile', { requestId: request.expected.requestId }).catch(() => undefined)
      report(cause)
    }
  }
}
async function print(): Promise<PrintOutcome> {
  await flush()
  const token = generation, current = session!, result = await current.export('pdf')
  if (disposed || token !== generation || current !== session) throw Error('演示文稿已切换，请重新打印。')
  return await printPdf(result.bytes, props.document.name)
}
async function load() {
  const token = ++generation, source = { ...props.document }, previous = session
  loading.value = true; problem.value = ''
  let prepared: PreparedRustPresentationDocument | undefined = props.prepared
  try {
    let current = prepared?.take(source)
    if (!current) { prepared = await prepareRustPresentationDocument(source); current = prepared.take(source) }
    if (!current) throw Error('演示文稿准备失败。')
    if (disposed || token !== generation || source.id !== props.document.id) { await current.close(true); return }
    // Parse and validate the candidate while the previous presentation remains
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
    loading.value = false; emit('ready'); emit('status', '演示文稿已就绪')
  } catch (cause) {
    prepared?.discard()
    if (token === generation) {
      if (session) { listen(session, token); accept(session.snapshot, token) }
      loading.value = false; report(cause)
    }
  }
}
watch(() => props.theme, value => { void setRustPresentationTheme(value).catch(report) }, { immediate: true })
watch(() => props.document.id, () => { opening = load() }, { immediate: true })
watch(() => props.active, value => {
  if (value) void attach().catch(report)
  else {
    cancelMedia()
    // End an active slide show before another session takes the shared canvas.
    if ((snapshot.value?.ui as { showing?: unknown } | undefined)?.showing) void session?.command('show.end').catch(report)
    session?.deactivate()
  }
})
watch(() => props.disabled, value => { if (props.active) session?.setInteractive(!value) })
watch(() => props.templatesOpen, value => { if (props.active) void session?.setTemplatePanelOpen(value).catch(report) })
onBeforeUnmount(() => {
  disposed = true; generation++; mediaRequest = undefined; unsubscribe?.(); unlisten?.(); props.prepared?.discard()
  session?.deactivate()
  void session?.close(true).catch(cause => console.error('Presentation session cleanup failed', cause))
})
defineExpose({ prepareDeactivate, exportFile, markSaved, discardChanges, undo, redo, search, print, focus, present, stopPresentation, inspect, syncRevision, canBackgroundExport, command, query, applyTemplate })
</script>

<template>
  <section class="rust-presentation-editor" data-testid="rust-presentation-editor" data-engine="office-presentation-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-slides="snapshot?.slides.length" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div ref="viewport" class="office-presentation-viewport" data-testid="office-presentation-viewport" />
    <input ref="mediaInput" data-testid="office-presentation-media-input" type="file" accept=".png,.jpg,.jpeg" hidden @change="insertMedia" @cancel="cancelMedia" />
    <div v-if="loading" class="office-presentation-loading" role="status"><span class="office-presentation-spinner" />正在打开演示文稿…</div>
    <p v-if="problem" class="office-presentation-error" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.rust-presentation-editor{display:flex;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.office-presentation-viewport{position:absolute;inset:0;min-width:0;min-height:0}.office-presentation-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.office-presentation-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:office-presentation-spin .8s linear infinite}.office-presentation-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}@keyframes office-presentation-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.office-presentation-spinner{animation:none}}
</style>
