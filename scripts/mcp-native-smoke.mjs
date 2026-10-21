import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_NATIVE_TEXT = 'NATIVE_MCP_ROUNDTRIP 中文';
export const MCP_NATIVE_CHECKS = Object.freeze([
  'native-mcp-http-initialize-and-catalog',
  'native-mcp-event-edits-and-reads-current-document',
  'native-mcp-docx-export',
  'native-mcp-document-switch-closes-listener',
  'native-mcp-seven-editor-edit-query-export',
  'native-mcp-word-format-undo-redo',
  'native-mcp-session-cleanup',
]);
export const MCP_NATIVE_LIMITATIONS = Object.freeze([
  'The HTTP client is invoked by a smoke-only native command; external AI client applications are not exercised.',
  'Document edits use the actual MCP event bridge and Rust editor; physical keyboard input is not exercised.',
]);
const check = (value, message) => assert.ok(value, `Native MCP: ${message}`);
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `missing ${label}`);
const integer = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`);
const id = (value, label) => check(typeof value === 'string' && value.length > 0 && value.length <= 256, `invalid ${label}`);

function rpc(value, requestId, label) {
  object(value, label);
  check(value.jsonrpc === '2.0' && value.id === requestId && value.error === undefined, `${label} JSON-RPC failed`);
  object(value.result, `${label} result`);
  return value.result;
}
function toolValue(probe, tool, service) {
  object(probe, `${tool} HTTP evidence`);
  check(probe.sessionId === service.sessionId && probe.port === service.port, `${tool} targeted a different service`);
  check(typeof probe.httpSessionId === 'string' && /^[a-f0-9]{32,128}$/.test(probe.httpSessionId), `${tool} lacks the HTTP session header`);
  check(rpc(probe.initialized, 1, `${tool} initialize`).protocolVersion === '2025-03-26', `${tool} protocol version differs`);
  const tools = rpc(probe.catalog, 2, `${tool} catalog`).tools;
  check(Array.isArray(tools) && tools.some(item => item?.name === tool), `${tool} missing from the actual HTTP catalog`);
  const result = rpc(probe.response, 3, `${tool} response`);
  check(result.isError === undefined || result.isError === false, `${tool} reported an execution error`);
  check(Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text' && typeof result.content[0].text === 'string', `${tool} lacks actual tool content`);
  let value;
  try { value = JSON.parse(result.content[0].text); } catch { throw Error(`Native MCP: ${tool} content is not JSON`); }
  object(value, `${tool} document result`);
  return value;
}
function verifyDocx(document) {
  check(typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sha256), 'invalid export SHA-256');
  integer(document.sizeBytes, 'export size', 101);
  check(document.sizeBytes <= 1024 * 1024 && typeof document.base64 === 'string' && document.base64.length <= 1_398_104, 'export exceeds the small specimen bound');
  check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(document.base64), 'export Base64 is invalid');
  const bytes = Buffer.from(document.base64, 'base64');
  check(bytes.toString('base64') === document.base64 && bytes.length === document.sizeBytes && createHash('sha256').update(bytes).digest('hex') === document.sha256, 'export bytes differ from the recorded hash and size');
  check(bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')), 'export is not DOCX');
  const directory = mkdtempSync(join(tmpdir(), 'open-office-mcp-docx-'));
  let result;
  try {
    const path = join(directory, 'document.docx');
    writeFileSync(path, bytes, { flag: 'wx' });
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(dirname(fileURLToPath(import.meta.url)), 'workspace-smoke-docx.py'), path], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal, 'independent DOCX verification failed');
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error('Native MCP: independent DOCX evidence is invalid JSON'); }
  check(evidence.text === MCP_NATIVE_TEXT, 'independent DOCX text differs from the actual MCP edit');
}

export const MCP_NATIVE_EDITORS = Object.freeze(['word', 'sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram']);
const editorTools = {
  word: ['word_execute_command', 'format.set', 'word_query', 'document.inspect', 'docx', MCP_NATIVE_TEXT],
  sheet: ['sheet_execute_command', 'range.setValues', 'sheet_query', 'cell.get', 'xlsx', 'NATIVE_MCP_SHEET'],
  presentation: ['presentation_execute_command', 'shape.insert', 'presentation_query', 'slide.inspect', 'pptx', 'NATIVE_MCP_PRESENTATION'],
  pdf: ['pdf_execute_command', 'page_add_text', 'pdf_query', 'content_list', 'pdf', 'NATIVE_MCP_PDF'],
  note: ['note_edit', undefined, 'note_read', undefined, 'oonote', 'NATIVE_MCP_NOTE'],
  canvas: ['canvas_edit', undefined, 'canvas_read', undefined, 'owflow', 'NATIVE_MCP_CANVAS'],
  diagram: ['diagram_update', undefined, 'diagram_read', undefined, 'owflow', 'NATIVE_MCP_DIAGRAM'],
};
function snapshot(value, label) {
  object(value, label); integer(value.documentId, `${label} document id`, 1); integer(value.revision, `${label} revision`);
  check(typeof value.dirty === 'boolean', `${label} dirty flag is absent`);
}
function wordBlocks(probe, service) { return toolValue(probe, 'word_query', service).blocks; }
function verifyEditorExports(editors) {
  const directory = mkdtempSync(join(tmpdir(), 'open-office-mcp-editors-'));
  let result;
  try {
    for (const entry of editors) {
      const output = entry.exported;
      object(output, `${entry.kind} exported document`);
      check(output.extension === editorTools[entry.kind][4], `${entry.kind} exported another format`);
      integer(output.sizeBytes, `${entry.kind} exported size`, 101);
      check(output.sizeBytes <= 8 * 1024 * 1024 && typeof output.base64 === 'string' && output.base64.length <= 11_184_812, `${entry.kind} export exceeds the bound`);
      check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64), `${entry.kind} export base64 is invalid`);
      const bytes = Buffer.from(output.base64, 'base64');
      check(bytes.toString('base64') === output.base64 && bytes.length === output.sizeBytes && createHash('sha256').update(bytes).digest('hex') === output.sha256, `${entry.kind} export bytes differ from their receipt`);
      writeFileSync(join(directory, `${entry.kind}.${output.extension}`), bytes, { flag: 'wx' });
    }
    const python = process.env.OPEN_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    result = spawnSync(python, [join(dirname(fileURLToPath(import.meta.url)), 'mcp-smoke-documents.py'), directory], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  check(!result.error && result.status === 0 && !result.signal, `independent seven-editor export verification failed: ${result.stderr || result.error?.message || ''}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { throw Error('Native MCP: independent export evidence is invalid JSON'); }
  assert.deepEqual(evidence, Object.fromEntries(MCP_NATIVE_EDITORS.map(kind => [kind, true])), 'Native MCP: incomplete independent exported document evidence');
}
function verifyEditors(report) {
  check(Array.isArray(report.editors), 'seven-editor native evidence is absent');
  assert.deepEqual(report.editors.map(entry => entry?.kind), [...MCP_NATIVE_EDITORS], 'Native MCP: missing or duplicate editor coverage');
  check(new Set(report.editors.map(entry => entry.key)).size === 7, 'editor evidence reuses a document key');
  check(new Set(report.editors.map(entry => entry.service?.sessionId)).size === 7, 'editor evidence reuses another running service');
  for (const entry of report.editors) {
    const [editTool, command, queryTool, queryCommand, , marker] = editorTools[entry.kind];
    id(entry.key, `${entry.kind} key`); object(entry.service, `${entry.kind} service`);
    id(entry.service.sessionId, `${entry.kind} session`); integer(entry.service.port, `${entry.kind} port`, 1024);
    check(entry.service.port <= 65535, `${entry.kind} invalid port`);
    snapshot(entry.before, `${entry.kind} before`); snapshot(entry.after, `${entry.kind} after`);
    check(entry.before.documentId === entry.after.documentId && entry.after.revision > entry.before.revision && entry.after.dirty === true && entry.shellDirty === true, `${entry.kind} actual document/shell did not change`);
    object(entry.edit, `${entry.kind} edit`); object(entry.query, `${entry.kind} query`);
    check(entry.edit.tool === editTool && entry.query.tool === queryTool, `${entry.kind} did not use the new editor tools`);
    object(entry.edit.arguments, `${entry.kind} edit arguments`); object(entry.query.arguments, `${entry.kind} query arguments`);
    check(entry.edit.arguments.command === command && entry.query.arguments.command === queryCommand, `${entry.kind} ran another editor command`);
    const edited = toolValue(entry.edit.probe, editTool, entry.service), queried = toolValue(entry.query.probe, queryTool, entry.service);
    const updated = edited.snapshot || edited;
    snapshot(updated, `${entry.kind} HTTP edit snapshot`);
    check(updated.documentId === entry.after.documentId && updated.revision > entry.before.revision && updated.revision <= entry.after.revision && updated.dirty === true, `${entry.kind} HTTP edit differs from actual editor state`);
    check(JSON.stringify(queried).includes(marker) && entry.actual !== undefined && JSON.stringify(entry.actual).includes(marker), `${entry.kind} HTTP query and actual document disagree`);
    if (['note', 'canvas', 'diagram'].includes(entry.kind)) check(typeof entry.visibleText === 'string' && entry.visibleText.includes(marker), `${entry.kind} UI did not redraw the edit`);
    if (['sheet', 'presentation'].includes(entry.kind)) assert.deepEqual(entry.actual, queried, `Native MCP: ${entry.kind} queried another actual document`);
    if (entry.kind === 'word') {
      check(entry.key === report.document.key && entry.service.sessionId === report.service.sessionId && entry.service.port === report.service.port, 'Word enhanced edit targets a different legacy specimen');
      check(entry.actual.documentId === entry.after.documentId && entry.actual.revision === entry.after.revision, 'Word actual snapshot is stale');
      check(entry.actual.format?.bold === true && entry.actual.format?.size === 22 && entry.actual.format?.color === 'D52B3F', 'Word actual format did not update');
      const runs = queried.blocks?.flatMap(block => block.runs || []) || [];
      check(runs.some(run => run.props?.bold === true && run.props?.size === 22 && JSON.stringify(run.props?.color) === '{"Rgb":[213,43,63]}'), 'Word formatting query lacks the edited runs');
      object(entry.history, 'Word HTTP undo/redo history');
      toolValue(entry.history.select, 'word_select_text', entry.service);
      const before = wordBlocks(entry.history.before, entry.service), undone = wordBlocks(entry.history.undone, entry.service), redone = wordBlocks(entry.history.redone, entry.service);
      check(Array.isArray(before) && Array.isArray(undone) && Array.isArray(redone) && JSON.stringify(before) !== JSON.stringify(queried.blocks), 'Word format history did not change');
      assert.deepEqual(undone, before, 'Native MCP: Word undo failed'); assert.deepEqual(redone, queried.blocks, 'Native MCP: Word redo failed');
      const undo = toolValue(entry.history.undo, 'document_undo', entry.service), redo = toolValue(entry.history.redo, 'document_redo', entry.service);
      check(undo.documentId === entry.after.documentId && redo.documentId === entry.after.documentId && undo.revision > updated.revision && redo.revision > undo.revision && redo.revision === entry.after.revision, 'Word history responses target another revision');
    }
  }
  verifyEditorExports(report.editors);
}

