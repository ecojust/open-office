import type { PresentationTextStyle } from '../types'
import { effectiveRichText } from './rich-text.ts'
import { layoutRichText, richTextBounds } from './rich-text-layout.ts'
import type { PresentationModel, SlideModel, SlideObject } from './types'
import { tableGrid } from './table-layout.ts'
import { textDecorationBounds, textDecorationLines, underlineKind, strikeKind } from './text-decorations.ts'
import { textHighlightPaint } from './text-highlight.ts'

export const PT_TO_MM = 25.4 / 72
export interface SceneBox { x: number; y: number; width: number; height: number }
export interface ScenePaint { fill: string | null; stroke: string | null; strokeWidth: number }
export type SceneNode =
  | ({ kind: 'group'; children: SceneNode[]; id?: string; inherited?: boolean; rotation?: number; opacity?: number; clip?: SceneBox; isolateTextPaint?: boolean; isolateHighlightPaint?: boolean } & SceneBox)
  | ({ kind: 'rect'; textHighlight?: boolean } & SceneBox & ScenePaint)
  | ({ kind: 'ellipse' } & SceneBox & ScenePaint)
  | ({ kind: 'path'; points: Array<[number, number]>; closed: boolean; decoration?: 'underline' | 'strike' } & ScenePaint)
  | ({ kind: 'text'; text: string; x: number; y: number; width: number; size: number; family: string; bold: boolean; italic: boolean; underline: boolean; underlineStyle?: PresentationTextStyle['underlineStyle']; strike?: PresentationTextStyle['strike']; color: string })
  | ({ kind: 'image'; dataUrl: string } & SceneBox)

export interface SceneOptions {
  /** Hide objects while an editor supplies its own overlay. IDs include descendants. */
  omitObjectIds?: Iterable<string>
  /** Optional text measurer, taking a size in millimetres. */
  measureText?: (text: string, style: PresentationTextStyle, size: number) => number
  /** Font/glyph vertical bounds in millimetres, used to keep accents/descenders inside clips. */
  measureTextMetrics?: (text: string, style: PresentationTextStyle, size: number) => { ascent: number; descent: number }
  /** Full font line metrics for highlight bands; never changes glyph layout. */
  measureFontMetrics?: (style: PresentationTextStyle, size: number) => { ascent: number; descent: number }
}

