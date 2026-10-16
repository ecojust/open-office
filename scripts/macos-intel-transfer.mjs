import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectInstalledPdf, validateInstalledPdfEvidence } from './office-pdf-native-smoke.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'macos-x64';
const TARGET = 'x86_64-apple-darwin';
const ARTIFACTS = join(ROOT, 'artifacts');
const PROOF = join(ARTIFACTS, `${ID}-build-proof.json`);

export function sha256File(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function sha256Json(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function appInventory(app) {
  const root = realpathSync(app), entries = [];
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), item = lstatSync(path), logical = prefix ? `${prefix}/${name}` : name;
      const common = { path: logical, mode: item.mode & 0o7777 };
      if (item.isSymbolicLink()) {
        const target = readlinkSync(path), destination = realpathSync(path), difference = relative(root, destination);
        assert.ok(!isAbsolute(target) && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference), `App symlink escapes its bundle: ${logical}`);
        entries.push({ ...common, type: 'symlink', target });
      } else if (item.isDirectory()) {
        entries.push({ ...common, type: 'directory' });
        visit(path, logical);
      } else {
        assert.ok(item.isFile(), `Unsupported App filesystem entry: ${logical}`);
        entries.push({ ...common, type: 'file', size: item.size, sha256: sha256File(path) });
      }
    }
  }
  visit(root);
  assert.ok(entries.length > 0, 'App inventory is empty');
  return { entries, sha256: sha256Json(entries) };
}

export function verifyTransferProof(proof, { commit, runId, dmgPath, inventory, signatures, root = ROOT }) {
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.platformId, ID);
  assert.equal(proof.target, TARGET);
  assert.equal(proof.commit, commit, 'The Intel package comes from another source commit');
  assert.equal(proof.runId, runId, 'The Intel package comes from another workflow run');
  assert.equal(proof.dmg.name, basename(dmgPath));
  assert.match(proof.dmg.sha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256File(dmgPath), proof.dmg.sha256, 'Intel DMG bytes changed during transfer');
  assert.equal(sha256Json(proof.app.entries), proof.app.sha256, 'Intel source App manifest digest is invalid');
  if (inventory) {
    assert.equal(sha256Json(inventory.entries), inventory.sha256, 'Restored App manifest digest is invalid');
    assert.equal(inventory.sha256, proof.app.sha256, 'The App copied from the Intel DMG differs from its original bundle');
    assert.deepEqual(inventory.entries, proof.app.entries, 'App file bytes, permissions, or symlinks changed');
  }
  validateInstalledPdfEvidence(proof.pdf, { root });
  const prefix = `Contents/Resources/${proof.pdf.directory}/`;
  for (const [name, evidence] of Object.entries({ ...proof.pdf.files,
    'manifest.json': { sha256: proof.pdf.manifestSha256, bytes: Buffer.byteLength(proof.pdf.manifestText) } })) {
    const entries = proof.app.entries.filter(entry => entry.path === prefix + name);
    assert.equal(entries.length, 1, 'PDF file is missing or duplicated in the original App inventory');
    assert.equal(entries[0].type, 'file');
    assert.equal(entries[0].sha256, evidence.sha256, 'PDF installed file differs from the original App inventory');
    assert.equal(entries[0].size, evidence.bytes, 'PDF installed size differs from the original App inventory');
  }
  assert.deepEqual(Object.keys(proof.signatures || {}).sort(), ['app', 'main']);
  for (const value of Object.values(proof.signatures)) assert.match(value, /^[a-f0-9]{40}$/);
  if (signatures) assert.deepEqual(signatures, proof.signatures, 'App or nested code signature changed during transfer');
}

