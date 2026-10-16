import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const CATEGORIES = new Set(['assertion', 'linker', 'compiler', 'timeout', 'unknown']);
// These are public, checked-in test labels, not arbitrary text from a job log.
// No control characters, URLs, backslashes, markup or escaped source literals.
const SAFE_TEST_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ ,.'()\/;-]{0,239}$/;

export function validateFailedJob(job, runId, jobId) {
  assert.match(runId, /^[0-9]+$/);
  assert.match(jobId, /^[0-9]+$/);
  assert.equal(String(job.id), jobId, 'The API returned a different job');
  assert.equal(String(job.run_id), runId, 'The job does not belong to the requested run');
  assert.equal(job.status, 'completed', 'Only completed jobs can be inspected');
  assert.ok(['failure', 'timed_out'].includes(job.conclusion), 'Only failed jobs can be inspected');
  assert.ok(job.steps?.some(step => ['failure', 'timed_out'].includes(step.conclusion)), 'No failed step exists');
}

export function knownRustTests(root = 'src-tauri/src') {
  const names = new Set();
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.rs')) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/#\[(?:test|tokio::test(?:\([^\]]*\))?)\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) names.add(match[1]);
      }
    }
  };
  visit(root); return names;
}

export function knownNodeTests(root = 'tests') {
  const names = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue;
    const source = readFileSync(join(root, entry.name), 'utf8');
    // Skip comments and quoted/template strings rather than importing tests or
    // evaluating titles. Only direct, line-start test('literal', ...) calls are
    // admitted. Interpolation, concatenation and escaped literals are omitted.
    const declarations = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|`(?:\\[\s\S]|[^`\\])*`|^[ \t]*test(?:\.(?:only|skip|todo))?\s*\(\s*(?:'([^'\\\r\n]*)'|"([^"\\\r\n]*)")\s*,|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/gm;
    for (const match of source.matchAll(declarations)) {
      const title = match[1] ?? match[2];
      if (typeof title === 'string' && SAFE_TEST_NAME.test(title)) names.add(title);
    }
  }
  return names;
}

export function knownRepositoryTests() {
  // Enumerate source roots explicitly: never scan vendored build output or target/.
  const rustRoots = ['src-tauri/src', 'vendor/office-word/crates/ui-egui/src', 'vendor/office-word/crates/engine/src',
    'vendor/office-sheet/apps/open-office-host/src', 'vendor/office-sheet/crates/ui-egui/src', 'vendor/office-sheet/crates/pdf/src',
    'vendor/office-presentation/apps/open-office-host/src', 'vendor/office-presentation/crates/ui-egui/src', 'vendor/office-presentation/crates/pptx/src', 'vendor/office-presentation/crates/pdf/src'];
  return new Set([...rustRoots.flatMap(root => [...knownRustTests(root)]), ...knownNodeTests()]);
}

export function sanitizeFailureLog(log, knownTests) {
  const clean = log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const failed = new Set();
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z[ \t]+/, '');
    const match = line.match(/^\s*test\s+(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)\s+\.\.\.\s+FAILED\s*$/);
    const tap = line.match(/^\s*not ok\s+[0-9]+\s+-\s+(.+?)\s*$/);
    const spec = line.match(/^\s*✖\s+(.+?)(?:\s+\([0-9]+(?:\.[0-9]+)?ms\))?\s*$/);
    for (const name of [match?.[1], tap?.[1], spec?.[1]]) {
      if (typeof name === 'string' && SAFE_TEST_NAME.test(name) && knownTests.has(name)) failed.add(name);
    }
  }
  const rustErrorCodes = [...new Set([...clean.matchAll(/\berror\[(E[0-9]{4})\]/g)].map(match => match[1]))].sort();
  const typescriptErrorCodes = [...new Set([...clean.matchAll(/\berror\s+(TS[0-9]{4}):/g)].map(match => match[1]))].sort();
  const categories = [];
  if (/assertion[^\r\n]{0,80}failed|\b(?:ERR_ASSERTION|AssertionError)\b/.test(clean)) categories.push('assertion');
  if (/linking with[^\r\n]{0,150}failed|linker command failed/.test(clean)) categories.push('linker');
  if (rustErrorCodes.length || typescriptErrorCodes.length || /error: could not compile/.test(clean)) categories.push('compiler');
  if (/\b(?:timed out|timeout|time limit exceeded)\b/i.test(clean)) categories.push('timeout');
  if (!categories.length) categories.push('unknown');
  return { failedTestNames: [...failed].sort(), rustErrorCodes, typescriptErrorCodes, categories };
}

export function validatePublicSummary(report, knownTests) {
  assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'runId', 'jobId', 'failedTestNames', 'rustErrorCodes', 'typescriptErrorCodes', 'categories'].sort());
  assert.equal(report.schemaVersion, 3);
  assert.match(report.runId, /^[0-9]+$/); assert.match(report.jobId, /^[0-9]+$/);
  assert.ok(Array.isArray(report.failedTestNames) && report.failedTestNames.length <= knownTests.size);
  for (const name of report.failedTestNames) assert.ok(typeof name === 'string' && SAFE_TEST_NAME.test(name) && knownTests.has(name));
  assert.ok(Array.isArray(report.rustErrorCodes) && report.rustErrorCodes.length <= 10000);
  for (const code of report.rustErrorCodes) assert.ok(typeof code === 'string' && /^E[0-9]{4}$/.test(code));
  assert.ok(Array.isArray(report.typescriptErrorCodes) && report.typescriptErrorCodes.length <= 10000);
  for (const code of report.typescriptErrorCodes) assert.ok(typeof code === 'string' && /^TS[0-9]{4}$/.test(code));
  assert.ok(Array.isArray(report.categories) && report.categories.length > 0 && report.categories.length <= CATEGORIES.size);
  for (const category of report.categories) assert.ok(CATEGORIES.has(category));
  return report;
}

async function boundedText(response) {
  assert.ok(response.ok, `Log download failed with HTTP ${response.status}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= MAX_LOG_BYTES, 'The job log exceeds the 16 MiB diagnostic limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readFailedJobLog(env = process.env, fetcher = fetch, knownTests = knownRepositoryTests()) {
  const runId = env.SOURCE_RUN_ID || ''; const jobId = env.SOURCE_JOB_ID || '';
  const repository = env.SOURCE_REPOSITORY || '';
  assert.match(runId, /^[0-9]+$/); assert.match(jobId, /^[0-9]+$/);
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(env.GH_TOKEN, 'The read-only workflow token is required');
  const root = `https://api.github.com/repos/${repository}/actions/jobs/${jobId}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Open-Office-read-only-diagnostics' };
  const response = await fetcher(root, { headers, signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `Job metadata request failed with HTTP ${response.status}`);
  const job = await response.json(); validateFailedJob(job, runId, jobId);
  let download = await fetcher(`${root}/logs`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if ([301, 302, 303, 307, 308].includes(download.status)) {
    const location = new URL(download.headers.get('location'));
    assert.equal(location.protocol, 'https:');
    assert.ok(location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com'),
      'Unexpected log storage host');
    // Never forward the GitHub token to the signed storage URL or print that URL.
    download = await fetcher(location, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  }
  const log = await boundedText(download);
  // Raw log bytes stay in this process only. No excerpts, panic values, paths,
  // arbitrary messages, URLs, hashes, or encoded log payloads leave this scope.
  return validatePublicSummary({ schemaVersion: 3, runId, jobId, ...sanitizeFailureLog(log, knownTests) }, knownTests);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await readFailedJobLog();
    console.log(`::notice title=failed-job-${report.jobId}-safe-summary::${JSON.stringify(report)}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Failed job allowlisted summary\n\n<pre>${JSON.stringify(report, null, 2)}</pre>\n`);
  } catch {
    // An assertion can itself contain actual values: never print exception text.
    console.error('Unable to produce the allowlisted failed-job summary.'); process.exitCode = 1;
  }
}
