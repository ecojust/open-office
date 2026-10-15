import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkInputPreflight, parseInputRequest, inputForWindow, checkLifecycle,
  validateEditingReport, viewportMapping, geometryForRequest, EDITING_ACTIONS, EDITING_CHECKS } from '../scripts/macos-editing-diagnostic.mjs';

const geometry = { actionId: 'single-a1', viewport: { width: 1200, height: 800 }, pid: 1234, windowId: 92, x: 40, y: 70,
  width: 1200, height: 800, scaleFactor: 2, coordinateSpace: 'quartz-screen-points', candidates: {
    bounds: [40, 70, 1200, 800], visibleRect: [40, 70, 1200, 800], safeAreaRect: [40, 70, 1200, 800], contentLayoutIntersection: [40, 70, 1200, 800] } };
const request = { actionId: 'single-a1', kind: 'click', clientX: 300, clientY: 200, viewportWidth: 1200, viewportHeight: 800 };
const permissions = { postEventAccess: true, accessibilityTrusted: true, screenCaptureAccess: false, inputSourceId: 'com.apple.keylayout.ABC' };

function fixture() {
  const sessions = ['sheet', 'sheet', 'word'].map((kind, index) => ({ key: `tab-${index}`, kind, sessionId: `${kind}-${index}`, documentId: index + 1 }));
  const snapshot = (index, after = false) => {
    const count = index < 9 ? 2 : 3;
    return { activeKey: sessions[count === 2 ? 1 : 2].key,
      tabs: sessions.slice(0, count).map(({ key, kind }) => ({ key, kind, dirty: true, ready: true })),
      sessions: sessions.slice(0, count).map((value, item) => ({ ...value, revision: item === 0 ? 2 : index * 2 + (after ? 2 : 1), dirty: item !== 0 && index > 0 })),
      shell: { home: false, tabCount: count, workspaceDisplay: 'flex', visibleTabCount: count } };
  };
  const sent = EDITING_ACTIONS.map(([actionId, kind, , value]) => {
    const input = { actionId, kind, viewportWidth: 1200, viewportHeight: 800,
      ...(['click', 'doubleClick'].includes(kind) ? { clientX: 300, clientY: 200 } : kind === 'type' ? { text: value } : { key: value }) };
    const current = { ...structuredClone(geometry), actionId };
    return { request: input, geometry: current, mapping: viewportMapping(input, current), nativeInput: inputForWindow(input, current, current.pid),
      result: { schemaVersion: 1, ok: true, actionId, kind, method: 'CGEvent-hidSystemState', physicalIME: false,
        pid: geometry.pid, windowId: geometry.windowId, eventCount: kind === 'doubleClick' ? 5 : kind === 'click' ? 3 : kind === 'key' ? 2 : value.length * 2,
        startedAt: 1700000000000, finishedAt: 1700000001000, permissions: structuredClone(permissions) } };
  });
  const actions = EDITING_ACTIONS.map(([actionId, kind, target, value], index) => ({ actionId, kind, target, completed: true,
    before: snapshot(index), after: snapshot(index, true), events: ['click', 'doubleClick'].includes(kind)
      ? [{ type: kind === 'doubleClick' ? 'dblclick' : 'click', target: target === 'shell:undo' ? 'button:撤销' : target.startsWith('word:') ? 'wordcraft-canvas' : 'gridcraft-canvas',
        isTrusted: true, clientX: 300, clientY: 200, detail: kind === 'doubleClick' ? 2 : 1 }]
      : (kind === 'key' ? [value] : [...value]).map(key => ({ type: 'keyup', key, isTrusted: true, target: target.startsWith('word:') ? 'wordcraft-input' : 'gridcraft-input' })) }));
  const editing = { schemaVersion: 1, kind: 'macos-editing', transport: 'local-wasm-in-native-webview', ok: true,
    bootId: 'd3b1ead1-d8e1-418f-b964-cd13826da6ac', timeOrigin: 1700000000000, checks: [...EDITING_CHECKS],
    initialTabIds: sessions.slice(0, 2).map(item => item.key), finalTabIds: sessions.map(item => item.key), sessions, actions,
    observations: { singleClickValue: 42, doubleClickValue: 'sheetnative', ribbonBold: true, commandValue: 'API_SENTINEL',
      undoneValue: null, wordText: 'wordnative', retained: { a1: 42, bold: true, d6: 'sheetnative', pristineA1: null } },
    lastState: { ...snapshot(10, true), activeKey: sessions[1].key }, cleanup: { attempted: 3, closed: 3, ok: true } };
  const diagnostics = { schemaVersion: 1, scope: 'macos-editing', generation: 1, terminations: 0, events: [
    { phase: 'document-start', detail: JSON.stringify({ bootId: editing.bootId, timeOrigin: editing.timeOrigin }) },
    ...sent.flatMap(item => [{ phase: 'editing-input-request', detail: JSON.stringify(item.request) }, { phase: 'editing-window-geometry', detail: JSON.stringify(item.geometry) }]),
  ] };
  return { frontend: { ok: true, nativeLifecycle: { generation: 1, terminations: 0 }, editing }, diagnostics, sent };
}
const validate = value => validateEditingReport(value.frontend, value.diagnostics, value.sent);

