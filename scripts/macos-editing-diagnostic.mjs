import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendLogTail, decodeLogTail, locateApplication } from './native-smoke.mjs';
import { inspectInstalledWordcraft } from './wordcraft-native-smoke.mjs';
import { inspectInstalledGridcraft } from './gridcraft-native-smoke.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const INPUT_SOURCES = new Set(['com.apple.keylayout.US', 'com.apple.keylayout.ABC']);
const KINDS = new Set(['click', 'doubleClick', 'type', 'key']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const EDITING_CHECKS = [
  'two-cold-spreadsheet-sessions', 'sheet-single-click-native-typing', 'sheet-double-click-native-typing',
  'sheet-ribbon-native-formatting', 'sheet-command-path-editing', 'sheet-global-native-undo',
  'word-trusted-native-edit', 'original-tabs-and-session-identities-preserved',
];
export const EDITING_ACTIONS = [
  ['single-a1', 'click', 'sheet:A1'], ['type-a1', 'type', 'sheet:A1', '42'],
  ['enter-a1', 'key', 'sheet:A1', 'Enter'], ['double-d6', 'doubleClick', 'sheet:D6'],
  ['type-d6', 'type', 'sheet:D6', 'sheetnative'], ['enter-d6', 'key', 'sheet:D6', 'Enter'],
  ['select-a1', 'click', 'sheet:A1'], ['ribbon-bold', 'click', 'sheet:home.bold'],
  ['global-undo', 'click', 'shell:undo'], ['word-click', 'click', 'word:page'],
  ['word-type', 'type', 'word:page', 'wordnative'],
];
export const EDITING_F2_CHECKS = EDITING_CHECKS.map(check => check === 'sheet-double-click-native-typing' ? 'sheet-f2-native-typing' : check);
export const EDITING_F2_ACTIONS = [
  ...EDITING_ACTIONS.slice(0, 3), ['single-d6', 'click', 'sheet:D6'], ['f2-d6', 'key', 'sheet:D6', 'F2'],
  ...EDITING_ACTIONS.slice(4),
];

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}
function readJson(path, limit = 1024 * 1024) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, 'Evidence file is invalid or exceeds its bound');
  const bytes = readFileSync(path);
  assert.ok(bytes.length <= limit);
  return JSON.parse(bytes.toString('utf8'));
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, ...options });
  assert.ok(!result.error && result.status === 0 && !result.signal,
    `${basename(program)} failed: ${String(result.stderr || result.stdout || result.error?.message || result.status).slice(0, 1500)}`);
  return result.stdout.trim();
}
function crashReporterServiceStatus() {
  const domain = `gui/${process.getuid()}`;
  const queries = [['print-disabled', domain], ['print-disabled', 'system'],
    ['print', `${domain}/com.apple.ReportCrash`], ['print', 'system/com.apple.ReportCrash.Root']];
  return queries.map(args => {
    try {
      const result = spawnSync('/bin/launchctl', args, { shell: false, encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024 });
      const lines = [], disabled = args[0] === 'print-disabled';
      let depth = 0;
      for (const line of String(result.stdout || '').split('\n')) {
        if (disabled ? /^\s*"[^"\r\n]{0,120}(?:ReportCrash|CrashReporter)[^"\r\n]{0,120}"\s*=>\s*(?:true|false)\s*$/i.test(line)
          : depth === 1 && /^\s*(?:state|pid|last exit code)\s*=\s*[a-zA-Z0-9 _()-]{1,80}\s*$/.test(line)) {
          if (lines.length < 8) lines.push(line.trim().slice(0, 180));
        }
        if (line.trim().endsWith('{')) depth++;
        if (line.trim() === '}') depth--;
      }
      return { query: args.join(' '), exitCode: result.status, signal: result.signal,
        errorCode: String(result.error?.code || '').slice(0, 40) || null, lines };
    } catch (error) { return { query: args.join(' '), exitCode: null, errorCode: String(error.code || 'query-failed').slice(0, 40), lines: [] }; }
  });
}
export function checkInputPreflight(preflight) {
  assert.equal(preflight?.schemaVersion, 1);
  assert.equal(preflight.kind, 'macos-os-input-preflight');
  const permissions = preflight.permissions;
  if (permissions?.postEventAccess !== true) return 'macos-post-event-permission-denied';
  if (!INPUT_SOURCES.has(permissions.inputSourceId)) return 'unsupported-keyboard-input-source';
  return null;
}
export function parseInputRequest(detail) {
  assert.equal(typeof detail, 'string');
  assert.ok(Buffer.byteLength(detail) < 400, 'Input request exceeds the native progress bound');
  const value = JSON.parse(detail);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(Object.keys(value).every(key => ['actionId', 'kind', 'clientX', 'clientY', 'text', 'key', 'viewportWidth', 'viewportHeight'].includes(key)), 'Unknown input request field');
  assert.match(value.actionId, /^[a-z0-9-]{1,64}$/);
  assert.ok(KINDS.has(value.kind), 'Unsupported OS input kind');
  for (const dimension of ['viewportWidth', 'viewportHeight']) assert.ok(Number.isFinite(value[dimension]) && value[dimension] >= 100 && value[dimension] <= 8192, 'Invalid viewport');
  if (value.kind === 'click' || value.kind === 'doubleClick') {
    assert.ok(Number.isFinite(value.clientX) && value.clientX >= 0 && value.clientX < value.viewportWidth);
    assert.ok(Number.isFinite(value.clientY) && value.clientY >= 0 && value.clientY < value.viewportHeight);
    assert.equal(value.text, undefined); assert.equal(value.key, undefined);
  } else if (value.kind === 'type') {
    assert.match(value.text, /^[A-Za-z0-9 -]{1,64}$/);
    assert.equal(value.key, undefined);
  } else {
    assert.ok(['Enter', 'Escape', 'F2'].includes(value.key));
    assert.equal(value.text, undefined);
  }
  return value;
}
export function inputForWindow(request, geometry, pid) {
  assert.equal(geometry?.coordinateSpace, 'quartz-screen-points');
  assert.equal(geometry.actionId, request.actionId, 'Window geometry is stale or belongs to another input action');
  assert.deepEqual(geometry.viewport, { width: request.viewportWidth, height: request.viewportHeight }, 'Geometry sampled a different viewport');
  assert.equal(geometry.pid, pid, 'Window does not belong to the launched app');
  assert.ok(Number.isSafeInteger(geometry.windowId) && geometry.windowId > 0);
  for (const key of ['x', 'y', 'width', 'height', 'scaleFactor']) assert.ok(Number.isFinite(geometry[key]), 'Invalid native geometry');
  assert.ok(Math.abs(geometry.x) < 30000 && Math.abs(geometry.y) < 30000 && geometry.width >= 100 && geometry.width <= 8192 && geometry.height >= 100 && geometry.height <= 8192);
  assert.ok(geometry.scaleFactor >= 1 && geometry.scaleFactor <= 4);
  const selected = viewportMapping(request, geometry);
  const [x, y, width] = selected.rect;
  const scale = width / request.viewportWidth;
  return { actionId: request.actionId, kind: request.kind, pid, windowId: geometry.windowId,
    ...(request.kind === 'click' || request.kind === 'doubleClick' ? { x: x + request.clientX * scale, y: y + request.clientY * scale } : {}),
    ...(request.text !== undefined ? { text: request.text } : {}), ...(request.key !== undefined ? { key: request.key } : {}) };
}

