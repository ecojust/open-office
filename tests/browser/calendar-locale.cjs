/* Calendar language changes are display-only, including open drafts and allocation controls.
 * Run: node tests/browser/calendar-locale.cjs (no native engines required).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/i18n-calendar');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'fixture.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module" src="./fixture.js"></script></body></html>');
fs.writeFileSync(path.join(output, 'fixture.js'), `
import { createApp, h, ref } from 'vue';
import CalendarEditor from '/src/components/CalendarEditor.vue';
import { createCalendar, encodeCalendar } from '/src/calendar/model.ts';
import { bytesToBase64 } from '/src/shared/document.ts';
import { setLocale, locale } from '/src/shared/i18n.ts';
import '/src/style.css';
const book = createCalendar('用户日历 · Keep name');
book.notes = [
 { id:'first', title:'项目会议 · Keep title', content:'用户内容不能翻译', date:'2026-11-13', type:'工作日', color:'#3b82f6', created_at:'2026-11-13T00:00:00.000Z', weight:.5 },
 { id:'second', title:'研发', content:'', date:'2026-11-13', type:'工作日', color:'#ff8a5c', created_at:'2026-11-13T00:00:01.000Z', weight:.5 },
];
const bytes=encodeCalendar(book);
window.__calendarLocale = {setLocale, handle:null};
createApp({setup(){const editor=ref(); return ()=>h('main',{style:'height:100vh;display:flex;flex-direction:column'},[
 h('div',{style:'height:32px;flex:none'},[h('button',{id:'switch-zh',onClick:()=>setLocale('zh-CN')},'中文'),h('button',{id:'switch-en',onClick:()=>setLocale('en')},'English')]),
 h(CalendarEditor,{ref:instance=>{editor.value=instance;window.__calendarLocale.handle=instance},document:{id:'locale-calendar',name:'用户日历.oocalendar',kind:'calendar',extension:'oocalendar',base64:bytesToBase64(bytes),sizeBytes:bytes.length,sha256:''},theme:'light',active:true,style:'flex:1;min-height:0'})]);}}).mount('#fixture');
`);
(async()=>{
 let server,browser;
 const errors=[];
 try {
  const {createServer}=await import('vite');
  server=await createServer({root,clearScreen:false,cacheDir:path.join(output,'vite-cache'),server:{host:'127.0.0.1',port:5363,strictPort:true,hmr:false}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1366,height:800},locale:'zh-CN'});page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**',route=>route.fulfill({status:503,body:''}));
  await page.goto('http://127.0.0.1:5363/test-results/i18n-calendar/fixture.html');
  await page.getByTestId('calendar-settings').waitFor();
  await page.getByTestId('calendar-month').fill('2026-11');await page.getByTestId('calendar-month').dispatchEvent('change');
  const inspect=()=>page.evaluate(()=>window.__calendarLocale.handle.inspect());
  const switchTo=async language=>{await page.evaluate(language=>window.__calendarLocale.setLocale(language),language);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  await page.getByTestId('calendar-day-2026-11-13').click();
  const before=await inspect();await switchTo('en');
  assert.deepEqual(await inspect(),before,'Locale change preserves document, history and view selection');
  assert.equal(await page.getByTestId('calendar-settings').textContent(),'Settings');
  assert.equal(await page.getByTestId('calendar-add').textContent(),'Add event');
  assert.equal(await page.locator('.calendar-month-label span').textContent(),'November 2026');
  assert.deepEqual(await page.locator('.calendar-weekdays span').allTextContents(),['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
  assert.match(await page.getByTestId('calendar-note-title-first').textContent(),/项目会议 · Keep title/);
  assert.match(await page.getByTestId('calendar-work-capsule-2026-11-13').getAttribute('aria-label'),/Work allocation/);
  assert.match(await page.getByTestId('calendar-note-value-first').getAttribute('aria-label'),/Edit work allocation for 项目会议 · Keep title/);
  await page.getByTestId('calendar-settings').click();assert.equal(await page.getByTestId('calendar-settings-dialog').getAttribute('aria-label'),'Calendar settings');
  assert.equal(await page.getByTestId('calendar-week-mode').locator('option').first().textContent(),'Week · Monday–Sunday');
  assert.equal(await page.getByTestId('calendar-book-title').inputValue(),before.book.title);
  await switchTo('zh-CN');assert.equal(await page.getByTestId('calendar-settings-dialog').getAttribute('aria-label'),'日历本设置');await page.getByTestId('calendar-note-cancel').click();assert.deepEqual(await inspect(),before);
  await page.getByTestId('calendar-add').click();await page.getByTestId('calendar-note-title').fill('未提交草稿');await page.getByTestId('calendar-note-content').fill('Keep this draft unchanged');
  const draftState=await inspect();await switchTo('en');
  assert.deepEqual(await inspect(),draftState);assert.equal(await page.getByTestId('calendar-note-title').inputValue(),'未提交草稿');assert.equal(await page.getByTestId('calendar-note-content').inputValue(),'Keep this draft unchanged');
  assert.equal(await page.getByTestId('calendar-note-title').getAttribute('placeholder'),'For example: Project meeting');assert.equal(await page.getByTestId('calendar-note-type').inputValue(),'工作日');
  await page.screenshot({path:path.join(output,'calendar-en-draft.png')});await page.getByTestId('calendar-note-cancel').click();assert.deepEqual(await inspect(),before);
  await page.getByTestId('calendar-day-allocation-2026-11-13').click();assert.equal(await page.getByTestId('calendar-day-dialog').getAttribute('aria-label'),'Events on 2026-11-13');
  await page.getByTestId('calendar-day-dialog').getByTestId('calendar-note-value-first').dblclick();assert.equal(await page.getByTestId('calendar-allocation-dialog').getAttribute('aria-label'),'Edit work allocation');
  assert.match(await page.locator('#calendar-allocation-hint').textContent(),/Decimals are supported/);
  await switchTo('zh-CN');assert.equal(await page.getByTestId('calendar-allocation-dialog').getAttribute('aria-label'),'修改工时分配');await page.getByTestId('calendar-note-cancel').click();await page.getByTestId('calendar-note-cancel').click();
  // Selecting an allocation changes the selected note, so compare document/history, not view.
  const afterAllocation=await inspect();assert.deepEqual(afterAllocation.book,before.book);assert.equal(afterAllocation.revision,before.revision);assert.equal(afterAllocation.dirty,before.dirty);
  await switchTo('en');await page.getByTestId('calendar-date-details').click();await page.locator('.calendar-almanac-heading').waitFor();assert.match(await page.locator('.calendar-almanac-heading').textContent(),/Friday/);assert.match(await page.locator('.calendar-almanac').textContent(),/Heavenly stems/);assert.match(await page.locator('.calendar-almanac-heading').textContent(),/[年月]/);
  await page.getByTestId('calendar-note-cancel').click();await page.screenshot({path:path.join(output,'calendar-en.png')});
  // The real shell shares the same locale instance with its mounted calendar editor.
  await page.goto('http://127.0.0.1:5363/');await page.getByTestId('home-new-calendar').click();await page.getByTestId('calendar-settings').waitFor();
  const fullInspect=()=>page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._instance.setupState;return app.handleFor(app.active).inspect()});
  const shellBefore=await fullInspect();await page.evaluate(async()=>{const {setLocale}=await import('/src/shared/i18n.ts');setLocale('en')});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  assert.equal(await page.getByTestId('calendar-add').textContent(),'Add event');assert.deepEqual(await fullInspect(),shellBefore,'Shell language switch preserves the mounted calendar session');
  await page.screenshot({path:path.join(output,'calendar-shell-en.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,checks:['calendar toolbar, weekdays, month, settings and accessibility translated','Chinese user titles and lunar data preserved','locale switches preserve full document, history, selection and pending drafts','allocation controls and almanac labels translated','real shell shares locale without changing the calendar session'],errors},null,2));console.log('Calendar locale: 5 checks passed');
 } finally {await browser?.close();await server?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
