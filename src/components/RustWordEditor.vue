<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { printPdf, type PrintOutcome } from '../shared/printing'
import { prepareRustWordDocument, setRustWordTheme, type PreparedRustWordDocument, type RustWordSession } from '../word/rust/client'
import type { OfficeWordEvent, OfficeWordFileAction, OfficeWordSnapshot } from '../word/rust/office-word-types'
import { describeWordCommands } from '../mcp/word-tools'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustWordDocument; active?: boolean; disabled?: boolean; theme?: Appearance }>(), { active: true, disabled: false, theme: 'system' })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: OfficeWordFileAction] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<OfficeWordSnapshot>()
const pictureInput = ref<HTMLInputElement>()
const loading = ref(true), problem = ref('')
let session: RustWordSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
let pictureRequest: { session: RustWordSession; generation: number; expected: Extract<OfficeWordEvent, { type: 'pick-file' }> } | undefined
function report(cause: unknown) {
  if (disposed) return
  problem.value = cause instanceof Error ? cause.message : String(cause)
  emit('error', problem.value)
}
function accept(value: OfficeWordSnapshot, token: number) {
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
async function exportFile(options: { format?: Extension; background?: boolean } = {}): Promise<EditorExport> {
  if (options.background) {
    await opening
    if (!session) throw Error('请等待文字文稿打开。')
  } else await flush()
  const format = options.format ?? 'docx'
  if (format !== 'docx' && format !== 'pdf') throw Error('文字文稿支持保存 DOCX 或导出 PDF。')
  const current = session!, token = generation
  const result = await current.export(format, options)
  if (disposed || generation !== token || current !== session) throw Error('文稿已切换，请重新保存。')
  const base64 = bytesToBase64(result.bytes)
  if (format === 'docx') lastExport = { generation: token, documentId: result.snapshot.documentId, revision: result.snapshot.revision, base64 }
  return { base64, extension: format, name: props.document.name.replace(/\.[^.]+$/, '') + '.' + format, dirty: result.snapshot.dirty, revision: `${result.snapshot.documentId}:${result.snapshot.revision}` }
}
async function markSaved(base64?: string, options: { background?: boolean } = {}) {
  if (options.background) {
    await opening
    if (!session) throw Error('请等待文字文稿打开。')
  } else await flush()
  const receipt = lastExport
  if (!receipt || receipt.generation !== generation || base64 !== receipt.base64) throw Error('保存的文件与当前导出结果不同，请重新保存当前文稿。')
  try { await session!.markSaved(receipt.documentId, receipt.revision, options) }
  catch (cause) { emit('dirty', true); throw cause }
}
async function prepareDeactivate() {
  const token = generation
  await flush()
  if (disposed || generation !== token || !session) throw Error('文稿已切换，请重试。')
  const { documentId, revision, dirty } = session.snapshot
  return { documentId, revision, dirty }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) return
  if ((await prepareDeactivate()).dirty) throw Error('文稿还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('edit.find', { text: value }) }
async function inspect() { await opening; if (!session) throw Error('请等待文字文稿打开。'); return session.inspect() }
async function syncRevision() { return inspect() }
async function canBackgroundExport() { await opening; return !disposed && !loading.value && !pictureRequest && !!session && session.canBackgroundExport() }
async function command(id: string, params: Record<string, unknown> = {}) { await flush(); return session!.command(id, params) }
function focus() { session?.focus() }
function pickFile(event: Extract<OfficeWordEvent, { type: 'pick-file' }>) {
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
async function print(): Promise<PrintOutcome> {
  await flush()
  const token = generation, current = session!, result = await current.export('pdf')
  if (disposed || token !== generation || current !== session) throw Error('文稿已切换，请重新打印。')
  return await printPdf(result.bytes, props.document.name)
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
  void session?.close(true).catch(cause => console.error('OfficeWord session cleanup failed', cause))
})
async function mcpExecute(name: string, args: Record<string, unknown>, assertCurrent: () => void): Promise<unknown> {
  const owner = generation
  const guard = () => { assertCurrent(); if (disposed || owner !== generation || !props.active) throw Error('MCP 文档已切换，请重新开启服务。') }
  guard(); await opening; guard()
  const current = session
  if (!current || loading.value) throw Error('请等待文档打开。')
  if (name === 'document_inspect') { const result = await current.inspect(); guard(); return result }
  if (name === 'document_undo' || name === 'document_redo') return (await current.mcpCommand(name === 'document_undo' ? 'edit.undo' : 'edit.redo', {}, guard)).snapshot
  if (name === 'word_read') { const value = await current.inspect(); guard(); return { text: (value.text ?? '').slice(0, 100000), totalCharacters: (value.text ?? '').length, truncated: (value.text ?? '').length > 100000 } }
  if (name === 'word_insert_text') return (await current.mcpCommand('text.insert', { text: args.text, raw: true }, guard)).snapshot
  if (name === 'word_list_commands') return describeWordCommands(await current.mcpCommands(args, guard))
  if (name === 'word_inspect_document') return current.mcpQuery('document.inspect', args, guard)
  if (name === 'word_query') return current.mcpQuery(String(args.command), (args.params ?? {}) as Record<string, unknown>, guard)
  if (name === 'word_execute_command') return current.mcpCommand(String(args.command), (args.params ?? {}) as Record<string, unknown>, guard)
  if (name === 'word_select_text') return current.mcpCommand('select.text', { ...args, occurrence: Number(args.occurrence ?? 0) + 1 }, guard)
  if (name === 'word_select_range') return current.mcpCommand('select.range', args, guard)
  throw Error('当前编辑器不支持此 MCP 工具。')
}
defineExpose({ mcpExecute, prepareDeactivate, exportFile, markSaved, discardChanges, undo, redo, search, print, focus, inspect, syncRevision, canBackgroundExport, command })
</script>

<template>
  <section class="rust-word-editor" data-testid="rust-word-editor" data-engine="office-word-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-pages="snapshot?.pages" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div ref="viewport" class="office-word-viewport" data-testid="office-word-viewport" />
    <input ref="pictureInput" data-testid="office-word-picture-input" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.wmf,.emf" hidden @change="insertPicture" @cancel="cancelPicture" />
    <div v-if="loading" class="office-word-loading" role="status"><span class="office-word-spinner" />正在打开文字文稿…</div>
    <p v-if="problem" class="office-word-error" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.rust-word-editor{display:flex;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.office-word-viewport{position:absolute;inset:0;min-width:0;min-height:0}.office-word-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.office-word-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:office-word-spin .8s linear infinite}.office-word-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}@keyframes office-word-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.office-word-spinner{animation:none}}
</style>
