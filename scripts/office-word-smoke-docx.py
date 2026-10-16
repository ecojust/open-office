#!/usr/bin/env python3
"""Bounded, independent OOXML assertion for the native OfficeWord smoke specimen.

This is deliberately a narrow acceptance oracle, not a general DOCX importer.
Only Python's standard library is used; no product decoder or Office is invoked.
"""
import io
import json
from pathlib import Path
import posixpath
import re
import sys
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET

EXPECTED_TEXT = 'OfficeWord Native 中文😀'
EXPECTED_FORMAT = {'bold': True, 'italic': True, 'underline': True, 'size': 16, 'color': '336699'}
MAX_ZIP = 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_ENTRIES = 128
W_URI = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
W = '{' + W_URI + '}'
R_URI = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
XML = '{http://www.w3.org/XML/1998/namespace}'
MC = '{http://schemas.openxmlformats.org/markup-compatibility/2006}'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def attrs(element, allowed=()):
    require(set(element.attrib) <= set(allowed), 'unsupported attributes on ' + element.tag)


def container(element):
    require(not (element.text or '').strip(), 'unexpected text in ' + element.tag)
    require(all(not (child.tail or '').strip() for child in element), 'unexpected XML tail text')


def unique(element):
    result = {}
    container(element)
    for child in element:
        require(child.tag not in result, 'duplicate property ' + child.tag)
        result[child.tag] = child
    return result


def leaf(element, allowed=()):
    attrs(element, allowed)
    require(not list(element) and not (element.text or '').strip(), 'property is not a leaf: ' + element.tag)


def val(element, default=None):
    return element.get(W + 'val', default)


def boolean(element):
    leaf(element, [W + 'val'])
    value = val(element, '1')
    require(value in ('1', '0', 'true', 'false', 'on', 'off'), 'invalid on/off value')
    return value in ('1', 'true', 'on')


def number(value, message):
    require(value is not None and re.fullmatch(r'[0-9]{1,8}', value), message)
    return int(value)


def parse_xml(data):
    # NUL removal also detects declarations in UTF-16/32 before the XML parser sees them.
    declaration = data.replace(b'\0', b'').upper()
    require(b'<!DOCTYPE' not in declaration and b'<!ENTITY' not in declaration, 'DTD/entity declarations are forbidden')
    depth = count = 0
    parser = ET.iterparse(io.BytesIO(data), events=('start', 'end'))
    for event, _ in parser:
        if event == 'start':
            depth += 1
            count += 1
            require(depth <= 64 and count <= 50000, 'XML complexity limit exceeded')
        else:
            depth -= 1
    return parser.root


