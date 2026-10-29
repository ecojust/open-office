import { buildCalendar, projectedSpan, type ScheduleCalendar } from './calendar.ts'
import type { HolidayYears } from './holidays.ts'
import { buildTimelineRows, getEventVerticalLayout, getTrackHeight, SCHEDULE_HEADER_HEIGHT, SCHEDULE_LABEL_WIDTH, type TimelineRow } from './layout.ts'
import { validateSchedule, type ScheduleProject } from './model.ts'

export type SchedulePngOptions = { mode: 'people' | 'global'; dayWidth?: number; holidayYears?: HolidayYears }
export type SchedulePngResult = { bytes: Uint8Array; width: number; height: number; scale: number }
export const SCHEDULE_PNG_MAX_SIDE = 16384
export const SCHEDULE_PNG_MAX_PIXELS = 24_000_000
const MARGIN = 24, TITLE_HEIGHT = 88, FOOTER_HEIGHT = 48, WEEK_HEIGHT = 28
const FONT = '"Office UI", "Office UI CJK", "PingFang SC", "Microsoft YaHei", sans-serif'
const COLOR = { text: '#202b3b', muted: '#647287', subtle: '#8390a1', line: '#e3e6eb', strong: '#cbd2dc', mutedSurface: '#f7f8fa', accent: '#315fd6', soft: '#edf2fd' }
const weekdays = ['日', '一', '二', '三', '四', '五', '六']

/** Keep the complete table in one PNG while bounding both bitmap memory and dimensions. */
export function fitSchedulePngDimensions(logicalWidth: number, logicalHeight: number): { width: number; height: number; scale: number } {
 if (!Number.isFinite(logicalWidth) || !Number.isFinite(logicalHeight) || logicalWidth < 1 || logicalHeight < 1) throw Error('排期图片尺寸无效。')
 // Reserve at most one rounded pixel on each edge before rounding dimensions up.
 const budget = SCHEDULE_PNG_MAX_PIXELS - SCHEDULE_PNG_MAX_SIDE * 2 - 1
 const scale = Math.min(2, SCHEDULE_PNG_MAX_SIDE / logicalWidth, SCHEDULE_PNG_MAX_SIDE / logicalHeight, Math.sqrt(budget / (logicalWidth * logicalHeight)))
 const width = Math.max(1, Math.min(SCHEDULE_PNG_MAX_SIDE, Math.ceil(logicalWidth * scale)))
 const height = Math.max(1, Math.min(SCHEDULE_PNG_MAX_SIDE, Math.ceil(logicalHeight * scale)))
 return { width, height, scale }
}

export type SchedulePngLayout = {
 project: ScheduleProject; mode: 'people' | 'global'; calendar: ScheduleCalendar
 rows: (TimelineRow & { top: number; height: number })[]; dayWidth: number
 tableWidth: number; tableBottom: number; logicalWidth: number; logicalHeight: number
 width: number; height: number; scale: number; hiddenEvents: number
}

/** Data-driven layout deliberately includes rows and dates outside the scroll viewport. */
export function buildSchedulePngLayout(source: ScheduleProject, options: SchedulePngOptions): SchedulePngLayout {
 const project = validateSchedule(source)
 if (options.mode !== 'people' && options.mode !== 'global') throw Error('排期视图模式无效。')
 const dayWidth = Math.max(36, Math.min(160, Number.isFinite(options.dayWidth) ? options.dayWidth! : 64))
 const calendar = buildCalendar(project, options.holidayYears)
 const tableWidth = SCHEDULE_LABEL_WIDTH + Math.max(360, calendar.days.length * dayWidth)
 let top = TITLE_HEIGHT + SCHEDULE_HEADER_HEIGHT
 const rows = buildTimelineRows(project, options.mode, calendar.days).map(row => {
  const height = getTrackHeight(project, row.key), result = { ...row, top, height }
  top += height
  return result
 })
 const logicalWidth = tableWidth + MARGIN * 2, logicalHeight = top + FOOTER_HEIGHT
 return { project, mode: options.mode, calendar, rows, dayWidth, tableWidth, tableBottom: top, logicalWidth, logicalHeight,
  ...fitSchedulePngDimensions(logicalWidth, logicalHeight), hiddenEvents: project.events.filter(event => !projectedSpan(event, calendar.days)).length }
}

