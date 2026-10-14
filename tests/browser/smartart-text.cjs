/* Independent SmartArt text interoperability checks. These tests drive the public
 * importer/controller/exporter; pinned GUIDs below were read from the upstream
 * XML, not derived with the production mapping implementation. */
const { chromium } = require('playwright');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const suite = path.join(root, 'tests/compatibility/presentation-complex');
const out = path.resolve(root, process.env.SMARTART_TEXT_OUTPUT || 'test-results/smartart-text');
const url = process.env.PRESENTATION_COMPLEX_URL || 'http://127.0.0.1:5198/';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plans = [
  { name: 'smartart-simple.pptx', content: '{63986E3B-5608-7F48-A1F2-C2D1F88EED58}', shape: '{DB1843D3-471D-3D4F-8D9B-C7F506BC5FEE}', original: 'abc',
    readonly: ['{B0DF3F4E-A375-EB49-AB27-EE2F66D1C44E}'] },
  { name: 'smartart-rotated-text.pptx', content: '{384819B8-B852-9242-9D86-5CC9197F7C3F}', shape: '{15B6B5E2-4746-1B4C-A555-F2DFA0E39D18}', original: 'abc',
    readonly: [] },
  { name: 'SmartArt.pptx', content: '{EC0D1448-4AB9-47C0-A4EF-4E8640283403}', shape: '{6B75AEA0-469E-42BA-9B81-3A0807E17FCA}', original: '', readonly: [] },
];
const report = { scope: 'Conservative single-line SmartArt text edits: independently pinned data/cache targets, repeat exports, atomic failure and original package preservation. No SmartArt layout regeneration claim.', preservation: 'Media, styles, layouts and diagram relationships retain original bytes. The existing exporter normalizes general relationship XML, checked semantically; relative to a no-op export, text editing may change only diagram data and drawing parts.', fixtures: [], adversarial: [], externalRequests: [], pageErrors: [] };
fs.mkdirSync(out, { recursive: true });

