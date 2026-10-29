/* Real Vue project schedule UI, pointer gestures, browser downloads and reopen.
 * Run: node tests/browser/project-schedule.cjs (owns Vite 5337 and Chromium).
 * Focused unknown-year regression: OFFICE_SCHEDULE_FOCUS=unknown-year node tests/browser/project-schedule.cjs
 * Automatic holiday regression: OFFICE_SCHEDULE_FOCUS=holiday-refresh node tests/browser/project-schedule.cjs
 * Compact toolbar, track sizing and file/image export: OFFICE_SCHEDULE_FOCUS=layout-export node tests/browser/project-schedule.cjs
 * Half-day slots and pointer-anchored wheel zoom: OFFICE_SCHEDULE_FOCUS=daypart-zoom node tests/browser/project-schedule.cjs
 * Direct event-edge resizing and Ctrl-drag copies: OFFICE_SCHEDULE_FOCUS=resize-copy node tests/browser/project-schedule.cjs
 * ISO annual/project-relative week numbering: OFFICE_SCHEDULE_FOCUS=annual-weeks node tests/browser/project-schedule.cjs
 * Inline per-person monthly workload: OFFICE_SCHEDULE_FOCUS=monthly-workload node tests/browser/project-schedule.cjs
 * Synthetic project data only. No screen-capture, microphone or native I/O API.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const focus = process.env.OFFICE_SCHEDULE_FOCUS || '';
const output = path.resolve(process.env.OFFICE_SCHEDULE_OUTPUT || path.join(root, ['unknown-year', 'holiday-refresh', 'layout-export', 'daypart-zoom', 'resize-copy', 'annual-weeks', 'monthly-workload'].includes(focus) ? `test-results/project-schedule-${focus}` : 'test-results/project-schedule'));
const sources = ['src/App.vue', 'src/style.css', 'src/components/ScheduleEditor.vue', 'src/schedule/components/ScheduleTimeline.vue', 'src/schedule/model.ts', 'src/schedule/calendar.ts', 'src/schedule/holidays.ts', 'src/schedule/holiday-native.ts', 'src/schedule/session.ts', 'src/schedule/workload.ts', 'src/schedule/layout.ts', 'src/schedule/interaction.ts', 'src/schedule/zoom.ts', 'src/schedule/png-export.ts', 'src/shared/document.ts'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { ok: false, runtime: 'Real Vue schedule UI in system Chromium over local Vite HTTP; real browser downloads and file input; allowlisted public holiday responses are deterministic fixtures', checks: [], screenshots: [], gestures: [], errors: [], consoleErrors: [], externalRequests: [], holidayRequests: [], expectedNetworkErrors: [], limitations: ['Native file dialogs, desktop filesystem autosave and platform WebViews are not exercised.', 'Holiday fetches use the real browser fetch/client/cache path with fixture responses; live upstream availability is not asserted.', 'Pointer input is automated Chromium mouse input; physical touch and operating-system accessibility tools are not exercised.', 'Browser page screenshots require visual review.'] };
let server, browser, page;
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const holidayPlans = new Map(), heldHolidays = [], abortedHolidayUrls = new Set();
const holidayCachePrefix = 'open-office.schedule.holidays.v1.';
function holidayRequest(url) {
  const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.port || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const match = parsed.hostname === 'raw.githubusercontent.com' ? parsed.pathname.match(/^\/NateScarlet\/holiday-cn\/master\/(\d{4})\.json$/) : parsed.hostname === 'cdn.jsdelivr.net' ? parsed.pathname.match(/^\/gh\/NateScarlet\/holiday-cn@master\/(\d{4})\.json$/) : null;
  return match ? { year: Number(match[1]), source: parsed.hostname === 'raw.githubusercontent.com' ? 'primary' : 'fallback' } : null;
}
function holidayFixture(year, extras = []) {
  const ranges = {
    2025: [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']],
    2026: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
  };
  const days = [];
  for (const [start, end] of ranges[year] || []) for (let date = new Date(`${year}-${start}T00:00:00Z`); date.toISOString().slice(0, 10) <= `${year}-${end}`; date.setUTCDate(date.getUTCDate() + 1)) days.push({ name: '夹具官方假日', date: date.toISOString().slice(0, 10), isOffDay: true });
  if (year === 2026) for (const date of ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10']) days.push({ name: '夹具调休上班', date: `2026-${date}`, isOffDay: false });
  for (const date of extras) days.push({ name: '自动更新测试假日', date, isOffDay: true });
  return { year, papers: [], days };
}
async function answerHoliday(route, spec, details) {
  if (spec.mode === 'offline') { abortedHolidayUrls.add(route.request().url()); await route.abort('internetdisconnected'); return; }
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' }, body: JSON.stringify(spec.payload || holidayFixture(details.year)) });
}
async function installHolidayRoutes(context, origin) {
  context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin && !holidayRequest(request.url())) report.externalRequests.push(request.url()); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); if (!/^https?:$/.test(url.protocol) || url.origin === origin) { await route.continue(); return; }
    const details = holidayRequest(request.url()); if (!details) { await route.abort('blockedbyclient'); return; }
    assert.equal(request.method(), 'GET'); assert.equal(request.postData(), null); assert.equal(request.headers().referer, undefined, 'Public holiday requests do not disclose the document location');
    const configured = holidayPlans.get(details.year) || {}, spec = configured[details.source] || configured;
    report.holidayRequests.push({ ...details, url: request.url(), stage: report.stage, held: !!spec.hold, mode: spec.mode || 'fixture' }); persist();
    if (spec.hold) { heldHolidays.push({ route, spec, details }); return; }
    await answerHoliday(route, spec, details);
  });
}
async function releaseHoliday(year) { const index = heldHolidays.findIndex(item => item.details.year === year); assert.notEqual(index, -1, `An annual ${year} request is held`); const item = heldHolidays.splice(index, 1)[0]; await answerHoliday(item.route, item.spec, item.details); }
const editor = () => page.locator('[data-testid="schedule-editor"]:visible');
const timeline = () => editor().getByTestId('schedule-timeline');
const scroll = () => editor().getByTestId('schedule-timeline-scroll');
const eventElement = id => timeline().locator(`[data-event-id="${id}"]`);
const track = id => timeline().getByTestId(`schedule-track-${id || 'overall'}`);
const projectDialog = () => editor().getByTestId('schedule-project-dialog');
const eventDialog = () => editor().getByTestId('schedule-event-dialog');
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function poll(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await page.waitForTimeout(40); }
  throw Error(`Timed out: ${description}`);
}
async function active() { return page.evaluate(() => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return { key: a.activeKey, name: a.active?.document.name, kind: a.active?.document.kind, dirty: a.active?.dirty, ready: a.active?.ready, busy: !!a.busy }; }); }
async function ready() { await poll(async () => { const a = await active(); return !a.busy && a.ready && a.kind === 'schedule'; }, 'schedule ready'); await frame(); }
async function scheduleState() { return page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.scheduleHandles.get(a.activeKey).inspect(); }); }
async function shownDates() { return timeline().locator('[data-date]').evaluateAll(elements => elements.map(element => element.getAttribute('data-date'))); }
async function holidayIdle() { await poll(async () => (await editor().getByTestId('schedule-refresh-holidays').textContent()) === '更新假日', 'holiday refresh completes'); await frame(); }
async function viewMenu(open = true) { const summary = editor().getByTestId('schedule-view-menu'), current = await summary.evaluate(element => element.parentElement.open); if (current !== open) await summary.click(); await frame(); }
async function refreshHoliday() { await viewMenu(); await editor().getByTestId('schedule-refresh-holidays').click(); await viewMenu(false); }
async function cachedHoliday(year) { return page.evaluate(key => localStorage.getItem(key), `${holidayCachePrefix}${year}`); }
async function exportedModel() {
  return page.evaluate(async () => {
    const a = document.querySelector('#app').__vue_app__._instance.setupState;
    const result = await a.scheduleHandles.get(a.activeKey).exportFile({ format: 'ooschedule', background: true });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))));
  });
}
async function check(name, action) { report.stage = name; persist(); await action(); report.checks.push(name); persist(); }
async function capture(name) { await frame(); const file = `${String(report.screenshots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push({ file, viewport: page.viewportSize() }); persist(); }
async function project(title, start = '2026-09-21', end = '2026-11-27') {
  await projectDialog().waitFor();
  await projectDialog().getByTestId('schedule-project-title').fill(title);
  await projectDialog().getByTestId('schedule-project-start').fill(start);
  await projectDialog().getByTestId('schedule-project-end').fill(end);
  await projectDialog().getByTestId('schedule-project-confirm').click();
  await projectDialog().waitFor({ state: 'hidden' }); await ready();
}
async function newSchedule(title) { await page.getByTestId('shell-new').click(); await page.getByTestId('shell-new-schedule').click(); await project(title); }
async function addRoles(values) {
  await editor().getByTestId('schedule-roles').click();
  const dialog = editor().getByTestId('schedule-roles-dialog');
  for (const value of values) {
    await dialog.getByTestId('schedule-role-add').click(); const row = dialog.locator('[data-role-draft]').last();
    await row.getByTestId('role-name').fill(value.name); await row.getByTestId('role-job').fill(value.role); await row.getByTestId('role-color').fill(value.color);
  }
  await dialog.getByTestId('schedule-roles-confirm').click(); await dialog.waitFor({ state: 'hidden' }); await frame();
}
async function eventForm(value) {
  await eventDialog().waitFor(); await eventDialog().getByTestId('schedule-event-title').fill(value.title);
  await eventDialog().getByTestId('schedule-event-role').selectOption(value.roleId ? { value: value.roleId } : { index: 0 });
  await eventDialog().getByTestId('schedule-event-start').fill(value.startDate);
  await eventDialog().getByTestId('schedule-event-end').fill(value.endDate);
  await eventDialog().getByTestId('schedule-event-height').selectOption(String(value.height || 1));
  if (value.height === .5 && value.slot !== undefined) await eventDialog().getByTestId('schedule-event-slot').selectOption(String(value.slot));
  await eventDialog().getByTestId('schedule-event-notes').fill(value.notes || '');
}
async function createEvent(value) {
  await editor().getByTestId('schedule-add-event').click(); await eventForm(value);
  await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' }); await frame();
  const result = (await exportedModel()).events.find(item => item.title === value.title); assert.ok(result); return result;
}
async function cancelDialog(dialog) { await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); }
async function gesture(locator, dx, dy, cancel = false) {
  await locator.scrollIntoViewIfNeeded(); await frame(); const box = await locator.boundingBox(); assert.ok(box, 'Gesture target is visible');
  const viewport = await scroll().boundingBox(); assert.ok(viewport);
  const visibleLeft = Math.max(box.x, viewport.x + 194), visibleRight = Math.min(box.x + box.width, viewport.x + viewport.width - 8);
  assert.ok(visibleRight > visibleLeft, 'Gesture target has a visible part in the timeline');
  const start = { x: (visibleLeft + visibleRight) / 2, y: box.y + box.height / 2 }, end = { x: start.x + dx, y: start.y + dy };
  assert.equal(await locator.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)) || (element.matches('[data-resize]') && element.closest('[data-event-id]') === document.elementFromPoint(point.x, point.y)?.closest('[data-event-id]')), start), true, 'Pointer starts on the actual visible gesture target');
  report.gestures.push({ stage: report.stage, selector: await locator.getAttribute('data-testid'), start, end, cancel }); persist();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const expectedKind = await locator.getAttribute('data-resize'); if (expectedKind) assert.equal(await timeline().getAttribute('data-gesture'), expectedKind, 'Visual grip coordinates start the intended resize action');
  await page.mouse.move(end.x, end.y, { steps: 10 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await frame();
}
async function eventState(id) { return (await exportedModel()).events.find(item => item.id === id); }
async function undo() { await page.getByTestId('global-toolbar').getByRole('button', { name: '撤销', exact: true }).click(); await frame(); }
async function redo() { await page.getByTestId('global-toolbar').getByRole('button', { name: '重做', exact: true }).click(); await frame(); }
async function saveDownload(filename, saveAs = false) {
  if (saveAs) { await page.getByTestId('shell-save-as').click(); await page.getByTestId('save-format-name').fill(filename.replace(/\.ooschedule$/, '')); }
  const pending = page.waitForEvent('download'); await page.getByTestId(saveAs ? 'save-format-confirm' : 'shell-save').click(); const download = await pending;
  assert.equal(download.suggestedFilename(), filename); const target = path.join(output, filename); await download.saveAs(target); assert.equal(await download.failure(), null); await ready();
  const bytes = fs.readFileSync(target); return { target, bytes, model: JSON.parse(bytes.toString('utf8')) };
}
async function openFixture(name, value) {
  const folder = path.join(output, 'fixtures'); fs.mkdirSync(folder, { recursive: true }); const target = path.join(folder, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); await page.getByTestId('document-open-input').setInputFiles(target); await ready(); return target;
}
async function closeError() {
  const close = page.getByRole('button', { name: '关闭错误提示', exact: true }); if (await close.isVisible()) await close.click();
  const localClose = editor().getByRole('button', { name: '关闭提示', exact: true }); if (await localClose.isVisible()) await localClose.click();
}
function completeReport() {
  report.sourcesAfter = hashes(); assert.deepEqual(report.sourcesAfter, report.sourcesBefore, 'Product sources stay fixed throughout verification');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []); report.ok = true; report.finishedAt = new Date().toISOString();
}
async function holidayRefreshChecks() {
  const year = 2028, prefix = `${year}-06-`, eventId = 'automatic_holiday_event';
  const fixture = { format: 'open-office-schedule', version: 1, id: 'automatic_holiday_project', title: '自动节假日验证', startDate: `${prefix}05`, endDate: `${prefix}23`, calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [], events: [{ id: eventId, roleId: null, title: '跨假日阶段', startDate: `${prefix}06`, endDate: `${prefix}09`, height: 1, slot: 0, notes: '纯合成项目，用于验证联网日历不会改写排期。' }] };
  let cleanState, cached;
  const payload = (...days) => holidayFixture(year, days.map(day => `${prefix}${day}`));
  const sameDocument = async () => { assert.deepEqual(await exportedModel(), fixture); assert.deepEqual(await scheduleState(), cleanState); assert.equal((await active()).dirty, false); };
  await check('automatic-annual-fetch-hides-new-holiday-without-editing-document', async () => {
    holidayPlans.set(year, { payload: payload('07') });
    await openFixture('automatic-holiday-project.ooschedule', fixture); await holidayIdle();
    assert.ok(report.holidayRequests.some(request => request.year === year && request.source === 'primary'));
    assert.ok(!(await shownDates()).includes(`${prefix}07`)); assert.ok((await shownDates()).includes(`${prefix}08`)); assert.equal(await editor().getByTestId('schedule-holiday-warning').count(), 0);
    assert.match(await editor().getByTestId('schedule-holiday-status').innerText(), /已更新并缓存/); assert.deepEqual(await exportedModel(), fixture);
    const saved = await saveDownload('自动节假日验证.ooschedule', true); assert.deepEqual(saved.model, fixture); cleanState = await scheduleState(); assert.equal(cleanState.dirty, false); await capture('automatic-holiday-success');
  });
  await check('manual-refresh-bypasses-fresh-cache-without-changing-revision-or-dirty', async () => {
    const beforeRequests = report.holidayRequests.length; holidayPlans.set(year, { payload: payload('07', '08') }); await refreshHoliday(); await holidayIdle();
    assert.ok(report.holidayRequests.length > beforeRequests); assert.ok(!(await shownDates()).includes(`${prefix}08`)); await sameDocument(); cached = await cachedHoliday(year); assert.ok(cached); assert.ok(JSON.parse(cached).days[`${prefix}08`]);
  });
  await check('empty-announcements-fail-without-replacing-known-holidays-or-cache', async () => {
    const count = report.holidayRequests.length; holidayPlans.set(year, { payload: { year, papers: [], days: [] } }); await refreshHoliday(); await holidayIdle();
    assert.deepEqual(report.holidayRequests.slice(count).map(request => request.source), ['primary', 'fallback']); assert.match(await editor().getByTestId('schedule-holiday-status').innerText(), /继续使用本地|继续使用.*数据/);
    assert.ok(!(await shownDates()).includes(`${prefix}07`)); assert.ok(!(await shownDates()).includes(`${prefix}08`)); assert.equal(await cachedHoliday(year), cached); await sameDocument();
  });
  await check('fallback-source-can-refresh-after-primary-rejects-invalid-announcement', async () => {
    const count = report.holidayRequests.length; holidayPlans.set(year, { primary: { payload: { year, papers: [], days: [] } }, fallback: { payload: payload('07', '08', '09') } });
    await refreshHoliday(); await holidayIdle(); assert.deepEqual(report.holidayRequests.slice(count).map(request => request.source), ['primary', 'fallback']);
    assert.ok(!(await shownDates()).includes(`${prefix}09`)); await sameDocument();
  });
  async function delayedGesture(days, closing) {
    holidayPlans.set(year, { hold: true, payload: payload(...days) }); await refreshHoliday(); await poll(async () => heldHolidays.some(item => item.details.year === year), 'annual response is held');
    const beforeDates = await shownDates(), box = await eventElement(eventId).boundingBox(); assert.ok(box); const x = box.x + box.width / 2, y = box.y + box.height / 2, dayWidth = Number(await timeline().getAttribute('data-day-width'));
    report.gestures.push({ stage: report.stage, selector: `schedule-event-${eventId}`, start: { x, y }, end: { x: x + dayWidth * 0.2, y }, cancel: closing === 'escape', deferredHoliday: `${prefix}${days.at(-1)}` }); persist();
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dayWidth * 0.2, y, { steps: 5 }); await frame(); assert.equal(await timeline().locator('.schedule-event-ghost').count(), 1);
    await releaseHoliday(year); await holidayIdle();
    assert.equal(await timeline().locator('.schedule-event-ghost').count(), 1, 'A completed response and its status text cannot cancel the active pointer gesture'); assert.deepEqual(await shownDates(), beforeDates, 'Dates remain frozen while a pointer is down');
    assert.ok(JSON.parse(await cachedHoliday(year)).days[`${prefix}${days.at(-1)}`], 'The network result has arrived in the real persistent cache'); assert.equal((await active()).dirty, false); await capture(`refresh-pending-until-${closing}`);
    if (closing === 'escape') await page.keyboard.press('Escape'); await page.mouse.up(); await frame();
    await poll(async () => !(await shownDates()).includes(`${prefix}${days.at(-1)}`), 'deferred holiday columns apply after gesture finishes'); assert.equal(await timeline().locator('.schedule-event-ghost').count(), 0); await sameDocument();
  }
  await check('network-result-stays-deferred-until-real-pointer-escape', async () => { await delayedGesture(['07', '08', '09', '12'], 'escape'); });
  await check('network-result-stays-deferred-until-real-pointer-mouseup', async () => { await delayedGesture(['07', '08', '09', '12', '13'], 'mouseup'); });
  await check('fresh-persistent-cache-survives-page-reload-with-no-remote-request', async () => {
    holidayPlans.set(year, { mode: 'offline' }); const count = report.holidayRequests.length;
    await page.reload(); await page.getByTestId('home-new-schedule').waitFor(); await openFixture('cached-holiday-project.ooschedule', fixture); await holidayIdle();
    assert.equal(report.holidayRequests.length, count, 'A new page reuses fresh localStorage data without making a network request');
    for (const day of ['07', '08', '09', '12', '13']) assert.ok(!(await shownDates()).includes(`${prefix}${day}`)); assert.deepEqual(await exportedModel(), fixture); assert.equal((await scheduleState()).dirty, false); await capture('fresh-cache-after-reload');
  });
  await check('stale-persistent-cache-remains-usable-when-both-sources-are-offline', async () => {
    await page.evaluate(key => { const entry = JSON.parse(localStorage.getItem(key)); entry.fetchedAt = Date.now() - 25 * 60 * 60 * 1000; localStorage.setItem(key, JSON.stringify(entry)); }, `${holidayCachePrefix}${year}`);
    const before = await cachedHoliday(year), count = report.holidayRequests.length; await page.reload(); await page.getByTestId('home-new-schedule').waitFor(); await openFixture('offline-holiday-project.ooschedule', fixture); await holidayIdle();
    assert.deepEqual(report.holidayRequests.slice(count).map(request => request.source), ['primary', 'fallback']); assert.match(await editor().getByTestId('schedule-holiday-status').innerText(), /继续使用本地|继续使用.*数据/); assert.equal(await cachedHoliday(year), before);
    for (const day of ['07', '08', '09', '12', '13']) assert.ok(!(await shownDates()).includes(`${prefix}${day}`)); assert.deepEqual(await exportedModel(), fixture); assert.equal((await scheduleState()).dirty, false); await capture('stale-cache-offline');
  });
  await check('december-project-reads-next-year-announcement-and-renders-its-december-holiday', async () => {
    holidayPlans.set(2026, { payload: holidayFixture(2026) }); holidayPlans.set(2027, { payload: holidayFixture(2027, ['2027-01-01', '2026-12-31']) });
    const december = { ...structuredClone(fixture), id: 'december_project', title: '跨年公告验证', startDate: '2026-12-28', endDate: '2026-12-31', events: [] }, count = report.holidayRequests.length;
    await openFixture('december-project.ooschedule', december); await holidayIdle();
    assert.deepEqual([...new Set(report.holidayRequests.slice(count).map(request => request.year))].sort(), [2026, 2027]); assert.ok((await shownDates()).includes('2026-12-30')); assert.ok(!(await shownDates()).includes('2026-12-31')); assert.deepEqual(await exportedModel(), december);
  });
  await check('late-response-from-previous-project-year-cannot-replace-current-calendar', async () => {
    holidayPlans.set(2030, { hold: true, payload: holidayFixture(2030, ['2030-06-05']) }); holidayPlans.set(2031, { payload: holidayFixture(2031, ['2031-06-04']) });
    const prior = { ...structuredClone(fixture), id: 'late_annual_project', title: '切年响应顺序验证', startDate: '2030-06-03', endDate: '2030-06-21', events: [] };
    await openFixture('late-year-project.ooschedule', prior); await poll(async () => heldHolidays.some(item => item.details.year === 2030), 'previous year request is held');
    await editor().getByTestId('schedule-settings').click(); await project('切年响应顺序验证', '2031-06-02', '2031-06-20'); await holidayIdle();
    const before = await exportedModel(), state = await scheduleState(), dates = await shownDates(); assert.ok(dates.every(date => date.startsWith('2031-'))); assert.ok(!dates.includes('2031-06-04'));
    await releaseHoliday(2030); await poll(async () => !!(await cachedHoliday(2030)), 'previous response reaches cache'); await frame();
    assert.deepEqual(await shownDates(), dates); assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state);
  });
}


async function toolbarExport(format, name) {
  await editor().getByTestId('schedule-export-menu').click();
  const pending = page.waitForEvent('download'); await editor().getByTestId(`schedule-export-${format}`).click(); const download = await pending;
  assert.ok(download.suggestedFilename().endsWith(`.${format}`)); const target = path.join(output, name || download.suggestedFilename());
  await download.saveAs(target); assert.equal(await download.failure(), null); await ready(); return { target, bytes: fs.readFileSync(target) };
}
async function toolbarImport(name, value) {
  const pending = page.waitForEvent('filechooser'); await editor().getByTestId('schedule-import').click(); const chooser = await pending;
  await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
}
function pixel(png, x, y) { const index = (Math.floor(y) * png.width + Math.floor(x)) * 4; return Array.from(png.data.subarray(index, index + 4)); }
async function layoutExportChecks() {
  const fixture = { format: 'open-office-schedule', version: 1, id: 'resize_project', title: '轨道高度与导入导出验证', startDate: '2026-09-21', endDate: '2026-11-13', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'alice', name: '林设计', role: '设计', color: '#2563eb' }, { id: 'bob', name: '陈开发', role: '开发', color: '#db2777' }], events: [{ id: 'overview', roleId: null, title: '整体阶段', startDate: '2026-09-21', endDate: '2026-09-30', height: 1, slot: 0, notes: '' }, { id: 'alice_work', roleId: 'alice', title: '设计交付', startDate: '2026-09-21', endDate: '2026-09-23', height: 1, slot: 0, notes: '' }, { id: 'bob_work', roleId: 'bob', title: '开发交付', startDate: '2026-10-26', endDate: '2026-10-27', height: 1, slot: 0, notes: '' }] };
  let saved, beforeResize, originalKey;
  const handle = key => editor().getByTestId(`track-resize-${key}`);
  await check('compact-header-single-status-and-accessible-view-menu', async () => {
    await openFixture('resize-project.ooschedule', fixture); await holidayIdle(); originalKey = (await active()).key;
    await saveDownload('轨道高度验证.ooschedule', true); beforeResize = await exportedModel(); assert.equal((await active()).dirty, false);
    assert.equal(await editor().getByTestId('schedule-holiday-warning').count(), 0);
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 }); await frame();
      const heading = await editor().getByTestId('schedule-toolbar').boundingBox(), people = await editor().getByTestId('schedule-mode-people').boundingBox(), settings = await editor().getByTestId('schedule-settings').boundingBox();
      assert.ok(heading && people && settings); assert.ok(Math.abs(people.y - settings.y) < 8, `${width}px: mode and project tools share a row`); assert.ok(heading.height <= 85, `${width}px: compact toolbar height is bounded`);
      await capture(`compact-toolbar-${width}`);
    }
    await viewMenu(); assert.equal(await editor().getByTestId('schedule-show-weekends').isVisible(), true); await page.keyboard.press('Escape'); assert.equal(await editor().getByTestId('schedule-show-weekends').isVisible(), false); assert.equal(await editor().getByTestId('schedule-view-menu').evaluate(element => element === document.activeElement), true);
    await page.setViewportSize({ width: 1360, height: 900 });
  });
  await check('track-pointer-snaps-to-ticks-and-undo-redo-is-one-edit', async () => {
    await gesture(handle('alice'), 0, 45); const after = await exportedModel();
    assert.equal(after.layout.trackHeights['person-alice'], 168); assert.equal(Number(await track('alice').getAttribute('data-track-height')), 168); assert.equal(Math.round((await track('alice').boundingBox()).height), 168); assert.deepEqual(after.events, beforeResize.events); assert.equal((await active()).dirty, true);
    await undo(); assert.deepEqual(await exportedModel(), beforeResize); assert.equal((await scheduleState()).dirty, false); await redo(); assert.deepEqual(await exportedModel(), after);
    await capture('track-resized-with-tick-snap');
  });
  await check('track-cancel-and-keyboard-respect-step-and-bounds', async () => {
    const before = await exportedModel(), state = await scheduleState(); await gesture(handle('alice'), 0, 70, true); assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state);
    await handle('bob').focus(); await page.keyboard.press('Home'); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 84);
    await page.keyboard.press('End'); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 336);
    await page.keyboard.press('ArrowDown'); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 336, 'End bound cannot be exceeded');
    await page.keyboard.press('Home'); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 84);
    await page.keyboard.press('ArrowUp'); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 84, 'Home bound cannot be exceeded');
    assert.equal((await exportedModel()).layout.trackHeights['person-bob'], 84);
  });
  await check('event-height-and-cross-track-drag-use-resized-lanes', async () => {
    assert.equal(Math.round((await eventElement('alice_work').boundingBox()).height), 150);
    await gesture(eventElement('alice_work').getByTestId('resize-height'), 0, -85); assert.equal((await eventState('alice_work')).height, .5); assert.equal(Math.round((await eventElement('alice_work').boundingBox()).height), 75);
    const original = await eventState('alice_work'), item = await eventElement('alice_work').boundingBox(), lane = await editor().getByTestId('schedule-lane-bob').boundingBox(); assert.ok(item && lane);
    const x = item.x + item.width / 2, y = item.y + item.height / 2, targetY = lane.y + 9 + (lane.height - 18) / 4;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, targetY, { steps: 8 }); await frame();
    assert.equal(Math.round((await timeline().locator('.schedule-event-ghost').boundingBox()).height), 33, 'Ghost fits the half-height destination lane');
    await page.mouse.up(); await frame(); const moved = await eventState('alice_work'); assert.equal(moved.roleId, 'bob'); assert.equal(moved.startDate, original.startDate); assert.equal(moved.endDate, original.endDate); assert.equal(Math.round((await eventElement('alice_work').boundingBox()).height), 33);
    await undo(); assert.deepEqual(await eventState('alice_work'), original);
    await capture('different-track-and-event-heights');
  });
  await check('track-heights-survive-ooschedule-save-and-reopen', async () => {
    saved = await saveDownload('轨道高度验证.ooschedule'); assert.equal(saved.model.layout.trackHeights['person-alice'], 168); assert.equal(saved.model.layout.trackHeights['person-bob'], 84);
    await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready(); assert.deepEqual(await exportedModel(), saved.model); assert.equal(Math.round((await track('alice').boundingBox()).height), 168); assert.equal(Math.round((await track('bob').boundingBox()).height), 84);
  });
  await check('json-export-keeps-dirty-state-and-import-opens-independent-tab', async () => {
    await gesture(handle('overall'), 0, 30); const before = await exportedModel(), state = await scheduleState(), identity = await active(), count = await page.locator('.document-tab').count(); assert.equal(identity.dirty, true);
    const result = await toolbarExport('json', 'full-project-data.json'); assert.deepEqual(JSON.parse(result.bytes.toString('utf8')), before); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity);
    await toolbarImport('imported-project.json', before); await ready(); assert.equal(await page.locator('.document-tab').count(), count + 1); assert.notEqual((await active()).key, identity.key); assert.deepEqual(await exportedModel(), before); assert.match((await active()).name, /\.json$/);
    await gesture(handle('alice'), 0, 28); const importedIdentity = await active(), importedState = await scheduleState(), importedModel = await exportedModel(); assert.equal(importedIdentity.dirty, true);
    const exportedAgain = await toolbarExport('json', 'json-import-then-export.json'); assert.deepEqual(JSON.parse(exportedAgain.bytes.toString('utf8')), importedModel); assert.deepEqual(await active(), importedIdentity); assert.deepEqual(await scheduleState(), importedState);
    const roundTrip = await saveDownload('导入后另存排期.ooschedule', true); assert.deepEqual(roundTrip.model, importedModel); assert.equal((await active()).dirty, false);
    await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); assert.equal((await active()).key, originalKey); assert.deepEqual(await exportedModel(), saved.model); assert.equal((await active()).dirty, false);
  });
  await check('toolbar-invalid-import-preserves-current-document-and-tab-count', async () => {
    const before = await exportedModel(), identity = await active(), state = await scheduleState(), count = await page.locator('.document-tab').count();
    const invalid = structuredClone(before); invalid.layout.trackHeights['person-alice'] = 113;
    for (const [name, value] of [['broken.json', '{'], ['invalid-height.json', invalid], ['unrelated.json', { type: 'excalidraw', elements: [] }]]) {
      await toolbarImport(name, value); await page.locator('.error-banner').waitFor(); await ready(); assert.equal(await page.locator('.document-tab').count(), count); assert.deepEqual(await active(), identity); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await exportedModel(), before); await closeError();
    }
  });
  const pngProject = { ...structuredClone(fixture), id: 'png_full_table', title: '整张排期表 PNG 中文验收', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, roles: Array.from({ length: 9 }, (_, i) => ({ id: `png_role_${i}`, name: `成员 ${i + 1}`, role: `工作轨道 ${i + 1}`, color: i === 8 ? '#cc0044' : '#2563eb' })), events: [], layout: { trackHeights: { overall: 140, 'person-png_role_0': 84, 'person-png_role_8': 168, 'event-png_event_8': 196 } } };
  pngProject.events = pngProject.roles.map((role, i) => ({ id: `png_event_${i}`, roleId: role.id, title: i === 8 ? '离屏末日交付' : `第 ${i + 1} 项交付`, startDate: i === 8 ? '2026-11-11' : '2026-09-21', endDate: i === 8 ? '2026-11-13' : '2026-09-23', height: i === 8 ? .5 : 1, slot: 0, notes: '' }));
  await check('full-png-includes-offscreen-final-row-and-final-date-columns', async () => {
    await toolbarImport('complete-png-project.ooschedule', pngProject); await ready(); await holidayIdle(); const before = await exportedModel(), identity = await active(), state = await scheduleState();
    assert.equal((await shownDates()).includes('2026-11-13'), false, 'Last date is outside virtualized viewport'); const bounds = await scroll().boundingBox(), last = await track('png_role_8').boundingBox(); assert.ok(last.y > bounds.y + bounds.height, 'Last row is below viewport');
    const result = await toolbarExport('png', 'complete-people.png'), png = PNG.sync.read(result.bytes);
    assert.equal(png.width, (240 + 54 * 64) * 2); assert.equal(png.height, (208 + 140 + 84 + 7 * 112 + 168) * 2);
    const x = (24 + 192 + 51 * 64 + 4) * 2, y = (160 + 140 + 84 + 7 * 112 + 9 + 20) * 2;
    assert.deepEqual(pixel(png, x, y), [204, 0, 68, 255], 'Final offscreen event is rendered in its own color at the expected final row/date');
    const afterHalf = pixel(png, x + 30, (160 + 140 + 84 + 7 * 112 + 9 + 100) * 2); assert.deepEqual(afterHalf, [255, 255, 255, 255], 'Half-height event does not paint the lower half');
    assert.deepEqual(await exportedModel(), before); assert.deepEqual(await active(), identity); assert.deepEqual(await scheduleState(), state);
    report.png = { file: path.basename(result.target), width: png.width, height: png.height, bytes: result.bytes.length, offscreenColorPoint: { x, y } }; await capture('png-source-with-offscreen-content');
  });
  await check('global-png-preserves-owner-color-and-global-track-height', async () => {
    await editor().getByTestId('schedule-mode-global').click(); await frame(); const before = await exportedModel(), state = await scheduleState();
    const result = await toolbarExport('png', 'complete-global.png'), png = PNG.sync.read(result.bytes);
    assert.equal(png.width, (240 + 54 * 64) * 2); assert.equal(png.height, (208 + 140 + 8 * 112 + 196) * 2);
    assert.deepEqual(pixel(png, (24 + 192 + 51 * 64 + 4) * 2, (160 + 140 + 8 * 112 + 9 + 20) * 2), [204, 0, 68, 255]);
    assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state); await capture('global-png-source');
  });
  await check('tall-overall-track-unpins-in-short-window-and-people-remain-editable', async () => {
    await editor().getByTestId('schedule-mode-people').click(); await page.setViewportSize({ width: 1360, height: 600 });
    await scroll().evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; }); await frame();
    await handle('overall').focus(); await page.keyboard.press('End'); await frame(); assert.equal(Number(await track(null).getAttribute('data-track-height')), 336); assert.equal(await timeline().getAttribute('data-overall-sticky'), 'false');
    const headerBefore = await timeline().locator('.schedule-calendar-header').boundingBox(), overallBefore = await track(null).boundingBox();
    await scroll().evaluate(element => { element.scrollTop = 260; }); await frame();
    const headerAfter = await timeline().locator('.schedule-calendar-header').boundingBox(), overallAfter = await track(null).boundingBox();
    assert.ok(Math.abs(headerBefore.y - headerAfter.y) < 2, 'Date header stays pinned'); assert.ok(overallAfter.y < overallBefore.y - 200, 'Oversized overall row scrolls away to expose personnel');
    const item = await eventElement('png_event_0').boundingBox(), lane = await editor().getByTestId('schedule-lane-png_role_1').boundingBox(), width = Number(await timeline().getAttribute('data-day-width')); assert.ok(item && lane);
    const start = { x: item.x + item.width / 2, y: item.y + item.height / 2 }, end = { x: start.x + width * 3, y: lane.y + 28 };
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up(); await frame();
    const moved = await eventState('png_event_0'); assert.equal(moved.roleId, 'png_role_1'); assert.equal(moved.startDate, '2026-09-24'); assert.equal(moved.endDate, '2026-09-26'); await capture('short-window-tall-overall-person-drag');
    await gesture(handle('overall'), 0, -224); assert.equal(Number(await track(null).getAttribute('data-track-height')), 112);
    await page.setViewportSize({ width: 1360, height: 900 }); await frame(); assert.equal(await timeline().getAttribute('data-overall-sticky'), 'true');
    await capture('overall-restored-and-pinned');
  });
  await check('compact-controls-remain-contained-in-small-dark-window', async () => {
    await page.getByTestId('theme-dark').click(); await page.setViewportSize({ width: 800, height: 640 }); await frame();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await viewMenu(); await capture('small-dark-view-menu');
    const menu = await editor().locator('.schedule-view-panel').boundingBox(); assert.ok(menu.x >= 0 && menu.x + menu.width <= 800); await page.keyboard.press('Escape');
    await editor().getByTestId('schedule-export-menu').click(); await capture('small-dark-export-menu'); const exportMenu = await editor().locator('.schedule-export-panel').boundingBox(); assert.ok(exportMenu.x >= 0 && exportMenu.x + exportMenu.width <= 800); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1360, height: 900 }); await page.getByTestId('theme-light').click();
  });
}


async function dropToDaypart(id, targetRole, slot, cancel = false) {
  await eventElement(id).scrollIntoViewIfNeeded(); await frame();
  const item = await eventElement(id).boundingBox(), lane = await editor().getByTestId(`schedule-lane-${targetRole || 'overall'}`).boundingBox(); assert.ok(item && lane);
  const start = { x: item.x + item.width / 2, y: item.y + item.height / 2 }, end = { x: start.x, y: lane.y + 9 + (lane.height - 18) * (slot ? .75 : .25) };
  assert.equal(await eventElement(id).evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), start), true);
  report.gestures.push({ stage: report.stage, event: id, start, end, slot, cancel }); persist();
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await frame();
  if (cancel) await page.keyboard.press('Escape');
  else { const ghost = timeline().locator('.schedule-event-ghost'); assert.equal(await ghost.getAttribute('data-slot'), String(slot)); }
  await page.mouse.up(); await frame();
}
async function wheelAt(x, y, deltaY, ctrl = true, deltaX = 0) {
  await page.mouse.move(x, y); if (ctrl) await page.keyboard.down('Control');
  try { await page.mouse.wheel(deltaX, deltaY); } finally { if (ctrl) await page.keyboard.up('Control'); }
  await frame();
}
async function zoomState() {
  return { width: Number(await timeline().getAttribute('data-day-width')), ...(await scroll().evaluate(element => { const rect = element.getBoundingClientRect(); return { left: element.scrollLeft, top: element.scrollTop, x: rect.left, y: rect.top, viewWidth: element.clientWidth, viewHeight: element.clientHeight }; })) };
}
async function daypartZoomChecks() {
  const fixture = { format: 'open-office-schedule', version: 1, id: 'daypart_zoom_project', title: '上午下午与时间轴缩放', startDate: '2026-09-21', endDate: '2026-11-30', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'alice', name: '林设计', role: '设计', color: '#cc0044' }, { id: 'bob', name: '陈开发', role: '开发', color: '#00aa88' }, ...Array.from({ length: 4 }, (_, i) => ({ id: `extra_${i}`, name: `其他成员 ${i + 1}`, role: '协作', color: '#2563eb' }))], events: [{ id: 'overview_pm', roleId: null, title: '下午整体会议', startDate: '2026-09-21', endDate: '2026-09-23', height: .5, slot: 1, notes: '' }, { id: 'alice_half', roleId: 'alice', title: '设计半天安排', startDate: '2026-09-23', endDate: '2026-09-25', height: .5, slot: 0, notes: '' }, { id: 'bob_later', roleId: 'bob', title: '后续开发安排', startDate: '2026-10-05', endDate: '2026-10-06', height: .5, slot: 1, notes: '' }], layout: { trackHeights: { 'person-alice': 168, 'person-bob': 84 } } };
  let saved, originalKey, beforeZoom, zoomSnapshot, zoomIdentity;
  const assertPosition = async (id, role, slot) => {
    const item = await eventElement(id).boundingBox(), lane = await editor().getByTestId(`schedule-lane-${role || 'overall'}`).boundingBox(); assert.ok(item && lane);
    const half = (lane.height - 18) / 2; assert.ok(Math.abs(item.y - lane.y - 9 - slot * half) < 1, `Slot ${slot} is aligned within the ${lane.height}px lane`); assert.ok(Math.abs(item.height - half) < 1); assert.equal(await eventElement(id).getAttribute('data-slot'), String(slot));
  };
  await check('imported-morning-and-afternoon-events-render-in-correct-halves', async () => {
    await openFixture('daypart-zoom.ooschedule', fixture); await holidayIdle(); originalKey = (await active()).key;
    await assertPosition('overview_pm', null, 1); await assertPosition('alice_half', 'alice', 0); await assertPosition('bob_later', 'bob', 1);
    assert.match(await eventElement('overview_pm').getAttribute('title'), /下午/); assert.match(await eventElement('alice_half').getAttribute('title'), /上午/);
    await saveDownload('半天排期验证.ooschedule', true); await capture('imported-dayparts');
  });
  await check('real-vertical-drag-switches-dayparts-with-undo-redo-and-cancel', async () => {
    const before = await exportedModel(); await dropToDaypart('alice_half', 'alice', 1);
    const after = await exportedModel(); assert.equal(after.events.find(event => event.id === 'alice_half').slot, 1); assert.equal(after.events.find(event => event.id === 'alice_half').startDate, '2026-09-23'); await assertPosition('alice_half', 'alice', 1);
    await undo(); assert.deepEqual(await exportedModel(), before); await redo(); assert.deepEqual(await exportedModel(), after);
    await dropToDaypart('alice_half', 'alice', 0, true); assert.deepEqual(await exportedModel(), after); await assertPosition('alice_half', 'alice', 1);
    await dropToDaypart('alice_half', 'alice', 0); assert.equal((await eventState('alice_half')).slot, 0); await assertPosition('alice_half', 'alice', 0);
  });
  await check('cross-height-track-drag-selects-morning-or-afternoon', async () => {
    const before = await eventState('alice_half'); await dropToDaypart('alice_half', 'bob', 1); let value = await eventState('alice_half'); assert.equal(value.roleId, 'bob'); assert.equal(value.slot, 1); assert.equal(value.startDate, before.startDate); assert.equal(value.endDate, before.endDate); await assertPosition('alice_half', 'bob', 1);
    await dropToDaypart('alice_half', 'alice', 0); value = await eventState('alice_half'); assert.equal(value.roleId, 'alice'); assert.equal(value.slot, 0); await assertPosition('alice_half', 'alice', 0);
    await dropToDaypart('alice_half', 'bob', 1); await assertPosition('alice_half', 'bob', 1); await capture('afternoon-in-short-track');
  });
  await check('horizontal-move-resize-and-global-view-preserve-afternoon-slot', async () => {
    const width = Number(await timeline().getAttribute('data-day-width')); await gesture(eventElement('alice_half'), width, 0);
    let event = await eventState('alice_half'); assert.equal(event.slot, 1); assert.equal(event.startDate, '2026-09-24'); assert.equal(event.endDate, '2026-09-26');
    await gesture(eventElement('alice_half').getByTestId('resize-end'), width, 0); event = await eventState('alice_half'); assert.equal(event.slot, 1); assert.equal(event.endDate, '2026-09-27');
    await gesture(eventElement('alice_half').getByTestId('resize-start'), -width, 0); event = await eventState('alice_half'); assert.equal(event.slot, 1); assert.equal(event.startDate, '2026-09-23');
    await gesture(eventElement('alice_half').getByTestId('resize-start'), width, 0); assert.equal((await eventState('alice_half')).slot, 1);
    const before = await exportedModel(); await editor().getByTestId('schedule-mode-global').click(); await frame(); assert.equal(await eventElement('alice_half').getAttribute('data-slot'), '1');
    await gesture(eventElement('alice_half'), width, 0); assert.equal((await eventState('alice_half')).slot, 1); assert.equal((await eventState('alice_half')).roleId, 'bob'); await undo(); assert.deepEqual(await exportedModel(), before);
    await editor().getByTestId('schedule-mode-people').click(); await frame();
  });
  await check('half-to-full-normalizes-slot-and-form-supports-afternoon', async () => {
    await gesture(eventElement('alice_half').getByTestId('resize-height'), 0, 50); let event = await eventState('alice_half'); assert.equal(event.height, 1); assert.equal(event.slot, 0);
    await editor().getByTestId('schedule-edit-event').click(); await eventDialog().waitFor(); await eventDialog().getByTestId('schedule-event-height').selectOption('0.5'); await eventDialog().getByTestId('schedule-event-slot').selectOption('1'); await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' }); await assertPosition('alice_half', 'bob', 1);
    await editor().getByTestId('schedule-edit-event').click(); await eventDialog().waitFor(); await eventDialog().getByTestId('schedule-event-height').selectOption('1'); await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' }); event = await eventState('alice_half'); assert.equal(event.height, 1); assert.equal(event.slot, 0);
    await undo(); await assertPosition('alice_half', 'bob', 1);
  });
  await check('morning-and-afternoon-still-cannot-share-person-and-day', async () => {
    const before = await exportedModel(); await editor().getByTestId('schedule-add-event').click();
    await eventForm({ title: '冲突的上午安排', roleId: 'bob', startDate: '2026-09-24', endDate: '2026-09-24', height: .5, slot: 0 }); await eventDialog().getByTestId('schedule-event-confirm').click(); await frame();
    assert.equal(await eventDialog().isVisible(), true); assert.match(await eventDialog().innerText(), /重叠|冲突|占用/); await cancelDialog(eventDialog()); assert.deepEqual(await exportedModel(), before);
  });
  await check('afternoon-survives-save-json-round-trip-and-png-lower-half', async () => {
    saved = await saveDownload('半天排期验证.ooschedule'); assert.equal(saved.model.events.find(event => event.id === 'alice_half').slot, 1);
    const json = await toolbarExport('json', 'afternoon-project.json'); assert.deepEqual(JSON.parse(json.bytes), saved.model);
    const pngResult = await toolbarExport('png', 'afternoon-people.png'), png = PNG.sync.read(pngResult.bytes);
    const x = (24 + 192 + 3 * 64 + 4) * 2, rowTop = 160 + 112 + 168;
    assert.deepEqual(pixel(png, x, (rowTop + 9 + 33 + 12) * 2), [0, 170, 136, 255], 'Afternoon event paints the lower half of its 84px personnel track');
    assert.deepEqual(pixel(png, x + 20, (rowTop + 9 + 12) * 2), [255, 255, 255, 255], 'The upper morning half stays empty');
    await editor().getByTestId('schedule-mode-global').click(); await frame(); const global = PNG.sync.read((await toolbarExport('png', 'afternoon-global.png')).bytes);
    assert.deepEqual(pixel(global, x, (160 + 112 + 9 + 47 + 12) * 2), [0, 170, 136, 255], 'Global export also puts afternoon below the midpoint');
    await editor().getByTestId('schedule-mode-people').click(); await toolbarImport('afternoon-import.json', saved.model); await ready(); assert.deepEqual(await exportedModel(), saved.model); await assertPosition('alice_half', 'bob', 1);
    await saveDownload('半天缩放验证.ooschedule', true); beforeZoom = await exportedModel(); zoomSnapshot = await scheduleState(); zoomIdentity = await active(); await capture('afternoon-roundtrip');
  });
  await check('control-wheel-zooms-continuously-around-cursor-date-without-editing', async () => {
    await scroll().evaluate(element => { element.scrollLeft = 640; }); await frame();
    let prior = await zoomState(); const x = prior.x + 192 + 420, y = prior.y + 90, initialViewport = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, scale: visualViewport?.scale }));
    for (const delta of [-120, -60, 90, 45]) {
      const before = prior, anchorBefore = (before.left + x - before.x - 192) / before.width;
      await wheelAt(x, y, delta); await poll(async () => (await zoomState()).width !== before.width, 'Ctrl+wheel changes timeline width'); prior = await zoomState();
      assert.equal(Math.sign(prior.width - before.width), -Math.sign(delta)); const anchorAfter = (prior.left + x - prior.x - 192) / prior.width; assert.ok(Math.abs(anchorAfter - anchorBefore) < .04, 'The date fraction below the mouse remains anchored');
      assert.equal(prior.top, before.top, 'Zoom does not vertically scroll the timeline');
    }
    assert.deepEqual(await exportedModel(), beforeZoom); assert.deepEqual(await scheduleState(), zoomSnapshot); assert.deepEqual(await active(), zoomIdentity); assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio, scale: visualViewport?.scale })), initialViewport, 'Ctrl+wheel does not zoom the browser page');
    await viewMenu(); assert.match(await editor().getByRole('combobox', { name: '日期列宽' }).locator('option:checked').innerText(), /%/); await viewMenu(false); await capture('mouse-anchored-wheel-zoom');
  });
  await check('wheel-zoom-clamps-at-bounds-and-normal-wheel-still-scrolls', async () => {
    let view = await zoomState(); const x = view.x + 192 + 420, y = view.y + 100;
    await wheelAt(x, y, -1200); await wheelAt(x, y, -1200); assert.equal((await zoomState()).width, 160);
    const max = await zoomState(); await wheelAt(x, y, -1200); assert.deepEqual(await zoomState(), max);
    await wheelAt(x, y, 1200); await wheelAt(x, y, 1200); assert.equal((await zoomState()).width, 36); const min = await zoomState(); await wheelAt(x, y, 1200); assert.deepEqual(await zoomState(), min);
    await scroll().evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; }); await frame(); view = await zoomState();
    await wheelAt(x, y + 210, 180, false); await poll(async () => (await zoomState()).top > view.top, 'Plain wheel scrolls rows'); assert.equal((await zoomState()).width, 36);
    const beforeHorizontal = await zoomState(); await wheelAt(x, y + 210, 0, false, 220); await poll(async () => (await zoomState()).left > beforeHorizontal.left, 'Plain horizontal wheel scrolls dates'); assert.equal((await zoomState()).width, 36);
    assert.deepEqual(await exportedModel(), beforeZoom); assert.deepEqual(await scheduleState(), zoomSnapshot); assert.deepEqual(await active(), zoomIdentity);
  });
  await check('zoom-is-disabled-during-dialog-or-gesture-and-isolated-by-tab', async () => {
    await scroll().evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; }); await frame();
    let view = await zoomState(); await editor().getByTestId('schedule-settings').click(); await wheelAt(view.x + 210, view.y + 100, -120); assert.equal((await zoomState()).width, view.width); await cancelDialog(projectDialog());
    const item = await eventElement('alice_half').boundingBox(); assert.ok(item); const x = item.x + item.width / 2, y = item.y + item.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 8, y, { steps: 3 }); await frame(); view = await zoomState();
    await wheelAt(x + 8, y, -120); assert.equal((await zoomState()).width, view.width); await page.keyboard.press('Escape'); await page.mouse.up(); await frame(); assert.deepEqual(await exportedModel(), beforeZoom);
    const firstZoomedKey = (await active()).key, firstWidth = (await zoomState()).width; await newSchedule('缩放隔离验证'); const secondKey = (await active()).key; assert.notEqual(secondKey, firstZoomedKey); assert.equal((await zoomState()).width, 64);
    const second = await zoomState(); await wheelAt(second.x + 192 + 200, second.y + 100, -120); assert.ok((await zoomState()).width > 64);
    await page.locator('.document-tab').filter({ has: page.locator('.tab-name', { hasText: '半天缩放验证.ooschedule' }) }).locator('.tab-name').click(); await ready(); assert.equal((await active()).key, firstZoomedKey); assert.equal((await zoomState()).width, firstWidth); assert.deepEqual(await exportedModel(), beforeZoom); assert.deepEqual(await scheduleState(), zoomSnapshot);
    await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); assert.equal((await active()).key, originalKey); assert.equal((await zoomState()).width, 64); assert.deepEqual(await exportedModel(), saved.model);
  });
}


async function eventPoint(id, edge = 'center') {
  await eventElement(id).scrollIntoViewIfNeeded(); await frame(); const box = await eventElement(id).boundingBox(); assert.ok(box);
  return { x: edge === 'start' ? box.x + .5 : edge === 'end' ? box.x + box.width - .5 : box.x + box.width / 2, y: edge === 'height' ? box.y + box.height - .5 : box.y + box.height / 2 };
}
async function hoverCursor(id, edge) {
  const point = await eventPoint(id, edge); await page.mouse.move(point.x, point.y); await frame();
  return page.evaluate(point => { const target = document.elementFromPoint(point.x, point.y); return { cursor: getComputedStyle(target).cursor, event: target.closest('[data-event-id]')?.getAttribute('data-event-id') }; }, point);
}
async function directEdgeDrag(id, edge, dx, dy, ctrl = false) {
  const start = await eventPoint(id, edge); await page.mouse.move(start.x, start.y); if (ctrl) await page.keyboard.down('Control');
  try {
    await page.mouse.down(); assert.equal(await timeline().getAttribute('data-gesture'), edge); await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 }); await frame();
    assert.equal(await timeline().locator('.schedule-event-ghost').getAttribute('data-copy'), 'false', 'An edge drag always resizes, including with Ctrl');
    await page.mouse.up();
  } finally { if (ctrl) await page.keyboard.up('Control'); }
  await frame();
}
async function copyDrag(id, { days = 4, role, slot, initialCtrl = true, finalCtrl = true, cancel = false, click = false, button = 'left' } = {}) {
  const item = await eventState(id), start = await eventPoint(id), width = Number(await timeline().getAttribute('data-day-width'));
  let y = start.y;
  if (role !== undefined || slot !== undefined) {
    const target = role === undefined ? item.roleId : role, lane = await editor().getByTestId(`schedule-lane-${target || 'overall'}`).boundingBox(); assert.ok(lane);
    y = lane.y + 9 + (lane.height - 18) * ((slot ?? item.slot) ? .75 : .25);
  }
  const end = { x: start.x + (click ? 0 : days * width), y: click ? start.y : y };
  if (initialCtrl) await page.keyboard.down('Control'); await page.mouse.move(start.x, start.y);
  try {
    await page.mouse.down({ button }); if (!click) await page.mouse.move(end.x, end.y, { steps: 8 }); await frame();
    if (initialCtrl !== finalCtrl) { await page.keyboard[finalCtrl ? 'down' : 'up']('Control'); await frame(); }
    if (!click) {
      assert.equal(await timeline().locator('.schedule-event-ghost').getAttribute('data-copy'), String(finalCtrl));
      assert.equal(await editor().getByTestId('schedule-copy-preview').isVisible(), finalCtrl);
      if (finalCtrl) assert.ok(Number(await eventElement(id).evaluate(element => getComputedStyle(element).opacity)) > .8, 'The original stays visibly intact during a copy preview');
    }
    if (cancel) await page.keyboard.press('Escape'); await page.mouse.up({ button });
  } finally { await page.keyboard.up('Control'); }
  await frame();
}
async function resizeCopyChecks() {
  const edgeFixture = { format: 'open-office-schedule', version: 1, id: 'edge_project', title: '未选中直接拉伸', startDate: '2026-09-21', endDate: '2026-10-30', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'edge_a', name: '结束边验证', role: '半高', color: '#2563eb' }, { id: 'edge_b', name: '开始边验证', role: '半高', color: '#cc0044' }, { id: 'edge_c', name: '高度边验证', role: '全天', color: '#00aa88' }], events: [{ id: 'right_event', roleId: 'edge_a', title: '先不选中，直接拉结束边', startDate: '2026-09-23', endDate: '2026-09-25', height: .5, slot: 1, notes: '' }, { id: 'left_event', roleId: 'edge_b', title: '直接拉开始边', startDate: '2026-09-23', endDate: '2026-09-25', height: .5, slot: 0, notes: '' }, { id: 'height_event', roleId: 'edge_c', title: '直接拉高度边', startDate: '2026-09-23', endDate: '2026-09-25', height: 1, slot: 0, notes: '' }, { id: 'tiny_event', roleId: 'edge_a', title: '小块', startDate: '2026-09-29', endDate: '2026-09-29', height: .5, slot: 1, notes: '' }], layout: { trackHeights: { 'person-edge_a': 84, 'person-edge_b': 84, 'person-edge_c': 168 } } };
  await check('unselected-real-border-hover-displays-resize-cursors', async () => {
    await openFixture('unselected-edges.ooschedule', edgeFixture); await holidayIdle(); assert.equal(await eventElement('right_event').getAttribute('aria-pressed'), 'false');
    for (const [edge, cursor] of [['start', 'ew-resize'], ['end', 'ew-resize'], ['height', 'ns-resize'], ['center', 'grab']]) { const result = await hoverCursor('right_event', edge); assert.equal(result.event, 'right_event'); assert.equal(result.cursor, cursor, `${edge}: outer border has the intended pointer cursor before any click`); assert.equal(await eventElement('right_event').getAttribute('aria-pressed'), 'false'); }
  });
  await check('first-pointer-down-on-each-unselected-border-resizes-instead-of-moving', async () => {
    let before = await eventState('right_event'); assert.equal(await eventElement('right_event').getAttribute('aria-pressed'), 'false'); await directEdgeDrag('right_event', 'end', 64, 0);
    let after = await eventState('right_event'); assert.equal(after.startDate, before.startDate); assert.equal(after.endDate, '2026-09-26'); assert.equal(after.slot, 1); assert.equal(after.roleId, before.roleId);
    before = await eventState('left_event'); assert.equal(await eventElement('left_event').getAttribute('aria-pressed'), 'false'); await directEdgeDrag('left_event', 'start', 64, 0); after = await eventState('left_event'); assert.equal(after.startDate, '2026-09-24'); assert.equal(after.endDate, before.endDate); assert.equal(after.slot, 0);
    before = await eventState('height_event'); assert.equal(await eventElement('height_event').getAttribute('aria-pressed'), 'false'); await directEdgeDrag('height_event', 'height', 0, -100); after = await eventState('height_event'); assert.equal(after.height, .5); assert.equal(after.slot, 0); assert.equal(after.startDate, before.startDate); assert.equal(after.endDate, before.endDate); assert.equal((await exportedModel()).events.length, 4); await capture('unselected-borders-resized');
  });
  await check('minimum-width-half-height-block-retains-move-and-all-resize-targets', async () => {
    const view = await zoomState(); await wheelAt(view.x + 192 + 300, view.y + 100, 1200); assert.equal((await zoomState()).width, 36);
    const box = await eventElement('tiny_event').boundingBox(); assert.equal(Math.round(box.width), 30); assert.equal(Math.round(box.height), 33); assert.equal(await eventElement('tiny_event').getAttribute('aria-pressed'), 'false');
    for (const [edge, cursor] of [['start', 'ew-resize'], ['end', 'ew-resize'], ['height', 'ns-resize'], ['center', 'grab']]) assert.equal((await hoverCursor('tiny_event', edge)).cursor, cursor);
    await gesture(eventElement('tiny_event'), 36, 0); let event = await eventState('tiny_event'); assert.equal(event.startDate, '2026-09-30'); assert.equal(event.endDate, '2026-09-30'); assert.equal(event.slot, 1);
    await directEdgeDrag('tiny_event', 'start', 36, 0); event = await eventState('tiny_event'); assert.equal(event.startDate, '2026-09-30'); assert.equal(event.endDate, '2026-09-30', 'Resizing a one-day block cannot make it empty');
    await directEdgeDrag('tiny_event', 'end', 36, 0); event = await eventState('tiny_event'); assert.equal(event.startDate, '2026-09-30'); assert.equal(event.endDate, '2026-10-01'); assert.equal(event.slot, 1);
    await directEdgeDrag('tiny_event', 'start', 36, 0); event = await eventState('tiny_event'); assert.equal(event.startDate, '2026-10-01'); assert.equal(event.endDate, '2026-10-01'); assert.equal(event.slot, 1);
    await directEdgeDrag('tiny_event', 'height', 0, 40); event = await eventState('tiny_event'); assert.equal(event.height, 1); assert.equal(event.slot, 0); await capture('minimum-size-resize-and-move');
  });
  const fixture = { format: 'open-office-schedule', version: 1, id: 'copy_project', title: 'Ctrl 拖动复制事件', startDate: '2026-09-21', endDate: '2026-10-30', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'alice', name: '林设计', role: '设计', color: '#cc0044' }, { id: 'bob', name: '陈开发', role: '开发', color: '#00aa88' }, { id: 'carol', name: '罗测试', role: '测试', color: '#2563eb' }], events: [{ id: 'copy_source', roleId: 'alice', title: '保留名称的交付事件', startDate: '2026-09-23', endDate: '2026-09-24', height: .5, slot: 1, notes: '说明必须完整保留\n第二行备注。' }, { id: 'copy_blocker', roleId: 'bob', title: '已有上午任务', startDate: '2026-09-30', endDate: '2026-10-01', height: .5, slot: 0, notes: '' }], layout: { trackHeights: { 'person-alice': 168, 'person-bob': 84, 'event-copy_source': 196 } } };
  let baseline, source, finalCopy, finalProject;
  const newCopy = async before => { const after = await exportedModel(), ids = new Set(before.events.map(event => event.id)), copies = after.events.filter(event => !ids.has(event.id)); assert.equal(copies.length, 1); assert.equal(after.events.length, before.events.length + 1); assert.deepEqual(after.events.find(event => event.id === source.id), source); assert.equal(copies[0].title, source.title); assert.equal(copies[0].notes, source.notes); assert.equal(copies[0].height, source.height); return copies[0]; };
  await check('ctrl-drag-creates-a-new-id-on-new-dates-and-one-undo-removes-only-copy', async () => {
    await toolbarImport('ctrl-copy.ooschedule', fixture); await ready(); await saveDownload('复制交互验证.ooschedule', true); baseline = await exportedModel(); source = baseline.events.find(event => event.id === 'copy_source');
    await copyDrag(source.id); const copy = await newCopy(baseline); assert.equal(copy.roleId, 'alice'); assert.equal(copy.startDate, '2026-09-27'); assert.equal(copy.endDate, '2026-09-28'); assert.equal(copy.slot, 1);
    const after = await exportedModel(); await undo(); assert.deepEqual(await exportedModel(), baseline); await redo(); assert.deepEqual(await exportedModel(), after); await capture('ctrl-copied-new-date'); await undo();
  });
  await check('ctrl-copy-across-different-height-tracks-can-change-daypart', async () => {
    await copyDrag(source.id, { days: 0, role: 'bob', slot: 0 }); const copy = await newCopy(baseline); assert.equal(copy.roleId, 'bob'); assert.equal(copy.slot, 0); assert.equal(copy.startDate, source.startDate); assert.equal(copy.endDate, source.endDate);
    const item = await eventElement(copy.id).boundingBox(), lane = await editor().getByTestId('schedule-lane-bob').boundingBox(); assert.equal(Math.round(item.height), 33); assert.ok(Math.abs(item.y - lane.y - 9) < 1); await undo(); assert.deepEqual(await exportedModel(), baseline);
  });
  await check('copy-conflicts-preserve-both-events-and-afternoon-does-not-bypass-date-conflict', async () => {
    await copyDrag(source.id, { days: 7, role: 'bob', slot: 1 }); assert.deepEqual(await exportedModel(), baseline); assert.match(await editor().getByTestId('schedule-error').innerText(), /重叠|冲突|占用/); await closeError();
    await copyDrag(source.id, { days: 0, role: 'alice', slot: 0 }); assert.deepEqual(await exportedModel(), baseline); assert.match(await editor().getByTestId('schedule-error').innerText(), /重叠|冲突|占用/); await closeError();
  });
  await check('ctrl-click-and-escape-cancel-never-create-a-copy', async () => {
    const state = await scheduleState(); await copyDrag(source.id, { click: true }); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await scheduleState(), state);
    await copyDrag(source.id, { cancel: true }); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await scheduleState(), state); assert.equal(await timeline().locator('.schedule-event-ghost').count(), 0);
  });
  await check('pressing-control-during-a-drag-switches-preview-and-release-to-copy', async () => {
    await copyDrag(source.id, { initialCtrl: false, finalCtrl: true }); const copy = await newCopy(baseline); assert.equal(copy.startDate, '2026-09-27'); assert.equal(copy.slot, 1); await undo(); assert.deepEqual(await exportedModel(), baseline);
  });
  await check('releasing-control-during-a-drag-switches-final-action-back-to-move', async () => {
    await copyDrag(source.id, { initialCtrl: true, finalCtrl: false }); let after = await exportedModel(); assert.equal(after.events.length, baseline.events.length); const moved = after.events.find(event => event.id === source.id); assert.equal(moved.startDate, '2026-09-27'); assert.equal(moved.endDate, '2026-09-28'); assert.equal(moved.slot, 1); await undo(); assert.deepEqual(await exportedModel(), baseline);
    await copyDrag(source.id, { initialCtrl: false, finalCtrl: false }); after = await exportedModel(); assert.equal(after.events.length, baseline.events.length); assert.equal(after.events.find(event => event.id === source.id).startDate, '2026-09-27'); await undo(); assert.deepEqual(await exportedModel(), baseline);
  });
  await check('simulated-control-right-button-copies-and-only-its-context-menu-is-suppressed', async () => {
    await page.evaluate(() => { window.__scheduleContextEvents = []; window.__scheduleContextObserver = event => { setTimeout(() => window.__scheduleContextEvents.push({ prevented: event.defaultPrevented, control: event.ctrlKey, button: event.button, trusted: event.isTrusted, target: event.target?.closest('[data-event-id]')?.getAttribute('data-event-id') }), 0); }; document.addEventListener('contextmenu', window.__scheduleContextObserver, true); });
    try {
      await copyDrag(source.id, { button: 'right' }); await newCopy(baseline); const controlled = await page.evaluate(() => window.__scheduleContextEvents.slice()); report.controlContextEvents = controlled; assert.ok(controlled.some(event => event.control && event.trusted && event.prevented), 'Control + right-button mapping suppresses only the copy context menu'); await undo();
      const point = await eventPoint(source.id); await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y, { button: 'right' }); await frame(); assert.deepEqual(await exportedModel(), baseline); assert.equal(await timeline().locator('.schedule-event-ghost').count(), 0);
      const events = await page.evaluate(() => window.__scheduleContextEvents); assert.ok(events.some(event => !event.control && event.trusted && !event.prevented), 'Ordinary right-click preserves native context-menu behavior');
    } finally { await page.evaluate(() => { document.removeEventListener('contextmenu', window.__scheduleContextObserver, true); delete window.__scheduleContextObserver; delete window.__scheduleContextEvents; }); }
    report.limitations.push('macOS Control-click button 2 mapping used real Chromium right-button input and its trusted contextmenu event, sampled after full event dispatch; this is not a physical Mac/WebKit test.');
  });
  await check('control-on-an-event-edge-resizes-without-duplicating', async () => {
    await directEdgeDrag(source.id, 'end', 64, 0, true); const after = await exportedModel(); assert.equal(after.events.length, baseline.events.length); const event = after.events.find(event => event.id === source.id); assert.equal(event.startDate, source.startDate); assert.equal(event.endDate, '2026-09-25'); assert.equal(event.slot, 1); await undo(); assert.deepEqual(await exportedModel(), baseline);
  });
  await check('global-copy-retains-owner-and-source-row-height-in-one-transaction', async () => {
    await editor().getByTestId('schedule-mode-global').click(); await frame(); await copyDrag(source.id); finalCopy = await newCopy(baseline); finalProject = await exportedModel(); assert.equal(finalCopy.roleId, source.roleId); assert.equal(finalCopy.slot, source.slot); assert.equal(finalProject.layout.trackHeights[`event-${finalCopy.id}`], 196); assert.equal(Number(await track(`event-${finalCopy.id}`).getAttribute('data-track-height')), 196);
    await undo(); assert.deepEqual(await exportedModel(), baseline); await redo(); assert.deepEqual(await exportedModel(), finalProject); await capture('global-duplicate-retains-row-height');
  });
  await check('copied-events-survive-json-png-and-editable-file-round-trip', async () => {
    const state = await scheduleState(), identity = await active(); const json = await toolbarExport('json', 'copied-project.json'); assert.deepEqual(JSON.parse(json.bytes), finalProject); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity);
    const png = PNG.sync.read((await toolbarExport('png', 'copied-global.png')).bytes), x = (24 + 192 + 6 * 64 + 4) * 2, y = (160 + 112 + 196 + 9 + 89 + 20) * 2;
    assert.deepEqual(pixel(png, x, y), [204, 0, 68, 255], 'PNG includes the copied afternoon event in its separate 196px global row');
    const saved = await saveDownload('复制交互验证.ooschedule'); assert.deepEqual(saved.model, finalProject); await toolbarImport('copied-import.json', JSON.parse(json.bytes)); await ready(); assert.deepEqual(await exportedModel(), finalProject); assert.notEqual(finalCopy.id, source.id); assert.equal((await exportedModel()).events.filter(event => event.title === source.title).length, 2);
    await capture('copied-json-reopened');
  });
}


async function weekLabels() {
  return timeline().locator('[data-week]').evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('data-week'), year: element.getAttribute('data-week-year') })));
}
async function numbering(mode) { await viewMenu(); await editor().getByTestId('schedule-week-numbering').selectOption(mode); await viewMenu(false); await frame(); }
async function weekAt(date) {
  const day = await timeline().locator(`[data-date="${date}"]`).boundingBox(); assert.ok(day, `Date ${date} is rendered`);
  return timeline().locator('[data-week]').evaluateAll((elements, x) => { const week = elements.find(element => { const bounds = element.getBoundingClientRect(); return x >= bounds.left && x < bounds.right; }); return week ? { label: week.getAttribute('data-week'), year: week.getAttribute('data-week-year') } : null; }, day.x + day.width / 2);
}
async function pngWithText(name) {
  await page.evaluate(() => { window.__schedulePngText = []; window.__scheduleOriginalFillText = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(value, x, y, ...rest) { window.__schedulePngText.push({ text: String(value), x, y, font: this.font, scale: this.getTransform().a }); return window.__scheduleOriginalFillText.call(this, value, x, y, ...rest); }; });
  try { const result = await toolbarExport('png', name); return { ...result, png: PNG.sync.read(result.bytes), texts: await page.evaluate(() => window.__schedulePngText.slice()) }; }
  finally { await page.evaluate(() => { CanvasRenderingContext2D.prototype.fillText = window.__scheduleOriginalFillText; delete window.__scheduleOriginalFillText; delete window.__schedulePngText; }); }
}
function darkPixels(png, x0, y0, x1, y1) { let count = 0; for (let y = Math.ceil(y0); y < Math.floor(y1); y++) for (let x = Math.ceil(x0); x < Math.floor(x1); x++) { const at = (y * png.width + x) * 4; if (png.data[at] < 170 && png.data[at + 1] < 180 && png.data[at + 2] < 240 && png.data[at + 3] > 200) count++; } return count; }
async function annualWeekChecks() {
  const fixture = { format: 'open-office-schedule', version: 1, id: 'annual_week_project', title: '按年与按项目计周', startDate: '2026-09-21', endDate: '2026-10-02', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, roles: [{ id: 'alice', name: '林设计', role: '设计', color: '#2563eb' }], events: [{ id: 'annual_task', roleId: 'alice', title: '跨周任务', startDate: '2026-09-29', endDate: '2026-10-02', height: .5, slot: 1, notes: '模式切换不改日期。' }] };
  let annualBefore, projectModel, referenceWeek;
  await check('legacy-project-defaults-to-annual-iso-weeks-without-adding-data', async () => {
    await openFixture('annual-default.ooschedule', fixture); await holidayIdle(); annualBefore = await exportedModel(); assert.deepEqual(annualBefore, fixture); assert.equal(Object.hasOwn(annualBefore.calendar, 'weekNumbering'), false);
    assert.deepEqual(await weekLabels(), [{ label: 'W39', year: '2026' }, { label: 'W40', year: '2026' }]); referenceWeek = await weekAt('2026-09-29'); assert.deepEqual(referenceWeek, { label: 'W40', year: '2026' });
    assert.equal(await timeline().locator('.schedule-week-header').getAttribute('data-week-numbering'), 'year'); await saveDownload('周号模式验证.ooschedule', true); await capture('annual-default-weeks');
  });
  await check('project-numbering-switch-is-undoable-and-does-not-rewrite-dates', async () => {
    const before = await scheduleState(); await numbering('project'); projectModel = await exportedModel(); assert.equal(projectModel.calendar.weekNumbering, 'project'); assert.deepEqual(projectModel.events, fixture.events); assert.equal(projectModel.startDate, fixture.startDate); assert.equal(projectModel.endDate, fixture.endDate);
    assert.deepEqual(await weekLabels(), [{ label: 'W1', year: null }, { label: 'W2', year: null }]); assert.equal(await timeline().locator('.schedule-week-header').getAttribute('data-week-numbering'), 'project'); assert.equal((await scheduleState()).revision, before.revision + 1);
    await undo(); assert.deepEqual(await exportedModel(), annualBefore); assert.deepEqual(await weekAt('2026-09-29'), referenceWeek); await redo(); assert.deepEqual(await exportedModel(), projectModel);
    const sameState = await scheduleState(); await numbering('project'); assert.deepEqual(await scheduleState(), sameState, 'Choosing the already selected mode is a no-op'); await capture('project-relative-weeks');
  });
  await check('week-numbering-survives-json-export-import-and-native-format-reopen', async () => {
    const saved = await saveDownload('周号模式验证.ooschedule'); assert.deepEqual(saved.model, projectModel); const json = await toolbarExport('json', 'project-weeks.json'); assert.deepEqual(JSON.parse(json.bytes), projectModel);
    await toolbarImport('project-weeks-import.json', JSON.parse(json.bytes)); await ready(); assert.deepEqual(await exportedModel(), projectModel); assert.deepEqual(await weekLabels(), [{ label: 'W1', year: null }, { label: 'W2', year: null }]);
    await saveDownload('导入项目周.ooschedule', true); await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready(); assert.deepEqual(await exportedModel(), projectModel); assert.equal(await timeline().locator('.schedule-week-header').getAttribute('data-week-numbering'), 'project');
  });
  await check('same-date-has-the-same-annual-week-in-projects-with-different-starts', async () => {
    const later = { ...structuredClone(fixture), id: 'later_start_week_project', title: '较晚开始的同一年度周', startDate: '2026-09-28' };
    await openFixture('later-start.ooschedule', later); await holidayIdle(); assert.deepEqual(await weekAt('2026-09-29'), referenceWeek); assert.deepEqual(await weekLabels(), [{ label: 'W40', year: '2026' }]);
    await numbering('project'); assert.deepEqual(await weekAt('2026-09-29'), { label: 'W1', year: null }); assert.deepEqual((await exportedModel()).events, later.events);
  });
  await check('iso-year-boundary-uses-previous-year-w53-then-new-year-w1', async () => {
    const boundary = { ...structuredClone(fixture), id: 'iso_year_boundary', title: '2026 / 2027 跨年排期', startDate: '2026-12-28', endDate: '2027-01-08', events: [{ ...fixture.events[0], id: 'boundary_task', startDate: '2026-12-31', endDate: '2027-01-05' }] };
    await openFixture('year-boundary.ooschedule', boundary); await holidayIdle(); assert.deepEqual(await weekAt('2026-12-28'), { label: 'W53', year: '2026' }); assert.deepEqual(await weekAt('2027-01-01'), { label: 'W53', year: '2026' }); assert.deepEqual(await weekAt('2027-01-04'), { label: 'W1', year: '2027' }); await capture('iso-year-boundary');
    await numbering('project'); assert.deepEqual(await weekAt('2026-12-28'), { label: 'W1', year: null }); assert.deepEqual(await weekAt('2027-01-01'), { label: 'W1', year: null }); assert.deepEqual(await weekAt('2027-01-04'), { label: 'W2', year: null }); assert.deepEqual((await exportedModel()).events, boundary.events); await capture('project-weeks-across-year');
  });
  await check('late-december-can-belong-to-the-next-iso-week-year', async () => {
    const earlier = { ...structuredClone(fixture), id: 'iso_next_year', title: '十二月属于下一周年', startDate: '2024-12-30', endDate: '2025-01-10', events: [] };
    await openFixture('next-week-year.ooschedule', earlier); await holidayIdle(); assert.deepEqual(await weekAt('2024-12-30'), { label: 'W1', year: '2025' }); assert.deepEqual(await weekAt('2025-01-06'), { label: 'W2', year: '2025' }); assert.deepEqual(await exportedModel(), earlier);
  });
  await check('hidden-entire-weeks-do-not-renumber-annual-or-project-weeks', async () => {
    const hidden = { ...structuredClone(fixture), id: 'hidden_whole_week', title: '隐藏整周保留周序', startDate: '2026-06-01', endDate: '2026-06-26', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12'], excludedHolidays: [] }, events: [{ ...fixture.events[0], id: 'hidden_week_task', startDate: '2026-06-16', endDate: '2026-06-18' }] };
    await openFixture('hidden-week.ooschedule', hidden); await holidayIdle(); assert.deepEqual(await weekLabels(), [{ label: 'W23', year: '2026' }, { label: 'W25', year: '2026' }, { label: 'W26', year: '2026' }]); const beforeDates = await shownDates();
    await numbering('project'); assert.deepEqual(await weekLabels(), [{ label: 'W1', year: null }, { label: 'W3', year: null }, { label: 'W4', year: null }]); assert.deepEqual(await shownDates(), beforeDates); assert.deepEqual((await exportedModel()).events, hidden.events);
  });
  await check('single-visible-day-weeks-show-complete-year-and-week-at-minimum-zoom', async () => {
    // Close the older imported tab before adding another project: preserve the app's eight-tab limit.
    const narrow = { ...structuredClone(fixture), id: 'narrow_week_headers', title: '窄列周号与PNG验证', startDate: '2027-01-01', endDate: '2027-01-04', calendar: { hideWeekends: true, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, events: [] };
    await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); await page.locator('.document-tab').first().getByRole('button').last().click(); await frame();
    await openFixture('narrow-weeks.ooschedule', narrow); await holidayIdle(); const view = await zoomState(); await wheelAt(view.x + 192 + 100, view.y + 100, 1200); assert.equal((await zoomState()).width, 36); assert.deepEqual(await weekLabels(), [{ label: 'W53', year: '2026' }, { label: 'W1', year: '2027' }]);
    const cells = await timeline().locator('[data-week]').evaluateAll(elements => elements.map(element => { const title = element.querySelector('strong'), caption = element.querySelector('span'), t = title.getBoundingClientRect(), c = caption.getBoundingClientRect(); return { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, title: title.textContent, caption: caption.textContent, captionAbove: c.top < t.top, titleFits: title.scrollWidth <= title.clientWidth, captionFits: caption.scrollWidth <= caption.clientWidth }; }));
    assert.equal(cells.length, 2); for (const cell of cells) { assert.equal(cell.width, 36); assert.equal(cell.height, 28); assert.equal(cell.captionAbove, true); assert.equal(cell.titleFits, true); assert.equal(cell.captionFits, true); } assert.deepEqual(cells.map(cell => cell.caption), ['2026', '2027']); await capture('narrow-annual-week-headers');
  });
  await check('png-uses-current-week-mode-and-renders-narrow-headings-without-truncation', async () => {
    const yearModel = await exportedModel(), yearState = await scheduleState(), year = await pngWithText('narrow-annual-weeks.png'); assert.deepEqual(await exportedModel(), yearModel); assert.deepEqual(await scheduleState(), yearState);
    assert.ok(year.texts.some(entry => entry.text.includes('按年计周'))); const headerText = result => result.texts.filter(entry => entry.y >= 88 && entry.y < 116 && entry.x >= 216);
    assert.deepEqual(headerText(year).map(entry => entry.text), ['2026', 'W53', '2027', 'W1']);
    for (const column of [0, 1]) for (const [top, bottom] of [[89, 101], [101, 115]]) assert.ok(darkPixels(year.png, (216 + column * 36) * 2, top * 2, (252 + column * 36) * 2, bottom * 2) > 2, 'PNG contains both caption and week text pixels inside every narrow column');
    await numbering('project'); const project = await pngWithText('narrow-project-weeks.png'); assert.ok(project.texts.some(entry => entry.text.includes('按项目计周'))); assert.deepEqual(headerText(project).map(entry => entry.text), ['项目周', 'W1', '项目周', 'W2']); assert.equal(project.png.width, year.png.width); assert.equal(project.png.height, year.png.height);
    assert.deepEqual(await weekLabels(), [{ label: 'W1', year: null }, { label: 'W2', year: null }]); assert.deepEqual(await timeline().locator('[data-week] span').allTextContents(), ['项目', '项目']); assert.deepEqual((await exportedModel()).events, yearModel.events); await capture('narrow-project-week-headers');
    report.weekPng = { annual: path.basename(year.target), project: path.basename(project.target), annualText: headerText(year), projectText: headerText(project) };
  });
}


const monthlyList = role => editor().getByTestId(`schedule-workload-${role}`);
const monthlyCell = (role, month) => monthlyList(role).locator(`[data-month="${month}"]`);
async function monthlyValue(role, month, scheduled, available) {
  const cell = monthlyCell(role, month); assert.equal(await cell.count(), 1);
  assert.equal(Number(await cell.getAttribute('data-scheduled-days')), scheduled); assert.equal(Number(await cell.getAttribute('data-available-days')), available);
  const percentage = await cell.getAttribute('data-percentage');
  if (available) { assert.ok(Math.abs(Number(percentage) - scheduled / available * 100) < .051); assert.equal(await cell.locator('strong').innerText(), `${Number((scheduled / available * 100).toFixed(1))}%`); }
  else { assert.equal(percentage, null); assert.equal(await cell.locator('strong').innerText(), '—'); }
  assert.equal(await cell.textContent(), `${month.slice(2).replace('-', '.')}-${available ? `${Number((scheduled / available * 100).toFixed(1))}%` : '—'}`);
  assert.equal(await cell.getAttribute('aria-label'), await cell.getAttribute('title'));
  assert.equal(await cell.evaluate(element => { const bounds = element.getBoundingClientRect(); return element.scrollWidth <= element.clientWidth + 1 && Array.from(element.children).every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right; }); }), true, 'Compact month and full percentage fit inside the tag');
  assert.match(await cell.getAttribute('title'), new RegExp(`已排 ${scheduled} 天 / 可排 ${available} 天`));
}
async function personHeading(role, truncated = false) {
  const layout = await editor().getByTestId(`schedule-label-${role}`).evaluate(label => {
    const heading = label.querySelector('.schedule-label-heading'), name = heading.querySelector('strong'), role = heading.querySelector('span');
    const box = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    return { label: box(label), heading: box(heading), name: box(name), role: box(role), truncated: [name, role].map(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis'), title: role.title, text: role.textContent };
  });
  assert.equal(layout.label.width, 192); assert.ok(layout.heading.height <= 18);
  assert.ok(Math.abs(layout.name.y - layout.role.y) <= 3 && layout.role.x >= layout.name.x + layout.name.width, 'Name and role share one line');
  assert.ok(layout.role.x + layout.role.width <= layout.label.x + layout.label.width); assert.equal(layout.title, layout.text, 'Truncated role retains its full hover text');
  if (truncated) assert.deepEqual(layout.truncated, [true, true], 'Long names and roles use ellipsis without widening the label');
}
async function reachEveryMonth(list) {
  const months = await list.evaluate(element => Array.from(element.querySelectorAll('[data-month]'), item => {
    element.scrollTop += item.getBoundingClientRect().top - element.getBoundingClientRect().top;
    const area = element.getBoundingClientRect(), box = item.getBoundingClientRect();
    return { month: item.getAttribute('data-month'), visible: box.top >= area.top - 1 && box.bottom <= area.bottom + 1 };
  }));
  assert.equal(months.length, 37); assert.equal(months.at(-1).month, '2031-01'); assert.ok(months.every(item => item.visible), 'Every month can be fully exposed by scrolling its tag list');
}
async function monthlySnapshot() {
  return editor().locator('.schedule-workload-list').evaluateAll(lists => lists.map(list => ({ role: list.getAttribute('data-testid'), months: Array.from(list.querySelectorAll('[data-month]'), item => ({ month: item.getAttribute('data-month'), scheduled: item.getAttribute('data-scheduled-days'), available: item.getAttribute('data-available-days'), percentage: item.getAttribute('data-percentage') })) })));
}
async function eventWorkload(id, days) {
  const block = eventElement(id); await block.hover();
  assert.equal(await block.evaluate(element => element.matches(':hover')), true);
  const title = await block.getAttribute('title');
  assert.ok(title.split('\n').includes(`工时：${days} 天`), `${id} shows ${days} working days on hover`);
  assert.equal(await block.getAttribute('aria-label'), title, 'Accessible event description includes the same workload');
}
async function monthlyWorkloadChecks() {
  const fixture = { format: 'open-office-schedule', version: 1, id: 'monthly_workload_project', title: '跨月人员工时占比', startDate: '2025-12-29', endDate: '2026-01-06', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: ['2026-01-05'], excludedHolidays: ['2026-01-02'] }, roles: [{ id: 'alice', name: '林设计', role: '设计', color: '#cc0044' }, { id: 'bob', name: '陈开发', role: '开发', color: '#00aa88' }], events: [{ id: 'monthly_overall', roleId: null, title: '整体计划不计人员工时', startDate: '2025-12-29', endDate: '2026-01-06', height: 1, slot: 0, notes: '' }, { id: 'monthly_cross', roleId: 'alice', title: '跨月整天任务', startDate: '2025-12-30', endDate: '2026-01-02', height: 1, slot: 0, notes: '' }, { id: 'monthly_half', roleId: 'alice', title: '下午半天任务', startDate: '2026-01-06', endDate: '2026-01-06', height: .5, slot: 1, notes: '' }, { id: 'monthly_bob', roleId: 'bob', title: '上午半天跨月', startDate: '2025-12-29', endDate: '2026-01-06', height: .5, slot: 0, notes: '' }], layout: { trackHeights: { 'person-bob': 84 } } };
  let initialMatrix, baseline;
  const personTags = role => monthlyList(role).locator('[data-month]').evaluateAll(elements => elements.map(element => element.textContent));
  async function monthlyPng(name, expected) {
    const model = await exportedModel(), state = await scheduleState(), identity = await active(), result = await pngWithText(name);
    const tags = result.texts.filter(item => /^\d{2}\.\d{2}-(?:\d+(?:\.\d+)?%|—)$/.test(item.text));
    assert.deepEqual(tags.map(item => item.text).sort(), expected.slice().sort(), 'PNG draws every monthly tag exactly as shown in the person list');
    assert.ok(result.texts.every(item => !/\d+\s*(?:个|项)?\s*事件|事件\s*[：:]?\s*\d+/.test(item.text)), 'PNG has no generated event counts in its heading, rows, or footer');
    for (const tag of tags) {
      assert.ok((tag.y + 9) * tag.scale < result.png.height && (tag.x - 36) * tag.scale >= 0, 'The entire monthly tag lies inside the downloaded image');
      assert.ok(darkPixels(result.png, (tag.x - 33) * tag.scale, (tag.y - 6) * tag.scale, (tag.x + 33) * tag.scale, (tag.y + 6) * tag.scale) > 0, 'Actual PNG contains dark text pixels for every tag');
    }
    assert.deepEqual(await exportedModel(), model); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity);
    report.monthlyPng ??= []; report.monthlyPng.push({ file: path.basename(result.target), width: result.png.width, height: result.png.height, bytes: result.bytes.length, tags: tags.length }); persist();
    return { ...result, tags };
  }
  await check('inline-person-lists-split-cross-month-events-and-count-workdays-and-halves', async () => {
    await openFixture('monthly-workload.ooschedule', fixture); await holidayIdle(); baseline = await exportedModel(); assert.deepEqual(baseline, fixture);
    assert.equal(await editor().locator('.schedule-workload-list').count(), 2); assert.equal(await track(null).locator('.schedule-workload-list').count(), 0, 'Overall plans do not receive or add person workload'); assert.equal(await editor().getByTestId('schedule-monthly-workload').count(), 0, 'No extra modal/table entry is introduced');
    assert.deepEqual(await monthlyList('alice').locator('[data-month]').evaluateAll(items => items.map(item => item.getAttribute('data-month'))), ['2025-12', '2026-01']);
    await monthlyValue('alice', '2025-12', 2, 3); await monthlyValue('alice', '2026-01', 1.5, 2); await monthlyValue('bob', '2025-12', 1.5, 3); await monthlyValue('bob', '2026-01', 1, 2);
    await personHeading('alice'); await personHeading('bob');
    const firstTag = await monthlyCell('alice', '2025-12').boundingBox(), secondTag = await monthlyCell('alice', '2026-01').boundingBox(); assert.equal(firstTag.y, secondTag.y); assert.ok(secondTag.x > firstTag.x + firstTag.width, 'Two month tags share each row');
    initialMatrix = await monthlySnapshot(); await saveDownload('月度工时验证.ooschedule', true); await capture('inline-monthly-workload');
  });
  await check('reading-and-scrolling-monthly-list-never-edits-the-saved-document', async () => {
    const state = await scheduleState(), identity = await active(), before = await exportedModel(); assert.equal(identity.dirty, false);
    await monthlyList('bob').focus(); await page.keyboard.press('ArrowDown'); await frame(); const cell = monthlyCell('bob', '2026-01'); await cell.hover(); assert.match(await cell.getAttribute('title'), /当月项目范围内的工作日/);
    assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity); assert.deepEqual(await monthlySnapshot(), initialMatrix);
  });
  await check('event-hover-shows-full-half-and-overall-workdays-without-editing', async () => {
    const state = await scheduleState(), identity = await active();
    await eventWorkload('monthly_cross', 3); await eventWorkload('monthly_half', .5); await eventWorkload('monthly_bob', 2.5); await eventWorkload('monthly_overall', 5);
    assert.match(await eventElement('monthly_cross').getAttribute('title'), /跨月整天任务\n林设计 · 2025-12-30 至 2026-01-02\n全天/);
    assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity);
  });
  await check('people-and-global-png-draw-ui-month-tags-without-event-counts', async () => {
    const alice = await personTags('alice'), bob = await personTags('bob');
    assert.ok(alice.includes('25.12-66.7%')); await monthlyPng('monthly-tags-people.png', [...alice, ...bob]);
    await editor().getByTestId('schedule-mode-global').click(); await frame();
    const global = await monthlyPng('monthly-tags-global.png', [...alice, ...alice, ...bob]);
    assert.ok(global.texts.some(item => item.text.includes('月度工时按负责人汇总')));
    await editor().getByTestId('schedule-mode-people').click(); await frame(); assert.deepEqual(await exportedModel(), baseline);
  });
  await check('editing-event-height-and-undo-recompute-inline-percentage-immediately', async () => {
    await eventElement('monthly_half').click(); await editor().getByTestId('schedule-edit-event').click(); await eventDialog().waitFor(); await eventDialog().getByTestId('schedule-event-height').selectOption('1'); await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' }); await frame();
    await monthlyValue('alice', '2026-01', 2, 2); await monthlyValue('alice', '2025-12', 2, 3); await monthlyValue('bob', '2026-01', 1, 2); assert.equal((await eventState('monthly_half')).height, 1);
    await eventWorkload('monthly_half', 1); const fullTags = await personTags('alice'); assert.ok(fullTags.includes('26.01-100%')); await monthlyPng('monthly-tags-full-capacity.png', [...fullTags, ...await personTags('bob')]);
    await undo(); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await monthlySnapshot(), initialMatrix); await eventWorkload('monthly_half', .5); await capture('monthly-after-undo');
  });
  await check('editing-event-date-and-undo-update-hover-workdays', async () => {
    await eventElement('monthly_cross').click(); await editor().getByTestId('schedule-edit-event').click(); await eventDialog().waitFor(); await eventDialog().getByTestId('schedule-event-start').fill('2025-12-29'); await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' }); await frame();
    await eventWorkload('monthly_cross', 4); await monthlyValue('alice', '2025-12', 3, 3);
    await undo(); await eventWorkload('monthly_cross', 3); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await monthlySnapshot(), initialMatrix);
  });
  await check('display-switches-and-week-numbering-do-not-change-workload-and-global-has-no-duplicates', async () => {
    await viewMenu(); await editor().getByTestId('schedule-show-weekends').check(); await editor().getByTestId('schedule-show-holidays').check(); await viewMenu(false); await numbering('project');
    assert.deepEqual(await monthlySnapshot(), initialMatrix); assert.deepEqual((await exportedModel()).events, fixture.events); await eventWorkload('monthly_cross', 3); await eventWorkload('monthly_half', .5);
    await editor().getByTestId('schedule-mode-global').click(); await frame(); assert.equal(await editor().locator('.schedule-workload-list').count(), 0, 'Global event rows do not repeat person-level monthly totals');
    await eventWorkload('monthly_bob', 2.5); await eventWorkload('monthly_overall', 5);
    await editor().getByTestId('schedule-mode-people').click(); await frame(); assert.deepEqual(await monthlySnapshot(), initialMatrix);
    await undo(); await undo(); await undo(); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await monthlySnapshot(), initialMatrix);
  });
  await check('manual-holiday-overrides-change-capacity-and-undo-restores-it', async () => {
    await viewMenu(); await editor().getByTestId('schedule-calendar-settings').click(); const dialog = editor().getByTestId('schedule-calendar-dialog'); await dialog.waitFor(); await dialog.getByTestId('schedule-excluded-holidays').fill(''); await dialog.getByTestId('schedule-calendar-confirm').click(); await dialog.waitFor({ state: 'hidden' }); await frame();
    await monthlyValue('alice', '2026-01', .5, 1); await monthlyValue('bob', '2026-01', .5, 1); assert.deepEqual((await exportedModel()).events, fixture.events); await eventWorkload('monthly_cross', 2);
    await undo(); assert.deepEqual(await exportedModel(), baseline); assert.deepEqual(await monthlySnapshot(), initialMatrix); await eventWorkload('monthly_cross', 3);
  });
  await check('late-holiday-refresh-updates-inline-workload-without-changing-project-or-revision', async () => {
    const before = await exportedModel(), state = await scheduleState(), identity = await active();
    holidayPlans.set(2026, { hold: true, payload: holidayFixture(2026, ['2026-01-06']) }); await refreshHoliday(); await poll(async () => heldHolidays.some(item => item.details.year === 2026), 'annual workload holiday response is held'); assert.deepEqual(await monthlySnapshot(), initialMatrix);
    await releaseHoliday(2026); await holidayIdle(); await monthlyValue('alice', '2026-01', 1, 1); await monthlyValue('bob', '2026-01', .5, 1); await monthlyValue('alice', '2025-12', 2, 3);
    await eventWorkload('monthly_overall', 4); await eventWorkload('monthly_bob', 2);
    const hidden = await monthlyPng('monthly-tags-hidden-event.png', [...await personTags('alice'), ...await personTags('bob')]); assert.ok(hidden.texts.some(item => item.text.includes('部分事件仅在隐藏日期内')));
    assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state); assert.deepEqual(await active(), identity); await capture('monthly-after-holiday-refresh');
  });
  await check('projects-without-people-show-no-empty-workload-widgets', async () => {
    const empty = { ...structuredClone(fixture), id: 'workload_no_people', title: '无人员工时', roles: [], events: [fixture.events[0]] }; delete empty.layout;
    await openFixture('no-people-workload.ooschedule', empty); await holidayIdle(); assert.equal(await editor().locator('.schedule-workload-list').count(), 0); assert.doesNotMatch(await editor().innerText(), /NaN|Infinity/); assert.deepEqual(await exportedModel(), empty);
  });
  await check('zero-working-day-month-shows-a-dash-even-when-weekends-are-visible', async () => {
    const zero = { ...structuredClone(fixture), id: 'workload_zero_days', title: '周末范围无工作日', startDate: '2026-09-26', endDate: '2026-09-27', calendar: { hideWeekends: false, hideHolidays: false, extraHolidays: [], excludedHolidays: [] }, events: [{ ...fixture.events[1], id: 'weekend_person', startDate: '2026-09-26', endDate: '2026-09-27' }] };
    await openFixture('zero-workdays.ooschedule', zero); await holidayIdle(); await monthlyValue('alice', '2026-09', 0, 0); await monthlyValue('bob', '2026-09', 0, 0); await eventWorkload('weekend_person', 0); assert.match(await monthlyCell('alice', '2026-09').getAttribute('title'), /无可排工作日/); assert.doesNotMatch(await editor().innerText(), /NaN|Infinity/); assert.deepEqual(await exportedModel(), zero); await capture('zero-month-capacity');
    await monthlyPng('monthly-tags-no-workdays.png', ['26.09-—', '26.09-—']);
  });
  await check('one-hundred-persons-and-thirty-seven-months-stay-readable-at-minimum-track-height', async () => {
    const end = new Date('2028-01-31T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1095);
    const large = { ...structuredClone(fixture), id: 'maximum_monthly_lists', title: '100 人 · 37 个月工时列表', startDate: '2028-01-31', endDate: end.toISOString().slice(0, 10), calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: Array.from({ length: 100 }, (_, i) => ({ id: `workload_person_${i}`, name: `成员 ${i + 1}`, role: '长期项目', color: i % 2 ? '#00aa88' : '#2563eb' })), events: [], layout: { trackHeights: { 'person-workload_person_0': 84, 'person-workload_person_99': 84 } } };
    large.roles[0].name = '这是需要省略显示的很长的人员姓名'; large.roles[0].role = '这是需要省略显示的很长的项目角色';
    await openFixture('maximum-monthly-lists.ooschedule', large); await holidayIdle(); await page.setViewportSize({ width: 1280, height: 600 }); await frame();
    const before = await exportedModel(), state = await scheduleState(), first = monthlyList('workload_person_0'); assert.equal(await editor().locator('.schedule-workload-list').count(), 100); assert.equal(await first.locator('[data-month]').count(), 37); assert.equal(Number(await track('workload_person_0').getAttribute('data-track-height')), 84);
    const area = await first.boundingBox(), row = await first.locator('[data-month]').first().boundingBox(); assert.ok(area && row); assert.ok(area.height >= 18, 'An 84px track exposes at least one complete monthly row'); assert.ok(row.y >= area.y - 1 && row.y + row.height <= area.y + area.height + 1); assert.equal(await first.evaluate(element => element.scrollHeight > element.clientHeight), true);
    await personHeading('workload_person_0', true); const pair = await first.locator('[data-month]').nth(1).boundingBox(), nextRow = await first.locator('[data-month]').nth(2).boundingBox(); assert.equal(row.y, pair.y); assert.ok(pair.x > row.x + row.width); assert.equal(nextRow.x, row.x); assert.ok(nextRow.y >= row.y + row.height + 3); await capture('two-column-tags-long-heading');
    const outerTop = await scroll().evaluate(element => element.scrollTop); await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2); await page.mouse.wheel(0, 280); await poll(async () => first.evaluate(element => element.scrollTop > 0), 'monthly list scrolls independently'); assert.equal(await scroll().evaluate(element => element.scrollTop), outerTop);
    await reachEveryMonth(first); await frame(); const final = await first.locator('[data-month="2031-01"]').boundingBox(), scrolled = await first.boundingBox(); assert.ok(final.y >= scrolled.y - 1 && final.y + final.height <= scrolled.y + scrolled.height + 1); await capture('minimum-track-monthly-scroll');
    const regular = monthlyList('workload_person_1'); await regular.scrollIntoViewIfNeeded(); assert.equal(Number(await track('workload_person_1').getAttribute('data-track-height')), 112); await reachEveryMonth(regular); await frame(); await capture('default-track-monthly-scroll');
    await page.setViewportSize({ width: 800, height: 640 }); await page.getByTestId('theme-dark').click(); await scroll().evaluate(element => { element.scrollTop = element.scrollHeight; }); await frame();
    const last = monthlyList('workload_person_99'); await last.scrollIntoViewIfNeeded(); await last.evaluate(element => { element.scrollTop = element.scrollHeight; }); await frame(); const lastBox = await last.boundingBox(), lastMonth = await last.locator('[data-month="2031-01"]').boundingBox(); assert.ok(lastBox.height >= 18); assert.ok(lastMonth.y >= lastBox.y - 1 && lastMonth.y + lastMonth.height <= lastBox.y + lastBox.height + 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await exportedModel(), before); assert.deepEqual(await scheduleState(), state); await capture('one-hundred-person-lists-dark-small-window'); await page.setViewportSize({ width: 1360, height: 900 }); await page.getByTestId('theme-light').click();
  });
  await check('png-expands-short-tracks-to-show-all-thirty-seven-months-and-preserves-afternoon', async () => {
    const end = new Date('2028-01-31T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1095);
    const long = { ...structuredClone(fixture), id: 'complete_months_png', title: '完整月度工时与下午排期', startDate: '2028-01-31', endDate: end.toISOString().slice(0, 10), calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, events: [{ ...fixture.events[2], id: 'long_afternoon', title: '跨月下午任务', startDate: '2028-01-31', endDate: end.toISOString().slice(0, 10) }], layout: { trackHeights: { 'person-alice': 84, 'person-bob': 112 } } };
    await openFixture('complete-monthly-tags.ooschedule', long); await holidayIdle(); const view = await zoomState(); await wheelAt(view.x + 192 + 100, view.y + 100, 1200); assert.equal((await zoomState()).width, 36);
    const alice = await personTags('alice'), bob = await personTags('bob'); assert.equal(alice.length, 37); assert.equal(bob.length, 37); assert.ok(alice.every(tag => tag.endsWith('-50%'))); assert.ok(bob.every(tag => tag.endsWith('-0%')));
    const people = await monthlyPng('monthly-tags-all-37-months.png', [...alice, ...bob]);
    const name = people.texts.find(item => item.text === '林设计' && item.x < 216), nextName = people.texts.find(item => item.text === '陈开发' && item.x < 216), rowTop = name.y - 24, rowBottom = nextName.y - 24, height = rowBottom - rowTop;
    assert.ok(height > 336 && height % 28 === 0, 'Export expands beyond the UI height cap using track increments');
    const finalTag = people.tags.find(item => item.text === '31.01-50%'); assert.ok(finalTag.y + 9 < rowBottom, 'Last month fits completely inside the expanded row');
    const afternoon = people.texts.find(item => item.text === '下午' && item.x >= 216); assert.ok(afternoon.y > rowTop + height / 2 && afternoon.y < rowBottom, 'Afternoon event stays in the lower half of the expanded export row');
    assert.deepEqual(pixel(people.png, 220 * afternoon.scale, (rowTop + height / 4) * afternoon.scale), [255, 255, 255, 255], 'Morning half remains empty in the actual PNG');
    const stripe = pixel(people.png, 220 * afternoon.scale, (rowTop + height * .75) * afternoon.scale); assert.ok(stripe[0] > 170 && stripe[1] < 100 && stripe[2] < 120, 'Afternoon event color appears in the lower half of the actual PNG');
    assert.equal(Number(await track('alice').getAttribute('data-track-height')), 84); assert.equal(Number(await track('bob').getAttribute('data-track-height')), 112); assert.deepEqual(await exportedModel(), long);
    await editor().getByTestId('schedule-mode-global').click(); await frame(); const global = await monthlyPng('monthly-tags-global-all-37-months.png', alice); assert.equal(global.tags.at(-1).text, '31.01-50%');
    assert.deepEqual(await exportedModel(), long);
  });
}

(async () => {
  try {
    report.startedAt = new Date().toISOString(); report.sourcesBefore = hashes();
    const { createServer } = await import('vite');
    server = await createServer({ root, clearScreen: false, optimizeDeps: { entries: ['index.html'] }, cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: Number(process.env.OFFICE_SCHEDULE_PORT || 5337), strictPort: true, hmr: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, watch: { ignored: ['**/vendor/**', '**/target/**', '**/test-results/**'] }, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', acceptDownloads: true, serviceWorkers: 'block' });
    await installHolidayRoutes(context, origin);
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message)); page.on('console', message => {
      if (message.type() !== 'error') return;
      const url = message.location().url;
      if (abortedHolidayUrls.has(url) && /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED/.test(message.text())) report.expectedNetworkErrors.push({ url, message: message.text() });
      else report.consoleErrors.push(message.text());
    });
    await page.goto(origin, { timeout: 60000 });
    if (focus === 'holiday-refresh') { await holidayRefreshChecks(); completeReport(); return; }
    if (focus === 'layout-export') { await layoutExportChecks(); completeReport(); return; }
    if (focus === 'daypart-zoom') { await daypartZoomChecks(); completeReport(); return; }
    if (focus === 'resize-copy') { await resizeCopyChecks(); completeReport(); return; }
    if (focus === 'annual-weeks') { await annualWeekChecks(); completeReport(); return; }
    if (focus === 'monthly-workload') { await monthlyWorkloadChecks(); completeReport(); return; }
    if (focus === 'unknown-year') {
      await check('unknown-year-notice-respects-both-weekend-display-states', async () => {
        const value = { format: 'open-office-schedule', version: 1, id: 'unknown_year_toggle', title: '未知年份周末显示验证', startDate: '2035-06-04', endDate: '2035-06-29', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: ['2035-06-12'], excludedHolidays: [] }, roles: [], events: [{ id: 'unknown_year_event', roleId: null, title: '跨周工作安排', startDate: '2035-06-08', endDate: '2035-06-14', height: 1, slot: 0, notes: '合成测试数据' }] };
        await openFixture('unknown-year-weekends.ooschedule', value);
        await holidayIdle(); const warning = editor().getByTestId('schedule-holiday-status');
        assert.equal(await editor().getByTestId('schedule-holiday-warning').count(), 0, 'Unknown years use one neutral status instead of a duplicate yellow row'); assert.match(await warning.innerText(), /2035/); assert.match(await warning.innerText(), /本地|周末|手动/);
        const shownDates = async () => timeline().locator('[data-date]').evaluateAll(elements => elements.map(element => element.getAttribute('data-date')));
        const weekend = date => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
        assert.ok((await shownDates()).every(date => !weekend(date))); assert.ok(!(await shownDates()).includes('2035-06-12'), 'A manually configured holiday stays hidden in an unknown year');
        await viewMenu(); await editor().getByTestId('schedule-show-weekends').check(); await viewMenu(false); await frame();
        const expanded = await exportedModel(); assert.equal(expanded.calendar.hideWeekends, false); assert.deepEqual(expanded.events, value.events); assert.ok((await shownDates()).some(weekend), 'Checking the UI toggle renders real Saturday/Sunday columns');
        assert.ok(!(await shownDates()).includes('2035-06-12')); assert.match(await warning.innerText(), /本地|周末|手动/); assert.doesNotMatch(await warning.innerText(), /仅隐藏周末/); await capture('unknown-year-weekends-visible');
        await viewMenu(); await editor().getByTestId('schedule-show-weekends').uncheck(); await viewMenu(false); await frame(); assert.deepEqual(await exportedModel(), value); assert.ok((await shownDates()).every(date => !weekend(date))); await capture('unknown-year-weekends-hidden');
      });
      await holidayIdle(); completeReport(); return;
    }
    let roleA, roleB, work, overall, conflict, saved, firstKey, dayWidth, trackHeight;
    await check('home-create-project-dates-people-roles-and-colors', async () => {
      await page.getByTestId('home-new-schedule').click(); await project('秋季产品迭代');
      await addRoles([{ name: '林设计', role: '产品设计', color: '#2563eb' }, { name: '陈开发', role: '客户端开发', color: '#db2777' }]);
      const value = await exportedModel(); firstKey = (await active()).key; [roleA, roleB] = value.roles;
      assert.equal(value.title, '秋季产品迭代'); assert.equal(value.startDate, '2026-09-21'); assert.equal(value.endDate, '2026-11-27');
      assert.deepEqual(value.roles.map(({ name, role, color }) => ({ name, role, color })), [{ name: '林设计', role: '产品设计', color: '#2563eb' }, { name: '陈开发', role: '客户端开发', color: '#db2777' }]);
      assert.equal(await track(null).count(), 1); assert.equal(await track(roleA.id).count(), 1); assert.equal(await track(roleB.id).count(), 1);
      dayWidth = Number(await timeline().getAttribute('data-day-width')); trackHeight = Number(await timeline().getAttribute('data-track-height')); assert.ok(dayWidth > 20 && trackHeight > 40);
      assert.equal(await page.getByTestId('document-mcp-toggle').count(), 0, 'Schedule does not advertise an unimplemented MCP server');
    });
    await check('week-labels-and-weekend-mainland-holiday-projection', async () => {
      const dates = await timeline().locator('[data-date]').evaluateAll(elements => elements.map(element => element.getAttribute('data-date')));
      for (const day of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-28']) assert.ok(dates.includes(day), `Working date ${day} appears`);
      for (const day of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01']) assert.ok(!dates.includes(day), `Hidden date ${day} is absent`);
      assert.equal(await timeline().locator('[data-week="W39"][data-week-year="2026"]').count(), 1); assert.equal(await timeline().locator('[data-week="W40"][data-week-year="2026"]').count(), 1);
    });
    await check('create-overall-event-and-person-event-from-empty-track', async () => {
      overall = await createEvent({ title: '版本整体计划', roleId: null, startDate: '2026-09-21', endDate: '2026-09-30', notes: '合成测试项目：设计、实现与验证。' });
      const dateBox = await timeline().locator('[data-date="2026-09-21"]').boundingBox(), laneBox = await editor().getByTestId(`schedule-lane-${roleA.id}`).boundingBox(); assert.ok(dateBox && laneBox);
      await page.mouse.dblclick(dateBox.x + dateBox.width / 2, laneBox.y + laneBox.height / 2);
      await eventDialog().waitFor(); assert.equal(await eventDialog().getByTestId('schedule-event-start').inputValue(), '2026-09-21');
      await eventForm({ title: '交互原型', roleId: roleA.id, startDate: '2026-09-21', endDate: '2026-09-23', notes: '通过真实鼠标验证整天吸附。' });
      await eventDialog().getByTestId('schedule-event-confirm').click(); await eventDialog().waitFor({ state: 'hidden' });
      work = (await exportedModel()).events.find(value => value.title === '交互原型'); assert.ok(work); assert.equal((await exportedModel()).events.length, 2); await capture('desktop-created');
    });
    await check('pointer-cross-person-move-and-left-right-whole-day-resize', async () => {
      await gesture(eventElement(work.id), dayWidth, trackHeight);
      let value = await eventState(work.id); assert.equal(value.roleId, roleB.id); assert.equal(value.startDate, '2026-09-22'); assert.equal(value.endDate, '2026-09-24');
      await gesture(eventElement(work.id).getByTestId('resize-end'), dayWidth * 1.3, 0);
      value = await eventState(work.id); assert.equal(value.endDate, '2026-09-28', 'One displayed-day resize skips the hidden holiday and weekend');
      await gesture(eventElement(work.id).getByTestId('resize-start'), -dayWidth * 0.8, 0);
      value = await eventState(work.id); assert.equal(value.startDate, '2026-09-21'); assert.equal(value.endDate, '2026-09-28');
      await gesture(eventElement(work.id).getByTestId('resize-end'), dayWidth * 0.2, 0);
      assert.deepEqual(await eventState(work.id), value, 'Sub-half-cell horizontal resize leaves exact dates unchanged');
      report.dragResult = value;
    });
    await check('bottom-resize-snaps-to-fifty-and-one-hundred-percent', async () => {
      await gesture(eventElement(work.id).getByTestId('resize-height'), 0, -trackHeight * 0.55);
      let value = await eventState(work.id); assert.equal(value.height, 0.5); assert.equal(value.slot, 0);
      await gesture(eventElement(work.id).getByTestId('resize-height'), 0, trackHeight * 0.55);
      value = await eventState(work.id); assert.equal(value.height, 1); assert.equal(value.slot, 0);
      await gesture(eventElement(work.id).getByTestId('resize-height'), 0, -trackHeight * 0.55); assert.equal((await eventState(work.id)).height, 0.5);
      await capture('half-height-event');
    });
    await check('fifty-percent-event-still-blocks-same-person-date-collision', async () => {
      const before = await exportedModel(); await editor().getByTestId('schedule-add-event').click();
      await eventForm({ title: '不允许同日并排', roleId: roleB.id, startDate: '2026-09-22', endDate: '2026-09-23', height: 0.5 });
      await eventDialog().getByTestId('schedule-event-confirm').click(); await frame(); assert.equal(await eventDialog().isVisible(), true);
      assert.match(await eventDialog().innerText(), /重叠|冲突|占用/); await cancelDialog(eventDialog()); assert.deepEqual(await exportedModel(), before);
      conflict = await createEvent({ title: '独立设计评审', roleId: roleA.id, startDate: '2026-09-22', endDate: '2026-09-24', height: 0.5 });
      const prior = await exportedModel(); await gesture(eventElement(conflict.id), 0, trackHeight);
      assert.deepEqual(await exportedModel(), prior, 'Rejected pointer drop preserves both events and every stored property');
      await closeError(); await capture('collision-preserves-events');
    });
    await check('escape-cancels-pointer-gesture-and-shell-undo-redo-restores-exact-model', async () => {
      const before = await exportedModel(); await gesture(eventElement(work.id), dayWidth * 2, -trackHeight, true); assert.deepEqual(await exportedModel(), before);
      await gesture(eventElement(work.id).getByTestId('resize-end'), dayWidth, 0); const after = await exportedModel(); assert.notDeepEqual(after, before);
      await undo(); assert.deepEqual(await exportedModel(), before); await redo(); assert.deepEqual(await exportedModel(), after);
      await undo(); assert.deepEqual(await exportedModel(), before);
    });
    await check('global-view-mixes-people-by-start-date-and-preserves-owner-on-drag', async () => {
      await editor().getByTestId('schedule-mode-global').click(); await frame();
      const before = await exportedModel(), expected = before.events.filter(value => value.roleId !== null).sort((a, b) => a.startDate.localeCompare(b.startDate)).map(value => value.id);
      const rows = timeline().locator('[data-testid^="schedule-track-event-"]');
      assert.deepEqual(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid').replace('schedule-track-event-', ''))), expected);
      const prior = await eventState(work.id); await gesture(eventElement(work.id), dayWidth, trackHeight);
      const moved = await eventState(work.id); assert.equal(moved.roleId, prior.roleId); assert.equal(moved.startDate, '2026-09-22'); assert.equal(moved.endDate, '2026-09-29');
      await capture('global-mixed-people'); await undo(); assert.deepEqual(await exportedModel(), before);
      await editor().getByTestId('schedule-mode-people').click(); await frame();
    });
    await check('calendar-display-toggles-never-change-event-dates', async () => {
      const before = (await exportedModel()).events;
      await viewMenu(); await editor().getByTestId('schedule-show-weekends').click(); await editor().getByTestId('schedule-show-holidays').click(); await viewMenu(false); await frame();
      let value = await exportedModel(); assert.equal(value.calendar.hideWeekends, false); assert.equal(value.calendar.hideHolidays, false); assert.deepEqual(value.events, before);
      assert.equal(await timeline().locator('[data-date="2026-09-25"]').count(), 1); assert.equal(await timeline().locator('[data-date="2026-09-26"]').count(), 1);
      await capture('calendar-weekends-and-holidays-visible');
      await viewMenu(); await editor().getByTestId('schedule-show-weekends').click(); await editor().getByTestId('schedule-show-holidays').click(); await viewMenu(false); await frame();
      value = await exportedModel(); assert.equal(value.calendar.hideWeekends, true); assert.equal(value.calendar.hideHolidays, true); assert.deepEqual(value.events, before);
    });
    await check('browser-download-ooschedule-and-exact-json', async () => {
      const before = await exportedModel(); saved = await saveDownload('秋季排期验收.ooschedule', true);
      assert.deepEqual(saved.model, before); assert.equal(saved.model.format, 'open-office-schedule'); assert.equal(saved.model.version, 1); assert.equal(saved.model.events.length, 3);
      assert.equal(await page.getByTestId('global-save-state').innerText(), '已保存');
      report.download = { file: path.basename(saved.target), bytes: saved.bytes.length, sha256: crypto.createHash('sha256').update(saved.bytes).digest('hex') };
    });
    await check('selection-and-cancelled-pointer-gesture-keep-saved-document-clean', async () => {
      await eventElement(work.id).click(); await frame(); assert.equal((await active()).dirty, false); assert.equal(await page.getByTestId('global-save-state').innerText(), '已保存');
      await gesture(eventElement(work.id), dayWidth * 2, 0, true); assert.deepEqual(await exportedModel(), saved.model); assert.equal((await active()).dirty, false); assert.equal(await page.getByTestId('global-save-state').innerText(), '已保存');
    });
    await check('manual-save-cancels-uncommitted-gesture-and-background-save-is-unavailable', async () => {
      const box = await eventElement(work.id).boundingBox(); assert.ok(box); const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dayWidth * 2, y, { steps: 8 }); await frame();
      assert.equal(await timeline().locator('.schedule-event-ghost').count(), 1);
      assert.equal(await page.evaluate(async () => { const a = document.querySelector('#app').__vue_app__._instance.setupState; return a.scheduleHandles.get(a.activeKey).canBackgroundExport(); }), false, 'Background autosave cannot interrupt an unfinished gesture');
      const pending = page.waitForEvent('download'); await page.keyboard.press('ControlOrMeta+s'); const download = await pending; const target = path.join(output, 'save-during-pointer.ooschedule'); await download.saveAs(target); assert.equal(await download.failure(), null); await ready();
      assert.equal(await timeline().locator('.schedule-event-ghost').count(), 0); assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), saved.model, 'Manual save contains the committed dates, with no pointer preview');
      await page.mouse.up(); await frame(); assert.deepEqual(await exportedModel(), saved.model, 'Releasing the cancelled pointer cannot commit a late change'); assert.equal((await active()).dirty, false);
    });
    await check('reopen-download-preserves-model-and-independent-tab-state', async () => {
      await page.getByTestId('document-open-input').setInputFiles(saved.target); await ready(); assert.equal(await page.locator('.document-tab').count(), 2); assert.deepEqual(await exportedModel(), saved.model);
      const reopened = await saveDownload('秋季排期验收.ooschedule'); assert.deepEqual(reopened.model, saved.model); assert.deepEqual(reopened.bytes, saved.bytes);
      await newSchedule('另一个独立项目'); assert.equal(await page.locator('.document-tab').count(), 3); assert.equal((await exportedModel()).events.length, 0);
      await page.locator('.document-tab').first().locator('.tab-name').click(); await ready(); assert.equal((await active()).key, firstKey); assert.deepEqual(await exportedModel(), saved.model);
      await capture('reopened-and-multiple-tabs');
    });
    await check('invalid-open-is-atomic-and-keeps-current-document-and-tabs', async () => {
      const key = (await active()).key, before = await exportedModel(), count = await page.locator('.document-tab').count();
      const wrongVersion = structuredClone(before); wrongVersion.version = 99;
      const wrongDates = structuredClone(before); wrongDates.events[0].endDate = '2026-02-30';
      const overlap = structuredClone(before); overlap.events.push({ ...overlap.events.find(value => value.roleId === roleB.id), id: 'rejected_overlap', height: 0.5, title: '冲突导入' });
      const duplicate = structuredClone(before); duplicate.roles[1].id = duplicate.roles[0].id;
      for (const [name, value] of [['broken-json', '{"format":'], ['unsupported-version', wrongVersion], ['invalid-date', wrongDates], ['duplicate-id', duplicate], ['overlap-even-at-half-height', overlap]]) {
        await page.getByTestId('document-open-input').setInputFiles({ name: `${name}.ooschedule`, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
        await page.locator('.error-banner').waitFor(); await ready(); assert.equal((await active()).key, key); assert.equal(await page.locator('.document-tab').count(), count); assert.deepEqual(await exportedModel(), before); await closeError();
      }
    });
    await check('unknown-holiday-year-is-disclosed-and-custom-project-reopens', async () => {
      const future = { format: 'open-office-schedule', version: 1, id: 'future_project', title: '未知假期年份验证', startDate: '2035-06-04', endDate: '2035-06-29', calendar: { hideWeekends: true, hideHolidays: true, extraHolidays: [], excludedHolidays: [] }, roles: [], events: [] };
      await openFixture('unknown-holiday-year.ooschedule', future); assert.deepEqual(await exportedModel(), future); assert.match(await editor().innerText(), /2035/); assert.match(await editor().innerText(), /未.*(?:发布|覆盖|提供|假期|假日)|未知|暂无/); await capture('unknown-year-notice');
    });
    await check('overall-track-and-left-labels-stay-visible-during-scroll', async () => {
      const value = structuredClone(saved.model); value.id = 'sticky_project'; value.title = '长项目滚动验证'; value.endDate = '2027-03-26'; value.roles = Array.from({ length: 12 }, (_, i) => ({ id: `sticky_role_${i}`, name: `测试人员 ${i + 1}`, role: `协作角色 ${i + 1}`, color: i % 2 ? '#db2777' : '#2563eb' }));
      value.events = [{ ...overall, id: 'sticky_overall', startDate: value.startDate, endDate: '2026-10-09' }, ...value.roles.map((role, i) => ({ id: `sticky_event_${i}`, roleId: role.id, title: `阶段工作 ${i + 1}`, startDate: '2026-09-21', endDate: '2026-09-24', height: 1, slot: 0, notes: '' }))];
      await openFixture('sticky-project.ooschedule', value); await frame();
      const label = timeline().getByTestId('schedule-label-overall'), initialLabel = await label.boundingBox(), initialOverall = await track(null).boundingBox(), viewport = await scroll().boundingBox(); assert.ok(initialLabel && initialOverall && viewport);
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2); await page.mouse.wheel(700, 500); await frame();
      await poll(async () => scroll().evaluate(element => element.scrollLeft > 100 && element.scrollTop > 100), 'timeline scrolls in both directions');
      const finalLabel = await label.boundingBox(), finalOverall = await track(null).boundingBox(); assert.ok(finalLabel && finalOverall);
      assert.ok(Math.abs(initialLabel.x - finalLabel.x) < 2, 'Left label retains its screen position during horizontal scroll'); assert.ok(Math.abs(initialOverall.y - finalOverall.y) < 2, 'Overall plan retains its screen position during vertical scroll');
      report.stickyEvidence = { initialLabel, finalLabel, initialOverall, finalOverall, scroll: await scroll().evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop })) }; await capture('sticky-overall-and-left-label');
    });
    await check('light-dark-and-small-window-remain-contained', async () => {
      await page.getByTestId('theme-light').click(); await capture('desktop-light'); await page.getByTestId('theme-dark').click(); await capture('desktop-dark');
      await page.setViewportSize({ width: 800, height: 640 }); await frame(); await capture('small-window-dark'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Small window has no document-level horizontal overflow');
      assert.ok(await timeline().isVisible()); await page.setViewportSize({ width: 1360, height: 900 }); await page.getByTestId('theme-light').click();
    });
    await holidayIdle(); completeReport();
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) { try { await capture('failure'); report.failure.text = (await page.locator('body').innerText()).slice(-9000); } catch {} }
    process.exitCode = 1;
  } finally { await browser?.close(); await server?.close(); persist(); console.log(JSON.stringify({ ok: report.ok, stage: report.stage, checks: report.checks.length, report: path.join(output, 'report.json'), failure: report.failure?.message })); }
})();
