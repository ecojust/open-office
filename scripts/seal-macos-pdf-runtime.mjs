import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { capture } from './pdf-backend-tools.mjs';

export const MAC_SIGNATURE_FORMAT = 1;

function macho(file) {
  const fd = openSync(file, 'r'), magic = Buffer.alloc(4);
  try {
    return readSync(fd, magic, 0, 4, 0) === 4
      && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE());
  } finally { closeSync(fd); }
}

/** Seal frameworks before recording the runtime hash; never apply hardened
 * runtime recursively to a Python interpreter that loads native extensions. */
export function sealMacRuntime(directory, target) {
  if (process.platform !== 'darwin') return null;
  const root = realpathSync(resolve(directory)), frameworks = [], binaries = [];
  const arch = target.startsWith('aarch64-') ? 'arm64' : 'x86_64';
  const contained = file => {
    const actual = realpathSync(file);
    assert.ok(actual.startsWith(`${root}${sep}`), `PDF runtime symlink escaped its directory: ${file}`);
    return actual;
  };
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) { contained(file); continue; }
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.framework')) frameworks.push(file);
        collect(file);
      } else if (entry.isFile() && macho(file)) {
        const description = capture('/usr/bin/file', ['-b', file]);
        assert.ok(new RegExp(`\\b${arch}\\b`).test(description), `Wrong native PDF library architecture: ${file}: ${description}`);
        binaries.push(file);
      }
    }
  }
  collect(root);
  const executable = contained(join(root, 'open-office-pdf'));
  assert.ok(binaries.includes(executable), 'Missing native PDF executable');
  const records = [];
  frameworks.sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const framework of frameworks) {
    const name = basename(framework, '.framework');
    const info = contained(existsSync(join(framework, 'Resources', 'Info.plist')) ? join(framework, 'Resources', 'Info.plist') : join(framework, 'Info.plist'));
    assert.equal(capture('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info]), name);
    assert.equal(capture('/usr/bin/plutil', ['-extract', 'CFBundlePackageType', 'raw', '-o', '-', info]), 'FMWK');
    assert.ok(binaries.includes(contained(join(framework, name))));
    capture('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', framework]);
    capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', framework]);
    records.push(relative(root, framework).replaceAll('\\', '/'));
  }
  for (const binary of binaries) capture('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary]);
  capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', executable]);
  return { format: MAC_SIGNATURE_FORMAT, kind: 'ad-hoc', developerIdSigned: false, notarized: false,
    strictVerification: true, architecture: arch, nativeObjectCount: binaries.length, frameworks: records };
}
