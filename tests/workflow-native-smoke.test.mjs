import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { validateNativeWorkflowReport, WORKFLOW_NATIVE_CHECKS, WORKFLOW_NATIVE_LIMITATIONS, CANVAS_TEXT, DIAGRAM_SOURCE } from '../scripts/workflow-native-smoke.mjs';
import { workflowReport } from './helpers/workflow-smoke-report.mjs';
import { workspaceReport } from './helpers/workspace-smoke-report.mjs';
import { createDocument, serializeDocument } from '../src/workflow/core/documents.ts';

test('native canvas and diagram acceptance validates exact disk content, original-file receipts and fresh editor sessions', () => {
  assert.deepEqual(validateNativeWorkflowReport(workflowReport(), workspaceReport()), {
    canvasDomInput: true, canvasSavedFileReadback: true, canvasSessionCleanup: true,
    diagramDomInput: true, diagramSavedFileReadback: true, diagramSessionCleanup: true,
  });
  const report = workflowReport();
  for (const doc of report.documents) for (const snapshot of [doc.editing.before, doc.editing.after, doc.persistence.saved, doc.reopened.snapshot]) {
    Object.assign(snapshot, { canUndo: snapshot.revision > 0, canRedo: false });
  }
  assert.doesNotThrow(() => validateNativeWorkflowReport(report, workspaceReport()));
});

test('native workflow gate accepts the real new sequence diagram and rejects the former flowchart default', () => {
  const report = workflowReport(), doc = report.documents[1];
  const initial = createDocument('mermaid');
  initial.title = 'native-diagram';
  const installInitial = () => {
    // Exercise production creation and serialization, while the gate retains its
    // independent literal expectation rather than importing the sample itself.
    const data = Buffer.from(serializeDocument(initial));
    const hash = createHash('sha256').update(data).digest('hex');
    Object.assign(doc.persistence, { initialBase64: data.toString('base64'), initialSha256: hash, initialSizeBytes: data.length });
    doc.persistence.saves[0].expectedSha256 = hash;
  };
  installInitial();
  rewriteSaved(doc, model => {
    model.id = initial.id;
    model.createdAt = initial.createdAt;
    model.updatedAt = new Date(Date.parse(initial.createdAt) + 1000).toISOString();
  });
  assert.doesNotThrow(() => validateNativeWorkflowReport(report, workspaceReport()));

  // Recompute file hashes and receipts too, so rejection is about stale default
  // content, not corrupt bytes or a mismatched native save acknowledgement.
  initial.source = 'flowchart TD\n  start([开始]) --> idea[整理想法]\n  idea --> review{准备好了吗？}\n  review -->|是| done([发布])\n  review -->|再完善| idea';
  installInitial();
  assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /diagram initial content differs/);
});

test('workflow gate rejects browser reports, missing document coverage, incomplete edits and cleanup', () => {
  for (const value of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateNativeWorkflowReport(value, workspaceReport()), /Native workflow/);
  for (const mutate of [
    r => { r.ok = false; }, r => { r.schemaVersion = 2; }, r => { r.transport = 'browser'; }, r => { r.native.tauri = false; },
    r => { r.native.origin = 'http://example.com:1234'; }, r => { r.native.origin += '/path'; },
    r => { r.checks.pop(); }, r => { r.checks.reverse(); }, r => { r.limitations.pop(); },
    r => { r.documents.pop(); }, r => { r.documents.reverse(); }, r => { r.documents.push(r.documents[0]); },
    r => { r.cleanup.closedDocuments = 3; }, r => { r.error = 'failed'; }, r => { r.cleanupError = 'failed'; },
  ]) { const report = workflowReport(); mutate(report); assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/); }
  for (const index of [0, 1]) for (const mutate of [
    d => { d.kind = 'notebook'; }, d => { d.editing.inputEvents = 0; }, d => { d.editing.inputEvents = 2; },
    d => { d.editing.doubleClickEvents++; }, d => { d.editing.text = 'incorrect'; }, d => { d.editing.visibleText = ''; },
    d => { d.editing.before.dirty = true; }, d => { d.editing.before.revision = 1; },
    d => { d.editing.after.documentId++; }, d => { d.editing.after.revision = 0; }, d => { d.editing.after.dirty = false; },
    d => { d.cleanup.closedDocuments = 1; },
  ]) { const report = workflowReport(); mutate(report.documents[index]); assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/); }
  for (const workspace of [undefined, {}, { ...workspaceReport(), ok: false }, { ...workspaceReport(), cleanup: { temporaryFilesRemoved: false } },
    { ...workspaceReport(), native: { origin: 'http://127.0.0.1:22' } }]) assert.throws(() => validateNativeWorkflowReport(workflowReport(), workspace), /cleanup/);
});

