/* Actual Calc UNO operations + XLSX/ODS round trips. No installed Office or mock engine. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),publicRoot=path.join(root,'public'),out=path.resolve(process.env.CALC_MERGED_OUTPUT||path.join(root,'test-results/highlight-calc-followup'));
fs.mkdirSync(out,{recursive:true});
const report={scope:'Merged content guards: real Calc RPC, independent XLSX and ODS package audit, native reopen',calcToolsSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(publicRoot,'office/calc-tools.js'))).digest('hex'),checks:[],errors:[]};let phase='startup',browser,page;
const html=`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0}</style><iframe id="office" src="office/host.html?smoke=1#session=calc-test"></iframe><script>
window.events=[];window.pending=new Map();let seq=0;window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==office.contentWindow)return;const message=event.data;if(message.channel!=='open-office-engine'||message.session!=='calc-test')return;if(message.requestId&&pending.has(message.requestId)){const item=pending.get(message.requestId);pending.delete(message.requestId);clearTimeout(item.timer);message.ok?item.resolve(message.data):item.reject(Error(message.error))}else events.push(message)});
window.request=(action,data={},documentId='calc-document')=>new Promise((resolve,reject)=>{const requestId='calc-'+(++seq),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timed out: '+action))},120000);pending.set(requestId,{resolve,reject,timer});office.contentWindow.postMessage({channel:'open-office-engine',session:'calc-test',requestId,action,data,documentId},location.origin)});
</script>`;
const server=http.createServer((request,response)=>{response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');response.setHeader('Cross-Origin-Resource-Policy','same-origin');const url=new URL(request.url,'http://127.0.0.1');if(url.pathname.startsWith('/__native-smoke/')){request.resume();response.writeHead(204);return response.end()}if(url.pathname==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(html)}const filename=path.resolve(publicRoot,'.'+decodeURIComponent(url.pathname));if(!filename.startsWith(publicRoot+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()){response.writeHead(404);return response.end()}response.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm'})[path.extname(filename)]||'application/octet-stream');fs.createReadStream(filename).pipe(response)});
const ok=name=>{report.checks.push(name);console.log('PASS',name)};
function inspectXlsx(filename){return JSON.parse(execFileSync('python3',['-c',String.raw`
import zipfile,xml.etree.ElementTree as E,json,sys,posixpath
S='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(sys.argv[1]) as z:
 sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'));book=E.fromstring(z.read('xl/workbook.xml'))
 auto=sheet.find(S+'autoFilter');valid=sheet.find(S+'dataValidations');merges=sheet.find(S+'mergeCells');defined=book.find(S+'definedNames');pane=sheet.find('.//'+S+'pane');filters=[] if auto is None else [E.tostring(auto,encoding='unicode')]
 relfile='xl/worksheets/_rels/sheet1.xml.rels'
 if relfile in z.namelist():
  for rel in E.fromstring(z.read(relfile)):
   if rel.attrib.get('Type','').endswith('/table'):
    target=posixpath.normpath(posixpath.join('xl/worksheets',rel.attrib['Target']));table=E.fromstring(z.read(target));item=table.find(S+'autoFilter')
    if item is not None:filters.append(E.tostring(item,encoding='unicode'))
 print(json.dumps({'view':sheet.find('.//'+S+'sheetView').attrib,'autoFilter':'\n'.join(filters) or None,'hiddenRows':[r.attrib['r'] for r in sheet.findall('.//'+S+'row') if r.attrib.get('hidden') in ['1','true']],'conditions':len(sheet.findall(S+'conditionalFormatting')),'validations':[] if valid is None else [{'type':v.attrib.get('type'),'range':v.attrib.get('sqref'),'formula1':v.findtext(S+'formula1'),'formula2':v.findtext(S+'formula2')} for v in valid],'merges':[] if merges is None else [v.attrib.get('ref') for v in merges],'names':[] if defined is None else [{'name':v.attrib.get('name'),'value':v.text} for v in defined],'pane':None if pane is None else pane.attrib,'charts':[n for n in z.namelist() if n.startswith('xl/charts/chart') and n.endswith('.xml')],'pivots':[n for n in z.namelist() if n.startswith('xl/pivotTables/pivotTable') and n.endswith('.xml')],'sheets':[v.attrib for v in book.findall('.//'+S+'sheet')]}))
`,filename],{encoding:'utf8'}));}
(async()=>{try{
 execFileSync('python3',['-c',String.raw`
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill
from openpyxl.worksheet.formula import ArrayFormula
from openpyxl.worksheet.datavalidation import DataValidation
import sys
w=Workbook();s=w.active
s['A1']='keep';s['B2']='anchor';s.merge_cells('B2:C3');s['E2']='vertical';s.merge_cells('E2:E3');s['G2']='horizontal';s.merge_cells('G2:H2')
for cell in ['B2','E2','G2']:
 s[cell].font=Font(bold=True,color='C02020');s[cell].fill=PatternFill('solid',fgColor='DCEEDD')
s['J1']=ArrayFormula(ref='J1:J2',text='=ROW(J1:J2)');s['L2']=5
v=DataValidation(type='whole',operator='between',formula1=1,formula2=10,errorStyle='stop',showErrorMessage=True);s.add_data_validation(v);v.add('L2')
other=w.create_sheet('Other');other['A1']='other keep';other['B2']='other anchor';other.merge_cells('B2:C3')
w.save(sys.argv[1])
`,path.join(out,'guard-input.xlsx')]);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>report.errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/');
 await page.waitForFunction(()=>events.some(i=>i.event==='engine-ready'||i.event==='error'),null,{timeout:240000});assert.equal(await page.evaluate(()=>events.find(i=>i.event==='error')),undefined);
 const call=(action,data={},id='calc-document')=>page.evaluate(args=>window.request(args.action,args.data,args.id),{action,data,id});
 const act=(data,id='calc-document')=>{phase=data.type;return call('sheet-action',data,id)},read=(id='calc-document',sheetIndex=0)=>call('sheet-data',{type:'range',range:'A1:M4',sheetIndex},id);
 const open=(id,base64,format='xlsx')=>call('open',{id,name:id+'.'+format,kind:'sheet',extension:format,base64,discard:true});
 const source=fs.readFileSync(path.join(out,'guard-input.xlsx'));report.sourceSha256=require('node:crypto').createHash('sha256').update(source).digest('hex');await open('calc-document',source.toString('base64'));
 const before=await read(),initial=await call('sheet-state');report.before=before;
 for(const operation of [
  ...['C2','B3','C3','E3','H2'].map(address=>({type:'set-cell',address,input:'99'})),
  {type:'set-cell',address:'C3',input:''},
  {type:'patch-cells',cells:[{address:'A1',kind:'text',value:'bad prefix'},{address:'C3',kind:'number',value:99}]},
  {type:'set-matrix',range:'A1:C3',cells:[[1,2,3],[4,5,6],[7,8,9]]},
  {type:'set-matrix',range:'B2:C3',cells:[['=1','=2'],['=3','=4']],formulas:true},
  {type:'set-matrix',range:'B2:C3',cells:[['anchor',null],[null,'']]},
 ]){
  await assert.rejects(act(operation),/覆盖格.*左上角/);const current=await read(),state=await call('sheet-state');assert.deepEqual(current.values,before.values);assert.deepEqual(current.formulas,before.formulas);assert.equal(state.dirty,initial.dirty);assert.equal(state.selection.address,initial.selection.address);ok('Atomically rejects '+operation.type+' '+(operation.address||operation.range||'ordinary prefix plus covered cell'));
 }
 const secondary=await read('calc-document',1);
 await assert.rejects(act({type:'patch-cells',sheetIndex:1,cells:[{address:'A1',kind:'text',value:'bad other prefix'},{address:'C3',kind:'number',value:99}]}),/覆盖格/);assert.deepEqual((await read('calc-document',1)).values,secondary.values);assert.equal((await call('sheet-state')).activeSheetIndex,0);ok('Explicit inactive sheet inspection rejects covered writes without modifying or selecting either sheet');
 await act({type:'set-cell',address:'B2',input:'single anchor'});
 await act({type:'patch-cells',cells:[{address:'E2',kind:'number',value:7},{address:'A1',kind:'text',value:'valid prefix'}]});
 await act({type:'set-matrix',range:'G2',cells:[['=SUM(1;2)']],formulas:true});
 await act({type:'set-matrix',range:'A2:B2',cells:[[10,'matrix anchor']]});
 await act({type:'set-cell',address:'M1',input:'=SUM(E2;G2)'});
 const expected=await read();assert.equal(expected.values[1][1],'matrix anchor');assert.equal(expected.values[1][4],7);assert.equal(expected.values[1][6],3);assert.equal(expected.values[1][0],10);assert.equal(expected.values[0][12],10);
 for(const [c,r] of [[2,1],[1,2],[2,2],[4,2],[7,1]])assert.equal(expected.values[r][c],'');ok('Anchors work through scalar, sparse and matrix writes while covered cells stay empty');
 await act({type:'select-range',range:'B2'});assert.equal((await call('sheet-state')).format.bold,true);assert.equal((await call('sheet-state')).format.backgroundColor,'#DCEEDD');ok('Native anchor styling and merge remain after content edits');
 await act({type:'set-cell',sheetIndex:1,address:'B2',input:'other changed anchor'});assert.equal((await read('calc-document',1)).values[1][1],'other changed anchor');await act({type:'select-sheet',sheetIndex:0});
 for(const operation of [{type:'patch-cells',cells:[{address:'A1',kind:'text',value:'bad prefix'},{address:'J2',kind:'number',value:99}]},{type:'set-matrix',range:'L2',cells:[[99]]}]){await assert.rejects(act(operation),/数组公式|数据验证规则/);assert.deepEqual((await read()).values,expected.values)}
 ok('Existing array-member and STOP-validation batch guards remain effective beside merged cells');
 const exports={};for(const format of ['xlsx','ods']){exports[format]=await call('export',{format});fs.writeFileSync(path.join(out,'guarded-merges.'+format),Buffer.from(exports[format].base64,'base64'))}
 report.package=inspectXlsx(path.join(out,'guarded-merges.xlsx'));assert.deepEqual(report.package.merges,['B2:C3','E2:E3','G2:H2']);
 report.independent=JSON.parse(execFileSync('python3',['-c',String.raw`
from zipfile import ZipFile
import xml.etree.ElementTree as E,json,sys
S='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
T='{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
O='{urn:oasis:names:tc:opendocument:xmlns:office:1.0}'
with ZipFile(sys.argv[1]) as z:
 t=E.fromstring(z.read('xl/worksheets/sheet1.xml'));cells={c.get('r'):c for c in t.findall('.//'+S+'c')}
 for addr in ['C2','B3','C3','E3','H2']:
  c=cells.get(addr)
  assert c is None or not any(c.find(S+n) is not None for n in ['v','f','is']),addr
 f=cells['J1'].find(S+'f');assert f.get('t')=='array' and f.get('ref')=='J1:J2'
 assert cells['J1'].findtext(S+'v')=='1' and cells['J2'].findtext(S+'v')=='2'
 rules=t.findall('.//'+S+'dataValidation');assert any(v.get('sqref')=='L2' and v.get('errorStyle')=='stop' for v in rules)
 xlsx={'coveredCellsEmpty':True,'array':f.attrib,'rules':[v.attrib for v in rules]}
with ZipFile(sys.argv[2]) as z:
 t=E.fromstring(z.read('content.xml'));covered=t.findall('.//'+T+'covered-table-cell');assert sum(int(c.get(T+'number-columns-repeated','1')) for c in covered)==8
 for c in covered:
  assert c.get(O+'value') is None and c.get(O+'string-value') is None and not ''.join(c.itertext()).strip()
 anchors=[{k:v for k,v in c.attrib.items() if 'spanned' in k} for c in t.findall('.//'+T+'table-cell') if c.get(T+'number-columns-spanned') or c.get(T+'number-rows-spanned')]
 assert len(anchors)==4
 ods={'coveredElements':len(covered),'coveredCells':sum(int(c.get(T+'number-columns-repeated','1')) for c in covered),'coveredValuesEmpty':True,'anchors':anchors}
print(json.dumps({'xlsx':xlsx,'ods':ods}))
`,path.join(out,'guarded-merges.xlsx'),path.join(out,'guarded-merges.ods')],{encoding:'utf8'}));
 ok('Independent XLSX/ODS inspection confirms merge extents, empty covered cells, and retained array/STOP rules');
 report.after=expected;
 for(const format of ['xlsx','ods']){
  const id='reopen-'+format;await open(id,exports[format].base64,format);const reopened=await read(id);assert.deepEqual(reopened.values,expected.values);assert.deepEqual(reopened.formulas,expected.formulas);assert.equal((await read(id,1)).values[1][1],'other changed anchor');
  await assert.rejects(act({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'bad prefix'},{address:'C3',kind:'number',value:99}]},id),/覆盖格/);assert.deepEqual((await read(id)).values,expected.values);
  await act({type:'set-cell',address:'B2',input:format+' reopened anchor'},id);assert.equal((await read(id)).values[1][1],format+' reopened anchor');
  const final=await call('export',{format},id);fs.writeFileSync(path.join(out,'reopened-edited.'+format),Buffer.from(final.base64,'base64'));ok(format.toUpperCase()+' reopens with intact data, still rejects covered batches and allows a new anchor edit');
 }
 assert.deepEqual(report.errors,[]);await page.screenshot({path:path.join(out,'calc-merged-guards.png')});report.ok=true;
}catch(error){report.ok=false;report.phase=phase;report.error=String(error.stack||error);console.error(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}
finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(resolve=>server.close(resolve))}})();
