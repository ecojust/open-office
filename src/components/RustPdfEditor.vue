<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { NativeDocument } from '../types'
import type { Appearance } from '../shared/appearance'
import { bytesToBase64, type EditorExport, type Extension } from '../shared/document'
import { printPdf, type PrintOutcome } from '../shared/printing'
import { prepareRustPdfDocument, setRustPdfTheme, isPdfPendingDecisionCommand, type PreparedRustPdfDocument, type RustPdfSession } from '../pdf/rust/client'
import type { OfficePdfFileAction, OfficePdfSnapshot } from '../pdf/rust/types'
import { normalizePdfAuthor, pdfAuthorPreference } from '../pdf/author'
import { useDialogFocus } from '../shared/dialog-focus'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ document: NativeDocument; prepared?: PreparedRustPdfDocument; active?: boolean; disabled?: boolean; theme?: Appearance; focusMode?: boolean }>(), { active: true, disabled: false, theme: 'system', focusMode: false })
const emit = defineEmits<{ ready: []; dirty: [value: boolean]; error: [message: string]; status: [message: string]; 'file-action': [action: OfficePdfFileAction] }>()
const viewport = ref<HTMLElement>(), snapshot = shallowRef<OfficePdfSnapshot>()
const loading = ref(true), problem = ref('')
const author = ref(pdfAuthorPreference.read()), authorDialog = ref(false), authorDraft = ref(''), authorError = ref(''), authorSaving = ref(false)
const authorForm = ref<HTMLElement>(), authorInput = ref<HTMLInputElement>()
useDialogFocus(authorForm)
const unlistenAuthor = pdfAuthorPreference.subscribe(value => { author.value = value })
let session: RustPdfSession | undefined, unsubscribe: (() => void) | undefined, unlisten: (() => void) | undefined
let disposed = false, generation = 0, opening: Promise<void> = Promise.resolve()
let lastExport: { generation: number; documentId: number; revision: number; base64: string } | undefined
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
  if (!disposed && props.active && viewport.value && session) await session.attach(viewport.value, !props.disabled && !authorDialog.value)
}
async function editAuthor() {
  if (loading.value || props.disabled || !props.active || !session) return
  try {
    await flush()
    if (disposed || props.disabled || !props.active) return
    authorDraft.value = author.value; authorError.value = ''; authorDialog.value = true
    session?.setInteractive(false)
    await nextTick(); authorInput.value?.focus(); authorInput.value?.select()
  } catch (cause) { report(cause) }
}
function closeAuthor() {
  if (authorSaving.value) return
  authorDialog.value = false
  if (props.active) session?.setInteractive(!props.disabled)
}
async function saveAuthor() {
  if (authorSaving.value || props.disabled || !props.active || !session) return
  const current = session, token = generation
  authorSaving.value = true; authorError.value = ''
  try {
    const persisted = await current.setAuthor(normalizePdfAuthor(authorDraft.value))
    if (disposed || token !== generation || current !== session) return
    authorDialog.value = false
    if (props.active) current.setInteractive(!props.disabled)
    emit('status', persisted ? '署名已保存，将用于新图章和批注' : '署名已应用，本次会话有效；本机设置暂时无法保存')
  } catch (cause) { authorError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { authorSaving.value = false }
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
async function prepareDeactivate() {
  const token = generation
  await flush()
  if (disposed || generation !== token || !session) throw Error('PDF 文档已切换，请重试。')
  const { documentId, revision, dirty } = session.snapshot
  return { documentId, revision, dirty }
}
async function discardChanges(options: { force?: boolean } = {}) {
  if (options.force) {
    // The shell activates the next tab before this component unmounts. Release
    // confirmed-discarded drafts now so they cannot block that tab's activation.
    await opening
    await session?.close(true)
    return
  }
  if ((await prepareDeactivate()).dirty) throw Error('PDF 文档还有未保存的修改，请先保存或确认不保存后关闭。')
}
async function undo() { await flush(); await session!.command('edit.undo') }
async function redo() { await flush(); await session!.command('edit.redo') }
async function search(value: string) { await flush(); await session!.command('edit.find', { query: value }) }
async function inspect() { await opening; if (!session) throw Error('请等待 PDF 文档打开。'); return session.inspect() }
async function syncRevision() { return inspect() }
async function canBackgroundExport() {
  await opening
  return !disposed && !loading.value && !authorDialog.value && !!session && await session.canBackgroundExport()
}
async function command(id: string, params: Record<string, unknown> = {}) {
  if (isPdfPendingDecisionCommand(id)) {
    await opening
    if (!session) throw Error('请等待 PDF 文档打开。')
  } else await flush()
  return session!.command(id, params)
}
async function query(id: string, params: Record<string, unknown> = {}) { await opening; if (!session) throw Error('请等待 PDF 文档打开。'); return session.query(id, params) }
function focus() { session?.focus() }
async function print(): Promise<PrintOutcome> {
  await flush()
  const token = generation, current = session!, result = await current.export('pdf')
  if (disposed || token !== generation || current !== session) throw Error('PDF 文档已切换，请重新打印。')
  return await printPdf(result.bytes, props.document.name)
}
async function load() {
  const token = ++generation, source = { ...props.document }, previous = session
  loading.value = true; problem.value = ''
  authorDialog.value = false
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
    authorDialog.value = false
    session?.deactivate()
  }
})
watch(() => props.disabled, value => { if (props.active) session?.setInteractive(!value && !authorDialog.value) })
onBeforeUnmount(() => {
  disposed = true; generation++; unsubscribe?.(); unlisten?.(); props.prepared?.discard()
  unlistenAuthor()
  session?.deactivate()
  void session?.close(true).catch(cause => console.error('PDF session cleanup failed', cause))
})
async function mcpExecute(name: string, args: Record<string, unknown>, assertCurrent: () => void): Promise<unknown> {
  const owner = generation
  const guard = () => { assertCurrent(); if (disposed || owner !== generation || !props.active) throw Error('MCP 文档已切换，请重新开启服务。') }
  guard(); await opening; guard()
  const current = session
  if (!current || loading.value) throw Error('请等待文档打开。')
  if (name === 'document_inspect') { const result = await current.inspect(); guard(); return result }
  if (name === 'pdf_list_commands') { const result = await current.query('mcp.commands', args); guard(); return result }
  if (authorDialog.value) throw Error('请先关闭 PDF 署名设置。')
  if (name === 'pdf_query') return current.executeMcp('mcp.query', args, guard)
  if (name === 'pdf_execute_command') {
    const params = { ...((args.params as Record<string, unknown> | undefined) ?? {}) }
    if (['comment_add', 'comment_reply', 'comment_set_status', 'comment_mark', 'stamp_custom', 'fill_sign_add'].includes(String(args.command)) && params.author === undefined) params.author = author.value
    return current.executeMcp('mcp.execute', { ...args, params }, guard)
  }
  if (name === 'document_undo' || name === 'document_redo') return current.command(name === 'document_undo' ? 'edit.undo' : 'edit.redo', {}, guard)
  if (name === 'pdf_read') { const result = await current.query('document.inspect'); guard(); return result }
  if (name === 'pdf_add_text') {
    const state = await current.inspect(); guard()
    const page = Number(args.page ?? state.activePage ?? 0), bounds = state.pages[page]
    const x = Number(args.x ?? 36), y = Number(args.y ?? 36), width = Number(args.width ?? 300), height = Number(args.height ?? 60)
    if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number' || x + width > bounds.width || y + height > bounds.height) throw Error('文字框超出 PDF 页面范围。')
    return current.command('pdf.addText', { text: args.text, page, rect: [x, y, x + width, y + height], size: args.size ?? 18 }, guard)
  }
  throw Error('当前编辑器不支持此 MCP 工具。')
}
defineExpose({ mcpExecute, prepareDeactivate, exportFile, markSaved, discardChanges, undo, redo, search, print, focus, inspect, syncRevision, canBackgroundExport, command, query })
</script>

