import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDesktopReleaseArtifacts } from '../scripts/select-desktop-release-artifacts.mjs';

const SHA = '285fb831f2f9cd8ff04a0c37faa621f636aef3dc';
const REPOSITORY = { id: 1415958664, full_name: 'ecojust/open-office' };
function fixture() {
  const run = { id: 38672473631, repository: { ...REPOSITORY }, head_repository: { ...REPOSITORY },
    path: '.github/workflows/desktop-release.yml', event: 'workflow_dispatch', head_sha: SHA,
    run_attempt: 2, status: 'completed', conclusion: 'failure' };
  const names = ['Validate requested platforms', 'windows-x64 native build and verification',
    'macos-arm64 native build and verification', 'macos-x64 native build and verification',
    'Unchanged Intel DMG / Rosetta real GUI round trip', 'Publish only after all native platforms pass'];
  const jobs = { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, name,
    run_id: run.id, head_sha: SHA, run_attempt: index === 4 || index === 5 ? 2 : 1,
    status: 'completed', conclusion: index === 5 ? 'failure' : 'success' })) };
  const makeArtifact = (id, platform, created_at) => ({ id, name: `open-office-native-${platform}`,
    created_at, expires_at: '2026-10-29T03:00:00Z', expired: false, size_in_bytes: 200000000,
    digest: `sha256:${'a'.repeat(64)}`, workflow_run: { id: run.id, head_sha: SHA,
      repository_id: REPOSITORY.id, head_repository_id: REPOSITORY.id } });
  const artifacts = { total_count: 4, artifacts: [
    makeArtifact(11945000000, 'windows-x64', '2026-10-15T02:58:00Z'),
    makeArtifact(11945341205, 'macos-arm64', '2026-10-15T02:49:31Z'),
    makeArtifact(11945312994, 'macos-x64', '2026-10-15T03:01:20Z'),
    // A later upload can have a smaller artifact ID; IDs and API order are not clocks.
    makeArtifact(11945044082, 'macos-x64', '2026-10-15T03:07:07Z'),
  ] };
  return { run, jobs, artifacts, expectedRunId: String(run.id), now: '2026-10-15T03:20:00Z' };
}
function addArtifact(input, artifact) { input.artifacts.artifacts.push(artifact); input.artifacts.total_count++; }

test('selects exactly the three newest platform artifacts without changing earlier evidence', () => {
  const input = fixture(), before = structuredClone(input);
  const selected = selectDesktopReleaseArtifacts(input);
  assert.deepEqual(selected.artifactIds, [11945000000, 11945341205, 11945044082]);
  assert.equal(selected.macosIntelArtifactId, 11945044082);
  assert.equal(selected.sourceRunId, '38672473631'); assert.equal(selected.sourceCommit, SHA);
  assert.equal(selected.sourceRunAttempt, 2); assert.equal(selected.verifiedJobs.length, 5);
  assert.deepEqual(input, before, 'Selection must never remove or modify failed artifacts');
  input.artifacts.artifacts.reverse();
  assert.deepEqual(selectDesktopReleaseArtifacts(input), selected, 'API order must not affect selection');
});

test('rejects another run, repository, fork, workflow, trigger, commit or unfinished source', () => {
  for (const mutate of [
    x => { x.expectedRunId = '1'; }, x => { x.run.id = Number.MAX_SAFE_INTEGER + 1; },
    x => { x.run.repository.full_name = 'other/open-office'; },
    x => { x.run.head_repository.full_name = 'other/open-office'; },
    x => { x.run.head_repository.id++; }, x => { x.run.path = '.github/workflows/native-diagnostics.yml'; },
    x => { x.run.event = 'pull_request'; }, x => { x.run.head_sha = 'short'; },
    x => { x.run.status = 'in_progress'; }, x => { x.run.conclusion = 'cancelled'; },
    x => { x.run.run_attempt = 0; }, x => { x.now = '2026-02-30T00:00:00Z'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => selectDesktopReleaseArtifacts(input)); }
});

test('every native, Rosetta and plan gate must be present exactly once and successful', () => {
  for (let index = 0; index < 5; index++) {
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
      const input = fixture(); input.jobs.jobs[index].conclusion = conclusion;
      assert.throws(() => selectDesktopReleaseArtifacts(input), /Required job did not succeed/);
    }
    const missing = fixture(); missing.jobs.jobs.splice(index, 1); missing.jobs.total_count--;
    assert.throws(() => selectDesktopReleaseArtifacts(missing), /Expected one latest job/);
  }
  const duplicate = fixture(); duplicate.jobs.jobs.push({ ...duplicate.jobs.jobs[4], id: 100 }); duplicate.jobs.total_count++;
  assert.throws(() => selectDesktopReleaseArtifacts(duplicate), /Expected one latest job/);
});

