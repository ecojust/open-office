import { tool, type McpSchema, type McpToolDefinition } from './tool-schema.ts'

const command: McpSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z][a-z0-9_]*$', description: 'pdf_list_commands 返回的 command 名称。' }
const params: McpSchema = { type: 'object', additionalProperties: true, description: '命令的 inputSchema 所定义参数；不传 doc。新接口页码、对象序号从 1 开始，坐标为页面左上角起的 PDF 点。' }
const assets: McpSchema = { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 6 * 1024 * 1024 }, description: '可选内嵌素材：文件名 → base64，总解码大小最多 4 MiB。图片、签名、自定义图章、水印、插入 PDF 等命令的文件参数仅可引用这里的名字。' }

export const pdfEditingTools: McpToolDefinition[] = [
  tool('pdf_list_commands', '发现 PDF 全部当前文档编辑和查询命令及完整参数 schema，含文字/图像、字体导入、页面、批注、高亮、签名图章、表单及其动作/脚本内容、文档脚本内容、书签、链接、页眉水印和无障碍。页码从 1 开始；旧 pdf_add_text 保持从 0 开始。', true, { filter: { type: 'string', maxLength: 200 }, command }),
  tool('pdf_query', '查询 PDF 内容、现有对象索引、批注、表单动作、文档脚本内容和页面结构。只接受目录中 readOnly=true 的命令，不能修改文档。', true, { command, params }, ['command']),
  tool('pdf_execute_command', '执行目录中的 PDF 编辑命令，直接修改当前文档并刷新页面、侧栏、脏状态和撤销记录。先用 pdf_list_commands 获取参数；签名、图章及文字编辑直接生效，无需打开弹窗。外部文件读写、任意脚本和系统命令不可用。', false, { command, params, assets }, ['command']),
]
