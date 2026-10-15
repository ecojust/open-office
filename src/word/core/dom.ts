import { normalizeDocument, normalizeSourceVerticalAlign, normalizeTextColor, normalizeUnderlineColor, normalizeVerticalAlign, paragraphInsertionFormat, type TextColor, type TextStyle, type UnderlineColor, type WordDocument, type WordParagraph, type WordPoint, type WordRun, type WordSelection } from './model'
import { wordScript } from './scripts'
import { isHighlightColor } from './highlight'
import { backgroundFromCss, normalizeBackgroundColor, textBackgroundColor } from './background'
import { textColorFromCss, textColorPaint } from './text-color'

const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3'])
const ignoredTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG'])
type RenderState = { signatures: WeakMap<HTMLElement, string>; observer: MutationObserver }
const renderStates = new WeakMap<HTMLElement, RenderState>()

function renderState(root: HTMLElement): RenderState {
  const found = renderStates.get(root)
  if (found) return found
  const signatures = new WeakMap<HTMLElement, string>()
  const observer = new MutationObserver(records => invalidateRenderedParagraphs(root, signatures, records))
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
  const state = { signatures, observer }; renderStates.set(root, state)
  return state
}
function invalidateRenderedParagraphs(root: HTMLElement, signatures: WeakMap<HTMLElement, string>, records: MutationRecord[]) {
  for (const record of records) {
    let node: Node | null = record.target
    while (node && node !== root && node.parentNode !== root) node = node.parentNode
    if (node instanceof HTMLElement && node !== root) signatures.delete(node)
  }
}

function paragraphGroups(root: HTMLElement): Node[][] {
  const groups: Node[][] = []
  let inline: Node[] = []
  for (const node of root.childNodes) {
    if (node instanceof HTMLElement && blockTags.has(node.tagName)) {
      if (inline.length) { groups.push(inline); inline = [] }
      groups.push([node])
    } else inline.push(node)
  }
  if (inline.length) groups.push(inline)
  return groups.length ? groups : [[]]
}

function placeholder(node: HTMLElement): boolean {
  if (node.hasAttribute('data-word-placeholder')) return true
  if (node.hasAttribute('data-word-break')) return false
  const block = node.closest('[data-word-paragraph],p,div[contenteditable]')
  return !!block && !block.textContent && block.querySelectorAll('br').length === 1
}

function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length || 0
  if (node instanceof HTMLElement) {
    if (ignoredTags.has(node.tagName)) return 0
    if (node.tagName === 'BR') return placeholder(node) ? 0 : 1
  }
  return Array.from(node.childNodes).reduce((length, child) => length + nodeLength(child), 0)
}

function cssLetterSpacing(value: string): number | undefined {
  if (!value || value === 'inherit' || value === 'unset') return
  if (value === 'normal' || value === 'initial') return 0
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(pt|px)$/)
  if (!match) throw Error('暂不支持这种字符间距，请使用以磅为单位的固定间距。')
  const points = Number(match[1]) * (match[2] === 'px' ? .75 : 1)
  // WebViews can serialize a twip as 0.0666667 px. Recover that rounding,
  // while leaving genuinely fractional twips for model validation to reject.
  const twips = points * 20
  return Math.abs(twips - Math.round(twips)) < 1e-4 ? Math.round(twips) / 20 : points
}

function cssKerning(element: HTMLElement): number | undefined {
  const value = element.style.fontKerning
  if (!value || value === 'inherit' || value === 'unset') return
  if (value === 'normal') return 1
  if (value === 'none') return element.hasAttribute('data-word-fallback-kerning') ? undefined : 0
  throw Error('暂不支持自动字偶距，请明确选择启用或关闭。')
}

function underlineLine(element: HTMLElement): true | 'double' | undefined {
  const line = element.style.textDecorationLine || element.style.textDecoration || (element.tagName === 'U' ? 'underline' : '')
  if (line.includes('underline')) return element.style.textDecorationStyle === 'double' ? 'double' : true
}

function decorationColor(element: HTMLElement): UnderlineColor {
  const css = element.style.textDecorationColor.trim().toLowerCase()
  if (!css || ['currentcolor', 'initial', 'unset'].includes(css)) return 'auto'
  if (css === 'inherit') return element.parentElement ? decorationColor(element.parentElement) : 'auto'
  try {
    const color = backgroundFromCss(css)
    if (color && color !== 'none') return normalizeUnderlineColor(color)
  } catch { /* Report the underline-specific supported color contract. */ }
  throw Error('下划线颜色仅支持不透明 RGB 颜色或跟随文字颜色。')
}

function cssUnderlineColor(element: HTMLElement, inherited: TextStyle): UnderlineColor | undefined {
  // Decoration colors belong to the element drawing that line. A strike-only
  // child or an arbitrary colored wrapper cannot repaint an ancestor's line.
  const semantic = element.dataset.wordUnderline !== undefined
  const script = semantic ? [...element.children].find(child => child instanceof HTMLElement && ['script', 'position'].includes(child.dataset.wordVisual ?? '')) as HTMLElement | undefined : undefined
  const origin = underlineLine(element) ? element : script && underlineLine(script) ? script : semantic && element.style.textDecorationColor ? element : undefined
  if (!origin) return
  if (origin.style.textDecorationColor) return decorationColor(origin)
  // An external new underline origin has its own default currentColor. The
  // renderer's absent color is merely the normal inherited model default.
  if (!semantic && inherited.underlineColor !== undefined) return 'auto'
}

function cssCaseMap(element: HTMLElement, inherited: TextStyle): TextStyle['caseMap'] {
  const transform = element.style.textTransform, variant = element.style.fontVariantCaps
  if (!transform && !variant) return
  if (transform && !['none', 'uppercase', 'inherit', 'unset', 'initial'].includes(transform)) throw Error('暂不支持这种大小写显示，请使用原样、全部大写或小型大写。')
  if (variant && !['normal', 'small-caps', 'inherit', 'unset', 'initial'].includes(variant)) throw Error('暂不支持这种小型大写显示，请使用标准小型大写。')
  const inherits = (value: string) => !value || value === 'inherit' || value === 'unset'
  const upper = inherits(transform) ? inherited.caseMap === 'upper' : transform === 'uppercase'
  const small = inherits(variant) ? inherited.caseMap === 'smallCaps' : variant === 'small-caps'
  // CSS offers two independently inherited properties; Writer has one case
  // map. Refuse the ambiguous combined CSS state rather than guessing which
  // formatting intention to retain in a saved document.
  if (upper && small) throw Error('无法同时设置全部大写与小型大写，请选择一种大小写显示。')
  if (inherits(transform) && inherits(variant)) return
  return upper ? 'upper' : small ? 'smallCaps' : 'none'
}

