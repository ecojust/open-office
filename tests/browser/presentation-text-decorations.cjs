const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), fixture = path.join(root, 'tests/compatibility/presentation-text-decorations');
const output = path.resolve(root, process.env.PRESENTATION_DECORATIONS_OUTPUT || 'test-results/presentation-text-decorations');
const url = process.env.PRESENTATION_URL || 'http://127.0.0.1:5199/';
fs.mkdirSync(output, { recursive: true });
(async () => {
 const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 const report = { ok: false, errors: [], external: [] };
 try {
  const page = await browser.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(url).origin) report.external.push(r.url()); });
  await page.goto(url);
  const result = await page.evaluate(async ({ base64, manifest }) => {
   const { importPresentation, exportPresentation } = await import('/src/presentation/core/pptx.ts');
   const { PresentationController } = await import('/src/presentation/core/model.ts');
   const { buildSlideScene } = await import('/src/presentation/core/scene.ts');
   const { slideSvg } = await import('/src/presentation/core/render.ts');
   const { exportPresentationPdf } = await import('/src/presentation/core/pdf.ts');
   const { unzipSync } = await import('/node_modules/fflate/esm/browser.js');
   const source = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), checks = [], artifacts = [];
   const check = (v, name) => { if (!v) throw Error(name); checks.push(name); }, eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
   const make = async bytes => new PresentationController(await importPresentation(bytes), 'decoration-test');
   const find = (c, name) => c.model.slides[0].objects.find(o => o.name === name);
   const values = o => o.richText.paragraphs.flatMap(p => p.runs.map(r => [r.style.underlineStyle || (r.style.underline ? 'single' : 'none'), r.style.strike || 'none', r.style.opacity ?? 1]));
   const save = c => exportPresentation(c.model), c = await make(source);
   const part = Object.keys(unzipSync(source)).find(n => /^ppt\/slides\/[^/]+\.xml$/.test(n));
   const attrs = bytes => [...new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(bytes)[part]), 'application/xml').querySelectorAll('*')].filter(n => ['rPr','defRPr','endParaRPr'].includes(n.localName)).map(n => [n.getAttribute('u'), n.getAttribute('strike')]).filter(([u,s])=>u!==null||s!==null);
   const flatten = (nodes, alpha=1) => nodes.flatMap(node => node.kind === 'group' ? flatten(node.children, alpha * (node.opacity ?? 1)) : [{node, alpha}]);
   const scene = buildSlideScene(c.model, c.model.slides[0]);
   for (const spec of manifest.items[0].objects) {
    const expected = [spec.expected[0] === 'unsupported' ? 'none' : spec.expected[0], spec.expected[1], spec.alpha ?? 1], o = find(c, spec.id);
    check(values(o).every(v => eq(v, expected)), spec.id + ': decoration inheritance and alpha');
    const rendered = flatten(scene.filter(n => n.id === o.id)), paths = rendered.filter(x => x.node.kind === 'path' && x.node.decoration), count = expected.slice(0,2).reduce((n,k) => n + (k === 'double' ? 2 : k === 'single' ? 1 : 0), 0);
    check(paths.length === count && paths.every(x => x.alpha === expected[2]), spec.id + ': exact rail count with independent alpha');
   }
   const noOp = await save(c);
   check(eq(attrs(noOp), attrs(source)), 'No-op preserves source underline and strike attributes, including unsupported styles');
   const originalSources = [...c.model.sourceParts].map(([k,v]) => [k,[...v]]);
   const both = find(c, 'both-double');
   c.action({type:'update-object',id:both.id,text:'HH',textStyle:{fontSize:30,bold:true,color:'#336699'}});
   const edited = await save(c);
   check(eq(attrs(edited), attrs(source)), 'Changing text, color and fonts never normalizes source double or unknown decoration attributes');
   check(eq(values(find(await make(edited), 'both-double')), [['double','double',1]]), 'Text and font changes reopen with both double decorations');
   c.undo(); c.action({type:'update-object',id:both.id,textStyle:{underline:true,strike:'single'}});
   check(eq(values(find(await make(await save(c)), 'both-double')), [['single','single',1]]), 'Legacy underline true explicitly changes double to single');
   c.undo(); c.action({type:'format-text-range',id:both.id,start:0,end:1,expectedText:find(c,'both-double').text,expectedRevision:c.revision,textStyle:{underlineStyle:'none',strike:'single',opacity:.4}});
   const range = await save(c), reopened = await make(range);
   check(eq(values(find(reopened,'both-double')), [['none','single',.4],['double','double',1]]), 'Range decoration edits preserve the unselected run and keep alpha local');
   c.undo(); check(eq(attrs(await save(c)), attrs(source)), 'Undo restores exact original decoration attributes'); c.redo(); check(eq(attrs(await save(c)),attrs(range)), 'Redo restores the same local decoration XML');
   const wavy = find(c, 'wavy-preserved'); c.action({type:'update-object',id:wavy.id,textStyle:{strike:'double'}});
   const unknown = await save(c); check(attrs(unknown).some(([u,s])=>u==='wavy'&&s==='dblStrike'), 'Editing strike alone retains unsupported wavy underline');
   check(originalSources.every(([k,v]) => eq(v,[...c.model.sourceParts.get(k)])), 'All original package parts remain immutable');
   const encode = b => {let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s);};
   const original = await make(source);
   for (const [name, bytes] of [['noop.pptx',noOp],['edited.pptx',edited],['range.pptx',range],['source.pdf',await exportPresentationPdf(original.model)],['edited.pdf',await exportPresentationPdf(c.model)]]) artifacts.push({name,base64:encode(bytes)});
   artifacts.push({name:'source.svg',text:slideSvg(original.model,original.model.slides[0])});
   return {checks, artifacts};
  }, {base64:fs.readFileSync(path.join(fixture,'ordinary-decorations.pptx')).toString('base64'),manifest:JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json'),'utf8'))});
  for(const artifact of result.artifacts)fs.writeFileSync(path.join(output,artifact.name),artifact.base64?Buffer.from(artifact.base64,'base64'):artifact.text);
  delete result.artifacts; Object.assign(report,result,{ok:!report.errors.length&&!report.external.length});assert.equal(report.ok,true);console.log(JSON.stringify({ok:true,checks:report.checks.length}));
 } catch(e) {report.error=e.stack;throw e;} finally {fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
