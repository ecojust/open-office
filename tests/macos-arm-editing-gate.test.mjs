import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appInventory, sha256File } from '../scripts/macos-intel-transfer.mjs';
import { verifyMacosArmEditingProof, readMacosArmEditingProof, runMacosArmEditingGate } from '../scripts/macos-arm-editing-gate.mjs';
import { EDITING_ACTIONS, EDITING_CHECKS, viewportMapping, inputForWindow } from '../scripts/macos-editing-diagnostic.mjs';
import { inspectInstalledWordcraft, wordcraftSourceHash, validateInstalledWordcraftEvidence } from '../scripts/wordcraft-native-smoke.mjs';
import { inspectInstalledGridcraft, gridcraftSourceHash, validateInstalledGridcraftEvidence } from '../scripts/gridcraft-native-smoke.mjs';

// Independent native-event fixture: no OS injection or successful gate flags substitute for its model observations.
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

const digest = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), runId = '38772234421';
function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'arm-editing-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };
  write(join(root, 'package.json'), JSON.stringify({ version: '0.10.1' }));
  for (const path of ['scripts/build-wordcraft.mjs', 'scripts/build-gridcraft.mjs', 'scripts/build-office-icons.mjs',
    'vendor/wordcraft/src/lib.rs', 'vendor/gridcraft/src/lib.rs', 'assets/fonts/open-office/license.txt', 'src/icons/test.svg']) write(join(root, path), `fixture: ${path}`);
  const app = join(root, 'Open Office.app'), resourceRoot = join(app, 'Contents/Resources');
  write(join(app, 'Contents/MacOS/open-office'), 'ARM application fixture');
  write(join(resourceRoot, 'pdf-runtime/open-office-pdf'), 'ARM PDF fixture');
  for (const [engine, name, upstream, hash] of [
    ['wordcraft', 'WordCraft', '3292ba05d3c15c003823be6849e87a1c6e205242', wordcraftSourceHash],
    ['gridcraft', 'GridCraft', 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb', gridcraftSourceHash],
  ]) {
    const files = { [`${engine}.js`]: Buffer.from('export const fixture=true;'), [`${engine}.d.ts`]: Buffer.from('export const fixture:boolean;'),
      [`${engine}_bg.wasm`]: Buffer.from('0061736d01000000', 'hex'), [`${engine}_bg.wasm.d.ts`]: Buffer.from('export const memory:WebAssembly.Memory;') };
    for (const [name, bytes] of Object.entries(files)) write(join(resourceRoot, 'frontend', engine, name), bytes);
    const manifest = { engine: name, upstreamCommit: upstream, sourceHash: hash(root), target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129',
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])), sizeBytes: 8 };
    write(join(resourceRoot, 'frontend', engine, 'manifest.json'), JSON.stringify(manifest));
  }
  const dmgPath = join(root, 'Open-Office-0.10.1-macos-arm64.dmg'); write(dmgPath, 'immutable DMG fixture');
  const scenario = fixture(), signatures = { app: '1'.repeat(40), main: '2'.repeat(40), pdfRuntime: '3'.repeat(40) };
  const inventory = appInventory(app);
  const proof = { schemaVersion: 1, kind: 'macos-arm-editing-gate', platformId: 'macos-arm64', target: 'aarch64-apple-darwin',
    commit, runId, ok: true, status: 'passed', releaseAcceptance: true,
    host: { platform: 'darwin', arch: 'arm64', machine: 'arm64', productVersion: '26.0.1', buildVersion: '25A362' },
    dmg: { name: 'Open-Office-0.10.1-macos-arm64.dmg', bytes: readFileSync(dmgPath).length, sha256: sha256File(dmgPath) },
    app: inventory, copiedAppPath: app, signatures, architectures: { main: 'arm64', pdfRuntime: 'arm64' },
    transfer: { readonlyMount: true, originalAppResigned: false, unchangedAppBytesAndSymlinks: true,
      copiedInventorySha256: inventory.sha256, finalInventorySha256: inventory.sha256, copiedSignatures: { ...signatures }, finalSignatures: { ...signatures } },
    cleanup: { detached: true, removedTemporaryApp: true },
    diagnostic: { schemaVersion: 1, diagnosticOnly: true, releaseAcceptance: false, commit, runId, ok: true, status: 'passed', gaps: [],
      preflight: { schemaVersion: 1, kind: 'macos-os-input-preflight', permissions: { ...permissions } },
      process: { pid: 1234, exitCode: 0, signal: null }, system: { machine: 'arm64', swVers: 'ProductName:\tmacOS\nProductVersion:\t26.0.1\nBuildVersion:\t25A362' },
      application: { app, executableSha256: sha256File(join(app, 'Contents/MacOS/open-office')),
        wordcraft: inspectInstalledWordcraft(resourceRoot, { root }), gridcraft: inspectInstalledGridcraft(resourceRoot, { root }) },
      frontend: scenario.frontend, nativeDiagnostics: scenario.diagnostics, actions: scenario.sent } };
  return { root, proof, options: { commit, runId, dmgPath, root }, app };
}

