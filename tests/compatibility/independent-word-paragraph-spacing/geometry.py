#!/usr/bin/env python3
"""Read native PDF glyph origins independently using PyMuPDF."""
import json
import sys
import fitz

with fitz.open(sys.argv[1]) as document:
    spans = [dict(page=page.number, text=s['text'], origin=s['origin'], size=s['size'], font=s['font'])
             for page in document for block in page.get_text('dict')['blocks']
             for line in block.get('lines', []) for s in line['spans']]
print(json.dumps(spans, ensure_ascii=False))
