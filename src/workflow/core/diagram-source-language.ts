import { diagramHasBlockBraces, hashCommentStart, isDiagramPipeLabelStart } from './diagrams/comments.ts'

export type DiagramTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'punctuation' | 'variableName' | 'typeName' | 'attributeName' | 'atom'
export interface DiagramLexState { multiline: boolean; blockBraces: boolean; quote: string; labelOpen: string; labelClose: string; labelDepth: number }
export const createDiagramLexState = (multiline = false): DiagramLexState => ({ multiline, blockBraces: false, quote: '', labelOpen: '', labelClose: '', labelDepth: 0 })
export interface DiagramToken { from: number; to: number; kind: DiagramTokenKind | null }
const keywords = new Set(`flowchart graph sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram gitGraph pie gantt xychart xychart-beta quadrantChart mindmap timeline journey kanban requirementDiagram C4Context C4Container C4Component architecture architecture-beta sankey sankey-beta radar radar-beta treemap treemap-beta block block-beta packet packet-beta
subgraph end direction class classDef style linkStyle click participant actor as activate deactivate create destroy autonumber loop alt else opt par and critical option break rect box Note note over left right of namespace state fork join choice
requirement functionalRequirement interfaceRequirement performanceRequirement physicalRequirement designConstraint element satisfies verifies refines traces contains copies derives service group junction in columns space section title accTitle accDescr dateFormat axisFormat excludes includes todayMarker tickInterval weekday weekend after until milestone crit done active showData x-axis y-axis bar line horizontal vertical quadrant-1 quadrant-2 quadrant-3 quadrant-4 commit branch checkout switch merge cherry-pick order id tag type parent main name value color fill stroke opacity label shape radius icon
Person Person_Ext System System_Ext SystemDb SystemDb_Ext SystemQueue Container ContainerDb ContainerQueue Container_Ext Component ComponentDb ComponentQueue Component_Ext Boundary System_Boundary Container_Boundary Enterprise_Boundary Rel BiRel Rel_U Rel_D Rel_L Rel_R UpdateLayoutConfig UpdateElementStyle UpdateRelStyle`.split(/\s+/))
const atoms = new Set(['LR', 'RL', 'TB', 'TD', 'BT', 'true', 'false', 'null', 'PK', 'FK', 'UK', 'NORMAL', 'REVERSE', 'HIGHLIGHT'])

