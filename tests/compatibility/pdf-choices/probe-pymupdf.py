#!/usr/bin/env python3
"""Bounded capability probe of the installed native library, not our engine."""
import json
from pathlib import Path
import sys
import pymupdf

report = {'version': pymupdf.VersionBind, 'cases': []}
for kind, name in [(3, 'ComboBox'), (4, 'ListBox')]:
    with pymupdf.open() as doc:
        page = doc.new_page()
        widget = pymupdf.Widget(); widget.field_name = 'Probe'; widget.field_type = kind
        widget.choice_values = [('first', 'First label'), ('second', 'Second label')]
        widget.field_value = 'first'; widget.text_fontsize = 12; widget.rect = pymupdf.Rect(30, 30, 230, 130)
        page.add_widget(widget); widget = next(page.widgets())
        doc.xref_set_key(widget.xref, 'I', '[1]')
        widget.field_value = 'second'; widget.update(); page = doc.reload_page(page); widget = next(page.widgets())
        appearance_xref = int(doc.xref_get_key(widget.xref, 'AP/N')[1].split()[0])
        report['cases'].append({'type': name, 'value': widget.field_value, 'index': doc.xref_get_key(widget.xref, 'I'), 'text': page.get_text(), 'appearance': doc.xref_stream(appearance_xref).decode()})
        widget.field_value = ['first', 'second']
        try:
            widget.update(); report['cases'].append({'type': name, 'multiSelect': 'accepted'})
        except Exception as error:
            report['cases'].append({'type': name, 'multiSelectError': type(error).__name__ + ': ' + str(error)})
        widget.field_value = ''
        widget.choice_values = [('first', 'First label'), ('', 'Empty export')]
        try:
            widget.update(); report['cases'].append({'type': name, 'emptyExport': 'accepted'})
        except Exception as error:
            report['cases'].append({'type': name, 'emptyExportError': type(error).__name__ + ': ' + str(error)})
path = Path(sys.argv[1])
path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({'version': report['version'], 'cases': len(report['cases']), 'path': str(path)}))
