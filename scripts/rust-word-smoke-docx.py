#!/usr/bin/env python3
"""Independent, bounded ZIP/XML verification of the native Rust Word fixture.

Only Python's standard library is used. This verifies exported document bytes,
not GUI interactions or general DOCX compatibility, and imports no product code.
"""
import io
import json
from pathlib import Path
import sys
import zipfile
from xml.etree import ElementTree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
Q = lambda name: '{' + W + '}' + name
EXPECTED_TEXT = ['Rust 正文 中文😀', 'Second paragraph']
EXPECTED_PARTS = {'[Content_Types].xml', '_rels/.rels', 'word/document.xml',
                  'word/_rels/document.xml.rels', 'word/settings.xml'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_children(node, allowed):
    children = list(node)
    require(all(child.tag in allowed for child in children), 'Unexpected XML element')
    require(len({child.tag for child in children}) == len(children), 'Duplicate XML property')
    return {child.tag: child for child in children}


def relationship(root, suffix, target):
    require(root.tag == '{' + REL + '}Relationships' and len(root) == 1, 'Invalid relationships part')
    child = root[0]
    require(child.tag == '{' + REL + '}Relationship' and bool(child.get('Id'))
            and child.get('Type') == R + '/' + suffix and child.get('Target') == target
            and child.get('TargetMode', 'Internal') == 'Internal', 'Invalid internal relationship')


def verify(data):
    require(0 < len(data) < 1024 * 1024, 'DOCX exceeds fixture bound')
    require(len(data) > 100 and data[:4] == b'PK\x03\x04', 'DOCX is not a ZIP package')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        require(len(members) == len(EXPECTED_PARTS), 'Unexpected ZIP entry count')
        names = [member.filename for member in members]
        require(len(set(names)) == len(names) and set(names) == EXPECTED_PARTS, 'Unexpected or duplicate ZIP parts')
        require(sum(member.file_size for member in members) <= 2 * 1024 * 1024
                and all(member.file_size <= 1024 * 1024 and not member.flag_bits & 1
                        for member in members), 'ZIP members exceed fixture bounds or are encrypted')
        xml = {}
        for name in names:
            raw = archive.read(name)  # zipfile verifies each CRC before XML parsing.
            require(b'<!DOCTYPE' not in raw.upper() and b'<!ENTITY' not in raw.upper(), 'XML declarations are not allowed')
            xml[name] = ET.fromstring(raw)

    types = xml['[Content_Types].xml']
    require(types.tag == '{' + CT + '}Types', 'Invalid content-types namespace')
    defaults, overrides = {}, {}
    for node in types:
        require(len(node) == 0, 'Nested content type')
        if node.tag == '{' + CT + '}Default':
            key = node.get('Extension')
            require(key not in defaults, 'Duplicate default content type')
            defaults[key] = node.get('ContentType')
        else:
            require(node.tag == '{' + CT + '}Override', 'Invalid content type element')
            key = node.get('PartName')
            require(key not in overrides, 'Duplicate override content type')
            overrides[key] = node.get('ContentType')
    require(defaults == {'rels': 'application/vnd.openxmlformats-package.relationships+xml', 'xml': 'application/xml'}, 'Missing package default content types')
    require(overrides == {'/word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
                          '/word/settings.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'}, 'Invalid Word part content types')
    relationship(xml['_rels/.rels'], 'officeDocument', 'word/document.xml')
    relationship(xml['word/_rels/document.xml.rels'], 'settings', 'settings.xml')
    settings = xml['word/settings.xml']
    require(settings.tag == Q('settings') and len(settings) == 1 and settings[0].tag == Q('defaultTabStop')
            and settings[0].get(Q('val')) == '720', 'Invalid default tab stop')

    document = xml['word/document.xml']
    require(document.tag == Q('document') and len(document) == 1 and document[0].tag == Q('body'), 'Invalid Word document root')
    body = document[0]
    require([node.tag for node in body] == [Q('p'), Q('p'), Q('sectPr')], 'Expected exactly two body paragraphs and one section')
    for index, paragraph in enumerate(list(body)[:2]):
        require(len(paragraph) >= 2 and paragraph[0].tag == Q('pPr')
                and all(node.tag == Q('r') for node in list(paragraph)[1:]), 'Invalid fixture paragraph content')
        props = unique_children(paragraph[0], {Q(name) for name in ('jc', 'widowControl', 'spacing', 'suppressAutoHyphens')})
        require(Q('jc') in props and props[Q('jc')].get(Q('val')) == ('center' if index == 0 else 'left'), 'Paragraph alignment changed')
        text = ''
        for run in list(paragraph)[1:]:
            require(len(run) >= 2 and run[0].tag == Q('rPr')
                    and all(node.tag == Q('t') and len(node) == 0 for node in list(run)[1:]), 'Invalid fixture text run')
            rp = unique_children(run[0], {Q(name) for name in ('rFonts', 'b', 'i', 'sz', 'color')})
            require(len(rp) == 5, 'Missing explicit fixture run formatting')
            require(rp[Q('b')].get(Q('val')) == ('1' if index == 0 else '0')
                    and rp[Q('i')].get(Q('val')) == ('1' if index == 0 else '0'), 'Bold or italic formatting changed')
            require(rp[Q('sz')].get(Q('val')) == ('28' if index == 0 else '24'), 'Font size changed')
            require(rp[Q('color')].get(Q('val')) == ('C00000' if index == 0 else '20242B'), 'Text color changed')
            require(all(rp[Q('rFonts')].get(Q(slot)) == 'DejaVu Sans' for slot in ('ascii', 'hAnsi', 'eastAsia', 'cs')), 'Font family changed')
            require(not any(rp[Q('color')].get(Q(key)) is not None for key in ('themeColor', 'themeTint', 'themeShade')), 'Theme color overrides fixture color')
            text += ''.join(node.text or '' for node in list(run)[1:])
        require(text == EXPECTED_TEXT[index], 'Chinese, emoji, or paragraph text changed')
    section = unique_children(body[-1], {Q('pgSz'), Q('pgMar')})
    require(set(section) == {Q('pgSz'), Q('pgMar')}, 'Missing page geometry')
    size, margin = section[Q('pgSz')], section[Q('pgMar')]
    width, height = (int(size.get(Q(key))) for key in ('w', 'h'))
    top, bottom, left, right = (int(margin.get(Q(key))) for key in ('top', 'bottom', 'left', 'right'))
    require(0 <= left + right < width <= 31680 and 0 <= top + bottom < height <= 31680
            and min(top, bottom, left, right) >= 0, 'Invalid page geometry')
    return {'ok': True, 'docxBytes': len(data), 'zipEntries': names, 'paragraphs': EXPECTED_TEXT,
            'firstParagraphFormat': {'bold': True, 'italic': True, 'fontSize': 14, 'color': '#C00000', 'align': 'center'}}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'Pass the exported fixture DOCX path')
        with Path(sys.argv[1]).open('rb') as source:
            print(json.dumps(verify(source.read(1024 * 1024 + 1)), ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
