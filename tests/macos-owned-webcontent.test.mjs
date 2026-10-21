import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOwnedWebContent, responsiblePid, webContentPids } from '../scripts/macos-owned-webcontent.mjs';

test('OS ownership parser accepts one exact numeric responsibility field only', () => {
  assert.equal(responsiblePid('responsible pid = 123\n'), 123);
  assert.equal(responsiblePid('  Responsible PID: 456\n'), 456);
  for (const value of ['parent pid = 123', 'responsible pid = 123 secret',
    'responsible pid = 123\nresponsible pid = 123', 'responsible pid = 1', 'responsible pid = 9999999999']) {
    assert.equal(responsiblePid(value), null);
  }
  assert.deepEqual(webContentPids(' 17 /System/Library/com.apple.WebKit.WebContent\n18 /Other/WebContent\n19 /System/com.apple.WebKit.GPU\n'), [17]);
});

test('only a WebContent process with verified app responsibility is observed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-office-owned-test-'));
  const calls = [], observed = [];
  const observer = observeOwnedWebContent({ appPid: 100, helper: '/tmp/fixed-observer', directory, platform: 'darwin',
    execute: async (program, args) => {
      calls.push({ program, args });
      if (program === '/bin/ps') return { stdout: '201 /System/com.apple.WebKit.WebContent\n202 /System/com.apple.WebKit.WebContent\n203 /System/com.apple.WebKit.WebContent\n' };
      return { stdout: args.at(-1) === '201' ? 'responsible pid = 100\n' : args.at(-1) === '202' ? 'responsible pid = 999\n' : 'unknown PRIVATE_TOKEN\n' };
    },
    observe: async ({ pid }) => {
      observed.push(pid); return { report: { registered: true }, stop: async () => {} };
    },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const report = await observer.stop();
    assert.deepEqual(observed, [201]); assert.equal(report.targets[0].responsiblePid, 100);
    assert.equal(report.unrelatedCount, 1); assert.equal(report.ownershipUnavailableCount, 1);
    assert(calls.filter(call => call.program === '/usr/bin/sudo').every(call => call.args.slice(0, 3).join(' ') === '-n /bin/launchctl procinfo'));
    assert(!readFileSync(join(directory, 'owned-webcontent.json'), 'utf8').includes('PRIVATE_TOKEN'));
  } finally { await observer.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('unavailable OS ownership never substitutes an arbitrary WebContent PID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-office-owned-test-'));
  let observed = false;
  const observer = observeOwnedWebContent({ appPid: 100, helper: '/tmp/fixed-observer', directory, platform: 'darwin',
    execute: async program => {
      if (program === '/bin/ps') return { stdout: '201 /System/com.apple.WebKit.WebContent\n' };
      throw new Error('not permitted PRIVATE_TOKEN');
    }, observe: async () => { observed = true; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const report = await observer.stop();
    assert.equal(observed, false); assert.equal(report.status, 'no-verified-owned-webcontent');
    assert.equal(report.ownershipUnavailableCount, 1);
    assert(!JSON.stringify(report).includes('PRIVATE_TOKEN'));
  } finally { await observer.stop(); rmSync(directory, { recursive: true, force: true }); }
});
