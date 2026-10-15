import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('./', import.meta.url));
const oracle = path.join(root, 'inspect_docx.py');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const wordcraftFixtureRoot = root;

export function inspectWordcraftFile(file, pdf = false) {
  const result = spawnSync('python3', [oracle, ...(pdf ? ['--pdf'] : []), file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function containsText(doc, text) {
  assert.ok(doc.paragraphs.some(p => p.text.includes(text)), `missing text ${JSON.stringify(text)}`);
}

function textStyle(doc, text, expected) {
  const p = doc.paragraphs.find(p => p.text.includes(text));
  assert.ok(p, `missing formatted text ${text}`);
  const start = [...p.text.slice(0, p.text.indexOf(text))].length;
  const chars = p.characters.slice(start, start + [...text].length);
  assert.equal(chars.length, [...text].length);
  for (const ch of chars) for (const [key, value] of Object.entries(expected)) {
    assert.equal(ch[key], value, `${text}: ${ch.text} ${key}`);
  }
}

export function richContract(doc, imageSha) {
  for (const text of ['WordCraft independent 中文😀', 'Bold中文😀', 'Target format', 'List first', 'List second', 'Cell A1', 'Cell B1', 'Cell A2', 'Cell B2', 'Independent header 中文', 'Independent footer']) containsText(doc, text);
  textStyle(doc, 'WordCraft independent 中文😀', { bold: true, fontSize: 18, color: '#336699' });
  textStyle(doc, 'Bold中文😀', { bold: true });
  textStyle(doc, 'Italic', { italic: true });
  textStyle(doc, 'Underline', { underline: 'single' });
  textStyle(doc, 'Strike', { strike: true });
  textStyle(doc, 'Highlighted', { highlight: 'yellow' });
  textStyle(doc, 'x2', { verticalAlign: 'superscript' });
  textStyle(doc, 'H2O', { verticalAlign: 'subscript' });
  const spaced = doc.paragraphs.find(p => p.text === 'Paragraph spacing');
  for (const [key, value] of Object.entries({ spacingBefore: 6, spacingAfter: 8, indentLeft: 18, indentRight: 9, indentFirstLine: 6, lineSpacing: 1.5 })) assert.equal(spaced.style[key], value, key);
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0].rows, 2);
  assert.deepEqual(doc.tables[0].columns, [2, 2]);
  assert.equal(doc.images.length, 1);
  assert.equal(doc.images[0].sha256, imageSha);
  assert.ok(doc.fields.some(f => f.instruction === 'PAGE'));
  assert.equal(doc.sections.at(-1).width, 612);
  assert.equal(doc.sections.at(-1).height, 792);
  for (const text of ['List first', 'List second']) assert.ok(doc.paragraphs.find(p => p.text === text)?.numbering, `missing numbering ${text}`);
}

/** Real host WASM integration, called by the shared Playwright suite. No second browser/build.
 * adapter.open(name,bytes), command(id,params) -> {ok,...}, exportDocument(name) -> bytes.
 * The adapter must use an isolated retained WordApp session; open replaces that test session.
 */
export async function runWordcraftCore(adapter, outdir) {
  await mkdir(outdir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const report = { upstreamCommit: '3292ba05d3c15c003823be6849e87a1c6e205242', fixtures: [], commands: [], pdf: null, artifacts: [] };
  async function save(name) {
    const bytes = new Uint8Array(await adapter.exportDocument(name));
    assert.ok(bytes.length > 100, `${name} is empty`);
    const file = path.join(outdir, name);
    await writeFile(file, bytes);
    report.artifacts.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
    return { file, bytes };
  }
  async function command(id, params = {}) {
    const response = await adapter.command(id, params);
    assert.equal(response.ok, true, `${id}: ${response.error}`);
    report.commands.push({ id, params, documentId: response.snapshot?.documentId, revision: response.snapshot?.revision });
    return response;
  }
  try {
  const rich = manifest.fixtures.find(f => f.name === 'independent-rich');
  for (const [kind, relative, expectedHash] of [['source', rich.source, rich.sourceSha256], ['native', rich.nativeDocx, rich.nativeDocxSha256]]) {
    assert.ok(relative, `missing ${kind} specimen`);
    const bytes = await readFile(path.join(root, relative));
    assert.equal(sha256(bytes), expectedHash);
    await adapter.open(`${kind}.docx`, bytes);
    const first = await save(`${kind}-roundtrip.docx`);
    richContract(inspectWordcraftFile(first.file), manifest.image.sha256);
    await adapter.open(`${kind}-reopen.docx`, first.bytes);
    const second = await save(`${kind}-second.docx`);
    richContract(inspectWordcraftFile(second.file), manifest.image.sha256);
    report.fixtures.push({ kind, sourceSha256: expectedHash, rounds: 2 });
  }
  const seed = manifest.fixtures.find(f => f.name === 'independent-seed');
  await adapter.open('commands.docx', await readFile(path.join(root, seed.source)));
  await command('caret.docEnd');
  await command('text.newParagraph');
  await command('text.insert', { text: 'Inserted 中文😀' });
  await command('select.text', { text: 'Inserted 中文😀' });
  for (const id of ['format.bold', 'format.italic', 'format.underline', 'format.strikethrough']) await command(id, { value: true });
  await command('format.size', { size: 18 });
  await command('format.color', { color: '336699' });
  await command('format.highlight', { color: 'yellow' });
  await command('caret.docEnd');
  await command('text.newParagraph');
  await command('insert.table', { rows: 2, cols: 2 });
  for (const [index, text] of ['Command A1', 'Command B1', 'Command A2', 'Command B2'].entries()) {
    if (index) await command('text.tab');
    await command('text.insert', { text });
  }
  await command('insert.header', { text: 'Command header 中文' });
  await command('insert.footer', { text: 'Command footer' });
  await command('caret.docEnd');
  await command('insert.pageNumber', { position: 'current' });
  await command('insert.closeHeader');
  await command('caret.docEnd');
  await command('insert.picture', { data: (await readFile(path.join(root, manifest.image.path))).toString('base64'), width: 24, alt: 'Command independent PNG' });
  const beforeError = await command('caret.docEnd');
  const invalid = await adapter.command('integration.unknown-command', {});
  assert.equal(invalid.ok, false, 'unknown command must fail explicitly');
  assert.equal(invalid.snapshot?.revision, beforeError.snapshot?.revision, 'failed command changed revision');
  assert.equal(invalid.snapshot?.text, beforeError.snapshot?.text, 'failed command changed document text');
  const saved = await save('commands.docx');
  const doc = inspectWordcraftFile(saved.file);
  for (const text of ['Seed', 'Inserted 中文😀', 'Command A1', 'Command B1', 'Command A2', 'Command B2', 'Command header 中文', 'Command footer']) containsText(doc, text);
  textStyle(doc, 'Inserted 中文😀', { bold: true, italic: true, underline: 'single', strike: true, fontSize: 18, color: '#336699', highlight: 'yellow' });
  assert.equal(doc.tables.length, 1);
  assert.deepEqual(doc.tables[0].columns, [2, 2]);
  assert.equal(doc.images.length, 1);
  assert.equal(doc.images[0].sha256, manifest.image.sha256);
  assert.equal(doc.images[0].width, 24);
  assert.ok(doc.fields.some(f => f.instruction === 'PAGE'));
  const pdfFile = await save('commands.pdf');
  const pdf = inspectWordcraftFile(pdfFile.file, true);
  for (const text of ['Seed', 'Inserted', '中文', '😀', 'Command A1', 'Command B1', 'Command A2', 'Command B2', 'Command header', 'Command footer']) assert.ok(pdf.text.includes(text), `PDF text missing ${text}`);
  assert.ok(pdf.spans.some(s => s.text.includes('Inserted') && Math.abs(s.size - 18) < 0.1 && s.color === 0x336699), 'PDF formatted span mismatch');
  report.pdf = { pages: pdf.pages, text: pdf.text, spans: pdf.spans.length };
  await adapter.open('commands-reopened.docx', saved.bytes);
  const reopened = await save('commands-reopened.docx');
  const reopenedDoc = inspectWordcraftFile(reopened.file);
  textStyle(reopenedDoc, 'Inserted 中文😀', { bold: true, italic: true, underline: 'single', strike: true, fontSize: 18, color: '#336699', highlight: 'yellow' });
  assert.equal(reopenedDoc.tables.length, 1);
  assert.equal(reopenedDoc.images.length, 1);
  // Exercise the real Unicode-scalar replacement command used by eframe's text agent.
  // These calls use the same retained host and WASM as the other core probes.
  await adapter.open('surrounding.docx', await readFile(path.join(root, seed.source)));
  const originalText = 'A😀e\u0301中Z';
  await command('select.all');
  await command('text.insert', { text: originalText });
  const selected = await command('select.text', { text: '中' });
  const reversed = await command('select.range', {
    anchor: selected.snapshot.selection.focus,
    focus: selected.snapshot.selection.anchor,
  });
  const removed = await command('text.deleteSurrounding', { beforeChars: 2, afterChars: 1 });
  assert.equal(removed.snapshot.text, 'A😀中', 'Counts delete e + combining mark and Z, preserving selected Chinese');
  assert.equal(removed.snapshot.selection.anchor.off, Buffer.byteLength('A😀中'));
  assert.equal(removed.snapshot.selection.focus.off, Buffer.byteLength('A😀'));
  const undone = await command('edit.undo');
  assert.equal(undone.snapshot.text, originalText);
  assert.deepEqual(undone.snapshot.selection, reversed.snapshot.selection, 'One undo restores the reversed selection');
  const redone = await command('edit.redo');
  assert.equal(redone.snapshot.text, 'A😀中');
  assert.deepEqual(redone.snapshot.selection, removed.snapshot.selection);
  await command('edit.undo');
  const replaced = await command('text.deleteSurrounding', { beforeChars: 2, afterChars: 1, text: '新' });
  assert.equal(replaced.snapshot.text, 'A😀新');
  assert.deepEqual(replaced.snapshot.selection.anchor, replaced.snapshot.selection.focus);
  const replacementUndo = await command('edit.undo');
  assert.equal(replacementUndo.snapshot.text, originalText, 'Replacement and surrounding deletion are one undo transaction');
  assert.deepEqual(replacementUndo.snapshot.selection, reversed.snapshot.selection);
  const replacementRedo = await command('edit.redo');
  assert.equal(replacementRedo.snapshot.text, 'A😀新');
  await command('select.text', { text: '新' });
  const emojiDeleted = await command('text.deleteSurrounding', { beforeChars: 1, afterChars: 0 });
  assert.equal(emojiDeleted.snapshot.text, 'A新', 'One scalar deletes the whole emoji rather than half a UTF-16 pair');
  const beforeRefusals = (await command('edit.undo')).snapshot;
  report.surroundingRefusals = [];
  for (const params of [{ beforeChars: -1, afterChars: 0 }, { beforeChars: 0.5, afterChars: 0 }, { beforeChars: 1, afterChars: '1' }, { beforeChars: 0 }, { beforeChars: 1, afterChars: 0, text: 3 }]) {
    const refusal = await adapter.command('text.deleteSurrounding', params);
    assert.equal(refusal.ok, false, 'Invalid surrounding count/replacement must fail explicitly');
    for (const key of ['documentId', 'revision', 'text', 'selection', 'dirty', 'canUndo', 'canRedo']) assert.deepEqual(refusal.snapshot[key], beforeRefusals[key], `Rejected surrounding edit changed ${key}`);
    report.surroundingRefusals.push({ params, error: refusal.error, revision: refusal.snapshot.revision });
  }
  const scalarFile = await save('surrounding-scalars.docx');
  assert.equal(inspectWordcraftFile(scalarFile.file).paragraphs[0].text, 'A😀新');
  await command('select.all');
  // The engine's typed-text protocol uses CR for a paragraph and LF for a line break.
  await command('text.insert', { text: 'ab\r中文\r😀cd' });
  const paragraphSelection = await command('select.text', { text: '中' });
  await command('select.collapse', { end: true });
  const joined = await command('text.deleteSurrounding', { beforeChars: 3, afterChars: 2 });
  assert.equal(joined.snapshot.text, 'a😀cd', 'Each paragraph separator is one scalar');
  assert.equal(joined.snapshot.selection.focus.off, 1);
  const paragraphFile = await save('surrounding-paragraphs.docx');
  assert.deepEqual(inspectWordcraftFile(paragraphFile.file).paragraphs.map(p => p.text), ['a😀cd']);
  assert.ok(paragraphSelection.snapshot.text.includes('\n'), 'The probe had real paragraph boundaries');
  await command('select.all');
  await command('text.insert', { text: 'before' });
  await command('caret.docEnd');
  await command('text.newParagraph');
  await command('insert.table', { rows: 1, cols: 2 });
  await command('text.insert', { text: '左😀右' });
  await command('text.tab');
  await command('text.insert', { text: 'neighbor' });
  const leftCell = await command('select.text', { text: '左' });
  await command('text.deleteSurrounding', { beforeChars: 100, afterChars: 100 });
  const cellFile = await save('surrounding-cell-boundary.docx');
  assert.deepEqual(inspectWordcraftFile(cellFile.file).tables[0].cells.map(cell => cell.text), ['左', 'neighbor'], 'Surrounding counts cannot erase a neighboring table cell');
  const neighbor = await command('select.text', { text: 'neighbor' });
  const crossCell = await command('select.range', { anchor: leftCell.snapshot.selection.anchor, focus: neighbor.snapshot.selection.focus });
  const boundaryFailure = await adapter.command('text.deleteSurrounding', { beforeChars: 1, afterChars: 1, text: 'changed' });
  assert.equal(boundaryFailure.ok, false, 'A selection crossing table cells is refused');
  for (const key of ['documentId', 'revision', 'text', 'selection', 'dirty', 'canUndo', 'canRedo']) assert.deepEqual(boundaryFailure.snapshot[key], crossCell.snapshot[key], `Cross-cell refusal changed ${key}`);
  report.surroundingRefusals.push({ kind: 'cross-cell selection', error: boundaryFailure.error, revision: boundaryFailure.snapshot.revision });
  report.surrounding = { unicodeScalars: true, reversedSelection: true, paragraphSeparators: true, oneStepUndoRedo: true, cellBoundary: true, atomicRefusals: report.surroundingRefusals.length };
  return report;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await writeFile(path.join(outdir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