test('posting permission and keyboard layout preflight cannot be replaced by synthetic input', () => {
  const preflight = { schemaVersion: 1, kind: 'macos-os-input-preflight', permissions: { ...permissions } };
  assert.equal(checkInputPreflight(preflight), null);
  preflight.permissions.postEventAccess = false;
  assert.equal(checkInputPreflight(preflight), 'macos-post-event-permission-denied');
  preflight.permissions.postEventAccess = true; preflight.permissions.inputSourceId = 'com.apple.inputmethod.SCIM.ITABC';
  assert.equal(checkInputPreflight(preflight), 'unsupported-keyboard-input-source');
});

test('Retina geometry uses native screen points and does not double the display scale', () => {
  assert.deepEqual(inputForWindow(request, geometry, 1234), { actionId: 'single-a1', kind: 'click', pid: 1234, windowId: 92, x: 340, y: 270 });
  assert.throws(() => inputForWindow(request, geometry, 5678), /belong/);
  assert.throws(() => inputForWindow(request, { ...geometry, actionId: 'old-action' }, 1234), /stale/);
  assert.throws(() => inputForWindow(request, { ...geometry, viewport: { width: 1200, height: 600 } }, 1234), /different viewport/);
});

test('fresh measured inset region may match the viewport without guessing titlebar dimensions', () => {
  const input = { ...request, viewportWidth: 1024, viewportHeight: 642 };
  const current = { ...geometry, viewport: { width: 1024, height: 642 }, x: 0, y: 31, width: 1024, height: 674,
    candidates: { bounds: [0, 31, 1024, 674], visibleRect: [0, 31, 1024, 674],
      safeAreaRect: [0, 63, 1024, 642], contentLayoutIntersection: [0, 63, 1024, 642] } };
  assert.deepEqual(viewportMapping(input, current), { rect: [0, 63, 1024, 642], sources: ['safeAreaRect', 'contentLayoutIntersection'] });
  assert.deepEqual(inputForWindow(input, current, 1234), { actionId: 'single-a1', kind: 'click', pid: 1234, windowId: 92, x: 300, y: 263 });
  current.candidates.safeAreaRect = [0, 31, 1024, 642];
  assert.throws(() => viewportMapping(input, current), /conflicting/);
  current.candidates.safeAreaRect = [0, 31, 1024, 674];
  current.candidates.contentLayoutIntersection = [0, 31, 1024, 674];
  assert.throws(() => viewportMapping(input, current), /disagree/);
});

test('geometry must arrive after and identify the exact input request', () => {
  const event = { phase: 'editing-input-request', detail: JSON.stringify(request) };
  const sample = { phase: 'editing-window-geometry', detail: JSON.stringify(geometry) };
  assert.equal(geometryForRequest(request, [sample, event]), null, 'Even a matching old sample cannot be reused');
  assert.equal(geometryForRequest(request, [event, { ...sample, detail: JSON.stringify({ ...geometry, actionId: 'other' }) }]), null);
  assert.deepEqual(geometryForRequest(request, [event, sample]), geometry);
});

