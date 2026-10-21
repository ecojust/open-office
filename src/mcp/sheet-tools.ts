import { tool, type McpToolDefinition } from './tool-schema.ts'

export const sheetQueryCommands = ['document.inspect', 'cell.get', 'selection.stats', 'history.list', 'arrange.selectionPane', 'formulas.functions', 'formulas.nameManager', 'formulas.evaluate', 'pivot.list', 'pivot.fields', 'data.queriesConnections'] as const

export const sheetEditingTools: McpToolDefinition[] = [
  tool('sheet_list_commands', '检索当前工作簿完整编辑命令及参数说明。覆盖选区、内容/公式、字体样式、行列/工作表、图表/图片/形状、表格、筛选排序、数据透视表、批注和页面布局。先检索，再将命令 id 和参数传给 sheet_execute_command。', true, {
    search: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  tool('sheet_execute_command', '执行 sheet_list_commands 返回的当前工作簿命令；立即更新工作表画面、修改状态和撤销记录。params 必须按命令参数说明填写；图片使用 base64 数据，CSV 使用 text，不接受文件路径。不会打开编辑对话框，缺少参数会返回错误。', false, {
    command: { type: 'string', minLength: 1, maxLength: 120 }, params: { type: 'object', additionalProperties: true },
  }, ['command']),
  tool('sheet_query', '读取单元格内容及完整格式、工作簿结构/图表、选区统计、撤销记录或计算公式；不修改文档。参数说明可通过 sheet_list_commands 检索。', true, {
    command: { type: 'string', enum: [...sheetQueryCommands] }, params: { type: 'object', additionalProperties: true },
  }, ['command']),
  tool('sheet_write_range', '批量写入二维表格，首个单元格由 range 指定，单次最多 10000 个单元格。以 = 开头的字符串作为公式；支持文本、数字、布尔值和空值。写入后立即刷新画面并支持撤销。', false, {
    range: { type: 'string', minLength: 1, maxLength: 200 }, sheet: { type: 'integer', minimum: 0, maximum: 1023 },
    values: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'array', minItems: 1, maxItems: 1000, items: { anyOf: [{ type: 'string', maxLength: 32767 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } } },
  }, ['range', 'values']),
]