/** Only measured AppKit regions may define a CSS viewport mapping. Inconsistent
 * origins or dimensions are a diagnostic failure, never a guessed titlebar. */
export function viewportMapping(request, geometry) {
  const entries = Object.entries(geometry.candidates || {});
  assert.deepEqual(entries.map(([name]) => name).sort(), ['bounds', 'contentLayoutIntersection', 'safeAreaRect', 'visibleRect']);
  const matches = [];
  for (const [source, rect] of entries) {
    assert.ok(Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite), 'Invalid measured viewport candidate');
    const [x, y, width, height] = rect;
    assert.ok(Math.abs(x) < 30000 && Math.abs(y) < 30000 && width >= 0 && width <= 8192 && height >= 0 && height <= 8192);
    if (width < 100 || height < 100) continue;
    const scaleX = width / request.viewportWidth, scaleY = height / request.viewportHeight;
    if (scaleX < .25 || scaleX > 4 || Math.abs(scaleX - scaleY) >= .02) continue;
    const existing = matches.find(item => item.rect.every((value, index) => Math.abs(value - rect[index]) < .01));
    if (existing) existing.sources.push(source); else matches.push({ rect, sources: [source] });
  }
  assert.ok(matches.length > 0, 'Viewport and measured native WebView regions disagree');
  assert.equal(matches.length, 1, 'Native viewport candidates imply conflicting coordinate mappings');
  return matches[0];
}

export function geometryForRequest(request, events) {
  const requestIndex = events.findLastIndex(event => event.phase === 'editing-input-request' && parseInputRequest(event.detail).actionId === request.actionId);
  if (requestIndex < 0) return null;
  for (let index = events.length - 1; index > requestIndex; index--) {
    if (events[index].phase !== 'editing-window-geometry') continue;
    const geometry = JSON.parse(events[index].detail);
    if (geometry.actionId === request.actionId) return geometry;
  }
  return null;
}
export function checkLifecycle(diagnostics, final = false) {
  assert.equal(diagnostics?.schemaVersion, 1);
  assert.equal(diagnostics.scope, 'macos-editing');
  assert.ok(Number.isSafeInteger(diagnostics.generation) && diagnostics.generation >= 0);
  assert.equal(diagnostics.terminations, 0, 'WebContent terminated during OS editing');
  assert.ok(diagnostics.generation <= 1, 'The page restarted during OS editing');
  if (final) assert.equal(diagnostics.generation, 1, 'No original page startup evidence');
  assert.ok(Array.isArray(diagnostics.events) && diagnostics.events.length <= 256);
  assert.equal(diagnostics.events.filter(event => event.phase === 'document-start').length, diagnostics.generation, 'Startup counter and event inventory disagree');
  assert.ok(!diagnostics.events.some(event => ['web-content-terminated', 'web-content-reload-requested'].includes(event.phase)), 'Native restart event was recorded');
}

