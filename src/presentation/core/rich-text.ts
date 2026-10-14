import type { PresentationTextStyle } from '../types'
import type { SlideObject } from './types'

/** Percentage values are ratios (150% = 1.5); points remain points. */
export interface RichSpacing { unit: 'percent' | 'points'; value: number }
export interface RichRun { text: string; style: PresentationTextStyle; /** Unsupported source paint cannot be edited as an ordinary solid. */ paintUnsupported?: boolean; /** Explicit line-break/field nodes are not ordinary editable runs. */ kind?: 'break' | 'field'; /** Positive fraction of this run's font size raises its baseline. */ baseline?: number }
export interface RichParagraph {
  runs: RichRun[]
  /** endParaRPr supplies display metrics only for empty paragraphs. */
  style: PresentationTextStyle
  baseline?: number
  paintUnsupported?: boolean
  /** Insertion inherits paragraph defaults, not endParaRPr. */
  defaultRun?: Omit<RichRun, 'text'>
  lineSpacing?: RichSpacing
  spaceBefore?: RichSpacing
  spaceAfter?: RichSpacing
}
/** Derived display data only. Original DrawingML remains the export authority. */
export interface RichText { sourceText: string; sourceStyle: PresentationTextStyle; spaceFirstLastParagraph?: boolean; paragraphs: RichParagraph[] }

/** Mirrors plain-text export's paragraph-template policy and applies only
 * changed toolbar attributes. Geometry edits never flatten mixed formatting. */
export function effectiveRichText(object: SlideObject): RichParagraph[] | undefined {
  const rich = object.richText
  if (!rich) return
  const changed: Partial<PresentationTextStyle> = {}
  for (const key of new Set([...Object.keys(rich.sourceStyle), ...Object.keys(object.textStyle)]) as Set<keyof PresentationTextStyle>) {
    if (object.textStyle[key] !== rich.sourceStyle[key]) Object.assign(changed, { [key]: object.textStyle[key] })
  }
  Object.assign(changed, object.textStyleOverrides)
  let paragraphs = rich.paragraphs
  if (object.text !== rich.sourceText) paragraphs = object.text.split('\n').map((text, index) => {
    const original = rich.paragraphs[Math.min(index, rich.paragraphs.length - 1)]
    if (original && original.runs.map(run => run.text).join('') === text) return original
    const template = original?.runs[0] || original?.defaultRun || { style: original?.style || rich.sourceStyle, baseline: original?.baseline }
    return { ...original, style: original?.style || rich.sourceStyle, runs: [{ ...template, kind: undefined, text }] }
  })
  const update = <T extends { style: PresentationTextStyle; paintUnsupported?: boolean }>(value: T): T => {
    const result = { ...value, style: { ...value.style, ...changed } }
    if (Object.hasOwn(changed, 'color')) delete result.paintUnsupported
    return result
  }
  return paragraphs.map(paragraph => ({ ...update(paragraph),
    ...(paragraph.defaultRun ? { defaultRun: update(paragraph.defaultRun) } : {}),
    runs: paragraph.runs.map(update) }))
}
