const normalizeText = value => String(value ?? '').normalize('NFC').replace(/\s+/g,'');
function checkAssertions(info, assertions, marker) {
  // The inspector deliberately identifies unsupported legacy formats. Their
  // original semantics are checked against provenance-backed manifest values.
  const checks = [];
  const check = (name,ok,actual,expected) => checks.push({name,ok:!!ok,actual,expected});
  check('independent-parser',info.inspection === 'parsed',info.inspection,'parsed');
  const strings = info.coreText?.strings || [];
  const text = normalizeText(strings.join('\n'));
  for (const expected of [...(assertions.textIncludes || []), ...(marker ? [marker] : [])]) check('text:'+expected,text.includes(normalizeText(expected)),text.includes(normalizeText(expected)),true);
  for (const [name,minimum] of Object.entries(assertions.minimumFeatures || {})) check('feature:'+name,(info.features?.[name] ?? -1)>=minimum,info.features?.[name] ?? null,minimum);
  if (assertions.slideCount !== undefined) check('slide-count',info.presentation?.slides?.length===assertions.slideCount,info.presentation?.slides?.length,assertions.slideCount);
  for (const name of assertions.sheetNames || []) check('sheet:'+name,info.spreadsheet?.sheets?.some(sheet=>sheet.name===name),info.spreadsheet?.sheets?.map(sheet=>sheet.name),name);
  for (const expected of assertions.sheetCells || []) {
    const sheet = info.spreadsheet?.sheets?.find(sheet=>sheet.name===expected.sheet);
    const cells = sheet?.cells || [];
    const cell = Array.isArray(cells) ? cells.find(cell=>(cell.address || cell.ref)===expected.address) : cells[expected.address];
    check('cell:'+expected.sheet+'!'+expected.address,!!cell,cell || null,expected);
    if (!cell) continue;
    if (expected.type !== undefined) check('cell-type:'+expected.address,cell.type===expected.type,cell.type,expected.type);
    if (expected.value !== undefined) check('cell-value:'+expected.address,typeof expected.value==='number'? typeof cell.value==='number' && Number.isFinite(cell.value) && (Number.isInteger(expected.value)?cell.value===expected.value:Math.abs(cell.value-expected.value)<=Number.EPSILON*8*Math.max(1,Math.abs(expected.value))) : String(cell.value)===String(expected.value),cell.value,expected.value);
    if (expected.formula !== undefined) {
      const clean=value=>String(value??'').replace(/^=/,'');
      if(info.format==='xlsx')check('cell-formula:'+expected.address,clean(cell.formula)===clean(expected.formula),cell.formula,expected.formula);
      else check('cell-formula-present:'+expected.address,typeof cell.formula==='string'&&cell.formula.length>0,cell.formula,'ODF expression retained; exact cross-syntax equivalence requires separate review');
    }
  }
  return checks;
}

module.exports = { checkAssertions };
