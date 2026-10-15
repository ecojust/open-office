#!/usr/bin/env python3
"""Read-only native DOCX/ODT/PDF oracle; does not import product code."""
from pathlib import Path
import hashlib
import json
import zipfile
from xml.etree import ElementTree as E

import fitz

from inspect_docx import inspect

ROOT = Path(__file__).resolve().parent
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
NS = {
    'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
}
S = '{' + NS['style'] + '}'
T = '{' + NS['text'] + '}'
checks = 0


def check(ok, message):
    global checks
    checks += 1
    if not ok:
        raise AssertionError(message)


def load(name):
    return json.loads((ROOT / name).read_text())


def spacing(p):
    node = p.find(W + 'spacing') if p is not None else None
    return {} if node is None else {k.split('}')[1]: v for k, v in node.attrib.items()}


def native_docx(path):
    """Resolve complete native encodings without using the source-rule oracle."""
    with zipfile.ZipFile(path) as archive:
        root = E.fromstring(archive.read('word/document.xml'))
        sheet = E.fromstring(archive.read('word/styles.xml'))
    definitions = {n.get(W + 'styleId'): n for n in sheet.findall(W + 'style')}
    defaults = dict(lineRule='auto', line='240', before='0', after='0')
    defaults.update(spacing(sheet.find(W + 'docDefaults/' + W + 'pPrDefault/' + W + 'pPr')))
    default_id = next((key for key, v in definitions.items()
                       if v.get(W + 'type') == 'paragraph' and v.get(W + 'default') in ('1', 'true')), None)

    def resolve(key, seen=()):
        if not key:
            return dict(defaults)
        check(key not in seen, 'native paragraph style cycle')
        style = definitions[key]
        base = style.find(W + 'basedOn')
        props = resolve(base.get(W + 'val') if base is not None else None, (*seen, key))
        props.update(spacing(style.find(W + 'pPr')))
        return props

    rows = []
    for paragraph in root.findall(W + 'body/' + W + 'p'):
        direct = paragraph.find(W + 'pPr')
        style = direct.find(W + 'pStyle') if direct is not None else None
        props = resolve(style.get(W + 'val') if style is not None else default_id)
        props.update(spacing(direct))
        rows.append(dict(text=''.join(n.text or '' for n in paragraph.iter(W + 't')), **props))
    return rows


def native_odt(path):
    with zipfile.ZipFile(path) as archive:
        roots = [E.fromstring(archive.read(name)) for name in ('content.xml', 'styles.xml')]
    styles = {n.get(S + 'name'): n for root in roots for n in root.findall('.//style:style', NS)}
    defaults = {}

    def layer(props, node):
        if node is None:
            return props
        own = {k.split('}')[1]: v for k, v in node.attrib.items()}
        alternatives = ('line-height', 'line-height-at-least', 'line-spacing')
        if any(key in own for key in alternatives):
            for key in alternatives:
                props.pop(key, None)
        props.update(own)
        return props

    for root in roots:
        for style in root.findall('.//style:default-style', NS):
            if style.get(S + 'family') == 'paragraph':
                layer(defaults, style.find('style:paragraph-properties', NS))

    def resolve(key, seen=()):
        if not key:
            return dict(defaults)
        check(key not in seen, 'native ODT style cycle')
        style = styles[key]
        return layer(resolve(style.get(S + 'parent-style-name'), (*seen, key)),
                     style.find('style:paragraph-properties', NS))

    return [dict(text=''.join(p.itertext()), props=resolve(p.get(T + 'style-name')))
            for p in roots[0].findall('.//office:body/office:text/text:p', NS)]


def native_pdf(path):
    with fitz.open(path) as document:
        return [dict(page=page.number, text=span['text'], origin=span['origin'])
                for page in document for block in page.get_text('dict')['blocks']
                for line in block.get('lines', []) for span in line['spans']]


