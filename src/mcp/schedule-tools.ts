import { MAX_SCHEDULE_DAILY_RATE, SCHEDULE_MAX_DAYS, SCHEDULE_MAX_EVENTS, SCHEDULE_MAX_ROLES } from '../schedule/model.ts'
import { SCHEDULE_TRACK_MAX_HEIGHT, SCHEDULE_TRACK_MIN_HEIGHT, SCHEDULE_TRACK_STEP } from '../schedule/layout.ts'
import { tool, type McpSchema } from './tool-schema.ts'

const id: McpSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }
const date: McpSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', minLength: 10, maxLength: 10 }
const text = (maxLength: number, required = false): McpSchema => ({ type: 'string', maxLength, ...(required ? { minLength: 1 } : {}) })
const bool: McpSchema = { type: 'boolean' }
const enumeration = (...values: string[]): McpSchema => ({ type: 'string', enum: values })
const object = (properties: Record<string, McpSchema>, required: string[] = []): McpSchema => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items: McpSchema, maxItems: number, minItems = 0): McpSchema => ({ type: 'array', items, maxItems, minItems })
const nullable = (schema: McpSchema): McpSchema => ({ anyOf: [schema, { type: 'null' }] })
const patch = (properties: Record<string, McpSchema>): McpSchema => ({ ...object(properties), minProperties: 1 })
const operation = (op: string, fields: Record<string, McpSchema>, required: string[] = []): McpSchema => object({ op: enumeration(op), ...fields }, ['op', ...required])
const dailyRate: McpSchema = { type: 'number', minimum: 0, maximum: MAX_SCHEDULE_DAILY_RATE, description: '元/人天，最多两位小数；0 表示零单价。' }
const color: McpSchema = { type: 'string', pattern: '^#[a-fA-F0-9]{6}$', minLength: 7, maxLength: 7 }
const roleFields = { name: text(100, true), role: text(100), color }
const eventFields = { roleId: nullable(id), title: text(200, true), startDate: date, endDate: date, height: { type: 'number', enum: [1, .5] } as McpSchema, slot: { type: 'integer', enum: [0, 1] } as McpSchema, notes: text(20000) }
const calendarFields = { hideWeekends: bool, hideHolidays: bool, weekNumbering: enumeration('year', 'project'), extraHolidays: array(date, SCHEDULE_MAX_DAYS), excludedHolidays: array(date, SCHEDULE_MAX_DAYS) }
const trackKey: McpSchema = { type: 'string', minLength: 1, maxLength: 107, pattern: '^(overall|person-[A-Za-z0-9_-]+|event-[A-Za-z0-9_-]+)$', description: 'overall、person-人员ID 或 event-事件ID。' }
const trackHeight: McpSchema = { type: 'integer', enum: Array.from({ length: (SCHEDULE_TRACK_MAX_HEIGHT - SCHEDULE_TRACK_MIN_HEIGHT) / SCHEDULE_TRACK_STEP + 1 }, (_, index) => SCHEDULE_TRACK_MIN_HEIGHT + index * SCHEDULE_TRACK_STEP) }
const dayWidth: McpSchema = { type: 'number', minimum: 36, maximum: 160 }
const mode = enumeration('people', 'global')
const project = object({
 format: { const: 'open-office-schedule' }, version: { const: 1 }, id, title: text(200, true), startDate: date, endDate: date, dailyRate,
 calendar: object(calendarFields, ['hideWeekends', 'hideHolidays', 'extraHolidays', 'excludedHolidays']),
 roles: array(object({ id, ...roleFields }, ['id', 'name', 'role', 'color']), SCHEDULE_MAX_ROLES),
 events: array(object({ id, ...eventFields }, ['id', 'roleId', 'title', 'startDate', 'endDate', 'height', 'slot', 'notes']), SCHEDULE_MAX_EVENTS),
 layout: object({ trackHeights: { type: 'object', additionalProperties: trackHeight, maxProperties: SCHEDULE_MAX_ROLES + SCHEDULE_MAX_EVENTS + 1 } }, ['trackHeights']),
}, ['format', 'version', 'id', 'title', 'startDate', 'endDate', 'calendar', 'roles', 'events'])
const operations = [
 operation('project.update', { patch: patch({ title: text(200, true), startDate: date, endDate: date, dailyRate: nullable(dailyRate) }) }, ['patch']),
 operation('role.add', { role: object({ id, ...roleFields }, ['name']), index: { type: 'integer', minimum: 0, maximum: SCHEDULE_MAX_ROLES } }, ['role']),
 operation('role.update', { roleId: id, patch: patch(roleFields) }, ['roleId', 'patch']),
 operation('role.delete', { roleId: id }, ['roleId']),
 operation('role.reorder', { roleIds: array(id, SCHEDULE_MAX_ROLES) }, ['roleIds']),
 operation('event.add', { event: object({ id, ...eventFields }, ['roleId', 'title', 'startDate', 'endDate']) }, ['event']),
 operation('event.update', { eventId: id, patch: patch(eventFields) }, ['eventId', 'patch']),
 operation('event.delete', { eventId: id }, ['eventId']),
 operation('event.copy', { eventId: id, id, patch: patch(eventFields) }, ['eventId']),
 operation('calendar.update', { patch: patch(calendarFields) }, ['patch']),
 operation('track.height', { key: trackKey, height: trackHeight }, ['key', 'height']),
 operation('track.reset', { key: trackKey }),
]

