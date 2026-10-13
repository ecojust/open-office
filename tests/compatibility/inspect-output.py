#!/usr/bin/env python3
"""Independent, bounded structural inspection of exported office documents.

Only the standard library is needed for OOXML, ODF, RTF and container detection.
PDF inspection optionally uses PyMuPDF. Nothing is executed, fetched or repaired.
Exit 0 = parsed, 1 = rejected/error, 2 = unsupported (including legacy OLE).
"""
from __future__ import annotations

import argparse
import codecs
import hashlib
import io
import json
import math
import pathlib
import posixpath
import re
import stat
import sys
import zipfile
from collections import Counter
from xml.etree import ElementTree as ET

LIMITS = {
    'inputBytes': 128 * 1024 * 1024, 'zipEntries': 6000,
    'expandedBytes': 256 * 1024 * 1024, 'xmlPartBytes': 24 * 1024 * 1024,
    'xmlNodes': 500_000, 'xmlDepth': 128, 'textCharacters': 2_000_000,
    'reportedStrings': 20_000, 'reportedCells': 30_000,
    'reportedObjects': 5000, 'pages': 1000, 'previewPages': 6,
    'repeatedCells': 1_000_000, 'rtfDepth': 256, 'outputBytes': 24 * 1024 * 1024,
}
NS = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pr': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
    'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    'style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    'draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    'presentation': 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
    'animation': 'urn:oasis:names:tc:opendocument:xmlns:animation:1.0',
    'chart': 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0',
    'xlink': 'http://www.w3.org/1999/xlink',
    'manifest': 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
    'fo': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    'svg': 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    'dc': 'http://purl.org/dc/elements/1.1/',
}


class InspectionError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise InspectionError(code, message)


def q(prefix, local):
    return '{' + NS[prefix] + '}' + local


def local(tag):
    return tag.rsplit('}', 1)[-1]


def attr(element, prefix, name, default=None):
    return element.get(q(prefix, name), default) if element is not None else default


def descendants(element, prefix, name):
    return list(element.iter(q(prefix, name))) if element is not None else []


def integer(value, default=0, maximum=1_000_000):
    try:
        result = int(value)
    except (ValueError, TypeError):
        return default
    if result < 0 or result > maximum:
        fail('COUNT_LIMIT', 'An XML repetition or dimension exceeds its inspection limit.')
    return result


def xml(data):
    # Removing NULs also detects prohibited declarations in UTF-16/32 XML.
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data.replace(b'\x00', b''), re.I):
        fail('UNSAFE_XML', 'DTD and entity declarations are forbidden.')
    if len(data) > LIMITS['xmlPartBytes']:
        fail('XML_LIMIT', 'An XML part exceeds the size limit.')
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError) as error:
        fail('INVALID_XML', 'An XML part is not well formed: ' + str(error)[:160])
    stack, count = [(root, 1)], 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if depth > LIMITS['xmlDepth'] or count > LIMITS['xmlNodes']:
            fail('XML_LIMIT', 'The XML tree exceeds the node or depth limit.')
        stack.extend((child, depth + 1) for child in node)
    return root


class Report:
    def __init__(self, path, data):
        self.value = {
            'schemaVersion': 1, 'ok': False, 'inspection': 'rejected', 'format': 'unknown',
            'file': {'name': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()},
            'limits': dict(LIMITS), 'zipSafety': None, 'warnings': [], 'errors': [],
            'truncated': False, 'features': {},
            'coreText': {'strings': [], 'reportedCharacters': 0, 'observedStrings': 0, 'truncated': False},
            'meaning': 'Structural inspection only; no Office execution, visual equivalence, formula recalculation or source/output comparison is implied.',
        }

    def warn(self, code, detail):
        item = {'code': code, 'detail': detail}
        if item not in self.value['warnings']:
            self.value['warnings'].append(item)

    def truncate(self, context):
        self.value['truncated'] = True
        self.warn('REPORT_TRUNCATED', context + ' exceeds the reporting limit; omitted content is not validated as preserved.')

    def text(self, value):
        if not value:
            return
        text = self.value['coreText']
        text['observedStrings'] += 1
        remaining = LIMITS['textCharacters'] - text['reportedCharacters']
        if len(text['strings']) >= LIMITS['reportedStrings'] or remaining < len(value):
            text['truncated'] = True
            self.truncate('Core text')
            return
        text['strings'].append(value)
        text['reportedCharacters'] += len(value)

    def bounded(self, values, label, maximum=None):
        maximum = maximum or LIMITS['reportedObjects']
        if len(values) > maximum:
            self.truncate(label)
        return values[:maximum]


class Package:
    def __init__(self, data, report):
        self.report = report
        self.parts, self.trees, self.infos, self.hashes = {}, {}, {}, {}
        self.safety = report.value['zipSafety'] = {
            'checked': True, 'safe': False, 'entries': 0, 'declaredExpandedBytes': 0,
            'actualExpandedBytes': 0, 'crcCheckedEntries': 0, 'externalTargetsFetched': False,
        }
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except (zipfile.BadZipFile, ValueError):
            fail('INVALID_ZIP', 'The ZIP container cannot be opened.')
        with archive:
            infos = archive.infolist()
            if len(infos) > LIMITS['zipEntries']:
                fail('ZIP_LIMIT', 'Too many ZIP entries.')
            seen = set()
            for info in infos:
                name = info.filename
                pieces = name.rstrip('/').split('/')
                if not name or '\\' in name or '\x00' in name or name.startswith('/') or ':' in pieces[0] or any(part in ('', '.', '..') for part in pieces):
                    fail('UNSAFE_ZIP_PATH', 'A ZIP entry has an unsafe or ambiguous path.')
                if name.casefold() in seen:
                    fail('DUPLICATE_ZIP_PATH', 'Duplicate or case-colliding ZIP entries are forbidden.')
                seen.add(name.casefold())
                if stat.S_ISLNK(info.external_attr >> 16):
                    fail('ZIP_SYMLINK', 'ZIP symbolic links are forbidden.')
                if info.flag_bits & 1:
                    fail('ENCRYPTED_ZIP', 'Encrypted ZIP entries cannot be independently inspected.')
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    fail('ZIP_COMPRESSION', 'Only stored and deflated ZIP entries are supported.')
                self.safety['declaredExpandedBytes'] += info.file_size
                if self.safety['declaredExpandedBytes'] > LIMITS['expandedBytes']:
                    fail('ZIP_LIMIT', 'The declared expanded ZIP size exceeds the limit.')
                self.infos[name] = info
            self.safety['entries'] = len(infos)
            for info in infos:
                cache = info.filename.endswith(('.xml', '.rels')) or info.filename == 'mimetype'
                if cache and info.file_size > LIMITS['xmlPartBytes']:
                    fail('XML_LIMIT', 'An XML part exceeds the inspection size limit.')
                chunks, actual, digest = [], 0, hashlib.sha256()
                try:
                    with archive.open(info) as stream:
                        while chunk := stream.read(65536):
                            actual += len(chunk)
                            digest.update(chunk)
                            self.safety['actualExpandedBytes'] += len(chunk)
                            if self.safety['actualExpandedBytes'] > LIMITS['expandedBytes'] or actual > info.file_size:
                                fail('ZIP_LIMIT', 'Actual ZIP expansion exceeds the declared or configured limit.')
                            if cache:
                                chunks.append(chunk)
                except (zipfile.BadZipFile, RuntimeError, EOFError, OSError):
                    fail('INVALID_ZIP', 'A ZIP entry failed decompression or CRC validation.')
                if actual != info.file_size:
                    fail('INVALID_ZIP', 'A ZIP entry does not match its declared length.')
                self.safety['crcCheckedEntries'] += 1
                self.hashes[info.filename] = digest.hexdigest()
                if cache:
                    self.parts[info.filename] = b''.join(chunks)
            # Validate all XML, including auxiliary/custom parts, before reading semantics.
            for name, content in self.parts.items():
                if name.endswith(('.xml', '.rels')):
                    # LibreOffice's unconfigured accelerator slot is a known
                    # zero-byte optional application configuration, not an XML
                    # document. Never extend this exception to document parts.
                    if name == 'Configurations2/accelerator/current.xml' and not content:
                        report.warn('EMPTY_OPTIONAL_CONFIGURATION', 'The optional LibreOffice accelerator configuration is empty; it contains no document content.')
                        continue
                    self.trees[name] = xml(content)
            self.safety['safe'] = True

    def tree(self, name, required=False):
        result = self.trees.get(name)
        if result is None and required:
            fail('MISSING_PART', 'Required package part is missing: ' + name)
        return result

    def relations(self, source):
        relpath = posixpath.join(posixpath.dirname(source), '_rels', posixpath.basename(source) + '.rels') if source else '_rels/.rels'
        root = self.tree(relpath)
        result = {}
        if root is None:
            return result
        for rel in root:
            if local(rel.tag) != 'Relationship':
                continue
            rid, target, kind = rel.get('Id'), rel.get('Target', ''), rel.get('Type', '').rsplit('/', 1)[-1]
            if not rid or rid in result:
                fail('INVALID_RELATIONSHIP', 'Relationship IDs must be present and unique.')
            external = rel.get('TargetMode') == 'External'
            resolved = None
            if not external:
                if '\\' in target or '\x00' in target or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target):
                    fail('UNSAFE_RELATIONSHIP', 'An internal relationship has an unsafe target.')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), target)) if not target.startswith('/') else target.lstrip('/')
                if resolved == '..' or resolved.startswith('../'):
                    fail('UNSAFE_RELATIONSHIP', 'A relationship escapes the package.')
                if resolved not in self.infos:
                    self.report.warn('MISSING_RELATIONSHIP_TARGET', source + ': ' + rid + ' -> ' + resolved)
            result[rid] = {'id': rid, 'type': kind, 'target': target, 'part': resolved, 'external': external}
        return result

    def linked(self, source, rid, expected=None):
        relation = self.relations(source).get(rid)
        if not relation or relation['external'] or not relation['part']:
            self.report.warn('UNRESOLVED_REFERENCE', source + ': ' + str(rid))
            return None
        if expected and relation['type'] != expected:
            self.report.warn('RELATIONSHIP_TYPE', source + ': unexpected relation type ' + relation['type'])
        return relation['part']


