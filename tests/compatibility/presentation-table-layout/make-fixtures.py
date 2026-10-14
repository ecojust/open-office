"""Deterministic, self-authored layout variants of the local mixed-cell fixture."""
from pathlib import Path
from lxml import etree as E
import hashlib,json,zipfile
root=Path(__file__).resolve().parent
base=root.parent/'presentation-table-text/mixed-cell.pptx'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
P='http://schemas.openxmlformats.org/presentationml/2006/main'
ns={'a':A,'p':P}
q=lambda name:f'{{{A}}}{name}'
emu=lambda mm:str(round(mm*36000))
items=[]
for name,width,height in [('matched',120,40),('mismatched-frame',180,80),('content-growth',120,4)]:
    with zipfile.ZipFile(base) as z:parts={i.filename:z.read(i)for i in z.infolist()}
    slides=[p for p in parts if p.startswith('ppt/slides/')and p.endswith('.xml')and p.count('/')==2]
    assert len(slides)==1
    slide_part=slides[0];slide=E.fromstring(parts[slide_part])
    cs=slide.find('p:cSld',ns)
    for old in cs.findall('p:bg',ns):cs.remove(old)
    bg=E.Element(f'{{{P}}}bg');pr=E.SubElement(bg,f'{{{P}}}bgPr');fill=E.SubElement(pr,q('solidFill'));E.SubElement(fill,q('srgbClr'),val='D9E7F3');cs.insert(0,bg)
    frame=slide.find('.//p:graphicFrame',ns);xfrm=frame.find('p:xfrm',ns)
    off=xfrm.find('a:off',ns);off.set('x',emu(20));off.set('y',emu(20))
    ext=xfrm.find('a:ext',ns);ext.set('cx',emu(width));ext.set('cy',emu(height))
    table=frame.find('.//a:tbl',ns)
    for element in list(table):table.remove(element)
    E.SubElement(table,q('tblPr'),firstRow='0',bandRow='0')
    grid=E.SubElement(table,q('tblGrid'))
    for w in [20,60,40]:E.SubElement(grid,q('gridCol'),w=emu(w))
    heights=[10,30] if name!='content-growth'else[2,2]
    for r,h in enumerate(heights):
        row=E.SubElement(table,q('tr'),h=emu(h))
        for c in range(3):
            tc=E.SubElement(row,q('tc'));body=E.SubElement(tc,q('txBody'));E.SubElement(body,q('bodyPr'));E.SubElement(body,q('lstStyle'))
            para=E.SubElement(body,q('p'));run=E.SubElement(para,q('r'));rp=E.SubElement(run,q('rPr'),sz='1000',lang='en-US');sf=E.SubElement(rp,q('solidFill'));E.SubElement(sf,q('srgbClr'),val='123456');E.SubElement(rp,q('latin'),typeface='Arial');E.SubElement(run,q('t')).text=f'R{r+1} C{c+1}'
            props=E.SubElement(tc,q('tcPr'),marL=emu(1),marR=emu(1),marT=emu(1),marB=emu(1),anchor='t')
            if c==0:
                f=E.SubElement(props,q('solidFill'));E.SubElement(f,q('srgbClr'),val='F7C65F' if r==0 else'ED8A85')
            elif c==1:E.SubElement(props,q('noFill'))
    parts[slide_part]=E.tostring(slide,xml_declaration=True,encoding='UTF-8',standalone=True)
    path=root/f'{name}.pptx'
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED)as z:
        for key,value in sorted(parts.items()):
            info=zipfile.ZipInfo(key,date_time=(2026,10,14,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,value)
    items.append({'id':name,'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'expected':{'slides':1},'gridWidthsMm':[20,60,40],'rowHeightsMm':heights,'frameMm':[width,height]})
(root/'manifest.json').write_text(json.dumps({'scope':'Authored grid/row/fill fixtures; native height can grow from text','items':items},indent=2)+'\n')
print(json.dumps(items))