function font(context: CanvasRenderingContext2D, size: number, weight = 400) { context.font = `${weight} ${size}px ${FONT}` }
function text(context: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, color = COLOR.text, align: CanvasTextAlign = 'left') {
 if (width < 2 || !value) return
 const clean = value.replace(/[\r\n\t]+/g, ' ')
 let shown = clean
 if (context.measureText(shown).width > width) {
  const characters = Array.from(clean), ellipsis = '…'
  if (context.measureText(ellipsis).width > width) return
  let low = 0, high = characters.length
  while (low < high) {
   const middle = Math.ceil((low + high) / 2)
   if (context.measureText(characters.slice(0, middle).join('') + ellipsis).width <= width) low = middle
   else high = middle - 1
  }
  shown = characters.slice(0, low).join('') + ellipsis
 }
 context.fillStyle = color; context.textAlign = align; context.textBaseline = 'middle'
 context.fillText(shown, align === 'center' ? x + width / 2 : align === 'right' ? x + width : x, y)
}
function line(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color = COLOR.line) {
 context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.strokeStyle = color; context.lineWidth = 1; context.stroke()
}
function fill(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string) { context.fillStyle = color; context.fillRect(x, y, width, height) }
function tint(color: string, strength: number): string {
 const rgb = [1, 3, 5].map(offset => Math.round(255 + (parseInt(color.slice(offset, offset + 2), 16) - 255) * strength))
 return `rgb(${rgb.join(',')})`
}
function rounded(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
 const radius = Math.min(5, width / 2, height / 2)
 context.beginPath(); context.moveTo(x + radius, y); context.lineTo(x + width - radius, y)
 context.quadraticCurveTo(x + width, y, x + width, y + radius); context.lineTo(x + width, y + height - radius)
 context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height); context.lineTo(x + radius, y + height)
 context.quadraticCurveTo(x, y + height, x, y + height - radius); context.lineTo(x, y + radius)
 context.quadraticCurveTo(x, y, x + radius, y); context.closePath()
}