test('Linux publisher verifies a complete original-DMG native-editing proof without rebuilding', t => {
  const value = installation(t);
  const before = structuredClone(value.proof);
  assert.equal(verifyMacosArmEditingProof(value.proof, value.options), true);
  assert.deepEqual(value.proof, before, 'Proof verification must be read-only');
  assert.equal(value.proof.diagnostic.actions.length, 11);
  assert.equal(value.proof.diagnostic.frontend.editing.checks.length, 8);
});

test('release success flags cannot replace OS actions, actual models, original sessions or a surviving page', async t => {
  const { proof, options } = installation(t);
  const cases = [
    ['preflight only', p => { p.diagnostic.status = 'preflight-passed'; }],
    ['blocked', p => { p.diagnostic.blockedReason = 'permission-denied'; }],
    ['gap', p => { p.diagnostic.gaps.push('missing evidence'); }],
    ['failed exit', p => { p.diagnostic.process.exitCode = 1; }],
    ['spawn failure', p => { p.diagnostic.process.spawnError = 'failed'; }],
    ['post-event denied', p => { p.diagnostic.preflight.permissions.postEventAccess = false; }],
    ['missing action', p => { p.diagnostic.actions.pop(); }],
    ['untrusted input', p => { p.diagnostic.frontend.editing.actions[0].events[0].isTrusted = false; }],
    ['unchanged model', p => { p.diagnostic.frontend.editing.observations.singleClickValue = null; }],
    ['lost tab', p => { p.diagnostic.frontend.editing.actions[5].after.tabs.pop(); }],
    ['page reload', p => { p.diagnostic.nativeDiagnostics.generation = 2; }],
    ['WebContent crash', p => { p.diagnostic.nativeDiagnostics.terminations = 1; }],
    ['another PID', p => { p.diagnostic.process.pid = 5678; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const changed = structuredClone(proof); mutate(changed);
    assert.throws(() => verifyMacosArmEditingProof(changed, options));
  });
});

test('proof binds run, commit, macOS 26 ARM, copied executable, signatures and unchanged inventory', async t => {
  const { proof, options } = installation(t);
  const cases = [
    p => { p.commit = 'b'.repeat(40); }, p => { p.runId = '1'; }, p => { p.diagnostic.commit = 'b'.repeat(40); },
    p => { p.diagnostic.runId = '1'; }, p => { p.host.productVersion = '15.7'; }, p => { p.host.arch = 'x64'; },
    p => { p.diagnostic.system.swVers = p.diagnostic.system.swVers.replace('26.0.1', '26.1'); },
    p => { p.architectures.main = 'x86_64 arm64'; }, p => { p.transfer.originalAppResigned = true; },
    p => { p.transfer.readonlyMount = false; }, p => { p.transfer.copiedInventorySha256 = 'f'.repeat(64); },
    p => { p.transfer.finalInventorySha256 = 'f'.repeat(64); }, p => { p.app.entries[0].mode++; },
    p => { p.transfer.copiedSignatures.app = 'f'.repeat(40); }, p => { p.transfer.finalSignatures.main = 'f'.repeat(40); },
    p => { p.cleanup.detached = false; }, p => { p.cleanup.removedTemporaryApp = false; },
    p => { p.diagnostic.application.app += '-other'; }, p => { p.diagnostic.application.executableSha256 = 'f'.repeat(64); },
    p => { p.ok = false; }, p => { p.releaseAcceptance = false; }, p => { p.error = 'failure'; },
  ];
  for (const [index, mutate] of cases.entries()) await t.test(`identity mutation ${index + 1}`, () => {
    const changed = structuredClone(proof); mutate(changed);
    assert.throws(() => verifyMacosArmEditingProof(changed, options));
  });
});

test('published DMG bytes and exact source-version filename must match the tested package', t => {
  const { proof, options, root } = installation(t);
  const other = join(root, 'Open-Office-0.10.0-macos-arm64.dmg');
  writeFileSync(other, readFileSync(options.dmgPath));
  assert.throws(() => verifyMacosArmEditingProof(proof, { ...options, dmgPath: other }), /source version/);
  const bytes = readFileSync(options.dmgPath); bytes[0] ^= 1;
  writeFileSync(options.dmgPath, bytes);
  assert.throws(() => verifyMacosArmEditingProof(proof, options), /DMG bytes differ/);
});

test('installed-only wrappers reject stale source and bind every installed asset to the mounted App', t => {
  const { proof, options, root } = installation(t);
  for (const [engine, validate] of [['wordcraft', validateInstalledWordcraftEvidence], ['gridcraft', validateInstalledGridcraftEvidence]]) {
    const installed = proof.diagnostic.application[engine];
    assert.equal(validate(installed, { root }).engine, engine === 'wordcraft' ? 'WordCraft' : 'GridCraft');
    const damaged = structuredClone(installed); damaged.manifestText += ' ';
    assert.throws(() => validate(damaged, { root }), /manifest digest/);
    const source = join(root, `vendor/${engine}/src/lib.rs`), bytes = readFileSync(source);
    writeFileSync(source, 'different source');
    assert.throws(() => verifyMacosArmEditingProof(proof, options), /current checkout source/);
    writeFileSync(source, bytes);
    const changed = structuredClone(proof);
    const entry = changed.app.entries.find(entry => entry.path.endsWith(`/frontend/${engine}/${engine}.js`));
    entry.sha256 = 'f'.repeat(64);
    changed.app.sha256 = digest(JSON.stringify(changed.app.entries));
    changed.transfer.copiedInventorySha256 = changed.transfer.finalInventorySha256 = changed.app.sha256;
    assert.throws(() => verifyMacosArmEditingProof(changed, options), /differs from the mounted App/);
  }
});

test('proof reader rejects oversized files and symlinks before parsing', t => {
  const { root, proof } = installation(t), path = join(root, 'proof.json');
  writeFileSync(path, JSON.stringify(proof));
  assert.deepEqual(readMacosArmEditingProof(path), proof);
  const link = join(root, 'linked.json'); symlinkSync(path, link);
  assert.throws(() => readMacosArmEditingProof(link), /bound/);
  truncateSync(path, 16 * 1024 * 1024 + 1);
  assert.throws(() => readMacosArmEditingProof(path), /bound/);
});

test('runner retains a failed proof when called on an unsupported host', { skip: process.platform === 'darwin' }, async t => {
  const { root, options } = installation(t);
  const proof = await runMacosArmEditingGate(['--dmg', options.dmgPath, '--helper', join(root, 'helper')], { GITHUB_SHA: commit, GITHUB_RUN_ID: runId }, root);
  assert.equal(proof.ok, false); assert.equal(proof.releaseAcceptance, false);
  assert.match(proof.error, /requires macOS/);
  assert.deepEqual(readMacosArmEditingProof(join(root, 'artifacts/macos26-editing-proof.json')), proof);
});
