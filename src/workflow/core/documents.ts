import { DEFAULT_STYLE, clone, emptyScene, newId } from './types.ts'
import type { DocumentKind, ElementStyle, Scene, SceneElement, WorkflowDocument } from './types.ts'
import { resolveStrokePattern, sceneDefaultStyle } from './appearance.ts'
import { normalizeDiagramStyle } from './diagram-appearance.ts'
import { readBrushData } from './brushes.ts'

export const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_ELEMENTS = 5000
const SHAPES = ['rectangle', 'ellipse', 'diamond', 'note', 'text', 'image', 'triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'frame', 'brace-left', 'brace-right', 'brace-top', 'brace-bottom'] as const
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件内容应为一个对象。')
  return value as Record<string, any>
}
function string(value: unknown, field: string, limit = 100000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${field}不是有效文本，或超过长度限制。`)
  return value
}
function number(value: unknown, field: string, min = -1000000, max = 1000000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field}不是有效数值。`)
  return value
}
function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (!options.includes(value as T)) throw new Error(`${field}不受支持。`)
  return value as T
}
export function safeColor(value: unknown, fallback = '#ffffff'): string {
  if (typeof value !== 'string') return fallback
  return /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|none|black|white|red|blue|green|yellow|orange|purple|gray|grey|pink|cyan|magenta|navy|teal|lime|maroon|olive|silver|aqua|fuchsia|rebeccapurple|rgba?\([\d.% ,/]+\)|hsla?\([\d.% ,/]+\))$/i.test(value) ? value : fallback
}
export function safeImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 14 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/\r\n]+={0,2}$/i.test(value)) return false
  const body = value.slice(value.indexOf(',') + 1).replace(/[\r\n]/g, '')
  const bytes = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return body.length % 4 === 0 && bytes <= 10 * 1024 * 1024
}
export function validateElementStyle(value: unknown): ElementStyle {
  const input = value ? object(value) : DEFAULT_STYLE
  const strokePattern = input.strokePattern === undefined ? (input.dashed === true ? 'dashed' : 'solid') : choice(input.strokePattern, ['solid', 'dashed', 'dotted'] as const, '线型')
  return {
    stroke: safeColor(input.stroke, DEFAULT_STYLE.stroke), fill: safeColor(input.fill, DEFAULT_STYLE.fill),
    strokeWidth: number(input.strokeWidth ?? 2, '线宽', 0, 100), fontSize: number(input.fontSize ?? 16, '字号', 1, 500),
    textAlign: choice(input.textAlign ?? 'center', ['left', 'center', 'right'], '文字对齐'),
    opacity: number(input.opacity ?? 1, '透明度', 0, 1), dashed: strokePattern !== 'solid', strokePattern,
    roughness: choice(input.roughness ?? 'clean', ['clean', 'sketch'] as const, '线条外观'),
  }
}
export function validateScene(value: unknown): Scene {
  const input = object(value)
  if (!Array.isArray(input.elements) || input.elements.length > MAX_ELEMENTS) throw new Error(`画布最多支持 ${MAX_ELEMENTS} 个元素。`)
  const ids = new Set<string>()
  let points = 0
  const elements: SceneElement[] = input.elements.map((raw: unknown) => {
    const e = object(raw)
    const id = string(e.id, '元素 ID', 512)
    if (!id || ids.has(id)) throw new Error('画布包含空白或重复的元素 ID。')
    ids.add(id)
    const base = { id, style: validateElementStyle(e.style), locked: e.locked === true, ...(e.groupId ? { groupId: string(e.groupId, '组合 ID', 512) } : {}) }
    if (e.type === 'shape') {
      const shape = choice(e.shape, SHAPES, '图形')
      if (shape.startsWith('brace-')) base.style.fill = 'none'
      if (shape === 'image' && !safeImage(e.imageData)) throw new Error('图片必须是内嵌 PNG、JPEG 或 WebP（不超过 10 MB）。')
      return { ...base, type: 'shape', shape, x: number(e.x, 'X'), y: number(e.y, 'Y'), width: number(e.width, '宽度', 1, 100000), height: number(e.height, '高度', 1, 100000), text: string(e.text ?? '', '文本'), ...(e.imageData && shape === 'image' ? { imageData: e.imageData } : {}) }
    }
    if (e.type === 'edge') {
      const endpoint = (value: unknown) => {
        const p = object(value)
        return { x: number(p.x, '连线 X'), y: number(p.y, '连线 Y'), ...(p.nodeId ? { nodeId: string(p.nodeId, '绑定元素 ID', 512) } : {}) }
      }
      return { ...base, type: 'edge', from: endpoint(e.from), to: endpoint(e.to), label: string(e.label ?? '', '连线标签'), arrow: choice(e.arrow, ['end', 'both', 'none'], '箭头'), route: choice(e.route, ['straight', 'orthogonal'], '连线类型') }
    }
    if (e.type === 'stroke') {
      if (!Array.isArray(e.points) || e.points.length < (e.closed === true ? 3 : 1) || (points += e.points.length) > 100000) throw new Error('笔迹为空或总点数超过 100000。')
      return { ...base, type: 'stroke', ...(e.closed === true ? { closed: true } : {}), ...readBrushData(e.brush, e.pressures, e.points.length), points: e.points.map((p: unknown) => { const point = object(p); return { x: number(point.x, '笔迹 X'), y: number(point.y, '笔迹 Y') } }) }
    }
    throw new Error('文件中有不支持的画布元素。')
  })
  const shapeIds = new Set(elements.filter(e => e.type === 'shape').map(e => e.id))
  for (const e of elements) if (e.type === 'edge') {
    for (const p of [e.from, e.to]) if (p.nodeId && !shapeIds.has(p.nodeId)) throw new Error('连线引用了不存在的图形。')
  }
  return { elements, background: safeColor(input.background), grid: input.grid !== false, defaultStyle: validateElementStyle(input.defaultStyle) }
}

