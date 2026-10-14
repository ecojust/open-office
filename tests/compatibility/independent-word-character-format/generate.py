#!/usr/bin/env python3
"""Create original ODT sources and retain complete native LibreOffice DOCX outputs."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
import json

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location('word_corpus', ROOT.parent / 'independent-word' / 'generate.py')
corpus = module_from_spec(spec)
spec.loader.exec_module(corpus)

corpus.STYLES = corpus.STYLES.replace(' </office:styles>', '''
  <style:style style:name="Super" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
  <style:style style:name="Sub" style:family="text"><style:text-properties style:text-position="sub 58%"/></style:style>
  <style:style style:name="SingleStrike" style:family="text"><style:text-properties style:text-line-through-style="solid" style:text-line-through-type="single"/></style:style>
  <style:style style:name="DoubleStrike" style:family="text"><style:text-properties style:text-line-through-style="solid" style:text-line-through-type="double"/></style:style>
  <style:style style:name="ScriptParagraph" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties style:text-position="super 58%" style:text-line-through-style="solid" style:text-line-through-type="single" fo:font-size="18pt"/></style:style>
  <style:style style:name="SubParagraph" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties style:text-position="sub 58%" style:text-line-through-style="solid" style:text-line-through-type="double" fo:font-size="16pt"/></style:style>
 </office:styles>''')

def chars(text, **style):
    return [{'character': char, 'fontSize': 12, 'strike': 'none', 'verticalAlign': 'baseline', 'underline': False, **style} for char in text]

text1 = 'Normal SUP中😀 SUB文🚀 single double end.'
text2 = 'Inherited superscript reset baseline inherited again.'
text3 = 'Inherited subscript reset none tail.'
text4 = 'Underline double 中文😀 size24 size9'
text5 = 'Edit target'
expected = [
    chars('Normal ') + chars('SUP中😀', verticalAlign='superscript') + chars(' ') + chars('SUB文🚀', verticalAlign='subscript') + chars(' ') + chars('single', strike='single') + chars(' ') + chars('double', strike='double') + chars(' end.'),
    chars('Inherited superscript ', fontSize=18, verticalAlign='superscript', strike='single') + chars('reset baseline', fontSize=18) + chars(' inherited again.', fontSize=18, verticalAlign='superscript', strike='single'),
    chars('Inherited subscript ', fontSize=16, verticalAlign='subscript', strike='double') + chars('reset none', fontSize=16) + chars(' tail.', fontSize=16, verticalAlign='subscript', strike='double'),
    chars('Underline double 中文😀', underline=True, strike='double', verticalAlign='superscript') + chars(' ') + chars('size24', fontSize=24, verticalAlign='superscript') + chars(' ') + chars('size9', fontSize=9, verticalAlign='subscript'),
    chars(text5),
]
corpus.CASES = [{
    'name': 'character-format',
    'purpose': 'Standard automatic super/subscript, inherited paragraph script and strike, explicit reset, single/double strike, underline combination and logical font sizes with CJK/emoji.',
    'automaticStyles': '''
<style:style style:name="Reset" style:family="text"><style:text-properties style:text-position="0% 100%" style:text-line-through-style="none" style:text-line-through-type="none"/></style:style>
<style:style style:name="Combined" style:family="text"><style:text-properties style:text-position="super 58%" style:text-line-through-style="solid" style:text-line-through-type="double" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="LargeSuper" style:family="text"><style:text-properties style:text-position="super 58%" fo:font-size="24pt"/></style:style>
<style:style style:name="SmallSub" style:family="text"><style:text-properties style:text-position="sub 58%" fo:font-size="9pt"/></style:style>''',
    'body': '''<text:p text:style-name="Standard">Normal <text:span text:style-name="Super">SUP中😀</text:span> <text:span text:style-name="Sub">SUB文🚀</text:span> <text:span text:style-name="SingleStrike">single</text:span> <text:span text:style-name="DoubleStrike">double</text:span> end.</text:p><text:p text:style-name="ScriptParagraph">Inherited superscript <text:span text:style-name="Reset">reset baseline</text:span> inherited again.</text:p><text:p text:style-name="SubParagraph">Inherited subscript <text:span text:style-name="Reset">reset none</text:span> tail.</text:p><text:p text:style-name="Standard"><text:span text:style-name="Combined">Underline double 中文😀</text:span> <text:span text:style-name="LargeSuper">size24</text:span> <text:span text:style-name="SmallSub">size9</text:span></text:p><text:p text:style-name="Standard">Edit target</text:p>''',
    'paragraphs': [text1, text2, text3, text4, text5],
    'expectedSemantics': {'characters': expected},
}]

if __name__ == '__main__':
    if '--output' not in sys.argv: sys.argv.extend(['--output', str(ROOT)])
    corpus.main()
    inspector_spec = spec_from_file_location('character_inspector', ROOT / 'inspect.py')
    inspector = module_from_spec(inspector_spec)
    inspector_spec.loader.exec_module(inspector)
    output = Path(sys.argv[sys.argv.index('--output') + 1])
    for case in corpus.CASES:
        resolved = inspector.inspect(output / 'libreoffice' / (case['name'] + '.docx'))
        if [p['characters'] for p in resolved['paragraphs']] != case['expectedSemantics']['characters']:
            raise RuntimeError('Native conversion changed ODT-authored character expectations')
        (output / 'inventory' / (case['name'] + '-semantics.json')).write_text(json.dumps(resolved, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
