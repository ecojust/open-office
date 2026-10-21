// Temporary diagnostic-only replacement. No application behavior or acceptance rules change.
// Every emitted string is a fixed identifier, commit/run identifier, or allowlisted enum.
const PLATFORM = new Set(['windows-x64', 'macos-arm64', 'macos-x64']);
const EDITORS = ['word', 'sheet', 'presentation', 'pdf', 'note', 'canvas', 'diagram'];
const GROUPS = ['word', 'sheet', 'presentation', 'pdf', 'notebook', 'workflow', 'mcp', 'workspace'];
const PHASES = new Set([
  'native-setup', 'http-listening', 'acl-ready', 'window-created', 'document-start',
  'app-setup', 'app-mounted', 'ipc-close-listener', 'ipc-recent-documents', 'ipc-bootstrap',
  'office-word-native', 'office-sheet-native', 'office-presentation-native', 'pdf-native',
  'notebook-native', 'workflow-native', 'mcp-native', 'workspace-native',
  'word', 'sheet', 'presentation', 'office-word-roundtrip', 'office-sheet-roundtrip',
  'office-presentation-roundtrip', 'pdf-roundtrip', 'ipc-smoke-report', 'report-written',
  'editor-ready', 'editor-error', 'web-content-terminated', 'web-content-reload-requested',
  'mcp-step-start', 'mcp-step-complete', 'mcp-step-failed',
  'sheet-attach-runner-start', 'sheet-attach-runner-ready', 'sheet-attach-activate-begin', 'sheet-attach-activate-end',
  'sheet-flush-input-begin', 'sheet-flush-input-end', 'sheet-mcp-operation-begin', 'sheet-mcp-operation-end',
  'sheet-mcp-command-begin', 'sheet-mcp-command-end',
]);
const MCP_LABELS = new Set([
  'new document', 'normal MCP start', 'native service status', 'word_insert_text', 'word_read',
  'MCP edited DOCX export', 'edited document export', 'switch current document', 'stopped native service status',
  'closed MCP TCP listener', 'close Word specimen', 'final MCP stop', 'close MCP smoke document', 'cleanup native status',
  ...EDITORS.flatMap(kind => ['inspect before edit', 'native document', 'native MCP start', 'native status', 'stop', 'close'].map(action => `${kind} ${action}`)),
  'word word_select_text', 'word word_query', 'word word_execute_command', 'word document_undo', 'word document_redo',
  'sheet sheet_execute_command', 'sheet sheet_query', 'presentation presentation_execute_command', 'presentation presentation_query',
  'pdf pdf_execute_command', 'pdf pdf_query', 'note note_edit', 'note note_read',
  'canvas canvas_edit', 'canvas canvas_read', 'diagram diagram_update', 'diagram diagram_read',
]);
const SHEET_LABELS = new Set(['new', 'reuse', 'commands', 'execute', 'query', 'host.mcpCommands', 'host.mcpExecute', 'host.mcpQuery']);
const IO_KINDS = new Set([
  'NotFound', 'PermissionDenied', 'ConnectionRefused', 'ConnectionReset', 'HostUnreachable',
  'NetworkUnreachable', 'ConnectionAborted', 'NotConnected', 'AddrInUse', 'AddrNotAvailable',
  'NetworkDown', 'BrokenPipe', 'AlreadyExists', 'WouldBlock', 'NotADirectory', 'IsADirectory',
  'DirectoryNotEmpty', 'ReadOnlyFilesystem', 'FilesystemLoop', 'StaleNetworkFileHandle',
  'InvalidInput', 'InvalidData', 'TimedOut', 'WriteZero', 'StorageFull', 'NotSeekable',
  'QuotaExceeded', 'FileTooLarge', 'ResourceBusy', 'ExecutableFileBusy', 'Deadlock',
  'CrossesDevices', 'TooManyLinks', 'InvalidFilename', 'ArgumentListTooLong', 'Interrupted',
  'Unsupported', 'UnexpectedEof', 'OutOfMemory', 'InProgress', 'Other', 'Uncategorized',
]);
const ASSETS = new Set([
  'index.html',
  'office-word/manifest.json', 'office-word/office-word.js', 'office-word/office-word_bg.wasm',
  'office-sheet/manifest.json', 'office-sheet/office-sheet.js', 'office-sheet/office-sheet_bg.wasm',
  'office-presentation/manifest.json', 'office-presentation/office-presentation.js', 'office-presentation/office-presentation_bg.wasm',
  'office-pdf/manifest.json', 'office-pdf/office_pdf.js', 'office-pdf/office_pdf_bg.wasm',
]);
const SHEET_CHECKS = [
  'default-mounted-local-wasm-canvas-painted', 'synthetic-dom-input-chinese-emoji',
  'rust-formulas-and-cell-formatting', 'xlsx-export-and-save-receipt',
  'stale-save-and-invalid-open-preserve-active-document', 'saved-xlsx-reopened-in-default-editor',
];
const MCP_CHECKS = [
  'native-mcp-http-initialize-and-catalog', 'native-mcp-event-edits-and-reads-current-document',
  'native-mcp-docx-export', 'native-mcp-document-switch-closes-listener',
  'native-mcp-seven-editor-edit-query-export', 'native-mcp-word-format-undo-redo',
  'native-mcp-session-cleanup',
];
const FAILURES = new Map([
  ['Native full diagnostic observed a page restart or WebContent termination.', 'native-lifecycle-restarted'],
  ['Native editing diagnostic observed a page restart or WebContent termination.', 'native-lifecycle-restarted'],
  ['Unable to create isolated native smoke document: File exists (os error 17)', 'isolated-fixture-already-exists'],
  ['Load failed', 'resource-load-failed'],
  ['Failed to fetch', 'resource-fetch-failed'],
  ['NetworkError when attempting to fetch resource.', 'resource-network-error'],
  ['The operation was aborted.', 'operation-aborted'],
  ['The user aborted a request.', 'request-aborted'],
  ['文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。', 'export-revision-conflict'],
  ['文档已变化，请刷新工作台后再操作。', 'stale-workbench-revision'],
  ['当前文档有未保存修改。请先保存，或明确放弃修改后再切换。', 'unsaved-document-open'],
  ['请先保存或放弃当前文档修改，再打开其他文档。', 'unsaved-editor-open'],
  ['操作等待超时，文档仍保留在编辑器中。', 'engine-request-timeout'],
  ['即时命令目标已改变，请在当前目标重新操作。', 'immediate-command-target-changed'],
  ['请在画布中选择一个文字位置，对象或多选不能使用即时文字命令。', 'immediate-command-nontext-selection'],
  ['当前选中的是对象或另一处文字，请重新定位。', 'immediate-command-range-mismatch'],
  ['无法确认当前文字选区。', 'immediate-command-unverified-selection'],
  ['已有页眉页脚需要使用有版本保护的编辑操作。', 'immediate-command-existing-header-footer'],
]);
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const integer = (value, max = 86400000) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const hasObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = value => typeof value === 'string' && value ? FAILURES.get(value) || 'other' : null;
const checks = (value, allowed) => allowed.filter(name => Array.isArray(value) && value.slice(0, 128).includes(name));
function assetName(value) {
  if (typeof value !== 'string' || value.length > 400) return 'unknown-asset';
  const normalized = value.replaceAll('\\', '/');
  if (ASSETS.has(normalized)) return normalized;
  // Never expose hashed bundle names or arbitrary relative paths.
  if (/^assets\/[a-zA-Z0-9_-]+\.js$/.test(normalized)) return 'frontend-script';
  if (/^assets\/[a-zA-Z0-9_-]+\.css$/.test(normalized)) return 'frontend-style';
  return 'unknown-asset';
}
function resourceEvent(event) {
  const phase = event.phase;
  const item = { phase, elapsedMs: integer(event.elapsedMs), generation: integer(event.generation, 1000) };
  if (phase === 'http-io-error' || phase === 'http-socket-error') {
    const match = typeof event.detail === 'string' && event.detail.slice(0, 400).match(/^([A-Za-z]+): /);
    item.ioKind = match && IO_KINDS.has(match[1]) ? match[1] : 'unknown-io-error';
  } else if (phase === 'http-404') {
    item.asset = assetName(event.detail);
  } else {
    const match = typeof event.detail === 'string' && event.detail.slice(0, 400).match(/^(.*) \(([0-9]{1,10}) bytes\)$/);
    item.asset = match ? assetName(match[1]) : 'unknown-asset';
    item.bytes = match ? integer(Number(match[2]), 512 * 1024 * 1024) : null;
  }
  return item;
}

