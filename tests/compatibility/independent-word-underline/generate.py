#!/usr/bin/env python3
"""Author ODT and explicitly synthetic DOCX inputs; retain untouched native outputs."""
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import argparse
import json
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location('word_corpus', ROOT.parent / 'independent-word' / 'generate.py')
corpus = module_from_spec(spec)
spec.loader.exec_module(corpus)
spec = spec_from_file_location('underline_inspector', ROOT / 'inspect.py')
inspector = module_from_spec(spec)
spec.loader.exec_module(inspector)


def chars(text, **style):
    return [{'character': c, 'fontSize': 12, 'verticalAlign': 'baseline', 'strike': 'none', 'underline': False, 'highlight': 'none', 'backgroundColor': 'none', **style} for c in text]


def underline(kind, color='font-color'):
    return f'style:text-underline-style="solid" style:text-underline-type="{kind}" style:text-underline-width="auto" style:text-underline-color="{color}"'


ODT_STYLES = f'''
<style:style style:name="Single" style:family="text"><style:text-properties {underline('single')}/></style:style>
<style:style style:name="Double" style:family="text"><style:text-properties {underline('double')}/></style:style>
<style:style style:name="Clear" style:family="text"><style:text-properties style:text-underline-style="none"/></style:style>
<style:style style:name="ComboSuper" style:family="text"><style:text-properties {underline('double')} style:text-line-through-style="solid" style:text-line-through-type="double" style:text-position="super 58%" fo:font-size="18pt" style:font-size-asian="18pt" style:font-size-complex="18pt" fo:background-color="#13579b"/></style:style>
<style:style style:name="ComboSub" style:family="text"><style:text-properties {underline('double')} style:text-line-through-style="solid" style:text-line-through-type="single" style:text-position="sub 58%" fo:font-size="18pt" style:font-size-asian="18pt" style:font-size-complex="18pt"/></style:style>
'''
ODT_BODY = '''<text:p text:style-name="Standard">Plain baseline</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="Single">Single 中文😀</text:span> tail</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="Double">Double 中文😀</text:span> tail</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="Double">double <text:span text:style-name="Clear">clear</text:span> double</text:span> tail</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="ComboSuper">Super 中文😀</text:span> tail</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="ComboSub">Sub 中文😀</text:span> tail</text:p>
<text:p text:style-name="Standard"><text:span text:style-name="Single">single</text:span> <text:span text:style-name="Double">double</text:span> none</text:p>
<text:p text:style-name="Standard">Edit target</text:p>'''
ODT_EXPECTED = [
    chars('Plain baseline'),
    chars('Single 中文😀', underline=True) + chars(' tail'),
    chars('Double 中文😀', underline='double') + chars(' tail'),
    chars('double ', underline='double') + chars('clear') + chars(' double', underline='double') + chars(' tail'),
    chars('Super 中文😀', underline='double', strike='double', verticalAlign='superscript', fontSize=18, backgroundColor='#13579B') + chars(' tail'),
    chars('Sub 中文😀', underline='double', strike='single', verticalAlign='subscript', fontSize=18) + chars(' tail'),
    chars('single', underline=True) + chars(' ') + chars('double', underline='double') + chars(' none'),
    chars('Edit target'),
]


def synthetic_paragraph(text, properties='', style='Normal'):
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:rPr>{properties}</w:rPr><w:t>{text}</w:t></w:r></w:p>'


