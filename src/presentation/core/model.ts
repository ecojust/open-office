import type { PresentationAction, PresentationChartData, PresentationGeometry, PresentationObjectData, PresentationObjectQuery, PresentationPage, PresentationState, PresentationTextStyle } from '../types'
import type { NewPptxMedia, PptxPatch, PptxTransition } from '../pptx-package'
import type { PresentationModel, SlideModel, SlideObject } from './types'
import { commitSmartArtTextEdit, refreshSmartArtEditability, smartArtEditBlockReason, hasSmartArtBinding } from './smartart-text.ts'

import { formatTextRange } from './text-range-format.ts'
import { formatParagraphs } from './paragraph-format.ts'
import { replaceTextContent } from './text-content-edit.ts'
import { replaceTableText } from './table-text-content.ts'
import { paintOpacityEditable } from './paint-opacity.ts'
import { formatWholeTextPaint } from './format-text-paint.ts'

export const PRESENTATION_LIMITS = Object.freeze({ slides: 500, objects: 2000, text: 20000, notes: 50000, history: 80, historyBytes: 32 * 1024 * 1024, imageBytes: 32 * 1024 * 1024, mediaBytes: 64 * 1024 * 1024 })
export type PresentationPatch = Omit<PptxPatch['slides'][number], 'slideIndex'> & { expectedRevision?: number }
type Snapshot = { model: PresentationModel; page: number; selection: string[]; version: number; weight: number }
const layouts = [0, 1, 3, 19, 20, 32]
const geometryKeys = ['x', 'y', 'width', 'height', 'rotation'] as const
let serial = 0
function id(prefix: string) { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++serial}`}` }
function requireValue(value: unknown, message: string): asserts value { if (!value) throw Error(message) }
function number(value: unknown, min: number, max: number, label: string) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label}必须在 ${min}–${max} 之间。`)
  return value
}
function integer(value: unknown, min: number, max: number, label: string) { const n = number(value, min, max, label); requireValue(Number.isInteger(n), `${label}必须为整数。`); return n }
function string(value: unknown, max: number, label: string, empty = true) {
  requireValue(typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) && (empty || value.trim()), `${label}长度或内容无效。`)
  return value
}
function boolean(value: unknown, label: string) { requireValue(typeof value === 'boolean', `${label}必须为布尔值。`); return value }
function choice<const T extends string | number>(value: unknown, choices: readonly T[], label: string): T { requireValue(choices.includes(value as T), `不支持的${label}。`); return value as T }
function color(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  requireValue(typeof value === 'string' && /^#[\da-f]{6}$/i.test(value), '颜色必须为 #RRGGBB。')
  return value.toUpperCase()
}
/** Immutable package bytes and media buffers are intentionally shared by history. */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Map) return value
  if (Array.isArray(value)) return value.map(item => clone(item)) as T
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a instanceof Map || b instanceof Map || a instanceof Uint8Array || b instanceof Uint8Array) return false
  const ak = Object.keys(a), bk = Object.keys(b)
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}
function weight(value: unknown): number {
  if (typeof value === 'string') return value.length * 2
  if (!value || typeof value !== 'object') return 8
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof Map) return 8
  return Object.entries(value).reduce((n, [key, item]) => n + key.length * 2 + weight(item), 0)
}
function textStyle(patch: Partial<PresentationTextStyle> = {}): Partial<PresentationTextStyle> {
  requireValue(patch && typeof patch === 'object' && !Array.isArray(patch), '文字样式无效。')
  const output: Partial<PresentationTextStyle> = {}
  for (const key of Object.keys(patch)) requireValue(['fontName', 'fontSize', 'bold', 'italic', 'underline', 'underlineStyle', 'strike', 'color', 'opacity', 'highlightColor', 'highlightOpacity', 'align'].includes(key), `不支持的文字样式：${key}`)
  if (patch.fontName !== undefined) output.fontName = string(patch.fontName, 120, '字体名称', false)
  if (patch.fontSize !== undefined) output.fontSize = number(patch.fontSize, 5, 300, '字号')
  if (patch.color !== undefined) output.color = color(patch.color)!
  if (patch.opacity !== undefined) output.opacity = Math.round(number(patch.opacity, 0, 1, '文字不透明度') * 100000) / 100000
  if (patch.highlightOpacity !== undefined) requireValue(patch.highlightColor !== undefined, '设置高亮透明度时，请同时明确选择高亮颜色。')
  if (patch.highlightColor !== undefined) {
    const alpha = patch.highlightOpacity === undefined ? patch.highlightColor === null ? 0 : 1 : Math.round(number(patch.highlightOpacity, 0, 1, '高亮不透明度') * 100000) / 100000
    requireValue(patch.highlightColor !== null || alpha === 0, '清除高亮不能同时指定非零不透明度。')
    const selected = patch.highlightColor === null ? null : color(patch.highlightColor)
    output.highlightColor = alpha === 0 ? null : selected; output.highlightOpacity = alpha
  }
  if (patch.align !== undefined) output.align = choice(patch.align, ['left', 'center', 'right', 'justify'], '文字对齐')
  for (const key of ['bold', 'italic'] as const) if (patch[key] !== undefined) output[key] = boolean(patch[key], key)
  if (patch.underlineStyle !== undefined) {
    output.underlineStyle = choice(patch.underlineStyle, ['none', 'single', 'double'], '下划线样式'); output.underline = output.underlineStyle !== 'none'
    if (patch.underline !== undefined) requireValue(boolean(patch.underline, '下划线') === output.underline, '下划线开关和样式相互冲突。')
  } else if (patch.underline !== undefined) { output.underline = boolean(patch.underline, '下划线'); output.underlineStyle = output.underline ? 'single' : 'none' }
  if (patch.strike !== undefined) output.strike = choice(patch.strike, ['none', 'single', 'double'], '删除线样式')
  return output
}
function geometry(patch: Partial<PresentationGeometry>): Partial<PresentationGeometry> {
  const output: Partial<PresentationGeometry> = {}
  for (const key of geometryKeys) if (patch[key] !== undefined) output[key] = number(patch[key], key === 'width' || key === 'height' ? 0 : key === 'rotation' ? -360 : -5000, key === 'rotation' ? 360 : 5000, key)
  return output
}
function defaultStyle(): PresentationTextStyle { return { fontName: 'Arial', fontSize: 24, bold: false, italic: false, underline: false, color: '#24334A', align: 'left' } }
function defaultTransition(): PptxTransition { return { type: 'none', rawType: null, supported: true, durationMs: null, speed: null, advanceAfterMs: null, advanceOnClick: true } }
function newSlide(name: string, layout = 20): SlideModel { return { id: id('slide'), name, hidden: false, layout, background: '#FFFFFF', notes: '', objects: [], transition: defaultTransition(), media: [], warnings: [] } }
export function createPresentation(): PresentationModel { return { width: 338.666667, height: 190.5, slides: [newSlide('幻灯片 1')], warnings: [] } }
function allObjects(objects: SlideObject[]): SlideObject[] { return objects.flatMap(object => [object, ...allObjects(object.children ?? [])]) }
function renumber(objects: SlideObject[]) { objects.forEach((object, index) => { object.zIndex = index; if (object.children) renumber(object.children) }) }
function copyObject(object: SlideObject, markCopy = true): SlideObject {
  const copy = clone(object); copy.id = id('object')
  if (markCopy) copy.sourceCopy = true
  if (copy.children) copy.children = copy.children.map(child => copyObject(child, markCopy))
  return copy
}
function requireNoAnimation(objects: SlideObject[], operation: string) {
  requireValue(!allObjects(objects).some(object => object.hasAnimation), `所选对象参与原有动画或触发关系，${operation}可能破坏这些关系。请复制整张幻灯片以保留原动画。`)
}
function requireSafeObjectCopy(objects: SlideObject[]) {
  requireValue(!allObjects(objects).some(object => object.smartArtEdits && Object.keys(object.smartArtEdits).length), '已编辑节点的 SmartArt 暂不能复制；请先保存并重新打开文稿。')
  requireNoAnimation(objects, '复制或粘贴')
  const sourceId = (object: SlideObject) => object.sourceXml?.match(/<(?:[\w.-]+:)?cNvPr\b[^>]*\bid\s*=\s*(["'])([^"']+)\1/)?.[2]
  const selected = new Set(allObjects(objects).filter(object => object.sourcePart && sourceId(object)).map(object => `${object.sourcePart}#${sourceId(object)}`))
  for (const object of objects) {
    // A complete group owns a scope in which the exporter can remap every
    // endpoint. Free sibling connectors currently have no shared copy scope.
    if (object.children || !object.sourcePart || !object.sourceXml) continue
    const endpoints = [...object.sourceXml.matchAll(/<(?:[\w.-]+:)?(?:stCxn|endCxn)\b[^>]*\bid\s*=\s*(["'])([^"']+)\1/g)].map(match => match[2])
    requireValue(!endpoints.some(endpoint => selected.has(`${object.sourcePart}#${endpoint}`)), '连接线与其连接对象的多选复制需要先组合，以免副本连接到原对象。请先组合这些对象再复制。')
  }
}
function table(cells: string[][], rows?: number, columns?: number): string[][] {
  requireValue(Array.isArray(cells), '表格数据无效。')
  integer(cells.length, 1, 30, '表格行数')
  const width = integer(cells[0]?.length, 1, 20, '表格列数')
  if (rows !== undefined) requireValue(cells.length === rows && width === columns, '表格数据必须与行列数量一致。')
  return Array.from(cells, row => { requireValue(Array.isArray(row) && row.length === width, '表格每行列数必须一致。'); return Array.from(row, cell => string(cell, 2000, '单元格文本')) })
}
function chart(input: { chartType: string; categories: string[]; series: string[]; values: number[][]; title?: string }): Omit<PresentationChartData, 'id'> {
  const type = choice(input.chartType, ['column', 'bar', 'line', 'pie'], '图表类型')
  requireValue(Array.isArray(input.categories) && Array.isArray(input.series) && Array.isArray(input.values), '图表数据无效。')
  integer(input.categories.length, 1, 100, '类别数量'); integer(input.series.length, 1, 20, '系列数量')
  requireValue(type !== 'pie' || input.series.length === 1, '饼图只支持一个数据系列。')
  requireValue(input.values.length === input.categories.length, '图表数据必须与类别数量一致。')
  const categories = Array.from(input.categories, value => string(value, 120, '类别名称', false)), series = Array.from(input.series, value => string(value, 120, '系列名称', false))
  const values = Array.from(input.values, row => {
    requireValue(Array.isArray(row) && row.length === series.length, '图表每行数据必须与系列数量一致。')
    return Array.from(row, value => number(value, type === 'pie' ? 0 : -1e12, 1e12, '图表数值'))
  })
  requireValue(type !== 'pie' || values.some(row => row[0] > 0), '饼图至少需要一个正数。')
  return { type, categories, series, values, title: string(input.title ?? '', 300, '图表标题') }
}
function rect(objects: SlideObject[]) {
  const x = Math.min(...objects.map(o => o.x)), y = Math.min(...objects.map(o => o.y))
  return { x, y, width: Math.max(...objects.map(o => o.x + o.width)) - x, height: Math.max(...objects.map(o => o.y + o.height)) - y }
}
/** Read raster dimensions without decoding pixels or using a browser runtime. */
export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  let width = 0, height = 0
  if (mimeType === 'image/png' && bytes.length >= 24 && ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20)
  } else if (mimeType === 'image/gif' && bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true)
  } else if (mimeType === 'image/bmp' && bytes.length >= 26 && ascii(0, 2) === 'BM') {
    const dib = view.getUint32(14, true)
    if (dib === 12) { width = view.getUint16(18, true); height = view.getUint16(20, true) }
    else if (dib >= 40) { width = view.getInt32(18, true); height = Math.abs(view.getInt32(22, true)) }
  } else if (mimeType === 'image/webp' && bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = ascii(offset, 4), size = view.getUint32(offset + 4, true), payload = offset + 8
      if (payload + size > bytes.length) break
      if (tag === 'VP8X' && size >= 10) {
        width = 1 + bytes[payload + 4]! + (bytes[payload + 5]! << 8) + (bytes[payload + 6]! << 16)
        height = 1 + bytes[payload + 7]! + (bytes[payload + 8]! << 8) + (bytes[payload + 9]! << 16); break
      }
      if (tag === 'VP8L' && size >= 5 && bytes[payload] === 0x2f) {
        width = 1 + bytes[payload + 1]! + ((bytes[payload + 2]! & 0x3f) << 8)
        height = 1 + (bytes[payload + 2]! >> 6) + (bytes[payload + 3]! << 2) + ((bytes[payload + 4]! & 0xf) << 10); break
      }
      if (tag === 'VP8 ' && size >= 10 && ascii(payload + 3, 3) === '\x9d\x01\x2a') {
        width = view.getUint16(payload + 6, true) & 0x3fff; height = view.getUint16(payload + 8, true) & 0x3fff; break
      }
      offset = payload + size + (size & 1)
    }
  } else if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 0xd8) {
    let orientation = 1
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 255) break
      while (offset < bytes.length && bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue
      if (offset + 2 > bytes.length) break
      const size = view.getUint16(offset), end = offset + size
      if (size < 2 || end > bytes.length) break
      if (marker === 0xe1 && size >= 16 && ascii(offset + 2, 6) === 'Exif\x00\x00') {
        const tiff = offset + 8, endian = ascii(tiff, 2), little = endian === 'II'
        if ((little || endian === 'MM') && view.getUint16(tiff + 2, little) === 42) {
          const ifd = tiff + view.getUint32(tiff + 4, little)
          if (ifd >= tiff + 8 && ifd + 2 <= end) {
            const entries = view.getUint16(ifd, little)
            for (let i = 0; i < entries && ifd + 2 + (i + 1) * 12 <= end; i++) {
              const entry = ifd + 2 + i * 12
              if (view.getUint16(entry, little) === 0x112 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) orientation = view.getUint16(entry + 8, little)
            }
          }
        }
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5) }
      offset = end
    }
    if ([5, 6, 7, 8].includes(orientation)) [width, height] = [height, width]
  }
  requireValue(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0, '图片尺寸无效或图片头已损坏。')
  return { width, height }
}
/** Children use absolute, unrotated page geometry. Group rotation is applied once by the renderer. */
function transform(object: SlideObject, patch: Partial<PresentationGeometry>) {
  const next = { x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation, ...geometry(patch) }
  if (object.children) {
    const sx = object.width ? next.width / object.width : 1, sy = object.height ? next.height / object.height : 1
    for (const child of object.children) {
      const w = child.width * sx, h = child.height * sy
      transform(child, { x: next.x + (child.x - object.x) * sx, y: next.y + (child.y - object.y) * sy, width: w, height: h })
    }
  }
  Object.assign(object, next)
}

