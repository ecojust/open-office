/* Real bundled WASM regression. Run after preparing the Office assets:
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/writer-workbench.cjs
 * No mocked editor, injected UNO implementation, or remote document service.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('playwright')
const { unzipSync, strFromU8, zipSync, strToU8 } = require('fflate')
const project = path.resolve(__dirname, '../..')
const publicRoot = path.join(project, 'public')
const output = path.join(project, process.env.WRITER_TARGET === 'completion' ? 'test-results/writer-completion' : 'test-results/writer-workbench')
fs.mkdirSync(output, { recursive: true })
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
<iframe id="office" src="office/host.html?smoke=1#session=writer-test"></iframe><script>
window.events=[];window.pending=new Map();window.seq=0;
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==office.contentWindow)return;const m=e.data;if(m.channel!=='open-office-engine'||m.session!=='writer-test')return;
if(m.requestId&&pending.has(m.requestId)){const p=pending.get(m.requestId);pending.delete(m.requestId);clearTimeout(p.timer);m.ok?p.resolve(m.data):p.reject(Error(m.error));}
else events.push(m);});
window.request=(action,data={},documentId='writer-document')=>new Promise((resolve,reject)=>{const requestId='test-'+(++seq);
const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timed out: '+action))},150000);pending.set(requestId,{resolve,reject,timer});
office.contentWindow.postMessage({channel:'open-office-engine',session:'writer-test',requestId,action,data,documentId},location.origin);});
</script>`
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/__native-smoke/')) { req.resume(); res.writeHead(204); return res.end() }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html) }
  const local = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname))
  if (!local.startsWith(publicRoot + path.sep) || !fs.existsSync(local) || !fs.statSync(local).isFile()) { res.writeHead(404); return res.end() }
  const mime = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' }[path.extname(local)] || 'application/octet-stream'
  if(process.env.WRITER_METADATA_DEBUG==='1'&&local.endsWith('/writer-tools.js')) {
    const diagnostic=fs.readFileSync(local,'utf8').replace('const basicStyle =', `console.log('WRITER_METADATA '+JSON.stringify({target,name,visited,unvisited,events})); const basicStyle =`)
    res.setHeader('Content-Type',mime);return res.end(diagnostic)
  }
  if(process.env.WRITER_UNDO_DEBUG==='1'&&local.endsWith('/writer-tools.js')) {
    const diagnostic=fs.readFileSync(local,'utf8').replace('function state() { const e = env(); return', `function state() { const e = env(); console.log('WRITER_UNDO '+JSON.stringify(optional(()=>{const u=e.model.getUndoManager();return {undo:u.isUndoPossible(),redo:u.isRedoPossible(),titles:u.getAllUndoActionTitles().slice(0,5),text:selection(e).text,link:read(e.view,'HyperLinkURL','')}}))); return`)
    res.setHeader('Content-Type',mime);return res.end(diagnostic)
  }
  if(process.env.WRITER_SIGNATURE_DEBUG==='1'&&local.endsWith('/writer-tools.js')) {
    const diagnostic=fs.readFileSync(local,'utf8').replace('return names.map((name, index) => [name, safeFormatValue(values[index])]);',"return names.map((name,index) => {try{return [name,safeFormatValue(values[index])]}catch(error){console.warn('CAS_PROPERTY',name);throw error}});")
      .replace('values = names.map(name => object.getPropertyValue(name));',"values = names.map(name => {try{return object.getPropertyValue(name)}catch(error){console.warn('CAS_PROPERTY_READ',name);throw error}});")
      .replace('} catch (error) { recover(error); return null; }','} catch (error) { console.warn("CAS_SIGNATURE_ERROR",String(error)); recover(error); return null; }')
    res.setHeader('Content-Type',mime);return res.end(diagnostic)
  }
  res.setHeader('Content-Type', mime); fs.createReadStream(local).pipe(res)
})
async function run() {
  const runStarted=Date.now()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  const errors = []
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    if(process.env.WRITER_SIGNATURE_DEBUG==='1')page.on('console',message=>{if(message.text().includes('CAS_'))console.log(message.text())})
    if(process.env.WRITER_UNDO_DEBUG==='1')page.on('console',message=>{if(message.text().startsWith('WRITER_UNDO '))console.log(message.text())})
    if(process.env.WRITER_METADATA_DEBUG==='1')page.on('console',message=>{if(message.text().startsWith('WRITER_METADATA '))console.log(message.text())})
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForFunction(() => events.some(e => e.event === 'engine-ready' || e.event === 'error'), {}, { timeout: 180000 })
    const startup = await page.evaluate(() => ({ isolated: crossOriginIsolated, failure: events.find(e => e.event === 'error') }))
    assert.equal(startup.isolated, true); assert.equal(startup.failure, undefined)
    await page.evaluate(() => request('open', { id: 'writer-document', name: 'Writer.docx', kind: 'word', extension: 'docx', base64: '', discard: false }))
    const call = (action, data = {}, id = 'writer-document') => page.evaluate(({ action, data, id }) => request(action, data, id), { action, data, id })
    const act = data => { console.log('ACTION', data.type); return call('word-action', data) }
    const inspectDocx = async (exported, label) => {
      const bytes=Buffer.from(exported.base64,'base64'),parts=unzipSync(bytes),xml=strFromU8(parts['word/document.xml'])
      fs.writeFileSync(path.join(output,label+'.docx'),bytes)
      const result=await page.evaluate(xml=>{
        const doc=new DOMParser().parseFromString(xml,'application/xml'),ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        const nodes=name=>Array.from(doc.getElementsByTagNameNS(ns,name)),content=node=>Array.from(node.getElementsByTagNameNS(ns,'t')).map(item=>item.textContent).join('')
        return {insertions:nodes('ins').map(content),deletions:nodes('del').map(node=>node.textContent),bodyText:nodes('t').map(node=>node.textContent).join('')}
      },xml)
      return {...result,hasPageField:Object.entries(parts).some(([name,data])=>/^word\/footer\d+\.xml$/.test(name)&&/\bPAGE\b/.test(strFromU8(data)))}
    }
    console.log('ENGINE_OPENED')
    const initial = await call('word-state')
    assert.equal(initial.dirty, false); assert.ok(initial.selection.id); assert.ok(initial.styles.length)
    if(process.env.WRITER_TARGET==='link-metadata') {
      const target=path.join(project,'test-results/writer-link-metadata');fs.mkdirSync(target,{recursive:true})
      const original=fs.readFileSync(path.join(project,'test-results/writer-completion/completion-formatted.odt'))
      await call('open',{id:'writer-document',name:'plain.odt',kind:'word',extension:'odt',base64:original.toString('base64'),discard:true})
      await act({type:'find-replace',search:'链接正文'});let state=await act({type:'set-hyperlink',url:'https://example.net/plain'});assert.equal(state.hyperlink.url,'https://example.net/plain')
      await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      const parts=unzipSync(original),changed=await page.evaluate(xml=>{const d=new DOMParser().parseFromString(xml,'application/xml'),a=d.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0','a')[0];a.setAttributeNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0','office:target-frame-name','_blank');a.setAttributeNS('urn:oasis:names:tc:opendocument:xmlns:office:1.0','office:name','KeepName');return new XMLSerializer().serializeToString(d)},strFromU8(parts['content.xml']))
      parts['content.xml']=strToU8(changed);const fixture=zipSync(parts,{level:0});fs.writeFileSync(path.join(target,'advanced-link.odt'),fixture)
      await call('open',{id:'writer-document',name:'advanced.odt',kind:'word',extension:'odt',base64:Buffer.from(fixture).toString('base64'),discard:true})
      await act({type:'find-replace',search:'链接正文'})
      const readLinks=async file=>page.evaluate(xml=>{const d=new DOMParser().parseFromString(xml,'application/xml');return Array.from(d.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0','a')).map(a=>({text:a.textContent,attributes:Array.from(a.attributes).map(v=>[v.namespaceURI,v.localName,v.value]).sort()}))},strFromU8(unzipSync(Buffer.from(file.base64,'base64'))['content.xml']))
      const beforeFile=await call('export',{format:'odt'}),before=await readLinks(beforeFile)
      assert.ok(before.some(link=>link.attributes.some(a=>a[1]==='target-frame-name'&&a[2]==='_blank')))
      await assert.rejects(act({type:'set-hyperlink',url:'https://example.net/must-not-overwrite'}),/普通链接|混合/)
      const afterFile=await call('export',{format:'odt'}),after=await readLinks(afterFile);assert.deepEqual(after,before)
      fs.writeFileSync(path.join(target,'after-rejected-edit.odt'),Buffer.from(afterFile.base64,'base64'))
      await act({type:'set-hyperlink',url:''});await call('undo');const restored=await readLinks(await call('export',{format:'odt'}));assert.deepEqual(restored,before)
      fs.writeFileSync(path.join(target,'report.json'),JSON.stringify({ok:true,checks:['Ordinary link edit and undo still work with strict metadata preflight','Advanced target/name link edit rejected without changing native ODT XML','Explicit removal undo restores target/name and the original link'],before,after,restored},null,2));console.log('Writer link metadata checks passed: 3');return
    }
    if(process.env.WRITER_TARGET==='link-undo') {
      const source=path.join(project,'test-results/writer-completion/completion-formatted.odt'),target=path.join(project,'test-results/writer-link-undo');fs.mkdirSync(target,{recursive:true})
      await call('open',{id:'writer-document',name:'link.odt',kind:'word',extension:'odt',base64:fs.readFileSync(source).toString('base64'),discard:true})
      const before=await act({type:'find-replace',search:'链接正文'});const removed=await act({type:'set-hyperlink',url:''});await call('undo')
      const undoExport=await call('export',{format:'docx'});fs.writeFileSync(path.join(target,'after-undo.docx'),Buffer.from(undoExport.base64,'base64'))
      const after=await act({type:'find-replace',search:'链接正文'});await page.waitForTimeout(500);const later=await call('word-state')
      fs.writeFileSync(path.join(target,'diagnostic.json'),JSON.stringify({before,removed,after,later},null,2));console.log('LINK_UNDO',JSON.stringify({before:before.hyperlink,after:after.hyperlink,later:later.hyperlink}));return
    }
    if(process.env.WRITER_TARGET==='completion') {
      const checks=[],guarded=async data=>{const current=await call('word-state');return act({...data,expectedRevision:current.revision,expectedSelectionId:current.selection.id})}
      await act({type:'insert-text',text:'Alpha Alpha Cat caterpillar CAT\n链接正文 高亮文字 删除文字 上标2 下标2 清除格式 保留正文'})
      let state=await act({type:'find-replace',search:'Alpha',matchCase:true,wholeWords:true})
      assert.equal(state.selection.text,'Alpha')
      state=await act({type:'find-replace',search:'Alpha',replace:'Beta',matchCase:true,wholeWords:true})
      const replaceProof=await inspectDocx(await call('export',{format:'docx'}),'completion-replace')
      assert.match(replaceProof.bodyText,/Beta Alpha/);checks.push('replace selected repeated match first')
      await act({type:'find-replace',search:'caterpillar',matchCase:true})
      await act({type:'find-replace',search:'cat',replace:'DOG',wholeWords:true})
      const wordProof=await inspectDocx(await call('export',{format:'docx'}),'completion-whole-word')
      assert.match(wordProof.bodyText,/Cat caterpillar DOG/);checks.push('Whole-word replacement skips a partial selected word and respects case-insensitive native matching')
      state=await act({type:'find-replace',search:'链接正文'})
      await act({type:'format-text',bold:true,fontSize:18,fontName:'Liberation Serif',color:'#2356A0'})
      state=await guarded({type:'set-hyperlink',url:'https://example.com/article?x=1&y=2'})
      assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2');assert.equal(state.textStyle.bold,true)
      await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'');assert.equal(state.textStyle.bold,true);assert.equal(state.textStyle.fontSize,18)
      await call('redo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      await act({type:'find-replace',search:'接正'});await guarded({type:'set-hyperlink',url:''})
      const partial=await call('export',{format:'docx'}),partialParts=unzipSync(Buffer.from(partial.base64,'base64'))
      fs.writeFileSync(path.join(output,'completion-partial-link.docx'),Buffer.from(partial.base64,'base64'))
      const remainingLinks=await page.evaluate(xml=>{const d=new DOMParser().parseFromString(xml,'application/xml');return Array.from(d.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main','hyperlink')).map(n=>n.textContent)},strFromU8(partialParts['word/document.xml']))
      assert.deepEqual(remainingLinks,['链','文'],'Removing the middle of a hyperlink must preserve both unselected linked sides')
      await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      checks.push('Partial link removal preserves both unselected linked sides and undo restores the complete link')
      await guarded({type:'set-hyperlink',url:'https://example.net/revised'});await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      await call('redo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.net/revised')
      await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      checks.push('Link insertion and address change each support one-step undo and redo')
      await assert.rejects(guarded({type:'set-hyperlink',url:'javascript:alert(1)'}),/仅支持/)
      const stale=await call('word-state')
      await act({type:'find-replace',search:'保留正文'})
      await assert.rejects(act({type:'set-hyperlink',url:'https://example.com/wrong',expectedRevision:stale.revision,expectedSelectionId:stale.selection.id}),/选区已改变|文档已变化/)
      checks.push('link attributes preserve text formatting; unsafe and stale writes rejected')
      for(const [search,format] of [['高亮文字',{highlight:'#FFF1A6'}],['删除文字',{strikethrough:true}],['上标2',{baseline:'superscript'}],['下标2',{baseline:'subscript'}],['清除格式',{strikethrough:true,baseline:'superscript',highlight:'#FFFF00'}]]) {
        await act({type:'find-replace',search});state=await act({type:'format-text',...format})
        for(const [key,value] of Object.entries(format))assert.equal(state.textStyle[key],value)
      }
      await call('undo');state=await act({type:'find-replace',search:'清除格式'});assert.equal(state.textStyle.strikethrough,false);assert.equal(state.textStyle.baseline,'normal');assert.equal(state.textStyle.highlight,null)
      await call('redo');state=await act({type:'find-replace',search:'清除格式'});assert.equal(state.textStyle.strikethrough,true);assert.equal(state.textStyle.baseline,'superscript');assert.equal(state.textStyle.highlight,'#FFFF00')
      checks.push('Character format group supports one-step native undo and redo')
      await act({type:'format-text',strikethrough:false,baseline:'normal',highlight:null})
      const saved=await call('export',{format:'docx'}),parts=unzipSync(Buffer.from(saved.base64,'base64'))
      fs.writeFileSync(path.join(output,'completion-formatted.docx'),Buffer.from(saved.base64,'base64'))
      const xmlProof=await page.evaluate(({xml,rels})=>{
        const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main',rns='http://schemas.openxmlformats.org/package/2006/relationships'
        const doc=new DOMParser().parseFromString(xml,'application/xml'),rel=new DOMParser().parseFromString(rels,'application/xml')
        const runs=Array.from(doc.getElementsByTagNameNS(ns,'r')).map(run=>({text:Array.from(run.getElementsByTagNameNS(ns,'t')).map(n=>n.textContent).join(''),properties:Array.from(run.getElementsByTagNameNS(ns,'rPr')).map(n=>new XMLSerializer().serializeToString(n)).join('')}))
        return {runs,links:Array.from(doc.getElementsByTagNameNS(ns,'hyperlink')).map(n=>n.textContent),targets:Array.from(rel.getElementsByTagNameNS(rns,'Relationship')).filter(n=>n.getAttribute('Type').endsWith('/hyperlink')).map(n=>({target:n.getAttribute('Target'),mode:n.getAttribute('TargetMode')}))}
      },{xml:strFromU8(parts['word/document.xml']),rels:strFromU8(parts['word/_rels/document.xml.rels'])})
      assert.ok(xmlProof.links.includes('链接正文'));assert.ok(xmlProof.targets.some(r=>r.target==='https://example.com/article?x=1&y=2'&&r.mode==='External'))
      assert.ok(xmlProof.runs.some(r=>r.text==='删除文字'&&/<w:strike/.test(r.properties)))
      assert.ok(xmlProof.runs.some(r=>r.text.startsWith('上标')&&/superscript/.test(r.properties)))
      assert.ok(xmlProof.runs.some(r=>r.text.startsWith('下标')&&/subscript/.test(r.properties)))
      assert.ok(xmlProof.runs.some(r=>r.text==='高亮文字'&&/FFF1A6/i.test(r.properties)))
      checks.push('DOCX hyperlink relationship and character run XML verified')
      const odt=await call('export',{format:'odt'});fs.writeFileSync(path.join(output,'completion-formatted.odt'),Buffer.from(odt.base64,'base64'))
      for(const [format,file] of [['docx',saved],['odt',odt]]) {
        await call('open',{id:'writer-document',name:'completion.'+format,kind:'word',extension:format,base64:file.base64,discard:true})
        state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2');assert.equal(state.textStyle.bold,true);assert.equal(state.textStyle.fontSize,18)
        for(const [search,expected] of [['高亮文字',{highlight:'#FFF1A6'}],['删除文字',{strikethrough:true}],['上标2',{baseline:'superscript',fontSize:12}],['下标2',{baseline:'subscript',fontSize:12}],['清除格式',{strikethrough:false,baseline:'normal',highlight:null}]]) {
          state=await act({type:'find-replace',search});for(const [key,value] of Object.entries(expected)) assert.equal(state.textStyle[key],value,format+' '+search+' '+key)
        }
        checks.push(format+' reopens with links, formatting and explicit resets')
      }
      await act({type:'find-replace',search:'链接正文'});state=await guarded({type:'set-hyperlink',url:''});assert.equal(state.hyperlink.url,'');assert.equal(state.textStyle.bold,true);assert.equal(state.textStyle.fontSize,18);assert.equal(state.textStyle.fontName,'Liberation Serif');assert.equal(state.textStyle.color,'#2356A0')
      await call('undo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'https://example.com/article?x=1&y=2')
      await call('redo');state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'')
      const removed=await call('export',{format:'docx'}),removedParts=unzipSync(Buffer.from(removed.base64,'base64'))
      fs.writeFileSync(path.join(output,'completion-link-removed.docx'),Buffer.from(removed.base64,'base64'))
      assert.ok(!strFromU8(removedParts['word/document.xml']).includes('<w:hyperlink'))
      await call('open',{id:'writer-document',name:'removed.docx',kind:'word',extension:'docx',base64:removed.base64,discard:true})
      state=await act({type:'find-replace',search:'链接正文'});assert.equal(state.hyperlink.url,'');assert.equal(state.selection.text,'链接正文');assert.equal(state.textStyle.bold,true);assert.equal(state.textStyle.fontSize,18);assert.equal(state.textStyle.fontName,'Liberation Serif');assert.equal(state.textStyle.color,'#2356A0')
      checks.push('explicit link removal supports undo/redo and DOCX reopen without losing text')
      await page.screenshot({path:path.join(output,'completion.png')})
      fs.writeFileSync(path.join(output,'completion-proof.json'),JSON.stringify({ok:true,checks,xmlProof,errors,totalMilliseconds:Date.now()-runStarted},null,2))
      assert.deepEqual(errors,[]);console.log('Writer completion native checks passed: '+checks.length);return
    }
    if(['table','cas'].includes(process.env.WRITER_TARGET)) {
      await act({type:'insert-text',text:'表格定位前的正文'})
      await act({type:'insert-break',kind:'paragraph'})
      let state=await act({type:'insert-table',rows:1,columns:2,cells:[['甲','乙']]})
      const name=state.tables[0].name
      if(process.env.WRITER_TARGET==='cas') {
        await act({type:'find-replace',search:'甲'})
        const formatted=await act({type:'format-paragraph',align:'right',leftIndent:4,firstLineIndent:2,lineSpacingPercent:150})
        assert.ok(Math.abs(formatted.paragraph.leftIndent-4)<0.03);assert.ok(Math.abs(formatted.paragraph.firstLineIndent-2)<0.03)
        const baseline=await call('word-data',{type:'table',name})
        console.log('CAS_BASELINE',JSON.stringify({tableId:baseline.tableId,cellSignatures:baseline.cellSignatures,revision:baseline.revision}))
        assert.ok(baseline.cellSignatures[0][0],'A real plain Writer cell must have a safe baseline')
        await act({type:'update-table',name,cells:[['甲','另一个单元格的新内容']]})
        state=await act({type:'update-table',name,cells:[['甲CAS','乙']],expectedRevision:baseline.revision,expectedTableId:baseline.tableId,expectedCells:baseline.cells,expectedCellSignatures:baseline.cellSignatures})
        assert.deepEqual((await call('word-data',{type:'table',name})).cells,[['甲CAS','另一个单元格的新内容']])
        state=await act({type:'find-replace',search:'甲CAS'})
        assert.equal(state.paragraph.align,'right');assert.equal(state.paragraph.leftIndent,formatted.paragraph.leftIndent);assert.equal(state.paragraph.firstLineIndent,formatted.paragraph.firstLineIndent);assert.equal(state.paragraph.lineSpacingPercent,150)
        const fresh=await call('word-data',{type:'table',name})
        await act({type:'find-replace',search:'甲CAS'});await act({type:'format-text',bold:true,fontSize:20})
        await assert.rejects(act({type:'update-table',name,cells:[['不可覆盖','另一个单元格的新内容']],expectedRevision:fresh.revision,expectedTableId:fresh.tableId,expectedCells:fresh.cells,expectedCellSignatures:fresh.cellSignatures}),/内容或格式已变化/)
        assert.deepEqual((await call('word-data',{type:'table',name})).cells,[['甲CAS','另一个单元格的新内容']])
        const saved=await call('export',{format:'docx'})
        await call('open',{id:'cas-readback',name:'cas.docx',kind:'word',extension:'docx',base64:saved.base64,discard:true})
        const readback=await call('word-action',{type:'find-replace',search:'甲CAS'},'cas-readback')
        assert.equal(readback.paragraph.align,'right');assert.equal(readback.paragraph.leftIndent,formatted.paragraph.leftIndent);assert.equal(readback.paragraph.firstLineIndent,formatted.paragraph.firstLineIndent);assert.equal(readback.paragraph.lineSpacingPercent,150)
        assert.equal(readback.textStyle.fontSize,20);assert.equal(readback.textStyle.bold,true)
        fs.writeFileSync(path.join(output,'cas-proof.json'),JSON.stringify({ok:true,baseline,after:state,readback,totalMilliseconds:Date.now()-runStarted},null,2))
        console.log('Writer CAS preserves unrelated edits and rejects changed-format conflicts');return
      }
      state=await act({type:'find-replace',search:'甲'});console.log('TABLE_SELECTION',JSON.stringify(state.selection),state.message)
      assert.equal(state.selection.text,'甲')
      await act({type:'format-text',fontSize:20,bold:true,color:'#8A2456'})
      await act({type:'update-table',name,cells:[['甲','丙']]})
      state=await act({type:'find-replace',search:'甲'});assert.equal(state.textStyle.fontSize,20);assert.equal(state.textStyle.color,'#8A2456')
      const exported=await call('export',{format:'docx'})
      await call('open',{id:'table-readback',name:'table.docx',kind:'word',extension:'docx',base64:exported.base64,discard:true})
      state=await call('word-action',{type:'find-replace',search:'甲'},'table-readback')
      assert.equal(state.selection.text,'甲');assert.equal(state.textStyle.fontSize,20);assert.equal(state.textStyle.color,'#8A2456')
      fs.writeFileSync(path.join(output,'table-proof.json'),JSON.stringify({ok:true,state,totalMilliseconds:Date.now()-runStarted},null,2))
      console.log('Table native selection and rich-text preservation passed');return
    }
    for (const data of [{type:'format-text',fontSize:0},{type:'insert-table',rows:0,columns:3},{type:'find-replace',search:''}]) await assert.rejects(act(data))
    assert.equal((await call('word-state')).dirty, false)
    await act({type:'insert-text',text:'Writer 工作区验证\n'})
    const heading = initial.styles.find(style => style.name === 'Heading 1')
    assert.ok(heading, 'Native Heading 1 paragraph style must exist')
    await act({type:'apply-style',name:heading.name})
    await act({type:'insert-text',text:'第一章 保存验证'})
    await act({type:'insert-break',kind:'paragraph'})
    const body = initial.styles.find(style => style.name === 'Text body') || initial.styles.find(style => style.name === 'Standard')
    assert.ok(body)
    await act({type:'apply-style',name:body.name})
    await act({type:'insert-text',text:'可编辑正文 Alpha Alpha.'})
    let state = await act({type:'find-replace',search:'可编辑正文'})
    assert.equal(state.selection.text,'可编辑正文')
    const selectedId=state.selection.id
    state=await act({type:'format-text',fontName:'Noto Sans CJK SC',fontSize:18,bold:true,italic:true,underline:true,color:'#2356A0',highlight:'#FFF1A6',expectedSelectionId:selectedId})
    assert.equal(state.textStyle.fontSize,18);assert.equal(state.textStyle.bold,true);assert.equal(state.textStyle.italic,true);assert.equal(state.textStyle.underline,true);assert.equal(state.textStyle.color,'#2356A0')
    state=await act({type:'format-paragraph',align:'center',leftIndent:6,firstLineIndent:3,spaceAbove:4,spaceBelow:5,lineSpacingPercent:150})
    assert.equal(state.paragraph.align,'center');assert.equal(state.paragraph.lineSpacingPercent,150)
    state=await act({type:'find-replace',search:'Alpha',replace:'Beta',all:true})
    assert.match(state.message,/2/)
    state=await act({type:'find-replace',search:'可编辑正文'})
    await act({type:'insert-comment',author:'Open Office 测试',text:'这是一条可保存的批注'})
    state=await call('word-state');assert.equal(state.review.comments.length,1);assert.equal(state.review.comments[0].text,'这是一条可保存的批注')
    state=await act({type:'navigate-comment',index:0});assert.equal(state.selection.text,'可编辑正文')
    await act({type:'insert-comment',author:'删除测试',text:'删除后正文不可丢失'})
    state=await call('word-state');assert.equal(state.review.comments.length,2)
    state=await act({type:'delete-comment',index:state.review.comments.find(item=>item.author==='删除测试').index})
    assert.equal(state.review.comments.length,1)
    state=await act({type:'find-replace',search:'可编辑正文'});assert.equal(state.selection.text,'可编辑正文')
    await act({type:'find-replace',search:'Beta'})
    await act({type:'insert-footnote',text:'脚注说明：独立内置办公内核'})
    state=await call('word-state');assert.equal(state.review.footnoteCount,1)
    await act({type:'set-track-changes',enabled:true,show:true})
    await act({type:'insert-text',text:' 未选前段修订新增文字未选后段 ',replaceSelection:false})
    state=await act({type:'set-track-changes',enabled:false})
    assert.equal(state.review.recordChanges,false);assert.ok(state.review.changeCount>0)
    const reviewProof=[]
    const trackedBefore=await inspectDocx(await call('export',{format:'docx'}),'tracked-before')
    assert.ok(trackedBefore.insertions.some(value=>value.includes('未选前段修订新增文字未选后段')))
    state=await act({type:'find-replace',search:'修订新增文字'})
    state=await act({type:'review-changes',decision:'accept',scope:'selection'})
    assert.ok(state.review.changeCount>0,'Accepting only the middle retains the surrounding unreviewed insertion')
    const partialAccepted=await inspectDocx(await call('export',{format:'docx'}),'tracked-partial-accepted')
    assert.match(partialAccepted.insertions.join(''),/未选前段/);assert.match(partialAccepted.insertions.join(''),/未选后段/)
    assert.ok(!partialAccepted.insertions.join('').includes('修订新增文字'));assert.match(partialAccepted.bodyText,/修订新增文字/)
    state=await act({type:'review-changes',decision:'reject',scope:'all'})
    assert.equal(state.review.changeCount,0)
    const remainingRejected=await inspectDocx(await call('export',{format:'docx'}),'tracked-remainder-rejected')
    assert.deepEqual(remainingRejected.insertions,[]);assert.deepEqual(remainingRejected.deletions,[])
    assert.match(remainingRejected.bodyText,/修订新增文字/);assert.ok(!remainingRejected.bodyText.includes('未选前段'));assert.ok(!remainingRejected.bodyText.includes('未选后段'))
    state=await act({type:'find-replace',search:'修订新增文字'});assert.equal(state.selection.text,'修订新增文字')
    reviewProof.push({decision:'accept',scope:'partial-selection',remainingAfterReject:state.review.changeCount,retained:state.selection.text})
    for(const [decision,scope,value] of [['reject','selection','拒绝当前修订'],['accept','all','接受全部修订'],['reject','all','拒绝全部修订']]) {
      await act({type:'set-track-changes',enabled:true})
      await act({type:'insert-text',text:value,replaceSelection:false})
      state=await act({type:'set-track-changes',enabled:false});assert.ok(state.review.changeCount>0)
      state=await act({type:'find-replace',search:value});assert.equal(state.selection.text,value)
      state=await act({type:'review-changes',decision,scope});assert.equal(state.review.changeCount,0)
      state=await act({type:'find-replace',search:value})
      if(decision==='accept')assert.equal(state.selection.text,value);else assert.match(state.message,/未找到/)
      reviewProof.push({decision,scope,remaining:state.review.changeCount,content:state.message})
    }
    for(const [decision,value] of [['accept','确认删除修订文字'],['reject','撤回删除修订文字']]) {
      await act({type:'insert-text',text:value,replaceSelection:false})
      state=await act({type:'find-replace',search:value});assert.equal(state.selection.text,value)
      await act({type:'set-track-changes',enabled:true})
      await act({type:'insert-text',text:'',replaceSelection:true})
      state=await act({type:'set-track-changes',enabled:false});assert.ok(state.review.changeCount>0)
      const before=await inspectDocx(await call('export',{format:'docx'}),'tracked-deletion-'+decision+'-before')
      assert.ok(before.deletions.some(text=>text.includes(value)),'Recorded deletion must be a real w:del element')
      state=await act({type:'review-changes',decision,scope:'all'});assert.equal(state.review.changeCount,0)
      const after=await inspectDocx(await call('export',{format:'docx'}),'tracked-deletion-'+decision+'-after')
      assert.deepEqual(after.deletions,[])
      assert.equal(after.bodyText.includes(value),decision==='reject','Reject restores deleted text; accept removes it')
      reviewProof.push({decision,scope:'all',kind:'deletion',remaining:state.review.changeCount,restored:after.bodyText.includes(value)})
    }
    await act({type:'set-track-changes',enabled:true})
    await act({type:'insert-text',text:' 保留待审阅修订 ',replaceSelection:false})
    state=await act({type:'set-track-changes',enabled:false});assert.ok(state.review.changeCount>0)
    await act({type:'set-page',width:210,height:297,landscape:true,marginLeft:22,marginRight:23,marginTop:18,marginBottom:19})
    await act({type:'set-header-footer',target:'header',enabled:true,text:'Open Office 页眉'})
    await act({type:'set-header-footer',target:'footer',enabled:true,text:'页码：'})
    state=await act({type:'insert-page-number',target:'footer',align:'center'})
    await assert.rejects(act({type:'set-header-footer',target:'footer',enabled:false}),/确认删除/)
    await act({type:'set-header-footer',target:'footer',enabled:true,text:state.page.footerText})
    assert.equal(state.page.landscape,true);assert.equal(state.page.width,297);assert.equal(state.page.marginLeft,22);assert.match(state.page.headerText,/Open Office/)
    await act({type:'insert-break',kind:'page'})
    state=await act({type:'insert-table',rows:2,columns:3,cells:[['A','B','C'],['1','2','3']]})
    assert.equal(state.tables.length,1)
    const tableName=state.tables[0].name
    assert.deepEqual((await call('word-data',{type:'table',name:tableName})).cells,[['A','B','C'],['1','2','3']])
    await act({type:'update-table',name:tableName,cells:[['甲','乙','丙'],['4','5','6']]})
    assert.deepEqual((await call('word-data',{type:'table',name:tableName})).cells,[['甲','乙','丙'],['4','5','6']])
    state=await act({type:'find-replace',search:'甲'});assert.equal(state.selection.text,'甲',JSON.stringify(state.selection)+' / '+state.message)
    await act({type:'format-text',bold:true,fontSize:20,color:'#8A2456'})
    await act({type:'update-table',name:tableName,cells:[['甲','乙','丙'],['4','五','6']]})
    state=await act({type:'find-replace',search:'甲'});assert.equal(state.textStyle.fontSize,20);assert.equal(state.textStyle.color,'#8A2456')
    state=await call('word-state');assert.ok(state.outline.some(item=>item.text.includes('第一章')))
    await act({type:'goto-outline',id:state.outline.find(item=>item.text.includes('第一章')).id})
    await act({type:'insert-toc',title:'文档目录',levels:3})
    state=await act({type:'update-indexes'});assert.equal(state.review.indexCount,1)
    const readStarted=Date.now(), readRevision=state.revision, readDirty=state.dirty
    for(let i=0;i<110;i++) {if(i%20===0)console.log('READ_STRESS',i);const read=await call('word-state');assert.ok(read.selection.id);assert.equal(read.review.indexCount,1);assert.equal(read.revision,readRevision);assert.equal(read.dirty,readDirty)}
    const readStressMs=Date.now()-readStarted;console.log('READ_STRESS_MS',readStressMs)
    const exported={}
    for(const format of ['docx','odt','pdf']) {console.log('EXPORT',format);exported[format]=await call('export',{format});fs.writeFileSync(path.join(output,'writer.'+format),Buffer.from(exported[format].base64,'base64'))}
    assert.equal((await inspectDocx(exported.docx,'writer-field-proof')).hasPageField,true,'Unchanged footer save must preserve a native PAGE field')
    const roundtrips={}
    for(const format of ['docx','odt']) {
      const id='writer-readback-'+format;console.log('REOPEN',format)
      await call('open',{id,name:'writer.'+format,kind:'word',extension:format,base64:exported[format].base64,discard:true})
      const read=await call('word-state',{},id)
      assert.equal(read.tables.length,1);assert.equal(read.page.landscape,true);assert.equal(read.page.marginLeft,22)
      assert.match(read.page.headerText,/Open Office/);assert.equal(read.review.footnoteCount,1);assert.equal(read.review.comments.length,1);assert.equal(read.review.indexCount,1)
      assert.ok(read.review.changeCount>0,'Unreviewed tracked changes must remain editable after import')
      assert.ok(read.outline.some(item=>item.text.includes('第一章')))
      const table=await call('word-data',{type:'table',name:read.tables[0].name},id)
      assert.deepEqual(table.cells,[['甲','乙','丙'],['4','五','6']])
      const rich=await call('word-action',{type:'find-replace',search:'甲'},id)
      assert.equal(rich.textStyle.fontSize,20);assert.equal(rich.textStyle.bold,true);assert.equal(rich.textStyle.color,'#8A2456')
      const found=await call('word-action',{type:'find-replace',search:'可编辑正文'},id)
      assert.equal(found.selection.text,'可编辑正文');assert.equal(found.textStyle.bold,true);assert.equal(found.textStyle.fontSize,18)
      roundtrips[format]={state:read,formattedSelection:found.textStyle,table}
    }
    await page.screenshot({path:path.join(output,'writer.png')});assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,scope:'Actual bundled LibreOffice WASM, not mocked UNO',totalMilliseconds:Date.now()-runStarted,initial,reviewProof,readStress:{count:110,milliseconds:readStressMs,revision:readRevision,dirty:readDirty},roundtrips,exports:Object.fromEntries(Object.entries(exported).map(([key,value])=>[key,{bytes:Buffer.from(value.base64,'base64').length}]))},null,2))
    console.log('Writer real-engine editing and DOCX/ODT editable round trips passed.')
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, message: error.message, errors }, null, 2))
    throw error
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
