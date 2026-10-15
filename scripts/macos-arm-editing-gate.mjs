import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appInventory, sha256File } from './macos-intel-transfer.mjs';
import { checkInputPreflight, runMacosEditingDiagnostic, validateEditingReport } from './macos-editing-diagnostic.mjs';
import { validateInstalledWordcraftEvidence, validateNativeWordcraftEvidence } from './wordcraft-native-smoke.mjs';
import { validateInstalledGridcraftEvidence, validateNativeGridcraftEvidence } from './gridcraft-native-smoke.mjs';
import { validateNativeDeckcraftEvidence } from './deckcraft-native-smoke.mjs';
import { runNativeSmoke, validateFrontendReport } from './native-smoke.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const jsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readJson(path, limit = LIMIT) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, 'Evidence file is invalid or exceeds its bound');
  const bytes = readFileSync(path);
  assert.ok(bytes.length <= limit, 'Evidence file exceeds its read bound');
  return JSON.parse(bytes.toString('utf8'));
}
export const readMacosArmEditingProof = path => readJson(path);

function writeProof(path, proof) {
  const text = JSON.stringify(proof, null, 2) + '\n';
  assert.ok(Buffer.byteLength(text) <= LIMIT, 'Editing proof exceeds its write bound');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function identity(commit, runId) {
  assert.match(commit || '', /^[a-f0-9]{40}$/, 'An exact source commit is required');
  assert.match(runId || '', /^[1-9]\d*$/, 'An exact workflow run ID is required');
}
function dmgName(root) {
  const { version } = readJson(join(root, 'package.json'), 64 * 1024);
  assert.match(version || '', /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  return `Open-Office-${version}-macos-arm64.dmg`;
}
function signatureInventory(signatures) {
  assert.deepEqual(Object.keys(signatures || {}).sort(), ['app', 'main', 'pdfRuntime']);
  for (const value of Object.values(signatures)) assert.match(value, /^[a-f0-9]{40}$/, 'Code-signature CDHash is invalid');
}
function fileEntry(app, path) {
  const entries = app.entries.filter(entry => entry.path === path);
  assert.equal(entries.length, 1, `Missing or duplicate App file: ${path}`);
  const entry = entries[0];
  assert.equal(entry.type, 'file', `App evidence must identify a regular file: ${path}`);
  assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
  assert.match(entry.sha256, SHA256);
  return entry;
}

function bindInstalledFiles(app, installed, engine) {
  const prefix = `Contents/Resources/${installed.directory}/`;
  const manifest = fileEntry(app, `${prefix}manifest.json`);
  assert.equal(manifest.sha256, installed.manifestSha256, 'Installed manifest differs from the mounted App');
  assert.equal(manifest.size, Buffer.byteLength(installed.manifestText));
  for (const [name, evidence] of Object.entries(installed.files)) {
    const entry = fileEntry(app, prefix + name);
    assert.equal(entry.sha256, evidence.sha256, `Installed ${engine} file differs from the mounted App`);
    assert.equal(entry.size, evidence.bytes);
  }
}

function validateCompatibilityPolicy(diagnostics) {
  assert.ok(Array.isArray(diagnostics?.events), 'WebKit compatibility readback is missing');
  const created = diagnostics.events.filter(event => event?.phase === 'editing-webkit-policy')
    .map(event => JSON.parse(event.detail)).filter(policy => policy?.stage === 'created');
  assert.equal(created.length, 1, 'Exactly one created WebView compatibility readback is required');
  assert.deepEqual(created[0], { source: 'WKWebpagePreferences.securityRestrictionMode', stage: 'created',
    supported: true, requested: 1, actual: 1, action: 'readback' }, 'The created WebView did not use the required public compatibility mode');
}

function validateFullSmokeLifecycle(report) {
  assert.equal(report.nativeDiagnosticsError, undefined, 'Full-editor lifecycle diagnostics could not be preserved');
  const lifecycle = report.nativeDiagnostics;
  assert.equal(lifecycle?.schemaVersion, 1, 'Full-editor lifecycle evidence is missing');
  assert.equal(lifecycle.scope, 'full');
  assert.equal(lifecycle.generation, 1, 'Full-editor smoke observed a page restart');
  assert.equal(lifecycle.terminations, 0, 'Full-editor smoke observed a WebContent termination');
  assert.ok(Array.isArray(lifecycle.events) && lifecycle.events.length <= 256);
  assert.ok(lifecycle.events.every(event => typeof event?.phase === 'string' && event.phase.length <= 80
    && typeof event.detail === 'string' && event.detail.length <= 400
    && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && [0, 1].includes(event.generation)), 'Invalid full-editor lifecycle event');
  assert.equal(lifecycle.events.filter(event => event?.phase === 'document-start').length, 1, 'Full-editor smoke must retain exactly one page start');
  assert.ok(lifecycle.events.every(event => event?.phase !== 'web-content-terminated' && event?.phase !== 'web-content-reload-requested'),
    'Full-editor smoke recorded a WebContent termination or reload');
  const started = lifecycle.events.findIndex(event => event.phase === 'document-start');
  const completed = lifecycle.events.filter(event => event.phase === 'report-written');
  assert.equal(lifecycle.events[started].generation, 1);
  assert.equal(completed.length, 1, 'Full-editor lifecycle must include exactly one completed report');
  assert.equal(completed[0].detail, 'passed');
  assert.equal(completed[0].generation, 1);
  assert.ok(lifecycle.events.indexOf(completed[0]) > started, 'Full-editor report predates its page start');
  validateCompatibilityPolicy(lifecycle);
}

function validateFullSmoke(proof, root) {
  const report = proof.fullSmoke;
  assert.equal(report?.schemaVersion, 1, 'Full-editor native smoke evidence is missing');
  assert.equal(report.kind, 'native-gui-smoke');
  assert.equal(report.ok, true, 'Full-editor native smoke did not pass');
  assert.deepEqual(report.errors, []);
  assert.equal(report.commit, proof.commit, 'Full-editor smoke belongs to another source commit');
  assert.equal(report.runId, proof.runId, 'Full-editor smoke belongs to another workflow run');
  assert.equal(report.platformId, proof.platformId);
  assert.equal(report.target, proof.target);
  assert.deepEqual(report.host, { platform: 'darwin', architecture: 'arm64' });
  assert.equal(report.hostArch, 'arm64');
  assert.equal(report.targetArch, 'arm64');
  assert.equal(report.executionMode, 'native', 'Full-editor smoke must run natively on ARM');
  assert.equal(report.timeoutMs, 300_000, 'Full-editor smoke must retain its original timeout');
  assert.equal(report.process?.launchExecutable, join(proof.copiedAppPath, 'Contents/MacOS/open-office'), 'Full-editor smoke ran another App');
  assert.deepEqual(report.process.launchArguments, []);
  assert.ok(Number.isSafeInteger(report.process.pid) && report.process.pid > 1);
  assert.equal(report.process.cleanExit, true);
  assert.equal(report.process.exitCode, 0);
  assert.equal(report.process.signal, null);
  assert.equal(report.process.timedOut, false);
  assert.equal(report.process.spawnErrorCode, undefined);
  assert.equal(report.process.cleanupError, undefined);
  validateFullSmokeLifecycle(report);
  const installed = report.preflight;
  assert.equal(installed?.installedResourceLayout, true);
  assert.equal(installed.finalExecutable, 'open-office');
  assert.equal(installed.finalExecutableSha256, fileEntry(proof.app, 'Contents/MacOS/open-office').sha256, 'Full-editor smoke ran another executable');
  assert.equal(installed.pdfExecutableSha256, fileEntry(proof.app, 'Contents/Resources/pdf-runtime/open-office-pdf').sha256, 'Full-editor smoke ran another PDF runtime');
  assert.deepEqual(installed.macos?.mainArchitectures, ['arm64']);
  assert.deepEqual(installed.macos.pdfArchitectures, ['arm64']);
  assert.deepEqual(installed.macos.strictSignatureVerification, ['app', 'main', 'pdfRuntime']);
  assert.deepEqual(installed.macos.cdHashes, proof.signatures, 'Full-editor smoke signatures differ from the mounted App');
  assert.equal(installed.macos.originalAppResigned, false);
  // Re-run the functional and independent document readback checks at publish
  // time; an ok flag or optional shared-memory capability is not sufficient.
  validateFrontendReport(report.frontend);
  for (const [engine, validate] of [['wordcraft', validateNativeWordcraftEvidence], ['gridcraft', validateNativeGridcraftEvidence], ['deckcraft', validateNativeDeckcraftEvidence]]) {
    validate(report, { root });
    bindInstalledFiles(proof.app, installed[engine], engine);
  }
}

/** Linux publication verifies serialized native evidence against the exact DMG
 * and source checkout; it never promotes a diagnostic-only success flag alone. */
export function verifyMacosArmEditingProof(proof, { commit, runId, dmgPath, root = ROOT }) {
  identity(commit, runId);
  assert.ok(proof && Buffer.byteLength(JSON.stringify(proof)) <= LIMIT, 'Editing proof is absent or oversized');
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.kind, 'macos-arm-editing-gate');
  assert.equal(proof.platformId, 'macos-arm64');
  assert.equal(proof.target, 'aarch64-apple-darwin');
  assert.equal(proof.commit, commit, 'Editing proof belongs to another source commit');
  assert.equal(proof.runId, runId, 'Editing proof belongs to another workflow run');
  assert.equal(proof.status, 'passed');
  assert.equal(proof.ok, true);
  assert.equal(proof.releaseAcceptance, true);
  assert.equal(proof.error, undefined);
  assert.deepEqual(proof.cleanup, { detached: true, removedTemporaryApp: true });
  assert.equal(proof.host?.platform, 'darwin');
  assert.equal(proof.host.arch, 'arm64');
  assert.equal(proof.host.machine, 'arm64');
  assert.match(proof.host.productVersion, /^26(?:\.\d+){1,2}$/, 'Editing gate requires macOS 26');
  assert.match(proof.host.buildVersion, /^[a-zA-Z0-9]+$/);

  const stat = lstatSync(dmgPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'ARM installer must be a regular file');
  assert.equal(basename(dmgPath), dmgName(root), 'ARM installer name does not match the source version');
  assert.equal(proof.dmg?.name, basename(dmgPath));
  assert.equal(proof.dmg.bytes, stat.size);
  assert.match(proof.dmg.sha256, SHA256);
  assert.equal(sha256File(dmgPath), proof.dmg.sha256, 'ARM DMG bytes differ from the tested installer');
  assert.ok(Array.isArray(proof.app?.entries) && proof.app.entries.length > 0 && proof.app.entries.length <= 20000);
  assert.equal(jsonHash(proof.app.entries), proof.app.sha256, 'App inventory digest is invalid');
  assert.equal(new Set(proof.app.entries.map(entry => entry.path)).size, proof.app.entries.length, 'Duplicate App inventory path');
  signatureInventory(proof.signatures);
  assert.equal(proof.transfer?.readonlyMount, true);
  assert.equal(proof.transfer.originalAppResigned, false);
  assert.equal(proof.transfer.unchangedAppBytesAndSymlinks, true);
  assert.equal(proof.transfer.copiedInventorySha256, proof.app.sha256, 'Copied App differs from the DMG');
  assert.equal(proof.transfer.finalInventorySha256, proof.app.sha256, 'App changed during the editing check');
  assert.deepEqual(proof.transfer.copiedSignatures, proof.signatures, 'Copied App signatures changed');
  assert.deepEqual(proof.transfer.finalSignatures, proof.signatures, 'App signatures changed during the editing check');
  assert.deepEqual(proof.architectures, { main: 'arm64', pdfRuntime: 'arm64' });

  const report = proof.diagnostic;
  assert.equal(report?.schemaVersion, 1);
  assert.equal(report.commit, commit);
  assert.equal(report.runId, runId);
  assert.equal(report.diagnosticOnly, true, 'Original diagnostic semantics must remain intact');
  assert.equal(report.releaseAcceptance, false);
  assert.equal(report.status, 'passed', 'A preflight-only or blocked diagnostic cannot pass the gate');
  assert.equal(report.ok, true);
  assert.equal(report.error, undefined);
  assert.equal(report.blockedReason, undefined);
  assert.deepEqual(report.gaps, []);
  assert.equal(checkInputPreflight(report.preflight), null);
  assert.equal(report.system?.machine, 'arm64');
  assert.equal(/^ProductVersion:\s*(\S+)\s*$/m.exec(report.system.swVers)?.[1], proof.host.productVersion);
  assert.equal(/^BuildVersion:\s*(\S+)\s*$/m.exec(report.system.swVers)?.[1], proof.host.buildVersion);
  assert.ok(Number.isSafeInteger(report.process?.pid) && report.process.pid > 1);
  assert.equal(report.process.exitCode, 0);
  assert.equal(report.process.signal, null);
  assert.equal(report.process.spawnError, undefined);
  assert.ok(isAbsolute(proof.copiedAppPath || ''));
  assert.equal(report.application?.app, proof.copiedAppPath, 'Diagnostic ran another App');
  assert.equal(report.application.executableSha256, fileEntry(proof.app, 'Contents/MacOS/open-office').sha256, 'Diagnostic ran another executable');
  fileEntry(proof.app, 'Contents/Resources/pdf-runtime/open-office-pdf');
  for (const [engine, validate] of [['wordcraft', validateInstalledWordcraftEvidence], ['gridcraft', validateInstalledGridcraftEvidence]]) {
    const installed = report.application[engine];
    validate(installed, { root });
    bindInstalledFiles(proof.app, installed, engine);
  }
  validateEditingReport(report.frontend, report.nativeDiagnostics, report.actions);
  assert.ok(report.actions.every(action => action.result.pid === report.process.pid), 'OS input targeted another process');
  validateCompatibilityPolicy(report.nativeDiagnostics);
  validateFullSmoke(proof, root);
  return true;
}

function command(program, args, timeout = 30000) {
  const result = spawnSync(program, args, { encoding: 'utf8', shell: false, timeout, maxBuffer: 256 * 1024 });
  assert.ok(!result.error && result.status === 0 && !result.signal,
    `${basename(program)} failed: ${String(result.error?.message || result.stderr || result.stdout || result.status).slice(-2000)}`);
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}
function signaturesFor(app) {
  const signatures = {}, architectures = {};
  for (const [label, path] of [['app', app], ['main', join(app, 'Contents/MacOS/open-office')],
    ['pdfRuntime', join(app, 'Contents/Resources/pdf-runtime/open-office-pdf')]]) {
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
    const display = command('/usr/bin/codesign', ['--display', '--verbose=4', path]);
    signatures[label] = /^CDHash=([a-f0-9]+)$/m.exec(display)?.[1];
    if (label !== 'app') {
      architectures[label] = command('/usr/bin/lipo', ['-archs', path]);
      assert.equal(architectures[label], 'arm64', `${label} must be native ARM only`);
    }
  }
  signatureInventory(signatures);
  return { signatures, architectures };
}

export async function runMacosArmEditingGate(args = process.argv.slice(2), env = process.env, root = ROOT) {
  const proof = { schemaVersion: 1, kind: 'macos-arm-editing-gate', platformId: 'macos-arm64', target: 'aarch64-apple-darwin',
    commit: env.GITHUB_SHA || null, runId: env.GITHUB_RUN_ID || null, startedAt: new Date().toISOString(),
    ok: false, status: 'failed', releaseAcceptance: false, cleanup: { detached: false, removedTemporaryApp: false } };
  let temporary, mount, destination, mounted = false, dmg;
  try {
    assert.equal(args.length, 4, 'Usage: macos-arm-editing-gate.mjs --dmg PATH --helper PATH');
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(['--dmg', '--helper'].includes(args[index]) && !options.has(args[index]));
      assert.ok(isAbsolute(args[index + 1] || ''), 'Gate paths must be absolute');
      options.set(args[index], args[index + 1]);
    }
    identity(proof.commit, proof.runId);
    assert.equal(process.platform, 'darwin', 'Editing gate requires macOS');
    assert.equal(process.arch, 'arm64', 'Editing gate requires native ARM Node');
    proof.host = { platform: process.platform, arch: process.arch, machine: command('/usr/bin/uname', ['-m']),
      productVersion: command('/usr/bin/sw_vers', ['-productVersion']), buildVersion: command('/usr/bin/sw_vers', ['-buildVersion']) };
    assert.equal(proof.host.machine, 'arm64');
    assert.match(proof.host.productVersion, /^26(?:\.\d+){1,2}$/, 'Editing gate requires macOS 26');
    dmg = options.get('--dmg');
    assert.equal(basename(dmg), dmgName(root), 'ARM installer name does not match the source version');
    const stat = lstatSync(dmg);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0);
    proof.dmg = { name: basename(dmg), bytes: stat.size, sha256: sha256File(dmg) };
    temporary = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'open-office-arm-editing-'));
    mount = join(temporary, 'mounted'); destination = join(temporary, 'verified', 'Open Office.app');
    mkdirSync(mount); mkdirSync(dirname(destination));
    command('/usr/bin/hdiutil', ['verify', dmg], 60000);
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], 60000);
    mounted = true;
    assert.deepEqual(readdirSync(mount).filter(name => name.endsWith('.app')), ['Open Office.app']);
    const original = join(mount, 'Open Office.app');
    proof.app = appInventory(original);
    Object.assign(proof, signaturesFor(original));
    command('/usr/bin/ditto', [original, destination], 60000);
    destination = realpathSync(destination);
    const copied = appInventory(destination), before = signaturesFor(destination);
    assert.deepEqual(copied, proof.app, 'Copied App file bytes, permissions or symlinks changed');
    assert.deepEqual(before.signatures, proof.signatures, 'Copied App signatures changed');
    proof.copiedAppPath = destination;
    proof.transfer = { readonlyMount: true, originalAppResigned: false, unchangedAppBytesAndSymlinks: false,
      copiedInventorySha256: copied.sha256, copiedSignatures: before.signatures };
    proof.diagnostic = await runMacosEditingDiagnostic(['--app', destination, '--helper', options.get('--helper')], env, root);
    assert.equal(proof.diagnostic.ok, true, proof.diagnostic.error || proof.diagnostic.blockedReason || 'Native editing did not pass');
    validateCompatibilityPolicy(proof.diagnostic.nativeDiagnostics);
    // Exercise all editors on the same unmodified App after real OS editing.
    // Explicit scope prevents an inherited diagnostic scope replacing this run.
    proof.fullSmoke = await runNativeSmoke(['--app', destination], { ...env,
      OPEN_OFFICE_PLATFORM_ID: proof.platformId, OPEN_OFFICE_TARGET: proof.target,
      OPEN_OFFICE_SMOKE_SCOPE: 'full', OPEN_OFFICE_ALLOW_ROSETTA: '0' }, root);
    const after = appInventory(destination), final = signaturesFor(destination);
    proof.transfer.finalInventorySha256 = after.sha256;
    proof.transfer.finalSignatures = final.signatures;
    assert.deepEqual(after, proof.app, 'App file bytes, permissions or symlinks changed during editing');
    assert.deepEqual(final.signatures, proof.signatures, 'App signatures changed during editing');
    proof.transfer.unchangedAppBytesAndSymlinks = true;
    assert.equal(proof.fullSmoke.ok, true, proof.fullSmoke.errors?.[0] || 'Full-editor native smoke did not pass');
    validateFullSmokeLifecycle(proof.fullSmoke);
    proof.status = 'passed'; proof.ok = true; proof.releaseAcceptance = true;
  } catch (error) { proof.error = String(error?.message || error).slice(0, 4000); }
  finally {
    try {
      if (mounted) { command('/usr/bin/hdiutil', ['detach', mount], 30000); mounted = false; }
      proof.cleanup.detached = !mounted;
      if (temporary && !mounted) rmSync(temporary, { recursive: true, force: true });
      proof.cleanup.removedTemporaryApp = !temporary || !existsSync(temporary);
      if (proof.ok) verifyMacosArmEditingProof(proof, { commit: proof.commit, runId: proof.runId, dmgPath: dmg, root });
    } catch (error) { proof.error = String(error?.message || error).slice(0, 4000); }
    if (proof.error) { proof.status = 'failed'; proof.ok = false; proof.releaseAcceptance = false; }
    proof.finishedAt = new Date().toISOString();
    writeProof(join(root, 'artifacts', 'macos26-editing-proof.json'), proof);
  }
  return proof;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const proof = await runMacosArmEditingGate();
  console.log(`macOS 26 ARM installed-package editing gate: ${proof.status}${proof.error ? ` (${proof.error})` : ''}`);
  process.exitCode = proof.ok ? 0 : 1;
}