def plain_text(node, prefix='w', include_deleted=False):
    output = []
    def visit(current):
        if current.tag in {q(prefix, name) for name in ('pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'sectPr', 'sdtPr', 'endParaRPr', 'defRPr')}:
            return
        if current.tag == q(prefix, 'del') and not include_deleted:
            return
        if current.tag in (q(prefix, 't'), q(prefix, 'delText')):
            if current.tag != q(prefix, 'delText') or include_deleted:
                output.append(current.text or '')
        elif current.tag == q(prefix, 'tab'):
            output.append('\t')
        elif current.tag in (q(prefix, 'br'), q(prefix, 'cr')):
            output.append('\n')
        else:
            for child in current:
                visit(child)
    visit(node)
    return ''.join(output)


def properties(node):
    return {local(child.tag): {local(key): value for key, value in child.attrib.items()} for child in node} if node is not None else {}


def word_paragraph(node):
    return {
        'text': plain_text(node), 'textIncludingDeleted': plain_text(node, include_deleted=True),
        'style': attr(node.find('w:pPr/w:pStyle', NS), 'w', 'val'),
        'properties': properties(node.find('w:pPr', NS)),
        'runs': [{'text': plain_text(run, include_deleted=True), 'properties': properties(run.find('w:rPr', NS))} for run in node.iter(q('w', 'r'))],
    }


def word_fields(node):
    # Word stores simple fields in w:fldSimple/@w:instr and complex fields in
    # w:instrText runs. Both can occur in bodies, headers, footers and notes.
    return [attr(item, 'w', 'instr', '') if item.tag == q('w', 'fldSimple') else item.text or ''
            for item in node.iter() if item.tag in (q('w', 'fldSimple'), q('w', 'instrText'))]


def word_text_without_field_results(node):
    """Text outside simple/complex field ranges; cached PAGE etc. are dynamic."""
    paragraphs, depth = [], 0
    def visit(current, output):
        nonlocal depth
        if current.tag in {q('w', name) for name in ('fldSimple', 'del', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'sectPr', 'sdtPr')}:
            return
        if current.tag == q('w', 'fldChar'):
            kind = attr(current, 'w', 'fldCharType')
            if kind == 'begin':
                depth += 1
            elif kind == 'end':
                depth = max(0, depth - 1)
        elif current.tag == q('w', 't'):
            if not depth:
                output.append(current.text or '')
        elif current.tag in (q('w', 'tab'), q('w', 'br'), q('w', 'cr')):
            if not depth:
                output.append('\t' if current.tag == q('w', 'tab') else '\n')
        else:
            for child in current:
                visit(child, output)
    for paragraph in descendants(node, 'w', 'p'):
        output = []
        visit(paragraph, output)
        paragraphs.append(''.join(output))
    return '\n'.join(paragraphs)


def ooxml_word(pkg, main, report):
    document = pkg.tree(main, True)
    body = document.find('w:body', NS)
    if body is None:
        fail('MISSING_BODY', 'Word document has no body.')
    all_paragraphs = descendants(body, 'w', 'p')
    paragraphs = [word_paragraph(node) for node in report.bounded(all_paragraphs, 'Word paragraphs')]
    for node in all_paragraphs:
        report.text(plain_text(node))
    tables = []
    for table in report.bounded(descendants(body, 'w', 'tbl'), 'Word tables'):
        rows, row_grid_before = [], []
        for row in table.findall('w:tr', NS):
            row_grid_before.append(integer(attr(row.find('w:trPr/w:gridBefore', NS), 'w', 'val', '0'), 0, 16384))
            cells = []
            for cell in row.findall('w:tc', NS):
                cells.append({'text': '\n'.join(plain_text(p) for p in cell.findall('w:p', NS)),
                              'columnSpan': attr(cell.find('w:tcPr/w:gridSpan', NS), 'w', 'val', '1'),
                              'verticalMerge': attr(cell.find('w:tcPr/w:vMerge', NS), 'w', 'val', 'continue') if cell.find('w:tcPr/w:vMerge', NS) is not None else None})
            rows.append(cells)
        tables.append({'rows': rows, 'rowCount': len(rows), 'gridColumns': len(table.findall('w:tblGrid/w:gridCol', NS)), 'rowGridBefore': row_grid_before})
    relationships = pkg.relations(main)
    related = lambda kind: [rel['part'] for rel in relationships.values() if rel['type'] == kind and rel['part']]
    styles, sections, headers, footers, comments, footnotes, endnotes = [], [], [], [], [], [], []
    for part in related('styles'):
        root = pkg.tree(part)
        for node in root.findall('w:style', NS) if root is not None else []:
            styles.append({'id': attr(node, 'w', 'styleId'), 'type': attr(node, 'w', 'type'),
                           'name': attr(node.find('w:name', NS), 'w', 'val'),
                           'basedOn': attr(node.find('w:basedOn', NS), 'w', 'val'),
                           'runProperties': properties(node.find('w:rPr', NS)), 'paragraphProperties': properties(node.find('w:pPr', NS))})
    for node in descendants(body, 'w', 'sectPr'):
        sections.append({'pageSize': properties(node).get('pgSz'), 'pageMargins': properties(node).get('pgMar'),
                         'headers': [{'id': attr(ref, 'r', 'id'), 'type': attr(ref, 'w', 'type')} for ref in node.findall('w:headerReference', NS)],
                         'footers': [{'id': attr(ref, 'r', 'id'), 'type': attr(ref, 'w', 'type')} for ref in node.findall('w:footerReference', NS)]})
    for kind, collection in [('header', headers), ('footer', footers), ('comments', comments), ('footnotes', footnotes), ('endnotes', endnotes)]:
        for part in related(kind):
            root = pkg.tree(part)
            if root is None:
                continue
            nodes = list(root) if kind in ('comments', 'footnotes', 'endnotes') else [root]
            for node in nodes:
                text = '\n'.join(plain_text(p) for p in descendants(node, 'w', 'p'))
                collection.append({'id': attr(node, 'w', 'id'), 'type': attr(node, 'w', 'type'), 'part': part,
                                   'author': attr(node, 'w', 'author'), 'text': text,
                                   'textWithoutFieldResults': word_text_without_field_results(node),
                                   'fields': word_fields(node)})
                if kind in ('header', 'footer'):
                    collection[-1]['references'] = [{'sectionIndex': section_index, 'type': reference['type']}
                                                    for section_index, section in enumerate(sections)
                                                    for reference in section['headers' if kind == 'header' else 'footers']
                                                    if relationships.get(reference['id'], {}).get('part') == part]
                report.text(text)
    tracked = []
    for node in body.iter():
        if local(node.tag) in ('ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange', 'tblPrChange', 'sectPrChange') and node.tag.startswith('{' + NS['w'] + '}'):
            tracked.append({'kind': local(node.tag), 'id': attr(node, 'w', 'id'), 'author': attr(node, 'w', 'author'), 'date': attr(node, 'w', 'date'), 'text': plain_text(node, include_deleted=True)})
    report.value['word'] = {'paragraphCount': len(all_paragraphs), 'paragraphs': paragraphs, 'tables': tables,
                            'styles': report.bounded(styles, 'Word styles'), 'sections': sections,
                            'headers': headers, 'footers': footers, 'comments': comments,
                            'footnotes': footnotes, 'endnotes': endnotes, 'trackedChanges': report.bounded(tracked, 'Tracked changes'),
                            'fields': word_fields(body)}
    report.value['features'].update(paragraphs=len(all_paragraphs), tables=len(descendants(body, 'w', 'tbl')),
                                    comments=len(comments), footnotes=len(footnotes), endnotes=len(endnotes), trackedChanges=len(tracked),
                                    imageReferences=len(descendants(document, 'a', 'blip')))


def cell_address(column, row):
    letters = ''
    while column >= 0:
        letters = chr(65 + column % 26) + letters
        column = column // 26 - 1
    return letters + str(row + 1)


def chart_data(node):
    """Preserve formula sources and indexed cached data, without recalculating."""
    if node is None:
        return None
    points = []
    for point in node.iter(q('c', 'pt')):
        points.append({'index': point.get('idx'), 'value': point.findtext('c:v', None, NS)})
    literal = node.findtext('c:v', None, NS)
    return {'formula': node.findtext('.//c:f', None, NS), 'values': points,
            'literal': literal, 'formatCode': node.findtext('.//c:formatCode', None, NS),
            'pointCounts': [child.get('val') for child in node.iter(q('c', 'ptCount'))]}


def ooxml_chart(pkg, part):
    root = pkg.tree(part) if part else None
    result = {'part': part, 'sha256': pkg.hashes.get(part), 'parsed': root is not None,
              'chartTypes': [], 'series': [], 'externalData': None}
    if root is None:
        return result
    plot = root.find('c:chart/c:plotArea', NS)
    if plot is not None:
        for chart in plot:
            if not chart.tag.startswith('{' + NS['c'] + '}') or not local(chart.tag).endswith('Chart'):
                continue
            kind = local(chart.tag)
            result['chartTypes'].append(kind)
            for series in chart.findall('c:ser', NS):
                index, order = series.find('c:idx', NS), series.find('c:order', NS)
                result['series'].append({'chartType': kind,
                                        'index': index.get('val') if index is not None else None,
                                        'order': order.get('val') if order is not None else None,
                                        'title': chart_data(series.find('c:tx', NS)),
                                        'categories': chart_data(series.find('c:cat', NS)),
                                        'values': chart_data(series.find('c:val', NS)),
                                        'xValues': chart_data(series.find('c:xVal', NS)),
                                        'yValues': chart_data(series.find('c:yVal', NS)),
                                        'bubbleSize': chart_data(series.find('c:bubbleSize', NS))})
    ext = root.find('c:externalData', NS)
    if ext is not None:
        relation = pkg.relations(part).get(attr(ext, 'r', 'id'))
        result['externalData'] = {**(relation or {'unresolved': True}),
                                  'sha256': pkg.hashes.get(relation['part']) if relation else None}
    result['titleTexts'] = [node.text or '' for node in root.findall('c:chart/c:title//a:t', NS)]
    result['editableDataReferences'] = [item['formula'] for series in result['series'] for key in ('title', 'categories', 'values', 'xValues', 'yValues', 'bubbleSize') if (item := series[key]) and item['formula']]
    return result


def sheet_charts(pkg, part, sheet):
    charts = []
    for drawing in sheet.findall('s:drawing', NS):
        drawing_part = pkg.linked(part, attr(drawing, 'r', 'id'), 'drawing')
        drawing_root = pkg.tree(drawing_part) if drawing_part else None
        if drawing_root is not None:
            for chart in drawing_root.iter(q('c', 'chart')):
                chart_part = pkg.linked(drawing_part, attr(chart, 'r', 'id'), 'chart')
                charts.append({**ooxml_chart(pkg, chart_part), 'drawingPart': drawing_part})
    return charts


def ooxml_sheet(pkg, main, report):
    root = pkg.tree(main, True)
    relationships = pkg.relations(main)
    shared = []
    shared_parts = [r['part'] for r in relationships.values() if r['type'] == 'sharedStrings' and r['part']]
    for part in shared_parts:
        shared_root = pkg.tree(part)
        if shared_root is not None:
            shared = [''.join(child.text or '' for child in node.iter(q('s', 't'))) for node in shared_root.findall('s:si', NS)]
    output, cell_count = [], 0
    for sheet in root.findall('s:sheets/s:sheet', NS):
        part = pkg.linked(main, attr(sheet, 'r', 'id'), 'worksheet')
        tree = pkg.tree(part) if part else None
        item = {'name': sheet.get('name'), 'sheetId': sheet.get('sheetId'), 'state': sheet.get('state', 'visible'), 'part': part,
                'cells': [], 'mergedRanges': [], 'cellCount': 0}
        if tree is not None:
            for cell in tree.findall('s:sheetData/s:row/s:c', NS):
                item['cellCount'] += 1
                cell_count += 1
                kind = cell.get('t', 'n')
                raw_value = cell.findtext('s:v', None, NS)
                formula_node = cell.find('s:f', NS)
                value = raw_value
                if kind == 's':
                    index = integer(raw_value, -1)
                    if index < 0 or index >= len(shared):
                        report.warn('INVALID_SHARED_STRING', 'Invalid shared-string reference in ' + part)
                        value = None
                    else:
                        value = shared[index]
                elif kind == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//s:is//s:t', NS))
                semantic_type = 'formula' if formula_node is not None else {'s': 'text', 'inlineStr': 'text', 'str': 'text', 'b': 'boolean', 'e': 'error', 'd': 'date'}.get(kind, 'number' if raw_value is not None else 'empty')
                if kind == 'n' and raw_value is not None:
                    try:
                        numeric = float(raw_value)
                        value = int(numeric) if math.isfinite(numeric) and numeric.is_integer() else numeric if math.isfinite(numeric) else raw_value
                    except ValueError:
                        report.warn('INVALID_NUMBER', 'Invalid numeric cached value in ' + part)
                elif kind == 'b' and raw_value in ('0', '1'):
                    value = raw_value == '1'
                entry = {'address': cell.get('r'), 'type': semantic_type, 'storageType': kind, 'value': value, 'cachedValue': raw_value,
                         'formula': formula_node.text if formula_node is not None else None,
                         'formulaAttributes': dict(formula_node.attrib) if formula_node is not None else {}, 'styleIndex': cell.get('s')}
                if cell_count <= LIMITS['reportedCells']:
                    item['cells'].append(entry)
                    if kind in ('s', 'inlineStr', 'str'):
                        report.text(value)
                else:
                    report.truncate('Spreadsheet cells')
            item['mergedRanges'] = [node.get('ref') for node in tree.findall('s:mergeCells/s:mergeCell', NS)]
            item['frozenPanes'] = [dict(node.attrib) for node in tree.findall('s:sheetViews/s:sheetView/s:pane', NS)]
            item['autoFilters'] = [ET.tostring(node, encoding='unicode') for node in tree.findall('s:autoFilter', NS)]
            item['conditionalFormats'] = [dict(node.attrib) for node in tree.findall('s:conditionalFormatting', NS)]
            item['conditionalRules'] = [{'sqref': node.get('sqref'), 'rules': [
                {'type': rule.get('type'), 'operator': rule.get('operator'), 'priority': rule.get('priority'),
                 'formulas': [formula.text or '' for formula in rule.findall('s:formula', NS)],
                 'attributes': dict(rule.attrib), 'xml': ET.tostring(rule, encoding='unicode')}
                for rule in node.findall('s:cfRule', NS)]} for node in tree.findall('s:conditionalFormatting', NS)]
            item['dataValidations'] = [{'attributes': dict(node.attrib), 'formula1': node.findtext('s:formula1', None, NS), 'formula2': node.findtext('s:formula2', None, NS)} for node in tree.findall('s:dataValidations/s:dataValidation', NS)]
            item['tableParts'] = [pkg.linked(part, attr(node, 'r', 'id'), 'table') for node in tree.findall('s:tableParts/s:tablePart', NS)]
            item['charts'] = sheet_charts(pkg, part, tree)
        output.append(item)
    report.value['spreadsheet'] = {'sheets': output, 'sheetCount': len(output), 'cellCount': cell_count,
                                   'definedNames': [{'name': node.get('name'), 'localSheetId': node.get('localSheetId'), 'formula': node.text} for node in root.findall('s:definedNames/s:definedName', NS)],
                                   'date1904': root.find('s:workbookPr', NS).get('date1904', '0') if root.find('s:workbookPr', NS) is not None else '0',
                                   'calculation': properties(root).get('calcPr')}
    report.warn('FORMULAS_NOT_RECALCULATED', 'Formula strings and cached values are independent package evidence; formulas are not evaluated, and shared formulas are not expanded.')
    report.value['features'].update(sheets=len(output), cells=cell_count,
                                    formulas=sum(1 for item in output for cell in item['cells'] if cell['formula'] is not None or cell['formulaAttributes']),
                                    mergedRanges=sum(len(item['mergedRanges']) for item in output))


def ooxml_presentation(pkg, main, report):
    root = pkg.tree(main, True)
    slides = []
    animation_names = {'anim', 'animClr', 'animEffect', 'animMotion', 'animRot', 'animScale', 'cmd', 'set'}
    for position, sid in enumerate(root.findall('p:sldIdLst/p:sldId', NS)):
        part = pkg.linked(main, attr(sid, 'r', 'id'), 'slide')
        tree = pkg.tree(part) if part else None
        item = {'index': position, 'id': sid.get('id'), 'part': part, 'texts': [], 'notes': [], 'tables': [], 'charts': [], 'media': [], 'animations': []}
        if tree is not None:
            item['hidden'] = tree.get('show', '1') == '0'
            common = tree.find('p:cSld', NS)
            item['name'] = common.get('name') if common is not None else None
            item['texts'] = [plain_text(p, 'a') for p in descendants(tree, 'a', 'p')]
            for value in item['texts']:
                report.text(value)
            for table in descendants(tree, 'a', 'tbl'):
                rows = [[ '\n'.join(plain_text(p, 'a') for p in descendants(cell, 'a', 'p')) for cell in row.findall('a:tc', NS)] for row in table.findall('a:tr', NS)]
                item['tables'].append({'rows': rows, 'rowCount': len(rows), 'columnCount': len(table.findall('a:tblGrid/a:gridCol', NS))})
            rels = pkg.relations(part)
            for rel in rels.values():
                if rel['type'] in ('video', 'audio', 'media'):
                    item['media'].append({**rel, 'bytes': pkg.infos[rel['part']].file_size if rel['part'] in pkg.infos else None, 'sha256': pkg.hashes.get(rel['part'])})
                if rel['type'] == 'chart':
                    item['charts'].append({**rel, **ooxml_chart(pkg, rel['part'])})
                if rel['type'] == 'notesSlide' and rel['part']:
                    notes = pkg.tree(rel['part'])
                    if notes is not None:
                        for shape in descendants(notes, 'p', 'sp'):
                            placeholder = shape.find('p:nvSpPr/p:nvPr/p:ph', NS)
                            # Keep all placeholders separately; slide-number/date aren't spoken notes.
                            texts = [plain_text(p, 'a') for p in descendants(shape, 'a', 'p')]
                            item['notes'].append({'placeholderType': placeholder.get('type') if placeholder is not None else None, 'texts': texts})
                            for value in texts:
                                report.text(value)
            transitions = [node for node in tree.iter() if local(node.tag) == 'transition']
            item['transitions'] = [{'attributes': {local(k): v for k, v in node.attrib.items()}, 'effects': [local(child.tag) for child in node], 'xml': ET.tostring(node, encoding='unicode')} for node in transitions]
            item['animations'] = [{'kind': local(node.tag), 'xml': ET.tostring(node, encoding='unicode')} for node in tree.iter() if local(node.tag) in animation_names and node.tag.startswith('{' + NS['p'] + '}')]
        slides.append(item)
    report.value['presentation'] = {'slides': slides, 'slideCount': len(slides), 'size': dict(root.find('p:sldSz', NS).attrib) if root.find('p:sldSz', NS) is not None else None}
    report.value['features'].update(slides=len(slides), tables=sum(len(s['tables']) for s in slides),
                                    chartReferences=sum(len(s['charts']) for s in slides), mediaReferences=sum(len(s['media']) for s in slides),
                                    animations=sum(len(s['animations']) for s in slides), transitions=sum(len(s.get('transitions', [])) for s in slides))


def ooxml(pkg, report):
    root_relationships = pkg.relations('')
    candidates = [rel for rel in root_relationships.values() if rel['type'] == 'officeDocument' and rel['part']]
    if len(candidates) != 1:
        fail('MISSING_MAIN_PART', 'OOXML requires one internal officeDocument relationship.')
    main = candidates[0]['part']
    root = pkg.tree(main, True)
    strict_uris = ('http://purl.oclc.org/ooxml/',)
    if any(uri in root.tag for uri in strict_uris):
        report.value.update(format='ooxml-strict', inspection='unsupported')
        report.warn('UNSUPPORTED_STRICT_OOXML', 'Strict OOXML namespaces are detected; this inspector does not silently treat them as transitional OOXML.')
        return
    if root.tag == q('w', 'document'):
        report.value['format'] = 'docx'
        ooxml_word(pkg, main, report)
    elif root.tag == q('s', 'workbook'):
        report.value['format'] = 'xlsx'
        ooxml_sheet(pkg, main, report)
    elif root.tag == q('p', 'presentation'):
        report.value['format'] = 'pptx'
        ooxml_presentation(pkg, main, report)
    else:
        fail('UNKNOWN_OOXML', 'The main OOXML part is not a recognized document root.')
    content_types = pkg.tree('[Content_Types].xml', True)
    types = [node.get('ContentType', '') for node in content_types]
    report.value['package'] = {'mainPart': main, 'macroEnabled': any('macroEnabled' in value for value in types),
                               'vbaParts': [name for name in pkg.infos if name.lower().endswith('vbaproject.bin')],
                               'charts': [ooxml_chart(pkg, name) for name, tree in pkg.trees.items() if tree.tag == q('c', 'chartSpace')],
                               'embeddedObjects': [{'part': name, 'bytes': info.file_size, 'sha256': pkg.hashes[name]}
                                                   for name, info in pkg.infos.items() if '/embeddings/' in name and '/_rels/' not in name and not name.endswith(('/', '.rels'))]}
    report.value['features'].update(
        imageParts=sum(1 for name in pkg.infos if re.search(r'/(?:media)/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|svg|emf|wmf|webp)$', name, re.I)),
        chartParts=sum(1 for name in pkg.infos if re.search(r'/charts/chart\d+\.xml$', name)),
        pivotTableParts=sum(1 for name in pkg.infos if re.search(r'/pivotTables/pivotTable\d+\.xml$', name)),
        embeddedObjects=len(report.value['package']['embeddedObjects']))
    if report.value['package']['macroEnabled'] or report.value['package']['vbaParts']:
        report.warn('MACROS_NOT_EXECUTED', 'Macro-enabled content is reported but never executed.')


ODF_ANNOTATION_CONTAINERS = {
    q('office', 'annotation'), q('office', 'annotation-end'), q('office', 'change-info'),
    q('text', 'note'), q('text', 'note-body'), q('text', 'tracked-changes'),
    q('text', 'changed-region'), q('text', 'deletion'), q('text', 'insertion'), q('text', 'format-change'),
}


def odf_paragraph_nodes(container):
    """Paragraphs in one text scope, excluding nested note/review scopes.

    The supplied container itself is the scope: passing an annotation or
    note-body intentionally reads that object's paragraphs, never its metadata.
    """
    def visit(node):
        if node.tag in ODF_ANNOTATION_CONTAINERS:
            return
        if node.tag in (q('text', 'p'), q('text', 'h')):
            yield node
        for child in node:
            yield from visit(child)
    if container is not None:
        for child in container:
            yield from visit(child)


def odf_object_text(container):
    return '\n'.join(odf_text(paragraph) for paragraph in odf_paragraph_nodes(container))


def odf_text(node):
    result = []
    def visit(current, with_tail=True):
        if current.tag in ODF_ANNOTATION_CONTAINERS:
            pass
        elif current.tag == q('text', 's'):
            result.append(' ' * integer(attr(current, 'text', 'c', '1'), 1, 100_000))
        elif current.tag == q('text', 'tab'):
            result.append('\t')
        elif current.tag == q('text', 'line-break'):
            result.append('\n')
        else:
            if current.text:
                result.append(current.text)
            for child in current:
                visit(child)
        if with_tail and current.tail:
            result.append(current.tail)
    visit(node, False)
    return ''.join(result)


def odf_tables(container, report, spreadsheet=False):
    tables, reported_cells = [], 0
    for table in descendants(container, 'table', 'table'):
        sheet = {'name': attr(table, 'table', 'name'), 'style': attr(table, 'table', 'style-name'),
                 'cells': [], 'rows': [], 'mergedRanges': [], 'cellCount': 0, 'repetitions': []}
        row_index = 0
        # Exclude rows of nested tables; they are separate structural objects.
        def row_nodes(node):
            for child in node:
                if child.tag == q('table', 'table-row'):
                    yield child
                elif child.tag != q('table', 'table'):
                    yield from row_nodes(child)
        for row in row_nodes(table):
            row_repeat = integer(attr(row, 'table', 'number-rows-repeated', '1'), 1, 1_048_576)
            if not row_repeat or row_index + row_repeat > 1_048_576:
                fail('COUNT_LIMIT', 'ODF row repetition exceeds spreadsheet limits.')
            template, col = [], 0
            for cell in row:
                if cell.tag not in (q('table', 'table-cell'), q('table', 'covered-table-cell')):
                    continue
                repeat = integer(attr(cell, 'table', 'number-columns-repeated', '1'), 1, 16384)
                if not repeat or col + repeat > 16384:
                    fail('COUNT_LIMIT', 'ODF column repetition exceeds spreadsheet limits.')
                texts = [odf_text(p) for p in cell if p.tag in (q('text', 'p'), q('text', 'h'))]
                text_value = '\n'.join(texts)
                formula, kind = attr(cell, 'table', 'formula'), attr(cell, 'office', 'value-type', 'empty')
                raw = attr(cell, 'office', 'value')
                value = raw if raw is not None else attr(cell, 'office', 'string-value', text_value)
                if kind in ('float', 'currency', 'percentage') and raw is not None:
                    try:
                        number = float(raw)
                        value = int(number) if math.isfinite(number) and number.is_integer() else number if math.isfinite(number) else raw
                    except ValueError:
                        report.warn('INVALID_NUMBER', 'An ODF cell contains an invalid numeric value.')
                elif kind == 'boolean':
                    value = attr(cell, 'office', 'boolean-value') == 'true'
                elif kind == 'date':
                    value = attr(cell, 'office', 'date-value')
                elif kind == 'time':
                    value = attr(cell, 'office', 'time-value')
                significant = bool(formula or kind != 'empty' or text_value or attr(cell, 'table', 'number-columns-spanned') or attr(cell, 'table', 'number-rows-spanned'))
                if significant:
                    template.append({'column': col, 'repeat': repeat, 'type': 'formula' if formula else {'string': 'text', 'float': 'number', 'currency': 'number', 'percentage': 'number'}.get(kind, kind),
                                     'value': value, 'formula': formula, 'storageType': kind, 'text': text_value,
                                     'style': attr(cell, 'table', 'style-name'), 'covered': cell.tag == q('table', 'covered-table-cell'),
                                     'columnSpan': integer(attr(cell, 'table', 'number-columns-spanned', '1'), 1, 16384),
                                     'rowSpan': integer(attr(cell, 'table', 'number-rows-spanned', '1'), 1, 1_048_576)})
                col += repeat
            logical_cells = sum(cell['repeat'] for cell in template) * row_repeat
            sheet['cellCount'] += logical_cells
            if row_repeat > 1 or any(cell['repeat'] > 1 for cell in template):
                sheet['repetitions'].append({'startRow': row_index + 1, 'rowRepeat': row_repeat, 'populatedCells': logical_cells})
            if logical_cells:
                room = max(0, LIMITS['reportedCells'] - reported_cells)
                if logical_cells > room:
                    report.truncate('ODF repeated cells')
                emitted = 0
                for offset in range(min(row_repeat, room + 1)):
                    row_values = []
                    for cell in template:
                        for column_offset in range(min(cell['repeat'], room - emitted)):
                            address = cell_address(cell['column'] + column_offset, row_index + offset)
                            entry = {k: v for k, v in cell.items() if k not in ('column', 'repeat')}
                            entry['address'] = address
                            sheet['cells'].append(entry)
                            row_values.append(entry['text'])
                            report.text(entry['text'])
                            if cell['columnSpan'] > 1 or cell['rowSpan'] > 1:
                                sheet['mergedRanges'].append(address + ':' + cell_address(cell['column'] + column_offset + cell['columnSpan'] - 1, row_index + offset + cell['rowSpan'] - 1))
                            emitted += 1
                        if emitted >= room:
                            break
                    if not spreadsheet and row_values:
                        sheet['rows'].append(row_values)
                    if emitted >= room:
                        break
                reported_cells += emitted
            row_index += row_repeat
        sheet['rowCount'] = row_index
        tables.append(sheet)
    return tables


def odf_part_reference(pkg, href):
    if not href:
        return {'href': href, 'part': None, 'external': False}
    external = bool(re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', href)) or href.startswith('//')
    if external or href.startswith('#'):
        return {'href': href, 'part': None, 'external': external}
    if '\\' in href or '\x00' in href or href.startswith('/'):
        fail('UNSAFE_RELATIONSHIP', 'ODF contains an unsafe internal resource path.')
    normalized = posixpath.normpath(href)
    if normalized == '..' or normalized.startswith('../'):
        # Parent references inside embedded chart XML can denote its owning
        # spreadsheet. Those are retained there, not resolved as files here.
        fail('UNSAFE_RELATIONSHIP', 'An ODF document resource escapes its package.')
    part = normalized if normalized in pkg.infos else normalized.rstrip('/') + '/content.xml'
    return {'href': href, 'part': part, 'external': False,
            'bytes': pkg.infos[part].file_size if part in pkg.infos else None, 'sha256': pkg.hashes.get(part)}


def odf_charts(pkg, report):
    charts = []
    for part, tree in pkg.trees.items():
        for chart in tree.iter(q('chart', 'chart')):
            plot = chart.find('chart:plot-area', NS)
            charts.append({'part': part, 'sha256': pkg.hashes.get(part), 'parsed': True,
                           'chartClass': attr(chart, 'chart', 'class'),
                           'titleTexts': [odf_text(node) for node in chart.findall('chart:title/text:p', NS)],
                           'plotRange': attr(plot, 'table', 'cell-range-address'),
                           'dataSourceHasLabels': attr(plot, 'chart', 'data-source-has-labels'),
                           'categoryRanges': [attr(node, 'table', 'cell-range-address') for node in chart.iter(q('chart', 'categories'))],
                           'series': [{'chartClass': attr(node, 'chart', 'class'), 'valuesRange': attr(node, 'chart', 'values-cell-range-address'),
                                       'labelRange': attr(node, 'chart', 'label-cell-address'), 'attributes': dict(node.attrib),
                                       'domains': [attr(domain, 'table', 'cell-range-address') for domain in node.findall('chart:domain', NS)]}
                                      for node in chart.iter(q('chart', 'series'))],
                           'cachedTables': odf_tables(chart, report, True)})
    return charts


def odf_images(pkg, body, report):
    """Resolve images including bitmap fills used by actual document styles."""
    references = [{**odf_part_reference(pkg, attr(node, 'xlink', 'href')), 'kind': 'image'}
                  for node in descendants(body, 'draw', 'image')]
    styles, fills = {}, {}
    for part in ('styles.xml', 'content.xml'):
        tree = pkg.tree(part)
        if tree is None:
            continue
        for node in tree.iter(q('style', 'style')):
            styles[attr(node, 'style', 'name')] = node
        for node in tree.iter(q('draw', 'fill-image')):
            fills[attr(node, 'draw', 'name')] = node
    used_styles = {attr(node, 'draw', 'style-name') for node in body.iter() if attr(node, 'draw', 'style-name')}
    for name in sorted(used_styles):
        chain, current, seen = [], name, set()
        while current and current in styles:
            if current in seen or len(chain) >= LIMITS['xmlDepth']:
                fail('ODF_STYLE_CYCLE', 'ODF graphic style inheritance is cyclic or too deep.')
            seen.add(current); chain.append(styles[current])
            current = attr(styles[current], 'style', 'parent-style-name')
        properties_ = {}
        for style in reversed(chain):
            for child in style:
                if child.tag in (q('style', 'graphic-properties'), q('style', 'drawing-page-properties')):
                    properties_.update(child.attrib)
        if properties_.get(q('draw', 'fill')) != 'bitmap':
            continue
        fill_name = properties_.get(q('draw', 'fill-image-name'))
        fill = fills.get(fill_name)
        if fill is None:
            report.warn('UNRESOLVED_REFERENCE', 'ODF bitmap fill has no named image definition: ' + str(fill_name))
            continue
        references.append({**odf_part_reference(pkg, attr(fill, 'xlink', 'href')), 'kind': 'bitmap-fill',
                           'styleName': name, 'fillImageName': fill_name})
    return references


def odf(pkg, report):
    mimetype = pkg.parts.get('mimetype', b'').decode('ascii', errors='replace').strip()
    kinds = {'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'application/vnd.oasis.opendocument.presentation': 'odp'}
    if mimetype not in kinds:
        report.value.update(format='odf', inspection='unsupported')
        report.warn('UNSUPPORTED_ODF_TYPE', 'This ODF media type has no independent semantic parser.')
        return
    report.value['format'] = kinds[mimetype]
    manifest = pkg.tree('META-INF/manifest.xml')
    if manifest is not None and any(local(node.tag) == 'encryption-data' for node in manifest.iter()):
        fail('ENCRYPTED_ODF', 'Encrypted ODF content cannot be independently inspected without decryption.')
    root = pkg.tree('content.xml', True)
    body = root.find('office:body', NS)
    if body is None:
        fail('MISSING_BODY', 'ODF document has no body.')
    styles_root = pkg.tree('styles.xml')
    styles = []
    for source in (root, styles_root):
        if source is not None:
            for style in descendants(source, 'style', 'style'):
                styles.append({'name': attr(style, 'style', 'name'), 'family': attr(style, 'style', 'family'),
                               'parent': attr(style, 'style', 'parent-style-name'), 'properties': properties(style)})
    features = report.value['features']
    image_references = odf_images(pkg, body, report)
    embedded_objects = [{**odf_part_reference(pkg, attr(node, 'xlink', 'href')), 'kind': local(node.tag)}
                        for node in body.iter() if node.tag in (q('draw', 'object-ole'), q('draw', 'object'))]
    for reference in embedded_objects:
        if not reference['external'] and reference.get('bytes') is None:
            report.warn('MISSING_RELATIONSHIP_TARGET', 'ODF embedded OLE object cannot be resolved: ' + str(reference['href']))
    features.update(images=len(image_references), charts=sum(1 for tree in pkg.trees.values() for _ in tree.iter(q('chart', 'chart'))),
                    hyperlinks=len(descendants(body, 'text', 'a')), annotations=len(descendants(body, 'office', 'annotation')),
                    embeddedObjects=sum(1 for item in embedded_objects if not item['external'] and item.get('bytes', 0)),
                    imageParts=sum(1 for name in pkg.infos if name.startswith('Pictures/') and not name.endswith('/')))
    report.value['odf'] = {'mimetype': mimetype, 'styles': report.bounded(styles, 'ODF styles'),
                          'externalLinks': [attr(node, 'xlink', 'href') for node in body.iter() if attr(node, 'xlink', 'href') and re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', attr(node, 'xlink', 'href'))],
                          'charts': odf_charts(pkg, report), 'imageReferences': image_references, 'embeddedObjects': embedded_objects}
    if kinds[mimetype] == 'ods':
        sheets = odf_tables(body, report, True)
        for sheet, table in zip(sheets, descendants(body, 'table', 'table')):
            references = [odf_part_reference(pkg, attr(node, 'xlink', 'href')) for node in descendants(table, 'draw', 'object')]
            sheet['charts'] = [chart for chart in report.value['odf']['charts'] if any(ref['part'] == chart['part'] for ref in references)]
            sheet['objectReferences'] = references
            sheet['conditionalRules'] = [{'kind': local(node.tag), 'attributes': dict(node.attrib), 'xml': ET.tostring(node, encoding='unicode')} for node in table.iter() if local(node.tag) in ('conditional-format', 'condition', 'data-bar', 'color-scale', 'icon-set')]
        report.value['spreadsheet'] = {'sheets': sheets, 'sheetCount': len(sheets), 'cellCount': sum(s['cellCount'] for s in sheets),
                                       'definedNames': [{local(k): v for k, v in node.attrib.items()} for node in body.iter() if node.tag in (q('table', 'named-range'), q('table', 'named-expression'))],
                                       'dataValidations': [{local(k): v for k, v in node.attrib.items()} for node in descendants(body, 'table', 'content-validation')],
                                       'pivotTables': [{'attributes': dict(node.attrib), 'xml': ET.tostring(node, encoding='unicode')} for node in descendants(body, 'table', 'data-pilot-table')]}
        features.update(sheets=len(sheets), tables=len(sheets), cells=sum(s['cellCount'] for s in sheets), formulas=sum(1 for s in sheets for c in s['cells'] if c['formula']), mergedRanges=sum(len(s['mergedRanges']) for s in sheets))
        report.warn('FORMULAS_NOT_RECALCULATED', 'ODF formulas retain their original namespace/expression and stored values; no recalculation is performed.')
    elif kinds[mimetype] == 'odt':
        content = body.find('office:text', NS)
        if content is None:
            fail('MISSING_BODY', 'ODT has no office:text body.')
        paragraphs = [{'text': odf_text(node), 'style': attr(node, 'text', 'style-name'), 'outlineLevel': attr(node, 'text', 'outline-level')} for node in odf_paragraph_nodes(content)]
        for p in paragraphs:
            report.text(p['text'])
        tables = odf_tables(content, report)
        notes = [{'id': attr(node, 'text', 'id'), 'kind': attr(node, 'text', 'note-class'),
                  'citation': node.findtext('text:note-citation', None, NS),
                  'text': odf_object_text(node.find('text:note-body', NS))} for node in descendants(content, 'text', 'note')]
        changes = []
        for region in descendants(content, 'text', 'changed-region'):
            for node in region:
                if node.tag in (q('text', 'insertion'), q('text', 'deletion'), q('text', 'format-change')):
                    changes.append({'kind': local(node.tag), 'id': attr(region, 'text', 'id'),
                                    'author': node.findtext('office:change-info/dc:creator', None, NS),
                                    'date': node.findtext('office:change-info/dc:date', None, NS),
                                    'text': odf_object_text(node)})
        comments = [{'name': attr(node, 'office', 'name'), 'author': node.findtext('dc:creator', None, NS),
                     'date': node.findtext('dc:date', None, NS), 'text': odf_object_text(node)}
                    for node in descendants(content, 'office', 'annotation')]
        for item in notes + comments:
            report.text(item['text'])
        headers, footers = [], []
        if styles_root is not None:
            for node in styles_root.iter():
                target = headers if node.tag in {q('style', name) for name in ('header', 'header-left', 'header-first')} else footers if node.tag in {q('style', name) for name in ('footer', 'footer-left', 'footer-first')} else None
                if target is not None:
                    target.append({'kind': local(node.tag), 'text': '\n'.join(odf_text(p) for p in descendants(node, 'text', 'p'))})
                    report.text(target[-1]['text'])
        report.value['word'] = {'paragraphCount': len(paragraphs), 'paragraphs': report.bounded(paragraphs, 'ODT paragraphs'), 'tables': tables, 'styles': report.bounded(styles, 'ODT styles'),
                                'headers': headers, 'footers': footers, 'comments': comments,
                                'footnotes': [note for note in notes if note['kind'] == 'footnote'], 'endnotes': [note for note in notes if note['kind'] == 'endnote'], 'trackedChanges': changes}
        features.update(paragraphs=len(paragraphs), tables=len(tables), comments=len(report.value['word']['comments']), footnotes=len(report.value['word']['footnotes']), endnotes=len(report.value['word']['endnotes']), trackedChanges=len(changes))
    else:
        slides = []
        for index, page in enumerate(descendants(body, 'draw', 'page')):
            notes = descendants(page, 'presentation', 'notes')
            note_nodes = {id(child) for note in notes for child in note.iter()}
            texts = [odf_text(node) for node in odf_paragraph_nodes(page) if id(node) not in note_nodes]
            for value in texts:
                report.text(value)
            note_items = [{'text': odf_object_text(note)} for note in notes]
            for note in note_items:
                report.text(note['text'])
            animations = [{'kind': local(node.tag), 'attributes': {local(k): v for k, v in node.attrib.items()}} for node in page.iter() if node.tag.startswith('{' + NS['animation'] + '}')]
            media = [{**{local(k): v for k, v in node.attrib.items()}, **odf_part_reference(pkg, attr(node, 'xlink', 'href'))} for node in descendants(page, 'draw', 'plugin')]
            objects = [odf_part_reference(pkg, attr(node, 'xlink', 'href')) for node in page.iter() if node.tag in (q('draw', 'object'), q('draw', 'object-ole'))]
            slides.append({'index': index, 'name': attr(page, 'draw', 'name'), 'style': attr(page, 'draw', 'style-name'), 'texts': texts,
                           'notes': note_items, 'tables': odf_tables(page, report), 'media': media, 'animations': animations,
                           'charts': [chart for chart in report.value['odf']['charts'] if any(ref['part'] == chart['part'] for ref in objects)],
                           'objectReferences': [ref['href'] for ref in objects], 'resolvedObjects': objects})
        report.value['presentation'] = {'slides': slides, 'slideCount': len(slides)}
        features.update(slides=len(slides), tables=sum(len(s['tables']) for s in slides), mediaReferences=sum(len(s['media']) for s in slides), animations=sum(len(s['animations']) for s in slides))


def rtf(data, report):
    report.value['format'] = 'rtf'
    if not re.match(br'^\s*\{\\rtf\d', data):
        fail('INVALID_RTF', 'RTF must start with its declared root group.')
    # Latin-1 preserves byte offsets. Hex and text bytes are decoded only after
    # the active codepage is known; no embedded object is interpreted/executed.
    source = data.decode('latin1')
    state = {'uc': 1, 'skip': False, 'destination': 'body', 'ignorable': False, 'codepage': 'cp1252'}
    stack, buckets, counts, controls = [], {}, Counter(), Counter()
    i, fallback, text_bytes = 0, 0, bytearray()
    skip_destinations = {'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'filetbl', 'listtable', 'listoverridetable', 'generator', 'datastore', 'themedata', 'colorschememapping', 'xmlnstbl'}
    destinations = {'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'annotation', 'fldinst', 'fldrslt'}
    def emit(text):
        if not state['skip']:
            buckets.setdefault(state['destination'], []).append(text)
    def flush():
        if text_bytes:
            emit(bytes(text_bytes).decode(state['codepage'], errors='replace'))
            text_bytes.clear()
    while i < len(source):
        ch = source[i]
        if ch == '{':
            flush()
            if len(stack) >= LIMITS['rtfDepth']:
                fail('RTF_LIMIT', 'RTF group nesting exceeds the limit.')
            stack.append(dict(state)); state['ignorable'] = False; i += 1
        elif ch == '}':
            flush()
            if not stack:
                fail('INVALID_RTF', 'Unbalanced RTF groups.')
            state = stack.pop(); i += 1
        elif ch == '\\':
            if i + 1 >= len(source):
                fail('INVALID_RTF', 'Incomplete RTF escape.')
            next_char = source[i + 1]
            if next_char == "'":
                token = source[i + 2:i + 4]
                if len(token) != 2 or not re.fullmatch('[0-9a-fA-F]{2}', token):
                    fail('INVALID_RTF', 'Invalid RTF hexadecimal escape.')
                if fallback:
                    fallback -= 1
                else:
                    text_bytes.append(int(token, 16))
                i += 4; continue
            flush()
            if next_char in '{}\\~_-':
                if fallback:
                    fallback -= 1
                else:
                    emit({'~': '\u00a0', '_': '\u2011', '-': '\u00ad'}.get(next_char, next_char))
                i += 2; continue
            if next_char == '*':
                state['ignorable'] = True; i += 2; continue
            match = re.match(r'\\([A-Za-z]+)(-?\d+)? ?', source[i:])
            if not match:
                i += 2; continue
            word, parameter = match.group(1), match.group(2)
            value = int(parameter) if parameter is not None else None
            i += len(match.group(0)); controls[word] += 1
            if word == 'bin':
                if value is None or value < 0 or i + value > len(source):
                    fail('INVALID_RTF', 'Invalid RTF binary payload length.')
                i += value; continue
            if word in skip_destinations:
                counts[word] += 1; state['skip'] = True
            elif word in destinations:
                state['destination'] = word; counts[word] += 1
            elif state['ignorable']:
                state['skip'] = True
            state['ignorable'] = False
            if word == 'ansicpg':
                name = 'cp' + str(value)
                try:
                    codecs.lookup(name)
                    state['codepage'] = name
                except LookupError:
                    report.warn('UNKNOWN_RTF_CODEPAGE', 'Unsupported RTF codepage; affected bytes use replacement characters.')
            elif word == 'uc':
                if value is None or not 0 <= value <= 16:
                    fail('RTF_LIMIT', 'Invalid RTF Unicode fallback length.')
                state['uc'] = value
            elif word == 'u':
                if value is None or not -32768 <= value <= 65535:
                    fail('INVALID_RTF', 'Invalid RTF Unicode code unit.')
                emit(chr(value & 0xffff)); fallback = state['uc']
            elif word in ('par', 'line'):
                emit('\n')
            elif word == 'tab':
                emit('\t')
            elif word in ('cell', 'nestcell'):
                # A cell delimiter is structural, not a literal tab in a
                # paragraph. Emit a text-block boundary as OOXML/ODF cell
                # paragraphs do; an actual \tab remains an actual tab above.
                emit('\n')
            elif word in ('row', 'nestrow'):
                emit('\n'); counts['tableRows'] += 1
            elif word in ('emdash', 'endash', 'bullet', 'lquote', 'rquote', 'ldblquote', 'rdblquote'):
                emit({'emdash': '—', 'endash': '–', 'bullet': '•', 'lquote': '‘', 'rquote': '’', 'ldblquote': '“', 'rdblquote': '”'}[word])
        else:
            if ch not in '\r\n':
                if fallback:
                    fallback -= 1
                else:
                    text_bytes.append(ord(ch))
            i += 1
    flush()
    if stack:
        fail('INVALID_RTF', 'Unclosed RTF group.')
    values = {key: ''.join(value).encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace') for key, value in buckets.items()}
    for value in values.values():
        report.text(value)
    body = values.get('body', '')
    report.value['word'] = {'paragraphs': [{'text': p} for p in body.split('\n')], 'paragraphCount': len(body.split('\n')),
                            'headers': [{'kind': k, 'text': v} for k, v in values.items() if k.startswith('header')],
                            'footers': [{'kind': k, 'text': v} for k, v in values.items() if k.startswith('footer')],
                            'footnotes': [{'text': values['footnote']}] if 'footnote' in values else [],
                            'comments': [{'text': values['annotation']}] if 'annotation' in values else [],
                            'fields': [{'instructions': values.get('fldinst', ''), 'displayText': values.get('fldrslt', '')}],
                            'tables': {'rowControlCount': counts['tableRows'], 'cellControlCount': controls['cell'] + controls['nestcell']},
                            'styles': {'styleControlCount': controls['s'], 'characterStyleControlCount': controls['cs']},
                            'trackedChanges': {'insertControlCount': controls['revised'], 'deleteControlCount': controls['deleted']}}
    report.value['rtf'] = {'destinations': dict(counts), 'controls': dict(controls)}
    report.value['features'].update(images=counts['pict'], embeddedObjects=counts['object'], tableRows=counts['tableRows'], hyperlinks=values.get('fldinst', '').upper().count('HYPERLINK'))
    report.warn('RTF_PARTIAL_STRUCTURE', 'RTF text and control/destination counts are parsed; table layout, style definitions, nested fields, tracked ranges and embedded OLE/chart semantics are not fully reconstructed.')


def pdf(data, report, preview_dir=None):
    report.value['format'] = 'pdf'
    try:
        import pymupdf
    except ImportError:
        report.value['inspection'] = 'unsupported'
        report.warn('PDF_PARSER_UNAVAILABLE', 'PyMuPDF is unavailable; use the existing pdf-backend/.venv Python interpreter.')
        return
    try:
        doc = pymupdf.open(stream=data, filetype='pdf')
    except Exception:
        fail('INVALID_PDF', 'PyMuPDF could not open the PDF bytes.')
    with doc:
        if doc.needs_pass:
            fail('PDF_PASSWORD_REQUIRED', 'Encrypted PDF requires its password; the inspector does not bypass protection.')
        if doc.page_count > LIMITS['pages']:
            fail('PAGE_LIMIT', 'PDF page count exceeds the inspection limit.')
        # PDF permission masks are signed (often negative), including restricted
        # encrypted files with an empty opening password. Test the bit directly.
        if not doc.permissions & pymupdf.PDF_PERM_COPY:
            fail('PDF_COPY_RESTRICTED', 'The PDF does not permit text extraction.')
        pages = []
        for index, page in enumerate(doc):
            text = page.get_text()
            report.text(text)
            item = {'index': index, 'width': page.rect.width, 'height': page.rect.height, 'rotation': page.rotation,
                    'text': text, 'images': len(page.get_images()), 'annotations': len(list(page.annots() or []))}
            if preview_dir and index < LIMITS['previewPages']:
                folder = pathlib.Path(preview_dir)
                folder.mkdir(parents=True, exist_ok=True)
                destination = folder / ('page-' + str(index + 1).zfill(3) + '.png')
                if destination.exists():
                    fail('PREVIEW_EXISTS', 'Refusing to overwrite an existing preview image.')
                scale = min(1.4, 1400 / max(page.rect.width, page.rect.height))
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                pixmap.save(destination)
                item['preview'] = destination.name
            pages.append(item)
        report.value['pdf'] = {'pageCount': doc.page_count, 'pages': pages, 'metadata': doc.metadata,
                               'outline': doc.get_toc(), 'parserVersion': pymupdf.VersionBind, 'previewCount': min(doc.page_count, LIMITS['previewPages']) if preview_dir else 0}
        report.value['features'].update(pages=doc.page_count, images=sum(p['images'] for p in pages), annotations=sum(p['annotations'] for p in pages))


def inspect(path, preview_dir=None):
    path = pathlib.Path(path)
    report = None
    try:
        if not path.is_file() or path.stat().st_size > LIMITS['inputBytes']:
            fail('INPUT_LIMIT', 'Input must be a regular file no larger than the configured input limit.')
        with path.open('rb') as stream:
            data = stream.read(LIMITS['inputBytes'] + 1)
        if len(data) > LIMITS['inputBytes']:
            fail('INPUT_LIMIT', 'Input grew beyond the configured limit while being read.')
        report = Report(path, data)
        if data.startswith(b'PK\x03\x04') or data.startswith(b'PK\x05\x06'):
            pkg = Package(data, report)
            if '[Content_Types].xml' in pkg.parts:
                ooxml(pkg, report)
                features = report.value['features']
                features.setdefault('images', features.get('imageParts', 0))
                features.setdefault('charts', features.get('chartParts', 0))
                features.setdefault('tables', sum(1 for name in pkg.infos if re.search(r'/tables/table\d+\.xml$', name)))
                features['hyperlinks'] = sum(1 for name, tree in pkg.trees.items() if name.endswith('.rels') for node in tree if node.get('Type', '').endswith('/hyperlink'))
            elif 'mimetype' in pkg.parts:
                odf(pkg, report)
            else:
                report.value.update(format='zip', inspection='unsupported')
                report.warn('UNRECOGNIZED_PACKAGE', 'Safe ZIP container, but no supported OOXML/ODF main document was detected.')
        elif data.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
            report.value.update(format='ole', inspection='unsupported')
            report.value['legacy'] = {'extensionHint': path.suffix.lower().lstrip('.'), 'container': 'OLE Compound File', 'contentParsed': False}
            report.warn('LEGACY_PARSER_UNAVAILABLE', 'DOC/XLS/PPT and encrypted OOXML may use OLE. No independent legacy parser is installed; content and feature preservation are not validated.')
        elif data.lstrip().startswith(b'{\\rtf'):
            rtf(data, report)
        elif data.startswith(b'%PDF-'):
            pdf(data, report, preview_dir)
        else:
            report.value.update(inspection='unsupported')
            report.warn('UNSUPPORTED_FORMAT', 'The file magic does not identify a supported document format.')
        if report.value['truncated']:
            fail('REPORT_LIMIT', 'Structural output was truncated; the file cannot count as a complete independent inspection.')
        if report.value['inspection'] != 'unsupported':
            report.value.update(ok=True, inspection='parsed')
        return report.value
    except InspectionError as error:
        result = report.value if report else {'schemaVersion': 1, 'ok': False, 'format': 'unknown', 'inspection': 'rejected', 'zipSafety': None, 'warnings': [], 'errors': []}
        result['errors'].append({'code': error.code, 'message': str(error)})
        return result
    except (OSError, ValueError, OverflowError, KeyError, IndexError, RuntimeError, UnicodeError) as error:
        result = report.value if report else {'schemaVersion': 1, 'ok': False, 'format': 'unknown', 'inspection': 'rejected', 'zipSafety': None, 'warnings': [], 'errors': []}
        result['errors'].append({'code': 'INSPECTION_ERROR', 'message': type(error).__name__ + ': ' + str(error)[:240]})
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=pathlib.Path)
    parser.add_argument('--preview-dir', help='Optionally render at most six bounded PDF previews, without overwriting existing files.')
    args = parser.parse_args()
    result = inspect(args.file, args.preview_dir)
    encoded, size = [], 0
    for chunk in json.JSONEncoder(ensure_ascii=True, allow_nan=False).iterencode(result):
        size += len(chunk)
        if size > LIMITS['outputBytes']:
            result = {'schemaVersion': 1, 'ok': False, 'inspection': 'rejected', 'format': result['format'],
                      'file': result.get('file'), 'zipSafety': result.get('zipSafety'), 'truncated': True,
                      'warnings': [], 'errors': [{'code': 'OUTPUT_LIMIT', 'message': 'The structural report exceeds the JSON output limit; no complete inspection is claimed.'}]}
            encoded = [json.dumps(result, ensure_ascii=True)]
            break
        encoded.append(chunk)
    print(''.join(encoded))
    return 0 if result['ok'] else 2 if result['inspection'] == 'unsupported' else 1


if __name__ == '__main__':
    sys.exit(main())
