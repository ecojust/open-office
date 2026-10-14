import type { PresentationTextStyle } from '../types'
import type { RichParagraph, RichRun, RichSpacing } from './rich-text'
import { textDecorationBounds } from './text-decorations.ts'

export interface RichFragment { text: string; style: PresentationTextStyle; size: number; width: number; baselineOffset: number }
export interface RichLine {
  fragments: RichFragment[]; width: number; ascent: number; descent: number; inkAscent: number; inkDescent: number
  /** Baseline advance; explicit spacing may be smaller than the ink bounds. */
  height: number; naturalHeight: number; textHeight: number; fontSize: number
  baseline: number; top: number; bottom: number
  paragraphIndex: number; spaceBefore: number; spaceAfter: number
  align: PresentationTextStyle['align']; last: boolean
}
export interface RichLayoutOptions { spaceFirstLastParagraph?: boolean }

const PT_TO_MM = 25.4 / 72
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
const sizeOf = (style: PresentationTextStyle) => Math.max(.35, Math.min(400, Number.isFinite(style.fontSize) ? style.fontSize : 18)) * PT_TO_MM
const valid = (value: number, fallback: number) => Number.isFinite(value) && value >= 0 ? Math.min(value, 1e7) : fallback
const baselineOffset = (baseline: number | undefined, size: number) => Number.isFinite(baseline) ? Math.max(-1e7, Math.min(1e7, baseline! * size)) : 0
// OOXML spcPct uses the largest font size on the relevant line, independently
// of baseline offsets, glyph shapes, or a separately requested line advance.
const spacing = (value: RichSpacing | undefined, naturalHeight: number, fallback: number) => value ? valid(value.value * (value.unit === 'points' ? PT_TO_MM : naturalHeight), fallback) : fallback

/** Include actual shifted glyph extents as well as requested outer spacing. */
export function richTextBounds(lines: RichLine[]) {
  let top = 0, bottom = 0
  for (const line of lines) { top = Math.min(top, line.top); bottom = Math.max(bottom, line.bottom) }
  bottom = Math.max(bottom, (lines.at(-1)?.bottom || 0) + (lines.at(-1)?.spaceAfter || 0))
  return { top, bottom, height: bottom - top }
}

/** Measurements use each run's font, and every line shares its maximum
 * ascent/descent. Renderers consume identical baseline and wrap decisions. */
