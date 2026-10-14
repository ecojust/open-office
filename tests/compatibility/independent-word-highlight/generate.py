#!/usr/bin/env python3
"""Author controlled ODT and OOXML inputs; retain complete native DOCX outputs.

ODT character background exports as separate standard shading, so the highlight input is
explicitly synthetic DOCX. Its OOXML semantics are authored before conversion.
No native DOCX output is stripped or rewritten.
"""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from datetime import datetime, timezone
import argparse, hashlib, json, platform, re, shutil, subprocess, tempfile, zipfile

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location('word_corpus', ROOT.parent / 'independent-word' / 'generate.py')
corpus = module_from_spec(spec); spec.loader.exec_module(corpus)
spec = spec_from_file_location('highlight_inspector', ROOT / 'inspect.py')
inspector = module_from_spec(spec); spec.loader.exec_module(inspector)
spec = spec_from_file_location('background_inspector', ROOT.parent / 'independent-word-background' / 'inspect.py')
background_inspector = module_from_spec(spec); spec.loader.exec_module(background_inspector)
PALETTE = {'none':None,'black':'000000','blue':'0000FF','cyan':'00FFFF','green':'00FF00','magenta':'FF00FF','red':'FF0000','yellow':'FFFF00','white':'FFFFFF','darkBlue':'000080','darkCyan':'008080','darkGreen':'008000','darkMagenta':'800080','darkRed':'800000','darkYellow':'808000','darkGray':'808080','lightGray':'C0C0C0'}

def chars(text, **style):
    return [{'character':c,'fontSize':12,'verticalAlign':'baseline','strike':'none','underline':False,'highlight':'none',**style} for c in text]

