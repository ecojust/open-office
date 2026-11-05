/* Real Vue calendar shell, DOM forms/drag gestures, browser download and reopen.
 * Run: node tests/browser/calendar-notes.cjs. Uses the existing public WASM files;
 * no native build, private data, external write, or installed-app evidence.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const focus = process.env.OFFICE_CALENDAR_FOCUS || '';
const output = path.resolve(process.env.OFFICE_CALENDAR_OUTPUT || path.join(root, ['allocation-boundaries', 'week-settings', 'drag-summary', 'value-layout'].includes(focus) ? `test-results/calendar-notes-${focus}` : 'test-results/calendar-notes'));
const sources = ['src/App.vue', 'src/components/CalendarEditor.vue', 'src/calendar/model.ts', 'src/calendar/allocation.ts', 'src/calendar/components/CalendarWorkCapsule.vue', 'src/calendar/session.ts', 'src/calendar/calendar.ts', 'src/calendar/almanac.ts', 'src/calendar/mcp.ts', 'src/shared/document.ts', 'src/shared/printing.ts', 'src/style.css'];
const hashes = () => Object.fromEntries(sources.filter(file => fs.existsSync(path.join(root, file))).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue UI in Chromium with deterministic public holiday fixtures; actual browser downloads and file imports', checks: [], screenshots: [], printEvidence: [], pointerGestures: [], dragGestures: [], errors: [], consoleErrors: [], externalRequests: [], holidayRequests: [], limitations: ['Native dialogs, native filesystem autosave and installed platform WebViews are not exercised.', 'Public holiday network responses are deterministic fixtures, not live availability evidence.', 'Mouse, keyboard and drag input are automated browser events; physical input is not exercised.', 'Native operating-system drag cursors and drag images are not captured by Chromium screenshots; drop acceptance and source-icon visibility are checked in the DOM.', 'Printing captures the generated browser print DOM; system print dialogs and printer output are not exercised.'] };
fs.mkdirSync(output, { recursive: true });
let server, browser, page;
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const editor = () => page.locator('[data-testid="calendar-editor"]:visible');
const day = date => editor().getByTestId(`calendar-day-${date}`);
const note = id => editor().getByTestId(`calendar-note-${id}`);
const capsule = date => editor().getByTestId(`calendar-work-capsule-${date}`);
const title = id => editor().getByTestId(`calendar-note-title-${id}`);
const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6, `${label}: ${actual} versus ${expected}`);
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function poll(predicate, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await page.waitForTimeout(35); } throw Error(`Timed out: ${label}`); }
async function active() { return page.evaluate(() => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return { key: a.activeKey, kind: a.active?.document.kind, ready: a.active?.ready, dirty: a.active?.dirty, busy: !!a.busy, loadError: a.active?.loadError }; }); }
async function ready() { await poll(async () => { const a = await active(); if (a.loadError) throw Error(a.loadError); return a.ready && !a.busy && a.kind === 'calendar'; }, 'calendar editor ready'); await frame(); }
async function state() { return page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.handleFor(a.active).inspect(); }); }
async function exported() { return page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; const result = await a.handleFor(a.active).exportFile({ format: 'oocalendar' }); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)))); }); }
async function month(value) { await editor().getByTestId('calendar-month').fill(value); await editor().getByTestId('calendar-month').dispatchEvent('change'); await frame(); }
async function custom(date) { await day(date).click({ button: 'right' }); await page.getByTestId('calendar-context-custom').click(); await page.getByTestId('calendar-note-dialog').waitFor(); }
async function settings(values, commit = true) {
  await editor().getByTestId('calendar-settings').click(); await page.getByTestId('calendar-settings-dialog').waitFor();
  if (values.title !== undefined) await page.getByTestId('calendar-book-title').fill(values.title);
  if (values.workdayHours !== undefined) await page.getByTestId('calendar-workday-hours').fill(String(values.workdayHours));
  if (values.weekMode !== undefined) await page.getByTestId('calendar-week-mode').selectOption(values.weekMode);
  if (values.allocationDisplay !== undefined) await page.getByTestId('calendar-allocation-display').selectOption(values.allocationDisplay);
  await page.getByTestId(commit ? 'calendar-settings-confirm' : 'calendar-note-cancel').click(); await frame();
}
async function add(date, title, content = '', color = '#3b82f6', type = '工作日') { await custom(date); await page.getByTestId('calendar-note-title').fill(title); await page.getByTestId('calendar-note-content').fill(content); await page.getByTestId('calendar-note-color').fill(color); await page.getByTestId('calendar-note-type').selectOption(type); await page.getByTestId('calendar-note-confirm').click(); await frame(); const result = (await exported()).notes.find(n => n.date === date && n.title === title); assert.ok(result); return result; }
async function undo() { await page.getByTestId('global-toolbar').getByRole('button', { name: '撤销', exact: true }).click(); await frame(); }
async function redo() { await page.getByTestId('global-toolbar').getByRole('button', { name: '重做', exact: true }).click(); await frame(); }
async function remove(id) { await note(id).hover(); await editor().getByTestId(`calendar-note-delete-${id}`).click(); await page.getByTestId('calendar-delete-confirm').click(); await frame(); }
async function capture(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file); }
async function check(name, fn) { report.stage = name; persist(); await fn(); report.checks.push(name); persist(); }
async function saveDownload(filename, saveAs = false) {
  if (saveAs) { await page.getByTestId('shell-save-as').click(); await page.getByTestId('save-format-name').fill(filename.replace(/\.oocalendar$/, '')); }
  const pending = page.waitForEvent('download'); await page.getByTestId(saveAs ? 'save-format-confirm' : 'shell-save').click(); const download = await pending;
  assert.ok(download.suggestedFilename().endsWith('.oocalendar')); const target = path.join(output, filename); await download.saveAs(target); const bytes = fs.readFileSync(target); return { target, bytes, model: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}
async function allocations(date, expected) {
  const book = await exported(), work = book.notes.filter(n => n.date === date && n.type === '工作日');
  assert.equal(work.length, Object.keys(expected).length); assert.equal(await capsule(date).count(), work.length ? 1 : 0);
  let percent = 0, hours = 0;
  for (const n of work) {
    const weight = n.weight ?? 1 / work.length; near(weight, expected[n.id], `${n.title} persisted weight`);
    const segment = capsule(date).getByTestId(`calendar-note-${n.id}`), shownPercent = Number(await segment.getAttribute('data-allocation-percent')), shownHours = Number(await segment.getAttribute('data-allocation-hours'));
    near(shownPercent, weight * 100, `${n.title} displayed percent`); near(shownHours, weight * book.workdayHours, `${n.title} displayed hours`); percent += shownPercent; hours += shownHours;
  }
  if (work.length) { near(percent, 100, 'day conserves 100%'); near(hours, book.workdayHours, 'day conserves total hours'); }
  return book;
}
async function resize(date, leftId, rightId, ratio, scope = editor()) {
  const container = scope.getByTestId(`calendar-work-capsule-${date}`), handle = container.getByTestId(`calendar-work-divider-${leftId}-${rightId}`);
  await handle.scrollIntoViewIfNeeded(); const box = await container.boundingBox(), grip = await handle.boundingBox(); assert.ok(box && grip);
  await handle.evaluate(element => { window.calendarPointerEvents = []; for (const type of ['pointerdown', 'pointermove', 'pointerup']) element.addEventListener(type, event => window.calendarPointerEvents.push({ type: event.type, trusted: event.isTrusted })); });
  const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, end = { x: box.x + box.width * ratio, y: start.y };
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up(); await frame();
  const events = await page.evaluate(() => window.calendarPointerEvents); assert.ok(events.some(e => e.type === 'pointerdown' && e.trusted)); assert.ok(events.some(e => e.type === 'pointermove' && e.trusted)); assert.ok(events.some(e => e.type === 'pointerup' && e.trusted)); report.pointerGestures.push({ date, leftId, rightId, ratio, start, end, events });
}
async function mouseDrag(source, target, { modifier, copy = false, release = true, label = 'calendar-note-drag', during } = {}) {
  await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(), to = await target.boundingBox(); assert.ok(from && to);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }, end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.evaluate(() => { window.calendarDragEvents = []; });
  if (modifier) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 8, start.y + 3, { steps: 3 });
    await page.mouse.move(end.x, end.y, { steps: 10 }); await page.mouse.move(end.x + 1, end.y, { steps: 2 }); await frame();
    const hints = editor().locator('.calendar-drop-hint');
    assert.ok((await hints.allTextContents()).some(value => value.includes(copy ? '复制' : '移动')), `${label}: dragging shows the intended ${copy ? 'copy' : 'move'} action`);
    if (during) await during();
    if (!release) await page.keyboard.press('Escape');
    await page.mouse.up(); await frame();
  } finally { if (modifier) await page.keyboard.up(modifier); }
  const events = await page.evaluate(() => window.calendarDragEvents);
  const nativeDrag = events.filter(event => event.type === 'dragstart');
  if (nativeDrag.length) {
    assert.ok(nativeDrag.every(event => event.trusted), `${label}: native drag starts from real mouse input`);
    assert.ok(events.some(event => event.type === 'dragover' && event.prevented && event.dropEffect === (copy ? 'copy' : 'move')), `${label}: valid native drop target accepts the intended action`);
    if (release) assert.ok(events.some(event => event.type === 'drop' && event.trusted), `${label}: a real native drop reaches the target`);
  } else {
    assert.ok(events.some(event => event.type === 'pointerdown' && event.trusted), `${label}: pointer drag starts from real mouse input`);
    assert.ok(events.some(event => event.type === 'pointermove' && event.trusted), `${label}: pointer drag has real movement`);
  }
  report.dragGestures.push({ label, modifier: modifier || null, copy, cancelled: !release, start, end, events }); persist();
}
async function dragSummaryChecks() {
  const fixture = { format: 'open-office-calendar', version: 1, id: 'drag-summary-calendar', title: '胶囊拖拽及汇总单位验收', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', history: [], notes: [
    ['drag-a', '2026-11-04', '需求设计', .7, '#3b82f6'], ['drag-b', '2026-11-04', '开发实现', .3, '#16a34a'], ['drag-c', '2026-11-05', '发布准备', 1, '#8b5cf6'],
  ].map(([id, date, title, weight, color]) => ({ id, date, title, weight, color, type: '工作日', content: `${title}的正文`, created_at: '2026-11-01T10:00:00.000Z' })) };
  await page.getByTestId('document-open-input').setInputFiles({ name: '胶囊拖拽验收.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11');
  await page.evaluate(() => {
    window.calendarDragEvents = [];
    if (window.calendarDragTraceInstalled) return;
    window.calendarDragTraceInstalled = true;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => {
      if (!event.target.closest?.('[data-testid="calendar-editor"]')) return;
      if (window.calendarDragEvents.length >= 200) return;
      window.calendarDragEvents.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented, dropEffect: event.dataTransfer?.dropEffect, effectAllowed: event.dataTransfer?.effectAllowed, ctrlKey: event.ctrlKey, metaKey: event.metaKey, target: event.target.getAttribute?.('data-testid') || event.target.tagName });
    }, type !== 'dragover');
  });
  const text = id => title(id).locator('span').first();
  await check('capsule-title-mouse-drag-moves-over-another-capsule-and-allows-undo', async () => {
    const before = await exported();
    await mouseDrag(text('drag-a'), text('drag-c'), { label: 'title-to-existing-capsule-move', during: async () => { assert.deepEqual((await state()).book, before); await capture('calendar-capsule-move-preview'); } });
    assert.equal((await exported()).notes.find(n => n.id === 'drag-a').date, '2026-11-05');
    await allocations('2026-11-04', { 'drag-b': 1 }); await allocations('2026-11-05', { 'drag-a': .5, 'drag-c': .5 });
    assert.equal(await page.getByTestId('calendar-note-dialog').count(), 0); assert.equal(await page.getByTestId('calendar-delete-dialog').count(), 0);
    await undo(); assert.deepEqual(await exported(), before);
  });
  await check('capsule-title-control-and-meta-copy-to-empty-and-occupied-days', async () => {
    for (const [modifier, date, target] of [['Control', '2026-11-10', () => day('2026-11-10')], ['Meta', '2026-11-05', () => text('drag-c')]]) {
      const before = await exported(); await mouseDrag(text('drag-a'), target(), { modifier, copy: true, label: `title-${modifier.toLowerCase()}-copy` });
      const book = await exported(), copies = book.notes.filter(n => n.id !== 'drag-a' && n.title === '需求设计'); assert.equal(copies.length, 1);
      assert.equal(copies[0].date, date); assert.equal(copies[0].content, fixture.notes[0].content); assert.equal(copies[0].color, fixture.notes[0].color); assert.equal(book.notes.find(n => n.id === 'drag-a').date, '2026-11-04');
      await allocations('2026-11-04', { 'drag-a': .7, 'drag-b': .3 });
      await allocations(date, date === '2026-11-05' ? { 'drag-c': .5, [copies[0].id]: .5 } : { [copies[0].id]: 1 });
      await undo(); assert.deepEqual(await exported(), before);
    }
  });
  await check('same-day-drag-keeps-allocation-and-control-drag-copies-with-one-undo', async () => {
    const before = await exported(), revision = (await state()).revision;
    await mouseDrag(text('drag-a'), text('drag-b'), { label: 'same-day-move' }); assert.deepEqual(await exported(), before); assert.equal((await state()).revision, revision);
    await mouseDrag(text('drag-a'), text('drag-b'), { modifier: 'Control', copy: true, label: 'same-day-copy' });
    const book = await exported(), copy = book.notes.find(n => !before.notes.some(original => original.id === n.id)); assert.ok(copy); assert.equal(copy.date, '2026-11-04');
    await allocations('2026-11-04', { 'drag-a': 1 / 3, 'drag-b': 1 / 3, [copy.id]: 1 / 3 });
    assert.equal((await state()).revision, revision + 1); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('capsule-escape-cancels-drag-and-divider-resize-never-moves-notes', async () => {
    const before = await exported(); await mouseDrag(text('drag-a'), text('drag-c'), { release: false, label: 'escape-cancels-title-drag' }); assert.deepEqual(await exported(), before); assert.equal(await editor().locator('.calendar-drop-hint').count(), 0);
    const dates = before.notes.map(n => [n.id, n.date]); await resize('2026-11-04', 'drag-a', 'drag-b', .59); await allocations('2026-11-04', { 'drag-a': .6, 'drag-b': .4 });
    assert.deepEqual((await exported()).notes.map(n => [n.id, n.date]), dates); assert.equal(await editor().locator('.calendar-drop-hint').count(), 0); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('dragging-hides-source-delete-icon-and-can-drop-over-day-adjust-control', async () => {
    const before = await exported();
    await mouseDrag(text('drag-a'), editor().getByTestId('calendar-day-allocation-2026-11-05'), { label: 'drop-over-day-adjust-control', during: async () => {
      const button = editor().getByTestId('calendar-note-delete-drag-a');
      if (await button.count()) assert.equal(await button.evaluate(element => { const style = getComputedStyle(element); return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0; }), true, 'The source delete cross is hidden during the drag');
      await capture('calendar-drag-over-day-adjust-control');
    } });
    assert.equal((await exported()).notes.find(n => n.id === 'drag-a').date, '2026-11-05'); assert.equal(await page.getByTestId('calendar-day-dialog').count(), 0); assert.equal(await page.getByTestId('calendar-delete-dialog').count(), 0);
    await undo(); assert.deepEqual(await exported(), before);
  });
  await check('expanded-day-allocation-resizes-without-an-invalid-event-drag-affordance', async () => {
    const before = await exported(); await editor().getByTestId('calendar-day-allocation-2026-11-04').click(); const dialog = page.getByTestId('calendar-day-dialog'); await dialog.waitFor();
    const source = dialog.getByTestId('calendar-note-title-drag-a').locator('span').first(), target = dialog.getByTestId('calendar-note-title-drag-b').locator('span').first();
    assert.notEqual(await source.evaluate(element => getComputedStyle(element.closest('button')).cursor), 'grab', 'The expanded allocation title does not advertise an unavailable date move');
    await dialog.evaluate(element => { window.calendarExpandedDragStarts = 0; element.addEventListener('dragstart', () => window.calendarExpandedDragStarts++, { capture: true }); });
    const from = await source.boundingBox(), to = await target.boundingBox(); assert.ok(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 }); await page.mouse.up(); await frame();
    assert.equal(await page.evaluate(() => window.calendarExpandedDragStarts), 0); assert.deepEqual((await state()).book, before);
    await resize('2026-11-04', 'drag-a', 'drag-b', .59, dialog); await dialog.getByTestId('calendar-note-cancel').click(); await frame();
    await allocations('2026-11-04', { 'drag-a': .6, 'drag-b': .4 }); assert.deepEqual((await exported()).notes.map(n => [n.id, n.date]), before.notes.map(n => [n.id, n.date])); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('month-summary-and-print-follow-settings-hours-or-days', async () => {
    async function assertSummary(mode, amount, unit) {
      const tags = editor().getByTestId('calendar-summary').locator('.calendar-summary-tag'), row = tags.filter({ hasText: '需求设计' });
      const shown = await row.innerText(); assert.ok(shown.includes(`${amount}${unit}`) || shown.includes(`${amount} ${unit}`), `${mode} summary shows ${amount} ${unit}: ${shown}`);
      const all = await tags.allTextContents(); for (const value of all) assert.equal(mode === 'hours' ? /\d\s*天/.test(value) : /\d\s*(?:h|小时)/.test(value), false, `${mode} summary does not mix quantity units: ${value}`);
      const hint = await row.getAttribute('title'); assert.ok(hint); assert.equal(mode === 'hours' ? /\d\s*天/.test(hint) : /\d\s*(?:h|小时)/.test(hint), false, `${mode} summary tooltip follows the selected unit: ${hint}`);
      await page.evaluate(() => { window.calendarOriginalPrint = window.print; window.calendarPrinted = undefined; window.print = () => { const root = document.querySelector('#office-print-root'); window.calendarPrinted = { summary: root.querySelector('.work-summary')?.textContent, html: root.outerHTML }; }; });
      try {
        await page.getByTestId('shell-print').click(); await poll(() => page.evaluate(() => !!window.calendarPrinted), 'summary print generated');
        const printed = await page.evaluate(() => window.calendarPrinted); const offsets = fixture.notes.map(note => printed.summary.indexOf(note.title)); assert.ok(offsets.every(index => index >= 0), 'All work categories appear in the printed summary'); const entries = printed.summary.slice(Math.min(...offsets));
        assert.ok(entries.includes(`${amount} ${unit}`) || entries.includes(`${amount}${unit}`), `${mode} print summary uses selected unit: ${entries}`);
        assert.equal(mode === 'hours' ? /\d\s*天/.test(entries) : /\d\s*(?:h|小时)/.test(entries), false, `${mode} print entries do not mix quantity units: ${entries}`);
        fs.writeFileSync(path.join(output, `calendar-summary-${mode}.html`), printed.html); report.printEvidence.push({ label: `summary-${mode}`, summary: printed.summary });
      } finally { await page.evaluate(() => { window.print = window.calendarOriginalPrint; delete window.calendarOriginalPrint; window.dispatchEvent(new Event('afterprint')); }); await frame(); }
    }
    await assertSummary('percent', .7, '天'); await settings({ allocationDisplay: 'hours' }); await assertSummary('hours', 4.9, '小时');
    await settings({ workdayHours: 8 }); await assertSummary('hours', 5.6, '小时'); await settings({ allocationDisplay: 'percent' }); await assertSummary('percent', .7, '天'); await capture('calendar-summary-selected-unit');
  });
}
async function valueLayoutChecks() {
  await page.setViewportSize({ width: 1360, height: 900 });
  if (await page.getByTestId('shell-focus-exit').isVisible()) await page.getByTestId('shell-focus-exit').click();
  await page.getByTestId('theme-light').click(); await frame();
  if (await page.locator('.document-tab').count()) {
    await page.getByTestId('tabs-close-all').click(); await poll(async () => !(await page.locator('.document-tab').count()) || (await page.getByTestId('close-discard').isVisible()), 'close prior fixtures');
    if (await page.getByTestId('close-discard').isVisible()) await page.getByTestId('close-discard').click();
    await poll(async () => !(await page.locator('.document-tab').count()), 'prior fixtures closed');
  }
  const fixture = { format: 'open-office-calendar', version: 1, id: 'value-layout-calendar', title: '数字直接编辑验收', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', history: [], notes: [
    ['value-a', '2026-11-04', '设计工作', .2, '#3b82f6'], ['value-b', '2026-11-04', '研发工作', .3, '#16a34a'], ['value-c', '2026-11-04', '测试工作', .5, '#8b5cf6'], ['value-single', '2026-11-09', '单项工作', 1, '#f59e0b'],
  ].map(([id, date, title, weight, color]) => ({ id, date, title, weight, color, type: '工作日', content: '原事项正文保持不变', created_at: '2026-11-01T10:00:00.000Z' })) };
  await page.getByTestId('document-open-input').setInputFiles({ name: '数字直接编辑.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11');
  const value = (id, scope = editor()) => scope.getByTestId(`calendar-note-value-${id}`);
  const dialog = () => page.getByTestId('calendar-allocation-dialog');
  const input = () => dialog().getByTestId('calendar-allocation-value');
  async function openValue(id = 'value-a', scope = editor(), keyboard = false) {
    if (keyboard) await value(id, scope).press('Enter'); else await value(id, scope).dblclick();
    await dialog().waitFor(); await frame(); assert.equal(await page.getByTestId('calendar-note-dialog').count(), 0, 'Double-clicking a quantity never opens the note editor');
  }
  async function commitValue(amount) { await input().fill(String(amount)); await dialog().getByTestId('calendar-allocation-confirm').click(); await frame(); }
  async function cancelValue() { await dialog().getByTestId('calendar-note-cancel').click(); await frame(); }
  await check('quantity-double-click-and-enter-open-draft-dialog-with-cancel-and-no-op', async () => {
    const before = await exported(), original = await state();
    await openValue(); assert.equal(Number(await input().inputValue()), 20); assert.equal(await input().evaluate(e => e === document.activeElement), true);
    await input().fill('42.5'); assert.deepEqual((await state()).book, before); assert.equal((await state()).revision, original.revision); await capture('calendar-direct-value-dialog');
    await cancelValue(); assert.deepEqual(await exported(), before); assert.equal((await state()).revision, original.revision);
    await openValue('value-a', editor(), true); await dialog().getByTestId('calendar-allocation-confirm').click(); await frame(); assert.equal(await dialog().count(), 0); assert.deepEqual(await exported(), before); assert.equal((await state()).revision, original.revision);
  });
  await check('direct-percent-change-preserves-other-ratios-and-is-one-undo', async () => {
    const before = await exported(), revision = (await state()).revision;
    await openValue(); await commitValue(40); await allocations('2026-11-04', { 'value-a': .4, 'value-b': .225, 'value-c': .375 });
    assert.equal((await state()).revision, revision + 1); assert.deepEqual((await exported()).notes.map(n => [n.id, n.date, n.title, n.content]), before.notes.map(n => [n.id, n.date, n.title, n.content]));
    await undo(); assert.deepEqual(await exported(), before); await redo(); await allocations('2026-11-04', { 'value-a': .4, 'value-b': .225, 'value-c': .375 }); await undo();
    await openValue(); await commitValue(37.5); await allocations('2026-11-04', { 'value-a': .375, 'value-b': .234375, 'value-c': .390625 }); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('direct-value-validates-range-and-single-work-stays-full-day', async () => {
    const before = await exported(), revision = (await state()).revision; await openValue();
    for (const amount of ['', '-1', '101']) {
      await input().fill(amount); await dialog().getByTestId('calendar-allocation-confirm').click(); await frame(); assert.ok(await dialog().isVisible()); assert.deepEqual((await state()).book, before); assert.equal((await state()).revision, revision);
      assert.ok((await input().evaluate(e => !e.validity.valid)) || (await dialog().innerText()).includes('范围'), 'Invalid value is visibly rejected');
    }
    await cancelValue(); await openValue('value-single'); assert.equal(Number(await input().inputValue()), 100);
    if (!(await input().isDisabled()) && !(await input().evaluate(e => e.readOnly))) {
      await input().fill('50'); await dialog().getByTestId('calendar-allocation-confirm').click(); await frame(); assert.ok(await dialog().isVisible());
    }
    assert.deepEqual((await state()).book, before); assert.match(await dialog().innerText(), /全天|100%/); await cancelValue(); assert.deepEqual(await exported(), before);
  });
  await check('direct-value-handles-zero-full-and-previously-zero-peers', async () => {
    const before = await exported(); await openValue(); await commitValue(100); await allocations('2026-11-04', { 'value-a': 1, 'value-b': 0, 'value-c': 0 });
    await openValue(); await commitValue(60); await allocations('2026-11-04', { 'value-a': .6, 'value-b': .2, 'value-c': .2 });
    await openValue(); await commitValue(0); await allocations('2026-11-04', { 'value-a': 0, 'value-b': .5, 'value-c': .5 });
    await undo(); await undo(); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('expanded-day-quantity-dialog-returns-to-day-and-can-be-undone', async () => {
    const before = await exported(); await editor().getByTestId('calendar-day-allocation-2026-11-04').click(); const details = page.getByTestId('calendar-day-dialog'); await details.waitFor();
    await openValue('value-b', details); await input().fill('46.5'); await cancelValue(); await details.waitFor(); assert.deepEqual((await state()).book, before);
    await openValue('value-b', details); await commitValue(44); await details.waitFor(); assert.equal(await page.getByTestId('calendar-note-dialog').count(), 0);
    await details.getByTestId('calendar-note-cancel').click(); await frame(); await allocations('2026-11-04', { 'value-a': .16, 'value-b': .44, 'value-c': .4 }); await undo(); assert.deepEqual(await exported(), before);
  });
  await check('direct-hours-accepts-precise-value-with-nondefault-day-and-survives-reopen', async () => {
    await settings({ allocationDisplay: 'hours', workdayHours: 8 }); const before = await exported(); await openValue(); assert.equal(Number(await input().inputValue()), 1.6);
    await commitValue(1.25); await allocations('2026-11-04', { 'value-a': .15625, 'value-b': .31640625, 'value-c': .52734375 });
    const edited = await exported(); await undo(); assert.deepEqual(await exported(), before); await redo(); assert.deepEqual(await exported(), edited);
    const download = await saveDownload('直接编辑工时.oocalendar', true), session = (await state()).documentId; assert.deepEqual(download.model, edited);
    await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); await month('2026-11'); assert.notEqual((await state()).documentId, session); assert.deepEqual(await exported(), edited);
    await allocations('2026-11-04', { 'value-a': .15625, 'value-b': .31640625, 'value-c': .52734375 }); await capture('calendar-direct-hours-saved');
  });
  const dense = { ...fixture, id: 'calendar-fit-density', title: '六行月历自适应布局验收', notes: [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `dense-work-${index}`, date: '2026-11-04', title: `工作事项${index + 1}及其完整名称`, color: ['#3b82f6', '#16a34a', '#8b5cf6'][index % 3], weight: 1 / 8, type: '工作日', content: `工作正文${index + 1}`, created_at: '2026-11-01T10:00:00.000Z' })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `dense-off-${index}`, date: '2026-11-04', title: `非工作事项${index + 1}`, color: '#f59e0b', type: '非工作日', content: `非工作正文${index + 1}`, created_at: '2026-11-01T10:00:00.000Z' })),
    { id: 'last-row-note', date: '2026-12-02', title: '最后一周仍可操作', color: '#3b82f6', type: '工作日', weight: 1, content: '', created_at: '2026-11-01T10:00:00.000Z' },
  ] };
  await page.getByTestId('document-open-input').setInputFiles({ name: '密集日历布局.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dense)) }); await ready(); await month('2026-11');
  async function assertFit(label, columns) {
    const geometry = await editor().evaluate(element => {
      const bounds = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; };
      const viewport = element.querySelector('.calendar-scroll'), grid = element.querySelector('.calendar-grid');
      return { outer: bounds(element), viewport: bounds(viewport), grid: bounds(grid), cells: [...grid.querySelectorAll('[role="gridcell"]')].map(bounds), root: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight } };
    });
    report.layoutEvidence ||= []; report.layoutEvidence.push({ label, columns, ...geometry }); persist();
    assert.equal(geometry.cells.length, columns * 6);
    for (const [name, item] of [['viewport', geometry.viewport], ['grid', geometry.grid], ...geometry.cells.map((cell, index) => [`cell-${index}`, cell])]) {
      assert.ok(item.height > 0 && item.width > 0, `${label}: ${name} has positive size`);
      assert.ok(item.scrollHeight <= item.clientHeight + 1, `${label}: ${name} vertically fits (${item.scrollHeight}/${item.clientHeight})`);
      assert.ok(item.scrollWidth <= item.clientWidth + 1, `${label}: ${name} horizontally fits (${item.scrollWidth}/${item.clientWidth})`);
    }
    assert.ok(geometry.grid.y >= geometry.viewport.y - 1 && geometry.grid.bottom <= geometry.viewport.bottom + 1, `${label}: all six rows fit in the actual viewport`);
    assert.ok(geometry.cells.at(-1).bottom <= geometry.viewport.bottom + 1 && geometry.cells.at(-1).bottom <= geometry.root.height, `${label}: final week is on screen`);
    const heights = geometry.cells.map(cell => cell.height); assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `${label}: six rows share available height equally`);
    assert.ok(geometry.root.scrollWidth <= geometry.root.width + 1 && geometry.root.scrollHeight <= geometry.root.height + 1, `${label}: document does not scroll`);
    const entry = editor().getByTestId('calendar-day-allocation-2026-11-04'); const hit = await entry.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }); assert.equal(hit, true, `${label}: dense-day details entry remains clickable`);
    await entry.click(); const details = page.getByTestId('calendar-day-dialog'); await details.waitFor(); assert.equal(await details.locator('.calendar-day-list > button').count(), 13, `${label}: all dense-day notes remain accessible`);
    for (const item of dense.notes.filter(n => n.date === '2026-11-04')) assert.equal(await details.locator(`.calendar-day-list > button[data-note-id="${item.id}"]`).count(), 1);
    await details.getByTestId('calendar-note-cancel').click(); await frame();
    const summary = editor().getByTestId('calendar-summary');
    const summaryGeometry = await summary.locator('.calendar-summary-tags').evaluate(node => { const style = getComputedStyle(node); return { overflowX: style.overflowX, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; });
    assert.ok(summaryGeometry.scrollWidth <= summaryGeometry.clientWidth + 1 || !['auto', 'scroll'].includes(summaryGeometry.overflowX), `${label}: month summary has no horizontal scrollbar`);
    await editor().getByTestId('calendar-summary-more').click(); const summaryDialog = page.getByTestId('calendar-summary-dialog'); await summaryDialog.waitFor();
    const workTitles = dense.notes.filter(n => n.date.startsWith('2026-11') && n.type === '工作日').map(n => n.title);
    assert.equal(await summaryDialog.locator('.calendar-summary-tag').count(), workTitles.length, `${label}: collapsed summary retains every monthly work category`);
    for (const name of workTitles) assert.ok((await summaryDialog.innerText()).includes(name));
    await summaryDialog.getByTestId('calendar-note-cancel').click(); await frame(); await day('2026-12-02').click(); assert.equal((await state()).view.selectedDate, '2026-12-02');
  }
  await check('six-calendar-rows-fit-week-and-work-with-dense-days-at-three-window-sizes', async () => {
    for (const [width, height] of [[1360, 900], [1000, 700], [900, 640]]) {
      await page.setViewportSize({ width, height }); await frame();
      for (const weekMode of ['week', 'work']) {
        await settings({ weekMode }); const before = await exported(); await assertFit(`${weekMode}-${width}x${height}`, weekMode === 'work' ? 5 : 7); assert.deepEqual(await exported(), before); await capture(`calendar-fit-${weekMode}-${width}x${height}`);
      }
    }
  });
  await check('fullscreen-resize-and-exit-keep-six-visible-rows-without-losing-notes', async () => {
    for (const weekMode of ['week', 'work']) {
      await settings({ weekMode }); const before = await exported(); await page.getByTestId('shell-focus-enter').click(); await frame(); await assertFit(`focus-${weekMode}-900x640`, weekMode === 'work' ? 5 : 7); await capture(`calendar-fit-focus-${weekMode}`);
      await page.setViewportSize({ width: 1360, height: 900 }); await frame(); await assertFit(`focus-${weekMode}-1360x900`, weekMode === 'work' ? 5 : 7); await page.getByTestId('shell-focus-exit').click(); await frame(); assert.deepEqual(await exported(), before);
      await page.setViewportSize({ width: 900, height: 640 }); await frame();
    }
    await page.setViewportSize({ width: 1360, height: 900 }); await frame();
  });
}

async function closeError() { const error = page.locator('.error-banner'); if (await error.count()) await error.getByRole('button').click(); await frame(); }
async function allocationBoundaryChecks() {
  await check('keyboard-home-end-reach-unsnapped-adjacent-pair-boundaries', async () => {
    const fixture = { format: 'open-office-calendar', version: 1, id: 'boundary-calendar', title: '分隔线键盘边界验收', workdayHours: 7, allocationDisplay: 'percent', history: [], notes: [
      ['boundary-a', '需求', .38, '#3b82f6'], ['boundary-b', '开发', .2, '#16a34a'], ['boundary-c', '测试', .42, '#8b5cf6'],
    ].map(([id, title, weight, color]) => ({ id, title, weight, color, date: '2026-11-06', type: '工作日', content: '', created_at: '2026-11-01T10:00:00.000Z' })) };
    await page.getByTestId('document-open-input').setInputFiles({ name: '分隔线边界.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11');
    const original = await exported(), divider = capsule('2026-11-06').getByTestId('calendar-work-divider-boundary-b-boundary-c');
    await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': .2, 'boundary-c': .42 });
    await divider.press('Home'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': 0, 'boundary-c': .62 }); await capture('calendar-unsnapped-home'); await undo(); assert.deepEqual(await exported(), original);
    await divider.press('End'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': .62, 'boundary-c': 0 }); await capture('calendar-unsnapped-end'); await undo(); assert.deepEqual(await exported(), original);
    await settings({ allocationDisplay: 'hours' }); const hours = await exported();
    await divider.press('Home'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': 0, 'boundary-c': .62 }); await undo(); assert.deepEqual(await exported(), hours);
    await divider.press('End'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': .62, 'boundary-c': 0 }); await undo(); assert.deepEqual(await exported(), hours);
  });
}
async function printedCalendar(label, columns, articleCount) {
  await page.evaluate(() => {
    window.calendarOriginalPrint = window.print; window.calendarPrinted = undefined;
    window.print = () => { const root = document.querySelector('#office-print-root'); window.calendarPrinted = { headers: [...root.querySelectorAll('table th')].map(e => e.textContent), rows: [...root.querySelectorAll('table tr')].slice(1).map(row => [...row.querySelectorAll('td')].map(cell => cell.querySelector('strong')?.textContent || '')), summary: root.querySelector('.work-summary')?.textContent, articles: [...root.querySelectorAll('article')].map(e => e.textContent), html: root.outerHTML }; };
  });
  try {
    await page.getByTestId('shell-print').click(); await poll(() => page.evaluate(() => !!window.calendarPrinted), 'calendar print content');
    const printed = await page.evaluate(() => window.calendarPrinted); assert.equal(printed.headers.length, columns); assert.equal(printed.rows.length, 6); assert.ok(printed.rows.every(row => row.length === columns)); assert.equal(printed.articles.length, articleCount); assert.ok(printed.summary.includes('周六工作') && printed.summary.includes('周日工作'));
    if (columns === 5) for (const date of printed.rows.flat().filter(Boolean)) assert.ok(![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()), `Work print hides weekend ${date}`);
    fs.writeFileSync(path.join(output, `${label}.html`), printed.html); const { html, ...evidence } = printed; report.printEvidence.push({ label, ...evidence });
    await page.emulateMedia({ media: 'print' }); await capture(label);
  } finally { await page.emulateMedia({ media: 'screen' }); await page.evaluate(() => { window.print = window.calendarOriginalPrint; delete window.calendarOriginalPrint; window.dispatchEvent(new Event('afterprint')); }); await frame(); }
  assert.equal(await page.locator('#office-print-root').count(), 0);
}
async function weekSettingsChecks() {
  // Earlier independent scenarios have already saved and verified their fixtures.
  // Use normal shell close/discard so this group stays below the eight-tab limit.
  if (await page.locator('.document-tab').count()) {
    await page.getByTestId('tabs-close-all').click(); await poll(async () => !(await page.locator('.document-tab').count()) || (await page.getByTestId('close-discard').isVisible()), 'close previous fixture tabs');
    if (await page.getByTestId('close-discard').isVisible()) await page.getByTestId('close-discard').click();
    await poll(async () => !(await page.locator('.document-tab').count()), 'previous fixture tabs closed'); await frame();
  }
  const fixture = { format: 'open-office-calendar', version: 1, id: 'week-settings-calendar', title: '周视图验收', workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week', history: [], notes: [
    ['friday', '2026-11-06', '周五工作', '#3b82f6', '工作日'], ['saturday', '2026-11-07', '周六工作', '#16a34a', '工作日'], ['sunday', '2026-11-08', '周日工作', '#8b5cf6', '工作日'], ['monday', '2026-11-09', '周一工作', '#f59e0b', '工作日'], ['weekend-off', '2026-11-08', '周末备注', '#ef4444', '非工作日'],
  ].map(([id, date, title, color, type]) => ({ id, date, title, color, type, content: '', created_at: '2026-11-01T10:00:00.000Z', ...(type === '工作日' ? { weight: 1 } : {}) })) };
  await check('unified-settings-commit-and-cancel-are-atomic-and-work-keeps-weekend-data', async () => {
    await page.getByTestId('document-open-input').setInputFiles({ name: '周视图验收.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11'); await day('2026-11-07').click();
    assert.equal(await editor().getByRole('gridcell').count(), 42); assert.equal(await editor().getByRole('columnheader').count(), 7);
    for (const id of ['calendar-workday-hours', 'calendar-week-mode', 'calendar-allocation-display']) assert.equal(await page.getByTestId(id).count(), 0, `${id} is only shown in settings`);
    const before = await exported(), original = await state(); await editor().getByTestId('calendar-settings').click();
    await page.getByTestId('calendar-book-title').fill('统一设置提交'); await page.getByTestId('calendar-workday-hours').fill('8'); await page.getByTestId('calendar-week-mode').selectOption('work'); await page.getByTestId('calendar-allocation-display').selectOption('hours');
    assert.deepEqual((await state()).book, before); assert.equal((await state()).revision, original.revision); assert.equal(await editor().getByRole('gridcell').count(), 42); await capture('calendar-unified-settings'); await page.getByTestId('calendar-note-cancel').click(); await frame(); assert.deepEqual(await exported(), before); assert.equal((await state()).revision, original.revision);
    await settings({ title: '统一设置提交', workdayHours: 8, weekMode: 'work', allocationDisplay: 'hours' });
    const work = await exported(); assert.deepEqual(work, { ...before, title: '统一设置提交', workdayHours: 8, weekMode: 'work', allocationDisplay: 'hours' }); assert.equal((await state()).revision, original.revision + 1); assert.equal((await state()).view.selectedDate, '2026-11-09'); assert.equal(await day('2026-11-09').evaluate(e => e === document.activeElement), true, 'Settings confirm focuses the normalized visible date');
    assert.equal(await editor().getByRole('gridcell').count(), 30); assert.equal(await editor().getByRole('columnheader').count(), 5); assert.equal(await editor().locator('.calendar-grid').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length), 5);
    assert.equal(await day('2026-11-07').count(), 0); assert.equal(await day('2026-11-08').count(), 0); assert.equal(await editor().locator('[role="gridcell"][tabindex="0"]').count(), 1);
    const summary = editor().getByTestId('calendar-summary'); for (const name of ['周五工作', '周六工作', '周日工作', '周一工作']) assert.match(await summary.locator('.calendar-summary-tag').filter({ hasText: name }).innerText(), /8\s*小时/);
    assert.doesNotMatch(await editor().getByTestId('calendar-day-allocation-2026-11-06').innerText(), /全天|8h/);
    await undo(); assert.deepEqual(await exported(), before); assert.equal(await editor().getByRole('gridcell').count(), 42); await redo(); assert.deepEqual(await exported(), work); assert.equal(await editor().getByRole('gridcell').count(), 30); await capture('calendar-work-view');
  });
  await check('work-keyboard-skips-weekends-with-visible-focus-and-month-normalization', async () => {
    const book = await exported(); await day('2026-11-06').focus(); await page.keyboard.press('ArrowRight'); await frame(); assert.equal((await state()).view.selectedDate, '2026-11-09'); assert.equal(await day('2026-11-09').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('ArrowLeft'); await frame(); assert.equal((await state()).view.selectedDate, '2026-11-06'); assert.equal(await day('2026-11-06').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('ArrowDown'); await frame(); assert.equal((await state()).view.selectedDate, '2026-11-13'); assert.equal(await day('2026-11-13').evaluate(e => e === document.activeElement), true); await page.keyboard.press('ArrowUp'); await frame(); assert.equal((await state()).view.selectedDate, '2026-11-06');
    await month('2027-05'); assert.equal((await state()).view.selectedDate, '2027-05-03'); assert.equal(await editor().getByRole('gridcell').count(), 30); assert.equal(await editor().locator('[role="gridcell"][tabindex="0"]').count(), 1);
    await day('2027-05-03').focus(); await page.keyboard.press('ArrowLeft'); await frame(); assert.equal((await state()).view.selectedDate, '2027-04-30'); assert.equal(await day('2027-04-30').evaluate(e => e === document.activeElement), true); assert.deepEqual(await exported(), book);
    await month('2026-11'); const download = await saveDownload('Work视图保留周末.oocalendar', true); assert.deepEqual(download.model, book); const session = (await state()).documentId; await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); assert.notEqual((await state()).documentId, session); await month('2026-11'); assert.deepEqual(await exported(), book); assert.equal(await editor().getByRole('gridcell').count(), 30);
  });
  await check('real-print-dom-follows-week-columns-and-discloses-full-month-work-summary', async () => {
    const work = await exported(); await printedCalendar('calendar-print-work-five-columns', 5, 2); assert.deepEqual(await exported(), work);
    await settings({ weekMode: 'week' }); assert.equal(await editor().getByRole('gridcell').count(), 42); assert.equal(await editor().getByRole('columnheader').count(), 7); assert.ok(await note('saturday').isVisible()); assert.ok(await note('sunday').isVisible());
    await printedCalendar('calendar-print-week-seven-columns', 7, 5); assert.deepEqual((await exported()).notes, fixture.notes); assert.deepEqual((await exported()).history, fixture.history);
  });
}
function completeReport() { report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Source changed during browser acceptance'); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []); report.ok = true; }
(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', acceptDownloads: true, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); if (!/^https?:$/.test(url.protocol) || url.origin === origin) return route.continue();
      const match = url.hostname === 'raw.githubusercontent.com' ? url.pathname.match(/^\/NateScarlet\/holiday-cn\/master\/(\d{4})\.json$/) : url.hostname === 'cdn.jsdelivr.net' ? url.pathname.match(/^\/gh\/NateScarlet\/holiday-cn@master\/(\d{4})\.json$/) : null;
      if (!match) { report.externalRequests.push(url.href); return route.abort('blockedbyclient'); }
      report.holidayRequests.push(url.href); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }, body: JSON.stringify({ year: Number(match[1]), papers: [], days: [{ name: '国庆节', date: `${match[1]}-10-01`, isOffDay: true }] }) });
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(origin, { timeout: 60000 });
    if (focus === 'allocation-boundaries') { await allocationBoundaryChecks(); completeReport(); return; }
    if (focus === 'week-settings') { await weekSettingsChecks(); completeReport(); return; }
    if (focus === 'drag-summary') { await dragSummaryChecks(); completeReport(); return; }
    if (focus === 'value-layout') { await valueLayoutChecks(); completeReport(); return; }
    let first, second, saved, firstKey;
    await check('new-calendar-has-42-cells-and-date-click-only-selects', async () => {
      await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-calendar').click(); await ready(); firstKey = (await active()).key;
      await month('2026-11'); assert.equal(await editor().getByRole('gridcell').count(), 42); const before = await exported(); const revision = (await state()).revision;
      await day('2026-11-04').click(); await frame(); assert.equal(await page.getByTestId('calendar-almanac-dialog').count(), 0); assert.equal((await state()).view.selectedDate, '2026-11-04'); assert.deepEqual(await exported(), before); assert.equal((await state()).revision, revision);
      await editor().getByTestId('calendar-date-details').click(); await page.getByTestId('calendar-almanac-dialog').waitFor(); await page.keyboard.press('Escape'); await frame(); assert.equal(await page.getByTestId('calendar-almanac-dialog').count(), 0);
    });
    await check('right-click-custom-commits-history-atomically-and-cancel-does-not', async () => {
      first = await add('2026-11-04', '产品评审', '仅本次正文，历史不得复用', '#16a34a', '非工作日'); const book = await exported(); assert.deepEqual(Object.keys(book.history[0]).sort(), ['color', 'lastUsedAt', 'title', 'type']); assert.equal(book.history[0].title, first.title);
      const revision = (await state()).revision; await custom('2026-11-05'); await page.getByTestId('calendar-note-title').fill('取消的历史项'); await page.getByTestId('calendar-note-cancel').click(); assert.deepEqual(await exported(), book); assert.equal((await state()).revision, revision);
      await undo(); assert.equal((await exported()).notes.length, 0); assert.equal((await exported()).history.length, 0); await redo(); assert.deepEqual(await exported(), book);
    });
    await check('history-reuse-searches-across-months-and-never-copies-body', async () => {
      await month('2026-12'); await custom('2026-12-03'); await page.getByTestId('calendar-history-search').fill('评审'); const item = page.getByTestId('calendar-history-item').filter({ hasText: '产品评审' }); assert.equal(await item.count(), 1); await item.click();
      assert.equal(await page.getByTestId('calendar-note-title').inputValue(), first.title); assert.equal(await page.getByTestId('calendar-note-color').inputValue(), first.color); assert.equal(await page.getByTestId('calendar-note-type').inputValue(), first.type); assert.equal(await page.getByTestId('calendar-note-content').inputValue(), ''); assert.equal(await page.getByTestId('calendar-note-date').inputValue(), '2026-12-03'); await capture('calendar-history-reuse');
      await page.getByTestId('calendar-note-confirm').click(); await frame(); second = (await exported()).notes.find(n => n.date === '2026-12-03'); assert.ok(second); assert.equal(second.content, ''); assert.equal((await exported()).history.filter(h => h.title === first.title).length, 1);
      await month('2026-11'); await remove(first.id); assert.equal((await exported()).history[0].title, first.title); await month('2027-01'); await custom('2027-01-04'); await page.getByTestId('calendar-history-search').fill('评审'); assert.equal(await page.getByTestId('calendar-history-item').count(), 1); await page.getByTestId('calendar-note-cancel').click();
    });
    await check('drag-moves-note-and-control-drag-copies-with-undo', async () => {
      await month('2026-12'); const before = await exported(); await note(second.id).dragTo(day('2026-12-04')); await frame(); assert.equal((await exported()).notes.find(n => n.id === second.id).date, '2026-12-04');
      await undo(); assert.deepEqual(await exported(), before); await redo();
      await page.keyboard.down('Control'); try { await note(second.id).dragTo(day('2026-12-07')); } finally { await page.keyboard.up('Control'); } await frame();
      const notes = (await exported()).notes; assert.equal(notes.length, before.notes.length + 1); assert.equal(notes.find(n => n.id === second.id).date, '2026-12-04'); assert.ok(notes.find(n => n.id !== second.id && n.date === '2026-12-07'));
      await undo(); assert.equal((await exported()).notes.length, before.notes.length); await redo();
      const beforeMeta = await exported(); await page.keyboard.down('Meta'); try { await note(second.id).dragTo(day('2026-12-09')); } finally { await page.keyboard.up('Meta'); } await frame();
      assert.equal((await exported()).notes.length, beforeMeta.notes.length + 1); assert.equal((await exported()).notes.find(n => n.id === second.id).date, '2026-12-04'); await undo(); assert.deepEqual(await exported(), beforeMeta);
    });
    await check('edit-delete-and-clear-month-confirmations-are-undoable', async () => {
      await note(second.id).click({ button: 'right' }); await page.getByTestId('calendar-context-menu').waitFor(); await page.keyboard.press('Escape'); await frame(); assert.equal(await title(second.id).evaluate(element => element === document.activeElement), true, 'Esc restores context-menu focus to the note title');
      await title(second.id).dblclick(); await page.getByTestId('calendar-note-content').fill('已修改正文'); await page.getByTestId('calendar-note-confirm').click(); await frame(); assert.equal((await exported()).notes.find(n => n.id === second.id).content, '已修改正文');
      await undo(); assert.equal((await exported()).notes.find(n => n.id === second.id).content, ''); await redo(); const beforeDelete = await exported(); await remove(second.id); assert.ok(!(await exported()).notes.some(n => n.id === second.id)); await undo(); assert.deepEqual(await exported(), beforeDelete);
      const beforeClear = await exported(); await editor().getByTestId('calendar-clear-month').click(); await page.getByTestId('calendar-delete-dialog').waitFor(); assert.deepEqual((await state()).book, beforeClear); await page.getByTestId('calendar-delete-confirm').click(); await frame(); assert.equal((await exported()).notes.length, 0); assert.deepEqual((await exported()).history, beforeClear.history); await undo(); assert.deepEqual(await exported(), beforeClear);
    });
    await check('html-looking-titles-and-content-remain-literal-text', async () => {
      const hostile = '<img src=x onerror=window.calendarInjected=1>'; const item = await add('2026-12-08', hostile, '<script>window.calendarInjected=2</script>'); assert.ok((await note(item.id).innerText()).includes(hostile)); assert.equal(await note(item.id).locator('img,script').count(), 0); assert.equal(await page.evaluate(() => window.calendarInjected), undefined);
      await title(item.id).dblclick(); assert.equal(await page.getByTestId('calendar-note-content').inputValue(), item.content); await page.getByTestId('calendar-note-cancel').click();
    });
    await check('calendar-download-and-reopen-preserve-notes-and-history-in-new-session', async () => {
      const before = await exported(), session = (await state()).documentId; saved = await saveDownload('日历便笺验收.oocalendar', true); assert.deepEqual(saved.model, before); assert.equal(saved.model.format, 'open-office-calendar'); assert.equal((await active()).dirty, false);
      await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready(); assert.notEqual((await state()).documentId, session); assert.deepEqual(await exported(), saved.model); assert.equal((await state()).dirty, false); await month('2026-12');
      const repeat = await saveDownload('日历便笺再次保存.oocalendar'); assert.deepEqual(repeat.bytes, saved.bytes); assert.equal(await page.locator('.document-tab').count(), 2);
    });
    await check('independent-calendar-tabs-retain-their-own-model-and-view', async () => {
      await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-calendar').click(); await ready(); assert.equal((await exported()).notes.length, 0); await month('2028-02');
      await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); assert.equal((await active()).key, firstKey); assert.equal((await state()).view.month, '2026-12'); assert.deepEqual(await exported(), saved.model);
    });
    await check('invalid-calendar-imports-leave-current-session-content-and-tabs-unchanged', async () => {
      const before = await exported(), original = await state(), key = (await active()).key, tabs = await page.locator('.document-tab').count();
      const future = { ...before, version: 99 }, badDate = structuredClone(before), duplicate = structuredClone(before); badDate.notes[0].date = '2026-02-30'; duplicate.notes.push({ ...duplicate.notes[0] });
      for (const [name, value] of [['invalid-json', '{"format":'], ['future-version', future], ['invalid-date', badDate], ['duplicate-id', duplicate]]) {
        await page.getByTestId('document-open-input').setInputFiles({ name: `${name}.oocalendar`, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) }); await page.locator('.error-banner').waitFor(); await ready(); assert.equal((await active()).key, key); assert.equal(await page.locator('.document-tab').count(), tabs); assert.deepEqual(await exported(), before); assert.deepEqual(await state(), original); await closeError();
      }
    });
    let workA, workB, workC, workD;
    await check('one-work-capsule-equal-shares-and-real-pointer-percent-resize', async () => {
      await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-calendar').click(); await ready(); await month('2026-11');
      const blank = await exported(); assert.equal(blank.workdayHours, 7); assert.equal(blank.allocationDisplay, 'percent'); assert.equal(blank.weekMode, 'week');
      workA = await add('2026-11-04', '需求设计', '第一份工作', '#3b82f6'); await allocations('2026-11-04', { [workA.id]: 1 });
      workB = await add('2026-11-04', '开发实现', '第二份工作', '#16a34a'); await allocations('2026-11-04', { [workA.id]: .5, [workB.id]: .5 });
      const off = await add('2026-11-04', '请假备注', '不分配工作量', '#ef4444', '非工作日'); assert.equal(Object.hasOwn(off, 'weight'), false); await allocations('2026-11-04', { [workA.id]: .5, [workB.id]: .5 }); assert.equal(await capsule('2026-11-04').getByTestId(`calendar-note-${off.id}`).count(), 0);
      const before = await exported(); await resize('2026-11-04', workA.id, workB.id, .69); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 }); await undo(); assert.deepEqual(await exported(), before); await redo(); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      const divider = capsule('2026-11-04').getByRole('slider'); await divider.press('ArrowLeft'); await allocations('2026-11-04', { [workA.id]: .6, [workB.id]: .4 }); await divider.press('ArrowRight'); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await divider.press('Home'); await allocations('2026-11-04', { [workA.id]: 0, [workB.id]: 1 }); assert.equal(await title(workA.id).count(), 1); await undo(); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await capture('calendar-work-percent');
    });
    await check('hours-mode-snaps-half-hour-and-non-default-allocation-survives-reopen', async () => {
      await settings({ allocationDisplay: 'hours' }); assert.equal((await exported()).allocationDisplay, 'hours'); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await resize('2026-11-04', workA.id, workB.id, 4.1 / 7); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 });
      await editor().getByTestId('calendar-settings').click(); assert.equal(await page.getByTestId('calendar-workday-hours').inputValue(), '7'); await page.getByTestId('calendar-workday-hours').fill('8'); await page.getByTestId('calendar-settings-confirm').click(); await frame(); assert.equal((await exported()).workdayHours, 8); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 }); await undo(); assert.equal((await exported()).workdayHours, 7);
      const before = await exported(), session = (await state()).documentId; const download = await saveDownload('工时分配验收.oocalendar', true); assert.deepEqual(download.model, before); assert.ok(Math.abs(download.model.notes.find(n => n.id === workA.id).weight - 4 / 7) < 1e-9);
      await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); assert.notEqual((await state()).documentId, session); assert.deepEqual(await exported(), before); await month('2026-11'); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 }); await capture('calendar-work-hours');
      const key = (await active()).key, tabs = await page.locator('.document-tab').count(), original = await state();
      const variants = [book => { book.workdayHours = 0; }, book => { book.allocationDisplay = 'unknown'; }, book => { book.weekMode = 'unknown'; }, book => { book.notes.find(n => n.id === workA.id).weight = .1; }, book => { delete book.notes.find(n => n.id === workA.id).weight; }, book => { book.notes.find(n => n.type === '非工作日').weight = .5; }];
      for (const [index, mutate] of variants.entries()) { const bad = structuredClone(before); mutate(bad); await page.getByTestId('document-open-input').setInputFiles({ name: `invalid-allocation-${index}.oocalendar`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) }); await page.locator('.error-banner').waitFor(); await ready(); assert.equal((await active()).key, key); assert.equal(await page.locator('.document-tab').count(), tabs); assert.deepEqual(await exported(), before); assert.deepEqual(await state(), original); await closeError(); }
    });
    await check('work-membership-move-copy-type-and-delete-conserve-and-redivide-affected-days', async () => {
      workC = await add('2026-11-04', '联调测试', '', '#8b5cf6'); await allocations('2026-11-04', { [workA.id]: 1 / 3, [workB.id]: 1 / 3, [workC.id]: 1 / 3 });
      workD = await add('2026-11-05', '发布准备', '', '#f59e0b'); await allocations('2026-11-05', { [workD.id]: 1 });
      await note(workB.id).dragTo(day('2026-11-05')); await frame(); await allocations('2026-11-04', { [workA.id]: .5, [workC.id]: .5 }); await allocations('2026-11-05', { [workB.id]: .5, [workD.id]: .5 });
      await settings({ allocationDisplay: 'percent' }); await resize('2026-11-04', workA.id, workC.id, .69); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
      const beforeCopy = await exported(); await page.keyboard.down('Control'); try { await note(workA.id).dragTo(day('2026-11-05')); } finally { await page.keyboard.up('Control'); } await frame();
      const copied = (await exported()).notes.find(n => n.date === '2026-11-05' && n.title === workA.title); assert.ok(copied); assert.notEqual(copied.id, workA.id); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 }); await allocations('2026-11-05', { [workB.id]: 1 / 3, [workD.id]: 1 / 3, [copied.id]: 1 / 3 }); await undo(); assert.deepEqual(await exported(), beforeCopy); await redo();
      await remove(workB.id); await allocations('2026-11-05', { [workD.id]: .5, [copied.id]: .5 }); await undo(); await allocations('2026-11-05', { [workB.id]: 1 / 3, [workD.id]: 1 / 3, [copied.id]: 1 / 3 });
      await title(workC.id).dblclick(); await page.getByTestId('calendar-note-type').selectOption('非工作日'); await page.getByTestId('calendar-note-confirm').click(); await frame(); await allocations('2026-11-04', { [workA.id]: 1 }); assert.equal(Object.hasOwn((await exported()).notes.find(n => n.id === workC.id), 'weight'), false); await undo(); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
      const before = await exported(), download = await saveDownload('跨日分配验收.oocalendar', true); assert.deepEqual(download.model, before); await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); await month('2026-11'); assert.deepEqual(await exported(), before); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
    });
    await allocationBoundaryChecks();
    await dragSummaryChecks();
    await weekSettingsChecks();
    await check('imported-notes-without-history-keep-reusable-types-after-delete-and-clear', async () => {
      const fixture = { format: 'open-office-calendar', version: 1, id: 'imported-calendar', title: '团队工作日历', history: [], notes: [
        ['planning', '2026-11-04', '项目计划', '#3b82f6', '工作日'], ['review', '2026-11-04', '产品评审', '#16a34a', '工作日'], ['travel', '2026-11-04', '客户拜访', '#f59e0b', '工作日'],
        ['leave', '2026-11-12', '年假', '#ef4444', '非工作日'], ['release', '2026-11-20', '版本发布', '#8b5cf6', '工作日'], ['next-month', '2026-12-04', '月度复盘', '#16a34a', '工作日'],
      ].map(([id, date, title, color, type]) => ({ id, date, title, color, type, content: '本次具体事项，不复用到历史类型', created_at: '2026-11-01T10:00:00.000Z' })) };
      await page.getByTestId('document-open-input').setInputFiles({ name: '团队工作日历.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11');
      await editor().getByTestId('calendar-day-allocation-2026-11-04').click(); await page.getByTestId('calendar-day-dialog').waitFor(); assert.equal(await page.locator('.calendar-day-list > button').count(), 3); await page.locator('.calendar-day-list > button').filter({ hasText: '客户拜访' }).click(); assert.equal(await page.getByTestId('calendar-note-title').inputValue(), '客户拜访'); await page.getByTestId('calendar-note-cancel').click();
      await remove('planning'); assert.ok((await exported()).history.find(h => h.title === '项目计划'));
      await editor().getByTestId('calendar-clear-month').click(); await page.getByTestId('calendar-delete-confirm').click(); await frame(); const cleared = await exported(); assert.deepEqual(cleared.notes.map(n => n.id), ['next-month']); for (const n of fixture.notes.filter(n => n.date.startsWith('2026-11'))) assert.ok(cleared.history.find(h => h.title === n.title && h.color === n.color && h.type === n.type));
      const historical = await saveDownload('历史保留验收.oocalendar', true); assert.deepEqual(historical.model, cleared); await undo(); await undo(); assert.deepEqual(await exported(), { ...fixture, workdayHours: 7, allocationDisplay: 'percent', weekMode: 'week' });
    });
    await check('focus-mode-preserves-session-and-allows-exit', async () => {
      const before = await state(); await page.getByTestId('shell-focus-enter').click(); await frame(); await page.getByTestId('shell-focus-exit').waitFor(); assert.ok(await editor().isVisible()); assert.deepEqual(await state(), before); await capture('calendar-focus-light'); await page.getByTestId('shell-focus-exit').click(); await frame(); assert.deepEqual(await state(), before);
    });
    await check('dark-and-narrow-window-retain-42-cells-without-document-overflow', async () => {
      await capture('calendar-desktop-light'); await page.getByTestId('theme-dark').click(); await capture('calendar-desktop-dark'); await page.setViewportSize({ width: 800, height: 640 }); await frame(); assert.equal(await editor().getByRole('gridcell').count(), 42); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await capture('calendar-narrow-dark');
    });
    await valueLayoutChecks();
    completeReport();
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) { try { await capture('failure'); report.failure.text = (await page.locator('body').innerText()).slice(-10000); } catch {} } process.exitCode = 1; }
  finally { await browser?.close(); await server?.close(); persist(); console.log(JSON.stringify({ ok: report.ok, stage: report.stage, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message })); }
})();
