/* Real shell locale toggle, persistence, responsive appearance controls and document preservation.
 * Run: node tests/browser/app-localization.cjs (no native engine build required).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'test-results/app-localization');
fs.mkdirSync(output, { recursive: true });
(async()=>{
 let server,browser;const report={ok:false,checks:[],layouts:[],errors:[]};
 try {
  const {createServer}=await import('vite');server=await createServer({root,clearScreen:false,cacheDir:path.join(output,'vite-cache'),server:{host:'127.0.0.1',port:5365,strictPort:true,hmr:false}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1366,height:800},locale:'zh-CN'});page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await page.route('https://**',route=>route.fulfill({status:503,body:''}));
  const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const state=()=>page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._instance.setupState;return app.handleFor(app.active).inspect()});
  const check=async(name,fn)=>{await fn();report.checks.push(name)};
  const toggle=()=>page.getByTestId('language-toggle');
  await page.goto('http://127.0.0.1:5365', {waitUntil:'domcontentloaded',timeout:60000});await toggle().waitFor();
  await check('Chinese defaults and English toggle is beside the theme controls',async()=>{
   assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');assert.equal(await toggle().getAttribute('aria-label'),'Switch to English');
   assert.equal(await page.locator('.appearance-controls .theme-switch').count(),1);assert.equal(await page.locator('.appearance-controls [data-testid=language-toggle]').count(),1);
   await toggle().click();assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await toggle().getAttribute('aria-label'),'切换到中文');
   assert.equal(await page.locator('.home-heading h1').textContent(),'Home');assert.equal(await page.getByTestId('shell-open').getAttribute('aria-label'),'Open file');
   assert.equal(await page.getByTestId('theme-light').getAttribute('aria-label'),'Light theme');assert.equal(await page.getByTestId('theme-system').getAttribute('aria-label'),'System');
   assert.equal(await page.evaluate(()=>localStorage.getItem('open-office.locale')),'en');
  });
  await check('English persists on reload and shell help and new menu are translated',async()=>{
   await page.reload({waitUntil:'domcontentloaded',timeout:60000});await toggle().waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.locator('.home-heading h1').textContent(),'Home');
   await page.getByTestId('shell-new').click();assert.equal(await page.getByTestId('shell-new-calendar').textContent(),'Calendar notes');assert.equal(await page.getByTestId('shell-new-word').textContent(),'Text document');await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'User guide',exact:true}).click();await page.locator('.help-modal').waitFor();assert.equal(await page.locator('.help-grid article').count(),9);assert.doesNotMatch(await page.locator('.help-modal').textContent(),/[\u4e00-\u9fff]/);await page.getByRole('button',{name:'Close guide',exact:true}).click();
  });
  await page.evaluate(()=>{document.querySelector('#app').__vue_app__._instance.setupState.recents=[{id:'locale-recent',name:'用户项目计划.owflow',extension:'owflow',kind:'canvas',lastOpenedAt:Date.now()}]});
  await check('Localized home keeps user file names and appearance controls within the sidebar',async()=>{
   for(const [width,height] of [[1366,800],[1024,640],[760,800],[480,800],[360,640]]){
    await page.setViewportSize({width,height});await frame();
    const geometry=await page.evaluate(()=>{
     const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
     const aside=document.querySelector('.sidebar'),controls=[...document.querySelectorAll('.sidebar-bottom button')].filter(node=>node.getClientRects().length),cards=[...document.querySelectorAll('.create-card')];
     return{sidebar:rect(aside),controls:controls.map(node=>({name:node.getAttribute('aria-label'),...rect(node)})),cards:cards.map(node=>({rect:rect(node),title:rect(node.querySelector('strong')),textWidth:node.querySelector('strong').scrollWidth})),bodyWidth:document.documentElement.scrollWidth,viewWidth:innerWidth};
    });
    assert.equal(geometry.bodyWidth,geometry.viewWidth);for(const control of geometry.controls){assert.ok(control.x>=geometry.sidebar.x-1&&control.right<=geometry.sidebar.right+1,`${width}: clipped ${control.name}`);assert.ok(control.bottom<=height,`${width}: bottom clipped ${control.name}`)}
    for(let i=0;i<geometry.controls.length;i++)for(let j=i+1;j<geometry.controls.length;j++){const a=geometry.controls[i],b=geometry.controls[j];assert.ok(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,`${width}: overlapping ${a.name}/${b.name}`)}
    for(const card of geometry.cards)assert.ok(card.title.x+card.textWidth<=card.rect.right+1,`${width}: card title overflows its card`);
    assert.equal(await page.locator('.recent-row').getAttribute('title'),'用户项目计划.owflow');report.layouts.push({width,height,sidebarWidth:geometry.sidebar.width});await page.screenshot({path:path.join(output,`home-en-${width}.png`)});
   }
  });
  await page.setViewportSize({width:1366,height:800});await page.getByTestId('home-new-calendar').click();await page.getByTestId('calendar-settings').waitFor();
  await page.evaluate(async()=>{const app=document.querySelector('#app').__vue_app__._instance.setupState;await app.handleFor(app.active).setDocumentTitle('中文用户文档 · Keep name')});await frame();
  await check('Editing rail toggle preserves document, user title and raw status/error messages',async()=>{
   const before=await state();const originalTitle=await page.locator('.document-tab .tab-name').first().textContent();
   for(const [width,height] of [[1366,800],[1024,640],[760,800]]){
    await page.setViewportSize({width,height});await frame();await toggle().click();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');assert.equal(await page.getByTestId('calendar-settings').textContent(),'设置');
    await toggle().click();assert.equal(await page.getByTestId('calendar-settings').textContent(),'Settings');assert.deepEqual(await state(),before);assert.equal(await page.locator('.document-tab .tab-name').first().textContent(),originalTitle);
    const bounds=await toggle().boundingBox(),rail=await page.locator('.sidebar').boundingBox();assert.ok(bounds.x>=rail.x&&bounds.x+bounds.width<=rail.x+rail.width);await page.screenshot({path:path.join(output,`editing-en-${width}.png`)});
   }
   await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._instance.setupState;app.status='所有文件，仅在你的设备上处理';app.error='名称不能超过 240 字。'});await frame();assert.match(await page.locator('.editor-status').textContent(),/All files are processed on your device/);assert.match(await page.locator('.error-banner').textContent(),/The name cannot exceed 240 characters/);
   await toggle().click();assert.match(await page.locator('.editor-status').textContent(),/所有文件，仅在你的设备上处理/);assert.match(await page.locator('.error-banner').textContent(),/名称不能超过 240 字/);assert.deepEqual(await state(),before);
   const raw=await page.evaluate(()=>{const app=document.querySelector('#app').__vue_app__._instance.setupState;return{status:app.status,error:app.error}});assert.equal(raw.status,'所有文件，仅在你的设备上处理');assert.equal(raw.error,'名称不能超过 240 字。');
  });
  await check('Mouse language toggles retain source focus, selection and an active composition draft',async()=>{
   await page.evaluate(()=>{document.querySelector('#app').__vue_app__._instance.setupState.error=''});
   await page.getByTestId('shell-new').click();await page.getByTestId('shell-new-diagram').click();
   const source=page.locator('[data-testid=workflow-editor]:visible [data-testid=diagram-source]');await source.waitFor();
   await source.fill('flowchart LR\n  A[用户内容] --> B[Keep content]');await page.waitForTimeout(300);
   await source.focus();await page.keyboard.press('Control+End');
   // Synthetic composition keeps the draft pending so a normal debounce cannot
   // masquerade as a locale-induced commit. Physical IME behavior is not claimed.
   await source.dispatchEvent('compositionstart',{data:''});await page.keyboard.insertText('\n# 未提交草稿');
   await source.evaluate(element=>{const api=element.closest('.diagram-source-editor').__vueParentComponent.exposed;api.setSelectionRange(api.value.indexOf('未提交'),api.value.length)});
   const snapshot=()=>source.evaluate(element=>{const api=element.closest('.diagram-source-editor').__vueParentComponent.exposed,selection=window.getSelection();return{focused:document.activeElement===element,value:api.value,start:api.selectionStart,end:api.selectionEnd,direction:api.selectionDirection,domText:selection?.toString(),anchorOffset:selection?.anchorOffset,focusOffset:selection?.focusOffset}});
   const draftBefore=await snapshot(),sessionBefore=await state();assert.equal(draftBefore.focused,true);assert.equal(draftBefore.domText,'未提交草稿');
   for(const language of ['en','zh-CN']){
    await toggle().click();await frame();assert.equal(await page.locator('html').getAttribute('lang'),language);
    assert.deepEqual(await snapshot(),draftBefore,'Actual pointer click keeps CodeMirror focus, raw/DOM selection and pending source');
    assert.deepEqual(await state(),sessionBefore,'Language toggle does not commit the active composition draft');
    assert.equal(await source.getAttribute('aria-label'),language==='en'?'Code diagram source':'代码图表源码');
   }
   await source.dispatchEvent('compositionend',{data:'未提交草稿'});
  });
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});await toggle().waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');assert.equal(await page.locator('.home-heading h1').textContent(),'工作台');
  assert.deepEqual(report.errors,[]);report.ok=true;console.log(JSON.stringify({ok:true,checks:report.checks.length,layouts:report.layouts}));
 } finally {fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
