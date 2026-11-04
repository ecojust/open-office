import { CALENDAR_MAX_CONTENT, CALENDAR_MAX_NOTES, CALENDAR_MAX_TITLE } from '../calendar/model.ts'
import { tool, type McpSchema } from './tool-schema.ts'

const id: McpSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }
const date: McpSchema = { type: 'string', minLength: 10, maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const month: McpSchema = { type: 'string', minLength: 7, maxLength: 7, pattern: '^\\d{4}-\\d{2}$' }
const text = (maxLength: number, required = false): McpSchema => ({ type: 'string', maxLength, ...(required ? { minLength: 1 } : {}) })
const enumeration = (...values: string[]): McpSchema => ({ type: 'string', enum: values })
const object = (properties: Record<string, McpSchema>, required: string[] = []): McpSchema => ({ type: 'object', properties, required, additionalProperties: false })
const patch = (properties: Record<string, McpSchema>): McpSchema => ({ ...object(properties), minProperties: 1 })
const operation = (op: string, fields: Record<string, McpSchema>, required: string[] = []): McpSchema => object({ op: enumeration(op), ...fields }, ['op', ...required])
const noteType = enumeration('工作日', '非工作日')
const allocationDisplay = enumeration('percent', 'hours')
const workdayHours: McpSchema = { type: 'number', minimum: .5, maximum: 24, description: '每日工作小时数，默认7，只允许0.5小时整数倍。' }
const weight: McpSchema = { type: 'number', minimum: 0, maximum: 1 }
const noteFields = {
 title: text(CALENDAR_MAX_TITLE, true), content: text(CALENDAR_MAX_CONTENT), date,
 color: { type: 'string', minLength: 7, maxLength: 7, pattern: '^#[a-fA-F0-9]{6}$' } as McpSchema,
 type: noteType,
}
const operations = [
 operation('book.title', { title: text(CALENDAR_MAX_TITLE, true) }, ['title']),
 operation('book.settings', { patch: patch({ workdayHours, allocationDisplay }) }, ['patch']),
 operation('note.add', { note: object({ id, ...noteFields }, ['title', 'date']) }, ['note']),
 operation('note.update', { noteId: id, patch: patch(noteFields) }, ['noteId', 'patch']),
 operation('note.delete', { noteId: id }, ['noteId']),
 operation('note.move', { noteId: id, date }, ['noteId', 'date']),
 operation('note.copy', { noteId: id, id, patch: patch(noteFields) }, ['noteId']),
 operation('notes.clear_month', { month }, ['month']),
 operation('day.allocate', { date, allocations: { type: 'array', minItems: 1, maxItems: CALENDAR_MAX_NOTES, items: object({ noteId: id, weight }, ['noteId', 'weight']) } }, ['date', 'allocations']),
 operation('day.adjust', { date, leftNoteId: id, position: { type: 'number', minimum: 0, maximum: 100 }, display: allocationDisplay }, ['date', 'leftNoteId', 'position']),
]

export const calendarTools = [
 tool('calendar_read', '查询当前日历本事项，按日期、创建时间、ID升序。month、含端点的from/to取交集；query搜索名称和正文，type筛选工作日/非工作日。默认limit=200、上限500，返回分页及总数。book含每日工作小时数workdayHours和显示方式allocationDisplay。每项额外返回实际share(0..1)、days和hours，非工作事项均为0，份额计算包含该日全部工作事项、不受筛选分页影响。allocation为该事项胶囊位置{start,end,rightNoteId}，start/end为0..1全日累计比例，右邻按原文档事项顺序（不是查询排序），末段rightNoteId:null、非工作allocation:null。默认包含跨月历史事项（只含名称、颜色、属性、使用时间）；指定month时默认包含整月实际分配天数/小时/百分比统计，不受搜索分页影响。includeHistory/includeSummary可关闭附加结果。', true, {
  month, from: date, to: date, query: text(CALENDAR_MAX_CONTENT), type: noteType,
  offset: { type: 'integer', minimum: 0, maximum: CALENDAR_MAX_NOTES }, limit: { type: 'integer', minimum: 1, maximum: 500 },
  includeHistory: { type: 'boolean' }, includeSummary: { type: 'boolean' },
 }),
 tool('calendar_edit', '原子修改日历本：book.title改名；book.settings.patch设置workdayHours(0.5..24且为0.5倍数，默认7)、allocationDisplay(percent/hours)，会保存并可撤销；note.add/update/delete/move/copy增改删移动复制；notes.clear_month清空月。工作成员新增/删除/跨日移动/属性变化后相关日期重均分，纯名称/正文/颜色及每日小时设置保留比例。day.allocate完整列出该日每个工作事项noteId/weight一次，weight为0..1且总和1；day.adjust指定date、leftNoteId及全日累计边界position，display默认本设置，percent吸附10个百分点、hours吸附0.5小时后限制在相邻两段范围，仅调整左侧事项及紧邻右侧事项、二者总量保持。最多100项，失败全部回滚，成功一次撤销。新增默认空正文/#4376d4/工作日，ID可自定、时间自动生成；update不能修改ID、创建时间或weight。copy保留原正文并可patch；add/update/copy仅记录历史名称/颜色/属性，删除保留历史。返回created事项ID。', false, {
  operations: { type: 'array', items: { anyOf: operations }, minItems: 1, maxItems: 100 },
 }, ['operations']),
 tool('calendar_set_view', '切换月份、选中日期/事项、搜索文字；selectedNoteId:null清除事项选择。选中事项自动切换到其日期与月份，选中日期自动切换月份；同时给出的日期/月/事项必须一致。仅切换月份时会清除不在该月的选择。只改变界面，不修改文件或撤销历史。', true, {
  month, selectedDate: date, selectedNoteId: { anyOf: [id, { type: 'null' }] }, search: text(CALENDAR_MAX_CONTENT),
 }),
 tool('calendar_export', '返回当前日历本完整JSON：format、mimeType和book（含全部事项及历史）。不写文件、不改动已保存状态；MCP结果超过7MiB请通过界面保存日历本。', true, { format: enumeration('json') }, ['format']),
]
calendarTools.find(item => item.name === 'calendar_set_view')!.inputSchema.minProperties = 1
