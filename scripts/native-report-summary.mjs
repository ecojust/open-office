const PHASES = new Set(['office-word-native','office-sheet-native','office-presentation-native','word','sheet','presentation','office-word-roundtrip','office-sheet-roundtrip','office-presentation-roundtrip','pdf-roundtrip','ipc-smoke-report']);
const PLATFORM = new Set(['windows-x64','macos-arm64','macos-x64']);
const CONFLICT = '文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。';
const FAILURES = new Map([
  [CONFLICT, 'export-revision-conflict'],
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
const finite = value => Number.isSafeInteger(value) && value >= 0 && value <= 86400000 ? value : null;
const lifecycleCounts = value => ({ generation: finite(value?.generation), terminations: finite(value?.terminations) });

// Only fixed identifiers, booleans and bounded numbers leave this function.
// Raw logs, free-form details, errors, paths and document text never do.
export function nativeReportSummary(report) {
  const frontend = report.frontend || {};
  const events = [];
  for (const event of (Array.isArray(report.nativeDiagnostics?.events) ? report.nativeDiagnostics.events : []).slice(-256)) {
    if (!PHASES.has(event?.phase)) continue;
    const item = { phase: event.phase, elapsedMs: finite(event.elapsedMs) };
    item.complete = event.detail === 'complete';
    events.push(item);
  }
  const groups = {};
  for (const name of ['word','sheet','presentation','pdf']) {
    groups[name] = { present: !!frontend[name] && typeof frontend[name] === 'object', ok: frontend[name]?.ok === true };
  }
  return { schemaVersion: 1, platformId: PLATFORM.has(report.platformId) ? report.platformId : 'unknown',
    commit: typeof report.commit === 'string' && /^[a-f0-9]{40}$/.test(report.commit) ? report.commit : null,
    runId: typeof report.runId === 'string' && /^\d{1,20}$/.test(report.runId) ? report.runId : null,
    ok: report.ok === true, durationMs: finite(report.durationMs),
    // Preserve the host-written verdict and diagnostic counters independently.
    // Missing evidence must not become an inferred successful lifecycle.
    nativeLifecycle: lifecycleCounts(frontend.nativeLifecycle),
    diagnosticLifecycle: lifecycleCounts(report.nativeDiagnostics),
    process: { exitCode: Number.isInteger(report.process?.exitCode) && Math.abs(report.process.exitCode) <= 255 ? report.process.exitCode : null, timedOut: report.process?.timedOut === true },
    failure: FAILURES.get(frontend.error) || (frontend.error ? 'other' : null),
    groups, events: events.slice(-80), rawDetailsOmitted: true };
}
