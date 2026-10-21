import { tool, type McpSchema } from './tool-schema.ts'

const command: McpSchema = { type: 'string', minLength: 1, maxLength: 160, description: 'presentation_list_commands 返回的命令 id。' }
const params: McpSchema = { type: 'object', additionalProperties: true, description: '完整参数及类型见 presentation_describe_command；图片等媒体使用内嵌 base64，页码索引从 0 开始，位置单位为 pt。' }

export const presentationEditingTools = [
  tool('presentation_list_commands', '列出演示文稿全部可用的文档编辑与查询命令，包含文字、段落、形状、图片、表格、图表、页面、母版、主题、过渡、动画、备注和批注。返回参数说明、当前可用状态及是否可撤销。', true, { filter: { type: 'string', maxLength: 120 } }),
  tool('presentation_describe_command', '查询一个真实演示引擎命令的完整参数、选区要求和当前可用状态。先查询再执行，无需猜测参数。', true, { command }, ['command']),
  tool('presentation_query', '执行命令目录中 readOnly=true 的查询，如 document.inspect、slide.inspect、shape.inspect、text.get、animation.list、design.themes。', true, { command, params }, ['command']),
  tool('presentation_execute_command', '执行当前演示文稿的真实编辑命令并实时刷新画布、缩略图与未保存状态。覆盖现有编辑器全部文档编辑命令；返回结果中的新对象 id 可用于后续编辑。可使用 slide.go、edit.select、text.edit 设置选区；支持正常撤销重做。', false, { command, params }, ['command']),
  tool('presentation_list_templates', '查找当前模板库中的内置及自定义模板，返回名称、描述、id 和页数。', true, { search: { type: 'string', maxLength: 120 } }),
  tool('presentation_apply_template', '将模板库中的指定模板应用到当前演示文稿，替换全部页面，立即更新界面并保留撤销历史。请先用 presentation_list_templates 查询 id。', false, { id: { type: 'string', minLength: 1, maxLength: 160 } }, ['id']),
]
