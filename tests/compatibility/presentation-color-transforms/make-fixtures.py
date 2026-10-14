"""Self-authored color swatches; no reference implementation or assets copied."""
from pathlib import Path
from lxml import etree as E
import hashlib, json, zipfile

root = Path(__file__).resolve().parent
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
ns = {'a': A, 'p': P}
qa = lambda n: f'{{{A}}}{n}'
qp = lambda n: f'{{{P}}}{n}'
emu = lambda v: str(round(v * 36000))
with zipfile.ZipFile(root.parent / 'presentation-table-text/mixed-cell.pptx') as z:
    parts = {i.filename: z.read(i) for i in z.infolist()}
slide_part = next(p for p in parts if p.startswith('ppt/slides/') and p.endswith('.xml') and p.count('/') == 2)
slide = E.fromstring(parts[slide_part]); cs = slide.find('p:cSld', ns)
for old in cs.findall('p:bg', ns): cs.remove(old)
bg = E.Element(qp('bg')); pr = E.SubElement(bg, qp('bgPr'))
E.SubElement(E.SubElement(pr, qa('solidFill')), qa('srgbClr'), val='FFFFFF'); cs.insert(0, bg)
tree = cs.find('p:spTree', ns)
for el in list(tree):
    if E.QName(el).localname not in ('nvGrpSpPr', 'grpSpPr'): tree.remove(el)

specs = [
    ('base', 'srgbClr', {'val':'336699'}, []),
    ('tint-0', 'srgbClr', {'val':'336699'}, [('tint','0')]),
    ('tint-25', 'srgbClr', {'val':'336699'}, [('tint','25000')]),
    ('tint-50', 'srgbClr', {'val':'336699'}, [('tint','50000')]),
    ('tint-100', 'srgbClr', {'val':'336699'}, [('tint','100000')]),
    ('shade-50', 'srgbClr', {'val':'336699'}, [('shade','50000')]),
    ('lum-mod-50', 'srgbClr', {'val':'336699'}, [('lumMod','50000')]),
    ('lum-off-20', 'srgbClr', {'val':'336699'}, [('lumOff','20000')]),
    ('lum-mod-off', 'srgbClr', {'val':'336699'}, [('lumMod','50000'),('lumOff','20000')]),
    ('lum-off-mod', 'srgbClr', {'val':'336699'}, [('lumOff','20000'),('lumMod','50000')]),
    ('green-tint-50', 'srgbClr', {'val':'00FF00'}, [('tint','50000')]),
    ('green-shade-50', 'srgbClr', {'val':'00FF00'}, [('shade','50000')]),
    ('scrgb-50', 'scrgbClr', {'r':'50000','g':'50000','b':'50000'}, []),
    ('scrgb-percent', 'scrgbClr', {'r':'50%','g':'50%','b':'50%'}, []),
    ('srgb-equivalent', 'srgbClr', {'val':'BCBCBC'}, []),
    ('tint-percent', 'srgbClr', {'val':'336699'}, [('tint','50%')]),
    ('tint-shade', 'srgbClr', {'val':'336699'}, [('tint','50000'),('shade','50000')]),
    ('shade-tint', 'srgbClr', {'val':'336699'}, [('shade','50000'),('tint','50000')]),
    ('system-tint', 'sysClr', {'val':'windowText','lastClr':'336699'}, [('tint','50000')]),
    ('alpha-chain', 'srgbClr', {'val':'336699'}, [('alpha','80000'),('alphaMod','50000'),('alphaOff','10000')]),
]
swatches=[]
for i,(name,kind,attrs,mods) in enumerate(specs):
    x,y=20+(i%5)*62,15+(i//5)*42
    sp=E.SubElement(tree,qp('sp')); nv=E.SubElement(sp,qp('nvSpPr'))
    E.SubElement(nv,qp('cNvPr'),id=str(i+2),name=name);E.SubElement(nv,qp('cNvSpPr'));E.SubElement(nv,qp('nvPr'))
    pr=E.SubElement(sp,qp('spPr'));xf=E.SubElement(pr,qa('xfrm'))
    E.SubElement(xf,qa('off'),x=emu(x),y=emu(y));E.SubElement(xf,qa('ext'),cx=emu(46),cy=emu(28))
    E.SubElement(E.SubElement(pr,qa('prstGeom'),prst='rect'),qa('avLst'))
    col=E.SubElement(E.SubElement(pr,qa('solidFill')),qa(kind),**attrs)
    for mod,value in mods:E.SubElement(col,qa(mod),val=value)
    E.SubElement(E.SubElement(pr,qa('ln')),qa('noFill'))
    swatches.append({'id':name,'color':kind,'attributes':attrs,'transforms':mods,'boxMm':[x,y,46,28]})
parts[slide_part]=E.tostring(slide,xml_declaration=True,encoding='UTF-8',standalone=True)
path=root/'swatches.pptx'
with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
    for key,value in sorted(parts.items()):
        info=zipfile.ZipInfo(key,date_time=(2026,10,14,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,value)
manifest={'scope':'Self-authored solid-color oracle; percentage lexical cases are deliberate compatibility probes.', 'items':[{'id':'swatches','path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'expected':{'slides':1},'slideMm':[338.6666666667,190.5],'swatches':swatches}]}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(path,manifest['items'][0]['sha256'])
