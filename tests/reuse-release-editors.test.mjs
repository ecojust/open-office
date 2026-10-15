import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EDITOR_RELEASE, publishedEditorChecksum, reuseInstalledEditors, runEditorReleaseReuse, validateEditorRelease, verifyEditorReleaseAsset } from '../scripts/reuse-release-editors.mjs';
import { wordcraftSourceHash } from '../scripts/wordcraft-native-smoke.mjs';
import { gridcraftSourceHash } from '../scripts/gridcraft-native-smoke.mjs';
import { deckcraftSourceHash } from '../scripts/deckcraft-native-smoke.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const checksums = [
  'ae39ea30e4e0e9c8290bb60314408de3af2d87a9436de32afbc5b957f0985372  Open-Office-0.10.0-windows-x64-setup.exe',
  'e787e4ee1c5416e30307cf535e56dadeac27b0fa492b7620a2199a9159b50509  Open-Office-0.10.0-macos-arm64.dmg',
  '069ee5cc68343b0876413468763378db8f2219ed69eb9e57e1c90e4100d68e11  Open-Office-0.10.0-macos-x64.dmg',
  '84dd6ddb6d33430b4ad13c7ae40609d2b56de6ad9da7aa69d78155956c04b1b2  Open-Office-0.10.0-source.zip', '',
].join('\n');
const metadata = () => ({ id: EDITOR_RELEASE.id, tag_name: EDITOR_RELEASE.tag, target_commitish: EDITOR_RELEASE.commit, draft: false,
  assets: [EDITOR_RELEASE.dmg, EDITOR_RELEASE.checksums].map(asset => ({ ...asset, digest: `sha256:${asset.sha256}`,
    browser_download_url: `https://github.com/${EDITOR_RELEASE.repository}/releases/download/${EDITOR_RELEASE.tag}/${asset.name}` })) });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'editor-release-reuse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const engines = [
    ['wordcraft', 'WordCraft', '3292ba05d3c15c003823be6849e87a1c6e205242', wordcraftSourceHash],
    ['gridcraft', 'GridCraft', 'e6b6b349708ab4978cb3f061f6bd6ecbc25667cb', gridcraftSourceHash],
    ['deckcraft', 'DeckCraft', '9859da39255c0262cd592bb57101d7f2fa961f72', deckcraftSourceHash],
  ];
  for (const path of ['scripts/build-office-icons.mjs', 'src/icons/icon.svg', 'assets/fonts/open-office/license', 'assets/fonts/deck/license',
    ...engines.flatMap(([engine]) => [`scripts/build-${engine}.mjs`, `vendor/${engine}/src/lib.rs`])]) write(join(root, path), path);
  const resourceRoot = join(root, 'installed', 'Contents', 'Resources');
  for (const [engine, name, upstreamCommit, sourceHash] of engines) {
    const files = { [`${engine}.js`]: Buffer.from('export const fixture = true;'), [`${engine}.d.ts`]: Buffer.from('export const fixture: boolean;'),
      [`${engine}_bg.wasm`]: Buffer.from('0061736d01000000', 'hex'), [`${engine}_bg.wasm.d.ts`]: Buffer.from('export const memory: WebAssembly.Memory;') };
    for (const [name, bytes] of Object.entries(files)) write(join(resourceRoot, 'frontend', engine, name), bytes);
    write(join(resourceRoot, 'frontend', engine, 'manifest.json'), JSON.stringify({ engine: name, upstreamCommit, sourceHash: sourceHash(root),
      target: 'wasm32-unknown-unknown', wasmBindgenVersion: '0.2.129', sizeBytes: 8,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])) }));
  }
  return { root, resourceRoot, write };
}

test('published checksum is independently pinned and metadata cannot select another release or asset', async t => {
  assert.equal(Buffer.byteLength(checksums), EDITOR_RELEASE.checksums.size);
  assert.equal(digest(checksums), EDITOR_RELEASE.checksums.sha256);
  assert.equal(publishedEditorChecksum(checksums), EDITOR_RELEASE.dmg.sha256);
  validateEditorRelease(metadata());
  const cases = [value => { value.tag_name = 'latest'; }, value => { value.id++; }, value => { value.target_commitish = 'main'; },
    value => { value.draft = true; }, value => { value.assets[0].id++; }, value => { value.assets[0].size++; },
    value => { value.assets[0].digest = `sha256:${'f'.repeat(64)}`; }, value => { value.assets[0].browser_download_url = 'https://example.com/asset'; },
    value => { value.assets.push(value.assets[0]); }, value => { value.assets.pop(); }];
  for (const [index, mutate] of cases.entries()) await t.test(`reject metadata mutation ${index}`, () => {
    const value = metadata(); mutate(value); assert.throws(() => validateEditorRelease(value));
  });
  for (const value of [checksums + checksums, checksums.replace(EDITOR_RELEASE.dmg.name, 'other.dmg'),
    checksums.replace(EDITOR_RELEASE.dmg.sha256, 'f'.repeat(64)), checksums.replace('  Open-', '  ../Open-'), 'x'.repeat(17000)]) {
    assert.throws(() => publishedEditorChecksum(value));
  }
});

