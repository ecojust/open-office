#!/usr/bin/env python3
"""Independent native PDF origins and screenshot space-column decoration colors.
The browser is intentionally not asserted pixel-identical to native Writer.
"""
import hashlib,json,sys
from pathlib import Path
sys.path = [p for p in sys.path if Path(p).resolve() != Path(__file__).parent.resolve()]
import fitz
from PIL import Image
root=Path(__file__).parent
native=json.loads((root/'native-geometry.json').read_text())
pdf=root/native['pdf']
assert hashlib.sha256(pdf.read_bytes()).hexdigest()==native['pdfSha256']
rows=[]
for page in fitz.open(pdf):
    spans=[s for block in page.get_text('dict')['blocks'] for line in block.get('lines',[]) for s in line['spans']]
    for target in [s for s in spans if s['text'].startswith('X')]:
        index=int(target['text'][1:4]);ref=next(s for s in spans if s['text'].startswith(f'C{index:03} R'))
        raised=ref['origin'][1]-target['origin'][1]
        expected=next(r for r in native['rows'] if r['index']==index)
        assert abs(raised-expected['raisedPt'])<.001,(index,raised,expected['raisedPt'])
        rows.append(dict(index=index,raisedPt=raised,fontSize=target['size'],font=target['font']))
assert len(rows)==12,len(rows)
result=dict(nativePdfSha256=native['pdfSha256'],native=rows)
if len(sys.argv)>1:
    info=json.loads(Path(sys.argv[2]).read_text());image=Image.open(sys.argv[1]).convert('RGB')
    pixels=[]
    def bands(values):
        out=[]
        for y in values:
            if not out or y>out[-1][-1]+1:out.append([])
            out[-1].append(y)
        return [[v[0],v[-1]] for v in out]
    for row in info:
        x0,x1=int(row['space']['left']+2),int(row['space']['right']-2)
        top,bottom=int(row['clip']['top']),int(row['clip']['bottom'])
        red=[];blue=[]
        for y in range(max(0,top),min(image.height,bottom)):
            colors=[image.getpixel((x,y)) for x in range(max(0,x0),min(image.width,x1))]
            if sum(r>170 and g<100 and b<100 for r,g,b in colors)>=3:red.append(y)
            if sum(b>170 and r<100 and g<100 for r,g,b in colors)>=3:blue.append(y)
        r,b=bands(red),bands(blue)
        assert len(r)==2,(row['percent'],'double red underline',r)
        assert len(b)==1,(row['percent'],'independent single blue strike',b)
        pixels.append(dict(percent=row['percent'],redBands=r,blueBands=b,referenceTop=row['referenceTop'],targetTop=row['targetTop']))
    relative=lambda r,key:sum(sum(b)/2 for b in r[key])/len(r[key])-r['referenceTop']
    center=next(r for r in pixels if r['percent']==0)
    for r in pixels:
        if not r['percent']:continue
        for key in ['redBands','blueBands']:
            delta=relative(r,key)-relative(center,key)
            assert delta*r['percent']<0,(r,key,delta)
            glyph=r['targetTop']-r['referenceTop']
            assert abs(delta-glyph)<2,(r,key,delta,glyph)
    result['pixels']=pixels
print(json.dumps(result,ensure_ascii=False,indent=2))