async function exercise({ base64, plan, adversarial = false }) {
  const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
  const { prepareSmartArtTextEdit, discardPreparedSmartArtTextEdit } = await import('/src/presentation/core/smartart-text.ts');
  const { PresentationController } = await import('/src/presentation/core/model.ts');
  const { slideSvg } = await import('/src/presentation/core/render.ts');
  const { readPptxParts } = await import('/src/presentation/pptx-package.ts');
  const D = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
  const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const encode = value => { let raw = ''; for (let i = 0; i < value.length; i += 16384) raw += String.fromCharCode(...value.subarray(i, i + 16384)); return btoa(raw); };
  const check = (condition, message) => { if (!condition) throw Error(`${plan.name}: ${message}`); };
  const eq = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  const sourceHashes = async model => Promise.all([...model.sourceParts].map(async ([name, value]) => [name, await digest(value)]));
  const read = bytes => { const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml'); check(!xml.querySelector('parsererror'), 'Oracle XML parse failure'); return xml; };
  const all = (node, ns, local) => [...node.getElementsByTagNameNS(ns, local)];
  const one = (document, ns, tag, id) => { const found = all(document, ns, tag).filter(n => n.getAttribute('modelId') === id); check(found.length === 1, `Oracle expected one ${tag} ${id}`); return found[0]; };
  const textOf = node => all(node, A, 't').map(t => t.textContent).join('');
  // Namespace-aware canonical tree ignores only serializer prefix/declaration order.
  const canonical = node => node.nodeType === 3 ? ['#text', node.nodeValue] : node.nodeType !== 1 ? null :
    [node.namespaceURI, node.localName, [...node.attributes].filter(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map(a => [a.namespaceURI || '', a.localName, a.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [...node.childNodes].map(canonical).filter(x => x !== null)];
  function assertRelationships(before, after, except = []) {
    let count = 0;
    for (const [name, bytes] of before) if (name.endsWith('.rels') && !except.includes(name)) {
      const values = data => all(read(data), 'http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship').map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      eq(values(after.get(name)), values(bytes), `Relationship semantics preserved: ${name}`); count++;
    }
    return count;
  }
  function assertXmlEdits(before, after, value) {
    const d0 = read(before.get('ppt/diagrams/data1.xml')), d1 = read(after.get('ppt/diagrams/data1.xml'));
    const c0 = read(before.get('ppt/diagrams/drawing1.xml')), c1 = read(after.get('ppt/diagrams/drawing1.xml'));
    const targetData = one(d1, D, 'pt', plan.content), targetShape = one(c1, DSP, 'sp', plan.shape);
    eq(textOf(targetData), value, 'Correct content node must contain new text');
    eq(textOf(targetShape), value, 'Correct cached shape must contain same new text');
    let unchanged = 0;
    for (const [oldDoc, newDoc, namespace, tag, target] of [[d0, d1, D, 'pt', plan.content], [c0, c1, DSP, 'sp', plan.shape]]) {
      const oldNodes = all(oldDoc, namespace, tag), newNodes = all(newDoc, namespace, tag);
      eq(oldNodes.map(n => n.getAttribute('modelId')), newNodes.map(n => n.getAttribute('modelId')), 'Node order/identity preserved');
      oldNodes.forEach((node, index) => { if (node.getAttribute('modelId') !== target) { eq(canonical(newNodes[index]), canonical(node), `Unrelated ${tag} ${node.getAttribute('modelId')} changed`); unchanged++; } });
    }
    const oldData = one(d0, D, 'pt', plan.content), oldShape = one(c0, DSP, 'sp', plan.shape);
    const withoutBody = (node, namespace, local) => { node = node.cloneNode(true); for (const b of all(node, namespace, local)) b.remove(); for (const pr of all(node, D, 'prSet')) pr.removeAttribute('phldr'); return canonical(node); };
    eq(withoutBody(targetData, D, 't'), withoutBody(oldData, D, 't'), 'Data node non-text metadata preserved');
    eq(withoutBody(targetShape, DSP, 'txBody'), withoutBody(oldShape, DSP, 'txBody'), 'Cache geometry/styles preserved');
    eq(all(d1, D, 'cxn').map(canonical), all(d0, D, 'cxn').map(canonical), 'Connections and presOf graph unchanged');
    for (const [oldNode, newNode] of [[oldData, targetData], [oldShape, targetShape]]) {
      for (const tag of ['bodyPr', 'lstStyle', 'pPr', 'endParaRPr']) eq(all(newNode, A, tag).map(canonical), all(oldNode, A, tag).map(canonical), `${tag} preserved`);
      if (all(oldNode, A, 'r').length) eq(all(newNode, A, 'rPr').map(canonical), all(oldNode, A, 'rPr').map(canonical), 'Existing run formatting preserved');
    }
    return { contentId: plan.content, cacheShapeId: plan.shape, value, unchangedNodes: unchanged };
  }
  const find = model => model.slides[0].objects.find(o => o.sourceXml?.includes('/diagram'));
  const nodeAt = model => find(model)?.smartArt?.nodes.find(n => n.id === plan.shape);
  const expectRejected = async (fn, message, controller) => {
    const before = controller ? JSON.stringify(controller.model.slides) : null, revision = controller?.revision;
    let failure; try { await fn(); } catch (error) { failure = String(error.message || error); }
    check(failure, `${message} must reject`);
    if (controller) { eq(JSON.stringify(controller.model.slides), before, `${message} changed model`); eq(controller.revision, revision, `${message} changed revision`); }
    return failure;
  };
  const source = decode(base64), initial = await importPresentation(source), result = { artifacts: [], cycles: [], rejected: [] };
  let model = initial;
  if (adversarial) {
    const editor = new PresentationController(model, plan.name), diagram = find(editor.model), initialHash = await sourceHashes(editor.model);
    check(diagram, 'Diagram must remain represented');
    check(!nodeAt(editor.model)?.editable || diagram.smartArt?.blockedReason, 'Unsafe target must be readonly');
    result.reason = nodeAt(editor.model)?.reason || diagram.smartArt?.blockedReason || diagram.warning;
    check(!!result.reason, 'Unsafe target must explain readonly state');
    result.rejected.push(await expectRejected(async () => editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'MUST NOT APPLY', editor.revision)), 'Unsafe edit', editor));
    const bytes = await exportPresentation(editor.model);
    result.relationshipsPreserved = assertRelationships(model.sourceParts, await readPptxParts(bytes));
    eq(await sourceHashes(editor.model), initialHash, 'Rejected edit/export mutated source parts');
    result.artifacts.push({ name: 'preserved.pptx', base64: encode(bytes) });
    result.node = nodeAt(editor.model) || null;
    return result;
  }
  eq(nodeAt(model)?.contentId, plan.content, 'Importer mapping matches independently pinned content node');
  eq(nodeAt(model)?.text, plan.original, 'Source text matches pinned fixture');
  check(nodeAt(model)?.editable, 'Pinned text node must be editable');
  result.initialNodes = find(model).smartArt.nodes.map(n => ({ id: n.id, contentId: n.contentId, text: n.text, editable: n.editable, reason: n.reason }));
  for (const id of plan.readonly) {
    const editor = new PresentationController(model, plan.name), diagram = find(editor.model);
    check(!diagram.smartArt.nodes.find(n => n.id === id)?.editable, 'Pinned image/ambiguous node must be readonly');
    result.rejected.push(await expectRejected(async () => editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, id, 'MUST NOT APPLY', editor.revision)), 'Pinned readonly node', editor));
  }
  {
    const stale = new PresentationController(model, plan.name), diagram = find(stale.model);
    const action = await prepareSmartArtTextEdit(stale.model, diagram.id, plan.shape, 'STALE', stale.revision);
    stale.action({ type: 'set-notes', pageIndex: 0, text: 'Intervening edit' });
    result.rejected.push(await expectRejected(() => stale.action(action), 'Stale prepared action', stale));
    discardPreparedSmartArtTextEdit(action);
    eq(nodeAt(stale.model).text, plan.original, 'Stale action changed text');
    result.rejected.push(await expectRejected(() => stale.action({ type: 'update-smartart-text', id: diagram.id, nodeId: plan.shape, text: 'FORGED', expectedRevision: stale.revision, preparationId: 'not-prepared' }), 'Unprepared forged action', stale));
    for (const text of ['first\nsecond', 'first\rsecond', 'x'.repeat(1001), 'control\u0001']) result.rejected.push(await expectRejected(() => prepareSmartArtTextEdit(stale.model, diagram.id, plan.shape, text, stale.revision), 'Invalid single-line edit', stale));
  }
  {
    const revert = new PresentationController(model, plan.name), diagram = find(revert.model), preview = diagram.diagramPreview.dataUrl;
    revert.action(await prepareSmartArtTextEdit(revert.model, diagram.id, plan.shape, 'Temporary', revert.revision));
    revert.action(await prepareSmartArtTextEdit(revert.model, diagram.id, plan.shape, plan.original, revert.revision));
    eq(nodeAt(revert.model).text, plan.original, 'Reverting to original restores node text, including empty placeholders');
    check(!Object.keys(find(revert.model).smartArtEdits || {}).length, 'Reverting to original clears semantic delta');
    eq(find(revert.model).diagramPreview.dataUrl, preview, 'Reverting to original restores preview');
    result.artifacts.push({ name: 'reverted-original.pptx', base64: encode(await exportPresentation(revert.model)), compare: 'original', unchangedDiagrams: true });
    result.revertOriginal = true;
  }
  if (plan.name === 'smartart-simple.pptx') {
    const editor = new PresentationController(model, plan.name), diagram = find(editor.model), before = await sourceHashes(editor.model);
    const oldToDataURL = HTMLCanvasElement.prototype.toDataURL;
    try {
      HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,' + 'A'.repeat(6_000_001);
      const reason = await expectRejected(() => prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'Oversize preview', editor.revision), 'Oversize prepared preview', editor);
      check(/预算/.test(reason), 'Oversize preview must fail with an explicit budget reason');
      result.previewBudget = { rejected: true, reason };
    } finally { HTMLCanvasElement.prototype.toDataURL = oldToDataURL; }
    eq(await sourceHashes(editor.model), before, 'Oversize preview must not mutate source bytes');
    const secondary = { shape: '{C21E3514-2DBB-8145-BBE2-28ED23242DFE}', content: '{391B1171-DA48-964C-B79F-15538C9FA0BA}' };
    editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'Alpha', editor.revision));
    editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, secondary.shape, 'Beta', editor.revision));
    const bytes = await exportPresentation(editor.model), parts = await readPptxParts(bytes), data = read(parts.get('ppt/diagrams/data1.xml')), drawing = read(parts.get('ppt/diagrams/drawing1.xml'));
    for (const [ids, text] of [[plan, 'Alpha'], [secondary, 'Beta']]) {
      eq(textOf(one(data, D, 'pt', ids.content)), text, 'Two edits coexist in the correct data nodes');
      eq(textOf(one(drawing, DSP, 'sp', ids.shape)), text, 'Two edits coexist in the correct cached shapes');
    }
    for (const [namespace, tag, partName, targets] of [[D, 'pt', 'ppt/diagrams/data1.xml', [plan.content, secondary.content]], [DSP, 'sp', 'ppt/diagrams/drawing1.xml', [plan.shape, secondary.shape]]]) {
      const source = read(model.sourceParts.get(partName)), changed = read(parts.get(partName));
      for (const node of all(source, namespace, tag)) if (!targets.includes(node.getAttribute('modelId'))) eq(canonical(one(changed, namespace, tag, node.getAttribute('modelId'))), canonical(node), 'Multi-node edit must preserve all unrelated nodes');
    }
    const reopened = await importPresentation(bytes), nodes = find(reopened).smartArt.nodes;
    eq(nodes.find(node => node.id === plan.shape).text, 'Alpha', 'First text survives second edit and reopen');
    eq(nodes.find(node => node.id === secondary.shape).text, 'Beta', 'Second text survives reopen');
    eq(await sourceHashes(editor.model), before, 'Multi-node edits must not mutate source bytes');
    result.artifacts.push({ name: 'multi-node.pptx', base64: encode(bytes), compare: 'original', noopCompare: 'reverted-original.pptx' });
    editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, plan.original, editor.revision));
    const revertedOne = await readPptxParts(await exportPresentation(editor.model));
    eq(textOf(one(read(revertedOne.get('ppt/diagrams/data1.xml')), D, 'pt', plan.content)), plan.original, 'Revert one node restores its source text');
    eq(textOf(one(read(revertedOne.get('ppt/diagrams/data1.xml')), D, 'pt', secondary.content)), 'Beta', 'Revert one node retains the other pending edit');
    result.multiNode = true;
  }
  let previousBytes = source;
  for (let cycle = 1; cycle <= 3; cycle++) {
    console.info('SMARTART_TEXT', plan.name, 'cycle', cycle);
    const editor = new PresentationController(model, plan.name), diagram = find(editor.model), beforeText = nodeAt(editor.model).text;
    const beforePreview = diagram.diagramPreview?.dataUrl, beforeSources = await sourceHashes(editor.model);
    const text = ['Text I', '  R&D <II> "Q"  ', 'Team III'][cycle - 1];
    const action = await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, text, editor.revision);
    eq(nodeAt(editor.model).text, beforeText, 'Prepare must not mutate committed model');
    eq(editor.revision, 0, 'Prepare must not advance revision');
    eq(await sourceHashes(editor.model), beforeSources, 'Prepare must not mutate source parts');
    editor.action(action);
    eq(nodeAt(editor.model).text, text, 'Controller committed node text');
    eq(find(editor.model).smartArtEdits?.[plan.shape], text, 'Controller persisted semantic text delta');
    eq(editor.revision, 1, 'Edit is one undoable transaction');
    check(editor.dirty && editor.canUndo, 'Successful edit is dirty and undoable');
    const editedPreview = find(editor.model).diagramPreview?.dataUrl;
    check(editedPreview && editedPreview !== beforePreview, 'Committed cached preview must refresh');
    editor.undo(); eq(nodeAt(editor.model).text, beforeText, 'Undo restores text');
    eq(find(editor.model).diagramPreview?.dataUrl, beforePreview, 'Undo restores exact preview');
    const undo = await exportPresentation(editor.model);
    result.artifacts.push({ name: `undo-${cycle}.pptx`, base64: encode(undo), compare: cycle === 1 ? 'original' : `edited-${cycle - 1}.pptx`, unchangedDiagrams: true });
    editor.redo(); eq(nodeAt(editor.model).text, text, 'Redo restores text');
    eq(find(editor.model).diagramPreview?.dataUrl, editedPreview, 'Redo restores exact edited preview');
    if (cycle === 1) {
      result.rejected.push(await expectRejected(() => editor.duplicateObjects([diagram.id]), 'Copy edited diagram', editor));
      result.rejected.push(await expectRejected(() => editor.action({ type: 'duplicate-page', pageIndex: 0 }), 'Copy page containing edited diagram', editor));
    }
    const bytes = await exportPresentation(editor.model), parts = await readPptxParts(bytes), beforeParts = await readPptxParts(previousBytes);
    const oracle = assertXmlEdits(beforeParts, parts, text);
    eq(await sourceHashes(editor.model), beforeSources, 'Committed edit/export mutated immutable source parts');
    eq(nodeAt(model).text, beforeText, 'Controller changed caller source model');
    result.artifacts.push({ name: `edited-${cycle}.pptx`, base64: encode(bytes), compare: cycle === 1 ? 'original' : `edited-${cycle - 1}.pptx`, noopCompare: `undo-${cycle}.pptx` });
    const reopened = await importPresentation(bytes);
    eq(nodeAt(reopened).text, text, 'Reopen imported edited text');
    eq(nodeAt(reopened).contentId, plan.content, 'Reopen preserved target mapping');
    check(nodeAt(reopened).editable, 'Reopened edited node remains editable');
    eq(find(reopened).diagramPreview?.dataUrl, editedPreview, 'Reopened preview matches committed edit');
    const noop = await exportPresentation(reopened);
    result.artifacts.push({ name: `reopened-${cycle}.pptx`, base64: encode(noop), compare: `edited-${cycle}.pptx`, unchangedDiagrams: true });
    assertXmlEdits(beforeParts, await readPptxParts(noop), text);
    result.cycles.push({ cycle, oracle, sourceImmutable: true, undoRedo: true, previewConsistent: true, relationshipsPreserved: assertRelationships(beforeParts, parts) });
    model = reopened; previousBytes = bytes;
  }
  {
    // Clearing a saved text node is an actual edit, not restoring the original
    // untouched placeholder. Native typing leaves phldr=0 after deletion.
    const editor = new PresentationController(model, plan.name), diagram = find(editor.model);
    editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, '', editor.revision));
    const bytes = await exportPresentation(editor.model), parts = await readPptxParts(bytes);
    assertXmlEdits(model.sourceParts, parts, '');
    const point = one(read(parts.get('ppt/diagrams/data1.xml')), D, 'pt', plan.content), properties = all(point, D, 'prSet')[0];
    if (properties?.hasAttribute('phldr')) eq(properties.getAttribute('phldr'), '0', 'Clearing saved text must not recreate placeholder status');
    const reopened = await importPresentation(bytes);
    eq(nodeAt(reopened).text, '', 'Cleared saved text reopens empty');
    check(nodeAt(reopened).editable, 'Cleared saved text remains editable');
    result.artifacts.push({ name: 'cleared-after-save.pptx', base64: encode(bytes), compare: 'edited-3.pptx', noopCompare: 'reopened-3.pptx' });
    result.clearedAfterSave = true;
  }
  // A copied original diagram shares data/cache parts and cannot be text-edited.
  for (const copyPage of [false, true]) {
    const editor = new PresentationController(initial, plan.name), diagram = find(editor.model);
    if (copyPage) editor.action({ type: 'duplicate-page', pageIndex: 0 }); else editor.duplicateObjects([diagram.id]);
    result.rejected.push(await expectRejected(() => prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'SHARED', editor.revision), 'Shared copied diagram', editor));
    if (copyPage) {
      const bytes = await exportPresentation(editor.model), reopened = await importPresentation(bytes);
      eq(reopened.slides.length, 2, 'Whole-page copy survives export');
      check(reopened.slides.every(slide => slide.objects.some(object => object.diagramPreview)), 'Whole-page copy retains both cached previews after reopen');
      result.artifacts.push({ name: 'copied-page.pptx', base64: encode(bytes), compare: 'original', unchangedDiagrams: true, changedRelations: ['ppt/_rels/presentation.xml.rels'] });
      editor.action({ type: 'delete-page', pageIndex: 1 });
      editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'Editable after removal', editor.revision));
      eq(nodeAt(editor.model).text, 'Editable after removal', 'Removing copied page restores editability');
    }
  }
  {
    const editor = new PresentationController(initial, plan.name), diagram = find(editor.model), clipboard = editor.copyObjects([diagram.id]);
    editor.action(await prepareSmartArtTextEdit(editor.model, diagram.id, plan.shape, 'Changed after copy', editor.revision));
    result.rejected.push(await expectRejected(() => editor.pasteObjects(clipboard), 'Paste stale snapshot after original edit', editor));
    const otherPage = new PresentationController(initial, plan.name), old = find(otherPage.model), copy = otherPage.copyObjects([old.id]);
    otherPage.action({ type: 'add-page', layout: 20 });
    result.rejected.push(await expectRejected(() => otherPage.pasteObjects(copy), 'Paste diagram object on different page', otherPage));
  }
  document.body.innerHTML = slideSvg(model, model.slides[0], { width: 1200, height: 800 });
  document.body.style.cssText = 'margin:0;background:white';
  check(document.querySelectorAll('svg image').length > 0, 'Final slide uses refreshed cached image');
  result.finalPreview = find(model).diagramPreview.dataUrl.split(',')[1];
  return result;
}