test('download verifier checks actual bytes, exact size, and regular files', t => {
  const { root, write } = fixture(t), path = join(root, 'download');
  write(path, checksums);
  assert.equal(verifyEditorReleaseAsset(path, EDITOR_RELEASE.checksums).sha256, EDITOR_RELEASE.checksums.sha256);
  write(path, checksums.replace('ae39', 'be39'));
  assert.throws(() => verifyEditorReleaseAsset(path, EDITOR_RELEASE.checksums), /SHA256 differs/);
  write(path, checksums + 'x');
  assert.throws(() => verifyEditorReleaseAsset(path, EDITOR_RELEASE.checksums), /size differs/);
  symlinkSync(path, join(root, 'link'));
  assert.throws(() => verifyEditorReleaseAsset(join(root, 'link'), EDITOR_RELEASE.checksums), /regular file/);
});

test('all three real inspectors seed only fixed files and preserve exact manifest bytes', t => {
  const { root, resourceRoot, write } = fixture(t);
  write(join(resourceRoot, 'frontend/wordcraft/unverified-extra.js'), 'not part of the manifest');
  const result = reuseInstalledEditors(resourceRoot, { root });
  for (const engine of ['wordcraft', 'gridcraft', 'deckcraft']) {
    assert.equal(result[engine].status, 'reused');
    assert.equal(readdirSync(join(root, 'public', engine)).length, 5);
    assert.deepEqual(readFileSync(join(root, 'public', engine, 'manifest.json')), readFileSync(join(resourceRoot, 'frontend', engine, 'manifest.json')));
  }
  assert.equal(existsSync(join(root, 'public/wordcraft/unverified-extra.js')), false);
});

test('a source change falls back only its engine without overwriting its previous resources', t => {
  const { root, resourceRoot, write } = fixture(t);
  write(join(root, 'vendor/gridcraft/src/lib.rs'), 'changed source');
  write(join(root, 'public/gridcraft/previous'), 'keep');
  const result = reuseInstalledEditors(resourceRoot, { root });
  assert.equal(result.wordcraft.status, 'reused');
  assert.equal(result.deckcraft.status, 'reused');
  assert.equal(result.gridcraft.status, 'fallback');
  assert.match(result.gridcraft.reason, /current checkout source/);
  assert.equal(readFileSync(join(root, 'public/gridcraft/previous'), 'utf8'), 'keep');
});

test('shared icon and deck-specific font changes invalidate the appropriate source hashes', t => {
  const { root, resourceRoot, write } = fixture(t);
  write(join(root, 'assets/fonts/deck/license'), 'changed deck font');
  let result = reuseInstalledEditors(resourceRoot, { root });
  assert.equal(result.wordcraft.status, 'reused'); assert.equal(result.gridcraft.status, 'reused'); assert.equal(result.deckcraft.status, 'fallback');
  write(join(root, 'src/icons/icon.svg'), 'changed shared icon');
  result = reuseInstalledEditors(resourceRoot, { root });
  assert.ok(Object.values(result).every(engine => engine.status === 'fallback'));
});

