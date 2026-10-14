#!/usr/bin/env python3
"""Independent OOXML underline oracle using only Python XML/ZIP libraries.

Retains bool single/none and the distinct double value. Unknown patterns fail
instead of being treated as ordinary underline. No application code is used.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda name: '{' + W + '}' + name


def value(node, default=None):
    return node.get(q('val'), default) if node is not None else default


def on(node):
    return value(node, 'true') in ['true', '1', 'on']


def props(node):
    result = {}
    if node is None:
        return result
    for tag, field in [('b', 'bold'), ('i', 'italic')]:
        child = node.find('w:' + tag, NS)
        if child is not None:
            result[field] = on(child)
    underline = node.find('w:u', NS)
    if underline is not None:
        encoded = value(underline, 'single')
        assert encoded in ['none', 'single', 'double'], 'Unsupported underline pattern: ' + encoded
        result['underline'] = {'none': False, 'single': True, 'double': 'double'}[encoded]
        color = underline.get(q('color'))
        if color is not None:
            assert len(color) == 6 and all(c in '0123456789abcdefABCDEF' for c in color), 'Unsupported underline color: ' + color
            result['underlineColor'] = '#' + color.upper()
    strike, double = node.find('w:strike', NS), node.find('w:dstrike', NS)
    if strike is not None or double is not None:
        result['strike'] = 'double' if double is not None and on(double) else 'single' if strike is not None and on(strike) else 'none'
    shading = node.find('w:shd', NS)
    if shading is not None:
        assert value(shading) == 'clear' and shading.get(q('fill')) is not None
        result['backgroundColor'] = 'none' if shading.get(q('fill')) == 'auto' else '#' + shading.get(q('fill')).upper()
    for tag, field, convert in [('highlight', 'highlight', str), ('vertAlign', 'verticalAlign', str), ('sz', 'fontSize', lambda x: int(x) / 2), ('szCs', 'fontSizeCs', lambda x: int(x) / 2), ('color', 'color', str), ('kern', 'kern', int)]:
        encoded = value(node.find('w:' + tag, NS))
        if encoded is not None:
            result[field] = convert(encoded)
    for tag, attributes in [('rFonts', ['ascii', 'hAnsi', 'eastAsia', 'cs']), ('lang', ['val', 'eastAsia', 'bidi'])]:
        child = node.find('w:' + tag, NS)
        if child is not None:
            result.update({tag + ':' + a: child.get(q(a)) for a in attributes if child.get(q(a)) is not None})
    return result


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        styles, defaults, default_id = {}, {}, None
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            styles = {s.get(q('styleId')): s for s in sheet.findall('w:style', NS)}
            defaults = props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr', NS))
            default_id = next((k for k, s in styles.items() if s.get(q('type')) == 'paragraph' and s.get(q('default')) in ['1', 'true']), None)

        def chain(style_id, seen=()):
            if style_id not in styles:
                return []
            assert style_id not in seen, 'Circular style ancestry'
            style = styles[style_id]
            return chain(value(style.find('w:basedOn', NS)), (*seen, style_id)) + [style]

        paragraphs = []
        document = E.fromstring(archive.read('word/document.xml'))
        for paragraph in document.findall('w:body/w:p', NS):
            inherited = {'fontSize': 12, 'verticalAlign': 'baseline', 'strike': 'none', 'underline': False, 'underlineColor': 'auto', 'highlight': 'none', 'backgroundColor': 'none', **defaults}
            for style in chain(value(paragraph.find('w:pPr/w:pStyle', NS), default_id)):
                inherited.update(props(style.find('w:rPr', NS)))
            runs = []
            for run in paragraph.findall('w:r', NS):
                style = dict(inherited)
                character_source = {}
                for named in chain(value(run.find('w:rPr/w:rStyle', NS))):
                    character_style = props(named.find('w:rPr', NS))
                    character_style.pop('highlight', None)
                    character_source.update(character_style)
                if 'underline' in character_source and 'underlineColor' not in character_source:
                    character_source['underlineColor'] = defaults.get('underlineColor', 'auto')
                style.update(character_source)
                direct = props(run.find('w:rPr', NS))
                if 'underline' in direct and 'underlineColor' not in direct:
                    direct['underlineColor'] = defaults.get('underlineColor', 'auto')
                style.update(direct)
                text = ''.join((n.text or '') if n.tag == q('t') else '\n' if n.tag in [q('br'), q('cr')] else '\t' if n.tag == q('tab') else '' for n in run)
                if text:
                    runs.append({'text': text, 'style': style, 'directStyle': direct})
            keys = ['fontSize', 'verticalAlign', 'strike', 'underline', 'highlight', 'backgroundColor']
            characters = [{'character': char, **{key: run['style'][key] for key in keys}} for run in runs for char in run['text']]
            paragraphs.append({'text': ''.join(run['text'] for run in runs), 'characters': characters, 'runs': runs, 'sourceStyle': inherited, 'paragraphMarkStyle': props(paragraph.find('w:pPr/w:rPr', NS))})
        return {'paragraphs': paragraphs, 'zipEntries': len(archive.namelist())}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
