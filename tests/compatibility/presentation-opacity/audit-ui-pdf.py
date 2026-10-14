"""Independent PyMuPDF audit of the actual Vue downloads (run with PDF venv)."""
from pathlib import Path
import json,hashlib
import pymupdf as fitz
root=Path(__file__).resolve().parents[3]
out=root/'test-results/presentation-opacity-ui'
manifest=json.loads((Path(__file__).parent/'manifest.json').read_text())['items'][0]
fill_alphas=[.5,0,1,.5,1,.5,None,.5,1,.5,.5,1]
line_alphas=[1,1,.25,.25,0,.25,.25,1,.5,.25,1,.25]
cases=[]
for stem in ['opacity-source','opacity-edited']:
 file=out/f'{stem}.pdf';document=fitz.open(file);assert len(document)==1
 page=document[0];drawings=page.get_drawings();trace=page.get_texttrace();samples=[]
 for i,obj in enumerate(manifest['objects']):
  x,y,w,h=obj['boxMm'];bounds=[x*72/25.4,y*72/25.4,(x+w)*72/25.4,(y+h)*72/25.4]
  matches=[d for d in drawings if max(abs(a-b)for a,b in zip(d['rect'],bounds))<.002]
  fills=[d for d in matches if d['fill'] is not None];lines=[d for d in matches if d['color'] is not None]
  expected_fill=0 if i==0 and stem=='opacity-edited'else fill_alphas[i]
  expected_line=.25 if i==0 and stem=='opacity-edited'else line_alphas[i]
  if expected_fill is None:assert not fills,obj['id']
  else:assert fills and all(abs(d['fill_opacity']-expected_fill)<.00001 for d in fills),(obj['id'],fills)
  assert lines and all(abs(d['stroke_opacity']-expected_line)<.00001 for d in lines),(obj['id'],lines)
  samples.append({'id':obj['id'],'fillAlpha':expected_fill,'lineAlpha':expected_line,'drawOperations':len(matches)})
 assert len(trace)==22
 assert all(abs(t['opacity']-1)<.00001 for t in trace),'Paint opacity leaked into text'
 assert 'HI' in page.get_text() if stem=='opacity-edited' else 'H' in page.get_text()
 page.get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(out/f'{stem}-pdf.png')
 cases.append({'file':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'pages':1,'paints':samples,'opaqueTextOperations':len(trace),'ok':True})
report={'ok':True,'reader':'PyMuPDF '+fitz.VersionBind,'scope':'Real UI PDF drawing-state audit. Text-alpha-limitation control still renders opaque and is not counted as reference equivalence. Fill/stroke chain values follow standard ordered math.','cases':cases}
(out/'independent-pdf.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'ok':True,'files':len(cases),'paintPairs':sum(len(c['paints'])for c in cases),'opaqueTextOperations':sum(c['opaqueTextOperations']for c in cases)}))