function visibleLetterSpacing(style: TextStyle): number {
  // Writer's CheckKerning_ limits condensed advances to one sixth of the
  // actual font height. Both the 58% escapement font size and the limit use
  // integer twips; preserve the unmodified value in semantic metadata.
  const twips = Math.round((style.fontSize ?? 12) * 20)
  const actualTwips = style.verticalAlign === 'superscript' || style.verticalAlign === 'subscript' ? Math.floor(twips * 58 / 100) : twips
  return Math.max(style.letterSpacing ?? 0, -Math.floor(actualTwips / 6) / 20)
}

function encodedVerticalAlign(value: string): NonNullable<TextStyle['verticalAlign']> {
  // Metadata stores a semantic integer percentage, not a CSS length or a
  // percentage of line height. Reject malformed tokens instead of coercing.
  return normalizeVerticalAlign(/^[+-]?\d+$/.test(value) ? Number(value) : value)
}

const positionFontHeights = new Map<string, number>()
const zeroLineBaselines = new Map<string, number>()
let positionFontGeneration = 0
export function invalidateWordFontMetrics(): void {
  positionFontHeights.clear(); zeroLineBaselines.clear(); positionFontGeneration++
}
function naturalFontHeight(style: TextStyle): number {
  const size = style.fontSize ?? 12, family = style.fontName ?? 'Times New Roman'
  const key = JSON.stringify([family, size, !!style.bold, !!style.italic])
  let height = positionFontHeights.get(key)
  if (height === undefined) {
    if (document.body) {
      // A fixed probe includes the font's leading, unlike Canvas glyph-box
      // metrics. Its text never comes from the run: adding an emoji/fallback
      // glyph must not move existing text. Large-size measurement reduces
      // CSS-pixel rounding while keeping this a browser preview metric.
      const probe = document.createElement('span')
      probe.style.cssText = 'all:initial;position:fixed;left:-1000000px;top:-1000000px;display:block;visibility:hidden;white-space:pre;pointer-events:none'
      probe.style.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size * 100}pt ${fontFamily(family)}`
      probe.style.fontSynthesis = 'none'; probe.style.lineHeight = 'normal'; probe.textContent = 'Hg'
      document.body.append(probe)
      const measured = probe.getBoundingClientRect().height * .75 / 100
      probe.remove()
      if (Number.isFinite(measured) && measured > 0) height = Math.round(measured * 20)
    }
    // Non-layout hosts still retain the semantic percentage.
    height ??= Math.round(size * 20)
    if (positionFontHeights.size >= 512) positionFontHeights.delete(positionFontHeights.keys().next().value!)
    positionFontHeights.set(key, height)
  }
  return height / 20
}
function zeroLineBaseline(style: TextStyle): number {
  const size = style.fontSize ?? 12, family = style.fontName ?? 'Times New Roman'
  const key = JSON.stringify([family, size, !!style.bold, !!style.italic])
  const cached = zeroLineBaselines.get(key)
  if (cached !== undefined) return cached
  if (!document.body || !size) return 0
  const probe = document.createElement('span'), baseline = document.createElement('span')
  probe.style.cssText = 'all:initial;position:fixed;left:-1000000px;top:-1000000px;display:block;visibility:hidden;white-space:pre;pointer-events:none'
  probe.style.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}pt ${fontFamily(family)}`
  probe.style.fontSynthesis = 'none'; probe.style.lineHeight = '0'
  baseline.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline'
  probe.append('Hg', baseline); document.body.append(probe)
  const result = (baseline.getBoundingClientRect().top - probe.getBoundingClientRect().top) * .75
  probe.remove()
  if (zeroLineBaselines.size >= 512) zeroLineBaselines.delete(zeroLineBaselines.keys().next().value!)
  zeroLineBaselines.set(key, result)
  return result
}
function visiblePositionOffset(style: TextStyle): number {
  if (typeof style.verticalAlign !== 'number') return 0
  // Writer truncates offsets to integer twips. Browser font metrics remain a
  // preview approximation, not native pagination or cross-font equivalence.
  return Math.trunc(Math.round(naturalFontHeight(style) * 20) * style.verticalAlign / 100) / 20
}

function cssTextColor(element: HTMLElement, inherited: TextStyle, current: TextStyle): TextColor | undefined {
  const color = textColorFromCss(element.style.color)
  // Native editing sometimes copies an ancestor's computed RGB into an
  // anonymous span. Only an inherited semantic auto value can identify this
  // matching paint as a clone; ordinary external RGB stays explicit. The
  // toolbar and an owned RGB run can always express a same-paint override.
  // Include this wrapper's already-resolved shading: a new black background
  // with explicit black text must not become automatic white text on read.
  if (color !== undefined && inherited.color === 'auto' && color === textColorPaint({ ...current, color: 'auto' })) return
  return color
}

function inlineStyle(element: HTMLElement, inherited: TextStyle, paragraphSource: TextStyle = {}): TextStyle {
  // A paragraph marker only supplies the empty line's geometry. Its wrapper
  // must never turn that geometry (or a script's visual size) into body text
  // formatting when the browser inserts text at its placeholder.
  if (element.dataset.wordVisual === 'paragraph-marker') return { ...inherited }
  if (element.dataset.wordInsertionStyle !== undefined) {
    const insertion: unknown = JSON.parse(element.dataset.wordInsertionStyle)
    if (!insertion || typeof insertion !== 'object' || Array.isArray(insertion)) throw Error('空段落的输入格式无效。')
    return { ...inherited, ...insertion as TextStyle }
  }
  const value = { ...inherited }
  // Direct-style metadata can recover an individual missing run attribute.
  // Only an element with its own run provenance may use the paragraph source;
  // ordinary nested spans inherit their parent's two independent layers.
  const direct = element.dataset.wordDirectStyle === undefined ? undefined : runDirectStyle(element)
  const ownRunSource = direct ? { ...paragraphSource, ...(element.dataset.wordSourceColor !== undefined ? { color: normalizeTextColor(element.dataset.wordSourceColor) } : {}), ...direct } : undefined
  const semanticVerticalAlign = element.dataset.wordVerticalAlign !== undefined ? encodedVerticalAlign(element.dataset.wordVerticalAlign)
    : ownRunSource?.verticalAlign !== undefined ? normalizeVerticalAlign(ownRunSource.verticalAlign) : undefined
  let semanticUnderline: TextStyle['underline']
  if (element.dataset.wordUnderline !== undefined) {
    if (!['true', 'false', 'double'].includes(element.dataset.wordUnderline)) throw Error('下划线格式无效。')
    semanticUnderline = element.dataset.wordUnderline === 'double' ? 'double' : element.dataset.wordUnderline === 'true'
  } else if (ownRunSource?.underline !== undefined) {
    if (typeof ownRunSource.underline !== 'boolean' && ownRunSource.underline !== 'double') throw Error('下划线格式无效。')
    semanticUnderline = ownRunSource.underline
  }
  if (semanticUnderline !== undefined) value.underline = semanticUnderline
  if (element.dataset.wordUnderlineColor !== undefined) value.underlineColor = normalizeUnderlineColor(element.dataset.wordUnderlineColor)
  else if (ownRunSource?.underlineColor !== undefined) value.underlineColor = normalizeUnderlineColor(ownRunSource.underlineColor)
  else if (!element.hasAttribute('data-word-visual')) {
    const color = cssUnderlineColor(element, inherited)
    if (color !== undefined) value.underlineColor = color
  }
  let semanticPaint = false
  if (element.dataset.wordHighlight !== undefined) {
    if (!isHighlightColor(element.dataset.wordHighlight)) throw Error('文字高亮颜色无效。')
    value.highlight = element.dataset.wordHighlight; semanticPaint = true
  } else if (ownRunSource?.highlight !== undefined) {
    if (!isHighlightColor(ownRunSource.highlight)) throw Error('文字高亮颜色无效。')
    value.highlight = ownRunSource.highlight; semanticPaint = true
  }
  if (element.dataset.wordBackgroundColor !== undefined) {
    value.backgroundColor = normalizeBackgroundColor(element.dataset.wordBackgroundColor); semanticPaint = true
  } else if (ownRunSource?.backgroundColor !== undefined) {
    value.backgroundColor = normalizeBackgroundColor(ownRunSource.backgroundColor); semanticPaint = true
  }
  if (!semanticPaint) {
    const background = backgroundFromCss(element.style.backgroundColor)
    if (background !== undefined && background !== textBackgroundColor(value)) {
      // A copied composite paint cannot tell us two new layer values. Keep
      // matching native clones, and reject an ambiguous new color above an
      // existing highlight rather than overwriting its hidden shading.
      if (value.highlight !== undefined && value.highlight !== 'none') throw Error('无法确定新增背景与已有高亮的关系，请使用文字背景设置。')
      value.backgroundColor = background
    }
  }
  if (element.dataset.wordColor !== undefined) value.color = normalizeTextColor(element.dataset.wordColor)
  else if (ownRunSource?.color !== undefined) value.color = normalizeTextColor(ownRunSource.color)
  else {
    const color = cssTextColor(element, inherited, value)
    if (color !== undefined) value.color = color
  }
  // These owned wrappers only paint a run. Reading their 58% script size or
  // independent strike decoration as direct formatting would change DOCX
  // semantics on every native input event. Native editing can still place an
  // explicit highlight on one of these wrappers, so retain that paint above.
  if (element.hasAttribute('data-word-visual')) {
    if (element.dataset.wordVisual === 'position' && typeof value.verticalAlign !== 'number') throw Error('文字位置数据不完整，无法恢复基线偏移。')
    return value
  }
  const css = element.style
  if (element.dataset.wordCaseMap !== undefined) {
    if (!['none', 'upper', 'smallCaps'].includes(element.dataset.wordCaseMap)) throw Error('大小写显示格式无效。')
    value.caseMap = element.dataset.wordCaseMap as TextStyle['caseMap']
  } else if (ownRunSource?.caseMap !== undefined) value.caseMap = ownRunSource.caseMap
  else {
    const caseMap = cssCaseMap(element, inherited)
    if (caseMap !== undefined) value.caseMap = caseMap
  }
  // Keep the original OOXML value independent of any visual limit applied
  // for condensed text. A native clone may lose its dedicated attribute but
  // retain the run's direct/source formatting. Ordinary wrappers, however,
  // inherit their parent and may explicitly reset spacing with CSS normal.
  if (element.dataset.wordLetterSpacing !== undefined) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(element.dataset.wordLetterSpacing)) throw Error('字符间距格式无效。')
    value.letterSpacing = Number(element.dataset.wordLetterSpacing)
  } else if (ownRunSource?.letterSpacing !== undefined) value.letterSpacing = ownRunSource.letterSpacing
  else {
    const spacing = cssLetterSpacing(css.letterSpacing)
    if (spacing !== undefined) value.letterSpacing = spacing
  }
  if (['B', 'STRONG'].includes(element.tagName)) value.bold = true
  if (['I', 'EM'].includes(element.tagName)) value.italic = true
  if (element.tagName === 'SUP') value.verticalAlign = 'superscript'
  if (element.tagName === 'SUB') value.verticalAlign = 'subscript'
  if (css.fontWeight) value.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600
  if (css.fontStyle) value.italic = css.fontStyle === 'italic'
  const decoration = css.textDecorationLine || css.textDecoration || (element.tagName === 'U' ? 'underline' : ['S', 'STRIKE', 'DEL'].includes(element.tagName) ? 'line-through' : '')
  if (decoration.includes('underline') || decoration.includes('line-through')) {
    // Chromium serializes an omitted style in some valid decoration
    // shorthands as initial. This non-inherited property's default is solid.
    const decorationStyle = !css.textDecorationStyle || ['initial', 'unset'].includes(css.textDecorationStyle) ? 'solid' : css.textDecorationStyle
    if (!['solid', 'double'].includes(decorationStyle)) throw Error('暂不支持这种下划线或删除线样式，请使用单线或双线。')
    // CSS decorations propagate through descendants. A nested strike-only
    // clone must not erase its ancestor's underline; CSS none cannot cancel
    // an ancestor's decoration either. Explicit clears live in run metadata.
    if (decoration.includes('underline')) value.underline = decorationStyle === 'double' ? 'double' : true
    if (decoration.includes('line-through')) value.strike = decorationStyle === 'double' ? 'double' : 'single'
  }
  if (css.verticalAlign === 'super') value.verticalAlign = 'superscript'
  else if (css.verticalAlign === 'sub') value.verticalAlign = 'subscript'
  else if (css.verticalAlign === 'baseline') value.verticalAlign = 'baseline'
  else if (css.verticalAlign && semanticVerticalAlign === undefined && !element.hasAttribute('data-word-marker-whitespace') && !element.hasAttribute('data-word-line-layout')) throw Error('暂不支持这种 CSS 文字位置，请使用上标、下标或文字位置设置。')
  // Exact-line previews use relative positioning so shifted ink does not
  // enlarge the line box. Once semantic metadata is absent, a CSS offset
  // cannot recover the original font-height percentage; never flatten it.
  if (semanticVerticalAlign === undefined && !element.hasAttribute('data-word-line-layout') && css.position && css.position !== 'static'
    && [css.top, css.bottom].some(offset => offset && offset !== 'auto' && Number.parseFloat(offset) !== 0)) throw Error('暂不支持这种 CSS 文字位置，请使用上标、下标或文字位置设置。')
  if (css.fontSize && !element.hasAttribute('data-word-fallback-font-size')) {
    const size = Number.parseFloat(css.fontSize)
    if (Number.isFinite(size)) value.fontSize = css.fontSize.endsWith('px') ? size * .75 : size
  }
  if (!element.hasAttribute('data-word-glyph-font')) {
    if (element.dataset.wordFontName) value.fontName = element.dataset.wordFontName
    else if (css.fontFamily) value.fontName = css.fontFamily.replace(/^['"]|['"]$/g, '').replace(/\\([\\"'])/g, '$1')
  }
  if (element.dataset.wordFontNameEastAsia) value.fontNameEastAsia = element.dataset.wordFontNameEastAsia
  if (element.dataset.wordFontNameCs) value.fontNameCs = element.dataset.wordFontNameCs
  if (element.lang) value.language = element.lang
  if (element.dataset.wordLanguageEastAsia) value.languageEastAsia = element.dataset.wordLanguageEastAsia
  if (element.dataset.wordLanguageBidi) value.languageBidi = element.dataset.wordLanguageBidi
  if (element.dataset.wordFontSizeCs !== undefined) value.fontSizeCs = Number(element.dataset.wordFontSizeCs)
  if (element.dataset.wordKerning !== undefined) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(element.dataset.wordKerning)) throw Error('字偶距格式无效。')
    value.kerning = Number(element.dataset.wordKerning)
  } else if (ownRunSource?.kerning !== undefined) value.kerning = ownRunSource.kerning
  else {
    const kerning = cssKerning(element)
    if (kerning !== undefined) value.kerning = kerning
  }
  if (semanticUnderline !== undefined) value.underline = semanticUnderline
  if (element.dataset.wordStrike !== undefined) value.strike = element.dataset.wordStrike as TextStyle['strike']
  if (semanticVerticalAlign !== undefined) value.verticalAlign = semanticVerticalAlign
  return value
}

