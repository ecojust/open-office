import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const WORKFLOW_NATIVE_CHECKS = Object.freeze([
  'mounted-canvas-dom-input',
  'global-save-writes-approved-canvas-file',
  'native-file-readback-reopens-in-new-canvas-session',
  'canvas-tabs-and-editors-closed',
  'mounted-diagram-dom-input',
  'global-save-writes-approved-diagram-file',
  'native-file-readback-reopens-in-new-diagram-session',
  'diagram-tabs-and-editors-closed',
]);
export const WORKFLOW_NATIVE_LIMITATIONS = Object.freeze([
  'The isolated temporary files are provisioned by a smoke-only native command; system file chooser interaction is not covered.',
  'Editing uses DOM mouse and text input in the installed native WebView; physical input devices and operating-system IME are not covered.',
  'The following workspace autosave check removes the shared native smoke directory and verifies its removal.',
]);
export const CANVAS_TEXT = '原生画布保存重开';
export const DIAGRAM_SOURCE = 'flowchart LR\n  start[原生代码图表] --> done[本地保存与重开]';
export const INITIAL_DIAGRAM_SOURCE = 'sequenceDiagram\n  actor User as 用户\n  participant App as 应用\n  participant Data as 数据服务\n  autonumber\n  User->>+App: 提交请求\n  App->>+Data: 读取数据\n  Data-->>-App: 返回结果\n  App-->>-User: 展示结果';
// These expectations deliberately do not use the application parser, serializer,
// scene defaults or diagram renderer: accepted file bytes need independent checks.
export const EXPECTED_STYLE = Object.freeze({ stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16,
  textAlign: 'center', opacity: 1, dashed: false, roughness: 'clean', strokePattern: 'solid' });
const check = (value, message) => assert.ok(value, `Native workflow: ${message}`);
const integer = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`);
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `missing ${label}`);
const identity = (value, label) => check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value), `invalid ${label}`);

function fileModel(base64, hash, size, label) {
  check(typeof base64 === 'string' && base64.length > 0 && base64.length <= 65536 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), `${label} Base64 invalid`);
  integer(size, `${label} size`, 1);
  check(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), `${label} SHA-256 invalid`);
  const bytes = Buffer.from(base64, 'base64');
  check(bytes.toString('base64') === base64 && bytes.length === size && createHash('sha256').update(bytes).digest('hex') === hash, `${label} bytes differ`);
  let model;
  try { model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Native workflow: ${label} is not UTF-8 JSON`); }
  object(model, `${label} model`); identity(model.id, `${label} model ID`);
  for (const key of ['createdAt', 'updatedAt']) {
    check(typeof model[key] === 'string' && Number.isFinite(Date.parse(model[key])) && new Date(model[key]).toISOString() === model[key], `${label} ${key} invalid`);
  }
  check(Date.parse(model.updatedAt) >= Date.parse(model.createdAt), `${label} timestamps reversed`);
  return model;
}
function snapshot(value, label, dirty) {
  object(value, label); integer(value.documentId, `${label} document ID`, 1); integer(value.revision, `${label} revision`);
  check(value.dirty === dirty, `${label} dirty state differs`);
}
function visibleText(value, kind) {
  check(typeof value === 'string' && value.length <= 1000, `${kind} visible text missing`);
  check(kind === 'canvas' ? value === CANVAS_TEXT : value.includes('原生代码图表') && value.includes('本地保存与重开'), `${kind} rendered text differs`);
}

