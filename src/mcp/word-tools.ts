import { tool, type McpSchema, type McpToolDefinition } from './tool-schema.ts'

const text: McpSchema = { type: 'string', maxLength: 100000 }
const number: McpSchema = { type: 'number' }
const index: McpSchema = { type: 'integer', minimum: 0, maximum: 10000000 }
const object: McpSchema = { type: 'object', additionalProperties: true }
const position: McpSchema = {
  anyOf: [
    { type: 'object', properties: { block: index, off: index }, required: ['block', 'off'], additionalProperties: false },
    { type: 'object', properties: {
      story: { anyOf: [{ type: 'string', enum: ['body'] }, { type: 'object', properties: { part: index }, required: ['part'], additionalProperties: false }] },
      path: { type: 'array', items: index, minItems: 1, maxItems: 31 }, off: index,
    }, required: ['story', 'path', 'off'], additionalProperties: false },
  ],
  description: '段落位置。off 为 UTF-8 字节偏移，不能使用 JavaScript 字符下标；正文可用 {block,off}，表格内 path 为 [表格块,行,列,段落]。优先使用 word_select_text。',
}
export const wordQueryCommands = [
  'document.inspect', 'document.text', 'document.paragraph', 'document.selection',
  'document.layout', 'format.state', 'styles.inspect', 'font.list', 'edit.undoHistory',
  'link.targets', 'file.privacy',
] as const

