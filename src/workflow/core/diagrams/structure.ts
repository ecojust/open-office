import type { SceneElement, ShapeElement, Point, EdgeElement } from '../types.ts'
import { center, edgePoints } from '../geometry.ts'
import { wrapText } from '../svg.ts'
import { DiagramSyntaxError, DiagramSourceMap, sourceLines, diagramNode, diagramText, diagramEdge, diagramStroke, finishDiagram, type DiagramResult, type DiagramTemplate, type SourceLine } from './common.ts'

type Direction = 'LR' | 'RL' | 'TB' | 'TD' | 'BT'
interface Box { key: string; title: string; fields: string[]; methods: string[]; stereotype: string; width: number; height: number; x: number; y: number; shape?: ShapeElement['shape']; group?: string; line: number; sourceLines: number[] }
interface Link { a: string; b: string; label: string; line: number; op?: string; left?: string; right?: string }
interface ModelNote { target?: string; text: string; line: number; lines: number[] }
const ID = '[\\p{L}_][\\p{L}\\p{N}_-]*'
const ident = new RegExp(`^${ID}$`, 'u')
const PALETTE = ['#2563eb', '#059669', '#9333ea', '#d97706', '#dc2626', '#0891b2']
function fail(message: string, line: number): never { throw new DiagramSyntaxError(message, line) }
function value(text: string, line: number): string {
  text = text.trim()
  if (text.length > 2000) fail('单项文本不能超过 2,000 个字符。', line)
  if (text.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(text); if (typeof decoded === 'string') return decoded } catch { /* diagnostic below */ }
    fail('字符串引号或转义不完整。', line)
  }
  return text
}
function addBox(boxes: Map<string, Box>, key: string, line: number): Box {
  let box = boxes.get(key)
  if (!box) {
    if (boxes.size >= 100) fail('此类图表最多支持 100 个节点。', line)
    box = { key, title: key, fields: [], methods: [], stereotype: '', width: 200, height: 72, x: 0, y: 0, line, sourceLines: [] }
    boxes.set(key, box)
  }
  box.sourceLines.push(line)
  return box
}
function addLink(links: Link[], link: Link): void {
  if (links.length >= 240) fail('此类图表最多支持 240 条关系。', link.line)
  links.push(link)
}
function member(box: Box, text: string, line: number): void {
  box.sourceLines.push(line)
  if (box.fields.length + box.methods.length >= 40) fail('每个节点最多支持 40 个成员或字段。', line)
  if (/^<<[^<>]+>>$/.test(text)) { box.stereotype = text; return }
  if (!text || /[{}]/.test(text)) fail('成员语法不完整；不支持嵌套块。', line)
  const label = value(text, line)
  ;(label.includes('(') ? box.methods : box.fields).push(label)
}
function cardSections(box: Box): { header: number; fields: number; methods: number } {
  return {
    header: Math.max(44, wrapText([box.stereotype, box.title].filter(Boolean).join('\n'), box.width - 36, 15).length * 22 + 24),
    fields: Math.max(1, wrapText(box.fields.join('\n'), box.width - 44, 14).length) * 22 + 16,
    methods: box.methods.length ? wrapText(box.methods.join('\n'), box.width - 44, 14).length * 22 + 16 : 0,
  }
}
function sizeCard(box: Box): void {
  const labels = [box.title, box.stereotype, ...box.fields, ...box.methods]
  box.width = Math.min(680, Math.max(230, ...labels.map(label => Array.from(label).reduce((sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 14 : 8), 64))))
  const section = cardSections(box)
  box.height = section.header + section.fields + section.methods
}
/** Layering uses first-visit ranks so cycles cannot inflate the layout. */
function layout(boxes: Map<string, Box>, links: Link[], direction: Direction): void {
  const all = [...boxes.values()]
  const rank = new Map<string, number>()
  const incoming = new Set(links.filter(link => link.a !== link.b).map(link => link.b))
  const queue = all.filter(box => !incoming.has(box.key)).map(box => box.key)
  for (const key of queue) rank.set(key, 0)
  function walk(): void {
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]!
      for (const link of links) if (link.a === key && !rank.has(link.b)) { rank.set(link.b, rank.get(key)! + 1); queue.push(link.b) }
    }
  }
  walk()
  for (const box of all) if (!rank.has(box.key)) { rank.set(box.key, 0); queue.push(box.key); walk() }
  const horizontal = direction === 'LR' || direction === 'RL'
  const layers: Box[][] = []
  for (const box of all) (layers[rank.get(box.key)!] ??= []).push(box)
  const cross = Math.max(0, ...layers.map(layer => layer.reduce((n, box) => n + (horizontal ? box.height : box.width) + 60, -60)))
  let along = 80
  for (const layer of layers) {
    const span = layer.reduce((n, box) => n + (horizontal ? box.height : box.width) + 60, -60)
    let across = 80 + (cross - span) / 2
    for (const box of layer) {
      box.x = horizontal ? along : across; box.y = horizontal ? across : along
      across += (horizontal ? box.height : box.width) + 60
    }
    along += Math.max(...layer.map(box => horizontal ? box.width : box.height)) + 130
  }
  if (direction === 'RL') for (const box of all) box.x = along - box.x - box.width + 80
  if (direction === 'BT') for (const box of all) box.y = along - box.y - box.height + 80
}
function card(box: Box, id: string, elements: SceneElement[], fill = '#eff6ff'): ShapeElement {
  const startIndex = elements.length
  const node = diagramNode(id, '', box.x, box.y, box.width, box.height, box.shape ?? 'rectangle', { fill, stroke: '#64748b' })
  elements.push(node)
  const section = cardSections(box), header = section.header
  elements.push(diagramText(`${id}-title`, [box.stereotype, box.title].filter(Boolean).join('\n'), box.x + 8, box.y + 5, box.width - 16, header - 8, { fontSize: 15 }))
  elements.push(diagramStroke(`${id}-separator`, [{ x: box.x, y: box.y + header }, { x: box.x + box.width, y: box.y + header }], { stroke: '#94a3b8', strokeWidth: 1 }))
  elements.push(diagramText(`${id}-fields`, box.fields.join('\n'), box.x + 12, box.y + header + 2, box.width - 24, section.fields - 4, { textAlign: 'left' }))
  if (box.methods.length) {
    const y = box.y + header + section.fields
    elements.push(diagramStroke(`${id}-methods-separator`, [{ x: box.x, y }, { x: box.x + box.width, y }], { stroke: '#94a3b8', strokeWidth: 1 }))
    elements.push(diagramText(`${id}-methods`, box.methods.join('\n'), box.x + 12, y + 2, box.width - 24, section.methods - 4, { textAlign: 'left' }))
  }
  for (const element of elements.slice(startIndex)) element.groupId = `${id}-card`
  return node
}
function endpoint(node: ShapeElement) { return { ...center(node), nodeId: node.id } }
function relation(edge: EdgeElement, elements: SceneElement[], prefix: string, left = '', right = ''): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  for (const [index, label] of [[0, left], [1, right]] as const) if (label) {
    const p = points[index ? points.length - 1 : 0]!, q = points[index ? points.length - 2 : 1]!
    const length = Math.hypot(q.x - p.x, q.y - p.y) || 1
    elements.push(diagramText(`${prefix}-multiplicity-${index}`, label, p.x + (q.x - p.x) / length * 28 - 32, p.y + (q.y - p.y) / length * 28 - 24, 64, 22, { fontSize: 12 }))
  }
}
function marker(edge: EdgeElement, elements: SceneElement[], side: 'start' | 'end', kind: 'diamond' | 'hollow' | 'triangle', id: string): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  const p = points[side === 'start' ? 0 : points.length - 1]!, q = points[side === 'start' ? 1 : points.length - 2]!
  const length = Math.hypot(q.x - p.x, q.y - p.y) || 1, ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
  const at = (d: number, cross: number): Point => ({ x: p.x + ux * d - uy * cross, y: p.y + uy * d + ux * cross })
  const points2 = kind === 'triangle' ? [p, at(18, 9), at(18, -9)] : [p, at(10, 6), at(20, 0), at(10, -6)]
  elements.push(diagramStroke(id, points2, { fill: kind === 'diamond' ? '#334155' : '#ffffff', strokeWidth: 1.5 }, true))
}
function mapStructureSources(sources: DiagramSourceMap, boxes: Map<string, Box>, nodes: Map<string, ShapeElement>, elements: SceneElement[], links: Link[], prefix: string, groups?: Map<string, Group>): void {
  const members = new Map<string, string[]>()
  for (const element of elements) if (element.groupId) members.set(element.groupId, [...(members.get(element.groupId) ?? []), element.id])
  for (const box of boxes.values()) {
    const node = nodes.get(box.key)!
    for (const line of box.sourceLines) sources.add(line, ...(node.groupId ? members.get(node.groupId)! : [node.id]))
  }
  links.forEach((link, i) => { const id = `${prefix}-edge-${i}`; sources.set(link.line, ...elements.filter(element => element.id === id || element.id.startsWith(`${id}-`)).map(element => element.id)) })
  if (groups) [...groups.values()].forEach((group, i) => sources.add(group.line, `${prefix}-group-${i}`))
}
function modelNotes(notes: ModelNote[], nodes: Map<string, ShapeElement>, elements: SceneElement[], sources: DiagramSourceMap, prefix: string): void {
  if (!notes.length) return
  const bottom = Math.max(0, ...[...nodes.values()].map(node => node.y + node.height)) + 70
  let y = bottom
  for (let index = 0; index < notes.length; index += 3) {
    let height = 0
    for (const [column, note] of notes.slice(index, index + 3).entries()) {
      const width = 300, h = Math.max(70, wrapText(note.text, width - 24, 14).length * 20 + 24), id = `${prefix}-note-${index + column}`
      const node = diagramNode(id, note.text, 80 + column * 350, y, width, h, 'note', { fill: '#fef9c3', stroke: '#854d0e', fontSize: 14, textAlign: 'left' })
      elements.push(node); height = Math.max(height, h)
      if (note.target) elements.push(diagramEdge(`${id}-link`, endpoint(nodes.get(note.target)!), endpoint(node), '', { arrow: 'none', route: 'orthogonal', style: { dashed: true, stroke: '#a16207' } }))
      for (const line of [note.line, ...note.lines]) sources.set(line, id, ...(note.target ? [`${id}-link`] : []))
    }
    y += height + 40
  }
}
function compileClass(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = [], groups = new Map<string, Group>(), stack: string[] = [], notes: ModelNote[] = []
  let active: Box | undefined, opening = 1, direction: Direction = 'TB'
  const relationRE = new RegExp(`^(${ID})(?:\\s+"([^"\\n]*)")?\\s*(<\\|--|--\\|>|<\\|\\.\\.|\\.\\.\\|>|\\*--|--\\*|o--|--o|<-->|<\\.\\.>|-->|<--|\\.\\.>|<\\.\\.|--|\\.\\.)\\s*(?:"([^"\\n]*)"\\s+)?(${ID})(?:\\s*:\\s*(.+))?$`, 'u')
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line
    if (active) { if (text === '}') { active = undefined; continue }; member(active, text, line); continue }
    let m: RegExpMatchArray | null
    if (text === '}') { const key = stack.pop(); if (!key) fail('出现了多余的右花括号。', line); groups.get(key)!.closing = line; continue }
    if ((m = text.match(new RegExp(`^namespace\\s+(${ID})(?:\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*\\{$`, 'u')))) {
      if (groups.has(m[1]!) || boxes.has(m[1]!)) fail(`重复的命名空间标识：${m[1]}。`, line)
      if (groups.size >= 30 || stack.length >= 8) fail('命名空间最多支持 30 个分组和 8 层嵌套。', line)
      groups.set(m[1]!, { key: m[1]!, title: m[2] ? value(m[2], line) : m[1]!, parent: stack.at(-1), line }); stack.push(m[1]!); continue
    }
    if ((m = text.match(new RegExp(`^note(?:\\s+for\\s+(${ID}))?\\s+("(?:[^"\\\\]|\\\\.)*")$`, 'u')))) {
      if (notes.length >= 40) fail('类图最多支持 40 条注释。', line)
      notes.push({ target: m[1], text: value(m[2]!, line), line, lines: [] }); continue
    }
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^class\\s+(${ID})(?:\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*(?:\\{(.*))?$`, 'u')))) {
      const box = addBox(boxes, m[1]!, line); if (m[2]) box.title = value(m[2], line)
      if (groups.has(box.key)) fail('类和命名空间不能使用相同标识。', line)
      if (box.group && box.group !== stack.at(-1)) fail('同一类不能声明在不同命名空间中。', line)
      box.group = stack.at(-1)
      if (m[3] !== undefined) {
        if (m[3].trim().endsWith('}')) { const body = m[3].trim().slice(0, -1); for (const item of body.split(';').map(item => item.trim()).filter(Boolean)) member(box, item, line) }
        else if (m[3].trim()) fail('类定义的首行请仅保留左花括号。', line)
        else { active = box; opening = line }
      }
      continue
    }
    if ((m = text.match(new RegExp(`^(${ID})\\s*:\\s*(.+)$`, 'u')))) { member(addBox(boxes, m[1]!, line), m[2]!, line); continue }
    if ((m = text.match(new RegExp(`^(<<[^<>]+>>)\\s+(${ID})$`, 'u')))) { addBox(boxes, m[2]!, line).stereotype = m[1]!; continue }
    if ((m = text.match(relationRE))) {
      addBox(boxes, m[1]!, line); addBox(boxes, m[5]!, line)
      addLink(links, { a: m[1]!, b: m[5]!, left: m[2] ?? '', right: m[4] ?? '', op: m[3]!, label: value(m[6] ?? '', line), line }); continue
    }
    fail('不支持此类图语法。支持 class、成员、direction、关系、namespace 和 note；样式及交互指令暂不支持。', line)
  }
  if (active) fail('类定义缺少右花括号。', opening)
  if (stack.length) fail('命名空间缺少右花括号。', groups.get(stack.at(-1)!)!.line)
  for (const note of notes) if (note.target && !boxes.has(note.target)) fail('注释引用了未定义的类。', note.line)
  if (!boxes.size) fail('类图至少需要一个类。', lines[0]!.line)
  for (const box of boxes.values()) sizeCard(box)
  const bounds = groups.size ? hierarchicalLayout(boxes, groups, links, direction) : new Map()
  if (!groups.size) layout(boxes, links, direction)
  const elements: SceneElement[] = groups.size ? groupElements(groups, 'class', bounds) : [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `class-${nodes.size}`, elements))
  modelNotes(notes, nodes, elements, sources, 'class')
  const relations: { edge: EdgeElement; link: Link; reverse: boolean; inheritance: boolean; diamond: boolean }[] = []
  links.forEach((link, i) => {
    const op = link.op!, reverse = op.startsWith('<') && !op.endsWith('>'), inheritance = op.includes('|'), diamond = op.includes('*') || op.includes('o')
    const a = nodes.get(reverse ? link.b : link.a)!, b = nodes.get(reverse ? link.a : link.b)!
    const edge = diagramEdge(`class-edge-${i}`, endpoint(a), endpoint(b), link.label, { route: 'orthogonal', arrow: inheritance || diamond || op === '--' || op === '..' ? 'none' : op.startsWith('<') && op.endsWith('>') ? 'both' : 'end', style: { dashed: op.includes('..') } })
    elements.push(edge); relations.push({ edge, link, reverse, inheritance, diamond })
  })
  for (const { edge, link, reverse, inheritance, diamond } of relations) {
    const op = link.op!
    relation(edge, elements, edge.id, reverse ? link.right : link.left, reverse ? link.left : link.right)
    if (inheritance) marker(edge, elements, 'end', 'triangle', `${edge.id}-inheritance`)
    if (diamond) marker(edge, elements, op.startsWith('*') || op.startsWith('o') ? 'start' : 'end', op.includes('*') ? 'diamond' : 'hollow', `${edge.id}-composition`)
  }
  mapStructureSources(sources, boxes, nodes, elements, links, 'class', groups)
  return finishDiagram('class', elements, links.some(link => /[|*o]/.test(link.op ?? '')) ? ['继承、组合和聚合端标为静态装饰；创建可编辑副本后，移动类卡片不会自动重算这些端标。'] : [], sources)
}
function compileState(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), groups = new Map<string, Group>(), stack: string[] = [], links: Link[] = [], notes: ModelNote[] = []
  let direction: Direction = 'TB', activeNote: ModelNote | undefined
  const token = `(?:${ID}|\\[\\*\\])`
  const scope = () => stack.at(-1)
  function state(key: string, line: number, declare = false): Box {
    let resolved = key
    if (scope()) {
      const candidates = [...stack].reverse().map(parent => `${parent}/${key}`)
      resolved = declare ? `${scope()}/${key}` : candidates.find(candidate => boxes.has(candidate)) ?? (boxes.has(key) ? key : `${scope()}/${key}`)
    }
    const exists = boxes.has(resolved), box = addBox(boxes, resolved, line)
    if (box.title === resolved) box.title = key
    if (!exists) box.group = scope()
    return box
  }
  function pseudo(end: boolean, line: number): Box {
    const key = `${scope() ? `${scope()}/` : ''}$${end ? 'end' : 'start'}`, box = addBox(boxes, key, line)
    box.group = scope(); box.stereotype = end ? 'end' : 'start'; return box
  }
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if (activeNote) {
      activeNote.lines.push(line)
      if (text === 'end note') { activeNote = undefined; continue }
      if (activeNote.text.length + text.length > 2000) fail('注释不能超过 2,000 个字符。', line)
      activeNote.text += `${activeNote.text ? '\n' : ''}${text}`; continue
    }
    if (text === '}') {
      const key = stack.pop(); if (!key) fail('出现了多余的右花括号。', line)
      groups.get(key)!.closing = line; continue
    }
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) {
      if (scope()) groups.get(scope()!)!.direction = m[1] as Direction
      else direction = m[1] as Direction
      continue
    }
    if ((m = text.match(new RegExp(`^note\\s+(?:left|right)\\s+of\\s+(${ID})(?:\\s*:\\s*(.+))?$`, 'u')))) {
      if (notes.length >= 40) fail('状态图最多支持 40 条注释。', line)
      const note: ModelNote = { target: state(m[1]!, line).key, text: m[2] ? value(m[2], line) : '', line, lines: [] }
      notes.push(note); if (!m[2]) activeNote = note; continue
    }
    if ((m = text.match(new RegExp(`^state\\s+(?:("(?:[^"\\\\]|\\\\.)*")\\s+as\\s+)?(${ID})\\s*\\{$`, 'u')))) {
      const box = state(m[2]!, line, true)
      if (groups.has(box.key)) fail('复合状态不能重复声明。', line)
      if (groups.size >= 30 || stack.length >= 8) fail('复合状态最多支持 30 个分组和 8 层嵌套。', line)
      if (m[1]) box.title = value(m[1], line)
      box.shape = 'frame'; groups.set(box.key, { key: box.key, title: box.title, parent: scope(), line }); stack.push(box.key); continue
    }
    if ((m = text.match(new RegExp(`^(${token})\\s*-->\\s*(${token})(?:\\s*:\\s*(.+))?$`, 'u')))) {
      const a = m[1] === '[*]' ? pseudo(false, line) : state(m[1]!, line), b = m[2] === '[*]' ? pseudo(true, line) : state(m[2]!, line)
      if (a.stereotype === 'start' && b.stereotype === 'end') fail('起点与终点之间至少需要一个状态。', line)
      addLink(links, { a: a.key, b: b.key, label: value(m[3] ?? '', line), line }); continue
    }
    if ((m = text.match(new RegExp(`^state\\s+("(?:[^"\\\\]|\\\\.)*")\\s+as\\s+(${ID})$`, 'u')))) { state(m[2]!, line, true).title = value(m[1]!, line); continue }
    if ((m = text.match(new RegExp(`^state\\s+(${ID})(?:\\s+<<(choice|fork|join)>>)?$`, 'u')))) {
      const box = state(m[1]!, line, true); if (m[2]) { box.stereotype = m[2]; box.shape = m[2] === 'choice' ? 'diamond' : 'rectangle' }; continue
    }
    if ((m = text.match(new RegExp(`^(${ID})\\s*:\\s*(.+)$`, 'u')))) { const box = state(m[1]!, line); if (box.fields.length >= 20) fail('单个状态描述过多。', line); box.fields.push(value(m[2]!, line)); continue }
    if (ident.test(text)) { state(text, line); continue }
    fail('不支持此状态图语法。支持普通/复合状态、choice、fork/join、note、起终点和转移；并行区域分隔符及历史状态暂不支持。', line)
  }
  if (activeNote) fail('注释缺少 end note。', activeNote.line)
  if (stack.length) fail('复合状态缺少右花括号。', groups.get(stack.at(-1)!)!.line)
  if (!boxes.size) fail('状态图至少需要一个状态。', lines[0]!.line)
  for (const box of boxes.values()) {
    const pseudo = ['start', 'end'].includes(box.stereotype), bar = ['fork', 'join'].includes(box.stereotype), horizontal = direction === 'LR' || direction === 'RL'
    box.width = pseudo ? 30 : bar ? horizontal ? 10 : 140 : box.shape === 'diamond' ? 180 : 240
    box.height = pseudo ? 30 : bar ? horizontal ? 140 : 10 : box.shape === 'diamond' ? 120 : Math.max(72, wrapText([box.title, ...box.fields].join('\n'), 216, 16).length * 23 + 24)
  }
  if (groups.size) hierarchicalLayout(boxes, groups, links, direction)
  else {
    layout(boxes, links, direction)
    const final = boxes.get('$end'), otherStates = [...boxes.values()].filter(box => box !== final)
    if (final && otherStates.length) {
      if (direction === 'LR') final.x = Math.max(...otherStates.map(box => box.x + box.width)) + 130
      if (direction === 'RL') final.x = Math.min(...otherStates.map(box => box.x)) - 160
      if (direction === 'TB' || direction === 'TD') final.y = Math.max(...otherStates.map(box => box.y + box.height)) + 130
      if (direction === 'BT') final.y = Math.min(...otherStates.map(box => box.y)) - 160
    }
  }
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>(), ordered = [...boxes.values()]
  for (const box of ordered) {
    const pseudo = ['start', 'end'].includes(box.stereotype), bar = ['fork', 'join'].includes(box.stereotype), id = `state-${nodes.size}`
    const node = diagramNode(id, pseudo || bar ? '' : [box.title, ...box.fields].join('\n'), box.x, box.y, box.width, box.height, pseudo ? 'ellipse' : box.shape ?? 'rectangle', { fill: box.stereotype === 'start' || bar ? '#334155' : box.shape === 'frame' ? 'none' : '#f0fdfa', ...(box.shape === 'frame' ? { textAlign: 'left', dashed: true } : {}) })
    elements.push(node); nodes.set(box.key, node)
    if (box.stereotype === 'end') {
      node.groupId = `${id}-symbol`
      elements.push({ ...diagramNode(`${id}-inner`, '', box.x + 6, box.y + 6, 18, 18, 'ellipse', { fill: '#334155' }), groupId: node.groupId })
    }
  }
  elements.sort((a, b) => Number(b.type === 'shape' && b.shape === 'frame') - Number(a.type === 'shape' && a.shape === 'frame'))
  links.forEach((link, i) => elements.push(diagramEdge(`state-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { route: 'orthogonal' })))
  mapStructureSources(sources, boxes, nodes, elements, links, 'state')
  modelNotes(notes, nodes, elements, sources, 'state')
  return finishDiagram('state', elements, notes.length ? ['状态注释按自动布局集中放在图下方，并以虚线连接目标状态；left/right 提示不固定注释的绝对位置。'] : [], sources)
}
function crowfoot(edge: EdgeElement, elements: SceneElement[], side: 'start' | 'end', symbol: string, id: string): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  const p = points[side === 'start' ? 0 : points.length - 1]!, q = points[side === 'start' ? 1 : points.length - 2]!
  const length = Math.hypot(q.x - p.x, q.y - p.y) || 1, ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
  const at = (d: number, cross: number): Point => ({ x: p.x + ux * d - uy * cross, y: p.y + uy * d + ux * cross })
  if (/[{}]/.test(symbol)) for (const cross of [-8, 0, 8]) elements.push(diagramStroke(`${id}-fan-${cross}`, [at(2, cross), at(17, 0)], { strokeWidth: 1.5 }))
  else elements.push(diagramStroke(`${id}-one`, [at(7, -8), at(7, 8)], { strokeWidth: 1.5 }))
  if (symbol.includes('o')) { const c = at(25, 0); elements.push(diagramNode(`${id}-optional`, '', c.x - 5, c.y - 5, 10, 10, 'ellipse', { fill: '#ffffff', strokeWidth: 1.5 })) }
  else elements.push(diagramStroke(`${id}-required`, [at(24, -8), at(24, 8)], { strokeWidth: 1.5 }))
}
function compileER(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = []; let active: Box | undefined, opening = 1, direction: Direction = 'LR'
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if (active) {
      if (text === '}') { active = undefined; continue }
      if (!(m = text.match(/^([\p{L}_][\p{L}\p{N}_()[\]-]*)\s+([\p{L}_][\p{L}\p{N}_-]*)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+("(?:[^"\\]|\\.)*"))?$/u))) fail('实体属性格式应为：类型 名称 [PK, FK, UK] ["说明"]。', line)
      const label = `${m[1]}    ${m[2]}${m[3] ? `    [${m[3].replace(/\s/g, '')}]` : ''}${m[4] ? `  ${value(m[4], line)}` : ''}`
      if (active.fields.length >= 40) fail('每个实体最多支持 40 个属性。', line)
      active.sourceLines.push(line); active.fields.push(label); continue
    }
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^(${ID})(?:\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*\\{$`, 'u')))) { active = addBox(boxes, m[1]!, line); if (m[2]) active.title = value(m[2], line); opening = line; continue }
    if ((m = text.match(new RegExp(`^(${ID})\\s+(\\|\\||\\|o|o\\||\\}\\||\\}o)(--|\\.\\.)(\\|\\||o\\||\\|o|\\|\\{|o\\{)\\s+(${ID})\\s*:\\s*(.+)$`, 'u')))) {
      addBox(boxes, m[1]!, line); addBox(boxes, m[5]!, line); addLink(links, { a: m[1]!, b: m[5]!, left: m[2]!, right: m[4]!, op: m[3]!, label: value(m[6]!, line), line }); continue
    }
    if (ident.test(text)) { addBox(boxes, text, line); continue }
    fail('不支持此 ER 图语法。请使用实体属性块及 ||--o{ 等基数关系。', line)
  }
  if (active) fail('实体定义缺少右花括号。', opening)
  if (!boxes.size) fail('ER 图至少需要一个实体。', lines[0]!.line)
  for (const box of boxes.values()) sizeCard(box)
  layout(boxes, links, direction)
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `er-${nodes.size}`, elements, '#f0fdf4'))
  links.forEach((link, i) => {
    const edge = diagramEdge(`er-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { arrow: 'none', style: { dashed: link.op === '..' } }); elements.push(edge)
    crowfoot(edge, elements, 'start', link.left!, `${edge.id}-left`); crowfoot(edge, elements, 'end', link.right!, `${edge.id}-right`)
  })
  mapStructureSources(sources, boxes, nodes, elements, links, 'er')
  return finishDiagram('er', elements, links.length ? ['ER 基数端标为静态装饰；创建可编辑副本后，移动实体卡片不会自动重算这些端标。'] : [], sources)
}
interface Commit { id: string; branch: string; parents: string[]; tag: string; type: string; line: number; pickedFrom?: string; pickedParent?: string }
function gitOptions(text: string, line: number, allowed = ['id', 'tag', 'type']): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  while (text.trim()) {
    const m = text.trim().match(/^(id|tag|type|parent)\s*:\s*("(?:[^"\\]|\\.)*"|[\w.-]+)(?:\s+|$)/)
    if (!m || !allowed.includes(m[1]!)) fail(`此指令选项支持 ${allowed.join('、')}。`, line)
    if (result[m[1]!] !== undefined) fail(`重复的 ${m[1]} 选项。`, line)
    result[m[1]!] = value(m[2]!, line); text = text.trim().slice(m[0].length)
  }
  if (result.type && !['NORMAL', 'REVERSE', 'HIGHLIGHT'].includes(result.type)) fail('未知提交类型。', line)
  return result
}
function compileGit(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const header = lines[0]!, hm = header.text.trim().match(/^gitGraph(?:\s+(LR|RL|TB|BT))?\s*:?$/)
  if (!hm) fail('gitGraph 标题支持 LR、RL、TB、BT 方向。', header.line)
  const direction = (hm[1] ?? 'LR') as Direction
  const branches = new Map<string, { head?: string; order: number; index: number; lines: number[] }>([['main', { order: 0, index: 0, lines: [] }]])
  const commits: Commit[] = [], ids = new Set<string>(); let current = 'main'
  const commit = (options: Record<string, string>, line: number, extra?: string): void => {
    if (commits.length >= 150) fail('gitGraph 最多支持 150 次提交。', line)
    let id = options.id
    if (id !== undefined && !id.trim()) fail('提交标识不能为空。', line)
    if (id === undefined) { let n = commits.length + 1; while (ids.has(`c${n}`)) n++; id = `c${n}` }
    if (ids.has(id)) fail(`重复的提交标识：${id}。`, line)
    const branch = branches.get(current)!, parents = [branch.head, extra].filter((parent): parent is string => !!parent)
    commits.push({ id, branch: current, parents, tag: options.tag ?? '', type: options.type ?? 'NORMAL', line }); ids.add(id); branch.head = id
  }
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(/^commit(?:\s+(.*))?$/))) { commit(gitOptions(m[1] ?? '', line), line); continue }
    if ((m = text.match(new RegExp(`^branch\\s+(${ID})(?:\\s+order\\s*:\\s*(\\d+))?$`, 'u')))) {
      if (branches.size >= 20) fail('最多支持 20 个分支。', line)
      if (branches.has(m[1]!)) fail(`分支 ${m[1]} 已存在。`, line)
      const order = m[2] ? Number(m[2]) : branches.size
      if (!Number.isSafeInteger(order) || order > 10000) fail('分支 order 必须是 0–10000 的整数。', line)
      branches.set(m[1]!, { head: branches.get(current)!.head, order, index: branches.size, lines: [line] }); current = m[1]!; continue
    }
    if ((m = text.match(new RegExp(`^(?:checkout|switch)\\s+(${ID})$`, 'u')))) { if (!branches.has(m[1]!)) fail(`分支 ${m[1]} 不存在。`, line); current = m[1]!; branches.get(current)!.lines.push(line); continue }
    if ((m = text.match(new RegExp(`^merge\\s+(${ID})(?:\\s+(.*))?$`, 'u')))) {
      const other = branches.get(m[1]!)
      if (!other) fail(`合并分支 ${m[1]} 不存在。`, line)
      if (m[1] === current) fail('不能将分支合并到自身。', line)
      if (!other.head || !branches.get(current)!.head) fail('合并双方都需要已有提交。', line)
      if (other.head === branches.get(current)!.head) fail('两个分支指向相同提交，无需合并。', line)
      commit(gitOptions(m[2] ?? '', line), line, other.head); continue
    }
    if ((m = text.match(/^cherry-pick(?:\s+(.*))?$/))) {
      const options = gitOptions(m[1] ?? '', line, ['id', 'parent', 'tag']), original = commits.find(item => item.id === options.id)
      if (!original) fail('cherry-pick 的 id 必须引用已有提交。', line)
      if (original.branch === current) fail('cherry-pick 应从其他分支选取提交。', line)
      if (!branches.get(current)!.head) fail('当前分支需要已有提交才能摘取提交。', line)
      if (original.parents.length > 1 && !options.parent) fail('摘取合并提交时，必须用 parent 指定其一个父提交。', line)
      if (options.parent && !original.parents.includes(options.parent)) fail('parent 必须是被摘取提交的实际父提交。', line)
      let id = `${original.id}-pick`, suffix = 2
      while (ids.has(id)) id = `${original.id}-pick-${suffix++}`
      commit({ id, type: 'HIGHLIGHT', ...(options.tag ? { tag: options.tag } : {}) }, line)
      commits.at(-1)!.pickedFrom = original.id; commits.at(-1)!.pickedParent = options.parent; continue
    }
    fail('不支持此 gitGraph 语法。支持 commit、branch、checkout/switch、merge 和 cherry-pick；配置指令暂不支持。', line)
  }
  if (!commits.length) fail('gitGraph 至少需要一次提交。', header.line)
  const lanes = [...branches.entries()].sort((a, b) => a[1].order - b[1].order || a[1].index - b[1].index)
  const textSize = (text: string) => { const width = Math.min(260, Math.max(130, Array.from(text).length * 7 + 24)); return { width, height: Math.max(28, wrapText(text, width - 20, 12).length * 17 + 12) } }
  const metrics = commits.map(item => ({ label: textSize(item.id), tag: textSize(item.tag) })), vertical = direction === 'TB' || direction === 'BT'
  const along = Math.max(150, ...metrics.map(item => vertical ? item.label.height + item.tag.height + 70 : Math.max(item.label.width, item.tag.width) + 24))
  const across = Math.max(130, ...metrics.map(item => vertical ? Math.max(item.label.width, item.tag.width) + 40 : item.label.height + item.tag.height + 70))
  const position = (time: number, lane: number): Point => {
    let x = 180 + time * along, y = 100 + lane * across
    if (direction === 'RL') x = 180 + (commits.length - 1 - time) * along
    if (vertical) { const nextX = y; y = direction === 'BT' ? 180 + (commits.length - 1 - time) * along : x; x = nextX }
    return { x, y }
  }
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  lanes.forEach(([name, branch], index) => {
    for (const line of branch.lines) sources.add(line, `git-lane-${index}`, `git-branch-${index}`)
    const start = position(-0.5, index), end = position(commits.length - 0.5, index), color = PALETTE[index % PALETTE.length]!
    elements.push(diagramStroke(`git-lane-${index}`, [start, end], { stroke: color, opacity: 0.28, strokeWidth: 2 }))
    const p = position(direction === 'RL' || direction === 'BT' ? commits.length - 0.4 : -0.6, index)
    elements.push(diagramText(`git-branch-${index}`, name, p.x - 55, p.y - 40, 110, 30, { stroke: color }))
  })
  commits.forEach((item, i) => {
    const first = elements.length
    const lane = lanes.findIndex(([name]) => name === item.branch), p = position(i, lane), color = PALETTE[lane % PALETTE.length]!, id = `git-commit-${i}`
    const node = diagramNode(id, '', p.x - 13, p.y - 13, 26, 26, 'ellipse', { fill: color, stroke: color }); nodes.set(item.id, node); elements.push(node)
    if (item.type === 'HIGHLIGHT') elements.push(diagramNode(`${id}-highlight`, '', p.x - 19, p.y - 19, 38, 38, 'ellipse', { fill: 'none', stroke: color }))
    if (item.type === 'REVERSE') for (const sign of [-1, 1]) elements.push(diagramStroke(`${id}-reverse-${sign}`, [{ x: p.x - 6, y: p.y - sign * 6 }, { x: p.x + 6, y: p.y + sign * 6 }], { stroke: '#ffffff', strokeWidth: 2 }))
    const metric = metrics[i]!
    elements.push(diagramText(`${id}-label`, item.id, p.x - metric.label.width / 2, p.y + 23, metric.label.width, metric.label.height, { fontSize: 12 }))
    if (item.tag) elements.push(diagramNode(`${id}-tag`, item.tag, p.x - metric.tag.width / 2, p.y - metric.tag.height - 26, metric.tag.width, metric.tag.height, 'rectangle', { fill: '#fef3c7', stroke: '#d97706', fontSize: 12 }))
    for (const element of elements.slice(first)) element.groupId = `${id}-symbol`
    sources.capture(item.line, elements, first)
    sources.add(item.line, ...item.parents.map((_, index) => `git-edge-${i}-${index}`))
    if (item.pickedFrom) sources.add(item.line, `git-pick-${i}`)
  })
  const edges: SceneElement[] = []
  commits.forEach((item, i) => item.parents.forEach((parent, index) => edges.push(diagramEdge(`git-edge-${i}-${index}`, endpoint(nodes.get(parent)!), endpoint(nodes.get(item.id)!), '', { route: index ? 'orthogonal' : 'straight', style: { stroke: nodes.get(item.id)!.style.stroke, strokeWidth: 2 } }))))
  commits.forEach((item, i) => { if (item.pickedFrom) edges.push(diagramEdge(`git-pick-${i}`, endpoint(nodes.get(item.pickedFrom)!), endpoint(nodes.get(item.id)!), item.pickedParent ? `摘取 · 基于 ${item.pickedParent}` : '摘取', { route: 'orthogonal', style: { dashed: true, stroke: '#9333ea' } })) })
  // Tracks first, ancestry second, commits last keep dots and labels legible.
  const tracks = lanes.length * 2
  elements.splice(tracks, 0, ...edges)
  return finishDiagram('gitgraph', elements, [], sources)
}
function compileRequirement(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = [], fields = new Map<string, Map<string, string>>()
  let active: Box | undefined, opening = 1, direction: Direction = 'TB'
  const allowedTypes = 'requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element'
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if (active) {
      if (text === '}') { active = undefined; continue }
      if (!(m = text.match(/^(id|text|risk|verifymethod|type|docref)\s*:\s*(.+)$/))) fail('需求字段支持 id、text、risk、verifymethod；element 支持 type、docref。', line)
      const key = m[1]!, data = value(m[2]!, line), isElement = active.stereotype === '«element»'
      if (isElement ? !['type', 'docref'].includes(key) : !['id', 'text', 'risk', 'verifymethod'].includes(key)) fail(`此节点不支持 ${key} 字段。`, line)
      if (key === 'risk' && !['low', 'medium', 'high'].includes(data.toLowerCase())) fail('risk 应为 low、medium 或 high。', line)
      if (key === 'verifymethod' && !['analysis', 'inspection', 'test', 'demonstration'].includes(data.toLowerCase())) fail('verifymethod 应为 analysis、inspection、test 或 demonstration。', line)
      const map = fields.get(active.key)!
      if (map.has(key)) fail(`重复的 ${key} 字段。`, line)
      active.sourceLines.push(line); map.set(key, data); continue
    }
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^(${allowedTypes})\\s+(${ID})\\s*\\{$`, 'u')))) {
      if (boxes.has(m[2]!)) fail(`重复的需求节点：${m[2]}。`, line)
      active = addBox(boxes, m[2]!, line); active.stereotype = `«${m[1]}»`; fields.set(active.key, new Map()); opening = line; continue
    }
    if ((m = text.match(new RegExp(`^(${ID})\\s+(-|<-)\\s*(contains|copies|derives|satisfies|verifies|refines|traces)\\s*(->|-)\\s+(${ID})$`, 'u')))) {
      if (!(m[2] === '-' && m[4] === '->') && !(m[2] === '<-' && m[4] === '-')) fail('需求关系应为 A - 关系 -> B 或 A <- 关系 - B。', line)
      addLink(links, { a: m[2] === '<-' ? m[5]! : m[1]!, b: m[2] === '<-' ? m[1]! : m[5]!, label: m[3]!, line }); continue
    }
    fail('不支持此需求图语法。请使用需求/element 字段块和有向关系。', line)
  }
  if (active) fail('需求定义缺少右花括号。', opening)
  if (!boxes.size) fail('需求图至少需要一个节点。', lines[0]!.line)
  for (const link of links) if (!boxes.has(link.a) || !boxes.has(link.b)) fail('需求关系引用了未定义节点。', link.line)
  for (const box of boxes.values()) { box.fields = [...fields.get(box.key)!].flatMap(([key, data]) => wrap(`${key}: ${data}`, 45)); sizeCard(box) }
  layout(boxes, links, direction)
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `requirement-${nodes.size}`, elements, '#fefce8'))
  links.forEach((link, i) => elements.push(diagramEdge(`requirement-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), `«${link.label}»`, { style: { dashed: link.label !== 'contains' } })))
  mapStructureSources(sources, boxes, nodes, elements, links, 'requirement')
  return finishDiagram('requirement', elements, [], sources)
}
function wrap(text: string, width: number): string[] {
  const chars = Array.from(text), lines: string[] = []
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
  return lines.length ? lines : ['']
}
function args(text: string, line: number): string[] {
  const result: string[] = []; let current = '', quoted = false, escaped = false
  for (const char of text) {
    if (escaped) { current += char; escaped = false; continue }
    if (quoted && char === '\\') { current += char; escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (char === ',' && !quoted) { result.push(value(current, line)); current = '' } else current += char
  }
  if (quoted) fail('函数参数的引号未闭合。', line)
  result.push(value(current, line)); return result
}
interface Group { key: string; title: string; parent?: string; line: number; closing?: number; direction?: Direction }
function hierarchicalLayout(boxes: Map<string, Box>, groups: Map<string, Group>, links: Link[], direction: Direction): Map<string, { x: number; y: number; width: number; height: number }> {
  const bounds = new Map<string, { x: number; y: number; width: number; height: number }>()
  const belongs = (key: string | undefined, ancestor: string): boolean => { while (key) { if (key === ancestor) return true; key = groups.get(key)?.parent }; return false }
  function project(key: string, parent: string | undefined): string | undefined {
    if (!groups.has(key) && boxes.get(key)?.group === parent) return key
    let group = groups.has(key) ? key : boxes.get(key)?.group
    while (group) { const item = groups.get(group)!; if (item.parent === parent) return group; group = item.parent }
    return undefined
  }
  function place(parent: string | undefined, depth: number): { width: number; height: number } {
    if (depth > 8) fail('分组嵌套不能超过 8 层。', groups.get(parent ?? '')?.line ?? 1)
    const units = new Map([...boxes.entries()].filter(([key, box]) => !groups.has(key) && box.group === parent))
    const children = [...groups.values()].filter(group => group.parent === parent)
    for (const group of children) {
      const size = place(group.key, depth + 1)
      bounds.set(group.key, { x: 0, y: 0, ...size })
      units.set(group.key, { key: group.key, title: group.title, fields: [], methods: [], stereotype: '', ...size, x: 0, y: 0, line: group.line, sourceLines: [] })
    }
    if (!units.size) return { width: 300, height: 130 }
    const relations = links.flatMap(link => { const a = project(link.a, parent), b = project(link.b, parent); return a && b && a !== b ? [{ ...link, a, b }] : [] })
    let group = parent, localDirection = direction
    while (group) { const item = groups.get(group)!; if (item.direction) { localDirection = item.direction; break }; group = item.parent }
    layout(units, relations, localDirection)
    const left = Math.min(...[...units.values()].map(box => box.x)), top = Math.min(...[...units.values()].map(box => box.y))
    for (const unit of units.values()) {
      unit.x += 30 - left; unit.y += 55 - top
      if (!groups.has(unit.key)) continue
      for (const box of boxes.values()) if (!groups.has(box.key) && belongs(box.group, unit.key)) { box.x += unit.x; box.y += unit.y }
      for (const [key, bounds2] of bounds) if (belongs(key, unit.key)) { bounds2.x += unit.x; bounds2.y += unit.y }
    }
    return { width: Math.max(...[...units.values()].map(box => box.x + box.width)) + 30, height: Math.max(...[...units.values()].map(box => box.y + box.height)) + 30 }
  }
  place(undefined, 0)
  for (const [key, area] of bounds) { const box = boxes.get(key); if (box) Object.assign(box, area) }
  return bounds
}
function groupedLayout(boxes: Map<string, Box>, groups: Map<string, Group>): Map<string, { x: number; y: number; width: number; height: number }> {
  // Recursive groups retain visual membership, with a deterministic grid inside each boundary.
  let count = 0
  function place(groupKey: string | undefined, x: number, y: number, depth: number): { width: number; height: number } {
    if (depth > 8) fail('分组嵌套不能超过 8 层。', groups.get(groupKey ?? '')?.line ?? 1)
    const direct = [...boxes.values()].filter(box => box.group === groupKey), children = [...groups.values()].filter(group => group.parent === groupKey)
    let bottom = y + 55, maxRight = x + 320
    for (let i = 0; i < direct.length; i += 3) {
      const row = direct.slice(i, i + 3), rowY = bottom
      let rowX = x + 30
      row.forEach(box => { box.x = rowX; box.y = rowY; rowX += box.width + 80; maxRight = Math.max(maxRight, box.x + box.width + 30) })
      bottom += Math.max(...row.map(box => box.height)) + 60
    }
    for (const child of children) {
      if (++count > 100) fail('分组结构包含循环或节点过多。', child.line)
      const size = place(child.key, x + 25, bottom + 20, depth + 1)
      bounds.set(child.key, { x: x + 25, y: bottom + 20, width: size.width, height: size.height })
      bottom += size.height + 45; maxRight = Math.max(maxRight, x + 25 + size.width + 25)
    }
    return { width: maxRight - x, height: Math.max(130, bottom - y) }
  }
  const bounds = new Map<string, { x: number; y: number; width: number; height: number }>()
  place(undefined, 50, 70, 0)
  return bounds
}
function groupElements(groups: Map<string, Group>, prefix: string, groupBounds: Map<string, { x: number; y: number; width: number; height: number }>): SceneElement[] {
  return [...groups.values()].map((group, i) => {
    const bounds = groupBounds.get(group.key)!
    return diagramNode(`${prefix}-group-${i}`, group.title, bounds.x, bounds.y, bounds.width, bounds.height, 'frame', { fill: '#f8fafc', stroke: '#94a3b8', dashed: true, textAlign: 'left', fontSize: 14 })
  })
}
function compileC4(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), groups = new Map<string, Group>(), links: Link[] = [], kinds = new Map<string, string>(), stack: string[] = []
  let title = ''
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(/^title\s+(.+)$/))) { if (title) fail('title 只能声明一次。', line); title = value(m[1]!, line); sources.add(line, 'c4-title'); continue }
    if (text === '}') { const key = stack.pop(); if (!key) fail('出现了多余的右花括号。', line); groups.get(key)!.closing = line; continue }
    if (!(m = text.match(/^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?$/))) fail('不支持此 C4 语法。请使用 Person、System、边界和 Rel 函数。', line)
    const name = m[1]!, list = args(m[2]!, line), key = list[0]!
    if (['Enterprise_Boundary', 'System_Boundary', 'Container_Boundary', 'Boundary'].includes(name)) {
      if (!m[3] || list.length !== 2 || !ident.test(key)) fail('边界格式应为 System_Boundary(id, "名称") {。', line)
      if (groups.has(key) || boxes.has(key)) fail(`重复的 C4 标识：${key}。`, line)
      if (groups.size >= 30 || stack.length >= 8) fail('C4 分组过多或嵌套超过 8 层。', line)
      groups.set(key, { key, title: list[1]!, parent: stack.at(-1), line }); stack.push(key); continue
    }
    if (m[3]) fail('仅边界函数允许定义块。', line)
    if (/^(?:Person|System(?:Db|Queue)?|Container(?:Db|Queue)?|Component(?:Db|Queue)?)(?:_Ext)?$/.test(name)) {
      const detailed = /^(Container|Component)/.test(name)
      if (list.length < (detailed ? 3 : 2) || list.length > (detailed ? 4 : 3) || !ident.test(key)) fail(detailed ? '容器或组件格式应为 Container/Component(id, "名称", "技术", ["描述"])。' : '人物或系统格式应为 Person/System(id, "名称", ["描述"])。', line)
      if (boxes.has(key) || groups.has(key)) fail(`重复的 C4 标识：${key}。`, line)
      const box = addBox(boxes, key, line); box.title = list[1]!; box.fields = detailed ? [`技术：${list[2]}`, ...wrap(list[3] ?? '', 28)] : wrap(list[2] ?? '', 28); box.stereotype = name; box.group = stack.at(-1); box.width = detailed ? 280 : 250; box.height = Math.max(120, wrapText([box.title, `[${name}]`, ...box.fields].join('\n'), box.width - 24, 14).length * 20 + 24); kinds.set(key, name); continue
    }
    if (['Rel', 'Rel_Back', 'BiRel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R'].includes(name)) {
      if (list.length < 3 || list.length > 4 || !ident.test(key) || !ident.test(list[1]!)) fail('关系格式应为 Rel(起点, 终点, "说明", ["协议"])。', line)
      addLink(links, { a: name === 'Rel_Back' ? list[1]! : key, b: name === 'Rel_Back' ? key : list[1]!, label: list[2]! + (list[3] ? `\n[${list[3]}]` : ''), op: name, line }); continue
    }
    fail(`暂不支持 C4 函数 ${name}。支持人物、系统、容器、组件、边界和关系。`, line)
  }
  if (stack.length) fail('C4 边界缺少右花括号。', groups.get(stack.at(-1)!)!.line)
  if (!boxes.size) fail('C4 图至少需要一个人物或系统。', lines[0]!.line)
  for (const link of links) if (!boxes.has(link.a) || !boxes.has(link.b)) fail('C4 关系引用了未定义节点。', link.line)
  const bounds = groups.size ? groupedLayout(boxes, groups) : new Map()
  if (!groups.size) layout(boxes, links, 'LR')
  const elements: SceneElement[] = groups.size ? groupElements(groups, 'c4', bounds) : [], nodes = new Map<string, ShapeElement>()
  if (title) elements.push(diagramText('c4-title', title, 60, 10, 700, 40, { fontSize: 23, textAlign: 'left' }))
  for (const box of boxes.values()) {
    const kind = kinds.get(box.key)!, external = kind.endsWith('_Ext'), person = kind.startsWith('Person'), id = `c4-${nodes.size}`
    const category = person ? 'Person' : kind.startsWith('Container') ? 'Container' : kind.startsWith('Component') ? 'Component' : 'Software System'
    const node = diagramNode(id, `${box.title}\n[${category}]\n${box.fields.join('\n')}`, box.x, box.y, box.width, box.height, kind.includes('Db') ? 'cylinder' : 'rectangle', { fill: external ? '#64748b' : person ? '#1e3a8a' : '#2563eb', stroke: '#ffffff', fontSize: 14 })
    elements.push(node); nodes.set(box.key, node)
    if (person) {
      node.groupId = `${id}-symbol`
      elements.push({ ...diagramNode(`${id}-person`, '', box.x + box.width / 2 - 15, box.y - 25, 30, 30, 'ellipse', { fill: external ? '#64748b' : '#1e3a8a', stroke: '#ffffff' }), groupId: node.groupId })
    }
  }
  links.forEach((link, i) => elements.push(diagramEdge(`c4-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { arrow: link.op === 'BiRel' ? 'both' : 'end', style: { dashed: true } })))
  const warnings = ['C4 图使用本地简化人物、系统、容器与组件符号及自动布局；边界保留分组，暂不支持样式配置指令。']
  if (links.some(link => /^Rel_[UDLR]$/.test(link.op ?? ''))) warnings.push('Rel_U/D/L/R 的方向提示由自动布局统一处理；关系起点、终点及标签保持不变。')
  mapStructureSources(sources, boxes, nodes, elements, links, 'c4', groups)
  return finishDiagram('c4', elements, warnings, sources)
}
type Port = 'L' | 'R' | 'T' | 'B'
function port(node: ShapeElement, side: Port): Point {
  return { x: node.x + (side === 'L' ? 0 : side === 'R' ? node.width : node.width / 2), y: node.y + (side === 'T' ? 0 : side === 'B' ? node.height : node.height / 2) }
}
function compileArchitecture(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), groups = new Map<string, Group>(), icons = new Map<string, string>()
  const links: (Link & { fromPort: Port; toPort: Port; fromGroup?: boolean; toGroup?: boolean })[] = []
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(new RegExp(`^junction\\s+(${ID})(?:\\s+in\\s+(${ID}))?$`, 'u')))) {
      const key = m[1]!
      if (boxes.has(key) || groups.has(key)) fail(`重复的架构标识：${key}。`, line)
      const box = addBox(boxes, key, line); box.title = ''; box.group = m[2]; box.width = 14; box.height = 14; icons.set(key, 'junction'); continue
    }
    if ((m = text.match(new RegExp(`^(group|service)\\s+(${ID})(?:\\(([\\w:.-]+)\\))?\\[([^\\[\\]]+)\\](?:\\s+in\\s+(${ID}))?$`, 'u')))) {
      const key = m[2]!
      if (boxes.has(key) || groups.has(key)) fail(`重复的架构标识：${key}。`, line)
      if (m[1] === 'group') { if (groups.size >= 30) fail('架构图最多支持 30 个分组。', line); groups.set(key, { key, title: value(m[4]!, line), parent: m[5], line }) }
      else { const box = addBox(boxes, key, line); box.title = value(m[4]!, line); box.group = m[5]; box.width = 220; box.height = 110; icons.set(key, m[3] ?? 'server') }
      continue
    }
    if ((m = text.match(new RegExp(`^(${ID})(\\{group\\})?:([LRTB])\\s*(<-->|-->|<--|--)\\s*([LRTB]):(${ID})(\\{group\\})?(?:\\s*:\\s*(.+))?$`, 'u')))) {
      if (links.length >= 240) fail('架构图最多支持 240 条连接。', line)
      links.push({ a: m[1]!, fromGroup: !!m[2], fromPort: m[3] as Port, op: m[4]!, toPort: m[5] as Port, b: m[6]!, toGroup: !!m[7], label: value(m[8] ?? '', line), line }); continue
    }
    fail('不支持此架构语法。支持 group/service、junction、L/R/T/B 端口、{group} 边界端口及连接标签。', line)
  }
  if (!boxes.size) fail('架构图至少需要一个 service。', lines[0]!.line)
  for (const group of groups.values()) {
    const visited = new Set<string>([group.key]); let parent = group.parent
    while (parent) {
      if (!groups.has(parent)) fail(`架构分组 ${parent} 未定义。`, group.line)
      if (visited.has(parent)) fail('架构分组不能循环包含。', group.line)
      visited.add(parent); parent = groups.get(parent)!.parent
    }
  }
  for (const box of boxes.values()) if (box.group && !groups.has(box.group)) fail(`服务 ${box.key} 的分组 ${box.group} 未定义。`, box.line)
  for (const link of links) {
    if ((!boxes.has(link.a) && !groups.has(link.a)) || (!boxes.has(link.b) && !groups.has(link.b))) fail('架构连接引用了未定义的服务、连接点或分组。', link.line)
    if (link.fromGroup && !boxes.get(link.a)?.group || link.toGroup && !boxes.get(link.b)?.group) fail('{group} 端口需要引用一个属于分组的服务或连接点。', link.line)
  }
  const bounds = hierarchicalLayout(boxes, groups, links, 'TB')
  const elements: SceneElement[] = groupElements(groups, 'architecture', bounds), nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) {
    const icon = icons.get(box.key)!, local = icon === 'junction' ? 'ellipse' : /database|postgres|mysql|redis|disk/i.test(icon) ? 'cylinder' : /cloud/i.test(icon) ? 'cloud' : 'rectangle', id = `architecture-${nodes.size}`
    const node = diagramNode(id, icon === 'junction' ? '' : `${box.title}\n[${icon}]`, box.x, box.y, box.width, box.height, local, { fill: icon === 'junction' ? '#1e40af' : '#eff6ff', stroke: '#1e40af', fontSize: 14 })
    elements.push(node); nodes.set(box.key, node)
  }
  links.forEach((link, i) => {
    const groupNodes = new Map([...groups.keys()].map((key, index) => [key, elements.find(element => element.id === `architecture-group-${index}`)! as ShapeElement]))
    const resolve = (key: string, group: boolean | undefined) => group ? groupNodes.get(boxes.get(key)!.group!)! : nodes.get(key) ?? groupNodes.get(key)!
    const reverse = link.op === '<--', a = resolve(reverse ? link.b : link.a, reverse ? link.toGroup : link.fromGroup), b = resolve(reverse ? link.a : link.b, reverse ? link.fromGroup : link.toGroup)
    // Explicit unbound endpoints preserve the requested L/R/T/B ports exactly.
    elements.push(diagramEdge(`architecture-edge-${i}`, port(a, reverse ? link.toPort : link.fromPort), port(b, reverse ? link.fromPort : link.toPort), link.label, { arrow: link.op === '--' ? 'none' : link.op === '<-->' ? 'both' : 'end', route: 'orthogonal' }))
  })
  mapStructureSources(sources, boxes, nodes, elements, links, 'architecture', groups)
  return finishDiagram('architecture', elements, ['架构图标使用本地基础图形与图标名称，不下载远程 logos；端口连接保留精确 L/R/T/B 坐标，转换为画布后为自由端点。'], sources)
}
export function compileStructureDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source), header = lines[0]?.text.trim() ?? ''
  const kind = header.split(/\s/)[0]
  if (!['classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'gitGraph', 'gitGraph:', 'requirementDiagram', 'C4Context', 'C4Container', 'C4Component', 'architecture-beta'].includes(kind!)) return undefined
  if (lines.length > 1200) fail('此类图表最多支持 1,200 行有效语句。', lines[1200]!.line)
  if (kind === 'gitGraph' || kind === 'gitGraph:') return compileGit(lines)
  if (header !== kind) fail('图表标题后不支持额外参数，请把指令另起一行。', lines[0]!.line)
  if (kind === 'classDiagram') return compileClass(lines)
  if (kind === 'stateDiagram' || kind === 'stateDiagram-v2') return compileState(lines)
  if (kind === 'erDiagram') return compileER(lines)
  if (kind === 'requirementDiagram') return compileRequirement(lines)
  if (kind === 'C4Context' || kind === 'C4Container' || kind === 'C4Component') return compileC4(lines)
  return compileArchitecture(lines)
}
export const STRUCTURAL_TEMPLATES: DiagramTemplate[] = [
  { kind: 'class', id: 'class-order-domain', title: '订单领域与支付扩展', description: '嵌套命名空间、属性方法、接口、枚举、组合、依赖与注释', category: '软件建模', source: `classDiagram
%% 订单域内保存业务数据；支付域通过接口提供可替换实现。
direction LR
namespace Commerce["订单领域"] {
  class Customer["客户"] {
    +String id
    +String name
    +placeOrder() Order
  }
  class Address["收货地址"] { +String city; +String detail }
  namespace Trading["交易聚合"] {
    class Order["订单"] {
      +String id
      -Decimal total
      +pay() bool
      +cancel() void
    }
    class LineItem["订单明细"] { +String product; +int quantity }
    class OrderStatus["订单状态"] {
      <<enumeration>>
      PENDING
      PAID
      CANCELLED
    }
    class Shipment["配送单"] { +String tracking; +dispatch() void }
  }
}
namespace Payments["支付领域"] {
  class Payment { <<interface>>; +pay(amount) bool }
  class CardPayment { -String token; +pay(amount) bool }
  class CashPayment { +pay(amount) bool }
}
class OrderRepository { <<abstract>>; #load(id) Order; +save(order) void }
Customer "1" --> "*" Order : 下单
Customer "1" o-- "1..*" Address : 保存地址
Order "1" *-- "1..*" LineItem : 拥有明细
Order --> OrderStatus : 当前状态
Order "1" --> "0..1" Shipment : 支付后配送
Order ..> Payment : 调用支付
Payment <|.. CardPayment : 实现
Payment <|.. CashPayment : 实现
Order ..> OrderRepository : 存取订单
note for Order "订单拥有明细的生命周期；取消后仍保留审计信息。"
note "虚线表示依赖，空心三角表示接口实现。"` },
  { kind: 'state', id: 'state-order-lifecycle', title: '订单履约复合状态机', description: '嵌套复合状态、局部起终点、选择、重试与多行注释', category: '软件建模', source: `stateDiagram-v2
%% 支付与履约各自封装内部状态；外层描述订单生命周期。
direction LR
state "待支付" as Pending
state "支付处理" as Payment {
  direction TB
  [*] --> Paying
  state "请求支付" as Paying
  state Decision <<choice>>
  state "核验通过" as Paid
  Paying --> Decision : 收到支付结果
  Decision --> Paid : 已支付
  Decision --> Paying : 暂时失败 / 重试
  Paid --> [*]
}
state "履约处理中" as Fulfillment {
  direction LR
  [*] --> Preparing
  state "准备发货" as Preparing
  state "配送过程" as Delivery {
    direction TB
    [*] --> Shipping
    state "运输中" as Shipping
    state "客户签收" as Received
    Shipping --> Received : 确认收货
    Received --> [*]
  }
  Preparing --> Delivery : 打包完成
  Delivery --> [*]
}
state "已完成" as Done
state "已取消" as Cancelled
[*] --> Pending
Pending --> Payment : 确认支付
Pending --> Cancelled : 超时或主动取消
Payment --> Fulfillment : 支付成功
Fulfillment --> Done : 履约完成
Done --> [*]
Cancelled --> [*]
note right of Payment
支付回调必须保持幂等。
临时失败可以在内部重试。
end note
note left of Cancelled : 未支付订单才允许直接取消。` },
  { kind: 'er', id: 'er-commerce', title: '电商订单与库存模型', description: '实体别名、复合主外键、唯一键、说明及识别/非识别关系', category: '数据建模', source: `erDiagram
%% 明细与库存使用复合键；付款和配送允许尚未产生。
direction LR
CUSTOMER["客户"] {
  string id PK
  string name "姓名"
  string email UK
}
ORDER["订单"] {
  string id PK
  string customer_id FK
  decimal(12) total "应付金额"
}
ORDER_ITEM["订单明细"] {
  string order_id PK, FK
  string product_id PK, FK
  int quantity
}
PRODUCT["商品"] {
  string id PK
  string sku UK
  string name
  decimal price
}
PAYMENT["付款记录"] {
  string id PK
  string order_id FK, UK
  string status
}
SHIPMENT["配送记录"] {
  string id PK
  string order_id FK
  string tracking UK
}
WAREHOUSE["仓库"] {
  string id PK
  string address
}
STOCK["库存"] {
  string warehouse_id PK, FK
  string product_id PK, FK
  int available "可售数量"
}
SUPPLIER["供应商"] {
  string id PK
  string name
}
CUSTOMER ||--o{ ORDER : 创建
ORDER ||--|{ ORDER_ITEM : 包含
PRODUCT ||..o{ ORDER_ITEM : 被购买
ORDER ||..o| PAYMENT : 可产生付款
ORDER ||..o{ SHIPMENT : 可分批配送
WAREHOUSE ||--o{ STOCK : 管理
PRODUCT ||--o{ STOCK : 存放
SUPPLIER }o..o{ PRODUCT : 供应` },
  { kind: 'gitgraph', id: 'git-feature-release', title: '分支开发与版本发布', description: '分支排序、切换、双亲合并、标签与普通/重点/回退提交', category: '软件建模', source: `gitGraph LR:
%% develop 集成日常开发；功能分支合并后再发布到 main。
commit id: "init" tag: "起点"
branch develop order: 1
commit id: "setup" type: NORMAL
branch feature order: 3
commit id: "feature-ui" type: HIGHLIGHT
commit id: "feature-test"
checkout develop
branch security order: 2
commit id: "access-check"
switch develop
merge security id: "merge-security"
commit id: "fix"
merge feature id: "merge-feature" type: HIGHLIGHT
checkout main
merge develop id: "release" tag: "v1.0"
commit id: "revert" type: REVERSE
commit id: "stabilize" tag: "v1.0.1"` },
  { kind: 'requirement', id: 'requirement-account', title: '账户需求分解与验证', description: '需求风险、验证方式、分解、派生、跟踪及测试追踪', category: '软件建模', source: `requirementDiagram
%% 从顶层能力分解功能，再由实现与测试提供可追踪证据。
direction LR
requirement account {
  id: R-1
  text: 系统应提供完整的账户管理能力
  risk: high
  verifymethod: inspection
}
functionalRequirement login {
  id: R-1.1
  text: 用户可通过邮箱和密码登录
  risk: medium
  verifymethod: test
}
functionalRequirement registration {
  id: R-1.2
  text: 用户可以注册并验证邮箱
  risk: medium
  verifymethod: demonstration
}
functionalRequirement recovery {
  id: R-1.3
  text: 用户可通过受控验证流程找回账户
  risk: high
  verifymethod: test
}
interfaceRequirement email {
  id: R-2
  text: 邮件通知接口需要返回可追踪的发送编号
  risk: low
  verifymethod: analysis
}
element service {
  type: account implementation
  docref: modules/account
}
element test_suite {
  type: automated test
  docref: tests/account
}
element acceptance {
  type: acceptance record
  docref: acceptance/account
}
account - contains -> login
account - contains -> registration
account - contains -> recovery
recovery - derives -> email
service - satisfies -> login
test_suite - verifies -> login
registration <- verifies - acceptance
recovery - traces -> account` },
  { kind: 'c4', id: 'c4-shop-context', title: '商城系统与外部参与方', description: '人物、外部人物、系统、数据库、队列、嵌套边界及双向关系', category: '系统架构', source: `C4Context
%% 系统上下文描述职责与依赖，不展开内部实现。
title 商城业务协作上下文
Person(customer, "顾客", "浏览商品并下单")
Person(admin, "运营人员", "维护商品与处理订单")
Person_Ext(carrier, "配送人员", "交付包裹并回传签收结果")
Enterprise_Boundary(company, "业务组织") {
  System_Boundary(shop, "商城边界") {
    System(web, "商城系统", "提供商品、购物车和订单服务")
    SystemDb(database, "业务数据库", "存储订单与商品")
    SystemQueue(events, "业务事件队列", "异步传递支付及发货事件")
  }
  System(operations, "履约系统", "协调仓库与物流")
}
System_Ext(payment, "支付平台", "处理第三方支付")
SystemDb_Ext(catalog, "外部商品目录", "同步供应商品资料")
SystemQueue_Ext(notices, "外部通知通道", "投递客户通知")
Rel(customer, web, "浏览、下单", "HTTPS")
Rel(admin, web, "管理商品")
Rel(web, database, "读写数据")
Rel(web, events, "发布订单事件")
Rel(events, operations, "驱动履约")
BiRel(web, payment, "支付与回调", "HTTPS")
Rel_Back(operations, carrier, "回传签收结果")
Rel(catalog, web, "同步商品资料")
Rel(operations, notices, "通知发货")` },
  { kind: 'architecture', id: 'architecture-services', title: '服务分层与边界通信', description: '嵌套分组、连接点、精确端口、分组端口与带标签连接', category: '系统架构', source: `architecture-beta
%% 边界端口表达跨服务域通信；连接点聚合请求分流。
group platform(cloud)[业务平台]
group api(cloud)[应用服务] in platform
group data(database)[数据服务] in platform
group outside(cloud)[外部服务]
service frontend(server)[前端应用] in api
service gateway(server)[请求入口] in api
junction route in api
service backend(server)[订单服务] in api
service auth(server)[身份认证] in api
service storage(database)[业务数据] in data
service cache(disk)[缓存服务] in data
service audit(server)[审计任务] in data
service payment(server)[支付接口] in outside
frontend:B --> T:gateway : HTTPS 请求
gateway:B -- T:route
route:L --> T:backend : 下单
route:R --> T:auth : 鉴权
backend{group}:L --> L:storage{group} : 跨域数据访问
backend:B --> T:storage : 读写订单
backend:R <--> L:cache : 查询与回填
storage:B --> T:audit : 审计数据
platform:B --> T:payment{group} : 支付请求` },
  { kind: 'class', id: 'class-content-platform', title: '内容平台继承与协作', description: '抽象类、接口、双向关联、聚合、反向关系及成员补充', category: '软件建模', source: `classDiagram
%% 用继承复用内容结构，以接口隔离审核和通知策略。
direction TB
namespace Content["内容模型"] {
  class ContentItem { <<abstract>>; +String id; #String body; +publish() bool }
  class Article { +String headline; +render() String }
  class Video { +int duration; +transcode() void }
  class Revision { +int number; +String reason }
  class Author { +String name; +edit(item) void }
  class Collection { +String title; +add(item) void }
}
namespace Review["审核与通知"] {
  class Reviewer { <<interface>>; +review(item) bool }
  class HumanReviewer { +String reviewerId; +review(item) bool }
  class AuditLog { +String actor; +String action }
  class Notification { +send(message) void }
}
ContentItem <|-- Article : 文本内容
Video --|> ContentItem : 视频内容
ContentItem "1" --* "1..*" Revision : 修订归属于内容
Collection "1" o-- "*" ContentItem : 汇集内容
Author "*" <--> "*" ContentItem : 创作与协作
HumanReviewer ..|> Reviewer : 实现审核
ContentItem ..> Reviewer : 发布前校验
AuditLog <-- HumanReviewer : 记录审核
HumanReviewer <..> Notification : 异步协作
ContentItem -- AuditLog : 保留轨迹
Author .. Notification : 消息订阅
Article : +estimateReadTime() int
<<service>> Notification
note for Collection "聚合关系允许内容从集合移除后继续存在。"
note for Reviewer "调用方仅依赖审核接口，便于替换实现。"` },
  { kind: 'state', id: 'state-approval-parallel', title: '并行审核与异常恢复', description: 'fork/join 分流汇合、条件状态、描述、取消及纵向布局', category: '软件建模', source: `stateDiagram-v2
%% 分流启动两项审核；汇合后统一判断结果并决定发布。
direction TB
state "等待提交" as Draft
state Fork <<fork>>
state "内容审核" as ContentReview
state "合规审核" as ComplianceReview
state Join <<join>>
state Decision <<choice>>
state "等待修订" as Revision
state "准备发布" as Ready
state "已发布" as Published
state "已撤回" as Withdrawn
Draft : 保存草稿不触发审核
Ready : 发布前确认资源与时间
[*] --> Draft
Draft --> Fork : 提交申请
Fork --> ContentReview : 内容检查
Fork --> ComplianceReview : 合规检查
ContentReview --> Join : 内容结果就绪
ComplianceReview --> Join : 合规结果就绪
Join --> Decision : 两项审核均完成
Decision --> Ready : 全部通过
Decision --> Revision : 需要修改
Revision --> Draft : 完成修订
Ready --> Published : 确认发布
Ready --> Withdrawn : 主动撤回
Published --> [*]
Withdrawn --> [*]
note right of Join : 汇合点等待两项独立检查，不代表任一完成即可继续。` },
  { kind: 'er', id: 'er-library-circulation', title: '图书馆借阅与预约模型', description: '可选一对一、多对多、反向基数、实体别名与复合键', category: '数据建模', source: `erDiagram
%% 书目与实体册分离；借阅和预约保存各自的业务历史。
direction TB
READER["读者"] {
  string id PK
  string card_no UK
  string name
}
PROFILE["读者扩展资料"] {
  string reader_id PK, FK
  string address
}
BOOK["书目"] {
  string isbn PK
  string title
}
COPY["实体册"] {
  string barcode PK
  string isbn FK
  string status
}
LOAN["借阅记录"] {
  string id PK
  string reader_id FK
  string barcode FK
  date due_date "应还日期"
}
RESERVATION["预约记录"] {
  string reader_id PK, FK
  string isbn PK, FK
  datetime requested_at
}
AUTHOR["作者"] {
  string id PK
  string name
}
AUTHORSHIP["作品署名"] {
  string isbn PK, FK
  string author_id PK, FK
  int position
}
BRANCH["馆藏地点"] {
  string id PK
  string name
}
READER ||..o| PROFILE : 可补充资料
BOOK ||--|{ COPY : 拥有实体册
READER ||..o{ LOAN : 发起借阅
COPY ||..o{ LOAN : 历次借出
READER ||--o{ RESERVATION : 提交预约
BOOK ||--o{ RESERVATION : 被预约
BOOK ||--|{ AUTHORSHIP : 包含署名
AUTHOR ||..o{ AUTHORSHIP : 创作作品
COPY }|..|| BRANCH : 存放于
PROFILE |o..|| READER : 归属于` },
  { kind: 'gitgraph', id: 'git-hotfix-backport', title: '热修复与跨分支摘取', description: '纵向时间轴、普通摘取、合并提交指定父节点与版本回补', category: '软件建模', source: `gitGraph TB:
%% 稳定分支只接收必要修复；开发分支继续推进独立功能。
commit id: "base" tag: "v2.0"
branch stable order: 1
commit id: "stable-config"
checkout main
branch next order: 3
commit id: "new-api"
branch fix order: 2
commit id: "security-fix" type: HIGHLIGHT
checkout next
commit id: "docs"
merge fix id: "integrated-fix"
checkout stable
cherry-pick id: "security-fix" tag: "v2.0.1"
commit id: "compatibility-test"
cherry-pick id: "integrated-fix" parent: "docs" tag: "v2.0.2"
checkout main
merge next id: "next-release" tag: "v2.1"
commit id: "rollback-metrics" type: REVERSE` },
  { kind: 'requirement', id: 'requirement-device-release', title: '设备发布约束与证据链', description: '七类节点、三档风险、四种验证方式与全部关系语义', category: '软件建模', source: `requirementDiagram
%% 非功能约束与功能需求共同形成发布门槛，测试证据可反向追踪。
direction TB
requirement release {
  id: REL-1
  text: 设备应满足量产发布准入条件
  risk: high
  verifymethod: inspection
}
functionalRequirement telemetry {
  id: FUN-1
  text: 设备应定期上报有效遥测数据
  risk: medium
  verifymethod: demonstration
}
interfaceRequirement protocol {
  id: INT-1
  text: 通信接口应遵循已批准的数据契约
  risk: medium
  verifymethod: test
}
performanceRequirement latency {
  id: PERF-1
  text: 正常网络条件下端到端响应不超过目标时限
  risk: high
  verifymethod: analysis
}
physicalRequirement enclosure {
  id: PHY-1
  text: 外壳应满足已定义的尺寸和环境要求
  risk: low
  verifymethod: inspection
}
designConstraint encryption {
  id: DES-1
  text: 传输数据必须采用批准的加密机制
  risk: high
  verifymethod: test
}
requirement inherited {
  id: BASE-1
  text: 复用已批准的产品线基础约束
  risk: low
  verifymethod: analysis
}
element firmware {
  type: device implementation
  docref: design/firmware
}
element lab_report {
  type: qualification report
  docref: verification/release
}
release - contains -> telemetry
release - contains -> enclosure
telemetry - derives -> protocol
latency - refines -> release
encryption - traces -> protocol
inherited - copies -> release
firmware - satisfies -> telemetry
lab_report - verifies -> latency
protocol <- verifies - lab_report` },
  { kind: 'c4', id: 'c4-container-platform', title: '业务平台容器协作', description: '容器、数据容器、消息容器、外部依赖、边界及方向提示', category: '系统架构', source: `C4Container
%% 以可部署单元为边界，技术字段说明其职责所依赖的协议或运行形式。
title 业务平台容器协作图
Person(user, "业务用户", "提交业务请求并查看处理状态")
System_Boundary(platform, "业务平台") {
  Container(web, "操作界面", "HTML / CSS", "提供任务处理入口")
  Container(api, "业务接口", "HTTP", "校验请求并协调业务")
  Container(worker, "后台任务", "异步任务", "处理耗时操作")
  ContainerDb(data, "业务数据", "SQL", "保存业务状态")
  ContainerQueue(queue, "任务通道", "事件协议", "缓冲待处理任务")
  Container(cache, "查询缓存", "键值访问", "降低高频读取成本")
}
System_Ext(identity, "统一身份服务", "提供身份核验")
Container_Ext(callback, "合作方回调入口", "HTTPS", "接收处理结果")
Rel(user, web, "执行任务")
Rel_D(web, api, "提交请求", "HTTPS")
Rel_R(api, identity, "校验令牌")
BiRel(api, cache, "读取与回填")
Rel(api, queue, "发布任务")
Rel(queue, worker, "分发任务")
Rel(worker, data, "更新状态", "SQL")
Rel(worker, callback, "通知结果")
Rel_U(data, api, "查询结果")` },
  { kind: 'architecture', id: 'architecture-resilient-routing', title: '双区域接入与数据汇聚', description: '分流/汇聚连接点、四向端口、直接分组端口与反向箭头', category: '系统架构', source: `architecture-beta
%% 接入层把请求分发到两个服务区；数据变更汇聚到共享存储。
group ingress(cloud)[接入层]
group primary(cloud)[主服务区]
group secondary(cloud)[备用服务区]
group shared(database)[共享数据层]
service public(cloud)[公共入口] in ingress
junction split in ingress
service primary_api(server)[主业务接口] in primary
service primary_jobs(server)[主任务处理] in primary
service standby_api(server)[备用接口] in secondary
service standby_jobs(server)[备用任务] in secondary
junction converge in shared
service db(database)[共享数据库] in shared
service archive(disk)[归档存储] in shared
service monitor(server)[健康监控]
public:B --> T:split : 分配请求
split:L --> T:primary_api : 主路径
split:B --> T:standby_api : 降级路径
primary_api:B -- T:primary_jobs
standby_api:B -- T:standby_jobs
primary_jobs:R --> L:converge : 写入结果
standby_jobs:R --> L:converge : 备用写入
converge:B --> T:db
db:B --> T:archive : 定期归档
monitor:B <-- T:primary_api : 上报健康
monitor:R <-- T:standby_api : 上报健康
ingress:R <--> L:shared : 运维控制面` },
  { kind: 'c4', id: 'c4-component-order', title: '订单接口组件分工', description: '组件、组件边界、数据组件、外部组件与服务契约', category: '系统架构', source: `C4Component
%% 将一个业务接口拆分为接入、应用逻辑与基础设施组件。
title 订单接口内部组件图
Container(client, "业务客户端", "HTTP", "提交订单并查询状态")
Container_Boundary(api, "订单接口") {
  Component(controller, "请求控制器", "HTTP handler", "校验输入并转发命令")
  Component(application, "订单应用服务", "应用逻辑", "协调订单创建与支付")
  Boundary(domain, "订单领域") {
    Component(order, "订单规则", "领域逻辑", "维护订单不变量")
    Component(pricing, "计价策略", "策略接口", "计算金额与优惠")
  }
  ComponentDb(repository, "订单仓储", "SQL access", "保存与恢复订单状态")
  ComponentQueue(events, "事件发布器", "事件协议", "发布订单状态变化")
}
Component_Ext(payment, "支付适配器", "HTTPS", "连接外部支付能力")
ContainerDb(database, "业务数据库", "SQL", "保存订单数据")
Rel(client, controller, "提交请求")
Rel(controller, application, "执行命令")
Rel(application, order, "创建订单")
Rel(order, pricing, "计算应付金额")
Rel(application, repository, "持久化")
Rel(repository, database, "读写")
Rel_L(application, payment, "发起支付")
Rel(application, events, "发布结果")` },
]