/** Publication requires installed-app IPC, real HTTP responses and independent exported bytes. */
export function validateNativeMcpReport(report) {
  object(report, 'installed native MCP report');
  check(report.schemaVersion === 2 && report.kind === 'mcp-native' && report.ok === true, 'installed MCP acceptance did not pass');
  check(report.transport === 'native-webview-ipc-http', 'requires genuine native IPC and HTTP transport');
  object(report.native, 'native WebView identity');
  check(report.native.tauri === true, 'native IPC was unavailable');
  let origin;
  try { origin = new URL(report.native.origin); } catch { throw Error('Native MCP: invalid native WebView origin'); }
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 0 && origin.origin === report.native.origin, 'not the installed app loopback origin');
  assert.deepEqual(report.checks, [...MCP_NATIVE_CHECKS], 'Native MCP: missing ordered acceptance checks');
  assert.deepEqual(report.limitations, [...MCP_NATIVE_LIMITATIONS], 'Native MCP: disclose actual HTTP client and input coverage');
  check(report.error === undefined && report.cleanupError === undefined, 'operation or cleanup failed');
  const service = report.service, document = report.document;
  object(service, 'native service lifecycle'); object(document, 'actual Rust document observations');
  id(service.sessionId, 'service session'); id(service.documentId, 'service document'); id(service.switchedDocumentId, 'switched document');
  integer(service.port, 'listener port', 1024); check(service.port <= 65535, 'invalid listener port');
  check(service.runningBefore === true && service.runningButton === true, 'native service or UI Running state was absent');
  check(document.key === service.documentId && service.switchedDocumentId !== document.key, 'document switch target is invalid');
  check(service.stoppedAfter === true && service.closedProbe?.port === service.port && service.closedProbe?.closed === true, 'document switch did not close the native TCP listener');
  integer(document.beforeDocumentId, 'initial Rust document identity', 1);
  check(document.afterDocumentId === document.beforeDocumentId, 'tool changed another Rust document');
  integer(document.beforeRevision, 'initial revision'); integer(document.afterRevision, 'edited revision');
  check(document.afterRevision > document.beforeRevision && document.dirty === true, 'actual Rust document was not edited');
  check(document.beforeText === '' && document.afterText === MCP_NATIVE_TEXT, 'actual Rust document text differs');
  object(report.http, 'real HTTP tool exchange');
  const written = toolValue(report.http.write, 'word_insert_text', service), read = toolValue(report.http.read, 'word_read', service);
  check(written.documentId === document.afterDocumentId && written.revision === document.afterRevision && written.dirty === true && written.text === MCP_NATIVE_TEXT, 'HTTP write result differs from the actual Rust document');
  check(read.text === MCP_NATIVE_TEXT && read.totalCharacters === MCP_NATIVE_TEXT.length && read.truncated === false, 'HTTP read did not return the actual MCP edit');
  verifyDocx(document);
  verifyEditors(report);
  check(report.cleanup?.closedDocuments === 8 && report.cleanup?.serviceStopped === true, 'native service or document cleanup is incomplete');
  return { mcpNativeHttp: true, mcpNativeDocumentTools: true, mcpNativeDocxExport: true, mcpNativeSwitchStop: true, mcpNativeSessionCleanup: true,
    mcpNativeSevenEditorEditing: true, mcpNativeWordFormatHistory: true, mcpNativeSevenEditorExports: true };
}
