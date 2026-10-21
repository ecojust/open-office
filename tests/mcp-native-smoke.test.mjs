import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { validateNativeMcpReport, MCP_NATIVE_CHECKS, MCP_NATIVE_LIMITATIONS, MCP_NATIVE_TEXT } from '../scripts/mcp-native-smoke.mjs';
import { mcpReport } from './helpers/mcp-smoke-report.mjs';
import { workspaceDocx } from './helpers/workspace-smoke-report.mjs';
import { wordDocx } from './helpers/office-word-smoke-fixture.mjs';

test('native MCP acceptance requires HTTP, real document changes, independent DOCX bytes, switch-stop and cleanup', () => {
  assert.deepEqual(validateNativeMcpReport(mcpReport()), {
    mcpNativeHttp: true, mcpNativeDocumentTools: true, mcpNativeDocxExport: true,
    mcpNativeSwitchStop: true, mcpNativeSessionCleanup: true,
    mcpNativeSevenEditorEditing: true, mcpNativeWordFormatHistory: true, mcpNativeSevenEditorExports: true,
  });
});

test('MCP publication rejects browser substitutes, missing checks and incomplete native reports', () => {
  for (const invalid of [undefined, null, [], {}, { ok: true }]) assert.throws(() => validateNativeMcpReport(invalid), /Native MCP/);
  for (const mutate of [
    r => { r.ok = false; }, r => { r.schemaVersion = 0; }, r => { r.kind = 'http-probe'; },
    r => { r.transport = 'browser'; }, r => { r.native.tauri = false; },
    r => { r.native.origin = 'http://example.com:31415'; }, r => { r.native.origin += '/asset-token'; },
    r => { r.checks.pop(); }, r => { r.checks.reverse(); }, r => { r.limitations.pop(); },
    r => { r.error = 'failed'; }, r => { r.cleanupError = 'failed'; },
    r => { delete r.http; }, r => { delete r.document; }, r => { delete r.service; }, r => { delete r.cleanup; },
  ]) {
    const report = mcpReport(); mutate(report);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP publication requires real handshake, catalog and well-formed successful tool responses for both HTTP clients', () => {
  for (const phase of ['write', 'read']) for (const mutate of [
    p => { p.sessionId = 'stale-session'; }, p => { p.port++; }, p => { p.httpSessionId = ''; },
    p => { p.initialized.jsonrpc = '1.0'; }, p => { p.initialized.id = 0; },
    p => { p.initialized.result.protocolVersion = 'unknown'; }, p => { p.initialized.error = { code: -32000 }; },
    p => { p.catalog.id = 0; }, p => { p.catalog.result.tools = []; }, p => { p.catalog.error = { code: -32000 }; },
    p => { p.response.jsonrpc = '1.0'; }, p => { p.response.id = 0; }, p => { p.response.error = { code: -32000 }; },
    p => { p.response.result.isError = true; }, p => { p.response.result.content = []; },
    p => { p.response.result.content[0].type = 'image'; }, p => { p.response.result.content[0].text = 'invalid JSON'; },
  ]) {
    const report = mcpReport(); mutate(report.http[phase]);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP tool results must match the same edited document, revision and exact returned text', () => {
  for (const mutate of [
    r => { r.document.key = 'another-document'; }, r => { r.document.afterDocumentId++; },
    r => { r.document.afterRevision = r.document.beforeRevision; }, r => { r.document.beforeText = 'nonblank'; },
    r => { r.document.afterText = 'wrong'; }, r => { r.document.dirty = false; },
    r => { r.http.write.response.result.content[0].text = JSON.stringify({ documentId: 18, revision: 1, dirty: true, text: MCP_NATIVE_TEXT }); },
    r => { r.http.write.response.result.content[0].text = JSON.stringify({ documentId: 17, revision: 0, dirty: true, text: MCP_NATIVE_TEXT }); },
    r => { r.http.write.response.result.content[0].text = JSON.stringify({ documentId: 17, revision: 1, dirty: false, text: MCP_NATIVE_TEXT }); },
    r => { r.http.read.response.result.content[0].text = JSON.stringify({ text: 'wrong', totalCharacters: 5, truncated: false }); },
    r => { r.http.read.response.result.content[0].text = JSON.stringify({ text: MCP_NATIVE_TEXT, totalCharacters: 0, truncated: false }); },
    r => { r.http.read.response.result.content[0].text = JSON.stringify({ text: MCP_NATIVE_TEXT, totalCharacters: MCP_NATIVE_TEXT.length, truncated: true }); },
  ]) {
    const report = mcpReport(); mutate(report);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP exported DOCX bytes must match their canonical encoding, hash and size', () => {
  for (const mutate of [
    d => { d.base64 += '\n'; }, d => { d.sha256 = '0'.repeat(64); }, d => { d.sizeBytes++; },
    d => { d.base64 = 'not-base64'; }, d => { delete d.base64; }, d => { d.sizeBytes = 0; },
  ]) {
    const report = mcpReport(); mutate(report.document);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP independent DOCX inspection rejects forged content even when exported hashes agree', () => {
  const hidden = wordDocx(parts => {
    parts['word/document.xml'] = parts['word/document.xml'].replace('OfficeWord Native 中文😀', MCP_NATIVE_TEXT)
      .replace('<w:rPr>', '<w:rPr><w:vanish/>');
  });
  for (const base64 of [workspaceDocx('A different exported document'), hidden, Buffer.from('PK\x03\x04' + 'invalid'.repeat(30)).toString('base64')]) {
    const report = mcpReport(), bytes = Buffer.from(base64, 'base64');
    Object.assign(report.document, { base64, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length });
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP publication requires a visible Running state and closes the actual old listener on document switch', () => {
  for (const mutate of [
    r => { r.service.runningBefore = false; }, r => { r.service.runningButton = false; },
    r => { r.service.sessionId = 'other-session'; }, r => { r.service.documentId = 'other-document'; },
    r => { r.service.switchedDocumentId = r.service.documentId; }, r => { r.service.switchedDocumentId = ''; },
    r => { r.service.stoppedAfter = false; }, r => { r.service.closedProbe.closed = false; }, r => { r.service.closedProbe.port++; },
    r => { r.cleanup.closedDocuments = 1; }, r => { r.cleanup.closedDocuments = 3; }, r => { r.cleanup.serviceStopped = false; },
  ]) {
    const report = mcpReport(); mutate(report);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP publication requires all seven new editing interfaces and matching actual editor revisions', () => {
  for (const mutate of [
    r => { r.schemaVersion = 1; }, r => { delete r.editors; }, r => { r.editors.pop(); },
    r => { r.editors.reverse(); }, r => { r.editors[6] = r.editors[5]; },
    r => { r.editors[1].key = r.editors[0].key; },
    r => { r.editors[1].service.sessionId = r.editors[0].service.sessionId; },
  ]) {
    const report = mcpReport(); mutate(report);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
  for (let index = 0; index < 7; index++) for (const mutate of [
    e => { e.edit.tool = 'document_inspect'; }, e => { e.query.tool = 'document_inspect'; },
    e => { e.edit.probe.sessionId = 'stale'; }, e => { e.query.probe.port++; },
    e => { e.edit.probe.response.result.isError = true; }, e => { e.query.probe.catalog.result.tools = []; },
    e => { e.after.revision = e.before.revision; }, e => { e.after.documentId++; },
    e => { e.after.dirty = false; }, e => { e.shellDirty = false; },
    e => { e.actual = { text: 'stale document' }; }, e => { e.exported.sha256 = '0'.repeat(64); },
  ]) {
    const report = mcpReport(); mutate(report.editors[index]);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
  for (const index of [4, 5, 6]) {
    const report = mcpReport(); report.editors[index].visibleText = '';
    assert.throws(() => validateNativeMcpReport(report), /UI did not redraw/);
  }
});

test('MCP publication verifies actual Word formatting and undo/redo query history', () => {
  for (const mutate of [
    e => { e.actual.format.bold = false; }, e => { e.actual.format.size = 11; },
    e => { delete e.history; }, e => { e.history.undo.response.result.isError = true; },
    e => { e.history.undone = e.history.redone; }, e => { e.history.redone = e.history.before; },
    e => { e.history.redo.response.result.content[0].text = JSON.stringify({ ...e.after, revision: 2 }); },
  ]) {
    const report = mcpReport(); mutate(report.editors[0]);
    assert.throws(() => validateNativeMcpReport(report), /Native MCP/);
  }
});

test('MCP publication independently inspects every exported format, even when hashes match', () => {
  for (let index = 0; index < 7; index++) {
    const report = mcpReport(), receipt = report.editors[index].exported;
    const bytes = Buffer.from('not an edited document '.repeat(10));
    Object.assign(receipt, { base64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    assert.throws(() => validateNativeMcpReport(report), /independent seven-editor/);
  }
});

test('installed MCP helper and publication validator agree on checks, specimen and disclosed limits', () => {
  const source = ts.createSourceFile('native-smoke.ts', readFileSync(new URL('../src/mcp/native-smoke.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const arrays = [], strings = [];
  const visit = node => {
    if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) arrays.push(node.elements.map(item => item.text));
    if (ts.isStringLiteral(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const required of [MCP_NATIVE_CHECKS, MCP_NATIVE_LIMITATIONS]) assert.ok(arrays.some(value => JSON.stringify(value) === JSON.stringify(required)));
  assert.ok(strings.includes(MCP_NATIVE_TEXT));
});
