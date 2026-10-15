#!/usr/bin/env python3
"""Independent ZIP/XML oracle for the first Rust Word editing subset.

No application module or model is imported. This reports effective basic body
formatting, explicit paragraph boundaries and page geometry from complete DOCX
packages. Unsupported OOXML is deliberately reported separately, not interpreted
as supported merely because a text node can be found inside it.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
Q = lambda key: '{' + W + '}' + key


def value(node, default=None):
    return node.get(Q('val'), default) if node is not None else default


def run_properties(node):
    result = {}
    if node is None:
        return result
    for tag, field in [('b', 'bold'), ('i', 'italic')]:
        child = node.find('w:' + tag, NS)
        if child is not None:
            result[field] = value(child, '1') not in ('0', 'false', 'off')
    size = value(node.find('w:sz', NS))
    if size is not None:
        result['fontSize'] = int(size) / 2
    color = value(node.find('w:color', NS))
    if color is not None:
        result['color'] = color if color == 'auto' else '#' + color.upper()
    fonts = node.find('w:rFonts', NS)
    if fonts is not None:
        # Keep all script slots to detect silently replacing a native font.
        for slot in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
            if fonts.get(Q(slot)) is not None:
                result['font:' + slot] = fonts.get(Q(slot))
    return result


def inspect(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None, 'CRC failure'
        names = archive.namelist()
        assert len(names) == len(set(names)), 'duplicate ZIP member'
        for name in names:
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
        document = ET.fromstring(archive.read('word/document.xml'))
        styles_xml = ET.fromstring(archive.read('word/styles.xml')) if 'word/styles.xml' in names else ET.Element(Q('styles'))
        styles = {node.get(Q('styleId')): node for node in styles_xml.findall('w:style', NS)}
        default_id = next((key for key, node in styles.items() if node.get(Q('type')) == 'paragraph' and node.get(Q('default')) in ('1', 'true')), None)
        base = {'bold': False, 'italic': False, 'fontSize': 12, 'color': 'auto'}
        base.update(run_properties(styles_xml.find('w:docDefaults/w:rPrDefault/w:rPr', NS)))

        def ancestry(identifier, seen=()):
            if identifier is None:
                return []
            assert identifier in styles, 'unknown style: ' + identifier
            assert identifier not in seen, 'circular styles'
            node = styles[identifier]
            return ancestry(value(node.find('w:basedOn', NS)), (*seen, identifier)) + [node]

        paragraphs = []
        for paragraph in document.findall('w:body/w:p', NS):
            inherited = dict(base)
            alignment = 'left'
            for style in ancestry(value(paragraph.find('w:pPr/w:pStyle', NS), default_id)):
                inherited.update(run_properties(style.find('w:rPr', NS)))
                alignment = value(style.find('w:pPr/w:jc', NS), alignment)
            alignment = value(paragraph.find('w:pPr/w:jc', NS), alignment)
            alignment = {'start': 'left', 'end': 'right'}.get(alignment, alignment)
            runs = []
            for run in paragraph.findall('w:r', NS):
                style = dict(inherited)
                for character in ancestry(value(run.find('w:rPr/w:rStyle', NS))):
                    style.update(run_properties(character.find('w:rPr', NS)))
                style.update(run_properties(run.find('w:rPr', NS)))
                text = ''.join((node.text or '') if node.tag == Q('t') else '\t' if node.tag == Q('tab') else '\n' if node.tag in (Q('br'), Q('cr')) else '' for node in run)
                runs.append({'text': text, 'style': style})
            paragraphs.append({'text': ''.join(run['text'] for run in runs), 'align': alignment, 'runs': runs,
                               'characters': [{'character': character, **run['style']} for run in runs for character in run['text']]})
        section = document.find('w:body/w:sectPr', NS)
        page = {}
        if section is not None:
            size = section.find('w:pgSz', NS)
            if size is not None:
                page.update({key: int(size.get(Q(attr))) / 20 for key, attr in [('width', 'w'), ('height', 'h')]})
            margins = section.find('w:pgMar', NS)
            if margins is not None:
                page.update({key: int(margins.get(Q(attr))) / 20 for key, attr in [('marginTop', 'top'), ('marginBottom', 'bottom'), ('marginLeft', 'left'), ('marginRight', 'right')]})
        unsupported = sorted({node.tag.split('}')[-1] for node in document.iter() if node.tag in {Q(tag) for tag in ('tbl', 'drawing', 'pict', 'hyperlink', 'fldSimple', 'instrText', 'commentReference', 'footnoteReference', 'endnoteReference')}})
        tab_stop = None
        if 'word/settings.xml' in names:
            settings = ET.fromstring(archive.read('word/settings.xml'))
            token = value(settings.find('w:defaultTabStop', NS))
            if token is not None:
                tab_stop = int(token) / 20
        return {'paragraphs': paragraphs, 'page': page, 'defaultTabStop': tab_stop, 'zipEntries': names, 'unsupported': unsupported}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
