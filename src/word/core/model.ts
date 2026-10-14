import { assertSupportedWordText } from './scripts.ts'
import { isHighlightColor, type HighlightColor } from './highlight.ts'
import { normalizeBackgroundColor, type BackgroundColor } from './background.ts'
import { normalizePaperDimension } from './paper.ts'

/** Independent paragraph/run model. No UNO or LibreOffice runtime dependency. */
export type ScriptAlignment = 'baseline' | 'superscript' | 'subscript'
/** Custom alignment is an integer percentage of native font height, without glyph scaling. */
export type VerticalAlignment = ScriptAlignment | number
export interface TextStyle {
  bold?: boolean
  italic?: boolean
  /** Boolean single/none values retain compatibility; undefined inherits. */
  underline?: boolean | 'double'
  /** Independent underline paint; auto follows the text color, even when the line is off. */
  underlineColor?: UnderlineColor
  strike?: 'none' | 'single' | 'double'
  /** Display-only casing; original text and UTF-16 selection offsets never change. */
  caseMap?: 'none' | 'upper' | 'smallCaps'
  /** Script or custom baseline positioning never changes the logical font size. */
  verticalAlign?: VerticalAlignment
  fontSize?: number
  fontName?: string
  fontNameEastAsia?: string
  fontNameCs?: string
  color?: string
  highlight?: HighlightColor
  backgroundColor?: BackgroundColor
  language?: string
  languageEastAsia?: string
  languageBidi?: string
  fontSizeCs?: number
  /** Original OOXML threshold in points; Writer renders any nonzero value as enabled. */
  kerning?: number
  /** Signed character tracking in points; 0 explicitly clears inherited spacing. */
  letterSpacing?: number
}
export interface ParagraphStyle {
  align?: 'left' | 'center' | 'right' | 'justify'
  heading?: 0 | 1 | 2 | 3
  spaceBefore?: number
  spaceAfter?: number
  /** Physical LTR indentation in points; negative first-line means hanging. */
  indentLeft?: number
  indentRight?: number
  indentFirstLine?: number
  widowControl?: boolean
  keepNext?: boolean
  keepLines?: boolean
  suppressAutoHyphens?: boolean
  /** A multiple for auto, points for exact / atLeast. */
  lineHeight?: number
  lineHeightRule?: 'auto' | 'exact' | 'atLeast'
}
export interface WordRun {
  text: string; style: TextStyle
  /** Undefined means style itself is direct; an explicit empty object means entirely inherited. */
  directStyle?: TextStyle
  /** Script inherited from a named character style, distinct from hard escapement. */
  sourceVerticalAlign?: ScriptAlignment
}
/** Character format of the paragraph mark, independent of visible body runs. */
export interface ParagraphMarkerFormat {
  style: TextStyle
  /** Undefined means style itself is direct, matching older run models. */
  directStyle?: TextStyle
  sourceVerticalAlign?: ScriptAlignment
}
export interface WordParagraph {
  id: string; runs: WordRun[]; style: ParagraphStyle
  marker?: ParagraphMarkerFormat
  /** Live end-caret attributes after deleting custom-offset text. Never serialized to DOCX. */
  sessionInsertion?: ParagraphMarkerFormat
  /** Effective inherited character style, separate from individual direct overrides. */
  sourceRun?: TextStyle
  /** Inherited paragraph format before direct overrides. */
  sourceParagraph?: ParagraphStyle
  /** Direct paragraph attributes; undefined treats style as direct for older in-memory models. */
  directStyle?: ParagraphStyle
  /** Effective style to use when Enter splits at the end of this paragraph. */
  nextParagraphStyle?: { paragraph: ParagraphStyle; run: TextStyle; sourceRun?: TextStyle }
}
/** All paper dimensions and margins are points. */
export interface WordPage {
  width: number
  height: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
  /** Independent stored flag; changing it alone does not swap dimensions. */
  orientation?: 'portrait' | 'landscape'
}
export interface WordDocument {
  paragraphs: WordParagraph[]
  page: WordPage
  defaultTabStop?: number
  autoHyphenation?: boolean
  /** Known OPC metadata only; the codec validates XML and relationships on import and export. */
  packageMetadata?: { fontTable?: string; theme?: string; coreProperties?: string; extendedProperties?: string }
}
/** Offsets count UTF-16 units, matching browser Selection and Range. */
export interface WordPoint { paragraph: number; offset: number }
export interface WordSelection { anchor: WordPoint; focus: WordPoint }
export const WORD_LIMITS = { paragraphs: 5000, characters: 250000, runs: 50000, metadataCharacters: 256 * 1024, historyEntries: 100, historyBytes: 8 * 1024 * 1024 } as const
/** Deliberately bounded tracking subset; OOXML uses integer twentieths of a point. */
export const LETTER_SPACING_LIMITS = { min: -20, max: 20, step: 0.05 } as const
export const BASELINE_OFFSET_LIMITS = { min: -100, max: 100, step: 1 } as const
export const PARAGRAPH_SPACING_LIMITS = { min: 0, max: 1584, step: 0.05 } as const
/** Writer's point-valued line item stores integer mm100 in a signed short. */
export const POINT_LINE_HEIGHT_LIMITS = { min: 0.05, max: 928.8, step: 0.05 } as const
/** Continuous percentage range that survives native Writer's repeated rounding. */
export const AUTO_LINE_HEIGHT_LIMITS = { min: 0.01, max: 3.33, step: 0.01 } as const
export const PAGE_SIZE_LIMITS = { min: 72, max: 1584, step: 0.05 } as const
export const PAGE_MARGIN_LIMITS = { min: 0, max: 1584, step: 0.05 } as const
/** Families with independently checked native ascent/descent offset metrics. */
export const BASELINE_OFFSET_FONTS = ['Times New Roman', 'DejaVu Sans', 'Liberation Serif'] as const
const baselineOffsetFontNames = new Set<string>(BASELINE_OFFSET_FONTS.map(name => name.toLowerCase()))
export type UnderlineColor = `#${string}` | 'auto'

/** The model's auto means text-color paint, not OOXML's incompatible color="auto" token. */
export function normalizeUnderlineColor(value: unknown): UnderlineColor {
  if (value === 'auto') return value
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw Error('下划线颜色必须是六位 RGB 颜色或跟随文字。')
  return value.toUpperCase() as UnderlineColor
}

export function normalizeVerticalAlign(value: unknown): VerticalAlignment {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < BASELINE_OFFSET_LIMITS.min || value > BASELINE_OFFSET_LIMITS.max) throw Error('基线偏移请使用 -100% 到 100% 之间的整数百分比。')
    return value === 0 ? 'baseline' : value
  }
  if (value !== 'baseline' && value !== 'superscript' && value !== 'subscript') throw Error('上下标或基线偏移格式无效。')
  return value
}

