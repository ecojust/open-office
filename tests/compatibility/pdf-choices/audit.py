#!/usr/bin/env python3
"""Independent pypdf audit of value, index, appearances and unrelated objects."""
import hashlib
import json
from pathlib import Path
import re
import sys
from pypdf import PdfReader

source, output, report_file = map(Path, sys.argv[1:4])
before, after = PdfReader(source), PdfReader(output)
checks = []
def ok(condition, name):
    assert condition, name
    checks.append(name)
def fields(reader):
    return {str(obj.get_object()['/T']): obj.get_object() for page in reader.pages for obj in page.get('/Annots', []) if obj.get_object().get('/Subtype') == '/Widget'}
def normal(widget): return widget['/AP']['/N'].get_data()
def stable(value):
    if hasattr(value, 'get_object'): value = value.get_object()
    if hasattr(value, 'get_data'): return {'stream': hashlib.sha256(value.get_data()).hexdigest()}
    if isinstance(value, dict): return {str(key): stable(child) for key, child in value.items()}
    if isinstance(value, list): return [stable(child) for child in value]
    return str(value)
a, b = fields(before), fields(after)
ok(list(a) == list(b), 'All original field names and order preserved')
for name, value, index in [('City', 'sh', 1), ('Department', 'night', 2), ('Plain choice', 'Afternoon', 1)]:
    ok(str(b[name]['/V']) == value, f'{name}: actual export value')
    ok(list(b[name]['/I']) == [index], f'{name}: selected index')
    ok('/AP' in b[name] and len(normal(b[name])) > 20, f'{name}: saved normal appearance stream')
    for key in ['/Opt', '/DV', '/DA', '/Ff', '/F', '/BS', '/MK', '/Rect', '/PrivateMetadata', '/T']:
        ok(stable(a[name].get(key)) == stable(b[name].get(key)), f'{name}: preserve {key}')
ok(normal(a['City']) != normal(b['City']), 'Combo selected label updates the saved appearance')
ok(b'(sh) Tj' not in normal(b['City']), 'Combo appearance does not draw the export code')
ok(b'Shanghai' in normal(b['City']) and b'4e0a6d77' in normal(b['City']), 'Combo appearance contains Latin and CJK display label')
ok(int(b['Department']['/TI']) == 2, 'List scroll position shows selected item')
ok(b'0.78 0.87 0.98 rg ' in normal(b['Department']), 'List selection includes vector highlight')
ok(b'Night team' in normal(b['Department']), 'Selected list label is drawn')
for name in ['Multiple choice', 'Locked choice']:
    ok(stable(a[name]['/V']) == stable(b[name]['/V']), f'{name}: original value preserved')
    ok(stable(a[name].get('/I')) == stable(b[name].get('/I')), f'{name}: original selected indices preserved')
    ok(normal(a[name]) == normal(b[name]), f'{name}: original appearance bytes preserved')
ok(before.pages[1].get_contents().get_data() == after.pages[1].get_contents().get_data(), 'Unrelated page content stream unchanged')
ok(len(before.pages) == len(after.pages) == 2, 'Page count unchanged')
for key in ['/Outlines']:
    ok(key in before.trailer['/Root'] and key in after.trailer['/Root'], 'Bookmarks retained')
for reader in [before, after]:
    annotations = [obj.get_object() for obj in reader.pages[0]['/Annots']]
    ok(any(str(obj.get('/Contents')) == 'Keep this note' for obj in annotations), 'Original note retained')
    ok(any(str(obj.get('/A', {}).get('/URI')) == 'https://example.com/choice' for obj in annotations), 'Original link retained')
report = {'ok': True, 'parser': 'pypdf', 'checks': checks, 'count': len(checks), 'files': [{'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()} for file in [source, output]]}
report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({'ok': True, 'checks': len(checks), 'report': str(report_file)}))
