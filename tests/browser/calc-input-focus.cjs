/* Fresh-document causal matrix for native Calc pointer input after typing.
 * Only C/D explicitly focus the public DOM canvas. Native reads use the public
 * read-only office protocol; E separately clicks another cell first. F/G
 * distinguish double-click editing from delayed single-click replacement.
 * Screenshots and exported ZIP/XML are inspected independently. */
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
const fixture = path.join(fixtures, 'viewport-source.xlsx');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const out = path.resolve(process.env.CALC_INPUT_OUTPUT || path.join(root, 'test-results/calc-input-followup', runId));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inspect = (command, file, ...args) => JSON.parse(execFileSync('python3', [path.join(fixtures, 'audit-viewport.py'), command, file, ...args.map(value => JSON.stringify(value))], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
const scenarios = [
  { id: 'A', name: 'direct-click', focus: false, home: false },
  { id: 'B', name: 'home-only', focus: false, home: true },
  { id: 'C', name: 'dom-focus-only', focus: true, home: false },
  { id: 'D', name: 'dom-focus-and-home', focus: true, home: true },
  { id: 'E', name: 'distant-cell-before-original-cell', focus: false, home: false, anchorFirst: true },
  { id: 'F', name: 'double-click-append', focus: false, home: false, editProbe: 'double-click', expectedB2Value: 3149 },
  { id: 'G', name: 'delayed-single-click-replace-and-now', focus: false, home: false, editProbe: 'delayed-single-click', expectedB2Value: 9, checkNow: true },
];
const requestedCases = (process.env.CALC_INPUT_SCENARIOS || 'A,B,C,D').split(',');
assert.ok(requestedCases.length && requestedCases.every(id => scenarios.some(scenario => scenario.id === id)), 'CALC_INPUT_SCENARIOS must contain A through G');
const selectedScenarios = scenarios.filter(scenario => requestedCases.includes(scenario.id));
const runtimeFiles = ['public/office-runtime/soffice.wasm', 'dist/office-runtime/soffice.wasm'];
const report = { runId, scope: 'Fresh 1560px DPR1 contexts; type 314 in B2 and confirm Enter commits at B3. A-D vary explicit DOM focus and Ctrl+Home before the B2 probe; E clicks distant A4 before B2. F double-clicks B2 then End and types 9, expecting 3149; G single-clicks the original B2 point after at least 1200 ms then types 9, expecting replacement with 9. F/G also check Ctrl+Home and A4 to B2 navigation; G enters NOW() and independently checks the exported cached date against UTC wall time. Each result preserves selection assertions and independently audits UI export.',
  requestedCases,
  testScriptSha256: sha(__filename),
  runtimeFiles: runtimeFiles.filter(file => fs.existsSync(path.join(root, file))).map(file => ({ file, bytes: fs.statSync(path.join(root, file)).size, sha256: sha(path.join(root, file)) })),
  sourceSha256: sha(fixture), frozenViewportScriptSha256: sha(path.join(__dirname, 'office-viewport-ui.cjs')),
  cases: [], errors: [], console: [], files: [] };
assert.equal(report.sourceSha256, JSON.parse(fs.readFileSync(path.join(fixtures, 'manifest.json'), 'utf8')).sha256['viewport-source.xlsx']);
fs.mkdirSync(out, { recursive: true });
const consoleEntries = new Map();
let browser, context, page, current, phase = 'startup';

async function auditServedRuntime() {
  const url = new URL('/office-runtime/soffice.wasm', process.env.OFFICE_WORKBENCH_URL || 'http://127.0.0.1:4299/').href;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert.ok(response.ok, 'The preview must serve the office WASM');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.length; }
  report.servedRuntime = { url, bytes, sha256: hash.digest('hex') };
  const builtRuntime = report.runtimeFiles.find(file => file.file.startsWith('dist/'));
  assert.ok(builtRuntime, 'The production runtime must be available for fingerprint comparison');
  assert.equal(report.servedRuntime.sha256, builtRuntime.sha256, 'The preview must serve the fingerprinted build');
  assert.equal(report.servedRuntime.bytes, builtRuntime.bytes);
}

async function idle() {
  await page.waitForFunction(() => document.querySelector('.error-banner,.ow-sheet>.ow-error') ||
    document.querySelector('.office-frame:not(.is-loading)') && !document.querySelector('.office-loading,.busy-overlay'), null, { timeout: 240000 });
  const error = page.locator('.error-banner,.ow-sheet>.ow-error');
  if (await error.count()) throw Error(await error.first().innerText());
}

async function state() {
  const value = await readOfficeState(page, 'sheet-state');
  if (current.documentId) assert.equal(value.documentId, current.documentId);
  return value;
}

async function waitState(predicate, description, timeout = 8000) {
  const started = Date.now();
  let value;
  do {
    value = await state();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  } while (Date.now() - started < timeout);
  throw Error(description + ': ' + JSON.stringify({ selection: value.selection, cell: value.cell, revision: value.revision }));
}

async function domSnapshot(includeEvents = false) {
  return Promise.all(page.frames().map(frame => frame.evaluate(includeEvents => {
    const describe = node => node && { tag: node.tagName || node.constructor?.name, id: node.id || '', contentEditable: node.contentEditable };
    const canvas = document.querySelector('#qtcanvas');
    return { path: location.pathname, at: Date.now(), documentHasFocus: document.hasFocus(), activeElement: describe(document.activeElement),
      canvas: canvas && { text: canvas.textContent, childNodes: canvas.childNodes.length, scrollTop: canvas.scrollTop, scrollLeft: canvas.scrollLeft },
      ...(includeEvents ? { events: window.__calcInputAudit || [] } : {}) };
  }, includeEvents).catch(error => ({ error: String(error) }))));
}

async function snapshot(name) {
  const value = await state();
  const result = { name, at: Date.now(), selection: value.selection, cell: value.cell, revision: value.revision, dom: await domSnapshot() };
  current.snapshots.push(result);
  return result;
}

async function capture(name) {
  const file = path.join(out, current.id + '-' + name + '.png');
  const started = Date.now();
  let previous = '', stableSince = 0, attempts = 0, lastError;
  do {
    attempts++;
    const geometry = await waitForOfficeViewport(page);
    await page.screenshot({ path: file, scale: 'device' });
    try {
      const visual = inspect('markers', file, { iframe: geometry.iframe, viewportWidth: 1560 }, { primary: '20B2AA', anchor: 'DB7311' });
      const key = JSON.stringify({ iframe: geometry.iframe, positions: Object.values(visual.markers).map(marker => [marker.x, marker.y, marker.width, marker.height]) });
      if (key !== previous) { previous = key; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 1500) {
        const result = { name, file: path.basename(file), geometry, visual, attempts, elapsedMs: Date.now() - started, stableMs: Date.now() - stableSince };
        current.captures.push(result);
        return result;
      }
    } catch (error) { lastError = error.message; previous = ''; stableSince = 0; }
    await page.waitForTimeout(150);
  } while (Date.now() - started < 15000);
  throw Error('Visible cell markers did not settle: ' + lastError);
}

function pointInPrimary(captured, point) {
  const marker = captured.visual.markers.primary;
  assert.ok(point.x > marker.x && point.x < marker.x + marker.width && point.y > marker.y && point.y < marker.y + marker.height,
    'The original pointer position must remain inside the independently detected B2 color marker');
  return point;
}

async function clickPrimary(captured, originalPoint) {
  const { x, y } = originalPoint ? pointInPrimary(captured, originalPoint) : captured.visual.markers.primary.center;
  current.actions.push({ action: 'pointer-click-B2', at: Date.now(), point: { x, y }, pressDelayMs: 0 });
  await page.mouse.click(x, y);
  return waitState(value => value.selection.address === 'B2', `Visible B2 at(${x},${y}) must be selected`);
}

async function clickAnchor(captured) {
  const { x, y } = captured.visual.markers.anchor.center;
  current.actions.push({ action: 'pointer-click-A4', at: Date.now(), point: { x, y }, pressDelayMs: 0 });
  await page.mouse.click(x, y);
  const anchor = await waitState(value => value.selection.address === 'A4', `Visible A4 at(${x},${y}) must be selected`);
  assert.equal(anchor.cell.text, 'KEEP');
  current.anchorSelectionPassed = true;
  return anchor;
}

async function checkEditSemantics(target, baseline) {
  const point = pointInPrimary(target, baseline.visual.markers.primary.center);
  const action = current.actions.find(value => value.action === 'pointer-click-B2');
  const minimumGapMs = 1200;
  if (current.editProbe === 'delayed-single-click') {
    const remaining = minimumGapMs - (Date.now() - action.at);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await clickPrimary(target, point);
  } else {
    current.actions.push({ action: 'pointer-double-click-B2', at: Date.now(), point, pressDelayMs: 100 });
    await page.mouse.dblclick(point.x, point.y, { delay: 100 });
    await waitState(value => value.selection.address === 'B2', 'Double-click must address B2');
  }
  const beforeTyping = await snapshot('after-edit-mode-probe');
  await page.screenshot({ path: path.join(out, current.id + '-edit-mode-probe.png') });
  const audit = await domSnapshot(true);
  const nativeAudit = audit.find(frame => frame.canvas)?.events || [];
  const downs = nativeAudit.filter(event => event.type === 'mousedown' && event.target === 'qtcanvas');
  assert.ok(downs.length >= (current.editProbe === 'double-click' ? 3 : 2), 'Real native canvas mouse events must be recorded');
  current.clickTiming = { empiricalMinimumGapMs: minimumGapMs, nativeDoubleClickThresholdMeasured: false,
    firstDown: downs[0], probeDowns: downs.slice(1), gapMs: downs[1].timestamp - downs[0].timestamp };
  if (current.editProbe === 'delayed-single-click') assert.ok(current.clickTiming.gapMs >= minimumGapMs, 'The recorded same-position click gap must be at least 1200 ms');
  else {
    current.clickTiming.doubleClickGapMs = downs[2].timestamp - downs[1].timestamp;
    assert.ok(nativeAudit.some(event => event.type === 'dblclick' && event.target === 'qtcanvas' && event.trusted), 'The double-click must produce a trusted DOM dblclick');
    current.actions.push({ action: 'keyboard-End', at: Date.now() });
    await page.keyboard.press('End');
  }
  current.actions.push({ action: 'keyboard-type-9', at: Date.now(), delayMs: 70 });
  await page.keyboard.type('9', { delay: 70 });
  current.actions.push({ action: 'keyboard-Enter', at: Date.now() });
  await page.keyboard.press('Enter');
  await waitState(value => value.selection.address === 'B3' && value.revision > beforeTyping.revision, 'Second edit must commit at B3');
  await snapshot('committed-edit-mode-probe');
  current.actions.push({ action: 'keyboard-Control-Home', at: Date.now() });
  await page.keyboard.press('Control+Home');
  await waitState(value => value.selection.address === 'A1', 'Ctrl+Home must select A1 after the edit-mode probe');
  await snapshot('after-edit-Control-Home');
  await clickAnchor(await capture('before-edit-anchor-probe'));
  await snapshot('after-edit-anchor-probe');
  const value = await clickPrimary(await capture('before-edit-value-probe'));
  assert.equal(value.cell.value, current.expectedB2Value, 'Double-click must append, while delayed single-click must replace the cell');
  current.editSemanticsPassed = true;
}

async function enterNowFormula() {
  phase = current.id + ' NOW formula';
  current.actions.push({ action: 'keyboard-ArrowRight-to-C2', at: Date.now() });
  await page.keyboard.press('ArrowRight');
  const before = await waitState(value => value.selection.address === 'C2', 'Right from B2 must select C2');
  const hostBefore = Date.now();
  const browserClock = await page.evaluate(() => ({ now: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: new Date().getTimezoneOffset() }));
  const hostAfter = Date.now();
  assert.equal(browserClock.offsetMinutes, 0, 'NOW date validation uses UTC');
  assert.ok(browserClock.now >= hostBefore - 1000 && browserClock.now <= hostAfter + 1000, 'Browser wall time must agree with the independent host clock');
  current.nowCheck = { browserClock, hostClockBeforeMs: hostBefore, hostClockAfterMs: hostAfter, enteredAfterMs: Date.now() };
  current.actions.push({ action: 'keyboard-type-NOW-formula', at: Date.now(), delayMs: 70 });
  await page.keyboard.type('=NOW()', { delay: 70 });
  current.actions.push({ action: 'keyboard-Enter', at: Date.now() });
  await page.keyboard.press('Enter');
  await waitState(value => value.selection.address === 'C3' && value.revision > before.revision, 'NOW formula must commit at C3');
  await snapshot('committed-NOW-formula');
  current.actions.push({ action: 'keyboard-ArrowUp-to-C2', at: Date.now() });
  await page.keyboard.press('ArrowUp');
  await waitState(value => value.selection.address === 'C2', 'Up must select the NOW formula cell C2');
  await snapshot('selected-NOW-formula');
}

function auditNow(file) {
  // Independent ZIP/XML read and Excel serial conversion; no native clock getters.
  const script = `import datetime, json, math, sys, zipfile
from xml.etree import ElementTree as ET
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as archive:
    book = ET.fromstring(archive.read('xl/workbook.xml'))
    props = book.find('s:workbookPr', ns)
    date1904 = props is not None and props.get('date1904', '0').lower() in ('1', 'true')
    sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    cell = sheet.find('.//s:c[@r="C2"]', ns)
    assert cell is not None, 'C2 NOW formula must be exported'
    formula = cell.findtext('s:f', '', ns)
    assert formula.lstrip('=').upper() == 'NOW()', formula
    assert cell.get('t', 'n') == 'n', 'NOW cached value must be numeric'
    serial = float(cell.findtext('s:v', 'nan', ns))
    assert math.isfinite(serial), 'NOW cached value must be finite'
    epoch = datetime.datetime(1904, 1, 1, tzinfo=datetime.timezone.utc) if date1904 else datetime.datetime(1899, 12, 30, tzinfo=datetime.timezone.utc)
    actual = epoch + datetime.timedelta(days=serial)
    actual_ms = actual.timestamp() * 1000
    lower, upper = float(sys.argv[2]), float(sys.argv[3])
    assert lower - 5000 <= actual_ms <= upper + 5000, f'NOW cache {actual.isoformat()} outside UTC input/export interval {lower}..{upper}'
    print(json.dumps({'formula': formula, 'serial': serial, 'date1904': date1904, 'utc': actual.isoformat(), 'unixMs': actual_ms, 'lowerMs': lower, 'upperMs': upper, 'toleranceMs': 5000, 'passed': True}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file, String(current.nowCheck.enteredAfterMs), String(current.nowCheck.exportedBeforeMs)],
    { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
}

async function save() {
  if (!current.auditBeforeSave) current.auditBeforeSave = await domSnapshot(true);
  phase = current.id + ' export';
  current.actions.push({ action: 'save-UI', at: Date.now() });
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const file = path.join(out, current.id + '-edited.xlsx');
  await (await pending).saveAs(file);
  if (current.nowCheck) current.nowCheck.exportedBeforeMs = Date.now();
  await idle();
  current.exported = inspect('export', file);
  current.exportedFile = path.basename(file);
  report.files.push({ file: path.basename(file), sha256: sha(file) });
  const cells = current.exported.cells;
  assert.deepEqual([cells.B2.type, cells.B2.value, cells.B2.formula], ['n', String(current.expectedB2Value ?? 314), '']);
  assert.equal(cells.A1.value, 'ORIGIN');
  assert.equal(cells.A4.value, 'KEEP');
  assert.equal(cells.C5.value, 'SHEET_SENTINEL');
  if (current.checkNow) {
    assert.ok(current.nowCheck, 'NOW formula must be entered before export');
    current.nowCheck.exportAudit = auditNow(file);
  }
  current.exportPassed = true;
}

async function run(scenario) {
  current = { ...scenario, snapshots: [], actions: [], captures: [] };
  report.cases.push(current);
  context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Etc/UTC', acceptDownloads: true });
  try {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push({ scenario: current.id, phase, message: error.message }));
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      const text = message.text().startsWith('[Office engine] dependency:') ? '[Office engine] startup file dependency (asset names counted)' : message.text();
      const key = JSON.stringify([current.id, message.type(), text]);
      if (consoleEntries.has(key)) consoleEntries.get(key).count++;
      else { const entry = { scenario: current.id, phase, type: message.type(), text, count: 1 }; consoleEntries.set(key, entry); report.console.push(entry); }
    });
    await page.routeWebSocket('**', () => {});
    await page.route('**/__native-smoke/*', route => route.fulfill({ status: 204, body: '' }));
    await page.addInitScript(() => {
      window.__calcInputAudit = [];
      const describe = node => node && (node.id || node.tagName || node.constructor?.name);
      for (const type of ['focus', 'blur', 'focusin', 'focusout', 'mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
        window.addEventListener(type, event => {
          const entry = { type, at: Date.now(), timestamp: event.timeStamp, target: describe(event.target), relatedTarget: describe(event.relatedTarget),
            activeElement: describe(document.activeElement), key: event.key, code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey,
            x: event.clientX, y: event.clientY, buttons: event.buttons, detail: event.detail, inputType: event.inputType, data: event.data,
            trusted: event.isTrusted, defaultPreventedAtCapture: event.defaultPrevented, canvasTextAtCapture: document.querySelector('#qtcanvas')?.textContent };
          window.__calcInputAudit.push(entry);
          if (window.__calcInputAudit.length > 400) window.__calcInputAudit.shift();
          setTimeout(() => { entry.defaultPreventedAfterTask = event.defaultPrevented; entry.canvasTextAfterTask = document.querySelector('#qtcanvas')?.textContent; entry.activeElementAfterTask = describe(document.activeElement); }, 0);
        }, true);
      }
    });
    await installOfficeStateReader(page);
    phase = current.id + ' open';
    console.log('START', current.id, current.name);
    await page.goto(process.env.OFFICE_WORKBENCH_URL || 'http://127.0.0.1:4299/');
    current.buildLabel = await page.locator('body').innerText().then(text => text.match(/202\d\.\d{4}\.\d+/)?.[0] || null);
    await page.getByTestId('document-open-input').setInputFiles(fixture);
    await idle();
    await page.getByLabel('单元格字体', { exact: true }).waitFor();
    current.documentId = (await state()).documentId;
    await snapshot('fresh-document');
    phase = current.id + ' initial visible B2 click';
    const baseline = await capture('before-edit');
    const selected = await clickPrimary(baseline);
    assert.equal(selected.cell.value, 25);
    await snapshot('selected-B2-before-typing');
    current.actions.push({ action: 'keyboard-type-314', at: Date.now(), delayMs: 70 });
    await page.keyboard.type('314', { delay: 70 });
    current.actions.push({ action: 'keyboard-Enter', at: Date.now() });
    await page.keyboard.press('Enter');
    await waitState(value => value.selection.address === 'B3' && value.revision > selected.revision, 'Enter must commit and advance toB3');
    current.committed = true;
    await snapshot('committed-B3-before-variant');
    phase = current.id + ' requested variant';
    if (scenario.focus) {
      current.actions.push({ action: 'explicit-DOM-canvas-focus', at: Date.now() });
      await page.frameLocator('iframe.office-frame').locator('#qtcanvas').focus();
      await snapshot('after-explicit-DOM-focus');
    }
    if (scenario.home) {
      current.actions.push({ action: 'keyboard-Control-Home', at: Date.now() });
      await page.keyboard.press('Control+Home');
      await waitState(value => value.selection.address === 'A1', 'Ctrl+Home must selectA1');
      await snapshot('after-Control-Home');
    }
    let target = await capture('before-probe-click');
    await snapshot('immediately-before-probe-click');
    phase = current.id + ' visible B2 probe';
    try {
      if (scenario.editProbe) {
        phase = current.id + ' edit-mode semantics';
        await checkEditSemantics(target, baseline);
      } else if (scenario.anchorFirst) {
        phase = current.id + ' distant A4 probe';
        try {
          await clickAnchor(target);
        } finally {
          await snapshot('after-anchor-probe');
          await page.screenshot({ path: path.join(out, current.id + '-after-anchor-probe.png') });
        }
        target = await capture('before-primary-probe-click');
        phase = current.id + ' visible B2 after A4 probe';
      }
      if (!scenario.editProbe) {
        const value = await clickPrimary(target);
        assert.equal(value.cell.value, 314);
      }
      current.selectionPassed = true;
    } catch (error) { current.selectionPassed = false; current.selectionError = error.message; }
    await snapshot('after-probe-click');
    if (scenario.checkNow && current.selectionPassed) await enterNowFormula();
    current.auditBeforeSave = await domSnapshot(true);
    await page.screenshot({ path: path.join(out, current.id + '-after-probe.png') });
    // Selection failure is preserved while normal UI export is still audited.
    await save();
    current.completed = true;
  } catch (error) {
    current.error = { phase, message: error.stack || String(error) };
    if (current.committed && !current.exportedFile) {
      try { await save(); } catch (saveError) { current.exportError = String(saveError.stack || saveError); }
    }
  } finally {
    if (page) {
      current.finalState = await state().catch(error => ({ error: String(error) }));
      current.auditAfterSave = await domSnapshot(true);
      await page.screenshot({ path: path.join(out, current.id + '-final.png'), timeout: 10000 }).catch(() => {});
    }
    console.log('RESULT', current.id, JSON.stringify({ completed: !!current.completed, selectionPassed: !!current.selectionPassed, selected: current.snapshots.find(value => value.name === 'after-probe-click')?.selection.address, exportPassed: !!current.exportPassed }));
    fs.writeFileSync(path.join(out, 'matrix-report.json'), JSON.stringify(report, null, 2) + '\n');
    await context.close();
    context = null;
    page = null;
  }
}

(async () => {
  try {
    await auditServedRuntime();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const scenario of selectedScenarios) await run(scenario);
    report.matrixCompleted = report.cases.length === selectedScenarios.length && report.cases.every(value => value.completed);
    report.sourceUnchanged = sha(fixture) === report.sourceSha256;
    report.frozenViewportScriptUnchanged = sha(path.join(__dirname, 'office-viewport-ui.cjs')) === report.frozenViewportScriptSha256;
    report.ok = report.matrixCompleted && report.cases.every(value => value.selectionPassed && value.exportPassed) && report.errors.length === 0 && report.sourceUnchanged && report.frozenViewportScriptUnchanged;
    if (!report.ok) process.exitCode = 1;
  } catch (error) { report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; }
  finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    fs.writeFileSync(path.join(out, 'matrix-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Calc input matrix:', path.join(out, 'matrix-report.json'));
  }
})();
