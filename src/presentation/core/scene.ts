import type { PresentationTextStyle } from '../types'
import type { PresentationModel, SlideModel, SlideObject } from './types'

export const PT_TO_MM = 25.4 / 72
export interface SceneBox { x: number; y: number; width: number; height: number }
export interface ScenePaint { fill: string | null; stroke: string | null; strokeWidth: number }
export type SceneNode =
  | ({ kind: 'group'; children: SceneNode[]; id?: string; inherited?: boolean; rotation?: number; opacity?: number; clip?: SceneBox } & SceneBox)
  | ({ kind: 'rect' } & SceneBox & ScenePaint)
  | ({ kind: 'ellipse' } & SceneBox & ScenePaint)
  | ({ kind: 'path'; points: Array<[number, number]>; closed: boolean } & ScenePaint)
  | ({ kind: 'text'; text: string; x: number; y: number; width: number; size: number; family: string; bold: boolean; italic: boolean; underline: boolean; color: string })
  | ({ kind: 'image'; dataUrl: string } & SceneBox)

export interface SceneOptions {
  /** Hide objects while an editor supplies its own overlay. IDs include descendants. */
  omitObjectIds?: Iterable<string>
  /** Optional text measurer, taking a size in millimetres. */
  measureText?: (text: string, style: PresentationTextStyle, size: number) => number
  /** Font/glyph vertical bounds in millimetres, used to keep accents/descenders inside clips. */
  measureTextMetrics?: (text: string, style: PresentationTextStyle, size: number) => { ascent: number; descent: number }
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
  const ascent = Math.max(0, finite(measured.ascent, size * 1.16)), descent = Math.max(style.underline ? size * .13 : 0, finite(measured.descent, size * .288))
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
  const omitted = new Set(options.omitObjectIds)
  function textBlock(text: string, box: SceneBox, inputStyle: Partial<PresentationTextStyle>, padding = 1.3, layout?: SlideObject['textLayout']): SceneNode[] {
    if (!text || box.width <= 0 || box.height <= 0) return []
    const { style, size, ascent, descent, lineHeight, inner, wrapped, startY } = resolveTextLayout(text, box, inputStyle, padding, layout, measure, metrics)
    if (!inner.width || !inner.height) return []
    const innerWidth = inner.width
    const result: SceneNode[] = []
    for (let index = 0; index < wrapped.length; index++) {
      const line = wrapped[index]!
      const y = startY + ascent + index * lineHeight
      if (y - ascent > inner.y + inner.height) break
      if (y + descent < inner.y) continue
      const width = measure(line.text, style, size)
      const start = inner.x + (style.align === 'right' ? innerWidth - width : style.align === 'center' ? (innerWidth - width) / 2 : 0)
      const node = (value: string, x: number, w: number): SceneNode => ({ kind: 'text', text: value, x, y, width: w, size, family: style.fontName, bold: !!style.bold, italic: !!style.italic, underline: !!style.underline, color: safeColor(style.color, '#17253b')! })
      if (style.align === 'justify' && !line.last && line.text.includes(' ')) {
        const words = line.text.trim().split(/ +/)
        const widths = words.map(word => measure(word, style, size))
        const gap = (innerWidth - widths.reduce((sum, w) => sum + w, 0)) / Math.max(1, words.length - 1)
        let x = start
        words.forEach((word, i) => { result.push(node(word, x, widths[i]!)); x += widths[i]! + gap })
      } else result.push(node(line.text, start, width))
    }
    return [{ kind: 'group', ...box, ...(layout?.rotation ? { rotation: finite(layout.rotation) } : {}), clip: layout ? inner : box, children: result }]
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
    let nodes: SceneNode[] = []
    if (object.type === 'group') nodes = (object.children ?? []).slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(child => objectScene(child, inherited, depth + 1))
    else if (object.type === 'image') { const dataUrl = safeImageDataUrl(object.image?.dataUrl); nodes = dataUrl ? [{ kind: 'image', ...box, dataUrl }] : placeholder(object, '不支持的图片格式') }
    else if (object.type === 'table') {
      const rows = object.table?.cells ?? [], rowCount = rows.length, colCount = Math.max(0, ...rows.map(row => row.length))
      if (!rowCount || !colCount) nodes = placeholder(object, object.locked ? '暂不支持此类表格预览\n原始数据保留' : '空表格')
      else rows.forEach((row, r) => { for (let c = 0; c < colCount; c++) {
        const cell = { x: box.x + c * box.width / colCount, y: box.y + r * box.height / rowCount, width: box.width / colCount, height: box.height / rowCount }
        nodes.push(rect(cell, fill ?? (r === 0 ? '#e7edf8' : '#ffffff'), stroke ?? '#9caac0', strokeWidth || .2), ...textBlock(row[c] ?? '', cell, object.textStyle, 1))
      } })
    } else if (object.type === 'chart') nodes = chart(object)
    else if (object.type === 'line') nodes = stroke && strokeWidth > 0 ? [path([[box.x, box.y], [box.x + box.width, box.y + box.height]], stroke, strokeWidth)] : []
    else if (['text', 'rectangle', 'ellipse'].includes(object.type)) {
      if (fill || stroke) nodes.push({ kind: object.type === 'ellipse' ? 'ellipse' : 'rect', ...box, fill, stroke, strokeWidth })
      nodes.push(...textBlock(object.text, box, object.textStyle, 1.3, object.textLayout))
    } else nodes = placeholder(object, '暂不支持的对象')
    return [{ kind: 'group', ...box, id: object.id, inherited, rotation: finite(object.rotation), opacity: Math.max(0, Math.min(1, finite(object.opacity, 1))), children: nodes }]
  }
  return [rect({ x: 0, y: 0, width: Math.max(1, finite(model.width, 254)), height: Math.max(1, finite(model.height, 142.875)) }, safeColor(slide.background, '#ffffff')),
    ...(slide.inheritedObjects ?? []).slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(object => objectScene(object, true)),
    ...slide.objects.slice().sort((a, b) => a.zIndex - b.zIndex).flatMap(object => objectScene(object))]
}
