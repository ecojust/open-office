#!/usr/bin/env python3
"""External OOXML/PDF evidence reader. Does not load product code or WASM."""
import hashlib
import json
import posixpath
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
W = '{' + NS['w'] + '}'
R = '{' + NS['r'] + '}'

def value(el, name='val', fallback=None):
    return el.get(W + name, fallback) if el is not None else fallback

def on(el):
    return value(el, fallback='1') not in ('0', 'false', 'off')

def rprops(el):
    out = {}
    if el is None:
        return out
    for tag, key in [('b', 'bold'), ('i', 'italic'), ('strike', 'strike')]:
        item = el.find('w:' + tag, NS)
        if item is not None:
            out[key] = on(item)
    for tag, key in [('u', 'underline'), ('highlight', 'highlight'), ('vertAlign', 'verticalAlign')]:
        item = el.find('w:' + tag, NS)
        if item is not None:
            out[key] = value(item, fallback='single' if tag == 'u' else 'none')
    item = el.find('w:sz', NS)
    if item is not None:
        out['fontSize'] = float(value(item)) / 2
    item = el.find('w:color', NS)
    if item is not None:
        color = value(item, fallback='auto')
        out['color'] = color if color == 'auto' else '#' + color.upper()
    item = el.find('w:rFonts', NS)
    if item is not None:
        for attr, key in [('ascii', 'fontFamily'), ('eastAsia', 'eastAsiaFont')]:
            if value(item, attr) is not None:
                out[key] = value(item, attr)
    return out

def pprops(el):
    out = {}
    if el is None:
        return out
    item = el.find('w:jc', NS)
    if item is not None:
        align = value(item)
        rtl = el.find('w:bidi', NS)
        rtl = rtl is not None and on(rtl)
        out['align'] = ('right' if rtl else 'left') if align == 'start' else ('left' if rtl else 'right') if align == 'end' else align
    item = el.find('w:spacing', NS)
    if item is not None:
        for attr, key in [('before', 'spacingBefore'), ('after', 'spacingAfter')]:
            if value(item, attr) is not None:
                out[key] = float(value(item, attr)) / 20
        if value(item, 'line') is not None:
            rule = value(item, 'lineRule', 'auto')
            out['lineSpacing'] = float(value(item, 'line')) / (240 if rule == 'auto' else 20)
            out['lineRule'] = rule
    item = el.find('w:ind', NS)
    if item is not None:
        for attr, key in [('left', 'indentLeft'), ('right', 'indentRight'), ('firstLine', 'indentFirstLine')]:
            if value(item, attr) is not None:
                out[key] = float(value(item, attr)) / 20
        if value(item, 'hanging') is not None:
            out['indentFirstLine'] = -float(value(item, 'hanging')) / 20
        # LibreOffice writes the OOXML logical start/end form for ordinary LTR indents.
        rtl = el.find('w:bidi', NS)
        rtl = rtl is not None and on(rtl)
        for attr, key in [('start', 'indentRight' if rtl else 'indentLeft'), ('end', 'indentLeft' if rtl else 'indentRight')]:
            if value(item, attr) is not None:
                out[key] = float(value(item, attr)) / 20
    return out

