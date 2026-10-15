import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'ecojust/open-office';
const WORKFLOW_PATH = '.github/workflows/desktop-release.yml';
const PLATFORMS = ['windows-x64', 'macos-arm64', 'macos-x64'];
const EDITING_PROOF_ARTIFACT = 'open-office-macos26-editing-proof';
const REQUIRED_JOBS = [
  'Validate requested platforms',
  ...PLATFORMS.map(platform => `${platform} native build and verification`),
  'Unchanged Intel DMG / Rosetta real GUI round trip',
  'Unchanged ARM DMG / macOS 26 real input editing',
];

function positiveInteger(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

function timestamp(value, label) {
  assert.equal(typeof value, 'string', `${label} must be an ISO UTC timestamp`);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, `${label} must be an ISO UTC timestamp`);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} is invalid`);
  assert.equal(new Date(parsed).toISOString(), value.includes('.') ? value : value.replace('Z', '.000Z'), `${label} is invalid`);
  return parsed;
}

function completeList(envelope, key) {
  assert.ok(envelope && typeof envelope === 'object' && !Array.isArray(envelope), `${key} must include the API total_count`);
  assert.ok(Array.isArray(envelope[key]), `${key} must be an array`);
  assert.ok(Number.isSafeInteger(envelope.total_count) && envelope.total_count >= 0, `${key} total_count is invalid`);
  assert.equal(envelope[key].length, envelope.total_count, `${key} list is incomplete; retrieve every page`);
  const ids = new Set();
  for (const item of envelope[key]) {
    assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${key} entry is invalid`);
    const id = positiveInteger(item.id, `${key} id`);
    assert.ok(!ids.has(id), `${key} contains a duplicate id`);
    ids.add(id);
  }
  return envelope[key];
}

/**
 * Select metadata only; this does not verify installer bytes or native reports.
 * Fetch jobs with filter=latest and supply complete, unmodified API envelopes.
 * Callers must download these exact IDs, then run the source commit's complete
 * native report, package, signature and digest validators before publishing.
 * The current macOS editing validator must also verify the unchanged ARM DMG
 * and the exact source checkout; historical builds cannot bypass this gate.
 * The explicit clock keeps selection deterministic and this function read-only.
 */
