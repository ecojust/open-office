"""Independent ZIP/XML and PDF readback of production browser exports."""
import json
from pathlib import Path
from zipfile import ZipFile
from lxml import etree
import fitz

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).with_name('spacing-baseline.pptx')
OUT = ROOT / 'test-results/presentation-typography'
CASE = OUT / 'spacing-baseline'
NS = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
checks=[]


def check(condition, message):
    assert condition, message
    checks.append(message)


def tree(node):
    return (node.tag, sorted(node.attrib.items()), node.text, [tree(c) for c in node])


def bodies(archive):
    result={}
    for index in range(1,5):
        doc=etree.fromstring(archive.read(f'ppt/slides/slide{index}.xml'))
        for shape in doc.xpath('//p:sp[p:txBody]',namespaces=NS):
            name=shape.find('p:nvSpPr/p:cNvPr',NS).get('name')
            result[name]=shape.find('p:txBody',NS)
    return result


with ZipFile(FIXTURE) as archive:
    original=bodies(archive)
for cycle in range(1,4):
    with ZipFile(CASE/f'noop-{cycle}.pptx') as archive:
        current=bodies(archive)
        check({n:tree(t) for n,t in current.items()}=={n:tree(t) for n,t in original.items()},f'Cycle {cycle}: all original text-body XML preserved independently')

with ZipFile(CASE/'styled.pptx') as archive:
    styled=bodies(archive)
    check(all(tree(body)==tree(original[name]) for name,body in styled.items() if name!='BASELINE_EXPLICIT'),'Style edit preserves every unrelated text body')
    props=styled['BASELINE_EXPLICIT'].xpath('./a:p/a:r/a:rPr',namespaces=NS)
    check([p.get('baseline') for p in props]==['0','30000','-25000','0'],'Style edit preserves exact baseline lexical values')
    check(all(p.get('b')=='1' and p.get('sz')=='2600' for p in props),'Style edit applies bold without changing stored sizes')

with ZipFile(CASE/'edited.pptx') as archive:
    edited=bodies(archive)
    check(all(tree(body)==tree(original[name]) for name,body in edited.items() if name!='BASELINE_EXPLICIT'),'Text edit preserves every unrelated text body')
    edited_run=edited['BASELINE_EXPLICIT'].find('a:p/a:r',NS)
    check(edited_run.find('a:t',NS).text=='Edited normal paragraph' and edited_run.find('a:rPr',NS).get('baseline')=='0','Text edit retains the first run baseline template')

pdf=fitz.open(CASE/'preview.pdf')
check(len(pdf)==4,'PDF independently opens with four pages')


def spans(index):
    return [s for b in pdf[index].get_text('dict')['blocks'] for l in b.get('lines',[]) for s in l['spans']]


def near(a,b):
    return abs(a-b)<0.002


line_spans=spans(0)
for x,expected in [(28.8,21.6),(331.2,36),(633.6,12)]:
    lines=[next(s for s in line_spans if s['text']==text and near(s['origin'][0],x)) for text in ['First 24pt line','Second 24pt line','Third 24pt line','Next paragraph']]
    ys=[s['origin'][1] for s in lines]
    check(near(ys[1]-ys[0],expected) and near(ys[2]-ys[1],expected) and near(ys[3]-ys[2],expected+8),f'PDF column {x}: expected point advances and max paragraph gap')

script={s['text'].strip():s for s in spans(1) if s['origin'][1]<200}
check(near(script['Normal']['origin'][1]-script['Raised']['origin'][1],7.8),'PDF raised text uses requested 30% of 26pt')
check(near(script['Lowered']['origin'][1]-script['Normal']['origin'][1],6.5),'PDF lowered text uses requested 25% of 26pt')
check(near(script['Zero']['origin'][1],script['Normal']['origin'][1]),'PDF explicit-zero returns to normal baseline')
check(all(near(script[key]['size'],26) for key in ['Normal','Raised','Lowered','Zero']),'PDF retains all explicit script font sizes')

boundary=spans(3)
mixed=[next(s for s in boundary if s['text']==text) for text in ['Small 12','Large 42','Medium 18']]
check(all(near(mixed[i+1]['origin'][1]-mixed[i]['origin'][1],12) for i in range(2)),'PDF mixed-size glyphs retain fixed 12pt advances')
first=sorted((s for s in boundary if s['text']=='First paragraph'),key=lambda s:s['origin'][0])
check(near(first[1]['origin'][1]-first[0]['origin'][1],12),'PDF first/last switch applies 12pt leading space')

report={'ok':True,'verifiers':['Python zipfile','lxml','PyMuPDF'],'checks':checks,'limitations':['Geometry assertions use declared fixture values; no pixel-equality claim against native reference software.']}
(OUT/'independent-readback.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'ok':True,'checks':len(checks)}))
