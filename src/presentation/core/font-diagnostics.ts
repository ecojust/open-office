import type { PresentationModel, SlideObject } from './types'
import type { RichParagraph } from './rich-text'

export type FontAvailability = 'available' | 'possibly-substituted' | 'unknown'
export interface PresentationFonts { names: string[]; truncated: boolean }
export type FontProbeContext = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>

const MAX_NAME_LENGTH = 128
const MAX_FONTS = 256
const MAX_VISITS = 20000
const MAX_TEXT = 1_000_000
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'])
const GLOBAL_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])

function validName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_NAME_LENGTH) return
  const name = value.trim()
  if (!name || /[\u0000-\u001f\u007f]/.test(name) || GLOBAL_KEYWORDS.has(name.toLowerCase())) return
  return name
}

/** Read only the fonts of modeled, currently displayed text. This does not
 * inspect original XML, cached SmartArt bitmaps or embedded document contents.
 * Collection is bounded independently of untrusted object/paragraph counts. */
export function collectPresentationFonts(model: PresentationModel, limit = 64): PresentationFonts {
  const maximum = Number.isFinite(limit) ? Math.min(MAX_FONTS, Math.max(0, Math.floor(limit))) : 64
  const names: string[] = [], seenNames = new Set<string>(), seenObjects = new WeakSet<object>()
  let truncated = false, visits = 0, textBudget = 0
  const visit = () => { if (++visits <= MAX_VISITS) return true; truncated = true; return false }
  const readText = (value: string) => { textBudget += value.length; if (textBudget <= MAX_TEXT) return true; truncated = true; return false }
  const add = (value: unknown) => {
    const name = validName(value)
    if (!name) { truncated = true; return true } // Do not expose unsafe/oversized names in the UI.
    if (seenNames.has(name.toLowerCase())) return true
    if (names.length >= maximum) { truncated = true; return false }
    seenNames.add(name.toLowerCase()); names.push(name); return true
  }
  const addRichParagraph = (paragraph: RichParagraph, override?: string): boolean => {
    if (!visit()) return false
    let hasContent = false, trailingBreak = false
    for (const run of paragraph.runs) {
      if (!visit() || !readText(run.text)) return false
      // Ordinary empty runs do not contribute display metrics. Explicit breaks
      // do, and a trailing break leaves an empty line using paragraph-end style.
      const text = run.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n')
      if (!text) continue
      hasContent = true; trailingBreak = text.endsWith('\n')
      if (!add(override ?? run.style.fontName)) return false
    }
    return hasContent && !trailingBreak || add(override ?? paragraph.style.fontName)
  }
  const addObject = (object: SlideObject, depth: number): boolean => {
    if (!visit()) return false
    if (depth > 64) { truncated = true; return true }
    if (seenObjects.has(object)) return true
    seenObjects.add(object)
    if (['text', 'rectangle', 'ellipse'].includes(object.type) && object.text) {
      const rich = object.richText
      if (!rich) { if (!add(object.textStyle.fontName)) return false }
      else {
        // Match effectiveRichText's font merge without allocating an unbounded
        // copy. Explicit applications remain effective when equal to baseline.
        const override = object.textStyleOverrides?.fontName ?? (object.textStyle.fontName !== rich.sourceStyle.fontName ? object.textStyle.fontName : undefined)
        if (object.text === rich.sourceText) {
          for (const paragraph of rich.paragraphs) if (!addRichParagraph(paragraph, override)) return false
        } else {
          if (!readText(object.text)) return false
          for (const [index, text] of object.text.split('\n').entries()) {
            if (!visit()) return false
            const original = rich.paragraphs[Math.min(index, rich.paragraphs.length - 1)]
            let previous = ''
            if (original) for (const run of original.runs) {
              if (!visit() || !readText(run.text)) return false
              previous += run.text
            }
            if (original && previous === text) { if (!addRichParagraph(original, override)) return false }
            else {
              const template = text ? original?.runs[0]?.style || original?.defaultRun?.style || original?.style || rich.sourceStyle : original?.style || rich.sourceStyle
              if (!add(override ?? template.fontName)) return false
            }
          }
        }
      }
    } else if (object.type === 'table' && object.table) {
      for (const [r, row] of object.table.cells.entries()) for (const [c, text] of row.entries()) {
        if (!visit()) return false
        const rich = object.tableCellText?.[r]?.[c]?.richText
        if (rich && text) { for (const paragraph of rich.paragraphs) if (!addRichParagraph(paragraph)) return false }
        else if (text && !add(object.textStyle.fontName)) return false
      }
    } else if (object.type === 'chart' && object.chart) {
      // The current generated chart labels use the shared scene's generic font.
      if (!add('sans-serif')) return false
    }
    for (const child of object.children || []) if (!addObject(child, depth + 1)) return false
    return true
  }
  for (const slide of model.slides) {
    if (!visit()) break
    let complete = true
    for (const objects of [slide.inheritedObjects || [], slide.objects]) {
      for (const object of objects) if (!addObject(object, 0)) { complete = false; break }
      if (!complete) break
    }
    if (!complete) break
  }
  return { names, truncated }
}

/** Quote one literal CSS font family, never a caller-provided family list. */
function quoteFamily(name: string): string { return '"' + name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' }
const SAMPLES = ['Hamburgefontsiv AVWilm 0123456789', 'iiii MMMM WWWW 1234567890', '汉字中文天地永和国', '漢字かなカナ一二三']
const FALLBACKS = ['monospace', 'serif', 'sans-serif']

/** Conservative synchronous heuristic, not a font inventory or glyph-coverage
 * guarantee. Aliases and metrically identical substitutes can be inconclusive;
 * an available font can still substitute individual missing glyphs. This does
 * not register fonts or call font-loading APIs (the browser can use already
 * declared @font-face resources). FontFaceSet.check() is not treated as proof
 * of an installed font. The caller owns per-font caches and invalidates them after
 * document/font-loading changes; this module keeps no persistent probe cache. */
export function probeFontAvailability(fontName: string, context: FontProbeContext | null | undefined): FontAvailability {
  const name = validName(fontName)
  if (!name) return 'unknown'
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return 'available'
  if (!context) return 'unknown'
  let original: string | undefined
  try {
    original = context.font
    let differs = false
    for (const fallback of FALLBACKS) {
      const baselineFont = `48px ${fallback}`, candidateFont = `48px ${quoteFamily(name)}, ${fallback}`
      for (const sample of SAMPLES) {
        context.font = baselineFont
        const canonicalBaseline = context.font
        if (!canonicalBaseline || !/48px\s/.test(canonicalBaseline)) return 'unknown'
        const baseline = context.measureText(sample)
        context.font = candidateFont
        // Invalid Canvas font assignments may be silently ignored. Comparing
        // against the just-applied fallback prevents stale state proving a font.
        if (context.font === canonicalBaseline) return 'unknown'
        const candidate = context.measureText(sample)
        if (!Number.isFinite(baseline.width) || !Number.isFinite(candidate.width) || baseline.width <= 0 || candidate.width <= 0) return 'unknown'
        const fields = ['width', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent'] as const
        for (const field of fields) {
          const a = baseline[field], b = candidate[field]
          if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > Math.max(.01, Math.abs(a) * .00001)) differs = true
        }
      }
    }
    return differs ? 'available' : 'possibly-substituted'
  } catch { return 'unknown' }
  finally { if (original !== undefined) { try { context.font = original } catch { /* A lost context cannot be restored. */ } } }
}
