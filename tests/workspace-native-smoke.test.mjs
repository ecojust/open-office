import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { validateNativeWorkspaceReport, WORKSPACE_NATIVE_CHECKS, WORKSPACE_NATIVE_LIMITATIONS, WORKSPACE_SAVED_TEXT } from '../scripts/workspace-native-smoke.mjs';
import { workspaceDocx, workspaceReport } from './helpers/workspace-smoke-report.mjs';
import { wordDocx } from './helpers/office-word-smoke-fixture.mjs';

test('native Server/autosave evidence requires actual four-format bytes and independent file readback', () => {
  assert.deepEqual(validateNativeWorkspaceReport(workspaceReport()), {
    workspaceNativeServer: true, workspaceFourFormats: true, workspaceHttpConflictProtection: true,
    workspaceLocalAutosave: true, workspaceSavedFileReadback: true, workspaceStopRevocation: true,
  });
});

test('missing, browser-only, or shortened workspace acceptance cannot pass publication', () => {
  for (const invalid of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateNativeWorkspaceReport(invalid), /Native workspace/);
  for (const mutate of [
    r => { r.ok = false; }, r => { r.schemaVersion = 0; }, r => { r.transport = 'browser-fetch'; },
    r => { r.native.tauri = false; }, r => { r.native.origin = 'http://example.com:31415'; },
    r => { r.native.origin += '/token'; }, r => { r.checks.pop(); }, r => { r.checks.reverse(); },
    r => { r.limitations.pop(); }, r => { r.error = 'failed'; }, r => { r.cleanupError = 'failed'; },
    r => { delete r.server; }, r => { delete r.autosave; }, r => { delete r.cleanup; },
  ]) {
    const report = workspaceReport(); mutate(report);
    assert.throws(() => validateNativeWorkspaceReport(report), /Native workspace/);
  }
});

test('native HTTP acceptance binds IPC bytes, version advancement, real status codes and revocation', () => {
  const mutations = [
    r => { r.server.before.running = true; }, r => { r.server.started.running = false; },
    r => { r.server.status.revision = 1; }, r => { r.server.started.localUrl = 'http://127.0.0.1:1/token/'; },
    r => { r.server.formats.pop(); }, r => { r.server.formats.reverse(); },
    r => { r.server.formats[1].version = 2; }, r => { r.server.formats[1].sha256 = '0'.repeat(64); },
    r => { r.server.formats[2].base64 += '\n'; }, r => { r.server.formats[3].sizeBytes++; },
    r => { r.server.http.execution = 'mock'; }, r => { r.server.http.documentId = 'another-document'; },
    r => { r.server.http.acceptedVersion = r.server.http.initialVersion; },
    r => { r.server.http.acceptedSha256 = r.server.http.initialSha256; },
    r => { r.server.http.initialSha256 = 'a'.repeat(64); },
    r => { r.server.http.rangeBytes = 7; }, r => { delete r.server.http.indexSha256; },
    r => { r.server.httpReadback.sha256 = 'a'.repeat(64); }, r => { r.server.httpReadback.version = 1; },
    r => { r.server.stopped.running = true; }, r => { r.server.stoppedStatus.lanUrlsCount = 1; },
    r => { r.server.stoppedStatus.revision = 6; }, r => { r.cleanup.oldLinkRevoked = false; },
    r => { r.cleanup.temporaryFilesRemoved = false; }, r => { r.cleanup.closedDocuments = 1; },
  ];
  for (const field of ['assetIndex', 'wasmRange', 'stateRead', 'documentRead', 'writeAccepted', 'staleWriteRejected', 'readback', 'wrongOriginRejected']) {
    mutations.push(r => { r.server.http[field] = false; });
  }
  for (const field of ['indexStatus', 'rangeStatus', 'stateStatus', 'documentStatus', 'writeStatus', 'staleWriteStatus', 'readbackStatus', 'wrongOriginStatus']) {
    mutations.push(r => { r.server.http[field] = 201; });
  }
  for (const mutate of mutations) {
    const report = workspaceReport(); mutate(report);
    assert.throws(() => validateNativeWorkspaceReport(report), /Native workspace/);
  }
});

