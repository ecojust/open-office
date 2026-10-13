import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knownRustTests, knownNodeTests, knownRepositoryTests, sanitizeFailureLog, validateFailedJob, validatePublicSummary, readFailedJobLog } from '../scripts/read-failed-job-log.mjs';

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
  const report = { schemaVersion: 3, runId: '123', jobId: '456', ...sanitizeFailureLog(log, known) };
  validatePublicSummary(report, known);
  assert.deepEqual(report.failedTestNames, [...known]);
  assert.deepEqual(report.rustErrorCodes, ['E0308']);
  assert.deepEqual(report.categories, ['assertion', 'compiler']);
  const serialized = JSON.stringify(report);
  for (const disallowed of [secret, '/Users', 'https:', 'panicked', 'left', 'right', 'unrecognized-error', Buffer.from(secret).toString('base64')]) assert.ok(!serialized.includes(disallowed));
  assert.deepEqual(sanitizeFailureLog(`arbitrary failure ${secret}`, known), { failedTestNames: [], rustErrorCodes: [], typescriptErrorCodes: [], categories: ['unknown'] });
});

test('public schema rejects arbitrary fields, unknown names, and injected error codes/categories', () => {
  const clean = { schemaVersion: 3, runId: '123', jobId: '456', ...sanitizeFailureLog(log, known) };
  for (const mutation of [{ excerpt: secret }, { message: secret }, { failedTestNames: [secret] }, { rustErrorCodes: [`E0308 ${secret}`] }, { typescriptErrorCodes: [`TS2322 ${secret}`] }, { categories: [secret] }, { runId: secret }]) assert.throws(() => validatePublicSummary({ ...clean, ...mutation }, known));
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

test('Node allowlist reads only bounded static test declarations without executing source', t => {
  const directory = mkdtempSync(join(tmpdir(), 'office-safe-tests-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = [
    "throw Error('This module must never execute');",
    "test('A known static test', () => {});",
    'test("Another known test", () => {});',
    "  test.only('A static focused test', () => {});",
    "test('Concatenated title' + secret, () => {});",
    'test(`An interpolated ${secret} title`, () => {});',
    "test('An escaped \\u0074itle', () => {});",
    "// test('A line commented test', () => {});",
    "/*\ntest('A block commented test', () => {});\n*/",
    "const fixture = `\ntest('A template fixture test', () => {});\n`;",
    "test('https://private.invalid/value', () => {});",
    "test('/Users/private/value', () => {});",
    "test('A title with <markup>', () => {});",
    "test('A title with %0Acontrol', () => {});",
    "test('A title with \u202econtrol', () => {});",
    `test('${'a'.repeat(241)}', () => {});`,
  ].join('\n');
  writeFileSync(join(directory, 'fixture.test.mjs'), source);
  writeFileSync(join(directory, 'ignored.mjs'), "test('An unrelated script', () => {});");
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'ignored.test.mjs'), "test('A nested file', () => {});");
  assert.deepEqual([...knownNodeTests(directory)].sort(), ['A known static test', 'A static focused test', 'Another known test']);
});

test('Node TAP and spec failures and TypeScript codes expose only exact public identifiers', () => {
  const title = 'the redistributed bridge remains pinned with its upstream copyright and modification notice';
  const other = 'Node TAP and spec failures and TypeScript codes expose only exact public identifiers';
  const allowlist = knownRepositoryTests();
  assert.ok(knownNodeTests().has(title));
  assert.ok(allowlist.has(other));
  assert.ok(allowlist.has([...known][0]));
  const raw = [
    `2026-10-13T01:01:00.000Z not ok 12 - ${title}`,
    `2026-10-13T01:01:00.001Z \u001b[31m✖ ${other} (2.413ms)\u001b[39m`,
    `✖ ${title} (0.7ms)`,
    `C:\\private\\${secret}.vue(3,9): error TS2322: ${secret}`,
    `/Users/private/${secret}.ts(9,4): error TS2345: ${secret}`,
    `error TS2322: https://private.invalid/?secret=${secret}`,
    `  code: 'ERR_ASSERTION'`,
    `  actual: ${secret}`,
  ].join('\n');
  const report = { schemaVersion: 3, runId: '123', jobId: '456', ...sanitizeFailureLog(raw, allowlist) };
  validatePublicSummary(report, allowlist);
  assert.deepEqual(report.failedTestNames, [other, title].sort());
  assert.deepEqual(report.typescriptErrorCodes, ['TS2322', 'TS2345']);
  assert.deepEqual(report.categories, ['assertion', 'compiler']);
  for (const disallowed of [secret, 'private', '.vue', '.ts', 'https:', 'actual', '2.413', '\u001b']) assert.ok(!JSON.stringify(report).includes(disallowed));
});

test('Forged failure lines cannot disclose suffixes paths assertion values or encoded payloads', () => {
  const title = 'the redistributed bridge remains pinned with its upstream copyright and modification notice';
  const encoded = Buffer.from(secret).toString('base64');
  const allowlist = knownNodeTests();
  const raw = [
    `not ok 1 - ${secret}`,
    `not ok 2 - ${encoded}`,
    `not ok 3 - ${title} ${secret}`,
    `✖ ${title} (1.5ms) ${secret}`,
    `✖ C:\\private\\${secret}.test.mjs:12:4`,
    `not ok 4 - /Users/private/${secret}`,
    `not ok 5 - https://private.invalid/${secret}`,
    `not ok 6 - ${title}\u202e${secret}`,
    `error TS12345: ${secret}`,
    `TS2322 ${secret}`,
    `actual: '${secret}', expected: '${encoded}'`,
    `actual: not ok 8 - ${title}`,
    `# not ok 9 - ${title}`,
    `assertion text ✖ ${title}`,
    `ok 7 - ${title}`,
    `# Subtest: ${title}`,
  ].join('\n');
  assert.deepEqual(sanitizeFailureLog(raw, allowlist), { failedTestNames: [], rustErrorCodes: [], typescriptErrorCodes: [], categories: ['unknown'] });
  const report = { schemaVersion: 3, runId: '123', jobId: '456', ...sanitizeFailureLog('', allowlist) };
  for (const unsafe of [`https://private.invalid/${secret}`, `name\n${secret}`, 'a'.repeat(241), `<${secret}>`, `${title}\u202e`]) {
    assert.throws(() => validatePublicSummary({ ...report, failedTestNames: [unsafe] }, new Set([unsafe])));
  }
});
