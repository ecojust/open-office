import { createHash } from 'node:crypto';
import { MCP_NATIVE_CHECKS, MCP_NATIVE_LIMITATIONS, MCP_NATIVE_TEXT } from '../../scripts/mcp-native-smoke.mjs';
import { workspaceDocx } from './workspace-smoke-report.mjs';

// Validator contract fixture only, never installed-app or native HTTP evidence.
export function mcpReport() {
  const base64 = workspaceDocx(MCP_NATIVE_TEXT), bytes = Buffer.from(base64, 'base64');
  const key = 'native-mcp-document', sessionId = '1'.repeat(64), port = 19780;
  const snapshot = { documentId: 17, revision: 1, dirty: true, text: MCP_NATIVE_TEXT };
  const probe = (name, value, httpSessionId) => ({
    sessionId, port, httpSessionId,
    initialized: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } },
    catalog: { jsonrpc: '2.0', id: 2, result: { tools: [{ name }] } },
    response: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } },
  });
  return {
    schemaVersion: 1, kind: 'mcp-native', transport: 'native-webview-ipc-http', ok: true,
    native: { tauri: true, origin: 'http://127.0.0.1:31415' }, checks: [...MCP_NATIVE_CHECKS], limitations: [...MCP_NATIVE_LIMITATIONS],
    http: {
      write: probe('word_insert_text', snapshot, '2'.repeat(64)),
      read: probe('word_read', { text: MCP_NATIVE_TEXT, totalCharacters: MCP_NATIVE_TEXT.length, truncated: false }, '3'.repeat(64)),
    },
    document: { key, beforeDocumentId: 17, afterDocumentId: 17, beforeRevision: 0, afterRevision: 1,
      beforeText: '', afterText: MCP_NATIVE_TEXT, dirty: true, base64, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length },
    service: { sessionId, documentId: key, port, runningBefore: true, runningButton: true,
      switchedDocumentId: 'native-mcp-next-document', stoppedAfter: true, closedProbe: { port, closed: true } },
    cleanup: { closedDocuments: 2, serviceStopped: true },
  };
}
