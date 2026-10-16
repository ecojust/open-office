import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locateApplication } from '../scripts/native-smoke.mjs';

for (const os of ['darwin', 'win32']) {
  test(`${os} installed layout accepts current editors without the retired Office host`, t => {
    const root = mkdtempSync(join(tmpdir(), 'office-layout-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const app = join(root, 'Open Office.app');
    const resourceRoot = os === 'darwin' ? join(app, 'Contents', 'Resources') : join(root, 'installed');
    const executable = os === 'darwin' ? join(app, 'Contents', 'MacOS', 'open-office') : join(resourceRoot, 'open-office.exe');
    const pdfFiles = ['office_pdf.js', 'office_pdf_bg.wasm', 'manifest.json'].map(name => join(resourceRoot, 'frontend/office-pdf', name));
    const index = join(resourceRoot, 'frontend', 'index.html');
    for (const path of [executable, ...pdfFiles, index]) {
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture');
    }
    const locate = () => locateApplication({ os }, os === 'darwin' ? { app } : {}, { OPEN_OFFICE_INSTALLED_APP: resourceRoot }, root);
    const located = locate();
    assert.equal(located.executable, realpathSync(executable));
    assert.equal(located.resourceRoot, realpathSync(resourceRoot));
    // All four editor manifests and their source/content hashes are checked
    // by the installed-editor inspectors after this layout check.
    for (const path of [index, ...pdfFiles]) {
      rmSync(path); assert.throws(locate); writeFileSync(path, 'fixture');
    }
    assert.equal(located.pdfDirectory, join(realpathSync(resourceRoot), 'frontend/office-pdf'));
    assert.equal('pdfExecutable' in located, false);
  });
}
