#!/usr/bin/env python3
"""Independent raw section / PDF page-box oracle; no product code or defaults.

Declared dimensions and orientation are reported separately. This inspector
does not infer native behavior from contradictory orientation attributes or
fill absent page properties with application-specific defaults. Native control
expectations will be frozen only after source/native DOCX/PDF comparison.
"""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
q = lambda name: '{' + W + '}' + name


def attrs(element):
    return {key.split('}')[-1]: value for key, value in element.attrib.items()} if element is not None else None


def inspect_docx(filename):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                E.fromstring(archive.read(name))
        doc = E.fromstring(archive.read('word/document.xml'))
        body = doc.find('w:body', NS)
        assert body is not None
        sections = []
        for element in doc.iter(q('sectPr')):
            sizes, margins = element.findall('w:pgSz', NS), element.findall('w:pgMar', NS)
            assert len(sizes) <= 1 and len(margins) <= 1, 'Duplicate page properties'
            size, margin = attrs(sizes[0]) if sizes else None, attrs(margins[0]) if margins else None
            explicit = {}
            for name, field in [('w', 'width'), ('h', 'height')]:
                if size and name in size:
                    explicit[field] = int(size[name]) / 20
            for name in ['top', 'right', 'bottom', 'left']:
                if margin and name in margin:
                    explicit['margin' + name.title()] = int(margin[name]) / 20
            sections.append(dict(location='body' if element in list(body) else 'paragraph',
                                 size=size, margins=margin, explicitPoints=explicit,
                                 otherProperties=[n.tag.split('}')[-1] for n in element if n.tag not in [q('pgSz'), q('pgMar')]]))
        paragraphs = []
        for p in body.findall('w:p', NS):
            paragraphs.append(''.join(n.text or '' if n.tag == q('t') else '\t' if n.tag == q('tab')
                                      else '\n' if n.tag in (q('br'), q('cr')) else ''
                                      for r in p.findall('w:r', NS) for n in r))
        return dict(sections=sections, paragraphs=paragraphs, zipEntries=len(archive.namelist()))


def inspect_pdf(filename):
    import fitz
    with fitz.open(filename) as document:
        return [dict(index=page.number, mediaBox=list(page.mediabox), cropBox=list(page.cropbox),
                     rotation=page.rotation,
                     spans=[dict(text=span['text'], origin=span['origin'], bbox=span['bbox'])
                            for block in page.get_text('dict')['blocks']
                            for line in block.get('lines', []) for span in line['spans']])
                for page in document]


if __name__ == '__main__':
    result = inspect_pdf(sys.argv[2]) if sys.argv[1] == '--pdf' else inspect_docx(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