export function selectDesktopReleaseArtifacts({ run, jobs, artifacts, now, expectedRunId }) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Source run metadata is required');
  assert.equal(typeof expectedRunId, 'string', 'Expected source run ID must be a string');
  assert.match(expectedRunId, /^[1-9]\d*$/, 'Expected source run ID is invalid');
  const runId = positiveInteger(run.id, 'Source run ID');
  assert.equal(String(runId), expectedRunId, 'Source run ID does not match the requested run');
  assert.equal(run.repository?.full_name, REPOSITORY, 'Unexpected source repository');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Forked source runs are not eligible');
  const repositoryId = positiveInteger(run.repository.id, 'Source repository ID');
  assert.equal(run.head_repository.id, repositoryId, 'Source repository identity mismatch');
  assert.equal(run.path, WORKFLOW_PATH, 'Unexpected source workflow path');
  assert.equal(run.event, 'workflow_dispatch', 'Source must be a dispatched desktop release workflow');
  assert.equal(typeof run.head_sha, 'string', 'Source commit is required');
  assert.match(run.head_sha, /^[0-9a-f]{40}$/, 'Source commit must be a full SHA');
  const attempt = positiveInteger(run.run_attempt, 'Source run attempt');
  assert.equal(run.status, 'completed', 'Source workflow is still running');
  // A previous artifact merge can fail the publication job while all required
  // native checks pass. Never substitute the overall conclusion for each gate.
  assert.ok(['success', 'failure'].includes(run.conclusion), 'Source workflow did not finish normally');
  const observedAt = timestamp(now, 'Observation time');

  const latestJobs = completeList(jobs, 'jobs');
  const verifiedJobs = REQUIRED_JOBS.map(name => {
    const matches = latestJobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Expected one latest job: ${name}`);
    const job = matches[0];
    assert.equal(job.run_id, runId, `Job belongs to another run: ${name}`);
    assert.equal(job.head_sha, run.head_sha, `Job belongs to another commit: ${name}`);
    assert.ok(positiveInteger(job.run_attempt, `Job attempt: ${name}`) <= attempt, `Job attempt exceeds source run: ${name}`);
    assert.equal(job.status, 'completed', `Required job is incomplete: ${name}`);
    assert.equal(job.conclusion, 'success', `Required job did not succeed: ${name}`);
    return { id: job.id, name, runAttempt: job.run_attempt };
  });

  const allArtifacts = completeList(artifacts, 'artifacts');
  const requiredArtifacts = [
    ...PLATFORMS.map(platformId => ({ platformId, name: `open-office-native-${platformId}` })),
    { platformId: 'macos26-editing-proof', name: EDITING_PROOF_ARTIFACT },
  ];
  const selected = requiredArtifacts.map(({ platformId, name }) => {
    const candidates = [];
    for (const artifact of allArtifacts.filter(item => item.name === name)) {
      assert.equal(typeof artifact.expired, 'boolean', `Artifact expiry flag is missing: ${name}`);
      if (artifact.expired) continue;
      const created = timestamp(artifact.created_at, `Artifact creation time: ${name}`);
      const expires = timestamp(artifact.expires_at, `Artifact expiry time: ${name}`);
      assert.ok(created <= observedAt && expires > created, `Artifact timestamps are inconsistent: ${name}`);
      if (expires <= observedAt) continue;
      assert.equal(artifact.workflow_run?.id, runId, `Artifact belongs to another run: ${name}`);
      assert.equal(artifact.workflow_run.head_sha, run.head_sha, `Artifact belongs to another commit: ${name}`);
      assert.equal(artifact.workflow_run.repository_id, repositoryId, `Artifact repository mismatch: ${name}`);
      assert.equal(artifact.workflow_run.head_repository_id, repositoryId, `Artifact source repository mismatch: ${name}`);
      positiveInteger(artifact.size_in_bytes, `Artifact size: ${name}`);
      assert.equal(typeof artifact.digest, 'string', `Artifact digest is missing: ${name}`);
      assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/, `Artifact digest is invalid: ${name}`);
      candidates.push({ artifact, created });
    }
    assert.ok(candidates.length > 0, `No unexpired artifact: ${name}`);
    const newest = Math.max(...candidates.map(candidate => candidate.created));
    const winners = candidates.filter(candidate => candidate.created === newest);
    assert.equal(winners.length, 1, `Ambiguous latest artifact creation time: ${name}`);
    const { artifact } = winners[0];
    return { platformId, id: artifact.id, name, createdAt: artifact.created_at,
      expiresAt: artifact.expires_at, sizeInBytes: artifact.size_in_bytes, digest: artifact.digest };
  });

  return { schemaVersion: 1, repository: REPOSITORY, workflowPath: WORKFLOW_PATH,
    sourceRunId: String(runId), sourceRunAttempt: attempt, sourceCommit: run.head_sha,
    sourceRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    observedAt: now, artifactIds: selected.map(artifact => artifact.id), artifacts: selected,
    windowsArtifactId: selected[0].id, macosArmArtifactId: selected[1].id, macosIntelArtifactId: selected[2].id,
    macosEditingProofArtifactId: selected[3].id,
    verifiedJobs };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), values = new Map();
  const allowed = new Set(['--run', '--jobs', '--artifacts', '--run-id', '--now']);
  assert.equal(args.length, allowed.size * 2, 'Usage: node scripts/select-desktop-release-artifacts.mjs --run run.json --jobs jobs.json --artifacts artifacts.json --run-id ID --now ISO');
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(allowed.has(args[index]) && !values.has(args[index]), 'Unexpected or duplicate argument');
    values.set(args[index], args[index + 1]);
  }
  const read = key => JSON.parse(readFileSync(values.get(key), 'utf8'));
  const result = selectDesktopReleaseArtifacts({ run: read('--run'), jobs: read('--jobs'), artifacts: read('--artifacts'),
    expectedRunId: values.get('--run-id'), now: values.get('--now') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
