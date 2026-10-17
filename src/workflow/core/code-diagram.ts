import { DiagramSyntaxError, DiagramSourceMap, sourceLines, type DiagramResult } from './diagrams/common.ts'
import { compileStructureDiagram } from './diagrams/structure.ts'
import { compileChartDiagram } from './diagrams/charts.ts'
import { compilePlanningDiagram } from './diagrams/planning.ts'
import { DEFAULT_STYLE, type EdgeElement, type ElementStyle, type Scene, type SceneElement, type ShapeElement } from './types.ts'
import { layoutScene } from './layout.ts'
import { edgePoints } from './geometry.ts'

/** Compile the supported diagram language into our editable scene model. */
export type CodeDiagramResult = DiagramResult
export { DiagramSyntaxError, lookupDiagramSource, type DiagramSourceRange } from './diagrams/common.ts'
interface Statement { text: string; line: number; start: number; end: number }
const MAX_NODES = 400, MAX_EDGES = 800
const ID = '[A-Za-z0-9_\\u0080-\\uFFFF]+(?:[-.][A-Za-z0-9_\\u0080-\\uFFFF]+)*'
const idAtStart = new RegExp(`^${ID}`)
const fail = (message: string, statement: Statement, column = 1): never => { throw new DiagramSyntaxError(message, statement.line, column) }
const style = (changes: Partial<ElementStyle> = {}): ElementStyle => ({ ...DEFAULT_STYLE, ...changes, strokePattern: changes.strokePattern ?? (changes.dashed ? 'dashed' : 'solid') })

/** Semicolons/comments are separators only outside labels, preserving their original line numbers. */
function statements(source: string): Statement[] {
  const result: Statement[] = []
  let text = '', line = 1, startLine = 1, start = 0, quote = '', escaped = false, hasContent = false
  const brackets: string[] = []
  const flush = () => { const value = text.trim(); if (value) result.push({ text: value, line: startLine, start, end: start + value.length }); text = ''; startLine = line; hasContent = false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (!hasContent && !/\s/.test(c)) { startLine = line; start = i; hasContent = true }
    if (quote) {
      text += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = ''
      if (c === '\n') line++
      continue
    }
    if (c === '"') { quote = c; text += c; continue }
    if (c === '%' && source[i + 1] === '%' && !brackets.length) {
      if (source[i + 2] === '{') throw new DiagramSyntaxError('暂不支持图表初始化指令。', line)
      while (i < source.length && source[i] !== '\n') i++
      flush(); line++; startLine = line; continue
    }
    if (c === '\n') {
      if (brackets.length) throw new DiagramSyntaxError('节点标签未闭合；换行请写为 <br/> 或 \\n。', startLine)
      flush(); line++; startLine = line; continue
    }
    if (c === ';' && !brackets.length) { flush(); continue }
    if ('[({'.includes(c)) brackets.push(c)
    else if ('])}'.includes(c)) {
      const open = brackets.pop()
      if (open !== ({ ']': '[', ')': '(', '}': '{' } as Record<string, string>)[c]) {
        throw new DiagramSyntaxError(`不匹配的括号“${c}”。`, line)
      }
    }
    text += c
  }
  if (quote) throw new DiagramSyntaxError('字符串缺少结束引号。', startLine)
  if (brackets.length) throw new DiagramSyntaxError('节点标签缺少结束括号。', startLine)
  flush()
  return result
}

function labelText(value: string, warnings: Set<string>, statement?: Statement): string {
  let label = value.trim()
  if (label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1)
  label = label.replace(/\\([n"\\])/g, (_, character: string) => character === 'n' ? '\n' : character)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&quot;|#quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  if (/<[^>]+>/.test(label)) warnings.add('HTML 标签按纯文本显示；不执行 HTML 或脚本。')
  if (label.length > 2_000) throw new DiagramSyntaxError('单个标签不能超过 2,000 个字符。', statement?.line ?? 1)
  return label
}
function shape(id: string, text: string, kind: ShapeElement['shape'], x = 0, y = 0, width?: number, height?: number): ShapeElement {
  const lines = text.split('\n'), length = Math.max(1, ...lines.map(line => [...line].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : .58), 0)))
  const nodeWidth = width ?? Math.min(340, Math.max(kind === 'diamond' ? 180 : 150, length * 16 + 44))
  const contentWidth = kind === 'diamond' ? nodeWidth * .58 : nodeWidth - 30
  const contentLines = lines.reduce((n, line) => n + Math.max(1, Math.ceil([...line].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 1 : .58), 0) * 16 / contentWidth)), 0)
  return { id, type: 'shape', shape: kind, x, y, width: nodeWidth, height: height ?? Math.max(kind === 'diamond' ? 100 : 64, contentLines * 24 + 28), text, locked: false,
    style: style({ fill: kind === 'diamond' ? '#fff7dc' : kind === 'ellipse' ? '#e8f7ef' : kind === 'note' ? '#fff3b0' : '#eff6ff' }) }
}

