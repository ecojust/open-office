import type { ElementStyle, Point, SceneElement } from '../types.ts'
import {
  diagramEdge, diagramNode, diagramStroke, diagramText, finishDiagram,
  DiagramSyntaxError, DiagramSourceMap, sourceLines,
  type DiagramResult, type DiagramTemplate, type SourceLine,
} from './common.ts'

type Line = SourceLine
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const COLORS = ['#6389e7', '#61b9a0', '#f0b45b', '#ad86d6', '#e78291', '#5bafca', '#bdba5a', '#bc8e70']
const DAY = 86_400_000
const fail = (message: string, at: Line): never => { throw new DiagramSyntaxError(message, at.line) }
const style = (fill: string, stroke = '#ffffff'): Partial<ElementStyle> => ({ fill, stroke, strokeWidth: 1.5 })

function text(value: string, at: Line): string {
  let result = value.trim()
  if (result.startsWith('"')) {
    try { result = JSON.parse(result) } catch { return fail('文字引号不完整；请使用有效的双引号文本。', at) }
  }
  if (typeof result !== 'string' || !result.trim() || result.length > 2000) return fail('文字不能为空，且不能超过 2,000 个字符。', at)
  return result.replace(/<br\s*\/?\s*>/gi, '\n')
}
function number(value: string, at: Line, limit = 1e12): number {
  if (!new RegExp(`^${NUMBER}$`).test(value.trim())) return fail(`“${value}”不是有效数值。`, at)
  const result = Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > limit) return fail(`数值必须有限，绝对值不能超过 ${limit}。`, at)
  return result
}
function labelNumber(value: number): string {
  return Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(2) : Number(value.toPrecision(6)).toString()
}
function commaList(value: string, at: Line): string[] {
  const result: string[] = []
  let begin = 0, quoted = false, escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (!quoted && char === ',') { result.push(value.slice(begin, i).trim()); begin = i + 1 }
  }
  if (quoted) return fail('列表中的双引号未闭合。', at)
  result.push(value.slice(begin).trim())
  if (result.some(item => !item)) return fail('列表不能为空或包含空项。', at)
  return result
}
function boolean(value: string, at: Line): boolean {
  if (value !== 'true' && value !== 'false') return fail('布尔设置必须为 true 或 false。', at)
  return value === 'true'
}
function color(value: string, at: Line): string {
  if (!/^#[\da-fA-F]{3}(?:[\da-fA-F]{3})?$/.test(value)) return fail('颜色使用 #RGB 或 #RRGGBB，不支持外部地址和动态样式。', at)
  return value
}
interface ChartAppearance { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; textColor?: string; radius?: number }
function chartAppearance(value: string, at: Line, point = false): ChartAppearance {
  const result: ChartAppearance = {}, seen = new Set<string>()
  for (const entry of commaList(value, at)) {
    const pair = /^([a-z-]+)\s*:\s*(.+)$/.exec(entry)
    if (!pair || seen.has(pair[1]!)) return fail('样式属性格式为 属性:值，且不能重复。', at)
    const key = pair[1]!, raw = pair[2]!.trim(); seen.add(key)
    if (key === 'fill' && !point) result.fill = color(raw, at)
    else if (key === 'color') { if (point) result.fill = color(raw, at); else result.textColor = color(raw, at) }
    else if (key === (point ? 'stroke-color' : 'stroke')) result.stroke = color(raw, at)
    else if (key === 'stroke-width') { const width = number(raw, at); if (width < 0 || width > 12) fail('stroke-width 必须在 0 到 12 之间。', at); result.strokeWidth = width }
    else if (key === 'opacity' && !point) { const opacity = number(raw, at); if (opacity < 0 || opacity > 1) fail('opacity 必须在 0 到 1 之间。', at); result.opacity = opacity }
    else if (key === 'radius' && point) { const radius = number(raw, at); if (radius < 2 || radius > 30) fail('radius 必须在 2 到 30 之间。', at); result.radius = radius }
    else fail(`不支持样式属性“${key}”。`, at)
  }
  return result
}
function elementAppearance(appearance: ChartAppearance): Partial<ElementStyle> {
  const { radius: _radius, textColor: _textColor, ...result } = appearance
  return result
}
function titleNode(title: string): SceneElement { return diagramText('chart-title', title, 80, 25, 900, 54, { fontSize: 27, textAlign: 'left', stroke: '#24334d' }) }
function stroke(id: string, points: Point[], options: Partial<ElementStyle> = {}): SceneElement {
  return diagramStroke(id, points, { stroke: '#b5c1d1', strokeWidth: 1, fill: 'none', ...options })
}

function pie(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const header = lines[0]!
  const declaration = /^pie(?:\s+showData)?(?:\s+title\s+(.+))?$/.exec(header.text.trim())
  if (!declaration) return fail('饼图开头支持 pie 或 pie showData，可添加 title 标题。', header)
  const showData = /\bshowData\b/.test(header.text), slices: { label: string; value: number; at: Line }[] = []
  let title = declaration[1] ? text(declaration[1], header) : '占比分析', hasTitle = Boolean(declaration[1]), innerRadius = 0, showLegend = true
  const options = new Map<string, Line>()
  if (declaration[1]) sources.add(header.line, 'chart-title')
  const labels = new Set<string>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = value.match(/^title\s+(.+)$/)
    if (heading) { if (hasTitle) fail('饼图只能设置一个标题。', at); title = text(heading[1]!, at); sources.add(at.line, 'chart-title'); hasTitle = true; continue }
    const option = /^(innerRadius|showLegend)\s+(.+)$/.exec(value)
    if (option) { const key = option[1]!; if (options.has(key)) fail(`“${key}”不能重复。`, at); options.set(key, at); if (key === 'showLegend') showLegend = boolean(option[2]!, at); else { innerRadius = number(option[2]!, at); if (innerRadius < 0 || innerRadius > .8) fail('innerRadius 必须在 0 到 0.8 之间。', at) }; continue }
    const match = value.match(new RegExp(`^("(?:[^"\\\\]|\\\\.)*")\\s*:\\s*(${NUMBER})$`))
    if (!match) fail('饼图数据格式为 "分类名称" : 非负数；其他指令暂不支持。', at)
    const label = text(match![1]!, at), amount = number(match![2]!, at)
    if (amount < 0) fail('饼图数值不能为负数。', at)
    if (labels.has(label)) fail(`饼图分类“${label}”重复。`, at)
    sources.add(at.line, `pie-sector-${slices.length}`, `pie-percent-${slices.length}`, `pie-key-${slices.length}`, `pie-label-${slices.length}`)
    labels.add(label); slices.push({ label, value: amount, at })
    if (slices.length > 64) fail('饼图最多支持 64 个分类。', at)
  }
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  if (!slices.length || total <= 0) fail('饼图需要至少一个正数，所有分类的合计必须大于零。', header)
  const elements: SceneElement[] = [titleNode(title)], cx = 320, cy = 340, radius = 220
  let angle = -Math.PI / 2
  slices.forEach((slice, index) => {
    const fraction = slice.value / total, finish = angle + fraction * Math.PI * 2, color = COLORS[index % COLORS.length]!
    if (fraction > 0) {
      const samples = Math.max(2, Math.ceil(fraction * 160)), points: Point[] = innerRadius ? [] : [{ x: cx, y: cy }]
      for (let i = 0; i <= samples; i++) { const theta = angle + (finish - angle) * i / samples; points.push({ x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius }) }
      if (innerRadius) for (let i = samples; i >= 0; i--) { const theta = angle + (finish - angle) * i / samples; points.push({ x: cx + Math.cos(theta) * radius * innerRadius, y: cy + Math.sin(theta) * radius * innerRadius }) }
      elements.push(diagramStroke(`pie-sector-${index}`, points, style(color), true))
      if (fraction >= .045) {
        const middle = (angle + finish) / 2
        elements.push(diagramText(`pie-percent-${index}`, `${showLegend ? '' : `${slice.label}\n`}${Number((fraction * 100).toFixed(1))}%`, cx + Math.cos(middle) * radius * Math.max(.67, (1 + innerRadius) / 2) - (showLegend ? 45 : 65), cy + Math.sin(middle) * radius * Math.max(.67, (1 + innerRadius) / 2) - (showLegend ? 15 : 24), showLegend ? 90 : 130, showLegend ? 30 : 48, { fontSize: showLegend ? 17 : 13, stroke: '#ffffff' }))
      }
    }
    if (showLegend) {
      elements.push(diagramNode(`pie-key-${index}`, '', 600, 120 + index * 39, 18, 18, 'rectangle', style(color, color)))
      elements.push(diagramText(`pie-label-${index}`, `${slice.label}  ${showData ? `${labelNumber(slice.value)} · ` : ''}${Number((fraction * 100).toFixed(1))}%`, 632, 110 + index * 39, 430, 38, { textAlign: 'left', fontSize: 16 }))
    }
    angle = finish
  })
  elements.push(diagramText('pie-total', `合计 ${labelNumber(total)}`, 100, 590, 440, 36, { fontSize: 16, stroke: '#64748b' }))
  for (const [key, at] of options) sources.add(at.line, ...elements.filter(element => key === 'innerRadius' || !showLegend ? element.id.startsWith('pie-sector-') : /^pie-(key|label)-/.test(element.id)).map(element => element.id))
  return finishDiagram('pie', elements, [], sources)
}