function drawTable(context: CanvasRenderingContext2D, plan: SchedulePngLayout) {
 const { project, calendar, rows, dayWidth, tableWidth, tableBottom } = plan
 const left = MARGIN, datesLeft = left + SCHEDULE_LABEL_WIDTH, right = left + tableWidth
 fill(context, 0, 0, plan.logicalWidth, plan.logicalHeight, '#ffffff')
 font(context, 22, 600); text(context, project.title, left, 30, tableWidth)
 font(context, 12); text(context, `${project.startDate} — ${project.endDate}  ·  ${plan.mode === 'people' ? '人员模式' : '全局模式'}  ·  ${project.calendar.weekNumbering === 'project' ? '按项目计周' : '按年计周'}  ·  ${project.roles.length} 名人员 / ${project.events.length} 个事件`, left, 59, tableWidth, COLOR.muted)
 fill(context, left, TITLE_HEIGHT, tableWidth, SCHEDULE_HEADER_HEIGHT, COLOR.mutedSurface)
 if (rows[0]) fill(context, left, rows[0].top, tableWidth, rows[0].height, COLOR.soft)

 // Column backgrounds and lines span the whole table, avoiding rows × days work.
 for (let index = 0; index < calendar.days.length; index++) {
  const day = calendar.days[index], x = datesLeft + index * dayWidth
  if (day.holiday || day.weekday === 0 || day.weekday === 6) fill(context, x, TITLE_HEIGHT + WEEK_HEIGHT, dayWidth, tableBottom - TITLE_HEIGHT - WEEK_HEIGHT, '#f4f5f7')
  line(context, x, TITLE_HEIGHT + WEEK_HEIGHT, x, tableBottom)
  font(context, 11); text(context, day.date.slice(5).replace('-', '/'), x + 3, TITLE_HEIGHT + 43, dayWidth - 6, COLOR.text, 'center')
  font(context, 9); text(context, `周${weekdays[day.weekday]}`, x + 3, TITLE_HEIGHT + 59, dayWidth - 6, COLOR.muted, 'center')
 }
 if (calendar.days.length) line(context, datesLeft + calendar.days.length * dayWidth, TITLE_HEIGHT + WEEK_HEIGHT, datesLeft + calendar.days.length * dayWidth, tableBottom)
 for (const week of calendar.weeks) {
  const x = datesLeft + week.startIndex * dayWidth, width = week.count * dayWidth
  const yearOrProject = project.calendar.weekNumbering === 'project' ? '项目周' : String(week.weekYear)
  line(context, x, TITLE_HEIGHT, x, TITLE_HEIGHT + SCHEDULE_HEADER_HEIGHT, COLOR.strong)
  if (width < 96) {
   // A partial week may contain just one 36px day; retain both year and W53.
   font(context, 9); text(context, yearOrProject, x + 3, TITLE_HEIGHT + 7, width - 6, COLOR.muted, 'center')
   font(context, 11, 600); text(context, week.label, x + 3, TITLE_HEIGHT + 21, width - 6, COLOR.accent, 'center')
  } else {
   font(context, 11, 600); text(context, week.label, x + 9, TITLE_HEIGHT + 14, 33, COLOR.accent)
   font(context, 10); text(context, `${yearOrProject}${width >= 150 ? ` · ${calendar.days[week.startIndex].date.slice(5).replace('-', '/')}` : ''}`, x + 49, TITLE_HEIGHT + 14, width - 58, COLOR.muted)
  }
 }
 font(context, 12, 600); text(context, plan.mode === 'people' ? '人员 / 角色' : '全局事件', left + 15, TITLE_HEIGHT + 26, SCHEDULE_LABEL_WIDTH - 30)
 font(context, 10); text(context, `${calendar.days.length} 个显示日 · 隐藏 ${calendar.hiddenCount} 天`, left + 15, TITLE_HEIGHT + 48, SCHEDULE_LABEL_WIDTH - 30, COLOR.muted)
 line(context, datesLeft, TITLE_HEIGHT + WEEK_HEIGHT, right, TITLE_HEIGHT + WEEK_HEIGHT)
 line(context, left, TITLE_HEIGHT + SCHEDULE_HEADER_HEIGHT, right, TITLE_HEIGHT + SCHEDULE_HEADER_HEIGHT, COLOR.strong)

 for (const row of rows) {
  const color = /^#[\da-fA-F]{6}$/.test(row.color) ? row.color : COLOR.accent
  const textLeft = left + 30, textWidth = SCHEDULE_LABEL_WIDTH - 44
  context.beginPath(); context.arc(left + 17, row.top + 24, 4, 0, Math.PI * 2); context.fillStyle = color; context.fill()
  font(context, 12, 600); text(context, row.name, textLeft, row.top + 24, textWidth)
  font(context, 10); text(context, row.subtitle, textLeft, row.top + 43, textWidth, COLOR.muted)
  font(context, 9); text(context, `${row.total} 个事件`, textLeft, row.top + 61, textWidth, COLOR.subtle)
  line(context, left, row.top + row.height, right, row.top + row.height, row.key === 'overall' ? COLOR.strong : COLOR.line)
  for (const item of row.events) {
   const { event } = item, vertical = getEventVerticalLayout(row.height, event)
   const x = datesLeft + item.start * dayWidth + 3, y = row.top + vertical.top
   const width = Math.max(10, item.count * dayWidth - 6), height = vertical.height
   context.save(); rounded(context, x, y, width, height); context.fillStyle = tint(color, .13); context.fill(); context.strokeStyle = tint(color, .55); context.lineWidth = 1; context.stroke(); context.clip()
   fill(context, x, y, 3, height, color)
   if (event.height === .5) {
    font(context, 9, 600); text(context, event.slot === 1 ? '下午' : '上午', x + 6, y + 10, width - 10, color)
    font(context, 11, 600); text(context, event.title, x + 6, y + 25, width - 12)
    if (height >= 47) { font(context, 9); text(context, `${event.startDate.slice(5).replace('-', '/')} — ${event.endDate.slice(5).replace('-', '/')}`, x + 6, y + 40, width - 12, COLOR.muted) }
   } else {
    font(context, 11, 600); text(context, event.title, x + 10, y + 18, width - 20)
    font(context, 9); text(context, `${event.startDate.slice(5).replace('-', '/')} — ${event.endDate.slice(5).replace('-', '/')}`, x + 10, y + 38, width - 20, COLOR.muted)
   }
   if (plan.mode === 'global' && event.roleId && height >= 68) {
    const owner = project.roles.find(role => role.id === event.roleId)
    font(context, 9); text(context, owner?.name ?? '', x + 10, y + height - 13, width - 20, COLOR.muted)
   }
   context.restore()
  }
  if (!row.events.length && !calendar.days.length) {
   font(context, 11); text(context, '当前日期范围全部被隐藏', datesLeft + 14, row.top + 30, tableWidth - SCHEDULE_LABEL_WIDTH - 28, COLOR.muted)
  } else if (row.total && !row.events.length) {
   font(context, 10); text(context, '事件日期已隐藏', datesLeft + 14, row.top + 30, tableWidth - SCHEDULE_LABEL_WIDTH - 28, COLOR.subtle)
  }
 }
 line(context, datesLeft, TITLE_HEIGHT, datesLeft, tableBottom, COLOR.strong)
 context.strokeStyle = COLOR.strong; context.lineWidth = 1; context.strokeRect(left, TITLE_HEIGHT, tableWidth, tableBottom - TITLE_HEIGHT)
 const status = [project.calendar.hideWeekends ? '已隐藏周末' : '显示周末', project.calendar.hideHolidays ? '已隐藏法定假日' : '显示法定假日']
 if (plan.hiddenEvents) status.push(`${plan.hiddenEvents} 个事件仅在隐藏日期内`)
 if (calendar.unknownHolidayYears.length) status.push(`${calendar.unknownHolidayYears.join('、')} 年假日待更新`)
 font(context, 10); text(context, status.join(' · '), left, tableBottom + 24, tableWidth, COLOR.muted)
}

