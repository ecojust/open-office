import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appInventory, sha256File, verifyTransferProof } from '../scripts/macos-intel-transfer.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'intel-dmg-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = join(directory, 'Open Office.app'), dmgPath = join(directory, 'Open-Office-0.1.0-macos-x64.dmg');
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'payload'), 'original x64 fixture');
  writeFileSync(dmgPath, 'original DMG fixture');
  const identity = { commit: 'a'.repeat(40), runId: '123' };
  const proof = {
    schemaVersion: 1, platformId: 'macos-x64', target: 'x86_64-apple-darwin', ...identity,
    dmg: { name: 'Open-Office-0.1.0-macos-x64.dmg', sha256: sha256File(dmgPath) },
    app: appInventory(app), signatures: { app: '11', main: '11', pdfRuntime: '22' },
  };
  return { app, dmgPath, identity, proof, options: { ...identity, dmgPath } };
}

test('unchanged Intel package, complete App inventory and signatures pass transfer validation', t => {
  const { app, proof, options } = fixture(t);
  assert.doesNotThrow(() => verifyTransferProof(proof, { ...options, inventory: appInventory(app), signatures: proof.signatures }));
});

test('changed DMG bytes or another build identity cannot pass the transfer gate', t => {
  const { dmgPath, proof, options } = fixture(t);
  assert.throws(() => verifyTransferProof(proof, { ...options, runId: '124' }), /another workflow run/);
  assert.throws(() => verifyTransferProof(proof, { ...options, commit: 'b'.repeat(40) }), /another source commit/);
  writeFileSync(dmgPath, 'replacement DMG fixture');
  assert.throws(() => verifyTransferProof(proof, options), /DMG bytes changed/);
});

test('changed App payload and tampered manifest digest are independently rejected', t => {
  const { app, proof, options } = fixture(t);
  writeFileSync(join(app, 'Contents', 'payload'), 'replacement app bytes');
  assert.throws(() => verifyTransferProof(proof, { ...options, inventory: appInventory(app) }), /differs from its original bundle/);
  const forged = structuredClone(proof);
  forged.app.entries.find(item => item.type === 'file').sha256 = '0'.repeat(64);
  assert.throws(() => verifyTransferProof(forged, options), /manifest digest is invalid/);
});

test('re-signing the transferred application is rejected even if payload bytes match', t => {
  const { proof, options } = fixture(t);
  assert.throws(() => verifyTransferProof(proof, { ...options, signatures: { ...proof.signatures, app: '33' } }), /signature changed/);
});

test('App inventories record internal symlinks and reject links outside the bundle', { skip: process.platform === 'win32' }, t => {
  const { app } = fixture(t);
  symlinkSync('payload', join(app, 'Contents', 'alias'));
  assert.ok(appInventory(app).entries.some(item => item.type === 'symlink' && item.target === 'payload'));
  symlinkSync('../..', join(app, 'Contents', 'escape'));
  assert.throws(() => appInventory(app), /escapes its bundle/);
});