test('job identity cannot come from another run, commit, or future attempt', () => {
  for (const patch of [{ run_id: 1 }, { head_sha: 'b'.repeat(40) }, { run_attempt: 3 }, { status: 'in_progress' }]) {
    const input = fixture(); Object.assign(input.jobs.jobs[4], patch);
    assert.throws(() => selectDesktopReleaseArtifacts(input));
  }
});

test('requires complete API pages and unique IDs before choosing a winner', () => {
  for (const key of ['jobs', 'artifacts']) {
    const input = fixture(); input[key].total_count++;
    assert.throws(() => selectDesktopReleaseArtifacts(input), /list is incomplete/);
    const duplicate = fixture(); duplicate[key][key][1].id = duplicate[key][key][0].id;
    assert.throws(() => selectDesktopReleaseArtifacts(duplicate), /duplicate id/);
  }
});

test('exact names exclude build-only and similarly named artifacts; missing platforms fail', () => {
  const input = fixture();
  addArtifact(input, { ...input.artifacts.artifacts[3], id: 99, name: 'open-office-build-macos-x64', created_at: '2026-10-15T03:19:00Z' });
  addArtifact(input, { ...input.artifacts.artifacts[3], id: 100, name: 'open-office-native-macos-x64-other', created_at: '2026-10-15T03:19:00Z' });
  assert.equal(selectDesktopReleaseArtifacts(input).macosIntelArtifactId, 11945044082);
  input.artifacts.artifacts[0].name += '-other';
  assert.throws(() => selectDesktopReleaseArtifacts(input), /No unexpired artifact/);
});

test('does not resolve equal newest creation times using IDs or response order', () => {
  const input = fixture(); input.artifacts.artifacts[2].created_at = input.artifacts.artifacts[3].created_at;
  assert.throws(() => selectDesktopReleaseArtifacts(input), /Ambiguous latest artifact creation time/);
});

test('both API expiry and explicit observation time exclude expired artifacts', () => {
  for (const patch of [{ expired: true }, { expires_at: '2026-10-15T03:20:00Z' }]) {
    const input = fixture(); Object.assign(input.artifacts.artifacts[3], patch);
    assert.equal(selectDesktopReleaseArtifacts(input).macosIntelArtifactId, 11945312994);
  }
  const input = fixture(); input.now = '2026-10-30T00:00:00Z';
  assert.throws(() => selectDesktopReleaseArtifacts(input), /No unexpired artifact/);
});

test('unexpired matching artifacts require source identity, a digest, size and valid times', () => {
  for (const mutate of [
    x => { x.workflow_run.id = 1; }, x => { x.workflow_run.head_sha = 'b'.repeat(40); },
    x => { x.workflow_run.repository_id++; }, x => { x.workflow_run.head_repository_id++; },
    x => { delete x.workflow_run; }, x => { delete x.expired; }, x => { x.digest = ''; },
    x => { x.size_in_bytes = 0; }, x => { x.created_at = '2026-02-30T00:00:00Z'; },
    x => { x.created_at = '2026-10-15T03:30:00Z'; }, x => { x.expires_at = x.created_at; },
  ]) { const input = fixture(); mutate(input.artifacts.artifacts[3]); assert.throws(() => selectDesktopReleaseArtifacts(input)); }
});