export const scheduleTools = [
 tool('schedule_read', '读取当前排期完整项目：名称、日期、人天单价、人员、事件、日历设置和保存的轨道高度。返回真实 ID；最多 4 MiB，不省略数据。', true),
 tool('schedule_read_calendar', '读取当前项目的全部可见日期、周号、假日及未知年份，还有独立于显示开关的工作日期 workingDates。使用已加载的假日数据。', true),
 tool('schedule_read_workload', '读取月度工时、人员及总人天、百分比和预算（元）。默认 basis=project 按项目范围，month 使用完整月份容量但不增加已排人天。roleId 可只读一人；projectTotalDays/projectBudget 始终保留项目合计。整体计划不重复计入。', true, { roleId: id, basis: enumeration('project', 'month') }),
 tool('schedule_edit', '原子修改排期：项目名称/日期/单价（dailyRate:null 清空）；人员增改删及排序；事件增改删、复制、负责人/日期/全天半天/上午下午/备注；日历及周号；轨道高度与重置。新增 role 默认职能为空、颜色蓝色；event 默认全天、上午、空备注。event.copy 保留来源内容及行高，patch 修改副本。改为全天自动恢复 slot=0；显式提供无效 slot 仍拒绝。同一批次最多100项、失败全部回滚、成功一次撤销。role.delete 仅能删除已无事件的人员，请先移动/删除事件。role.reorder 必须列出全部人员 ID；track.reset 不传 key 重置全部行高。创建 ID 可指定或自动生成，返回 created。', false, { operations: array({ anyOf: operations }, 100, 1) }, ['operations']),
 tool('schedule_set_view', '切换人员 people / 事件 global 视图、日期列宽或选择事件；selectedEventId:null 清除选择。只改变界面，不修改文件或撤销历史。', true, { mode, dayWidth, selectedEventId: nullable(id) }),
 tool('schedule_import', '用完整排期 JSON 替换当前项目内容；保留当前文档与项目 ID，可一次撤销。先校验全部字段、日期冲突和4MiB上限，失败不改变数据；不读取文件路径。', false, { project }, ['project']),
 tool('schedule_export', '导出当前排期 JSON 或整张 PNG。JSON 返回完整 project；PNG 返回 mimeType:image/png、encoding:base64、base64、width、height、scale。PNG 可指定人员 people / 事件 global 与日宽，默认当前视图；包含完整日期/轨道与非零月度胶囊、总工时。结果超过7MiB将返回错误。不会写入文件、改写内容或已保存状态。', true, { format: enumeration('json', 'png'), mode, dayWidth }, ['format']),
 tool('schedule_refresh_holidays', '立即从内置假日服务更新当前项目所需年份，失败沿用有效缓存。最多等待8秒；refreshing:true 表示后台仍在更新，可稍后读取日历。返回当前日历和实际更新状态，不改写事件、项目文件或撤销历史，不接受自定义网址。', true),
]
scheduleTools.find(item => item.name === 'schedule_set_view')!.inputSchema.minProperties = 1
scheduleTools.find(item => item.name === 'schedule_import')!.annotations.destructiveHint = true
