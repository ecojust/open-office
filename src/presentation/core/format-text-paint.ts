import type { PresentationTextStyle } from '../types'
import type { SlideObject } from './types'
import type { RichParagraph } from './rich-text'
import { effectiveRichText } from './rich-text.ts'
import { A, child, children } from './pptx-common.ts'
import { materializeTextBody, persistTextBody, textRangeBlockedReason } from './text-range-format.ts'
import { ensureRunProperties, patchTextPaint } from './text-paint.ts'

type PaintPatch = Pick<Partial<PresentationTextStyle>, 'color' | 'opacity'>
function updated<T extends { style: PresentationTextStyle; paintUnsupported?: boolean }>(value: T, patch: PaintPatch): T {
  const result = { ...value, style: { ...value.style, ...patch } }
  if (patch.color !== undefined) delete result.paintUnsupported
  return result
}
function ordinaryParagraphs(object: SlideObject): RichParagraph[] {
  return effectiveRichText(object) || object.text.split('\n').map(text => ({ style: { ...object.textStyle }, defaultRun: { style: { ...object.textStyle } }, runs: [{ text, style: { ...object.textStyle } }] }))
}
function prepared(object: SlideObject, patch: PaintPatch) {
  const reason = textRangeBlockedReason(object); if (reason) throw Error(reason)
  const body = materializeTextBody(object, undefined, undefined, false), current = ordinaryParagraphs(object), paragraphs = children(body, 'p'), output: RichParagraph[] = []
  if (paragraphs.length !== current.length) throw Error('文字段落与预览不一致，原文档未改变。')
  for (const [index, paragraph] of paragraphs.entries()) {
    const metadata = current[index]!, runs = children(paragraph).filter(node => ['r', 'br'].includes(node.localName))
    if (runs.length !== metadata.runs.length) throw Error('文字片段与预览不一致，原文档未改变。')
    const changedRuns = []
    for (const [runIndex, run] of runs.entries()) {
      const meta = metadata.runs[runIndex]!
      const properties = ensureRunProperties(run.cloneNode(true) as Element)
      try { patchTextPaint(properties, patch, meta.style, body, paragraph, meta.paintUnsupported) }
      catch (error) { if (patch.color === undefined && meta.kind === 'break') { changedRuns.push(meta); continue } throw error }
      const previous = child(run, 'rPr')
      if (previous) previous.replaceWith(properties); else run.insertBefore(properties, run.firstChild)
      changedRuns.push(updated(meta, patch))
    }
    const visibleText = metadata.runs.some(run => !run.kind && run.text.length > 0)
    const patchDefault = (kind: 'defRPr' | 'endParaRPr', style: PresentationTextStyle, unsupported?: boolean): boolean => {
      const parent = kind === 'defRPr' ? child(paragraph, 'pPr') : paragraph, original = child(parent, kind)
      const candidate = original?.cloneNode(true) as Element || body.ownerDocument.createElementNS(A, `a:${kind}`)
      try { patchTextPaint(candidate, patch, style, body, paragraph, unsupported) }
      catch (error) {
        // A nonempty paragraph's unpainted/unsupported end and default style
        // is not a visible run. Preserve it rather than guessing a donor from
        // the first glyph, or rejecting an otherwise safe direct run edit.
        if (patch.color === undefined && visibleText) return false
        throw error
      }
      if (original) original.replaceWith(candidate)
      else if (kind === 'endParaRPr') paragraph.append(candidate)
      else {
        let pPr = parent
        if (!pPr) { pPr = body.ownerDocument.createElementNS(A, 'a:pPr'); paragraph.insertBefore(pPr, paragraph.firstChild) }
        pPr.insertBefore(candidate, child(pPr, 'extLst') || null)
      }
      return true
    }
    const endChanged = patchDefault('endParaRPr', metadata.style, metadata.paintUnsupported)
    const defaultsChanged = patchDefault('defRPr', metadata.defaultRun?.style || metadata.style, metadata.defaultRun?.paintUnsupported)
    output.push({ ...(endChanged ? updated(metadata, patch) : metadata), ...(metadata.defaultRun ? { defaultRun: defaultsChanged ? updated(metadata.defaultRun, patch) : metadata.defaultRun } : {}), runs: changedRuns })
  }
  return { body, paragraphs: output }
}

/** A paint edit commits each run's effective alpha individually. Generic font
 * edits remain attribute-only and never flatten a mixed-alpha paragraph. */
export function formatWholeTextPaint(object: SlideObject, patch: PaintPatch): void {
  if (patch.color === undefined && patch.opacity === undefined) return
  // Whole-frame recolor never splits runs. Keep the existing safe path for
  // fields, links and extensions; the exporter patches each original rPr
  // with that run's effective alpha. Range guards apply only to operations
  // that materialize/split a replacement body, not to this existing action.
  if (patch.color !== undefined && patch.opacity === undefined) {
    object.textStyle = { ...object.textStyle, color: patch.color }
    if (object.richText || object.sourceXml) object.textStyleOverrides = { ...object.textStyleOverrides, color: patch.color }
    return
  }
  if (!object.sourceXml && !object.richText && !object.textBodyOverride) { object.textStyle = { ...object.textStyle, ...patch }; return }
  const { body, paragraphs } = prepared(object, patch)
  object.textStyle = { ...object.textStyle, ...patch }
  persistTextBody(object, body, paragraphs)
}

/** Whole-text UI preflight; the action repeats this against current state. */
export function textOpacityBlockedReason(object: SlideObject): string | undefined {
  try {
    if (!object.sourceXml && !object.richText && !object.textBodyOverride) return textRangeBlockedReason(object)
    prepared(object, { opacity: object.textStyle.opacity ?? 1 })
  } catch (error) { return error instanceof Error ? error.message : '文字填充暂不支持独立透明度。' }
}
