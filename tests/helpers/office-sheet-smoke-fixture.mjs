import { strToU8, zipSync } from 'fflate';

// Independent OOXML specimens exercise the release oracle; application code
// does not generate these bytes and they are not installed-app evidence.
export function sheetXlsx(mutate = () => {}) {
  const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relations = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const document = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const parts = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relations}"><Relationship Id="workbook" Type="${document}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${sheet}" xmlns:r="${document}"><sheets><sheet name="Sheet1" sheetId="1" r:id="sheet1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relations}"><Relationship Id="sheet1" Type="${document}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="styles" Type="${document}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${sheet}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0" numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" numFmtId="0" xfId="0"/><xf fontId="1" fillId="0" borderId="0" numFmtId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1" t="inlineStr" s="1"><is><t>Open Office 表格😀</t></is></c><c r="B1"><v>12</v></c><c r="C1"><f>SUM(B1:B2)</f><v>42</v></c></row><row r="2"><c r="B2"><v>30</v></c></row></sheetData></worksheet>`,
  };
  mutate(parts);
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])), { level: 6, mtime: new Date('2026-01-01T00:00:00Z') })).toString('base64');
}