async function prepareFonts(): Promise<void> {
 if (!document.fonts) return
 let timer: ReturnType<typeof setTimeout> | undefined
 try {
  // Font failure falls back to the system's CJK fonts; never block export forever.
  await Promise.race([
   Promise.all([document.fonts.load('400 12px "Office UI"'), document.fonts.load('600 12px "Office UI"'), document.fonts.load('400 12px "Office UI CJK"', '项目排期人员整体计划')]).catch(() => undefined),
   new Promise<void>(resolve => { timer = setTimeout(resolve, 3000) }),
  ])
 } finally { clearTimeout(timer) }
}

export async function exportSchedulePng(project: ScheduleProject, options: SchedulePngOptions): Promise<SchedulePngResult> {
 // Freeze the data before any await so subsequent UI edits cannot create a mixed image.
 const plan = buildSchedulePngLayout(project, options)
 await prepareFonts()
 const canvas = document.createElement('canvas')
 try {
  canvas.width = plan.width; canvas.height = plan.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw Error('无法创建排期图片画布，请关闭其他占用内存的文档后重试。')
  fill(context, 0, 0, plan.width, plan.height, '#ffffff')
  context.scale(plan.scale, plan.scale)
  drawTable(context, plan)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(Error('排期图片编码失败，请缩小日期范围或使用人员模式后重试。')), 'image/png'))
  if (blob.type !== 'image/png' || !blob.size) throw Error('排期图片未生成有效的 PNG 数据。')
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: plan.width, height: plan.height, scale: plan.scale }
 } finally {
  // Release the potentially large backing bitmap even if encoding fails.
  canvas.width = 1; canvas.height = 1
 }
}