function runDirectStyle(element: HTMLElement, inherited?: TextStyle): TextStyle | undefined {
  const encoded = element.dataset.wordDirectStyle
  if (encoded === undefined) return inherited
  const value: unknown = JSON.parse(encoded)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('文字格式来源无效。')
  return value as TextStyle
}

function runSourceVerticalAlign(element: HTMLElement, inherited?: WordRun['sourceVerticalAlign']): WordRun['sourceVerticalAlign'] {
  return element.dataset.wordSourceVerticalAlign === undefined ? inherited : normalizeSourceVerticalAlign(element.dataset.wordSourceVerticalAlign)
}

function runSourceColor(element: HTMLElement, inherited?: WordRun['sourceColor']): WordRun['sourceColor'] {
  return element.dataset.wordSourceColor === undefined ? inherited : normalizeTextColor(element.dataset.wordSourceColor)
}

type UnderlineOrigin = { line: true | 'double'; color: UnderlineColor; textColor?: string }
function runsFrom(nodes: Node[], inherited: TextStyle = {}, directStyle?: TextStyle, sourceVerticalAlign?: WordRun['sourceVerticalAlign'], paragraphSource: TextStyle = {}, underlineOrigin?: UnderlineOrigin, sourceColor?: WordRun['sourceColor']): WordRun[] {
  const runs: WordRun[] = []
  const makeRun = (text: string): WordRun => ({ text, style: { ...inherited }, ...(directStyle !== undefined ? { directStyle: { ...directStyle } } : {}), ...(sourceVerticalAlign !== undefined ? { sourceVerticalAlign } : {}), ...(sourceColor !== undefined ? { sourceColor } : {}) })
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) runs.push(makeRun(node.textContent))
    } else if (node instanceof HTMLElement && !ignoredTags.has(node.tagName)) {
      // A placeholder is not a line break, but its complete ancestor chain
      // supplies the empty paragraph's insertion formatting and provenance.
      // Normalization discards this empty run when real text is present.
      if (node.tagName === 'BR') runs.push(makeRun(placeholder(node) ? '' : '\n'))
      else {
        const style = inlineStyle(node, inherited, paragraphSource)
        let direct = runDirectStyle(node, directStyle)
        const ownSource = node.dataset.wordDirectStyle !== undefined ? { ...paragraphSource, ...(node.dataset.wordSourceColor !== undefined ? { color: normalizeTextColor(node.dataset.wordSourceColor) } : {}), ...direct } : undefined
        if (direct !== undefined && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordColor !== undefined && node.dataset.wordDirectStyle === undefined) {
          // A nested semantic color is an explicit command, including RGB
          // equal to automatic paint. Do not retain its parent's auto item.
          direct = { ...direct, color: normalizeTextColor(node.dataset.wordColor) }
        } else if (direct !== undefined && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordColor === undefined && ownSource?.color === undefined) {
          const color = cssTextColor(node, inherited, style)
          // Preserve a real CSS override even without a paragraph source to
          // trigger rebasing. A matching auto-paint clone adds no override.
          if (color !== undefined) direct = { ...direct, color }
        }
        if (direct !== undefined && !node.hasAttribute('data-word-visual') && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordUnderlineColor === undefined && ownSource?.underlineColor === undefined) {
          const color = cssUnderlineColor(node, inherited)
          if (color !== undefined) direct = { ...direct, underlineColor: color }
        }
        if (direct !== undefined && !node.hasAttribute('data-word-visual') && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordLetterSpacing === undefined && ownSource?.letterSpacing === undefined) {
          const spacing = cssLetterSpacing(node.style.letterSpacing)
          // A native CSS-only wrapper is a new explicit override, including
          // normal/0. Update retained provenance as well as appearance even
          // when the paragraph does not carry a sourceRun to rebase against.
          if (spacing !== undefined) direct = { ...direct, letterSpacing: spacing }
        }
        if (direct !== undefined && !node.hasAttribute('data-word-visual') && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordCaseMap === undefined && ownSource?.caseMap === undefined) {
          const caseMap = cssCaseMap(node, inherited)
          if (caseMap !== undefined) direct = { ...direct, caseMap }
        }
        if (direct !== undefined && !node.hasAttribute('data-word-visual') && node.dataset.wordInsertionStyle === undefined
          && node.dataset.wordKerning === undefined && ownSource?.kerning === undefined) {
          const kerning = cssKerning(node)
          if (kerning !== undefined) direct = { ...direct, kerning }
        }
        // CSS can draw several independent ancestor lines over the same text.
        // The native model has one underline per run, so reject conflicting
        // external origins instead of silently discarding a visible line.
        let textColor = textColorPaint(style) ?? underlineOrigin?.textColor
        if (node.style.color) {
          // A line drawn by an ancestor keeps that origin's actual color.
          // Compare opaque paint here, never the semantic auto token.
          textColor = textColorFromCss(node.style.color) ?? textColor
        }
        if (underlineOrigin?.color === 'auto' && node.style.color && textColor !== underlineOrigin.textColor) throw Error('暂不支持在跟随文字颜色的下划线内单独改变文字颜色，请使用工具栏设置。')
        const line = underlineLine(node)
        let origin = underlineOrigin
        if (line) {
          const next = { line, color: decorationColor(node), textColor }
          const paint = (value: UnderlineOrigin) => value.color === 'auto' ? value.textColor ?? 'auto' : value.color
          if (origin && (origin.line !== next.line || paint(origin) !== paint(next))) throw Error('暂不支持叠加不同样式或颜色的下划线，请使用一种下划线格式。')
          origin = next
        }
        runs.push(...runsFrom(Array.from(node.childNodes), style, direct, runSourceVerticalAlign(node, sourceVerticalAlign), paragraphSource, origin, runSourceColor(node, sourceColor)))
      }
    }
  }
  return runs
}

