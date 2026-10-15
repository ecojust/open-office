import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './macos-intel-transfer.mjs';
import { inspectInstalledWordcraft } from './wordcraft-native-smoke.mjs';
import { inspectInstalledGridcraft } from './gridcraft-native-smoke.mjs';
import { inspectInstalledDeckcraft } from './deckcraft-native-smoke.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A diagnostic optimization, never a release proof or an arbitrary release downloader.
export const EDITOR_RELEASE = Object.freeze({
  repository: 'ecojust/open-office', tag: 'desktop-v0.10.0-38761189564',
  commit: '826a69471e87a427dee70ea835f697783258a6bf', id: 414035222,
  dmg: Object.freeze({ id: 644473617, name: 'Open-Office-0.10.0-macos-arm64.dmg', size: 202168212,
    sha256: 'e787e4ee1c5416e30307cf535e56dadeac27b0fa492b7620a2199a9159b50509' }),
  checksums: Object.freeze({ id: 644473618, name: 'SHA256SUMS', size: 403,
    sha256: '5c4746e8e289b23fec19e579456692cb403ffbb226485c65c566ff23a90c2070' }),
});
const INSPECTORS = Object.freeze({ wordcraft: inspectInstalledWordcraft, gridcraft: inspectInstalledGridcraft, deckcraft: inspectInstalledDeckcraft });
const failure = error => String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 600);
const expectedFiles = engine => ['manifest.json', `${engine}.d.ts`, `${engine}.js`, `${engine}_bg.wasm`, `${engine}_bg.wasm.d.ts`];

export function validateEditorRelease(metadata) {
  assert.equal(metadata?.id, EDITOR_RELEASE.id, 'Unexpected release id');
  assert.equal(metadata.tag_name, EDITOR_RELEASE.tag, 'Unexpected release tag');
  assert.equal(metadata.target_commitish, EDITOR_RELEASE.commit, 'Unexpected release source commit');
  assert.equal(metadata.draft, false, 'The source release must already be published');
  assert.ok(Array.isArray(metadata.assets), 'Release assets are missing');
  for (const asset of [EDITOR_RELEASE.dmg, EDITOR_RELEASE.checksums]) {
    const matches = metadata.assets.filter(item => item.name === asset.name);
    assert.equal(matches.length, 1, `Release must contain exactly one ${asset.name}`);
    const actual = matches[0];
    assert.equal(actual.id, asset.id, `${asset.name} was replaced`);
    assert.equal(actual.size, asset.size, `${asset.name} size changed`);
    assert.equal(actual.digest, `sha256:${asset.sha256}`, `${asset.name} published digest changed`);
    assert.equal(actual.browser_download_url, `https://github.com/${EDITOR_RELEASE.repository}/releases/download/${EDITOR_RELEASE.tag}/${asset.name}`, 'Unexpected release download location');
  }
  return metadata;
}

export function publishedEditorChecksum(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024, 'Published checksums must be bounded text');
  const checksums = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    assert.ok(match, 'Malformed published checksum entry');
    assert.ok(!checksums.has(match[2]), 'Duplicate published checksum entry');
    checksums.set(match[2], match[1]);
  }
  assert.equal(checksums.get(EDITOR_RELEASE.dmg.name), EDITOR_RELEASE.dmg.sha256, 'Published ARM checksum does not match the pinned release');
  return checksums.get(EDITOR_RELEASE.dmg.name);
}

export function verifyEditorReleaseAsset(path, asset) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Downloaded asset must be a regular file');
  assert.equal(stat.size, asset.size, `${asset.name} downloaded size differs`);
  const sha256 = sha256File(path);
  assert.equal(sha256, asset.sha256, `${asset.name} downloaded SHA256 differs`);
  return { name: asset.name, bytes: stat.size, sha256 };
}

/** Verify each engine independently, then copy only the five verified files. */
export function reuseInstalledEditors(resourceRoot, { root = ROOT, copy = copyFileSync, rename = renameSync } = {}) {
  const canonicalRoot = realpathSync(root), publicDirectory = join(canonicalRoot, 'public');
  mkdirSync(publicDirectory, { recursive: true });
  assert.equal(realpathSync(publicDirectory), publicDirectory, 'public must not redirect outside the checkout');
  const results = {};
  for (const [engine, inspect] of Object.entries(INSPECTORS)) {
    let stage, retainPrevious = false;
    try {
      const source = inspect(resourceRoot, { root: canonicalRoot });
      const sourceDirectory = join(resourceRoot, 'frontend', engine);
      for (const name of expectedFiles(engine)) assert.ok(lstatSync(join(sourceDirectory, name)).isFile(), 'Editor resources must not be symbolic links');
      // Stage beside public for rename promotion. Retained backups must stay
      // outside public: Vite copies hidden public files into the application.
      stage = mkdtempSync(join(canonicalRoot, '.release-editor-'));
      assert.equal(lstatSync(stage).dev, lstatSync(publicDirectory).dev, 'Editor staging and public must share a filesystem for rename promotion');
      const stagedDirectory = join(stage, 'frontend', engine);
      mkdirSync(stagedDirectory, { recursive: true });
      for (const name of expectedFiles(engine)) copy(join(sourceDirectory, name), join(stagedDirectory, name));
      const staged = inspect(stage, { root: canonicalRoot });
      assert.deepEqual(staged, source, 'Copied editor resources changed before promotion');
      const destination = join(publicDirectory, engine), previous = join(stage, 'previous');
      let hasPrevious = false;
      if (existsSync(destination)) {
        assert.ok(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink(), 'Existing editor directory must not be a symbolic link');
        rename(destination, previous);
        hasPrevious = true;
      }
      try { rename(stagedDirectory, destination); }
      catch (error) {
        if (hasPrevious) {
          try { rename(previous, destination); }
          catch (restoreError) {
            retainPrevious = true;
            throw new AggregateError([error, restoreError], 'Editor promotion and rollback failed; previous files retained in staging');
          }
        }
        throw error;
      }
      results[engine] = { status: 'reused', sourceHash: JSON.parse(source.manifestText).sourceHash,
        manifestSha256: source.manifestSha256, files: source.files };
    } catch (error) {
      results[engine] = { status: 'fallback', reason: failure(error) };
    } finally {
      if (stage && retainPrevious) results[engine].retainedDirectory = stage;
      else if (stage) {
        try { rmSync(stage, { recursive: true, force: true }); }
        catch (error) { results[engine].cleanupError = failure(error); }
      }
    }
  }
  return results;
}

