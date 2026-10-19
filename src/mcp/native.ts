import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { McpConfig } from './config'
import type { McpRequest, McpTransport } from './service'

export const getMcpConfig = (): Promise<McpConfig> => invoke('mcp_get_config')
export const saveMcpConfig = (config: McpConfig): Promise<McpConfig> => invoke('mcp_save_config', { config })
export const mcpTransport: McpTransport = {
  start: (config, document, tools) => invoke('mcp_start', { config, document, tools }),
  stop: sessionId => invoke('mcp_stop', { sessionId }),
  heartbeat: sessionId => invoke('mcp_heartbeat', { sessionId }),
  claim: (sessionId, requestId) => invoke('mcp_claim', { sessionId, requestId }),
  complete: (sessionId, requestId, result) => invoke('mcp_complete', { sessionId, requestId, result }),
  listen: callback => listen<McpRequest>('mcp-tool-request', event => callback(event.payload)),
}