export function parseDocument(text: string): WorkflowDocument {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error('文件超过 50 MB。')
  let raw: Record<string, any>
  try { raw = object(JSON.parse(text)) } catch { throw new Error('这不是有效的画布或代码图表 JSON 文件。') }
  return validateDocument(raw)
}
export function validateDocument(value: unknown): WorkflowDocument {
  const raw = object(value)
  if (raw.format !== 'open-workflow' || raw.version !== 1) throw new Error('文件格式或版本不受支持；当前支持画布与代码图表文档 v1。')
  const doc: WorkflowDocument = {
    format: 'open-workflow', version: 1, id: string(raw.id, '文档 ID', 512) || newId('doc'),
    title: string(raw.title, '标题', 200) || '未命名', kind: choice(raw.kind, ['flow', 'board', 'mermaid'], '文档类型'),
    scene: validateScene(raw.scene), source: string(raw.source ?? '', '图表源码', 500000),
    diagramStyle: normalizeDiagramStyle(raw.diagramStyle),
    createdAt: validDate(raw.createdAt), updatedAt: validDate(raw.updatedAt),
  }
  if (raw.importSource) {
    const source = object(raw.importSource)
    doc.importSource = { name: string(source.name, '来源文件名', 500), format: string(source.format, '来源格式', 30), text: string(source.text, '原始导入内容', MAX_FILE_BYTES) }
  }
  return doc
}
function validDate(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('文件时间无效。')
  return new Date(value).toISOString()
}
export function serializeDocument(doc: WorkflowDocument): string {
  // Use the reader's schema before writing: a successful save must be reopenable.
  const text = JSON.stringify(validateDocument(doc), null, 2)
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error('文档超过 50 MB，请减少图片或拆分画布。')
  return text
}
export function contentKey(doc: WorkflowDocument): string {
  // Object insertion order and non-document metadata must not make a saved file dirty.
  const styleKey = (s: ElementStyle) => [s.stroke, s.fill, s.strokeWidth, s.fontSize, s.textAlign, s.opacity, resolveStrokePattern(s), s.roughness ?? 'clean']
  const elements = doc.scene.elements.map(element => {
    const base = [element.id, element.type, element.locked, styleKey(element.style), ...(element.groupId ? [element.groupId] : [])]
    if (element.type === 'shape') return [...base, element.shape, element.x, element.y, element.width, element.height, element.text, element.imageData ?? null]
    if (element.type === 'edge') return [...base, [element.from.x, element.from.y, element.from.nodeId ?? null], [element.to.x, element.to.y, element.to.nodeId ?? null], element.label, element.arrow, element.route]
    return [...base, element.points.map(point => [point.x, point.y]), ...(element.closed ? [true] : []), ...(element.brush !== undefined || element.pressures !== undefined ? [{ brush: element.brush ?? null, pressures: element.pressures ?? null }] : [])]
  })
  const identity: unknown[] = [doc.title, doc.kind, doc.scene.background, doc.scene.grid, styleKey(sceneDefaultStyle(doc.scene)), elements, doc.source]
  const diagramStyle = normalizeDiagramStyle(doc.diagramStyle)
  // Preserve v0.1.0 saved keys byte-for-byte for the default presentation.
  if (diagramStyle !== 'classic') identity.push(diagramStyle)
  return JSON.stringify(identity)
}
export const CODE_DIAGRAM_SAMPLE = `flowchart TD
  start([开始]) --> idea[整理想法]
  idea --> review{准备好了吗？}
  review -->|是| done([发布])
  review -->|再完善| idea`