export function nativeReportSummary(input) {
  const report = record(input), frontend = record(report.frontend), diagnostics = record(report.nativeDiagnostics);
  const groups = Object.fromEntries(GROUPS.map(name => {
    const group = record(frontend[name]);
    return [name, { present: hasObject(frontend[name]), ok: group.ok === true, failure: failure(group.error), cleanupFailure: failure(group.closeError || group.cleanupError) }];
  }));
  const events = [], resources = [];
  for (const raw of (Array.isArray(diagnostics.events) ? diagnostics.events : []).slice(-256)) {
    const event = record(raw);
    if (PHASES.has(event.phase)) {
      const item = { phase: event.phase, elapsedMs: integer(event.elapsedMs), generation: integer(event.generation, 1000), complete: event.detail === 'complete' };
      if (event.phase === 'editor-ready') item.editor = EDITORS.includes(event.detail) ? event.detail : 'unknown-editor';
      if (event.phase === 'editor-error') item.failure = failure(event.detail);
      if (event.phase === 'report-written') item.passed = event.detail === 'passed';
      if (event.phase === 'web-content-reload-requested') item.reloadSucceeded = event.detail === 'ok';
      if (event.phase.startsWith('mcp-step-')) item.step = MCP_LABELS.has(event.detail) ? event.detail : 'unknown-step';
      if (event.phase.startsWith('sheet-') && event.detail) item.step = SHEET_LABELS.has(event.detail) ? event.detail : 'unknown-step';
      events.push(item);
    } else if (['http-asset', 'http-asset-complete', 'http-io-error', 'http-socket-error', 'http-404'].includes(event.phase)) {
      resources.push(resourceEvent(event));
    }
  }
  const sheet = record(frontend.sheet), canvas = record(sheet.canvas), sheetResources = record(sheet.resources), cleanup = record(sheet.cleanup);
  const mcp = record(frontend.mcp), mcpEditors = Array.isArray(mcp.editors) ? mcp.editors.slice(0, 7) : [];
  const terminationIndex = events.findIndex(event => event.phase === 'web-content-terminated');
  // Preserve the first observed termination and its preceding operations even
  // when an automatic reload generates a second, unrelated smoke sequence.
  const selected = terminationIndex < 0 ? events.slice(-64) : events.filter((event, index) =>
    (index >= Math.max(0, terminationIndex - 40) && index <= terminationIndex + 11) || index >= events.length - 10);
  return {
    schemaVersion: 2,
    platformId: PLATFORM.has(report.platformId) ? report.platformId : 'unknown',
    commit: typeof report.commit === 'string' && /^[a-f0-9]{40}$/.test(report.commit) ? report.commit : null,
    runId: typeof report.runId === 'string' && /^\d{1,20}$/.test(report.runId) ? report.runId : null,
    ok: report.ok === true, durationMs: integer(report.durationMs),
    process: { exitCode: Number.isInteger(report.process?.exitCode) && Math.abs(report.process.exitCode) <= 255 ? report.process.exitCode : null, timedOut: report.process?.timedOut === true },
    failure: failure(frontend.error), groups,
    lifecycle: { generation: integer(diagnostics.generation, 1000), terminations: integer(diagnostics.terminations, 1000),
      documentStartRetained: events.some(event => event.phase === 'document-start'), retainedEventCount: integer(diagnostics.events?.length, 256) },
    sheetProgress: {
      canvasPresent: hasObject(sheet.canvas), canvasWidth: integer(canvas.width, 32768), canvasHeight: integer(canvas.height, 32768), paintCalls: integer(canvas.paintCalls, 10000000),
      resourcesVerified: sheetResources.wasmLoaded === true && sheetResources.sameOrigin === true,
      inputAccepted: sheet.domInput?.accepted === true, formulaPresent: hasObject(sheet.formula), formatPresent: hasObject(sheet.format),
      exported: typeof sheet.xlsxBase64 === 'string' && sheet.xlsxBase64.length > 0,
      reopenedExported: typeof sheet.reopenedXlsxBase64 === 'string' && sheet.reopenedXlsxBase64.length > 0,
      checks: checks(sheet.checks, SHEET_CHECKS),
      cleanup: { attempted: integer(cleanup.attempted, 1000), closed: integer(cleanup.closed, 1000), ok: cleanup.ok === true, remainingCanvas: integer(cleanup.remainingCanvas, 1000), remainingInput: integer(cleanup.remainingInput, 1000) },
    },
    mcpProgress: {
      checks: checks(mcp.checks, MCP_CHECKS),
      editors: EDITORS.map(kind => {
        const entry = mcpEditors.find(item => record(item).kind === kind);
        return { kind, present: !!entry, exported: typeof entry?.exported?.base64 === 'string' && entry.exported.base64.length > 0, shellDirty: entry?.shellDirty === true };
      }),
      closedDocuments: integer(mcp.cleanup?.closedDocuments, 1000), serviceStopped: mcp.cleanup?.serviceStopped === true,
    },
    events: selected, resourceEvents: resources.slice(-64),
    rawDetailsOmitted: true,
    resourceEventsAreCorrelatedByTimeOnly: true,
  };
}
