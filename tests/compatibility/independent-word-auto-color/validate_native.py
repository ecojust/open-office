#!/usr/bin/env python3
"""Verify immutable native auto-color corpus using ZIP/XML and actual PDF bytes."""
from pathlib import Path
import hashlib,importlib.util,json,sys,zipfile,xml.etree.ElementTree as E
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('corpus_inspect',ROOT/'inspect_docx.py');ins=importlib.util.module_from_spec(spec);spec.loader.exec_module(ins)
NS={'office':'urn:oasis:names:tc:opendocument:xmlns:office:1.0','style':'urn:oasis:names:tc:opendocument:xmlns:style:1.0','text':'urn:oasis:names:tc:opendocument:xmlns:text:1.0','fo':'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'}
def q(p,n):return '{'+NS[p]+'}'+n
checks=0
def eq(actual,expected,label):
 global checks
 checks+=1
 assert actual==expected,f'{label}: {actual!r} != {expected!r}'
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def odt(path):
 with zipfile.ZipFile(path) as z:
  assert z.testzip() is None
  roots=[E.fromstring(z.read(n)) for n in ['styles.xml','content.xml']]
 styles={s.get(q('style','name')):s for rt in roots for s in rt.findall('.//style:style',NS)}
 defaults='auto'
 def apply(parent,props):
  if props is None:return parent
  if props.get(q('style','use-window-font-color'))=='true':return 'auto'
  if q('fo','color') in props.attrib:return props.get(q('fo','color')).upper()
  return parent
 for rt in roots:
  for s in rt.findall('.//style:default-style',NS):
   if s.get(q('style','family'))=='paragraph':defaults=apply(defaults,s.find('style:text-properties',NS))
 def style_color(name,current,seen=()):
  if name not in styles:return current
  assert name not in seen
  st=styles[name];base=style_color(st.get(q('style','parent-style-name')),current,(*seen,name))
  return apply(base,st.find('style:text-properties',NS))
 def chars(node,color):
  color=style_color(node.get(q('text','style-name')),color)
  result=[dict(character=c,color=color) for c in (node.text or '')]
  for child in node:
   result+=chars(child,color)
   result +=[dict(character=c,color=color) for c in (child.tail or '')]
  return result
 return [chars(p,defaults) for p in roots[1].findall('.//office:body/office:text/text:p',NS)]
def painting(style):
 color=style.get('color','auto')
 if color!='auto':return int(color[1:],16)
 bg=style.get('backgroundColor','none');bg='FFFFFF' if bg=='none' else bg[1:]
 channels=[int(bg[i:i+2],16) for i in (0,2,4)]
 if bg.upper()=='729FCF':dark=(channels[0]*76+channels[1]*151+channels[2]*29)//256<=62
 else:
  linear=[(c/255)/12.92 if c/255<.04045 else ((c/255+.055)/1.055)**2.4 for c in channels]
  dark=int(sum(a*b for a,b in zip(linear,[.2126,.7152,.0722]))*255)<=87
 return 0xFFFFFF if dark else 0

def snapshot():
 manifest=json.loads((ROOT/'manifest.json').read_text());data={'fixtures':{},'editing':{}}
 for f in manifest['fixtures']:
  data['fixtures'][f['name']]={}
  for key,path in [('source',f['source']),('docx',f['docx']),('secondDocx',f['secondDocx']['path'])]:data['fixtures'][f['name']][key]=ins.inspect(ROOT/path)
  data['fixtures'][f['name']]['odt']=odt(ROOT/f['odt']['path'])
  data['fixtures'][f['name']]['pdf']=ins.pdf(ROOT/f['pdf']['path']);data['fixtures'][f['name']]['secondPdf']=ins.pdf(ROOT/f['secondPdf']['path'])
 for f in manifest.get('editingFixtures',[]):
  data['editing'][f['name']]={k:ins.inspect(ROOT/f[k]) for k in ['source','docx']}
  data['editing'][f['name']]['odt']=odt(ROOT/f['odt']['path']);data['editing'][f['name']]['pdf']=ins.pdf(ROOT/f['pdf']['path'])
 return json.loads(json.dumps(data))

def main():
 data=snapshot()
 if '--write-expected' in sys.argv:
  (ROOT/'expected.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');print('Frozen native snapshot');return
 frozen=json.loads((ROOT/'expected.json').read_text());manifest=json.loads((ROOT/'manifest.json').read_text());provenance=json.loads((ROOT/'research-provenance.json').read_text())
 for a in provenance['artifacts']:eq(digest(ROOT/a['path']),a['sha256'],'artifact '+a['path'])
 for group in ['fixtures','editing']:
  eq(list(data[group]),list(frozen[group]),group+' names')
  for name,entry in data[group].items():
   for kind,value in entry.items():eq(value,frozen[group][name][kind],group+'/'+name+'/'+kind+' exact independent snapshot')
 for f in manifest['fixtures']:
  e=data['fixtures'][f['name']];a=e['source']['paragraphs'];b=e['docx']['paragraphs'];c=e['secondDocx']['paragraphs']
  eq(len(a),len(b),f['name']+' count');eq(len(b),len(c),f['name']+' second count')
  pdf={span['text']:span for span in e['pdf']};pdf2={span['text']:span for span in e['secondPdf']}
  for i,p in enumerate(a):
   eq(p['characters'],b[i]['characters'],f['name']+str(i)+' source/native character semantics')
   eq(b[i]['characters'],c[i]['characters'],f['name']+str(i)+' first/second character semantics')
   eq([{k:char[k] for k in ['character','color']} for char in p['characters']],e['odt'][i],f['name']+str(i)+' ODT foreground semantics')
   if p['text']:
    eq(pdf[p['text']]['color'],painting(p['runs'][0]['style']),f['name']+str(i)+' native PDF painting')
    eq(pdf[p['text']]['color'],pdf2[p['text']]['color'],f['name']+str(i)+' reopened PDF painting')
 for f in manifest.get('editingFixtures',[]):
  e=data['editing'][f['name']];paras=e['docx']['paragraphs'];expected=f['typedColor']
  eq(paras[-1]['text'],'x',f['name']+' typed x')
  eq(paras[-1]['characters'][0]['color'],expected,f['name']+' typed color')
  eq(e['odt'][-1],[{'character':'x','color':expected}],f['name']+' ODT typed color')
 inventory=ROOT/'inventory.json'
 if inventory.exists():
  for a in json.loads(inventory.read_text())['files']:eq(digest(ROOT/a['path']),a['sha256'],'sealed '+a['path'])
 print(json.dumps(dict(ok=True,checks=checks,basePackages=len(manifest['fixtures']),baseParagraphs=sum(len(e['source']['paragraphs']) for e in data['fixtures'].values()),editingPackages=len(manifest.get('editingFixtures',[])),nativeWordRuntime=False,productCodeInvoked=False),indent=2))
if __name__=='__main__':main()
