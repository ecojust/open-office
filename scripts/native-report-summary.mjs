const PHASES = new Set(['office-start','office-roundtrip','pdf-roundtrip','word-workbench','sheet-workbench','presentation-workbench','ipc-smoke-report','office-host:request','office-host:reply']);
const ACTIONS = new Set(['open','export','discard','mark-saved','smoke-test','word-state','word-action','word-data','sheet-state','sheet-action','sheet-data','presentation-state','presentation-action','presentation-object-data','preview-presentation']);
const PLATFORM = new Set(['windows-x64','macos-arm64','macos-x64']);
const CONFLICT = '文档在导出后又有修改，已保留内容。请重新保存或明确放弃修改。';
const finite = value => Number.isSafeInteger(value) && value >= 0 && value <= 86400000 ? value : null;

// Only fixed identifiers, booleans and bounded numbers leave this function.
// Raw logs, free-form details, errors, paths and document text never do.
export function nativeReportSummary(report) {
  const frontend = report.frontend || {};
  const events = [];
  for (const event of (Array.isArray(report.nativeDiagnostics?.events) ? report.nativeDiagnostics.events : []).slice(-256)) {
    if (!PHASES.has(event?.phase)) continue;
    const item = { phase: event.phase, elapsedMs: finite(event.elapsedMs) };
    if (event.phase.startsWith('office-host:')) {
      let detail;
      try { detail = JSON.parse(typeof event.detail === 'string' && event.detail.length <= 400 ? event.detail : '{}'); } catch { detail = {}; }
      if (!detail || !ACTIONS.has(detail.action)) continue;
      item.action = detail.action;
      if (typeof detail.ok === 'boolean') item.ok = detail.ok;
      if (detail.error === CONFLICT) item.failure = 'export-revision-conflict';
    } else item.complete = event.detail === 'complete';
    events.push(item);
  }
  const groups = {};
  for (const name of ['office','pdf','wordWorkbench','sheetWorkbench','presentationWorkbench']) {
    groups[name] = { present: !!frontend[name] && typeof frontend[name] === 'object', ok: frontend[name]?.ok === true };
  }
  return { schemaVersion: 1, platformId: PLATFORM.has(report.platformId) ? report.platformId : 'unknown',
    commit: typeof report.commit === 'string' && /^[a-f0-9]{40}$/.test(report.commit) ? report.commit : null,
    runId: typeof report.runId === 'string' && /^\d{1,20}$/.test(report.runId) ? report.runId : null,
    ok: report.ok === true, durationMs: finite(report.durationMs),
    process: { exitCode: Number.isInteger(report.process?.exitCode) && Math.abs(report.process.exitCode) <= 255 ? report.process.exitCode : null, timedOut: report.process?.timedOut === true },
    failure: frontend.error === CONFLICT ? 'export-revision-conflict' : frontend.error ? 'other' : null,
    groups, events: events.slice(-80), rawDetailsOmitted: true };
}
