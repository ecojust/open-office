/** JSON schemas shared by the public document tools and their argument validator. */
export type McpSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | ('object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null')[]
  title?: string
  description?: string
  properties?: Record<string, McpSchema>
  required?: string[]
  additionalProperties?: boolean | McpSchema
  items?: McpSchema
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  enum?: unknown[]
  const?: unknown
  anyOf?: McpSchema[]
  oneOf?: McpSchema[]
  allOf?: McpSchema[]
  default?: unknown
  examples?: unknown[]
}

export type McpToolDefinition = {
  name: string
  description: string
  inputSchema: McpSchema & { type: 'object'; properties: Record<string, McpSchema>; required: string[]; additionalProperties: false }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false }
}

export function tool(name: string, description: string, readOnlyHint: boolean, properties: Record<string, McpSchema> = {}, required: string[] = []): McpToolDefinition {
  return {
    name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint,
      destructiveHint: !readOnlyHint && /execute_command|_edit$|_delete|_remove|apply_template|diagram_(?:update|set_source)/.test(name),
      idempotentHint: readOnlyHint,
      openWorldHint: false,
    },
  }
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_ARGUMENT_BYTES = 7 * 1024 * 1024

function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  // IPC/test realms have their own Object.prototype; still exclude class instances.
  return prototype === null || (Object.getPrototypeOf(prototype) === null &&
    Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name === 'Object')
}

function checkJson(value: unknown, path: string, budget: { nodes: number }, depth = 0): void {
  if (++budget.nodes > 500000 || depth > 32) throw Error('MCP 参数过多或嵌套过深，请分批编辑。')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    // Vertical tab is the presentation engine's soft line break (Shift+Enter).
    if (value.length > MAX_ARGUMENT_BYTES || /[\u0000-\u0008\u000c\u000e-\u001f]/.test(value)) throw Error(`MCP 参数 ${path} 的文字格式或长度无效。`)
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (value.length > 100000) throw Error(`MCP 参数 ${path} 的集合过大，请分批编辑。`)
    value.forEach((item, index) => checkJson(item, `${path}[${index}]`, budget, depth + 1))
    return
  }
  if (value && typeof value === 'object' && plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw Error(`不支持的 MCP 参数：${key}。`)
      checkJson(item, `${path}.${key}`, budget, depth + 1)
    }
    return
  }
  throw Error(`MCP 参数 ${path} 必须为有效 JSON 值。`)
}

function hasType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === type
}

function matches(value: unknown, schema: McpSchema, path: string): boolean {
  try { validateSchema(value, schema, path); return true } catch { return false }
}

function validateSchema(value: unknown, schema: McpSchema, path: string): void {
  const invalid = () => Error(`MCP 参数 ${path} 的格式或取值无效。`)
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => hasType(value, type))) throw invalid()
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw invalid()
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) throw invalid()
  if (schema.anyOf && !schema.anyOf.some(item => matches(value, item, path))) throw invalid()
  if (schema.oneOf && schema.oneOf.filter(item => matches(value, item, path)).length !== 1) throw invalid()
  for (const item of schema.allOf ?? []) validateSchema(value, item, path)
  if (typeof value === 'string') {
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw invalid()
  } else if (typeof value === 'number') {
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) || (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)) throw invalid()
  } else if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw invalid()
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`))
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>, keys = Object.keys(object)
    if ((schema.minProperties !== undefined && keys.length < schema.minProperties) || (schema.maxProperties !== undefined && keys.length > schema.maxProperties)) throw invalid()
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) throw Error(`缺少 MCP 参数：${path}.${key}。`)
    for (const key of keys) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validateSchema(object[key], schema.properties[key]!, `${path}.${key}`)
      else if (schema.additionalProperties === false) throw Error(`不支持的 MCP 参数：${path}.${key}。`)
      else if (typeof schema.additionalProperties === 'object') validateSchema(object[key], schema.additionalProperties, `${path}.${key}`)
    }
  }
}

export function validateToolArguments(schema: McpSchema, raw: unknown): Record<string, unknown> {
  const args = raw ?? {}
  checkJson(args, 'arguments', { nodes: 0 })
  if (new TextEncoder().encode(JSON.stringify(args)).length > MAX_ARGUMENT_BYTES) throw Error('MCP 参数超过 7 MiB，请缩小图片或分批编辑。')
  validateSchema(args, schema, 'arguments')
  return structuredClone(args) as Record<string, unknown>
}
