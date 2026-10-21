#!/usr/bin/env python3
"""Independent, bounded inspection of the seven native MCP smoke exports.

No application decoder is imported. OOXML is read as OPC/XML, PDF through
an independent inspector, and notebook/workflow documents as persisted JSON.
"""
import importlib.util
import json
from pathlib import Path
import posixpath
import re
import sys
import urllib.parse
import zipfile

spec = importlib.util.spec_from_file_location(
    "office_docx_oracle", Path(__file__).with_name("office-word-smoke-docx.py")
)
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
require = oracle.require
MAX_FILE = 8 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
MAX_PART = 16 * 1024 * 1024
MAX_ENTRIES = 512
oracle.MAX_ZIP = MAX_FILE
oracle.MAX_TOTAL = MAX_EXPANDED
oracle.MAX_ENTRIES = MAX_ENTRIES
W, R_URI, REL, CT = oracle.W, oracle.R_URI, oracle.REL, oracle.CT
R = '{' + R_URI + '}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'


def checked_file(folder, name):
    path = folder / name
    require(path.is_file() and not path.is_symlink(), 'missing/non-regular export: ' + name)
    require(0 < path.stat().st_size <= MAX_FILE, 'export must be between 1 byte and 8 MiB: ' + name)
    return path


def word(path):
    document, styles = oracle.package(path)
    require(document.tag == W + 'document' and styles.tag == W + 'styles', 'invalid Word namespaces')
    children = list(document)
    require(len(children) == 1 and children[0].tag == W + 'body', 'invalid Word body')
    body = children[0]
    oracle.container(body)
    require([item.tag for item in body] in ([W + 'p'], [W + 'p', W + 'sectPr']), 'Word specimen must have one ordinary paragraph')
    base = {'bold': False}
    defaults = styles.findall(W + 'docDefaults')
    require(len(defaults) <= 1, 'duplicate Word defaults')
    if defaults:
        items = oracle.unique(defaults[0])
        require(set(items) <= {W + 'rPrDefault', W + 'pPrDefault'}, 'unsupported Word defaults')
        if W + 'rPrDefault' in items:
            rd = items[W + 'rPrDefault']
            require(set(oracle.unique(rd)) <= {W + 'rPr'}, 'unsupported run defaults')
            base.update(oracle.properties(rd.find(W + 'rPr')))
        if W + 'pPrDefault' in items:
            pd = items[W + 'pPrDefault']
            require(set(oracle.unique(pd)) <= {W + 'pPr'}, 'unsupported paragraph defaults')
            oracle.paragraph_properties(pd.find(W + 'pPr'))
    style_map, default_styles = {}, {}
    for style in styles.findall(W + 'style'):
        sid = style.get(W + 'styleId')
        require(sid and sid not in style_map, 'duplicate/invalid Word style')
        style_map[sid] = style
        if style.get(W + 'default') in ('1', 'true', 'on'):
            kind = style.get(W + 'type')
            require(kind not in default_styles, 'duplicate default Word style')
            default_styles[kind] = sid

    def layers(sid, kind, seen=()):
        if sid is None:
            return []
        require(sid in style_map and sid not in seen and len(seen) < 32, 'invalid/cyclic Word style reference')
        style = style_map[sid]
        require(style.get(W + 'type') == kind, 'Word style type mismatch')
        items = oracle.unique(style)
        parent = oracle.val(items[W + 'basedOn']) if W + 'basedOn' in items else None
        oracle.paragraph_properties(items.get(W + 'pPr'))
        return layers(parent, kind, seen + (sid,)) + [oracle.properties(items.get(W + 'rPr'))]

    paragraph = body[0]
    oracle.container(paragraph)
    require(len(paragraph.findall(W + 'pPr')) <= 1, 'duplicate paragraph properties')
    pp = paragraph.find(W + 'pPr')
    oracle.paragraph_properties(pp)
    pstyle = pp.find(W + 'pStyle') if pp is not None else None
    for layer in layers(oracle.val(pstyle) if pstyle is not None else default_styles.get('paragraph'), 'paragraph'):
        base = oracle.merge(base, layer, style=True)
    texts = []
    for run in paragraph:
        if run.tag == W + 'pPr':
            continue
        require(run.tag == W + 'r', 'hidden/unsupported Word paragraph content')
        oracle.container(run)
        require(len(run.findall(W + 'rPr')) <= 1, 'duplicate run properties')
        rp = run.find(W + 'rPr')
        direct = oracle.properties(rp)  # Reject hidden, field and unsupported formatting.
        rstyle = rp.find(W + 'rStyle') if rp is not None else None
        effective = dict(base)
        for layer in layers(oracle.val(rstyle) if rstyle is not None else None, 'character'):
            effective = oracle.merge(effective, layer, style=True)
        effective = oracle.merge(effective, direct)
        pieces = []
        for child in run:
            if child.tag == W + 'rPr':
                continue
            require(child.tag == W + 't' and not list(child), 'Word text must be an ordinary visible run')
            oracle.attrs(child, [oracle.XML + 'space'])
            require(child.get(oracle.XML + 'space', 'default') in ('default', 'preserve'), 'invalid Word text whitespace')
            pieces.append(child.text or '')
        text = ''.join(pieces)
        require(text, 'empty Word run in specimen')
        actual = {key: effective.get(key) for key in ('bold', 'size', 'color')}
        require(actual == {'bold': True, 'size': 22, 'color': 'D52B3F'}, 'Word body run formatting mismatch: ' + json.dumps(actual))
        require(effective.get('bCs', True) is True and effective.get('sizeCs', 22) == 22, 'Word complex-script formatting mismatch')
        texts.append(text)
    require(''.join(texts) == 'NATIVE_MCP_ROUNDTRIP 中文', 'Word body text mismatch')
    if len(body) == 2:
        for tag, child in oracle.unique(body[-1]).items():
            allowed = {'type': ['val'], 'pgSz': ['w', 'h', 'orient'], 'pgMar': ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'], 'cols': ['space', 'num', 'equalWidth']}
            local = tag.removeprefix(W)
            require(tag.startswith(W) and local in allowed, 'unsupported Word section content')
            oracle.leaf(child, [W + key for key in allowed[local]])
    return True


class Package:
    def __init__(self, path, main_mime):
        self.parts = {}
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            require(len(infos) <= MAX_ENTRIES, 'too many ZIP entries')
            require(sum(info.file_size for info in infos) <= MAX_EXPANDED, 'ZIP expands beyond 64 MiB')
            names = set()
            for info in infos:
                name = info.filename
                require(name == info.orig_filename and not any(char in name for char in ('\x00', '\\', '%', ':')), 'invalid ZIP name')
                require(not name.startswith('/') and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/')), 'ZIP traversal/ambiguous name')
                require(name.casefold() not in names, 'duplicate ZIP part')
                names.add(name.casefold())
                require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'encrypted/unsupported ZIP part')
                require((info.external_attr >> 16) & 0o170000 != 0o120000, 'ZIP symlink')
                if info.is_dir():
                    continue
                require(info.file_size <= MAX_PART, 'ZIP part exceeds 16 MiB')
                with archive.open(info) as stream:
                    data = stream.read(MAX_PART + 1)
                require(len(data) == info.file_size, 'ZIP size mismatch')
                self.parts[name] = data
        require('[Content_Types].xml' in self.parts and '_rels/.rels' in self.parts, 'missing OPC identity')
        self.trees = {name: oracle.parse_xml(data) for name, data in self.parts.items() if name.endswith(('.xml', '.rels'))}
        types = self.trees['[Content_Types].xml']
        require(types.tag == CT + 'Types', 'invalid content types')
        overrides, defaults = {}, {}
        for item in types:
            if item.tag == CT + 'Override':
                name = item.get('PartName', '')
                require(name.startswith('/') and name[1:] in self.parts and name not in overrides, 'invalid/duplicate MIME override')
                overrides[name] = item.get('ContentType')
            elif item.tag == CT + 'Default':
                extension = item.get('Extension')
                require(extension and extension not in defaults, 'invalid/duplicate MIME default')
                defaults[extension] = item.get('ContentType')
            else:
                raise ValueError('unexpected content type element')
        roots = [target for kind, target in self.relationships('').values() if kind == R_URI + '/officeDocument']
        require(len(roots) == 1, 'expected one main OPC document')
        self.main = roots[0]
        require(overrides.get('/' + self.main, defaults.get(self.main.rsplit('.', 1)[-1])) == main_mime, 'main document MIME mismatch')

    def relationships(self, owner):
        rel_path = posixpath.join(posixpath.dirname(owner), '_rels', posixpath.basename(owner) + '.rels') if owner else '_rels/.rels'
        tree = self.trees.get(rel_path)
        require(tree is not None and tree.tag == REL + 'Relationships', 'missing/invalid relationships: ' + rel_path)
        result = {}
        for rel in tree:
            require(rel.tag == REL + 'Relationship' and not list(rel), 'invalid relationship element')
            rid, kind, target = rel.get('Id'), rel.get('Type'), rel.get('Target', '')
            require(rid and rid not in result and kind, 'duplicate/invalid relationship')
            require(rel.get('TargetMode') in (None, 'Internal'), 'external relationship in smoke specimen')
            url = urllib.parse.urlsplit(target)
            require(target and not (url.scheme or url.netloc or url.query or url.fragment) and not any(char in target for char in ('\\', '%', '\x00')), 'unsafe relationship target')
            resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(owner), target))
            require(resolved != '..' and not resolved.startswith('../') and resolved in self.parts, 'missing/escaping relationship target')
            result[rid] = (kind, resolved)
        return result


