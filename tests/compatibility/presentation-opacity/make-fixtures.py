"""Self-authored independent fill/line/text alpha probes."""
from pathlib import Path
from lxml import etree as E
import hashlib,json,zipfile
root=Path(__file__).resolve().parent
A='http://schemas.openxmlformats.org/drawingml/2006/main';P='http://schemas.openxmlformats.org/presentationml/2006/main';ns={'a':A,'p':P}
qa=lambda n:f'{{{A}}}{n}';qp=lambda n:f'{{{P}}}{n}';emu=lambda n:str(round(n*36000))
with zipfile.ZipFile(root.parent/'presentation-table-text/mixed-cell.pptx')as z:parts={p:z.read(p)for p in z.namelist()}
part=next(p for p in parts if p.startswith('ppt/slides/')and p.endswith('.xml')and p.count('/')==2)
slide=E.fromstring(parts[part]);cs=slide.find('p:cSld',ns)
for bg in cs.findall('p:bg',ns):cs.remove(bg)
bg=E.Element(qp('bg'));E.SubElement(E.SubElement(E.SubElement(bg,qp('bgPr')),qa('solidFill')),qa('srgbClr'),val='FFFFFF');cs.insert(0,bg)
tree=cs.find('p:spTree',ns)
for n in list(tree):
 if E.QName(n).localname not in ['nvGrpSpPr','grpSpPr']:tree.remove(n)
specs=[
 ('fill-half','rect',[('alpha','50000')],[],[],False),
 ('fill-zero','rect',[('alpha','0')],[],[],False),
 ('line-quarter','rect',[],[('alpha','25000')],[],False),
 ('independent','rect',[('alpha','50000')],[('alpha','25000')],[],False),
 ('line-zero','ellipse',[],[('alpha','0')],[],False),
 ('ellipse-independent','ellipse',[('alpha','50000')],[('alpha','25000')],[],False),
 ('line-only','line',[],[('alpha','25000')],[],False),
 ('fill-chain','rect',[('alpha','80000'),('alphaMod','50000'),('alphaOff','10000')],[],[],False),
 ('line-chain','rect',[],[('alpha','80000'),('alphaMod','50000'),('alphaOff','10000')],[],False),
 ('text-alpha-limitation','rect',[('alpha','50000')],[('alpha','25000')],[('alpha','50000')],False),
 ('theme-fill','rect',[('alpha','50000')],[],[],True),
 ('theme-line','rect',[],[('alpha','25000')],[],True),
]
def color(parent,value,mods,theme=False):
 c=E.SubElement(E.SubElement(parent,qa('solidFill')),qa('schemeClr'if theme else'srgbClr'),val=value)
 for name,val in mods:E.SubElement(c,qa(name),val=val)
rows=[]
for i,(name,preset,fillmods,linemods,textmods,theme)in enumerate(specs):
 x,y=15+i%3*105,12+i//3*44;w,h=88,32
 sp=E.SubElement(tree,qp('sp'));nv=E.SubElement(sp,qp('nvSpPr'));E.SubElement(nv,qp('cNvPr'),id=str(i+2),name=name);E.SubElement(nv,qp('cNvSpPr'));E.SubElement(nv,qp('nvPr'))
 pr=E.SubElement(sp,qp('spPr'));xf=E.SubElement(pr,qa('xfrm'));E.SubElement(xf,qa('off'),x=emu(x),y=emu(y));E.SubElement(xf,qa('ext'),cx=emu(w),cy=emu(h));E.SubElement(E.SubElement(pr,qa('prstGeom'),prst=preset),qa('avLst'))
 if preset!='line':color(pr,'accent1'if theme else'FF0000',fillmods,theme)
 else:E.SubElement(pr,qa('noFill'))
 ln=E.SubElement(pr,qa('ln'),w=emu(2));color(ln,'accent2'if theme else'0000FF',linemods,theme)
 if preset!='line':
  body=E.SubElement(sp,qp('txBody'));E.SubElement(body,qa('bodyPr'),anchor='ctr',wrap='none',lIns=emu(0),rIns=emu(0),tIns=emu(0),bIns=emu(0));E.SubElement(body,qa('lstStyle'));para=E.SubElement(body,qa('p'));E.SubElement(para,qa('pPr'),algn='ctr');run=E.SubElement(para,qa('r'));rp=E.SubElement(run,qa('rPr'),sz='4800',b='1',lang='en-US');color(rp,'000000',textmods);E.SubElement(rp,qa('latin'),typeface='Arial');E.SubElement(run,qa('t')).text='H'
 rows.append({'id':name,'preset':preset,'boxMm':[x,y,w,h],'fillModifiers':fillmods,'lineModifiers':linemods,'textModifiers':textmods,'theme':theme})
parts[part]=E.tostring(slide,xml_declaration=True,encoding='UTF-8',standalone=True)
target=root/'independent-alpha.pptx'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED)as z:
 for name,data in sorted(parts.items()):
  info=zipfile.ZipInfo(name,date_time=(2026,10,14,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,data)
(root/'manifest.json').write_text(json.dumps({'scope':'Independent paints and opaque text; text-alpha is an explicit unsupported control; chain behavior may differ from reference','items':[{'id':'independent-alpha','path':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'expected':{'slides':1},'slideMm':[338.6666666667,190.5],'objects':rows}]},indent=2)+'\n');print(target)
