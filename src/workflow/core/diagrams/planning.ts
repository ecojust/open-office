import type { ElementStyle, SceneElement, ShapeElement } from '../types.ts'
import {
  DiagramSyntaxError, DiagramSourceMap, diagramEdge, diagramNode, diagramStroke, diagramText, finishDiagram, sourceLines,
  type DiagramResult, type DiagramTemplate, type SourceLine,
} from './common.ts'

const COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#cffafe']
const INKS = ['#2563eb', '#15803d', '#b45309', '#be185d', '#7c3aed', '#0e7490']
const ID = '[\\p{L}\\p{N}_-]+'
function fail(message: string, line: number): never { throw new DiagramSyntaxError(message, line) }

function content(line: SourceLine): string {
  let quote = ''; let escaped = false
  for (let index = 0; index < line.text.length; index++) {
    const char = line.text[index]!
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(line.text[index - 1] ?? ''))) { quote = char; continue }
    if (line.text.slice(index, index + 3) === '%%{') return line.text
    if (line.text.slice(index, index + 2) === '%%') {
      const parsed = line.text.slice(0, index).trimEnd()
      line.end = line.start + parsed.length
      return parsed
    }
  }
  return line.text
}

function label(value: string, line: number): string {
  let result = value.trim()
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  } else if (/^["']/.test(result)) fail('标签的引号必须成对。', line)
  result = result.replace(/<br\s*\/?\s*>/gi, '\n').replace(/\\n/g, '\n')
  if (!result.trim()) fail('标签不能为空。', line)
  if (result.length > 2000) fail('单个标签不能超过 2,000 个字符。', line)
  if (result.startsWith('`') || result.endsWith('`')) fail('暂不支持 Markdown 标签，请使用普通文本及 <br> 换行。', line)
  return result
}

function splitQuoted(value: string, separator: string, line: number): string[] {
  const parts: string[] = []; let current = ''; let quote = ''; let escaped = false
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\') { current += char; escaped = true; continue }
    if (quote) { current += char; if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(current.at(-1) ?? ''))) { quote = char; current += char; continue }
    if (char === separator) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (quote) fail('引号没有闭合。', line)
  parts.push(current.trim()); return parts
}

function indent(line: SourceLine): number {
  if (/^[ \t]*\t/.test(line.text)) fail('缩进请使用空格，暂不支持制表符。', line.line)
  return line.text.length - line.text.trimStart().length
}

function rejectDirective(text: string, line: number): void {
  if (/^(?:%%\{|---$|::|classDef\b|class\s|style\s|click\s|linkStyle\b|direction\b|accTitle\b|accDescr\b)/.test(text)) {
    fail('暂不支持此配置或样式指令；请使用图表的数据语法。', line)
  }
}

function textHeight(text: string, width: number, minimum = 56): number {
  const chars = Math.max(6, Math.floor((width - 28) / 15))
  return Math.max(minimum, text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / chars)), 0) * 21 + 24)
}

function safeColor(value: string, line: number): string {
  const color = value.trim()
  if (!/^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|none|transparent|black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|navy|teal|cyan)$/i.test(color)) fail('颜色需要十六进制色值或支持的基础颜色名。', line)
  return color
}
function safeStyle(value: string, line: number): Partial<ElementStyle> {
  const style: Partial<ElementStyle> = {}, used = new Set<string>()
  for (const field of splitQuoted(value.replace(/;$/, ''), ',', line)) {
    const parts = splitQuoted(field, ':', line), key = parts[0], raw = parts[1]
    if (parts.length !== 2 || !key || raw === undefined || used.has(key)) fail('样式属性需要唯一的「属性: 值」。', line)
    used.add(key)
    if (key === 'fill' || key === 'stroke') style[key] = safeColor(raw, line)
    else if (key === 'stroke-width') { const width = Number(raw.replace(/px$/, '')); if (!/^\d+(?:\.\d+)?(?:px)?$/.test(raw) || width > 12) fail('stroke-width 需要 0 到 12 的数值。', line); style.strokeWidth = width }
    else if (key === 'opacity') { const opacity = Number(raw); if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(raw) || opacity < 0 || opacity > 1) fail('opacity 需要 0 到 1 的数值。', line); style.opacity = opacity }
    else if (key === 'stroke-dasharray') { if (!['solid', 'dashed', 'dotted'].includes(raw)) fail('stroke-dasharray 仅支持 solid、dashed、dotted。', line); style.strokePattern = raw as ElementStyle['strokePattern']; style.dashed = raw !== 'solid' }
    else fail(`暂不支持样式属性「${key}」，可使用 fill、stroke、stroke-width、opacity、stroke-dasharray。`, line)
  }
  return style
}
class PlanningStyles {
  private definitions = new Map<string, { style: Partial<ElementStyle>; line: number }>()
  private rules: { ids: string[]; className?: string; style?: Partial<ElementStyle>; line: number }[] = []
  private inline: { node: ShapeElement; className: string; line: number }[] = []
  read(raw: string, line: number): boolean {
    let match = raw.match(new RegExp(`^classDef\\s+(${ID})\\s+(.+)$`, 'u'))
    if (match) { if (this.definitions.has(match[1]!)) fail(`样式类「${match[1]}」重复。`, line); this.definitions.set(match[1]!, { style: safeStyle(match[2]!, line), line }); return true }
    match = raw.match(new RegExp(`^class\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s+(${ID})$`, 'u'))
    if (match) { this.rules.push({ ids: match[1]!.split(',').map(id => id.trim()), className: match[2]!, line }); return true }
    match = raw.match(new RegExp(`^style\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s+(.+)$`, 'u'))
    if (match) { this.rules.push({ ids: match[1]!.split(',').map(id => id.trim()), style: safeStyle(match[2]!, line), line }); return true }
    if (/^(?:style|class|classDef)\b/.test(raw)) fail('样式指令格式无效。', line)
    return false
  }
  attach(node: ShapeElement, data: Descriptor, line: number): void { if (data.className) this.inline.push({ node, className: data.className, line }) }
  apply(nodes: Map<string, ShapeElement>, sources: DiagramSourceMap): void {
    const use = (node: ShapeElement, className: string, line: number): void => {
      const definition = this.definitions.get(className)
      if (!definition) fail(`样式类「${className}」尚未定义。`, line)
      Object.assign(node.style, definition.style); sources.add(definition.line, node.id)
    }
    for (const item of this.inline) use(item.node, item.className, item.line)
    for (const rule of this.rules) for (const id of rule.ids) {
      const node = nodes.get(id); if (!node) fail(`样式引用了未声明的节点「${id}」。`, rule.line)
      if (rule.className) use(node, rule.className, rule.line)
      else Object.assign(node.style, rule.style)
      sources.add(rule.line, node.id)
    }
  }
}