/** A posted CGEvent alone is never an editing success. */
export function validateEditingReport(frontend, diagnostics, sent, { editEntry = 'doubleclick' } = {}) {
  assert.ok(['doubleclick', 'f2'].includes(editEntry), 'Unsupported editing validation entry');
  const f2Control = editEntry === 'f2';
  const expectedActions = f2Control ? EDITING_F2_ACTIONS : EDITING_ACTIONS;
  checkLifecycle(diagnostics, true);
  assert.equal(frontend?.ok, true, frontend?.error || 'Frontend editing failed');
  assert.deepEqual(frontend.nativeLifecycle, { generation: 1, terminations: 0 });
  const editing = frontend.editing;
  assert.equal(editing?.schemaVersion, 1);
  assert.equal(editing.kind, 'macos-editing');
  assert.equal(editing.transport, 'local-wasm-in-native-webview');
  // Legacy double-click reports omit these markers. F2 always requires an
  // explicit diagnostic-only marker and a separately selected validator.
  assert.equal(editing.editEntry ?? 'doubleclick', editEntry, 'Editing entry differs from the requested scenario');
  assert.equal(editing.diagnosticOnly ?? false, f2Control, 'Control experiments cannot supply double-click acceptance');
  assert.equal(editing.ok, true, editing.error || 'Editing scenarios failed');
  assert.match(editing.bootId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(editing.timeOrigin) && editing.timeOrigin > 0);
  const boots = diagnostics.events.filter(event => event.phase === 'document-start').map(event => JSON.parse(event.detail));
  assert.equal(boots.length, 1); assert.equal(boots[0].bootId, editing.bootId); assert.equal(boots[0].timeOrigin, editing.timeOrigin);
  assert.deepEqual(editing.checks, f2Control ? EDITING_F2_CHECKS : EDITING_CHECKS, 'Editing checks are missing or out of order');
  assert.equal(editing.initialTabIds?.length, 2, 'Expected two cold workbooks before any edit');
  assert.equal(editing.finalTabIds?.length, 3);
  assert.equal(new Set(editing.finalTabIds).size, 3);
  assert.deepEqual(editing.finalTabIds.slice(0, 2), editing.initialTabIds, 'Cold sentinel tabs changed');
  assert.equal(editing.sessions?.length, 3);
  assert.deepEqual(editing.sessions.map(item => item.key), editing.finalTabIds);
  assert.deepEqual(editing.sessions.map(item => item.kind), ['sheet', 'sheet', 'word']);
  assert.equal(new Set(editing.sessions.map(item => item.sessionId)).size, 3, 'Rust sessions are not distinct');
  for (const session of editing.sessions) {
    assert.ok(typeof session.key === 'string' && session.key.length > 0);
    assert.ok(typeof session.sessionId === 'string' && session.sessionId.length > 0);
    assert.ok(Number.isSafeInteger(session.documentId) && session.documentId > 0);
  }
  assert.equal(editing.actions?.length, expectedActions.length);
  assert.equal(sent.length, expectedActions.length);
  const progressRequests = diagnostics.events.filter(event => event.phase === 'editing-input-request').map(event => parseInputRequest(event.detail));
  assert.deepEqual(progressRequests, sent.map(action => action.request), 'Native progress and actual OS input inventories differ');
  const identity = ({ key, kind, sessionId, documentId }) => ({ key, kind, sessionId, documentId });
  let previous = null;
  for (let index = 0; index < expectedActions.length; index++) {
    const [actionId, kind, target, value] = expectedActions[index];
    const evidence = editing.actions[index], action = sent[index];
    const request = parseInputRequest(JSON.stringify(action.request));
    assert.deepEqual([evidence.actionId, evidence.kind, evidence.target], [actionId, kind, target]);
    assert.deepEqual([request.actionId, request.kind], [actionId, kind]);
    if (kind === 'type') assert.equal(request.text, value);
    if (kind === 'key') assert.equal(request.key, value);
    assert.equal(evidence.completed, true, `${actionId} was not completed`);
    assert.equal(action.result?.schemaVersion, 1);
    assert.equal(action.result.ok, true);
    assert.deepEqual([action.result.actionId, action.result.kind], [actionId, kind]);
    assert.equal(action.result.method, 'CGEvent-hidSystemState');
    assert.equal(action.result.physicalIME, false);
    assert.equal(action.result.permissions?.postEventAccess, true);
    assert.ok(INPUT_SOURCES.has(action.result.permissions.inputSourceId));
    assert.equal(action.result.eventCount, kind === 'doubleClick' ? 5 : kind === 'click' ? 3 : kind === 'key' ? 2 : value.length * 2);
    assert.deepEqual(action.nativeInput, inputForWindow(request, action.geometry, action.result.pid));
    assert.deepEqual(action.geometry, geometryForRequest(request, diagnostics.events), 'OS input did not use its freshly sampled geometry');
    assert.deepEqual(action.mapping, viewportMapping(request, action.geometry));
    assert.equal(action.result.windowId, action.nativeInput.windowId);
    assert.ok(Number.isFinite(action.result.startedAt) && action.result.finishedAt >= action.result.startedAt);
    assert.ok(Array.isArray(evidence.events) && evidence.events.length > 0 && evidence.events.length <= 100, 'OS action has no received event evidence');
    assert.ok(evidence.events.every(event => event.isTrusted === true), 'Untrusted event cannot validate native OS input');
    const pointerTarget = target === 'shell:undo' ? 'button:撤销' : target.startsWith('word:') ? 'wordcraft-canvas' : 'gridcraft-canvas';
    const keyTargets = target.startsWith('word:') ? ['wordcraft-input'] : ['gridcraft-canvas', 'gridcraft-input'];
    if (kind === 'click' || kind === 'doubleClick') {
      assert.ok(evidence.events.some(event => event.type === (kind === 'doubleClick' ? 'dblclick' : 'click')
        && event.target === pointerTarget && event.detail === (kind === 'doubleClick' ? 2 : 1)
        && Math.abs(event.clientX - request.clientX) < 3 && Math.abs(event.clientY - request.clientY) < 3), `${actionId} has no matching trusted pointer gesture`);
    } else {
      const ups = evidence.events.filter(event => event.type === 'keyup' && keyTargets.includes(event.target));
      assert.deepEqual(ups.map(event => event.key), kind === 'type' ? [...value] : [value], `${actionId} did not receive the requested native keys`);
    }
    const count = target.startsWith('word:') ? 3 : 2;
    for (const snapshot of [evidence.before, evidence.after]) {
      assert.deepEqual(snapshot?.tabs?.map(tab => tab.key), editing.finalTabIds.slice(0, count), `${actionId} lost original tabs`);
      assert.deepEqual(snapshot.tabs.map(tab => tab.kind), ['sheet', 'sheet', 'word'].slice(0, count));
      assert.ok(snapshot.tabs.every(tab => tab.ready === true));
      assert.equal(snapshot.shell?.home, false, `${actionId} unexpectedly returned home`);
      assert.equal(snapshot.shell.tabCount, count);
      assert.equal(snapshot.shell.visibleTabCount, count);
      assert.ok(typeof snapshot.shell.workspaceDisplay === 'string' && snapshot.shell.workspaceDisplay !== 'none');
      assert.equal(snapshot.activeKey, editing.finalTabIds[count === 2 ? 1 : 2]);
      assert.deepEqual(snapshot.sessions?.map(identity), editing.sessions.slice(0, count), `${actionId} replaced an original Rust session`);
      assert.ok(snapshot.sessions.every(session => Number.isSafeInteger(session.revision) && session.revision >= 0 && typeof session.dirty === 'boolean'));
      assert.equal(snapshot.sessions[0].dirty, false, 'Pristine workbook was changed by another document');
      if (previous) for (let item = 0; item < Math.min(previous.length, count); item++) assert.ok(snapshot.sessions[item].revision >= previous[item].revision, 'Session revision went backwards');
      previous = snapshot.sessions;
    }
  }
  assert.deepEqual(editing.observations, { singleClickValue: 42, [f2Control ? 'f2Value' : 'doubleClickValue']: 'sheetnative', ribbonBold: true,
    commandValue: 'API_SENTINEL', undoneValue: null, wordText: 'wordnative',
    retained: { a1: 42, bold: true, d6: 'sheetnative', pristineA1: null } }, 'Actual Rust model edits or retained values differ');
  assert.equal(editing.lastState?.activeKey, editing.initialTabIds[1]);
  assert.deepEqual(editing.lastState.tabs?.map(tab => tab.key), editing.finalTabIds);
  assert.deepEqual(editing.lastState.sessions?.map(identity), editing.sessions);
  assert.deepEqual(editing.lastState.sessions.map(session => session.dirty), [false, true, true]);
  assert.equal(editing.lastState.shell?.home, false);
  assert.equal(editing.lastState.shell.visibleTabCount, 3);
  assert.deepEqual(editing.cleanup, { attempted: 3, closed: 3, ok: true }, 'Diagnostic sessions were not cleaned up');
  return true;
}

