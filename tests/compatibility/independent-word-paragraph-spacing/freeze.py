#!/usr/bin/env python3
"""Copy complete, independently authored/native packages; never rewrites ZIPs."""
import hashlib
import json
import shutil
from pathlib import Path
import importlib.util

HERE = Path(__file__).resolve().parent
RESEARCH = Path('/workspace/open-office-research/libreoffice/paragraph-spacing-compatibility')
EDITING = RESEARCH.parent / 'paragraph-spacing-editing-explicit-color'
OLD_EDITING = RESEARCH.parent / 'paragraph-spacing-editing'
spec = importlib.util.spec_from_file_location('spacing_oracle', HERE/'inspect_docx.py')
oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
semantics = lambda p: [dict(text=x['text'], **x['style']) for x in oracle.inspect(p)['paragraphs']]

def copy(src, relative):
    out = HERE / relative; out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, out)
    assert sha(src) == sha(out)
    return dict(path=relative, sha256=sha(out))

if __name__ == '__main__':
    fixtures = []
    for name in ['supported-cases', 'document-default', 'geometry']:
        source = RESEARCH / (name+'.docx'); native = RESEARCH/'native-docx'/(name+'.docx')
        fixtures.append(dict(name=name, source=copy(source,'source/'+name+'.docx'),
            native=copy(native,'libreoffice/'+name+'.docx'),
            pdf=copy(RESEARCH/'native-pdf'/(name+'.pdf'),'libreoffice/'+name+'.pdf'),
            expected=semantics(native), sourceExpected=semantics(source)))
    actions = {'enter-start':dict(paragraph=0,offset=0,key='Enter'),
               'enter-middle':dict(paragraph=0,offset=1,key='Enter'),
               'enter-end':dict(paragraph=0,offset=3,key='Enter'),
               'merge-nonempty':dict(paragraph=1,offset=0,key='Backspace'),
               'merge-empty-first':dict(paragraph=1,offset=0,key='Backspace')}
    for name, action in actions.items():
        source = EDITING/'input'/('empty-first.docx' if name=='merge-empty-first' else 'two-paragraphs.docx')
        native = EDITING/'output'/(name+'.docx')
        fixtures.append(dict(name=name,source=copy(source,'source/'+name+'.docx'),
            native=copy(native,'libreoffice/'+name+'.docx'),
            pdf=copy(EDITING/'output'/(name+'.pdf'),'libreoffice/'+name+'.pdf'),
            expected=semantics(native),sourceExpected=semantics(source),action=action))
    rule_source = RESEARCH/'cases.docx'; rule_native = RESEARCH/'native-docx/cases.docx'
    fixtures.append(dict(name='rule-only',source=copy(rule_source,'source/rule-only.docx'),
        native=copy(rule_native,'libreoffice/rule-only.docx'),
        pdf=copy(RESEARCH/'native-pdf/cases.pdf','libreoffice/rule-only.pdf'),
        expected=semantics(rule_native),sourceExpected=semantics(rule_source)))
    fixtures.append(dict(name='automatic-color-native',
        source=copy(OLD_EDITING/'input/two-paragraphs.docx','source/automatic-color.docx'),
        native=copy(OLD_EDITING/'output/enter-start.docx','libreoffice/automatic-color.docx'),
        history='Original independently authored editing control omitted explicit color; native output uses automatic color, outside the existing color subset.',
        expected=semantics(OLD_EDITING/'output/enter-start.docx'),
        sourceExpected=semantics(OLD_EDITING/'input/two-paragraphs.docx')))
    for fixture in fixtures:
        source=fixture['source']; fixture['source']=source['path']; fixture['sourceSha256']=source['sha256']
        native=fixture.pop('native',source); fixture['docx']=native['path']; fixture['docxSha256']=native['sha256']
    provenance = []
    for folder,names in [(RESEARCH,['inventory.json','verification.json','check.py','report.json','supported-report.json','sha256.json','supported-sha256.json','probe-native.py','probe-supported.py']),
                         (EDITING,['paragraph-spacing-report.json','paragraph-spacing-driver.log','paragraph-spacing-NativeEdit.java','probe.py','sha256.json']),
                         (OLD_EDITING,['paragraph-spacing-report.json','paragraph-spacing-driver.log','paragraph-spacing-NativeEdit.java','probe.py','sha256.json'])]:
        for name in names:
            file=folder/name
            if file.exists():provenance.append(dict(path=str(file),sha256=sha(file)))
    (HERE/'manifest.json').write_text(json.dumps(dict(formatVersion=1,fixtures=fixtures),ensure_ascii=False,indent=2)+'\n')
    (HERE/'research-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print('Frozen',len(fixtures),'complete fixture pairs/negatives')