function compareParts(original, output, wholeDiagram = false, changedRelations = []) {
  const before = unzipSync(original), after = unzipSync(output);
  const editable = new Set(['ppt/diagrams/data1.xml', 'ppt/diagrams/drawing1.xml']);
  const names = Object.keys(before).filter(n => n.startsWith('ppt/media/') || n.startsWith('ppt/diagrams/') || n.startsWith('ppt/theme/') || n.startsWith('ppt/slideLayouts/') || n.startsWith('ppt/slideMasters/') || n.endsWith('.rels'));
  const checked = [];
  for (const name of names) {
    if (!wholeDiagram && editable.has(name)) continue;
    if (changedRelations.includes(name)) continue;
    // Existing package writer reserializes these general relationship files.
    // Their semantic identity is independently asserted in the browser above.
    if (name === '_rels/.rels' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/_rels\//.test(name)) continue;
    assert.equal(sha(after[name] || []), sha(before[name]), `Unrelated package part changed: ${name}`); checked.push(name);
  }
  return checked;
}
function compareNoop(noop, edited) {
  const before = unzipSync(noop), after = unzipSync(edited);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'Text editing must not create/delete package parts');
  const changed = Object.keys(before).filter(name => sha(before[name]) !== sha(after[name]));
  assert.deepEqual(changed.sort(), ['ppt/diagrams/data1.xml', 'ppt/diagrams/drawing1.xml']);
  return changed;
}