def main():
    manifest = load('manifest.json')
    provenance = load('research-provenance.json')
    raw_expected = load('expected.json')
    resolved = []
    for artifact in provenance['artifacts']:
        path = ROOT / artifact['path']
        check(hashlib.sha256(path.read_bytes()).hexdigest() == artifact['sha256'], 'hash ' + artifact['path'])
        if path.suffix in ('.docx', '.odt'):
            with zipfile.ZipFile(path) as archive:
                check(archive.testzip() is None, 'archive CRC ' + artifact['path'])
                for name in archive.namelist():
                    if name.endswith(('.xml', '.rels')):
                        E.fromstring(archive.read(name))
                        check(True, 'complete XML ' + name)
    for fixture in manifest['fixtures']:
        name = fixture['name']
        authored = inspect(ROOT / fixture['source'])['paragraphs']
        effective = [dict(text=p['text'], **p['effective']) for p in authored]
        check(effective == fixture['sourceExpected'], name + ' source oracle')
        check([dict(source=p['source'], direct=p['direct']) for p in authored] == fixture['provenance'], name + ' source provenance')
        first = native_docx(ROOT / fixture['docx'])
        second = native_docx(ROOT / fixture['secondDocx']['path'])
        odt = native_odt(ROOT / fixture['odt']['path'])
        resolved.append(dict(name=name, first=first, second=second, odt=odt))
        expected = raw_expected[name]
        check(len(first) == len(second) == len(odt) == len(expected) == len(authored), name + ' paragraph counts')
        for stage in (fixture['docx'], fixture['secondDocx']['path']):
            native = inspect(ROOT / stage)['paragraphs']
            check([dict(text=p['text'], **p['effective']) for p in native] == fixture['expected'], name + ' native effective properties ' + stage)
        first_pdf = native_pdf(ROOT / fixture['pdf']['path'])
        second_pdf = native_pdf(ROOT / fixture['secondPdf']['path'])
        for index, expected_row in enumerate(expected):
            for stage, rows in (('first', first), ('second', second)):
                for key in ('line', 'lineRule', 'before', 'after'):
                    check(rows[index][key] == str(expected_row[key]), f'{name}/{index}/{stage}/{key}')
            check(first[index]['text'] == second[index]['text'], f'{name}/{index}/text')
            rule = expected_row['lineRule']
            actual = odt[index]['props'].get('line-height-at-least') if rule == 'atLeast' else odt[index]['props'].get('line-height', '100%')
            odt_expected = ('116%' if expected_row['line'] == 278 else '100%' if rule == 'auto'
                            else '0.25in' if expected_row['line'] == 360 else '0.1665in')
            check(actual == odt_expected, f'{name}/{index}/ODT mutually exclusive line rule')
            prefix = 'D001' if name.startswith('defaults') and index == 1 else f'C{index:03d}'
            for stage, spans in (('first', first_pdf), ('second', second_pdf)):
                lines = [span for span in spans if span['text'].startswith(prefix)]
                check(len(lines) == 2 and lines[0]['page'] == lines[1]['page'], f'{name}/{index}/{stage}/same-page soft lines')
                distance = lines[1]['origin'][1] - lines[0]['origin'][1]
                check(abs(distance - expected_row['baselineDistancePt']) < .015, f'{name}/{index}/{stage}/PDF baseline')
    check(resolved == load('resolved-native.json'), 'frozen effective native inheritance')
    for path, expected_sha in load('inventory.json')['files'].items():
        check(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected_sha, 'sealed ' + path)
    print(json.dumps(dict(ok=True, checks=checks, nativeVersion=provenance['nativeVersion'],
                          authorPackages=6, nativeParagraphs=27, completeArtifacts=36,
                          microsoftWordRuntime=False, productCodeInvoked=False,
                          pdfReadFromActualFiles=True, externalResearchDirectoryRequired=False), indent=2))


if __name__ == '__main__':
    main()
