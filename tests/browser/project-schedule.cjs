/* Real Vue project schedule UI, pointer gestures, browser downloads and reopen.
 * Run: node tests/browser/project-schedule.cjs (owns Vite 5337 and Chromium).
 * Focused unknown-year regression: OFFICE_SCHEDULE_FOCUS=unknown-year node tests/browser/project-schedule.cjs
 * Automatic holiday regression: OFFICE_SCHEDULE_FOCUS=holiday-refresh node tests/browser/project-schedule.cjs
 * Compact toolbar, track sizing and file/image export: OFFICE_SCHEDULE_FOCUS=layout-export node tests/browser/project-schedule.cjs
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
const output = path.resolve(process.env.OFFICE_SCHEDULE_OUTPUT || path.join(root, ['unknown-year', 'holiday-refresh', 'layout-export'].includes(focus) ? `test-results/project-schedule-${focus}` : 'test-results/project-schedule'));
const sources = ['src/App.vue', 'src/style.css', 'src/components/ScheduleEditor.vue', 'src/schedule/components/ScheduleTimeline.vue', 'src/schedule/model.ts', 'src/schedule/calendar.ts', 'src/schedule/holidays.ts', 'src/schedule/holiday-native.ts', 'src/schedule/session.ts', 'src/schedule/layout.ts', 'src/schedule/png-export.ts', 'src/shared/document.ts'];
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
  assert.equal(await locator.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), start), true, 'Pointer starts on the actual visible gesture target');
  report.gestures.push({ stage: report.stage, selector: await locator.getAttribute('data-testid'), start, end, cancel }); persist();
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 10 });
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
    const x = item.x + item.width / 2, y = item.y + item.height / 2, targetY = lane.y + lane.height / 2;
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
      assert.match(await timeline().innerText(), /W1/); assert.match(await timeline().innerText(), /W2/);
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
