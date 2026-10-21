export interface McpConfig {
  port: number
  token: string
  allowEdits: boolean
}

export const MCP_CONFIG_STORAGE_KEY = 'open-office.mcp-config'
export const MCP_DEFAULT_PORT = 19780

export function createMcpToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createDefaultMcpConfig(): McpConfig {
  return { port: MCP_DEFAULT_PORT, token: createMcpToken(), allowEdits: true }
}

/** Reject malformed persisted values instead of silently opening a different port. */
export function validateMcpConfig(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'MCP 设置格式无效。'
  const config = value as Partial<McpConfig>
  if (!Number.isInteger(config.port) || Number(config.port) < 1024 || Number(config.port) > 65535)
    return '端口需要是 1024 至 65535 之间的整数。'
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token))
    return '访问密钥需要为 32 至 128 位字母、数字、短横线或下划线。'
  if (typeof config.allowEdits !== 'boolean') return '请选择是否允许编辑文档。'
  return null
}

export function normalizeMcpConfig(value: unknown): McpConfig | null {
  if (validateMcpConfig(value)) return null
  const config = value as McpConfig
  return { port: config.port, token: config.token, allowEdits: config.allowEdits }
}

/** Browser preference fallback. Desktop settings are stored by the native host. */
export function loadMcpConfig(): McpConfig {
  try {
    const stored = globalThis.localStorage.getItem(MCP_CONFIG_STORAGE_KEY)
    if (stored) {
      const config = normalizeMcpConfig(JSON.parse(stored))
      if (config) return config
    }
  } catch { /* An unavailable or damaged browser store must not block the settings UI. */ }
  return createDefaultMcpConfig()
}

/** Called only after the user saves; failures remain visible to the settings dialog. */
export function saveMcpConfig(config: McpConfig): void {
  const error = validateMcpConfig(config)
  if (error) throw new Error(error)
  try {
    globalThis.localStorage.setItem(MCP_CONFIG_STORAGE_KEY, JSON.stringify(normalizeMcpConfig(config)))
  } catch {
    throw new Error('无法保存 MCP 设置，请检查应用的本地存储权限。')
  }
}

export function mcpClientConfig(config: McpConfig): string {
  const error = validateMcpConfig(config)
  if (error) throw new Error(error)
  return JSON.stringify({
    mcpServers: {
      'open-office': {
        type: 'http',
        url: `http://127.0.0.1:${config.port}/mcp`,
        headers: { Authorization: `Bearer ${config.token}` },
      },
    },
  }, null, 2)
}