/** Read only supported text and explicit formatting. No pasted HTML is evaluated. */
export function readWordDom(root: HTMLElement, previous: WordDocument): WordDocument {
  const previousById = new Map(previous.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const paragraphs: WordParagraph[] = paragraphGroups(root).map((nodes, index) => {
    const block = nodes.length === 1 && nodes[0] instanceof HTMLElement && blockTags.has(nodes[0].tagName) ? nodes[0] : undefined
    const old = previousById.get(block?.dataset.wordParagraph || '')
    const heading = Number(block?.dataset.heading || block?.tagName.match(/^H([123])$/)?.[1] || 0) as 0 | 1 | 2 | 3
    const align = block?.style.textAlign
    const style = { ...(old?.style || previous.paragraphs[index]?.style || {}) }
    if (heading !== (style.heading || 0)) style.heading = heading
    if (align && ['left', 'center', 'right', 'justify'].includes(align) && align !== (style.align || 'left')) style.align = align as 'left' | 'center' | 'right' | 'justify'
    const directStyle = old?.directStyle !== undefined ? { ...old.directStyle } : undefined
    if (directStyle && style.heading !== old?.style.heading) directStyle.heading = style.heading
    if (directStyle && style.align !== old?.style.align) directStyle.align = style.align
    const runs = runsFrom(block ? Array.from(block.childNodes) : nodes, {}, undefined, undefined, old?.sourceRun)
    const emptyElement = block?.firstElementChild instanceof HTMLElement ? block.firstElementChild : undefined
    const emptyDirectStyle = runs.length ? undefined : emptyElement ? runDirectStyle(emptyElement) : old?.runs[0]?.directStyle
    const emptySourceVerticalAlign = runs.length ? undefined : emptyElement ? runSourceVerticalAlign(emptyElement) : old?.runs[0]?.sourceVerticalAlign
    const emptySourceColor = runs.length ? undefined : emptyElement ? runSourceColor(emptyElement) : old?.runs[0]?.sourceColor
    return {
      id: block?.dataset.wordParagraph || `paragraph-${crypto.randomUUID()}`,
      runs: runs.length ? runs : [{ text: '', style: emptyElement ? inlineStyle(emptyElement, {}, old?.sourceRun) : { ...old?.runs[0]?.style }, ...(emptyDirectStyle !== undefined ? { directStyle: { ...emptyDirectStyle } } : {}), ...(emptySourceVerticalAlign !== undefined ? { sourceVerticalAlign: emptySourceVerticalAlign } : {}), ...(emptySourceColor !== undefined ? { sourceColor: emptySourceColor } : {}) }],
      style,
      ...(directStyle !== undefined ? { directStyle } : {}),
      ...(old?.sourceRun !== undefined ? { sourceRun: { ...old.sourceRun } } : {}),
      ...(old?.sourceParagraph !== undefined ? { sourceParagraph: { ...old.sourceParagraph } } : {}),
      ...(old?.nextParagraphStyle ? { nextParagraphStyle: structuredClone(old.nextParagraphStyle) } : {}),
      ...(old?.marker ? { marker: structuredClone(old.marker) } : {}),
      ...(old?.sessionInsertion ? { sessionInsertion: structuredClone(old.sessionInsertion) } : {}),
    }
  })
  return normalizeDocument({ ...previous, paragraphs })
}

export interface WordDomOptions { forClipboard?: boolean }
function renderParagraph(paragraph: WordParagraph, options: WordDomOptions): HTMLElement {
    const block = document.createElement('p')
    const text = paragraph.runs.map(run => run.text).join('')
    const markerGeometry = /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n') + 1)) ? paragraph.marker : undefined
    block.dataset.wordParagraph = paragraph.id
    block.dataset.heading = String(paragraph.style.heading || 0)
    block.style.textAlign = paragraph.style.align || 'left'
    block.style.marginTop = `${paragraph.style.spaceBefore || 0}pt`
    block.style.marginBottom = `${paragraph.style.spaceAfter ?? 8}pt`
    block.style.marginLeft = `${paragraph.style.indentLeft ?? 0}pt`
    block.style.marginRight = `${paragraph.style.indentRight ?? 0}pt`
    block.style.textIndent = `${paragraph.style.indentFirstLine ?? 0}pt`
    const fixed = paragraph.style.lineHeightRule === 'exact' && !options.forClipboard
    const multiple = paragraph.style.lineHeightRule === 'exact' || paragraph.style.lineHeightRule === 'atLeast' ? undefined : paragraph.style.lineHeight ?? 1
    const minimum = paragraph.style.lineHeightRule === 'atLeast' ? paragraph.style.lineHeight ?? 12 : undefined
    const runStrut = multiple !== undefined || minimum !== undefined
    // Auto and minimum spacing are supplied by the runs on each individual
    // line. A default 12pt paragraph strut would enlarge lines of smaller text.
    block.style.lineHeight = runStrut ? '0' : `${paragraph.style.lineHeight ?? 12}pt`
    const fixedBaseline = fixed ? (paragraph.style.lineHeight ?? 12) / 2 + (markerGeometry ? 0 : zeroLineBaseline({})) : 0
    const fixLineBox = (element: HTMLElement, style: TextStyle) => {
      // A nonzero inline line-height can still enlarge an exact line when
      // fonts have different ascents. Top-aligned zero-height inline boxes
      // keep natural wrapping; measured baseline bias positions only ink.
      // Unlike inline-blocks, these spans remain breakable across lines.
      element.dataset.wordLineLayout = 'exact'
      element.style.lineHeight = '0'; element.style.verticalAlign = 'top'
      element.style.position = 'relative'; element.style.top = `${fixedBaseline - zeroLineBaseline(style)}pt`
    }
    if (paragraph.style.widowControl !== undefined) { block.style.widows = paragraph.style.widowControl ? '2' : '1'; block.style.orphans = block.style.widows }
    if (paragraph.style.keepNext !== undefined) block.style.breakAfter = paragraph.style.keepNext ? 'avoid' : 'auto'
    if (paragraph.style.keepLines !== undefined) block.style.breakInside = paragraph.style.keepLines ? 'avoid' : 'auto'
    if (paragraph.style.suppressAutoHyphens !== undefined) block.style.hyphens = paragraph.style.suppressAutoHyphens ? 'none' : 'auto'
    // The paragraph strut must not impose a default 12 pt minimum on a
    // smaller marker. Visible runs explicitly keep their own logical size.
    if (markerGeometry || runStrut) block.style.fontSize = '0pt'
    let lastTextParent: HTMLElement = block
    const blankStart = text.lastIndexOf('\n') + 1
    let runOffset = 0
    const layoutRuns = paragraph.runs.flatMap(run => {
      const boundary = blankStart - runOffset; runOffset += run.text.length
      if (!markerGeometry) return [{ run, blank: false }]
      return boundary > 0 && boundary < run.text.length
        ? [{ run: { ...run, text: run.text.slice(0, boundary) }, blank: false }, { run: { ...run, text: run.text.slice(boundary) }, blank: true }]
        : [{ run, blank: boundary <= 0 }]
    })
    for (const { run, blank } of layoutRuns) {
      if (markerGeometry && !run.text) continue
      const span = document.createElement('span'), style = run.style
      if (run.directStyle !== undefined) span.dataset.wordDirectStyle = JSON.stringify(run.directStyle)
      if (run.sourceVerticalAlign !== undefined) span.dataset.wordSourceVerticalAlign = run.sourceVerticalAlign
      if (run.sourceColor !== undefined) span.dataset.wordSourceColor = run.sourceColor
      if (style.bold !== undefined) span.style.fontWeight = style.bold ? 'bold' : 'normal'
      if (style.italic !== undefined) span.style.fontStyle = style.italic ? 'italic' : 'normal'
      if (style.underline !== undefined) span.dataset.wordUnderline = String(style.underline)
      if (style.underlineColor !== undefined) span.dataset.wordUnderlineColor = style.underlineColor
      if (style.strike !== undefined) span.dataset.wordStrike = style.strike
      if (style.verticalAlign !== undefined) span.dataset.wordVerticalAlign = String(style.verticalAlign)
      if (style.caseMap !== undefined) {
        span.dataset.wordCaseMap = style.caseMap
        // Display the case transformation without changing logical text,
        // UTF-16 selection offsets or the text exported to OOXML. CSS uses
        // the run's lang and the available font for locale/small-cap glyphs;
        // their exact metrics are intentionally not native Writer layout.
        span.style.textTransform = style.caseMap === 'upper' ? 'uppercase' : 'none'
        span.style.fontVariantCaps = style.caseMap === 'smallCaps' ? 'small-caps' : 'normal'
        // The application disables synthesized fonts globally. Permit only
        // synthesized small capitals here when the selected font lacks smcp;
        // keep synthesized weight/style disabled, including in copied HTML.
        if (style.caseMap === 'smallCaps') span.style.fontSynthesis = 'small-caps'
      }
      if (style.fontSize !== undefined || markerGeometry || runStrut) span.style.fontSize = `${style.fontSize ?? 12}pt`
      if ((markerGeometry || runStrut) && style.fontSize === undefined) span.dataset.wordFallbackFontSize = ''
      if (style.fontName) {
        // A DOCX font is one family name. Quotes, commas and parentheses in
        // that name must not turn into CSS syntax or a fallback-family list.
        span.dataset.wordFontName = style.fontName
        span.style.fontFamily = fontFamily(style.fontName)
      }
      if (style.fontNameEastAsia) span.dataset.wordFontNameEastAsia = style.fontNameEastAsia
      if (style.fontNameCs) span.dataset.wordFontNameCs = style.fontNameCs
      if (style.color !== undefined) {
        span.dataset.wordColor = style.color
        span.style.color = textColorPaint(style)!
      }
      if (style.highlight !== undefined) {
        span.dataset.wordHighlight = style.highlight
      }
      if (style.backgroundColor !== undefined) span.dataset.wordBackgroundColor = style.backgroundColor
      if (style.highlight !== undefined || style.backgroundColor !== undefined) span.style.backgroundColor = textBackgroundColor(style) ?? 'transparent'
      if (style.language) span.lang = style.language
      if (style.languageEastAsia) span.dataset.wordLanguageEastAsia = style.languageEastAsia
      if (style.languageBidi) span.dataset.wordLanguageBidi = style.languageBidi
      if (style.fontSizeCs !== undefined) span.dataset.wordFontSizeCs = String(style.fontSizeCs)
      if (style.kerning !== undefined) span.dataset.wordKerning = String(style.kerning)
      else span.dataset.wordFallbackKerning = ''
      if (style.letterSpacing !== undefined) {
        span.dataset.wordLetterSpacing = String(style.letterSpacing)
        span.style.letterSpacing = `${visibleLetterSpacing(style)}pt`
      }
      // Writer treats every nonzero OOXML kern value as enabled, irrespective
      // of the logical or script font size. Keep its raw value in metadata.
      span.style.fontKerning = style.kerning ? 'normal' : 'none'
      // Each run supplies its own natural or minimum line box. Do not apply
      // a paragraph-wide maximum: a large glyph on one line cannot enlarge
      // every other line of the paragraph.
      if (minimum !== undefined) span.style.lineHeight = `${Math.max(minimum, naturalFontHeight(style))}pt`
      else if (multiple !== undefined) span.style.lineHeight = `${naturalFontHeight(style) * multiple}pt`
      // Writer ignores the trailing blank line's spaces/tabs when sizing the
      // line. Keep their original font (and advance widths), but let the
      // paragraph mark provide the line box even when it is smaller.
      if (blank) { span.style.lineHeight = '0'; span.style.verticalAlign = 'middle'; span.dataset.wordMarkerWhitespace = '' }
      if (fixed) fixLineBox(span, style)
      let textParent = span
      if (style.verticalAlign === 'superscript' || style.verticalAlign === 'subscript') {
        const visual = document.createElement('span')
        visual.dataset.wordVisual = 'script'
        // Writer's standard escapement uses 58% glyph size and moves the
        // baseline by +33% / -8% of the ORIGINAL size (not the reduced size).
        visual.style.fontSize = '58%'
        if (multiple !== undefined && !blank) visual.style.lineHeight = `${naturalFontHeight({ ...style, fontSize: (style.fontSize ?? 12) * .58 }) * multiple}pt`
        else if (minimum !== undefined && !blank) visual.style.lineHeight = `${naturalFontHeight({ ...style, fontSize: (style.fontSize ?? 12) * .58 })}pt`
        if (blank || fixed) {
          // Blank-line script glyphs still paint at their raised/lowered
          // baseline, but Writer excludes that displacement from line size.
          visual.style.position = 'relative'
          visual.style.top = `${(style.verticalAlign === 'superscript' ? -.33 : .08) / .58}em`
        } else visual.style.verticalAlign = `${(style.verticalAlign === 'superscript' ? .33 : -.08) / .58}em`
        span.append(visual); textParent = visual
      } else if (typeof style.verticalAlign === 'number') {
        const visual = document.createElement('span'), offset = visiblePositionOffset(style)
        visual.dataset.wordVisual = 'position'
        visual.style.fontSize = '100%'
        if (blank || paragraph.style.lineHeightRule === 'exact') {
          // Exact line spacing and trailing blank-line geometry must not be
          // expanded by the shifted ink. Empty markers stay undisplaced.
          visual.style.position = 'relative'; visual.style.top = `${-offset}pt`
        } else visual.style.verticalAlign = `${offset}pt`
        span.append(visual); textParent = visual
      }
      if (style.underline !== undefined) {
        textParent.style.textDecorationLine = style.underline ? 'underline' : 'none'
        textParent.style.textDecorationStyle = style.underline === 'double' ? 'double' : 'solid'
      }
      if (style.underlineColor !== undefined) textParent.style.textDecorationColor = style.underlineColor === 'auto' ? 'currentColor' : style.underlineColor
      if (style.strike === 'single' || style.strike === 'double') {
        const strike = document.createElement('span')
        strike.dataset.wordVisual = 'strike'
        strike.style.textDecorationLine = 'line-through'
        strike.style.textDecorationStyle = style.strike === 'double' ? 'double' : 'solid'
        strike.style.textDecorationColor = 'currentColor'
        textParent.append(strike); textParent = strike
      }
      run.text.split('\n').forEach((part, index) => {
        if (index) { const br = document.createElement('br'); br.dataset.wordBreak = ''; textParent.append(br) }
        if (part) appendGlyphText(textParent, part, style)
      })
      block.append(span)
      lastTextParent = textParent
    }
    if (!text || text.endsWith('\n') || markerGeometry) {
      const br = document.createElement('br'); br.dataset.wordPlaceholder = ''
      if (markerGeometry) {
        const insertion = paragraphInsertionFormat(paragraph), marker = markerGeometry.style
        const semantic = document.createElement('span'), visual = document.createElement('span')
        semantic.dataset.wordInsertionStyle = JSON.stringify(insertion.style)
        if (insertion.directStyle !== undefined) semantic.dataset.wordDirectStyle = JSON.stringify(insertion.directStyle)
        if (insertion.sourceVerticalAlign !== undefined) semantic.dataset.wordSourceVerticalAlign = insertion.sourceVerticalAlign
        if (insertion.sourceColor !== undefined) semantic.dataset.wordSourceColor = insertion.sourceColor
        semantic.style.fontSize = '0pt'
        visual.dataset.wordVisual = 'paragraph-marker'
        visual.style.fontSize = `${marker.fontSize ?? 12}pt`
        if (marker.fontName) visual.style.fontFamily = fontFamily(marker.fontName)
        if (marker.bold !== undefined) visual.style.fontWeight = marker.bold ? 'bold' : 'normal'
        if (marker.italic !== undefined) visual.style.fontStyle = marker.italic ? 'italic' : 'normal'
        if (minimum !== undefined) visual.style.lineHeight = `${Math.max(minimum, naturalFontHeight(marker))}pt`
        else if (multiple !== undefined) visual.style.lineHeight = `${naturalFontHeight(marker) * multiple}pt`
        if (fixed) { semantic.style.lineHeight = '0'; semantic.style.verticalAlign = 'top'; fixLineBox(visual, marker) }
        // Empty markers have no glyph, underline, strike, highlight or
        // shading ink. Escapement retains the logical font-size line box.
        visual.append(br); semantic.append(visual); block.append(semantic)
      } else lastTextParent.append(br)
    }
    return block
}

function fontFamily(name: string): string { return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` }
// Keep semantic run properties on the outer span. These inner font spans only
// choose glyph families for the supported East Asian scripts; they never
// become additional DOCX run formatting when native input is read back.
function appendGlyphText(parent: HTMLElement, text: string, style: TextStyle): void {
  if (!style.fontNameEastAsia || style.fontNameEastAsia === style.fontName) { parent.append(document.createTextNode(text)); return }
  let buffer = '', eastAsian = false
  const append = () => {
    if (!buffer) return
    if (eastAsian) {
      const glyphs = document.createElement('span')
      glyphs.dataset.wordGlyphFont = 'eastAsia'; glyphs.style.fontFamily = fontFamily(style.fontNameEastAsia!)
      glyphs.textContent = buffer; parent.append(glyphs)
    } else parent.append(document.createTextNode(buffer))
  }
  for (const character of text) {
    const next = wordScript(character) === 'eastAsia'
    if (buffer && next !== eastAsian) { append(); buffer = '' }
    eastAsian = next; buffer += character
  }
  append()
}

/** Reconcile paragraphs by identity. Browser edits invalidate only their own
 * paragraph, while model commands can retain every unaffected DOM subtree. */
export function renderWordDom(root: HTMLElement, model: WordDocument, options: WordDomOptions = {}): void {
  const state = renderState(root)
  invalidateRenderedParagraphs(root, state.signatures, state.observer.takeRecords())
  const existing = new Map(Array.from(root.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'P').map(node => [node.dataset.wordParagraph, node]))
  let cursor = root.firstChild
  for (const paragraph of model.paragraphs) {
    const signature = JSON.stringify(paragraph) + `;font-metrics:${positionFontGeneration};clipboard:${!!options.forClipboard}`
    let block = existing.get(paragraph.id)
    if (!block || state.signatures.get(block) !== signature) {
      const previous = block
      block = renderParagraph(paragraph, options)
      state.signatures.set(block, signature)
      if (previous?.parentNode === root) {
        if (cursor === previous) cursor = block
        previous.replaceWith(block)
      }
    }
    if (cursor === block) cursor = block.nextSibling
    else root.insertBefore(block, cursor)
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next }
  // All writes above insert/remove complete paragraphs. Their signatures are
  // already authoritative; do not treat our own reconciliation as native input.
  state.observer.takeRecords()
}

function offsetInside(node: Node, target: Node, offset: number): number | undefined {
  if (node === target) {
    if (node.nodeType === Node.TEXT_NODE) return Math.min(offset, nodeLength(node))
    return Array.from(node.childNodes).slice(0, offset).reduce((length, child) => length + nodeLength(child), 0)
  }
  if (!node.contains(target)) return undefined
  let count = 0
  for (const child of node.childNodes) {
    const found = offsetInside(child, target, offset)
    if (found !== undefined) return count + found
    count += nodeLength(child)
  }
  return undefined
}

export function readWordSelection(root: HTMLElement): WordSelection | undefined {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode) return
  return readWordRange(root, { startContainer: selection.anchorNode, startOffset: selection.anchorOffset, endContainer: selection.focusNode, endOffset: selection.focusOffset })
}

/** Read a native beforeinput target range without changing the visible caret.
 * This uses the same UTF-16 / soft-break accounting as browser selections. */
export function readWordRange(root: HTMLElement, range: Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>): WordSelection | undefined {
  const validEndpoint = (node: Node, offset: number) => root.contains(node) && Number.isInteger(offset) && offset >= 0 && offset <= (node.nodeType === Node.TEXT_NODE ? node.textContent?.length || 0 : node.childNodes.length)
  if (!validEndpoint(range.startContainer, range.startOffset) || !validEndpoint(range.endContainer, range.endOffset)) return
  const groups = paragraphGroups(root)
  const groupByNode = new Map<Node, number>()
  groups.forEach((group, index) => group.forEach(node => groupByNode.set(node, index)))
  const point = (node: Node, offset: number): WordPoint => {
    if (node === root) {
      const after = root.childNodes[offset]
      const nextIndex = after ? groupByNode.get(after) ?? -1 : -1
      if (nextIndex >= 0) {
        const group = groups[nextIndex]!
        return { paragraph: nextIndex, offset: group.slice(0, group.indexOf(after!)).reduce((sum, child) => sum + nodeLength(child), 0) }
      }
      const before = root.childNodes[offset - 1]
      const index = before ? groupByNode.get(before) ?? -1 : -1
      return index < 0 ? { paragraph: 0, offset: 0 } : { paragraph: index, offset: groups[index]!.reduce((sum, child) => sum + nodeLength(child), 0) }
    }
    let top = node
    while (top.parentNode && top.parentNode !== root) top = top.parentNode
    const paragraph = groupByNode.get(top) ?? 0, group = groups[paragraph]!
    const prefix = group.slice(0, group.indexOf(top)).reduce((count, child) => count + nodeLength(child), 0)
    return { paragraph, offset: prefix + (offsetInside(top, node, offset) || 0) }
  }
  return { anchor: point(range.startContainer, range.startOffset), focus: point(range.endContainer, range.endOffset) }
}

function domPoint(block: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset)
  const walk = (node: Node): { node: Node; offset: number } | undefined => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = nodeLength(node)
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      const index = Array.from(node.parentNode!.childNodes).indexOf(node)
      if (remaining === 0) return { node: node.parentNode!, offset: index }
      remaining -= nodeLength(node)
      if (remaining === 0) return { node: node.parentNode!, offset: index + 1 }
    } else for (const child of node.childNodes) { const found = walk(child); if (found) return found }
  }
  return walk(block) || { node: block, offset: block.childNodes.length }
}

export function restoreWordSelection(root: HTMLElement, value: WordSelection): void {
  const children = Array.from(root.children) as HTMLElement[]
  const anchorBlock = children[value.anchor.paragraph], focusBlock = children[value.focus.paragraph]
  if (!anchorBlock || !focusBlock) return
  const anchor = domPoint(anchorBlock, value.anchor.offset), focus = domPoint(focusBlock, value.focus.offset)
  if (document.activeElement !== root) root.focus({ preventScroll: true })
  const selection = window.getSelection()
  if (selection && (selection.anchorNode !== anchor.node || selection.anchorOffset !== anchor.offset || selection.focusNode !== focus.node || selection.focusOffset !== focus.offset)) selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}
