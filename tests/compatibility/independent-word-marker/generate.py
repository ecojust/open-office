#!/usr/bin/env python3
"""Author explicit-RGB synthetic controls and preserve complete native outputs.

The native plain-text OPC container is reused; marker/body XML is deliberately
synthetic. No native output XML is stripped or repaired after conversion.
"""
import argparse, hashlib, importlib.util, json, subprocess, zipfile
from pathlib import Path
from xml.etree import ElementTree as E
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
q = lambda x: '{' + W + '}' + x
RICH = '<w:b/><w:i/><w:sz w:val="36"/><w:color w:val="CC0000"/><w:u w:val="double"/><w:dstrike/><w:highlight w:val="yellow"/><w:shd w:val="clear" w:fill="13579B"/>'
CLEAR = '<w:b w:val="0"/><w:i w:val="0"/><w:sz w:val="24"/><w:color w:val="000000"/><w:u w:val="none"/><w:strike w:val="0"/><w:dstrike w:val="0"/><w:highlight w:val="none"/><w:shd w:val="clear" w:fill="auto"/>'
def run(props='', text=''):
    return f'<w:r><w:rPr>{props}</w:rPr><w:t>{text}</w:t></w:r>'
def case(name, marker='', runs='', inherited='', extra='', unsupported=None):
    return dict(name=name, marker=marker, runs=runs, inherited=inherited, extra=extra, unsupported=unsupported)
