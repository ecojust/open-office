import { DEFAULT_STYLE, type ElementStyle, type Endpoint, type Scene, type SceneElement, type ShapeElement, type EdgeElement, type Point } from '../types.ts'
import { validateScene } from '../documents.ts'

export type DiagramKind = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gitgraph' | 'pie' | 'gantt' | 'xychart' | 'quadrant' | 'mindmap' | 'timeline' | 'journey' | 'kanban' | 'requirement' | 'c4' | 'architecture' | 'sankey' | 'radar' | 'treemap' | 'block' | 'packet'
export interface DiagramSourceRange { start: number; end: number; elementIds: string[] }
export interface DiagramResult { kind: DiagramKind; scene: Scene; warnings: string[]; sourceMap: DiagramSourceRange[] }
export interface DiagramTemplate { kind?: DiagramKind; id: string; title: string; description: string; category: string; source: string }
export interface SourceLine { text: string; line: number; start: number; end: number }
export class DiagramSyntaxError extends Error {
  readonly line: number
  readonly column: number
  constructor(message: string, line: number, column = 1) {
    super(`第 ${line} 行${column > 1 ? `，第 ${column} 列` : ''}：${message}`)
    this.name = 'DiagramSyntaxError'; this.line = line; this.column = column
  }
}
export function sourceLines(source: string): SourceLine[] {
  if (source.length > 200_000) throw new DiagramSyntaxError('源码不能超过 200,000 个字符。', 1)
  const result: SourceLine[] = []
  let start = 0, line = 1
  for (const match of source.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    const text = match[1]!.trimEnd()
    if (text.trim() && !/^\s*%%(?!\{)/.test(text)) result.push({ text, line, start, end: start + text.length })
    start += match[0].length; line++
  }
  return result
}

/** Parser-owned source locations never become part of the editable document. */
export class DiagramSourceMap {
  private readonly lines: Map<number, SourceLine>
  private readonly ranges: DiagramSourceRange[] = []
  private readonly byLine = new Map<number, Set<string>>()
  constructor(lines: SourceLine[] = []) { this.lines = new Map(lines.map(line => [line.line, line])) }
  add(line: number, ...ids: string[]): void {
    const previous = this.byLine.get(line) ?? new Set<string>()
    ids.forEach(id => previous.add(id)); this.byLine.set(line, previous)
  }
  set(line: number, ...ids: string[]): void { this.byLine.set(line, new Set(ids)) }
  range(start: number, end: number, ...elementIds: string[]): void { if (end > start) this.ranges.push({ start, end, elementIds }) }
  capture(line: number, elements: SceneElement[], from: number): void { this.add(line, ...elements.slice(from).map(element => element.id)) }
  entries(elements: SceneElement[]): DiagramSourceRange[] {
    const existing = new Set(elements.map(element => element.id)), result = [...this.ranges]
    for (const [line, ids] of this.byLine) {
      const entry = this.lines.get(line)
      if (!entry) continue
      const start = entry.start + entry.text.length - entry.text.trimStart().length
      if (entry.end > start) result.push({ start, end: entry.end, elementIds: [...ids] })
    }
    return result.map(range => ({ ...range, elementIds: [...new Set(range.elementIds)].filter(id => existing.has(id)) }))
      .filter(range => range.elementIds.length).sort((a, b) => a.start - b.start || a.end - b.end)
  }
}

/** Half-open UTF-16 ranges match textarea selection offsets, including non-BMP text. */
export function lookupDiagramSource(sourceMap: readonly DiagramSourceRange[], offset: number, selectionEnd = offset): string[] {
  if (!Number.isFinite(offset) || !Number.isFinite(selectionEnd)) return []
  const start = Math.min(offset, selectionEnd), end = Math.max(offset, selectionEnd), ids = new Set<string>()
  for (const range of sourceMap) {
    if (range.start > end) break
    if (start === end ? range.start <= start && start < range.end : range.start < end && range.end > start) range.elementIds.forEach(id => ids.add(id))
  }
  return [...ids]
}
export function diagramStyle(changes: Partial<ElementStyle> = {}): ElementStyle {
  const pattern = changes.strokePattern ?? (changes.dashed ? 'dashed' : 'solid')
  return { ...DEFAULT_STYLE, ...changes, strokePattern: pattern, dashed: pattern !== 'solid' }
}
export function diagramNode(id: string, text: string, x: number, y: number, width: number, height: number, shape: ShapeElement['shape'] = 'rectangle', style: Partial<ElementStyle> = {}): ShapeElement {
  return { id, type: 'shape', shape, x, y, width, height, text, style: diagramStyle(style), locked: false }
}
export function diagramText(id: string, text: string, x: number, y: number, width: number, height: number, style: Partial<ElementStyle> = {}): ShapeElement {
  return diagramNode(id, text, x, y, width, height, 'text', { fill: 'none', fontSize: 14, ...style })
}
export function diagramEdge(id: string, from: Endpoint, to: Endpoint, label = '', options: { arrow?: EdgeElement['arrow']; route?: EdgeElement['route']; style?: Partial<ElementStyle> } = {}): EdgeElement {
  return { id, type: 'edge', from: { ...from }, to: { ...to }, label, arrow: options.arrow ?? 'end', route: options.route ?? 'straight', style: diagramStyle({ fill: 'none', ...options.style }), locked: false }
}
export function diagramStroke(id: string, points: Point[], style: Partial<ElementStyle> = {}, closed = false): SceneElement {
  return { id, type: 'stroke', points: points.map(point => ({ ...point })), style: diagramStyle({ fill: 'none', ...style }), locked: false, ...(closed ? { closed: true } : {}) }
}
export function finishDiagram(kind: DiagramKind, elements: SceneElement[], warnings: string[] = [], sourceMap = new DiagramSourceMap()): DiagramResult {
  if (elements.length > 3500) throw new DiagramSyntaxError('图表过于复杂，请减少节点或数据。', 1)
  return { kind, scene: validateScene({ elements, background: '#ffffff', grid: false }), warnings: [...new Set(warnings)], sourceMap: sourceMap.entries(elements) }
}
