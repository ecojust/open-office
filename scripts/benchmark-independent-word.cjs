// Diagnostic microbenchmark: real editor modules, synthetic DOM input, no Vue shell.
// Run: node scripts/benchmark-independent-word.cjs
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results/word-performance-baseline.json');
const { chromium } = require('playwright');
(async () => {
 const {createServer} = await import('vite');
 const server = await createServer({configFile:false,root,cacheDir:path.join(root,'node_modules/.vite-word-performance'), optimizeDeps:{include:['fflate'],noDiscovery:true,entries:[]},server:{host:'127.0.0.1',port:0},plugins:[{name:'audit-page',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><style>body{font-family:sans-serif}#editor{width:600px;white-space:pre-wrap}p{margin:0 0 8px}</style><div id="editor" contenteditable="true"></div>')}else next()})}}]});
 let browser;
 try {
  await server.listen(); browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage(); await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
  const data=await page.evaluate(async()=>{
   const {createWordDocument,WordController,documentText}=await import('/src/word/core/model.ts');
   const {renderWordDom,readWordDom,restoreWordSelection,readWordSelection}=await import('/src/word/core/dom.ts');
   const {exportWordDocument,importWordDocument}=await import('/src/word/core/docx.ts');
   const root=document.querySelector('#editor');
   const summarize=xs=>{const v=[...xs].sort((a,b)=>a-b);return {medianMs:+v[Math.floor(v.length/2)].toFixed(2),p95Ms:+v[Math.min(v.length-1,Math.floor(v.length*.95))].toFixed(2)}};
   const result=[];
   for(const pcount of [10,100,1000,4000]){
    const m=createWordDocument();m.paragraphs=Array.from({length:pcount},(_,i)=>({id:'p'+i,style:{},runs:[{text:'测试中文abcdefghij0123456789 '.repeat(2),style:{}}]}));
    const c=new WordController(m), metrics={selection:[],cloneAndReadDom:[],commitModel:[],dirty:[],render:[],layout:[],uiCloneAndCount:[],total:[]};
    renderWordDom(root,c.model);root.offsetHeight;
    const index=Math.floor(pcount/2); let offset=0;
    for(let i=0;i<9;i++){
     const p=root.children[index],text=p.firstChild.firstChild;text.textContent='x'+text.textContent;offset++;
     const s={anchor:{paragraph:index,offset},focus:{paragraph:index,offset}};restoreWordSelection(root,s);
     let start=performance.now(),t=start;const mark=name=>{const next=performance.now();if(i>1)metrics[name].push(next-t);t=next};
     const selection=readWordSelection(root);mark('selection');
     const next=readWordDom(root,c.model);mark('cloneAndReadDom');
     c.setDocument(next,selection);mark('commitModel');
     c.dirty;mark('dirty');renderWordDom(root,c.model);restoreWordSelection(root,c.selection);mark('render');
     root.offsetHeight;mark('layout');const copy=c.model;Array.from(documentText(copy).replace(/\n/g,'')).length;mark('uiCloneAndCount');
     if(i>1)metrics.total.push(performance.now()-start);
    }
    const exports=[],imports=[];let bytes;
    for(let i=0;i<5;i++){let t=performance.now();bytes=exportWordDocument(c.model);if(i)exports.push(performance.now()-t);t=performance.now();importWordDocument(bytes);if(i)imports.push(performance.now()-t)}
    result.push({paragraphs:pcount,characters:documentText(c.model).length,zipBytes:bytes.length,inputPipeline:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,summarize(v)])),docxExport:summarize(exports),docxImport:summarize(imports)});
   }
   return {userAgent:navigator.userAgent,results:result};
  });
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output,JSON.stringify({capturedAt:new Date().toISOString(),method:'Chromium direct real TS modules; synthetic 50-char paragraphs; 7 measured keystroke-path iterations after 2 warmups; 4 measured codec iterations after 1 warmup; not a complete Vue editor or native Rust comparison.',...data},null,2));
  console.log(JSON.stringify(data,null,2));
 } finally {if(browser) await browser.close();await server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