<template>
  <section class="rust-pdf-editor" data-testid="rust-pdf-editor" data-engine="office-pdf-wasm" :data-ready="!!snapshot && !loading" :data-session-id="snapshot?.sessionId" :data-revision="snapshot?.revision" :data-pages="snapshot?.pageCount" :data-dirty="snapshot?.dirty" :aria-busy="loading">
    <div v-show="!focusMode" class="pdf-author-bar">
      <button class="pdf-author-button" type="button" :disabled="loading || disabled || !active" aria-label="设置图章署名" @click="editAuthor"><Icon name="pdf" :size="16" /><span>图章署名</span><strong :title="author || '未设置'">{{ author || '未设置' }}</strong><Icon name="chevron-down" :size="14" /></button>
      <span class="pdf-author-hint">用于新图章和批注</span>
    </div>
    <div ref="viewport" class="pdf-viewport" data-testid="pdf-viewport" />
    <div v-if="loading" class="pdf-loading" role="status"><span class="pdf-spinner" />正在打开 PDF 文档…</div>
    <p v-if="problem" class="pdf-error" role="alert">{{ problem }}</p>
    <div v-if="authorDialog" class="pdf-author-backdrop" @keydown.esc.prevent="closeAuthor">
      <form ref="authorForm" class="pdf-author-dialog" role="dialog" aria-modal="true" aria-label="图章署名" @submit.prevent="saveAuthor">
        <h2>图章署名</h2>
        <p>填写显示在动态图章和批注中的姓名。修改仅对之后添加的内容生效。</p>
        <label>姓名或署名<input ref="authorInput" v-model="authorDraft" :disabled="authorSaving" :aria-invalid="!!authorError" aria-label="姓名或署名" autocomplete="off" placeholder="输入你的姓名，留空则不署名" @input="authorError = ''" /></label>
        <small>设置保存在本机，所有 PDF 文档共用。</small>
        <p v-if="authorError" class="pdf-author-error" role="alert">{{ authorError }}</p>
        <div class="pdf-author-actions"><button type="button" :disabled="authorSaving" @click="closeAuthor">取消</button><button type="submit" :disabled="authorSaving || disabled" class="pdf-author-save">{{ authorSaving ? '正在保存…' : '保存署名' }}</button></div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.rust-pdf-editor{display:flex;flex-direction:column;flex:1;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--ui-bg)}.pdf-viewport{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden}.pdf-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--ui-surface-muted);color:var(--ui-muted);font-size:13px}.pdf-spinner{width:17px;height:17px;border:2px solid var(--ui-line);border-top-color:var(--ui-accent);border-radius:50%;animation:pdf-spin .8s linear infinite}.pdf-error{position:absolute;z-index:2;left:18px;right:18px;bottom:12px;padding:12px 15px;border:1px solid var(--ui-danger);background:var(--ui-danger-soft);color:var(--ui-danger);border-radius:7px;font-size:13px;line-height:1.6}.pdf-author-bar{display:flex;align-items:center;gap:12px;min-width:0;min-height:36px;padding:3px 12px;flex:none;background:var(--ui-surface);border-bottom:1px solid var(--ui-line);font-size:12px;color:var(--ui-muted)}.pdf-author-button{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:5px 7px;border:0;border-radius:6px;background:transparent;color:var(--ui-text);font:inherit;cursor:pointer}.pdf-author-button:hover:not(:disabled){background:var(--ui-surface-muted)}.pdf-author-button>span,.pdf-author-button>.ui-icon{flex:none}.pdf-author-button strong{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}.pdf-author-button:disabled{opacity:.5;cursor:default}.pdf-author-backdrop{position:absolute;inset:0;z-index:10;background:#18213655;display:flex;align-items:center;justify-content:center;padding:20px}.pdf-author-dialog{width:390px;max-width:100%;padding:24px;border:1px solid var(--ui-line);border-radius:16px;background:var(--ui-surface);box-shadow:0 20px 70px #0003;color:var(--ui-text);font-size:13px}.pdf-author-dialog h2{font-size:18px;margin:0 0 12px}.pdf-author-dialog p{line-height:1.7;color:var(--ui-muted)}.pdf-author-dialog label{display:flex;flex-direction:column;gap:8px;margin-top:18px}.pdf-author-dialog input{width:100%;box-sizing:border-box;border:1px solid var(--ui-line);border-radius:7px;padding:9px;background:transparent;font:inherit;color:inherit}.pdf-author-dialog small{display:block;margin-top:10px;line-height:1.6;color:var(--ui-muted)}.pdf-author-dialog .pdf-author-error{color:var(--ui-danger)}.pdf-author-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.pdf-author-actions button{padding:8px 16px;border:0;border-radius:7px;background:var(--ui-surface-muted);color:inherit;font:inherit;cursor:pointer}.pdf-author-actions .pdf-author-save{background:var(--ui-accent);color:#fff}.pdf-author-actions button:disabled{opacity:.5;cursor:default}.pdf-author-button:focus-visible,.pdf-author-dialog input:focus-visible,.pdf-author-dialog button:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}@media(max-width:560px){.pdf-author-hint{display:none}.pdf-author-button strong{max-width:140px}}@keyframes pdf-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.pdf-spinner{animation:none}}
</style>
