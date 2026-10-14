#!/usr/bin/env python3
"""Add separately authored inline ODT and controlled inheritance DOCX positives.

Original background.odt/background.docx and combined-layers.docx are retained
byte-for-byte. The original full-paragraph ODT export is a positive control for
independent paragraph-marker formatting, which is deliberately not stripped.
"""
import argparse, importlib.util, json, re, shutil, subprocess, tempfile, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('background_source',ROOT/'generate.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
spec=importlib.util.spec_from_file_location('background_inspector',ROOT/'inspect.py');inspector=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspector)
chars=g.chars
COMBO={'backgroundColor':'#13579B','fontSize':18,'verticalAlign':'superscript','strike':'double','underline':True}
INLINE=[chars('Before ')+chars('RGB 中文😀',backgroundColor='#ABCDEF')+chars(' after'),chars('Before ')+chars('Combo 中文😀',**COMBO)+chars(' after'),chars('Inherited ',backgroundColor='#FEDCBA')+chars('clear')+chars(' tail',backgroundColor='#FEDCBA'),chars('Named ')+chars('蓝😀',backgroundColor='#123456')+chars(' tail')]
INLINE_CASE={'automaticStyles':g.CASE['automaticStyles'],'body':'<text:p text:style-name="Standard">Before <text:span text:style-name="DirectRGB">RGB 中文😀</text:span> after</text:p><text:p text:style-name="Standard">Before <text:span text:style-name="Combo">Combo 中文😀</text:span> after</text:p><text:p text:style-name="YellowParagraph">Inherited <text:span text:style-name="ClearBackground">clear</text:span> tail</text:p><text:p text:style-name="Standard">Named <text:span text:style-name="BlueBackground">蓝😀</text:span> tail</text:p>'}
# Authored independently from input XML, never inferred from application output.
INHERITANCE=g.EXPECTED+[chars('Derived named background',backgroundColor='#123456'),chars('Named clear over paragraph')]
STYLE_DEFINITIONS='<w:style w:type="character" w:styleId="BgBlue"><w:name w:val="Bg Blue"/><w:rPr><w:shd w:val="clear" w:fill="123456"/></w:rPr></w:style><w:style w:type="character" w:styleId="BgDerived"><w:name w:val="Bg Derived"/><w:basedOn w:val="BgBlue"/></w:style><w:style w:type="character" w:styleId="BgClear"><w:name w:val="Bg Clear"/><w:basedOn w:val="BgBlue"/><w:rPr><w:shd w:val="clear" w:fill="auto"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="BgParagraph"><w:name w:val="Bg Paragraph"/><w:basedOn w:val="Normal"/><w:rPr><w:shd w:val="clear" w:fill="FEDCBA"/></w:rPr></w:style>'
def r(text,props=''):return '<w:r>'+('<w:rPr>'+props+'</w:rPr>' if props else '')+'<w:t xml:space="preserve">'+text+'</w:t></w:r>'
def p(runs,style='Normal'):return '<w:p><w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>'+runs+'</w:p>'
BODY=''.join([p(r('Plain baseline')),p(r('Named RGB 中文😀','<w:rStyle w:val="BgBlue"/>')),p(r('Inherited ')+r('clear','<w:shd w:val="clear" w:fill="auto"/>')+r(' tail'),'BgParagraph'),p(r('Direct RGB 中文😀','<w:shd w:val="clear" w:fill="ABCDEF"/>')),p(r('Black','<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:fill="000000"/>')+r(' ')+r('White','<w:shd w:val="clear" w:fill="FFFFFF"/>')),p(r('Combo 中文😀','<w:dstrike/><w:sz w:val="36"/><w:szCs w:val="36"/><w:u w:val="single"/><w:shd w:val="clear" w:fill="13579B"/><w:vertAlign w:val="superscript"/>')),p(r('Edit target')),p(r('Derived named background','<w:rStyle w:val="BgDerived"/>')),p(r('Named clear over paragraph','<w:rStyle w:val="BgClear"/>'),'BgParagraph')])
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--soffice',default='soffice');ap.add_argument('--output',type=Path,default=ROOT);a=ap.parse_args();out=a.output.resolve();source=out/'source';native=out/'libreoffice';inventory=out/'inventory';manifest=json.loads((out/'manifest.json').read_text());before={f['docx']:g.corpus.sha256(out/f['docx']) for f in manifest['fixtures'] if f['name'] not in ['inline-background','inheritance']};executable=shutil.which(a.soffice)
 if not executable:raise SystemExit('Missing soffice')
 content=g.corpus.odt_content(INLINE_CASE);(source/'inline-background.content.xml').write_text(content);g.corpus.write_odt(source/'inline-background.odt',content)
 with zipfile.ZipFile(native/'background.docx') as template,zipfile.ZipFile(source/'inheritance.docx','w',zipfile.ZIP_DEFLATED) as dest:
  for name in template.namelist():
   data=template.read(name)
   if name=='word/document.xml':
    xml=data.decode();section=re.search(r'<w:sectPr\b.*?</w:sectPr>',xml,re.S).group(0);data=re.sub(r'<w:body>.*?</w:body>','<w:body>'+BODY+section+'</w:body>',xml,flags=re.S).encode()
   elif name=='word/styles.xml':data=data.decode().replace('</w:styles>',STYLE_DEFINITIONS+'</w:styles>').encode()
   dest.writestr(name,data)
 with tempfile.TemporaryDirectory(prefix='word-background-supplement-') as tmp:
  for name,kind,ext,expected in [('inline-background','original-odt','odt',INLINE),('inheritance','synthetic-docx-from-native-template','docx',INHERITANCE)]:
   src=source/f'{name}.{ext}';command=[executable,'-env:UserInstallation='+Path(tmp,name).as_uri(),'--headless','--convert-to','docx:Office Open XML Text','--outdir',str(native),str(src)];result=subprocess.run(command,text=True,capture_output=True,check=True,timeout=60);target=native/f'{name}.docx';resolved=inspector.inspect(target);assert [p['characters'] for p in resolved['paragraphs']]==expected,name
   assert not any(p['paragraphMarkStyle'] for p in resolved['paragraphs']), 'Inline fixture unexpectedly introduced independent marker properties'
   f={'name':name,'source':f'source/{src.name}','sourceKind':kind,'sourceSha256':g.corpus.sha256(src),'docx':f'libreoffice/{target.name}','docxSha256':g.corpus.sha256(target),'docxBytes':target.stat().st_size,'expectedParagraphs':[''.join(c['character'] for c in para) for para in expected],'expectedSemantics':{'characters':expected}}
   manifest['fixtures']=[old for old in manifest['fixtures'] if old['name']!=name]+[f];manifest['conversion'].append({'argv':command,'stdout':result.stdout,'stderr':result.stderr,'exitCode':result.returncode})
   (inventory/f'{name}.json').write_text(json.dumps(g.corpus.inspect_docx(target),ensure_ascii=False,indent=2)+'\n');(inventory/f'{name}-semantics.json').write_text(json.dumps(resolved,ensure_ascii=False,indent=2)+'\n');print(name,f['docxSha256'],'positive')
 for f in manifest['fixtures']:
  if f['name']=='background':
   f.pop('expectUnsupported',None)
   f['expectedParagraphMarkers']=g.EXPECTED_MARKERS
   f['purpose']='Complete original ODT export with independent paragraph-marker shading and combined size/script/strike/underline; partial-body edits must preserve marker properties.'
   assert [p['paragraphMarkStyle'] for p in inspector.inspect(out/f['docx'])['paragraphs']]==g.EXPECTED_MARKERS
 manifest['provenance']='Complete native outputs preserved unchanged. Original full-paragraph ODT, separately authored inline ODT and explicitly synthetic inheritance/combined-layer DOCX inputs are positives. Character expectations are authored before native conversion; direct marker properties are independently inventoried from the untouched original native output.';manifest['supplementalGenerator']='generate_supplemental.py';(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');assert before=={p:g.corpus.sha256(out/p) for p in before}
if __name__=='__main__':main()
