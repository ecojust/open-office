'use strict';

/* Compare independent inspect-output.py reports. This never consults the editor
 * state, rendered screenshots or raw part counts as proof of editable semantics.
 * Every output cycle should be compared against the original source, not merely
 * against its predecessor (which could already have lost a feature).
 */
const { isDeepStrictEqual } = require('node:util');
const families={docx:'word',odt:'word',rtf:'word',xlsx:'sheet',ods:'sheet',pptx:'presentation',odp:'presentation'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function validText(value){
  if(typeof value!=='string'||value.length>2_000_000)return false;
  for(let i=0;i<value.length;i++){
    const code=value.charCodeAt(i);
    if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false}
    else if(code>=0xdc00&&code<=0xdfff)return false;
  }
  return true;
}
function text(value){if(!validText(value))throw Error('Invalid inspected text');return value.normalize('NFC').replace(/\r\n?/g,'\n')}
// Only function-identifier tokens are case insensitive. Strings, quoted sheet
// names, structured references, spaces and absolute markers remain data.
function formula(value){
  const source=text(value).replace(/^=/,'');let output='',i=0;
  while(i<source.length){
    const char=source[i];
    if(char==='"'||char==="'"){
      const quote=char;output+=source[i++];
      while(i<source.length){const next=source[i++];output+=next;if(next===quote){if(source[i]===quote)output+=source[i++];else break}}
    }else if(char==='['){
      let depth=0;do{const next=source[i++];output+=next;if(next==='[')depth++;else if(next===']')depth--}while(i<source.length&&depth);
    }else if(/[A-Za-z_\\]/.test(char)){
      const start=i++;while(i<source.length&&/[A-Za-z0-9_.\\]/.test(source[i]))i++;
      const identifier=source.slice(start,i);output+=source[i]==='('?identifier.toUpperCase():identifier;
    }else output+=source[i++];
  }
  return output;
}
function semanticValue(value){return typeof value==='string'?text(value):value}
function sameValue(expected,actual){
  if(typeof expected!=='number'||typeof actual!=='number')return isDeepStrictEqual(expected,actual);
  if(!Number.isFinite(expected)||!Number.isFinite(actual))return false;
  if(Number.isInteger(expected)||Number.isInteger(actual))return expected===actual;
  // Measure the actual IEEE-754 distance instead of a broad relative epsilon.
  const buffer=new ArrayBuffer(8),view=new DataView(buffer),sign=1n<<63n;
  const ordered=value=>{view.setFloat64(0,value);const bits=view.getBigUint64(0);return bits&sign?(~bits&((1n<<64n)-1n)):bits|sign};
  const left=ordered(expected),right=ordered(actual),distance=left>right?left-right:right-left;
  return distance<=8n;
}
function decimalSerializationOnly(expected,actual){
  return typeof expected==='number'&&typeof actual==='number'&&Number.isFinite(expected)&&Number.isFinite(actual)
    &&!Number.isInteger(expected)&&!Number.isInteger(actual)
    &&(Number(expected.toPrecision(15))===actual||Number(actual.toPrecision(15))===expected);
}
const array=value=>Array.isArray(value)&&value.length<=30_000;
const stringArray=value=>array(value)&&value.every(validText);
const scalar=value=>value===null||typeof value==='boolean'||validText(value)||(typeof value==='number'&&Number.isFinite(value));
function nullableText(value){return value===null||validText(value)}
function verticalTopology(table){
  if(!array(table.rowGridBefore)||table.rowGridBefore.length!==table.rows.length||!table.rowGridBefore.every(integer))return null;
  const result=table.rows.map(row=>row.map(()=>null)),groups=[];let previous=new Map();
  for(const [r,row] of table.rows.entries()){
    let column=table.rowGridBefore[r];const next=new Map();
    for(const [c,cell] of row.entries()){
      const span=Number(cell.columnSpan),key=column+':'+span;
      if(cell.verticalMerge==='restart'){
        const group={startRow:r,endRow:r,startColumn:column,endColumn:column+span-1,members:[[r,c]]};groups.push(group);next.set(key,group);
      }else if(cell.verticalMerge==='continue'){
        const group=previous.get(key);if(!group)return {valid:false,rows:result};
        group.endRow=r;group.members.push([r,c]);next.set(key,group);
      }
      column+=span;
    }
    previous=next;
  }
  for(const group of groups)if(group.endRow>group.startRow)for(const [r,c] of group.members){
    const {members,...extent}=group;result[r][c]=extent;
  }
  return {valid:true,rows:result};
}
function address(value){
  const match=typeof value==='string'&&/^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  return !!match&&[...match[1]].reduce((sum,c)=>sum*26+c.charCodeAt(0)-64,0)<=16384&&Number(match[2])<=1048576;
}
function chartShape(chart){
  if(!object(chart))return false;
  if(chart.parsed===undefined)return true; // Older inspector: explicitly reviewed below.
  if(typeof chart.parsed!=='boolean'||!stringArray(chart.chartTypes)||!array(chart.series))return false;
  const data=value=>value===null||object(value)&&nullableText(value.formula)&&nullableText(value.literal)&&array(value.values)&&value.values.every(point=>object(point)&&nullableText(point.index)&&nullableText(point.value));
  return chart.series.every(series=>object(series)&&validText(series.chartType)&&nullableText(series.order)&&nullableText(series.index)&&['title','categories','values','xValues','yValues','bubbleSize'].every(key=>data(series[key])))
    &&(chart.externalData===null||object(chart.externalData));
}
function failure(code,path,detail,actual,expected){return {code,path,detail,ok:false,...(expected!==undefined?{expected}:{}),...(actual!==undefined?{actual}:{})}}