test('autosave cannot use an accelerated timer, another target, stale bytes, dialogs, or a changed revision', () => {
  for (const mutate of [
    r => { r.autosave.intervalMs = 10; }, r => { r.autosave.elapsedMs = 29_999; },
    r => { r.autosave.elapsedMs = 50_001; }, r => { r.autosave.targetId = ''; },
    r => { r.autosave.initialSha256 = 'a'.repeat(64); }, r => { r.autosave.initialSizeBytes++; },
    r => { r.autosave.finalSha256 = r.autosave.initialSha256; }, r => { r.autosave.finalSizeBytes++; },
    r => { r.autosave.afterRevision++; }, r => { r.autosave.beforeDirty = false; },
    r => { r.autosave.afterDirty = true; }, r => { r.autosave.focusRetained = false; },
    r => { r.autosave.blurEvents = 1; }, r => { r.autosave.dialogObserved = true; },
    r => { r.autosave.reopenedText = 'unsaved'; }, r => { r.autosave.expectedText = 'unsaved'; },
    r => { r.autosave.saves = []; }, r => { r.autosave.saves.push(r.autosave.saves[0]); },
    r => { r.autosave.saves[0].saveAs = true; }, r => { r.autosave.saves[0].documentId = 'other'; },
    r => { r.autosave.saves[0].savedId = 'other'; }, r => { r.autosave.saves[0].status = 'cancelled'; },
    r => { delete r.autosave.saves[0].expectedSha256; },
    r => { r.autosave.saves[0].savedSha256 = r.autosave.initialSha256; },
    r => { r.autosave.saves[0].savedSizeBytes++; },
  ]) {
    const report = workspaceReport(); mutate(report);
    assert.throws(() => validateNativeWorkspaceReport(report), /Native workspace/);
  }
});

test('independent saved DOCX inspection rejects wrong or hidden text despite consistent claimed hashes', () => {
  const hidden = wordDocx(parts => {
    parts['word/document.xml'] = parts['word/document.xml'].replace('OfficeWord Native 中文😀', WORKSPACE_SAVED_TEXT)
      .replace('<w:rPr>', '<w:rPr><w:vanish/>');
  });
  for (const base64 of [workspaceDocx('A different saved document'), hidden, Buffer.from('PK\x03\x04' + 'invalid'.repeat(30)).toString('base64')]) {
    const report = workspaceReport(), bytes = Buffer.from(base64, 'base64');
    Object.assign(report.autosave, { readbackBase64: base64, finalSha256: createHash('sha256').update(bytes).digest('hex'), finalSizeBytes: bytes.length });
    Object.assign(report.autosave.saves[0], { savedSha256: report.autosave.finalSha256, savedSizeBytes: bytes.length });
    assert.throws(() => validateNativeWorkspaceReport(report), /independent DOCX/);
  }
});

test('frontend and publication agree on ordered checks and honest native smoke limitations', () => {
  const source = ts.createSourceFile('workspace-native-smoke.ts', readFileSync(new URL('../src/shared/workspace-native-smoke.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const arrays = [];
  const visit = node => { if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) arrays.push(node.elements.map(item => item.text)); ts.forEachChild(node, visit); };
  visit(source);
  assert.ok(arrays.some(value => JSON.stringify(value) === JSON.stringify(WORKSPACE_NATIVE_CHECKS)));
  assert.ok(arrays.some(value => JSON.stringify(value) === JSON.stringify(WORKSPACE_NATIVE_LIMITATIONS)));
});

test('publish verified artifacts applies current workspace policy in addition to source-bound editor validation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/desktop-publish-verified.yml', import.meta.url), 'utf8');
  assert.match(workflow, /import \{ validateFrontendReport \} from '\.\/verified-source\/scripts\/native-smoke\.mjs'/);
  assert.match(workflow, /import \{ validateNativeWorkspaceReport \} from '\.\/scripts\/native-smoke\.mjs'/);
  assert.match(workflow, /validateFrontendReport\(report\.frontend\);\s+validateNativeWorkspaceReport\(report\.frontend\.workspace\);/);
  assert.match(workflow, /verifyMacosArmEditingProof\(editingProof,/);
});
