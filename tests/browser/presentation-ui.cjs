const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const out=path.resolve(process.env.PRESENTATION_QA_OUTPUT||path.join(root,'test-results/presentation-ui'));
const python=path.join(root,'pdf-backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
fs.mkdirSync(out,{recursive:true});
const report={scope:'Real full application, Chromium, bundled Impress, PDF.js and independent exported-file inspection',checks:[],errors:[]};
const ok=name=>{report.checks.push(name);console.log('PASS',name)};
function inspectOffice(file){return JSON.parse(execFileSync(python,['-c',String.raw`
import json,sys,zipfile,re,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
    if sys.argv[1].endswith('.pptx'):
        names=sorted(n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n))
        texts=[' '.join(n.text or '' for n in E.fromstring(z.read(name)).iter() if n.tag.endswith('}t')) for name in names]
        print(json.dumps({'pages':len(names),'texts':texts}))
    else:
        root=E.fromstring(z.read('content.xml'))
        slides=list(root.iter('{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}page'))
        print(json.dumps({'pages':len(slides),'texts':[' '.join(s.itertext()) for s in slides]}))
`,file],{encoding:'utf8'}));}
let browser,page;
async function idle(){await page.waitForFunction(()=>document.querySelector('.error-banner')||(document.querySelector('.office-frame')&&!document.querySelector('.office-frame.is-loading')&&!document.querySelector('.office-loading')&&!document.querySelector('.busy-overlay')),null,{timeout:240000});const error=page.locator('.error-banner');if(await error.count())throw Error(await error.innerText());await page.getByRole('button',{name:'保存',exact:true}).waitFor();}
async function download(name,button){const pending=page.waitForEvent('download');await button.click();await(await pending).saveAs(path.join(out,name));await idle();return path.join(out,name);}
async function open(file){console.log('OPEN',path.basename(file));await page.getByTestId('document-open-input').setInputFiles(file);await page.locator('.titlebar-context').filter({hasText:path.basename(file)}).waitFor();await idle();console.log('READY',path.basename(file));}
(async()=>{try{
browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(60000);page.on('pageerror',e=>{report.errors.push(e.message);console.error('PAGEERROR',e.message)});
await page.goto(process.env.PRESENTATION_QA_URL||'http://127.0.0.1:5198/');
assert.equal(await page.locator('.create-card').count(),4);
await page.screenshot({path:out+'/home-with-ppt.png'});
await page.locator('.create-card.presentation').click();await idle();
const blank=await download('new.pptx',page.getByRole('button',{name:'保存',exact:true}));assert.equal(inspectOffice(blank).pages,1);ok('New presentation opens real Impress and saves a one-slide PPTX');
await page.getByTestId('presentation-new-slide').click();await idle();
const added=await download('new-two-slides.pptx',page.getByRole('button',{name:'保存',exact:true}));assert.equal(inspectOffice(added).pages,2);ok('Chinese add-slide action changes the actual saved PPTX');
await open(path.join(__dirname,'fixtures/presentation.pptx'));
await page.waitForTimeout(1200);await page.screenshot({path:out+'/ppt-editor.png'});
await page.getByTestId('presentation-new-slide').click();await idle();
const edited=await download('edited.pptx',page.getByRole('button',{name:'保存',exact:true}));const parsed=inspectOffice(edited);assert.equal(parsed.pages,3);assert.ok(parsed.texts.join('\n').includes('成为下一步行动'));ok('Existing Chinese PPTX opens, gains a slide and saves its original text');
const odp=await download('edited.odp',page.getByTestId('presentation-export-alternate'));assert.equal(inspectOffice(odp).pages,3);assert.match(await page.locator('.titlebar-context').textContent(),/\.pptx$/);ok('ODP export is a real copy and preserves original PPTX tab');
await open(odp);assert.equal(await page.getByTestId('presentation-export-alternate').textContent(),'导出 PPTX');ok('Exported ODP reopens through the application');
const pdf=await download('edited.pdf',page.getByRole('button',{name:'导出 PDF',exact:true}));
const info=JSON.parse(execFileSync(python,['-c','import pymupdf,json,sys;d=pymupdf.open(sys.argv[1]);print(json.dumps({"pages":len(d),"text":"\\n".join(p.get_text() for p in d)}))',pdf],{encoding:'utf8'}));
assert.equal(info.pages,3);assert.ok(info.text.includes('成为下一步行动'));ok('PDF export independently contains all three slides and Chinese text');
await page.getByTestId('presentation-preview').click();await page.getByTestId('slide-preview').waitFor();
await page.getByTestId('slide-preview-canvas').waitFor();await page.getByTestId('slide-preview-page').filter({hasText:/1\s*\/\s*3/}).waitFor();
await page.getByTestId('slide-preview-next').click();await page.getByTestId('slide-preview-page').filter({hasText:/2\s*\/\s*3/}).waitFor();
await page.keyboard.press('Home');await page.getByTestId('slide-preview-page').filter({hasText:/1\s*\/\s*3/}).waitFor();
await page.waitForFunction(()=>document.querySelector('[data-testid="slide-preview"]')?.getAttribute('data-rendering')==='false'&&document.querySelector('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index')==='0');await page.screenshot({path:out+'/ppt-preview.png'});
await page.keyboard.press('Escape');await page.getByTestId('slide-preview').waitFor({state:'hidden'});ok('Static presentation preview navigates and Escape returns to editor');
await page.frameLocator('.office-frame').locator('canvas').first().click({position:{x:600,y:350}});await page.keyboard.press('F5');await page.getByTestId('slide-preview').waitFor();await page.getByTestId('slide-preview-close').click();await page.getByTestId('slide-preview').waitFor({state:'hidden'});
const reopened=await download('after-preview.pptx',page.getByTestId('presentation-export-alternate'));assert.equal(inspectOffice(reopened).pages,3);ok('F5 is safely intercepted and document still exports afterwards');
await open(reopened);ok('Final PPTX reopens after ODP and preview round trip');
assert.deepEqual(report.errors,[]);assert.equal(await page.locator('.error-banner').count(),0);report.ok=true;
}catch(e){report.ok=false;report.error=String(e.stack||e);console.error(e);if(page)await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}finally{fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));await browser?.close();}})();