/** Named character styles currently support script positioning only. */
export function normalizeSourceVerticalAlign(value: unknown): ScriptAlignment {
  if (value !== 'baseline' && value !== 'superscript' && value !== 'subscript') throw Error('字符样式来源暂只支持标准上下标或基线。')
  return value
}

const clone = <T>(value: T): T => structuredClone(value)
const fail = (message: string): never => { throw Error(message) }
export function paragraphText(paragraph: WordParagraph): string { return paragraph.runs.map(run => run.text).join('') }
export function documentText(model: WordDocument): string { return model.paragraphs.map(paragraphText).join('\n') }
/** Older in-memory documents have no explicit paragraph base. Keep inherited
 * keys and remove known direct attributes instead of baking overrides in. */
export function inheritedParagraphStyle(paragraph: WordParagraph): ParagraphStyle {
  if (paragraph.sourceParagraph !== undefined) return { ...paragraph.sourceParagraph }
  const inherited = { ...paragraph.style }
  for (const key of Object.keys(paragraph.directStyle ?? paragraph.style) as Array<keyof ParagraphStyle>) delete inherited[key]
  if (inherited.lineHeight === undefined) delete inherited.lineHeightRule
  return inherited
}
export function createWordDocument(): WordDocument {
  return {
    paragraphs: [{ id: crypto.randomUUID(), style: {}, runs: [{ text: '', style: {} }] }],
    page: { width: 595.3, height: 841.9, marginTop: 72, marginRight: 72, marginBottom: 72, marginLeft: 72 },
  }
}
function number(value: unknown, min: number, max: number, title: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${title}超出支持范围。`)
  return value as number
}
function textStyle(input: TextStyle): TextStyle {
  if (!input || typeof input !== 'object') return fail('字符格式无效。')
  const out: TextStyle = {}
  for (const key of ['bold', 'italic'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') fail('字符格式必须使用有效的开关值。')
    out[key] = input[key]
  }
  if (input.underline !== undefined) {
    if (typeof input.underline !== 'boolean' && input.underline !== 'double') fail('下划线格式无效。')
    out.underline = input.underline
  }
  if (input.underlineColor !== undefined) out.underlineColor = normalizeUnderlineColor(input.underlineColor)
  if (input.strike !== undefined) {
    if (!['none', 'single', 'double'].includes(input.strike)) fail('删除线格式无效。')
    out.strike = input.strike
  }
  if (input.caseMap !== undefined) {
    if (!['none', 'upper', 'smallCaps'].includes(input.caseMap)) fail('文字大小写显示格式无效。')
    out.caseMap = input.caseMap
  }
  if (input.verticalAlign !== undefined) out.verticalAlign = normalizeVerticalAlign(input.verticalAlign)
  if (input.fontSize !== undefined) {
    out.fontSize = number(input.fontSize, 1, 400, '字号')
    if (!Number.isInteger(out.fontSize * 2)) fail('字号请按 0.5 磅递增。')
  }
  for (const key of ['fontName', 'fontNameEastAsia', 'fontNameCs'] as const) if (input[key] !== undefined) {
    const font = input[key]
    if (typeof font !== 'string' || !font.trim() || font.length > 200 || /[\x00-\x1f\x7f]/.test(font)) fail('字体名称无效。')
    validText(font); out[key] = font
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !/^#[\da-f]{6}$/i.test(input.color)) fail('文字颜色无效。')
    out.color = input.color.toUpperCase()
  }
  if (input.highlight !== undefined) {
    if (!isHighlightColor(input.highlight)) fail('文字高亮颜色无效。')
    out.highlight = input.highlight
  }
  if (input.backgroundColor !== undefined) out.backgroundColor = normalizeBackgroundColor(input.backgroundColor)
  for (const key of ['language', 'languageEastAsia', 'languageBidi'] as const) if (input[key] !== undefined) {
    const tag = input[key]
    if (typeof tag !== 'string' || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(tag) || tag.length > 85) fail('文字语言标记无效。')
    out[key] = tag
  }
  for (const key of ['fontSizeCs', 'kerning'] as const) if (input[key] !== undefined) {
    out[key] = number(input[key], key === 'kerning' ? 0 : 1, 400, '文字字号或字距阈值')
    if (!Number.isInteger(out[key]! * 2)) fail('文字字号或字距阈值请按 0.5 磅递增。')
  }
  if (input.letterSpacing !== undefined) {
    const twips = number(input.letterSpacing, LETTER_SPACING_LIMITS.min, LETTER_SPACING_LIMITS.max, '字符间距') * 20, rounded = Math.round(twips)
    // Decimal twip values such as 1.15pt are not always exact binary floats.
    if (Math.abs(twips - rounded) > 1e-8) fail('字符间距请按 0.05 磅递增。')
    out.letterSpacing = rounded / 20 || 0
  }
  return out
}
function inheritedTextStyle(input: TextStyle): TextStyle {
  if (typeof input?.verticalAlign === 'number') fail('段落继承样式暂不支持自定义基线偏移，请使用直接文字格式。')
  return textStyle(input)
}

/** Validate the resolved item, not a sparse direct override: its Western and
 * East Asian families can come from different inherited character layers. */
function assertCustomOffsetFonts(text: string, style: TextStyle): void {
  if (typeof style.verticalAlign !== 'number') return
  const western = (style.fontName ?? 'Times New Roman').toLowerCase()
  if (!baselineOffsetFontNames.has(western)) fail('自定义基线偏移暂只支持 Times New Roman、DejaVu Sans 或 Liberation Serif 字体。')
  // Native saves often add an unused East Asian default family to ASCII
  // text. Keep those packages usable, but conservatively require matching
  // families as soon as any non-ASCII text is actually inserted or formatted.
  if (/[^\x00-\x7f]/.test(text) && style.fontNameEastAsia !== undefined && style.fontNameEastAsia.toLowerCase() !== western) fail('自定义基线偏移的非 ASCII 文字暂不支持中西文使用不同字体，请统一为受支持的字体。')
}
function paragraphStyle(input: ParagraphStyle): ParagraphStyle {
  if (!input || typeof input !== 'object') return fail('段落格式无效。')
  const out: ParagraphStyle = {}
  if (input.align !== undefined) {
    if (!['left', 'center', 'right', 'justify'].includes(input.align)) fail('段落对齐方式无效。')
    out.align = input.align
  }
  if (input.heading !== undefined) {
    if (![0, 1, 2, 3].includes(input.heading)) fail('标题级别无效。')
    out.heading = input.heading
  }
  for (const key of ['spaceBefore', 'spaceAfter'] as const) if (input[key] !== undefined) out[key] = Math.round(number(input[key], PARAGRAPH_SPACING_LIMITS.min, PARAGRAPH_SPACING_LIMITS.max, '段落间距') * 20) / 20
  for (const key of ['indentLeft', 'indentRight', 'indentFirstLine'] as const) if (input[key] !== undefined) out[key] = Math.round(number(input[key], -1584, 1584, '段落缩进') * 20) / 20
  for (const key of ['widowControl', 'keepNext', 'keepLines', 'suppressAutoHyphens'] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== 'boolean') fail('段落分页和断词设置必须是有效开关。')
    out[key] = input[key]
  }
  if (input.lineHeightRule !== undefined) {
    if (!['auto', 'exact', 'atLeast'].includes(input.lineHeightRule)) fail('段落行距规则无效。')
    out.lineHeightRule = input.lineHeightRule
  }
  if (input.lineHeight !== undefined) {
    const automatic = (input.lineHeightRule || 'auto') === 'auto'
    // Writer's proportional spacing is an integer percentage. OOXML's
    // 240ths are only a wire encoding, not the model's editing precision.
    const units = automatic ? 100 : 20
    const limits = automatic ? AUTO_LINE_HEIGHT_LIMITS : POINT_LINE_HEIGHT_LIMITS
    out.lineHeight = Math.round(number(input.lineHeight, limits.min, limits.max, '段落行距') * units) / units
  } else if (input.lineHeightRule !== undefined) fail('段落行距规则缺少对应行距。')
  return out
}
function validText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value)) fail('正文包含无法保存的控制字符。')
  // XML 1.0 cannot carry unpaired surrogates. A committed IME string must be whole.
  for (let i = 0; i < (value as string).length; i++) {
    const code = (value as string).charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = (value as string).charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('正文包含不完整的 Unicode 字符。')
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('正文包含不完整的 Unicode 字符。')
  }
}
function assertCaseMapText(text: string, style: TextStyle): void {
  if (style.caseMap === undefined || style.caseMap === 'none') return
  // Native Writer and browser case mapping differ for non-ASCII cased
  // characters (for example sharp s). Preserve the text and reject the
  // unsupported display combination instead of expanding or rewriting it.
  if (/[^\x00-\x7f]/.test(text)) for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (codePoint > 0x7f && (/\p{Cased}/u.test(character) || character.toUpperCase() !== character.toLowerCase())) fail('大写或小型大写显示暂不支持非 ASCII 大小写字符，请先恢复原样显示或使用完整文字编辑器。')
    const variationSelector = (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    if (!variationSelector && /\p{M}/u.test(character)) fail('大写或小型大写显示暂不支持组合音标，请先恢复原样显示或使用完整文字编辑器。')
  }
  const language = style.language?.split('-')[0]?.toLowerCase()
  if (/[A-Za-z]/.test(text) && language && ['tr', 'az', 'el', 'lt', 'ga'].includes(language)) fail('大写或小型大写显示暂不支持此文字语言的大小写规则，请使用完整文字编辑器。')
}
function compactRuns(runs: WordRun[]): WordRun[] {
  const out: WordRun[] = []
  for (const run of runs) {
    if (!run.text) continue
    const previous = out.at(-1)
    if (previous && JSON.stringify(previous.style) === JSON.stringify(run.style) && JSON.stringify(previous.directStyle) === JSON.stringify(run.directStyle) && previous.sourceVerticalAlign === run.sourceVerticalAlign) previous.text += run.text
    else out.push(copyRun(run))
  }
  return out.length ? out : [copyRun(runs[0] || { text: '', style: {} }, '')]
}
function copyRun(run: WordRun, text = run.text): WordRun {
  return { text, style: { ...run.style }, ...(run.directStyle !== undefined ? { directStyle: { ...run.directStyle } } : {}), ...(run.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: run.sourceVerticalAlign } : {}) }
}
/** Writer stores line type and paint in one underline item. When either is
 * made direct, keep its partner from the current effective item. Colorless
 * legacy formats stay sparse until a colored source makes a reset necessary. */
function underlineOverrides(effective: TextStyle, overrides: TextStyle, source: TextStyle = {}): TextStyle {
  const direct = { ...overrides }
  if (direct.underlineColor !== undefined && direct.underline === undefined) direct.underline = effective.underline ?? false
  if (direct.underline !== undefined && direct.underlineColor === undefined
    && (effective.underlineColor !== undefined || source.underlineColor !== undefined)) direct.underlineColor = effective.underlineColor ?? 'auto'
  return direct
}
/** A paragraph-style change updates inherited marker values, preserving only
 * its actual direct overrides and supported named-character provenance. */
export function withParagraphMarkerSource(marker: ParagraphMarkerFormat, source: TextStyle): ParagraphMarkerFormat {
  const directStyle = underlineOverrides(marker.style, marker.directStyle ?? marker.style, source)
  return {
    style: { ...source, ...(marker.sourceVerticalAlign !== undefined ? { verticalAlign: marker.sourceVerticalAlign } : {}), ...directStyle },
    directStyle,
    ...(marker.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: marker.sourceVerticalAlign } : {}),
  }
}
/** At a nonempty paragraph's end, only the mark's explicit overrides replace
 * the adjacent body's insertion attributes. Inherited marker values are not
 * a new paragraph-wide character style. Empty paragraphs use their own mark. */
export function paragraphInsertionFormat(paragraph: WordParagraph): ParagraphMarkerFormat {
  if (paragraph.sessionInsertion) return clone(paragraph.sessionInsertion)
  const marker = paragraph.marker
  if (!paragraphText(paragraph).length) {
    if (marker) return clone(marker)
  }
  const run = [...paragraph.runs].reverse().find(item => item.text.length) ?? paragraph.runs[0]!
  const directStyle = { ...(run.directStyle ?? run.style) }
  const sourceVerticalAlign = marker?.sourceVerticalAlign ?? run.sourceVerticalAlign
  if (marker?.sourceVerticalAlign !== undefined) delete directStyle.verticalAlign
  const markerOverrides = marker ? underlineOverrides(marker.style, marker.directStyle ?? marker.style, run.style) : undefined
  Object.assign(directStyle, markerOverrides)
  return {
    style: { ...run.style, ...(marker?.sourceVerticalAlign !== undefined ? { verticalAlign: marker.sourceVerticalAlign } : {}), ...markerOverrides },
    ...(marker || run.directStyle !== undefined ? { directStyle } : {}),
    ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}),
  }
}
/** A run's effective appearance stays authoritative when browser/model edits
 * move it under another paragraph style. Only changed inherited values become
 * direct overrides; explicit direct values equal to the base remain explicit. */
function rebaseRun(run: WordRun, source: TextStyle): WordRun {
  if (run.sourceVerticalAlign !== undefined) source = { ...source, verticalAlign: run.sourceVerticalAlign }
  const direct: TextStyle = { ...(run.directStyle ?? run.style) }
  const effective: TextStyle = { ...run.style }
  const displayed = (style: TextStyle): TextStyle => ({
    ...style,
    bold: style.bold ?? false, italic: style.italic ?? false, underline: style.underline ?? false,
    underlineColor: style.underlineColor ?? 'auto',
    strike: style.strike ?? 'none', caseMap: style.caseMap ?? 'none', verticalAlign: style.verticalAlign ?? 'baseline',
    fontName: style.fontName ?? 'Times New Roman',
    fontNameEastAsia: style.fontNameEastAsia ?? style.fontName ?? 'Times New Roman',
    fontNameCs: style.fontNameCs ?? style.fontName ?? 'Times New Roman',
    fontSize: style.fontSize ?? 12, color: style.color ?? '#20242B', highlight: style.highlight ?? 'none', backgroundColor: style.backgroundColor ?? 'none',
    // OOXML kern=0 disables kerning, as does an absent inherited setting.
    kerning: style.kerning ?? 0,
    letterSpacing: style.letterSpacing ?? 0,
  })
  const desired = displayed(effective), inherited = displayed({ ...source, ...direct })
  for (const key of new Set([...Object.keys(desired), ...Object.keys(inherited)]) as Set<keyof TextStyle>) {
    if (desired[key] === inherited[key]) continue
    // There is no supported "clear inherited language / complex-script size"
    // command in this model. Refuse this rare merge atomically instead of
    // inventing a locale or silently inheriting the other paragraph's value.
    if (desired[key] === undefined) fail('此段落合并无法保留未指定的语言或复杂文字字号，请使用完整文字编辑器。')
    Object.assign(direct, { [key]: desired[key] })
    Object.assign(effective, { [key]: desired[key] })
  }
  return { text: run.text, style: textStyle(effective), directStyle: textStyle(underlineOverrides(effective, direct, source)), ...(run.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: run.sourceVerticalAlign } : {}) }
}
function rebaseParagraph(style: ParagraphStyle, source: ParagraphStyle, overrides: ParagraphStyle): { style: ParagraphStyle; directStyle: ParagraphStyle } {
  const defaults: Required<ParagraphStyle> = {
    align: 'left', heading: 0, spaceBefore: 0, spaceAfter: 8,
    indentLeft: 0, indentRight: 0, indentFirstLine: 0,
    widowControl: true, keepNext: false, keepLines: false, suppressAutoHyphens: true,
    lineHeight: 1, lineHeightRule: 'auto',
  }
  const effective = { ...style }, direct = { ...overrides }, inherited = { ...source, ...direct }
  for (const key of new Set([...Object.keys(style), ...Object.keys(inherited)]) as Set<keyof ParagraphStyle>) {
    const desired = style[key] ?? defaults[key]
    if (desired === (inherited[key] ?? defaults[key])) continue
    Object.assign(direct, { [key]: desired }); Object.assign(effective, { [key]: desired })
  }
  // The direct OOXML line-height rule always needs a matching line value.
  if (direct.lineHeightRule !== undefined && direct.lineHeight === undefined) direct.lineHeight = effective.lineHeight ?? 1
  if (direct.lineHeight !== undefined) direct.lineHeightRule = effective.lineHeightRule ?? 'auto'
  return { style: paragraphStyle(effective), directStyle: paragraphStyle(direct) }
}
export function normalizeDocument(input: WordDocument): WordDocument {
  if (!input || !Array.isArray(input.paragraphs) || !input.paragraphs.length || input.paragraphs.length > WORD_LIMITS.paragraphs) fail('正文需要至少一段，且不超过 5,000 段。')
  let characters = input.paragraphs.length - 1, runs = 0
  const ids = new Set<string>()
  const paragraphs = input.paragraphs.map(p => {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id)) fail('段落标识缺失或重复。')
    ids.add(p.id)
    if (!Array.isArray(p.runs) || !p.runs.length) fail('段落正文无效。')
    const sourceRun = p.sourceRun === undefined ? undefined : inheritedTextStyle(p.sourceRun)
    let marker: ParagraphMarkerFormat | undefined
    if (p.marker !== undefined) {
      if (!p.marker || typeof p.marker !== 'object' || Array.isArray(p.marker)) fail('段落标记格式无效。')
      if (Object.keys(p.marker).some(key => !['style', 'directStyle', 'sourceVerticalAlign'].includes(key))
        || !p.marker.style || typeof p.marker.style !== 'object' || Array.isArray(p.marker.style)
        || (p.marker.directStyle !== undefined && (!p.marker.directStyle || typeof p.marker.directStyle !== 'object' || Array.isArray(p.marker.directStyle)))) fail('段落标记格式无效。')
      const sourceVerticalAlign = p.marker.sourceVerticalAlign === undefined ? undefined : normalizeSourceVerticalAlign(p.marker.sourceVerticalAlign)
      const parsed = {
        text: '', style: textStyle(p.marker.style),
        ...(p.marker.directStyle !== undefined ? { directStyle: textStyle(p.marker.directStyle) } : {}),
        ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}),
      }
      const normalized = sourceRun === undefined && sourceVerticalAlign === undefined ? parsed : rebaseRun(parsed, sourceRun ?? {})
      assertCustomOffsetFonts('', normalized.style)
      const { text: _text, ...format } = normalized
      marker = format
    }
    const items = p.runs.map(run => {
      if (!run) fail('文字片段无效。')
      validText(run.text)
      assertSupportedWordText(run.text)
      characters += run.text.length; runs++
      if (characters > WORD_LIMITS.characters || runs > WORD_LIMITS.runs) fail('文档超过轻量编辑器的大小限制，请使用完整文字编辑器。')
      const sourceVerticalAlign = run.sourceVerticalAlign === undefined ? undefined : normalizeSourceVerticalAlign(run.sourceVerticalAlign)
      const normalized = { text: run.text.replace(/\r\n?/g, '\n'), style: textStyle(run.style), ...(run.directStyle !== undefined ? { directStyle: textStyle(run.directStyle) } : {}), ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}) }
      const effective = sourceRun === undefined && sourceVerticalAlign === undefined ? normalized : rebaseRun(normalized, sourceRun ?? {})
      assertCustomOffsetFonts(effective.text, effective.style)
      assertCaseMapText(effective.text, effective.style)
      return effective
    })
    let sessionInsertion: ParagraphMarkerFormat | undefined
    if (p.sessionInsertion !== undefined) {
      const format = p.sessionInsertion
      if (!marker || !format || typeof format !== 'object' || Array.isArray(format)
        || Object.keys(format).some(key => !['style', 'directStyle', 'sourceVerticalAlign'].includes(key))
        || !format.style || typeof format.style !== 'object' || Array.isArray(format.style)
        || (format.directStyle !== undefined && (!format.directStyle || typeof format.directStyle !== 'object' || Array.isArray(format.directStyle)))) fail('会话插入格式无效。')
      const sourceVerticalAlign = format.sourceVerticalAlign === undefined ? undefined : normalizeSourceVerticalAlign(format.sourceVerticalAlign)
      const normalized = rebaseRun({ text: '', style: textStyle(format.style),
        ...(format.directStyle !== undefined ? { directStyle: textStyle(format.directStyle) } : {}),
        ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}) }, sourceRun ?? {})
      assertCustomOffsetFonts('', normalized.style)
      const { text: _text, ...rest } = normalized
      sessionInsertion = rest
    }
    // Native deletion can retain a live caret format independently of the
    // saved mark, including a baseline successor after Enter. Import never
    // constructs sessionInsertion; only an editing transaction creates it.
    const emptyParagraph = items.every(run => !run.text)
    const emptyFormat = sessionInsertion ?? marker
    const normalizedRuns = emptyFormat && emptyParagraph ? [{ text: '', ...clone(emptyFormat) }] : items
    const paragraph: WordParagraph = { id: p.id, style: paragraphStyle(p.style), runs: compactRuns(normalizedRuns) }
    if (marker !== undefined) paragraph.marker = marker
    if (sessionInsertion !== undefined) paragraph.sessionInsertion = sessionInsertion
    if (sourceRun !== undefined) paragraph.sourceRun = sourceRun
    if (p.sourceParagraph !== undefined) paragraph.sourceParagraph = paragraphStyle(p.sourceParagraph)
    if (p.directStyle !== undefined) {
      const direct = p.directStyle?.lineHeight !== undefined
        ? { ...p.directStyle, lineHeightRule: p.directStyle.lineHeightRule ?? paragraph.style.lineHeightRule ?? 'auto' }
        : p.directStyle
      paragraph.directStyle = paragraphStyle(direct)
    }
    if (paragraph.sourceParagraph !== undefined) Object.assign(paragraph, rebaseParagraph(paragraph.style, paragraph.sourceParagraph, paragraph.directStyle ?? paragraph.style))
    if (p.nextParagraphStyle !== undefined) {
      if (!p.nextParagraphStyle || typeof p.nextParagraphStyle !== 'object') fail('后续段落样式无效。')
      paragraph.nextParagraphStyle = { paragraph: paragraphStyle(p.nextParagraphStyle.paragraph), run: inheritedTextStyle(p.nextParagraphStyle.run) }
      if (p.nextParagraphStyle.sourceRun !== undefined) paragraph.nextParagraphStyle.sourceRun = inheritedTextStyle(p.nextParagraphStyle.sourceRun)
    }
    return paragraph
  })
  if (!input.page) fail('纸张设置缺失。')
  const twips = (value: number, min: number, title: string) => Math.round(number(value, min, 1584, title) * 20) / 20
  const page: WordPage = { width: twips(input.page.width, 72, '纸张宽度'), height: twips(input.page.height, 72, '纸张高度'),
    marginTop: twips(input.page.marginTop, 0, '上边距'), marginRight: twips(input.page.marginRight, 0, '右边距'),
    marginBottom: twips(input.page.marginBottom, 0, '下边距'), marginLeft: twips(input.page.marginLeft, 0, '左边距') }
  page.width = normalizePaperDimension(page.width)
  page.height = normalizePaperDimension(page.height)
  if (input.page.orientation !== undefined) {
    if (!['portrait', 'landscape'].includes(input.page.orientation)) fail('纸张方向无效。')
    page.orientation = input.page.orientation
  }
  const pageTwips = (value: number) => Math.round(value * 20)
  if (pageTwips(page.marginLeft) + pageTwips(page.marginRight) >= pageTwips(page.width)
    || pageTwips(page.marginTop) + pageTwips(page.marginBottom) >= pageTwips(page.height)) fail('页边距不能占满整张纸。')
  const document: WordDocument = { paragraphs, page }
  if (input.defaultTabStop !== undefined) document.defaultTabStop = Math.round(number(input.defaultTabStop, 0.05, 1584, '默认制表位') * 20) / 20
  if (input.autoHyphenation !== undefined) {
    if (typeof input.autoHyphenation !== 'boolean') fail('自动断词设置必须是有效开关。')
    document.autoHyphenation = input.autoHyphenation
  }
  if (input.packageMetadata !== undefined) {
    if (!input.packageMetadata || typeof input.packageMetadata !== 'object' || Array.isArray(input.packageMetadata)) fail('文档元数据无效。')
    if (Object.keys(input.packageMetadata).some(key => !['fontTable', 'theme', 'coreProperties', 'extendedProperties'].includes(key))) fail('包含不支持的文档元数据。')
    const metadata: NonNullable<WordDocument['packageMetadata']> = {}
    let size = 0
    for (const key of ['fontTable', 'theme', 'coreProperties', 'extendedProperties'] as const) {
      const value = input.packageMetadata[key]
      if (value === undefined) continue
      validText(value); size += value.length
      if (size > WORD_LIMITS.metadataCharacters) fail('文档字体、主题或属性元数据超过轻量编辑器的大小限制。')
      metadata[key] = value
    }
    if (Object.keys(metadata).length) document.packageMetadata = metadata
  }
  return document
}
function compare(a: WordPoint, b: WordPoint) { return a.paragraph - b.paragraph || a.offset - b.offset }
export function orderedSelection(selection: WordSelection): [WordPoint, WordPoint] {
  return compare(selection.anchor, selection.focus) <= 0 ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor]
}
function point(model: WordDocument, input: WordPoint): WordPoint {
  if (!input || !Number.isInteger(input.paragraph) || input.paragraph < 0 || input.paragraph >= model.paragraphs.length) fail('选区对应的段落已变化。')
  const text = paragraphText(model.paragraphs[input.paragraph]!)
  if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > text.length) fail('文字选区已变化。')
  if (input.offset > 0 && input.offset < text.length && /[\ud800-\udbff]/.test(text[input.offset - 1]!) && /[\udc00-\udfff]/.test(text[input.offset]!)) fail('选区不能拆开一个 Unicode 字符。')
  return { ...input }
}
function selectionFor(model: WordDocument, input: WordSelection): WordSelection { return { anchor: point(model, input.anchor), focus: point(model, input.focus) } }
function clampSelection(model: WordDocument, input: WordSelection): WordSelection {
  const clamp = (p: WordPoint): WordPoint => {
    const paragraph = Math.max(0, Math.min(p.paragraph, model.paragraphs.length - 1))
    const text = paragraphText(model.paragraphs[paragraph]!)
    let offset = Math.max(0, Math.min(p.offset, text.length))
    if (offset > 0 && /[\ud800-\udbff]/.test(text[offset - 1]!) && /[\udc00-\udfff]/.test(text[offset] || '')) offset--
    return { paragraph, offset }
  }
  return { anchor: clamp(input.anchor), focus: clamp(input.focus) }
}
function sliceRuns(p: WordParagraph, start: number, end: number): WordRun[] {
  const runs: WordRun[] = []; let offset = 0
  for (const run of p.runs) {
    const from = Math.max(0, start - offset), to = Math.min(run.text.length, end - offset)
    if (to > from) runs.push(copyRun(run, run.text.slice(from, to)))
    offset += run.text.length
  }
  return runs
}
type Snapshot = { model: WordDocument; selection: WordSelection; size: number; revision: number; hardMarkerIds: Set<string> }
/** Caret provenance participates in undo, but is not a saved document change. */
function documentSignature(model: WordDocument): string {
  return JSON.stringify(model, (key, value) => key === 'sessionInsertion' ? undefined : value)
}
export class WordController {
  private current: WordDocument
  private cursor: WordSelection = { anchor: { paragraph: 0, offset: 0 }, focus: { paragraph: 0, offset: 0 } }
  private past: Snapshot[] = []
  private future: Snapshot[] = []
  private saved: string
  // Writer distinguishes imported ListAutoFormat marks from character
  // attributes applied to the paragraph during this editing session. Both
  // serialize as pPr/rPr, so opening a document intentionally starts empty.
  private hardMarkerIds = new Set<string>()
  revision = 0
  constructor(model = createWordDocument()) { this.current = normalizeDocument(model); this.saved = documentSignature(this.current) }
  // Consumers get detached values: all edits must pass through a transaction.
  get model(): WordDocument { return clone(this.current) }
  get selection(): WordSelection { return clone(this.cursor) }
  get dirty(): boolean { return documentSignature(this.current) !== this.saved }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }
  setSelection(selection: WordSelection): void { this.cursor = selectionFor(this.current, selection) }
  private snapshot(): Snapshot { return { model: clone(this.current), selection: clone(this.cursor), size: (JSON.stringify(this.current).length + [...this.hardMarkerIds].join('').length) * 2, revision: this.revision, hardMarkerIds: new Set(this.hardMarkerIds) } }
  private trimHistory(): void {
    let bytes = [...this.past, ...this.future].reduce((sum, item) => sum + item.size, 0)
    while (this.past.length + this.future.length > WORD_LIMITS.historyEntries || bytes > WORD_LIMITS.historyBytes) {
      const removed = this.past.length ? this.past.shift() : this.future.shift()
      if (!removed) break
      bytes -= removed.size
    }
  }
  private commit(model: WordDocument, selection?: WordSelection, beforeSelection?: WordSelection, hardMarkerIds?: ReadonlySet<string>): void {
    const next = normalizeDocument(model)
    const cursor = selection ? selectionFor(next, selection) : clampSelection(next, this.cursor)
    const markerOverrides = (marker: ParagraphMarkerFormat | undefined) => marker === undefined ? undefined
      : JSON.stringify({ directStyle: marker.directStyle ?? marker.style, sourceVerticalAlign: marker.sourceVerticalAlign })
    const oldMarkers = new Map(this.current.paragraphs.map(p => [p.id, markerOverrides(p.marker)]))
    // DOM text updates and paragraph-style rebasing retain the mark's origin.
    // Replacing its hard attributes through setDocument establishes a new mark.
    const nextHardMarkerIds = new Set(next.paragraphs.filter(p => p.marker && (hardMarkerIds !== undefined
      ? hardMarkerIds.has(p.id)
      : this.hardMarkerIds.has(p.id) && oldMarkers.get(p.id) === markerOverrides(p.marker))).map(p => p.id))
    if (JSON.stringify(next) === JSON.stringify(this.current) && nextHardMarkerIds.size === this.hardMarkerIds.size && [...nextHardMarkerIds].every(id => this.hardMarkerIds.has(id))) { this.cursor = cursor; return }
    const previous = this.snapshot()
    if (beforeSelection) previous.selection = clone(beforeSelection)
    this.past.push(previous); this.future = []
    this.current = next; this.cursor = cursor; this.hardMarkerIds = nextHardMarkerIds; this.revision++; this.trimHistory()
  }
  setDocument(model: WordDocument, selection?: WordSelection): void { this.commit(model, selection) }
  formatPage(patch: Partial<WordPage>): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('纸张设置无效。')
    const fields = ['width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const
    const allowed: ReadonlyArray<keyof WordPage> = [...fields, 'orientation']
    if (Object.keys(patch).some(key => !allowed.includes(key as keyof WordPage))) fail('纸张设置包含不支持的属性。')
    const page = { ...this.current.page }
    if (patch.orientation !== undefined) {
      if (!['portrait', 'landscape'].includes(patch.orientation)) fail('纸张方向无效。')
      page.orientation = patch.orientation
    }
    for (const key of fields) {
      const value = patch[key]
      if (value === undefined) continue
      const limits = key === 'width' || key === 'height' ? PAGE_SIZE_LIMITS : PAGE_MARGIN_LIMITS
      const points = number(value, limits.min, limits.max, '纸张尺寸或页边距')
      const twips = Math.round(points * 20)
      // Decimal point inputs can carry ordinary binary floating-point noise;
      // accept an exact twentieth of a point, not a new rounding edit.
      if (Math.abs(points * 20 - twips) > 1e-8) fail('纸张尺寸和页边距请按 0.05 磅递增。')
      page[key] = twips / 20
    }
    this.commit({ ...this.current, page }, this.cursor, this.cursor, this.hardMarkerIds)
  }
  formatText(selection: WordSelection, patch: TextStyle): void {
    const valid = selectionFor(this.current, selection), style = textStyle(patch), [start, end] = orderedSelection(valid)
    const collapsed = compare(start, end) === 0
    // An empty paragraph has no selectable text. Its caret formats the mark
    // immediately so saving before typing preserves the insertion format.
    if (!Object.keys(style).length || (collapsed && paragraphText(this.current.paragraphs[start.paragraph]!).length)) return
    const next = this.model
    const hardMarkerIds = new Set(this.hardMarkerIds)
    for (let i = start.paragraph; i <= end.paragraph; i++) {
      const p = next.paragraphs[i]!, from = i === start.paragraph ? start.offset : 0, to = i === end.paragraph ? end.offset : paragraphText(p).length
      // Native Writer resets the mark's other hard attributes when formatting
      // the complete nonempty paragraph text, even without its separator.
      // A partial body selection leaves an independent mark unchanged.
      if (from === 0 && to === paragraphText(p).length && to > 0) {
        delete p.sessionInsertion
        let markerPatch = style
        if (style.underlineColor !== undefined && style.underline === undefined) {
          const lines = new Set(p.runs.filter(run => run.text.length).map(run => run.style.underline ?? false))
          // Writer's underline-color command carries the selected line type
          // in the same item. For a uniform selection its mark must use that
          // type, even when paragraph inheritance or the old mark differs.
          // Mixed runs retain their individual types; never choose one run's
          // type as an override for the rest of the selection.
          if (lines.size === 1) markerPatch = { ...style, underline: [...lines][0]! }
        }
        p.marker = hardMarkerIds.has(p.id) && p.marker
          ? { ...p.marker, style: { ...p.marker.style, ...markerPatch }, directStyle: { ...(p.marker.directStyle ?? p.marker.style), ...markerPatch } }
          : { style: { ...p.sourceRun, ...markerPatch }, directStyle: { ...markerPatch } }
        hardMarkerIds.add(p.id)
      } else if (i < end.paragraph || collapsed) {
        // Crossing a boundary includes its mark even if no body text is
        // selected. Preserve unrelated marker attributes in this case.
        const marker = p.marker ?? (!paragraphText(p).length
          ? { style: { ...p.runs[0]!.style }, ...(p.runs[0]!.directStyle !== undefined ? { directStyle: { ...p.runs[0]!.directStyle } } : {}), ...(p.runs[0]!.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: p.runs[0]!.sourceVerticalAlign } : {}) }
          : { style: { ...p.sourceRun }, directStyle: {} })
        p.marker = { ...marker, style: { ...marker.style, ...style }, directStyle: { ...(marker.directStyle ?? marker.style), ...style } }
      }
      if (!paragraphText(p).length) {
        // Empty paragraphs retain their insertion format; a range covering
        // their paragraph break also applies the new character attributes.
        if (i < end.paragraph || collapsed) {
          const run = p.runs[0]!
          run.style = { ...run.style, ...style }
          if (run.directStyle !== undefined) run.directStyle = { ...run.directStyle, ...style }
          if (p.sessionInsertion) p.sessionInsertion = { ...p.sessionInsertion,
            style: { ...p.sessionInsertion.style, ...style }, directStyle: { ...(p.sessionInsertion.directStyle ?? p.sessionInsertion.style), ...style } }
        }
        continue
      }
      p.runs = compactRuns([...sliceRuns(p, 0, from), ...sliceRuns(p, from, to).map(run => ({ ...run, style: { ...run.style, ...style }, ...(run.directStyle !== undefined ? { directStyle: { ...run.directStyle, ...style } } : {}) })), ...sliceRuns(p, to, paragraphText(p).length)])
      if (p.sessionInsertion && to === paragraphText(p).length && from < to) p.sessionInsertion = { ...p.sessionInsertion,
        style: { ...p.sessionInsertion.style, ...style }, directStyle: { ...(p.sessionInsertion.directStyle ?? p.sessionInsertion.style), ...style } }
    }
    this.commit(next, valid, valid, hardMarkerIds)
  }
  formatParagraph(selection: WordSelection, patch: ParagraphStyle): void {
    const valid = selectionFor(this.current, selection), [start, end] = orderedSelection(valid)
    const next = this.model
    // A range ending at the start of the next paragraph does not include it.
    const last = end.paragraph > start.paragraph && end.offset === 0 ? end.paragraph - 1 : end.paragraph
    for (let i = start.paragraph; i <= last; i++) {
      const paragraph = next.paragraphs[i]!
      // A value-only edit retains each target paragraph's units. In a mixed
      // selection validate every target before committing, so an invalid
      // multiple cannot partly apply a valid point-valued edit.
      const style = paragraphStyle(patch?.lineHeight !== undefined && patch.lineHeightRule === undefined
        ? { ...patch, lineHeightRule: paragraph.style.lineHeightRule ?? 'auto' }
        : patch)
      paragraph.style = { ...paragraph.style, ...style }
      if (paragraph.directStyle !== undefined) paragraph.directStyle = { ...paragraph.directStyle, ...style }
    }
    this.commit(next, valid, valid)
  }
  replaceText(selection: WordSelection, input: string, style?: TextStyle): void {
    const valid = selectionFor(this.current, selection), [start, end] = orderedSelection(valid)
    if (typeof input !== 'string' || input.length > WORD_LIMITS.characters) fail('粘贴内容超过轻量编辑器的大小限制。')
    validText(input)
    const text = input.replace(/\r\n?/g, '\n')
    let breaks = 0, removedCharacters = end.paragraph - start.paragraph
    for (const character of text) if (character === '\n') breaks++
    for (let i = start.paragraph; i <= end.paragraph; i++) removedCharacters += (i === end.paragraph ? end.offset : paragraphText(this.current.paragraphs[i]!).length) - (i === start.paragraph ? start.offset : 0)
    if (this.current.paragraphs.length - (end.paragraph - start.paragraph) + breaks > WORD_LIMITS.paragraphs || documentText(this.current).length - removedCharacters + text.length > WORD_LIMITS.characters) fail('粘贴内容超过轻量编辑器的大小限制。')
    const next = this.model
    const first = next.paragraphs[start.paragraph]!, last = next.paragraphs[end.paragraph]!
    const left = sliceRuns(first, 0, start.offset), right = sliceRuns(last, end.offset, paragraphText(last).length)
    // Explicit mark attributes override adjacent text at paragraph end.
    const inheritedRun = first.marker && compare(start, end) === 0 && start.offset === paragraphText(first).length
      ? { text: '', ...paragraphInsertionFormat(first) }
      : left.at(-1) || first.runs[0]!
    const inherited = inheritedRun.style
    let marks = style ? textStyle(style) : { ...inherited }
    let direct = style ? { ...marks } : inheritedRun.directStyle === undefined ? undefined : { ...inheritedRun.directStyle }
    let sessionInsertion = first.sessionInsertion !== undefined && compare(start, end) === 0 && start.offset === paragraphText(first).length
    if (text === '' && start.paragraph === end.paragraph && start.offset === 0 && end.offset > 0
      && end.offset === paragraphText(first).length && typeof marks.verticalAlign === 'number' && first.marker) {
      const marker = first.marker, markerDirect = marker.directStyle ?? marker.style
      if (markerDirect.verticalAlign === 'baseline' || marker.sourceVerticalAlign === 'baseline') {
        // Native explicit baseline marks cancel the deleted body's offset.
        // The ordinary marker-authority rule below then supplies the caret.
        marks = { ...marks, verticalAlign: 'baseline' }
        direct = { ...(direct ?? inheritedRun.style), verticalAlign: 'baseline' }
      } else {
        const markerOverrides = underlineOverrides(marker.style, markerDirect, marks)
        // Native deletion keeps the body's logical size and font routes, even
        // when the independent mark is 24pt. Other explicit mark attributes
        // such as bold still contribute to the current insertion format.
        for (const key of ['verticalAlign', 'fontSize', 'fontSizeCs', 'fontName', 'fontNameEastAsia', 'fontNameCs'] as const) delete markerOverrides[key]
        marks = { ...marks, ...markerOverrides }
        direct = { ...(direct ?? inheritedRun.style), ...markerOverrides }
        // A numeric mark already records a deliberate session-wide offset;
        // its normal Enter continuation must remain distinct from deletion.
        sessionInsertion = typeof markerDirect.verticalAlign !== 'number'
      }
    }
    const lines = text.split('\n')
    // Backspace at the start of text after an empty paragraph deletes that
    // empty node. Native Writer keeps the surviving paragraph's inheritance
    // and direct paragraph format, not just its independent mark.
    const retainedParagraph = text === '' && end.paragraph === start.paragraph + 1 && end.offset === 0 && !paragraphText(first).length
      ? last : first
    // Native deletion of the boundary after an empty first paragraph removes
    // that empty text node, retaining the following paragraph's mark.
    const retainedMarker = text === '' && start.paragraph !== end.paragraph && !paragraphText(first).length
      ? last.marker : first.marker
    const retainedMarkerId = text === '' && start.paragraph !== end.paragraph && !paragraphText(first).length ? last.id : first.id
    const hardMarkerIds = new Set(this.hardMarkerIds)
    for (let i = start.paragraph; i <= end.paragraph; i++) hardMarkerIds.delete(next.paragraphs[i]!.id)
    const splitAtEnd = text === '\n' && compare(start, end) === 0 && start.offset === paragraphText(first).length
    const follow = splitAtEnd ? first.nextParagraphStyle : undefined
    const split = text === '\n'
    const followDirect = { ...(first.directStyle ?? first.style) }
    // Writer clears hard keep attributes on the second paragraph even when
    // splitting in the middle without changing styles. Inherited keep values
    // must remain inherited so a direct false can correctly revert to true.
    if (split) { delete followDirect.keepNext; delete followDirect.keepLines }
    if (follow) delete followDirect.heading
    const sourceParagraph = inheritedParagraphStyle(first)
    const inheritedCharacter = { ...(first.sourceRun ?? inheritedRun.style) }
    if (first.sourceRun === undefined) for (const key of Object.keys(inheritedRun.directStyle ?? inheritedRun.style) as Array<keyof TextStyle>) delete inheritedCharacter[key]
    const replacements = lines.map((line, index): WordParagraph => {
      const next = index > 0 ? follow : undefined
      const splitSuccessor = split && index > 0
      const source = next ? { ...next.paragraph } : sourceParagraph
      const runDirect = next ? underlineOverrides(marks, direct ?? marks, next.run) : direct !== undefined ? underlineOverrides(marks, direct) : undefined
      const runStyle = next ? { ...next.run, ...(inheritedRun.sourceVerticalAlign !== undefined ? { verticalAlign: inheritedRun.sourceVerticalAlign } : {}), ...runDirect } : { ...marks }
      if (splitAtEnd && index > 0) {
        // Writer removes hard escapement on the newly empty successor. The
        // paragraph's inherited script survives; strike and other direct
        // character attributes continue normally. A middle split keeps it.
        const inheritedScript = inheritedRun.sourceVerticalAlign ?? (next?.run ?? inheritedCharacter).verticalAlign
        if (inheritedScript === undefined && sessionInsertion) runStyle.verticalAlign = 'baseline'
        else if (inheritedScript === undefined) delete runStyle.verticalAlign
        else runStyle.verticalAlign = inheritedScript
        if (runDirect !== undefined) delete runDirect.verticalAlign
        // An explicit mark escapement is different from the body's hard
        // escapement: native Enter continues the mark's script positioning.
        const markerScript = (retainedMarker?.directStyle ?? retainedMarker?.style)?.verticalAlign
        if (markerScript !== undefined && !sessionInsertion) {
          runStyle.verticalAlign = markerScript
          if (runDirect !== undefined) runDirect.verticalAlign = markerScript
        }
        if (sessionInsertion && runDirect !== undefined) runDirect.verticalAlign = runStyle.verticalAlign ?? 'baseline'
      }
      // Writer carries adjacent-body insertion attributes in an empty run
      // after Enter, then loses them on DOCX reopen. Materialize those actual
      // attributes in the new empty mark so this editor can save them safely.
      // The original paragraph's independent mark remains unchanged.
      const marker = retainedMarker === undefined ? undefined : splitAtEnd && index > 0 && !sessionInsertion
        ? { style: { ...runStyle }, ...(runDirect !== undefined ? { directStyle: { ...runDirect } } : {}), ...(inheritedRun.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: inheritedRun.sourceVerticalAlign } : {}) }
        : next ? withParagraphMarkerSource(retainedMarker, next.run) : clone(retainedMarker)
      return {
        id: index === 0 ? first.id : crypto.randomUUID(), style: splitSuccessor ? { ...source, ...followDirect } : { ...retainedParagraph.style },
        // The surviving text node retains its mark; a newly split node copies
        // the mark's hard attributes. Follow styles change only inheritance.
        ...(marker !== undefined ? { marker } : {}),
        ...(sessionInsertion && index === lines.length - 1 ? { sessionInsertion: {
          style: { ...runStyle }, ...(runDirect !== undefined ? { directStyle: { ...runDirect } } : {}),
          ...(inheritedRun.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: inheritedRun.sourceVerticalAlign } : {}),
        } } : {}),
        ...(next ? { sourceRun: { ...next.run } } : retainedParagraph.sourceRun !== undefined ? { sourceRun: { ...retainedParagraph.sourceRun } } : {}),
        ...(splitSuccessor ? { sourceParagraph: { ...source } } : retainedParagraph.sourceParagraph !== undefined ? { sourceParagraph: { ...retainedParagraph.sourceParagraph } } : {}),
        ...(splitSuccessor ? { directStyle: { ...followDirect } } : retainedParagraph.directStyle !== undefined ? { directStyle: { ...retainedParagraph.directStyle } } : {}),
        ...(!next && retainedParagraph.nextParagraphStyle ? { nextParagraphStyle: clone(retainedParagraph.nextParagraphStyle) } : {}),
        runs: compactRuns([...(index === 0 ? left : []), {
          text: line,
          style: runStyle,
          ...(runDirect !== undefined ? { directStyle: runDirect } : {}),
          ...(inheritedRun.sourceVerticalAlign !== undefined ? { sourceVerticalAlign: inheritedRun.sourceVerticalAlign } : {}),
        }, ...(index === lines.length - 1 ? right : [])]),
      }
    })
    if (this.hardMarkerIds.has(retainedMarkerId)) for (const paragraph of replacements) if (paragraph.marker) hardMarkerIds.add(paragraph.id)
    next.paragraphs.splice(start.paragraph, end.paragraph - start.paragraph + 1, ...replacements)
    const at = { paragraph: start.paragraph + lines.length - 1, offset: lines.length === 1 ? start.offset + text.length : lines.at(-1)!.length }
    this.commit(next, { anchor: at, focus: at }, valid, hardMarkerIds)
  }
  undo(): void {
    const previous = this.past.pop(); if (!previous) return
    this.future.push(this.snapshot()); this.current = previous.model; this.cursor = previous.selection; this.hardMarkerIds = previous.hardMarkerIds; this.revision++; this.trimHistory()
  }
  redo(): void {
    const next = this.future.pop(); if (!next) return
    this.past.push(this.snapshot()); this.current = next.model; this.cursor = next.selection; this.hardMarkerIds = next.hardMarkerIds; this.revision++; this.trimHistory()
  }
  markSaved(revision = this.revision, exportedModel?: WordDocument): void {
    // A completed asynchronous save establishes the exported contents as the
    // baseline even if newer edits already exist. It must not clear those edits.
    const savedModel = exportedModel ? normalizeDocument(exportedModel) : revision === this.revision ? this.current : [...this.past, ...this.future].find(item => item.revision === revision)?.model
    if (savedModel) this.saved = documentSignature(savedModel)
  }
}