function validate(report,label){
  const issues=[];
  const demand=(ok,path,detail)=>{if(!ok)issues.push(failure('INVALID_INSPECTION_SHAPE',label+'.'+path,detail))};
  demand(object(report),'','Expected an inspection report object.');if(!object(report))return issues;
  demand(report.schemaVersion===1,'schemaVersion','Expected inspector schema version 1.');
  demand(['parsed','unsupported','rejected'].includes(report.inspection),'inspection','Unknown inspection status.');
  demand(typeof report.ok==='boolean','ok','Expected a boolean inspection result.');
  demand(validText(report.format),'format','Expected a format identifier.');
  demand(array(report.errors)&&report.errors.every(item=>object(item)&&validText(item.code)),'errors','Expected structured errors.');
  demand(array(report.warnings)&&report.warnings.every(item=>object(item)&&validText(item.code)),'warnings','Expected structured warnings.');
  if(report.inspection!=='parsed')return issues;
  demand(report.ok===true,'ok','A parsed inspection must report success.');
  demand(report.truncated===false,'truncated','A truncated or unspecified inspection is incomplete.');
  demand(object(report.file)&&integer(report.file.bytes)&&report.file.bytes>0&&typeof report.file.sha256==='string'&&/^[a-f0-9]{64}$/i.test(report.file.sha256),'file','Expected nonempty input with its SHA-256 digest.');
  demand(object(report.features)&&Object.values(report.features).every(value=>integer(value)),'features','Feature summaries must be finite nonnegative counts.');
  demand(object(report.coreText)&&report.coreText.truncated===false&&stringArray(report.coreText.strings),'coreText','Expected a complete array of Unicode text.');
  const family=families[report.format],sameOoxml=['docx','xlsx','pptx'].includes(report.format);
  if(family==='word'){
    const word=report.word;demand(object(word),'word','Missing Word semantics.');if(!object(word))return issues;
    demand(array(word.paragraphs)&&word.paragraphs.every(p=>object(p)&&validText(p.text)),'word.paragraphs','Invalid paragraph texts.');
    const collections=report.format==='rtf'?['headers','footers','comments','footnotes']:['headers','footers','comments','footnotes','endnotes','trackedChanges'];
    for(const key of collections){
      demand(array(word[key])&&word[key].every(item=>object(item)&&validText(item.text)&&(item.textWithoutFieldResults===undefined||validText(item.textWithoutFieldResults))&&(item.author===undefined||nullableText(item.author))&&(item.fields===undefined||stringArray(item.fields))&&(item.references===undefined||array(item.references)&&item.references.every(ref=>object(ref)&&integer(ref.sectionIndex)&&['default','even','first'].includes(ref.type)))),`word.${key}`,'Expected semantic text objects.');
    }
    if(report.format==='rtf'){
      demand(object(word.tables)&&integer(word.tables.rowControlCount)&&integer(word.tables.cellControlCount),'word.tables','Expected partial RTF table control counts.');
      demand(object(word.trackedChanges),'word.trackedChanges','Expected partial RTF revision controls.');
      return issues;
    }
    demand(array(word.tables),'word.tables','Expected editable tables.');
    for(const [i,table] of (array(word.tables)?word.tables:[]).entries()){
      demand(object(table)&&array(table.rows),`word.tables[${i}]`,'Expected table rows.');
      if(!object(table)||!array(table.rows))continue;
      demand(table.rowGridBefore===undefined||array(table.rowGridBefore)&&table.rowGridBefore.length===table.rows.length&&table.rowGridBefore.every(value=>integer(value)&&value<=16384),`word.tables[${i}].rowGridBefore`,'Invalid table row grid offsets.');
      for(const [j,row] of table.rows.entries())demand(array(row)&&row.every(cell=>sameOoxml?object(cell)&&validText(cell.text)&&(typeof cell.columnSpan==='string'||Number.isInteger(cell.columnSpan))&&/^[1-9]\d*$/.test(String(cell.columnSpan))&&Number(cell.columnSpan)<=16384&&[null,'restart','continue'].includes(cell.verticalMerge):validText(cell)),`word.tables[${i}].rows[${j}]`,'Invalid table cell text or merge semantics.');
    }
    if(sameOoxml){
      demand(stringArray(word.fields),'word.fields','Expected field instructions.');
      for(const key of ['headers','footers'])demand(array(word[key])&&word[key].every(item=>object(item)&&stringArray(item.fields)),`word.${key}.fields`,'Expected header/footer fields.');
      demand(array(word.trackedChanges)&&word.trackedChanges.every(item=>object(item)&&validText(item.kind)),'word.trackedChanges.kind','Missing revision kind.');
    }
  }else if(family==='sheet'){
    const book=report.spreadsheet;demand(object(book),'spreadsheet','Missing spreadsheet semantics.');if(!object(book))return issues;
    demand(array(book.sheets),'spreadsheet.sheets','Expected worksheet objects.');
    const names=new Set();
    for(const [i,sheet] of (array(book.sheets)?book.sheets:[]).entries()){
      const base=`spreadsheet.sheets[${i}]`;
      demand(object(sheet)&&validText(sheet.name)&&!names.has(text(sheet.name)),base+'.name','Worksheet names must be unique Unicode strings.');
      if(!object(sheet)||!validText(sheet.name))continue;names.add(text(sheet.name));
      demand(array(sheet.cells),base+'.cells','Expected an array of inspected cells.');
      const addresses=new Set();
      for(const [j,cell] of (array(sheet.cells)?sheet.cells:[]).entries()){
        const good=object(cell)&&address(cell.address)&&!addresses.has(cell.address);
        demand(good,base+`.cells[${j}].address`,'Invalid or duplicate cell address.');if(!object(cell))continue;
        addresses.add(cell.address);
        demand(['text','number','formula','boolean','error','date','time','empty'].includes(cell.type)&&scalar(cell.value)&&nullableText(cell.formula),base+`.cells[${j}]`,'Invalid cell type, value or formula.');
        if(cell.type==='text')demand(validText(cell.value),base+`.cells[${j}].value`,'A text cell must carry a string, not a coerced scalar.');
        if(cell.type==='number')demand(cell.value===null||typeof cell.value==='number'&&Number.isFinite(cell.value),base+`.cells[${j}].value`,'A numeric cell must contain a finite number.');
        if(cell.type==='boolean')demand(typeof cell.value==='boolean',base+`.cells[${j}].value`,'A boolean cell must carry a boolean.');
      }
      demand(stringArray(sheet.mergedRanges),base+'.mergedRanges','Expected merged range strings.');
      if(sameOoxml){
        demand(['visible','hidden','veryHidden'].includes(sheet.state),base+'.state','Missing worksheet visibility.');
        demand(array(sheet.dataValidations)&&sheet.dataValidations.every(item=>object(item)&&object(item.attributes)&&nullableText(item.formula1)&&nullableText(item.formula2)),base+'.dataValidations','Invalid validation rules.');
        demand(array(sheet.conditionalFormats)&&sheet.conditionalFormats.every(object),base+'.conditionalFormats','Invalid conditional-format targets.');
        demand(array(sheet.frozenPanes)&&sheet.frozenPanes.every(pane=>object(pane)&&['split','frozen','frozenSplit'].includes(pane.state??'split')&&['xSplit','ySplit'].every(key=>pane[key]===undefined||typeof pane[key]==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(pane[key])&&Number.isFinite(Number(pane[key])))),base+'.frozenPanes','Invalid frozen pane semantics.');
        if(sheet.charts!==undefined)demand(array(sheet.charts)&&sheet.charts.every(chartShape),base+'.charts','Invalid parsed chart semantics.');
        if(sheet.conditionalRules!==undefined)demand(array(sheet.conditionalRules)&&sheet.conditionalRules.every(group=>object(group)&&validText(group.sqref)&&array(group.rules)&&group.rules.every(rule=>object(rule)&&nullableText(rule.type)&&nullableText(rule.operator)&&nullableText(rule.priority)&&stringArray(rule.formulas)&&object(rule.attributes))),base+'.conditionalRules','Invalid conditional-format rule expressions.');
      }
    }
    demand(array(book.definedNames)&&book.definedNames.every(item=>object(item)&&validText(item.name)&&(!sameOoxml||nullableText(item.formula)&&nullableText(item.localSheetId))), 'spreadsheet.definedNames','Invalid defined names.');
  }else if(family==='presentation'){
    const deck=report.presentation;demand(object(deck),'presentation','Missing presentation semantics.');if(!object(deck))return issues;
    demand(array(deck.slides)&&integer(deck.slideCount)&&deck.slideCount===deck.slides.length,'presentation.slides','Slide count and records must agree.');
    for(const [i,slide] of (array(deck.slides)?deck.slides:[]).entries()){
      const base=`presentation.slides[${i}]`;demand(object(slide),base,'Expected a slide object.');if(!object(slide))continue;
      demand(slide.index===i,base+'.index','Slides must be in presentation order.');
      demand(stringArray(slide.texts),base+'.texts','Invalid slide Unicode text.');
      demand(array(slide.tables)&&slide.tables.every(table=>object(table)&&array(table.rows)&&table.rows.every(stringArray)),base+'.tables','Invalid editable slide table.');
      demand(array(slide.media)&&slide.media.every(media=>object(media)&&(media.sha256===undefined||media.sha256===null||typeof media.sha256==='string'&&/^[a-f0-9]{64}$/i.test(media.sha256))),base+'.media','Expected media references and valid optional hashes.');
      demand(array(slide.notes)&&slide.notes.every(note=>object(note)&&(sameOoxml?stringArray(note.texts):validText(note.text))),base+'.notes','Invalid notes text.');
      if(sameOoxml){
        demand(typeof slide.hidden==='boolean',base+'.hidden','Missing hidden-slide status.');
        demand(array(slide.charts)&&slide.charts.every(chartShape),base+'.charts','Expected editable chart references and valid parsed semantics.');
      }
    }
  }
  return issues;
}