export const wordEditingTools: McpToolDefinition[] = [
  tool('word_list_commands', '发现文字文稿的全部可用编辑命令及参数、分类和当前可用状态，支持关键词过滤和分页。编辑命令实际使用当前 Rust 文档、画面和撤销历史；文件与应用操作不在此目录内。', true, {
    search: { type: 'string', maxLength: 200 }, offset: index, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  tool('word_execute_command', '执行 word_list_commands 列出的文档命令：文字替换/删除、选区、字符和段落格式、样式/列表、表格、图片/形状/图表、页面/分节/页眉页脚、批注/修订、公式/引用/内容控件等。params 按目录说明填写；图片传 base64 data；拒绝文件路径、宏、系统剪贴板和弹窗。完成后画面与未保存状态立即更新，可撤销。', false, {
    command: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z]+\\.[A-Za-z][A-Za-z0-9]*$' },
    params: { ...object, description: '对应命令的参数，先用 word_list_commands 查询；省略表示空对象。' },
  }, ['command']),
  tool('word_inspect_document', '读取当前文稿的段落、格式、表格单元格、对象、选区和统计，供编辑前定位；不会更改文档或焦点。', true, { text: { type: 'boolean' } }),
  tool('word_query', '读取文稿结构、段落、选区、分页布局、格式、样式或撤销历史。document.paragraph 使用 {path:[块索引]}，表格段落 path=[表格块,行,列,段落]；不会更改文档或焦点。', true, {
    command: { type: 'string', enum: [...wordQueryCommands] }, params: object,
  }, ['command']),
  tool('word_select_text', '选择文稿中的指定文字，后续格式、删除或插入作用于此选区；occurrence 从 0 开始，默认第一个。不改变文稿内容。', false, {
    text: { ...text, minLength: 1 }, occurrence: index,
  }, ['text']),
  tool('word_select_range', '精确设置文稿选区；anchor 与 focus 相同时设置光标。位置中的 off 是 UTF-8 字节偏移，跨段落/表格/页眉页脚请先读取文档结构。', false, {
    anchor: position, focus: position,
  }, ['anchor', 'focus']),
]

const schema = (properties: Record<string, McpSchema>, required: string[] = []): McpSchema => ({ type: 'object', properties, required, additionalProperties: true })
const choice = (values: string[]): McpSchema => ({ type: 'string', enum: values })
const commonSchemas: Record<string, McpSchema> = {
  'text.insert': schema({ text, raw: { type: 'boolean' } }, ['text']),
  'document.setText': schema({ text }, ['text']),
  'document.inspect': schema({ text: { type: 'boolean' } }),
  'document.paragraph': schema({ path: { type: 'array', items: index, minItems: 1 }, story: position.anyOf![1]!.properties!.story! }, ['path']),
  'select.range': schema({ anchor: position, focus: position }, ['anchor', 'focus']),
  'select.text': schema({ text, occurrence: { type: 'integer', minimum: 1, description: '原生命令从 1 开始；word_select_text 辅助工具从 0 开始。' } }, ['text']),
  'caret.set': schema({ pos: position, extend: { type: 'boolean' }, page: index, x: number, y: number }),
  'format.set': schema({ props: { ...object, description: 'CharProps：如 {bold:true,italic:true,size:18,font:"Arial",color:"3355AA"}；空对象不改变已有格式。' } }, ['props']),
  'format.font': schema({ name: text, eastAsia: text }),
  'format.size': schema({ size: { type: 'number', minimum: 1, maximum: 1584 } }, ['size']),
  'format.color': schema({ color: text }, ['color']),
  'format.highlight': schema({ color: text }, ['color']),
  'format.phonetic': schema({ ruby: { anyOf: [text, { type: 'null' }] }, align: text, size: number, offset: number }, ['ruby']),
  'para.set': schema({ props: object, onPage: schema({ align: choice(['left', 'center', 'right', 'justify', 'distribute']), left: number, right: number }) }, ['props']),
  'para.style': schema({ style: text }, ['style']),
  'insert.table': schema({ rows: { type: 'integer', minimum: 1, maximum: 1000 }, cols: { type: 'integer', minimum: 1, maximum: 100 }, style: text }, ['rows', 'cols']),
  'insert.picture': schema({ data: { type: 'string', minLength: 1, description: '图片原始字节的 base64；不能传文件路径。' }, width: number, alt: text }, ['data']),
  'picture.change': schema({ data: { type: 'string', minLength: 1 } }, ['data']),
  'picture.size': schema({ width: number, height: number }),
  'picture.crop': schema({ left: number, top: number, right: number, bottom: number }),
  'insert.link': schema({ url: text, bookmark: text, heading: index, top: { type: 'boolean' }, text }),
  'insert.chart': schema({ type: text, data: object, title: text, width: number, height: number }),
  'layout.margins': schema({ preset: choice(['normal', 'narrow', 'moderate', 'wide', 'mirrored', 'office2003']), top: number, bottom: number, left: number, right: number, gutter: number, mirror: { type: 'boolean' } }),
  'layout.orientation': schema({ value: choice(['portrait', 'landscape']) }, ['value']),
  'layout.size': schema({ name: text, width: number, height: number }),
  'layout.pageSetup': schema({ section: object }, ['section']),
  'edit.replace': schema({ text, with: text, matchCase: { type: 'boolean' }, wholeWord: { type: 'boolean' } }, ['text', 'with']),
  'edit.replaceAll': schema({ text, with: text, matchCase: { type: 'boolean' }, wholeWord: { type: 'boolean' } }, ['text', 'with']),
  'review.newComment': schema({ text }, ['text']),
  'review.editComment': schema({ id: index, text }, ['id', 'text']),
  'review.reply': schema({ id: index, text }, ['id', 'text']),
  'review.compare': schema({ text, showIn: choice(['original']), author: text, level: choice(['word', 'character']), caseChanges: { type: 'boolean' }, whiteSpace: { type: 'boolean' }, formatting: { type: 'boolean' } }, ['text', 'showIn']),
  'review.combine': schema({ text, showIn: choice(['original']), author: text, level: choice(['word', 'character']), caseChanges: { type: 'boolean' }, whiteSpace: { type: 'boolean' }, formatting: { type: 'boolean' } }, ['text', 'showIn']),
}

/** Preserve the engine's complete parameter contract, including structured types, rather than
 * guessing mandatory fields from its human-readable mini-language. Common edits additionally
 * have typed JSON schemas; all remaining commands accept objects validated by the engine. */
export function describeWordCommands(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { commands?: unknown }).commands)) return value
  const result = value as { commands: Record<string, unknown>[] }
  return { ...result, commands: result.commands.map(command => {
    const id = String(command.id)
    let inputSchema = commonSchemas[id]
    if (!inputSchema && (String(command.parameters).includes('"value"?: bool') || ['format.subscript', 'format.superscript', 'format.allCaps', 'format.smallCaps', 'format.hidden'].includes(id))) inputSchema = schema({ value: { type: 'boolean' } })
    const parameters = ['review.compare', 'review.combine'].includes(id)
      ? `${String(command.parameters)} MCP: provide revised text and showIn:"original" to edit the current document; original/path and new/revised workspaces are unavailable.`
      : command.parameters
    return { ...command, parameters, inputSchema: { ...(inputSchema ?? object), description: parameters } }
  }) }
}
