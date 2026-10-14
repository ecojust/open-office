"""Independent OOXML highlight controls. No product importer is used."""
from pathlib import Path
from lxml import etree as E
import hashlib,json,zipfile
root=Path(__file__).resolve().parent
A='http://schemas.openxmlformats.org/drawingml/2006/main';P='http://schemas.openxmlformats.org/presentationml/2006/main'
ns={'a':A,'p':P};qa=lambda n:f'{{{A}}}{n}';qp=lambda n:f'{{{P}}}{n}';emu=lambda n:str(round(n*36000))
with zipfile.ZipFile(root.parent/'presentation-opacity/independent-alpha.pptx') as archive:parts={n:archive.read(n) for n in archive.namelist()}
part=next(n for n in parts if n.startswith('ppt/slides/') and n.endswith('.xml') and n.count('/')==2)
slide=E.fromstring(parts[part]);tree=slide.find('p:cSld/p:spTree',ns)
for node in list(tree):
 if E.QName(node).localname not in ['nvGrpSpPr','grpSpPr']:tree.remove(node)
def color(parent,value,alpha=1,theme=False,mods=()):
 node=E.SubElement(parent,qa('schemeClr' if theme else 'srgbClr'),val=value)
 if alpha!=1:E.SubElement(node,qa('alpha'),val=str(round(alpha*100000)))
 for name,value in mods:E.SubElement(node,qa(name),val=str(value))
def highlight(parent,value='FFFF00',alpha=1,theme=False,mods=()):color(E.SubElement(parent,qa('highlight')),value,alpha,theme,mods)
def paint(parent,value):color(E.SubElement(parent,qa('solidFill')),value)
specs=[
 dict(id='no-highlight',text='H H'),
 dict(id='yellow-opaque',text='H H',highlight='FFFF00'),
 dict(id='yellow-half',text='H H',highlight='FFFF00',highlightAlpha=.5),
 dict(id='text-half',text='H H',highlight='FFFF00',textAlpha=.5),
 dict(id='text-zero',text='H H',highlight='FFFF00',textAlpha=0),
 dict(id='inherited-yellow',text='H H',defaultHighlight='FFFF00'),
 dict(id='explicit-cyan',text='H H',defaultHighlight='FFFF00',highlight='00FFFF'),
 dict(id='transparent-override',text='H H',defaultHighlight='FFFF00',highlight='000000',highlightAlpha=0),
 dict(id='mixed-baselines',text='H H H',highlight='FFEE88',mixed=True),
 dict(id='leading-trailing-spaces',text=' H H ',highlight='FFFF00'),
 dict(id='manual-break',text='H\nH',highlight='FFFF00',breaks=True),
 dict(id='theme-highlight',text='H H',highlight='accent2',theme=True,mods=[('tint',50000)]),
]
objects=[]
for i,spec in enumerate(specs):
 x,y,w,h=15+i%3*105,12+i//3*44,88,32
 shape=E.SubElement(tree,qp('sp'));nv=E.SubElement(shape,qp('nvSpPr'))
 E.SubElement(nv,qp('cNvPr'),id=str(i+2),name=spec['id']);E.SubElement(nv,qp('cNvSpPr'));E.SubElement(nv,qp('nvPr'))
 props=E.SubElement(shape,qp('spPr'));transform=E.SubElement(props,qa('xfrm'));E.SubElement(transform,qa('off'),x=emu(x),y=emu(y));E.SubElement(transform,qa('ext'),cx=emu(w),cy=emu(h))
 E.SubElement(E.SubElement(props,qa('prstGeom'),prst='rect'),qa('avLst'));paint(props,'FFFFFF');paint(E.SubElement(props,qa('ln'),w=emu(.4)),'0077CC')
 body=E.SubElement(shape,qp('txBody'));E.SubElement(body,qa('bodyPr'),anchor='ctr',wrap='none',lIns='0',rIns='0',tIns='0',bIns='0');E.SubElement(body,qa('lstStyle'))
 paragraph=E.SubElement(body,qa('p'));pp=E.SubElement(paragraph,qa('pPr'),algn='ctr',lvl='0')
 if spec.get('defaultHighlight'):highlight(E.SubElement(pp,qa('defRPr')),spec['defaultHighlight'])
 runs=[('H ',4800,0),('H ',2400,30000),('H',3600,-25000)] if spec.get('mixed') else [('H',2400,0),('H',2400,0)] if spec.get('breaks') else [(spec['text'],4800,0)]
 for j,(text,size,baseline) in enumerate(runs):
  if spec.get('breaks') and j:E.SubElement(paragraph,qa('br'))
  run=E.SubElement(paragraph,qa('r'));rp=E.SubElement(run,qa('rPr'),sz=str(size),lang='en-US')
  if baseline:rp.set('baseline',str(baseline))
  color(E.SubElement(rp,qa('solidFill')),'000000',spec.get('textAlpha',1))
  if spec.get('highlight'):highlight(rp,spec['highlight'],spec.get('highlightAlpha',1),spec.get('theme',False),spec.get('mods',()))
  E.SubElement(rp,qa('latin'),typeface='Arial');t=E.SubElement(run,qa('t'));t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=text
 objects.append({**spec,'boxMm':[x,y,w,h]})
parts[part]=E.tostring(slide,xml_declaration=True,encoding='UTF-8',standalone=True)
target=root/'ordinary-highlight.pptx'
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
 for name,data in sorted(parts.items()):
  info=zipfile.ZipInfo(name,date_time=(2026,10,14,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;archive.writestr(info,data)
manifest={'scope':'Ordinary DrawingML highlight, text alpha independence, local inheritance and transparent override, baseline/space/break geometry; independent handwritten XML.','items':[{'id':'ordinary-highlight','path':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'expected':{'slides':1},'slideMm':[338.6666666667,190.5],'objects':objects}]}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(target)