def authored_synthetic():
    cases = [
        ('Implicit default character style ignored', '', 'Normal', {}),
        ('Explicit default character style', '<w:rStyle w:val="ImplicitDouble"/>', 'Normal', {'underline': 'double'}),
        ('Paragraph double', '', 'DoubleParagraph', {'underline': 'double'}),
        ('Paragraph basedOn double', '', 'ChildParagraph', {'underline': 'double'}),
        ('Direct single', '<w:u w:val="single"/>', 'DoubleParagraph', {'underline': True}),
        ('Direct none', '<w:u w:val="none"/>', 'DoubleParagraph', {}),
        ('Named character double', '<w:rStyle w:val="NamedDouble"/>', 'Normal', {'underline': 'double'}),
        ('Named basedOn double', '<w:rStyle w:val="ChildDouble"/>', 'Normal', {'underline': 'double'}),
        ('Named inherited none', '<w:rStyle w:val="NamedClear"/>', 'DoubleParagraph', {}),
        ('Direct none over named', '<w:rStyle w:val="NamedDouble"/><w:u w:val="none"/>', 'Normal', {}),
        ('Combo 中文😀', '<w:dstrike/><w:sz w:val="36"/><w:highlight w:val="magenta"/><w:u w:val="double"/><w:shd w:val="clear" w:fill="13579B"/><w:vertAlign w:val="superscript"/>', 'Normal', {'underline': 'double', 'strike': 'double', 'fontSize': 18, 'highlight': 'magenta', 'backgroundColor': '#13579B', 'verticalAlign': 'superscript'}),
        ('Sub combo 中文😀', '<w:strike/><w:sz w:val="36"/><w:highlight w:val="cyan"/><w:u w:val="double"/><w:shd w:val="clear" w:fill="ABCDEF"/><w:vertAlign w:val="subscript"/>', 'Normal', {'underline': 'double', 'strike': 'single', 'fontSize': 18, 'highlight': 'cyan', 'backgroundColor': '#ABCDEF', 'verticalAlign': 'subscript'}),
        ('Edit target', '', 'Normal', {}),
    ]
    styles = '''<w:style w:type="character" w:default="1" w:styleId="ImplicitDouble"><w:name w:val="Implicit Double"/><w:rPr><w:u w:val="double"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DoubleParagraph"><w:name w:val="Double Paragraph"/><w:basedOn w:val="Normal"/><w:rPr><w:u w:val="double"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ChildParagraph"><w:name w:val="Child Paragraph"/><w:basedOn w:val="DoubleParagraph"/></w:style>
<w:style w:type="character" w:styleId="NamedDouble"><w:name w:val="Named Double"/><w:rPr><w:u w:val="double"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="ChildDouble"><w:name w:val="Child Double"/><w:basedOn w:val="NamedDouble"/></w:style>
<w:style w:type="character" w:styleId="NamedClear"><w:name w:val="Named Clear"/><w:basedOn w:val="NamedDouble"/><w:rPr><w:u w:val="none"/></w:rPr></w:style>'''
    return ''.join(synthetic_paragraph(t, p, s) for t, p, s, _ in cases), styles, [chars(t, **expected) for t, _, _, expected in cases]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--soffice', default='soffice')
    parser.add_argument('--output', type=Path, default=ROOT)
    args = parser.parse_args()
    executable = shutil.which(args.soffice)
    if not executable:
        raise SystemExit('LibreOffice executable not found')
    output = args.output.resolve()
    source, native, inventory = (output / name for name in ['source', 'libreoffice', 'inventory'])
    for directory in [source, native, inventory]:
        directory.mkdir(parents=True, exist_ok=True)
    version = subprocess.check_output([executable, '--version'], text=True, timeout=20).strip()
    (source / 'styles.xml').write_text(corpus.STYLES, encoding='utf-8')
    cases = [
        {'name': 'inline-underline', 'automaticStyles': ODT_STYLES, 'body': ODT_BODY},
        {'name': 'unsupported-wave', 'automaticStyles': '<style:style style:name="Wave" style:family="text"><style:text-properties style:text-underline-style="wave" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>', 'body': '<text:p text:style-name="Standard"><text:span text:style-name="Wave">Wave underline</text:span> tail</text:p>'},
        {'name': 'unsupported-color', 'automaticStyles': f'<style:style style:name="Colored" style:family="text"><style:text-properties {underline("double", "#ff0000")}/></style:style>', 'body': '<text:p text:style-name="Standard"><text:span text:style-name="Colored">Red double underline</text:span> tail</text:p>'},
    ]
    for case in cases:
        content = corpus.odt_content(case)
        (source / (case['name'] + '.content.xml')).write_text(content, encoding='utf-8')
        corpus.write_odt(source / (case['name'] + '.odt'), content)
    commands = []

    def convert(inputs, profile):
        command = [executable, '--headless', f'-env:UserInstallation={profile.as_uri()}', '--convert-to', 'docx:Office Open XML Text', '--outdir', str(native), *[str(inp) for inp in inputs]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=True)
        commands.append({'argv': command, 'stdout': result.stdout, 'stderr': result.stderr, 'exitCode': result.returncode})
        for inp in inputs:
            if not (native / (inp.stem + '.docx')).exists():
                raise RuntimeError('Native conversion produced no output: ' + result.stdout + result.stderr)

    with tempfile.TemporaryDirectory(prefix='open-office-underline-corpus-') as temporary:
        temporary = Path(temporary)
        convert([source / (case['name'] + '.odt') for case in cases], temporary / 'odt-profile')
        body, styles, synthetic_expected = authored_synthetic()
        with zipfile.ZipFile(native / 'inline-underline.docx') as template, zipfile.ZipFile(source / 'inheritance.docx', 'w', zipfile.ZIP_DEFLATED) as target:
            for name in template.namelist():
                data = template.read(name)
                if name == 'word/document.xml':
                    xml = data.decode()
                    section = re.search(r'<w:sectPr\b.*?</w:sectPr>', xml, re.S).group(0)
                    data = re.sub(r'<w:body>.*?</w:body>', '<w:body>' + body + section + '</w:body>', xml, flags=re.S).encode()
                if name == 'word/styles.xml':
                    xml = data.decode()
                    xml = re.sub(r'<w:style\b[^>]*>', lambda match: re.sub(r' w:default="[^"]+"', '', match.group(0)) if 'w:type="character"' in match.group(0) else match.group(0), xml)
                    data = xml.replace('</w:styles>', styles + '</w:styles>').encode()
                target.writestr(name, data)
        assert [p['characters'] for p in inspector.inspect(source / 'inheritance.docx')['paragraphs']] == synthetic_expected
        convert([source / 'inheritance.docx'], temporary / 'docx-profile')
    fixtures = []
    for name, kind, extension, expected, unsupported in [
        ('inline-underline', 'original-odt', 'odt', ODT_EXPECTED, None),
        ('inheritance', 'synthetic-docx-from-native-template', 'docx', synthetic_expected, None),
        ('unsupported-wave', 'original-odt', 'odt', None, 'Wavy underline pattern'),
        ('unsupported-color', 'original-odt', 'odt', [chars('Red double underline', underline='double') + chars(' tail')], None),
    ]:
        source_file, docx = source / f'{name}.{extension}', native / f'{name}.docx'
        fixture = {'name': name, 'source': f'source/{name}.{extension}', 'sourceKind': kind, 'sourceSha256': corpus.sha256(source_file), 'docx': f'libreoffice/{name}.docx', 'docxSha256': corpus.sha256(docx), 'docxBytes': docx.stat().st_size, 'inventory': f'inventory/{name}.json'}
        (inventory / f'{name}.json').write_text(json.dumps(corpus.inspect_docx(docx), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if unsupported:
            fixture['expectUnsupported'] = unsupported
        else:
            resolved = inspector.inspect(docx)
            actual = [p['characters'] for p in resolved['paragraphs']]
            if actual != expected:
                (output / 'failed-semantics.json').write_text(json.dumps({'name': name, 'expected': expected, 'actual': actual}, ensure_ascii=False, indent=2))
                raise RuntimeError('Native output differs from authored contract: ' + name)
            fixture['expectedParagraphs'] = [''.join(c['character'] for c in paragraph) for paragraph in expected]
            fixture['expectedSemantics'] = {'characters': expected}
            if name == 'unsupported-color':
                fixture['historicalName'] = 'Retained filename from former independent-RGB rejection boundary; native package bytes unchanged.'
                fixture['expectedUnderlineColorSegments'] = [{'text': 'Red double underline', 'underlineColor': '#FF0000'}, {'text': ' tail', 'underlineColor': 'auto'}]
            (inventory / f'{name}-semantics.json').write_text(json.dumps(resolved, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        fixtures.append(fixture)
    manifest = {'formatVersion': 1, 'generatedAtUtc': datetime.now(timezone.utc).isoformat(), 'generator': 'generate.py', 'libreoffice': {'executable': executable, 'version': version}, 'provenance': 'Inline single/double/none and RGB color and negative wave fixtures are original authored ODT converted by native LibreOffice. Inheritance is explicitly synthetic OOXML in a native template, then resaved by native LibreOffice. All native DOCX outputs are complete and untouched. Expected semantics are authored from inputs before conversion.', 'conversion': commands, 'fixtures': fixtures}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'libreoffice': version, 'fixtures': [{key: f[key] for key in ['name', 'docxBytes', 'docxSha256']} for f in fixtures]}, indent=2))


if __name__ == '__main__':
    main()