export function layoutRichText(paragraphs: RichParagraph[], width: number, wrap: boolean,
  measure: (text: string, style: PresentationTextStyle, size: number) => number,
  metrics: (text: string, style: PresentationTextStyle, size: number) => { ascent: number; descent: number }, options: RichLayoutOptions = {}): RichLine[] {
  const result: RichLine[] = []
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const start = result.length
    let fragments: RichFragment[] = [], lineWidth = 0
    const flush = (last: boolean) => {
      const measurements = fragments.length ? fragments : [{ text: '', style: paragraph.style, size: sizeOf(paragraph.style), width: 0, baselineOffset: baselineOffset(paragraph.baseline, sizeOf(paragraph.style)) }]
      let ascent = 0, descent = 0, textAscent = 0, textDescent = 0, minimumHeight = 0, fontSize = 0, inkAscent = -Infinity, inkDescent = -Infinity
      const hasInk = measurements.some(item => item.text.length)
      for (const item of measurements) {
        const bounds = metrics(item.text || 'Mg', item.style, item.size)
        const decorations = textDecorationBounds(item.style, item.size)
        textAscent = Math.max(textAscent, valid(bounds.ascent, item.size * 1.16))
        textDescent = Math.max(textDescent, valid(bounds.descent, item.size * .288))
        ascent = Math.max(ascent, Math.max(valid(bounds.ascent, item.size * 1.16), decorations.ascent) + item.baselineOffset)
        descent = Math.max(descent, Math.max(valid(bounds.descent, item.size * .288), decorations.descent) - item.baselineOffset)
        minimumHeight = Math.max(minimumHeight, item.size * 1.25)
        fontSize = Math.max(fontSize, item.size)
        if (item.text || !hasInk) {
          inkAscent = Math.max(inkAscent, Math.max(valid(bounds.ascent, item.size * 1.16), decorations.ascent) + item.baselineOffset)
          inkDescent = Math.max(inkDescent, Math.max(valid(bounds.descent, item.size * .288), decorations.descent) - item.baselineOffset)
        }
      }
      const naturalHeight = Math.max(minimumHeight, ascent + descent)
      result.push({ fragments, width: lineWidth, ascent, descent, inkAscent, inkDescent, naturalHeight, fontSize, textHeight: textAscent + textDescent, height: spacing(paragraph.lineSpacing, fontSize, naturalHeight),
        baseline: 0, top: 0, bottom: 0, paragraphIndex, spaceBefore: 0, spaceAfter: 0, align: paragraph.style.align, last })
      fragments = []; lineWidth = 0
    }
    const append = (text: string, style: PresentationTextStyle, baseline?: number) => {
      const size = sizeOf(style), offset = baselineOffset(baseline, size), previous = fragments.at(-1)
      if (previous?.style === style && previous.baselineOffset === offset) {
        lineWidth -= previous.width
        previous.text += text
        previous.width = valid(measure(previous.text, style, size), previous.text.length * size)
        lineWidth += previous.width
      } else {
        const measured = valid(measure(text, style, size), text.length * size)
        fragments.push({ text, style, size, width: measured, baselineOffset: offset }); lineWidth += measured
      }
    }
    const finishParagraph = () => {
      const first = result[start]!, last = result.at(-1)!
      first.spaceBefore = paragraphIndex > 0 || options.spaceFirstLastParagraph ? spacing(paragraph.spaceBefore, first.fontSize, 0) : 0
      last.spaceAfter = paragraphIndex < paragraphs.length - 1 || options.spaceFirstLastParagraph ? spacing(paragraph.spaceAfter, last.fontSize, 0) : 0
    }
    if (!wrap) {
      // A long unwrapped paragraph must not repeatedly remeasure every prefix.
      for (const run of paragraph.runs) {
        const text = clean(run.text)
        if (!text) continue // Empty ordinary runs have no glyphs; endParaRPr owns empty-line metrics.
        const sections = text.split('\n')
        sections.forEach((text, index) => {
          if (index) { if (!fragments.length) append('', run.style, run.baseline); flush(true) }
          if (text || !index) append(text, run.style, run.baseline)
        })
      }
      flush(true)
      finishParagraph()
      continue
    }
    // Tokenize across style boundaries: changing color inside a word does not
    // create an artificial line-break opportunity.
    const tokens: Array<{ kind: 'word' | 'space' | 'break'; chunks: RichRun[] }> = []
    for (const run of paragraph.runs) for (const text of clean(run.text).match(/\n|[^\S\n]+|[^\s]+/gu) || []) {
      const kind = text === '\n' ? 'break' : /^\s+$/.test(text) ? 'space' : 'word'
      const previous = tokens.at(-1)
      if (kind !== 'break' && previous?.kind === kind) previous.chunks.push({ ...run, text })
      else tokens.push({ kind, chunks: [{ ...run, text }] })
    }
    let pending: RichRun[] = []
    const widthOf = (chunks: typeof pending) => chunks.reduce((sum, chunk) => sum + valid(measure(chunk.text, chunk.style, sizeOf(chunk.style)), chunk.text.length * sizeOf(chunk.style)), 0)
    const appendChunks = (chunks: typeof pending) => chunks.forEach(chunk => append(chunk.text, chunk.style, chunk.baseline))
    for (const token of tokens) {
      if (token.kind === 'break') { appendChunks(pending); pending = []; append('', token.chunks[0]!.style, token.chunks[0]!.baseline); flush(true); continue }
      if (token.kind === 'space') { pending.push(...token.chunks); continue }
      const tokenWidth = widthOf(token.chunks)
      if (lineWidth && lineWidth + widthOf(pending) + tokenWidth > width) {
        flush(false); pending = [] // Soft-wrap whitespace is not an empty visual line.
      }
      appendChunks(pending); pending = []
      if (tokenWidth <= width) { appendChunks(token.chunks); continue }
      // Long CJK words/URLs still wrap without dropping glyphs or run styles.
      for (const chunk of token.chunks) for (const glyph of chunk.text) {
        const size = sizeOf(chunk.style), previous = fragments.at(-1)
        const candidateWidth = previous?.style === chunk.style && previous.baselineOffset === baselineOffset(chunk.baseline, size)
          ? lineWidth - previous.width + valid(measure(previous.text + glyph, chunk.style, size), size)
          : lineWidth + valid(measure(glyph, chunk.style, size), size)
        if (lineWidth && candidateWidth > width) flush(false)
        append(glyph, chunk.style, chunk.baseline)
      }
    }
    appendChunks(pending)
    flush(true)
    finishParagraph()
  }
  for (const [index, line] of result.entries()) {
    const previous = result[index - 1]
    if (!previous) line.baseline = line.spaceBefore + line.ascent
    else if (previous.paragraphIndex !== line.paragraphIndex) {
      line.baseline = previous.baseline + previous.height - previous.ascent + Math.max(previous.spaceAfter, line.spaceBefore) + line.ascent
    } else if (paragraphs[line.paragraphIndex]?.lineSpacing) {
      line.baseline = previous.baseline + line.height
    } else line.baseline = previous.baseline + previous.height - previous.ascent + line.ascent
    line.top = line.baseline - line.inkAscent
    line.bottom = line.baseline + line.inkDescent
  }
  return result
}