def string_value(element):
    # Shared/inline rich text; phonetic guides are not the cell's value.
    pieces = []
    for child in element:
        if child.tag == S + 't':
            require(not list(child), 'invalid spreadsheet text')
            pieces.append(child.text or '')
        elif child.tag == S + 'r':
            texts = child.findall(S + 't')
            require(len(texts) == 1, 'invalid spreadsheet rich-text run')
            pieces.append(texts[0].text or '')
        elif child.tag not in (S + 'rPh', S + 'phoneticPr'):
            raise ValueError('invalid shared/inline string')
    return ''.join(pieces)


def sheet(path):
    package = Package(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
    book = package.trees[package.main]
    require(book.tag == S + 'workbook', 'invalid workbook root')
    sheets = book.findall(S + 'sheets/' + S + 'sheet')
    require(sheets, 'workbook has no sheets')
    relationships = package.relationships(package.main)
    target = relationships.get(sheets[0].get(R + 'id'))
    require(target and target[0] == R_URI + '/worksheet', 'first sheet must reference an actual worksheet')
    worksheet = package.trees[target[1]]
    require(worksheet.tag == S + 'worksheet', 'invalid worksheet root')
    shared_parts = [target for kind, target in relationships.values() if kind == R_URI + '/sharedStrings']
    require(len(shared_parts) <= 1, 'duplicate shared strings relation')
    shared = []
    if shared_parts:
        table = package.trees[shared_parts[0]]
        require(table.tag == S + 'sst', 'invalid shared strings root')
        shared = [string_value(item) for item in table.findall(S + 'si')]
    cells = {}
    for cell in worksheet.findall(S + 'sheetData/' + S + 'row/' + S + 'c'):
        reference = cell.get('r')
        require(reference and re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,6}', reference) and reference not in cells, 'invalid/duplicate spreadsheet cell')
        cells[reference] = cell
    require('A1' in cells and 'B2' in cells, 'missing edited spreadsheet cells')
    a1 = cells['A1']
    if a1.get('t') == 'inlineStr':
        inline = a1.find(S + 'is')
        require(inline is not None, 'missing inline string')
        text = string_value(inline)
    elif a1.get('t') == 's':
        value = a1.findtext(S + 'v', '')
        require(re.fullmatch(r'[0-9]{1,8}', value) and int(value) < len(shared), 'invalid shared string index')
        text = shared[int(value)]
    else:
        require(a1.get('t') == 'str', 'A1 must contain text')
        text = a1.findtext(S + 'v', '')
    require(text == 'NATIVE_MCP_SHEET', 'A1 text mismatch')
    b2 = cells['B2']
    require(b2.get('t') in (None, 'n'), 'B2 must be a numeric cell')
    from decimal import Decimal
    require(Decimal(b2.findtext(S + 'v', 'NaN')) == Decimal(29), 'B2 numeric value mismatch')
    return True


def presentation(path):
    package = Package(path, 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
    document = package.trees[package.main]
    require(document.tag == P + 'presentation', 'invalid presentation root')
    slides = document.findall(P + 'sldIdLst/' + P + 'sldId')
    require(0 < len(slides) <= 128, 'invalid slide count')
    relationships = package.relationships(package.main)
    texts, seen = [], set()
    for slide in slides:
        target = relationships.get(slide.get(R + 'id'))
        require(target and target[0] == R_URI + '/slide' and target[1] not in seen, 'invalid/duplicate actual slide relationship')
        seen.add(target[1])
        tree = package.trees[target[1]]
        require(tree.tag == P + 'sld', 'invalid slide root')
        shapes = tree.find(P + 'cSld/' + P + 'spTree')
        require(shapes is not None, 'missing slide shape tree')
        # Only actual text bodies of slide shapes/tables, never notes or metadata.
        for shape in shapes.iter(P + 'sp'):
            text_body = shape.find(P + 'txBody')
            if text_body is not None:
                texts.append(''.join(item.text or '' for item in text_body.iter(A + 't')))
        for cell in shapes.iter(A + 'tc'):
            body = cell.find(A + 'txBody')
            if body is not None:
                texts.append(''.join(item.text or '' for item in body.iter(A + 't')))
    require(any('NATIVE_MCP_PRESENTATION' in text for text in texts), 'actual slides do not contain the edited presentation text')
    return True


def pdf(path):
    import pymupdf as pdf_reader
    with pdf_reader.open(path) as document:
        require(document.is_pdf and not document.needs_pass and 0 < len(document) <= 128, 'invalid/encrypted PDF specimen')
        texts = []
        for page in document:
            texts.append(page.get_text())
            require(sum(len(text) for text in texts) <= 1024 * 1024, 'PDF extracted text exceeds limit')
        require('NATIVE_MCP_PDF' in '\n'.join(texts), 'actual PDF pages do not contain edited text')
    return True


def json_document(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    value = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('invalid JSON number')))
    require(isinstance(value, dict), 'document JSON must be an object')
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        require(depth <= 64 and count <= 100000, 'JSON complexity limit exceeded')
        children = item.values() if isinstance(item, dict) else item if isinstance(item, list) else []
        pending.extend((child, depth + 1) for child in children)
    return value


def note(path):
    document = json_document(path)
    require(document.get('format') == 'open-office-notebook' and document.get('version') == 2, 'invalid notebook format')
    texts = []
    for section in document.get('sections', []):
        for page in section.get('pages', []):
            for region in page.get('regions', []):
                for block in region.get('blocks', []):
                    if block.get('type') in ('paragraph', 'heading', 'bullet', 'numbered', 'todo'):
                        texts.append(''.join(item.get('text', '') for item in block.get('content', [])))
    require(any('NATIVE_MCP_NOTE' in text for text in texts), 'notebook block content does not contain edited text')
    return True


def workflow(path, kind):
    document = json_document(path)
    require(document.get('format') == 'open-workflow' and document.get('version') == 1, 'invalid workflow format')
    # Persisted compatibility names differ from the shell's canvas/diagram kinds.
    if kind == 'canvas':
        require(document.get('kind') in ('flow', 'board'), 'canvas export has the wrong persisted kind')
        matches = [item for item in document.get('scene', {}).get('elements', []) if item.get('id') == 'native_mcp_shape']
        require(len(matches) == 1, 'missing/duplicate edited canvas shape')
        shape = matches[0]
        require(shape.get('type') == 'shape' and shape.get('shape') == 'rectangle' and shape.get('text') == 'NATIVE_MCP_CANVAS', 'canvas shape content mismatch')
    else:
        require(document.get('kind') == 'mermaid', 'diagram export has the wrong persisted kind')
        require(document.get('source') == 'sequenceDiagram\n  Alice->>Bob: NATIVE_MCP_DIAGRAM' and document.get('diagramStyle') == 'blueprint', 'diagram source/style mismatch')
    return True


def inspect(folder):
    require(folder.is_dir(), 'export directory does not exist')
    files = {name: checked_file(folder, file) for name, file in {
        'word': 'word.docx', 'sheet': 'sheet.xlsx', 'presentation': 'presentation.pptx',
        'pdf': 'pdf.pdf', 'note': 'note.oonote', 'canvas': 'canvas.owflow', 'diagram': 'diagram.owflow',
    }.items()}
    return {'word': word(files['word']), 'sheet': sheet(files['sheet']), 'presentation': presentation(files['presentation']),
            'pdf': pdf(files['pdf']), 'note': note(files['note']), 'canvas': workflow(files['canvas'], 'canvas'), 'diagram': workflow(files['diagram'], 'diagram')}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'usage: mcp-smoke-documents.py EXPORT_DIRECTORY')
        print(json.dumps(inspect(Path(sys.argv[1]))))
    except Exception as error:
        print('MCP exported-document validation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