test('workflow publication rejects tampered bytes, wrong save targets, stale receipts and reused sessions', () => {
  for (const index of [0, 1]) for (const mutate of [
    d => { d.persistence.initialBase64 += '\n'; }, d => { d.persistence.readbackBase64 += '\n'; }, d => { d.persistence.finalSizeBytes++; },
    d => { d.persistence.initialSha256 = '0'.repeat(64); }, d => { d.persistence.finalSha256 = '0'.repeat(64); }, d => { d.persistence.dialogObserved = true; },
    d => { d.persistence.saved.revision--; }, d => { d.persistence.saved.documentId++; }, d => { d.persistence.saved.dirty = true; },
    d => { d.persistence.saves = []; }, d => { d.persistence.saves.push(d.persistence.saves[0]); }, d => { d.persistence.saves[0].saveAs = true; },
    d => { d.persistence.saves[0].documentId = 'other'; }, d => { d.persistence.saves[0].savedId = 'other'; }, d => { d.persistence.saves[0].savedKind = 'note'; },
    d => { d.persistence.saves[0].extension = 'json'; }, d => { d.persistence.saves[0].expectedSha256 = '0'.repeat(64); },
    d => { d.persistence.saves[0].savedSha256 = '0'.repeat(64); }, d => { d.persistence.saves[0].savedSizeBytes++; },
    d => { d.reopened.snapshot.documentId = d.editing.after.documentId; }, d => { d.reopened.snapshot.revision = 2; }, d => { d.reopened.snapshot.dirty = true; },
    d => { d.reopened.keyChanged = false; }, d => { d.reopened.fileId = 'other'; }, d => { d.reopened.kind = 'pdf'; },
    d => { d.reopened.exportedBase64 = d.persistence.initialBase64; }, d => { d.reopened.text = ''; }, d => { d.reopened.visibleText = ''; },
  ]) { const report = workflowReport(); mutate(report.documents[index]); assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/); }
  const reusedSession = workflowReport();
  reusedSession.documents[1].reopened.snapshot.documentId = reusedSession.documents[0].reopened.snapshot.documentId;
  assert.throws(() => validateNativeWorkflowReport(reusedSession, workspaceReport()), /reused model IDs or editor sessions/);
  const reusedFile = workflowReport(), doc = reusedFile.documents[1], targetId = reusedFile.documents[0].persistence.targetId;
  doc.persistence.targetId = targetId; Object.assign(doc.persistence.saves[0], { documentId: targetId, savedId: targetId }); doc.reopened.fileId = targetId;
  assert.throws(() => validateNativeWorkflowReport(reusedFile, workspaceReport()), /reused a file identity/);
});

function rewriteSaved(doc, mutate) {
  const model = JSON.parse(Buffer.from(doc.persistence.readbackBase64, 'base64').toString('utf8')); mutate(model);
  const data = Buffer.from(JSON.stringify(model)), hash = createHash('sha256').update(data).digest('hex'), base64 = data.toString('base64');
  Object.assign(doc.persistence, { readbackBase64: base64, finalSha256: hash, finalSizeBytes: data.length });
  Object.assign(doc.persistence.saves[0], { savedSha256: hash, savedSizeBytes: data.length });
  Object.assign(doc.reopened, { sha256: hash, exportedBase64: base64 });
}

test('independent workflow JSON inspection rejects altered content even when hashes and save receipts agree', () => {
  for (const index of [0, 1]) for (const mutate of [
    m => { m.title = 'different'; }, m => { m.id = 'another-document'; }, m => { m.extra = 'hidden payload'; },
    m => { m.kind = 'flow'; }, m => { m.diagramStyle = 'sketch'; }, m => { m.scene.background = '#000000'; },
    m => { m.scene.grid = false; }, m => { m.scene.defaultStyle.strokeWidth = 3; },
    m => { m.updatedAt = '2026-10-16T00:00:00.000Z'; }, m => { m.createdAt = m.updatedAt; },
    m => { m.updatedAt = 'invalid'; }, m => { m.importSource = { text: 'extra' }; },
  ]) {
    const report = workflowReport(); rewriteSaved(report.documents[index], mutate);
    assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/);
  }
  for (const mutate of [
    m => { m.scene.elements[0].text = 'wrong'; }, m => { m.scene.elements.push(structuredClone(m.scene.elements[0])); },
    m => { m.scene.elements[0].x += 1.001; }, m => { m.scene.elements[0].y += 1.001; }, m => { m.scene.elements[0].width++; },
    m => { m.scene.elements[0].height++; }, m => { m.scene.elements[0].locked = true; }, m => { m.scene.elements[0].style.fill = 'red'; },
    m => { m.scene.elements[0].id = m.id; }, m => { m.scene.elements[0].groupId = 'extra'; }, m => { m.source = 'unexpected source'; },
  ]) {
    const report = workflowReport(); rewriteSaved(report.documents[0], mutate);
    assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/);
  }
  for (const mutate of [
    m => { m.source = 'flowchart LR\n wrong --> other'; }, m => { m.scene.elements.push({ id: 'hidden', type: 'shape' }); },
  ]) {
    const report = workflowReport(); rewriteSaved(report.documents[1], mutate);
    assert.throws(() => validateNativeWorkflowReport(report, workspaceReport()), /Native workflow/);
  }
});

test('canvas placement permits one CSS pixel of native mouse coordinate quantization', () => {
  for (const [x, y] of [[200, 159.5], [199.5, 160], [199, 161], [201, 159]]) {
    const report = workflowReport();
    rewriteSaved(report.documents[0], model => { Object.assign(model.scene.elements[0], { x, y }); });
    assert.doesNotThrow(() => validateNativeWorkflowReport(report, workspaceReport()));
  }
});

test('installed helper and publication agree on workflow checks, inputs and honest coverage limitations', () => {
  const source = ts.createSourceFile('native-smoke.ts', readFileSync(new URL('../src/workflow/native-smoke.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const arrays = [], strings = [];
  const visit = node => {
    if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) arrays.push(node.elements.map(item => item.text));
    if (ts.isStringLiteral(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  }; visit(source);
  for (const required of [WORKFLOW_NATIVE_CHECKS, WORKFLOW_NATIVE_LIMITATIONS]) assert.ok(arrays.some(value => JSON.stringify(value) === JSON.stringify(required)));
  for (const required of [CANVAS_TEXT, DIAGRAM_SOURCE]) assert.ok(strings.includes(required));
  const publication = readFileSync(new URL('../.github/workflows/desktop-publish-verified.yml', import.meta.url), 'utf8');
  assert.match(publication, /import \{ validateFrontendReport \} from '\.\/verified-source\/scripts\/native-smoke\.mjs'/);
  assert.match(publication, /validateFrontendReport\(report\.frontend\)/);
});