interface Descriptor { explicit?: string; text: string; shape: ShapeElement['shape']; approximate?: boolean; className?: string; subroutine?: boolean }
function descriptor(value: string, line: number, bare = true): Descriptor {
  const decorated = value.match(/:::([\p{L}\p{N}_-]+)$/u), className = decorated?.[1]
  if (decorated) value = value.slice(0, decorated.index)
  const forms: [RegExp, ShapeElement['shape']][] = [
    [new RegExp(`^(${ID})?\\(\\((.*)\\)\\)$`, 'u'), 'ellipse'],
    [new RegExp(`^(${ID})?\\{\\{(.*)\\}\\}$`, 'u'), 'hexagon'],
    [new RegExp(`^(${ID})?\\[\\((.*)\\)\\]$`, 'u'), 'cylinder'],
    [new RegExp(`^(${ID})?\\[\\[(.*)\\]\\]$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\(\\[(.*)\\]\\)$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\[/(.*)/\\]$`, 'u'), 'parallelogram'],
    [new RegExp(`^(${ID})?\\[(.*)\\]$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\((.*)\\)$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\{(.*)\\}$`, 'u'), 'diamond'],
    [new RegExp(`^(${ID})?\\)([^()]*)\\($`, 'u'), 'cloud'],
  ]
  for (const [pattern, shape] of forms) {
    const match = value.match(pattern)
    if (match) {
      const inner = match[2]!.trim()
      if (!/^["']/.test(inner)) {
        const stack: string[] = []; const pairs: Record<string, string> = { ']': '[', ')': '(', '}': '{' }
        for (const char of inner) {
          if ('[({'.includes(char)) stack.push(char)
          else if ('])}'.includes(char) && stack.pop() !== pairs[char]) fail('节点括号未匹配；包含特殊括号的标签可以加引号。', line)
        }
        if (stack.length) fail('节点括号未闭合。', line)
      }
      return { explicit: match[1], text: label(inner, line), shape, className, approximate: /\(\[/.test(value), subroutine: /\[\[/.test(value) }
    }
  }
  if (!bare || /[\[\](){}]|:::|::icon/.test(value)) fail('节点语法不受支持或括号未闭合。', line)
  return { text: label(value, line), shape: 'rectangle', className }
}

function subroutineLines(node: ShapeElement, data: Descriptor): SceneElement[] {
  if (!data.subroutine) return []
  node.groupId ??= `planning-node:${node.id}`
  return [10, node.width - 10].map((offset, index) => ({ ...diagramStroke(`${node.id}:side:${index}`, [{ x: node.x + offset, y: node.y }, { x: node.x + offset, y: node.y + node.height }], node.style), groupId: node.groupId }))
}
interface TreeNode extends Descriptor { id: string; line: number; indent: number; children: TreeNode[]; weight: number; width: number; height: number; x: number; y: number; color: number; icon?: { name: string; line: number } }
function mindmap(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const styles = new PlanningStyles()
  const nodes: TreeNode[] = []; const stack: TreeNode[] = []; const explicit = new Set<string>(); const warnings: string[] = []
  for (const entry of lines.slice(1)) {
    const raw = content(entry); if (!raw.trim()) continue
    if (styles.read(raw.trim(), entry.line)) continue
    const icon = raw.trim().match(/^::icon\(([^()]*)\)$/)
    if (icon) {
      const node = nodes.at(-1)
      if (!node || node.icon) fail('图标需要紧随一个尚未设置图标的节点。', entry.line)
      if (!['check', 'star', 'circle', 'square', 'diamond', 'cloud'].includes(icon[1]!)) fail('内置图标仅支持 check、star、circle、square、diamond、cloud。', entry.line)
      node.icon = { name: icon[1]!, line: entry.line }; continue
    }
    rejectDirective(raw.trim(), entry.line)
    const level = indent(entry); const data = descriptor(raw.trim(), entry.line)
    if (data.explicit && explicit.has(data.explicit)) fail(`节点 ID「${data.explicit}」重复。`, entry.line)
    if (data.explicit) explicit.add(data.explicit)
    const height = textHeight(data.text, 190)
    const node: TreeNode = { ...data, id: `mindmap-${nodes.length}`, line: entry.line, indent: level, children: [], weight: height + 30, width: 190, height, x: 0, y: 0, color: 0 }
    if (!nodes.length) stack.push(node)
    else {
      if (level <= nodes[0]!.indent) fail('思维导图只能有一个根节点；子节点需要增加缩进。', entry.line)
      if (level <= stack[stack.length - 1]!.indent && !stack.some(parent => parent.indent === level)) fail('减少缩进时必须对齐已有层级。', entry.line)
      while (stack.length && stack[stack.length - 1]!.indent >= level) stack.pop()
      stack[stack.length - 1]!.children.push(node); stack.push(node)
    }
    if (stack.length > 20) fail('思维导图最多支持 20 层。', entry.line)
    sources.add(entry.line, node.id)
    nodes.push(node)
    if (nodes.length > 200) fail('思维导图最多支持 200 个节点。', entry.line)
    if (data.approximate) warnings.push('体育场形节点显示为矩形，标签及树关系保留。')
  }
  if (!nodes.length) fail('思维导图需要一个根节点。', lines[0]!.line)
  const root = nodes[0]!
  function measure(node: TreeNode): number { node.weight = Math.max(node.height + 30, node.children.reduce((sum, child) => sum + measure(child), 0)); return node.weight }
  measure(root)
  const left: TreeNode[] = []; const right: TreeNode[] = []; let leftWeight = 0; let rightWeight = 0
  root.children.forEach((child, index) => { child.color = index % COLORS.length; if (rightWeight <= leftWeight) { right.push(child); rightWeight += child.weight } else { left.push(child); leftWeight += child.weight } })
  const depth = (node: TreeNode): number => 1 + Math.max(0, ...node.children.map(depth))
  const leftDepth = Math.max(0, ...left.map(depth)); const centerX = 80 + leftDepth * 260 + root.width / 2
  const centerY = 100 + Math.max(root.height, leftWeight, rightWeight) / 2
  root.x = centerX - root.width / 2; root.y = centerY - root.height / 2
  function layout(children: TreeNode[], xDepth: number, side: number, center: number, color?: number): void {
    let cursor = center - children.reduce((sum, child) => sum + child.weight, 0) / 2
    for (const node of children) {
      node.color = color ?? node.color; node.x = centerX + side * xDepth * 260 - node.width / 2; node.y = cursor + node.weight / 2 - node.height / 2
      layout(node.children, xDepth + 1, side, cursor + node.weight / 2, node.color); cursor += node.weight
    }
  }
  layout(left, 1, -1, centerY); layout(right, 1, 1, centerY)
  const elements: SceneElement[] = []
  for (const node of nodes) for (const child of node.children) elements.push(diagramEdge(`mindmap-edge-${child.id}`, { x: node.x + node.width / 2, y: node.y + node.height / 2, nodeId: node.id }, { x: child.x + child.width / 2, y: child.y + child.height / 2, nodeId: child.id }, '', { arrow: 'none', route: 'orthogonal', style: { stroke: INKS[child.color]! } }))
  const declared = new Map<string, ShapeElement>(), rendered = new Map<string, ShapeElement>()
  for (const node of nodes) {
    const shape = diagramNode(node.id, node.text, node.x, node.y, node.width, node.height, node.shape, { fill: node === root ? '#1e3a8a' : COLORS[node.color]!, stroke: node === root ? '#ffffff' : INKS[node.color]!, strokeWidth: node === root ? 0 : 2, fontSize: node === root ? 20 : 16 })
    elements.push(shape); rendered.set(node.id, shape); styles.attach(shape, node, node.line)
    if (node.explicit) declared.set(node.explicit, shape)
  }
  styles.apply(declared, sources)
  for (const node of nodes) {
    const shape = rendered.get(node.id)!, first = elements.length
    elements.push(...subroutineLines(shape, node))
    if (node.icon) {
      const id = `${node.id}-icon`, x = node.x + node.width - 28, y = node.y - 12
      if (node.icon.name === 'check') { elements.push(diagramNode(id, '', x, y, 26, 26, 'ellipse', { fill: '#ffffff', stroke: INKS[node.color]!, strokeWidth: 1 })); elements.push(diagramStroke(`${id}-mark`, [{ x: x + 6, y: y + 13 }, { x: x + 11, y: y + 18 }, { x: x + 21, y: y + 7 }], { stroke: INKS[node.color]!, strokeWidth: 2 })) }
      else elements.push(diagramNode(id, '', x, y, 26, 26, node.icon.name === 'circle' ? 'ellipse' : node.icon.name === 'square' ? 'rectangle' : node.icon.name as ShapeElement['shape'], { fill: '#ffffff', stroke: INKS[node.color]!, strokeWidth: 2 }))
      sources.add(node.icon.line, shape.id, id, `${id}-mark`)
      shape.groupId ??= `planning-node:${node.id}`
      for (const decoration of elements.slice(first)) decoration.groupId = shape.groupId
    }
    sources.capture(node.line, elements, first)
  }
  return finishDiagram('mindmap', elements, warnings, sources)
}

interface Period { text: string; events: string[]; eventLines: number[]; section: string; group: number; line: number }
function timeline(lines: SourceLine[], vertical: boolean): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const periods: Period[] = []; let title = ''; let section = ''; let group = 0; let current: Period | undefined; let sectionUsed = true
  let directionSet = /\s(?:LR|TD)$/.test(lines[0]!.text.trim())
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue
    if (/^direction\b/.test(raw)) {
      const match = raw.match(/^direction\s+(LR|TD)$/)
      if (!match || directionSet || periods.length || section) fail('时间轴 direction 在数据之前设置一次，取 LR 或 TD；不能与标题行方向重复。', entry.line)
      vertical = match[1] === 'TD'; directionSet = true; continue
    }
    rejectDirective(raw, entry.line)
    if (/^title\s+/.test(raw)) { if (title || periods.length || section) fail('标题只能在时间轴数据之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'timeline-title'); continue }
    if (/^section\s+/.test(raw)) { if (!sectionUsed) fail('上一个 section 没有时间段。', entry.line); section = label(raw.slice(8), entry.line); sources.add(entry.line, `timeline-section-${periods.length}`); group++; current = undefined; sectionUsed = false; continue }
    const parts = splitQuoted(raw, ':', entry.line)
    if (parts.length < 2) fail('时间轴需要「时间段 : 事件」；续行事件以冒号开头。', entry.line)
    const events = parts.slice(1).map(part => label(part, entry.line))
    if (!parts[0]) { if (!current) fail('续行事件之前需要一个时间段。', entry.line); current.events.push(...events); current.eventLines.push(...events.map(() => entry.line)) }
    else { current = { text: label(parts[0], entry.line), events, eventLines: events.map(() => entry.line), section, group, line: entry.line }; periods.push(current); sectionUsed = true }
    if (periods.length > 80 || periods.reduce((sum, period) => sum + period.events.length, 0) > 240) fail('时间轴最多支持 80 个时间段、240 个事件。', entry.line)
  }
  if (!periods.length || !sectionUsed) fail('时间轴的每个分区至少需要一个时间段。', lines.at(-1)!.line)
  const elements: SceneElement[] = []; const top = title ? 100 : 48
  if (title) elements.push(diagramText('timeline-title', title, 60, 24, vertical ? 900 : Math.max(400, periods.length * 250), 54, { fontSize: 25, textAlign: 'left' }))
  if (vertical) {
    let y = top; let previousGroup: number | undefined
    for (let index = 0; index < periods.length; index++) {
      const period = periods[index]!; const color = period.group % COLORS.length
      if (period.group !== previousGroup && period.section) { elements.push(diagramNode(`timeline-section-${index}`, period.section, 60, y, 900, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 })); y += 64 }
      previousGroup = period.group
      const heights = period.events.map(event => textHeight(event, 540)); const height = Math.max(textHeight(period.text, 200), heights.reduce((sum, value) => sum + value + 12, 0))
      elements.push(diagramStroke(`timeline-axis-${index}`, [{ x: 310, y }, { x: 310, y: y + height + 32 }], { stroke: INKS[color]!, strokeWidth: 3 }))
      elements.push(diagramNode(`timeline-period-${index}`, period.text, 60, y, 210, textHeight(period.text, 210), 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
      elements.push(diagramNode(`timeline-dot-${index}`, '', 303, y + 22, 14, 14, 'ellipse', { fill: INKS[color]!, strokeWidth: 0 }))
      let eventY = y
      period.events.forEach((event, eventIndex) => { elements.push(diagramNode(`timeline-event-${index}-${eventIndex}`, event, 360, eventY, 540, heights[eventIndex]!, 'rectangle', { fill: '#f8fafc', stroke: INKS[color]!, textAlign: 'left' })); eventY += heights[eventIndex]! + 12 })
      y += height + 32
    }
  } else {
    elements.push(diagramEdge('timeline-axis', { x: 70, y: top + 144 }, { x: 70 + periods.length * 250, y: top + 144 }, '', { style: { stroke: '#64748b', strokeWidth: 3 } }))
    for (let index = 0; index < periods.length; index++) {
      const period = periods[index]!; const color = period.group % COLORS.length; const x = 60 + index * 250
      if (index === 0 || periods[index - 1]!.group !== period.group) {
        let end = index + 1; while (end < periods.length && periods[end]!.group === period.group) end++
        if (period.section) elements.push(diagramNode(`timeline-section-${index}`, period.section, x, top, (end - index) * 250 - 20, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 }))
      }
      elements.push(diagramNode(`timeline-period-${index}`, period.text, x, top + 62, 230, 62, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
      elements.push(diagramNode(`timeline-dot-${index}`, '', x + 108, top + 137, 14, 14, 'ellipse', { fill: INKS[color]!, strokeWidth: 0 }))
      let y = top + 174
      period.events.forEach((event, eventIndex) => { const height = textHeight(event, 230); elements.push(diagramNode(`timeline-event-${index}-${eventIndex}`, event, x, y, 230, height, 'rectangle', { fill: '#f8fafc', stroke: INKS[color]!, textAlign: 'left' })); y += height + 14 })
    }
  }
  periods.forEach((period, index) => {
    sources.add(period.line, `timeline-period-${index}`, `timeline-dot-${index}`, `timeline-axis-${index}`)
    period.eventLines.forEach((line, eventIndex) => sources.add(line, `timeline-event-${index}-${eventIndex}`))
  })
  return finishDiagram('timeline', elements, [], sources)
}

interface JourneyTask { line: number; text: string; score: number; actors: string[]; section: string; group: number }
function journey(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const tasks: JourneyTask[] = []; const actors: string[] = []; let title = ''; let section = ''; let group = 0; let sectionUsed = true
  const actorColors = new Map<string, { color: string; line: number }>()
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^actorColor\s+/.test(raw)) {
      const parts = splitQuoted(raw.slice(11), ':', entry.line)
      if (parts.length !== 2) fail('actorColor 需要「参与者名称 : 色值」。', entry.line)
      const actor = label(parts[0]!, entry.line)
      if (actorColors.has(actor)) fail(`参与者「${actor}」的颜色重复。`, entry.line)
      actorColors.set(actor, { color: safeColor(parts[1]!, entry.line), line: entry.line }); continue
    }
    if (/^title\s+/.test(raw)) { if (title || tasks.length || section) fail('标题只能在旅程数据之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'journey-title'); continue }
    if (/^section\s+/.test(raw)) { if (!sectionUsed) fail('上一个 section 没有任务。', entry.line); section = label(raw.slice(8), entry.line); sources.add(entry.line, `journey-section-${tasks.length}`); group++; sectionUsed = false; continue }
    const parts = splitQuoted(raw, ':', entry.line)
    if (parts.length !== 3 || !/^[0-5]$/.test(parts[1]!)) fail('旅程任务需要「任务 : 0 到 5 的整数评分 : 参与者, 参与者」。', entry.line)
    const members = splitQuoted(parts[2]!, ',', entry.line).map(value => label(value, entry.line))
    if (new Set(members).size !== members.length) fail('同一任务的参与者不能重复。', entry.line)
    for (const actor of members) if (!actors.includes(actor)) actors.push(actor)
    tasks.push({ line: entry.line, text: label(parts[0]!, entry.line), score: Number(parts[1]), actors: members, section, group }); sectionUsed = true
    if (tasks.length > 80 || actors.length > 16) fail('旅程图最多支持 80 个任务和 16 位参与者。', entry.line)
  }
  if (!tasks.length || !sectionUsed) fail('旅程图的每个分区至少需要一个任务。', lines.at(-1)!.line)
  for (const [actor, color] of actorColors) if (!actors.includes(actor)) fail(`actorColor 引用了未参加任务的参与者「${actor}」。`, color.line)
  const elements: SceneElement[] = []; const startX = 210; const step = 210; const width = tasks.length * step; const top = title ? 104 : 48
  if (title) elements.push(diagramText('journey-title', title, 60, 24, Math.max(width, 500), 54, { fontSize: 25, textAlign: 'left' }))
  const taskHeight = Math.max(...tasks.map(task => textHeight(task.text, 186))); const scoreTop = top + 66 + taskHeight + 50; const actorTop = scoreTop + 320
  for (let score = 0; score <= 5; score++) {
    const y = scoreTop + (5 - score) * 48
    elements.push(diagramText(`journey-score-${score}`, `${score}`, 150, y - 14, 40, 28, { fontSize: 14 }))
    elements.push(diagramStroke(`journey-grid-${score}`, [{ x: startX, y }, { x: startX + width, y }], { stroke: '#e2e8f0', strokeWidth: 1 }))
  }
  elements.push(diagramText('journey-score-label', '体验评分', 55, scoreTop + 84, 90, 50))
  actors.forEach((actor, index) => {
    const y = actorTop + index * 52, color = actorColors.get(actor)
    elements.push(diagramNode(`journey-lane-${index}`, '', startX, y, width, 46, 'rectangle', { fill: index % 2 ? '#f8fafc' : '#f1f5f9', stroke: color?.color ?? '#e2e8f0', strokeWidth: color ? 1 : 0 })); elements.push(diagramText(`journey-actor-${index}`, actor, 40, y, 160, 46, { textAlign: 'right', ...(color ? { stroke: color.color } : {}) }))
    if (color) sources.add(color.line, `journey-lane-${index}`, `journey-actor-${index}`)
  })
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!; const x = startX + index * step; const color = task.group % COLORS.length
    if (index === 0 || tasks[index - 1]!.group !== task.group) { let end = index + 1; while (end < tasks.length && tasks[end]!.group === task.group) end++; if (task.section) elements.push(diagramNode(`journey-section-${index}`, task.section, x, top, (end - index) * step - 16, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 })) }
    elements.push(diagramNode(`journey-task-${index}`, task.text, x, top + 60, 186, taskHeight, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
    const cx = x + 93; const cy = scoreTop + (5 - task.score) * 48
    if (index) { const previous = tasks[index - 1]!; elements.push(diagramEdge(`journey-link-${index}`, { nodeId: `journey-rating-${index - 1}`, x: cx - step, y: scoreTop + (5 - previous.score) * 48 }, { nodeId: `journey-rating-${index}`, x: cx, y: cy }, '', { arrow: 'none', style: { stroke: '#64748b' } })) }
    elements.push(diagramNode(`journey-rating-${index}`, `${task.score}/5`, cx - 24, cy - 24, 48, 48, 'ellipse', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 14 }))
    for (const actor of task.actors) {
      const actorIndex = actors.indexOf(actor), color = actorColors.get(actor), id = `journey-member-${index}-${actorIndex}`
      elements.push(diagramNode(id, '', cx - 16, actorTop + actorIndex * 52 + 7, 32, 32, 'ellipse', { fill: color?.color ?? COLORS[actorIndex % COLORS.length]!, stroke: color?.color ?? INKS[actorIndex % INKS.length]!, fontSize: 16, strokeWidth: 1 }))
      if (color) sources.add(color.line, id)
    }
  }
  tasks.forEach((task, index) => sources.add(task.line, `journey-task-${index}`, `journey-rating-${index}`, `journey-link-${index}`, ...task.actors.map(actor => `journey-member-${index}-${actors.indexOf(actor)}`)))
  return finishDiagram('journey', elements, [], sources)
}

interface KanbanCard { text: string; meta: Record<string, string>; line: number }
interface KanbanColumn { line: number; text: string; cards: KanbanCard[]; limit?: number }
function kanban(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const columns: KanbanColumn[] = []; const ids = new Set<string>(); let base: number | undefined; let cardIndent: number | undefined; let cardCount = 0
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    const level = indent(entry); if (base === undefined) base = level
    const metaIndex = raw.indexOf('@{'); let nodeText = raw; const meta: Record<string, string> = {}
    if (metaIndex >= 0) {
      if (!raw.endsWith('}')) fail('卡片 metadata 必须使用 @{ ... }。', entry.line)
      nodeText = raw.slice(0, metaIndex).trim()
      for (const field of splitQuoted(raw.slice(metaIndex + 2, -1), ',', entry.line)) {
        const parts = splitQuoted(field, ':', entry.line)
        const allowed = level === base ? ['limit'] : ['assigned', 'ticket', 'priority', 'due', 'tags', 'progress']
        if (parts.length !== 2 || !allowed.includes(parts[0]!)) fail(level === base ? '列 metadata 仅支持 limit。' : '卡片 metadata 支持 assigned、ticket、priority、due、tags、progress。', entry.line)
        const key = parts[0]!; if (Object.hasOwn(meta, key)) fail(`metadata「${key}」重复。`, entry.line)
        meta[key] = label(parts[1]!, entry.line)
        if (key === 'priority' && !['Very High', 'High', 'Medium', 'Low', 'Very Low'].includes(meta[key]!)) fail('priority 仅支持 Very High、High、Medium、Low、Very Low。', entry.line)
        if (key === 'due' && (!/^\d{4}-\d{2}-\d{2}$/.test(meta[key]!) || !Number.isFinite(Date.parse(`${meta[key]}T00:00:00Z`)) || new Date(`${meta[key]}T00:00:00Z`).toISOString().slice(0, 10) !== meta[key])) fail('due 需要真实的 YYYY-MM-DD 日期。', entry.line)
        if (key === 'progress' && (!/^\d{1,3}$/.test(meta[key]!) || Number(meta[key]) > 100)) fail('progress 需要 0 到 100 的整数。', entry.line)
        if (key === 'limit' && (!/^\d{1,3}$/.test(meta[key]!) || Number(meta[key]) < 1 || Number(meta[key]) > 120)) fail('列 limit 需要 1 到 120 的整数。', entry.line)
      }
    }
    const data = descriptor(nodeText, entry.line)
    if (data.shape !== 'rectangle' || data.approximate || data.subroutine || data.className || new RegExp(`^(?:${ID})?\\(`, 'u').test(nodeText)) fail('看板列与卡片使用普通文本或 id[标签]。', entry.line)
    if (data.explicit) { if (ids.has(data.explicit)) fail(`ID「${data.explicit}」重复。`, entry.line); ids.add(data.explicit) }
    if (level === base) columns.push({ line: entry.line, text: data.text, cards: [], ...(meta.limit ? { limit: Number(meta.limit) } : {}) })
    else {
      if (level < base || !columns.length) fail('卡片必须缩进在列下面。', entry.line)
      if (cardIndent === undefined) cardIndent = level
      if (level !== cardIndent) fail('看板只支持列和卡片两层，请对齐卡片缩进。', entry.line)
      columns.at(-1)!.cards.push({ text: data.text, meta, line: entry.line }); cardCount++
    }
    if (columns.length > 12 || cardCount > 120) fail('看板最多支持 12 列和 120 张卡片。', entry.line)
  }
  if (!columns.length) fail('看板至少需要一列。', lines[0]!.line)
  const elements: SceneElement[] = []
  const cardLabel = (card: KanbanCard): string => [card.text, card.meta.assigned && `负责人：${card.meta.assigned}`, card.meta.ticket && `工单：${card.meta.ticket}`, card.meta.priority && `优先级：${card.meta.priority}`, card.meta.due && `截止：${card.meta.due}`, card.meta.tags && `标签：${card.meta.tags}`, card.meta.progress !== undefined && `进度：${card.meta.progress}%`].filter(Boolean).join('\n')
  const cardHeight = (card: KanbanCard): number => textHeight(cardLabel(card), 248, 84) + (card.meta.progress !== undefined ? 20 : 0)
  const columnHeight = Math.max(220, ...columns.map(column => 94 + column.cards.reduce((sum, card) => sum + cardHeight(card) + 16, 0)))
  columns.forEach((column, index) => {
    const x = 50 + index * 296; const color = index % COLORS.length
    elements.push(diagramNode(`kanban-column-${index}`, '', x, 48, 280, columnHeight, 'rectangle', { fill: '#f1f5f9', stroke: '#e2e8f0', strokeWidth: 1 }))
    const exceeded = column.limit !== undefined && column.cards.length > column.limit
    elements.push(diagramNode(`kanban-title-${index}`, `${column.text} (${column.cards.length}${column.limit === undefined ? '' : `/${column.limit}`})${exceeded ? '\n超出在制品限制' : ''}`, x, 48, 280, 60, 'rectangle', { fill: exceeded ? '#ffe4e6' : COLORS[color]!, stroke: exceeded ? '#be123c' : INKS[color]!, fontSize: exceeded ? 15 : 19 }))
    let y = 128
    column.cards.forEach((card, cardIndex) => {
      const first = elements.length, text = cardLabel(card), height = cardHeight(card), id = `kanban-card-${index}-${cardIndex}`
      const high = card.meta.priority === 'High' || card.meta.priority === 'Very High'
      elements.push(diagramNode(id, text, x + 16, y, 248, height, 'rectangle', { fill: '#ffffff', stroke: high ? '#be123c' : '#475569', strokeWidth: high ? 2 : 1, textAlign: 'left', fontSize: 15 }))
      if (card.meta.progress !== undefined) {
        elements.push(diagramNode(`${id}-progress-track`, '', x + 32, y + height - 14, 216, 5, 'rectangle', { fill: '#e2e8f0', strokeWidth: 0 }))
        if (Number(card.meta.progress) > 0) elements.push(diagramNode(`${id}-progress-value`, '', x + 32, y + height - 14, 216 * Number(card.meta.progress) / 100, 5, 'rectangle', { fill: '#2563eb', strokeWidth: 0 }))
      }
      sources.capture(card.line, elements, first); y += height + 16
    })
  })
  columns.forEach((column, index) => {
    sources.add(column.line, `kanban-column-${index}`, `kanban-title-${index}`)
    column.cards.forEach((card, cardIndex) => sources.add(card.line, `kanban-card-${index}-${cardIndex}`))
  })
  return finishDiagram('kanban', elements, [], sources)
}

interface BlockEntry { id?: string; descriptor?: Descriptor; span: number; line: number; group?: BlockGroup; x?: number; y?: number; width?: number; height?: number }
interface BlockGroup { entries: BlockEntry[]; columns?: number; columnsSet: boolean; direction: 'LR' | 'RL' | 'TB' | 'BT'; directionSet: boolean; line: number; width: number; height: number; owner?: BlockEntry }
interface BlockLink { from: string; to: string; label: string; arrow: 'end' | 'both' | 'none'; line: number }
function blockTokens(raw: string, line: number): string[] {
  const tokens: string[] = []; let current = ''; let quote = ''; let escaped = false; const brackets: string[] = []
  const closes: Record<string, string> = { ']': '[', ')': '(', '}': '{' }
  for (const char of raw) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\') { current += char; escaped = true; continue }
    if (quote) { current += char; if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(current.at(-1) ?? ''))) { current += char; quote = char; continue }
    if (char === ')' && !brackets.length && new RegExp(`^${ID}$`, 'u').test(current)) brackets.push('cloud')
    else if (char === '(' && brackets.at(-1) === 'cloud') brackets.pop()
    else {
      if ('[({'.includes(char)) brackets.push(char)
      if ('])}'.includes(char) && brackets.pop() !== closes[char]) fail('节点括号未匹配。', line)
    }
    if (/\s/.test(char) && !brackets.length) { if (current) tokens.push(current); current = '' } else current += char
  }
  if (quote || brackets.length) fail('节点的引号或括号未闭合。', line)
  if (current) tokens.push(current); return tokens
}

function block(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines), styles = new PlanningStyles()
  const group = (line: number): BlockGroup => ({ entries: [], columnsSet: false, direction: 'LR', directionSet: false, line, width: 0, height: 0 })
  const root = group(lines[0]!.line), stack = [root], links: BlockLink[] = [], ids = new Set<string>(), warnings: string[] = []
  let itemCount = 0, anonymous = 0
  const add = (entry: BlockEntry, parent: BlockGroup): void => {
    if (entry.id) { if (ids.has(entry.id)) fail(`节点 ID「${entry.id}」重复。`, entry.line); ids.add(entry.id) }
    parent.entries.push(entry); itemCount++
    if (ids.size > 200 || itemCount > 240) fail('block 最多支持 200 个节点和 240 个网格项目。', entry.line)
  }
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue
    const current = stack.at(-1)!
    if (styles.read(raw, entry.line)) continue
    if (/^columns\b/.test(raw)) {
      if (current.columnsSet || current.entries.length) fail('每个分组的 columns 必须在节点前声明一次。', entry.line)
      const match = raw.match(/^columns\s+(auto|\d+)$/)
      if (!match) fail('columns 需要 1 到 12 的整数或 auto。', entry.line)
      current.columns = match[1] === 'auto' ? undefined : Number(match[1])
      if (current.columns !== undefined && (current.columns < 1 || current.columns > 12)) fail('columns 需要 1 到 12 的整数。', entry.line)
      current.columnsSet = true; continue
    }
    if (/^direction\b/.test(raw)) {
      const match = raw.match(/^direction\s+(LR|RL|TB|BT)$/)
      if (!match || current.directionSet || current.entries.length) fail('direction 需要在每组节点之前声明一次，取 LR、RL、TB 或 BT。', entry.line)
      current.direction = match[1] as BlockGroup['direction']; current.directionSet = true; continue
    }
    if (raw === 'end') {
      if (stack.length === 1) fail('end 没有对应的嵌套分组。', entry.line)
      if (!current.entries.some(item => item.id)) fail('嵌套分组至少需要一个节点。', entry.line)
      sources.add(entry.line, `block-${current.owner!.id}`); stack.pop(); continue
    }
    const opening = raw.match(/^block(?::(.+))?$/)
    if (opening) {
      const value = opening[1] ?? `anonymous-${++anonymous}[分组 ${anonymous}]`
      const spanMatch = value.match(/:(\d+)$/), span = spanMatch ? Number(spanMatch[1]) : 1, nodeValue = spanMatch ? value.slice(0, spanMatch.index) : value
      const data = descriptor(nodeValue, entry.line), id = data.explicit ?? nodeValue
      if (!new RegExp(`^${ID}$`, 'u').test(id) || data.shape !== 'rectangle' || data.approximate || data.subroutine) fail('分组使用 block:组ID[标题]:跨度。', entry.line)
      if (span < 1 || span > 12 || (current.columns !== undefined && span > current.columns)) fail('分组跨度不能超过当前列数。', entry.line)
      const child = group(entry.line), item: BlockEntry = { id, descriptor: data, span, line: entry.line, group: child }
      child.owner = item; add(item, current); sources.add(entry.line, `block-${id}`, `block-${id}:title`)
      stack.push(child); if (stack.length > 11) fail('分块布局最多支持 10 层嵌套分组。', entry.line)
      continue
    }
    rejectDirective(raw, entry.line)
    const connection = raw.match(new RegExp(`^(${ID})\\s*(<-->|-->|---)(?:\\|([^|]+)\\|)?\\s*(${ID})$`, 'u'))
    const labeled = raw.match(new RegExp(`^(${ID})\\s*--\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*-->\\s*(${ID})$`, 'u'))
    if (connection || labeled) {
      links.push(connection ? { from: connection[1]!, to: connection[4]!, label: connection[3] ? label(connection[3], entry.line) : '', arrow: connection[2] === '---' ? 'none' : connection[2] === '<-->' ? 'both' : 'end', line: entry.line } : { from: labeled![1]!, to: labeled![3]!, label: label(labeled![2]!, entry.line), arrow: 'end', line: entry.line })
      if (links.length > 400) fail('block 最多支持 400 条连线。', entry.line)
      continue
    }
    let sourceCursor = 0
    const sourceStart = entry.start + entry.text.length - entry.text.trimStart().length
    for (const token of blockTokens(raw, entry.line)) {
      const tokenStart = raw.indexOf(token, sourceCursor); sourceCursor = tokenStart + token.length
      const spanMatch = token.match(/:(\d+)$/), span = spanMatch ? Number(spanMatch[1]) : 1, nodeValue = spanMatch ? token.slice(0, spanMatch.index) : token
      if (span < 1 || span > 12 || (current.columns !== undefined && span > current.columns)) fail('节点跨度必须在 1 到列数之间，且不超过 12。', entry.line)
      if (nodeValue === 'space') add({ span, line: entry.line }, current)
      else {
        const data = descriptor(nodeValue, entry.line), id = data.explicit ?? nodeValue.replace(/:::[\p{L}\p{N}_-]+$/u, '')
        if (!new RegExp(`^${ID}$`, 'u').test(id)) fail('block 节点必须有 ID，例如 item[标签]。', entry.line)
        if (data.approximate) warnings.push('体育场形节点显示为矩形，标签及跨度保留。')
        sources.range(sourceStart + tokenStart, sourceStart + sourceCursor, `block-${id}`, `block-${id}:side:0`, `block-${id}:side:1`)
        add({ id, descriptor: data, span, line: entry.line }, current)
      }
    }
  }
  if (stack.length > 1) fail('嵌套分组缺少 end。', stack.at(-1)!.line)
  if (!ids.size) fail('block 至少需要一个节点。', lines[0]!.line)
  // Leave readable space around connector labels while preserving the node sizes.
  const layoutGap = Math.max(24, ...links.filter(link => link.label).map(link => Math.ceil([...link.label].reduce((width, char) => width + (/[\u0000-\u007f]/.test(char) ? .65 : 1.05) * 16, 0)) + 28))
  function measure(current: BlockGroup): void {
    for (const entry of current.entries) if (entry.group) measure(entry.group)
    const slots = current.columns ?? Math.min(12, current.entries.reduce((sum, entry) => sum + entry.span, 0)), horizontal = current.direction === 'LR' || current.direction === 'RL', gap = layoutGap
    if (current.columns === undefined && current.entries.reduce((sum, entry) => sum + entry.span, 0) > 12) warnings.push('自动列布局每行最多 12 列；可显式设置 columns。')
    const desired = (entry: BlockEntry) => entry.group ? { width: entry.group.width + 48, height: entry.group.height + 72 } : { width: horizontal ? entry.span * 184 - 24 : 160, height: Math.max(82, textHeight(entry.descriptor?.text ?? '', horizontal ? entry.span * 184 - 24 : 160)) }
    const cell = Math.max(horizontal ? 160 + gap : 86 + gap, ...current.entries.map(entry => ((horizontal ? desired(entry).width : desired(entry).height) + gap) / entry.span))
    const rows: { entries: { item: BlockEntry; slot: number }[]; extent: number }[] = []; let slot = 0
    for (const item of current.entries) {
      if (item.span > slots) fail('节点跨度不能超过 columns。', item.line)
      if (!rows.length || slot + item.span > slots || slot === slots) { rows.push({ entries: [], extent: horizontal ? 82 : 160 }); slot = 0 }
      const row = rows.at(-1)!, size = desired(item)
      row.entries.push({ item, slot }); row.extent = Math.max(row.extent, horizontal ? size.height : size.width); slot += item.span
    }
    const primary = slots * cell - gap, secondary = rows.reduce((sum, row) => sum + row.extent + gap, -gap)
    current.width = horizontal ? primary : secondary; current.height = horizontal ? secondary : primary
    if (Math.max(current.width, current.height) > 90000) fail('分组尺寸过大，请减少空列或嵌套跨度。', current.line)
    let cursor = 0
    for (const row of rows) {
      for (const { item, slot } of row.entries) {
        const length = item.span * cell - gap, reverse = current.direction === 'RL' || current.direction === 'BT', start = reverse ? primary - slot * cell - length : slot * cell
        item.x = horizontal ? start : cursor; item.y = horizontal ? cursor : start
        item.width = horizontal ? length : row.extent; item.height = horizontal ? row.extent : length
      }
      cursor += row.extent + gap
    }
  }
  measure(root)
  const nodes = new Map<string, ShapeElement>(), backgrounds: SceneElement[] = [], foregrounds: SceneElement[] = [], decorated: { node: ShapeElement; data: Descriptor; line: number }[] = []
  function render(current: BlockGroup, x: number, y: number, depth: number): void {
    for (const entry of current.entries) if (entry.id && entry.descriptor) {
      const node = diagramNode(`block-${entry.id}`, entry.group ? '' : entry.descriptor.text, x + entry.x!, y + entry.y!, entry.width!, entry.height!, entry.group ? 'rectangle' : entry.descriptor.shape, { fill: entry.group ? '#f8fafc' : COLORS[depth % COLORS.length]!, stroke: INKS[depth % INKS.length]!, strokeWidth: entry.group ? 1 : 2 })
      nodes.set(entry.id, node); styles.attach(node, entry.descriptor, entry.line)
      if (entry.group) {
        backgrounds.push(node); foregrounds.push(diagramText(`${node.id}:title`, entry.descriptor.text, node.x + 12, node.y + 8, node.width - 24, 34, { textAlign: 'left', fontSize: 17, stroke: INKS[depth % INKS.length]! }))
        render(entry.group, node.x + 24, node.y + 48, depth + 1)
      } else { foregrounds.push(node); decorated.push({ node, data: entry.descriptor, line: entry.line }) }
    }
  }
  render(root, 60, 60, 0); styles.apply(nodes, sources)
  for (const item of decorated) foregrounds.push(...subroutineLines(item.node, item.data))
  const elements: SceneElement[] = [...backgrounds]
  links.forEach((link, index) => {
    const from = nodes.get(link.from), to = nodes.get(link.to)
    if (!from || !to) fail('连线引用了未声明的 block 节点。', link.line)
    const edgeId = nodes.has(`edge-${index}`) ? `block-edge:${index}` : `block-edge-${index}`
    elements.push(diagramEdge(edgeId, { nodeId: from.id, x: from.x + from.width / 2, y: from.y + from.height / 2 }, { nodeId: to.id, x: to.x + to.width / 2, y: to.y + to.height / 2 }, link.label, { arrow: link.arrow, route: 'orthogonal' })); sources.add(link.line, edgeId)
  })
  elements.push(...foregrounds); return finishDiagram('block', elements, warnings, sources)
}

interface PacketField { start: number; end: number; text: string; line: number }
function packet(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const fields: PacketField[] = []; let title = ''; let next = 0
  let bitsPerRow = 32, showBits = true, bitOrder: 'lsb' | 'msb' = 'lsb', startBit = 0
  const settings = new Set<string>()
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^title\s+/.test(raw)) { if (title || fields.length) fail('标题只能在数据字段之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'packet-title'); continue }
    const option = raw.match(/^(bitsPerRow|showBits|bitOrder|startBit)\s+(.+)$/)
    if (option) {
      const key = option[1]!, value = option[2]!
      if (fields.length || settings.has(key)) fail('数据包设置必须在字段之前声明一次。', entry.line)
      settings.add(key)
      if (key === 'bitsPerRow') { if (!/^\d+$/.test(value) || Number(value) < 8 || Number(value) > 64) fail('bitsPerRow 需要 8 到 64 的整数。', entry.line); bitsPerRow = Number(value) }
      if (key === 'showBits') { if (!['true', 'false'].includes(value)) fail('showBits 需要 true 或 false。', entry.line); showBits = value === 'true' }
      if (key === 'bitOrder') { if (!['lsb', 'msb'].includes(value)) fail('bitOrder 需要 lsb 或 msb。', entry.line); bitOrder = value as 'lsb' | 'msb' }
      if (key === 'startBit') { if (!/^\d+$/.test(value) || Number(value) > 65535) fail('startBit 需要 0 到 65535 的整数。', entry.line); startBit = Number(value) }
      continue
    }
    const match = raw.match(/^(?:(\d+)(?:\s*-\s*(\d+))?|\+(\d+))\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/)
    if (!match) fail('数据字段需要 0-15: "标签"、16: "标签" 或 +8: "标签"。', entry.line)
    const start = match[3] ? next : Number(match[1]); const end = match[3] ? start + Number(match[3]) - 1 : Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 1023) fail('位范围必须递增，且位于 0 到 1023 之间。', entry.line)
    if (start < next) fail('数据字段不能重叠或倒序。', entry.line)
    fields.push({ start, end, text: label(match[4]!, entry.line), line: entry.line }); next = end + 1
    if (fields.length > 200) fail('packet 最多支持 200 个字段。', entry.line)
  }
  if (!fields.length) fail('packet 至少需要一个位字段。', lines[0]!.line)
  const elements: SceneElement[] = []; const bitWidth = 32; const left = 100; const top = title ? 112 : 56; const rows = Math.ceil(next / bitsPerRow), header = showBits ? 28 : 0, rowHeight = showBits ? 110 : 82
  if (title) elements.push(diagramText('packet-title', title, left, 24, bitWidth * bitsPerRow, 56, { fontSize: 25, textAlign: 'left' }))
  for (let row = 0; row < rows; row++) {
    const y = top + row * rowHeight
    elements.push(diagramText(`packet-offset-${row}`, `${startBit + row * bitsPerRow}`, 20, y + header + 2, 70, 56, { textAlign: 'right', fontSize: 13 }))
    elements.push(diagramNode(`packet-row-${row}`, '', left, y + header, bitWidth * bitsPerRow, 64, 'rectangle', { fill: '#f8fafc', stroke: '#cbd5e1', strokeWidth: 1 }))
    if (showBits) for (let bit = 0; bit < bitsPerRow; bit++) elements.push(diagramText(`packet-bit-${row}-${bit}`, `${bitOrder === 'msb' ? bitsPerRow - bit - 1 : bit}`, left + bit * bitWidth, y, bitWidth, 24, { fontSize: 10 }))
  }
  fields.forEach((field, index) => {
    const firstElement = elements.length
    for (let row = Math.floor(field.start / bitsPerRow); row <= Math.floor(field.end / bitsPerRow); row++) {
      const start = Math.max(field.start, row * bitsPerRow); const end = Math.min(field.end, row * bitsPerRow + bitsPerRow - 1); const width = (end - start + 1) * bitWidth
      const column = bitOrder === 'msb' ? bitsPerRow - 1 - end % bitsPerRow : start % bitsPerRow
      elements.push(diagramNode(`packet-field-${index}-${row}`, field.text, left + column * bitWidth, top + row * rowHeight + header, width, 64, 'rectangle', { fill: COLORS[index % COLORS.length]!, stroke: INKS[index % INKS.length]!, strokeWidth: 1, fontSize: width < 78 ? 10 : 14 }))
    }
    sources.capture(field.line, elements, firstElement)
  })
  return finishDiagram('packet', elements, [], sources)
}

