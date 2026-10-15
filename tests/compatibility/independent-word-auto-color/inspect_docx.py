#!/usr/bin/env python3
"""Independent complete DOCX/PDF inspection for automatic foreground tests.

Uses only ZIP/XML and PyMuPDF; it never imports the editor or renders its model.
The native corpus tests ordinary positive paragraph/character style ancestry,
not OOXML toggle inversions. Default character styles only apply when referenced.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda key: '{' + W + '}' + key

def val(node, default=None):
    return node.get(q('val'), default) if node is not None else default

def on(node):
    return val(node, 'true') in ('true', '1', 'on')

def props(node):
    out = {}
    if node is None:
        return out
    for key, target in [('b', 'bold'), ('i', 'italic')]:
        child = node.find('w:' + key, NS)
        if child is not None:
            out[target] = on(child)
    color = node.find('w:color', NS)
    if color is not None:
        token = val(color)
        assert token == 'auto' or (token is not None and len(token) == 6 and all(c in '0123456789abcdefABCDEF' for c in token))
        out['color'] = token if token == 'auto' else '#' + token.upper()
    shade = node.find('w:shd', NS)
    if shade is not None:
        assert val(shade) == 'clear'
        fill = shade.get(q('fill'))
        assert fill is not None
        out['backgroundColor'] = 'none' if fill == 'auto' else '#' + fill.upper()
    underline = node.find('w:u', NS)
    if underline is not None:
        line = val(underline, 'single')
        assert line in ('none', 'single', 'double')
        out['underline'] = False if line == 'none' else True if line == 'single' else 'double'
        token = underline.get(q('color'))
        out['underlineColor'] = '#' + token.upper() if token is not None else 'auto'
    strike, double = node.find('w:strike', NS), node.find('w:dstrike', NS)
    if strike is not None or double is not None:
        out['strike'] = 'double' if double is not None and on(double) else 'single' if strike is not None and on(strike) else 'none'
    for tag, field, convert in [('highlight', 'highlight', str), ('vertAlign', 'verticalAlign', str), ('sz', 'fontSize', lambda x: int(x) / 2), ('szCs', 'fontSizeCs', lambda x: int(x) / 2), ('spacing', 'letterSpacing', lambda x: int(x) / 20), ('kern', 'kerning', lambda x: int(x) / 2)]:
        token = val(node.find('w:' + tag, NS))
        if token is not None:
            out[field] = convert(token)
    for tag, attrs in [('rFonts', ['ascii', 'hAnsi', 'eastAsia', 'cs']), ('lang', ['val', 'eastAsia', 'bidi'])]:
        child = node.find('w:' + tag, NS)
        if child is not None:
            out.update({tag + ':' + key: child.get(q(key)) for key in attrs if child.get(q(key)) is not None})
    return out

DEFAULTS = {'color': 'auto', 'backgroundColor': 'none', 'highlight': 'none', 'fontSize': 12, 'underline': False, 'underlineColor': 'auto', 'strike': 'none', 'verticalAlign': 'baseline'}
FIELDS = tuple(DEFAULTS)

def inspect(file):
    with zipfile.ZipFile(file) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        sheet = E.fromstring(archive.read('word/styles.xml')) if 'word/styles.xml' in archive.namelist() else E.Element(q('styles'))
        styles = {s.get(q('styleId')): s for s in sheet.findall('w:style', NS)}
        defaults = {**DEFAULTS, **props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr', NS))}
        default_id = next((key for key, s in styles.items() if s.get(q('type')) == 'paragraph' and s.get(q('default')) in ('1', 'true')), None)
        def chain(sid, seen=()):
            if sid not in styles:
                return []
            assert sid not in seen, 'Circular ancestry'
            st = styles[sid]
            return chain(val(st.find('w:basedOn', NS)), (*seen, sid)) + [st]
        document = E.fromstring(archive.read('word/document.xml'))
        paragraphs = []
        for p in document.findall('w:body/w:p', NS):
            source = dict(defaults)
            for st in chain(val(p.find('w:pPr/w:pStyle', NS), default_id)):
                source.update(props(st.find('w:rPr', NS)))
            marker = props(p.find('w:pPr/w:rPr', NS))
            marker_character = {}
            for st in chain(val(p.find('w:pPr/w:rPr/w:rStyle', NS))):
                values = props(st.find('w:rPr', NS))
                values.pop('highlight', None)
                marker_character.update(values)
            runs = []
            for r in p.findall('w:r', NS):
                inherited = dict(source)
                character = {}
                for st in chain(val(r.find('w:rPr/w:rStyle', NS))):
                    values = props(st.find('w:rPr', NS))
                    values.pop('highlight', None)  # Native Writer ignores named character highlighting.
                    character.update(values)
                inherited.update(character)
                direct = props(r.find('w:rPr', NS))
                style = {**inherited, **direct}
                text = ''.join((n.text or '') if n.tag == q('t') else '\n' if n.tag in (q('br'), q('cr')) else '\t' if n.tag == q('tab') else '' for n in r)
                runs.append({'text': text, 'style': style, 'sourceStyle': inherited, 'characterStyle': character, 'directStyle': direct})
            characters = [{'character': char, **{key: run['style'].get(key, DEFAULTS[key]) for key in FIELDS}} for run in runs for char in run['text']]
            paragraphs.append({'text': ''.join(r['text'] for r in runs), 'characters': characters, 'runs': runs, 'sourceStyle': source, 'paragraphMarkStyle': marker, 'markerCharacterStyle': marker_character, 'marker': {**source, **marker_character, **marker}})
        return {'paragraphs': paragraphs, 'zipEntries': len(archive.namelist())}

def pdf(file):
    import fitz
    result = []
    with fitz.open(file) as document:
        for page in document:
            for block in page.get_text('dict')['blocks']:
                for line in block.get('lines', []):
                    for span in line['spans']:
                        result.append({'page': page.number, **{key: span[key] for key in ('text', 'color', 'origin', 'bbox', 'size', 'font')}})
    return result

if __name__ == '__main__':
    print(json.dumps(pdf(sys.argv[2]) if sys.argv[1] == '--pdf' else inspect(sys.argv[1]), ensure_ascii=False))