function command(program, args, timeout = 60_000) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  // Do not retain potentially credential-bearing CLI diagnostics or signed URLs.
  assert.ok(!result.error && result.status === 0 && !result.signal,
    `${program} failed (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}, error ${result.error?.code ?? 'none'})`);
  return result.stdout;
}

export function runEditorReleaseReuse({ root = ROOT, temporaryRoot = process.env.RUNNER_TEMP || tmpdir(), platform = process.platform,
  arch = process.arch, execute = command, verifyAsset = verifyEditorReleaseAsset } = {}) {
  const report = { schemaVersion: 1, kind: 'diagnostic-editor-resource-reuse', diagnosticOnly: true, releaseAcceptance: false,
    checkoutCommit: process.env.GITHUB_SHA ?? null, sourceRelease: EDITOR_RELEASE,
    status: 'fallback', engines: Object.fromEntries(Object.keys(INSPECTORS).map(engine => [engine, { status: 'fallback', reason: 'Release resources were not verified' }])),
    cleanup: { detachAttempted: false, detached: false, removedTemporaryDirectory: false } };
  const reportDirectory = join(root, 'artifacts', 'macos-editing');
  mkdirSync(reportDirectory, { recursive: true });
  let temporary, mount, attachAttempted = false;
  try {
    assert.equal(platform, 'darwin', 'Release resource reuse requires macOS for a read-only DMG mount');
    assert.equal(arch, 'arm64', 'This diagnostic reuses the fixed ARM release only');
    const metadata = validateEditorRelease(JSON.parse(execute('gh', ['api', `repos/${EDITOR_RELEASE.repository}/releases/tags/${EDITOR_RELEASE.tag}`])));
    temporary = mkdtempSync(join(temporaryRoot, 'open-office-release-editors-'));
    const download = asset => execute('gh', ['release', 'download', EDITOR_RELEASE.tag, '--repo', EDITOR_RELEASE.repository,
      '--pattern', asset.name, '--dir', temporary], 180_000);
    download(EDITOR_RELEASE.checksums);
    report.checksums = verifyAsset(join(temporary, EDITOR_RELEASE.checksums.name), EDITOR_RELEASE.checksums);
    report.publishedDmgSha256 = publishedEditorChecksum(readFileSync(join(temporary, EDITOR_RELEASE.checksums.name), 'utf8'));
    download(EDITOR_RELEASE.dmg);
    const dmg = join(temporary, EDITOR_RELEASE.dmg.name);
    report.dmg = verifyAsset(dmg, EDITOR_RELEASE.dmg);
    report.releaseId = metadata.id;
    execute('/usr/bin/hdiutil', ['verify', dmg]);
    mount = join(temporary, 'mount');
    mkdirSync(mount);
    attachAttempted = true;
    execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    report.readonlyMount = true;
    assert.deepEqual(readdirSync(mount).filter(name => name.endsWith('.app')), ['Open Office.app'], 'Unexpected application inventory in release DMG');
    report.engines = reuseInstalledEditors(join(mount, 'Open Office.app', 'Contents', 'Resources'), { root });
    const reused = Object.values(report.engines).filter(engine => engine.status === 'reused').length;
    report.status = reused === 3 ? 'reused' : reused ? 'partially-reused' : 'fallback';
  } catch (error) {
    report.reason = failure(error);
  } finally {
    if (attachAttempted) {
      report.cleanup.detachAttempted = true;
      try { execute('/usr/bin/hdiutil', ['detach', mount], 30_000); report.cleanup.detached = true; }
      catch (error) { report.cleanup.detachError = failure(error); }
    }
    // Never recursively remove a possibly mounted image after a failed detach.
    if (temporary && (!attachAttempted || report.cleanup.detached)) {
      try { rmSync(temporary, { recursive: true, force: true }); report.cleanup.removedTemporaryDirectory = true; }
      catch (error) { report.cleanup.removeError = failure(error); }
    }
    if (temporary && !report.cleanup.removedTemporaryDirectory) report.cleanup.retainedDirectory = temporary;
    writeFileSync(join(reportDirectory, 'reused-editor-resources.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Release resource reuse has no release or checksum overrides');
  const report = runEditorReleaseReuse();
  console.log(`Editor release reuse: ${report.status}. The normal build and resource checks still run.`);
  for (const [engine, result] of Object.entries(report.engines)) console.log(`${engine}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  if (report.reason) console.log(`Fallback reason: ${report.reason}`);
}