function date(value: string, at: Line): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return fail('日期必须为 YYYY-MM-DD，或用 after 任务ID 指定依赖。', at)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return fail(`无效日期“${value}”。`, at)
  const result = Date.UTC(year, month - 1, day), parsed = new Date(result)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return fail(`无效日期“${value}”。`, at)
  return result
}
function duration(value: string, at: Line, milestone = false): number {
  const match = /^(\d+)(d|w)$/.exec(value)
  if (!match) return fail('任务时长支持整数天 d 或周 w，例如 5d、2w；小时等单位暂不支持。', at)
  const days = Number(match[1]) * (match[2] === 'w' ? 7 : 1)
  if (!Number.isSafeInteger(days) || days > 36525 || days < (milestone ? 0 : 1)) return fail('普通任务时长须为 1–36,525 天；里程碑使用 0d。', at)
  if (milestone && days !== 0) return fail('里程碑时长必须为 0d。', at)
  return days * DAY
}
interface Task {
  id: string; name: string; section: string; sectionLine: number; at: Line; flags: Set<string>; startExpr: string; finishExpr: string
  previous?: Task; start?: number; end?: number; dependencies: string[]; resolving?: boolean
}
function gantt(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  if (lines[0]!.text.trim() !== 'gantt') return fail('甘特图开头应为 gantt。', lines[0]!)
  let title = '项目计划', section = '', sectionLine = 0, axisFormat = '%m-%d', hasTitle = false, hasDateFormat = false, hasAxisFormat = false
  const tasks: Task[] = [], ids = new Map<string, Task>(), calendarLines: Line[] = []
  const excludedWeekdays = new Set<number>(), excludedDates = new Set<number>(), includedDates = new Set<number>(), options = new Map<string, Line>()
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  let interval: number | undefined
  const working = (time: number) => includedDates.has(time) || (!excludedDates.has(time) && !excludedWeekdays.has(new Date(time).getUTCDay()))
  function nextWorking(time: number, at: Line): number {
    for (let skip = 0; skip <= 36525; skip++, time += DAY) if (working(time)) return time
    return fail('工作日历在支持范围内没有可用日期。', at)
  }
  function workingEnd(start: number, days: number, at: Line): number {
    let time = start
    for (let elapsed = 0; elapsed <= 36525; elapsed++, time += DAY) {
      if (!days) return time
      if (working(time)) days--
    }
    return fail('按工作日计算后的任务跨度超过 36,525 天。', at)
  }
  for (const at of lines.slice(1)) {
    const value = at.text.trim()
    const directive = value.match(/^(title|section|dateFormat|axisFormat)\s+(.+)$/)
    if (directive) {
      const argument = directive[2]!.trim()
      if (directive[1] === 'title') { if (hasTitle) fail('甘特图只能设置一个标题。', at); title = text(argument, at); sources.add(at.line, 'chart-title'); hasTitle = true }
      else if (directive[1] === 'section') { section = text(argument, at); sectionLine = at.line }
      else if (directive[1] === 'dateFormat') { if (hasDateFormat) fail('dateFormat 不能重复。', at); if (argument !== 'YYYY-MM-DD') fail('当前甘特图仅支持 dateFormat YYYY-MM-DD。', at); hasDateFormat = true }
      else { if (hasAxisFormat) fail('axisFormat 不能重复。', at); if (!['%Y-%m-%d', '%m-%d', '%d'].includes(argument)) fail('axisFormat 目前支持 %Y-%m-%d、%m-%d 或 %d。', at); axisFormat = argument; hasAxisFormat = true }
      continue
    }
    const calendar = /^(excludes|includes|tickInterval)\s+(.+)$/.exec(value)
    if (calendar) {
      const key = calendar[1]!, argument = calendar[2]!
      if (options.has(key)) fail(`“${key}”不能重复。`, at)
      options.set(key, at)
      if (key === 'tickInterval') interval = duration(argument, at) / DAY
      else {
        calendarLines.push(at)
        for (const entry of commaList(argument, at)) {
          if (key === 'includes') includedDates.add(date(entry, at))
          else if (entry === 'weekends') { excludedWeekdays.add(0); excludedWeekdays.add(6) }
          else if (weekdays.includes(entry)) excludedWeekdays.add(weekdays.indexOf(entry))
          else excludedDates.add(date(entry, at))
        }
      }
      continue
    }
    if (/^(?:todayMarker|weekend|click|accTitle|accDescr)\b/.test(value)) fail('此标记或交互指令暂不支持；请使用任务日期和里程碑。', at)
    const match = /^(.+?)\s*:\s*(.+)$/.exec(value)
    if (!match) fail('任务格式为 任务名称 :任务ID, 开始日期或 after 任务ID, 结束日期或时长。', at)
    const parts = commaList(match![2]!, at), flags = new Set<string>()
    while (['done', 'active', 'crit', 'milestone'].includes(parts[0] || '')) { const flag = parts.shift()!; if (flags.has(flag)) fail(`任务标记“${flag}”重复。`, at); flags.add(flag) }
    let id = `task-${tasks.length + 1}`, startExpr = '', finishExpr = ''
    if (parts.length === 3) { [id, startExpr, finishExpr] = parts as [string, string, string] }
    else if (parts.length === 2) {
      if (/^\d{4}-|^after\s/.test(parts[0]!)) [startExpr, finishExpr] = parts as [string, string]
      else { id = parts[0]!; finishExpr = parts[1]! }
    } else if (parts.length === 1) finishExpr = parts[0]!
    else fail('任务参数数量不正确；多个依赖请写为 after a b。', at)
    if (!/^[A-Za-z_][A-Za-z\d_-]*$/.test(id) || ids.has(id)) fail('任务 ID 必须唯一，并以字母或下划线开头。', at)
    const task: Task = { id, name: text(match![1]!, at), section, sectionLine, at, flags, startExpr, finishExpr, previous: tasks.at(-1), dependencies: [] }
    tasks.push(task); ids.set(id, task)
    if (tasks.length > 150) fail('甘特图最多支持 150 个任务。', at)
  }
  if (!tasks.length) fail('甘特图需要至少一个任务。', lines[0]!)
  function resolve(task: Task): void {
    if (task.start !== undefined) return
    if (task.resolving) return fail(`任务“${task.id}”存在循环依赖。`, task.at)
    task.resolving = true
    let start: number
    if (/^after\s+/.test(task.startExpr)) {
      const dependencies = task.startExpr.slice(6).trim().split(/\s+/)
      if (dependencies.length > 10 || dependencies.some(id => !/^[A-Za-z_][A-Za-z\d_-]*$/.test(id))) fail('after 支持最多 10 个任务 ID，以空格分隔。', task.at)
      task.dependencies = [...new Set(dependencies)]
      start = Math.max(...task.dependencies.map(id => { const dependency = ids.get(id); if (!dependency) return fail(`找不到依赖任务“${id}”。`, task.at); resolve(dependency); return dependency.end! }))
    } else if (!task.startExpr) {
      if (!task.previous) return fail('首个任务必须指定开始日期。', task.at)
      resolve(task.previous!); start = task.previous!.end!
    } else start = date(task.startExpr, task.at)
    const milestone = task.flags.has('milestone')
    if (!milestone && calendarLines.length) start = nextWorking(start, task.at)
    let end: number
    if (/^until\s+/.test(task.finishExpr)) {
      if (milestone) fail('里程碑不支持 until，请使用 0d。', task.at)
      const target = ids.get(task.finishExpr.slice(6).trim())
      if (!target) fail('until 引用了未知任务。', task.at)
      resolve(target!); end = target!.start!
    } else if (/^\d{4}-/.test(task.finishExpr)) end = date(task.finishExpr, task.at)
    else { const span = duration(task.finishExpr, task.at, milestone); end = calendarLines.length && !milestone ? workingEnd(start, span / DAY, task.at) : start + span }
    if (end < start || (!milestone && end === start) || (milestone && end !== start)) fail('任务结束时间必须晚于开始；里程碑的开始和结束必须相同。', task.at)
    if (end > Date.UTC(9999, 11, 31)) fail('任务结束日期超出支持范围。', task.at)
    task.start = start; task.end = end; task.resolving = false
  }
  tasks.forEach(resolve)
  const minimum = Math.min(...tasks.map(task => task.start!)), maximum = Math.max(minimum + DAY, ...tasks.map(task => task.end!)), days = (maximum - minimum) / DAY
  if (days > 36525) fail('甘特图总跨度不能超过 36,525 天。', lines[0]!)
  const elements: SceneElement[] = [titleNode(title)], left = 270, width = 860, positions = new Map<string, { x: number; y: number; right: number }>()
  const x = (time: number) => left + (time - minimum) / (maximum - minimum) * width
  let y = 145, previousSection: string | undefined
  for (const task of tasks) {
    if (task.section !== previousSection) {
      if (task.section) { elements.push(diagramNode(`gantt-section-bg-${task.id}`, '', 60, y - 8, 1090, 36, 'rectangle', { fill: '#f0f4fa', strokeWidth: 0 })); elements.push(diagramText(`gantt-section-${task.id}`, task.section, 70, y - 5, 1050, 30, { textAlign: 'left', fontSize: 16, stroke: '#475569' })); y += 44 }
      previousSection = task.section
    }
    positions.set(task.id, { x: x(task.start!), right: x(task.end!), y })
    y += 48
  }
  if (calendarLines.length && days <= 730) {
    let block = 0
    for (let time = minimum; time < maximum;) {
      if (working(time)) { time += DAY; continue }
      const begin = time; while (time < maximum && !working(time)) time += DAY
      elements.push(diagramNode(`gantt-excluded-${block++}`, '', x(begin), 115, Math.max(1, x(time) - x(begin)), y - 129, 'rectangle', { fill: '#edf0f5', strokeWidth: 0, opacity: .7 }))
    }
  }
  const ticks = Math.min(8, Math.ceil(days)), tickDays = interval ?? Math.max(1, Math.ceil(days / ticks))
  if (Math.floor(days / tickDays) + 1 > 200) fail('tickInterval 生成的刻度超过 200 个，请扩大间隔。', options.get('tickInterval') || lines[0]!)
  for (let index = 0, offset = 0; offset <= days; index++, offset += tickDays) {
    const time = minimum + offset * DAY, iso = new Date(time).toISOString().slice(0, 10), value = axisFormat === '%Y-%m-%d' ? iso : axisFormat === '%d' ? iso.slice(8) : iso.slice(5)
    elements.push(stroke(`gantt-grid-${index}`, [{ x: x(time), y: 115 }, { x: x(time), y: y - 14 }], { stroke: '#dbe3ef', dashed: true }))
    elements.push(diagramText(`gantt-tick-${index}`, value, x(time) - 50, 82, 100, 28, { fontSize: 13, stroke: '#64748b' }))
  }
  elements.push(stroke('gantt-axis', [{ x: left, y: 114 }, { x: left + width, y: 114 }], { stroke: '#8191a9' }))
  for (const task of tasks) for (const dependency of task.dependencies) {
    const from = positions.get(dependency)!, to = positions.get(task.id)!
    elements.push(diagramEdge(`gantt-dependency-${dependency}-${task.id}`, { x: from.right, y: from.y + 13 }, { x: to.x, y: to.y + 13 }, '', { arrow: 'end', route: 'orthogonal', style: { stroke: '#9aa8be', strokeWidth: 1.5, dashed: true } }))
  }
  for (const task of tasks) {
    const position = positions.get(task.id)!, fill = task.flags.has('crit') ? '#e2828f' : task.flags.has('done') ? '#68b89d' : task.flags.has('active') ? '#6389e7' : '#9b8ad1'
    elements.push(diagramText(`gantt-name-${task.id}`, task.name, 70, position.y - 3, 190, 34, { fontSize: 14, textAlign: 'left' }))
    const milestone = task.flags.has('milestone'), barWidth = Math.max(3, position.right - position.x)
    elements.push(diagramNode(`gantt-task-${task.id}`, '', milestone ? position.x - 11 : position.x, position.y, milestone ? 22 : barWidth, 26, milestone ? 'diamond' : 'rectangle', { fill, stroke: fill, strokeWidth: 1 }))
    const summary = milestone ? '里程碑' : `${new Date(task.start!).toISOString().slice(0, 10)} · ${(task.end! - task.start!) / DAY} ${calendarLines.length ? '日历天' : '天'}`
    elements.push(diagramText(`gantt-detail-${task.id}`, summary, position.x + 5, position.y + 27, Math.max(160, barWidth), 18, { fontSize: 10, textAlign: 'left', stroke: '#64748b' }))
  }
  elements.push(diagramText('gantt-calendar-note', calendarLines.length ? `UTC 工作日历 · 时长只计可用日，1w = 7 个可用日 · 结束日期不包含${days > 730 ? ' · 跨度较大，省略休息日底纹' : ' · 灰色为排除日'}` : 'UTC 连续日历日 · 结束日期为不包含的边界 · 未排除周末或节假日', 70, y + 10, 1060, 34, { textAlign: 'left', fontSize: 13, stroke: '#64748b' }))
  for (const task of tasks) {
    sources.add(task.at.line, `gantt-name-${task.id}`, `gantt-task-${task.id}`, `gantt-detail-${task.id}`, ...task.dependencies.map(dependency => `gantt-dependency-${dependency}-${task.id}`))
    sources.add(task.sectionLine, `gantt-section-bg-${task.id}`, `gantt-section-${task.id}`)
  }
  for (const at of calendarLines) sources.add(at.line, 'gantt-calendar-note', ...elements.filter(element => /^gantt-(excluded|task)-/.test(element.id)).map(element => element.id))
  const tickOption = options.get('tickInterval'); if (tickOption) sources.add(tickOption.line, ...elements.filter(element => /^gantt-(tick|grid)-/.test(element.id)).map(element => element.id))
  return finishDiagram('gantt', elements, [], sources)
}

