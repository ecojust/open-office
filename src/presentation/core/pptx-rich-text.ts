import type { PresentationTextStyle } from '../types'
import type { RichText, RichParagraph, RichRun, RichSpacing } from './rich-text'
import { child, children } from './pptx-common'

export interface RichTextMetadataResolvers {
  paragraph?: (paragraph: Element) => Pick<RichParagraph, 'lineSpacing' | 'spaceBefore' | 'spaceAfter'>
  run?: (paragraph: Element, properties?: Element) => Pick<RichRun, 'baseline' | 'paintUnsupported'>
}

/** Invalid lexical values do not erase valid inherited formatting. */
export function richSpacing(node: Element | undefined): RichSpacing | undefined {
  const value = child(node, 'spcPts') || child(node, 'spcPct')
  const raw = value?.getAttribute('val')?.trim()
  if (!value || !raw) return
  const percent = raw.endsWith('%'), number = Number(percent ? raw.slice(0, -1) : raw)
  if (!Number.isFinite(number) || number < 0 || (percent && value.localName === 'spcPts')) return
  return { unit: value.localName === 'spcPts' ? 'points' : 'percent', value: number / (percent || value.localName === 'spcPts' ? 100 : 100000) }
}

export function richBaseline(properties: Element | undefined): number | undefined {
  const raw = properties?.getAttribute('baseline')?.trim()
  if (!raw) return
  const percent = raw.endsWith('%'), value = Number(percent ? raw.slice(0, -1) : raw)
  return Number.isFinite(value) ? value / (percent ? 100 : 100000) : undefined
}

export function readRichText(body: Element, sourceText: string, sourceStyle: PresentationTextStyle,
  resolve: (paragraph: Element, properties?: Element) => PresentationTextStyle, metadata: RichTextMetadataResolvers = {}): RichText | undefined {
  if (sourceText.length > 100000) return
  const paragraphs = children(body, 'p')
  if (paragraphs.length > 10000) return
  let count = 0
  const parsed: RichParagraph[] = []
  for (const paragraph of paragraphs) {
    const runs: RichRun[] = []
    for (const run of children(paragraph)) {
      if (!['r', 'fld', 'br'].includes(run.localName)) continue
      if (++count > 10000) return
      const properties = child(run, 'rPr')
      runs.push({ text: run.localName === 'br' ? '\n' : child(run, 't')?.textContent || '', ...(run.localName === 'br' ? { kind: 'break' as const } : run.localName === 'fld' ? { kind: 'field' as const } : {}), style: resolve(paragraph, properties), ...metadata.run?.(paragraph, properties) })
    }
    const end = child(paragraph, 'endParaRPr')
    parsed.push({ runs, style: resolve(paragraph, end), ...metadata.run?.(paragraph, end),
      defaultRun: { style: resolve(paragraph), ...metadata.run?.(paragraph) }, ...metadata.paragraph?.(paragraph) })
  }
  return { sourceText, sourceStyle: { ...sourceStyle }, paragraphs: parsed }
}