interface NodeToken { id: string; text?: string; shape?: ShapeElement['shape']; classes?: string[]; start: number; end: number }
function readNode(statement: Statement, offset: number, warnings: Set<string>): NodeToken {
  const text = statement.text
  let cursor = offset
  while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++
  const tokenStart = cursor
  const match = text.slice(cursor).match(idAtStart)
  if (!match) fail('这里需要节点标识，例如 A[开始]。', statement, cursor + 1)
  const id = match![0]; cursor += id.length
  const complete = (token: NodeToken): NodeToken => {
    const suffix = text.slice(token.end).match(/^:::([A-Za-z0-9_\u0080-\uFFFF-]+(?:,[A-Za-z0-9_\u0080-\uFFFF-]+)*)/)
    return suffix ? { ...token, classes: suffix[1]!.split(','), end: token.end + suffix[0].length } : token
  }
  while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++
  if (text.startsWith('@{', cursor)) {
    let end = cursor + 2, quote = '', escaped = false
    for (; end < text.length; end++) {
      const char = text[end]!
      if (escaped) { escaped = false; continue }
      if (quote && char === '\\') { escaped = true; continue }
      if (quote) { if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === '}') break
    }
    if (end === text.length) fail('节点属性缺少右花括号。', statement, cursor + 1)
    const fields = new Map<string, string>()
    for (const part of commaParts(text.slice(cursor + 2, end), statement)) {
      const field = part.match(/^(shape|label)\s*:\s*(.+)$/)
      if (!field || fields.has(field[1]!)) fail('节点属性支持不重复的 shape 和 label。', statement)
      fields.set(field![1]!, field![2]!.trim().replace(/^['"]|['"]$/g, ''))
    }
    const aliases: Record<string, ShapeElement['shape']> = { rect: 'rectangle', rectangle: 'rectangle', rounded: 'rectangle', stadium: 'ellipse', circle: 'ellipse', ellipse: 'ellipse', diamond: 'diamond', decision: 'diamond', hex: 'hexagon', hexagon: 'hexagon', cyl: 'cylinder', cylinder: 'cylinder', database: 'cylinder', lean: 'parallelogram', parallelogram: 'parallelogram', triangle: 'triangle', cloud: 'cloud', star: 'star', note: 'note', text: 'text' }
    const name = fields.get('shape') ?? 'rect', kind = Object.hasOwn(aliases, name) ? aliases[name] : undefined
    if (!kind) fail(`暂不支持节点形状 ${name}。`, statement)
    if (name === 'rounded' || name === 'stadium') warnings.add('圆角矩形和体育场形分别使用矩形、椭圆近似显示。')
    return complete({ id, start: tokenStart, end: end + 1, shape: kind, text: labelText(fields.get('label') ?? id, warnings, statement) })
  }
  const forms: [string, string, ShapeElement['shape'], string?][] = [
    ['[(', ')]', 'cylinder'], ['[/', '/]', 'parallelogram'], ['[\\', '\\]', 'parallelogram', '反向平行四边形使用标准平行四边形显示。'],
    ['((', '))', 'ellipse'], ['([', '])', 'ellipse', '体育场形节点以椭圆表示。'],
    ['[[', ']]', 'rectangle', '子流程节点以普通矩形表示。'], ['{{', '}}', 'hexagon'],
    ['[', ']', 'rectangle'], ['(', ')', 'rectangle'], ['{', '}', 'diamond'],
  ]
  const form = forms.find(([open]) => text.startsWith(open, cursor))
  if (!form) return complete({ id, start: tokenStart, end: tokenStart + id.length })
  const [open, close, kind, warning] = form
  const start = cursor + open.length
  cursor = start
  let quoted = false, escaped = false
  while (cursor < text.length) {
    const c = text[cursor]!
    if (!quoted && text.startsWith(close, cursor)) {
      const value = text.slice(start, cursor)
      if (!value.trim()) fail('节点标签不能为空。', statement, start + 1)
      if (warning) warnings.add(warning)
      return complete({ id, shape: kind, text: labelText(value, warnings, statement), start: tokenStart, end: cursor + close.length })
    }
    if (escaped) escaped = false
    else if (c === '\\' && quoted) escaped = true
    else if (c === '"') quoted = !quoted
    else if (!quoted && /[\[\]{}()]/.test(c)) fail('标签含括号时请用双引号包围。', statement, cursor + 1)
    cursor++
  }
  return fail(`节点标签缺少“${close}”。`, statement, start + 1)
}

interface ArrowToken { start: number; end: number; arrow: EdgeElement['arrow']; dashed: boolean; thick: boolean; label: string; reverse?: boolean; invisible?: boolean; startMarker?: 'circle' | 'cross'; endMarker?: 'circle' | 'cross' }
function readArrow(statement: Statement, offset: number, warnings: Set<string>): ArrowToken {
  const rest = statement.text.slice(offset).trimStart(), start = statement.text.length - rest.length
  const direct = rest.match(/^(<-->|<==>|<-.->|o--o|x--x|--o|--x|<--|<==|-->|---|==>|===|-\.->|-\.-|~~~)/)
  let token: string, label = '', end: number
  if (direct) { token = direct[0]; end = start + token.length }
  else {
    const labelled = rest.match(/^(--|==|-\.)\s+(.+?)\s+(-->|---|==>|===|\.->|\.-)/)
    if (!labelled) return fail('不支持此连线或语法。支持 -->、---、-.->、==>、<--> 与带标签连线。', statement, start + 1)
    const head = labelled[1]!, tail = labelled[3]!
    if ((head === '--' && !tail.startsWith('--')) || (head === '==' && !tail.startsWith('==')) || (head === '-.' && !tail.startsWith('.'))) {
      return fail('连线两端的线型必须一致。', statement, start + 1)
    }
    token = head + tail; label = labelText(labelled[2]!, warnings, statement); end = start + labelled[0].length
  }
  while (/\s/.test(statement.text[end] || '') && end < statement.text.length) end++
  if (statement.text[end] === '|') {
    if (label) fail('一条连线只能使用一个标签。', statement, end + 1)
    let cursor = end + 1, quoted = false, escaped = false
    for (; cursor < statement.text.length; cursor++) {
      const c = statement.text[cursor]!
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === '"') quoted = !quoted
      if (c === '|' && !quoted) break
    }
    if (cursor === statement.text.length) fail('连线标签缺少结束的 |。', statement, end + 1)
    label = labelText(statement.text.slice(end + 1, cursor), warnings, statement); end = cursor + 1
  }
  return { start, end, label, arrow: token.startsWith('<') && token.endsWith('>') ? 'both' : token.endsWith('>') || token.startsWith('<') ? 'end' : 'none', reverse: token.startsWith('<') && !token.endsWith('>'), invisible: token === '~~~', startMarker: token.startsWith('o') ? 'circle' : token.startsWith('x') ? 'cross' : undefined, endMarker: token.endsWith('o') ? 'circle' : token.endsWith('x') ? 'cross' : undefined, dashed: token.includes('.'), thick: token.includes('=') }
}

type FlowDirection = 'TB' | 'LR' | 'RL' | 'BT'
interface FlowGroup { id: string; title: string; parent?: string; direction?: FlowDirection; statement: Statement }
function commaParts(input: string, statement: Statement): string[] {
  const parts: string[] = []; let start = 0, quote = '', escaped = false, depth = 0
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (escaped) { escaped = false; continue }
    if (quote && char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth++
    if (char === ')') depth--
    if (depth < 0) fail('参数括号不匹配。', statement)
    if (char === ',' && !depth) { parts.push(input.slice(start, i).trim()); start = i + 1 }
  }
  if (quote || depth) fail('参数引号或括号未闭合。', statement)
  parts.push(input.slice(start).trim())
  if (parts.some(part => !part)) fail('参数不能为空。', statement)
  return parts
}
function safeColor(input: string, statement: Statement): string {
  const color = input.trim().toLowerCase()
  const names = new Set(['none', 'transparent', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver', 'navy', 'teal', 'aqua', 'lime', 'maroon', 'olive'])
  if (names.has(color) || /^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/.test(color)) return color
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)$/)
  if (rgb && rgb.slice(1, 4).every(value => Number(value) <= 255) && (color.startsWith('rgba') ? rgb[4] !== undefined : rgb[4] === undefined)) return color
  return fail('颜色仅支持十六进制、常用颜色名、rgb() 和 rgba()；不允许 URL 或脚本。', statement)
}
function flowStyle(input: string, statement: Statement, warnings: Set<string>): Partial<ElementStyle> {
  const result: Partial<ElementStyle> = {}, seen = new Set<string>()
  for (const part of commaParts(input, statement)) {
    const pair = part.match(/^([\w-]+)\s*:\s*(.+)$/)
    if (!pair) fail('样式格式应为 属性:值，以逗号分隔。', statement)
    const key = pair![1]!, value = pair![2]!.trim()
    if (seen.has(key)) fail(`样式属性 ${key} 重复。`, statement)
    seen.add(key)
    if (key === 'fill' || key === 'stroke' || key === 'color') {
      result[key === 'color' ? 'stroke' : key] = safeColor(value, statement)
      if (key === 'color') warnings.add('图元文字与轮廓共用颜色；color 同时影响文字和轮廓。')
    } else if (key === 'stroke-width' || key === 'font-size' || key === 'opacity') {
      const match = value.match(/^(\d+(?:\.\d+)?)(px)?$/), amount = Number(match?.[1])
      const min = key === 'font-size' ? 8 : 0, max = key === 'opacity' ? 1 : key === 'font-size' ? 72 : 16
      if (!match || (key === 'opacity' && match[2]) || amount < min || amount > max) fail(`样式 ${key} 的数值应在 ${min}–${max} 之间。`, statement)
      result[key === 'stroke-width' ? 'strokeWidth' : key === 'font-size' ? 'fontSize' : 'opacity'] = amount
    } else if (key === 'stroke-dasharray') {
      if (value === '0' || value === 'none') { result.strokePattern = 'solid'; result.dashed = false }
      else if (/^\d+(?:\s+\d+)*$/.test(value) && value.split(/\s+/).every(n => Number(n) > 0 && Number(n) <= 100)) {
        result.strokePattern = Number(value.split(/\s+/)[0]) <= 2 ? 'dotted' : 'dashed'; result.dashed = true
        warnings.add('自定义虚线间距使用画布的点线或虚线样式，保留虚实线语义。')
      } else fail('stroke-dasharray 支持 none、0 或空格分隔的正数。', statement)
    } else if (key === 'text-align' && ['left', 'center', 'right'].includes(value)) result.textAlign = value as ElementStyle['textAlign']
    else fail(`暂不支持样式属性 ${key}。支持 fill、stroke、color、stroke-width、font-size、opacity、stroke-dasharray、text-align。`, statement)
  }
  return result
}

function layoutFlow(nodes: Map<string, ShapeElement>, edges: EdgeElement[], groups: Map<string, FlowGroup>, owners: Map<string, string>, direction: FlowDirection): Scene {
  if (!groups.size) return layoutScene({ elements: [...edges, ...nodes.values()], background: '#ffffff', grid: true }, direction)
  interface Placement { frame?: ShapeElement; elements: ShapeElement[] }
  function arrange(parent: string | undefined, inherited: FlowDirection): Placement {
    const group = parent ? groups.get(parent)! : undefined, localDirection = group?.direction ?? inherited
    const direct = [...nodes.entries()].filter(([id]) => owners.get(id) === parent).map(([, node]) => node)
    const children = [...groups.values()].filter(child => child.parent === parent).map(child => ({ id: child.id, placement: arrange(child.id, localDirection) }))
    const proxies = [...direct, ...children.map(child => child.placement.frame!)]
    const directIds = new Set(proxies.map(node => node.id))
    const representative = (sceneId: string): string | undefined => {
      if (directIds.has(sceneId)) return sceneId
      const raw = sceneId.slice('m-node-'.length)
      let owner = owners.get(raw) ?? groups.get(raw)?.parent
      for (let depth = 0; owner && depth <= 8; depth++) {
        if (directIds.has(`m-node-${owner}`)) return `m-node-${owner}`
        owner = groups.get(owner)?.parent
      }
      return undefined
    }
    const localEdges = edges.flatMap(edge => {
      const from = representative(edge.from.nodeId!), to = representative(edge.to.nodeId!)
      return from && to && from !== to ? [{ ...edge, from: { ...edge.from, nodeId: from }, to: { ...edge.to, nodeId: to } }] : []
    })
    const placed = layoutScene({ elements: [...localEdges, ...proxies], background: '#ffffff', grid: true }, localDirection).elements.filter((element): element is ShapeElement => element.type === 'shape')
    const elements: ShapeElement[] = []
    for (const node of placed) {
      const child = children.find(item => item.placement.frame!.id === node.id)
      if (child) {
        const old = child.placement.frame!, dx = node.x - old.x, dy = node.y - old.y
        elements.push(node, ...child.placement.elements.map(element => ({ ...element, x: element.x + dx, y: element.y + dy })))
      } else elements.push(node)
    }
    if (!group) return { elements }
    if (!elements.length) fail('子图至少需要一个节点或非空子图。', group.statement)
    const left = Math.min(...elements.map(node => node.x)) - 36, top = Math.min(...elements.map(node => node.y)) - 72
    const width = Math.max(...elements.map(node => node.x + node.width)) - left + 36, height = Math.max(...elements.map(node => node.y + node.height)) - top + 36
    const frame = shape(`m-node-${group.id}`, group.title, 'frame', left, top, width, height)
    frame.style = style({ fill: '#f8fafc', stroke: '#94a3b8', textAlign: 'left', dashed: true })
    return { frame, elements }
  }
  const arranged = arrange(undefined, direction).elements
  const frames = arranged.filter(node => node.shape === 'frame'), content = arranged.filter(node => node.shape !== 'frame')
  return { elements: [...frames, ...edges, ...content], background: '#ffffff', grid: true }
}

function compileFlow(statements: Statement[], direction: FlowDirection): CodeDiagramResult {
  const nodes = new Map<string, ShapeElement>(), edges: EdgeElement[] = [], warnings = new Set<string>()
  const groups = new Map<string, FlowGroup>(), owners = new Map<string, string>(), stack: string[] = [], explicit = new Set<string>()
  const classes = new Map<string, Partial<ElementStyle>>(), nodeClasses = new Map<string, { names: string[]; statement: Statement }>(), nodeStyles: { ids: string[]; style: Partial<ElementStyle>; statement: Statement }[] = []
  const edgeStyles: { indices?: number[]; style: Partial<ElementStyle>; statement: Statement }[] = []
  const sourceMap = new DiagramSourceMap()
  const markers = new Map<string, ArrowToken>()
  const addNode = (token: NodeToken, statement: Statement) => {
    if (groups.has(token.id)) { if (token.shape) fail('子图标识不能重新声明为普通节点。', statement) }
    else {
      const old = nodes.get(token.id)
      if (token.shape || !old) nodes.set(token.id, shape(`m-node-${token.id}`, token.text ?? token.id, token.shape ?? 'rectangle'))
      if (token.shape) explicit.add(token.id)
      if (stack.length && !owners.has(token.id)) owners.set(token.id, stack.at(-1)!)
    }
    if (token.classes?.length) nodeClasses.set(token.id, { names: [...(nodeClasses.get(token.id)?.names ?? []), ...token.classes], statement })
    sourceMap.range(statement.start + token.start, statement.start + token.end, `m-node-${token.id}`)
    if (nodes.size + groups.size > MAX_NODES) fail(`节点和子图合计不能超过 ${MAX_NODES} 个。`, statement)
  }
  for (const statement of statements) {
    let match: RegExpMatchArray | null
    if ((match = statement.text.match(/^subgraph\s+(.+)$/))) {
      const declaration = match[1]!.trim(), named = declaration.match(new RegExp(`^(${ID})\\s*\\[(.+)\\]$`))
      const id = named?.[1] ?? (new RegExp(`^${ID}$`).test(declaration) ? declaration : `group-${groups.size}`)
      if (groups.has(id) || explicit.has(id)) fail(`重复的子图或节点标识：${id}。`, statement)
      if (groups.size >= 64 || stack.length >= 8) fail('最多支持 64 个子图、8 层嵌套。', statement)
      const title = labelText(named?.[2] ?? declaration, warnings, statement)
      nodes.delete(id); owners.delete(id)
      groups.set(id, { id, title, parent: stack.at(-1), statement }); stack.push(id)
      sourceMap.range(statement.start, statement.end, `m-node-${id}`); continue
    }
    if (statement.text === 'end') { const id = stack.pop(); if (!id) fail('出现了多余的 end。', statement); sourceMap.range(statement.start, statement.end, `m-node-${id}`); continue }
    if ((match = statement.text.match(/^direction\s+(TD|TB|LR|RL|BT)$/))) {
      const value = (match[1] === 'TD' ? 'TB' : match[1]) as FlowDirection
      if (stack.length) groups.get(stack.at(-1)!)!.direction = value; else direction = value
      continue
    }
    if ((match = statement.text.match(new RegExp(`^classDef\\s+(${ID}(?:,${ID})*)\\s+(.+)$`)))) {
      const changes = flowStyle(match[2]!, statement, warnings)
      for (const name of match[1]!.split(',')) { if (classes.has(name)) fail(`样式类 ${name} 重复声明。`, statement); classes.set(name, changes) }
      continue
    }
    if ((match = statement.text.match(new RegExp(`^class\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s+(${ID}(?:,${ID})*)$`)))) {
      for (const id of match[1]!.split(/\s*,\s*/)) nodeClasses.set(id, { names: [...(nodeClasses.get(id)?.names ?? []), ...match[2]!.split(',')], statement })
      continue
    }
    if ((match = statement.text.match(new RegExp(`^style\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s+(.+)$`)))) {
      nodeStyles.push({ ids: match[1]!.split(/\s*,\s*/), style: flowStyle(match[2]!, statement, warnings), statement }); continue
    }
    if ((match = statement.text.match(/^linkStyle\s+(default|\d+(?:\s*,\s*\d+)*)\s+(.+)$/))) {
      edgeStyles.push({ indices: match[1] === 'default' ? undefined : match[1]!.split(/\s*,\s*/).map(Number), style: flowStyle(match[2]!, statement, warnings), statement }); continue
    }
    if (/^(?:subgraph|direction|style|classDef|class|click|linkStyle)\b/.test(statement.text)) fail('指令语法不正确；交互脚本和外部链接不受支持。', statement)
    let cursor = 0
    const readList = () => {
      const result: NodeToken[] = []
      while (true) {
        const token = readNode(statement, cursor, warnings); addNode(token, statement); result.push(token); cursor = token.end
        while (/\s/.test(statement.text[cursor] || '') && cursor < statement.text.length) cursor++
        if (statement.text[cursor] !== '&') break
        cursor++
      }
      return result
    }
    let previous = readList()
    while (statement.text.slice(cursor).trim()) {
      const arrow = readArrow(statement, cursor, warnings); cursor = arrow.end
      const next = readList(), ids: string[] = []
      if (edges.length + previous.length * next.length > MAX_EDGES) fail(`连线不能超过 ${MAX_EDGES} 条。`, statement)
      for (const from of previous) for (const to of next) {
        const id = `m-edge-${edges.length}`; ids.push(id)
        markers.set(id, arrow)
        edges.push({ id, type: 'edge', from: { nodeId: `m-node-${arrow.reverse ? to.id : from.id}`, x: 0, y: 0 }, to: { nodeId: `m-node-${arrow.reverse ? from.id : to.id}`, x: 0, y: 0 },
          label: arrow.label, arrow: arrow.arrow, route: 'orthogonal', style: style({ dashed: arrow.dashed, strokeWidth: arrow.thick ? 4 : 2, opacity: arrow.invisible ? 0 : 1 }), locked: false })
      }
      sourceMap.range(statement.start + arrow.start, statement.start + statement.text.slice(0, arrow.end).trimEnd().length, ...ids)
      previous = next
    }
  }
  if (stack.length) fail('子图缺少对应的 end。', groups.get(stack.at(-1)!)!.statement)
  if (!nodes.size) throw new DiagramSyntaxError('请至少添加一个节点，例如 A[开始] --> B[结束]。', 2)
  const apply = (node: ShapeElement, changes: Partial<ElementStyle>) => {
    node.style = { ...node.style, ...changes }

  }
  for (const [id, assignment] of nodeClasses) {
    if (!nodes.has(id) && !groups.has(id)) fail(`样式引用了未定义节点：${id}。`, assignment.statement)
    for (const name of assignment.names) if (!classes.has(name)) fail(`未定义样式类：${name}。`, assignment.statement)
  }
  for (const change of nodeStyles) for (const id of change.ids) if (!nodes.has(id) && !groups.has(id)) fail(`样式引用了未定义节点：${id}。`, change.statement)
  for (const [id, node] of nodes) {
    if (classes.has('default')) apply(node, classes.get('default')!)
    for (const name of nodeClasses.get(id)?.names ?? []) apply(node, classes.get(name)!)
    for (const change of nodeStyles) if (change.ids.includes(id)) apply(node, change.style)
    const ratio = Math.max(1, node.style.fontSize / 16); node.width *= ratio; node.height *= ratio
  }
  for (const change of edgeStyles) for (const index of change.indices ?? edges.map((_, index) => index)) {
    if (!edges[index]) fail(`linkStyle 引用了不存在的连线编号 ${index}。`, change.statement)
    edges[index]!.style = { ...edges[index]!.style, ...change.style }
  }
  const scene = layoutFlow(nodes, edges, groups, owners, direction)
  const groupBackgrounds: SceneElement[] = []
  for (const [id] of groups) {
    const frame = scene.elements.find((element): element is ShapeElement => element.type === 'shape' && element.id === `m-node-${id}`)!
    for (const name of nodeClasses.get(id)?.names ?? []) frame.style = { ...frame.style, ...classes.get(name)! }
    for (const change of nodeStyles) if (change.ids.includes(id)) frame.style = { ...frame.style, ...change.style }
    if (frame.style.fontSize > 32) fail('子图标题字号不能超过 32，以保留清晰的标题区域。', [...nodeStyles].reverse().find(change => change.ids.includes(id) && change.style.fontSize !== undefined)?.statement ?? nodeClasses.get(id)!.statement)
    groupBackgrounds.push({ id: `m-group-background-${id}`, type: 'stroke', points: [{ x: frame.x, y: frame.y }, { x: frame.x + frame.width, y: frame.y }, { x: frame.x + frame.width, y: frame.y + frame.height }, { x: frame.x, y: frame.y + frame.height }], closed: true, style: { ...frame.style, stroke: 'none', strokeWidth: 0, dashed: false, strokePattern: 'solid' }, locked: false })
  }
  scene.elements.unshift(...groupBackgrounds)
  for (const edge of scene.elements.filter((element): element is EdgeElement => element.type === 'edge')) {
    const arrow = markers.get(edge.id)!
    if (!arrow.startMarker && !arrow.endMarker) continue
    const points = edgePoints(edge, scene)
    for (const [side, marker] of [['start', arrow.startMarker], ['end', arrow.endMarker]] as const) if (marker) {
      const point = points[side === 'start' ? 0 : points.length - 1]!, id = `${edge.id}-${side}-marker`
      if (marker === 'circle') { const node = shape(id, '', 'ellipse', point.x - 5, point.y - 5, 10, 10); node.style = { ...edge.style, fill: '#ffffff' }; scene.elements.push(node) }
      else for (const sign of [-1, 1]) scene.elements.push({ id: `${id}-${sign}`, type: 'stroke', points: [{ x: point.x - 6, y: point.y - sign * 6 }, { x: point.x + 6, y: point.y + sign * 6 }], style: { ...edge.style, fill: 'none' }, locked: false })
    }
    warnings.add('圆形和交叉连线端标是静态图元；创建可编辑副本后移动节点不会自动重算端标位置。')
  }
  if (scene.elements.length > 3500) throw new DiagramSyntaxError('图表过于复杂，请减少节点或连线端标。', 1)
  return { kind: 'flowchart', scene, warnings: [...warnings], sourceMap: sourceMap.entries(scene.elements) }
}

interface Participant { id: string; name: string; actor: boolean; lines: number[] }
interface SequenceFragment { id: string; kind: string; text: string; line: number; depth: number; color?: string }
type SequenceItem = { line: number; type: 'message'; from: string; to: string; text: string; dashed: boolean; arrow: EdgeElement['arrow']; number?: number; activate?: boolean; deactivate?: boolean; cross?: boolean }
  | { line: number; type: 'note'; side: 'left of' | 'right of' | 'over'; ids: string[]; text: string }
  | { line: number; type: 'activate' | 'deactivate'; participant: string; color?: string }
  | { line: number; type: 'open' | 'close' | 'branch'; fragment: SequenceFragment; text?: string }
function compileSequence(statements: Statement[]): CodeDiagramResult {
  const participants = new Map<string, Participant>(), items: SequenceItem[] = [], warnings = new Set<string>(), sourceMap = new DiagramSourceMap(statements)
  const fragments: SequenceFragment[] = [], fragmentStack: SequenceFragment[] = [], active = new Map<string, number[]>()
  let number: number | undefined, increment = 1, pausedNumber: number | undefined, title = '', titleLine = 0
  const ensure = (id: string, statement: Statement) => {
    if (!participants.has(id)) participants.set(id, { id, name: id, actor: false, lines: [] })
    if (participants.size > 40) fail('时序图最多支持 40 个参与者。', statement)
  }
  const changeActivation = (id: string, open: boolean, statement: Statement) => {
    const stack = active.get(id) ?? []
    if (open) { if (stack.length >= 16) fail('同一参与者的激活嵌套最多 16 层。', statement); stack.push(statement.line) }
    else if (!stack.pop()) fail(`参与者 ${id} 没有可结束的激活区。`, statement)
    active.set(id, stack)
  }
  for (const statement of statements) {
    if (items.length >= MAX_EDGES * 2) fail(`时序图最多支持 ${MAX_EDGES * 2} 个事件。`, statement)
    let match: RegExpMatchArray | null
    const declaration = statement.text.match(new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`))
    if (declaration) {
      ensure(declaration[2]!, statement)
      participants.set(declaration[2]!, { id: declaration[2]!, name: labelText(declaration[3] ?? declaration[2]!, warnings, statement), actor: declaration[1] === 'actor', lines: [...participants.get(declaration[2]!)!.lines, statement.line] })
      continue
    }
    if ((match = statement.text.match(/^title\s+(.+)$/))) { if (title || items.length) fail('标题请在事件之前声明一次。', statement); title = labelText(match[1]!, warnings, statement); titleLine = statement.line; continue }
    const auto = statement.text.match(/^autonumber(?:\s+(\d+)(?:\s+(\d+))?)?$/)
    if (auto) { number = Number(auto[1] ?? 1); increment = Number(auto[2] ?? 1); pausedNumber = undefined; if (!increment || number > 1_000_000 || increment > 1_000_000) fail('编号和步长必须在 1,000,000 以内，步长必须大于 0。', statement); continue }
    if (statement.text === 'autonumber off') { pausedNumber = number; number = undefined; continue }
    if (statement.text === 'autonumber resume') { if (pausedNumber === undefined) fail('autonumber resume 之前需要暂停一个已开启的编号。', statement); number = pausedNumber; pausedNumber = undefined; continue }
    if ((match = statement.text.match(/^(loop|alt|opt|par|critical|break|rect)(?:\s+(.+))?$/))) {
      if (fragmentStack.length >= 8 || fragments.length >= 80) fail('时序片段最多支持 8 层嵌套、80 个片段。', statement)
      const fragment: SequenceFragment = { id: `m-seq-fragment-${fragments.length}`, kind: match[1]!, text: labelText(match[2] ?? '', warnings, statement), line: statement.line, depth: fragmentStack.length }
      if (fragment.kind === 'rect') { if (!match[2]) fail('rect 需要安全的背景颜色。', statement); fragment.color = safeColor(match[2], statement); fragment.text = '' }
      fragments.push(fragment); fragmentStack.push(fragment); items.push({ type: 'open', fragment, line: statement.line }); continue
    }
    if ((match = statement.text.match(/^(else|and|option)(?:\s+(.+))?$/))) {
      const fragment = fragmentStack.at(-1)
      if (!fragment || !({ else: ['alt'], and: ['par'], option: ['critical'] } as Record<string, string[]>)[match[1]!]!.includes(fragment.kind)) fail(`${match[1]} 必须位于对应的 alt、par 或 critical 片段中。`, statement)
      items.push({ type: 'branch', fragment: fragment!, text: labelText(match[2] ?? match[1]!, warnings, statement), line: statement.line }); continue
    }
    if (statement.text === 'end') { const fragment = fragmentStack.pop(); if (!fragment) fail('出现了多余的 end。', statement); items.push({ type: 'close', fragment: fragment!, line: statement.line }); continue }
    if ((match = statement.text.match(new RegExp(`^(activate|deactivate)\\s+(${ID})(?:\\s+(.+))?$`)))) {
      ensure(match[2]!, statement)
      if (match[1] === 'deactivate' && match[3]) fail('deactivate 后不接受颜色参数。', statement)
      changeActivation(match[2]!, match[1] === 'activate', statement)
      items.push({ type: match[1] as 'activate' | 'deactivate', participant: match[2]!, color: match[3] ? safeColor(match[3], statement) : undefined, line: statement.line }); continue
    }
    const note = statement.text.match(new RegExp(`^Note\\s+(left of|right of|over)\\s+(${ID})(?:\\s*,\\s*(${ID}))?\\s*:\\s*(.+)$`, 'i'))
    if (note) {
      const side = note[1]!.toLowerCase() as 'left of' | 'right of' | 'over'
      if (side !== 'over' && note[3]) fail('left of / right of 注释只能指定一个参与者。', statement)
      const ids = [note[2]!, ...(note[3] ? [note[3]] : [])]; ids.forEach(id => ensure(id, statement))
      items.push({ line: statement.line, type: 'note', side, ids, text: labelText(note[4]!, warnings, statement) }); continue
    }
    const message = statement.text.match(new RegExp(`^(${ID})\\s*(<<-->>|<<->>|-->>|->>|--x|-x|--\\)|-\\)|-->|->)\\s*([+-])?\\s*(${ID})\\s*:\\s*(.*)$`))
    if (message) {
      const from = message[1]!, to = message[4]!, token = message[2]!
      ensure(from, statement); ensure(to, statement)
      if (message[3] === '+') changeActivation(to, true, statement)
      if (message[3] === '-') changeActivation(from, false, statement)
      items.push({ line: statement.line, type: 'message', from, to, dashed: token.includes('--'), arrow: token.endsWith('x') ? 'none' : token.startsWith('<') ? 'both' : 'end', text: labelText(message[5]!, warnings, statement), number, activate: message[3] === '+', deactivate: message[3] === '-', cross: token.endsWith('x') })
      if (token.includes('>>') || token.endsWith(')')) warnings.add('消息箭头使用开放式箭头；实线、虚线、双向和取消标记分别保留。')
      if (number !== undefined) { if (number > 1_000_000) fail('自动编号超过 1,000,000，请重新设置起点。', statement); number += increment }
      if (items.filter(item => item.type === 'message').length > MAX_EDGES) fail(`时序图最多支持 ${MAX_EDGES} 条消息。`, statement)
      continue
    }
    fail('暂不支持此时序语法。支持参与者、消息、注释、激活、编号和 loop/alt/opt/par/critical/break/rect 片段；创建/销毁参与者及交互脚本暂不支持。', statement)
  }
  if (fragmentStack.length) throw new DiagramSyntaxError('时序片段缺少对应的 end。', fragmentStack.at(-1)!.line)
  for (const [id, stack] of active) if (stack.length) throw new DiagramSyntaxError(`参与者 ${id} 的激活区未结束。`, stack.at(-1)!)
  if (!participants.size) throw new DiagramSyntaxError('请添加参与者或消息，例如 A->>B: 你好。', 2)
  const elements: SceneElement[] = [], list = [...participants.values()], centers = new Map(list.map((person, i) => [person.id, 160 + i * 260]))
  const backgrounds: ShapeElement[] = [], activationElements: ShapeElement[] = [], openFragments = new Map<string, ShapeElement>(), fragmentDecorations = new Map<string, SceneElement[]>(), activationStacks = new Map<string, ShapeElement[]>()
  const titleOffset = title ? 64 : 0
  let y = 150 + titleOffset, counter = 0, activationCount = 0
  const edge = (x1: number, y1: number, x2: number, y2: number, dashed: boolean, arrow: EdgeElement['arrow']) => {
    elements.push({ id: `m-seq-edge-${counter++}`, type: 'edge', from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, label: '', arrow, route: 'straight', style: style({ dashed }), locked: false })
  }
  const openActivation = (participant: string, line: number, at: number, color = '#dbeafe') => {
    const stack = activationStacks.get(participant) ?? [], node = shape(`m-seq-activation-${activationCount++}`, '', 'rectangle', centers.get(participant)! - 7 + stack.length * 7, at, 14, 16)
    node.style = style({ fill: color, stroke: '#2563eb', strokeWidth: 1 }); stack.push(node); activationStacks.set(participant, stack); activationElements.push(node); sourceMap.add(line, node.id)
  }
  const closeActivation = (participant: string, line: number, at: number) => { const node = activationStacks.get(participant)!.pop()!; node.height = Math.max(16, at - node.y); sourceMap.add(line, node.id) }
  for (const item of items) {
    const firstElement = elements.length
    if (item.type === 'open') {
      const fragment = item.fragment, inset = fragment.depth * 16
      const frame = shape(fragment.id, '', 'rectangle', 25 + inset, y - 12, Math.max(300, (list.length - 1) * 260 + 270) - inset * 2, 70)
      frame.style = style({ fill: fragment.color ?? 'none', stroke: '#64748b', strokeWidth: fragment.kind === 'rect' ? 1 : 1.5, opacity: fragment.kind === 'rect' ? .3 : 1 })
      backgrounds.push(frame); openFragments.set(fragment.id, frame); fragmentDecorations.set(fragment.id, [])
      if (fragment.kind !== 'rect') {
        const heading = shape(`${fragment.id}-title`, `${fragment.kind}  ${fragment.text}`, 'text', frame.x + 10, y - 6, frame.width - 20, 34)
        heading.style = style({ fill: 'none', textAlign: 'left', fontSize: 14 }); elements.push(heading); fragmentDecorations.get(fragment.id)!.push(heading)
      }
      sourceMap.add(item.line, frame.id); sourceMap.capture(item.line, elements, firstElement); y += fragment.kind === 'rect' ? 22 : 48; continue
    }
    if (item.type === 'branch') {
      const frame = openFragments.get(item.fragment.id)!
      const id = `m-seq-branch-${counter++}`
      elements.push({ id, type: 'edge', from: { x: frame.x, y }, to: { x: frame.x + frame.width, y }, label: '', arrow: 'none', route: 'straight', style: style({ dashed: true, stroke: '#94a3b8', strokeWidth: 1 }), locked: false })
      const heading = shape(`${id}-label`, item.text ?? '', 'text', frame.x + 12, y + 7, frame.width - 24, 32); heading.style = style({ fill: 'none', textAlign: 'left', fontSize: 14 }); elements.push(heading)
      fragmentDecorations.get(item.fragment.id)!.push(...elements.slice(firstElement))
      sourceMap.capture(item.line, elements, firstElement); y += 56; continue
    }
    if (item.type === 'close') { const frame = openFragments.get(item.fragment.id)!; frame.height = Math.max(70, y - frame.y); sourceMap.add(item.line, frame.id); openFragments.delete(item.fragment.id); y += 25; continue }
    if (item.type === 'activate') { openActivation(item.participant, item.line, y - 12, item.color); y += 10; continue }
    if (item.type === 'deactivate') { closeActivation(item.participant, item.line, y - 20); y += 8; continue }
    if (item.type === 'note') {
      const first = centers.get(item.ids[0]!)!, last = centers.get(item.ids[1] ?? item.ids[0]!)!, width = item.ids.length === 2 ? Math.abs(last - first) + 160 : 190
      const note = shape(`m-seq-note-${counter++}`, item.text, 'note', item.side === 'left of' ? first - width - 16 : item.side === 'right of' ? first + 16 : Math.min(first, last) - width / 2 + Math.abs(last - first) / 2, y - 12, width)
      elements.push(note); sourceMap.capture(item.line, elements, firstElement); y += note.height + 35; continue
    }
    if (item.type !== 'message') continue
    const from = centers.get(item.from)!, to = centers.get(item.to)!, self = from === to
    const label = shape(`m-seq-label-${counter++}`, `${item.number === undefined ? '' : `${item.number}. `}${item.text}`, 'text', Math.min(from, to) + (self ? 18 : 8), y - 16, self ? 190 : Math.max(180, Math.abs(to - from) - 16))
    label.height = Math.max(36, item.text.split('\n').length * 24 + Math.ceil(item.text.length * 10 / label.width) * 22)
    label.style = style({ fill: 'none', strokeWidth: 0, textAlign: self ? 'left' : 'center' })
    const messageY = y + label.height - 10
    elements.push(label)
    if (item.activate) openActivation(item.to, item.line, messageY)
    if (self) {
      edge(from, messageY, from + 76, messageY, item.dashed, 'none')
      edge(from + 76, messageY, from + 76, messageY + 32, item.dashed, 'none')
      edge(from + 76, messageY + 32, from, messageY + 32, item.dashed, item.arrow)
      y = messageY + 82
    } else { edge(from, messageY, to, messageY, item.dashed, item.arrow); y = messageY + 58 }
    if (item.cross) for (const sign of [-1, 1]) elements.push({ id: `m-seq-cross-${counter++}`, type: 'stroke', points: [{ x: to - 6, y: messageY + (self ? 32 : 0) - sign * 6 }, { x: to + 6, y: messageY + (self ? 32 : 0) + sign * 6 }], style: style({ fill: 'none' }), locked: false })
    if (item.deactivate) closeActivation(item.from, item.line, messageY + (self ? 32 : 0))
    sourceMap.capture(item.line, elements, firstElement)
  }
  const headers: SceneElement[] = [], lifelines: SceneElement[] = []
  if (title) { const heading = shape('m-seq-title', title, 'text', 40, 8, Math.max(500, list.length * 260), 48); heading.style = style({ fill: 'none', fontSize: 25, textAlign: 'left' }); headers.push(heading); sourceMap.add(titleLine, heading.id) }
  for (const person of list) {
    const firstHeader = headers.length
    const center = centers.get(person.id)!
    lifelines.push({ id: `m-seq-life-${person.id}`, type: 'edge', from: { x: center, y: 112 + titleOffset }, to: { x: center, y: y + 16 }, label: '', arrow: 'none', route: 'straight', style: style({ dashed: true, stroke: '#94a3b8', strokeWidth: 1 }), locked: false })
    if (person.actor) {
      const head = shape(`m-seq-head-${person.id}`, '', 'ellipse', center - 12, 16 + titleOffset, 24, 24); head.style = style({ fill: '#ffffff' }); headers.push(head)
      for (const [index, points] of [ [{ x: center, y: 40 }, { x: center, y: 69 }], [{ x: center - 23, y: 51 }, { x: center + 23, y: 51 }], [{ x: center - 19, y: 88 }, { x: center, y: 69 }, { x: center + 19, y: 88 }] ].entries()) headers.push({ id: `m-seq-actor-${person.id}-${index}`, type: 'stroke', points: points.map(point => ({ ...point, y: point.y + titleOffset })), style: style({ fill: 'none' }), locked: false })
      const name = shape(`m-seq-name-${person.id}`, person.name, 'text', center - 100, 88 + titleOffset, 200, 28); name.style = style({ fill: 'none' }); headers.push(name)
    } else headers.push(shape(`m-seq-participant-${person.id}`, person.name, 'rectangle', center - 90, 40 + titleOffset, 180, 64))
    headers.push(shape(`m-seq-footer-${person.id}`, person.name, 'rectangle', center - 90, y + 16, 180, 56))
    for (const line of person.lines) { sourceMap.capture(line, headers, firstHeader); sourceMap.add(line, `m-seq-life-${person.id}`) }
  }
  if (backgrounds.length) {
    const maxDepth = Math.max(...fragments.map(fragment => fragment.depth))
    const left = Math.min(25, ...elements.filter((element): element is ShapeElement => element.type === 'shape').map(node => node.x - 18)) - maxDepth * 16
    const right = Math.max(list.length * 260 + 25, ...elements.filter((element): element is ShapeElement => element.type === 'shape').map(node => node.x + node.width + 18)) + maxDepth * 16
    for (const frame of backgrounds) {
      const depth = fragments.find(fragment => fragment.id === frame.id)!.depth
      frame.x = left + depth * 16; frame.width = right - left - depth * 32
      for (const decoration of fragmentDecorations.get(frame.id) ?? []) {
        if (decoration.type === 'shape') { decoration.x = frame.x + 12; decoration.width = frame.width - 24 }
        else if (decoration.type === 'edge') { decoration.from.x = frame.x; decoration.to.x = frame.x + frame.width }
      }
    }
  }

  const scene: Scene = { elements: [...backgrounds, ...lifelines, ...activationElements, ...elements, ...headers], background: '#ffffff', grid: false }
  if (scene.elements.length > 3500) throw new DiagramSyntaxError('图表过于复杂，请减少消息或片段。', 1)
  return { kind: 'sequence', scene, warnings: [...warnings], sourceMap: sourceMap.entries(scene.elements) }
}

function compileNormalized(source: string): CodeDiagramResult {
  if (typeof source !== 'string') throw new DiagramSyntaxError('源码必须是文本。', 1)
  if (source.length > 200_000) throw new DiagramSyntaxError('源码不能超过 200,000 个字符。', 1)
  // Sequence message text may contain punctuation/brackets, so only flowcharts use bracket-aware splitting.
  const normalized = source
  const first = normalized.split('\n').find(line => line.trim() && !/^\s*%%(?!\{)/.test(line))?.trim()
  if (!first) throw new DiagramSyntaxError('请输入图表源码，或从模板库选择一种图表。', 1)
  const extended = compileStructureDiagram(normalized) ?? compileChartDiagram(normalized) ?? compilePlanningDiagram(normalized)
  if (extended) return extended
  if (first === 'sequenceDiagram' || /^sequenceDiagram\s*%%(?!\{)/.test(first)) {
    const lines = sourceLines(normalized).map(entry => {
      if (/^\s*%%\{/.test(entry.text)) throw new DiagramSyntaxError('暂不支持图表初始化指令。', entry.line)
      const start = entry.start + entry.text.length - entry.text.trimStart().length
      return { ...entry, text: entry.text.trim(), start }
    })
    return compileSequence(lines.slice(1))
  }
  const parts = statements(normalized), header = parts.shift()
  if (!header) throw new DiagramSyntaxError('请添加图表类型。', 1)
  const flow = header.text.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)$/)
  if (!flow) fail('不支持此图表声明，请从图表模板库选择支持的类型。', header)
  return compileFlow(parts, flow![1] === 'TD' ? 'TB' : flow![1] as 'TB' | 'LR' | 'RL' | 'BT')
}

/** Normalize line endings once and translate metadata back to the original editor buffer. */
export function compileCodeDiagram(source: string): CodeDiagramResult {
  if (typeof source !== 'string') throw new DiagramSyntaxError('源码必须是文本。', 1)
  if (source.length > 200_000) throw new DiagramSyntaxError('源码不能超过 200,000 个字符。', 1)
  if (!source.startsWith('\uFEFF') && !source.includes('\r')) return compileNormalized(source)
  const offsets: number[] = [], characters: string[] = []
  for (let i = source.startsWith('\uFEFF') ? 1 : 0; i < source.length; i++) {
    offsets.push(i)
    if (source[i] === '\r') { characters.push('\n'); if (source[i + 1] === '\n') i++ }
    else characters.push(source[i]!)
  }
  offsets.push(source.length)
  const result = compileNormalized(characters.join(''))
  result.sourceMap = result.sourceMap.map(range => ({ ...range, start: offsets[range.start]!, end: offsets[range.end]! }))
  return result
}
