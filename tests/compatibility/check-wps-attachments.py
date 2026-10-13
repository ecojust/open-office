#!/usr/bin/env python3
"""Bounded, read-only audit of the nine WPS fixture attachments.

SPDX-License-Identifier: MIT

Uses only Python's standard library and inspect-output.py. Never activates an
OLE object, executes content, fetches a relationship, or modifies input files.
Exit 0: compared semantics retained; 1: actual loss; 2: invalid/unavailable input.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import tempfile
from zipfile import BadZipFile, ZipFile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MAX_BYTES = 64 * 1024 * 1024
EOC, FREE = 0xfffffffe, 0xffffffff
SIGNATURE = bytes.fromhex('d0cf11e0a1b11ae1')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cfb_package(data):
    """Read one unambiguous package stream from a bounded CFB v3/v4 file.

    No general filesystem extraction; all sectors/chains/names/sizes are bounded.
    Supports normal and mini streams, rejects cyclic or truncated FAT chains.
    """
    require(512 <= len(data) <= MAX_BYTES and data[:8] == SIGNATURE, 'Invalid or oversized CFB')
    version, endian, sector_shift, mini_shift = struct.unpack_from('<HHHH', data, 26)
    require(endian == 0xfffe and (version, sector_shift) in ((3, 9), (4, 12)) and mini_shift == 6, 'Unsupported CFB header')
    sector_size = 1 << sector_shift
    require(len(data) % sector_size == 0, 'Truncated CFB sectors')
    sector_count = len(data) // sector_size - 1
    require(0 < sector_count <= MAX_BYTES // sector_size, 'Invalid CFB sector count')

    def sector(index):
        require(isinstance(index, int) and 0 <= index < sector_count, 'Invalid CFB sector index')
        return data[(index + 1) * sector_size:(index + 2) * sector_size]

    fat_count, directory_start = struct.unpack_from('<II', data, 44)
    cutoff, mini_start, mini_count, difat_start, difat_count = struct.unpack_from('<IIIII', data, 56)
    require(cutoff == 4096 and 0 < fat_count <= sector_count and mini_count <= sector_count and difat_count <= sector_count, 'Invalid CFB allocation counts')
    fat_sectors = [v for v in struct.unpack_from('<109I', data, 76) if v != FREE]
    visited, current = set(), difat_start
    for _ in range(difat_count):
        require(current not in visited, 'Cyclic CFB DIFAT')
        visited.add(current)
        values = struct.unpack('<' + 'I' * (sector_size // 4), sector(current))
        fat_sectors.extend(v for v in values[:-1] if v != FREE)
        current = values[-1]
    require(current in (EOC, FREE) and len(fat_sectors) == fat_count and len(set(fat_sectors)) == fat_count, 'Invalid CFB DIFAT termination')
    fat = []
    for index in fat_sectors:
        fat.extend(struct.unpack('<' + 'I' * (sector_size // 4), sector(index)))

    def chain(start, allocation, read_sector, limit, unit):
        chunks, seen = [], set()
        while start != EOC:
            require(0 <= start < len(allocation) and start not in seen and len(seen) < limit, 'Invalid or cyclic CFB stream chain')
            seen.add(start)
            chunk = read_sector(start)
            require(len(chunk) == unit, 'Truncated CFB stream sector')
            chunks.append(chunk)
            start = allocation[start]
        return b''.join(chunks)

    def regular(start, size=None):
        require(size is None or 0 <= size <= MAX_BYTES, 'Oversized CFB stream')
        if size == 0:
            return b''
        raw = chain(start, fat, sector, sector_count, sector_size)
        require(size is None or len(raw) >= size, 'Truncated CFB stream')
        return raw if size is None else raw[:size]

    directory = regular(directory_start)
    entries = []
    for offset in range(0, len(directory), 128):
        record = directory[offset:offset + 128]
        require(len(record) == 128, 'Invalid CFB directory length')
        kind, name_length = record[66], struct.unpack_from('<H', record, 64)[0]
        if kind not in (2, 5):
            continue
        require(2 <= name_length <= 64 and name_length % 2 == 0 and record[name_length - 2:name_length] == b'\0\0', 'Invalid CFB directory name')
        name = record[:name_length - 2].decode('utf-16le', errors='strict')
        start = struct.unpack_from('<I', record, 116)[0]
        size = struct.unpack_from('<Q', record, 120)[0]
        require(size <= MAX_BYTES, 'Oversized CFB directory stream')
        entries.append((kind, name, start, size))
    roots = [entry for entry in entries if entry[0] == 5]
    packages = [entry for entry in entries if entry[0] == 2 and entry[1].casefold() == 'package']
    require(len(roots) == 1 and len(packages) == 1, 'CFB must have one root and one package stream')
    _, _, start, size = packages[0]
    if size >= cutoff:
        payload = regular(start, size)
    else:
        mini_raw = regular(mini_start, mini_count * sector_size)
        mini_fat = list(struct.unpack('<' + 'I' * (len(mini_raw) // 4), mini_raw))
        root = roots[0]
        mini_stream = regular(root[2], root[3])
        payload = chain(start, mini_fat, lambda index: mini_stream[index * 64:(index + 1) * 64], len(mini_stream) // 64, 64)
        require(len(payload) >= size, 'Truncated CFB mini stream')
        payload = payload[:size]
    require(payload.startswith(b'PK\x03\x04'), 'CFB package is not a ZIP document')
    return payload


def attachments(path):
    require(path.is_file() and path.stat().st_size <= MAX_BYTES, 'Missing or oversized document')
    result = {}
    with ZipFile(path) as archive:
        require(len(archive.infolist()) <= 6000, 'Too many ZIP entries')
        for entry in archive.infolist():
            if not entry.filename.startswith('word/embeddings/') or entry.is_dir():
                continue
            match = re.fullmatch(r'word/embeddings/(oleObject([1-9])\.(?:bin|docx|xlsx|doc|xls|ppt|pptx))', entry.filename)
            require(match is not None and not entry.flag_bits & 1 and 0 < entry.file_size <= MAX_BYTES, 'Unexpected or oversized embedded object')
            name, number = match.groups()
            number = int(number)
            require(number not in result, 'Duplicate embedded object number')
            payload = archive.read(entry)
            require(len(payload) == entry.file_size, 'Truncated embedded object')
            result[number] = {'name': name, 'bytes': len(payload), 'sha256': sha(payload), 'payload': payload}
    require(set(result) == set(range(1, 10)), 'Expected exactly nine distinct embedded objects')
    return result


def semantics(report):
    require(report['ok'] and report['inspection'] == 'parsed', 'Independent inspection rejected attachment')
    result = {'format': report['format'], 'text': report['coreText']['strings'], 'features': report['features']}
    if 'word' in report:
        word = report['word']
        result.update(paragraphs=[p['text'] for p in word['paragraphs']], tables=word['tables'], sections=word.get('sections', []))
    if 'spreadsheet' in report:
        sheet = report['spreadsheet']
        result['sheets'] = [{'name': s['name'], 'state': s['state'], 'cells': [{k: cell[k] for k in ('address', 'type', 'value', 'formula')} for cell in s['cells']], 'mergedRanges': s['mergedRanges']} for s in sheet['sheets']]
    return result


def run(output_dir):
    spec = importlib.util.spec_from_file_location('independent_inspector', HERE / 'inspect-output.py')
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    manifest = json.loads((HERE / 'manifest.json').read_text())
    fixture = next(item for item in manifest['fixtures'] if item['id'] == 'tika-wps-attachments')
    source_path = HERE / fixture['path']
    require(sha(source_path.read_bytes()) == fixture['sha256'], 'Source fixture hash mismatch')
    source = attachments(source_path)
    audit = {'schemaVersion': 1, 'fixtureId': fixture['id'], 'scope': 'Read-only bounded ZIP/CFB package-stream parsing; no object activation, external access or Office execution', 'source': {'path': source_path.relative_to(ROOT).as_posix(), 'sha256': fixture['sha256']}, 'cycles': [], 'lossDetected': False,
             'limits': {'renderedPageCount': 'Not measured; XML page setup is not a rendered page count', 'unchangedHashes': 'Prove binary preservation only, not execution safety or Office interoperability', 'coverage': 'Two simple embedded packages; no formulas or tables in these packages'}}
    with tempfile.TemporaryDirectory(prefix='wps-attachment-audit-') as temporary:
        temporary = Path(temporary)

        def analyze(objects, source_group=False):
            result = {}
            for number, extension in ((5, 'docx'), (7, 'xlsx')):
                payload = objects[number]['payload']
                if source_group:
                    payload = cfb_package(payload)
                else:
                    require(payload.startswith(b'PK\x03\x04'), 'Expected converted OOXML attachment')
                path = temporary / f'object{number}.{extension}'
                path.write_bytes(payload)
                result[str(number)] = {'packageSha256': sha(payload), 'semantics': semantics(inspector.inspect(path))}
            return result

        def inventory(objects):
            return [{'object': number, **{key: value for key, value in objects[number].items() if key != 'payload'}} for number in sorted(objects)]

        baseline = analyze(source, True)
        # Refuse a changed fixture or parser failure being mistaken for preservation.
        require(baseline['5']['semantics']['text'] == ['docx_content'], 'Unexpected source Word semantics')
        require([s['name'] for s in baseline['7']['semantics']['sheets']] == ['Sheet1', 'Sheet2', 'Sheet3'], 'Unexpected source sheet names')
        require(baseline['7']['semantics']['sheets'][0]['cells'] == [{'address': 'A1', 'type': 'text', 'value': 'xlsx_content', 'formula': None}], 'Unexpected source cell semantics')
        audit['source'].update(objects=inventory(source), packages=baseline)
        for cycle in (1, 2, 3):
            path = output_dir / f'docx-cycle-{cycle}.docx'
            objects = attachments(path)
            current = analyze(objects)
            preserved = [n for n in sorted(objects) if objects[n]['sha256'] == source[n]['sha256']]
            word_old, word_new = baseline['5']['semantics'], current['5']['semantics']
            sheet_old, sheet_new = baseline['7']['semantics'], current['7']['semantics']
            new_sheets = {s['name']: s for s in sheet_new['sheets']}
            missing_text = [text for text in word_old['text'] if text not in word_new['text']]
            missing_sheets = [s['name'] for s in sheet_old['sheets'] if s['name'] not in new_sheets]
            changed_cells = []
            for sheet in sheet_old['sheets']:
                cells = {c['address']: c for c in new_sheets.get(sheet['name'], {}).get('cells', [])}
                for cell in sheet['cells']:
                    if cells.get(cell['address']) != cell:
                        changed_cells.append({'sheet': sheet['name'], 'address': cell['address'], 'before': cell, 'after': cells.get(cell['address'])})
            losses = {'missingWordText': missing_text, 'missingSheets': missing_sheets, 'changedOrMissingCells': changed_cells, 'wordPageSetupChanged': word_old['sections'] != word_new['sections']}
            detected = bool(missing_text or missing_sheets or changed_cells)
            audit['lossDetected'] |= detected
            audit['cycles'].append({'cycle': cycle, 'output': path.relative_to(ROOT).as_posix(), 'sha256': sha(path.read_bytes()), 'objectCount': len(objects), 'objects': inventory(objects), 'byteIdenticalToSource': preserved, 'changedFromSource': [n for n in sorted(objects) if n not in preserved], 'packages': current, 'lossDetected': detected, 'differences': losses})
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, default=ROOT / 'test-results/compatibility/local-only-wps/tika-wps-attachments')
    parser.add_argument('--report', type=Path, default=HERE / 'results/wps-attachment-audit.json')
    args = parser.parse_args()
    try:
        # Only repository-relative provenance is emitted in versionable reports.
        output_dir = args.input_dir.resolve()
        output_dir.relative_to(ROOT)
        result = run(output_dir)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'fixtureId': result['fixtureId'], 'cycles': len(result['cycles']), 'lossDetected': result['lossDetected'], 'firstLossCycle': next((c['cycle'] for c in result['cycles'] if c['lossDetected']), None)}))
        return 1 if result['lossDetected'] else 0
    except (OSError, ValueError, KeyError, StopIteration, BadZipFile, struct.error) as error:
        # Do not echo arbitrary file paths or payload values into public diagnostics.
        print(json.dumps({'inspection': 'rejected', 'errorClass': type(error).__name__}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
