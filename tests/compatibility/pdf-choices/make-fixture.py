#!/usr/bin/env python3
"""Original test form and actual local-engine output; no imported application assets."""
import base64
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'pdf-backend/tests'))
from test_choices import fixture, empty_fixture, fields, fill

out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'test-results/pdf-choices/backend'
out.mkdir(parents=True, exist_ok=True)
source = fixture()
(out / 'choice-source.pdf').write_bytes(base64.b64decode(source))
(out / 'choice-empty-source.pdf').write_bytes(base64.b64decode(empty_fixture()))
steps = []
for name, value in [('City', 'sh'), ('Department', 'night'), ('Plain choice', 'Afternoon')]:
    item = next(item for item in fields(source) if item['name'] == name)
    result = fill(source, item, value)
    assert result['ok'], result
    source = result['base64']
    steps.append({'field': name, 'value': value, 'readback': next(item for item in fields(source) if item['name'] == name)})
(out / 'choice-filled.pdf').write_bytes(base64.b64decode(source))
report = {'engine': 'PyMuPDF', 'steps': steps, 'files': [{ 'name': file.name, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes': file.stat().st_size } for file in out.glob('*.pdf')]}
(out / 'generation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({'steps': len(steps), 'output': str(out)}, ensure_ascii=False))
