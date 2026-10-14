/* Independent regression for parent-owned layouts whose text belongs to a child.
 * Every content/cache GUID is pinned from the unmodified Apache POI fixture.
 * The oracle never reimplements the production SmartArt mapping algorithm. */
const { chromium } = require('playwright');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const suite = path.join(root, 'tests/compatibility/presentation-complex');
const out = path.resolve(root, process.env.SMARTART_CHILD_OUTPUT || 'test-results/smartart-child-text');
const url = process.env.PRESENTATION_COMPLEX_URL || 'http://127.0.0.1:5198/';
const DATA = 'ppt/diagrams/data1.xml', DRAW = 'ppt/diagrams/drawing1.xml';
const target = { content: '{4B8CF4D2-89EC-1B47-AC03-D01035EB640C}', shape: '{61DE9095-EDBC-BD41-B4E7-31F95E7FE489}',
  parent: '{DD222F8A-487E-1E41-BC99-A4B3A9454AE8}', parentShape: '{BFEB60DC-A0D1-B24C-974A-57B1766297E1}', parentText: 'ghi', original: 'jkl',
  parentEdge: '{70B25E89-4FCA-5F4C-894C-A1AECBAF9FC6}', rootEdge: '{5DCE9A82-D7B3-6B4E-92DE-2F57C538374B}' };
const emptyChildren = [
  { name: 'empty-child-first', content: '{BD2DEA4A-6202-694D-ADDB-C2AAF327D779}', shape: '{2FF32C31-9A47-524C-B714-6E3CE2235063}',
    parent: '{384819B8-B852-9242-9D86-5CC9197F7C3F}', parentShape: '{15B6B5E2-4746-1B4C-A555-F2DFA0E39D18}', parentText: 'abc', original: '' },
  { name: 'empty-child-second', content: '{6A0C33B6-D22F-8643-8E86-68D16D8B42E3}', shape: '{9C3E4401-9A92-B24E-A3BE-AA1399D518C6}',
    parent: '{6BDCB66F-47FE-CB4E-A273-833386179680}', parentShape: '{7A2BDDAA-32E5-A248-B1BF-0EE0667C4B74}', parentText: 'def', original: '' },
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'Single-line child text in a parent-owned SmartArt layout; exact child data and cache updates without altering parent text, layout, styles or relationships.', fixtures: [], adversarial: [], externalRequests: [], pageErrors: [] };
fs.mkdirSync(out, { recursive: true });

