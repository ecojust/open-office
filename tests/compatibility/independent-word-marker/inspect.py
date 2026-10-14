#!/usr/bin/env python3
"""Independent OOXML marker/body oracle. Does not import application code.

The paragraph marker is a separate formatting carrier. Empty-paragraph
insertion takes marker formatting, never the first conflicting empty run.
"""
import json
import re
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
        assert set(underline.attrib) <= {q('val'), q('color')}, 'Unsupported underline attributes'
        encoded = value(underline)
        assert encoded in ['none', 'single', 'double'], 'Unsupported underline pattern: ' + str(encoded)
        result['underline'] = {'none': False, 'single': True, 'double': 'double'}[encoded]
        color = underline.get(q('color'))
        if color is not None:
            assert re.fullmatch(r'[0-9a-fA-F]{6}', color), 'Unsupported underline color: ' + color
            result['underlineColor'] = '#' + color.upper()
    strike, double = node.find('w:strike', NS), node.find('w:dstrike', NS)
    if strike is not None or double is not None:
        result['strike'] = 'double' if double is not None and on(double) else 'single' if strike is not None and on(strike) else 'none'
    shading = node.find('w:shd', NS)
    if shading is not None:
        assert value(shading) == 'clear' and shading.get(q('fill')) is not None
        result['backgroundColor'] = 'none' if shading.get(q('fill')) == 'auto' else '#' + shading.get(q('fill')).upper()
    for tag, field, convert in [('highlight', 'highlight', str), ('vertAlign', 'verticalAlign', str), ('sz', 'fontSize', lambda x: int(x) / 2), ('szCs', 'fontSizeCs', lambda x: int(x) / 2), ('color', 'color', lambda x: '#' + x.upper()), ('kern', 'kern', int)]:
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

        default_underline_color = defaults.get('underlineColor', 'auto')

        def apply_direct(target, layer):
            target.update(layer)
            if 'underline' in layer and 'underlineColor' not in layer:
                # A direct w:u is a fresh underline item. Unlike a basedOn
                # child, omitted color uses docDefaults, not the selected
                # paragraph/character style's color.
                target['underlineColor'] = default_underline_color

        def apply_character_chain(target, reference, toggle=False):
            has_underline, color = False, None
            for named in chain(reference):
                layer = props(named.find('w:rPr', NS))
                layer.pop('highlight', None)
                if 'underline' in layer:
                    has_underline = True
                color = layer.get('underlineColor', color)
                if toggle:
                    for key in ['bold', 'italic']:
                        if key in layer:
                            layer[key] = not target[key] if layer[key] else target[key]
                target.update(layer)
            if has_underline:
                # Color survives within the character basedOn chain, but a
                # selected character underline without one resets the P color.
                target['underlineColor'] = color or default_underline_color

        paragraphs = []
        document = E.fromstring(archive.read('word/document.xml'))
        for paragraph in document.findall('w:body/w:p', NS):
            inherited = {'bold': False, 'italic': False, 'fontSize': 12, 'color': '#000000', 'verticalAlign': 'baseline', 'strike': 'none', 'underline': False, 'underlineColor': 'auto', 'highlight': 'none', 'backgroundColor': 'none', **defaults}
            for style in chain(value(paragraph.find('w:pPr/w:pStyle', NS), default_id)):
                layer = props(style.find('w:rPr', NS))
                for key in ['bold', 'italic']:
                    if key in layer:
                        layer[key] = not inherited[key] if layer[key] else inherited[key]
                inherited.update(layer)
            marker_node = paragraph.find('w:pPr/w:rPr', NS)
            marker_direct = props(marker_node)
            marker = dict(inherited)
            marker_reference = value(paragraph.find('w:pPr/w:rPr/w:rStyle', NS))
            apply_character_chain(marker, marker_reference, toggle=True)
            apply_direct(marker, marker_direct)
            runs = []
            for run in paragraph.findall('w:r', NS):
                style = dict(inherited)
                apply_character_chain(style, value(run.find('w:rPr/w:rStyle', NS)))
                direct = props(run.find('w:rPr', NS))
                apply_direct(style, direct)
                text = ''.join((n.text or '') if n.tag == q('t') else '\n' if n.tag in [q('br'), q('cr')] else '\t' if n.tag == q('tab') else '' for n in run)
                if text:
                    runs.append({'text': text, 'style': style, 'directStyle': direct})
            keys = ['bold', 'italic', 'fontSize', 'color', 'verticalAlign', 'strike', 'underline', 'underlineColor', 'highlight', 'backgroundColor']
            characters = [{'character': char, **{key: run['style'][key] for key in keys}} for run in runs for char in run['text']]
            text = ''.join(run['text'] for run in runs)
            paragraphs.append({'text': text, 'characters': characters, 'runs': runs, 'sourceStyle': inherited,
                               'markerPresent': marker_node is not None, 'markerReference': marker_reference,
                               'markerDirectStyle': marker_direct, 'markerStyle': {key: marker[key] for key in keys},
                               'emptyInsertionStyle': {key: marker[key] for key in keys} if not text else None})
        return {'paragraphs': paragraphs, 'zipEntries': len(archive.namelist())}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
