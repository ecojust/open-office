#!/usr/bin/env python3
"""Independent ZIP/XML inspector for line-rule native controls.

Raw source spacing is preserved alongside effective values. The independently
observed rule-only contract starts a new 240-twip pair in each declaration,
while line-only inherits its parent rule. No product code is imported.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda n: '{' + W + '}' + n


def value(n, default=None):
    return n.get(q('val'), default) if n is not None else default


def raw_spacing(n):
    if n is None:
        return {}
    values = n.findall('w:spacing', NS)
    assert len(values) <= 1, 'Duplicate spacing declaration'
    return {k.split('}')[-1]: v for k, v in values[0].attrib.items()} if values else {}


def raw_docx(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        styles, default_id, defaults = {}, None, {}
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            defaults = raw_spacing(sheet.find('w:docDefaults/w:pPrDefault/w:pPr', NS))
            for n in sheet.findall('w:style', NS):
                if n.get(q('type')) != 'paragraph':
                    continue
                identifier = n.get(q('styleId'))
                styles[identifier] = dict(basedOn=value(n.find('w:basedOn', NS)), next=value(n.find('w:next', NS)), spacing=raw_spacing(n.find('w:pPr', NS)))
                if n.get(q('default')) in ('1', 'true'):
                    default_id = identifier
        doc = E.fromstring(archive.read('word/document.xml'))
        paragraphs = []
        for p in doc.findall('w:body/w:p', NS):
            text = ''.join(n.text or '' if n.tag == q('t') else '\t' if n.tag == q('tab') else '\n' if n.tag in (q('br'), q('cr')) else '' for r in p.findall('w:r', NS) for n in r)
            paragraphs.append(dict(text=text, styleId=value(p.find('w:pPr/w:pStyle', NS), default_id), spacing=raw_spacing(p.find('w:pPr', NS))))
        return dict(defaults=defaults, defaultStyleId=default_id, styles=styles, paragraphs=paragraphs, zipEntries=len(archive.namelist()))


def native_percent(raw):
    mm100 = (raw * 127 + 36) // 72
    return (mm100 * 100 + 211) // 423


def merge_complete(inherited, direct):
    result = dict(inherited)
    for name, key in [('before', 'spaceBefore'), ('after', 'spaceAfter')]:
        if name in direct:
            result[key] = int(direct[name]) / 20
    if 'line' in direct or 'lineRule' in direct:
        rule = direct.get('lineRule', inherited['lineHeightRule'])
        assert rule in ['auto', 'exact', 'atLeast']
        raw = int(direct.get('line', '240'))
        assert raw > 0
        result['lineHeightRule'] = rule
        result['lineHeight'] = native_percent(raw) / 100 if rule == 'auto' else raw / 20

    return result


def inspect(filename):
    raw = raw_docx(filename)
    default = merge_complete(dict(spaceBefore=0, spaceAfter=0, lineHeight=1, lineHeightRule='auto'), raw['defaults'])

    def resolve(identifier, seen=()):
        if not identifier or identifier not in raw['styles']:
            return dict(default)
        assert identifier not in seen, 'Cyclic paragraph styles'
        style = raw['styles'][identifier]
        return merge_complete(resolve(style['basedOn'], (*seen, identifier)), style['spacing'])

    rows = []
    for p in raw['paragraphs']:
        source = resolve(p['styleId'])
        effective = merge_complete(source, p['spacing'])
        direct = {key: effective[key] for attr, key in [('before', 'spaceBefore'), ('after', 'spaceAfter')] if attr in p['spacing']}
        if 'line' in p['spacing'] or 'lineRule' in p['spacing']:
            direct.update({key: effective[key] for key in ['lineHeight', 'lineHeightRule']})
        rows.append(dict(**p, source=source, direct=direct, effective=effective))
    return dict(**{k: v for k, v in raw.items() if k != 'paragraphs'}, paragraphs=rows)


def inspect_pdf(filename):
    import fitz
    with fitz.open(filename) as doc:
        return [dict(page=page.number, text=span['text'], origin=span['origin'])
                for page in doc for block in page.get_text('dict')['blocks']
                for line in block.get('lines', []) for span in line['spans']]


if __name__ == '__main__':
    print(json.dumps(raw_docx(sys.argv[2]) if sys.argv[1] == '--raw' else inspect_pdf(sys.argv[2]) if sys.argv[1] == '--pdf' else inspect(sys.argv[1]), ensure_ascii=False))
