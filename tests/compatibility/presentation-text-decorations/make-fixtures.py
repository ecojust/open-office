"""Small self-authored OOXML controls, independent of the product importer."""
from pathlib import Path
from lxml import etree as E
import hashlib, json, zipfile

root = Path(__file__).resolve().parent
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
ns = {'a': A, 'p': P}
qa = lambda n: f'{{{A}}}{n}'
qp = lambda n: f'{{{P}}}{n}'
emu = lambda n: str(round(n * 36000))
with zipfile.ZipFile(root.parent / 'presentation-opacity/independent-alpha.pptx') as archive:
    parts = {name: archive.read(name) for name in archive.namelist()}
part = next(name for name in parts if name.startswith('ppt/slides/') and name.endswith('.xml') and name.count('/') == 2)
slide = E.fromstring(parts[part]); tree = slide.find('p:cSld/p:spTree', ns)
for node in list(tree):
    if E.QName(node).localname not in ['nvGrpSpPr', 'grpSpPr']: tree.remove(node)

def paint(parent, value='000000', alpha=None):
    color = E.SubElement(E.SubElement(parent, qa('solidFill')), qa('srgbClr'), val=value)
    if alpha is not None: E.SubElement(color, qa('alpha'), val=str(round(alpha * 100000)))

specs = [
    dict(id='none-control', u='none', strike='noStrike', expected=['none','none']),
    dict(id='single-underline', u='sng', expected=['single','none']),
    dict(id='double-underline', u='dbl', expected=['double','none']),
    dict(id='single-strike', strike='sngStrike', expected=['none','single']),
    dict(id='double-strike', strike='dblStrike', expected=['none','double']),
    dict(id='both-double', u='dbl', strike='dblStrike', expected=['double','double']),
    dict(id='inherited-double', default={'u':'dbl','strike':'dblStrike'}, expected=['double','double']),
    dict(id='explicit-disable', default={'u':'dbl','strike':'dblStrike'}, u='none', strike='noStrike', expected=['none','none']),
    dict(id='zero-alpha-double', u='dbl', strike='dblStrike', alpha=0, expected=['double','double']),
    dict(id='half-alpha-double', u='dbl', strike='dblStrike', alpha=.5, expected=['double','double']),
    dict(id='wavy-preserved', u='wavy', strike='sngStrike', expected=['unsupported','single']),
    dict(id='words-preserved', u='words', expected=['unsupported','none']),
]
rows = []
for index, spec in enumerate(specs):
    x, y, w, h = 15 + index % 3 * 105, 12 + index // 3 * 44, 88, 32
    shape = E.SubElement(tree, qp('sp'))
    nv = E.SubElement(shape, qp('nvSpPr'))
    E.SubElement(nv, qp('cNvPr'), id=str(index+2), name=spec['id'])
    E.SubElement(nv, qp('cNvSpPr')); E.SubElement(nv, qp('nvPr'))
    props = E.SubElement(shape, qp('spPr')); transform = E.SubElement(props, qa('xfrm'))
    E.SubElement(transform, qa('off'), x=emu(x), y=emu(y))
    E.SubElement(transform, qa('ext'), cx=emu(w), cy=emu(h))
    E.SubElement(E.SubElement(props, qa('prstGeom'), prst='rect'), qa('avLst'))
    paint(props, 'FFFFFF'); paint(E.SubElement(props, qa('ln'), w=emu(.4)), '0077CC')
    body = E.SubElement(shape, qp('txBody'))
    E.SubElement(body, qa('bodyPr'), anchor='ctr', wrap='none', lIns='0', rIns='0', tIns='0', bIns='0')
    E.SubElement(body, qa('lstStyle')); paragraph = E.SubElement(body, qa('p'))
    pp = E.SubElement(paragraph, qa('pPr'), algn='ctr', lvl='0')
    if spec.get('default'): E.SubElement(pp, qa('defRPr'), **spec['default'])
    run = E.SubElement(paragraph, qa('r'))
    rp = E.SubElement(run, qa('rPr'), sz='4800', lang='en-US', **{k:spec[k] for k in ['u','strike'] if k in spec})
    paint(rp, alpha=spec.get('alpha'))
    E.SubElement(rp, qa('latin'), typeface='Arial'); E.SubElement(run, qa('t')).text = 'H H'
    rows.append({**spec, 'boxMm':[x,y,w,h], 'text':'H H'})
parts[part] = E.tostring(slide, xml_declaration=True, encoding='UTF-8', standalone=True)
target = root / 'ordinary-decorations.pptx'
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(parts.items()):
        info = zipfile.ZipInfo(name, date_time=(2026,10,14,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,data)
manifest = {'scope':'Ordinary single/double underline and strike; inheritance and explicit disable; alpha 0/50%; unsupported wavy/words preservation. Native reference may simplify some underline styles.', 'items':[{'id':'ordinary-decorations','path':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'expected':{'slides':1},'slideMm':[338.6666666667,190.5],'objects':rows}]}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(target)
