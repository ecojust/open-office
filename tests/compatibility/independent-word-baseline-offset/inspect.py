#!/usr/bin/env python3
"""Independent ZIP/XML oracle for the supported direct-position subset.

OOXML position uses signed half-points. Native Writer resolves it after the
effective explicit font size, rounds to an integer percentage with ties away
from zero, and keeps full-size glyphs. Raw zero is ignored (not a baseline
reset). Nonzero style positions are deliberately outside this oracle's domain.
Paragraph-marker position is recorded separately and ignored by the native
importer; it must never leak into visible body runs.
"""
import json
import sys
import zipfile
from fractions import Fraction
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda name: '{' + W + '}' + name


def val(node, default=None):
    return node.get(q('val'), default) if node is not None else default


def round_away(value):
    value = Fraction(value)
    magnitude = abs(value)
    result = (2 * magnitude.numerator + magnitude.denominator) // (2 * magnitude.denominator)
    return -result if value < 0 else result


def props(node):
    result = {}
    if node is None:
        return result
    for tag, key, convert in [('sz', 'fontSize', lambda s: int(s) / 2),
                              ('vertAlign', 'verticalAlign', str),
                              ('position', 'positionHalfPoints', int),
                              ('color', 'color', str)]:
        value = val(node.find('w:' + tag, NS))
        if value is not None:
            result[key] = convert(value)
    bold = node.find('w:b', NS)
    if bold is not None:
        result['bold'] = val(bold, '1') not in ['0', 'false', 'off']
    fonts = node.find('w:rFonts', NS)
    if fonts is not None:
        result['fontFamily'] = fonts.get(q('ascii'), fonts.get(q('hAnsi')))
    return result


def inspect(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        definitions, defaults, default_id = {}, {}, None
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            definitions = {n.get(q('styleId')): n for n in sheet.findall('w:style', NS)}
            defaults = props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr', NS))
            default_id = next((k for k, n in definitions.items() if n.get(q('type')) == 'paragraph'
                               and n.get(q('default')) in ['1', 'true']), None)
        assert not defaults.get('positionHalfPoints'), 'Nonzero document-default position is outside the subset'

        def chain(identifier, seen=()):
            if identifier not in definitions:
                return []
            assert identifier not in seen, 'Cyclic style ancestry'
            node = definitions[identifier]
            layer = props(node.find('w:rPr', NS))
            assert not layer.get('positionHalfPoints'), 'Nonzero named-style position is outside the subset'
            return chain(val(node.find('w:basedOn', NS)), (*seen, identifier)) + [layer]

        def resolved(rpr, inherited, marker=False):
            style = dict(inherited)
            for layer in chain(val(rpr.find('w:rStyle', NS)) if rpr is not None else None):
                style.update({k: v for k, v in layer.items() if k != 'positionHalfPoints'})
            direct = props(rpr)
            style.update({k: v for k, v in direct.items() if k != 'positionHalfPoints'})
            raw = direct.get('positionHalfPoints')
            if raw and not marker:
                assert style.get('fontSize') is not None, 'Nonzero position needs explicit effective size'
                percent = round_away(Fraction(raw * 50) / Fraction(style['fontSize']))
                style['verticalAlign'] = percent if percent else 'baseline'
            return style, direct

        paragraphs = []
        body = E.fromstring(archive.read('word/document.xml'))
        for p in body.findall('w:body/w:p', NS):
            inherited = {'verticalAlign': 'baseline', **{k: v for k, v in defaults.items() if k != 'positionHalfPoints'}}
            for layer in chain(val(p.find('w:pPr/w:pStyle', NS), default_id)):
                inherited.update({k: v for k, v in layer.items() if k != 'positionHalfPoints'})
            marker, marker_direct = resolved(p.find('w:pPr/w:rPr', NS), inherited, marker=True)
            runs = []
            for r in p.findall('w:r', NS):
                text = ''.join((n.text or '') if n.tag == q('t') else '\t' if n.tag == q('tab')
                               else '\n' if n.tag in [q('br'), q('cr')] else '' for n in r)
                style, direct = resolved(r.find('w:rPr', NS), inherited, marker=not text)
                if text:
                    runs.append({'text': text, 'style': style, 'direct': direct})
            characters = [{'character': c, 'fontSize': run['style'].get('fontSize', 12),
                           'verticalAlign': run['style']['verticalAlign']} for run in runs for c in run['text']]
            paragraphs.append({'text': ''.join(r['text'] for r in runs), 'runs': runs,
                               'characters': characters, 'marker': marker, 'markerDirect': marker_direct,
                               'source': inherited})
        return {'paragraphs': paragraphs, 'zipEntries': len(archive.namelist())}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
