/* Complex PPTX preservation, semantic and screen checks are separate evidence.
 * Uses one real Chromium page, production codecs and the real Vue application.
 * Source packages come from the independent fixture manifest, not this editor.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { unzipSync } = require('fflate');

const root = path.resolve(__dirname, '../..');
const manifestFile = path.resolve(process.env.PRESENTATION_COMPLEX_MANIFEST || path.join(root, 'tests/compatibility/presentation-complex/manifest.json'));
const out = path.resolve(process.env.PRESENTATION_COMPLEX_OUTPUT || path.join(root, 'test-results/standalone-presentation-complex'));
const url = process.env.PRESENTATION_COMPLEX_URL || 'http://127.0.0.1:5198/';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'Independent complex PPTX fixtures: package preservation, production-model semantics and actual Vue screenshots recorded separately',
  okMeaning: 'All declared preservation, semantic and edit-safety assertions passed; this is not a claim of full visual fidelity or playback support.',
  limitations: ['Preserved XML is not evidence of complete rendering or playback.', 'Screenshots show the implemented editor rendering; no PowerPoint pixel-equivalence claim.', 'Browser verification does not replace packaged native WebView validation.'],
  startedAt: new Date().toISOString(), fixtures: [], pageErrors: [], consoleErrors: [], externalRequests: [], officeRuntimeRequests: [], checks: [] };
let browser, page, phase = 'startup';
fs.mkdirSync(out, { recursive: true });
const persist = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const glob = pattern => new RegExp('^' + pattern.split('**').map(chunk => chunk.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
function packageDifference(beforeBytes, afterBytes, preserve = []) {
  const before = unzipSync(beforeBytes), after = unzipSync(afterBytes), changed = [], removed = [], added = [];
  for (const [name, value] of Object.entries(before)) {
    if (!after[name]) removed.push(name);
    else if (sha256(value) !== sha256(after[name])) changed.push({ name, beforeSha256: sha256(value), afterSha256: sha256(after[name]), beforeBytes: value.length, afterBytes: after[name].length });
  }
  for (const name of Object.keys(after)) if (!before[name]) added.push(name);
  const patterns = preserve.map(glob), protectedChanges = [...changed.map(item => item.name), ...removed].filter(name => patterns.some(pattern => pattern.test(name)));
  return { beforeParts: Object.keys(before).length, afterParts: Object.keys(after).length, unchangedParts: Object.keys(before).length - changed.length - removed.length,
    changed, removed, added, protectedChanges };
}

async function exerciseCore(input) {
  const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
  const { PresentationController } = await import('/src/presentation/core/model.ts');
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const encode = bytes => { let text = ''; for (let n = 0; n < bytes.length; n += 16384) text += String.fromCharCode(...bytes.subarray(n, n + 16384)); return btoa(text); };
  const flatten = objects => objects.flatMap(object => [object, ...flatten(object.children || [])]);
  const objectSnapshot = object => ({ name: object.name, type: object.type, text: object.text,
    x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation,
    textStyle: object.textStyle, textLayout: object.textLayout || (object.type === 'text' ? { verticalAlign: 'top', insets: { left: 1.3, right: 1.3, top: 1.3, bottom: 1.3 }, wrap: true, rotation: 0 } : null),
    fillColor: object.fillColor, lineColor: object.lineColor, lineWidth: object.lineWidth,
    table: object.table || null, chart: object.chart ? { type: object.chart.type, title: object.chart.title, categories: object.chart.categories, series: object.chart.series, values: object.chart.values } : null,
    image: object.image ? { mimeType: object.image.mimeType, dataUrlLength: object.image.dataUrl.length } : null,
    locked: !!object.locked, children: (object.children || []).map(objectSnapshot) });
  const snapshot = model => ({ width: model.width, height: model.height, slides: model.slides.map(slide => ({ name: slide.name, hidden: slide.hidden, layout: slide.layout,
    background: slide.background, notes: slide.notes, transition: slide.transition,
    media: slide.media.map(media => ({ kind: media.kind, name: media.name, start: media.start, loop: media.loop, mimeType: media.mimeType, bytes: media.data?.length || 0 })),
    objects: slide.objects.map(objectSnapshot), inheritedObjects: (slide.inheritedObjects || []).map(objectSnapshot) })) });
  const differences = (a, b, prefix = '', result = []) => {
    if (result.length >= 100) return result;
    if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > .001) result.push({ path: prefix, before: a, after: b }); return result; }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], prefix + '/' + key, result);
    } else if (a !== b) result.push({ path: prefix, before: a, after: b });
    return result;
  };
  const sameBytes = (a, b) => a && b && a.length === b.length && a.every((value, index) => value === b[index]);
  const warnings = model => ({ document: model.warnings, slides: model.slides.map((slide, index) => ({ index, warnings: slide.warnings,
    unsupportedAnimations: !!slide.hasUnsupportedAnimations, locked: flatten(slide.objects).filter(object => object.locked).map(object => ({ name: object.name, type: object.type, warning: object.warning || '' })) })) });
  const result = { artifacts: [], scenarios: [], failures: [] };
  const source = decode(input.base64), original = await importPresentation(source), initial = snapshot(original);
  result.initial = initial; result.importWarnings = warnings(original);
  if (['typography-rich', 'text-layout-vertical', 'placeholder-inheritance'].includes(input.item.id)) {
    result.renderModel = JSON.parse(JSON.stringify({ ...original, sourceParts: undefined }));
    try {
      const { slideSvg } = await import('/src/presentation/core/render.ts');
      result.renderSvg = original.slides.map(slide => slideSvg(original, slide));
      const { exportPresentationPdf } = await import('/src/presentation/core/pdf.ts');
      result.renderPdf = encode(await exportPresentationPdf(original));
    } catch (error) { result.failures.push('PDF rendering: ' + error.message); }
  }
  const originals = new Map([...original.sourceParts].map(([name, bytes]) => [name, bytes.slice()]));
  const checkSource = () => [...originals].filter(([name, bytes]) => !sameBytes(bytes, original.sourceParts.get(name))).map(([name]) => name);
  let current = original;
  async function write(name, model, scenario, expected = snapshot(model)) {
    const start = performance.now(), bytes = await exportPresentation(model), reopened = await importPresentation(bytes);
    const modelDifferences = differences(expected, snapshot(reopened));
    result.artifacts.push({ name, base64: encode(bytes), scenario, bytes: bytes.length, modelDifferences, warnings: warnings(reopened), milliseconds: Math.round(performance.now() - start) });
    if (modelDifferences.length) result.failures.push(`${name}: model semantics changed during export/reopen`);
    return reopened;
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    try { current = await write(`noop-${cycle}.pptx`, current, 'noop', initial); }
    catch (error) { result.failures.push(`noop-${cycle}: ${error.message}`); break; }
  }
  result.mutatedSourceParts = checkSource();
  if (result.mutatedSourceParts.length) result.failures.push('Export modified immutable source buffers');
  const editText = `COMPLEX EDIT ${input.item.id} 中文`, editNotes = `COMPLEX NOTES ${input.item.id} 中文`;
  const index = input.item.editPageIndex || 0;
  try {
    const editor = new PresentationController(await importPresentation(source), 'complex-' + input.item.id);
    editor.action({ type: 'select-page', pageIndex: index });
    const slide = editor.model.slides[index], wanted = input.item.editObjectName;
    const target = wanted ? slide.objects.find(object => object.name === wanted) : null;
    if (wanted && !target) throw Error(`Missing requested unrelated text object ${wanted}`);
    if (target) editor.action({ type: 'update-object', id: target.id, text: editText });
    else editor.action({ type: 'insert-text', text: editText, x: 8, y: Math.max(8, editor.model.height - 18), width: 120, height: 12 });
    const notes = slide.notes ? slide.notes + '\n' + editNotes : editNotes;
    editor.action({ type: 'set-notes', pageIndex: index, text: notes });
    await write('edited.pptx', editor.model, 'edit');
    result.edit = { text: editText, notes, notesSentinel: editNotes, pageIndex: index, objectName: target?.name || null };
    editor.action({ type: 'duplicate-page', pageIndex: index });
    editor.action({ type: 'move-page', pageIndex: index + 1, direction: 'up' });
    await write('duplicated-reordered.pptx', editor.model, 'duplicate');
    result.slideOrder = Array.from({ length: original.slides.length }, (_, i) => i); result.slideOrder.splice(index, 0, index);
  } catch (error) { result.failures.push(`edit/duplicate: ${error.message}`); }

  if (input.item.formatObjectName) for (const [name, style] of [['format-color', { color: '#146CA4' }], ['format-size', { fontSize: 28 }]]) {
    try {
      const editor = new PresentationController(await importPresentation(source), 'complex-' + name);
      editor.action({ type: 'select-page', pageIndex: input.item.formatSlideIndex || 0 });
      const target = editor.model.slides[editor.currentPageIndex].objects.find(object => object.name === input.item.formatObjectName);
      if (!target) throw Error('Missing formatting target ' + input.item.formatObjectName);
      editor.action({ type: 'update-object', id: target.id, textStyle: style }); await write(`${name}.pptx`, editor.model, name);
    } catch (error) { result.failures.push(`${name}: ${error.message}`); }
  }
  if (input.item.duplicateObjectName) {
    try {
      const editor = new PresentationController(await importPresentation(source), 'complex-duplicate-object');
      editor.action({ type: 'select-page', pageIndex: input.item.duplicateObjectSlideIndex || 0 });
      const target = editor.model.slides[editor.currentPageIndex].objects.find(object => object.name === input.item.duplicateObjectName);
      if (!target) throw Error('Missing duplication target ' + input.item.duplicateObjectName);
      editor.action({ type: 'select-objects', ids: [target.id] }); editor.duplicateObjects();
      await write('duplicate-object.pptx', editor.model, 'duplicate-object');
    } catch (error) { result.failures.push(`duplicate-object: ${error.message}`); }
  }
  if (input.item.moveObjectName) {
    try {
      const editor = new PresentationController(await importPresentation(source), 'complex-move-object');
      editor.action({ type: 'select-page', pageIndex: input.item.moveObjectSlideIndex || 0 });
      const target = editor.model.slides[editor.currentPageIndex].objects.find(object => object.name === input.item.moveObjectName);
      if (!target) throw Error('Missing movement target ' + input.item.moveObjectName);
      editor.action({ type: 'update-object', id: target.id, x: target.x + 10 });
      await write('move-object.pptx', editor.model, 'move-object');
    } catch (error) { result.failures.push(`move-object: ${error.message}`); }
    const editor = new PresentationController(await importPresentation(source), 'complex-ungroup-refusal');
    editor.action({ type: 'select-page', pageIndex: input.item.moveObjectSlideIndex || 0 });
    const target = editor.model.slides[editor.currentPageIndex].objects.find(object => object.name === input.item.moveObjectName);
    if (target?.hasComplexGroupTransform) {
      const before = snapshot(editor.model), beforeDirty = editor.dirty, originalParts = new Map([...editor.model.sourceParts].map(([name, bytes]) => [name, bytes.slice()])); let rejection;
      try { editor.action({ type: 'arrange-objects', ids: [target.id], operation: 'ungroup' }); } catch (error) { rejection = error.message; }
      const unchanged = differences(before, snapshot(editor.model)).length === 0, sourcePartsUnchanged = [...originalParts].every(([name, bytes]) => sameBytes(bytes, editor.model.sourceParts.get(name)));
      result.scenarios.push({ scenario: 'ungroup-complex-affine-group', rejected: !!rejection, message: rejection || null, unchanged, beforeDirty, afterDirty: editor.dirty, sourcePartsUnchanged });
      if (!rejection || !/组合|缩放/.test(rejection) || !unchanged || beforeDirty !== editor.dirty || !sourcePartsUnchanged) result.failures.push('Complex affine ungroup must explicitly refuse without changing model, dirty state or source buffers');
    } else result.failures.push('The affine regression group must be marked with its complex-transform protection');
  }
  if (input.item.codecNestedFormatObjectName) {
    try {
      const model = await importPresentation(source), target = flatten(model.slides[input.item.codecNestedFormatSlideIndex || 0].objects).find(object => object.name === input.item.codecNestedFormatObjectName);
      if (!target) throw Error('Missing nested codec formatting target');
      target.textStyle = { ...target.textStyle, color: '#146CA4' };
      await write('nested-format-color.pptx', model, 'nested-format-color');
      result.scenarios.push({ scenario: 'nested-format-color', operationScope: 'Direct production model/exporter contract only; the editor UI does not expose nested child editing.' });
    } catch (error) { result.failures.push(`nested-format-color: ${error.message}`); }
  }
  if (input.item.copySelectionNames) {
    const editor = new PresentationController(await importPresentation(source), 'complex-copy-siblings');
    editor.action({ type: 'select-page', pageIndex: input.item.copySelectionSlideIndex || 0 });
    const targets = input.item.copySelectionNames.map(name => editor.model.slides[editor.currentPageIndex].objects.find(object => object.name === name));
    if (targets.some(target => !target)) result.failures.push('Missing free-connector selection target');
    else {
      editor.action({ type: 'select-objects', ids: targets.map(target => target.id) });
      const before = snapshot(editor.model); let rejection;
      try { editor.duplicateObjects(); } catch (error) { rejection = error.message; }
      const unchanged = differences(before, snapshot(editor.model)).length === 0;
      result.scenarios.push({ scenario: 'copy-free-connector-with-endpoints', names: input.item.copySelectionNames, rejected: !!rejection, message: rejection || null, unchanged });
      if (!rejection || !/连接|组合/.test(rejection) || !unchanged) result.failures.push('Free connector with endpoints must explicitly refuse an unsafe copy without model mutation');
    }
  }
  for (const [kind, targetDescription] of [['target', input.item.animationTarget], ['trigger', input.item.animationTrigger]]) {
    if (!targetDescription) continue;
    const editor = new PresentationController(await importPresentation(source), 'complex-animation-delete');
    editor.action({ type: 'select-page', pageIndex: targetDescription.slideIndex || 0 });
    const slide = editor.model.slides[editor.currentPageIndex], target = slide.objects.find(object => object.name === targetDescription.shapeName);
    if (!target) { result.failures.push(`Missing animation ${kind} ${targetDescription.shapeName}`); continue; }
    const before = snapshot(editor.model), beforeCount = slide.objects.length;
    let rejectionStage = 'action', rejection;
    try {
      editor.action({ type: 'delete-objects', ids: [target.id] }); rejectionStage = 'export';
      const bytes = await exportPresentation(editor.model);
      result.artifacts.push({ name: `unsafe-delete-${kind}.pptx`, base64: encode(bytes), scenario: 'delete', bytes: bytes.length, modelDifferences: [] });
    } catch (error) { rejection = error.message; }
    const unchangedAfterRefusedAction = differences(before, snapshot(editor.model)).length === 0;
    result.scenarios.push({ scenario: `delete-animation-${kind}`, shapeName: targetDescription.shapeName, rejected: !!rejection, rejectionStage, message: rejection || null,
      sourceObjectCount: beforeCount, modelObjectCountAfterAttempt: editor.model.slides[editor.currentPageIndex].objects.length, unchangedAfterRefusedAction });
    if (!rejection) result.failures.push(`Deleting animation ${kind} succeeded without an explicit unsupported-feature rejection`);
    if (rejection && !/动画|timing|animation/i.test(rejection)) result.failures.push(`Deleting animation ${kind} did not explain the animation protection: ${rejection}`);
    if (rejection && rejectionStage === 'action' && !unchangedAfterRefusedAction) result.failures.push(`Rejected ${kind} deletion still mutated the model`);
  }
  return result;
}

async function editorIdle() {
  await page.waitForFunction(() => {
    const error = document.querySelector('.error-banner'); if (error) throw Error(error.textContent);
    return document.querySelector('[data-testid="standalone-presentation-editor"]')?.getAttribute('data-ready') === 'true' && !document.querySelector('.busy-overlay');
  });
  assert.equal(await page.locator('iframe').count(), 0);
}
async function screenEvidence(file, item, directory, label) {
  await page.getByTestId('document-open-input').setInputFiles(file);
  await page.locator('.titlebar-context').filter({ hasText: path.basename(file) }).waitFor(); await editorIdle();
  const screenshots = [];
  for (const index of item.screenshots || [0]) {
    await page.locator(`[data-testid="presentation-slide-thumbnail"][data-slide-index="${index}"]`).click(); await editorIdle();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const name = `${label}-slide-${index + 1}`, stage = page.getByTestId('presentation-stage');
    const stageBytes = await stage.screenshot({ path: path.join(directory, name + '-stage.png') });
    await page.screenshot({ path: path.join(directory, name + '-editor.png') });
    const visible = await stage.evaluate(element => ({ text: element.querySelector('.pe-slide-svg')?.textContent || '',
      imageCount: element.querySelectorAll('svg image').length, svgTextElements: element.querySelectorAll('svg text').length,
      lockedObjects: [...element.querySelectorAll('.pe-object.is-locked')].map(node => ({ id: node.getAttribute('data-object-id'), kind: node.getAttribute('data-kind'), label: node.getAttribute('aria-label') })) }));
    screenshots.push({ slideIndex: index, stageImage: name + '-stage.png', editorImage: name + '-editor.png', stagePngSha256: sha256(stageBytes),
      warningText: await page.locator('.pe-warning').allTextContents(), effectWarnings: await page.locator('.note.warning').allTextContents(), rendered: visible });
  }
  return screenshots;
}

async function verifyLiveTextLayout(item, directory) {
  const checks = [], editedNames = ['CENTER_ASYM', 'BOTTOM_NOWRAP'];
  async function inspectOverlay(name, changeText) {
    const target = page.locator(`[data-testid="presentation-object"][aria-label^="${name}，"]`);
    await target.dblclick(); const textarea = page.getByTestId('presentation-text-editor'); await textarea.waitFor();
    if (changeText) await textarea.fill((await textarea.inputValue()) + ' UI');
    const measured = await page.evaluate(async name => {
      const { textLayoutFor } = await import('/src/presentation/core/scene.ts');
      const input = document.querySelector('[data-testid="presentation-text-editor"]'), actual = getComputedStyle(input);
      // The public data attributes describe the selected editable object's
      // geometry; the production importer supplies its actual saved text layout.
      const model = globalThis.__complexLayoutReadback, object = model.slides[0].objects.find(object => object.name === name);
      const layout = textLayoutFor({ ...object, text: input.value }), stage = document.querySelector('[data-testid="presentation-stage"]');
      const scale = stage.getBoundingClientRect().width / model.width;
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${actual.fontStyle} ${actual.fontWeight} ${layout.fontSize * scale}px ${actual.fontFamily}`;
      const metrics = context.measureText(input.value || 'Mg');
      const cssFirstBaseline = Number.isFinite(metrics.fontBoundingBoxAscent) && Number.isFinite(metrics.fontBoundingBoxDescent)
        ? metrics.fontBoundingBoxAscent + (layout.lineHeight * scale - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 : layout.ascent * scale;
      const expected = { paddingTop: Math.max(0, layout.firstBaseline * scale - cssFirstBaseline), paddingRight: Math.max(0, layout.insets.right) * scale,
        paddingBottom: Math.max(0, layout.insets.bottom) * scale, paddingLeft: Math.max(0, layout.insets.left) * scale,
        lineHeight: layout.lineHeight * scale, fontSize: layout.fontSize * scale };
      return { name, text: input.value, expected, baseline: { svg: layout.firstBaseline * scale, textarea: parseFloat(actual.paddingTop) + cssFirstBaseline }, actual: Object.fromEntries(Object.keys(expected).map(key => [key, parseFloat(actual[key])])),
        whiteSpace: actual.whiteSpace, expectedWhiteSpace: object.textLayout?.wrap === false ? 'pre' : 'pre-wrap',
        textLayout: object.textLayout, geometry: { x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation } };
    }, name);
    for (const key of Object.keys(measured.expected)) assert.ok(Math.abs(measured.expected[key] - measured.actual[key]) < .15, `${name}: textarea ${key} differs from the shared scene layout`);
    assert.equal(measured.whiteSpace, measured.expectedWhiteSpace); checks.push(measured);
    await page.getByTestId('presentation-stage').screenshot({ path: path.join(directory, `overlay-${name}-${changeText ? 'edited' : 'reopened'}.png`) });
    await textarea.blur(); await editorIdle();
  }
  async function loadReadback(file) {
    const base64 = fs.readFileSync(file).toString('base64');
    await page.evaluate(async base64 => {
      const { importPresentation } = await import('/src/presentation/core/pptx.ts');
      globalThis.__complexLayoutReadback = await importPresentation(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    }, base64);
  }
  const before = path.join(directory, 'noop-3.pptx'); await loadReadback(before);
  for (const name of editedNames) await inspectOverlay(name, true);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click();
  const file = path.join(directory, 'ui-layout-edited.pptx'); await (await pending).saveAs(file); await editorIdle();
  await page.getByTestId('document-open-input').setInputFiles(file);
  await page.locator('.titlebar-context').filter({ hasText: path.basename(file) }).waitFor(); await editorIdle(); await loadReadback(file);
  for (const name of editedNames) await inspectOverlay(name, false);
  await page.evaluate(() => { delete globalThis.__complexLayoutReadback; });
  for (let index = 0; index < editedNames.length; index++) {
    assert.deepEqual(checks[index].textLayout, checks[index + editedNames.length].textLayout);
    assert.deepEqual(checks[index].geometry, checks[index + editedNames.length].geometry);
    assert.equal(checks[index].text, checks[index + editedNames.length].text);
  }
  await page.screenshot({ path: path.join(directory, 'ui-layout-edited-editor.png') });
  return { ok: true, checks, exported: path.basename(file), sha256: sha256(fs.readFileSync(file)) };
}

async function verifyDocumentClipboard(items) {
  const sourceItem = items.find(item => item.editObjectName), otherItem = items.find(item => item.id !== sourceItem?.id);
  if (!sourceItem || !otherItem) return { skipped: 'Requires two distinct fixtures' };
  const source = item => path.resolve(path.dirname(manifestFile), item.path);
  async function open(item) {
    await page.getByTestId('document-open-input').setInputFiles(source(item));
    await page.locator('.titlebar-context').filter({ hasText: path.basename(source(item)) }).waitFor(); await editorIdle();
  }
  await open(sourceItem);
  await page.locator(`[data-testid="presentation-slide-thumbnail"][data-slide-index="${sourceItem.editPageIndex || 0}"]`).click();
  await page.locator(`[data-testid="presentation-object"][aria-label^="${sourceItem.editObjectName}，"]`).click();
  await page.keyboard.press('Control+c');
  assert.equal(await page.getByRole('button', { name: '粘贴', exact: true }).isEnabled(), true, 'The document-local copy must contain the selected object');
  await open(otherItem);
  const countBefore = await page.getByTestId('presentation-object').count(), savedBefore = await page.locator('.save-state').innerText();
  await page.getByTestId('standalone-presentation-editor').focus(); await page.keyboard.press('Control+v');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('presentation-object').count(), countBefore);
  assert.equal(await page.locator('.save-state').innerText(), savedBefore);
  await editorIdle();
  return { ok: true, copiedFrom: sourceItem.id, pastedInto: otherItem.id, countBefore, countAfter: await page.getByTestId('presentation-object').count(), savedBefore, savedAfter: await page.locator('.save-state').innerText() };
}

async function verifyHiddenLineWidth() {
  const result = await page.evaluate(async () => {
    const { createPresentation, PresentationController } = await import('/src/presentation/core/model.ts');
    const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
    const { slideSvg } = await import('/src/presentation/core/render.ts');
    const encode = bytes => { let text = ''; for (let n = 0; n < bytes.length; n += 16384) text += String.fromCharCode(...bytes.subarray(n, n + 16384)); return btoa(text); };
    const editor = new PresentationController(createPresentation(), 'hidden-line-width');
    editor.action({ type: 'insert-text', text: '启用保留的线宽', x: 10, y: 10, width: 100, height: 30 });
    const target = editor.model.slides[0].objects[0];
    editor.action({ type: 'update-object', id: target.id, lineWidth: .4, lineColor: null });
    const hiddenBytes = await exportPresentation(editor.model), hiddenModel = await importPresentation(hiddenBytes);
    const colorEditor = new PresentationController(hiddenModel, 'enable-line-color');
    colorEditor.action({ type: 'update-object', id: colorEditor.model.slides[0].objects[0].id, lineColor: '#123456' });
    const coloredBytes = await exportPresentation(colorEditor.model), coloredModel = await importPresentation(coloredBytes);
    const svg = slideSvg(coloredModel, coloredModel.slides[0]), document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return { hiddenWidth: hiddenModel.slides[0].objects[0].lineWidth, coloredWidth: coloredModel.slides[0].objects[0].lineWidth,
      strokeWidths: [...document.querySelectorAll('[stroke="#123456"]')].map(node => Number(node.getAttribute('stroke-width'))),
      hiddenBytes: encode(hiddenBytes), coloredBytes: encode(coloredBytes), svg };
  });
  const directory = path.join(out, 'regression-probes'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'hidden-line.pptx'), Buffer.from(result.hiddenBytes, 'base64'));
  fs.writeFileSync(path.join(directory, 'enabled-line.pptx'), Buffer.from(result.coloredBytes, 'base64'));
  fs.writeFileSync(path.join(directory, 'enabled-line.svg'), result.svg);
  delete result.hiddenBytes; delete result.coloredBytes; delete result.svg;
  assert.equal(result.hiddenWidth, .4); assert.equal(result.coloredWidth, .4);
  assert.ok(result.strokeWidths.length > 0 && result.strokeWidths.every(width => width > 0));
  return { ok: true, ...result };
}

function audit(source, files, item, scenario, directory, core) {
  const auditFile = path.join(path.dirname(manifestFile), 'inspect.py');
  const destination = path.join(directory, `independent-${scenario}.json`);
  const args = [auditFile, source, ...files, '--fixture', item.id, '--report', destination, '--scenario', scenario];
  if (core.edit && ['edit', 'duplicate'].includes(scenario)) args.push('--expected-edit-text', core.edit.text, '--expected-notes', core.edit.notes);
  if (scenario === 'duplicate') args.push('--slide-order', JSON.stringify(core.slideOrder));
  if (['format-color', 'nested-format-color'].includes(scenario)) args.push('--expected-color', '#146CA4');
  if (scenario === 'format-size') args.push('--expected-font-size', '28');
  try {
    const output = execFileSync(process.env.PYTHON || 'python3', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, reportFile: path.basename(destination), output: output.trim() };
  } catch (error) { return { ok: false, reportFile: path.basename(destination), error: String(error.stderr || error.stdout || error.message).slice(0, 16000) }; }
}

(async () => { try {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); assert.equal(manifest.schemaVersion, 1);
  let items = manifest.items;
  if (process.env.PRESENTATION_COMPLEX_CASES) { const selected = new Set(process.env.PRESENTATION_COMPLEX_CASES.split(',')); items = items.filter(item => selected.has(item.id)); }
  assert.ok(items.length, 'No complex fixtures selected'); report.manifest = { path: path.relative(root, manifestFile), sha256: sha256(fs.readFileSync(manifestFile)), fixtures: items.length };
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1360, height: 920 }, acceptDownloads: true }); page.setDefaultTimeout(45000);
  const origin = new URL(url).origin;
  await page.routeWebSocket('**', socket => { const target = new URL(socket.url()); if (target.host !== new URL(url).host) report.externalRequests.push({ phase, url: target.href, type: 'websocket' }); });
  page.on('request', request => {
    const target = new URL(request.url());
    if (/^https?:$/.test(target.protocol) && target.origin !== origin) report.externalRequests.push({ phase, url: target.href });
    if (target.pathname !== '/office-runtime/NotoSansCJKsc-Regular.otf' && (/^\/(office|office-runtime)\//.test(target.pathname) || /soffice|\.wasm(?:$|\?)/i.test(target.href))) report.officeRuntimeRequests.push({ phase, url: target.href });
  });
  page.on('pageerror', error => { report.pageErrors.push({ phase, error: error.message }); console.error('PAGEERROR', error.message); });
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, error: message.text() }); });
  await page.goto(url); await page.locator('.create-card.presentation').waitFor();
  for (const item of items) {
    phase = item.id; console.log('FIXTURE', item.id); const started = performance.now();
    const directory = path.join(out, item.id); fs.mkdirSync(directory, { recursive: true });
    const source = path.resolve(path.dirname(manifestFile), item.path), bytes = fs.readFileSync(source);
    assert.equal(sha256(bytes), item.sha256, `${item.id}: source differs from the fixture manifest`);
    const entry = { id: item.id, provenance: item.provenance, source: { path: path.relative(root, source), sha256: sha256(bytes), bytes: bytes.length }, failures: [], artifacts: [], audits: [], screens: {} };
    report.fixtures.push(entry); persist();
    try {
      const core = await page.evaluate(exerciseCore, { base64: bytes.toString('base64'), item });
      entry.model = { initial: core.initial, importWarnings: core.importWarnings, mutatedSourceParts: core.mutatedSourceParts, scenarios: core.scenarios };
      if (core.renderModel) fs.writeFileSync(path.join(directory, 'imported-model.json'), JSON.stringify(core.renderModel, null, 2));
      if (core.renderSvg) for (let index = 0; index < core.renderSvg.length; index++) fs.writeFileSync(path.join(directory, `source-render-${index + 1}.svg`), core.renderSvg[index]);
      if (core.renderPdf) fs.writeFileSync(path.join(directory, 'source-render.pdf'), Buffer.from(core.renderPdf, 'base64'));
      entry.failures.push(...core.failures); entry.edit = core.edit; entry.slideOrder = core.slideOrder;
      let previous = bytes;
      for (const artifact of core.artifacts) {
        const exported = Buffer.from(artifact.base64, 'base64'); delete artifact.base64;
        fs.writeFileSync(path.join(directory, artifact.name), exported);
        artifact.sha256 = sha256(exported); artifact.packageDifferenceFromSource = packageDifference(bytes, exported, item.preserveParts || []);
        if (artifact.scenario === 'noop') { artifact.packageDifferenceFromPreviousCycle = packageDifference(previous, exported); previous = exported; }
        if (artifact.packageDifferenceFromSource.removed.length) entry.failures.push(`${artifact.name}: removed original package parts`);
        if (artifact.packageDifferenceFromSource.protectedChanges.length) entry.failures.push(`${artifact.name}: modified protected dependencies ${artifact.packageDifferenceFromSource.protectedChanges.join(', ')}`);
        entry.artifacts.push(artifact);
      }
      for (const scenario of ['noop', 'edit', 'duplicate', 'format-color', 'format-size', 'duplicate-object', 'move-object', 'nested-format-color', 'delete']) {
        const files = entry.artifacts.filter(artifact => artifact.scenario === scenario).map(artifact => path.join(directory, artifact.name));
        if (!files.length) continue;
        const result = audit(source, files, item, scenario, directory, core); entry.audits.push({ scenario, ...result });
        if (!result.ok) entry.failures.push(`${scenario}: independent Python audit failed`);
      }
      phase = item.id + ':source-screen'; entry.screens.source = await screenEvidence(source, item, directory, 'source');
      if (fs.existsSync(path.join(directory, 'noop-3.pptx'))) {
        phase = item.id + ':roundtrip-screen'; entry.screens.roundtrip = await screenEvidence(path.join(directory, 'noop-3.pptx'), item, directory, 'roundtrip');
        entry.screens.sameStagePng = entry.screens.source.map((screen, index) => ({ slideIndex: screen.slideIndex, identical: screen.stagePngSha256 === entry.screens.roundtrip[index]?.stagePngSha256 }));
      }
      if (item.id === 'motion-triggers-connectors') assert.ok(entry.screens.source.some(screen => screen.effectWarnings.some(text => text.includes('暂未支持的对象动画'))), 'Unsupported object-animation warning must be visible in the actual editor');
      if (item.id === 'text-layout-vertical') entry.uiTextLayout = await verifyLiveTextLayout(item, directory);
    } catch (error) { entry.failures.push(String(error.stack || error)); await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); }
    entry.sourceHashUnchanged = sha256(fs.readFileSync(source)) === entry.source.sha256;
    if (!entry.sourceHashUnchanged) entry.failures.push('Original fixture file changed on disk');
    entry.milliseconds = Math.round(performance.now() - started); entry.ok = entry.failures.length === 0;
    console.log(entry.ok ? 'PASS' : 'FAIL', item.id, entry.failures); persist();
  }
  phase = 'document-local-clipboard'; report.documentClipboard = await verifyDocumentClipboard(items);
  phase = 'hidden-line-width'; report.hiddenLineWidth = await verifyHiddenLineWidth();
  report.assertionSummary = {
    originalFilesUnchanged: report.fixtures.every(item => item.sourceHashUnchanged),
    packageAuditsPassed: report.fixtures.every(item => item.audits.length > 0 && item.audits.every(audit => audit.ok)),
    noOpReopenCycles: report.fixtures.reduce((sum, item) => sum + item.artifacts.filter(artifact => artifact.scenario === 'noop').length, 0),
    modelSemanticsPassed: report.fixtures.every(item => item.artifacts.every(artifact => artifact.modelDifferences.length === 0)),
    visualFidelity: 'Not asserted: unsupported features and actual editor screenshots are recorded separately.',
    animationPlayback: 'Not supported for these complex source animations: warnings, preservation and unsafe-edit refusal are tested.',
  };
  report.ok = report.fixtures.every(item => item.ok) && !report.pageErrors.length && !report.consoleErrors.length && !report.externalRequests.length && !report.officeRuntimeRequests.length;
  assert.equal(await page.locator('iframe').count(), 0);
  if (!report.ok) process.exitCode = 1;
} catch (error) { report.ok = false; report.error = String(error.stack || error); console.error(error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); persist(); await browser?.close(); } })();