export const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? Math.max(-1e7, Math.min(1e7, value!)) : fallback
export const numberText = (value: number) => String(Math.round(finite(value) * 10000) / 10000)
export function safeColor(value: string | null | undefined, fallback: string | null = null): string | null {
  if (!value) return fallback
  const text = String(value).trim()
  if (/^#[\da-f]{6}$/i.test(text)) return text.toLowerCase()
  if (/^#[\da-f]{3}$/i.test(text)) return '#' + [...text.slice(1)].map(x => x + x).join('').toLowerCase()
  const names: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500', purple: '#800080' }
  return names[text.toLowerCase()] ?? fallback
}

/** SVG and remote URLs are deliberately excluded: only inert raster bytes enter the DOM. */
export function safeImageDataUrl(value: string | undefined): string | null {
  return value && /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/]+={0,2}$/i.test(value) ? value : null
}

export function estimatedTextWidth(text: string, _style: PresentationTextStyle, size: number): number {
  let units = 0
  for (const char of text) {
    const cp = char.codePointAt(0)!
    if (/\p{Mark}/u.test(char) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    units += cp >= 0x2e80 ? 1 : /[ilI.,'`!|:;]/.test(char) ? .28 : /[MW@%]/.test(char) ? .85 : /\s/.test(char) ? .3 : .55
  }
  return units * size
}

let canvasContext: CanvasRenderingContext2D | null | undefined
function browserTextMetrics(text: string, style: PresentationTextStyle, size: number) {
  if (typeof document === 'undefined') return null
  if (canvasContext === undefined) canvasContext = document.createElement('canvas').getContext('2d')
  if (!canvasContext) return null
  const family = (style.fontName || 'sans-serif').replace(/["\\\r\n]/g, '')
  canvasContext.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size * 96 / 25.4}px "${family}", "Noto Sans CJK SC", sans-serif`
  return canvasContext.measureText(text)
}
function browserMeasure(text: string, style: PresentationTextStyle, size: number) {
  const metrics = browserTextMetrics(text, style, size)
  return metrics ? metrics.width * 25.4 / 96 : estimatedTextWidth(text, style, size)
}
function browserVerticalMetrics(text: string, style: PresentationTextStyle, size: number) {
  const metrics = browserTextMetrics(text.replace(/\n/g, '') || 'Mg', style, size), k = 25.4 / 96
  if (metrics && metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent > 0) return {
    ascent: Math.max(0, metrics.actualBoundingBoxAscent) * k,
    descent: Math.max(0, metrics.actualBoundingBoxDescent) * k,
  }
  return metrics ? {
    ascent: Math.max(0, metrics.fontBoundingBoxAscent || 0, metrics.actualBoundingBoxAscent || 0) * k,
    descent: Math.max(0, metrics.fontBoundingBoxDescent || 0, metrics.actualBoundingBoxDescent || 0) * k,
  } : { ascent: size * 1.16, descent: size * .288 }
}
function browserFontMetrics(style: PresentationTextStyle, size: number) {
  const metrics = browserTextMetrics('Mg', style, size), k = 25.4 / 96
  return metrics && metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent > 0
    ? { ascent: Math.max(0, metrics.fontBoundingBoxAscent) * k, descent: Math.max(0, metrics.fontBoundingBoxDescent) * k }
    : { ascent: size * 1.16, descent: size * .288 }
}

const boxOf = (object: SlideObject): SceneBox => ({ x: finite(object.x), y: finite(object.y), width: Math.max(0, finite(object.width)), height: Math.max(0, finite(object.height)) })
const fallbackStyle: PresentationTextStyle = { fontName: 'sans-serif', fontSize: 18, bold: false, italic: false, underline: false, color: '#17253b', align: 'left' }
const palette = ['#4472c4', '#ed7d31', '#70ad47', '#a65bba', '#ffc000', '#5b9bd5', '#c0504d', '#548235']
const rect = (box: SceneBox, fill: string | null, stroke: string | null = null, strokeWidth = .2): SceneNode => ({ kind: 'rect', ...box, fill, stroke, strokeWidth })
const path = (points: Array<[number, number]>, stroke: string | null, strokeWidth = .3, fill: string | null = null, closed = false): SceneNode => ({ kind: 'path', points, stroke, strokeWidth, fill, closed })

function resolveTextLayout(text: string, box: SceneBox, inputStyle: Partial<PresentationTextStyle>, padding: number, layout: SlideObject['textLayout'], measure: NonNullable<SceneOptions['measureText']>, metrics: NonNullable<SceneOptions['measureTextMetrics']>) {
  const style = { ...fallbackStyle, ...inputStyle }
  const size = Math.max(.35, Math.min(400, finite(style.fontSize, 18))) * PT_TO_MM
  const insets = {
    left: finite(layout?.insets?.left, padding), right: finite(layout?.insets?.right, padding),
    top: finite(layout?.insets?.top, padding), bottom: finite(layout?.insets?.bottom, padding),
  }
  const inner = { x: box.x + insets.left, y: box.y + insets.top, width: Math.max(0, box.width - insets.left - insets.right), height: Math.max(0, box.height - insets.top - insets.bottom) }
  const clean = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  const measured = metrics(clean, style, size)
  const decorations = textDecorationBounds(style, size)
  const ascent = Math.max(decorations.ascent, finite(measured.ascent, size * 1.16)), descent = Math.max(decorations.descent, finite(measured.descent, size * .288))
  const lineHeight = Math.max(size * 1.25, ascent + descent)
  const wrapped: Array<{ text: string; last: boolean }> = []
  for (const paragraph of clean.split('\n')) {
    if (layout?.wrap === false) { wrapped.push({ text: paragraph, last: true }); continue }
    let current = ''
    for (const char of paragraph) {
      if (current && measure(current + char, style, size) > Math.max(.1, inner.width)) {
        const lastSpace = current.lastIndexOf(' ')
        if (lastSpace > current.length / 2 && char !== ' ') {
          wrapped.push({ text: current.slice(0, lastSpace), last: false })
          current = current.slice(lastSpace + 1) + char
        } else { wrapped.push({ text: current, last: false }); current = char }
      } else current += char
    }
    wrapped.push({ text: current, last: true })
  }
  const contentHeight = ascent + descent + Math.max(0, wrapped.length - 1) * lineHeight
  const extra = inner.height - contentHeight
  const startY = inner.y + (layout?.verticalAlign === 'middle' ? extra / 2 : layout?.verticalAlign === 'bottom' ? extra : 0)
  return { style, size, ascent, descent, lineHeight, insets, inner, wrapped, contentHeight, startY }
}

/** Shared measurements for the live textarea overlay; all dimensions are millimetres. */
export function textLayoutFor(object: SlideObject, options: Pick<SceneOptions, 'measureText' | 'measureTextMetrics'> = {}) {
  const box = boxOf(object)
  const layout = resolveTextLayout(object.text, box, object.textStyle, 1.3, object.textLayout, options.measureText ?? browserMeasure, options.measureTextMetrics ?? browserVerticalMetrics)
  return { insets: layout.insets, inner: layout.inner, top: layout.startY - box.y, contentHeight: layout.contentHeight,
    lineHeight: layout.lineHeight, fontSize: layout.size, ascent: layout.ascent, descent: layout.descent, firstBaseline: layout.startY - box.y + layout.ascent,
    lineCount: layout.wrapped.length, rotation: finite(object.textLayout?.rotation) }
}

/** Every consumer shares wrapping, chart geometry, clipping and stacking order. */
export function buildSlideScene(model: PresentationModel, slide: SlideModel, options: SceneOptions = {}): SceneNode[] {
  const measure = options.measureText ?? browserMeasure
  const metrics = options.measureTextMetrics ?? browserVerticalMetrics
  const fontMetrics = options.measureFontMetrics ?? browserFontMetrics
  const fontMetricCache = new Map<string, { ascent: number; descent: number }>()
  const highlightMetrics = (style: PresentationTextStyle, size: number) => {
    const key = JSON.stringify([style.fontName, style.bold, style.italic, size]), cached = fontMetricCache.get(key)
    if (cached) return cached
    const value = fontMetrics(style, size)
    const result = { ascent: Math.max(0, finite(value.ascent, size * 1.16)), descent: Math.max(0, finite(value.descent, size * .288)) }
    fontMetricCache.set(key, result); return result
  }
  const omitted = new Set(options.omitObjectIds)
  const textOpacity = (node: SceneNode, style: PresentationTextStyle, box: SceneBox): SceneNode => {
    const opacity = Math.max(0, Math.min(1, finite(style.opacity, 1)))
    return opacity === 1 ? node : { kind: 'group', ...box, opacity, children: [node] }
  }
  const highlight = (style: PresentationTextStyle, box: SceneBox): SceneNode[] => {
    const paint = textHighlightPaint(style)
    if (!paint || box.width <= 0 || box.height <= 0) return []
    const node: SceneNode = { kind: 'rect', ...box, textHighlight: true, fill: paint.color, stroke: null, strokeWidth: 0 }
    return [paint.opacity === 1 ? node : { kind: 'group', ...box, opacity: paint.opacity, children: [node] }]
  }
  const decoratedText = (node: Extract<SceneNode, { kind: 'text' }>, style: PresentationTextStyle, box: SceneBox): SceneNode => {
    const lines = textDecorationLines(style, node.size)
    const decorations: SceneNode[] = node.width > 0 ? lines.map(line => ({ kind: 'path', points: [[node.x, node.y + line.offset], [node.x + node.width, node.y + line.offset]], closed: false, decoration: line.kind, fill: null, stroke: node.color, strokeWidth: line.thickness })) : []
    return textOpacity(decorations.length ? { kind: 'group', ...box, isolateTextPaint: true, children: [node, ...decorations] } : node, style, box)
  }
  function textBlock(text: string, box: SceneBox, inputStyle: Partial<PresentationTextStyle>, padding = 1.3, layout?: SlideObject['textLayout']): SceneNode[] {
    if (!text || box.width <= 0 || box.height <= 0) return []
    const { style, size, ascent, descent, lineHeight, inner, wrapped, startY } = resolveTextLayout(text, box, inputStyle, padding, layout, measure, metrics)
    if (!inner.width || !inner.height) return []
    const innerWidth = inner.width
    // The PDF paint form must use the same clipping rectangle as the text.
    // Legal negative insets can make that rectangle larger than the shape.
    const textClip = layout ? inner : box
    const result: SceneNode[] = [], highlights: SceneNode[] = []
    for (let index = 0; index < wrapped.length; index++) {
      const line = wrapped[index]!
      const y = startY + ascent + index * lineHeight
      if (y - ascent > inner.y + inner.height) break
      if (y + descent < inner.y) continue
      const width = measure(line.text, style, size)
      const start = inner.x + (style.align === 'right' ? innerWidth - width : style.align === 'center' ? (innerWidth - width) / 2 : 0)
      const justified = style.align === 'justify' && !line.last && line.text.includes(' ')
      if (textHighlightPaint(style)) {
        const band = highlightMetrics(style, size)
        highlights.push(...highlight(style, { x: start, y: y - band.ascent, width: justified ? innerWidth : width, height: band.ascent + band.descent }))
      }
      const node = (value: string, x: number, w: number): SceneNode => decoratedText({ kind: 'text', text: value, x, y, width: w, size, family: style.fontName, bold: !!style.bold, italic: !!style.italic, underline: underlineKind(style) !== 'none', underlineStyle: underlineKind(style), strike: strikeKind(style), color: safeColor(style.color, '#17253b')! }, style, textClip)
      if (justified) {
        const words = line.text.trim().split(/ +/)
        const widths = words.map(word => measure(word, style, size))
        const gap = (innerWidth - widths.reduce((sum, w) => sum + w, 0)) / Math.max(1, words.length - 1)
        let x = start
        words.forEach((word, i) => { result.push(node(word, x, widths[i]!)); x += widths[i]! + gap })
      } else result.push(node(line.text, start, width))
    }
    return [{ kind: 'group', ...box, ...(layout?.rotation ? { rotation: finite(layout.rotation) } : {}), ...(highlights.length ? { isolateHighlightPaint: true } : {}), clip: textClip, children: [...highlights, ...result] }]
  }

  function richBlock(object: SlideObject): SceneNode[] {
    const paragraphs = effectiveRichText(object)
    if (!paragraphs) return textBlock(object.text, boxOf(object), object.textStyle, 1.3, object.textLayout)
    const box = boxOf(object), layout = object.textLayout
    const left = finite(layout?.insets?.left, 1.3), right = finite(layout?.insets?.right, 1.3)
    const top = finite(layout?.insets?.top, 1.3), bottom = finite(layout?.insets?.bottom, 1.3)
    const inner = { x: box.x + left, y: box.y + top, width: Math.max(0, box.width - left - right), height: Math.max(0, box.height - top - bottom) }
    if (!object.text || !inner.width || !inner.height) return []
    const lines = layoutRichText(paragraphs, inner.width, layout?.wrap !== false, measure, metrics, { spaceFirstLastParagraph: object.richText?.spaceFirstLastParagraph })
    const bounds = richTextBounds(lines), extra = inner.height - bounds.height
    const y = inner.y - bounds.top + (layout?.verticalAlign === 'middle' ? extra / 2 : layout?.verticalAlign === 'bottom' ? extra : 0)
    const nodes: SceneNode[] = [], highlights: SceneNode[] = []
    for (const line of lines) {
      const baseline = y + line.baseline
      let highlightAscent = 0, highlightDescent = 0
      if (line.fragments.some(fragment => textHighlightPaint(fragment.style))) for (const fragment of line.fragments) {
        const band = highlightMetrics(fragment.style, fragment.size)
        highlightAscent = Math.max(highlightAscent, band.ascent + fragment.baselineOffset)
        highlightDescent = Math.max(highlightDescent, band.descent - fragment.baselineOffset)
      }
      if (y + line.top <= inner.y + inner.height && y + line.bottom >= inner.y) {
        let x = inner.x + (line.align === 'right' ? inner.width - line.width : line.align === 'center' ? (inner.width - line.width) / 2 : 0)
        const spaces = line.fragments.reduce((sum, fragment) => sum + (fragment.text.match(/ /g)?.length || 0), 0)
        const gap = line.align === 'justify' && !line.last && spaces ? Math.max(0, inner.width - line.width) / spaces : 0
        for (const fragment of line.fragments) {
          const chunks = gap ? fragment.text.split(/( )/) : [fragment.text]
          for (const text of chunks) {
            if (!text) continue
            const width = gap ? measure(text, fragment.style, fragment.size) : fragment.width
            highlights.push(...highlight(fragment.style, { x, y: baseline - highlightAscent, width: width + (text === ' ' ? gap : 0), height: highlightAscent + highlightDescent }))
            nodes.push(decoratedText({ kind: 'text', text, x, y: baseline - fragment.baselineOffset, width, size: fragment.size, family: fragment.style.fontName,
              bold: !!fragment.style.bold, italic: !!fragment.style.italic, underline: underlineKind(fragment.style) !== 'none', underlineStyle: underlineKind(fragment.style), strike: strikeKind(fragment.style), color: safeColor(fragment.style.color, '#17253b')! }, fragment.style, inner))
            x += width + (text === ' ' ? gap : 0)
          }
        }
      }
    }
    return [{ kind: 'group', ...box, ...(layout?.rotation ? { rotation: finite(layout.rotation) } : {}), ...(highlights.length ? { isolateHighlightPaint: true } : {}), clip: inner, children: [...highlights, ...nodes] }]
  }

  function placeholder(object: SlideObject, label: string): SceneNode[] {
    const box = boxOf(object)
    return [rect(box, '#f1f4f9', '#9aa8bb', .3), path([[box.x, box.y], [box.x + box.width, box.y + box.height]], '#c9d1df', .2), ...textBlock(`${label}\n${object.name || ''}`, box, { fontSize: 11, color: '#5a6678', align: 'center' })]
  }

  function chart(object: SlideObject): SceneNode[] {
    const data = object.chart
    if (!data || !data.categories.length || !data.series.length) return placeholder(object, object.locked ? '暂不支持此类图表预览\n原始数据保留' : '图表无数据')
    const box = boxOf(object), result: SceneNode[] = [rect(box, safeColor(object.fillColor, '#ffffff'), safeColor(object.lineColor), finite(object.lineWidth, .2))]
    const fs = Math.max(5, Math.min(11, box.width / 7))
    const titleHeight = data.title ? Math.min(10, box.height * .15) : 2
    const legendHeight = Math.min(8, box.height * .15)
    if (data.title) result.push(...textBlock(data.title, { x: box.x + 2, y: box.y + 1, width: box.width - 4, height: titleHeight }, { fontSize: fs + 2, bold: true, align: 'center' }, .5))
    const plot = { x: box.x + Math.min(15, box.width * .18), y: box.y + titleHeight + 2, width: Math.max(1, box.width - Math.min(20, box.width * .25)), height: Math.max(1, box.height - titleHeight - legendHeight - 9) }
    const legend = data.type === 'pie' ? data.categories : data.series
    const legendWidth = box.width / legend.length
    legend.forEach((name, i) => {
      const x = box.x + i * legendWidth + 1, y = box.y + box.height - legendHeight
      result.push(rect({ x, y: y + 1, width: 2, height: 2 }, palette[i % palette.length]!))
      result.push(...textBlock(name, { x: x + 3, y, width: Math.max(1, legendWidth - 4), height: legendHeight }, { fontSize: fs - 1 }, .2))
    })
    // Values are data, not page coordinates: keep their magnitude. Normalize
    // before arithmetic so even imported extreme finite numbers cannot overflow.
    const rawValue = (row: number, column: number) => { const value = data.values[row]?.[column]; return Number.isFinite(value) ? value! : 0 }
    const magnitude = Math.max(...data.categories.flatMap((_, row) => data.series.map((__, column) => Math.abs(rawValue(row, column))))) || 1
    const value = (row: number, column: number) => rawValue(row, column) / magnitude
    if (data.type === 'pie') {
      const values = data.categories.map((_, i) => Math.max(0, value(i, 0))), total = values.reduce((a, b) => a + b, 0)
      if (!total) return [...result, ...textBlock('暂无正值数据', plot, { fontSize: fs, align: 'center' })]
      const cx = box.x + box.width / 2, cy = plot.y + plot.height / 2, radius = Math.max(.1, Math.min(plot.width, plot.height) / 2)
      let start = -Math.PI / 2
      values.forEach((v, i) => {
        if (!v) return
        const angle = v / total * Math.PI * 2, segments = Math.max(2, Math.ceil(angle / .04))
        const points: Array<[number, number]> = [[cx, cy]]
        for (let j = 0; j <= segments; j++) points.push([cx + radius * Math.cos(start + angle * j / segments), cy + radius * Math.sin(start + angle * j / segments)])
        result.push(path(points, '#ffffff', .2, palette[i % palette.length]!, true)); start += angle
      })
      return result
    }
    const allValues = data.categories.flatMap((_, r) => data.series.map((__, c) => value(r, c)))
    const minimum = Math.min(0, ...allValues), maximum = Math.max(0, ...allValues), span = maximum - minimum || 1
    const xValue = (v: number) => plot.x + (v - minimum) / span * plot.width
    const yValue = (v: number) => plot.y + plot.height - (v - minimum) / span * plot.height
    for (let tick = 0; tick <= 4; tick++) {
      const v = minimum + span * tick / 4, displayed = v * magnitude, label = Math.abs(displayed) >= 10000 ? displayed.toExponential(1) : String(Math.round(displayed * 100) / 100)
      if (data.type === 'bar') {
        const x = xValue(v)
        result.push(path([[x, plot.y], [x, plot.y + plot.height]], '#e0e5ed', .15))
        result.push(...textBlock(label, { x: x - 6, y: plot.y + plot.height + 1, width: 12, height: 5 }, { fontSize: fs - 2, align: 'center' }, 0))
      } else {
        const y = yValue(v)
        result.push(path([[plot.x, y], [plot.x + plot.width, y]], '#e0e5ed', .15))
        result.push(...textBlock(label, { x: box.x, y: y - 1.7, width: plot.x - box.x - 1, height: 5 }, { fontSize: fs - 2, align: 'right' }, 0))
      }
    }
    if (data.type === 'bar') {
      const band = plot.height / data.categories.length, h = band * .7 / data.series.length
      data.categories.forEach((category, r) => {
        result.push(...textBlock(category, { x: box.x + .5, y: plot.y + band * r + band / 2 - 2, width: plot.x - box.x - 1, height: Math.max(4, band) }, { fontSize: fs - 1, align: 'right' }, .1))
        data.series.forEach((_, c) => { const v = value(r, c), x = xValue(Math.min(0, v)); result.push(rect({ x, y: plot.y + band * r + band * .15 + h * c, width: Math.abs(xValue(v) - xValue(0)), height: h * .9 }, palette[c % palette.length]!)) })
      })
      result.push(path([[xValue(0), plot.y], [xValue(0), plot.y + plot.height]], '#8a95a6', .25))
    } else {
      const band = plot.width / data.categories.length, w = band * .7 / data.series.length
      data.categories.forEach((category, r) => result.push(...textBlock(category, { x: plot.x + band * r, y: plot.y + plot.height + 1, width: band, height: 6 }, { fontSize: fs - 1, align: 'center' }, .1)))
      data.series.forEach((_, c) => {
        if (data.type === 'line') {
          const points: Array<[number, number]> = data.categories.map((__, r) => [plot.x + band * (r + .5), yValue(value(r, c))])
          result.push(path(points, palette[c % palette.length]!, .65))
          points.forEach(([x, y]) => result.push({ kind: 'ellipse', x: x - .8, y: y - .8, width: 1.6, height: 1.6, fill: palette[c % palette.length]!, stroke: '#ffffff', strokeWidth: .15 }))
        } else data.categories.forEach((__, r) => { const v = value(r, c); result.push(rect({ x: plot.x + band * r + band * .15 + w * c, y: yValue(Math.max(0, v)), width: w * .9, height: Math.abs(yValue(v) - yValue(0)) }, palette[c % palette.length]!)) })
      })
      result.push(path([[plot.x, yValue(0)], [plot.x + plot.width, yValue(0)]], '#8a95a6', .25))
    }
    return result
  }

  function objectScene(object: SlideObject, inherited = false, depth = 0): SceneNode[] {
    if (omitted.has(object.id) || depth > 32) return []
    const box = boxOf(object), fill = safeColor(object.fillColor), stroke = safeColor(object.lineColor), strokeWidth = Math.max(0, finite(object.lineWidth, .2))
    const fillAlpha = Math.max(0, Math.min(1, finite(object.fillOpacity, 1))), lineAlpha = Math.max(0, Math.min(1, finite(object.lineOpacity, 1)))
    const paintOpacity = (node: SceneNode, opacity: number): SceneNode => opacity === 1 ? node : { kind: 'group', ...box, opacity, children: [node] }
    let nodes: SceneNode[] = []
    if (object.diagramPreview && safeImageDataUrl(object.diagramPreview.dataUrl)) nodes = [{ kind: 'image', ...box, dataUrl: object.diagramPreview.dataUrl }]
    else if (object.type === 'group') nodes = (object.children ?? []).slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(child => objectScene(child, inherited, depth + 1))
    else if (object.type === 'image') { const dataUrl = safeImageDataUrl(object.image?.dataUrl); nodes = dataUrl ? [{ kind: 'image', ...box, dataUrl }] : placeholder(object, '不支持的图片格式') }
    else if (object.type === 'table') {
      const rows = object.table?.cells ?? [], grid = tableGrid(object), rowCount = rows.length, colCount = Math.max(0, ...rows.map(row => row.length))
      const offsets = (values: number[]) => { let total = 0; return values.map(value => { const offset = total; total += value; return offset / 36000 }) }
      const columnOffsets = grid ? offsets(grid.columns) : [], rowOffsets = grid ? offsets(grid.rows) : []
      if (!rowCount || !colCount || !grid) nodes = placeholder(object, object.sourceXml || object.locked ? '暂不支持此类表格预览\n原始数据保留' : '空表格')
      else rows.forEach((row, r) => { for (let c = 0; c < colCount; c++) {
        const cell = { x: box.x + columnOffsets[c]!, y: box.y + rowOffsets[r]!, width: grid.columns[c]! / 36000, height: grid.rows[r]! / 36000 }
        const metadata = object.tableCellText?.[r]?.[c], value = row[c] ?? ''
        const richText = metadata?.richText || (!object.sourceXml || object.table?.rebuilt ? { sourceText: value, sourceStyle: object.textStyle, paragraphs: value.split('\n').map(text => ({ style: object.textStyle, runs: [{ text, style: object.textStyle }] })) } : undefined)
        const layout = metadata?.textLayout || { ...object.textLayout, verticalAlign: object.textLayout?.verticalAlign || 'top' as const, wrap: object.textLayout?.wrap !== false, insets: { left: 2.54, right: 2.54, top: 1.27, bottom: 1.27 } }
        const text = richText ? richBlock({ ...object, ...cell, type: 'text', text: value, richText, textStyle: richText.sourceStyle, textStyleOverrides: undefined, textLayout: layout }) : textBlock(value, cell, object.textStyle, 1)
        const paint = object.tableLayout?.cells[r]?.[c], cellFill = !object.sourceXml || object.table?.rebuilt ? fill : safeColor(paint?.fill), background = rect(cell, cellFill, null, 0)
        // Cell transparency affects its paint only, never the foreground text.
        nodes.push(paint && paint.opacity !== 1 && !object.table?.rebuilt ? { kind: 'group', ...cell, opacity: paint.opacity, children: [background] } : background, ...text)
      } })
    } else if (object.type === 'chart') nodes = chart(object)
    else if (object.type === 'line') nodes = stroke && strokeWidth > 0 ? [paintOpacity(path([[box.x, box.y], [box.x + box.width, box.y + box.height]], stroke, strokeWidth), lineAlpha)] : []
    else if (['text', 'rectangle', 'ellipse'].includes(object.type)) {
      const kind = object.type === 'ellipse' ? 'ellipse' : 'rect'
      if (fillAlpha === 1 && lineAlpha === 1) {
        if (fill || stroke) nodes.push({ kind, ...box, fill, stroke, strokeWidth })
      } else {
        if (fill) nodes.push(paintOpacity({ kind, ...box, fill, stroke: null, strokeWidth: 0 }, fillAlpha))
        if (stroke && strokeWidth > 0) nodes.push(paintOpacity({ kind, ...box, fill: null, stroke, strokeWidth }, lineAlpha))
      }
      nodes.push(...richBlock(object))
    } else nodes = placeholder(object, '暂不支持的对象')
    return [{ kind: 'group', ...box, id: object.id, inherited, rotation: finite(object.rotation), opacity: Math.max(0, Math.min(1, finite(object.opacity, 1))), children: nodes }]
  }
  return [rect({ x: 0, y: 0, width: Math.max(1, finite(model.width, 254)), height: Math.max(1, finite(model.height, 142.875)) }, safeColor(slide.background, '#ffffff')),
    ...(slide.inheritedObjects ?? []).slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(object => objectScene(object, true)),
    ...slide.objects.slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(object => objectScene(object))]
}