interface Axis { title: string; categories?: string[]; minimum?: number; maximum?: number; at: Line }
function axis(value: string, at: Line, isX: boolean): Axis {
  const array = /^(.*?)\[([\s\S]*)\]$/.exec(value)
  if (array) {
    if (!isX) return fail('y-axis 目前只支持数值范围。', at)
    const categories = commaList(array[2]!, at).map(item => text(item, at))
    if (categories.length > 100) return fail('X 轴最多支持 100 个分类。', at)
    return { title: array[1]!.trim() ? text(array[1]!, at) : '', categories, at }
  }
  const range = new RegExp(`^(?:(.*?)\\s+)?(${NUMBER})\\s*-->\\s*(${NUMBER})$`).exec(value)
  if (range) {
    const minimum = number(range[2]!, at), maximum = number(range[3]!, at)
    if (minimum >= maximum) return fail('坐标轴范围的结束值必须大于起始值。', at)
    return { title: range[1]?.trim() ? text(range[1], at) : '', minimum, maximum, at }
  }
  if (/[\[\]]|-->/.test(value)) return fail('坐标轴格式无效，支持 [分类列表] 或 最小值 --> 最大值。', at)
  return { title: value.trim() ? text(value, at) : '', at }
}
function xyChart(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const match = /^xychart(?:-beta)?(?:\s+(horizontal))?$/.exec(lines[0]!.text.trim())
  if (!match) return fail('XY 图开头支持 xychart-beta，可添加 horizontal。', lines[0]!)
  const horizontal = Boolean(match[1]), series: { type: 'bar' | 'line'; name?: string; values: number[]; at: Line }[] = []
  let title = '数据趋势', hasTitle = false, xAxis: Axis | undefined, yAxis: Axis | undefined, showLegend = true, yTicks = 5
  const options = new Map<string, Line>(), seriesNames = new Set<string>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = /^title\s+(.+)$/.exec(value)
    if (heading) { if (hasTitle) fail('XY 图只能设置一个标题。', at); title = text(heading[1]!, at); sources.add(at.line, 'chart-title'); hasTitle = true; continue }
    const declaration = /^([xy])-axis(?:\s+(.*))?$/.exec(value)
    if (declaration) {
      const isX = declaration[1] === 'x'
      if (isX ? xAxis : yAxis) fail('同一个坐标轴不能重复声明。', at)
      const result = axis(declaration[2] || '', at, isX)
      if (isX) xAxis = result; else yAxis = result
      continue
    }
    const option = /^(showLegend|y-ticks)\s+(.+)$/.exec(value)
    if (option) {
      const key = option[1]!; if (options.has(key)) fail(`“${key}”不能重复。`, at); options.set(key, at)
      if (key === 'showLegend') showLegend = boolean(option[2]!, at)
      else { yTicks = number(option[2]!, at); if (!Number.isInteger(yTicks) || yTicks < 1 || yTicks > 20) fail('y-ticks 必须为 1 到 20 的整数。', at) }
      continue
    }
    const data = /^(bar|line)(?:\s+("(?:[^"\\]|\\.)*"))?\s*\[([^\]]*)\]$/.exec(value)
    if (!data) fail('XY 图支持坐标轴、bar/line [数值]，可在方括号前添加双引号系列名称；也支持 showLegend 与 y-ticks。', at)
    const name = data![2] ? text(data![2], at) : undefined
    if (name && seriesNames.has(name)) fail('数据系列名称不能重复。', at)
    if (name) seriesNames.add(name)
    const values = commaList(data![3]!, at).map(item => number(item, at))
    if (values.length > 100) fail('每条数据序列最多支持 100 个数值。', at)
    series.push({ type: data![1] as 'bar' | 'line', name, values, at })
    if (series.length > 8) fail('XY 图最多支持 8 条数据序列。', at)
  }
  if (!series.length) fail('XY 图需要至少一组 bar 或 line 数据。', lines[0]!)
  const count = series[0]!.values.length
  for (const item of series) if (item.values.length !== count) fail('所有数据序列的长度必须相同。', item.at)
  if (xAxis?.categories && xAxis.categories.length !== count) fail('X 轴分类数量必须与数据序列长度一致。', xAxis.at)
  const values = series.flatMap(item => item.values)
  let minimum = yAxis?.minimum ?? Math.min(0, ...values), maximum = yAxis?.maximum ?? Math.max(0, ...values)
  if (maximum === minimum) { minimum -= 1; maximum += 1 }
  for (const item of series) if (item.values.some(value => value < minimum || value > maximum)) fail('数据超出了 y-axis 的声明范围，请扩大范围。', item.at)
  const left = 160, top = 130, width = 800, height = 430, elements: SceneElement[] = [titleNode(title)]
  const t = (index: number): number => xAxis?.minimum !== undefined && count > 1 ? index / (count - 1) : (index + .5) / count
  const point = (index: number, value: number): Point => horizontal
    ? { x: left + (value - minimum) / (maximum - minimum) * width, y: top + t(index) * height }
    : { x: left + t(index) * width, y: top + height - (value - minimum) / (maximum - minimum) * height }
  const baseline = Math.max(minimum, Math.min(maximum, 0)), base = point(0, baseline)
  for (let index = 0; index <= yTicks; index++) {
    const value = minimum + (maximum - minimum) * index / yTicks, p = point(0, value)
    elements.push(stroke(`xy-grid-${index}`, horizontal ? [{ x: p.x, y: top }, { x: p.x, y: top + height }] : [{ x: left, y: p.y }, { x: left + width, y: p.y }], { stroke: '#e1e7f0' }))
    elements.push(diagramText(`xy-y-tick-${index}`, labelNumber(value), horizontal ? p.x - 55 : left - 115, horizontal ? top + height + 16 : p.y - 14, 100, 28, { fontSize: 13, textAlign: horizontal ? 'center' : 'right', stroke: '#64748b' }))
  }
  const stride = Math.max(1, Math.ceil(count / 16))
  for (let index = 0; index < count; index++) if (index % stride === 0 || index === count - 1) {
    const value = xAxis?.categories?.[index] ?? (xAxis?.minimum !== undefined ? labelNumber(xAxis.minimum + (xAxis.maximum! - xAxis.minimum) * (count > 1 ? index / (count - 1) : .5)) : String(index + 1)), p = point(index, minimum)
    elements.push(diagramText(`xy-x-tick-${index}`, value, horizontal ? left - 140 : p.x - 45, horizontal ? p.y - 17 : top + height + 16, horizontal ? 125 : 90, 34, { fontSize: 13, textAlign: horizontal ? 'right' : 'center', stroke: '#64748b' }))
  }
  elements.push(stroke('xy-axis-bottom', [{ x: left, y: top + height }, { x: left + width, y: top + height }], { stroke: '#8091ac', strokeWidth: 1.5 }))
  elements.push(stroke('xy-axis-left', [{ x: left, y: top }, { x: left, y: top + height }], { stroke: '#8091ac', strokeWidth: 1.5 }))
  if (baseline !== minimum) elements.push(stroke('xy-zero', horizontal ? [{ x: base.x, y: top }, { x: base.x, y: top + height }] : [{ x: left, y: base.y }, { x: left + width, y: base.y }], { stroke: '#a3afc0', dashed: true }))
  if (xAxis?.title) elements.push(diagramText('xy-x-title', xAxis.title, horizontal ? 10 : left, horizontal ? 82 : top + height + 62, horizontal ? 140 : width, 35, { fontSize: 16, stroke: '#475569' }))
  if (yAxis?.title) elements.push(diagramText('xy-y-title', yAxis.title, horizontal ? left : 10, horizontal ? top + height + 62 : 82, horizontal ? width : 300, 35, { fontSize: 16, textAlign: horizontal ? 'center' : 'left', stroke: '#475569' }))
  const barCount = series.filter(item => item.type === 'bar').length, band = (horizontal ? height : width) / count * .7
  let barIndex = 0
  series.forEach((item, seriesIndex) => {
    const firstElement = elements.length
    const color = COLORS[seriesIndex % COLORS.length]!, points = item.values.map((value, index) => point(index, value))
    if (item.type === 'bar') {
      const thickness = band / barCount, offset = -band / 2 + barIndex++ * thickness
      points.forEach((p, index) => {
        const origin = point(index, baseline)
        if (item.values[index] === baseline) return
        const x = horizontal ? Math.min(p.x, origin.x) : p.x + offset, y = horizontal ? p.y + offset : Math.min(p.y, origin.y)
        const width = horizontal ? Math.abs(p.x - origin.x) : thickness, height = horizontal ? thickness : Math.abs(p.y - origin.y)
        const appearance: Partial<ElementStyle> = { fill: color, stroke: color, strokeWidth: 0, opacity: .85 }, id = `xy-bar-${seriesIndex}-${index}`
        // Tiny values retain their real proportions without violating the
        // editable rectangle's minimum size or widening adjacent bar groups.
        elements.push(width >= 1 && height >= 1 ? diagramNode(id, '', x, y, width, height, 'rectangle', appearance)
          : diagramStroke(id, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], appearance, true))
      })
    } else {
      if (points.length > 1) elements.push(stroke(`xy-line-${seriesIndex}`, points, { stroke: color, strokeWidth: 3 }))
      points.forEach((p, index) => elements.push(diagramNode(`xy-point-${seriesIndex}-${index}`, '', p.x - 3, p.y - 3, 6, 6, 'ellipse', { fill: color, stroke: '#ffffff', strokeWidth: 1 })))
    }
    if (showLegend) {
      elements.push(diagramNode(`xy-key-${seriesIndex}`, '', left + seriesIndex % 4 * 205, top + height + 115 + Math.floor(seriesIndex / 4) * 34, 18, 12, 'rectangle', style(color, color)))
      elements.push(diagramText(`xy-legend-${seriesIndex}`, item.name || `${item.type === 'bar' ? '柱形' : '折线'}序列 ${seriesIndex + 1}`, left + seriesIndex % 4 * 205 + 27, top + height + 104 + Math.floor(seriesIndex / 4) * 34, 165, 32, { textAlign: 'left', fontSize: 14 }))
    }
    sources.capture(item.at.line, elements, firstElement)
  })
  if (xAxis) sources.add(xAxis.at.line, 'xy-x-title', ...elements.filter(element => element.id.startsWith('xy-x-tick-')).map(element => element.id))
  if (yAxis) sources.add(yAxis.at.line, 'xy-y-title', ...elements.filter(element => element.id.startsWith('xy-y-tick-')).map(element => element.id))
  for (const [key, at] of options) sources.add(at.line, ...elements.filter(element => key === 'y-ticks' ? /^xy-(grid|y-tick)-/.test(element.id) : !showLegend ? /^xy-(bar|line|point)-/.test(element.id) : /^xy-(legend|key)-/.test(element.id)).map(element => element.id))
  return finishDiagram('xychart', elements, [], sources)
}