function command(program, args, timeout = 30_000) {
  const result = spawnSync(program, args, { encoding: 'utf8', shell: false, timeout, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0 && !result.signal,
    `${basename(program)} failed: ${result.error?.message ?? result.stderr?.slice(-4000) ?? result.status}`);
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

function signaturesFor(app) {
  const signatures = {};
  for (const [label, path] of [
    ['app', app], ['main', join(app, 'Contents/MacOS/open-office')],
  ]) {
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', path]);
    const display = command('/usr/bin/codesign', ['--display', '--verbose=4', path]);
    const description = `${display.stdout}\n${display.stderr}`;
    const cdHash = /^CDHash=([0-9a-f]+)$/m.exec(description)?.[1];
    assert.ok(cdHash, `Missing code-signature CDHash for ${label}`);
    signatures[label] = cdHash;
    if (label !== 'app') assert.equal(command('/usr/bin/lipo', ['-archs', path]).stdout.trim(), 'x86_64', `Intel ${label} is not strictly x86_64`);
  }
  return signatures;
}

function buildIdentity() {
  const commit = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID;
  assert.match(commit || '', /^[0-9a-f]{40}$/);
  assert.match(runId || '', /^\d+$/);
  return { commit, runId };
}

function oneDmg() {
  const files = readdirSync(ARTIFACTS).filter(name => /^Open-Office-.*-macos-x64\.dmg$/.test(name));
  assert.equal(files.length, 1, 'Expected exactly one Intel installer');
  return join(ARTIFACTS, files[0]);
}

function recordBuild() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'x64', 'Record the package only on its native Intel builder');
  const app = join(ROOT, 'src-tauri/target/release/bundle/macos/Open Office.app'), dmg = oneDmg();
  const metal = command('/usr/bin/xcrun', ['swift', '-e', [
    'import Foundation', 'import Metal', 'let device = MTLCreateSystemDefaultDevice()',
    'let result: [String: Any] = ["available": device != nil, "name": device?.name ?? "", "supportsMac2": device?.supportsFamily(.mac2) ?? false]',
    'print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)',
  ].join('\n')], 60_000);
  const metalProbe = JSON.parse(metal.stdout.trim());
  assert.equal(typeof metalProbe.available, 'boolean');
  assert.equal(typeof metalProbe.supportsMac2, 'boolean');
  const displays = JSON.parse(command('/usr/sbin/system_profiler', ['-json', 'SPDisplaysDataType'], 45_000).stdout);
  const proof = {
    schemaVersion: 1, platformId: ID, target: TARGET, ...buildIdentity(),
    recordedAt: new Date().toISOString(), buildHostArch: process.arch,
    metalProbe, displays, nativeIntelGpuGuiValidated: false,
    dmg: { name: basename(dmg), sha256: sha256File(dmg), bytes: lstatSync(dmg).size },
    signatures: signaturesFor(app), app: appInventory(app),
    pdf: inspectInstalledPdf(join(app, 'Contents/Resources')),
  };
  writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`Intel package recorded: ${proof.dmg.name}; Metal available=${metalProbe.available}; App digest=${proof.app.sha256}`);
}

function verifyAndCopy() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64', 'The Rosetta verification host must remain native ARM Node');
  assert.equal(process.env.OPEN_OFFICE_ALLOW_ROSETTA, '1', 'Rosetta verification requires an explicit opt-in');
  const proof = JSON.parse(readFileSync(PROOF, 'utf8')), dmg = oneDmg(), identity = buildIdentity();
  verifyTransferProof(proof, { ...identity, dmgPath: dmg });
  const parent = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'open-office-intel-transfer-'));
  const mount = join(parent, 'mounted'), destination = join(parent, 'verified', 'Open Office.app');
  mkdirSync(mount); mkdirSync(dirname(destination));
  let mounted = false;
  try {
    command('/usr/bin/hdiutil', ['verify', dmg], 60_000);
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], 60_000);
    mounted = true;
    const apps = readdirSync(mount).filter(name => name.endsWith('.app'));
    assert.deepEqual(apps, ['Open Office.app'], 'Intel DMG must contain exactly the intended App');
    command('/usr/bin/ditto', [join(mount, apps[0]), destination], 60_000);
    const inventory = appInventory(destination), signatures = signaturesFor(destination);
    verifyTransferProof(proof, { ...identity, dmgPath: dmg, inventory, signatures });
    const validation = {
      schemaVersion: 1, ok: true, platformId: ID, target: TARGET, ...identity,
      hostArch: process.arch, targetArch: 'x64', executionMode: 'rosetta2',
      dmg: proof.dmg, appInventorySha256: inventory.sha256, signatures,
      buildProofSha256: sha256File(PROOF), unchangedAppBytesAndSymlinks: true,
      originalAppResigned: false, nativeIntelGpuGuiValidated: false,
    };
    writeFileSync(join(ARTIFACTS, `${ID}-transfer-validation.json`), `${JSON.stringify(validation, null, 2)}\n`);
    assert.ok(isAbsolute(process.env.GITHUB_ENV || ''), 'GITHUB_ENV must be an absolute workflow file');
    assert.ok(!/[\r\n]/.test(destination), 'Unexpected newline in local App path');
    writeFileSync(process.env.GITHUB_ENV, `OPEN_OFFICE_VERIFIED_APP=${destination}\n`, { flag: 'a' });
    console.log(`Verified unchanged Intel App copied from DMG: ${inventory.sha256}`);
  } finally {
    if (mounted) command('/usr/bin/hdiutil', ['detach', mount], 30_000);
    // Keep the verified App for the following real GUI check; only discard the empty mountpoint.
    if (existsSync(mount)) rmdirSync(mount);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/macos-intel-transfer.mjs record|verify-and-copy');
  if (process.argv[2] === 'record') recordBuild();
  else if (process.argv[2] === 'verify-and-copy') verifyAndCopy();
  else throw new Error('Unknown Intel package transfer operation');
}