/** A deliberately tolerant lexer: incomplete source remains editable and colored. */
export function tokenizeDiagramLine(line: string, preserveProtectedMembers = false, state = createDiagramLexState()): DiagramToken[] {
  if (!state.multiline) { state.quote = ''; state.labelOpen = ''; state.labelClose = ''; state.labelDepth = 0 }
  if (!state.quote && !state.labelClose && diagramHasBlockBraces(line)) state.blockBraces = true
  const tokens: DiagramToken[] = []
  let hash = hashCommentStart(line, preserveProtectedMembers, state.blockBraces || preserveProtectedMembers), continued = Boolean(state.labelClose || state.quote)
  let pos = 0
  const add = (to: number, kind: DiagramTokenKind | null) => { tokens.push({ from: pos, to, kind }); pos = to }
  while (pos < line.length) {
    if (state.labelClose || state.quote) {
      const start = pos
      while (pos < line.length) {
        const c = line[pos]!
        if (state.quote) {
          if (c === '\\') { pos = Math.min(pos + 2, line.length); continue }
          if (c === state.quote) { state.quote = ''; pos++; if (!state.labelClose) break; continue }
        } else if (c === '"' || (c === "'" && !/[\p{L}\p{N}]/u.test(line[pos - 1] ?? '') && line.indexOf("'", pos + 1) >= 0)) state.quote = c
        else if (c === state.labelOpen && state.labelOpen !== '|') state.labelDepth++
        else if (c === state.labelClose) { state.labelDepth--; if (!state.labelDepth) break }
        pos++
      }
      if (pos > start) tokens.push({ from: start, to: pos, kind: 'string' })
      if (state.labelClose && !state.labelDepth) { add(pos + 1, 'punctuation'); state.labelClose = ''; state.labelOpen = '' }
      // The prefix may close a quote opened on a previous line. It no longer
      // participates in comment scanning on the remainder of this line.
      if (continued && !state.labelClose && !state.quote) { hash = hashCommentStart('x'.repeat(pos) + line.slice(pos), preserveProtectedMembers, state.blockBraces || preserveProtectedMembers); continued = false }
      continue
    }
    const rest = line.slice(pos), character = line[pos]!
    if (pos === hash || rest.startsWith('%%')) { add(line.length, 'comment'); break }
    const whitespace = rest.match(/^\s+/)
    if (whitespace) { add(pos + whitespace[0].length, null); continue }
    if (character === '"' || (character === "'" && !/[\p{L}\p{N}]/u.test(line[pos - 1] ?? '') && line.indexOf("'", pos + 1) >= 0)) {
      state.quote = character; add(pos + 1, 'string'); continue
    }
    // Node labels may contain #, %% and words that are also language keywords.
    const previous = tokens.at(-1)
    const labelClose = character === '[' && !/^\[\s*[-+\d.]/.test(rest) ? ']'
      : character === '(' && (previous?.kind === 'variableName' || previous?.kind === 'typeName') ? ')'
      : character === '{' && !state.blockBraces && !preserveProtectedMembers && (previous?.kind === 'variableName' || previous?.kind === 'typeName') && rest.includes('}') ? '}'
      : character === '|' && isDiagramPipeLabelStart(line, pos) ? '|' : ''
    if (labelClose) {
      state.labelOpen = character; state.labelClose = labelClose; state.labelDepth = 1
      add(pos + 1, 'punctuation'); continue
    }
    const color = rest.match(/^#[\da-fA-F]{3,8}\b/)
    if (color) { add(pos + color[0].length, 'atom'); continue }
    const arrow = rest.match(/^(?:<<-->>|<-->|<==>|<-.->|-->>|->>|--x|--o|o--o|x--x|-->|---|==>|===|-\.->|-\.-|\.\.>|--|->|<\|--|\*--|o--|\|\|--o\{|:::)/)
    if (arrow) { add(pos + arrow[0].length, 'operator'); continue }
    const number = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:%|px|ms|[dhmsw])?\b/)
    if (number) { add(pos + number[0].length, 'number'); continue }
    const word = rest.match(/^[\p{L}_][\p{L}\p{N}_]*(?:[-.][\p{L}\p{N}_]+)*/u)
    if (word) {
      const value = word[0], next = rest.slice(value.length)
      const kind = keywords.has(value) ? 'keyword' : atoms.has(value) ? 'atom' : /^\s*:/.test(next) ? 'attributeName' : /^[A-Z][a-z]/.test(value) ? 'typeName' : 'variableName'
      add(pos + value.length, kind); continue
    }
    add(pos + 1, /[+*=<>!&|~-]/.test(character) ? 'operator' : 'punctuation')
  }
  return tokens
}

export function tokenizeDiagramSource(source: string): Array<{ text: string; kind: DiagramTokenKind | null }> {
  let protectedMembers = false
  const state = createDiagramLexState()
  return source.split(/(\r\n|\r|\n)/).flatMap((line, index) => {
    if (index % 2) return [{ text: line, kind: null }]
    if (!state.quote && !state.labelClose && /^\s*(flowchart|graph)\b/.test(line)) state.multiline = true
    if (!state.quote && !state.labelClose && /^\s*classDiagram\b/.test(line)) protectedMembers = true
    return tokenizeDiagramLine(line, protectedMembers, state).map(token => ({ text: line.slice(token.from, token.to), kind: token.kind }))
  })
}

export interface DiagramFold { lineStart: number; from: number; to: number }
/** Offsets use CodeMirror's LF document. Explicit blocks, sections and trees fold. */
export function diagramFoldRanges(source: string): DiagramFold[] {
  let offset = 0, protectedMembers = false
  const state = createDiagramLexState()
  const lines = source.split('\n').map(text => {
    if (!state.quote && !state.labelClose && /^\s*(flowchart|graph)\b/.test(text)) state.multiline = true
    if (!state.quote && !state.labelClose && /^\s*classDiagram\b/.test(text)) protectedMembers = true
    const tokens = tokenizeDiagramLine(text, protectedMembers, state)
    const code = tokens.map(token => token.kind === 'comment' ? ' '.repeat(token.to - token.from) : token.kind === 'string' ? 'x' + ' '.repeat(token.to - token.from - 1) : text.slice(token.from, token.to)).join('')
    const entry = { start: offset, end: offset + text.length, code: code.trim(), indent: text.match(/^\s*/)?.[0].replaceAll('\t', '  ').length ?? 0 }
    offset += text.length + 1
    return entry
  })
  const ranges = new Map<number, DiagramFold>(), stack: Array<{ index: number; close: 'end' | '}' }> = []
  const add = (start: number, end: number, includeClosing = false) => {
    const first = lines[start]!, last = lines[end]!
    const to = includeClosing ? last.end : last.start - 1
    if (to > first.end) ranges.set(first.start, { lineStart: first.start, from: first.end, to })
  }
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i]!.code
    if (/^(?:end\b|}\s*;?$)/.test(code)) {
      const close = code.startsWith('end') ? 'end' : '}'
      if (stack.at(-1)?.close === close) add(stack.pop()!.index, i)
    } else if (/^(?:subgraph|loop|alt|opt|par|critical|break|rect|box|block)(?:\s|:|$)/.test(code)) stack.push({ index: i, close: 'end' })
    else if (code.endsWith('{') && !/\{.*\}/.test(code) && !/[|o]-+o?\{$/.test(code)) stack.push({ index: i, close: '}' })
  }
  // A stack keeps deeply nested trees linear in document size on each edit.
  const indents: number[] = []
  let previous = -1, section = -1
  const finishIndent = () => {
    const index = indents.pop()!
    if (previous > index && !ranges.has(lines[index]!.start)) add(index, previous, true)
  }
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i]!
    if (!entry.code) continue
    while (indents.length && lines[indents.at(-1)!]!.indent >= entry.indent) finishIndent()
    if (/^section\s/.test(entry.code)) {
      if (section >= 0 && previous > section) add(section, previous, true)
      section = i
    }
    if (!/^(?:end\b|})/.test(entry.code)) indents.push(i)
    previous = i
  }
  while (indents.length) finishIndent()
  if (section >= 0 && previous > section) add(section, previous, true)
  return [...ranges.values()].sort((a, b) => a.from - b.from)
}

/** Translate LF editor positions to the untouched original source, including CRLF. */
export function sourceCoordinates(source: string) {
  const offsets = [0]
  let normalized = ''
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r') { normalized += '\n'; if (source[i + 1] === '\n') i++ }
    else normalized += source[i]
    offsets.push(i + 1)
  }
  return {
    normalized,
    toRaw(position: number) { return offsets[Math.max(0, Math.min(position, offsets.length - 1))]! },
    toEditor(position: number) {
      let low = 0, high = offsets.length - 1
      while (low < high) { const middle = (low + high + 1) >> 1; if (offsets[middle]! <= position) low = middle; else high = middle - 1 }
      return low
    },
  }
}
