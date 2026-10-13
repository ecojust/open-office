const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const {unzipSync,strFromU8}=require('fflate');

// Exercise the actual Vue player, PDF.js canvas and browser media pipeline.
// No Office installation, WASM engine or mocked PDF/media implementation.
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.PRESENTATION_PLAYER_QA_OUTPUT || path.join(root, 'test-results/presentation-player'));
const harness = path.join(out, 'harness');
fs.mkdirSync(harness, { recursive: true });
const report = { scope: 'Actual SlidePreview + PresentationSession, PDF.js and browser audio/video', checks: [], failures: [], pageErrors: [] };
const filter = process.env.PRESENTATION_PLAYER_QA_FILTER ? new RegExp(process.env.PRESENTATION_PLAYER_QA_FILTER) : null;
let browser, server, page;
async function check(name, work) {
  if (filter && !filter.test(name)) return;
  try { await work(); report.checks.push(name); console.log('PASS', name); }
  catch (error) { report.failures.push({ name, error: String(error.stack || error) }); console.error('FAIL', name, error); if (page) await page.screenshot({ path: path.join(out, `failure-${report.failures.length}.png`) }).catch(() => {}); }
}
function wave() {
  const length = 44100 * 4, bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length * 2, 40);
  for (let index = 0; index < length; index++) bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI * 880 / 44100) * 3000), 44 + index * 2);
  return bytes;
}
const wav = wave(); fs.writeFileSync(path.join(harness, 'tone.wav'), wav);
const python = path.join(root, 'pdf-backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
execFileSync(python, ['-c', String.raw`
import pymupdf,sys
d=pymupdf.open()
for i,color in enumerate([(0.86,0.18,0.15),(0.15,0.62,0.22),(0.13,0.28,0.82),(0.70,0.40,0.10)]):
 p=d.new_page(width=960,height=540)
 p.draw_rect(p.rect,color=color,fill=color)
 p.insert_text((80,100),'Player page '+str(i+1),fontsize=32,color=(1,1,1))
d.save(sys.argv[1])
`, path.join(harness, 'slides.pdf')]);
execFileSync('python3', ['-c', String.raw`
from pptx import Presentation
from pptx.util import Inches
import sys,zipfile
p=Presentation()
for i in range(4):
 s=p.slides.add_slide(p.slide_layouts[6])
 t=s.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1));t.name='Title '+str(i+1);t.text='Player page '+str(i+1)
p.save(sys.argv[1])
first=p.slides._sldIdLst[0]
p.part.drop_rel(first.rId)
p.slides._sldIdLst.remove(first)
p.save(sys.argv[1].replace('.pptx','-minus-first.pptx'))
with zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[1].replace('.pptx','-hidden.pptx'),'w') as target:
 for name in source.namelist():
  data=source.read(name)
  if name=='ppt/slides/slide1.xml':data=data.replace(b'<p:sld ',b'<p:sld show="0" ',1)
  target.writestr(name,data)
with zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[1].replace('.pptx','-sound.pptx'),'w') as target:
 for name in source.namelist():
  data=source.read(name)
  if name=='ppt/slides/slide1.xml':data=data.replace(b'</p:sld>',b'<p:transition><p:sndAc><p:stSnd loop="1"><p:snd r:embed="rIdSoundPreserve" name="Slide tone"/></p:stSnd></p:sndAc></p:transition></p:sld>')
  if name=='ppt/slides/_rels/slide1.xml.rels':data=data.replace(b'</Relationships>',b'<Relationship Id="rIdSoundPreserve" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/sound.wav"/></Relationships>')
  if name=='[Content_Types].xml':data=data.replace(b'</Types>',b'<Default Extension="wav" ContentType="audio/wav"/></Types>')
  target.writestr(name,data)
 target.writestr('ppt/media/sound.wav',open(sys.argv[1].replace('slides.pptx','tone.wav'),'rb').read())
`, path.join(harness, 'slides.pptx')]);
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=3', '-an', '-c:v', 'libvpx-vp9', '-b:v', '80k', path.join(harness, 'clip.webm')], { stdio: 'ignore' });
const pdf64 = fs.readFileSync(path.join(harness, 'slides.pdf')).toString('base64');
const fixturePath = '/' + path.relative(root, harness).replaceAll(path.sep, '/');
fs.writeFileSync(path.join(harness, 'index.html'), `<!doctype html><html><head><base href="/"><style>body{margin:0;font:14px system-ui}</style></head><body><button id="prior-focus">Return focus</button><div id="app"></div><script type="module" src="${fixturePath}/main.js"></script></body></html>`);
fs.writeFileSync(path.join(harness, 'main.js'), `
import {createApp,h,shallowRef,nextTick} from 'vue';
import SlidePreview from '/src/components/SlidePreview.vue';
import PresentationEffects from '/src/components/PresentationEffects.vue';
import {PresentationSession,PRESENTATION_HISTORY_LIMIT} from '/src/presentation/session.ts';
import * as packages from '/src/presentation/pptx-package.ts';
const state=shallowRef(null),effects=shallowRef(null);const originalCreate=URL.createObjectURL.bind(URL),originalRevoke=URL.revokeObjectURL.bind(URL);
window.qa={closed:0,errors:[],created:[],revoked:[],packages,PresentationSession,PRESENTATION_HISTORY_LIMIT,effectEdits:[],effectErrors:[],effectDrafts:[],
 async mount(props){effects.value=null;state.value=null;await nextTick();state.value=props;await nextTick()},
 async mountEffects(props){state.value=null;effects.value=null;await nextTick();window.qa.effectEdits=[];window.qa.effectErrors=[];window.qa.effectDrafts=[];effects.value=props;await nextTick()},
 async updateEffects(props){effects.value={...effects.value,...props};await nextTick()},
 async unmount(){state.value=null;await nextTick()},
 async replace(props){state.value={...state.value,...props};await nextTick()}};
URL.createObjectURL=(blob)=>{const url=originalCreate(blob);window.qa.created.push(url);return url};
URL.revokeObjectURL=(url)=>{window.qa.revoked.push(url);return originalRevoke(url)};
createApp({setup:()=>()=>state.value?h(SlidePreview,{...state.value,onClose(){window.qa.closed++;state.value=null},onError(message){window.qa.errors.push(message)}}):effects.value?h('div',{style:'width:320px;padding:20px'},[h(PresentationEffects,{...effects.value,onEdit(patch){window.qa.effectEdits.push(patch)},onError(message){window.qa.effectErrors.push(message)},'onDraft-change'(pending){window.qa.effectDrafts.push(pending)}})]):null}).mount('#app');
`);
function presentation(patch = {}) {
  return { widthEmu: 9600000, heightEmu: 5400000, warnings: [], hasMacros: false, hasDigitalSignatures: false,
    slides: [0, 1, 2, 3].map(index => ({ index, id: `slide-${index}`, partName: `ppt/slides/slide${index + 1}.xml`, title: `Title ${index + 1}`, notes: `Speaker notes ${index + 1}`, hidden: false,
      transition: { type: 'none', rawType: null, supported: true, durationMs: 250, speed: 'med', advanceAfterMs: null, advanceOnClick: true }, media: [], hasUnsupportedAnimations: false, warnings: [] })), ...patch };
}
async function mount(data = presentation(), startPage = 0) {
  await page.evaluate(async args => { document.getElementById('prior-focus').focus(); await window.qa.mount(args); }, { base64: pdf64, name: 'Browser player regression', startPage, presentation: data });
  await rendered(startPage);
}
async function rendered(index) {
  await page.waitForFunction(index => document.querySelector('[data-testid="slide-preview"]')?.dataset.rendering === 'false' && document.querySelector('[data-testid="slide-preview-canvas"]')?.dataset.pageIndex === String(index), index);
}
async function attachMedia(slideIndex, kind = 'audio', start = 'click', delay = null) {
  return page.evaluate(async ({ slideIndex, kind, start, delay, fixturePath }) => {
    const bytes = new Uint8Array(await (await fetch(fixturePath + (kind === 'audio' ? '/tone.wav' : '/clip.webm'))).arrayBuffer());
    window.fixtureMedia = { id: `media-${slideIndex}`, shapeId: '22', name: kind + ' sample', kind, mimeType: kind === 'audio' ? 'audio/wav' : 'video/webm', data: bytes, rect: { x: .15, y: .2, width: .6, height: .6 }, rotation: 0, start, startDelayMs: delay, loop: false, external: false, partName: `ppt/media/sample.${kind === 'audio' ? 'wav' : 'webm'}`, warnings: [] };
  }, { slideIndex, kind, start, delay, fixturePath });
}
(async () => {
  try {
    const { createServer } = await import('vite'); const { default: vue } = await import('@vitejs/plugin-vue');
    server = await createServer({ root, configFile: false, cacheDir:path.join(out,'vite-cache'), plugins: [vue()], publicDir: path.join(root, 'public'), server: { host: '127.0.0.1', port: 5289, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } }, optimizeDeps: { include: ['vue', 'pdfjs-dist/legacy/build/pdf.mjs', 'fflate'] } });
    await server.listen(); const port = server.httpServer.address().port;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}${fixturePath}/index.html`); await page.waitForFunction(() => window.qa);
    await check('Real PDF.js canvas paints expected slide colors and keyboard navigation', async () => {
      await mount(); const rgb = await page.getByTestId('slide-preview-canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]);
      assert.ok(rgb[0] > 180 && rgb[1] < 80); await page.keyboard.press('ArrowRight'); await rendered(1);
      await page.keyboard.press('End'); await rendered(3); await page.keyboard.press('Home'); await rendered(0);
    });
    await check('Fade, push, wipe, cover, uncover and split create actual Web Animations', async () => {
      for (const effect of ['fade', 'push', 'wipe', 'cover', 'uncover', 'split']) {
        const data = presentation(); data.slides[1].transition = { ...data.slides[1].transition, type: effect, durationMs: 700 };
        await mount(data); await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.getAnimations().length > 0); await page.screenshot({ path: path.join(out, `transition-${effect}.png`) }); await rendered(1);
        assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      }
    });
    await check('Hidden slides are skipped, endpoints disabled, notes name next visible slide', async () => {
      const data = presentation(); data.slides[0].hidden = true; data.slides[2].hidden = true;
      await mount(data, 1); assert.equal(await page.getByTestId('slide-preview-previous').isDisabled(), true);
      await page.getByRole('button', { name: '演讲备注', exact: true }).click();
      assert.match(await page.locator('.slide-speaker-notes').innerText(), /下一页：Title 4/);
      await page.keyboard.press('ArrowRight'); await rendered(3); assert.equal(await page.getByTestId('slide-preview-next').isDisabled(), true);
      await page.keyboard.press('Home'); await rendered(1);
    });
    await check('Automatic advance survives a resize that interrupts the incoming transition', async () => {
      const data = presentation(); data.slides[1].transition = { ...data.slides[1].transition, type: 'push', durationMs: 1600, advanceAfterMs: 350 };
      await mount(data); await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.getAnimations().length > 0);
      await page.getByRole('button', { name: '演讲备注', exact: true }).click(); await rendered(2);
    });
    await check('Rapid navigation cancels old slide drawing and transition after resize', async () => {
      const data = presentation(); for (const slide of data.slides) slide.transition = { ...slide.transition, type: 'push', durationMs: 1200 };
      await mount(data); await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.getAnimations().length > 0);
      await page.keyboard.press('End'); await page.setViewportSize({ width: 1110, height: 760 }); await rendered(3);
      const color = await page.getByTestId('slide-preview-canvas').evaluate(c => [...c.getContext('2d').getImageData(10, 10, 1, 1).data]); assert.ok(color[0] > 150 && color[1] > 80 && color[2] < 60);
    });
    await check('B/W blackout, notes clock and laser pointer are visible and reversible', async () => {
      await mount(); await page.keyboard.press('b'); assert.equal(await page.locator('.slide-blank.black').count(), 1); await page.keyboard.press('b'); assert.equal(await page.locator('.slide-blank').count(), 0);
      await page.keyboard.press('w'); await page.locator('.slide-blank.white').click(); assert.equal(await page.locator('.slide-blank').count(), 0);
      await page.getByRole('button', { name: '演讲备注', exact: true }).click(); assert.match(await page.locator('.slide-speaker-notes').innerText(), /Speaker notes 1/);
      await page.waitForFunction(() => /00:0[1-9]/.test(document.querySelector('.slide-speaker-notes')?.textContent || ''));
      await page.getByRole('button', { name: '激光笔', exact: true }).click(); await page.mouse.move(400, 300); assert.equal(await page.locator('.slide-laser').count(), 1);
      await page.screenshot({ path: path.join(out, 'notes-and-laser.png') });
    });
    await check('Local WAV and WebM decode and play from a real user gesture; close pauses and revokes URLs', async () => {
      for (const kind of ['audio', 'video']) {
        await attachMedia(0, kind);
        await page.evaluate(async ({ data, pdf64 }) => { data.slides[0].media = [window.fixtureMedia]; await window.qa.mount({ base64: pdf64, presentation: data, name: 'Media test' }); }, { data: presentation(), pdf64 }); await rendered(0);
        const media = page.locator(kind); await media.waitFor(); await page.waitForFunction(kind => document.querySelector(kind)?.readyState >= 2, kind);
        await page.evaluate(kind => { const button = document.createElement('button'); button.id = 'gesture-play'; button.textContent = 'Play media'; button.style = 'position:fixed;z-index:11000;top:90px;left:10px'; button.onclick = () => document.querySelector(kind).play(); document.body.appendChild(button); }, kind);
        await page.locator('#gesture-play').click(); await page.waitForFunction(kind => document.querySelector(kind)?.currentTime > .15 && !document.querySelector(kind)?.paused, kind);
        await page.evaluate(kind => { window.lastMedia = document.querySelector(kind); window.lastMediaUrl = window.lastMedia.src; document.querySelector('#gesture-play').remove(); }, kind);
        await page.getByTestId('slide-preview-close').click(); await page.getByTestId('slide-preview').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.lastMedia.paused), true); assert.equal(await page.evaluate(() => window.qa.revoked.includes(window.lastMediaUrl)), true);
      }
    });
    await check('Media auto-start delay survives resizing and stops when leaving slide', async () => {
      await attachMedia(1, 'audio', 'auto', 700);
      await page.evaluate(async ({ data, pdf64 }) => { data.slides[1].media = [window.fixtureMedia]; data.slides[1].transition = { ...data.slides[1].transition, type: 'fade', durationMs: 1000 }; await window.qa.mount({ base64: pdf64, presentation: data, name: 'Delayed media' }); }, { data: presentation(), pdf64 }); await rendered(0);
      await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => document.getAnimations().length > 0); await page.setViewportSize({ width: 1200, height: 780 });
      await rendered(1); await page.waitForFunction(() => document.querySelector('audio')?.currentTime > .1 && !document.querySelector('audio')?.paused);
      await page.evaluate(() => { window.lastMedia = document.querySelector('audio'); }); await page.keyboard.press('ArrowRight'); await rendered(2); assert.equal(await page.evaluate(() => window.lastMedia.paused), true);
    });
    await check('Escape closes player, cancels timers, and restores prior focus', async () => {
      const data = presentation(); data.slides[0].transition.advanceAfterMs = 2000; await mount(data); await page.keyboard.press('Escape'); await page.getByTestId('slide-preview').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'prior-focus'); await page.waitForTimeout(2100); assert.equal(await page.getByTestId('slide-preview').count(), 0);
    });
    await check('All-hidden presentations fail safely without uncaught navigation errors', async () => {
      const before = report.pageErrors.length, data = presentation(); data.slides.forEach(slide => { slide.hidden = true; });
      await page.evaluate(async args => window.qa.mount(args), { base64: pdf64, name: 'All hidden', presentation: data }); await page.getByRole('alert').waitFor();
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('Home'); assert.equal(report.pageErrors.length, before); await page.keyboard.press('Escape');
    });
    await check('PresentationSession merge follows slide IDs through reorder, duplication and deletion', async () => {
      const result = await page.evaluate(async fixturePath => {
        const { PresentationSession, packages } = window.qa, bytes = new Uint8Array(await (await fetch(fixturePath + '/slides.pptx')).arrayBuffer());
        const state = { pages: [0, 1, 2, 3].map(index => ({ index, id: 'page-' + index })) }, session = new PresentationSession(); await session.open(bytes, state);
        await session.edit(bytes, state, 'page-0', { transition: { type: 'push', durationMs: 650, advanceAfterMs: 2300 } });
        const first = await session.merge(bytes, state); session.markSaved(session.revision); const saved = !session.dirty;
        session.duplicate('page-0', 'duplicate');
        const shuffled = { pages: [{ index: 0, id: 'page-2' }, { index: 1, id: 'duplicate' }, { index: 2, id: 'page-0' }, { index: 3, id: 'page-1' }] };
        const merged = await packages.parsePptxPackage(await session.merge(bytes, shuffled));
        await session.edit(await session.merge(bytes, shuffled), shuffled, 'duplicate', { transition: { type: 'fade', durationMs: 320 } });
        const independent = await packages.parsePptxPackage(await session.merge(bytes, shuffled));
        const dirty = session.dirty; session.markSaved(session.revision - 1); const staleRemainsDirty = session.dirty;
        const deleted = { pages: [{ index: 0, id: 'page-1' }, { index: 1, id: 'page-2' }, { index: 2, id: 'page-3' }, { index: 3, id: 'new' }] };
        const removed = await packages.parsePptxPackage(await session.merge(bytes, deleted));
        const reopen = new PresentationSession(); await reopen.open(first, state);
        return { saved, dirty, staleRemainsDirty, reopen: reopen.slide('page-0').transition.type, moved: merged.slides.map(slide => slide.transition.type), independent: independent.slides.map(slide => slide.transition.type), removed: removed.slides.map(slide => slide.transition.type) };
      }, fixturePath);
      assert.equal(result.saved, true); assert.equal(result.dirty, true); assert.equal(result.staleRemainsDirty, true); assert.equal(result.reopen, 'push');
      assert.deepEqual(result.moved, ['none', 'push', 'push', 'none']); assert.deepEqual(result.independent, ['none', 'fade', 'push', 'none']); assert.deepEqual(result.removed, ['none', 'none', 'none', 'none']);
    });
    await check('PresentationSession restores deleted media and effects after editing another page and undoing deletion', async () => {
      const restored = await page.evaluate(async fixturePath => {
        const {PresentationSession,packages}=window.qa;
        const bytes=new Uint8Array(await(await fetch(fixturePath+'/slides.pptx')).arrayBuffer()), deleted=new Uint8Array(await(await fetch(fixturePath+'/slides-minus-first.pptx')).arrayBuffer());
        const audio=new Uint8Array(await(await fetch(fixturePath+'/tone.wav')).arrayBuffer());
        const original=await packages.patchPptxPackage(bytes,{slides:[{slideIndex:0,transition:{type:'push',durationMs:650},addMedia:[{kind:'audio',name:'Restored narration.wav',mimeType:'audio/wav',data:audio,rect:{x:.1,y:.1,width:.3,height:.1},start:'auto',loop:true}]}]});
        const all={pages:[0,1,2,3].map(index=>({index,id:'page-'+index}))}, minus={pages:[1,2,3].map((old,index)=>({index,id:'page-'+old}))};
        const session=new PresentationSession();await session.open(original,all);
        await session.edit(await session.merge(deleted,minus),minus,'page-1',{transition:{type:'fade',durationMs:350}});
        const first=await packages.parsePptxPackage(await session.merge(bytes,all));const revision=session.revision;session.markSaved(revision);
        await session.edit(await session.merge(bytes,all),all,'page-1',{transition:{type:'wipe',direction:'u',durationMs:500}});
        session.markSaved(revision);
        const second=await packages.parsePptxPackage(await session.merge(bytes,all));
        return {first:first.slides.map(slide=>slide.transition.type),second:second.slides.map(slide=>slide.transition.type),count:second.slides[0].media.length,
          sameAudio:second.slides[0].media[0].data.every((value,index)=>value===audio[index]),audioBytes:second.slides[0].media[0].data.length,expectedBytes:audio.length,dirty:session.dirty};
      },fixturePath);
      assert.deepEqual(restored.first,['push','fade','none','none']);assert.deepEqual(restored.second,['push','wipe','none','none']);
      assert.equal(restored.count,1);assert.equal(restored.sameAudio,true);assert.equal(restored.audioBytes,restored.expectedBytes);assert.equal(restored.dirty,true);
    });
    await check('PresentationSession refuses history growth before committing edits and preserves click-only timing', async () => {
      const checked=await page.evaluate(async fixturePath=>{
        const {PresentationSession,PRESENTATION_HISTORY_LIMIT,packages}=window.qa;
        const bytes=new Uint8Array(await(await fetch(fixturePath+'/slides.pptx')).arrayBuffer()),deleted=new Uint8Array(await(await fetch(fixturePath+'/slides-minus-first.pptx')).arrayBuffer());
        const audio=new Uint8Array(await(await fetch(fixturePath+'/tone.wav')).arrayBuffer());
        const all={pages:[0,1,2,3].map(index=>({index,id:'page-'+index}))},minus={pages:[1,2,3].map((old,index)=>({index,id:'page-'+old}))};
        // A small valid ZIP view can retain a large backing allocation. Account
        // for that allocation too, without creating a 128 MiB document fixture.
        const backing=new Uint8Array(PRESENTATION_HISTORY_LIMIT-8192);backing.set(bytes);const view=backing.subarray(0,bytes.length);
        const history=new PresentationSession();await history.open(view,all);const before=history.data;let failure='';
        try {await history.edit(deleted,minus,'page-1',{addMedia:[{kind:'audio',name:'Too much retained history.wav',mimeType:'audio/wav',data:audio,rect:{x:.1,y:.1,width:.3,height:.1},start:'click'}]})}catch(error){failure=error.message}
        const unchanged=history.data===before&&history.revision===0&&!history.dirty&&history.slide('page-0')!==null&&history.slide('page-1').media.length===0;
        const clicks=await packages.patchPptxPackage(bytes,{slides:[{slideIndex:0,transition:{type:'none',advanceOnClick:false}}]});
        const session=new PresentationSession();await session.open(clicks,all);const after=await packages.parsePptxPackage(await session.merge(bytes,all));
        const effects=await packages.patchPptxPackage(bytes,{slides:[{slideIndex:0,transition:{type:'fade',durationMs:500}}]});
        const removed=new PresentationSession();await removed.open(effects,all);await removed.edit(effects,all,'page-0',{transition:{type:'none'}});removed.markSaved(removed.revision);
        const patched=await removed.merge(bytes,all),reopened=new PresentationSession();await reopened.open(patched,all);
        return {failure,unchanged,hasLiveFeatures:session.hasLiveFeatures(all),advanceOnClick:after.slides[0].transition.advanceOnClick,
          clearedHasLiveFeatures:removed.hasLiveFeatures(all),clearedRequiresPptx:removed.requiresPptx(all),reopenedRequiresPptx:reopened.requiresPptx(all)};
      },fixturePath);
      assert.match(checked.failure,/128 MiB/);assert.equal(checked.unchanged,true);assert.equal(checked.hasLiveFeatures,true);assert.equal(checked.advanceOnClick,false);assert.equal(checked.clearedHasLiveFeatures,false);assert.equal(checked.clearedRequiresPptx,true);assert.equal(checked.reopenedRequiresPptx,false);
    });
    await check('PresentationSession preserves pure transition sound without claiming visual or audio playback support', async () => {
      const result=await page.evaluate(async fixturePath=>{
        const {PresentationSession,packages}=window.qa;
        const bytes=new Uint8Array(await(await fetch(fixturePath+'/slides-sound.pptx')).arrayBuffer()),raw=new Uint8Array(await(await fetch(fixturePath+'/slides.pptx')).arrayBuffer());
        const state={pages:[0,1,2,3].map(index=>({index,id:'page-'+index}))},session=new PresentationSession();await session.open(bytes,state);
        const saved=await session.merge(raw,state),after=await packages.parsePptxPackage(saved);
        return {type:after.slides[0].transition.type,metadata:after.slides[0].hasTransitionMetadata,requiresPptx:session.requiresPptx(state),warnings:after.slides[0].warnings,bytes:Array.from(saved)};
      },fixturePath);
      assert.equal(result.type,'none');assert.equal(result.metadata,true);assert.equal(result.requiresPptx,true);assert.ok(result.warnings.some(value=>value.includes('转场声音尚不')));
      const entries=unzipSync(Uint8Array.from(result.bytes)),xml=strFromU8(entries['ppt/slides/slide1.xml']);assert.ok(xml.includes('sndAc'));assert.ok(xml.includes('loop="1"'));
      const sounds=Object.entries(entries).filter(([name])=>name.endsWith('.wav'));assert.equal(sounds.length,1);assert.equal(Buffer.compare(Buffer.from(sounds[0][1]),wav),0);
    });
    await check('Merging stored effects preserves current UNO hide/show state', async () => {
      const visibility = await page.evaluate(async fixturePath => {
        const { PresentationSession, packages } = window.qa;
        const bytes = new Uint8Array(await (await fetch(fixturePath + '/slides.pptx')).arrayBuffer()), hidden = new Uint8Array(await (await fetch(fixturePath + '/slides-hidden.pptx')).arrayBuffer());
        const state = { pages: [0,1,2,3].map(index => ({ index, id:'page-'+index })) }, session = new PresentationSession();
        await session.open(bytes, state); await session.edit(bytes, state, 'page-0', {transition:{type:'fade',durationMs:300}});
        const mergedHidden = await session.merge(hidden, state), parsedHidden = await packages.parsePptxPackage(mergedHidden);
        const reopened = new PresentationSession(); await reopened.open(mergedHidden, state);
        const parsedShown = await packages.parsePptxPackage(await reopened.merge(bytes, state));
        return [parsedHidden.slides[0].hidden,parsedShown.slides[0].hidden];
      }, fixturePath);
      assert.deepEqual(visibility, [true,false]);
    });
    await check('Transition effect UI validates input and retains unapplied drafts when native page changes', async () => {
      const slides = presentation().slides;
      await page.evaluate(async slide => window.qa.mountEffects({slide,pageId:'page-0',enabled:true,busy:false}), slides[0]);
      await page.getByTestId('transition-type').selectOption('fade'); await page.getByLabel('时长（秒）').fill('999'); await page.getByTestId('transition-apply').click();
      assert.equal(await page.evaluate(() => window.qa.effectEdits.length),0); assert.match(await page.evaluate(() => window.qa.effectErrors.at(-1)),/0–10/);
      await page.getByLabel('时长（秒）').fill('1.3'); await page.getByLabel('自动换片',{exact:true}).check(); await page.getByLabel('停留（秒）').fill('4.5');
      await page.evaluate(async slide => window.qa.updateEffects({slide,pageId:'page-1'}), slides[1]);
      assert.equal(await page.getByTestId('transition-type').inputValue(),'fade'); assert.equal(await page.getByTestId('transition-apply').isDisabled(),true);
      await page.getByRole('button',{name:'还原',exact:true}).click(); assert.equal(await page.getByTestId('transition-type').inputValue(),'none');
      await page.getByTestId('transition-type').selectOption('split'); await page.getByTestId('transition-apply').click();
      const patch = await page.evaluate(() => window.qa.effectEdits.at(-1)); assert.equal(patch.transition.type,'split'); assert.equal(patch.transition.direction,'out'); assert.equal(patch.transition.orientation,'vert');
    });
    await check('Delayed media file read cannot insert into a newly selected slide', async () => {
      const slides = presentation().slides;
      await page.evaluate(async slide => {
        await window.qa.mountEffects({slide,pageId:'page-0',enabled:true,busy:false});
        window.originalFileRead=File.prototype.arrayBuffer;
        File.prototype.arrayBuffer=async function(){window.fileReadStarted=true;await new Promise(resolve=>window.releaseFileRead=resolve);return window.originalFileRead.call(this)};
      }, slides[0]);
      await page.getByTestId('presentation-media-input').setInputFiles(path.join(harness,'tone.wav')); await page.waitForFunction(()=>window.fileReadStarted);
      await page.evaluate(async slide => {await window.qa.updateEffects({slide,pageId:'page-1'});window.releaseFileRead()},slides[1]);
      await page.waitForFunction(()=>window.qa.effectErrors.length>0); assert.equal(await page.evaluate(()=>window.qa.effectEdits.length),0);
      assert.match(await page.evaluate(()=>window.qa.effectErrors.at(-1)),/页面已变化/);
      await page.evaluate(()=>{File.prototype.arrayBuffer=window.originalFileRead});
    });
    await check('Player has no horizontal page overflow at 800px desktop width', async () => {
      await page.setViewportSize({ width: 800, height: 700 }); await mount(); await page.getByRole('button', { name: '演讲备注', exact: true }).click(); await rendered(0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: path.join(out, 'compact-player.png') });
    });
  } catch (error) { report.failures.push({ name: 'test harness', error: String(error.stack || error) }); console.error(error); }
  finally { report.ok = !report.failures.length && !report.pageErrors.length; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); if (!report.ok) process.exitCode = 1; }
})();