def authored():
    paragraphs, expected = [], []
    for color in PALETTE:
        text = color + ' 中文😀'
        foreground = '<w:color w:val="FFFFFF"/>' if color in ['black','blue','darkBlue','darkCyan','darkGreen','darkMagenta','darkRed','darkGray'] else ''
        paragraphs.append(f'<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr>{foreground}<w:highlight w:val="{color}"/></w:rPr><w:t>{text}</w:t></w:r></w:p>')
        expected.append(chars(text,highlight=color))
    paragraphs.extend([
        '<w:p><w:pPr><w:pStyle w:val="YellowParagraph"/></w:pPr><w:r><w:t xml:space="preserve">Inherited </w:t></w:r><w:r><w:rPr><w:highlight w:val="none"/></w:rPr><w:t>clear</w:t></w:r><w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:rStyle w:val="IgnoredBlue"/></w:rPr><w:t>Character style background ignored</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="YellowParagraph"/></w:pPr><w:r><w:rPr><w:rStyle w:val="IgnoredBlue"/></w:rPr><w:t>Paragraph highlight survives character style</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:dstrike/><w:sz w:val="36"/><w:highlight w:val="cyan"/><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>Combo 中文😀</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Edit target</w:t></w:r></w:p>',
    ])
    expected.extend([
        chars('Inherited ',highlight='yellow')+chars('clear')+chars(' tail',highlight='yellow'),
        chars('Character style background ignored'),chars('Paragraph highlight survives character style',highlight='yellow'),
        chars('Combo 中文😀',highlight='cyan',fontSize=18,verticalAlign='superscript',strike='double',underline=True),chars('Edit target'),
    ])
    return paragraphs, expected

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--soffice',default='soffice');parser.add_argument('--output',type=Path,default=ROOT);args=parser.parse_args()
    executable=shutil.which(args.soffice)
    if not executable: raise SystemExit('LibreOffice executable not found')
    output=args.output.resolve();source=output/'source';native=output/'libreoffice';inventory=output/'inventory'
    for d in [source,native,inventory]:d.mkdir(parents=True,exist_ok=True)
    version=subprocess.check_output([executable,'--version'],text=True,timeout=20).strip()
    (source/'styles.xml').write_text(corpus.STYLES,encoding='utf-8')
    cases=[{'name':'highlight-template','body':'<text:p text:style-name="Standard">Template</text:p>'},{'name':'unsupported-background','automaticStyles':'<style:style style:name="Background" style:family="text"><style:text-properties fo:background-color="#ffff00"/></style:style>','body':'<text:p text:style-name="Standard"><text:span text:style-name="Background">ODT character background is shading</text:span></text:p>'}]
    for case in cases:
        content=corpus.odt_content(case);(source/(case['name']+'.content.xml')).write_text(content,encoding='utf-8');corpus.write_odt(source/(case['name']+'.odt'),content)
    commands=[]
    def convert(inputs,destination,profile):
        command=[executable,'--headless',f'-env:UserInstallation={profile.as_uri()}','--convert-to','docx:Office Open XML Text','--outdir',str(destination),*[str(x) for x in inputs]]
        result=subprocess.run(command,capture_output=True,text=True,timeout=60,check=True);commands.append({'argv':command,'stdout':result.stdout,'stderr':result.stderr,'exitCode':result.returncode})
        for i in inputs:
            if not (destination/(i.stem+'.docx')).exists():raise RuntimeError('Native conversion produced no output: '+result.stdout+result.stderr)
    with tempfile.TemporaryDirectory(prefix='open-office-highlight-corpus-') as temporary:
        temp=Path(temporary);convert([source/(c['name']+'.odt') for c in cases],temp,temp/'odt-profile')
        shutil.copyfile(temp/'highlight-template.docx',source/'native-highlight-template.docx')
        shutil.copyfile(temp/'unsupported-background.docx',native/'unsupported-background.docx')
        paragraphs,expected=authored();synthetic=source/'highlight.docx'
        with zipfile.ZipFile(source/'native-highlight-template.docx') as template,zipfile.ZipFile(synthetic,'w',zipfile.ZIP_DEFLATED) as target:
            for name in template.namelist():
                data=template.read(name)
                if name=='word/document.xml':
                    xml=data.decode();section=re.search(r'<w:sectPr\b.*?</w:sectPr>',xml,re.S).group(0);xml=re.sub(r'<w:body>.*?</w:body>','<w:body>'+''.join(paragraphs)+section+'</w:body>',xml,flags=re.S);data=xml.encode()
                if name=='word/styles.xml':
                    extra='<w:style w:type="paragraph" w:styleId="YellowParagraph"><w:name w:val="YellowParagraph"/><w:basedOn w:val="Normal"/><w:rPr><w:highlight w:val="yellow"/></w:rPr></w:style><w:style w:type="character" w:styleId="IgnoredBlue"><w:name w:val="IgnoredBlue"/><w:rPr><w:highlight w:val="blue"/></w:rPr></w:style>'
                    data=data.decode().replace('</w:styles>',extra+'</w:styles>').encode()
                target.writestr(name,data)
        if [p['characters'] for p in inspector.inspect(synthetic)['paragraphs']]!=expected:raise RuntimeError('Synthetic input differs from independently authored contract')
        convert([synthetic],native,temp/'docx-profile')
    resolved=inspector.inspect(native/'highlight.docx')
    if [p['characters'] for p in resolved['paragraphs']]!=expected:raise RuntimeError('Native DOCX conversion changed authored highlight contract')
    for name in ['highlight','unsupported-background']:
        (inventory/(name+'.json')).write_text(json.dumps(corpus.inspect_docx(native/(name+'.docx')),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (inventory/'highlight-semantics.json').write_text(json.dumps(resolved,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    marker_expected=[{'backgroundColor':'#FFFF00'}]
    marker_resolved=background_inspector.inspect(native/'unsupported-background.docx')
    if [p['paragraphMarkStyle'] for p in marker_resolved['paragraphs']]!=marker_expected:raise RuntimeError('Native ODT paragraph marker differs from the independently inventoried contract')
    manifest={'formatVersion':1,'generatedAtUtc':datetime.now(timezone.utc).isoformat(),'generator':'generate.py','libreoffice':{'executable':executable,'version':version},'platform':platform.platform(),'provenance':'The source/highlight.docx is explicitly synthetic OOXML authored in a native template; LibreOffice opens/resaves it to a complete untouched native DOCX. Separately authored ODT character background is a positive control for independent body and paragraph-marker shading (legacy filename retained). Native DOCX outputs are never rewritten or stripped.','conversion':commands,'palette':PALETTE,'fixtures':[
      {'name':'highlight','purpose':'17 standard highlight values, direct none reset over paragraph inheritance, ignored character-style highlight and combined script/strike/underline.','source':'source/highlight.docx','sourceKind':'synthetic-docx-from-native-template','sourceSha256':corpus.sha256(source/'highlight.docx'),'docx':'libreoffice/highlight.docx','docxSha256':corpus.sha256(native/'highlight.docx'),'docxBytes':(native/'highlight.docx').stat().st_size,'inventory':'inventory/highlight.json','expectedParagraphs':[''.join(c['character'] for c in p) for p in expected],'expectedSemantics':{'characters':expected}},
      {'name':'unsupported-background','purpose':'Complete native ODT character background and independent paragraph-marker shading are supported separately; historical filename retained unchanged.','source':'source/unsupported-background.odt','sourceKind':'original-odt','sourceSha256':corpus.sha256(source/'unsupported-background.odt'),'docx':'libreoffice/unsupported-background.docx','docxSha256':corpus.sha256(native/'unsupported-background.docx'),'docxBytes':(native/'unsupported-background.docx').stat().st_size,'inventory':'inventory/unsupported-background.json','expectedParagraphMarkers':marker_expected,'expectedParagraphs':['ODT character background is shading']},
    ]}
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'libreoffice':version,'fixtures':[{'name':f['name'],'bytes':f['docxBytes'],'sha256':f['docxSha256']} for f in manifest['fixtures']]},indent=2))

if __name__=='__main__':main()