export function captureStream(child, path, limit) {
  assert(Number.isSafeInteger(limit) && limit > 0, 'Log capture limit must be a positive byte count');
  // A fixed ring keeps the crash tail without repeatedly copying an 8 MiB log
  // while the application is running. Keep raw bytes, including at most one
  // leading partial line when the byte limit cuts through a log record.
  const tail = Buffer.alloc(limit);
  let offset = 0, bytes = 0, totalBytes = 0, startsMidLine = false, stderr = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const dropped = Math.max(0, bytes + incoming.length - limit);
    if (dropped > 0) {
      const fromIncoming = dropped - bytes;
      const lastDroppedByte = fromIncoming > 0 ? incoming[fromIncoming - 1]
        : tail[(offset - bytes + dropped - 1 + limit) % limit];
      startsMidLine = lastDroppedByte !== 0x0a;
    }
    if (incoming.length >= limit) {
      incoming.copy(tail, 0, incoming.length - limit);
      offset = 0;
    } else {
      const first = Math.min(incoming.length, limit - offset);
      incoming.copy(tail, offset, 0, first);
      incoming.copy(tail, 0, first);
      offset = (offset + incoming.length) % limit;
    }
    bytes = Math.min(limit, bytes + incoming.length);
    totalBytes += incoming.length;
  });
  child.stderr.on('data', chunk => { stderr = appendLogTail(stderr, chunk); });
  child.on('error', error => { stderr = appendLogTail(stderr, Buffer.from(error.message)); });
  return (destination = path, { reset = false } = {}) => {
    const start = (offset - bytes + limit) % limit;
    const first = Math.min(bytes, limit - start);
    writeFileSync(destination, Buffer.concat([tail.subarray(start, start + first), tail.subarray(0, bytes - first)], bytes));
    const result = { file: basename(destination), mode: 'tail', limitBytes: limit, bytes, totalBytes,
      droppedBytes: totalBytes - bytes, truncated: totalBytes > bytes, startsMidLine, stderr: decodeLogTail(stderr) };
    if (reset) {
      // A phase boundary can split a record even when neither phase overflows.
      startsMidLine = bytes > 0 ? tail[(offset - 1 + limit) % limit] !== 0x0a : startsMidLine;
      offset = 0; bytes = 0; totalBytes = 0; stderr = Buffer.alloc(0);
    }
    return result;
  };
}
export async function collectCrashReports(started, directory, { terminated = false,
  roots = [join(homedir(), 'Library', 'Logs', 'DiagnosticReports'), '/Library/Logs/DiagnosticReports'] } = {}) {
  const collectingSince = Date.now(), maxWaitMs = terminated ? 10000 : 0;
  const evidence = { files: [], gaps: [], directories: [], scanCount: 0, waitMs: 0, maxWaitMs };
  const gap = value => { if (evidence.gaps.length < 32 && !evidence.gaps.includes(value)) evidence.gaps.push(value); };
  let previous = new Map();
  do {
    const current = new Map(), candidates = [];
    evidence.directories = [];
    evidence.scanCount++;
    for (const [index, root] of roots.entries()) {
      const label = index === 0 ? 'user' : 'system';
      const summary = { directory: label, readable: false, recentCount: 0, recent: [] };
      evidence.directories.push(summary);
      let files;
      try { files = readdirSync(root).sort(); summary.readable = true; }
      catch (error) { gap(`${label}-crash-directory-${error.code || 'unreadable'}`); continue; }
      for (const file of files) {
        if (!/\.(ips|crash)$/i.test(file)) continue;
        const source = join(root, file);
        try {
          const stat = lstatSync(source);
          if (stat.mtimeMs < started - 1000 || !stat.isFile() || stat.isSymbolicLink()) continue;
          const matched = /^(open-office|Open Office|com\.apple\.WebKit|WebKit|WebContent|GPU|JetsamEvent)/i.test(file);
          summary.recentCount++;
          if (summary.recent.length < 16) summary.recent.push({ file: file.slice(0, 160), matched,
            bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
          if (!matched || stat.size === 0) continue;
          if (stat.size > 8 * 1024 * 1024 || candidates.length >= 8) { gap('matching-crash-report-limit'); continue; }
          const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
          current.set(source, signature);
          candidates.push({ source, file, stat, label, stable: previous.get(source) === signature });
        } catch (error) { gap(`${label}-crash-file-${error.code || 'unreadable'}`); }
      }
    }
    for (const { source, file, stat, label, stable } of candidates) {
      if (terminated && !stable) continue;
      try {
        const bytes = readFileSync(source), after = lstatSync(source);
        if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ino !== stat.ino || !after.isFile() || after.isSymbolicLink()) { gap('crash-report-changed-during-read'); continue; }
        const destination = `crash-${evidence.files.length + 1}-${file}`;
        writeFileSync(join(directory, destination), bytes);
        evidence.files.push({ file: destination, bytes: bytes.length, sha256: hash(bytes), modifiedAt: new Date(stat.mtimeMs).toISOString() });
      } catch (error) { gap(`${label}-crash-file-${error.code || 'unreadable'}`); }
    }
    evidence.waitMs = Math.max(0, Date.now() - collectingSince);
    if (evidence.files.length || evidence.waitMs >= maxWaitMs || evidence.scanCount >= 21) break;
    previous = current;
    await delay(Math.min(500, maxWaitMs - evidence.waitMs));
  } while (true);
  if (terminated && !evidence.files.length) gap('no-stable-crash-report-within-deadline');
  return evidence;
}
function killGroup(child, signal = 'SIGTERM') {
  if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
export function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--preflight') { assert.equal(values.preflight, undefined); values.preflight = true; }
    else if (key === '--lldb') { assert.equal(values.lldb, undefined); values.lldb = true; }
    else if (key === '--edit-entry') {
      assert.equal(values.editEntry, undefined, 'Editing entry was specified twice');
      values.editEntry = args[++index];
      assert.ok(['doubleclick', 'f2'].includes(values.editEntry), '--edit-entry must be doubleclick or f2');
    }
    else { assert.ok(['--app', '--helper'].includes(key) && values[key] === undefined); values[key] = args[++index]; assert.ok(isAbsolute(values[key] || '')); }
  }
  assert.ok(values['--helper'], '--helper must name the compiled Swift tool');
  assert.ok(values.preflight || values['--app'], '--app is required');
  return { editEntry: 'doubleclick', lldb: false, ...values };
}

