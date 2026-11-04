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
const output = path.resolve(process.env.OFFICE_CALENDAR_OUTPUT || path.join(root, focus === 'allocation-boundaries' ? 'test-results/calendar-notes-allocation-boundaries' : 'test-results/calendar-notes'));
const sources = ['src/App.vue', 'src/components/CalendarEditor.vue', 'src/calendar/model.ts', 'src/calendar/allocation.ts', 'src/calendar/components/CalendarWorkCapsule.vue', 'src/calendar/session.ts', 'src/calendar/calendar.ts', 'src/calendar/almanac.ts', 'src/calendar/mcp.ts', 'src/shared/document.ts', 'src/style.css'];
const hashes = () => Object.fromEntries(sources.filter(file => fs.existsSync(path.join(root, file))).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue UI in Chromium with deterministic public holiday fixtures; actual browser downloads and file imports', checks: [], screenshots: [], pointerGestures: [], errors: [], consoleErrors: [], externalRequests: [], holidayRequests: [], limitations: ['Native dialogs, native filesystem autosave and installed platform WebViews are not exercised.', 'Public holiday network responses are deterministic fixtures, not live availability evidence.', 'Mouse, keyboard and drag input are automated browser events; physical input is not exercised.'] };
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
async function resize(date, leftId, rightId, ratio) {
  const container = capsule(date), handle = container.getByTestId(`calendar-work-divider-${leftId}-${rightId}`);
  await handle.scrollIntoViewIfNeeded(); const box = await container.boundingBox(), grip = await handle.boundingBox(); assert.ok(box && grip);
  await handle.evaluate(element => { window.calendarPointerEvents = []; for (const type of ['pointerdown', 'pointermove', 'pointerup']) element.addEventListener(type, event => window.calendarPointerEvents.push({ type: event.type, trusted: event.isTrusted })); });
  const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, end = { x: box.x + box.width * ratio, y: start.y };
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up(); await frame();
  const events = await page.evaluate(() => window.calendarPointerEvents); assert.ok(events.some(e => e.type === 'pointerdown' && e.trusted)); assert.ok(events.some(e => e.type === 'pointermove' && e.trusted)); assert.ok(events.some(e => e.type === 'pointerup' && e.trusted)); report.pointerGestures.push({ date, leftId, rightId, ratio, start, end, events });
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
    await editor().getByTestId('calendar-allocation-display').selectOption('hours'); await frame(); const hours = await exported();
    await divider.press('Home'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': 0, 'boundary-c': .62 }); await undo(); assert.deepEqual(await exported(), hours);
    await divider.press('End'); await allocations('2026-11-06', { 'boundary-a': .38, 'boundary-b': .62, 'boundary-c': 0 }); await undo(); assert.deepEqual(await exported(), hours);
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
      const blank = await exported(); assert.equal(blank.workdayHours, 7); assert.equal(blank.allocationDisplay, 'percent');
      workA = await add('2026-11-04', '需求设计', '第一份工作', '#3b82f6'); await allocations('2026-11-04', { [workA.id]: 1 });
      workB = await add('2026-11-04', '开发实现', '第二份工作', '#16a34a'); await allocations('2026-11-04', { [workA.id]: .5, [workB.id]: .5 });
      const off = await add('2026-11-04', '请假备注', '不分配工作量', '#ef4444', '非工作日'); assert.equal(Object.hasOwn(off, 'weight'), false); await allocations('2026-11-04', { [workA.id]: .5, [workB.id]: .5 }); assert.equal(await capsule('2026-11-04').getByTestId(`calendar-note-${off.id}`).count(), 0);
      const before = await exported(); await resize('2026-11-04', workA.id, workB.id, .69); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 }); await undo(); assert.deepEqual(await exported(), before); await redo(); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      const divider = capsule('2026-11-04').getByRole('slider'); await divider.press('ArrowLeft'); await allocations('2026-11-04', { [workA.id]: .6, [workB.id]: .4 }); await divider.press('ArrowRight'); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await divider.press('Home'); await allocations('2026-11-04', { [workA.id]: 0, [workB.id]: 1 }); assert.equal(await title(workA.id).count(), 1); await undo(); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await capture('calendar-work-percent');
    });
    await check('hours-mode-snaps-half-hour-and-non-default-allocation-survives-reopen', async () => {
      await editor().getByTestId('calendar-allocation-display').selectOption('hours'); await frame(); assert.equal((await exported()).allocationDisplay, 'hours'); await allocations('2026-11-04', { [workA.id]: .7, [workB.id]: .3 });
      await resize('2026-11-04', workA.id, workB.id, 4.1 / 7); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 });
      await editor().getByTestId('calendar-settings').click(); assert.equal(await page.getByTestId('calendar-workday-hours').inputValue(), '7'); await page.getByTestId('calendar-workday-hours').fill('8'); await page.getByTestId('calendar-settings-confirm').click(); await frame(); assert.equal((await exported()).workdayHours, 8); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 }); await undo(); assert.equal((await exported()).workdayHours, 7);
      const before = await exported(), session = (await state()).documentId; const download = await saveDownload('工时分配验收.oocalendar', true); assert.deepEqual(download.model, before); assert.ok(Math.abs(download.model.notes.find(n => n.id === workA.id).weight - 4 / 7) < 1e-9);
      await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); assert.notEqual((await state()).documentId, session); assert.deepEqual(await exported(), before); await month('2026-11'); await allocations('2026-11-04', { [workA.id]: 4 / 7, [workB.id]: 3 / 7 }); await capture('calendar-work-hours');
      const key = (await active()).key, tabs = await page.locator('.document-tab').count(), original = await state();
      const variants = [book => { book.workdayHours = 0; }, book => { book.allocationDisplay = 'unknown'; }, book => { book.notes.find(n => n.id === workA.id).weight = .1; }, book => { delete book.notes.find(n => n.id === workA.id).weight; }, book => { book.notes.find(n => n.type === '非工作日').weight = .5; }];
      for (const [index, mutate] of variants.entries()) { const bad = structuredClone(before); mutate(bad); await page.getByTestId('document-open-input').setInputFiles({ name: `invalid-allocation-${index}.oocalendar`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) }); await page.locator('.error-banner').waitFor(); await ready(); assert.equal((await active()).key, key); assert.equal(await page.locator('.document-tab').count(), tabs); assert.deepEqual(await exported(), before); assert.deepEqual(await state(), original); await closeError(); }
    });
    await check('work-membership-move-copy-type-and-delete-conserve-and-redivide-affected-days', async () => {
      workC = await add('2026-11-04', '联调测试', '', '#8b5cf6'); await allocations('2026-11-04', { [workA.id]: 1 / 3, [workB.id]: 1 / 3, [workC.id]: 1 / 3 });
      workD = await add('2026-11-05', '发布准备', '', '#f59e0b'); await allocations('2026-11-05', { [workD.id]: 1 });
      await note(workB.id).dragTo(day('2026-11-05')); await frame(); await allocations('2026-11-04', { [workA.id]: .5, [workC.id]: .5 }); await allocations('2026-11-05', { [workB.id]: .5, [workD.id]: .5 });
      await editor().getByTestId('calendar-allocation-display').selectOption('percent'); await frame(); await resize('2026-11-04', workA.id, workC.id, .69); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
      const beforeCopy = await exported(); await page.keyboard.down('Control'); try { await note(workA.id).dragTo(day('2026-11-05')); } finally { await page.keyboard.up('Control'); } await frame();
      const copied = (await exported()).notes.find(n => n.date === '2026-11-05' && n.title === workA.title); assert.ok(copied); assert.notEqual(copied.id, workA.id); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 }); await allocations('2026-11-05', { [workB.id]: 1 / 3, [workD.id]: 1 / 3, [copied.id]: 1 / 3 }); await undo(); assert.deepEqual(await exported(), beforeCopy); await redo();
      await remove(workB.id); await allocations('2026-11-05', { [workD.id]: .5, [copied.id]: .5 }); await undo(); await allocations('2026-11-05', { [workB.id]: 1 / 3, [workD.id]: 1 / 3, [copied.id]: 1 / 3 });
      await title(workC.id).dblclick(); await page.getByTestId('calendar-note-type').selectOption('非工作日'); await page.getByTestId('calendar-note-confirm').click(); await frame(); await allocations('2026-11-04', { [workA.id]: 1 }); assert.equal(Object.hasOwn((await exported()).notes.find(n => n.id === workC.id), 'weight'), false); await undo(); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
      const before = await exported(), download = await saveDownload('跨日分配验收.oocalendar', true); assert.deepEqual(download.model, before); await page.getByTestId('document-open-input').setInputFiles(download.target); await ready(); await month('2026-11'); assert.deepEqual(await exported(), before); await allocations('2026-11-04', { [workA.id]: .7, [workC.id]: .3 });
    });
    await allocationBoundaryChecks();
    await check('imported-notes-without-history-keep-reusable-types-after-delete-and-clear', async () => {
      const fixture = { format: 'open-office-calendar', version: 1, id: 'imported-calendar', title: '团队工作日历', history: [], notes: [
        ['planning', '2026-11-04', '项目计划', '#3b82f6', '工作日'], ['review', '2026-11-04', '产品评审', '#16a34a', '工作日'], ['travel', '2026-11-04', '客户拜访', '#f59e0b', '工作日'],
        ['leave', '2026-11-12', '年假', '#ef4444', '非工作日'], ['release', '2026-11-20', '版本发布', '#8b5cf6', '工作日'], ['next-month', '2026-12-04', '月度复盘', '#16a34a', '工作日'],
      ].map(([id, date, title, color, type]) => ({ id, date, title, color, type, content: '本次具体事项，不复用到历史类型', created_at: '2026-11-01T10:00:00.000Z' })) };
      await page.getByTestId('document-open-input').setInputFiles({ name: '团队工作日历.oocalendar', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) }); await ready(); await month('2026-11');
      await editor().getByTestId('calendar-day-allocation-2026-11-04').click(); await page.getByTestId('calendar-day-dialog').waitFor(); assert.equal(await page.locator('.calendar-day-list > button').count(), 3); await page.locator('.calendar-day-list > button').filter({ hasText: '客户拜访' }).click(); assert.equal(await page.getByTestId('calendar-note-title').inputValue(), '客户拜访'); await page.getByTestId('calendar-note-cancel').click();
      await remove('planning'); assert.ok((await exported()).history.find(h => h.title === '项目计划'));
      await editor().getByTestId('calendar-clear-month').click(); await page.getByTestId('calendar-delete-confirm').click(); await frame(); const cleared = await exported(); assert.deepEqual(cleared.notes.map(n => n.id), ['next-month']); for (const n of fixture.notes.filter(n => n.date.startsWith('2026-11'))) assert.ok(cleared.history.find(h => h.title === n.title && h.color === n.color && h.type === n.type));
      const historical = await saveDownload('历史保留验收.oocalendar', true); assert.deepEqual(historical.model, cleared); await undo(); await undo(); assert.deepEqual(await exported(), { ...fixture, workdayHours: 7, allocationDisplay: 'percent' });
    });
    await check('focus-mode-preserves-session-and-allows-exit', async () => {
      const before = await state(); await page.getByTestId('shell-focus-enter').click(); await frame(); await page.getByTestId('shell-focus-exit').waitFor(); assert.ok(await editor().isVisible()); assert.deepEqual(await state(), before); await capture('calendar-focus-light'); await page.getByTestId('shell-focus-exit').click(); await frame(); assert.deepEqual(await state(), before);
    });
    await check('dark-and-narrow-window-retain-42-cells-without-document-overflow', async () => {
      await capture('calendar-desktop-light'); await page.getByTestId('theme-dark').click(); await capture('calendar-desktop-dark'); await page.setViewportSize({ width: 800, height: 640 }); await frame(); assert.equal(await editor().getByRole('gridcell').count(), 42); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await capture('calendar-narrow-dark');
    });
    completeReport();
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) { try { await capture('failure'); report.failure.text = (await page.locator('body').innerText()).slice(-10000); } catch {} } process.exitCode = 1; }
  finally { await browser?.close(); await server?.close(); persist(); console.log(JSON.stringify({ ok: report.ok, stage: report.stage, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message })); }
})();
