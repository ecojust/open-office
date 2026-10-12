import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendRoot, runtimeRoot, executableName, projectRoot, nativeTarget, preparePython, requireMatchingPython, run, sourceHashes, runtimeInventory, verifyEngine, pyinstallerVersion, pymupdfVersion, main } from './pdf-backend-tools.mjs';
import { MAC_SIGNATURE_FORMAT } from './seal-macos-pdf-runtime.mjs';

main(() => {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--dev'), 'Usage: node scripts/ensure-pdf-backend.mjs [--dev]');
  const development = args[0] === '--dev';
  const host = nativeTarget();
  const manifestPath = join(backendRoot, 'build', host, 'manifest.json');
  const binary = join(runtimeRoot, executableName);
  if (!development && existsSync(manifestPath) && existsSync(binary)) {
    let current = false;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.format, 'onedir');
      assert.equal(manifest.target, host);
      assert.equal(manifest.pyinstaller, pyinstallerVersion);
      assert.equal(manifest.info.version, pymupdfVersion);
      assert.equal(manifest.selfTest.status, 'PASSED');
      assert.deepEqual(manifest.sources, sourceHashes());
      assert.equal(manifest.runtime.sha256, runtimeInventory(runtimeRoot).sha256);
      if (process.platform === 'darwin') {
        assert.equal(manifest.macSignatureFormat, MAC_SIGNATURE_FORMAT);
        assert.equal(manifest.macSignatures.strictVerification, true);
      }
      current = true;
    } catch { console.log('PDF source, native resources or packaging requirements changed; rebuilding the runtime.'); }
    if (current) {
      verifyEngine(binary);
      console.log('Using verified cached PDF runtime; no dependency download or freezing needed.');
      return;
    }
  }
  const python = preparePython();
  requireMatchingPython(python, host);
  if (development) {
    console.log('PDF development backend ready: project Python environment; no frozen runtime required.');
    return;
  }
  run(process.execPath, [join(projectRoot, 'scripts', 'build-pdf-backend.mjs')]);
  assert.ok(existsSync(binary), 'PDF build did not produce the expected native executable');
});