function compareInspections(source,output,options={}){
  const checks=[],reviewItems=[];
  const check=(code,path,ok,expected,actual,detail)=>{checks.push({code,path,ok:!!ok,...(expected!==undefined?{expected}:{}),...(actual!==undefined?{actual}:{}),...(detail?{detail}:{})})};
  const review=(code,path,detail)=>{if(!reviewItems.some(item=>item.code===code&&item.path===path))reviewItems.push({code,path,detail})};
  const finish=()=>{const failures=checks.filter(item=>!item.ok);const status=failures.length?'fail':reviewItems.length?'review':'pass';return {schemaVersion:1,cycle:options?.cycle??null,status,ok:status==='pass',scope:'Compared independent semantic fields only; no proof of full layout, typography, unsupported objects or original-application interoperability.',checks,failures,reviewItems}};
  if(!object(options)||(options.cycle!==undefined&&(!Number.isInteger(options.cycle)||options.cycle<1||options.cycle>5))){checks.push(failure('INVALID_COMPARISON_OPTIONS','options','Expected an optional integer cycle from 1 through 5.'));return finish()}
  checks.push(...validate(source,'source'),...validate(output,'output'));if(checks.length)return finish();
  for(const [side,report] of [['source',source],['output',output]]){
    if(report.inspection==='unsupported')review('UNSUPPORTED_INSPECTION',side,`Independent ${report.format} semantics are unavailable; import success is not a preservation result.`);
    else if(report.inspection!=='parsed'||!report.ok||report.errors.length)check('INSPECTION_REJECTED',side,false,'parsed',report.inspection,'The independent parser rejected this file.');
    for(const warning of report.warnings||[])if(['INVALID_SHARED_STRING','INVALID_NUMBER','MISSING_RELATIONSHIP_TARGET','UNRESOLVED_REFERENCE','RELATIONSHIP_TYPE'].includes(warning.code))check('INCOMPLETE_REFERENCE_EVIDENCE',side,false,'resolved semantic references',warning.code);
  }
  if(source.inspection!=='parsed'||output.inspection!=='parsed'||checks.some(item=>!item.ok))return finish();
  const family=families[source.format];
  check('DOCUMENT_FAMILY','format',!!family&&family===families[output.format],family??source.format,families[output.format]??output.format);
  if(!family||family!==families[output.format])return finish();
  const same=source.format===output.format&&['docx','xlsx','pptx'].includes(source.format);
  if(!same)review('CROSS_FORMAT_REPRESENTATION','format','ODF, RTF and OOXML encode fields, rules, references and objects differently; unproven equivalence remains manual review.');
  if((source.features.embeddedObjects||0)>0||(output.features.embeddedObjects||0)>0){
    if(same)check('EMBEDDED_OBJECT_COUNT','features.embeddedObjects',(output.features.embeddedObjects||0)>=(source.features.embeddedObjects||0),source.features.embeddedObjects||0,output.features.embeddedObjects||0);
    review('EMBEDDED_OBJECT_CONTENT_UNINSPECTED','features.embeddedObjects','Embedded attachments are not recursively parsed or executed. Counts and byte digests cannot establish semantic preservation after an OLE/document conversion; embedded chart workbooks are reviewed separately as well.');
  }
  const equals=(code,path,a,b)=>check(code,path,isDeepStrictEqual(a,b),a,b);
  function textsPreserved(path,expected,actual){
    const target=actual.map(text).join('\n');let position=0;
    for(const [i,value] of expected.entries()){
      const content=text(value);if(!content)continue;
      const found=target.indexOf(content,position);
      check('TEXT_PRESERVED',path+`[${i}]`,found>=0,content,found>=0?content:null,'Source text must remain in order; spaces and absolute punctuation are not discarded.');
      if(found>=0)position=found+content.length;
    }
  }
  function textObjects(key,expected,actual){
    const used=new Set();
    const headerFooter=same&&['word.headers','word.footers'].includes(key);
    const objectText=item=>headerFooter&&validText(item.textWithoutFieldResults)?text(item.textWithoutFieldResults):text(item.text);
    const hasFields=(item,candidate)=>!headerFooter||!array(item.fields)||item.fields.every(field=>array(candidate.fields)&&candidate.fields.some(value=>text(value).trim()===text(field).trim()));
    const hasRoles=(item,candidate)=>!headerFooter||!array(item.references)||!item.references.length||array(candidate.references)&&item.references.every(ref=>candidate.references.some(other=>other.sectionIndex===ref.sectionIndex&&other.type===ref.type));
    for(const [i,item] of expected.entries()){
      if(['separator','continuationSeparator','continuationNotice'].includes(item.type))continue;
      const content=objectText(item);
      const candidates=actual.map((candidate,j)=>({candidate,j})).filter(({candidate,j})=>!used.has(j)&&objectText(candidate)===content&&hasRoles(item,candidate));
      // Match semantic fields and section roles first. An empty even-page
      // footer cannot shadow a default footer with a live PAGE field.
      const chosen=candidates.find(({candidate})=>hasFields(item,candidate))||candidates[0];
      const index=chosen?.j??-1;
      if(index<0&&headerFooter&&array(item.fields)&&item.fields.length&&(!validText(item.textWithoutFieldResults)||actual.some(candidate=>!validText(candidate.textWithoutFieldResults)))){
        review('FIELD_CACHE_TEXT_UNINSPECTED',key+`[${i}]`,'An older inspector mixed dynamic field display caches with constant text; re-inspect both packages before judging a page number or date change.');continue;
      }
      if(!same&&index<0&&actual.length){review('TEXT_OBJECT_REPRESENTATION',key+`[${i}]`,'This format includes field/citation/metadata text differently; an object exists but exact content correspondence is unproven.');continue}
      check('TEXT_OBJECT_PRESERVED',key+`[${i}]`,index>=0,content,index>=0?content:null);
      if(headerFooter&&array(item.references)&&item.references.length)check('HEADER_FOOTER_ROLES',key+`[${i}].references`,index>=0&&hasRoles(item,actual[index]),item.references,index>=0?actual[index].references:null);
      if(index<0)continue;used.add(index);
      if(same&&validText(item.author)&&item.author)equals('AUTHOR_PRESERVED',key+`[${i}].author`,text(item.author),actual[index].author==null?null:text(actual[index].author));
      if(same&&array(item.fields))for(const [j,field] of item.fields.entries())check('FIELD_PRESERVED',key+`[${i}].fields[${j}]`,array(actual[index].fields)&&actual[index].fields.some(value=>text(value).trim()===text(field).trim()),text(field).trim(),array(actual[index].fields)?actual[index].fields.map(value=>text(value).trim()):null);
    }
  }
  function tables(path,expected,actual,word=false){
    check('EDITABLE_TABLE_COUNT',path,actual.length>=expected.length,expected.length,actual.length);
    if(!same){if(expected.length)review('TABLE_REPRESENTATION',path,'Cross-format merged-cell and row/cell semantics need a dedicated mapping; table presence alone is not equivalence.');return}
    expected.forEach((table,i)=>{
      if(!actual[i])return;
      const topology=word?verticalTopology(table):null,otherTopology=word?verticalTopology(actual[i]):null;
      if(topology&&!topology.valid)check('TABLE_VERTICAL_TOPOLOGY',path+`[${i}]`,false,'valid source merge chains','orphan continuation');
      if(otherTopology&&!otherTopology.valid)check('TABLE_VERTICAL_TOPOLOGY',path+`[${i}]`,false,'valid output merge chains','orphan continuation');
      equals('TABLE_ROWS',path+`[${i}].rows`,table.rows.length,actual[i].rows.length);
      table.rows.forEach((row,j)=>{
        const other=actual[i].rows[j];if(!other)return;
        equals('TABLE_COLUMNS',path+`[${i}].rows[${j}]`,row.length,other.length);
        row.forEach((cell,k)=>{
          if(other[k]===undefined)return;
          const base=path+`[${i}].rows[${j}][${k}]`;
          equals('TABLE_CELL_TEXT',base,word?text(cell.text):text(cell),word?text(other[k].text):text(other[k]));
          if(word){
            equals('TABLE_COLUMN_SPAN',base+'.columnSpan',Number(cell.columnSpan),Number(other[k].columnSpan));
            if(topology?.valid&&otherTopology?.valid){
              const a=topology.rows[j][k],b=otherTopology.rows[j]?.[k];
              equals('TABLE_VERTICAL_MERGE',base+'.verticalMerge',a,b);
              if(cell.verticalMerge!==other[k].verticalMerge&&isDeepStrictEqual(a,b))review('TABLE_VERTICAL_REPRESENTATION',base+'.verticalMerge','The raw vMerge marker changed while the independently computed grid extent is unchanged (for example a one-row restart).');
            }else equals('TABLE_VERTICAL_MERGE',base+'.verticalMerge',cell.verticalMerge,other[k].verticalMerge);
          }
        });
      });
    });
  }
  function formulas(path,a,b){
    if(a===null){if(b!==null)review('FORMULA_REPRESENTATION_ADDED',path,'The exporter added an expression where the source has none; cached equality alone does not prove equivalent binding semantics.');return}
    if(b===null){check('FORMULA_LOST',path,false,a,b);return}
    if(!same){review('FORMULA_REPRESENTATION',path,'Original formulas are retained verbatim in both reports; namespaces, sheet syntax and separators are not rewritten into assumed equivalence.');return}
    equals('FORMULA_EXPRESSION',path,formula(a),formula(b));
  }
  function chartObjects(path,a,b,sourceCount=0,outputCount=0){
    if(!array(a)||!array(b)){
      if(sourceCount>0){check('EDITABLE_CHART_PRESENT',path,outputCount>0,sourceCount,outputCount,'Images do not substitute for editable chart parts.');review('CHART_SEMANTICS_UNAVAILABLE',path,'Chart part counts cannot prove data, series, chart kind or editable references.')}return;
    }
    check('EDITABLE_CHART_COUNT',path,b.length>=a.length,a.length,b.length);
    for(let i=0;i<a.length;i++){
      if(!b[i])continue;
      const sourceChart=a[i],outputChart=b[i],base=path+`[${i}]`;
      if(sourceChart.parsed===undefined||outputChart.parsed===undefined){review('CHART_SEMANTICS_UNAVAILABLE',base,'A relationship is not proof that chart series and linked editable data survived.');continue}
      check('CHART_PART_PARSED',base,sourceChart.parsed&&outputChart.parsed,true,{source:sourceChart.parsed,output:outputChart.parsed});
      if(!sourceChart.parsed||!outputChart.parsed)continue;
      if(!sourceChart.chartTypes.length||!sourceChart.series.length){review('CHART_TYPE_UNSUPPORTED',base,'The inspector did not describe an editable series for this chart type.');continue}
      equals('CHART_TYPES',base+'.chartTypes',sourceChart.chartTypes,outputChart.chartTypes);
      equals('CHART_SERIES_COUNT',base+'.series',sourceChart.series.length,outputChart.series.length);
      const order=items=>items.slice().sort((left,right)=>Number(left.order||0)-Number(right.order||0));
      order(sourceChart.series).forEach((series,j)=>{
        const next=order(outputChart.series)[j];if(!next)return;
        equals('CHART_SERIES_TYPE',base+`.series[${j}].type`,series.chartType,next.chartType);
        for(const key of ['title','categories','values','xValues','yValues','bubbleSize']){
          const data=series[key],other=next[key],p=base+`.series[${j}].${key}`;
          if(data===null){if(other!==null)review('CHART_DATA_REPRESENTATION',p,'The exporter added a chart-data representation not present in the source.');continue}
          check('CHART_DATA_PRESENT',p,other!==null,true,other!==null);if(other===null)continue;
          if(data.formula===null&&data.literal!==null&&other.literal===null&&other.values.length===1&&other.values[0].value!==null&&text(other.values[0].value)===text(data.literal)){
            check('CHART_LITERAL_VALUE',p,true,text(data.literal),text(other.values[0].value));
            review('CHART_LITERAL_REPRESENTATION',p,'A literal title became a cached/reference expression. Its displayed text survived, while its new binding representation requires review.');continue;
          }
          formulas(p+'.formula',data.formula,other.formula);
          const numeric=['values','xValues','yValues','bubbleSize'].includes(key);
          const point=value=>numeric&&value!==null&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):value===null?null:text(value);
          const values=items=>items.map(item=>({index:item.index,value:point(item.value)})).sort((left,right)=>Number(left.index||0)-Number(right.index||0));
          const expectedPoints=values(data.values),actualPoints=values(other.values);
          const sameShape=expectedPoints.length===actualPoints.length&&expectedPoints.every((value,index)=>value.index===actualPoints[index].index);
          const pointsEqual=sameShape&&expectedPoints.every((value,index)=>sameValue(value.value,actualPoints[index].value));
          const decimalRewrite=sameShape&&expectedPoints.every((value,index)=>sameValue(value.value,actualPoints[index].value)||decimalSerializationOnly(value.value,actualPoints[index].value));
          if(!pointsEqual&&decimalRewrite)review('NUMERIC_SERIALIZATION_REPRESENTATION',p+'.values','Non-integer cached chart values changed beyond eight IEEE-754 ULPs but exactly match a 15-significant-digit decimal rewrite. Original values are retained; equivalence remains review, not a pass.');
          else check('CHART_CACHED_POINTS',p+'.values',pointsEqual,expectedPoints,actualPoints);
          if(data.literal!==null)equals('CHART_LITERAL',p+'.literal',text(data.literal),other.literal===null?null:text(other.literal));
        }
      });
      if(sourceChart.externalData!==null){
        check('CHART_EDITABLE_WORKBOOK',base+'.externalData',object(outputChart.externalData)&&!!outputChart.externalData.part&&!!outputChart.externalData.sha256,true,!!outputChart.externalData?.part&&!!outputChart.externalData?.sha256);
        review('EMBEDDED_CHART_WORKBOOK_UNINSPECTED',base+'.externalData','Series formulas/caches and the embedded workbook presence are checked separately; full embedded workbook cell semantics are not inspected.');
      }
    }
  }

  if(family==='word'){
    const a=source.word,b=output.word;
    textsPreserved('word.paragraphs',a.paragraphs.map(p=>p.text),b.paragraphs.map(p=>p.text));
    if(Array.isArray(a.tables)&&Array.isArray(b.tables))tables('word.tables',a.tables,b.tables,true);
    else review('RTF_TABLE_STRUCTURE_PARTIAL','word.tables','RTF control counts cannot demonstrate merged editable table structure.');
    for(const key of ['headers','footers','comments','footnotes','endnotes']){
      if(array(a[key])&&array(b[key]))textObjects('word.'+key,a[key],b[key]);
      else review('TEXT_OBJECT_STRUCTURE_PARTIAL','word.'+key,'This format has no complete independent semantic mapping for the object.');
    }
    if(same){
      const used=new Set();
      a.trackedChanges.forEach((change,i)=>{
        const index=b.trackedChanges.findIndex((other,j)=>!used.has(j)&&other.kind===change.kind&&text(other.text)===text(change.text));
        check('TRACKED_CHANGE_PRESERVED',`word.trackedChanges[${i}]`,index>=0,{kind:change.kind,text:text(change.text)},index>=0?{kind:b.trackedChanges[index].kind,text:text(b.trackedChanges[index].text)}:null);
        if(index>=0){
          used.add(index);
          if(validText(change.author)&&change.author)equals('REVISION_AUTHOR',`word.trackedChanges[${i}].author`,text(change.author),b.trackedChanges[index].author==null?null:text(b.trackedChanges[index].author));
        }
        if(!['ins','del','moveFrom','moveTo'].includes(change.kind))review('REVISION_PROPERTIES_UNINSPECTED',`word.trackedChanges[${i}]`,'This revision changes properties that the current inspector does not fully describe.');
      });
      for(const [i,field] of a.fields.entries())check('FIELD_PRESERVED',`word.fields[${i}]`,b.fields.some(other=>text(other).trim()===text(field).trim()),text(field).trim(),b.fields.map(other=>text(other).trim()));
    }else if(!array(a.trackedChanges)||a.trackedChanges.length)review('REVISION_REPRESENTATION','word.trackedChanges','ODF/RTF revision anchors and accepted/deleted text require a dedicated mapping.');
  }else if(family==='sheet'){
    const a=source.spreadsheet,b=output.spreadsheet,actual=new Map(b.sheets.map(sheet=>[text(sheet.name),sheet]));
    const sourceNames=a.sheets.map(sheet=>text(sheet.name));
    equals('SHEET_ORDER','spreadsheet.sheets',sourceNames,b.sheets.map(sheet=>text(sheet.name)).filter(name=>sourceNames.includes(name)));
    for(const sheet of a.sheets){
      const other=actual.get(text(sheet.name)),base='spreadsheet.'+sheet.name;
      check('SHEET_PRESENT',base,!!other,sheet.name,other?.name??null);if(!other)continue;
      if(same)equals('SHEET_VISIBILITY',base+'.state',sheet.state,other.state);else review('SHEET_VISIBILITY_UNINSPECTED',base+'.state','ODF visibility is style-driven and has not been resolved by this inspector.');
      const cells=new Map(other.cells.map(cell=>[cell.address,cell]));
      for(const cell of sheet.cells){
        if(cell.type==='empty')continue;
        const next=cells.get(cell.address),path=base+'!'+cell.address;
        check('CELL_PRESENT',path,!!next,cell.type,next?.type??null);if(!next)continue;
        if(!same&&cell.type!==next.type&&[cell.type,next.type].some(kind=>['date','time'].includes(kind))){review('DATE_CELL_REPRESENTATION',path,'Excel serial dates and ODF typed date/time values require an epoch-aware conversion.');continue}
        equals('CELL_TYPE',path+'.type',cell.type,next.type);
        if(cell.type==='formula'){
          formulas(path+'.formula',cell.formula,next.formula);
          if(cell.formula===null)review('SHARED_FORMULA_UNEXPANDED',path+'.formula','An unexpanded shared formula cannot be validated by cache values alone.');
        }
        if(cell.value===null){review('SOURCE_CELL_VALUE_UNAVAILABLE',path+'.value','No source cached value is available to validate the recalculated output.');continue}
        const expected=semanticValue(cell.value),value=semanticValue(next.value);
        const matches=sameValue(expected,value);
        if(!matches&&decimalSerializationOnly(expected,value))review('NUMERIC_SERIALIZATION_REPRESENTATION',path+'.value','The non-integer cached value changed beyond eight IEEE-754 ULPs but exactly matches a 15-significant-digit decimal rewrite. It is not treated as equal or independently recalculated.');
        else check(cell.type==='formula'?'FORMULA_CACHED_VALUE':'CELL_VALUE',path+'.value',matches,expected,value,'This compares stored values, not an independent recalculation.');
      }
      for(const range of sheet.mergedRanges)check('MERGED_RANGE',base+'.mergedRanges',other.mergedRanges.includes(range),range,other.mergedRanges);
      if(same){
        for(const [i,validation] of sheet.dataValidations.entries()){
          const next=other.dataValidations.find(value=>value.attributes.sqref===validation.attributes.sqref),path=base+`.dataValidations[${i}]`;
          if(!next){if(!other.dataValidations.length)check('VALIDATION_LOST',path,false,validation.attributes.sqref,[]);else review('VALIDATION_TARGET_REPRESENTATION',path,'Validation target ranges changed; a same-rule range-coverage proof is required.');continue}
          const defaults={type:'none',operator:'between',allowBlank:'0',showInputMessage:'0',showErrorMessage:'0',errorStyle:'stop'};
          for(const key of Object.keys(defaults)){
            const normalized=value=>['true','1'].includes(String(value))?'1':['false','0'].includes(String(value))?'0':value;
            equals('VALIDATION_RULE',path+'.'+key,normalized(validation.attributes[key]??defaults[key]),normalized(next.attributes[key]??defaults[key]));
          }
          formulas(path+'.formula1',validation.formula1,next.formula1);formulas(path+'.formula2',validation.formula2,next.formula2);
        }
        if(sheet.conditionalFormats.length){
          check('CONDITIONAL_FORMAT_PRESENT',base+'.conditionalFormats',other.conditionalFormats.length>0,sheet.conditionalFormats.length,other.conditionalFormats.length);
          if(array(sheet.conditionalRules)&&array(other.conditionalRules)){
            for(const [i,group] of sheet.conditionalRules.entries()){
              const match=other.conditionalRules.find(item=>item.sqref===group.sqref),p=base+`.conditionalRules[${i}]`;
              if(!match){review('CONDITIONAL_TARGET_REPRESENTATION',p,'Conditional format target ranges changed and need coverage comparison.');continue}
              const normalized=rules=>rules.slice().sort((a,b)=>Number(a.priority||0)-Number(b.priority||0)).map(rule=>({type:rule.type,operator:rule.operator,formulas:rule.formulas.map(formula),stopIfTrue:['1','true'].includes(String(rule.attributes.stopIfTrue))}));
              equals('CONDITIONAL_RULES',p,normalized(group.rules),normalized(match.rules));
              if(group.rules.some(rule=>rule.attributes.dxfId!==undefined||!['cellIs','expression'].includes(rule.type)))review('CONDITIONAL_STYLE_UNINSPECTED',p,'Differential styles, color-scale thresholds, icon sets and data bars are not fully resolved; rule-count/expression preservation alone is insufficient.');
            }
          }
          else review('CONDITIONAL_RULES_UNINSPECTED',base+'.conditionalFormats','A formatting range without rule expressions and styles does not prove preservation.');
        }
        const panes=value=>value.filter(pane=>['frozen','frozenSplit'].includes(pane.state)).map(pane=>({state:pane.state,xSplit:Number(pane.xSplit||0),ySplit:Number(pane.ySplit||0)}));
        equals('FROZEN_PANES',base+'.frozenPanes',panes(sheet.frozenPanes),panes(other.frozenPanes));
        chartObjects(base+'.charts',sheet.charts,other.charts);
      }
    }
    if(same){
      for(const name of a.definedNames){
        const matching=b.definedNames.find(other=>other.name===name.name&&other.localSheetId===name.localSheetId),path='spreadsheet.definedNames.'+name.name;
        check('DEFINED_NAME_PRESENT',path,!!matching,name.name,matching?.name??null);if(matching)formulas(path+'.formula',name.formula,matching.formula);
      }
      if(a.date1904!==undefined&&b.date1904!==undefined)equals('DATE_EPOCH','spreadsheet.date1904',['1','true'].includes(String(a.date1904)),['1','true'].includes(String(b.date1904)));
      if(!a.sheets.every(sheet=>array(sheet.charts)))chartObjects('spreadsheet.charts',null,null,source.features.chartParts||0,output.features.chartParts||0);
    }else if(a.definedNames.length)review('DEFINED_NAME_REPRESENTATION','spreadsheet.definedNames','Named range and expression syntax/scopes differ across formats.');
  }else{
    const a=source.presentation,b=output.presentation;
    equals('SLIDE_COUNT','presentation.slides',a.slides.length,b.slides.length);
    for(const [i,slide] of a.slides.entries()){
      const other=b.slides[i],base=`presentation.slides[${i}]`;if(!other)continue;
      textsPreserved(base+'.texts',slide.texts,other.texts);
      const noteTexts=value=>value.flatMap(note=>array(note.texts)?(['sldNum','dt','hdr','ftr'].includes(note.placeholderType)?[]:note.texts):[note.text]);
      textsPreserved(base+'.notes',noteTexts(slide.notes),noteTexts(other.notes));
      tables(base+'.tables',slide.tables,other.tables);
      if(same){
        equals('HIDDEN_SLIDE',base+'.hidden',slide.hidden,other.hidden);
        chartObjects(base+'.charts',slide.charts,other.charts);
        const embedded=slide.media.filter(media=>!media.external),nextEmbedded=other.media.filter(media=>!media.external);
        if(embedded.length){
          check('EMBEDDED_MEDIA_PRESENT',base+'.media',nextEmbedded.length>0,embedded.length,nextEmbedded.length);
          for(const [j,media] of embedded.entries()){
            if(!media.sha256||!nextEmbedded.every(item=>item.sha256)){review('MEDIA_CONTENT_UNVERIFIED',base+`.media[${j}]`,'Relationships and byte lengths alone cannot prove that playable embedded content survived.');continue}
            check('EMBEDDED_MEDIA_BYTES',base+`.media[${j}]`,nextEmbedded.some(item=>item.sha256===media.sha256&&item.bytes===media.bytes),{sha256:media.sha256,bytes:media.bytes},nextEmbedded.map(item=>({sha256:item.sha256,bytes:item.bytes})));
          }
        }
        for(const media of slide.media.filter(item=>item.external)){
          check('EXTERNAL_MEDIA_REFERENCE',base+'.media.external',other.media.some(item=>item.external&&item.target===media.target),media.target,other.media.filter(item=>item.external).map(item=>item.target));
          review('EXTERNAL_MEDIA_OFFLINE',base+'.media.external','An external link is not locally embedded playable media; this test does not fetch it.');
        }
      }else review('SLIDE_VISIBILITY_AND_OBJECT_REPRESENTATION',base,'ODF hidden flags, chart bindings and media identity need separate style/object mappings.');
    }
  }
  if(options.expectedEditMarker!==undefined){
    if(!validText(options.expectedEditMarker)||!options.expectedEditMarker.length)check('INVALID_EDIT_MARKER','options.expectedEditMarker',false,'nonempty Unicode text',null);
    else check('EDIT_MARKER','coreText',output.coreText.strings.map(text).join('\n').includes(text(options.expectedEditMarker)),text(options.expectedEditMarker),null);
  }
  return finish();
}

module.exports={compareInspections,normalizeText:text,normalizeFormula:formula};