test('corrupt artifacts, incomplete manifests, and escaped symlinks never seed public', async t => {
  const cases = [
    ['corrupt WASM', value => value.write(join(value.resourceRoot, 'frontend/gridcraft/gridcraft_bg.wasm'), 'bad wasm')],
    ['empty manifest inventory', value => {
      const path = join(value.resourceRoot, 'frontend/gridcraft/manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.files = {}; value.write(path, JSON.stringify(manifest));
    }],
    ['escaped symlink', value => {
      const path = join(value.resourceRoot, 'frontend/gridcraft/gridcraft.js');
      value.write(join(value.root, 'escaped.js'), readFileSync(path)); rmSync(path); symlinkSync(join(value.root, 'escaped.js'), path);
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, child => {
    const value = fixture(child); mutate(value);
    const result = reuseInstalledEditors(value.resourceRoot, { root: value.root });
    assert.equal(result.gridcraft.status, 'fallback'); assert.equal(existsSync(join(value.root, 'public/gridcraft')), false);
    assert.equal(result.wordcraft.status, 'reused'); assert.equal(result.deckcraft.status, 'reused');
  });
});

test('staged bytes are independently reverified before existing resources are replaced', t => {
  const { root, resourceRoot, write } = fixture(t);
  write(join(root, 'public/gridcraft/previous'), 'keep');
  const result = reuseInstalledEditors(resourceRoot, { root, copy: (source, destination) => {
    copyFileSync(source, destination);
    if (basename(destination) === 'gridcraft.js') writeFileSync(destination, 'corrupted in transit');
  } });
  assert.equal(result.gridcraft.status, 'fallback'); assert.match(result.gridcraft.reason, /digest differs/);
  assert.equal(readFileSync(join(root, 'public/gridcraft/previous'), 'utf8'), 'keep');
});

test('failed promotion restores the old directory; failed rollback retains the backup', async t => {
  for (const rollbackFails of [false, true]) await t.test(`rollback failure: ${rollbackFails}`, child => {
    const { root, resourceRoot, write } = fixture(child);
    write(join(root, 'public/gridcraft/previous'), 'keep');
    const result = reuseInstalledEditors(resourceRoot, { root, rename: (source, destination) => {
      if (destination === join(root, 'public/gridcraft') && (rollbackFails || basename(source) !== 'previous')) throw Error('injected rename failure');
      renameSync(source, destination);
    } });
    assert.equal(result.gridcraft.status, 'fallback');
    const previous = rollbackFails ? join(result.gridcraft.retainedDirectory, 'previous', 'previous') : join(root, 'public/gridcraft/previous');
    assert.equal(readFileSync(previous, 'utf8'), 'keep');
    if (rollbackFails) {
      assert.equal(dirname(result.gridcraft.retainedDirectory), root, 'Retained backups must not be copied by Vite from public');
      assert.equal(readdirSync(join(root, 'public')).some(name => name.startsWith('.release-editor-')), false);
    }
    assert.equal(result.wordcraft.status, 'reused'); assert.equal(result.deckcraft.status, 'reused');
  });
});

test('network and checksum failures retain a fallback report and never mount an unverified image', async t => {
  for (const phase of ['metadata', 'checksum', 'dmg']) await t.test(phase, child => {
    const { root } = fixture(child), calls = [];
    const report = runEditorReleaseReuse({ root, temporaryRoot: root, platform: 'darwin', arch: 'arm64', execute: (program, args) => {
      calls.push([program, args]);
      if (args[0] === 'api') { if (phase === 'metadata') throw Error('network unavailable'); return JSON.stringify(metadata()); }
      assert.equal(program, 'gh');
      const name = args[args.indexOf('--pattern') + 1], directory = args[args.indexOf('--dir') + 1];
      writeFileSync(join(directory, name), name === 'SHA256SUMS' ? phase === 'checksum' ? 'invalid' : checksums : 'invalid image');
      return '';
    } });
    assert.equal(report.status, 'fallback'); assert.ok(report.reason);
    assert.ok(calls.every(([program]) => program === 'gh'));
    assert.ok(Object.values(report.engines).every(engine => engine.status === 'fallback'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'artifacts/macos-editing/reused-editor-resources.json'), 'utf8')), report);
    assert.equal(readdirSync(root).some(name => name.startsWith('open-office-release-editors-')), false);
  });
});

test('mount lifecycle uses readonly flags and attempts detach even after partial attachment', async t => {
  for (const phase of ['success', 'attach-failed', 'detach-failed']) await t.test(phase, child => {
    const { root, resourceRoot } = fixture(child), calls = [];
    const report = runEditorReleaseReuse({ root, temporaryRoot: root, platform: 'darwin', arch: 'arm64',
      // Isolate the native mount lifecycle; the real digest verifier is tested separately above.
      verifyAsset: (_path, asset) => ({ name: asset.name, bytes: asset.size, sha256: asset.sha256 }),
      execute: (program, args) => {
        calls.push([program, args]);
        if (program === 'gh') {
          if (args[0] === 'api') return JSON.stringify(metadata());
          const name = args[args.indexOf('--pattern') + 1], directory = args[args.indexOf('--dir') + 1];
          writeFileSync(join(directory, name), name === 'SHA256SUMS' ? checksums : 'fixture image'); return '';
        }
        assert.equal(program, '/usr/bin/hdiutil');
        if (args[0] === 'attach') {
          assert.ok(args.includes('-readonly') && args.includes('-nobrowse'));
          const mount = args[args.indexOf('-mountpoint') + 1];
          cpSync(resourceRoot, join(mount, 'Open Office.app/Contents/Resources'), { recursive: true });
          if (phase === 'attach-failed') throw Error('partial attach timeout');
        }
        if (args[0] === 'detach' && phase === 'detach-failed') throw Error('detach unavailable');
        return '';
      } });
    assert.equal(report.diagnosticOnly, true); assert.equal(report.releaseAcceptance, false);
    assert.equal(report.status, phase === 'attach-failed' ? 'fallback' : 'reused');
    assert.ok(calls.some(([, args]) => args[0] === 'detach'));
    assert.equal(report.cleanup.detached, phase !== 'detach-failed');
    assert.equal(report.cleanup.removedTemporaryDirectory, phase !== 'detach-failed');
    if (phase === 'detach-failed') assert.ok(existsSync(join(report.cleanup.retainedDirectory, 'mount/Open Office.app')));
  });
});

test('diagnostic reuse is opt-in and does not skip normal frontend or resource checks', () => {
  const workflow = readFileSync(new URL('../.github/workflows/macos-editing-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(workflow, /reuse_release_editors:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /if: inputs\.reuse_release_editors/);
  const normalBuild = workflow.slice(workflow.indexOf('- name: Build the three Rust editors'), workflow.indexOf('- name: Compile and test the native lifecycle'));
  assert.match(normalBuild, /npm run build/); assert.match(normalBuild, /npm run word:check/); assert.match(normalBuild, /npm run sheet:check/);
  assert.match(normalBuild, /npm run deck:check/); assert.match(normalBuild, /npm run engine:check:dist/);
  assert.doesNotMatch(normalBuild, /if:/);
});
