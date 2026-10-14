import type { PresentationParagraphStyle, PresentationSpacing } from '../types'
import type { SlideObject } from './types'
import type { RichParagraph } from './rich-text'
import { effectiveRichText } from './rich-text.ts'
import { A, child, children } from './pptx-common.ts'
import { materializeTextBody, persistTextBody, textRangeBlockedReason } from './text-range-format.ts'

const ORDER = ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst']
function requireValue(value: unknown, message: string): asserts value { if (!value) throw Error(message) }
function spacing(value: PresentationSpacing): PresentationSpacing {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['unit', 'value'].includes(key)), '段落间距格式无效。')
  requireValue(['percent', 'points'].includes(value.unit) && typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && value.value <= (value.unit === 'points' ? 1000 : 10), '间距必须在 0–1000 磅或 0–1000% 之间。')
  const factor = value.unit === 'points' ? 100 : 100000
  return { unit: value.unit, value: Math.round(value.value * factor) / factor }
}
export function normalizedParagraphStyle(input: PresentationParagraphStyle): PresentationParagraphStyle {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), '段落样式无效。')
  requireValue(Object.keys(input).every(key => ['align', 'lineSpacing', 'spaceBefore', 'spaceAfter'].includes(key)), '不支持的段落样式。')
  const output: PresentationParagraphStyle = {}
  if (input.align !== undefined) { requireValue(['left', 'center', 'right', 'justify'].includes(input.align), '段落对齐方式无效。'); output.align = input.align }
  for (const key of ['lineSpacing', 'spaceBefore', 'spaceAfter'] as const) if (input[key] !== undefined) output[key] = spacing(input[key])
  return output
}

/** Select actual a:p nodes. Explicit a:br line breaks are never mistaken for
 * paragraph boundaries. Only requested paragraph properties are changed. */
export function formatParagraphs(object: SlideObject, indices: number[], input: PresentationParagraphStyle, spaceFirstLastParagraph?: boolean): void {
  const reason = textRangeBlockedReason(object)
  requireValue(!reason, reason || '')
  const patch = normalizedParagraphStyle(input)
  requireValue(spaceFirstLastParagraph === undefined || typeof spaceFirstLastParagraph === 'boolean', '首尾段距设置必须为布尔值。')
  requireValue(Object.keys(patch).length || spaceFirstLastParagraph !== undefined, '请至少设置一项段落格式。')
  const body = materializeTextBody(object, undefined, undefined, false), paragraphs = children(body, 'p')
  requireValue(Array.isArray(indices) && indices.length > 0 && indices.length <= paragraphs.length && indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < paragraphs.length) && new Set(indices).size === indices.length, '请选择有效且不重复的段落。')
  const selected = new Set(indices)
  for (const index of indices) {
    const paragraph = paragraphs[index]!
    let properties = child(paragraph, 'pPr')
    if (!properties && Object.keys(patch).length) { properties = body.ownerDocument.createElementNS(A, 'a:pPr'); paragraph.insertBefore(properties, paragraph.firstChild) }
    if (patch.align !== undefined) properties!.setAttribute('algn', { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[patch.align])
    for (const [key, local] of [['lineSpacing', 'lnSpc'], ['spaceBefore', 'spcBef'], ['spaceAfter', 'spcAft']] as const) {
      const value = patch[key]
      if (!value) continue
      requireValue(children(properties!, local).length <= 1, '原段落包含重复间距属性，无法安全修改。')
      const node = body.ownerDocument.createElementNS(A, `a:${local}`), amount = body.ownerDocument.createElementNS(A, value.unit === 'points' ? 'a:spcPts' : 'a:spcPct')
      amount.setAttribute('val', String(Math.round(value.value * (value.unit === 'points' ? 100 : 100000)))); node.appendChild(amount)
      const old = child(properties, local)
      if (old) properties!.replaceChild(node, old)
      else properties!.insertBefore(node, children(properties!).find(element => ORDER.indexOf(element.localName) > ORDER.indexOf(local)) || null)
    }
  }
  if (spaceFirstLastParagraph !== undefined) {
    let properties = child(body, 'bodyPr')
    if (!properties) { properties = body.ownerDocument.createElementNS(A, 'a:bodyPr'); body.insertBefore(properties, body.firstChild) }
    properties.setAttribute('spcFirstLastPara', spaceFirstLastParagraph ? '1' : '0')
  }
  const current: RichParagraph[] = effectiveRichText(object) || object.text.split('\n').map(text => ({ style: { ...object.textStyle }, defaultRun: { style: { ...object.textStyle } }, runs: [{ text, style: { ...object.textStyle } }] }))
  requireValue(current.length === paragraphs.length, '段落预览与原文结构不一致，原文档未改变。')
  const formatted = current.map((paragraph, index) => {
    if (!selected.has(index)) return paragraph
    const { align, ...spaces } = patch
    return { ...paragraph, ...spaces, ...(align === undefined ? {} : {
      style: { ...paragraph.style, align },
      ...(paragraph.defaultRun ? { defaultRun: { ...paragraph.defaultRun, style: { ...paragraph.defaultRun.style, align } } } : {}),
      runs: paragraph.runs.map(run => ({ ...run, style: { ...run.style, align } })),
    }) }
  })
  persistTextBody(object, body, formatted, spaceFirstLastParagraph)
}
