import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendRoot, runtimeRoot, executableName, venvPython, projectRoot, nativeTarget, preparePython, requireMatchingPython, run, sourceHashes, runtimeInventory, verifyEngine, pyinstallerVersion, main } from './pdf-backend-tools.mjs';
import { MAC_SIGNATURE_FORMAT, sealMacRuntime } from './seal-macos-pdf-runtime.mjs';

main(() => {
  const host = nativeTarget(), args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--target' && args[1] === host), 'PDF backend can only be frozen for the current native Rust host');
  const python = preparePython();
  requireMatchingPython(python, host);
  const sources = sourceHashes(), work = join(backendRoot, 'build', host);
  mkdirSync(work, { recursive: true });
  run(venvPython, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'open-office-pdf',
    '--collect-all', 'pymupdf', '--paths', backendRoot,
    '--distpath', join(work, 'dist'), '--workpath', join(work, 'work'), '--specpath', work, join(backendRoot, 'engine.py')]);
  const stagingRoot = mkdtempSync(join(projectRoot, 'src-tauri', 'pdf-runtime-stage-'));
  const staging = join(stagingRoot, 'payload'), backup = join(stagingRoot, 'previous');
  let moved = false;
  try {
    cpSync(join(work, 'dist', 'open-office-pdf'), staging, { recursive: true, verbatimSymlinks: true });
    const signatures = sealMacRuntime(staging, host);
    const binary = join(staging, executableName);
    const info = verifyEngine(binary), selfTest = verifyEngine(binary, [], true);
    assert.deepEqual(sourceHashes(), sources, 'PDF source changed during the build');
    const runtime = runtimeInventory(staging);
    const manifest = { format: 'onedir', generatedAt: new Date().toISOString(), target: host, python,
      pyinstaller: pyinstallerVersion, info, selfTest, sources, runtime,
      macSignatureFormat: process.platform === 'darwin' ? MAC_SIGNATURE_FORMAT : null, macSignatures: signatures };
    if (existsSync(runtimeRoot)) { renameSync(runtimeRoot, backup); moved = true; }
    try { renameSync(staging, runtimeRoot); }
    catch (error) { if (moved) { renameSync(backup, runtimeRoot); moved = false; } throw error; }
    writeFileSync(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`PDF runtime ready: ${runtimeRoot}\n${runtime.fileCount} files; SHA-256 ${runtime.sha256}`);
  } finally {
    if (moved && !existsSync(runtimeRoot) && existsSync(backup)) renameSync(backup, runtimeRoot);
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});
