import zipfile,xml.etree.ElementTree as E,json,sys
S='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
def font(n):
 out={}
 if n is not None:
  for e in n:
   name=e.tag.split('}')[-1];name='name' if name=='rFont' else name
   out[name]=dict(sorted(e.attrib.items())) or True
 return out
def canonical(n):
 return None if n is None else [n.tag.split('}')[-1],dict(sorted(n.attrib.items())),n.text or '',[canonical(c)for c in n]]
with zipfile.ZipFile(sys.argv[1])as z:
 styles=E.fromstring(z.read('xl/styles.xml'));fonts=list(styles.find(S+'fonts'));fills=list(styles.find(S+'fills'));borders=list(styles.find(S+'borders'));xfs=list(styles.find(S+'cellXfs'));formats={int(n.get('numFmtId')):n.get('formatCode')for n in (list(styles.find(S+'numFmts')) if styles.find(S+'numFmts') is not None else [])};strings=list(E.fromstring(z.read('xl/sharedStrings.xml')))if'xl/sharedStrings.xml'in z.namelist()else[]
 cells={}
 for c in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//'+S+'c'):
  xf=xfs[int(c.get('s','0'))];v=c.findtext(S+'v');kind=c.get('t','n');text=canonical(strings[int(v)])if kind=='s'else canonical(c.find(S+'is'))if kind=='inlineStr'else None
  font_value=font(fonts[int(xf.get('fontId','0'))]); runs=[]
  string=strings[int(v)]if kind=='s'else c.find(S+'is')if kind=='inlineStr'else None
  if string is not None:
   for r in string.findall(S+'r'):
    runs.append({'text':r.findtext(S+'t')or'','font':{**font_value,**font(r.find(S+'rPr'))}})
  cells[c.get('r')]={'runs':runs,'kind':kind,'formula':c.findtext(S+'f'),'value':None if kind=='s'else v,'text':text,'font':canonical(fonts[int(xf.get('fontId','0'))]),'fill':canonical(fills[int(xf.get('fillId','0'))]),'border':canonical(borders[int(xf.get('borderId','0'))]),'alignment':canonical(xf.find(S+'alignment')),'format':formats.get(int(xf.get('numFmtId','0')),int(xf.get('numFmtId','0')))}
 print(json.dumps(cells,ensure_ascii=False))