export function createDocument(kind: DocumentKind, template = false): WorkflowDocument {
  const time = new Date().toISOString()
  const doc: WorkflowDocument = {
    format: 'open-workflow', version: 1, id: newId('doc'), title: kind === 'mermaid' ? '未命名代码图表' : '未命名画布',
    kind, scene: emptyScene(), source: kind === 'mermaid' ? CODE_DIAGRAM_SAMPLE : '', diagramStyle: 'classic', createdAt: time, updatedAt: time,
  }
  if (template && kind === 'flow') {
    doc.title = '项目审批流程'
    const nodes = [
      { id: 'start', shape: 'ellipse', x: 300, y: 60, width: 160, height: 64, text: '项目启动', fill: '#dbeafe' },
      { id: 'plan', shape: 'rectangle', x: 280, y: 190, width: 200, height: 80, text: '整理方案与资料', fill: '#ffffff' },
      { id: 'review', shape: 'diamond', x: 280, y: 340, width: 200, height: 120, text: '评审通过？', fill: '#fef3c7' },
      { id: 'revise', shape: 'rectangle', x: 600, y: 360, width: 180, height: 80, text: '补充与修改', fill: '#fee2e2' },
      { id: 'done', shape: 'ellipse', x: 300, y: 540, width: 160, height: 64, text: '开始执行', fill: '#d1fae5' },
    ] as const
    doc.scene.elements = nodes.map(({ fill, ...node }) => ({ ...node, type: 'shape', locked: false, style: { ...DEFAULT_STYLE, fill } }))
    for (const [from, to, label] of [['start', 'plan', ''], ['plan', 'review', ''], ['review', 'done', '通过'], ['review', 'revise', '修改'], ['revise', 'plan', '重新提交']]) {
      doc.scene.elements.push({ id: newId('edge'), type: 'edge', from: { x: 0, y: 0, nodeId: from }, to: { x: 0, y: 0, nodeId: to }, label, arrow: 'end', route: 'orthogonal', style: { ...DEFAULT_STYLE }, locked: false })
    }
  }
  if (template && kind === 'board') {
    doc.title = '灵感收集板'
    doc.scene.elements = [
      { id: newId(), type: 'shape', shape: 'text', x: 90, y: 70, width: 620, height: 80, text: '把想法放在一起', style: { ...DEFAULT_STYLE, fill: 'transparent', fontSize: 32, textAlign: 'left' }, locked: false },
      ...['我们想解决什么问题？\n\n从真实使用场景开始。', '可能的方案\n\n一个想法，一张便签。', '下一步\n\n连接想法，形成行动。'].map((text, i) => ({ id: newId(), type: 'shape' as const, shape: 'note' as const, x: 90 + i * 245, y: 220 + (i % 2) * 40, width: 210, height: 210, text, style: { ...DEFAULT_STYLE, fill: ['#fef3c7', '#dbeafe', '#d1fae5'][i], stroke: '#334155', strokeWidth: 0, textAlign: 'left' as const, fontSize: 18 }, locked: false })),
    ]
  }
  return doc
}

/** Only committed gestures enter history; a large image cannot grow history indefinitely. */
export class DocumentHistory {
  private entries: WorkflowDocument[]
  private sizes: number[]
  private index = 0
  constructor(initial: WorkflowDocument) {
    this.entries = [clone(initial)]
    this.sizes = [JSON.stringify(initial).length * 2]
  }
  get canUndo(): boolean { return this.index > 0 }
  get canRedo(): boolean { return this.index < this.entries.length - 1 }
  commit(doc: WorkflowDocument): void {
    if (contentKey(this.entries[this.index]) === contentKey(doc)) return
    this.entries.splice(this.index + 1)
    this.sizes.splice(this.index + 1)
    this.entries.push(clone(doc))
    this.sizes.push(JSON.stringify(doc).length * 2)
    let size = this.sizes.reduce((total, entry) => total + entry, 0)
    // Retain the current snapshot and one undo even if those two alone exceed the budget.
    while (this.entries.length > 2 && (this.entries.length > 60 || size > 24 * 1024 * 1024)) {
      this.entries.shift()
      size -= this.sizes.shift()!
    }
    this.index = this.entries.length - 1
  }
  undo(): WorkflowDocument | null { return this.canUndo ? clone(this.entries[--this.index]) : null }
  redo(): WorkflowDocument | null { return this.canRedo ? clone(this.entries[++this.index]) : null }
}
