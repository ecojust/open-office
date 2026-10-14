"""Self-authored ordinary-text alpha fixture, independent of product import code."""
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
slide = E.fromstring(parts[part])
tree = slide.find('p:cSld/p:spTree', ns)
for node in list(tree):
    if E.QName(node).localname not in ['nvGrpSpPr', 'grpSpPr']:
        tree.remove(node)

def paint(parent, value='000000', mods=(), theme=False):
    color = E.SubElement(E.SubElement(parent, qa('solidFill')), qa('schemeClr' if theme else 'srgbClr'), val=value)
    for name, val in mods:
        E.SubElement(color, qa(name), val=str(val))

specs = [
    dict(id='direct-half', alpha=[.5], mods=[('alpha', 50000)]),
    dict(id='direct-zero', alpha=[0], mods=[('alpha', 0)]),
    dict(id='opaque-control', alpha=[1], mods=[]),
    dict(id='paragraph-inherited', alpha=[.5], default=[('alpha', 50000)], inherit=True),
    dict(id='explicit-overrides-default', alpha=[1], default=[('alpha', 50000)], mods=[]),
    dict(id='mixed-runs', alpha=[1, .5, 0], mixed=True),
    dict(id='ordered-chain', alpha=[.5], mods=[('alpha', 80000), ('alphaMod', 50000), ('alphaOff', 10000)]),
    dict(id='bold-half', alpha=[.5], mods=[('alpha', 50000)], bold=True),
    dict(id='underline-half', alpha=[.5], mods=[('alpha', 50000)], underline=True),
    dict(id='theme-color-half', alpha=[.5], mods=[('alpha', 50000)], theme=True),
    dict(id='end-paragraph-only', alpha=[1], mods=[], end=[('alpha', 0)]),
    dict(id='body-list-inherited', alpha=[.25], listdefault=[('alpha', 25000)], inherit=True),
]
rows = []
for index, spec in enumerate(specs):
    x, y, w, h = 15 + index % 3 * 105, 12 + index // 3 * 44, 88, 32
    shape = E.SubElement(tree, qp('sp'))
    nv = E.SubElement(shape, qp('nvSpPr'))
    E.SubElement(nv, qp('cNvPr'), id=str(index+2), name=spec['id'])
    E.SubElement(nv, qp('cNvSpPr'))
    E.SubElement(nv, qp('nvPr'))
    props = E.SubElement(shape, qp('spPr'))
    transform = E.SubElement(props, qa('xfrm'))
    E.SubElement(transform, qa('off'), x=emu(x), y=emu(y))
    E.SubElement(transform, qa('ext'), cx=emu(w), cy=emu(h))
    E.SubElement(E.SubElement(props, qa('prstGeom'), prst='rect'), qa('avLst'))
    paint(props, 'FFBFBF')
    paint(E.SubElement(props, qa('ln'), w=emu(1)), '0000FF')
    body = E.SubElement(shape, qp('txBody'))
    E.SubElement(body, qa('bodyPr'), anchor='ctr', wrap='none', lIns='0', rIns='0', tIns='0', bIns='0')
    liststyle = E.SubElement(body, qa('lstStyle'))
    if 'listdefault' in spec:
        paint(E.SubElement(E.SubElement(liststyle, qa('lvl1pPr')), qa('defRPr')), mods=spec['listdefault'])
    paragraph = E.SubElement(body, qa('p'))
    pp = E.SubElement(paragraph, qa('pPr'), algn='ctr', lvl='0')
    if 'default' in spec:
        paint(E.SubElement(pp, qa('defRPr')), mods=spec['default'])
    for run_index, alpha in enumerate(spec['alpha']):
        run = E.SubElement(paragraph, qa('r'))
        rp = E.SubElement(run, qa('rPr'), sz='4800', lang='en-US')
        if spec.get('bold'): rp.set('b', '1')
        if spec.get('underline'): rp.set('u', 'sng')
        if not spec.get('inherit'):
            mods = [('alpha', round(alpha*100000))] if spec.get('mixed') else spec.get('mods', [])
            paint(rp, 'accent2' if spec.get('theme') else '000000', mods, spec.get('theme', False))
        E.SubElement(rp, qa('latin'), typeface='Arial')
        E.SubElement(run, qa('t')).text = 'H ' if spec.get('mixed') and run_index < 2 else 'H'
    if 'end' in spec:
        paint(E.SubElement(paragraph, qa('endParaRPr')), mods=spec['end'])
    rows.append({**spec, 'boxMm': [x,y,w,h], 'text': 'H H H' if spec.get('mixed') else 'H'})
parts[part] = E.tostring(slide, xml_declaration=True, encoding='UTF-8', standalone=True)
target = root / 'ordinary-text-alpha.pptx'
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(parts.items()):
        info = zipfile.ZipInfo(name, date_time=(2026,10,14,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
manifest = {'scope': 'Ordinary glyph alpha, body-local inheritance, independent opaque shape paint. Ordered-chain reference behavior is measured separately.', 'items': [{'id': 'ordinary-text-alpha', 'path': target.name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'expected': {'slides': 1}, 'slideMm': [338.6666666667,190.5], 'objects': rows}]}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(target)
