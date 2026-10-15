/* Real native rendering, screenshot-derived pointer positions and keyboard edits.
 * No Qt/Module hooks, synthetic mutations, or forced engine resize calls. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { installOfficeStateReader, readOfficeState } = require('./office-state-reader.cjs');
const { waitForOfficeViewport } = require('./office-viewport.cjs');

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(root, 'tests/compatibility/office-viewport');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const out = path.resolve(process.env.OFFICE_VIEWPORT_UI_OUTPUT || path.join(root, 'test-results/viewport-iteration/ui', runId));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'manifest.json'), 'utf8'));
const sourceHashes = Object.fromEntries(Object.keys(manifest.sha256).map(name => [name, sha(path.join(fixtures, name))]));
const dprs = (process.env.VIEWPORT_DPRS || '1,2').split(',').map(Number);
const kinds = (process.env.VIEWPORT_KINDS || 'word,calc').split(',');
const flow = process.env.VIEWPORT_FLOW || 'full';
assert.ok(dprs.length && dprs.every(value => [1, 2].includes(value)), 'VIEWPORT_DPRS must contain 1 and/or 2');
assert.ok(kinds.length && kinds.every(value => ['word', 'calc'].includes(value)), 'VIEWPORT_KINDS must contain word and/or calc');
assert.ok(['full', 'wide-control', 'direct-export'].includes(flow), 'VIEWPORT_FLOW must be full, wide-control, or direct-export');
if (flow === 'wide-control') assert.deepEqual([kinds, dprs], [['calc'], [1]], 'Wide causal control uses only fresh Calc DPR1');
assert.deepEqual(sourceHashes, manifest.sha256, 'Independent fixture hashes match their manifest');
fs.mkdirSync(out, { recursive: true });
const report = { scope: 'Native viewport size, screenshot-derived hit testing, real keyboard edits and saved OOXML at sampled widths; not a complete mobile usability audit.', flow, runId, sourceHashes, checks: [], runs: [], errors: [], console: [], files: [] };
const consoleEntries = new Map();
let browser, context, page, phase = 'startup', current;
const pass = message => { report.checks.push(message); console.log('PASS', message); };
const inspect = (command, file, ...args) => JSON.parse(execFileSync('python3', [path.join(fixtures, 'audit-viewport.py'), command, file, ...args.map(value => JSON.stringify(value))], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));

async function idle() {
  await page.waitForFunction(() => document.querySelector('.error-banner,.ow-word>.ow-error,.ow-sheet>.ow-error') ||
    document.querySelector('.office-frame:not(.is-loading)') && !document.querySelector('.office-loading,.busy-overlay,.ow-panel>[role=status]'), null, { timeout: 240000 });
  const errors = page.locator('.error-banner,.ow-word>.ow-error,.ow-sheet>.ow-error');
  if (await errors.count()) throw Error(await errors.first().innerText());
}

async function state() {
  const value = await readOfficeState(page, current.kind === 'word' ? 'word-state' : 'sheet-state');
  if (current.documentId) assert.equal(value.documentId, current.documentId, 'Resize keeps the same native document');
  return value;
}

async function waitState(predicate, description, timeout = 8000) {
  const start = Date.now();
  let value;
  do {
    value = await state();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  } while (Date.now() - start < timeout);
  throw Error(description + ': ' + JSON.stringify({ selection: value.selection, cell: value.cell }));
}

async function collapseSelection() {
  // Focus only the public DOM canvas, then use the user's native navigation key.
  await page.frameLocator('iframe.office-frame').locator('#qtcanvas').focus();
  await page.keyboard.press('Control+Home');
  await waitState(value => current.kind === 'word' ? value.selection.collapsed : value.selection.address === 'A1', 'Ctrl+Home must collapse the selection / select A1');
}

async function captureMarkers(name, expectedPrimary) {
  const filename = current.label + '-' + name + '.png';
  const file = path.join(out, filename);
  const colors = current.kind === 'word' ? { primary: manifest.word.primaryColor, anchor: manifest.word.anchorColor } : { primary: manifest.calc.primaryColor, anchor: manifest.calc.anchorColor };
  const start = Date.now();
  let attempts = 0, lastError, previousVisualKey = '', stableSince = 0;
  do {
    attempts++;
    const geometry = await waitForOfficeViewport(page);
    // Device pixels preserve native raster evidence; the independent inspector
    // converts image coordinates back to CSS pixels using image/viewport width.
    await page.screenshot({ path: file, scale: 'device' });
    try {
      const visual = inspect('markers', file, { iframe: geometry.iframe, viewportWidth: page.viewportSize().width }, colors);
      for (const [key, marker] of Object.entries(visual.markers)) {
        assert.ok(marker.width >= 6 && marker.height >= 6, `${key} has visible dimensions`);
        assert.ok(marker.x >= geometry.iframe.x && marker.x + marker.width <= geometry.iframe.x + geometry.iframe.width, `${key} is fully within the native viewport`);
        const shapeKey = key === 'primary' && current.kind === 'word' ? expectedPrimary : key;
        const baseline = current.markerShapes[shapeKey];
        if (baseline) assert.ok(Math.abs(marker.aspectRatio / baseline - 1) < 0.07, `${key} aspect ratio ${marker.aspectRatio} differs from ${baseline}`);
      }
      // Native toolbars can finish painting after the DOM canvas is sized.
      // Require the actual visible targets to stop moving before using them.
      const visualKey = JSON.stringify({ iframe: geometry.iframe, markers: Object.values(visual.markers).map(marker => [marker.x, marker.y, marker.width, marker.height]) });
      if (visualKey !== previousVisualKey) { previousVisualKey = visualKey; stableSince = Date.now(); }
      if (Date.now() - stableSince < 1500) { await page.waitForTimeout(150); continue; }
      for (const [key, marker] of Object.entries(visual.markers)) {
        const shapeKey = key === 'primary' && current.kind === 'word' ? expectedPrimary : key;
        current.markerShapes[shapeKey] ??= marker.aspectRatio;
      }
      return { name, screenshot: filename, viewport: page.viewportSize(), geometry, visual, captureAttempts: attempts, captureElapsedMs: Date.now() - start, markerStableMs: Date.now() - stableSince };
    } catch (error) {
      lastError = error;
      previousVisualKey = ''; stableSince = 0;
      await page.waitForTimeout(150);
    }
  } while (Date.now() - start < 15000);
  throw Error(`Visible native markers did not settle for ${name}: ${lastError?.message}`);
}

async function clickMarker(marker, expected) {
  const { x, y } = marker.center;
  if (current.kind === 'word') await page.mouse.dblclick(x, y, { delay: 110 });
  else await page.mouse.click(x, y);
  const selected = await waitState(value => current.kind === 'word' ? value.selection.text === expected : value.selection.address === expected,
    `Screenshot-derived pointer (${x}, ${y}) must select ${expected}`);
  return { expected, selected: current.kind === 'word' ? selected.selection.text : selected.selection.address,
    value: current.kind === 'calc' ? selected.cell.value : undefined, text: current.kind === 'calc' ? selected.cell.text : undefined,
    documentId: selected.documentId, revision: selected.revision, point: { x, y } };
}

async function checkpoint(name, expectedPrimary) {
  phase = current.label + ' ' + name;
  await idle();
  await waitForOfficeViewport(page);
  await collapseSelection();
  const entry = await captureMarkers(name, expectedPrimary);
  current.pendingCheckpoint = entry;
  entry.toolbar = await page.locator('.ow-toolbar').evaluate(toolbar => ({
    clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth, scrollLeft: toolbar.scrollLeft,
    controls: [...toolbar.querySelectorAll('select,input[type="color"]')].map(control => ({
      name: control.getAttribute('aria-label'), type: control.tagName === 'SELECT' ? 'select' : 'color',
      width: control.getBoundingClientRect().width,
    })),
  }));
  for (const control of entry.toolbar.controls) assert.ok(control.width >= (control.type === 'color' ? 30 : 44), `${control.name} remains wide enough to display its value`);
  entry.hits = [];
  entry.hits.push(await clickMarker(entry.visual.markers.primary, current.kind === 'word' ? expectedPrimary : 'B2'));
  entry.hits.push(await clickMarker(entry.visual.markers.anchor, current.kind === 'word' ? 'ANCHOR' : 'A4'));
  if (current.kind === 'calc') {
    assert.equal(entry.hits[0].value, Number(expectedPrimary), 'Visible primary cell retains expected content');
    assert.equal(entry.hits[1].text, 'KEEP', 'Second visible cell retains its sentinel');
  }
  current.checkpoints.push(entry);
  delete current.pendingCheckpoint;
  pass(`${current.label} ${name}: both visible targets select expected content in the same document`);
  return entry;
}

async function saveAndInspect() {
  phase = current.label + ' save';
  const extension = current.kind === 'word' ? 'docx' : 'xlsx';
  const download = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const file = path.join(out, current.label + '-edited.' + extension);
  await (await download).saveAs(file);
  await idle();
  current.exported = inspect('export', file);
  current.exportedFile = path.basename(file);
  report.files.push({ name: path.basename(file), sha256: sha(file) });
  if (current.kind === 'word') assert.deepEqual(current.exported.paragraphs, ['RESIZED', 'ANCHOR', 'WORD_SENTINEL']);
  else {
    assert.equal(current.exported.cells.B2.value, '314');
    assert.equal(current.exported.cells.B2.type, 'n');
    assert.equal(current.exported.cells.A1.value, 'ORIGIN');
    assert.equal(current.exported.cells.A4.value, 'KEEP');
    assert.equal(current.exported.cells.C5.value, 'SHEET_SENTINEL');
  }
  pass(`${current.label}: independent exported ZIP/XML contains the keyboard edit and untouched sentinels`);
}

async function inputAudit() {
  return Promise.all(page.frames().map(frame => frame.evaluate(() => ({
    url: location.pathname, events: window.__viewportInputAudit || [],
    activeElement: document.activeElement?.id || document.activeElement?.tagName,
    canvas: (() => { const canvas = document.querySelector('#qtcanvas'); return canvas && { text: canvas.textContent, scrollTop: canvas.scrollTop, scrollLeft: canvas.scrollLeft }; })(),
  })).catch(error => ({ error: String(error) }))));
}

async function typeMarker(entry) {
  phase = current.label + ' keyboard edit at ' + page.viewportSize().width;
  await clickMarker(entry.visual.markers.primary, current.kind === 'word' ? 'VIEWPORT' : 'B2');
  const revisionBeforeEdit = (await state()).revision;
  await page.keyboard.type(current.kind === 'word' ? 'RESIZED' : '314', { delay: 70 });
  if (current.kind === 'calc') {
    await page.keyboard.press('Enter');
    const committed = await waitState(value => value.selection.address === 'B3' && value.revision > revisionBeforeEdit, 'Enter commits numeric editing and moves to B3');
    current.keyboardCommit = { selection: committed.selection.address, revision: committed.revision };
  } else {
    const committed = await waitState(value => value.revision > revisionBeforeEdit, 'Word keyboard editing advances native revision');
    current.keyboardCommit = { selection: committed.selection, revision: committed.revision };
  }
  await idle();
  return revisionBeforeEdit;
}

async function run(kind, dpr) {
  current = { kind, dpr, flow, label: kind + '-dpr' + dpr, checkpoints: [], markerShapes: {} };
  report.runs.push(current);
  context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: dpr, acceptDownloads: true });
  try {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push({ run: current.label, phase, message: error.message }));
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      const text = message.text().startsWith('[Office engine] dependency:') ? '[Office engine] startup file dependency (individual asset names counted)' : message.text();
      const key = JSON.stringify([current.label, message.type(), text]);
      if (consoleEntries.has(key)) consoleEntries.get(key).count++;
      else { const entry = { run: current.label, phase, type: message.type(), text, count: 1 }; consoleEntries.set(key, entry); report.console.push(entry); }
    });
    await page.routeWebSocket('**', () => {});
    await page.route('**/__native-smoke/*', route => route.fulfill({ status: 204, body: '' }));
    await page.addInitScript(() => {
      window.__viewportInputAudit = [];
      for (const type of ['mousemove', 'mousedown', 'mouseup', 'keydown', 'keyup']) window.addEventListener(type, event => {
        window.__viewportInputAudit.push({ type, time: event.timeStamp, x: event.clientX, y: event.clientY,
          key: event.key, buttons: event.buttons, detail: event.detail, target: event.target?.id || event.target?.tagName });
        if (window.__viewportInputAudit.length > 100) window.__viewportInputAudit.shift();
      }, true);
    });
    await installOfficeStateReader(page);
    phase = current.label + ' open';
    await page.goto(process.env.OFFICE_WORKBENCH_URL || 'http://127.0.0.1:4299/');
    const fixture = path.join(fixtures, kind === 'word' ? 'viewport-source.docx' : 'viewport-source.xlsx');
    await (kind === 'word' ? page.locator('input[type="file"][accept=".docx,.odt,.doc,.rtf"]') : page.getByTestId('document-open-input')).setInputFiles(fixture);
    await idle();
    await page.getByLabel(kind === 'word' ? '段落样式' : '单元格字体', { exact: true }).waitFor();
    current.documentId = (await state()).documentId;
    const initial = kind === 'word' ? 'VIEWPORT' : '25';
    if (flow === 'wide-control') {
      phase = current.label + ' fresh wide control';
      assert.equal((await state()).selection.address, 'A1');
      const baseline = await captureMarkers('wide-control-before-edit', '25');
      current.checkpoints.push(baseline);
      await typeMarker(baseline);
      let selectionError;
      try { await checkpoint('wide-control-after-edit-home-click', '314'); }
      catch (error) {
        selectionError = error;
        current.controlSelectionFailure = { phase, error: error.message, state: await state(), inputAudit: await inputAudit() };
        await page.screenshot({ path: path.join(out, current.label + '-control-selection-failure.png') });
      }
      // Preserve the selection assertion failure while independently checking
      // whether the actual keyboard edit is still saved through the normal UI.
      await saveAndInspect();
      if (selectionError) { phase = current.label + ' wide control selection'; throw selectionError; }
      current.ok = true;
      return;
    }
    await checkpoint('wide-1560', initial);
    await page.setViewportSize({ width: 820, height: 980 });
    const narrow = await checkpoint('narrow-820', initial);
    if (kind === 'word') {
      const panelCommand = page.locator('.ow-toolbar').getByRole('button', { name: '段落', exact: true });
      await panelCommand.scrollIntoViewIfNeeded();
      current.offscreenToolbarCommand = { name: '段落', scrollLeftBefore: narrow.toolbar.scrollLeft,
        scrollLeftAfter: await page.locator('.ow-toolbar').evaluate(toolbar => toolbar.scrollLeft) };
      assert.ok(current.offscreenToolbarCommand.scrollLeftAfter > current.offscreenToolbarCommand.scrollLeftBefore, 'Offscreen command is reachable by scrolling the toolbar');
      await panelCommand.click();
      const opened = await checkpoint('narrow-820-panel-open', initial);
      assert.equal(opened.viewport.width, narrow.viewport.width, 'Panel toggle keeps the browser width fixed');
      assert.ok(opened.geometry.iframe.width < narrow.geometry.iframe.width - 100, 'Sidebar changes the iframe width without an outer resize');
      await page.getByRole('button', { name: '关闭文字面板', exact: true }).click();
      const closed = await checkpoint('narrow-820-panel-closed', initial);
      assert.ok(Math.abs(closed.geometry.iframe.width - narrow.geometry.iframe.width) <= 1, 'Closing sidebar restores iframe width');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await checkpoint('small-390', initial);
    const revisionBeforeEdit = await typeMarker(mobile);
    if (flow === 'direct-export') {
      // This deliberately separate control observes repaint and saves after
      // typing, without another Ctrl+Home or canvas click after the edit.
      current.postEditObservations = [await captureMarkers('small-390-edited-direct', kind === 'word' ? 'RESIZED' : '314')];
      await page.setViewportSize({ width: 1560, height: 1000 });
      current.postEditObservations.push(await captureMarkers('restored-1560-edited-direct', kind === 'word' ? 'RESIZED' : '314'));
      await state();
      await saveAndInspect();
      current.ok = true;
      return;
    }
    const edited = await checkpoint('small-390-edited', kind === 'word' ? 'RESIZED' : '314');
    assert.ok(edited.hits[0].revision > revisionBeforeEdit, 'Real keyboard edit advances native document revision');
    await page.setViewportSize({ width: 1560, height: 1000 });
    await checkpoint('restored-1560-edited', kind === 'word' ? 'RESIZED' : '314');
    await saveAndInspect();
    current.ok = true;
  } finally {
    if (page) current.inputAudit = await inputAudit();
    if (!current.ok && page) {
      current.failureState = await state().catch(error => ({ error: String(error) }));
      await page.screenshot({ path: path.join(out, current.label + '-failure.png'), timeout: 10000 }).catch(() => {});
      if (process.env.VIEWPORT_POINTER_DIAGNOSTIC === '1' && kind === 'calc' && current.pendingCheckpoint?.visual?.markers?.primary) {
        const { x, y } = current.pendingCheckpoint.visual.markers.primary.center;
        current.pointerDiagnostics = [];
        for (const mode of ['move', 'paced']) {
          await page.keyboard.press('Escape');
          await page.mouse.move(x + 12, y + 10);
          await page.mouse.move(x, y, { steps: 3 });
          await page.mouse.click(x, y, { delay: mode === 'paced' ? 100 : 0 });
          const result = await waitState(value => value.selection.address === 'B2', 'Diagnostic pointer selection', 3000).catch(error => ({ error: error.message }));
          current.pointerDiagnostics.push({ mode, result });
          await page.screenshot({ path: path.join(out, current.label + '-diagnostic-' + mode + '.png') });
          if (!result.error) break;
        }
      }
    }
    await context.close();
    context = null;
    page = null;
  }
}

(async () => {
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const dpr of dprs) for (const kind of kinds) await run(kind, dpr);
    assert.deepEqual(report.errors, [], 'No page runtime errors');
    assert.deepEqual(Object.fromEntries(Object.keys(sourceHashes).map(name => [name, sha(path.join(fixtures, name))])), sourceHashes, 'Source fixtures remain byte-identical');
    pass('Source fixtures remain unchanged; every serial native UI run completed without page runtime errors');
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.phase = phase;
    report.error = error.stack || String(error);
    process.exitCode = 1;
    console.error(phase, error);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    fs.writeFileSync(path.join(out, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Viewport report:', path.join(out, 'ui-report.json'));
  }
})();