function quadrant(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  if (lines[0]!.text.trim() !== 'quadrantChart') return fail('象限图开头应为 quadrantChart。', lines[0]!)
  let title = '优先级分析', xLabels = ['较低', '较高'], yLabels = ['较低', '较高']
  const quadrants = ['第一象限', '第二象限', '第三象限', '第四象限'], declarations = new Set<string>(), points: { name: string; x: number; y: number; at: Line; className?: string; appearance: ChartAppearance }[] = []
  const classes = new Map<string, { appearance: ChartAppearance; at: Line }>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = /^title\s+(.+)$/.exec(value)
    if (heading) { if (declarations.has('title')) fail('象限图只能设置一个标题。', at); declarations.add('title'); title = text(heading[1]!, at); sources.add(at.line, 'chart-title'); continue }
    const declaration = /^(x-axis|y-axis|quadrant-[1-4])\s+(.+)$/.exec(value)
    if (declaration) {
      const key = declaration[1]!
      if (declarations.has(key)) fail(`“${key}”不能重复声明。`, at)
      declarations.add(key)
      if (key.startsWith('quadrant-')) sources.add(at.line, `quadrant-area-${key.slice(-1)}`, `quadrant-title-${key.slice(-1)}`)
      else sources.add(at.line, `quadrant-${key[0]}-low`, `quadrant-${key[0]}-high`)
      if (key.startsWith('quadrant-')) quadrants[Number(key.slice(-1)) - 1] = text(declaration[2]!, at)
      else {
        const pair = declaration[2]!.split(/\s*-->\s*/)
        if (pair.length !== 2) fail('象限坐标轴格式为 x-axis 较低 --> 较高。', at)
        const labels = pair.map(value => text(value, at))
        if (key === 'x-axis') xLabels = labels; else yLabels = labels
      }
      continue
    }
    const classDefinition = /^classDef\s+([A-Za-z_][A-Za-z\d_-]*)\s+(.+)$/.exec(value)
    if (classDefinition) { const id = classDefinition[1]!; if (classes.has(id)) fail('样式类名称不能重复。', at); classes.set(id, { appearance: chartAppearance(classDefinition[2]!, at, true), at }); continue }
    const match = new RegExp(`^(.+?)\\s*:\\s*\\[\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*\\](?:\\s+(.+))?$`).exec(value)
    if (!match) fail('象限数据格式为 名称: [x, y]，坐标范围为 0 到 1，可附加 :::类名 和点样式。', at)
    const x = number(match![2]!, at), y = number(match![3]!, at)
    if (x < 0 || x > 1 || y < 0 || y > 1) fail('象限图坐标必须在 0 到 1 之间。', at)
    const named = /^(.*?)(?::::([A-Za-z_][A-Za-z\d_-]*))?$/.exec(match![1]!.trim())!
    points.push({ name: text(named[1]!, at), className: named[2], appearance: match![4] ? chartAppearance(match![4], at, true) : {}, x, y, at })
    if (points.length > 100) fail('象限图最多支持 100 个数据点。', at)
  }
  if (!points.length) fail('象限图需要至少一个数据点。', lines[0]!)
  const elements: SceneElement[] = [titleNode(title)], left = 180, top = 130, width = 760, height = 500
  const boxes = [{ x: left + width / 2, y: top, fill: '#e3f3ed' }, { x: left, y: top, fill: '#e8effc' }, { x: left, y: top + height / 2, fill: '#f0eafa' }, { x: left + width / 2, y: top + height / 2, fill: '#fff2da' }]
  boxes.forEach((box, index) => {
    elements.push(diagramNode(`quadrant-area-${index + 1}`, '', box.x, box.y, width / 2, height / 2, 'rectangle', { fill: box.fill, stroke: '#ffffff', strokeWidth: 1 }))
    elements.push(diagramText(`quadrant-title-${index + 1}`, quadrants[index]!, box.x + 12, box.y + 12, width / 2 - 24, 34, { fontSize: 17, stroke: '#738197' }))
  })
  elements.push(stroke('quadrant-x-mid', [{ x: left, y: top + height / 2 }, { x: left + width, y: top + height / 2 }], { stroke: '#8a9bb2', dashed: true }))
  elements.push(stroke('quadrant-y-mid', [{ x: left + width / 2, y: top }, { x: left + width / 2, y: top + height }], { stroke: '#8a9bb2', dashed: true }))
  elements.push(diagramText('quadrant-x-low', xLabels[0]!, left, top + height + 14, width / 2, 40, { textAlign: 'left', stroke: '#475569' }))
  elements.push(diagramText('quadrant-x-high', xLabels[1]!, left + width / 2, top + height + 14, width / 2, 40, { textAlign: 'right', stroke: '#475569' }))
  elements.push(diagramText('quadrant-y-low', yLabels[0]!, 15, top + height - 50, 150, 40, { textAlign: 'right', stroke: '#475569' }))
  elements.push(diagramText('quadrant-y-high', yLabels[1]!, 15, top, 150, 40, { textAlign: 'right', stroke: '#475569' }))
  points.forEach((point, index) => {
    sources.add(point.at.line, `quadrant-point-${index}`, `quadrant-label-${index}`)
    const classStyle = point.className ? classes.get(point.className) : undefined
    if (point.className && !classStyle) fail(`找不到样式类“${point.className}”。`, point.at)
    const appearance = { ...classStyle?.appearance, ...point.appearance }, radius = appearance.radius ?? 6
    if (classStyle) sources.add(classStyle.at.line, `quadrant-point-${index}`, `quadrant-label-${index}`)
    const x = left + point.x * width, y = top + (1 - point.y) * height
    elements.push(diagramNode(`quadrant-point-${index}`, '', x - radius, y - radius, radius * 2, radius * 2, 'ellipse', { fill: '#526da5', stroke: '#ffffff', strokeWidth: 2, ...elementAppearance(appearance) }))
    elements.push(diagramText(`quadrant-label-${index}`, point.name, point.x > .75 ? x - 178 - radius : x + radius + 7, y - 18, 170, 36, { fontSize: 14, textAlign: point.x > .75 ? 'right' : 'left', stroke: '#334155' }))
  })
  return finishDiagram('quadrant', elements, [], sources)
}

