import { invoke, isTauri } from '@tauri-apps/api/core'
import type { RustWordCommand, RustWordRequest, RustWordResponse, RustWordSnapshot } from './types'

export interface NativeRustWordSmokeReport {
  schemaVersion: 1
  ok: boolean
  transport: 'tauri-word-engine-request'
  checks: string[]
  cleanup: { attempted: number; closed: number; ok: boolean }
  docxBase64?: string
  paragraphs?: number
  pages?: number
  glyphPaths?: number
  error?: string
  closeError?: string
}

/** Packaged-app smoke: every operation crosses the real Tauri boundary. */
export async function runNativeRustWordSmoke(): Promise<NativeRustWordSmokeReport> {
  const checks: string[] = [], sessions: string[] = []
  const report: NativeRustWordSmokeReport = { schemaVersion: 1, ok: false, checks, transport: 'tauri-word-engine-request', cleanup: { attempted: 0, closed: 0, ok: true } }
  function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message) }
  const raw = (request: RustWordRequest) => invoke<RustWordResponse>('word_engine_request', { request })
  async function send(request: RustWordRequest): Promise<RustWordResponse> {
    const result = await raw(request)
    if (!result?.ok) throw Error(result?.error || 'Rust Word IPC operation failed')
    return result
  }
  function state(response: RustWordResponse, id: string): RustWordSnapshot {
    const value = response.snapshot
    if (!value || value.sessionId !== id || !Number.isSafeInteger(value.revision)) throw Error('Rust Word IPC returned an invalid snapshot')
    return value
  }
  try {
    assert(isTauri(), 'Real Tauri IPC is required for this check')
    const id = `smoke-${crypto.randomUUID()}`
    const created = await send({ op: 'create', sessionId: id })
    sessions.push(id)
    let snapshot = state(created, id)
    assert(!snapshot.dirty && !snapshot.canUndo, 'New document must be clean without undo history')
    checks.push('Real IPC creates a clean Rust-owned document')
    const command = async (value: RustWordCommand) => { snapshot = state(await send({ op: 'command', sessionId: id, expectedRevision: snapshot.revision, command: value }), id); return snapshot }
    const text = 'Rust 正文 中文😀'
    await command({ type: 'replaceText', text: `${text}\nSecond paragraph` })
    assert(snapshot.document.paragraphs.length === 2 && snapshot.dirty && snapshot.canUndo, 'Unicode edit must create two paragraphs and dirty history')
    assert(snapshot.document.paragraphs[0]!.runs.map(run => run.text).join('') === text, 'Unicode text changed across IPC')
    checks.push('Chinese and emoji insertion, paragraph breaks and history stay in Rust')
    await command({ type: 'select', selection: { anchor: { paragraph: 0, offset: 0 }, focus: { paragraph: 0, offset: text.length } } })
    assert(snapshot.selectionText === text, 'UTF-16 selection did not return logical Unicode text')
    const beforeFormat = JSON.stringify(snapshot.document)
    await command({ type: 'format', bold: true, italic: true, fontSize: 14, color: '#C00000' })
    const formatted = JSON.stringify(snapshot.document)
    assert(snapshot.format.bold && snapshot.format.italic && snapshot.format.fontSize === 14 && snapshot.format.color === '#C00000', 'Character format was not applied')
    assert(snapshot.layout.pages.some(page => page.paths.some(path => path.d && path.fill.toUpperCase() === '#C00000')), 'Rust glyph outlines did not carry formatted color')
    await command({ type: 'undo' }); assert(JSON.stringify(snapshot.document) === beforeFormat, 'Undo did not restore the previous document')
    await command({ type: 'redo' }); assert(JSON.stringify(snapshot.document) === formatted, 'Redo did not restore character format')
    await command({ type: 'align', alignment: 'center' })
    assert(snapshot.document.paragraphs[0]!.align === 'center', 'Paragraph alignment was not applied')
    checks.push('Real IPC selection, bold/italic/size/color, alignment and undo/redo match snapshots')
    const exported = await send({ op: 'export', sessionId: id, expectedRevision: snapshot.revision })
    snapshot = state(exported, id)
    assert(typeof exported.base64 === 'string' && exported.base64.length < 1024 * 1024 && atob(exported.base64).startsWith('PK'), 'Export must be a bounded DOCX ZIP')
    assert(snapshot.dirty, 'Export must not mark the document saved')
    report.docxBase64 = exported.base64
    report.paragraphs = snapshot.document.paragraphs.length
    report.pages = snapshot.layout.pages.length
    report.glyphPaths = snapshot.layout.pages.reduce((count, page) => count + page.paths.length, 0)
    const exportedDocument = JSON.stringify(snapshot.document)
    const reopenedId = `smoke-${crypto.randomUUID()}`
    const opened = await send({ op: 'open', sessionId: reopenedId, base64: exported.base64! })
    sessions.push(reopenedId)
    const reopened = state(opened, reopenedId)
    assert(!reopened.dirty && JSON.stringify(reopened.document) === exportedDocument, 'Rust DOCX reopen changed content or formatting')
    assert(reopened.layout.pages.length > 0 && reopened.layout.pages.some(page => page.paths.length > 0), 'Reopened document has no Rust page/glyph layout')
    checks.push('Real IPC DOCX export/reopen preserves text and formatting with Rust glyph paths')
    await command({ type: 'markSaved' }); assert(!snapshot.dirty, 'markSaved did not update the clean baseline')
    const savedRevision = snapshot.revision
    await command({ type: 'replaceText', text: '更新 中文😀' })
    assert(snapshot.dirty && snapshot.revision > savedRevision, 'Post-save edit did not restore dirty state')
    const beforeStale = JSON.stringify(snapshot)
    const stale = await raw({ op: 'command', sessionId: id, expectedRevision: savedRevision, command: { type: 'replaceText', text: 'stale' } })
    assert(stale.ok === false && typeof stale.error === 'string', 'Stale expectedRevision was accepted')
    const unchanged = state(await send({ op: 'export', sessionId: id, expectedRevision: snapshot.revision }), id)
    assert(JSON.stringify(unchanged) === beforeStale, 'Rejected stale request changed the session')
    checks.push('Saved-state tracking and stale-revision failure preserve the current Rust session')
    report.ok = true
  } catch (cause) {
    report.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    for (const sessionId of sessions) {
      report.cleanup.attempted++
      try { await send({ op: 'close', sessionId }); report.cleanup.closed++ }
      catch (cause) { report.ok = false; report.cleanup.ok = false; report.closeError = cause instanceof Error ? cause.message : String(cause) }
    }
  }
  return report
}