CASES = [
    case('empty-rich-marker', RICH),
    case('empty-style-rich-marker-clear', CLEAR, inherited=RICH),
    case('empty-marker-super', RICH + '<w:vertAlign w:val="superscript"/>'),
    case('empty-marker-rich-run-clear', RICH, run(CLEAR)),
    case('empty-marker-clear-run-rich', CLEAR, run(RICH)),
    case('empty-marker-double-multiple-runs', '<w:u w:val="double"/>', run('<w:u w:val="single"/>') + run('<w:u w:val="none"/>')),
    case('text-rich-marker', RICH, run('', 'BODY')),
    case('text-rich-marker-run-clear', RICH, run(CLEAR, 'BODY')),
    case('text-rich-body-sparse-marker', '<w:b/>', run('<w:i/><w:sz w:val="48"/><w:color w:val="0000FF"/>', 'BODY')),
    case('text-48pt-marker-trailing-break', '<w:sz w:val="96"/>', '<w:r><w:t>BODY</w:t><w:br/></w:r>'),
    case('empty-48pt-marker', '<w:sz w:val="96"/>'),
    case('text-48pt-marker', '<w:sz w:val="96"/>', run('', 'BODY')),
    case('marker-character-style', '<w:rStyle w:val="MarkerChar"/>', extra=f'<w:style w:type="character" w:styleId="MarkerChar"><w:name w:val="MarkerChar"/><w:rPr>{RICH}</w:rPr></w:style>', unsupported=None),
    case('unsupported-marker-wave', '<w:u w:val="wave"/>', unsupported='Paragraph marker wave underline'),
    # Retain the historical filename and original corpus bytes. RGB underline
    # color is now a positive control; regeneration does not rename its input.
    case('unsupported-marker-color', '<w:u w:val="double" w:color="FF0000"/>'),
]
def main():
    p = argparse.ArgumentParser(); p.add_argument('--output', type=Path, default=HERE); p.add_argument('--soffice', default='/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/soffice'); p.add_argument('--names', nargs='+', help='Generate only these controls into an isolated output directory'); a = p.parse_args()
    out = a.output.resolve()
    for name in ['source', 'libreoffice', 'inventory']:
        (out / name).mkdir(parents=True, exist_ok=True)
    base = ROOT / 'tests/compatibility/independent-word/libreoffice/plain-text.docx'
    spec = importlib.util.spec_from_file_location('marker_inspect', HERE / 'inspect.py'); oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
    fixtures = []
    selected = [c for c in CASES if not a.names or c['name'] in a.names]
    if a.names:
        assert set(a.names) == {c['name'] for c in selected}, 'Unknown fixture name'
    for c in selected:
        with zipfile.ZipFile(base) as z:
            parts = {n: z.read(n) for n in z.namelist()}
        settings = E.fromstring(parts['word/settings.xml'])
        automatic = settings.find(q('autoHyphenation'))
        if automatic is None:
            automatic = E.SubElement(settings, q('autoHyphenation'))
        automatic.set(q('val'), '0')
        parts['word/settings.xml'] = E.tostring(settings)
        # Explicit RGB avoids the separate unsupported native auto-color layer.
        styles = f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="DejaVu Sans" w:hAnsi="DejaVu Sans"/><w:sz w:val="24"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:rPr><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Probe"><w:name w:val="Probe"/><w:basedOn w:val="Normal"/><w:rPr>{c["inherited"]}</w:rPr></w:style>{c["extra"]}</w:styles>'
        doc = E.fromstring(parts['word/document.xml']); body = doc.find(q('body')); section = body.find(q('sectPr')); body.clear()
        for fragment in ['<w:p>'+run('', 'BEFORE')+'</w:p>', f'<w:p><w:pPr><w:pStyle w:val="Probe"/><w:rPr>{c["marker"]}</w:rPr></w:pPr>{c["runs"]}</w:p>', '<w:p>'+run('', 'AFTER')+'</w:p>']:
            body.append(E.fromstring(fragment.replace('<w:p>', f'<w:p xmlns:w="{W}">', 1)))
        body.append(section); parts['word/document.xml'] = E.tostring(doc); parts['word/styles.xml'] = styles.encode()
        source = out / 'source' / (c['name'] + '.docx')
        with zipfile.ZipFile(source, 'w') as z:
            for n, value in parts.items(): z.writestr(n, value)
        f = {'name': c['name'], 'sourceKind': 'Explicitly synthetic DOCX in native plain-text OPC container; explicit RGB defaults and automatic hyphenation disabled', 'source': str(source.relative_to(out)), 'docx': 'libreoffice/' + source.name}
        if c['name'] == 'unsupported-marker-color':
            f['historicalName'] = 'Originally an unsupported-color negative control; promoted without changing source or native DOCX bytes.'
        if c['unsupported']:
            f['expectUnsupported'] = c['unsupported']
        else:
            parsed = oracle.inspect(source)
            f['expectedParagraphs'] = [p['text'] for p in parsed['paragraphs']]
            f['expectedSemantics'] = [{'characters': p['characters'], 'markerStyle': p['markerStyle']} for p in parsed['paragraphs']]
        fixtures.append(f)
    import tempfile
    from pathlib import Path as P
    with tempfile.TemporaryDirectory(prefix='word-marker-corpus-') as profile:
        cmd = [a.soffice, '-env:UserInstallation=' + P(profile).as_uri(), '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', str(out / 'libreoffice'), *[str(out / f['source']) for f in fixtures]]
        r = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
    sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
    for f in fixtures:
        source, native = out / f['source'], out / f['docx']
        assert native.is_file(), f
        f['sourceSha256'], f['docxSha256'] = sha(source), sha(native)
        with zipfile.ZipFile(native) as z:
            inventory = {'zipEntries': z.namelist(), 'xml': {n: z.read(n).decode() for n in z.namelist() if n.endswith(('.xml', '.rels'))}}
        (out / 'inventory' / (f['name'] + '.json')).write_text(json.dumps(inventory, ensure_ascii=False, indent=2))
        if not f.get('expectUnsupported'):
            parsed = oracle.inspect(native)
            semantics = [{'characters': p['characters'], 'markerStyle': p['markerStyle']} for p in parsed['paragraphs']]
            assert semantics == f['expectedSemantics'], f['name'] + ': native differs from authored contract'
            (out / 'inventory' / (f['name'] + '-semantics.json')).write_text(json.dumps(parsed, ensure_ascii=False, indent=2))
    manifest = {'libreoffice': subprocess.check_output([a.soffice, '--version'], text=True).strip(), 'sourceTemplate': str(base.relative_to(ROOT)), 'sourceTemplateSha256': sha(base), 'scope': 'Independent paragraph marker / body formatting, empty insertion, RGB underline color and trailing-break font size', 'conversion': {'command': cmd, 'stdout': r.stdout, 'stderr': r.stderr}, 'fixtures': fixtures}
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)); print(json.dumps({'fixtures': len(fixtures), 'positive': sum(not f.get('expectUnsupported') for f in fixtures), 'output': str(out)}))
if __name__ == '__main__': main()