def inspect(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None, 'ZIP CRC error'
        assert len(set(z.namelist())) == len(z.namelist()), 'duplicate ZIP entry'
        def xml(part):
            data = z.read(part)
            assert b'<!DOCTYPE' not in data and b'<!ENTITY' not in data, 'DTD not accepted by oracle'
            return ET.fromstring(data)
        def rels(part):
            rp = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels') if part else '_rels/.rels'
            if rp not in z.namelist():
                return {}
            return {r.get('Id'): {'type': r.get('Type').rsplit('/', 1)[-1], 'target': r.get('Target') if r.get('TargetMode') == 'External' else posixpath.normpath(posixpath.join(posixpath.dirname(part), r.get('Target'))).lstrip('/'), 'external': r.get('TargetMode') == 'External'} for r in xml(rp)}
        main = next(r['target'] for r in rels('').values() if r['type'] == 'officeDocument')
        relationships = rels(main)
        styles_part = next((r['target'] for r in relationships.values() if r['type'] == 'styles'), None)
        styles = xml(styles_part) if styles_part else ET.Element('styles')
        default_r = {'bold': False, 'italic': False, 'strike': False, 'underline': 'none', 'highlight': 'none', 'verticalAlign': 'baseline', 'color': 'auto', **rprops(styles.find('w:docDefaults/w:rPrDefault/w:rPr', NS))}
        default_p = {'align': 'left', 'spacingBefore': 0, 'spacingAfter': 0, 'indentLeft': 0, 'indentRight': 0, 'indentFirstLine': 0, **pprops(styles.find('w:docDefaults/w:pPrDefault/w:pPr', NS))}
        style_map = {value(e, 'styleId'): e for e in styles.findall('w:style', NS)}
        default_style = next((value(e, 'styleId') for e in style_map.values() if value(e, 'type') == 'paragraph' and value(e, 'default') == '1'), None)
        def inherited(name, kind, visited=()):
            if not name or name not in style_map:
                return {}
            assert name not in visited, 'style cycle'
            el = style_map[name]
            parent = value(el.find('w:basedOn', NS))
            return {**inherited(parent, kind, visited + (name,)), **(rprops if kind == 'rPr' else pprops)(el.find('w:' + kind, NS))}
        paragraphs, tables, images, fields = [], [], [], []
        def paragraph(p, part, location):
            pp = p.find('w:pPr', NS)
            style = value(pp.find('w:pStyle', NS)) if pp is not None else None
            style = style or default_style
            paragraph_style = {**default_p, **inherited(style, 'pPr'), **pprops(pp)}
            base = {**default_r, **inherited(style, 'rPr')}
            runs = []
            for r in p.iter(W + 'r'):
                rp = r.find('w:rPr', NS)
                rs = value(rp.find('w:rStyle', NS)) if rp is not None else None
                text = ''.join((e.text or '') if e.tag == W + 't' else '\t' if e.tag == W + 'tab' else '\n' if e.tag in (W + 'br', W + 'cr') else '' for e in r)
                if text:
                    runs.append({'text': text, 'style': {**base, **inherited(rs, 'rPr'), **rprops(rp)}})
            for field in p.iter(W + 'fldSimple'):
                fields.append({'part': part, 'instruction': value(field, 'instr', '').strip()})
            for field in p.iter(W + 'instrText'):
                fields.append({'part': part, 'instruction': (field.text or '').strip()})
            numbering = pp.find('w:numPr', NS) if pp is not None else None
            result = {'part': part, 'location': location, 'text': ''.join(r['text'] for r in runs), 'style': paragraph_style, 'runs': runs, 'characters': [{'text': ch, **r['style']} for r in runs for ch in r['text']]}
            if numbering is not None:
                result['numbering'] = {'id': value(numbering.find('w:numId', NS)), 'level': value(numbering.find('w:ilvl', NS), fallback='0')}
            paragraphs.append(result)
            for draw in p.iter(W + 'drawing'):
                extent = draw.find('.//wp:extent', NS)
                props = draw.find('.//wp:docPr', NS)
                for blip in draw.findall('.//a:blip', NS):
                    rid = blip.get(R + 'embed')
                    rel = rels(part).get(rid)
                    assert rel and not rel['external'] and rel['target'] in z.namelist(), 'unresolved image'
                    raw = z.read(rel['target'])
                    images.append({'part': part, 'target': rel['target'], 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'width': int(extent.get('cx')) / 12700 if extent is not None else None, 'height': int(extent.get('cy')) / 12700 if extent is not None else None, 'alt': props.get('descr', '') if props is not None else ''})
        def blocks(root, part, prefix):
            for i, child in enumerate(root):
                loc = prefix + [i]
                if child.tag == W + 'p':
                    paragraph(child, part, loc)
                elif child.tag == W + 'tbl':
                    rows = child.findall('w:tr', NS)
                    table = {'part': part, 'location': loc, 'rows': len(rows), 'columns': [len(row.findall('w:tc', NS)) for row in rows], 'grid': [int(value(g, 'w')) / 20 for g in child.findall('w:tblGrid/w:gridCol', NS)], 'cells': []}
                    for ri, row in enumerate(rows):
                        for ci, cell in enumerate(row.findall('w:tc', NS)):
                            before = len(paragraphs)
                            blocks(cell, part, loc + ['row', ri, 'cell', ci])
                            table['cells'].append({'row': ri, 'column': ci, 'text': '\n'.join(p['text'] for p in paragraphs[before:])})
                    tables.append(table)
                elif child.tag in (W + 'sdt', W + 'sdtContent'):
                    blocks(child, part, loc)
        document = xml(main)
        body = document.find('w:body', NS)
        blocks(body, main, ['body'])
        for rel in relationships.values():
            if rel['type'] in ('header', 'footer'):
                blocks(xml(rel['target']), rel['target'], [rel['type']])
        sections = []
        for sect in document.iter(W + 'sectPr'):
            sz, margin = sect.find('w:pgSz', NS), sect.find('w:pgMar', NS)
            sections.append({'width': float(value(sz, 'w')) / 20, 'height': float(value(sz, 'h')) / 20, 'margins': {k: float(value(margin, k)) / 20 for k in ['top', 'right', 'bottom', 'left', 'header', 'footer'] if value(margin, k) is not None}})
        return {'paragraphs': paragraphs, 'tables': tables, 'images': images, 'fields': fields, 'sections': sections, 'parts': sorted(z.namelist())}

def inspect_pdf(path):
    import fitz
    with fitz.open(path) as document:
        return {'pages': len(document), 'text': '\n'.join(p.get_text() for p in document), 'spans': [{'text': s['text'], 'size': s['size'], 'color': s['color'], 'font': s['font']} for p in document for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]}

if __name__ == '__main__':
    print(json.dumps(inspect_pdf(sys.argv[2]) if sys.argv[1] == '--pdf' else inspect(sys.argv[1]), ensure_ascii=False))