export class PresentationController {
  public model: PresentationModel
  public documentId: string
  public currentPageIndex = 0
  public selectedObjectIds: string[] = []
  public revision = 0
  public dirty = false
  private history: Snapshot[] = []
  private future: Snapshot[] = []
  private saved: Snapshot
  private version = 0
  private nextVersion = 0
  private clipboard: SlideObject[] = []

  constructor(model: PresentationModel, documentId: string) {
    requireValue(model && Array.isArray(model.slides), '演示文稿模型无效。')
    integer(model.slides.length, 1, PRESENTATION_LIMITS.slides, '幻灯片数量')
    number(model.width, 1, 5000, '页面宽度'); number(model.height, 1, 5000, '页面高度')
    this.model = clone(model); this.documentId = documentId
    const ids = new Set<string>()
    for (const slide of this.model.slides) {
      requireValue(slide.id && !ids.has(slide.id), '幻灯片 ID 重复。'); ids.add(slide.id)
      requireValue(allObjects(slide.objects).length <= PRESENTATION_LIMITS.objects, '幻灯片对象数量超过上限。')
      const objectIds = new Set<string>()
      for (const object of allObjects(slide.objects)) { requireValue(object.id && !objectIds.has(object.id), '对象 ID 重复。'); objectIds.add(object.id) }
      renumber(slide.objects)
    }
    this.saved = { ...this.snapshot(), model: clone(this.model) }
  }
  get canUndo() { return this.history.length > 0 }
  get canRedo() { return this.future.length > 0 }
  private get page() { return this.model.slides[this.pageIndex(this.currentPageIndex)]! }
  private pageIndex(index: number) { return integer(index, 0, this.model.slides.length - 1, '幻灯片索引') }
  private snapshot(): Snapshot { return { model: this.model, page: this.currentPageIndex, selection: [...this.selectedObjectIds], version: this.version, weight: weight(this.model) } }
  private restore(snapshot: Snapshot) { this.model = snapshot.model; this.currentPageIndex = snapshot.page; this.selectedObjectIds = [...snapshot.selection]; this.version = snapshot.version; this.dirty = this.version !== this.saved.version && !equal(this.model, this.saved.model) }
  private trim(stack: Snapshot[]) {
    let bytes = stack.reduce((sum, item) => sum + item.weight, 0)
    while (stack.length > 1 && (stack.length > PRESENTATION_LIMITS.history || bytes > PRESENTATION_LIMITS.historyBytes)) bytes -= stack.shift()!.weight
  }
  private guard(revision?: number) {
    if (revision === undefined) return
    integer(revision, 0, Number.MAX_SAFE_INTEGER, '文档版本')
    requireValue(revision === this.revision, '演示文稿已更新，请刷新后再操作，未应用过期更改。')
  }
  private transact(operation: () => void): PresentationState {
    const before = this.snapshot()
    this.model = clone(this.model)
    try {
      operation()
      for (const object of this.model.slides.flatMap(slide => [...allObjects(slide.objects), ...allObjects(slide.inheritedObjects || [])])) if (object.smartArtEdits && Object.keys(object.smartArtEdits).length) {
        const reason = smartArtEditBlockReason(this.model, object); requireValue(!reason, reason || '')
      }
      refreshSmartArtEditability(this.model)
      for (const slide of this.model.slides) { requireValue(allObjects(slide.objects).length <= PRESENTATION_LIMITS.objects, '当前页对象数量已达到上限。'); renumber(slide.objects) }
      if (!equal(before.model, this.model)) {
        this.history.push(before); this.trim(this.history); this.future = []
        this.version = ++this.nextVersion; this.dirty = !equal(this.model, this.saved.model); this.revision++
      } else {
        this.model = before.model
        if (before.page !== this.currentPageIndex || !equal(before.selection, this.selectedObjectIds)) this.revision++
      }
    } catch (error) { this.restore(before); throw error }
    return this.state()
  }
  state(): PresentationState {
    const pages: PresentationPage[] = this.model.slides.map((slide, index) => ({ id: slide.id, index, name: slide.name, title: allObjects(slide.objects).find(o => o.text.trim())?.text.split('\n')[0]?.slice(0, 300) || slide.name, hidden: slide.hidden, layout: slide.layout }))
    const page = this.page
    return { documentId: this.documentId, revision: this.revision, dirty: this.dirty, pageCount: pages.length, currentPageIndex: this.currentPageIndex,
      pageSize: { width: this.model.width, height: this.model.height }, pages,
      currentPage: { ...pages[this.currentPageIndex]!, background: page.background === null ? { type: 'none' } : { type: 'solid', color: page.background }, notes: page.notes },
      objects: clone(page.objects), selectedObjectIds: [...this.selectedObjectIds] }
  }
  private object(objectId: string) { const object = this.page.objects.find(item => item.id === objectId); requireValue(object, '对象已不存在，请重新选择。'); return object }
  private objects(ids: string[], editable = false) {
    requireValue(Array.isArray(ids) && ids.length <= PRESENTATION_LIMITS.objects && ids.every(value => typeof value === 'string'), '对象选择无效。')
    const objects = [...new Set(ids)].map(value => this.object(value))
    if (editable) for (const object of objects) requireValue(!object.locked, '对象已锁定，无法编辑。')
    return objects
  }
  private add(type: SlideObject['type'], fields: Partial<SlideObject> = {}, page = this.page, select = true) {
    const shape: SlideObject = { id: id('object'), name: ({ text: '文本框', rectangle: '矩形', ellipse: '椭圆', line: '直线', image: '图片', table: '表格', chart: '图表', group: '组合', custom: '形状', unknown: '对象' })[type],
      type, text: '', x: 20, y: 25, width: 100, height: type === 'text' ? 25 : 60, rotation: 0, fillColor: type === 'text' || type === 'line' ? null : '#DCE8FF', lineColor: type === 'text' ? null : '#4968AA', lineWidth: 0.4,
      zIndex: page.objects.length, textStyle: defaultStyle(), capabilities: { text: ['text', 'rectangle', 'ellipse', 'custom'].includes(type), fill: ['text', 'rectangle', 'ellipse', 'custom'].includes(type), line: !['table', 'chart', 'group'].includes(type), geometry: true }, ...fields }
    page.objects.push(shape); if (select) this.selectedObjectIds = [shape.id]; return shape
  }
  private applyLayout(page: SlideModel, layout: number) {
    page.layout = layout
    if (layout === 20) return
    const empty = page.objects.length === 0, w = this.model.width, h = this.model.height
    const slots = layout === 0 ? [{ name: '标题', text: '输入标题', x: .1, y: .3, width: .8, height: .2, size: 40, center: true }, { name: '副标题', text: '输入副标题', x: .15, y: .55, width: .7, height: .13, size: 24, center: true }]
      : layout === 32 ? [{ name: '标题', text: '输入标题', x: .12, y: .38, width: .76, height: .2, size: 38, center: true }]
      : [{ name: '标题', text: '输入标题', x: .07, y: .07, width: .86, height: .16, size: 32, center: false },
        ...(layout === 19 ? [] : layout === 3 ? [{ name: '内容', text: '输入内容', x: .07, y: .3, width: .4, height: .58, size: 24, center: false }, { name: '内容 2', text: '输入内容', x: .53, y: .3, width: .4, height: .58, size: 24, center: false }]
          : [{ name: '内容', text: '输入内容', x: .07, y: .3, width: .86, height: .58, size: 24, center: false }])]
    for (const slot of slots) {
      const existing = page.objects.find(object => object.type === 'text' && object.name === slot.name && !object.locked)
      const bounds = { x: slot.x * w, y: slot.y * h, width: slot.width * w, height: slot.height * h }
      if (existing) transform(existing, bounds)
      else if (empty) this.add('text', { ...bounds, name: slot.name, text: slot.text, textStyle: { ...defaultStyle(), fontSize: slot.size, bold: slot.name === '标题', align: slot.center ? 'center' : 'left' } }, page, false)
    }
  }
  action(action: PresentationAction): PresentationState { return this.batch([action]) }
  batch(actions: PresentationAction[]): PresentationState {
    requireValue(Array.isArray(actions) && actions.length <= PRESENTATION_LIMITS.objects, '批量操作无效。')
    for (const action of actions) { requireValue(action && typeof action === 'object', '演示文稿操作无效。'); this.guard(action.expectedRevision) }
    return this.transact(() => { for (const action of actions) this.apply(action) })
  }
  private apply(action: PresentationAction) {
    switch (action.type) {
      case 'select-page': this.currentPageIndex = this.pageIndex(action.pageIndex); this.selectedObjectIds = []; break
      case 'select-objects': this.selectedObjectIds = this.objects(action.ids).map(object => object.id); break
      case 'add-page': {
        requireValue(this.model.slides.length < PRESENTATION_LIMITS.slides, '幻灯片数量已达到上限。')
        const layout = choice(action.layout ?? 20, layouts, '幻灯片布局')
        let suffix = this.model.slides.length + 1; while (this.model.slides.some(slide => slide.name === `幻灯片 ${suffix}`)) suffix++
        const slide = newSlide(`幻灯片 ${suffix}`, layout)
        this.model.slides.splice(++this.currentPageIndex, 0, slide); this.applyLayout(slide, layout); this.selectedObjectIds = []; break
      }
      case 'duplicate-page': {
        const pageIndex = this.pageIndex(action.pageIndex)
        requireValue(!allObjects([...this.model.slides[pageIndex]!.objects, ...this.model.slides[pageIndex]!.inheritedObjects || []]).some(object => object.smartArtEdits && Object.keys(object.smartArtEdits).length), '含已编辑 SmartArt 节点的页面暂不能复制；请先保存并重新打开文稿。')
        requireValue(this.model.slides.length < PRESENTATION_LIMITS.slides, '幻灯片数量已达到上限。')
        const copy = clone(this.model.slides[pageIndex]!); copy.id = id('slide'); copy.objects = copy.objects.map(object => copyObject(object, false))
        if (copy.inheritedObjects) copy.inheritedObjects = copy.inheritedObjects.map(object => copyObject(object, false))
        copy.media = copy.media.map(media => ({ ...media, id: id('media') }))
        const baseName = copy.name.slice(0, 135)
        let suffix = 1; while (this.model.slides.some(slide => slide.name === `${baseName} 副本 ${suffix}`)) suffix++
        copy.name = `${baseName} 副本 ${suffix}`
        this.model.slides.splice(pageIndex + 1, 0, copy); this.currentPageIndex = pageIndex + 1; this.selectedObjectIds = []; break
      }
      case 'delete-page': {
        const index = this.pageIndex(action.pageIndex), current = this.page.id
        requireValue(this.model.slides.length > 1, '演示文稿至少需要保留一张幻灯片。')
        this.model.slides.splice(index, 1)
        const selected = this.model.slides.findIndex(slide => slide.id === current)
        this.currentPageIndex = selected < 0 ? Math.min(index, this.model.slides.length - 1) : selected
        if (selected < 0) this.selectedObjectIds = []
        break
      }
      case 'move-page': {
        const from = this.pageIndex(action.pageIndex), direction = choice(action.direction, ['up', 'down'], '页面移动方向'), to = from + (direction === 'up' ? -1 : 1)
        requireValue(to >= 0 && to < this.model.slides.length, '幻灯片已在此方向的边界。')
        const [page] = this.model.slides.splice(from, 1); this.model.slides.splice(to, 0, page!); this.currentPageIndex = to; this.selectedObjectIds = []; break
      }
      case 'set-hidden': this.model.slides[this.pageIndex(action.pageIndex)]!.hidden = boolean(action.value, '隐藏状态'); break
      case 'rename-page': {
        const index = this.pageIndex(action.pageIndex), name = string(action.name, 150, '幻灯片名称', false).trim()
        requireValue(!this.model.slides.some((slide, i) => i !== index && slide.name === name), '已有同名幻灯片，请使用不同名称。')
        this.model.slides[index]!.name = name; break
      }
      case 'set-layout': this.applyLayout(this.model.slides[this.pageIndex(action.pageIndex)]!, choice(action.layout, layouts, '幻灯片布局')); break
      case 'set-background': {
        const page = this.model.slides[this.pageIndex(action.pageIndex)]!, value = color(action.color, true)
        // Unsupported imported fills use null for their simplified preview. An
        // explicit clear must still reach the exporter, even when null === null.
        if (value === null && page.sourcePart && page.sourceFingerprint) {
          try { if (JSON.parse(page.sourceFingerprint).background === null) page.backgroundOverride = true } catch { /* No usable import baseline. */ }
        }
        page.background = value; break
      }
      case 'set-notes': this.model.slides[this.pageIndex(action.pageIndex)]!.notes = string(action.text, PRESENTATION_LIMITS.notes, '备注'); break
      case 'set-page-size': this.model.width = number(action.width, 50, 1000, '页面宽度'); this.model.height = number(action.height, 50, 1000, '页面高度'); break
      case 'insert-text': this.add('text', { ...geometry(action), text: string(action.text, PRESENTATION_LIMITS.text, '文本'), textStyle: { ...defaultStyle(), ...textStyle(action.textStyle) } }); break
      case 'insert-shape': this.add(choice(action.shapeType, ['rectangle', 'ellipse', 'line'], '形状类型'), { ...geometry(action), ...(action.fillColor !== undefined ? { fillColor: color(action.fillColor, true) } : {}), ...(action.lineColor !== undefined ? { lineColor: color(action.lineColor, true) } : {}), ...(action.lineWidth !== undefined ? { lineWidth: number(action.lineWidth, 0, 20, '线宽') } : {}) }); break
      case 'insert-table': {
        const rows = integer(action.rows, 1, 30, '表格行数'), columns = integer(action.columns, 1, 20, '表格列数')
        const cells = table(action.cells ?? Array.from({ length: rows }, () => Array<string>(columns).fill('')), rows, columns)
        this.add('table', { width: 200, height: rows * 12, ...geometry(action), table: { cells } }); break
      }
      case 'update-table': {
        const [object] = this.objects([action.id], true); requireValue(object?.table && object.type === 'table', '请选择可编辑表格对象。')
        replaceTableText(object, table(action.cells)); break
      }
      case 'insert-chart': this.add('chart', { width: 200, height: 110, ...geometry(action), chart: chart(action) }); break
      case 'update-chart': {
        const [object] = this.objects([action.id], true); requireValue(object?.chart && object.type === 'chart', '请选择可编辑图表对象。')
        object.chart = chart(action); break
      }
      case 'update-smartart-text': {
        commitSmartArtTextEdit(this.model, this.object(action.id), action)
        break
      }
      case 'format-paragraphs': {
        requireValue(Number.isSafeInteger(action.expectedRevision), '段落格式需要当前文稿版本，请重新打开排版设置。')
        const [object] = this.objects([action.id], true); requireValue(object, '对象已不存在。')
        requireValue(typeof action.expectedText === 'string' && action.expectedText === object.text, '正文已改变，请重新打开排版设置。')
        formatParagraphs(object, action.paragraphIndices, action.paragraphStyle, action.spaceFirstLastParagraph)
        break
      }
      case 'set-text-layout': {
        const [object] = this.objects([action.id], true)
        requireValue(object && object.capabilities.text && !['table', 'chart', 'group', 'image', 'unknown'].includes(object.type), '此对象不支持文本框排版。')
        const patch = action.layout
        requireValue(patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length > 0 && Object.keys(patch).every(key => ['verticalAlign', 'wrap', 'rotation', 'insets'].includes(key)), '文本框排版设置无效。')
        const layout = { ...object.textLayout }
        let changed = false
        if (patch.verticalAlign !== undefined) { layout.verticalAlign = choice(patch.verticalAlign, ['top', 'middle', 'bottom'], '垂直对齐'); changed = true }
        if (patch.wrap !== undefined) { layout.wrap = boolean(patch.wrap, '自动换行'); changed = true }
        if (patch.rotation !== undefined) { layout.rotation = Math.round(number(patch.rotation, -360, 360, '文字旋转') * 60000) / 60000; changed = true }
        if (patch.insets !== undefined) {
          requireValue(patch.insets && typeof patch.insets === 'object' && !Array.isArray(patch.insets) && Object.keys(patch.insets).length > 0 && Object.keys(patch.insets).every(key => ['left', 'right', 'top', 'bottom'].includes(key)), '文本框内边距无效。')
          const insets = { left: 1.3, right: 1.3, top: 1.3, bottom: 1.3, ...layout.insets }
          for (const key of ['left', 'right', 'top', 'bottom'] as const) if (patch.insets[key] !== undefined) { insets[key] = Math.round(number(patch.insets[key], 0, 1000, '内边距') * 36000) / 36000; changed = true }
          layout.insets = insets
        }
        requireValue(changed, '请至少设置一项文本框排版属性。')
        object.textLayout = layout
        break
      }
      case 'format-text-range': {
        requireValue(Number.isSafeInteger(action.expectedRevision), '选区格式需要当前文稿版本，请重新选择文字。')
        const [object] = this.objects([action.id], true); requireValue(object, '对象已不存在。')
        requireValue(typeof action.expectedText === 'string' && action.expectedText === object.text, '正文已改变，请重新选择文字后设置格式。')
        const patch = textStyle(action.textStyle)
        requireValue(!Object.hasOwn(action.textStyle || {}, 'align'), '选区格式仅设置字形，段落对齐请使用整框格式。')
        requireValue(Object.keys(patch).length > 0, '请选择至少一项文字格式。')
        // DrawingML stores sizes in hundredths of a point; use the same value
        // in the preview so saving and reopening cannot change the size.
        if (patch.fontSize !== undefined) patch.fontSize = Math.round(patch.fontSize * 100) / 100
        formatTextRange(object, action.start, action.end, patch)
        break
      }
      case 'update-object': {
        const [object] = this.objects([action.id], true); requireValue(object, '对象已不存在。')
        const hasGeometry = geometryKeys.some(key => action[key] !== undefined)
        if (hasGeometry) { requireValue(object.capabilities.geometry, '此对象暂不支持几何编辑。'); transform(object, action) }
        if (action.text !== undefined || action.textStyle !== undefined) requireValue(object.capabilities.text, '此对象不支持文字编辑。')
        if (action.text !== undefined) replaceTextContent(object, string(action.text, PRESENTATION_LIMITS.text, '文本'))
        if (action.textStyle !== undefined) {
          const patch = textStyle(action.textStyle)
          formatWholeTextPaint(object, { ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}) })
          object.textStyle = { ...object.textStyle, ...patch }
          const { color: _color, opacity: _opacity, ...attributes } = patch
          if ((object.richText || object.sourceXml && attributes.highlightColor !== undefined) && Object.keys(attributes).length) object.textStyleOverrides = { ...object.textStyleOverrides, ...attributes }
        }
        if (action.fillColor !== undefined) { requireValue(object.capabilities.fill, '此对象不支持填充编辑。'); object.fillColor = color(action.fillColor, true); if (object.sourceXml) object.fillColorOverride = true }
        if (action.lineColor !== undefined || action.lineWidth !== undefined) requireValue(object.capabilities.line, '此对象不支持线条编辑。')
        if (action.lineColor !== undefined) { object.lineColor = color(action.lineColor, true); if (object.sourceXml) object.lineColorOverride = true }
        if (action.lineWidth !== undefined) object.lineWidth = number(action.lineWidth, 0, 20, '线宽')
        if (action.fillOpacity !== undefined) {
          requireValue(['text', 'rectangle', 'ellipse'].includes(object.type) && object.capabilities.fill && object.fillColor !== null, '此对象没有可编辑的普通实色填充，请先选择填充颜色。')
          requireValue(paintOpacityEditable(object, 'fill', action.fillColor !== undefined), '引用样式或复杂颜色变换暂不能单独调整不透明度，请先选择明确的填充颜色。')
          object.fillOpacity = Math.round(number(action.fillOpacity, 0, 1, '填充不透明度') * 100000) / 100000
        }
        if (action.lineOpacity !== undefined) {
          requireValue(['text', 'rectangle', 'ellipse', 'line'].includes(object.type) && object.capabilities.line && object.lineColor !== null, '此对象没有可编辑的普通实色边框，请先选择边框颜色。')
          requireValue(paintOpacityEditable(object, 'line', action.lineColor !== undefined), '引用样式或复杂颜色变换暂不能单独调整不透明度，请先选择明确的边框颜色。')
          object.lineOpacity = Math.round(number(action.lineOpacity, 0, 1, '边框不透明度') * 100000) / 100000
        }
        break
      }
      case 'delete-objects': { requireNoAnimation(this.objects(action.ids), '删除'); const remove = new Set(this.objects(action.ids, true).map(object => object.id)); this.page.objects = this.page.objects.filter(object => !remove.has(object.id)); this.selectedObjectIds = this.selectedObjectIds.filter(value => !remove.has(value)); break }
      case 'arrange-objects': this.arrange(action.ids, action.operation); break
      default: throw Error('不支持的演示文稿操作。')
    }
  }
  private arrange(ids: string[], operation: string) {
    const selected = this.objects(ids), selectedIds = new Set(selected.map(object => object.id)), objects = this.page.objects
    if (operation === 'ungroup') requireNoAnimation(selected, '取消组合')
    if (operation === 'ungroup') requireValue(!selected.some(object => object.hasComplexGroupTransform), '此组合包含非等比缩放和旋转，取消组合会改变原有形状。请在原编辑器中处理这种组合变换。')
    for (const object of selected) requireValue(!object.locked, '对象已锁定，无法编辑。')
    choice(operation, ['front', 'back', 'forward', 'backward', 'align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom', 'distribute-horizontal', 'distribute-vertical', 'group', 'ungroup'], '排列操作')
    requireValue(selected.length, '请先选择对象。')
    const ordered = objects.filter(object => selectedIds.has(object.id))
    if (operation === 'front' || operation === 'back') { const rest = objects.filter(object => !selectedIds.has(object.id)); this.page.objects = operation === 'front' ? [...rest, ...ordered] : [...ordered, ...rest] }
    else if (operation === 'forward') { for (let i = objects.length - 2; i >= 0; i--) if (selectedIds.has(objects[i]!.id) && !selectedIds.has(objects[i + 1]!.id)) [objects[i], objects[i + 1]] = [objects[i + 1]!, objects[i]!] }
    else if (operation === 'backward') { for (let i = 1; i < objects.length; i++) if (selectedIds.has(objects[i]!.id) && !selectedIds.has(objects[i - 1]!.id)) [objects[i], objects[i - 1]] = [objects[i - 1]!, objects[i]!] }
    else if (operation === 'group') {
      requireValue(selected.length >= 2, '组合至少需要两个对象。')
      const bounds = rect(selected), insertion = objects.slice(0, objects.indexOf(ordered.at(-1)!)).filter(object => !selectedIds.has(object.id)).length
      this.page.objects = objects.filter(object => !selectedIds.has(object.id))
      const group = this.add('group', { ...bounds, children: ordered, fillColor: null, lineColor: null }); this.page.objects.pop(); this.page.objects.splice(insertion, 0, group)
    } else if (operation === 'ungroup') {
      requireValue(selected.every(object => object.type === 'group' && object.children), '请选择组合对象。')
      for (const group of selected) {
        const angle = group.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
        // The original XML still has local coordinates. Even an unrotated
        // ungroup operation must export the child's absolute model transform.
        for (const child of group.children!) if (child.sourceXml) child.sourceTransformDetached = true
        if (!angle) continue
        for (const child of group.children!) {
          const cx = child.x + child.width / 2 - group.x - group.width / 2, cy = child.y + child.height / 2 - group.y - group.height / 2
          transform(child, { x: group.x + group.width / 2 + cx * cos - cy * sin - child.width / 2, y: group.y + group.height / 2 + cx * sin + cy * cos - child.height / 2, rotation: ((child.rotation + group.rotation) % 360 + 360) % 360 })
        }
      }
      this.page.objects = objects.flatMap(object => selectedIds.has(object.id) ? object.children! : [object]); this.selectedObjectIds = ordered.flatMap(object => object.children!.map(child => child.id))
    } else if (operation.startsWith('align-')) {
      const bounds = selected.length === 1 ? { x: 0, y: 0, width: this.model.width, height: this.model.height } : rect(selected)
      for (const object of selected) {
        const patch = operation === 'align-left' ? { x: bounds.x } : operation === 'align-center' ? { x: bounds.x + (bounds.width - object.width) / 2 } : operation === 'align-right' ? { x: bounds.x + bounds.width - object.width } : operation === 'align-top' ? { y: bounds.y } : operation === 'align-middle' ? { y: bounds.y + (bounds.height - object.height) / 2 } : { y: bounds.y + bounds.height - object.height }
        transform(object, patch)
      }
    } else {
      requireValue(selected.length >= 3, '分布至少需要三个对象。')
      const axis = operation === 'distribute-horizontal' ? 'x' : 'y', size = axis === 'x' ? 'width' : 'height', sorted = [...selected].sort((a, b) => a[axis] - b[axis]), first = sorted[0]!, last = sorted.at(-1)!
      const gap = (last[axis] + last[size] - first[axis] - sorted.reduce((sum, object) => sum + object[size], 0)) / (sorted.length - 1)
      let cursor = first[axis]
      for (const object of sorted) { transform(object, { [axis]: cursor }); cursor += object[size] + gap }
    }
  }
  objectData(query: PresentationObjectQuery): PresentationObjectData {
    requireValue(query && typeof query === 'object', '对象查询无效。')
    const object = this.object(query.id)
    if (query.type === 'table') { requireValue(object.type === 'table' && object.table, '请选择表格对象。'); return { id: object.id, rows: object.table.cells.length, columns: object.table.cells[0]?.length ?? 0, cells: clone(object.table.cells) } }
    requireValue(query.type === 'chart' && object.type === 'chart' && object.chart, '请选择图表对象。')
    return { id: object.id, ...clone(object.chart) }
  }
  copyObjects(ids = this.selectedObjectIds): SlideObject[] { const objects = this.objects(ids); requireSafeObjectCopy(objects); this.clipboard = clone(objects); return clone(this.clipboard) }
  pasteObjects(objects = this.clipboard): PresentationState {
    requireValue(Array.isArray(objects) && objects.length > 0 && allObjects(objects).length <= PRESENTATION_LIMITS.objects, '剪贴板没有可粘贴对象。')
    requireSafeObjectCopy(objects)
    requireValue(!allObjects(objects).some(object => hasSmartArtBinding(object) && object.sourcePart !== this.page.sourcePart), 'SmartArt 暂不支持跨页对象粘贴；可以复制整张未编辑的幻灯片以保留图表关系。')
    return this.transact(() => {
      const copies = objects.map(object => copyObject(object))
      for (const object of copies) { if (!object.locked) transform(object, { x: object.x + 5, y: object.y + 5 }); this.page.objects.push(object) }
      this.selectedObjectIds = copies.map(object => object.id)
    })
  }
  duplicateObjects(ids = this.selectedObjectIds): PresentationState { return this.pasteObjects(this.objects(ids)) }
  insertImage(input: { name: string; base64: string; mimeType?: string }): PresentationState {
    const name = string(input.name, 300, '图片名称', false)
    requireValue(typeof input.base64 === 'string', '图片数据无效。')
    const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(input.base64), base64 = (data?.[2] ?? input.base64).replace(/\s/g, '')
    const bytes = base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
    requireValue(base64.length > 0 && base64.length % 4 === 0 && bytes <= PRESENTATION_LIMITS.imageBytes && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), '图片为空、编码无效或超过 32 MiB。')
    const head = atob(base64.slice(0, 64)), detected = head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : head.startsWith('\xff\xd8\xff') ? 'image/jpeg' : head.startsWith('GIF8') ? 'image/gif' : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'image/webp' : head.startsWith('BM') ? 'image/bmp' : null
    const mimeType = input.mimeType ?? data?.[1] ?? detected
    requireValue(mimeType && detected === mimeType, '请选择 PNG、JPEG、GIF、WebP 或 BMP 图片，文件内容必须与格式一致。')
    const dimensions = imageDimensions(Uint8Array.from(atob(base64), character => character.charCodeAt(0)), mimeType)
    let width = 120, height = width * dimensions.height / dimensions.width
    const fit = Math.min(1, this.model.width * 0.8 / width, this.model.height * 0.8 / height); width *= fit; height *= fit
    return this.transact(() => { this.add('image', { name, x: (this.model.width - width) / 2, y: (this.model.height - height) / 2, width, height, fillColor: null, lineColor: null, image: { dataUrl: `data:${mimeType};base64,${base64}`, mimeType } }) })
  }
  editFeatures(patch: PresentationPatch): PresentationState {
    requireValue(patch && typeof patch === 'object', '放映设置无效。'); this.guard(patch.expectedRevision)
    return this.transact(() => {
      if (patch.name !== undefined) this.apply({ type: 'rename-page', pageIndex: this.currentPageIndex, name: patch.name })
      if (patch.transition) {
        const value = patch.transition, transition = clone(this.page.transition)
        transition.type = choice(value.type, ['none', 'fade', 'push', 'wipe', 'cover', 'uncover', 'split'], '切换效果'); transition.rawType = transition.type === 'none' ? null : transition.type; transition.supported = true
        if (value.durationMs !== undefined) transition.durationMs = integer(value.durationMs, 0, 60000, '切换时长')
        if (value.advanceAfterMs !== undefined) transition.advanceAfterMs = value.advanceAfterMs === null ? null : integer(value.advanceAfterMs, 0, 86400000, '自动换页时间')
        if (value.advanceOnClick !== undefined) transition.advanceOnClick = boolean(value.advanceOnClick, '点击换页')
        if (value.direction !== undefined) transition.direction = choice(value.direction, ['l', 'r', 'u', 'd', 'lu', 'ru', 'ld', 'rd', 'in', 'out'], '切换方向')
        if (value.orientation !== undefined) transition.orientation = choice(value.orientation, ['horz', 'vert'], '切换方向')
        this.page.transition = transition
      }
      if (patch.removeMediaIds !== undefined) {
        requireValue(Array.isArray(patch.removeMediaIds) && patch.removeMediaIds.every(mediaId => this.page.media.some(media => media.id === mediaId)), '媒体已不存在，请刷新后重试。')
        const removed = new Set(patch.removeMediaIds); this.page.media = this.page.media.filter(media => !removed.has(media.id))
      }
      if (patch.addMedia !== undefined) {
        requireValue(Array.isArray(patch.addMedia) && this.page.media.length + patch.addMedia.length <= 100, '每张幻灯片最多支持 100 个媒体。')
        for (const media of patch.addMedia) this.addMedia(media)
      }
    })
  }
  private addMedia(media: NewPptxMedia) {
    const formats: Record<string, string> = { 'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/ogg': 'audio', 'video/mp4': 'video', 'video/webm': 'video' }
    requireValue(formats[media.mimeType] === media.kind, '请选择 MP3/WAV/OGG 音频或 MP4/WebM 视频。')
    requireValue(media.data instanceof Uint8Array && media.data.length >= 12 && media.data.length <= PRESENTATION_LIMITS.mediaBytes, '媒体为空、无效或超过 64 MiB。')
    const head = String.fromCharCode(...media.data.subarray(0, 12)), b = media.data
    const valid = media.mimeType === 'audio/wav' ? head.startsWith('RIFF') && head.slice(8) === 'WAVE' : media.mimeType === 'audio/mpeg' ? head.startsWith('ID3') || b[0] === 255 && (b[1]! & 0xe0) === 0xe0 : media.mimeType === 'audio/ogg' ? head.startsWith('OggS') : media.mimeType === 'video/mp4' ? head.slice(4, 8) === 'ftyp' : b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
    requireValue(valid, '媒体内容与所选格式不一致。')
    const r = media.rect; requireValue(r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, '媒体位置必须在幻灯片范围内。')
    const start = choice(media.start, ['auto', 'click'], '媒体启动方式'), name = string(media.name, 300, '媒体名称', false), loop = media.loop === undefined ? false : boolean(media.loop, '媒体循环')
    this.page.media.push({ id: id('media'), shapeId: id('media-shape'), name, kind: media.kind, mimeType: media.mimeType, data: media.data.slice(), rect: clone(r), rotation: 0, start, startDelayMs: start === 'auto' ? 0 : null, loop, external: false, partName: null, warnings: [] })
  }
  undo(): PresentationState { const previous = this.history.pop(); if (previous) { this.future.push(this.snapshot()); this.trim(this.future); this.restore(previous); this.revision++ }; return this.state() }
  redo(): PresentationState { const next = this.future.pop(); if (next) { this.history.push(this.snapshot()); this.trim(this.history); this.restore(next); this.revision++ }; return this.state() }
  markSaved(revision = this.revision): void { if (revision === this.revision) { this.saved = { ...this.snapshot(), model: clone(this.model) }; this.dirty = false } }
  discardChanges(): PresentationState { this.restore({ ...this.saved, model: clone(this.saved.model) }); this.history = []; this.future = []; this.revision++; return this.state() }
  assertNoPendingEdits(): void { /* The controller commits every transaction immediately. */ }
}
