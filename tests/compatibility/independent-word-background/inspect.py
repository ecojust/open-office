#!/usr/bin/env python3
"""Independently resolve DOCX run formatting, including independent background and highlight layers.

Uses Python's XML and ZIP libraries only; never calls the application's codec.
The generated corpus avoids toggle-style ancestry ambiguities. For synthetic
checks, strike/dstrike precedence follows LibreOffice's documented importer.
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
    if node is None: return result
    for tag, field in [('b','bold'), ('i','italic')]:
        child = node.find('w:'+tag, NS)
        if child is not None: result[field] = on(child)
    u = node.find('w:u', NS)
    if u is not None: result['underline'] = value(u, 'single') != 'none'
    strike, double = node.find('w:strike', NS), node.find('w:dstrike', NS)
    if strike is not None or double is not None:
        result['strike'] = 'double' if double is not None and on(double) else 'single' if strike is not None and on(strike) else 'none'
    shd = node.find('w:shd', NS)
    if shd is not None:
        assert value(shd) == 'clear', 'Only explicit clear shading is in this corpus'
        fill = shd.get(q('fill'))
        assert fill is not None, 'Missing fill has distinct inheritance semantics'
        result['backgroundColor'] = 'none' if fill == 'auto' else '#' + fill.upper()
    for tag, field, convert in [('highlight','highlight',str), ('vertAlign','verticalAlign',str), ('sz','fontSize',lambda x:int(x)/2), ('szCs','fontSizeCs',lambda x:int(x)/2), ('color','color',str), ('kern','kern',int)]:
        v = value(node.find('w:'+tag,NS))
        if v is not None: result[field] = convert(v)
    for tag, attrs in [('rFonts',['ascii','hAnsi','eastAsia','cs']),('lang',['val','eastAsia','bidi'])]:
        child = node.find('w:'+tag,NS)
        if child is not None:
            result.update({tag+':'+a:child.get(q(a)) for a in attrs if child.get(q(a)) is not None})
    return result

def inspect(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml','.rels')): E.fromstring(archive.read(name))
        styles, defaults, default_id = {}, {}, None
        if 'word/styles.xml' in archive.namelist():
            sheet = E.fromstring(archive.read('word/styles.xml'))
            styles = {s.get(q('styleId')):s for s in sheet.findall('w:style',NS)}
            defaults = props(sheet.find('w:docDefaults/w:rPrDefault/w:rPr',NS))
            default_id = next((k for k,s in styles.items() if s.get(q('type')) == 'paragraph' and s.get(q('default')) in ['1','true']),None)
        def chain(sid, seen=()):
            if sid not in styles: return []
            assert sid not in seen, 'Circular style ancestry'
            s = styles[sid]
            return chain(value(s.find('w:basedOn',NS)),(*seen,sid))+[s]
        document = E.fromstring(archive.read('word/document.xml'))
        paragraphs = []
        for p in document.findall('w:body/w:p',NS):
            inherited = {'fontSize':12,'verticalAlign':'baseline','strike':'none','underline':False,'highlight':'none','backgroundColor':'none', **defaults}
            for s in chain(value(p.find('w:pPr/w:pStyle',NS), default_id)):
                inherited.update(props(s.find('w:rPr',NS)))
            runs = []
            for r in p.findall('w:r',NS):
                style = dict(inherited)
                for s in chain(value(r.find('w:rPr/w:rStyle',NS))):
                    character_style = props(s.find('w:rPr',NS))
                    character_style.pop('highlight', None)  # Writer ignores character-style highlight.
                    style.update(character_style)
                direct = props(r.find('w:rPr',NS)); style.update(direct)
                text = ''.join((n.text or '') if n.tag == q('t') else '\n' if n.tag in [q('br'),q('cr')] else '\t' if n.tag == q('tab') else '' for n in r)
                if text: runs.append({'text':text,'style':style,'directStyle':direct})
            characters = [{'character':char, **{k:r['style'][k] for k in ['fontSize','verticalAlign','strike','underline','highlight','backgroundColor']}} for r in runs for char in r['text']]
            paragraphs.append({'text':''.join(r['text'] for r in runs),'characters':characters,'runs':runs,'sourceStyle':inherited,'paragraphMarkStyle':props(p.find('w:pPr/w:rPr',NS))})
        return {'paragraphs':paragraphs,'zipEntries':len(archive.namelist())}

if __name__ == '__main__': print(json.dumps(inspect(sys.argv[1]),ensure_ascii=False))