function validateDocument(report, kind) {
  object(report, `${kind} report`); check(report.kind === kind, `${kind} report order or kind differs`);
  const edit = report.editing, persistence = report.persistence, reopened = report.reopened;
  object(edit, `${kind} DOM edit`); object(persistence, `${kind} native persistence`); object(reopened, `${kind} reopen`);
  const text = kind === 'canvas' ? CANVAS_TEXT : DIAGRAM_SOURCE;
  check(edit.text === text && edit.inputEvents === 1 && edit.doubleClickEvents === (kind === 'canvas' ? 1 : 0), `${kind} DOM edit evidence differs`);
  visibleText(edit.visibleText, kind);
  snapshot(edit.before, `${kind} blank`, false); snapshot(edit.after, `${kind} edited`, true);
  check(edit.before.revision === 0 && edit.after.documentId === edit.before.documentId && edit.after.revision >= (kind === 'canvas' ? 2 : 1), `${kind} input did not advance the same session`);
  check(typeof persistence.targetId === 'string' && persistence.targetId.length > 0 && persistence.targetId.length <= 256, `${kind} file identity missing`);
  const initial = fileModel(persistence.initialBase64, persistence.initialSha256, persistence.initialSizeBytes, `${kind} initial`);
  const saved = fileModel(persistence.readbackBase64, persistence.finalSha256, persistence.finalSizeBytes, `${kind} saved`);
  assert.deepEqual(initial, { format: 'open-workflow', version: 1, id: initial.id, title: `native-${kind}`, kind: kind === 'canvas' ? 'board' : 'mermaid',
    scene: { elements: [], background: '#ffffff', grid: true, defaultStyle: { ...EXPECTED_STYLE } },
    source: kind === 'canvas' ? '' : INITIAL_DIAGRAM_SOURCE, diagramStyle: 'classic', createdAt: initial.createdAt, updatedAt: initial.createdAt }, `Native workflow: ${kind} initial content differs`);
  check(Date.parse(saved.updatedAt) >= Date.parse(initial.updatedAt), `${kind} save timestamp moved backwards`);
  const expected = structuredClone(initial); expected.updatedAt = saved.updatedAt;
  let elementId;
  if (kind === 'canvas') {
    const node = saved.scene?.elements?.[0]; object(node, 'canvas text element'); identity(node.id, 'canvas text element ID');
    // MouseEvent coordinates can be rounded to whole CSS pixels by the WebView,
    // while the stage origin retains a fractional layout coordinate.
    check(node.id !== initial.id && typeof node.x === 'number' && Math.abs(node.x - 200) <= 1 && typeof node.y === 'number' && Math.abs(node.y - 160) <= 1, 'canvas text placement differs');
    elementId = node.id;
    expected.scene.elements = [{ id: node.id, type: 'shape', shape: 'text', x: node.x, y: node.y, width: 180, height: 54,
      text: CANVAS_TEXT, style: { ...EXPECTED_STYLE, fill: 'transparent' }, locked: false }];
  } else expected.source = DIAGRAM_SOURCE;
  assert.deepEqual(saved, expected, `Native workflow: ${kind} independently parsed saved content differs`);
  check(persistence.finalSha256 !== persistence.initialSha256 && persistence.dialogObserved === false, `${kind} save did not update original bytes or opened a dialog`);
  snapshot(persistence.saved, `${kind} saved`, false);
  check(persistence.saved.documentId === edit.after.documentId && persistence.saved.revision === edit.after.revision, `${kind} save acknowledged another revision`);
  assert.deepEqual(persistence.saves, [{ documentId: persistence.targetId, extension: 'owflow', expectedSha256: persistence.initialSha256, saveAs: false,
    status: 'saved', savedId: persistence.targetId, savedKind: kind, savedSha256: persistence.finalSha256, savedSizeBytes: persistence.finalSizeBytes }], `Native workflow: ${kind} original-file save receipt differs`);
  snapshot(reopened.snapshot, `${kind} reopened`, false);
  check(reopened.keyChanged === true && reopened.snapshot.documentId !== edit.after.documentId && reopened.snapshot.revision === 0, `${kind} reopen reused an existing session`);
  check(reopened.kind === kind && reopened.fileId === persistence.targetId && reopened.sha256 === persistence.finalSha256 && reopened.exportedBase64 === persistence.readbackBase64, `${kind} reopen did not preserve disk bytes and identity`);
  check(reopened.text === text, `${kind} reopened UI content differs`); visibleText(reopened.visibleText, kind);
  assert.deepEqual(report.cleanup, { closedDocuments: 2 }, `Native workflow: ${kind} editors did not close`);
  return { targetId: persistence.targetId, ids: [initial.id, ...(elementId ? [elementId] : [])], sessions: [edit.before.documentId, reopened.snapshot.documentId] };
}

/** Require both installed editors to modify, save and reopen their native files. */
export function validateNativeWorkflowReport(report, workspace) {
  object(report, 'installed workflow report');
  check(report.schemaVersion === 1 && report.kind === 'workflow-native' && report.transport === 'native-webview-ipc' && report.ok === true, 'native acceptance did not pass');
  check(report.native?.tauri === true, 'requires native IPC');
  let origin;
  try { origin = new URL(report.native.origin); } catch { throw Error('Native workflow: invalid origin'); }
  check(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 0 && origin.origin === report.native.origin, 'requires installed WebView origin');
  assert.deepEqual(report.checks, [...WORKFLOW_NATIVE_CHECKS], 'Native workflow: ordered checks differ');
  assert.deepEqual(report.limitations, [...WORKFLOW_NATIVE_LIMITATIONS], 'Native workflow: native coverage limits differ');
  check(report.error === undefined && report.cleanupError === undefined, 'operation or cleanup failed');
  check(Array.isArray(report.documents) && report.documents.length === 2, 'both native document reports are required');
  const cases = ['canvas', 'diagram'].map((kind, index) => validateDocument(report.documents[index], kind));
  check(new Set(cases.map(item => item.targetId)).size === 2, 'canvas and diagram reused a file identity');
  const ids = cases.flatMap(item => item.ids), sessions = cases.flatMap(item => item.sessions);
  check(new Set(ids).size === ids.length && new Set(sessions).size === 4, 'canvas and diagram reused model IDs or editor sessions');
  assert.deepEqual(report.cleanup, { closedDocuments: 4 }, 'Native workflow: all editors did not close');
  check(workspace?.ok === true && workspace.schemaVersion === 2 && workspace.kind === 'workspace-native' && workspace.transport === 'native-webview-ipc'
    && workspace.native?.origin === report.native.origin && workspace.cleanup?.temporaryFilesRemoved === true, 'shared native temporary-file cleanup did not pass');
  return { canvasDomInput: true, canvasSavedFileReadback: true, canvasSessionCleanup: true,
    diagramDomInput: true, diagramSavedFileReadback: true, diagramSessionCleanup: true };
}