// Exact fixture mutations are intentionally independent of the implementation.
const DATA = 'ppt/diagrams/data1.xml', DRAW = 'ppt/diagrams/drawing1.xml';
function replace(parts, name, before, after) {
  const xml = strFromU8(parts[name]); assert.ok(xml.includes(before), `Mutation anchor missing: ${name} ${before}`);
  parts[name] = strToU8(xml.replace(before, after));
}
function block(xml, tag, id) {
  const start = xml.indexOf(`<${tag} modelId="${id}"`); assert.ok(start >= 0, `Block ${id} missing`);
  const end = xml.indexOf(`</${tag}>`, start) + tag.length + 3; assert.ok(end > start);
  return xml.slice(start, end);
}
function adversarialCases() {
  const target = plans[0];
  const sharedSlide = parts => {
    parts['ppt/slides/slide2.xml'] = parts['ppt/slides/slide1.xml'].slice();
    parts['ppt/slides/_rels/slide2.xml.rels'] = parts['ppt/slides/_rels/slide1.xml.rels'].slice();
    replace(parts, 'ppt/presentation.xml', '</p:sldIdLst>', '<p:sldId id="257" r:id="rIdSmartArtShared"/></p:sldIdLst>');
    replace(parts, 'ppt/_rels/presentation.xml.rels', '</Relationships>', '<Relationship Id="rIdSmartArtShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>');
    replace(parts, '[Content_Types].xml', '</Types>', '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  };
  return [
    ['duplicate-data-id', parts => { const xml = strFromU8(parts[DATA]); replace(parts, DATA, '</dgm:ptLst>', `${block(xml, 'dgm:pt', target.content)}</dgm:ptLst>`); }],
    ['duplicate-cache-id', parts => { const xml = strFromU8(parts[DRAW]); replace(parts, DRAW, '</dsp:spTree>', `${block(xml, 'dsp:sp', target.shape)}</dsp:spTree>`); }],
    ['ambiguous-presOf', parts => replace(parts, DATA, '</dgm:cxnLst>', `<dgm:cxn modelId="{00000000-0000-0000-0000-000000000001}" type="presOf" srcId="{391B1171-DA48-964C-B79F-15538C9FA0BA}" destId="${target.shape}" srcOrd="0" destOrd="0"/></dgm:cxnLst>`)],
    ['contradictory-presAssoc', parts => replace(parts, DATA, `presAssocID="${target.content}" presName="circ1"`, 'presAssocID="{391B1171-DA48-964C-B79F-15538C9FA0BA}" presName="circ1"')],
    ['external-data', parts => replace(parts, 'ppt/slides/_rels/slide1.xml.rels', 'Target="../diagrams/data1.xml"', 'Target="https://example.invalid/never-fetch-data.xml" TargetMode="External"')],
    ['external-cache', parts => replace(parts, 'ppt/slides/_rels/slide1.xml.rels', 'Target="../diagrams/drawing1.xml"', 'Target="https://example.invalid/never-fetch-cache.xml" TargetMode="External"')],
    ['external-image', parts => replace(parts, 'ppt/diagrams/_rels/drawing1.xml.rels', 'Target="../media/image1.jpeg"', 'Target="https://example.invalid/never-fetch-image.jpeg" TargetMode="External"')],
    ['missing-cache', parts => { delete parts[DRAW]; }],
    ['text-cache-mismatch', parts => replace(parts, DRAW, '>abc</a:t>', '>different</a:t>')],
    ['data-field', parts => { const xml = strFromU8(parts[DATA]), node = block(xml, 'dgm:pt', target.content), run = node.match(/<a:r>.*?<\/a:r>/)[0]; replace(parts, DATA, node, node.replace(run, `<a:fld id="{00000000-0000-0000-0000-000000000002}" type="slidenum"><a:rPr/><a:t>abc</a:t></a:fld>`)); }],
    ['cache-field', parts => { const xml = strFromU8(parts[DRAW]), node = block(xml, 'dsp:sp', target.shape), run = node.match(/<a:r>.*?<\/a:r>/)[0]; replace(parts, DRAW, node, node.replace(run, `<a:fld id="{00000000-0000-0000-0000-000000000003}" type="slidenum"><a:rPr/><a:t>abc</a:t></a:fld>`)); }],
    ['multi-run-data', parts => { const xml = strFromU8(parts[DATA]), node = block(xml, 'dgm:pt', target.content); replace(parts, DATA, node, node.replace('</a:r>', '</a:r><a:r><a:rPr b="1"/><a:t>rich</a:t></a:r>')); }],
    ['multi-paragraph-cache', parts => { const xml = strFromU8(parts[DRAW]), node = block(xml, 'dsp:sp', target.shape); replace(parts, DRAW, node, node.replace('</dsp:txBody>', '<a:p><a:r><a:t>second paragraph</a:t></a:r></a:p></dsp:txBody>')); }],
    ...['p', 'r', 't'].map(tag => [`foreign-namespace-${tag}`, parts => {
      const xml = strFromU8(parts[DATA]), node = block(xml, 'dgm:pt', target.content);
      replace(parts, DATA, node, node.replace(new RegExp(`<a:${tag}(?=[ >])`, 'g'), `<foreign:${tag} xmlns:foreign="urn:test:foreign"`).replaceAll(`</a:${tag}>`, `</foreign:${tag}>`));
    }]),
    ['image-target', parts => {}, { shape: '{B0DF3F4E-A375-EB49-AB27-EE2F66D1C44E}' }],
    ['shared-parts-two-slides', sharedSlide],
    ['shared-cache-separate-data', parts => {
      sharedSlide(parts); parts['ppt/diagrams/data2.xml'] = parts[DATA].slice();
      replace(parts, 'ppt/slides/_rels/slide2.xml.rels', 'Target="../diagrams/data1.xml"', 'Target="../diagrams/data2.xml"');
      replace(parts, '[Content_Types].xml', '</Types>', '<Override PartName="/ppt/diagrams/data2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/></Types>');
    }],
    ['shared-same-slide-relation', parts => {
      const key = 'ppt/slides/slide1.xml', xml = strFromU8(parts[key]), frame = xml.match(/<p:graphicFrame>.*?<\/p:graphicFrame>/)[0];
      replace(parts, key, '</p:spTree>', `${frame.replace('<p:cNvPr id="4"', '<p:cNvPr id="500"')}</p:spTree>`);
    }],
    ['shared-cache-unparsed-second-data', parts => {
      const key = 'ppt/slides/slide1.xml', xml = strFromU8(parts[key]), frame = xml.match(/<p:graphicFrame>.*?<\/p:graphicFrame>/)[0];
      replace(parts, key, '</p:spTree>', `${frame.replace('<p:cNvPr id="4"', '<p:cNvPr id="500"').replace('r:dm="rId2"', 'r:dm="rIdSecondData"')}</p:spTree>`);
      parts['ppt/diagrams/data2.xml'] = parts[DATA].slice();
      replace(parts, 'ppt/diagrams/data2.xml', 'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"', 'xmlns:dgm="urn:test:unknown-diagram"');
      replace(parts, 'ppt/slides/_rels/slide1.xml.rels', '</Relationships>', '<Relationship Id="rIdSecondData" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data2.xml"/></Relationships>');
      replace(parts, '[Content_Types].xml', '</Types>', '<Override PartName="/ppt/diagrams/data2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/></Types>');
    }],
  ];
}

(async () => {
  let browser;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(suite, 'manifest.json'), 'utf8'));
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('console', message => { if (message.text().startsWith('SMARTART_TEXT')) console.log(message.text()); });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route('**/*', route => { const request = route.request().url(); if (/^https?:/.test(request) && new URL(request).origin !== new URL(url).origin) { report.externalRequests.push(request); return route.abort(); } return route.continue(); });
    await page.goto(url);
    const run = async payload => {
      let timer;
      try { return await Promise.race([page.evaluate(exercise, payload), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SmartArt browser operation exceeded 90 seconds')), 90_000); })]); }
      finally { clearTimeout(timer); }
    };
    for (const plan of plans) {
      const entry = manifest.items.find(item => path.basename(item.path) === plan.name), source = fs.readFileSync(path.join(suite, entry.path));
      assert.equal(sha(source), entry.sha256, 'Upstream fixture changed'); assert.equal(source.length, entry.bytes);
      const directory = path.join(out, entry.id); fs.mkdirSync(directory, { recursive: true });
      const result = await run({ base64: source.toString('base64'), plan });
      const artifacts = new Map([['original', source]]);
      for (const artifact of result.artifacts) {
        const bytes = Buffer.from(artifact.base64, 'base64'); delete artifact.base64;
        fs.writeFileSync(path.join(directory, artifact.name), bytes); artifacts.set(artifact.name, bytes);
        if (artifact.name === 'edited-1.pptx') fs.writeFileSync(path.join(directory, 'edited.pptx'), bytes);
        if (artifact.name === 'edited-3.pptx') fs.writeFileSync(path.join(directory, 'edited-cycle-3.pptx'), bytes);
      }
      for (const artifact of result.artifacts) {
        const bytes = artifacts.get(artifact.name);
        artifact.preservedParts = compareParts(artifacts.get(artifact.compare), bytes, artifact.unchangedDiagrams, artifact.changedRelations);
        if (artifact.noopCompare) artifact.changedFromNoop = compareNoop(artifacts.get(artifact.noopCompare), bytes);
      }
      fs.writeFileSync(path.join(directory, 'preview.png'), Buffer.from(result.finalPreview, 'base64')); delete result.finalPreview;
      await page.screenshot({ path: path.join(directory, 'slide.png') });
      report.fixtures.push({ name: plan.name, id: entry.id, sha256: entry.sha256, ...result });
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      console.log('PASS', plan.name, '3 edited round trips');
    }
    const original = fs.readFileSync(path.join(suite, 'fixtures/upstream/apache-poi/smartart-simple.pptx'));
    for (const [name, mutate, target = {}] of adversarialCases()) {
      const parts = unzipSync(original); mutate(parts); const source = Buffer.from(zipSync(parts));
      const directory = path.join(out, 'adversarial', name); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'source.pptx'), source);
      const result = await run({ base64: source.toString('base64'), plan: { ...plans[0], ...target, name }, adversarial: true });
      const exported = Buffer.from(result.artifacts[0].base64, 'base64'); fs.writeFileSync(path.join(directory, 'preserved.pptx'), exported);
      report.adversarial.push({ name, reason: result.reason, rejected: result.rejected, preservedParts: compareParts(source, exported, true) });
      console.log('PASS', name, 'readonly with original bytes preserved');
    }
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []);
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); }
})();
