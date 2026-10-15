#!/usr/bin/env python3
"""Independent OOXML underline-color resolver using only ZIP/XML.

Native contract: mode/color form one underline item. Within a basedOn chain,
mode-only underline inherits the base color. At a new named-character scope
or direct override, mode-only underline instead uses docDefaults color (auto
when absent). No underline item inherits the previous scope unchanged.
Explicit underline w:u/@w:color=auto is rejected; underline auto means omitted
color. Foreground w:color/@w:val=auto is a separate supported semantic value,
and absent foreground inherits auto rather than an invented explicit black.
None retains its latent RGB for later re-enabling. Markers resolve separately.
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


def foreground(value):
    if value == 'auto':
        return value
    assert len(value) == 6 and all(c in '0123456789abcdefABCDEF' for c in value), 'Unsupported foreground color: ' + value
    return '#' + value.upper()


def props(node):
    result = {}
    if node is None:
        return result
    underline = node.find('w:u', NS)
    if underline is not None:
        mode = value(underline)
        assert mode in ['none', 'single', 'double'], 'Unsupported underline mode: ' + str(mode)
        result['underline'] = {'none': False, 'single': True, 'double': 'double'}[mode]
        color = underline.get(q('color'))
        if color is not None:
            assert len(color) == 6 and all(c in '0123456789abcdefABCDEF' for c in color), 'Unsupported underline color: ' + color
            result['underlineColor'] = '#' + color.upper()
    strike, double = node.find('w:strike', NS), node.find('w:dstrike', NS)
    if strike is not None or double is not None:
        result['strike'] = 'double' if double is not None and value(double, 'true') in ['1', 'true', 'on'] else 'single' if strike is not None and value(strike, 'true') in ['1', 'true', 'on'] else 'none'
    for tag, field, convert in [('spacing', 'letterSpacing', lambda v: int(v)/20),
                                ('sz', 'fontSize', lambda v: int(v)/2),
                                ('szCs', 'fontSizeCs', lambda v: int(v)/2),
                                ('kern', 'kerningHalfPoints', int),
                                ('vertAlign', 'verticalAlign', str),
                                ('color', 'color', foreground)]:
        v = value(node.find('w:' + tag, NS))
        if v is not None:
            result[field] = convert(v)
    for tag, field in [('b', 'bold'), ('i', 'italic')]:
        child = node.find('w:' + tag, NS)
        if child is not None:
            result[field] = value(child, 'true') in ['true', 'on', '1']
    return result


def inspect(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        styles, defaults, default_id = {}, {}, None
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            styles = {s.get(q('styleId')): s for s in sheet.findall('w:style', NS)}
            defaults = props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr', NS))
            default_id = next((k for k, s in styles.items() if s.get(q('type')) == 'paragraph'
                               and s.get(q('default')) in ['1', 'true']), None)

        def chain(sid, seen=()):
            if sid not in styles:
                return []
            assert sid not in seen, 'Circular style ancestry'
            style = styles[sid]
            return chain(value(style.find('w:basedOn', NS)), (*seen, sid)) + [style]

        def resolved(rpr, inherited):
            style = dict(inherited)
            character = {}
            for named in chain(value(rpr.find('w:rStyle', NS)) if rpr is not None else None):
                character.update(props(named.find('w:rPr', NS)))
            if 'underline' in character and 'underlineColor' not in character:
                character['underlineColor'] = defaults.get('underlineColor', 'auto')
            style.update(character)
            direct = props(rpr)
            if 'underline' in direct and 'underlineColor' not in direct:
                direct['underlineColor'] = defaults.get('underlineColor', 'auto')
            style.update(direct)
            return style, direct

        paragraphs = []
        document = E.fromstring(archive.read('word/document.xml'))
        for p in document.findall('w:body/w:p', NS):
            inherited = {'underline': False, 'underlineColor': 'auto', 'color': 'auto', 'strike': 'none', 'fontSize': 12, 'verticalAlign': 'baseline', **defaults}
            for named in chain(value(p.find('w:pPr/w:pStyle', NS), default_id)):
                inherited.update(props(named.find('w:rPr', NS)))
            marker, marker_direct = resolved(p.find('w:pPr/w:rPr', NS), inherited)
            runs = []
            for r in p.findall('w:r', NS):
                style, direct = resolved(r.find('w:rPr', NS), inherited)
                text = ''.join((n.text or '') if n.tag == q('t') else '\t' if n.tag == q('tab')
                               else '\n' if n.tag in [q('br'), q('cr')] else '' for n in r)
                if text:
                    runs.append({'text': text, 'style': style, 'directStyle': direct})
            characters = [{'character': c, **{k: r['style'][k] for k in ['underline', 'underlineColor', 'color', 'strike', 'fontSize', 'verticalAlign']}} for r in runs for c in r['text']]
            paragraphs.append({'text': ''.join(r['text'] for r in runs), 'runs': runs,
                               'characters': characters, 'sourceStyle': inherited,
                               'marker': marker, 'markerDirectStyle': marker_direct})
        return {'paragraphs': paragraphs, 'zipEntries': len(archive.namelist())}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
