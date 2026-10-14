#!/usr/bin/env python3
"""Original ODT character backgrounds and untouched native DOCX conversions.

A second explicitly synthetic DOCX input combines OOXML highlight and shading;
its untouched native resave is separately labeled. No native output is stripped.
"""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import argparse, json, re, shutil, subprocess, tempfile, zipfile
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parent
spec=spec_from_file_location('word_corpus',ROOT.parent/'independent-word'/'generate.py');corpus=module_from_spec(spec);spec.loader.exec_module(corpus)

corpus.STYLES=corpus.STYLES.replace(' </office:styles>','''
<style:style style:name="BlueBackground" style:family="text"><style:text-properties fo:background-color="#123456"/></style:style>
<style:style style:name="YellowParagraph" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:background-color="#fedcba"/></style:style>
 </office:styles>''')

def chars(text,**style):
 return [{'character':c,'fontSize':12,'verticalAlign':'baseline','strike':'none','underline':False,'highlight':'none','backgroundColor':'none',**style} for c in text]
EXPECTED=[chars('Plain baseline'),chars('Named RGB 中文😀',backgroundColor='#123456'),chars('Inherited ',backgroundColor='#FEDCBA')+chars('clear')+chars(' tail',backgroundColor='#FEDCBA'),chars('Direct RGB 中文😀',backgroundColor='#ABCDEF'),chars('Black',backgroundColor='#000000')+chars(' ')+chars('White',backgroundColor='#FFFFFF'),chars('Combo 中文😀',backgroundColor='#13579B',fontSize=18,verticalAlign='superscript',strike='double',underline=True),chars('Edit target')]
# Independently inventoried direct marker properties of the original native export.
EXPECTED_MARKERS=[{}, {}, {}, {'backgroundColor': '#ABCDEF'}, {}, {'underline': True, 'strike': 'double', 'backgroundColor': '#13579B', 'verticalAlign': 'superscript', 'fontSize': 18, 'fontSizeCs': 18}, {}]
CASE={'name':'background','purpose':'Original ODT named/direct RGB character background, paragraph inheritance, explicit transparent reset and script/strike/underline combination.','automaticStyles':'''<style:style style:name="ClearBackground" style:family="text"><style:text-properties fo:background-color="transparent"/></style:style><style:style style:name="DirectRGB" style:family="text"><style:text-properties fo:background-color="#abcdef"/></style:style><style:style style:name="Black" style:family="text"><style:text-properties fo:background-color="#000000" fo:color="#ffffff"/></style:style><style:style style:name="White" style:family="text"><style:text-properties fo:background-color="#ffffff"/></style:style><style:style style:name="Combo" style:family="text"><style:text-properties fo:background-color="#13579b" fo:font-size="18pt" style:font-size-asian="18pt" style:font-size-complex="18pt" style:text-position="super 58%" style:text-line-through-style="solid" style:text-line-through-type="double" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>''','body':'''<text:p text:style-name="Standard">Plain baseline</text:p><text:p text:style-name="Standard"><text:span text:style-name="BlueBackground">Named RGB 中文😀</text:span></text:p><text:p text:style-name="YellowParagraph">Inherited <text:span text:style-name="ClearBackground">clear</text:span> tail</text:p><text:p text:style-name="Standard"><text:span text:style-name="DirectRGB">Direct RGB 中文😀</text:span></text:p><text:p text:style-name="Standard"><text:span text:style-name="Black">Black</text:span> <text:span text:style-name="White">White</text:span></text:p><text:p text:style-name="Standard"><text:span text:style-name="Combo">Combo 中文😀</text:span></text:p><text:p text:style-name="Standard">Edit target</text:p>''','paragraphs':[''.join(c['character'] for c in p) for p in EXPECTED],'expectedSemantics':{'characters':EXPECTED}}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--soffice',default='soffice');parser.add_argument('--output',type=Path,default=ROOT);args=parser.parse_args();output=args.output.resolve();source=output/'source';native=output/'libreoffice';inventory=output/'inventory'
 for d in [source,native,inventory]:d.mkdir(parents=True,exist_ok=True)
 executable=shutil.which(args.soffice)
 if not executable:raise SystemExit('LibreOffice executable not found')
 version=subprocess.check_output([executable,'--version'],text=True,timeout=20).strip();commands=[]
 (source/'styles.xml').write_text(corpus.STYLES,encoding='utf8');content=corpus.odt_content(CASE);(source/'background.content.xml').write_text(content,encoding='utf8');corpus.write_odt(source/'background.odt',content)
 def convert(inp,destination,profile):
  command=[executable,'--headless',f'-env:UserInstallation={profile.as_uri()}','--convert-to','docx:Office Open XML Text','--outdir',str(destination),str(inp)];r=subprocess.run(command,capture_output=True,text=True,timeout=60,check=True);commands.append({'argv':command,'stdout':r.stdout,'stderr':r.stderr,'exitCode':r.returncode});target=destination/(inp.stem+'.docx')
  if not target.exists():raise RuntimeError(r.stdout+r.stderr)
  return target
 with tempfile.TemporaryDirectory(prefix='open-office-background-corpus-') as temporary:
  temp=Path(temporary);convert(source/'background.odt',native,temp/'odt-profile')
  # The combined-layer source is deliberately synthetic OOXML, not ODT output.
  combined=[
   ('Highlight overlays background','<w:highlight w:val="yellow"/><w:shd w:val="clear" w:fill="123456"/>',{'highlight':'yellow','backgroundColor':'#123456'}),
   ('No highlight keeps background','<w:highlight w:val="none"/><w:shd w:val="clear" w:fill="ABCDEF"/>',{'backgroundColor':'#ABCDEF'}),
   ('Highlight with no background','<w:highlight w:val="cyan"/><w:shd w:val="clear" w:fill="auto"/>',{'highlight':'cyan'}),
   ('Both layers absent','<w:highlight w:val="none"/><w:shd w:val="clear" w:fill="auto"/>',{}),
   ('Combo 中文😀','<w:dstrike/><w:sz w:val="36"/><w:highlight w:val="magenta"/><w:u w:val="single"/><w:shd w:val="clear" w:fill="13579B"/><w:vertAlign w:val="superscript"/>',{'fontSize':18,'highlight':'magenta','backgroundColor':'#13579B','verticalAlign':'superscript','strike':'double','underline':True}),
  ];combined_expected=[chars(text,**style) for text,props,style in combined];body=''.join('<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr>'+props+'</w:rPr><w:t>'+text+'</w:t></w:r></w:p>' for text,props,style in combined)
  with zipfile.ZipFile(native/'background.docx') as base,zipfile.ZipFile(source/'combined-layers.docx','w',zipfile.ZIP_DEFLATED) as dst:
   for name in base.namelist():
    data=base.read(name)
    if name=='word/document.xml':
     xml=data.decode();section=re.search(r'<w:sectPr\b.*?</w:sectPr>',xml,re.S).group(0);data=re.sub(r'<w:body>.*?</w:body>','<w:body>'+body+section+'</w:body>',xml,flags=re.S).encode()
    dst.writestr(name,data)
  convert(source/'combined-layers.docx',native,temp/'combined-profile')
 fixtures=[]
 for name,kind,inp,expected in [('background','original-odt','source/background.odt',EXPECTED),('combined-layers','synthetic-docx-from-native-template','source/combined-layers.docx',combined_expected)]:
  (inventory/(name+'.json')).write_text(json.dumps(corpus.inspect_docx(native/(name+'.docx')),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
  fixtures.append({'name':name,'source':inp,'sourceKind':kind,'sourceSha256':corpus.sha256(output/inp),'docx':f'libreoffice/{name}.docx','docxSha256':corpus.sha256(native/(name+'.docx')),'docxBytes':(native/(name+'.docx')).stat().st_size,'expectedParagraphs':[''.join(c['character'] for c in p) for p in expected],'expectedSemantics':{'characters':expected}})
 for fixture in fixtures:
  if fixture['name']=='background':
   fixture['expectedParagraphMarkers']=EXPECTED_MARKERS
   fixture['purpose']='Complete original ODT export with independent paragraph-marker shading and combined size/script/strike/underline; partial-body edits must preserve marker properties.'
 spec=spec_from_file_location('background_inspector',ROOT/'inspect.py');inspector=module_from_spec(spec);spec.loader.exec_module(inspector)
 for fixture in fixtures:
  resolved=inspector.inspect(output/fixture['docx'])
  if [p['characters'] for p in resolved['paragraphs']]!=fixture['expectedSemantics']['characters']:raise RuntimeError('Native conversion differs from authored ODT/OOXML contract: '+fixture['name'])
  if fixture['name']=='background' and [p['paragraphMarkStyle'] for p in resolved['paragraphs']]!=EXPECTED_MARKERS:raise RuntimeError('Native paragraph marker differs from the independently inventoried contract')
  (inventory/(fixture['name']+'-semantics.json')).write_text(json.dumps(resolved,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
 manifest={'formatVersion':1,'generatedAtUtc':datetime.now(timezone.utc).isoformat(),'generator':'generate.py','libreoffice':{'executable':executable,'version':version},'provenance':'Original ODT background fixture and separately labeled synthetic highlight+background input, each converted by native LibreOffice. Complete native DOCX outputs preserved without stripping or rewriting. Expected character semantics authored from inputs before conversion; expected direct marker properties independently inventoried from the untouched native output.','conversion':commands,'fixtures':fixtures};(output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps({'libreoffice':version,'fixtures':[{k:f[k] for k in ['name','docxBytes','docxSha256']} for f in fixtures]},indent=2))
if __name__=='__main__':main()
