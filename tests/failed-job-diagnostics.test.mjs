import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownRustTests, sanitizeFailureLog, validateFailedJob, validatePublicSummary, readFailedJobLog } from '../scripts/read-failed-job-log.mjs';

const known = new Set(['actual_server_has_isolation_headers_and_cannot_write']);
const secret = 'SECRET_TOKEN_ghp_sensitive_private_value';
const log = `2026-10-13T01:01:00Z test server::tests::actual_server_has_isolation_headers_and_cannot_write ... FAILED
test ${secret} ... FAILED
thread 'private' panicked at /Users/private/${secret}.rs:117: assertion left == right failed
  left: "${secret}"
  right: "https://storage.invalid/?sig=${secret}"
error[E0308]: ${secret}
unrecognized-error: ${secret}
##[error]${secret}`;

test('failure summary exposes only repository-known test names and fixed identifier schema', () => {
  const report = { schemaVersion: 2, runId: '123', jobId: '456', ...sanitizeFailureLog(log, known) };
  validatePublicSummary(report, known);
  assert.deepEqual(report.failedTestNames, [...known]);
  assert.deepEqual(report.rustErrorCodes, ['E0308']);
  assert.deepEqual(report.categories, ['assertion', 'compiler']);
  const serialized = JSON.stringify(report);
  for (const disallowed of [secret, '/Users', 'https:', 'panicked', 'left', 'right', 'unrecognized-error', Buffer.from(secret).toString('base64')]) assert.ok(!serialized.includes(disallowed));
  assert.deepEqual(sanitizeFailureLog(`arbitrary failure ${secret}`, known), { failedTestNames: [], rustErrorCodes: [], categories: ['unknown'] });
});

test('public schema rejects arbitrary fields, unknown names, and injected error codes/categories', () => {
  const clean = { schemaVersion: 2, runId: '123', jobId: '456', ...sanitizeFailureLog(log, known) };
  for (const mutation of [{ excerpt: secret }, { message: secret }, { failedTestNames: [secret] }, { rustErrorCodes: [`E0308 ${secret}`] }, { categories: [secret] }, { runId: secret }]) assert.throws(() => validatePublicSummary({ ...clean, ...mutation }, known));
  assert.ok(knownRustTests().has([...known][0]));
});

test('read-only job access verifies ownership and isolates storage token while returning sanitized data only', async () => {
  const job = { id: 456, run_id: 123, status: 'completed', conclusion: 'failure', name: secret, steps: [{ name: secret, conclusion: 'failure' }] };
  for (const changed of [{ run_id: 124 }, { id: 457 }, { status: 'in_progress' }, { conclusion: 'success' }, { steps: [] }]) assert.throws(() => validateFailedJob({ ...job, ...changed }, '123', '456'));
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return Response.json(job);
    if (requests.length === 2) return new Response(null, { status: 302, headers: { location: `https://logs.blob.core.windows.net/job?sig=${secret}` } });
    return new Response(log);
  };
  const result = await readFailedJobLog({ SOURCE_RUN_ID: '123', SOURCE_JOB_ID: '456', SOURCE_REPOSITORY: 'ecojust/open-office', GH_TOKEN: secret }, mockFetch, known);
  assert.equal(requests[2].options.headers, undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
  validatePublicSummary(result, known);
});
