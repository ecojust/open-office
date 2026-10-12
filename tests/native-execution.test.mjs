import assert from 'node:assert/strict';
import test from 'node:test';
import { guiLaunchCommand, selectExecution, validateMacArchitectures, validateRosettaProbe } from '../scripts/native-smoke.mjs';

test('cross-architecture application checks require the explicit Rosetta opt-in', () => {
  for (const permission of [undefined, '', 'true', '0']) {
    assert.throws(() => selectExecution('macos-x64', 'x86_64-apple-darwin', 'darwin', 'arm64', permission), /only explicitly enabled/);
  }
  assert.deepEqual(selectExecution('macos-x64', 'x86_64-apple-darwin', 'darwin', 'arm64', '1'), {
    targetArch: 'x64', hostArch: 'arm64', executionMode: 'rosetta2',
  });
});

test('Rosetta opt-in cannot authorize another platform, reversed architecture or a false target', () => {
  assert.throws(() => selectExecution('windows-x64', 'x86_64-pc-windows-msvc', 'win32', 'arm64', '1'), /only explicitly enabled/);
  assert.throws(() => selectExecution('macos-arm64', 'aarch64-apple-darwin', 'darwin', 'x64', '1'), /only explicitly enabled/);
  assert.throws(() => selectExecution('macos-x64', 'x86_64-apple-darwin', 'linux', 'arm64', '1'), /matching operating system/);
  assert.throws(() => selectExecution('macos-x64', 'aarch64-apple-darwin', 'darwin', 'arm64', '1'), /does not match/);
  assert.equal(selectExecution('macos-arm64', 'aarch64-apple-darwin', 'darwin', 'arm64', '1').executionMode, 'native');
});

test('physical ARM, untranslated orchestration and translated x64 execution must all be observed', () => {
  const valid = { hardwareArm64: '1', nodeProcessTranslated: '0', x86ProbeTranslated: '1' };
  assert.equal(validateRosettaProbe(valid).verified, true);
  for (const field of Object.keys(valid)) {
    assert.throws(() => validateRosettaProbe({ ...valid, [field]: '' }));
    assert.throws(() => validateRosettaProbe({ ...valid, [field]: valid[field] === '1' ? '0' : '1' }));
  }
});

test('universal or ARM executables cannot silently substitute for the delivered Intel binaries', () => {
  assert.doesNotThrow(() => validateMacArchitectures(['x86_64'], ['x86_64'], 'x86_64'));
  assert.throws(() => validateMacArchitectures(['x86_64', 'arm64'], ['x86_64'], 'x86_64'));
  assert.throws(() => validateMacArchitectures(['x86_64'], ['arm64'], 'x86_64'));
  const executable = '/tmp/Original App.app/Contents/MacOS/open-office';
  assert.deepEqual(guiLaunchCommand(executable, 'rosetta2'), { command: '/usr/bin/arch', args: ['-x86_64', executable] });
});