/** A bounded, native scene compiler; unsupported directives fail with a source line. */
export function compilePlanningDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source); const header = lines[0]?.text.trim()
  if (!header) return undefined
  if (header === 'mindmap') return mindmap(lines)
  if (/^timeline(?:\s+(?:LR|TD))?$/.test(header)) return timeline(lines, /\sTD$/.test(header))
  if (header === 'journey') return journey(lines)
  if (header === 'kanban') return kanban(lines)
  if (/^block(?:-beta)?$/.test(header)) return block(lines)
  if (/^packet(?:-beta)?$/.test(header)) return packet(lines)
  if (/^(?:mindmap|timeline|journey|kanban|block(?:-beta)?|packet(?:-beta)?)(?:\s|$)/.test(header)) fail('图表标题行包含不支持的参数。', lines[0]!.line)
  return undefined
}

export const PLANNING_TEMPLATES: DiagramTemplate[] = [
  { id: 'mindmap', kind: 'mindmap', title: '产品规划与交付', description: '多级树、节点形状、图标、类样式与单节点样式组合展示产品规划。', category: '规划与协作', source: `mindmap
  %% 缩进表示父子关系；不同形状区分目标、处理步骤、判断与存储
  root((产品交付全景))
    ::icon(star)
    goals[目标]:::focus
      efficiency[协作效率]
        ::icon(check)
        interviews[/用户访谈与问卷/]
        metrics{是否达到目标}
      ownership[数据自主]
        local[(本地文件与草稿)]
    design{{设计体系}}
      ::icon(diamond)
      process[[评审与改进流程]]
        prototype(原型设计)
        feedback)用户反馈(
    delivery[交付计划]
      ::icon(square)
      docs[使用指南<br>与示例文档]
      tests[保存、导出与回归验证]
    quality[质量保障]
      ::icon(circle)
      monitor[持续观测]
      support[用户支持]
        ::icon(cloud)
  %% 安全样式只影响外观，不执行脚本或加载外部资源
  classDef focus fill:#dbeafe,stroke:#1d4ed8,stroke-width:3
  class design,quality focus
  style metrics fill:#fff7dc,stroke:#a16207,stroke-dasharray:dashed` },
  { id: 'mindmap-risk', kind: 'mindmap', title: '风险分解与应对', description: '多层风险树结合引用样式、内置图标、带引号标签与透明度。', category: '规划与协作', source: `mindmap
  %% 根节点和每个显式 ID 在整个文档中保持唯一
  risks{{交付风险评估}}
    scope[范围风险]:::warning
      change["需求变化：先确认，再执行"]
      criteria{验收标准清楚吗}
        yes[明确边界]
        no[补充验收用例]
    people[协作风险]
      ::icon(circle)
      capacity[/关键岗位资源/]
      backup[[替补与知识共享]]
        review[双人评审]
        notes[(决策记录)]
    stability[稳定性风险]:::warning
      ::icon(check)
      regression[原生文件往返<br>图像与矢量导出]
      recovery)故障恢复演练(
    release[交付复盘]
      evidence["保留 %% 字符作为正文"]
      followup[负责人和下一步]
  classDef warning fill:#fff1f2,stroke:#be123c,stroke-width:2
  style capacity stroke:#0e7490,fill:#ecfeff,opacity:0.9
  style followup stroke-dasharray:dotted` },
  { id: 'timeline', kind: 'timeline', title: '分阶段产品时间轴', description: '横向时间轴展示分区、多事件、续行、引号标签与中文注释。', category: '规划与协作', source: `timeline
  title 产品交付时间轴
  %% 内置方向指令须放在时间段之前；这里按从左到右阅读
  direction LR
  section 发现与设计
    第 1 周 : 用户访谈 : 确定核心场景
    第 2 周 : "评审: 原型与边界"
            : 补充交互说明 : 明确验收标准
  section 开发与验证
    第 3–4 周 : 画布与文件格式 : 自动保存与恢复
    第 5 周 : 小范围试用<br>收集反馈
            : 导入导出回归 : 修复使用阻碍
  section 交付与演进
    第 6 周 : 正式交付 : 发布使用指南
    第 7 周 : 复盘与下一阶段规划 : 跟进用户建议` },
  { id: 'timeline-vertical', kind: 'timeline', title: '纵向事件与处置记录', description: '纵向时间轴将多轮事件、续行措施及分区整理为可追溯记录。', category: '规划与协作', source: `timeline TD
  %% 方向也可写在标题行；不要与 direction 重复设置
  title 服务异常调查与恢复
  section 发现与确认
    "09:10" : 收到监控告警 : 联系值班人员
    "09:15" : "确认影响: 部分用户无法保存"
            : 记录现象与时间范围
  section 处置与验证
    "09:25" : 临时关闭异常入口 : 通知受影响用户
    "09:40" : 完成修复<br>保留调查证据
            : 验证新建、恢复与导出 : 观察指标回落
  section 复盘与预防
    当日 : 更新恢复步骤 : 补充自动化检查
    次日 : 跟进剩余建议 : 确认长期改进负责人` },
  { id: 'journey', kind: 'journey', title: '首次使用与团队协作', description: '六级体验评分、多阶段和多参与者泳道，结合参与者配色。', category: '规划与协作', source: `journey
  title 从首次使用到团队协作
  %% 内置 actorColor 将同一参与者的名字、泳道和标记统一着色
  actorColor 用户: #2563eb
  actorColor 客服: #be123c
  actorColor 产品经理: #7c3aed
  section 发现
    了解产品: 4: 用户, 产品经理
    尝试创建画布: 5: 用户
    找不到历史草稿: 0: 用户, 客服
  section 使用
    导入历史文件: 2: 用户, 客服
    排查导出选项: 1: 用户, 客服
    完成第一张流程图: 5: 用户
  section 协作
    邀请同事评审: 3: 用户, 同事
    整理改进意见: 4: 用户, 同事, 产品经理
    确认下一步行动: 5: 用户, 产品经理` },
  { id: 'journey-service', kind: 'journey', title: '复杂服务与问题恢复', description: '引号处理任务与参与者中的分隔符，呈现服务失败及恢复后的体验。', category: '规划与协作', source: `journey
  title 从服务受阻到顺利完成
  %% 名称含逗号或冒号时使用引号，评分从 0 到 5，参与者按列分开
  actorColor "顾问,专员": #0e7490
  actorColor "支持:二线": #b45309
  section 准备
    "确认目标: 范围与时限": 4: 客户, "顾问,专员"
    整理资料<br>核实来源: 3: 客户
  section 处理
    提交资料: 5: 客户, "顾问,专员"
    遇到格式错误: 1: 客户, "支持:二线"
    等待补充说明: 2: 客户, "顾问,专员"
    无法继续处理: 0: 客户, "支持:二线"
  section 恢复与交付
    完成问题定位: 4: "支持:二线", "顾问,专员"
    重新提交并验收: 5: 客户, "顾问,专员"
    收集改进建议: 3: 客户, "支持:二线"` },
  { id: 'kanban', kind: 'kanban', title: '交付看板与在制品限制', description: '负责人、工单、优先级、日期、标签、进度和超限提醒的综合看板。', category: '规划与协作', source: `kanban
  %% limit 是内置列扩展；超过限制会在列标题中明显提示
  backlog[待办]
    research[梳理用户需求]@{ assigned: '小林', ticket: 'OW-101', priority: 'High', due: '2026-11-01', tags: '调研,体验', progress: 0 }
    tests[补充格式兼容测试]@{ assigned: '小周', priority: 'Low', due: '2026-11-03', tags: '质量' }
  doing[进行中]@{ limit: 1 }
    canvas[完善原生画布]@{ assigned: '小陈', ticket: 'OW-102', priority: 'Very High', progress: 65 }
    docs[编写使用指南]@{ assigned: '小林', priority: 'Medium', progress: 35 }
  review[待评审]@{ limit: 2 }
    prototype[交互原型评审]@{ ticket: 'OW-99', priority: 'Very Low', progress: 90 }
  done[已完成]
    scope[确认交付范围]@{ assigned: '小周', progress: 100, tags: '已验收' }` },
  { id: 'kanban-service', kind: 'kanban', title: '问题分流与处理看板', description: '两层卡片、空列、普通文字和带引号标签，追踪问题流转与完成进度。', category: '规划与协作', source: `kanban
  %% 普通文本列、匿名方括号标签、显式 ID 均可使用；卡片统一缩进
  收件箱
    [收集新反馈]@{ assigned: '值班人员', tags: '体验,建议', priority: 'Low' }
    classify["确认问题: 复现与影响"]@{ ticket: 'SUP-28', priority: 'High' }
  triage[已分流]@{ limit: 3 }
    reproduce[完成复现<br>补充操作记录]@{ assigned: '小张', due: '2026-12-05', progress: 20 }
  working[处理中]@{ limit: 2 }
    repair[修复保存失败]@{ assigned: '小李', ticket: 'SUP-27', priority: 'Very High', progress: 80 }
    guide[补充恢复指南]@{ assigned: '小张', priority: 'Medium', progress: 50 }
  [等待用户确认]
  closed[已关闭]
    confirmed[验收修复结果]@{ ticket: 'SUP-21', progress: 100, tags: '已验证' }
    deferred[记录后续改进]@{ priority: 'Very Low', due: '2027-01-12' }` },
  { id: 'block', kind: 'block', title: '嵌套系统与共享服务', description: '分组、局部列数、跨度、多种节点形状及跨分组连接的综合布局。', category: '结构与系统', source: `block-beta
  %% 根级三列；跨三列的分组内可再设置自己的列数和方向
  columns 3
  direction LR
  gateway[统一入口]:3
  block:workspace[编辑工作区]:3
    columns 3
    editor[[画布编辑器]] compiler{{代码编译器}} files[/文件服务/]
    space storage[(本地存储)] space
  end
  block:delivery[交付与验证]:3
    columns 3
    direction LR
    review{验收通过} package[交付文档] archive((归档))
    space feedback)用户反馈( space
  end
  %% 支持单箭头、双箭头、无箭头及两种标签写法
  gateway --> editor
  editor <-->|同步| compiler
  files -- "保存" --> storage
  compiler --> review
  review -->|通过| package
  package --- archive
  feedback --> editor
  classDef important fill:#dbeafe,stroke:#1d4ed8,stroke-width:3
  class gateway,review important
  style delivery fill:#f0fdf4,stroke:#15803d` },
  { id: 'block-directions', kind: 'block', title: '多方向分组与嵌套处理', description: '局部反向和纵向布局、自动列数、匿名组、空位与嵌套跨度。', category: '结构与系统', source: `block
  %% 每组独立排版；TB、BT 将 columns 作为纵向主轴的格数
  columns 2
  direction LR
  block:request[请求路径]
    columns 2
    direction RL
    receive[接收请求] validate{验证条件}
    block:processing[处理阶段]:2
      columns 3
      direction TB
      queue[(排队)] execute[[执行]] result[整理结果]
    end
  end
  block:response[返回路径]
    columns 3
    direction BT
    send[发送响应] format[/格式整理/] resultCheck{检查结果}
  end
  block:shared[共享能力]:2
    columns auto
    trace[记录链路] cache[(缓存)] space metrics{{度量}}
    block
      columns 2
      note[操作说明] owner[处理负责人]
    end
  end
  receive --> validate
  validate --> execute
  execute --> resultCheck
  format --> send
  trace --- metrics
  classDef active fill:#fef3c7,stroke:#a16207,stroke-width:2
  class execute,resultCheck active
  style shared fill:#f8fafc,stroke:#64748b,stroke-dasharray:dashed
  style send opacity:0.9` },
  { id: 'packet', kind: 'packet', title: '数据包字段与跨行载荷', description: '绝对位段、单个位、相对长度、留空区域和多行字段，默认位编号可见。', category: '结构与系统', source: `packet-beta
  title 传输数据包结构
  %% 以下为内置显示扩展；字段位置仍从零开始，startBit 仅改变行偏移标签
  bitsPerRow 32
  showBits true
  bitOrder lsb
  startBit 0
  0-15: "源端口"
  16-31: "目标端口"
  +16: "数据长度"
  +16: "校验和"
  64: "标志"
  68-79: "扩展类型"
  +48: "应用数据（跨行）"
  +16: "扩展字段"
  +8: "结束标记"` },
  { id: 'packet-compact', kind: 'packet', title: '高位在左的紧凑字段', description: '十六位行宽、隐藏逐位编号、逆序位位置及自定义显示偏移。', category: '结构与系统', source: `packet
  title 扩展记录与分段数据
  %% 高位在左会同时反转编号和字段位置，不改变源码中的逻辑位范围
  bitsPerRow 16
  showBits false
  bitOrder msb
  startBit 128
  0-3: "版本"
  +4: "类型"
  +8: "长度"
  +12: "序号"
  31: "标志"
  +24: "正文跨行"
  +8: "校验"
  +16: "结束字段"` },
]