/** Require a PID sampled from this WKWebView for this exact pending gesture.
 * Neither a process name nor a parent PID establishes WebContent ownership. */
export function debuggerTargetPid(geometry, appPid) {
  assert.equal(geometry?.pid, appPid, 'Debugger geometry belongs to another application');
  const process = geometry.webContent;
  if (process?.supported !== true || process.source !== 'WKWebView._webProcessIdentifier') return null;
  if (!Number.isSafeInteger(process.pid) || process.pid <= 1 || process.pid > 0x7fffffff || process.pid === appPid) return null;
  return process.pid;
}

/** Cleanup failures must never hide the input/lifecycle failure which brought
 * us here, or leave the earlier preflight report masquerading as this run. */
export async function finalizeMacosEditingDiagnostic({ report, directory, started, app, log, temporary,
  finishLog, debuggerControl, processState }, { kill = killGroup, wait = delay, collectReports = collectCrashReports } = {}) {
  const failure = (stage, error) => {
    const detail = `${stage}: ${String(error?.code ? `${error.code}: ${error.message}` : error?.message || error).slice(0, 500)}`;
    report.gaps.push(detail);
    report.ok = false; report.status = 'failed';
    report.error ??= `Diagnostic cleanup failed: ${detail}`;
  };
  const attempt = async (stage, work) => {
    try { await work(); return true; }
    catch (error) { failure(stage, error); return false; }
  };
  let retainedTemporary = false;
  const copyEvidence = async () => {
    if (!temporary) return;
    for (const [source, target, field] of [['diagnostics.json', 'native-diagnostics.json', 'nativeDiagnostics'], ['frontend.json', 'frontend-report.json', 'frontend']]) {
      if (!await attempt(target, () => {
        const path = join(temporary, source);
        if (!existsSync(path)) return;
        const value = readJson(path, 12 * 1024 * 1024);
        report[field] = value;
        writeJson(join(directory, target), value);
      })) retainedTemporary = true;
    }
  };
  // Save the evidence before any cleanup call, then refresh it after cleanup.
  // A denied signal or a broken LLDB/log process cannot suppress these files.
  await copyEvidence();
  if (report.nativeDiagnostics?.terminations > 0 && finishLog) {
    await attempt('system-log-checkpoint', () => { report.systemLog = finishLog(undefined, { reset: true }); });
  }
  if (debuggerControl) await attempt('debugger-cleanup', async () => {
    await debuggerControl.stop();
    assert.ok(['not-started', 'not-attached', 'detached', 'target-exited'].includes(report.debugger.cleanup),
      'WebContent debugger detach was not confirmed');
  });
  if (app && !processState().closed) {
    await attempt('application-SIGTERM', () => kill(app));
    await wait(300);
    if (!processState().closed) await attempt('application-SIGKILL', () => kill(app, 'SIGKILL'));
    await wait(100);
    if (!processState().closed) {
      failure('application-cleanup', 'Application exit was not observed; no further signals were sent');
      retainedTemporary = true;
    }
  }
  if (app) {
    const terminated = report.nativeDiagnostics?.terminations > 0;
    if (!report.ok && !terminated) await wait(1500);
    await attempt('crash-report-collection', async () => { report.crashReports = await collectReports(started, directory, { terminated }); });
  }
  if (log) {
    const exited = () => Number.isInteger(log.exitCode) || typeof log.signalCode === 'string';
    const signal = async (name, waitMs) => {
      if (exited()) return;
      let sent;
      const attempted = await attempt(`system-log-${name}`, () => { sent = log.kill(name); });
      // ChildProcess.kill emits an error and returns false for some failures;
      // captureStream records that error without throwing it. A false return
      // can also race an already-exiting process, so observe exit first.
      await wait(waitMs);
      if (attempted && sent === false && !exited()) failure(`system-log-${name}`, 'Signal was not sent and process exit was not observed');
    };
    await signal('SIGTERM', 150);
    await signal('SIGKILL', 100);
    if (!exited()) failure('system-log-cleanup', 'Log process exit was not observed; no further signals were sent');
  }
  if (finishLog) await attempt('system-log-save', () => {
    if (report.systemLog) report.reportCrashLog = finishLog(join(directory, 'system-reportcrash.ndjson'));
    else report.systemLog = finishLog();
  });
  await copyEvidence();
  if (temporary) {
    if (retainedTemporary) report.retainedEvidenceDirectory = temporary;
    else if (!await attempt('temporary-evidence-cleanup', () => rmSync(temporary, { recursive: true, force: true }))) report.retainedEvidenceDirectory = temporary;
  }
  if (app) {
    const state = processState();
    Object.assign(report.process, { exitCode: state.exitCode, signal: state.exitSignal, closed: state.closed,
      stdoutTail: decodeLogTail(state.stdout), stderrTail: decodeLogTail(state.stderr) });
  }
  // EPERM can leave a fixture process alive. Stop holding its pipes open so the
  // harness can finish with the recorded failure, without escalating signals.
  for (const [name, child] of [['application', app], ['system-log', log]]) {
    if (!child) continue;
    await attempt(`${name}-handles-cleanup`, () => {
      child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.();
    });
  }
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
  writeJson(join(directory, 'report.json'), report);
}

