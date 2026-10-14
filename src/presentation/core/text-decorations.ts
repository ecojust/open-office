import type { PresentationDecoration, PresentationTextStyle } from '../types'

type DecorationStyle = Pick<Partial<PresentationTextStyle>, 'underline' | 'underlineStyle' | 'strike'>
export function underlineKind(style: DecorationStyle): PresentationDecoration {
  if (style.underline === false || style.underlineStyle === 'none') return 'none'
  return style.underlineStyle === 'double' ? 'double' : style.underline || style.underlineStyle === 'single' ? 'single' : 'none'
}
export function strikeKind(style: DecorationStyle): PresentationDecoration {
  return style.strike === 'single' || style.strike === 'double' ? style.strike : 'none'
}
export interface TextDecorationLine { kind: 'underline' | 'strike'; offset: number; thickness: number }

/** Ordinary text-color decorations, measured from the fragment's own baseline.
 * Underline retains the editor's 0.1em position; actual font-specific underline
 * metrics and custom uLn/uFill are deliberately outside this basic geometry. */
export function textDecorationLines(style: DecorationStyle, size: number): TextDecorationLine[] {
  if (!Number.isFinite(size) || size <= 0) return []
  const thickness = size / 18, result: TextDecorationLine[] = []
  for (const [kind, value, offset] of [['underline', underlineKind(style), size * .1], ['strike', strikeKind(style), -size * .27]] as const) {
    if (value === 'single') result.push({ kind, offset, thickness })
    else if (value === 'double') result.push({ kind, offset: offset - thickness / 2, thickness }, { kind, offset: offset + thickness * 1.5, thickness })
  }
  return result
}
export function textDecorationBounds(style: DecorationStyle, size: number) {
  let ascent = 0, descent = 0
  for (const line of textDecorationLines(style, size)) { ascent = Math.max(ascent, -line.offset + line.thickness / 2); descent = Math.max(descent, line.offset + line.thickness / 2) }
  return { ascent, descent }
}
