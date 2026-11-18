import type { ElementStyle } from './types.ts'
import { DiagramSyntaxError } from './diagrams/common.ts'

/** Mermaid entity styles are authored in source and apply to the whole table. */
export interface EREntityStyle {
  fill?: string
  stroke?: string
  strokeWidth?: number
  color?: string
  fontSize?: number
  fontWeight?: ElementStyle['fontWeight']
  fontStyle?: ElementStyle['fontStyle']
  opacity?: number
  strokePattern?: ElementStyle['strokePattern']
  dashed?: boolean
}
export interface ResolvedERStyle { style: EREntityStyle; lines: number[] }
export const ER_STYLE_ID = '[\\p{L}_][\\p{L}\\p{N}_-]*'
const ID_LIST = `${ER_STYLE_ID}(?:\\s*,\\s*${ER_STYLE_ID})*`
const list = (value: string): string[] => value.split(',').map(id => id.trim())
function fail(message: string, line: number): never { throw new DiagramSyntaxError(message, line) }

function properties(value: string, line: number): string[] {
  const parts: string[] = []; let part = '', depth = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === '\\' && value[index + 1] === ',') { part += ','; index++; continue }
    if (char === '(') depth++
    if (char === ')') depth--
    if (depth < 0) fail('样式括号未匹配。', line)
    if (char === ',' && depth === 0) { parts.push(part.trim()); part = '' } else part += char
  }
  if (depth) fail('样式括号未闭合。', line)
  parts.push(part.trim())
  if (parts.some(part => !part)) fail('样式属性不能为空。', line)
  return parts
}
function color(value: string, line: number): string {
  const parsed = value.toLowerCase()
  if (/^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|none|transparent|black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|aqua|cyan|magenta|lime|maroon|olive)$/.test(parsed)) return parsed
  const rgb = parsed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)$/)
  if (rgb && rgb.slice(1, 4).every(channel => Number(channel) <= 255) && (parsed.startsWith('rgba') ? rgb[4] !== undefined : rgb[4] === undefined)) return parsed
  return fail('颜色支持十六进制、常用颜色名、rgb() 和 rgba()；不允许 URL 或脚本。', line)
}
function parseStyle(value: string, line: number): EREntityStyle {
  const style: EREntityStyle = {}, seen = new Set<string>()
  for (const part of properties(value, line)) {
    const match = part.match(/^([\w-]+)\s*:\s*(.+)$/)
    if (!match) fail('样式格式应为 属性:值，以逗号分隔。', line)
    const key = match[1]!, raw = match[2]!.trim()
    if (seen.has(key)) fail(`样式属性 ${key} 重复。`, line)
    seen.add(key)
    if (key === 'fill' || key === 'stroke' || key === 'color') {
      const parsed = color(raw, line)
      if (key === 'color' && parsed === 'none') fail('文字颜色不支持 none；隐藏文字请使用 transparent。', line)
      style[key] = key === 'color' && parsed === 'transparent' ? 'rgba(0,0,0,0)' : parsed
    }
    else if (key === 'font-size' || key === 'stroke-width' || key === 'opacity') {
      const numeric = raw.match(/^(\d+(?:\.\d+)?|\.\d+)(px|pt)?$/)
      const amount = Number(numeric?.[1]) * (numeric?.[2] === 'pt' ? 4 / 3 : 1)
      const minimum = key === 'font-size' ? 8 : 0, maximum = key === 'font-size' ? 72 : key === 'opacity' ? 1 : 16
      if (!numeric || (key === 'opacity' && numeric[2]) || (key === 'stroke-width' && numeric[2] === 'pt') || amount < minimum || amount > maximum) {
        fail(`样式 ${key} 需要 ${minimum}–${maximum} 范围内的数值${key === 'font-size' ? '（支持 px、pt）' : key === 'stroke-width' ? '（支持 px）' : ''}。`, line)
      }
      style[key === 'font-size' ? 'fontSize' : key === 'stroke-width' ? 'strokeWidth' : 'opacity'] = amount
    } else if (key === 'font-weight') {
      if (!['normal', 'bold', '400', '700'].includes(raw)) fail('font-weight 支持 normal、bold、400、700。', line)
      style.fontWeight = raw === 'bold' || raw === '700' ? 'bold' : 'normal'
    } else if (key === 'font-style') {
      if (raw !== 'normal' && raw !== 'italic') fail('font-style 支持 normal、italic。', line)
      style.fontStyle = raw
    } else if (key === 'stroke-dasharray') {
      if (raw === 'none' || raw === '0') { style.strokePattern = 'solid'; style.dashed = false }
      else if (/^8(?:\s+|\s*,\s*)5$/.test(raw)) { style.strokePattern = 'dashed'; style.dashed = true }
      else fail('stroke-dasharray 暂仅支持 none、0 或 8 5。', line)
    } else fail(`暂不支持 ER 样式属性「${key}」。支持 fill、stroke、stroke-width、color、font-size、font-weight、font-style、opacity、stroke-dasharray。`, line)
  }
  return style
}

interface ClassRule { ids: string[]; names: string[]; line: number }
interface StyleRule { ids: string[]; style: EREntityStyle; line: number }
export class ERStyleSheet {
  private definitions = new Map<string, { style: EREntityStyle; line: number }>()
  private assignments: ClassRule[] = []
  private rules: StyleRule[] = []

  read(input: string, line: number): boolean {
    const text = input.replace(/;\s*$/, '').trimEnd()
    let match = text.match(new RegExp(`^classDef\\s+(${ID_LIST})\\s+(.+)$`, 'u'))
    if (match) {
      const style = parseStyle(match[2]!, line)
      for (const name of list(match[1]!)) {
        if (this.definitions.has(name)) fail(`样式类「${name}」重复声明。`, line)
        this.definitions.set(name, { style, line })
      }
      return true
    }
    match = text.match(new RegExp(`^class\\s+(${ID_LIST})\\s+(${ID_LIST})$`, 'u'))
    if (match) { this.assignments.push({ ids: list(match[1]!), names: list(match[2]!), line }); return true }
    match = text.match(new RegExp(`^style\\s+(${ID_LIST})\\s+(.+)$`, 'u'))
    if (match) { this.rules.push({ ids: list(match[1]!), style: parseStyle(match[2]!, line), line }); return true }
    if (/^(?:style|classDef|class)(?:\s|$)/.test(text)) fail('ER 样式指令格式无效。', line)
    return false
  }

  attach(id: string, names: string | undefined, line: number): void {
    if (names) this.assignments.push({ ids: [id], names: list(names), line })
  }

  resolve(ids: Iterable<string>): Map<string, ResolvedERStyle> {
    const result = new Map<string, ResolvedERStyle>(), defaultStyle = this.definitions.get('default')
    for (const id of ids) result.set(id, { style: { ...defaultStyle?.style }, lines: defaultStyle ? [defaultStyle.line] : [] })
    const target = (id: string, line: number): ResolvedERStyle => result.get(id) ?? fail(`样式引用了未定义实体「${id}」。`, line)
    for (const rule of this.assignments) for (const id of rule.ids) {
      const resolved = target(id, rule.line)
      for (const name of rule.names) {
        const definition = this.definitions.get(name)
        if (!definition) fail(`未定义样式类「${name}」。`, rule.line)
        Object.assign(resolved.style, definition.style); resolved.lines.push(definition.line)
      }
      resolved.lines.push(rule.line)
    }
    for (const rule of this.rules) for (const id of rule.ids) {
      const resolved = target(id, rule.line)
      Object.assign(resolved.style, rule.style); resolved.lines.push(rule.line)
    }
    return result
  }
}