test('progress requests reject truncated, oversized, out-of-viewport and unknown OS commands', () => {
  assert.deepEqual(parseInputRequest(JSON.stringify(request)), request);
  assert.throws(() => parseInputRequest('{'));
  assert.throws(() => parseInputRequest(' '.repeat(400)), /bound/);
  for (const invalid of [{ ...request, kind: 'shell' }, { ...request, command: 'kill' }, { ...request, clientX: 1200 },
    { ...request, kind: 'key', key: 'Meta+Q' }, { ...request, kind: 'type', text: 'not\nallowed' }]) {
    assert.throws(() => parseInputRequest(JSON.stringify(invalid)));
  }
});

test('native page lifecycle rejects reloads and terminated content processes even after a new successful report', () => {
  const value = fixture();
  checkLifecycle(value.diagnostics, true);
  assert.throws(() => checkLifecycle({ ...value.diagnostics, generation: 2 }), /restarted/);
  assert.throws(() => checkLifecycle({ ...value.diagnostics, terminations: 1 }), /terminated/);
  value.diagnostics.events.push({ phase: 'web-content-reload-requested', detail: 'ok' });
  assert.throws(() => checkLifecycle(value.diagnostics), /restart event/);
});

test('complete native two-cold-sheet then Word scenario validates observed model edits and retained sessions', () => {
  assert.equal(validate(fixture()), true);
});

test('incomplete, synthetic, unrelated, restarted or state-losing evidence cannot become a pass', async t => {
  const cases = [
    ['browser-only transport', v => { v.frontend.editing.transport = 'local-wasm-in-browser'; }],
    ['missing behavior check', v => { v.frontend.editing.checks.pop(); }],
    ['missing OS action', v => { v.sent.pop(); }],
    ['duplicate action', v => { v.frontend.editing.actions[2] = structuredClone(v.frontend.editing.actions[1]); }],
    ['uncompleted gesture', v => { v.frontend.editing.actions[0].completed = false; }],
    ['synthetic event', v => { v.frontend.editing.actions[0].events[0].isTrusted = false; }],
    ['unrelated event type', v => { v.frontend.editing.actions[0].events[0].type = 'mousemove'; }],
    ['wrong canvas', v => { v.frontend.editing.actions[0].events[0].target = 'wordcraft-canvas'; }],
    ['wrong pointer location', v => { v.frontend.editing.actions[0].events[0].clientX += 20; }],
    ['wrong native key', v => { v.frontend.editing.actions[1].events[0].key = '5'; }],
    ['no actual model edit', v => { v.frontend.editing.observations.singleClickValue = null; }],
    ['undo did not apply', v => { v.frontend.editing.observations.undoneValue = 'API_SENTINEL'; }],
    ['tabs removed in middle', v => { v.frontend.editing.actions[4].after.tabs.pop(); }],
    ['session replaced in middle', v => { v.frontend.editing.actions[4].after.sessions[1].sessionId = 'replacement'; }],
    ['home hides existing tabs', v => { v.frontend.editing.actions[4].after.shell.home = true; }],
    ['pristine workbook mutated', v => { v.frontend.editing.actions[4].after.sessions[0].dirty = true; }],
    ['different boot', v => { v.frontend.editing.bootId = 'a3b1ead1-d8e1-418f-b964-cd13826da6ac'; }],
    ['native injection failed', v => { v.sent[0].result.ok = false; }],
    ['native events not sent', v => { v.sent[0].result.eventCount = 0; }],
    ['incomplete cleanup', v => { v.frontend.editing.cleanup.closed = 2; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => validate(value)); });
});

test('frontend check inventory remains aligned with the external native validator', () => {
  const source = readFileSync(new URL('../src/sheet/rust/macos-editing-smoke.ts', import.meta.url), 'utf8');
  const block = source.match(/export const MACOS_EDITING_CHECKS = \[([\s\S]*?)\] as const/)[1];
  assert.deepEqual([...block.matchAll(/'([^']+)'/g)].map(match => match[1]), EDITING_CHECKS);
});
