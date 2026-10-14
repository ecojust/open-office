#!/usr/bin/env python3
"""Freeze complete independently authored/native files after research verification.

No product module is imported. Source XML remains raw in sourceInspection;
sourceExpected is native-effective page geometry from the first native import.
"""
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = Path('/workspace/open-office-research/libreoffice/page-settings')
spec = importlib.util.spec_from_file_location('page_oracle', HERE / 'inspect_docx.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def copy(source, relative):
    target = HERE / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    assert sha(source) == sha(target)
    return {'path': relative, 'sha256': sha(target)}


def effective(filename):
    doc = oracle.inspect_docx(filename)
    assert len(doc['sections']) == 1
    section = doc['sections'][0]
    assert section['location'] == 'body'
    assert len(section['explicitPoints']) == 6
    return dict(**section['explicitPoints'], orientation=section['size'].get('orient', 'portrait'))


if __name__ == '__main__':
    # The absence of the independent inventory deliberately blocks freezing.
    inventory = RESEARCH / 'inventory.json'
    verification = RESEARCH / 'verification.json'
    assert inventory.exists() and verification.exists(), 'Research has not frozen its contract yet'
    positives = ['no-section', 'width-only', 'height-only', 'partial-margins',
                 'a4-portrait', 'a4-near', 'a4-landscape', 'tall-landscape-flag',
                 'wide-portrait-flag', 'custom-odd', 'zero-margins',
                 'header-footer-distances', 'a5', 'letter', 'legal']
    negatives = {'gutter-positive': 'Nonzero gutter is outside the supported page subset.',
                 'negative-top': 'Negative margins are outside the supported page subset; the native-repaired output is retained in research.',
                 'occupied-margins': 'Margins must leave positive body width and height.'}
    negatives.update({f'paper-drift-{raw}': 'The original raw dimension changes again after native DOCX reopening; the stable import/edit subset rejects it atomically.' for raw in [5965, 6488, 7896, 10407, 12936, 17256, 18684, 20185]})
    rows = []
    for name in positives:
        native = RESEARCH / 'native-docx' / (name + '.docx')
        source = copy(RESEARCH / 'input' / (name + '.docx'), 'source/' + name + '.docx')
        first = copy(native, 'libreoffice/' + name + '.docx')
        second = copy(RESEARCH / 'native-docx-second' / (name + '.docx'), 'libreoffice-second/' + name + '.docx')
        expected = effective(native)
        assert expected == effective(RESEARCH / 'native-docx-second' / (name + '.docx')), name
        rows.append(dict(name=name, source=source['path'], sourceSha256=source['sha256'],
                         docx=first['path'], docxSha256=first['sha256'],
                         pdf=copy(RESEARCH / 'native-pdf' / (name + '.pdf'), 'libreoffice/' + name + '.pdf'),
                         secondDocx=second,
                         secondPdf=copy(RESEARCH / 'native-pdf-second' / (name + '.pdf'), 'libreoffice-second/' + name + '.pdf'),
                         sourceInspection=oracle.inspect_docx(HERE / source['path']),
                         sourceExpected=expected, expected=expected,
                         roundtrip=name in ['no-section', 'a4-near', 'tall-landscape-flag', 'custom-odd']))
    for name, reason in negatives.items():
        source = copy(RESEARCH / 'input' / (name + '.docx'), 'source/' + name + '.docx')
        rows.append(dict(name=name, source=source['path'], sourceSha256=source['sha256'],
                         docx=source['path'], docxSha256=source['sha256'], expectUnsupported=True, reason=reason))
    presets = {}
    for key, name in [('a4', 'a4-portrait'), ('a5', 'a5'), ('letter', 'letter'), ('legal', 'legal')]:
        page = next(row['expected'] for row in rows if row['name'] == name)
        presets[key] = {key: page[key] for key in ['width', 'height']}
    manifest = dict(formatVersion=1, contractFrozen=True, nativeContract='LibreOfficeDev 26.8.0.0.alpha0 (2c87e51eeaa2b413ff4ae097b2705eea1995d8e5) single-section DOCX import and two native saves',
                    uiConvention='Page edits normalize standard paper sizes at Apply time for stable save/reopen; native property edits can retain custom dimensions until DOCX reopening.',
                    fixtures=rows, presets=presets)
    (HERE / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    provenance = [dict(path=str(p), sha256=sha(p)) for p in sorted(RESEARCH.iterdir()) if p.is_file() and p.suffix in ['.json', '.py', '.java', '.md']]
    (HERE / 'research-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print('Frozen', len(rows), 'complete independent fixture pairs/negatives')
