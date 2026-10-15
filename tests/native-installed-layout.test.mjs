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
    const pdfExecutable = join(resourceRoot, 'pdf-runtime', os === 'darwin' ? 'open-office-pdf' : 'open-office-pdf.exe');
    const index = join(resourceRoot, 'frontend', 'index.html');
    for (const path of [executable, pdfExecutable, index]) {
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture');
    }
    const dependencies = join(resourceRoot, 'pdf-runtime', '_internal');
    mkdirSync(dependencies);
    const locate = () => locateApplication({ os }, os === 'darwin' ? { app } : {}, { OPEN_OFFICE_INSTALLED_APP: resourceRoot }, root);
    const located = locate();
    assert.equal(located.executable, realpathSync(executable));
    assert.equal(located.resourceRoot, realpathSync(resourceRoot));
    // The three editor manifests and their source/content hashes are checked
    // by inspectInstalled{Wordcraft,Gridcraft,Deckcraft} after this layout check.
    for (const path of [index, pdfExecutable]) {
      rmSync(path); assert.throws(locate); writeFileSync(path, 'fixture');
    }
    rmSync(dependencies, { recursive: true });
    assert.throws(locate);
  });
}
