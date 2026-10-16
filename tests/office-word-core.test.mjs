import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { wordFixtureRoot as root, inspectOfficeWordFile, richContract } from './compatibility/office-word-core/run.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

  test('OfficeWord independent OOXML and native fixtures retain recorded hashes', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    for (const fixture of manifest.fixtures) for (const key of ['source', 'nativeDocx', 'nativePdf']) {
      if (fixture[key]) assert.equal(sha256(await readFile(path.join(root, fixture[key]))), fixture[key + 'Sha256']);
    }
    assert.equal(sha256(await readFile(path.join(root, manifest.image.path))), manifest.image.sha256);
  });
  test('Independent OOXML oracle verifies the authored rich source contract', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    richContract(inspectOfficeWordFile(path.join(root, 'independent-rich.docx')), manifest.image.sha256);
    richContract(inspectOfficeWordFile(path.join(root, 'native-docx/independent-rich.docx')), manifest.image.sha256);
  });
