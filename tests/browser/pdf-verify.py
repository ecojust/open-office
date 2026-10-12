"""Read exported browser-test files through the actual PDF parser, independently of UI metadata."""
import json
from pathlib import Path
import sys
import pymupdf

root = Path(sys.argv[1])
with pymupdf.open(root / 'edited.pdf') as doc, pymupdf.open(root / 'extracted.pdf') as extracted:
    page = doc[0]
    text = page.get_text()
    assert doc.page_count == 5
    assert 'REPLACED 中文' in text and 'ORIGINAL PAGE 1' not in text
    assert 'ADDED TEXT 新增' in text and 'KEEP THIS NEIGHBOR' in text
    annotations = [annotation.type[1] for annotation in page.annots() or []]
    assert 'Highlight' in annotations and 'Ink' in annotations
    assert len(page.get_images()) >= 1
    assert doc[1].rotation == 90
    assert any(drawing.get('fill') and drawing['fill'][0] < .95 for drawing in page.get_drawings())
    assert extracted.page_count == 2
    report = {'ok': True, 'engine': pymupdf.VersionBind, 'pages': doc.page_count, 'firstPageText': text,
              'annotations': annotations, 'images': len(page.get_images()), 'extractedPages': extracted.page_count,
              'coloredBackgroundPreserved': True}
(root / 'pdf-readback.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('Independent PDF readback PASSED')
