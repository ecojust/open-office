/* Actual Calc UNO operations + XLSX/ODS round trips. No installed Office or mock engine. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),publicRoot=path.join(root,'public'),out=path.join(root,'test-results/calc-completion');
fs.mkdirSync(out,{recursive:true});
const report={scope:'Real Calc WASM RPC, independently inspected XLSX and reopened XLSX/ODS',calcToolsSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(publicRoot,'office/calc-tools.js'))).digest('hex'),checks:[],errors:[]};let phase='startup',browser,page;
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
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>report.errors.push({phase,error:error.message}));await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>events.some(item=>item.event==='engine-ready'||item.event==='error'),null,{timeout:240000});assert.equal(await page.evaluate(()=>events.find(item=>item.event==='error')),undefined);
 const call=(action,data={},id='calc-document')=>page.evaluate(args=>window.request(args.action,args.data,args.id),{action,data,id});
 const act=async(data,id='calc-document')=>{phase=data.type;console.log('ACTION',data.type);return call('sheet-action',data,id)};
 const read=(range,id='calc-document')=>call('sheet-data',{type:'range',range},id);
 const waitFormulas=async(range,expected)=>{const end=Date.now()+15000;let data;do{data=await read(range);if(JSON.stringify(data.formulas)===JSON.stringify(expected))return;await page.waitForTimeout(150)}while(Date.now()<end);assert.deepEqual(data.formulas,expected)};

 await call('open',{id:'calc-document',name:'Completion.xlsx',kind:'sheet',extension:'xlsx',base64:'',discard:false});
 await act({type:'set-matrix',range:'A1:C4',cells:[[10,2,null],[20,3,null],[30,4,null],[40,5,null]]});
 await act({type:'set-cell',address:'C1',input:'=A1*$B$1+B$1+$A1'});
 await act({type:'format',range:'C1',numberFormat:'0.00',bold:true,backgroundColor:'#DCF0E3'});
 await act({type:'fill',range:'C1:C4',direction:'down'});
 const down=await read('C1:C4');report.down=down;assert.deepEqual(down.formulas,[['=A1*$B$1+B$1+$A1'],['=A2*$B$1+B$1+$A2'],['=A3*$B$1+B$1+$A3'],['=A4*$B$1+B$1+$A4']]);assert.deepEqual(down.values,[[32],[62],[92],[122]]);
 await call('undo');await waitFormulas('C2:C4',[[''],[''],['']]);await call('redo');await waitFormulas('C1:C4',down.formulas);ok('One native undo/redo restores the entire fill operation');
 await act({type:'select-range',range:'C4'});assert.equal((await call('sheet-state')).format.bold,true);ok('Native fill down preserves format and correctly translates relative, absolute and mixed references');
 await act({type:'set-cell',address:'E1',input:'=A1+$A$1+A$1+$A1'});await act({type:'fill',range:'E1:G1',direction:'right'});const right=await read('E1:G1');report.right=right;assert.deepEqual(right.formulas,[['=A1+$A$1+A$1+$A1','=B1+$A$1+B$1+$A1','=C1+$A$1+C$1+$A1']]);ok('Native fill right shifts columns without changing absolute references');
 await act({type:'patch-cells',cells:[{address:'I1',kind:'text',value:'001'},{address:'I2',kind:'formula',value:'=1/0'},{address:'I3',kind:'formula',value:'=""'},{address:'I4',kind:'number',value:0}]});
 await act({type:'set-matrix',range:'Q1:Q3',cells:[[10],[20],[30]]});await act({type:'filter',range:'Q1:Q3',column:0,operator:'greater',value:10,header:false});const visible=await call('sheet-data',{type:'summary',range:'Q1:Q3'}),all=await call('sheet-data',{type:'summary',range:'Q1:Q3',includeHidden:true});assert.equal(visible.sum,50);assert.equal(visible.count,2);assert.equal(all.sum,60);await act({type:'clear-filter',range:'Q1:Q3'});ok('Summary excludes filtered rows by default and can include them explicitly');
 const before=await call('sheet-state'),summary=await call('sheet-data',{type:'summary',range:'I1:I5'});report.summary=summary;assert.equal(summary.count,4);assert.equal(summary.numericCount,1);assert.equal(summary.sum,0);assert.equal(summary.average,0);assert.equal(summary.errorCount,1);assert.equal((await call('sheet-state')).revision,before.revision);ok('Read-only summary distinguishes numeric text, errors, formula-empty strings and empty cells');
 await assert.rejects(act({type:'fill',range:'A1',direction:'down'}));
 await act({type:'set-cell',address:'L1',input:'keep'});await act({type:'merge',range:'L2:M2',merged:true});const mergedBefore=await read('L1:M3');await assert.rejects(act({type:'fill',range:'L1:M3',direction:'down'}),/合并/);assert.deepEqual((await read('L1:M3')).formulas,mergedBefore.formulas);ok('Merged ranges reject before any target cell changes');
 await act({type:'add-sheet',name:'带 空格'});await act({type:'set-cell',address:'A1',input:'7'});await act({type:'set-cell',address:'A2',input:'9'});await act({type:'select-sheet',sheetIndex:0});await act({type:'set-cell',address:'O1',input:`=SUM('带 空格'.A1;A1:A2)+IF("A1"="A1";0;1)`});await act({type:'fill',range:'O1:O2',direction:'down'});const cross=await read('O1:O2');report.cross=cross;assert.equal(cross.values[0][0],37);assert.equal(cross.values[1][0],59);assert.match(cross.formulas[1][0],/"A1"/);assert.match(cross.formulas[1][0],/A2:A3/);ok('Cross-sheet names, range references and text literals survive native translation');
 await act({type:'validation',range:'K1:K3',kind:'whole',minimum:0,maximum:99,allowBlank:false});await act({type:'conditional-format',range:'K1:K3',operator:'greater',value:10,backgroundColor:'#FFCC00'});
 const exports={};for(const format of ['xlsx','ods']){exports[format]=await call('export',{format});fs.writeFileSync(path.join(out,'filled.'+format),Buffer.from(exports[format].base64,'base64'))}
 report.package=inspectXlsx(path.join(out,'filled.xlsx'));assert.equal(report.package.validations[0].type,'whole');assert.equal(report.package.conditions,1);
 const xml=JSON.parse(execFileSync('python3',['-c',`import json,zipfile,xml.etree.ElementTree as E,sys
s='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(sys.argv[1]) as z:
 t=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 print(json.dumps({c.get('r'):{'formula':c.findtext(s+'f'),'value':c.findtext(s+'v'),'style':c.get('s')} for c in t.findall('.//'+s+'c')}))`,path.join(out,'filled.xlsx')],{encoding:'utf8'}));report.xml=xml;assert.equal(xml.C4.formula,'A4*$B$1+B$1+$A4');assert.equal(xml.C4.value,'122');assert.equal(xml.C4.style,xml.C1.style);assert.equal(xml.G1.formula,'C1+$A$1+C$1+$A1');ok('Independent saved XLSX XML contains translated formulas, values and shared source formatting');
 for(const format of ['xlsx','ods']){const id='reopen-'+format;await call('open',{id,name:'filled.'+format,kind:'sheet',extension:format,base64:exports[format].base64,discard:true});assert.deepEqual((await read('C1:C4',id)).formulas,down.formulas);assert.deepEqual((await read('C1:C4',id)).values,down.values);assert.deepEqual((await read('E1:G1',id)).formulas,right.formulas);const rules=await call('sheet-data',{type:'rules',range:'K1:K3'},id);assert.equal(rules.validation.kind,'whole');assert.equal(rules.validation.formula2,'99');assert.equal(rules.conditions[0].formula1,'10');ok(format.toUpperCase()+' reopens with live copied formulas and existing rules')}
 execFileSync('python3',['-c',`from openpyxl import Workbook
from openpyxl.worksheet.formula import ArrayFormula
import sys
w=Workbook();s=w.active;s['A1']=ArrayFormula(ref='A1:A2',text='=ROW(A1:A2)');s['A3']='keep';w.save(sys.argv[1]);w=Workbook();s=w.active;s['A1']=1;s['A2']='keep';s.protection.sheet=True;w.save(sys.argv[2])`,path.join(out,'array-guard.xlsx'),path.join(out,'protected-guard.xlsx')]);
 for(const kind of ['array','protected']){const id='guard-'+kind;await call('open',{id,name:kind+'.xlsx',kind:'sheet',extension:'xlsx',base64:fs.readFileSync(path.join(out,kind+'-guard.xlsx')).toString('base64'),discard:true});const original=await read('A1:A3',id),state=await call('sheet-state',{},id);await assert.rejects(act({type:'fill',range:'A1:A3',direction:'down'},id),kind==='array'?/数组公式/:/保护/);assert.deepEqual((await read('A1:A3',id)).formulas,original.formulas);assert.equal((await call('sheet-state',{},id)).dirty,state.dirty);ok('Imported '+kind+' target refuses filling without partial writes')}
 const guardedId='guarded-writes';await call('open',{id:guardedId,name:'Guarded.xlsx',kind:'sheet',extension:'xlsx',base64:fs.readFileSync(path.join(out,'array-guard.xlsx')).toString('base64'),discard:true});
 const guardedBefore=await read('A1:C3',guardedId),guardedState=await call('sheet-state',{},guardedId);
 for(const operation of [
  {type:'set-cell',address:'A1',input:'99'},
  {type:'set-cell',address:'A2',input:'99'},
  {type:'patch-cells',cells:[{address:'A3',kind:'text',value:'must not change'},{address:'A2',kind:'number',value:99}]},
  {type:'set-matrix',range:'A2',cells:[[99]]},
  {type:'set-matrix',range:'A1:A3',cells:[[9],[8],['must not change']]},
  {type:'set-matrix',range:'A1:A2',cells:[['=9'],['=8']],formulas:true},
 ]){
  await assert.rejects(act(operation,guardedId),/数组公式/);
  const after=await read('A1:C3',guardedId),state=await call('sheet-state',{},guardedId);
  assert.deepEqual(after.formulas,guardedBefore.formulas);assert.deepEqual(after.values,guardedBefore.values);assert.equal(state.dirty,guardedState.dirty);assert.equal(state.selection.address,guardedState.selection.address);
  ok('Array guard atomically refuses '+operation.type+' '+(operation.address||operation.range||'ordinary-prefix plus array member'));
 }
 await act({type:'set-cell',address:'B1',input:'=SUM(A1:A2)'},guardedId);
 await act({type:'patch-cells',cells:[{address:'B2',kind:'number',value:9},{address:'C2',kind:'text',value:'001'}]},guardedId);
 await act({type:'set-matrix',range:'B3:C3',cells:[[12,13]]},guardedId);
 await act({type:'set-matrix',range:'D1:E1',cells:[['=SUM(A1:A2)','=SUM(B3:C3)']],formulas:true},guardedId);
 const guardedExpected=await read('A1:E3',guardedId);assert.deepEqual(guardedExpected.values,[[1,3,'',3,25],[2,9,'001','',''],['keep',12,13,'','']]);
 ok('All ordinary content entry paths still work beside an intact imported array');
 report.guardedWrites={before:guardedBefore,after:guardedExpected,exports:{}};
 for(const format of ['xlsx','ods']){const exported=await call('export',{format},guardedId);report.guardedWrites.exports[format]={revision:exported.revision};fs.writeFileSync(path.join(out,'guarded-writes.'+format),Buffer.from(exported.base64,'base64'))}
 const guardedXml=JSON.parse(execFileSync('python3',['-c',`import json,zipfile,xml.etree.ElementTree as E,sys
s='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(sys.argv[1]) as z:
 t=E.fromstring(z.read('xl/worksheets/sheet1.xml'));cells={c.get('r'):c for c in t.findall('.//'+s+'c')};f=cells['A1'].find(s+'f')
 print(json.dumps({'array':{'attributes':f.attrib,'formula':f.text},'A1':cells['A1'].findtext(s+'v'),'A2':cells['A2'].findtext(s+'v'),'B1':cells['B1'].findtext(s+'f')}))`,path.join(out,'guarded-writes.xlsx')],{encoding:'utf8'}));
 assert.equal(guardedXml.array.attributes.t,'array');assert.equal(guardedXml.array.attributes.ref,'A1:A2');assert.equal(guardedXml.array.formula,'ROW(A1:A2)');assert.equal(guardedXml.A1,'1');assert.equal(guardedXml.A2,'2');assert.equal(guardedXml.B1,'SUM(A1:A2)');report.guardedWrites.xml=guardedXml;
 ok('Independent XLSX inspection confirms the original array extent and both cached member values');
 for(const format of ['xlsx','ods']){const id='guarded-reopen-'+format;await call('open',{id,name:'guarded-writes.'+format,kind:'sheet',extension:format,base64:fs.readFileSync(path.join(out,'guarded-writes.'+format)).toString('base64'),discard:true});const reopened=await read('A1:E3',id);assert.deepEqual(reopened.formulas,guardedExpected.formulas);assert.deepEqual(reopened.values,guardedExpected.values);ok(format.toUpperCase()+' reopens with the intact array and every legitimate ordinary edit')}
 execFileSync('python3',['-c',`from openpyxl import Workbook
from openpyxl.worksheet.datavalidation import DataValidation
import sys
w=Workbook();s=w.active;s['A1']='keep';s['B2']=5;s['B3']=6;s['B4']='ok';s['H2']='apple';s['J1']='apple';s['J2']='pear'
for target,style,show in [('B2:B3','stop',True),('D2:D3','warning',True),('E2:E3','information',True),('F2:F3','stop',False)]:
 d=DataValidation(type='whole',operator='between',formula1=1,formula2=10,errorStyle=style,showErrorMessage=show);s.add_data_validation(d);d.add(target)
for target,kind,formula in [('B4','custom','LEN(B4)<5'),('H2','list','$J$1:$J$2')]:
 d=DataValidation(type=kind,formula1=formula,errorStyle='stop',showErrorMessage=True);s.add_data_validation(d);d.add(target)
w.save(sys.argv[1])`,path.join(out,'validation-styles.xlsx')]);
 const validationId='validation-writes';await call('open',{id:validationId,name:'Validation.xlsx',kind:'sheet',extension:'xlsx',base64:fs.readFileSync(path.join(out,'validation-styles.xlsx')).toString('base64'),discard:true});
 const validationBefore=await read('A1:J4',validationId),validationState=await call('sheet-state',{},validationId);
 for(const operation of [
  {type:'set-cell',address:'B2',input:'5'},
  {type:'set-cell',address:'B3',input:'99'},
  {type:'set-cell',address:'B4',input:'custom rule must use native editor'},
  {type:'set-cell',address:'H2',input:'pear'},
  {type:'patch-cells',cells:[{address:'A1',kind:'text',value:'must not change'},{address:'B2',kind:'number',value:99}]},
  {type:'set-matrix',range:'A1:B2',cells:[[1,2],[3,99]]},
  {type:'set-matrix',range:'A1:B2',cells:[['=1','=2'],['=3','=99']],formulas:true},
 ]){
  await assert.rejects(act(operation,validationId),/数据验证规则.*画布/);const after=await read('A1:J4',validationId);
  assert.deepEqual(after.formulas,validationBefore.formulas);assert.deepEqual(after.values,validationBefore.values);assert.equal((await call('sheet-state',{},validationId)).dirty,validationState.dirty);
  ok('STOP validation redirects '+operation.type+' '+(operation.address||operation.range||'ordinary-prefix batch')+' without changing any cell');
 }
 await act({type:'set-cell',address:'D2',input:'99'},validationId);
 await act({type:'patch-cells',cells:[{address:'E2',kind:'number',value:-1}]},validationId);
 await act({type:'set-matrix',range:'F2',cells:[[42]]},validationId);
 const validationExpected=await read('A1:J4',validationId);assert.equal(validationExpected.values[1][3],99);assert.equal(validationExpected.values[1][4],-1);assert.equal(validationExpected.values[1][5],42);
 ok('Warning, information and disabled-error rules retain prior advisory editing behavior');
 for(const format of ['xlsx','ods']){const exported=await call('export',{format},validationId);fs.writeFileSync(path.join(out,'guarded-validation.'+format),Buffer.from(exported.base64,'base64'))}
 const validationXml=JSON.parse(execFileSync('python3',['-c',`import json,zipfile,xml.etree.ElementTree as E,sys
s='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(sys.argv[1]) as z:
 t=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 print(json.dumps([{'attributes':d.attrib,'formula1':d.findtext(s+'formula1'),'formula2':d.findtext(s+'formula2')} for d in t.findall('.//'+s+'dataValidation')]))`,path.join(out,'guarded-validation.xlsx')],{encoding:'utf8'}));
 assert.ok(validationXml.some(rule=>rule.attributes.type==='custom'&&rule.attributes.errorStyle==='stop'&&/LEN\(B4\)/.test(rule.formula1)));
 assert.ok(validationXml.some(rule=>rule.attributes.type==='list'&&rule.attributes.errorStyle==='stop'));
 assert.ok(validationXml.some(rule=>rule.attributes.errorStyle==='warning'));assert.ok(validationXml.some(rule=>rule.attributes.errorStyle==='information'));
 report.validationWrites={before:validationBefore,after:validationExpected,rules:validationXml};
 ok('Saved XLSX retains STOP custom/list rules and advisory error styles without rewriting their formulas');
 for(const format of ['xlsx','ods']){const id='validation-reopen-'+format;await call('open',{id,name:'guarded-validation.'+format,kind:'sheet',extension:format,base64:fs.readFileSync(path.join(out,'guarded-validation.'+format)).toString('base64'),discard:true});const before=await read('A1:J4',id);assert.deepEqual(before.values,validationExpected.values);await assert.rejects(act({type:'patch-cells',cells:[{address:'A1',kind:'text',value:'must not change'},{address:'B2',kind:'number',value:99}]},id),/数据验证规则.*画布/);assert.deepEqual((await read('A1:J4',id)).values,before.values);ok(format.toUpperCase()+' reopens with unchanged rule-bearing cells and still refuses STOP bypass')}
 assert.deepEqual(report.errors,[]);await page.screenshot({path:path.join(out,'calc-completion.png')});report.ok=true;
}catch(error){report.ok=false;report.phase=phase;report.error=String(error.stack||error);console.error(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}
finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(resolve=>server.close(resolve))}})();
