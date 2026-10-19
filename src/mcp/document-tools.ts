import type { EditorHandle, Kind } from '../shared/document'

/** Only these bounded operations can cross the MCP bridge. Engine command IDs are never accepted. */
type Field = { type: 'string' | 'number' | 'integer'; description?: string; maxLength?: number; minLength?: number; minimum?: number; maximum?: number; enum?: string[]; pattern?: string }
export type McpToolDefinition = {
 name: string; description: string;
 inputSchema: { type: 'object'; properties: Record<string, Field>; required: string[]; additionalProperties: false };
 annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: boolean; openWorldHint: false };
}
const text: Field = { type: 'string', maxLength: 20000, minLength: 1 }
const optionalText: Field = { type: 'string', maxLength: 20000 }
const index: Field = { type: 'integer', minimum: 0, maximum: 100000 }
const coordinate: Field = { type: 'number', minimum: 0, maximum: 19000 }
const size: Field = { type: 'number', minimum: 80, maximum: 1000 }
const cell: Field = { type: 'string', maxLength: 10, pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}$' }
function tool(name: string, description: string, readOnlyHint: boolean, properties: Record<string, Field> = {}, required: string[] = []): McpToolDefinition {
 return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false } }
}
const common = [
 tool('document_inspect', '读取当前文档状态、修订号以及撤销和重做状态。', true),
 tool('document_undo', '撤销当前文档最后一次编辑；不会删除文件或关闭文档。', false),
 tool('document_redo', '重做当前文档最后一次撤销的编辑。', false),
]
const catalogs: Record<Kind, McpToolDefinition[]> = {
 word: [tool('word_read', '读取文字文稿的纯文本（最多 100000 字符）。', true), tool('word_insert_text', '在当前光标处插入纯文本；有选区时替换选区，可撤销。', false, { text }, ['text'])],
 sheet: [
  tool('sheet_read_range', '读取工作表矩形区域的值，最多 1000 个单元格；工作表索引从 0 开始。', true, { range: { type: 'string', maxLength: 21, pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$' }, sheet: index }, ['range']),
  tool('sheet_set_cell', '设置一个单元格的文字、数值或以 = 开头的公式；工作表索引从 0 开始，可撤销。', false, { cell, input: text, sheet: index }, ['cell', 'input']),
 ],
 presentation: [tool('presentation_read_slide', '读取指定幻灯片的文字、形状和备注；索引从 0 开始，省略时读取当前页。', true, { index }), tool('presentation_add_slide', '在当前幻灯片后添加带标题和正文的内容页，可撤销。', false, { title: { ...text, maxLength: 200 }, body: optionalText }, ['title'])],
 pdf: [tool('pdf_read', '读取 PDF 页面的可提取文字；图片内容不返回。', true), tool('pdf_add_text', '添加可保存的 PDF 文字框，可撤销。页码从 0 开始，坐标和尺寸使用 PDF 点。', false, { text, page: index, x: coordinate, y: coordinate, width: size, height: { type: 'number', minimum: 20, maximum: 1000 }, size: { type: 'number', minimum: 6, maximum: 144 } }, ['text'])],
 note: [tool('note_read', '读取笔记本的分区、页面、区域位置和文字，图片只返回描述。', true), tool('note_add_page', '在当前分区添加一个页面并切换到此页，可撤销。', false, { title: { ...text, maxLength: 200 }, text: optionalText }, ['title']), tool('note_add_text', '在当前笔记页面添加独立文字区域，可撤销。', false, { text, x: coordinate, y: coordinate, width: size }, ['text'])],
 canvas: [tool('canvas_read', '读取当前画布的元素、坐标和样式，图片不返回二进制数据。', true), tool('canvas_add_shape', '向画布添加一个图形或纯文本对象，可撤销。', false, { shape: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond', 'text'] }, text: optionalText, x: coordinate, y: coordinate, width: size, height: { type: 'number', minimum: 20, maximum: 1000 } })],
 diagram: [tool('diagram_read_source', '读取代码图表源码。', true), tool('diagram_set_source', '更新当前代码图表源码，立即更新预览，可撤销；不能访问文件或网络。', false, { source: { ...text, maxLength: 50000 } }, ['source'])],
}
export function catalogForKind(kind: Kind): McpToolDefinition[] {
 return structuredClone([...common, ...catalogs[kind]])
}
function cellPosition(address: string): [number, number] {
 const [, letters, row] = /^([A-Z]+)([0-9]+)$/.exec(address)!
 let column = 0
 for (const letter of letters!) column = column * 26 + letter.charCodeAt(0) - 64
 const line = Number(row)
 if (column > 16384 || line > 1048576) throw Error('单元格地址超出工作表范围。')
 return [column, line]
}
function validate(definition: McpToolDefinition, raw: unknown): Record<string, unknown> {
 const value = raw ?? {}
 if (typeof value !== 'object' || Array.isArray(value)) throw Error('MCP 参数必须为 JSON 对象。')
 const args = value as Record<string, unknown>, schema = definition.inputSchema
 for (const name of schema.required) if (!Object.hasOwn(args, name)) throw Error(`缺少 MCP 参数：${name}。`)
 for (const [name, value] of Object.entries(args)) {
  if (!Object.hasOwn(schema.properties, name)) throw Error(`不支持的 MCP 参数：${name}。`)
  const field = schema.properties[name]!
  if (field.type === 'string') {
   if (typeof value !== 'string' || (field.maxLength !== undefined && value.length > field.maxLength) || (field.minLength !== undefined && value.length < field.minLength) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (field.enum && !field.enum.includes(value)) || (field.pattern && !new RegExp(field.pattern).test(value))) throw Error(`MCP 参数 ${name} 的文字格式或长度无效。`)
  } else if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw Error(`MCP 参数 ${name} 的数值无效。`)
 }
 if (definition.name === 'sheet_read_range') {
  const range = String(args.range).split(':'), [x1, y1] = cellPosition(range[0]!), [x2, y2] = cellPosition(range[1] ?? range[0]!)
  if (x2 < x1 || y2 < y1 || (x2 - x1 + 1) * (y2 - y1 + 1) > 1000) throw Error('每次读取最多 1000 个单元格，请缩小范围。')
 }
 if (definition.name === 'sheet_set_cell') cellPosition(String(args.cell))
 return { ...args }
}
/** Avoid binary image payloads and unbounded text/arrays in engine inspection output. */
export function summarizeMcpValue(value: unknown, depth = 0): unknown {
 if (depth > 12) return '[嵌套内容已省略]'
 if (typeof value === 'string') return value.length > 100000 ? value.slice(0, 100000) + '\n[后续文字已省略]' : value
 if (Array.isArray(value)) return value.slice(0, 1000).map(item => summarizeMcpValue(item, depth + 1))
 if (value && typeof value === 'object') {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
   if (['dataUrl', 'imageData', 'base64', 'data', 'path', 'importSource', 'ui'].includes(key)) continue
   result[key] = summarizeMcpValue(item, depth + 1)
  }
  return result
 }
 return value
}
export async function executeDocumentTool(kind: Kind, handle: EditorHandle, name: string, args: unknown, assertCurrent: () => void): Promise<unknown> {
 assertCurrent()
 const definition = [...common, ...catalogs[kind]].find(tool => tool.name === name)
 if (!definition) throw Error('当前子软件不支持此 MCP 工具。')
 const validated = validate(definition, args)
 if (!handle.mcpExecute) throw Error('当前文档尚未准备好 MCP 编辑接口。')
 const result = await handle.mcpExecute(name, validated, assertCurrent)
 assertCurrent()
 const summary = summarizeMcpValue(result ?? null)
 if (JSON.stringify(summary).length > 1024 * 1024) throw Error('文档内容过多，请读取较小范围。')
 return summary
}