def package(path):
    require(path.stat().st_size <= MAX_ZIP, 'compressed ZIP exceeds 1 MiB')
    parts = {}
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(len(infos) <= MAX_ENTRIES, 'too many ZIP entries')
        require(sum(item.file_size for item in infos) <= MAX_TOTAL, 'expanded ZIP exceeds 16 MiB')
        names = set()
        for item in infos:
            name = item.filename
            require(name == item.orig_filename and '\x00' not in name and '\\' not in name and '%' not in name and ':' not in name, 'invalid ZIP name')
            require(not name.startswith('/') and all(p not in ('', '.', '..') for p in name.rstrip('/').split('/')), 'ZIP traversal or ambiguous name')
            require(name.casefold() not in names, 'duplicate ZIP entry')
            names.add(name.casefold())
            require(not item.flag_bits & 1, 'encrypted ZIP entry')
            require(item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'unsupported ZIP compression')
            require((item.external_attr >> 16) & 0o170000 != 0o120000, 'ZIP symlink entry')
            if item.is_dir():
                continue
            with archive.open(item) as stream:
                data = stream.read(MAX_TOTAL + 1)
            require(len(data) == item.file_size and len(data) <= MAX_TOTAL, 'invalid expanded ZIP size')
            parts[name] = data
    require('[Content_Types].xml' in parts and '_rels/.rels' in parts, 'missing OPC identity')
    trees = {name: parse_xml(data) for name, data in parts.items() if name.endswith(('.xml', '.rels'))}
    content_types = trees['[Content_Types].xml']
    require(content_types.tag == CT + 'Types', 'invalid content-types namespace')
    attrs(content_types)
    defaults, overrides = {}, {}
    for child in content_types:
        if child.tag == CT + 'Default':
            leaf(child, ['Extension', 'ContentType'])
            extension = child.get('Extension')
            require(extension and extension not in defaults, 'duplicate/invalid default MIME')
            defaults[extension] = child.get('ContentType')
        elif child.tag == CT + 'Override':
            leaf(child, ['PartName', 'ContentType'])
            name = child.get('PartName', '')
            require(name.startswith('/') and name[1:] in parts and name not in overrides, 'invalid/duplicate MIME override')
            overrides[name] = child.get('ContentType')
        else:
            raise ValueError('invalid content-types child')
    def mime(name):
        return overrides.get('/' + name, defaults.get(name.rsplit('.', 1)[-1]))
    for name in parts:
        if name != '[Content_Types].xml':
            require(mime(name), 'missing MIME for ' + name)
    relationships = {}
    for name, tree in trees.items():
        if not name.endswith('.rels'):
            continue
        require(tree.tag == REL + 'Relationships', 'invalid relationships namespace')
        attrs(tree)
        container(tree)
        if name == '_rels/.rels':
            owner = ''
        else:
            folder, file = posixpath.split(name)
            require(posixpath.basename(folder) == '_rels', 'invalid relationships location')
            owner = posixpath.join(posixpath.dirname(folder), file[:-5])
            require(owner in parts, 'orphan relationships owner')
        found = {}
        for rel in tree:
            require(rel.tag == REL + 'Relationship', 'invalid relationship child')
            leaf(rel, ['Id', 'Type', 'Target', 'TargetMode'])
            rid, target, kind = rel.get('Id'), rel.get('Target', ''), rel.get('Type', '')
            require(rid and rid not in found and kind, 'duplicate/invalid relationship')
            require(rel.get('TargetMode') in (None, 'Internal'), 'external relationship is not allowed in smoke output')
            url = urllib.parse.urlsplit(target)
            require(target and not (url.scheme or url.netloc or url.query or url.fragment) and '\\' not in target and '%' not in target, 'invalid relationship target')
            resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(owner), target))
            require(resolved != '..' and not resolved.startswith('../') and resolved in parts, 'missing or escaping relationship target')
            found[rid] = (kind, resolved)
        relationships[owner] = found
    root_rels = relationships.get('', {})
    mains = [target for kind, target in root_rels.values() if kind == R_URI + '/officeDocument']
    require(len(mains) == 1, 'one main document relationship is required')
    main = mains[0]
    require(mime(main) == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'main document MIME mismatch')
    allowed_main = {'styles', 'settings', 'theme', 'fontTable'}
    for kind, _ in relationships.get(main, {}).values():
        require(kind.startswith(R_URI + '/') and kind.rsplit('/', 1)[-1] in allowed_main, 'unsupported main-document relationship')
    styles = [target for kind, target in relationships.get(main, {}).values() if kind == R_URI + '/styles']
    require(len(styles) <= 1, 'duplicate styles relationships')
    if styles:
        require(mime(styles[0]) == 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', 'styles MIME mismatch')
    return trees[main], trees[styles[0]] if styles else ET.Element(W + 'styles')


def properties(element):
    out = {}
    if element is None:
        return out
    attrs(element)
    for tag, child in unique(element).items():
        local = tag.removeprefix(W)
        require(tag.startswith(W), 'foreign run property')
        if local in ('b', 'i', 'bCs', 'iCs'):
            out[{'b': 'bold', 'i': 'italic'}.get(local, local)] = boolean(child)
        elif local in ('sz', 'szCs'):
            leaf(child, [W + 'val'])
            out['size' if local == 'sz' else 'sizeCs'] = number(val(child), 'invalid half-point font size') / 2
        elif local == 'color':
            leaf(child, [W + 'val'])
            color = val(child, '')
            require(re.fullmatch('[0-9A-Fa-f]{6}', color) is not None, 'unsupported/theme/automatic color')
            out['color'] = color.upper()
        elif local == 'u':
            leaf(child, [W + 'val'])
            require(val(child, 'single') in ('single', 'none'), 'unsupported underline')
            out['underline'] = val(child, 'single') == 'single'
        elif local == 'rStyle':
            leaf(child, [W + 'val'])
            require(bool(val(child)), 'empty character style reference')
        elif local == 'rFonts':
            leaf(child, [W + p for p in ('ascii', 'hAnsi', 'eastAsia', 'cs', 'asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme', 'hint')])
        elif local == 'lang':
            leaf(child, [W + 'val', W + 'eastAsia', W + 'bidi'])
        elif local == 'kern':
            leaf(child, [W + 'val'])
            number(val(child), 'invalid kerning threshold')
        elif local == 'noProof':
            boolean(child)
        else:
            raise ValueError('unsupported or hidden run formatting: ' + local)
    return out


def merge(base, change, style=False):
    result = dict(base)
    for key, value in change.items():
        # OOXML bold/italic are toggle properties inside styles; direct formatting is absolute.
        if style and key in ('bold', 'italic', 'bCs', 'iCs'):
            if value:
                result[key] = not result.get(key, False)
        else:
            result[key] = value
    return result


def paragraph_properties(element):
    if element is None:
        return
    attrs(element)
    for tag, child in unique(element).items():
        require(tag.startswith(W), 'foreign paragraph property')
        local = tag.removeprefix(W)
        if local == 'rPr':
            properties(child)  # The paragraph mark never substitutes for run formatting.
        elif local == 'pStyle':
            leaf(child, [W + 'val'])
            require(bool(val(child)), 'empty paragraph style reference')
        elif local in ('widowControl', 'keepNext', 'keepLines', 'contextualSpacing'):
            boolean(child)
        elif local == 'spacing':
            leaf(child, [W + a for a in ('before', 'after', 'line', 'lineRule')])
            for attr in ('before', 'after', 'line'):
                if W + attr in child.attrib:
                    number(child.get(W + attr), 'invalid paragraph spacing')
            require(child.get(W + 'lineRule', 'auto') in ('auto', 'atLeast', 'exact'), 'invalid line rule')
        elif local == 'jc':
            leaf(child, [W + 'val'])
            require(val(child) in ('left', 'start'), 'unexpected paragraph alignment')
        else:
            raise ValueError('unsupported paragraph formatting: ' + local)


def inspect(path):
    document, styles = package(path)
    require(document.tag == W + 'document' and styles.tag == W + 'styles', 'invalid WordprocessingML namespace/root')
    attrs(document, [MC + 'Ignorable'])
    doc_children = unique(document)
    require(set(doc_children) == {W + 'body'}, 'unexpected document content')
    body = doc_children[W + 'body']
    attrs(body)
    container(body)
    require([e.tag for e in body] in ([W + 'p'], [W + 'p', W + 'sectPr']), 'smoke requires exactly one ordinary paragraph')
    defaults = styles.find(W + 'docDefaults')
    require(len(styles.findall(W + 'docDefaults')) <= 1, 'duplicate document defaults')
    base = {'bold': False, 'italic': False, 'underline': False}
    if defaults is not None:
        default_items = unique(defaults)
        require(set(default_items) <= {W + 'rPrDefault', W + 'pPrDefault'}, 'unsupported defaults')
        rd = default_items.get(W + 'rPrDefault')
        if rd is not None:
            require(set(unique(rd)) <= {W + 'rPr'}, 'invalid run defaults')
            base = merge(base, properties(rd.find(W + 'rPr')))
        pd = default_items.get(W + 'pPrDefault')
        if pd is not None:
            require(set(unique(pd)) <= {W + 'pPr'}, 'invalid paragraph defaults')
            paragraph_properties(pd.find(W + 'pPr'))
    style_map, default_styles = {}, {}
    for style in styles.findall(W + 'style'):
        sid = style.get(W + 'styleId')
        require(sid and sid not in style_map, 'duplicate/empty style id')
        style_map[sid] = style
        if style.get(W + 'default') in ('1', 'true', 'on'):
            kind = style.get(W + 'type')
            require(kind not in default_styles, 'duplicate default style')
            default_styles[kind] = sid
    def chain(sid, kind, seen=()):
        if sid is None:
            return []
        require(sid in style_map and sid not in seen, 'missing or cyclic style reference')
        style = style_map[sid]
        require(style.get(W + 'type') == kind, 'style type mismatch')
        items = unique(style)
        parent = val(items[W + 'basedOn']) if W + 'basedOn' in items else None
        paragraph_properties(items.get(W + 'pPr'))
        return chain(parent, kind, seen + (sid,)) + [properties(items.get(W + 'rPr'))]
    paragraph = body[0]
    attrs(paragraph, [W + key for key in ('rsidR', 'rsidRPr', 'rsidP', 'rsidRDefault')])
    container(paragraph)
    require(len(paragraph.findall(W + 'pPr')) <= 1, 'duplicate paragraph properties')
    pp = paragraph.find(W + 'pPr')
    paragraph_properties(pp)
    pstyle = pp.find(W + 'pStyle') if pp is not None else None
    for layer in chain(val(pstyle) if pstyle is not None else default_styles.get('paragraph'), 'paragraph'):
        base = merge(base, layer, style=True)
    runs = []
    for run in paragraph:
        if run.tag == W + 'pPr':
            continue
        require(run.tag == W + 'r', 'unsupported or hidden paragraph content')
        attrs(run, [W + 'rsidRPr', W + 'rsidR'])
        container(run)
        require(len(run.findall(W + 'rPr')) <= 1, 'duplicate run properties')
        rp = run.find(W + 'rPr')
        direct = properties(rp)
        rstyle = rp.find(W + 'rStyle') if rp is not None else None
        effective = dict(base)
        # The default character style is the UI's removal/default-style label;
        # its properties are not an implicit run layer without an rStyle reference.
        for layer in chain(val(rstyle) if rstyle is not None else None, 'character'):
            effective = merge(effective, layer, style=True)
        effective = merge(effective, direct)
        pieces = []
        for child in run:
            if child.tag == W + 'rPr':
                continue
            require(child.tag == W + 't', 'unsupported run content (fields, breaks, pictures, hidden text)')
            attrs(child, [XML + 'space'])
            require(not list(child) and child.get(XML + 'space', 'default') in ('default', 'preserve'), 'invalid text node')
            pieces.append(child.text or '')
        text = ''.join(pieces)
        require(bool(text), 'empty/extra run is not part of the smoke specimen')
        actual = {key: effective.get(key) for key in EXPECTED_FORMAT}
        require(actual == EXPECTED_FORMAT, 'text formatting mismatch: ' + json.dumps(actual))
        for key, expected in [('bCs', True), ('iCs', True), ('sizeCs', 16)]:
            require(key not in effective or effective[key] == expected, 'complex-script formatting mismatch')
        runs.append({'text': text, 'format': actual})
    text = ''.join(run['text'] for run in runs)
    require(text == EXPECTED_TEXT, 'smoke text mismatch: ' + repr(text))
    # A section may hold page geometry, but must not hide extra stories or objects.
    if len(body) == 2:
        section = body[1]
        attrs(section)
        for tag, child in unique(section).items():
            allowed = {'type': ['val'], 'pgSz': ['w', 'h', 'orient'], 'pgMar': ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'], 'cols': ['space', 'num', 'equalWidth']}
            local = tag.removeprefix(W)
            require(tag.startswith(W) and local in allowed, 'unsupported section content')
            leaf(child, [W + key for key in allowed[local]])
    return {'text': text, 'paragraphs': [{'text': text, 'runs': runs}], 'format': dict(EXPECTED_FORMAT)}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'usage: office-word-smoke-docx.py FILE.docx')
        print(json.dumps(inspect(Path(sys.argv[1]))))
    except (ValueError, OSError, KeyError, ET.ParseError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        print('DOCX smoke validation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