export async function runMacosEditingDiagnostic(args = process.argv.slice(2), env = process.env, root = ROOT) {
  const started = Date.now(), directory = join(root, 'artifacts', 'macos-editing');
  mkdirSync(directory, { recursive: true });
  const report = { schemaVersion: 1, diagnosticOnly: true, releaseAcceptance: false, ok: false, status: 'failed',
    commit: env.GITHUB_SHA || null, runId: env.GITHUB_RUN_ID || null, startedAt: new Date(started).toISOString(),
    userReportedSystem: { app: '0.9.0', macOS: '26.5', processor: 'Apple Silicon' }, actions: [], gaps: [],
    limitations: ['OS CGEvent input is not physical hardware or an IME composition acceptance test.', 'Runner OS/build is reported exactly; macos-26 does not imply macOS 26.5.', 'No crash report does not prove that WebContent survived.'] };
  let app, log, temporary, rawPath, finishLog, debuggerControl, closed = false, exitCode = null, exitSignal = null;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  try {
    const options = parseArgs(args);
    report.editEntry = options.editEntry;
    report.debugger = { requested: options.lldb, status: options.lldb ? 'pending' : 'not-requested', ready: false };
    if (options.editEntry === 'f2') report.limitations.push('F2 is a separate control experiment; passing it is not evidence that double-click editing is fixed.');
    if (options.lldb) report.limitations.push('Debugger attachment can change timing; this run cannot supply release acceptance.');
    assert.equal(process.platform, 'darwin', 'This diagnostic requires native macOS');
    assert.equal(process.arch, 'arm64', 'This diagnostic requires native Apple Silicon Node');
    report.system = { swVers: command('/usr/bin/sw_vers', []), machine: command('/usr/bin/uname', ['-m']), node: process.version };
    report.preflight = JSON.parse(command(options['--helper'], ['--preflight']));
    writeJson(join(directory, 'preflight.json'), report.preflight);
    const blocked = checkInputPreflight(report.preflight);
    if (blocked) { report.status = 'blocked'; report.blockedReason = blocked; return report; }
    if (options.preflight) { report.status = 'preflight-passed'; return report; }
    report.crashReporterServices = crashReporterServiceStatus();
    assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'Record the exact diagnostic source commit');
    const location = locateApplication({ os: 'darwin', target: 'aarch64-apple-darwin' }, { app: options['--app'] }, env, root);
    assert.equal(command('/usr/bin/lipo', ['-archs', location.executable]), 'arm64');
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', location.app]);
    report.application = { app: location.app, executableSha256: hash(readFileSync(location.executable)),
      wordcraft: inspectInstalledWordcraft(location.resourceRoot, { root }), gridcraft: inspectInstalledGridcraft(location.resourceRoot, { root }) };
    temporary = mkdtempSync(join(tmpdir(), 'open-office-macos-editing-'));
    rawPath = join(temporary, 'frontend.json');
    const predicate = 'process == "open-office" OR process CONTAINS "WebContent" OR process CONTAINS "WebKit" OR process == "ReportCrash" OR subsystem BEGINSWITH "com.apple.WebKit" OR ((process == "runningboardd" OR process == "launchd" OR process == "kernel") AND (eventMessage CONTAINS[c] "WebContent" OR eventMessage CONTAINS[c] "WebKit" OR eventMessage CONTAINS[c] "open-office" OR eventMessage CONTAINS[c] "SIGKILL" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "EXC_RESOURCE" OR eventMessage CONTAINS[c] "invalid message" OR eventMessage CONTAINS[c] "exited"))';
    log = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--level', 'debug', '--predicate', predicate], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    finishLog = captureStream(log, join(directory, 'system-webkit.ndjson'), 8 * 1024 * 1024);
    app = spawn(location.executable, [], { cwd: temporary, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, OPEN_OFFICE_SMOKE: '1', OPEN_OFFICE_SMOKE_SCOPE: 'macos-editing', OPEN_OFFICE_SMOKE_OUTPUT: rawPath,
        OPEN_OFFICE_SMOKE_EDIT_ENTRY: options.editEntry } });
    report.process = { pid: app.pid };
    app.stdout.on('data', chunk => { stdout = appendLogTail(stdout, chunk); });
    app.stderr.on('data', chunk => { stderr = appendLogTail(stderr, chunk); });
    app.on('error', error => { report.process.spawnError = error.message; closed = true; });
    app.on('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; });
    const sent = new Set(), samples = [], deadline = Date.now() + 180000;
    let lastSample = 0;
    while (!closed && Date.now() < deadline) {
      const path = join(temporary, 'diagnostics.json');
      if (existsSync(path)) {
        const diagnostics = readJson(path);
        report.nativeDiagnostics = diagnostics;
        checkLifecycle(diagnostics);
        for (const event of diagnostics.events.filter(event => event.phase === 'editing-input-request')) {
          const request = parseInputRequest(event.detail);
          if (sent.has(request.actionId)) continue;
          const geometry = geometryForRequest(request, diagnostics.events);
          if (!geometry) continue;
          if (options.lldb && report.debugger.status === 'pending') {
            const pid = debuggerTargetPid(geometry, app.pid);
            if (pid === null) {
              report.debugger = { requested: true, status: 'blocked', reason: 'exact-webcontent-pid-unavailable',
                ready: false, safeToContinue: true, continuedWithoutDebugger: true };
            } else {
              const { startWebContentDebugger } = await import('./macos-webcontent-lldb.mjs');
              debuggerControl = await startWebContentDebugger({ pid, directory, attachTimeoutMs: 8000 });
              report.debugger = debuggerControl.report;
              report.debugger.requested = true;
              assert.equal(report.debugger.safeToContinue, true, 'Debugger could not confirm WebContent is running or detached; no OS input was sent');
              report.debugger.continuedWithoutDebugger = report.debugger.ready !== true;
            }
            // An attachment attempt may take several seconds. Re-read native
            // lifecycle counters before sending the pending gesture; a failed
            // attach must not turn a replacement WebContent into the control.
            report.nativeDiagnostics = readJson(path);
            checkLifecycle(report.nativeDiagnostics);
          }
          assert.ok(sent.size < 32, 'Too many OS input requests');
          const input = inputForWindow(request, geometry, app.pid);
          sent.add(request.actionId);
          const action = { request, geometry, mapping: viewportMapping(request, geometry), nativeInput: input, result: null };
          report.actions.push(action);
          action.result = JSON.parse(command(options['--helper'], [], { input: JSON.stringify(input), timeout: 15000 }));
          assert.equal(action.result.ok, true); assert.equal(action.result.actionId, request.actionId);
          assert.equal(action.result.permissions.postEventAccess, true);
          assert.ok(INPUT_SOURCES.has(action.result.permissions.inputSourceId), 'Input source changed during native actions');
          writeJson(join(directory, 'actions.json'), report.actions);
        }
      }
      if (Date.now() - lastSample >= 1000) {
        const processList = command('/bin/ps', ['-axo', 'pid,ppid,rss,pcpu,comm']);
        samples.push({ unixMs: Date.now(), rows: processList.split('\n').filter(row => /open-office|WebContent|WebKit|GPU/.test(row)).slice(0, 40) });
        lastSample = Date.now();
      }
      report.processSamples = samples;
      await delay(40);
    }
    assert.ok(closed, 'Native editing diagnostic timed out');
    report.frontend = readJson(rawPath, 12 * 1024 * 1024);
    report.nativeDiagnostics = readJson(join(temporary, 'diagnostics.json'));
    validateEditingReport(report.frontend, report.nativeDiagnostics, report.actions, { editEntry: options.editEntry });
    assert.equal(exitCode, 0, 'Native application did not exit cleanly'); assert.equal(exitSignal, null);
    report.status = 'passed'; report.ok = true;
  } catch (error) { report.error = String(error?.message || error).slice(0, 4000); }
  finally {
    await finalizeMacosEditingDiagnostic({ report, directory, started, app, log, temporary, finishLog, debuggerControl,
      processState: () => ({ closed, exitCode, exitSignal, stdout, stderr }) });
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runMacosEditingDiagnostic();
  console.log(`macOS OS-input diagnostic: ${report.status}${report.blockedReason ? ` (${report.blockedReason})` : ''}; artifacts/macos-editing/report.json`);
  process.exitCode = report.status === 'preflight-passed' || report.ok ? 0 : report.status === 'blocked' ? 2 : 1;
}