function csv(value: string, at: Line): string[] {
  const fields: string[] = []
  let index = 0
  while (index < value.length) {
    while (value[index] === ' ') index++
    let field = ''
    if (value[index] === '"') {
      index++; let closed = false
      while (index < value.length) {
        if (value[index] === '"') { if (value[index + 1] === '"') { field += '"'; index += 2; continue }; closed = true; index++; break }
        field += value[index++]
      }
      if (!closed) fail('CSV 双引号未闭合；暂不支持跨行字段。', at)
      while (value[index] === ' ') index++
      if (index < value.length && value[index] !== ',') fail('CSV 引号后只能接逗号。', at)
    } else {
      while (index < value.length && value[index] !== ',') { if (value[index] === '"') fail('CSV 引号须位于字段开头。', at); field += value[index++] }
      field = field.trim()
    }
    if (!field || field.length > 2000) fail('CSV 字段不能为空或超过 2,000 字符。', at)
    fields.push(field)
    if (value[index] === ',') { index++; if (index === value.length) fail('CSV 末尾不能有空字段。', at) }
  }
  return fields
}
function sankey(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  if (!/^sankey(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('桑基图开头应为 sankey-beta。', lines[0]!)
  const nodes = new Map<string, { id: number; name: string; input: number; output: number; rank: number; incoming: number; x: number; y: number; height: number }>()
  const links: { source: string; target: string; value: number; at: Line; from?: number; to?: number }[] = []
  let title = '流向与分配', showValues = true, linkColor = 'source', nodeAlign = 'left'
  const options = new Map<string, Line>()
  function node(name: string) {
    if (!nodes.has(name)) nodes.set(name, { id: nodes.size, name, input: 0, output: 0, rank: 0, incoming: 0, x: 0, y: 0, height: 0 })
    return nodes.get(name)!
  }
  for (const at of lines.slice(1)) {
    const option = /^(title|showValues|linkColor|nodeAlign)\s+(.+)$/.exec(at.text.trim())
    if (option) {
      const key = option[1]!, argument = option[2]!.trim(); if (options.has(key)) fail(`“${key}”不能重复。`, at); options.set(key, at)
      if (key === 'title') { title = text(argument, at); sources.add(at.line, 'chart-title') }
      else if (key === 'showValues') showValues = boolean(argument, at)
      else if (key === 'linkColor') linkColor = ['source', 'target'].includes(argument) ? argument : color(argument, at)
      else { if (!['left', 'right', 'justify'].includes(argument)) fail('nodeAlign 支持 left、right 或 justify。', at); nodeAlign = argument }
      continue
    }
    const fields = csv(at.text.trim(), at)
    if (fields.length !== 3) fail('桑基图每行必须为 来源,去向,数值 三个 CSV 字段。', at)
    const value = number(fields[2]!, at)
    if (value <= 0) fail('桑基图流量必须大于零。', at)
    if (fields[0] === fields[1]) fail('桑基图不支持自身回流。', at)
    const from = node(fields[0]!), to = node(fields[1]!)
    from.output += value; to.input += value; to.incoming++
    sources.add(at.line, `sankey-flow-${links.length}`)
    links.push({ source: from.name, target: to.name, value, at })
    if (nodes.size > 60 || links.length > 120) fail('桑基图最多支持 60 个节点和 120 条流向。', at)
  }
  if (!links.length) fail('桑基图需要至少一条流向。', lines[0]!)
  const queue = [...nodes.values()].filter(item => !item.incoming)
  for (let i = 0; i < queue.length; i++) for (const link of links.filter(link => link.source === queue[i]!.name)) {
    const target = nodes.get(link.target)!
    target.rank = Math.max(target.rank, queue[i]!.rank + 1)
    if (--target.incoming === 0) queue.push(target)
  }
  if (queue.length !== nodes.size) fail('桑基图存在循环流向；当前支持无环的分层流向。', links.find(link => nodes.get(link.target)!.incoming > 0)!.at)
  const maxRank = Math.max(...queue.map(item => item.rank))
  if (nodeAlign === 'justify') for (const item of queue) { if (!item.output) item.rank = maxRank }
  if (nodeAlign === 'right') {
    const distance = new Map<string, number>()
    for (const item of [...queue].reverse()) {
      distance.set(item.name, Math.max(0, ...links.filter(link => link.source === item.name).map(link => distance.get(link.target)! + 1)))
      item.rank = maxRank - distance.get(item.name)!
    }
  }
  const layers = new Map<number, typeof queue>()
  for (const item of nodes.values()) layers.set(item.rank, [...(layers.get(item.rank) || []), item])
  const gap = 26, plotHeight = Math.max(480, ...[...layers.values()].map(items => items.length * 42)), top = 125
  const scale = Math.min(...[...layers.values()].map(items => (plotHeight - gap * (items.length - 1)) / items.reduce((sum, item) => sum + Math.max(item.input, item.output), 0)))
  const warnings: string[] = []
  for (const [rank, items] of layers) {
    const total = items.reduce((sum, item) => sum + Math.max(item.input, item.output) * scale, 0) + gap * (items.length - 1)
    let y = top + (plotHeight - total) / 2
    for (const item of items) { item.x = 100 + rank * 260; item.y = y; item.height = Math.max(item.input, item.output) * scale; y += item.height + gap }
  }
  for (const item of nodes.values()) {
    let output = 0, input = 0
    for (const link of links.filter(link => link.source === item.name).sort((a, b) => nodes.get(a.target)!.y - nodes.get(b.target)!.y)) { link.from = item.y + output; output += link.value * scale }
    for (const link of links.filter(link => link.target === item.name).sort((a, b) => nodes.get(a.source)!.y - nodes.get(b.source)!.y)) { link.to = item.y + input; input += link.value * scale }
  }
  const elements: SceneElement[] = [titleNode(title)]
  links.forEach((link, index) => {
    const from = nodes.get(link.source)!, to = nodes.get(link.target)!, thickness = link.value * scale, points: Point[] = [], x0 = from.x + 20, x1 = to.x
    const sample = (t: number, bottom: boolean): Point => {
      const smooth = t * t * (3 - 2 * t)
      return { x: x0 + (x1 - x0) * t, y: link.from! + (link.to! - link.from!) * smooth + (bottom ? thickness : 0) }
    }
    for (let j = 0; j <= 24; j++) points.push(sample(j / 24, false))
    for (let j = 24; j >= 0; j--) points.push(sample(j / 24, true))
    elements.push(diagramStroke(`sankey-flow-${index}`, points, { fill: linkColor === 'source' ? COLORS[from.id % COLORS.length] : linkColor === 'target' ? COLORS[to.id % COLORS.length] : linkColor, stroke: 'none', strokeWidth: 0, opacity: .48 }, true))
  })
  for (const item of nodes.values()) {
    if (item.height < 1) warnings.push('极小流量节点使用最小可见高度，流带仍按实际比例绘制。')
    elements.push(diagramNode(`sankey-node-${item.id}`, '', item.x, item.y, 20, Math.max(1, item.height), 'rectangle', { fill: COLORS[item.id % COLORS.length], strokeWidth: 0 }))
    const summary = item.input && item.output && item.input !== item.output ? `入 ${labelNumber(item.input)} / 出 ${labelNumber(item.output)}` : labelNumber(Math.max(item.input, item.output))
    elements.push(diagramText(`sankey-label-${item.id}`, showValues ? `${item.name}\n${summary}` : item.name, item.x + 28, item.y + item.height / 2 - 28, 210, 56, { fontSize: 14, textAlign: 'left' }))
  }
  for (const [key, at] of options) if (key !== 'title') sources.add(at.line, ...elements.filter(element => key === 'showValues' ? element.id.startsWith('sankey-label-') : key === 'linkColor' ? element.id.startsWith('sankey-flow-') : element.id.startsWith('sankey-')).map(element => element.id))
  return finishDiagram('sankey', elements, warnings, sources)
}

function structuredList(value: string, at: Line): string[] {
  const result: string[] = [], brackets: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if ('[{'.includes(char)) brackets.push(char)
    if (']}'.includes(char)) { const expected = char === ']' ? '[' : '{'; if (brackets.pop() !== expected) fail('括号不匹配。', at) }
    if (char === ',' && !brackets.length) { result.push(value.slice(start, i).trim()); start = i + 1 }
  }
  if (quoted || brackets.length) fail('文字或括号未闭合。', at)
  result.push(value.slice(start).trim())
  if (result.some(value => !value)) fail('列表不能包含空项。', at)
  return result
}
function radarDescriptor(value: string, at: Line): { id: string; label: string } {
  const match = /^([A-Za-z_][A-Za-z\d_-]*)(?:\[\s*("(?:[^"\\]|\\.)*")\s*\])?$/.exec(value.trim())
  if (!match) return fail('雷达轴或曲线格式为 id 或 id["显示名称"]。', at)
  return { id: match[1]!, label: match[2] ? text(match[2], at) : match[1]! }
}
function radar(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  if (!/^radar(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('雷达图开头应为 radar-beta。', lines[0]!)
  const axes: { id: string; label: string; at: Line }[] = [], curves: { id: string; label: string; raw: string[]; at: Line; values: number[] }[] = [], declarations = new Set<string>()
  let title = '多维能力比较', minimum = 0, maximum: number | undefined, ticks = 5, polygon = false, showLegend = true, rotation = -90
  const curveStyles = new Map<string, { appearance: ChartAppearance; at: Line }>(), optionLines = new Map<string, Line>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim()
    if (value.startsWith('axis ')) {
      for (const entry of structuredList(value.slice(5), at)) { const descriptor = radarDescriptor(entry, at); if (axes.some(axis => axis.id === descriptor.id)) fail('雷达轴 ID 不能重复。', at); axes.push({ ...descriptor, at }) }
      if (axes.length > 30) fail('雷达图最多支持 30 个轴。', at)
      continue
    }
    if (value.startsWith('curve ')) {
      for (const entry of structuredList(value.slice(6), at)) {
        const match = /^(.*?)\{([^{}]*)\}$/.exec(entry)
        if (!match) fail('曲线格式为 curve id["名称"]{数值列表}。', at)
        const descriptor = radarDescriptor(match![1]!, at)
        if (curves.some(curve => curve.id === descriptor.id)) fail('曲线 ID 不能重复。', at)
        curves.push({ ...descriptor, raw: commaList(match![2]!, at), at, values: [] })
      }
      if (curves.length > 8) fail('雷达图最多支持 8 条曲线。', at)
      continue
    }
    const curveStyle = /^curveStyle\s+([A-Za-z_][A-Za-z\d_-]*)\s+(.+)$/.exec(value)
    if (curveStyle) { const id = curveStyle[1]!; if (curveStyles.has(id)) fail('同一曲线的样式不能重复。', at); curveStyles.set(id, { appearance: chartAppearance(curveStyle[2]!, at), at }); continue }
    const directive = /^(title|min|max|ticks|graticule|showLegend|rotation)\s+(.+)$/.exec(value)
    if (!directive) fail('雷达图支持 axis、curve、title、min、max、ticks、graticule 和 showLegend。', at)
    const key = directive![1]!, argument = directive![2]!.trim()
    if (declarations.has(key)) fail(`“${key}”不能重复声明。`, at)
    declarations.add(key); optionLines.set(key, at)
    if (key === 'title') { title = text(argument, at); sources.add(at.line, 'chart-title') }
    else if (key === 'min') minimum = number(argument, at)
    else if (key === 'max') maximum = number(argument, at)
    else if (key === 'ticks') { ticks = number(argument, at); if (!Number.isInteger(ticks) || ticks < 1 || ticks > 12) fail('ticks 必须为 1 到 12 的整数。', at) }
    else if (key === 'rotation') { rotation = number(argument, at); if (rotation < -360 || rotation > 360) fail('rotation 必须在 -360 到 360 度之间。', at) }
    else if (key === 'graticule') { if (!['circle', 'polygon'].includes(argument)) fail('graticule 支持 circle 或 polygon。', at); polygon = argument === 'polygon' }
    else { if (!['true', 'false'].includes(argument)) fail('showLegend 必须为 true 或 false。', at); showLegend = argument === 'true' }
  }
  for (const [id, entry] of curveStyles) if (!curves.some(curve => curve.id === id)) fail(`曲线样式引用了未知曲线“${id}”。`, entry.at)
  if (axes.length < 3 || !curves.length) fail('雷达图需要至少 3 个轴和 1 条曲线。', lines[0]!)
  for (const curve of curves) {
    if (curve.raw.some(value => value.includes(':'))) {
      const pairs = new Map<string, number>()
      for (const item of curve.raw) { const match = /^([A-Za-z_][A-Za-z\d_-]*)\s*:\s*(.+)$/.exec(item); if (!match || !axes.some(axis => axis.id === match[1])) fail('曲线数据引用了未知的轴，或混合了两种数值写法。', curve.at); if (pairs.has(match![1]!)) fail('曲线中的轴 ID 不能重复。', curve.at); pairs.set(match![1]!, number(match![2]!, curve.at)) }
      if (pairs.size !== axes.length) fail('每条曲线必须提供全部轴的数值。', curve.at)
      curve.values = axes.map(axis => pairs.get(axis.id)!)
    } else { if (curve.raw.length !== axes.length) fail('曲线数值数量必须与轴数量一致。', curve.at); curve.values = curve.raw.map(value => number(value, curve.at)) }
  }
  maximum ??= Math.max(minimum + 1, ...curves.flatMap(curve => curve.values))
  if (minimum >= maximum) fail('雷达图 max 必须大于 min。', lines[0]!)
  for (const curve of curves) if (curve.values.some(value => value < minimum || value > maximum!)) fail('曲线数值超出了 min/max 的范围。', curve.at)
  const elements: SceneElement[] = [titleNode(title)], cx = 420, cy = 390, radius = 240
  const point = (index: number, amount: number): Point => ({ x: cx + Math.cos(rotation * Math.PI / 180 + index * Math.PI * 2 / axes.length) * amount, y: cy + Math.sin(rotation * Math.PI / 180 + index * Math.PI * 2 / axes.length) * amount })
  for (let index = 1; index <= ticks; index++) {
    const r = radius * index / ticks
    elements.push(polygon ? diagramStroke(`radar-grid-${index}`, axes.map((_, i) => point(i, r)), { fill: 'none', stroke: '#d2dce9', strokeWidth: 1 }, true) : diagramNode(`radar-grid-${index}`, '', cx - r, cy - r, r * 2, r * 2, 'ellipse', { fill: 'none', stroke: '#d2dce9', strokeWidth: 1 }))
    elements.push(diagramText(`radar-tick-${index}`, labelNumber(minimum + (maximum - minimum) * index / ticks), cx + 6, cy - r - 16, 95, 26, { fontSize: 11, textAlign: 'left', stroke: '#718099' }))
  }
  axes.forEach((axis, index) => {
    sources.add(axis.at.line, `radar-axis-${axis.id}`, `radar-label-${axis.id}`)
    const end = point(index, radius), label = point(index, radius + 42)
    elements.push(stroke(`radar-axis-${axis.id}`, [{ x: cx, y: cy }, end], { stroke: '#b9c5d6' }))
    elements.push(diagramText(`radar-label-${axis.id}`, axis.label, label.x - 90, label.y - 18, 180, 36, { fontSize: 15 }))
  })
  curves.forEach((curve, index) => {
    const firstElement = elements.length
    const appearance = curveStyles.get(curve.id), color = appearance?.appearance.stroke || appearance?.appearance.fill || COLORS[index]!, points = curve.values.map((value, i) => point(i, radius * (value - minimum) / (maximum - minimum)))
    elements.push(diagramStroke(`radar-curve-${curve.id}`, points, { fill: color, stroke: color, strokeWidth: 2.5, opacity: .3, ...elementAppearance(appearance?.appearance || {}) }, true))
    points.forEach((p, i) => elements.push(diagramNode(`radar-point-${curve.id}-${i}`, '', p.x - 3, p.y - 3, 6, 6, 'ellipse', { fill: color, stroke: color, strokeWidth: 1 })))
    if (showLegend) {
      elements.push(diagramNode(`radar-key-${curve.id}`, '', 810, 150 + index * 42, 18, 18, 'rectangle', style(color, color)))
      elements.push(diagramText(`radar-legend-${curve.id}`, curve.label, 842, 140 + index * 42, 240, 38, { textAlign: 'left', fontSize: 15, stroke: appearance?.appearance.textColor || '#334155' }))
    }
    if (appearance) sources.capture(appearance.at.line, elements, firstElement)
    sources.capture(curve.at.line, elements, firstElement)
  })
  for (const [key, at] of optionLines) if (key !== 'title') sources.add(at.line, ...elements.filter(element => key === 'showLegend' && showLegend ? /^radar-(key|legend)-/.test(element.id) : element.id.startsWith('radar-')).map(element => element.id))
  return finishDiagram('radar', elements, [], sources)
}

interface TreeEntry { id: number; name: string; at: Line; indent: number; children: TreeEntry[]; value?: number; childIndent?: number; className?: string }
function treemap(lines: Line[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  if (!/^treemap(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('树图开头应为 treemap-beta。', lines[0]!)
  const root: TreeEntry = { id: -1, name: '', at: lines[0]!, indent: -1, children: [] }, stack = [root]
  let count = 0, previous: TreeEntry | undefined, title: string | undefined, showValues = true
  const classes = new Map<string, { appearance: ChartAppearance; at: Line }>(), options = new Map<string, Line>()
  for (const at of lines.slice(1)) {
    if (/^\s*\t/.test(at.text) || /^[ \t]*\t/.test(at.text)) fail('树图缩进请使用空格，不支持制表符。', at)
    const directive = /^(title|showValues)\s+(.+)$/.exec(at.text.trim())
    if (directive) { const key = directive[1]!; if (options.has(key)) fail(`“${key}”不能重复。`, at); options.set(key, at); if (key === 'title') { title = text(directive[2]!, at); sources.add(at.line, 'chart-title') } else showValues = boolean(directive[2]!, at); continue }
    const classDefinition = /^classDef\s+([A-Za-z_][A-Za-z\d_-]*)\s+(.+)$/.exec(at.text.trim())
    if (classDefinition) { const id = classDefinition[1]!; if (classes.has(id)) fail('样式类名称不能重复。', at); classes.set(id, { appearance: chartAppearance(classDefinition[2]!, at), at }); continue }
    const indent = at.text.length - at.text.trimStart().length, match = new RegExp(`^("(?:[^"\\\\]|\\\\.)*")(?:\\s*:\\s*(${NUMBER}))?(?:\\s*:::([A-Za-z_][A-Za-z\\d_-]*))?$`).exec(at.text.trim())
    if (!match) fail('树图分组格式为 "名称"，叶子格式为 "名称": 正数，可在末尾添加 :::类名。', at)
    if (previous && indent > previous.indent && previous.value !== undefined) fail('带数值的叶子不能再包含子项。', at)
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    const parent = stack.at(-1)!
    if (parent.childIndent !== undefined && parent.childIndent !== indent) fail('同一分组的直接子项必须使用一致缩进。', at)
    parent.childIndent = indent
    const value = match![2] === undefined ? undefined : number(match![2], at)
    if (value !== undefined && value <= 0) fail('树图叶子的数值必须大于零。', at)
    const entry: TreeEntry = { id: count++, name: text(match![1]!, at), at, indent, value, className: match![3], children: [] }
    sources.add(at.line, `treemap-leaf-${entry.id}`, `treemap-label-${entry.id}`, `treemap-group-${entry.id}`, `treemap-key-${entry.id}`, `treemap-detail-${entry.id}`)
    parent.children.push(entry); previous = entry
    if (value === undefined) stack.push(entry)
    if (count > 200 || stack.length > 11) fail('树图最多支持 200 个条目和 10 层嵌套。', at)
  }
  if (!root.children.length) fail('树图至少需要一个带正数的叶子。', lines[0]!)
  function total(entry: TreeEntry): number {
    if (entry.value !== undefined) return entry.value
    if (!entry.children.length) return fail(`分组“${entry.name}”没有叶子数据。`, entry.at)
    entry.value = entry.children.reduce((sum, child) => sum + total(child), 0)
    return entry.value
  }
  total(root)
  const elements: SceneElement[] = [titleNode(title || (root.children.length === 1 && root.children[0]!.children.length ? root.children[0]!.name : '层级面积图'))], warnings: string[] = []
  const leaves: { entry: TreeEntry; path: string; color: string }[] = []
  function layout(entry: TreeEntry, x: number, y: number, width: number, height: number, branch: number, path: string[], inherited: ChartAppearance = {}, inheritedLines: number[] = []): void {
    const definition = entry.className ? classes.get(entry.className) : undefined
    if (entry.className && !definition) fail(`找不到样式类“${entry.className}”。`, entry.at)
    const appearance = { ...inherited, ...definition?.appearance }, appearanceLines = definition ? [...inheritedLines, definition.at.line] : inheritedLines
    for (const line of appearanceLines) sources.add(line, `treemap-leaf-${entry.id}`, `treemap-label-${entry.id}`, `treemap-group-${entry.id}`, `treemap-key-${entry.id}`, `treemap-detail-${entry.id}`)
    if (!entry.children.length) {
      const color = appearance.fill || COLORS[Math.max(0, branch) % COLORS.length]!
      elements.push(diagramStroke(`treemap-leaf-${entry.id}`, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], { fill: color, stroke: '#ffffff', strokeWidth: 1.5, ...elementAppearance(appearance) }, true))
      if (width >= 70 && height >= 64) elements.push(diagramText(`treemap-label-${entry.id}`, showValues ? `${entry.name}\n${labelNumber(entry.value!)}` : entry.name, x + 4, y + height / 2 - 32, width - 8, 64, { fontSize: 14, stroke: appearance.textColor || '#ffffff' }))
      else warnings.push('部分区块较小，名称和数值显示在右侧明细中。')
      leaves.push({ entry, path: [...path, entry.name].join(' / '), color }); return
    }
    let offset = 0
    entry.children.forEach((child, index) => {
      const fraction = child.value! / entry.value!, span = (width >= height ? width : height) * fraction
      const childBranch = branch < 0 ? (entry.children.length > 1 ? index : -1) : branch
      layout(child, width >= height ? x + offset : x, width >= height ? y : y + offset, width >= height ? span : width, width >= height ? height : span, childBranch, entry === root ? [] : [...path, entry.name], appearance, appearanceLines)
      offset += span
    })
    if (entry !== root) elements.push(diagramStroke(`treemap-group-${entry.id}`, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], { fill: 'none', stroke: appearance.stroke || '#ffffff', strokeWidth: appearance.strokeWidth ?? 4, opacity: appearance.opacity ?? 1 }, true))
  }
  layout(root, 80, 125, 980, 580, -1, [])
  leaves.forEach(({ entry, path, color }, index) => {
    elements.push(diagramNode(`treemap-key-${entry.id}`, '', 1100, 130 + index * 34, 14, 14, 'rectangle', style(color, color)))
    elements.push(diagramText(`treemap-detail-${entry.id}`, showValues ? `${path}  ${labelNumber(entry.value!)} · ${Number((entry.value! / root.value! * 100).toFixed(1))}%` : path, 1125, 118 + index * 34, 510, 36, { textAlign: 'left', fontSize: 13 }))
  })
  const valuesOption = options.get('showValues'); if (valuesOption) sources.add(valuesOption.line, ...elements.filter(element => /^treemap-(label|detail)-/.test(element.id)).map(element => element.id))
  return finishDiagram('treemap', elements, warnings, sources)
}

/** Returns undefined for diagram families owned by other parsers. */
export function compileChartDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source), header = lines[0]
  if (!header || !/^(?:pie|gantt|xychart(?:-beta)?|quadrantChart|sankey(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?)\b/.test(header.text.trim())) return undefined
  if (source.length > 200000 || lines.length > 2000) fail('图表源码超过 200,000 字符或 2,000 行。', header)
  if (/^pie\b/.test(header.text.trim())) return pie(lines)
  if (/^gantt\b/.test(header.text.trim())) return gantt(lines)
  if (/^xychart(?:-beta)?\b/.test(header.text.trim())) return xyChart(lines)
  if (/^sankey(?:-beta)?\b/.test(header.text.trim())) return sankey(lines)
  if (/^radar(?:-beta)?\b/.test(header.text.trim())) return radar(lines)
  if (/^treemap(?:-beta)?\b/.test(header.text.trim())) return treemap(lines)
  return quadrant(lines)
}

export const CHART_TEMPLATES: DiagramTemplate[] = [
  { id: 'pie', kind: 'pie', title: '季度资源结构复盘', description: '分类数值、零值项目与比例，检查研发和服务资源的实际分配。', category: '数据图表', source: `pie showData
%% 数值按统一单位统计，零值项目仍保留在图例中。
  title "季度资源结构 · 人日"
  innerRadius 0
  showLegend true
  "需求研究" : 80
  "核心研发" : 210
  "交付验证" : 95
  "客户支持" : 65
  "平台维护" : 40
  "能力培训" : 25
  "预备项目" : 0` },
  { id: 'gantt', kind: 'gantt', title: '跨团队交付工作日计划', description: '排除周末与假日、补班覆盖、并行依赖、关键任务和里程碑。', category: '项目计划', source: `gantt
%% excludes 定义休息日；includes 指定补班，优先于排除规则。
  title 跨团队交付工作日计划
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  excludes weekends, 2026-10-09
  includes 2026-10-10
  tickInterval 1w
  section 需求与设计
  需求确认 :done, requirements, 2026-10-05, 3d
  交互设计 :active, design, after requirements, 4d
  技术评审 :review, after requirements, 2d
  section 并行实施
%% after 后可以列出多个任务，全部完成才开始。
  核心开发 :crit, core, after design review, 8d
  帮助文档 :docs, after design, 1w
  数据迁移演练 :migration, after review, 5d
  section 验收与上线
  联合验收 :crit, acceptance, after core docs migration, 3d
  正式交付 :milestone, release, after acceptance, 0d` },
  { id: 'xychart', kind: 'xychart', title: '区域交付与目标复盘', description: '命名并列柱形、目标折线、分类轴和显式刻度，识别交付缺口。', category: '数据图表', source: `xychart-beta
%% 所有序列按同一分类顺序，柱形比较实际值，折线表示目标。
  title "区域交付与目标 · 上半年"
  x-axis "月份" ["一月", "二月", "三月", "四月", "五月", "六月"]
  y-axis "交付数量" 0 --> 120
  y-ticks 6
  showLegend true
  bar "东区交付" [35, 48, 42, 64, 76, 88]
  bar "西区交付" [28, 39, 45, 52, 62, 73]
  line "东区目标" [40, 45, 55, 70, 80, 100]
  line "西区目标" [30, 40, 50, 60, 70, 80]` },
  { id: 'quadrant', kind: 'quadrant', title: '需求投资组合评审', description: '四个决策区域、复用点样式与单点覆盖，突出关键需求。', category: '分析决策', source: `quadrantChart
  title 需求投资组合评审
  x-axis 投入较低 --> 投入较高
  y-axis 价值较低 --> 价值较高
  quadrant-1 战略投入
  quadrant-2 优先推进
  quadrant-3 低成本改善
  quadrant-4 暂缓立项
%% 类控制点的大小、填色和边框；单点属性覆盖同名类属性。
  classDef urgent color:#d85a72,radius:10,stroke-color:#91394b,stroke-width:2
  classDef stable color:#427db5,radius:7,stroke-color:#ffffff,stroke-width:2
  "搜索体验":::urgent: [0.22, 0.82]
  "协作能力":::urgent: [0.78, 0.87] radius:13
  "导出改进":::stable: [0.46, 0.61]
  "文案统一":::stable: [0.18, 0.24]
  "特殊报表": [0.81, 0.27] radius:6,color:#9b8da8,stroke-color:#ffffff,stroke-width:1
  "旧接口清理": [0.58, 0.43]` },
  { id: 'sankey', kind: 'sankey', title: '年度预算分层分配', description: '按来源着色的流带与分层汇总，追踪预算从部门流向实际成果。', category: '数据图表', source: `sankey-beta
  title 年度预算分层分配
  nodeAlign left
  linkColor source
  showValues true
%% 来源,去向,金额；输入与输出不一致时同时显示两者。
预算,产品研发,60
预算,客户服务,25
预算,运营保障,15
产品研发,核心能力,40
产品研发,体验改进,20
客户服务,体验改进,10
客户服务,知识支持,15
运营保障,稳定性,15
核心能力,客户交付,40
体验改进,客户交付,30
知识支持,客户交付,15` },
  { id: 'radar', kind: 'radar', title: '团队能力改进计划', description: '位置数据与按轴命名数据对照，设置多边形网格、曲线样式和目标。', category: '数据图表', source: `radar-beta
  title 团队能力改进计划
  axis planning["需求规划"], delivery["稳定交付"], quality["质量保障"]
  axis teamwork["跨组协作"], learning["知识积累"], support["服务响应"]
%% 位置写法遵循轴声明顺序；键值写法可自由调整轴的排列。
  curve current["当前基线"]{75, 85, 70, 90, 80, 68}
  curve target["下季目标"]{support: 88, planning: 90, delivery: 92, quality: 90, teamwork: 95, learning: 90}
  min 0
  max 100
  ticks 5
  graticule polygon
  rotation -90
  showLegend true
  curveStyle current fill:#6389e7,stroke:#325ea8,stroke-width:2,opacity:0.25,color:#24334d
  curveStyle target fill:#61b9a0,stroke:#26846d,stroke-width:3,opacity:0.16` },
  { id: 'treemap', kind: 'treemap', title: '产品投入层级审计', description: '三级预算分组、面积比例、继承样式和局部重点，明细显示完整路径。', category: '数据图表', source: `treemap-beta
  title 产品投入层级审计
  showValues true
%% 分组样式传给所有子项，叶子可以覆盖填色与文字颜色。
  classDef research fill:#437ca7,stroke:#ffffff,stroke-width:2,color:#ffffff
  classDef operation fill:#4d9e86,stroke:#ffffff,stroke-width:2,color:#ffffff
  classDef focus fill:#cb9340,stroke:#70511e,stroke-width:3,opacity:0.9,color:#ffffff
"年度投入"
  "研发":::research
    "产品能力"
      "需求研究": 18
      "核心开发": 32
    "交付保障"
      "自动化验证": 15:::focus
      "文档建设": 8
  "服务与运营":::operation
    "用户服务": 12
    "内容建设": 8
  "基础设施"
    "运行环境": 10
    "数据备份": 5` },
  { id: 'pie-capacity', kind: 'pie', title: '容量余量环形视图', description: '内环比例与紧凑无图例模式，用于容量分配概览。', category: '数据图表', source: `pie title "容量余量 · 标注百分比"
%% innerRadius 是内半径比例；此处关闭图例，保留扇区百分比。
  innerRadius 0.55
  showLegend false
  "主业务" : 36
  "检索服务" : 22
  "批处理" : 14
  "监控" : 9
  "备份" : 7
  "可用余量" : 12` },
  { id: 'gantt-cutover', kind: 'gantt', title: '切换窗口与保障交接', description: '固定日期边界、until 截止、连续任务和自定义休息日，适合上线窗口。', category: '项目计划', source: `gantt
  title 切换窗口与保障交接
  dateFormat YYYY-MM-DD
  axisFormat %Y-%m-%d
%% 本团队周一轮休，指定日期临时补班；固定截止日期不自动顺延。
  excludes monday, 2026-11-12
  includes 2026-11-09
  tickInterval 2d
  section 数据准备
  数据核对 :done, audit, 2026-11-03, 2026-11-06
  差异修复 :active, repair, after audit, 3d
  最后验证 :validation, 2d
  section 切换窗口
%% until 指向后续任务的开始时间，形成明确的保障边界。
  灰度观察 :crit, watch, after validation, until switch
  执行切换 :milestone, switch, 2026-11-15, 0d
  section 交接
  值守保障 :guard, after switch, 4d
  运维交接 :handover, after guard, 2d
  项目关闭 :milestone, close, after handover, 0d` },
  { id: 'xychart-balance', kind: 'xychart', title: '分时偏差与容量平衡', description: '横向数值坐标、正负偏差和零基线，无图例紧凑趋势图。', category: '数据图表', source: `xychart-beta horizontal
%% 数值 X 轴把样本均匀布置在 0 至 24 小时之间。
  title "分时容量偏差 · 正值为余量"
  x-axis "小时" 0 --> 24
  y-axis "偏差" -40 --> 60
  y-ticks 10
  showLegend false
  line [18, 24, -12, -28, 5, 32, 48]
  line "警戒线" [-20, -20, -20, -20, -20, -20, -20]` },
  { id: 'quadrant-risk', kind: 'quadrant', title: '服务风险处置分级', description: '默认象限、边界坐标与不同责任域点样式，支持风险评审。', category: '分析决策', source: `quadrantChart
  title 服务风险处置分级
  x-axis 发生概率低 --> 发生概率高
  y-axis 影响有限 --> 影响严重
  quadrant-1 立即处置
  quadrant-2 应急预案
  quadrant-3 定期复核
  quadrant-4 自动缓解
%% 先引用后声明也可解析；边界点表示零概率或最高影响。
  "备份不可恢复":::critical: [0.24, 1]
  "容量不足":::critical: [0.73, 0.86]
  "低频超时":::watch: [0.68, 0.24]
  "日志延迟":::watch: [0.18, 0.12]
  "已消除漏洞": [0, 0.43] radius:4,color:#6f8b82
  "跨区依赖": [0.52, 0.63] radius:9,color:#b28340,stroke-color:#664b20,stroke-width:2
  classDef critical color:#c95765,radius:11,stroke-color:#853743,stroke-width:2
  classDef watch color:#5b88b7,radius:6` },
  { id: 'sankey-energy', kind: 'sankey', title: '园区能源去向盘点', description: '按目标着色，所有终点右侧对齐，展示不同长度的分配路径。', category: '数据图表', source: `sankey-beta
  title 园区能源去向盘点
  nodeAlign justify
  linkColor target
  showValues true
%% 双引号支持带逗号的业务名称；流带仍严格按数值分配。
电网,总配电,75
光伏,总配电,25
总配电,生产设备,45
总配电,办公区域,20
总配电,"冷却,照明",20
总配电,线损,15
生产设备,有效产出,38
生产设备,设备损耗,7
办公区域,有效产出,18
办公区域,待机损耗,2
"冷却,照明",有效产出,20` },
  { id: 'sankey-intake', kind: 'sankey', title: '需求受理与交付路径', description: '终点距离对齐、统一流带颜色与隐藏数值，突出处理路径。', category: '数据图表', source: `sankey-beta
  title 需求受理与交付路径
  nodeAlign right
  linkColor #7794b3
  showValues false
%% 不同来源经历不同数量的处理环节，右对齐便于比较汇入位置。
用户建议,需求池,25
内部评审,需求池,15
紧急修复,开发中,10
需求池,待评审,30
需求池,暂缓,10
待评审,开发中,20
待评审,暂缓,10
开发中,验收中,25
开发中,继续开发,5
验收中,已交付,25` },
  { id: 'radar-service', kind: 'radar', title: '服务质量达标比较', description: '圆形网格、非零下限、旋转轴与隐藏图例，比较接近目标的质量分数。', category: '数据图表', source: `radar-beta
  title 服务质量达标比较
%% 下限设为 60 放大达标区间；数据必须处于显式范围内。
  axis response["响应"], accuracy["准确"], recovery["恢复"], coverage["覆盖"], clarity["可理解性"]
  curve before["改进前"]{response: 74, accuracy: 88, recovery: 68, coverage: 80, clarity: 76}
  curve after["改进后"]{90, 94, 88, 92, 91}
  min 60
  max 100
  ticks 4
  graticule circle
  rotation 0
  showLegend false
  curveStyle before fill:#ba8d64,stroke:#95693f,stroke-width:2,opacity:0.2
  curveStyle after fill:#6d93cb,stroke:#315d9b,stroke-width:3,opacity:0.25` },
  { id: 'treemap-portfolio', kind: 'treemap', title: '业务组合占用结构', description: '多个顶层业务、深层归属与隐藏数值，重点展示资源占用轮廓。', category: '数据图表', source: `treemap-beta
  title 业务组合占用结构
  showValues false
%% 顶层可有多个业务；颜色从分组继承，关键叶子局部覆盖。
"核心业务":::core
  "交易"
    "订单处理": 34
    "结算": 18
  "客户"
    "账户服务": 16
    "消息通知": 8
"增长业务":::growth
  "渠道连接": 12
  "活动运营": 7:::priority
"共享能力"
  "检索": 10
  "审计": 5
  classDef core fill:#486e9b,color:#ffffff,stroke:#d9e4f2,stroke-width:2
  classDef growth fill:#669280,color:#ffffff,stroke:#e0eee9,stroke-width:2
  classDef priority fill:#ae8052,color:#ffffff,stroke:#6d4b2b,stroke-width:3,opacity:0.85` },
]