async function exercise({ base64, plan, readonly }) {
  const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
  const { PresentationController } = await import('/src/presentation/core/model.ts');
  const { prepareSmartArtTextEdit } = await import('/src/presentation/core/smartart-text.ts');
  const { readPptxParts } = await import('/src/presentation/pptx-package.ts');
  const { slideSvg } = await import('/src/presentation/core/render.ts');
  const D = 'http://schemas.openxmlformats.org/drawingml/2006/diagram', A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram', PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text); };
  const check = (value, message) => { if (!value) throw Error(`${plan.name}: ${message}`); };
  const eq = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  const parse = bytes => { const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml'); check(!doc.querySelector('parsererror'), 'Oracle XML parse failed'); return doc; };
  const all = (node, ns, name) => [...node.getElementsByTagNameNS(ns, name)];
  const byId = (node, ns, tag, id) => { const nodes = all(node, ns, tag).filter(n => n.getAttribute('modelId') === id); eq(nodes.length, 1, `Pinned ${tag} ${id} must be unique`); return nodes[0]; };
  const text = node => all(node, A, 't').map(n => n.textContent).join('');
  const canonical = node => node.nodeType === 3 ? ['#text', node.nodeValue] : node.nodeType !== 1 ? null : [node.namespaceURI, node.localName,
    [...node.attributes].filter(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map(a => [a.namespaceURI || '', a.localName, a.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [...node.childNodes].map(canonical).filter(x => x !== null)];
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const snapshot = model => Promise.all([...model.sourceParts].map(async ([name, bytes]) => [name, await digest(bytes)]));
  const diagram = model => model.slides[0].objects.find(object => object.smartArt || object.sourceXml?.includes('graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"'));
  const node = model => diagram(model)?.smartArt?.nodes.find(n => n.id === plan.shape);
  function relationships(before, after) {
    let count = 0;
    for (const [name, bytes] of before) if (name.endsWith('.rels')) {
      const values = data => all(parse(data), PR, 'Relationship').map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      eq(values(bytes), values(after.get(name)), `Relationship semantics changed: ${name}`); count++;
    }
    return count;
  }
  function verify(before, after, expectedText) {
    const data0 = parse(before.get('ppt/diagrams/data1.xml')), data1 = parse(after.get('ppt/diagrams/data1.xml'));
    const cache0 = parse(before.get('ppt/diagrams/drawing1.xml')), cache1 = parse(after.get('ppt/diagrams/drawing1.xml'));
    eq(text(byId(data1, D, 'pt', plan.content)), expectedText, 'Only the pinned child content owns the new text');
    eq(text(byId(cache1, DSP, 'sp', plan.shape)), expectedText, 'Only the pinned child cache displays the new text');
    eq(text(byId(data1, D, 'pt', plan.parent)), plan.parentText, 'Parent content text must not change');
    eq(text(byId(cache1, DSP, 'sp', plan.parentShape)), plan.parentText, 'Parent cached text must not change');
    let unchangedNodes = 0;
    for (const [oldDoc, newDoc, ns, tag, targetId] of [[data0, data1, D, 'pt', plan.content], [cache0, cache1, DSP, 'sp', plan.shape]]) {
      const oldNodes = all(oldDoc, ns, tag), newNodes = all(newDoc, ns, tag);
      eq(newNodes.map(n => n.getAttribute('modelId')), oldNodes.map(n => n.getAttribute('modelId')), 'Node order/IDs preserved');
      oldNodes.forEach((entry, i) => { if (entry.getAttribute('modelId') !== targetId) { eq(canonical(newNodes[i]), canonical(entry), `Unrelated ${tag} ${entry.getAttribute('modelId')} changed`); unchangedNodes++; } });
    }
    const withoutTextBody = (entry, ns, tag) => { const copy = entry.cloneNode(true); all(copy, ns, tag).forEach(n => n.remove()); all(copy, D, 'prSet').forEach(n => n.removeAttribute('phldr')); return canonical(copy); };
    const content0 = byId(data0, D, 'pt', plan.content), content1 = byId(data1, D, 'pt', plan.content);
    const shape0 = byId(cache0, DSP, 'sp', plan.shape), shape1 = byId(cache1, DSP, 'sp', plan.shape);
    eq(withoutTextBody(content1, D, 't'), withoutTextBody(content0, D, 't'), 'Child non-text properties preserved');
    eq(withoutTextBody(shape1, DSP, 'txBody'), withoutTextBody(shape0, DSP, 'txBody'), 'Child geometry, rotation and styles preserved');
    eq(all(data1, D, 'cxn').map(canonical), all(data0, D, 'cxn').map(canonical), 'All connection/parent mappings preserved');
    for (const [oldNode, newNode] of [[content0, content1], [shape0, shape1]]) {
      for (const tag of ['bodyPr', 'lstStyle', 'pPr', 'endParaRPr']) eq(all(newNode, A, tag).map(canonical), all(oldNode, A, tag).map(canonical), `${tag} preserved`);
      if (all(oldNode, A, 'r').length) eq(all(newNode, A, 'rPr').map(canonical), all(oldNode, A, 'rPr').map(canonical), 'Existing run formatting preserved');
    }
    return { text: expectedText, childContentId: plan.content, childShapeId: plan.shape, parentContentId: plan.parent, parentText: plan.parentText, unchangedNodes, relationships: relationships(before, after) };
  }
  async function rejection(editor, shapeId, label) {
    const before = JSON.stringify(editor.model.slides), revision = editor.revision;
    let reason; try { editor.action(await prepareSmartArtTextEdit(editor.model, diagram(editor.model).id, shapeId, 'MUST NOT APPLY', revision)); } catch (error) { reason = String(error.message || error); }
    check(reason, `${label} must reject`); eq(JSON.stringify(editor.model.slides), before, `${label} changed model`); eq(editor.revision, revision, `${label} changed revision`);
    return reason;
  }
  let bytes = decode(base64), model = await importPresentation(bytes);
  const result = { name: plan.name, target: plan, artifacts: [], cycles: [] };
  if (readonly) {
    const editor = new PresentationController(model, plan.name), before = await snapshot(editor.model), object = diagram(editor.model);
    check(!node(editor.model)?.editable || object?.smartArt?.blockedReason, 'Invalid parent association must be readonly');
    result.reason = await rejection(editor, plan.shape, 'Invalid parent relation');
    const output = await exportPresentation(editor.model);
    eq(await snapshot(editor.model), before, 'Rejected edit/export mutated source parts');
    result.relationships = relationships(model.sourceParts, await readPptxParts(output));
    result.artifacts.push({ name: 'preserved.pptx', base64: encode(output) });
    return result;
  }
  check(node(model)?.editable && !diagram(model).smartArt.blockedReason, 'Valid parent-owned child must be editable');
  eq(node(model).contentId, plan.content, 'Production importer must target pinned child, not its layout parent');
  eq(node(model).text, plan.original, 'Original child text');
  result.transitionReadonly = [];
  for (const id of ['{A4BB3F1F-9010-404F-86A5-6BF140861DAF}', '{B038CF37-EA5B-C049-A232-BA28E45E8BB4}', '{EB4C1DEF-62C2-1646-B59E-E05DC4252D96}']) {
    const editor = new PresentationController(model, plan.name);
    check(!diagram(editor.model).smartArt.nodes.find(n => n.id === id)?.editable, 'sibTrans text remains readonly');
    result.transitionReadonly.push({ id, reason: await rejection(editor, id, 'Sibling transition node') });
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    console.log('SMARTART_CHILD', plan.name, 'cycle', cycle);
    const editor = new PresentationController(model, plan.name), object = diagram(editor.model), oldPreview = object.diagramPreview.dataUrl;
    const originalSources = await snapshot(editor.model), originalText = node(editor.model).text;
    const value = plan.original ? ['XYZ', ' A&B ', 'QRS'][cycle - 1] : ['KidA', 'KidB', 'KidC'][cycle - 1];
    const noop = await exportPresentation(editor.model);
    result.artifacts.push({ name: `noop-${cycle}.pptx`, base64: encode(noop), compare: cycle === 1 ? 'source.pptx' : `edited-${cycle - 1}.pptx`, unchangedDiagrams: true });
    const action = await prepareSmartArtTextEdit(editor.model, object.id, plan.shape, value, editor.revision);
    eq(node(editor.model).text, originalText, 'Preparation must not mutate document');
    editor.action(action); eq(node(editor.model).text, value, 'Committed child text');
    const preview = diagram(editor.model).diagramPreview.dataUrl;
    check(preview !== oldPreview, 'Changing child text refreshes preview');
    editor.undo(); eq(node(editor.model).text, originalText, 'Undo restores child text'); eq(diagram(editor.model).diagramPreview.dataUrl, oldPreview, 'Undo restores preview');
    editor.redo(); eq(node(editor.model).text, value, 'Redo restores child text'); eq(diagram(editor.model).diagramPreview.dataUrl, preview, 'Redo restores child preview');
    const output = await exportPresentation(editor.model), parts = await readPptxParts(output), beforeParts = await readPptxParts(bytes);
    const oracle = verify(beforeParts, parts, value);
    eq(await snapshot(editor.model), originalSources, 'Committed child edit/export mutated immutable source parts');
    const reopened = await importPresentation(output);
    eq(node(reopened).text, value, 'Reopen preserves child text'); eq(node(reopened).contentId, plan.content, 'Reopen preserves child mapping');
    check(node(reopened).editable && !diagram(reopened).smartArt.blockedReason, 'Child remains editable after reopen');
    eq(diagram(reopened).diagramPreview.dataUrl, preview, 'Reopened child preview matches edited preview');
    result.artifacts.push({ name: `edited-${cycle}.pptx`, base64: encode(output), compare: cycle === 1 ? 'source.pptx' : `edited-${cycle - 1}.pptx`, noopCompare: `noop-${cycle}.pptx` });
    result.cycles.push({ cycle, oracle, undoRedo: true, immutableSource: true, consistentPreview: true });
    bytes = output; model = reopened;
  }
  document.body.innerHTML = slideSvg(model, model.slides[0], { width: 1200, height: 800 });
  document.body.style.cssText = 'margin:0;background:white';
  result.finalPreview = diagram(model).diagramPreview.dataUrl.split(',')[1];
  return result;
}

function replace(parts, name, before, after) {
  const xml = strFromU8(parts[name]); assert.ok(xml.includes(before), `Mutation anchor missing: ${name} ${before}`); parts[name] = strToU8(xml.replace(before, after));
}
function point(parts, id) {
  const xml = strFromU8(parts[DATA]), start = xml.indexOf(`<dgm:pt modelId="${id}"`), end = xml.indexOf('</dgm:pt>', start);
  assert.ok(start >= 0 && end > start, `Point ${id} absent`); return xml.slice(start, end + 9);
}
function connection(parts, id) {
  const xml = strFromU8(parts[DATA]), start = xml.indexOf(`<dgm:cxn modelId="${id}"`), end = xml.indexOf('/>', start);
  assert.ok(start >= 0 && end > start, `Connection ${id} absent`); return xml.slice(start, end + 2);
}
const ABC = '{384819B8-B852-9242-9D86-5CC9197F7C3F}', ABC_ROOT = '{E72E2B02-F1B6-6148-88C5-1A147F6AC3E5}';
const edge = (id, src, dst) => `<dgm:cxn modelId="{00000000-0000-0000-0000-${String(id).padStart(12, '0')}}" type="parOf" srcId="${src}" destId="${dst}" srcOrd="0" destOrd="0"/>`;
const addEdge = (parts, value) => replace(parts, DATA, '</dgm:cxnLst>', `${value}</dgm:cxnLst>`);
function cases() {
  return [
    ['unrelated-presAssoc', parts => { const p = point(parts, target.shape); replace(parts, DATA, p, p.replace(`presAssocID="${target.parent}"`, `presAssocID="${ABC}"`)); }],
    ['multiple-content-parents', parts => addEdge(parts, edge(1, ABC, target.content))],
    ['duplicate-content-parent-edge', parts => addEdge(parts, edge(2, target.parent, target.content))],
    ['multiple-ancestor-parents', parts => addEdge(parts, edge(3, ABC, target.parent))],
    ['duplicate-ancestor-parent-edge', parts => { const c = connection(parts, target.rootEdge); addEdge(parts, c.replace(`modelId="${target.rootEdge}"`, 'modelId="{00000000-0000-0000-0000-000000000004}"')); }],
    ['reversed-parent-edge', parts => { const c = connection(parts, target.parentEdge); replace(parts, DATA, c, c.replace(`srcId="${target.parent}" destId="${target.content}"`, `srcId="${target.content}" destId="${target.parent}"`)); }],
    ['two-node-cycle', parts => { replace(parts, DATA, connection(parts, target.rootEdge), ''); addEdge(parts, edge(5, target.content, target.parent)); }],
    ['three-node-cycle', parts => { replace(parts, DATA, connection(parts, target.rootEdge), ''); replace(parts, DATA, connection(parts, ABC_ROOT), ''); addEdge(parts, edge(6, target.content, ABC)); addEdge(parts, edge(7, ABC, target.parent)); }],
    ['missing-parent-edge', parts => replace(parts, DATA, connection(parts, target.parentEdge), '')],
    ['presentation-parent-is-not-content-parent', parts => { const c = connection(parts, target.parentEdge); replace(parts, DATA, c, c.replace('<dgm:cxn ', '<dgm:cxn type="presParOf" ')); }],
    ['duplicate-child-presOf', parts => { const id = '{7127870B-4491-3143-8E84-11F27DD78134}', c = connection(parts, id); addEdge(parts, c.replace(`modelId="${id}"`, 'modelId="{00000000-0000-0000-0000-000000000008}"')); }],
    ['foreign-parent-connection', parts => { const c = connection(parts, target.parentEdge); replace(parts, DATA, c, c.replace('<dgm:cxn ', '<foreign:cxn xmlns:foreign="urn:test:wrong-diagram" ')); }],
    ['foreign-ancestor-connection', parts => { const c = connection(parts, target.rootEdge); replace(parts, DATA, c, c.replace('<dgm:cxn ', '<foreign:cxn xmlns:foreign="urn:test:wrong-diagram" ')); }],
    ['foreign-association-properties', parts => { const p = point(parts, target.shape); replace(parts, DATA, p, p.replace('<dgm:prSet ', '<foreign:prSet xmlns:foreign="urn:test:wrong-diagram" ').replace('</dgm:prSet>', '</foreign:prSet>')); }],
    ['non-content-layout-parent', parts => { const p = point(parts, target.parent); replace(parts, DATA, p, p.replace(`<dgm:pt modelId="${target.parent}"`, `<dgm:pt type="sibTrans" modelId="${target.parent}"`)); }],
  ];
}
function preserveParts(beforeBytes, afterBytes, wholeDiagrams = false) {
  const before = unzipSync(beforeBytes), after = unzipSync(afterBytes), checked = [];
  for (const name of Object.keys(before)) {
    if (!/^ppt\/(?:diagrams|media|theme|slideMasters|slideLayouts)\//.test(name)) continue;
    if (!wholeDiagrams && [DATA, DRAW].includes(name)) continue;
    assert.equal(sha(after[name] || []), sha(before[name]), `Unrelated original part changed: ${name}`); checked.push(name);
  }
  return checked;
}
function compareNoop(noop, edited) {
  const before = unzipSync(noop), after = unzipSync(edited);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'A child text edit may not create/delete parts');
  const changed = Object.keys(before).filter(name => sha(before[name]) !== sha(after[name])).sort();
  assert.deepEqual(changed, [DATA, DRAW]); return changed;
}
(async () => {
  let browser;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(suite, 'manifest.json'), 'utf8'));
    const entry = manifest.items.find(item => item.id === 'poi-smartart-alternating-hexagons'), original = fs.readFileSync(path.join(suite, entry.path));
    assert.equal(sha(original), entry.sha256); assert.equal(original.length, entry.bytes);
    report.source = { path: entry.path, sha256: entry.sha256, bytes: entry.bytes, provenance: entry.provenance };
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('console', message => { if (message.text().startsWith('SMARTART_CHILD')) console.log(message.text()); });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route('**/*', route => { const request = route.request().url(); if (/^https?:/.test(request) && new URL(request).origin !== new URL(url).origin) { report.externalRequests.push(request); return route.abort(); } return route.continue(); });
    await page.goto(url);
    const run = async payload => { let timer; try { return await Promise.race([page.evaluate(exercise, payload), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SmartArt child test exceeded 90 seconds')), 90_000); })]); } finally { clearTimeout(timer); } };
    const positive = [{ ...target, name: 'implicit-parOf' }, { ...target, name: 'explicit-parOf' }, ...emptyChildren, { ...target, name: 'child-and-parent-have-same-text', original: 'ghi' }];
    for (const plan of positive) {
      let source = original;
      if (plan.name === 'explicit-parOf') {
        const parts = unzipSync(original), xml = strFromU8(parts[DATA]);
        let changed = 0;
        parts[DATA] = strToU8(xml.replace(/<dgm:cxn\b[^>]*\/>/g, tag => { if (/\stype=/.test(tag)) return tag; changed++; return tag.replace('<dgm:cxn ', '<dgm:cxn type="parOf" '); }));
        assert.equal(changed, 6, 'Pinned fixture has six implicit content-tree parent edges'); source = Buffer.from(zipSync(parts));
      }
      if (plan.name === 'child-and-parent-have-same-text') {
        const parts = unzipSync(original); replace(parts, DATA, '>jkl</a:t>', '>ghi</a:t>'); replace(parts, DRAW, '>jkl</a:t>', '>ghi</a:t>'); source = Buffer.from(zipSync(parts));
      }
      const directory = plan.name === 'implicit-parOf' ? path.join(out, entry.id) : path.join(out, 'cases', plan.name); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'source.pptx'), source);
      const result = await run({ base64: source.toString('base64'), plan });
      const artifacts = new Map([['source.pptx', source]]);
      for (const artifact of result.artifacts) { const bytes = Buffer.from(artifact.base64, 'base64'); delete artifact.base64; artifacts.set(artifact.name, bytes); fs.writeFileSync(path.join(directory, artifact.name), bytes); }
      for (const artifact of result.artifacts) {
        artifact.preservedParts = preserveParts(artifacts.get(artifact.compare), artifacts.get(artifact.name), artifact.unchangedDiagrams);
        if (artifact.noopCompare) artifact.changedFromNoop = compareNoop(artifacts.get(artifact.noopCompare), artifacts.get(artifact.name));
      }
      fs.copyFileSync(path.join(directory, 'edited-1.pptx'), path.join(directory, 'edited.pptx'));
      fs.copyFileSync(path.join(directory, 'edited-3.pptx'), path.join(directory, 'edited-cycle-3.pptx'));
      if (plan.name === 'empty-child-first') fs.copyFileSync(path.join(directory, 'edited-1.pptx'), path.join(out, entry.id, 'empty-child-edited.pptx'));
      fs.writeFileSync(path.join(directory, 'preview.png'), Buffer.from(result.finalPreview, 'base64')); delete result.finalPreview;
      await page.screenshot({ path: path.join(directory, 'slide.png') });
      report.fixtures.push({ id: entry.id, directory: path.relative(out, directory), ...result });
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('PASS', plan.name, '3 cycles, parent unchanged, transitions readonly');
    }
    for (const [name, mutate] of cases()) {
      const parts = unzipSync(original); mutate(parts); const source = Buffer.from(zipSync(parts)), directory = path.join(out, 'adversarial', name); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'source.pptx'), source);
      const result = await run({ base64: source.toString('base64'), plan: { ...target, name }, readonly: true });
      const preserved = Buffer.from(result.artifacts[0].base64, 'base64'); fs.writeFileSync(path.join(directory, 'preserved.pptx'), preserved);
      report.adversarial.push({ name, reason: result.reason, relationships: result.relationships, preservedParts: preserveParts(source, preserved, true) });
      console.log('PASS', name, 'readonly');
    }
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []); report.ok = true;
  } catch (error) { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); }
})();
