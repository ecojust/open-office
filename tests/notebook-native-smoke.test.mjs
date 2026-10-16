import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { validateNativeNotebookReport, NOTEBOOK_NATIVE_CHECKS, NOTEBOOK_NATIVE_LIMITATIONS } from '../scripts/notebook-native-smoke.mjs';
import { notebookReport } from './helpers/notebook-smoke-report.mjs';
import { workspaceReport } from './helpers/workspace-smoke-report.mjs';

test('native notebook acceptance validates disk bytes, original-file receipt, DOM input and new-session reopen', () => {
  assert.deepEqual(validateNativeNotebookReport(notebookReport(), workspaceReport()), { notebookDomInput: true, notebookSavedFileReadback: true, notebookSessionCleanup: true });
});

test('native notebook gate rejects missing/browser reports and incomplete DOM edit or cleanup', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateNativeNotebookReport(value, workspaceReport()), /Native notebook/);
  for (const mutate of [
    r => { r.ok = false; }, r => { r.schemaVersion = 2; }, r => { r.transport = 'browser'; }, r => { r.native.tauri = false; },
    r => { r.native.origin = 'http://example.com:1234'; }, r => { r.native.origin += '/path'; }, r => { r.checks.pop(); }, r => { r.limitations.pop(); },
    r => { r.editing.bodyInputEvents = 0; }, r => { r.editing.titleInputEvents = 0; }, r => { r.editing.before.dirty = true; },
    r => { r.editing.after.documentId++; }, r => { r.editing.after.revision = 0; }, r => { r.editing.after.dirty = false; },
    r => { r.cleanup.closedDocuments = 1; }, r => { r.error = 'failed'; }, r => { r.cleanupError = 'failed'; },
  ]) { const report = notebookReport(); mutate(report); assert.throws(() => validateNativeNotebookReport(report, workspaceReport()), /Native notebook/); }
  for (const workspace of [undefined, {}, { ...workspaceReport(), ok: false }, { ...workspaceReport(), cleanup: { temporaryFilesRemoved: false } },
    { ...workspaceReport(), native: { origin: 'http://127.0.0.1:22' } }]) assert.throws(() => validateNativeNotebookReport(notebookReport(), workspace), /cleanup/);
});

test('native notebook publication rejects altered byte evidence, wrong save targets, stale receipts and reused sessions', () => {
  for (const mutate of [
    r => { r.persistence.initialBase64 += '\n'; }, r => { r.persistence.readbackBase64 += '\n'; }, r => { r.persistence.finalSizeBytes++; },
    r => { r.persistence.initialSha256 = '0'.repeat(64); }, r => { r.persistence.finalSha256 = '0'.repeat(64); }, r => { r.persistence.dialogObserved = true; },
    r => { r.persistence.saved.revision--; }, r => { r.persistence.saved.documentId++; }, r => { r.persistence.saved.dirty = true; },
    r => { r.persistence.saves = []; }, r => { r.persistence.saves.push(r.persistence.saves[0]); }, r => { r.persistence.saves[0].saveAs = true; },
    r => { r.persistence.saves[0].documentId = 'other'; }, r => { r.persistence.saves[0].savedId = 'other'; }, r => { r.persistence.saves[0].expectedSha256 = '0'.repeat(64); },
    r => { r.persistence.saves[0].savedSha256 = '0'.repeat(64); }, r => { r.persistence.saves[0].savedSizeBytes++; },
    r => { r.reopened.snapshot.documentId = r.editing.after.documentId; }, r => { r.reopened.snapshot.revision = 2; }, r => { r.reopened.snapshot.dirty = true; },
    r => { r.reopened.keyChanged = false; }, r => { r.reopened.fileId = 'other'; }, r => { r.reopened.exportedBase64 = r.persistence.initialBase64; },
    r => { r.reopened.title = ''; }, r => { r.reopened.text = ''; },
  ]) { const report = notebookReport(); mutate(report); assert.throws(() => validateNativeNotebookReport(report, workspaceReport()), /Native notebook/); }
});

test('independent JSON inspection rejects extra or altered content even when reported hashes and receipts agree', () => {
  for (const mutate of [
    model => { model.sections[0].pages[0].regions[0].blocks[0].content[0].text = 'different'; },
    model => { model.sections[0].pages[0].regions[0].blocks.push({ id: 'extra', type: 'paragraph', content: [{ text: 'hidden extra' }] }); },
    model => { model.sections[0].pages[0].regions[0].blocks[0].content[0].marks = ['bold']; },
    model => { model.sections[0].pages[0].id = model.id; },
    model => { model.sections[0].pages[0].regions[0].id = 'changed-region'; },
    model => { model.sections[0].pages[0].regions[0].id = model.id; },
    model => { model.sections[0].pages[0].regions[0].x++; },
    model => { model.sections[0].pages[0].regions[0].y++; },
    model => { model.sections[0].pages[0].regions[0].width++; },
    model => { model.sections[0].pages[0].regions[0].height = 100; },
    model => { model.sections[0].pages[0].regions.push({ id: 'extra-region', x: 600, y: 24, width: 480, blocks: [{ id: 'extra-block', type: 'paragraph', content: [] }] }); },
    model => { model.sections[0].pages[0].parentId = 'unexpected-parent'; },
    model => { const page = model.sections[0].pages[0]; model.version = 1; page.blocks = page.regions[0].blocks; delete page.regions; },
    model => { model.extra = 'unexpected'; },
  ]) {
    const report = notebookReport(), model = JSON.parse(Buffer.from(report.persistence.readbackBase64, 'base64').toString('utf8')); mutate(model);
    const bytes = Buffer.from(JSON.stringify(model)), hash = createHash('sha256').update(bytes).digest('hex'), base64 = bytes.toString('base64');
    Object.assign(report.persistence, { readbackBase64: base64, finalSha256: hash, finalSizeBytes: bytes.length });
    Object.assign(report.persistence.saves[0], { savedSha256: hash, savedSizeBytes: bytes.length });
    Object.assign(report.reopened, { sha256: hash, exportedBase64: base64 });
    assert.throws(() => validateNativeNotebookReport(report, workspaceReport()), /Native notebook/);
  }
});

test('installed notebook helper and publication agree on required checks and honest coverage limits', () => {
  const source = ts.createSourceFile('native-smoke.ts', readFileSync(new URL('../src/notes/native-smoke.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const arrays = [];
  const visit = node => { if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) arrays.push(node.elements.map(item => item.text)); ts.forEachChild(node, visit); }; visit(source);
  for (const required of [NOTEBOOK_NATIVE_CHECKS, NOTEBOOK_NATIVE_LIMITATIONS]) assert.ok(arrays.some(value => JSON.stringify(value) === JSON.stringify(required)));
  const workflow = readFileSync(new URL('../.github/workflows/desktop-publish-verified.yml', import.meta.url), 'utf8');
  assert.match(workflow, /import \{ validateNativeWorkspaceReport, validateNativeNotebookReport \} from '\.\/scripts\/native-smoke\.mjs'/);
  assert.match(workflow, /validateNativeNotebookReport\(report\.frontend\.notebook, report\.frontend\.workspace\)/);
});
