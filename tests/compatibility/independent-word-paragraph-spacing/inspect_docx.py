#!/usr/bin/env python3
"""Independent ZIP/XML paragraph-spacing oracle; no application code imported.

Writer's automatic line distance uses a twip -> mm100 -> integer-percent
conversion. Named paragraph styles and direct properties merge by component;
line without lineRule retains the inherited rule. Rule-only is outside this
bounded positive oracle unless already materialized by native export.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda name: '{' + W + '}' + name


def spacing(node):
    if node is None:
        return {}
    values = node.findall('w:spacing', NS)
    assert len(values) <= 1, 'Duplicate spacing'
    return {k.split('}')[-1]: v for k, v in values[0].attrib.items()} if values else {}


def value(node, default=None):
    return node.get(q('val'), default) if node is not None else default


def native_percent(raw):
    # tools::convert raw twips to rounded hundredths of a millimetre,
    # then DomainMapper's integer ratio against 423 mm100 (240 twips).
    mm100 = (raw * 127 + 36) // 72
    return (mm100 * 100 + 211) // 423


def merge(inherited, direct):
    result = dict(inherited)
    for name, key in [('before', 'spaceBefore'), ('after', 'spaceAfter')]:
        if name in direct:
            result[key] = int(direct[name]) / 20
    if 'line' in direct:
        rule = direct.get('lineRule', inherited['lineHeightRule'])
        result['lineHeightRule'] = rule
        raw = int(direct['line'])
        result['lineHeight'] = native_percent(raw) / 100 if rule == 'auto' else raw / 20
    else:
        assert 'lineRule' not in direct, 'Rule-only spacing needs a native materialized control'
    return result


def inspect(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        default = dict(spaceBefore=0, spaceAfter=0, lineHeight=1, lineHeightRule='auto')
        styles, default_id = {}, None
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            default = merge(default, spacing(sheet.find('w:docDefaults/w:pPrDefault/w:pPr', NS)))
            styles = {n.get(q('styleId')): n for n in sheet.findall('w:style', NS)}
            default_id = next((k for k, n in styles.items() if n.get(q('type')) == 'paragraph'
                               and n.get(q('default')) in ('1', 'true')), None)

        def resolve(identifier, seen=()):
            if not identifier or identifier not in styles:
                return dict(default)
            assert identifier not in seen, 'Cyclic styles'
            node = styles[identifier]
            inherited = resolve(value(node.find('w:basedOn', NS)), (*seen, identifier))
            return merge(inherited, spacing(node.find('w:pPr', NS)))

        doc = E.fromstring(archive.read('word/document.xml'))
        result = []
        for p in doc.findall('w:body/w:p', NS):
            source = resolve(value(p.find('w:pPr/w:pStyle', NS), default_id))
            direct = spacing(p.find('w:pPr', NS))
            text = ''.join(n.text or '' if n.tag == q('t') else '\t' if n.tag == q('tab')
                           else '\n' if n.tag in (q('br'), q('cr')) else ''
                           for r in p.findall('w:r', NS) for n in r)
            result.append(dict(text=text, style=merge(source, direct), source=source, direct=direct))
        return dict(paragraphs=result, zipEntries=len(archive.namelist()))


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
