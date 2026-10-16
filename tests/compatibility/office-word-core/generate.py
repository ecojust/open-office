#!/usr/bin/env python3
"""Independent, deterministic OOXML specimens; no product exporter is imported."""
import hashlib
import json
from pathlib import Path
import struct
import zlib
import zipfile
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixels = b''.join(b'\x00' + bytes([220, 40, 50, 255, 25, 110, 220, 255]) for _ in range(2))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')

def run(text, props=''):
    return f'<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'

def para(text, props='', run_props=''):
    return f'<w:p><w:pPr>{props}</w:pPr>{run(text, run_props)}</w:p>'

def package(name, rich):
    image = png()
    parts = {}
    rels = [('styles', 'styles', 'styles.xml'), ('settings', 'settings', 'settings.xml')]
    types = [('/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'), ('/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'), ('/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml')]
    body = para('Seed')
    hf = ''
    if rich:
        # Frozen authored document text; retain it to reproduce the recorded source specimen.
        body = para('WordCraft independent 中文😀', '<w:jc w:val="center"/>', '<w:b/><w:sz w:val="36"/><w:color w:val="336699"/>')
        body += '<w:p>' + run('Normal ') + run('Bold中文😀', '<w:b/>') + run(' Italic', '<w:i/>') + run(' Underline', '<w:u w:val="single"/>') + run(' Strike', '<w:strike/>') + '</w:p>'
        body += para('Target format')
        body += '<w:p>' + run('Highlighted', '<w:highlight w:val="yellow"/>') + run(' x2', '<w:vertAlign w:val="superscript"/>') + run(' H2O', '<w:vertAlign w:val="subscript"/>') + '</w:p>'
        body += para('Paragraph spacing', '<w:spacing w:before="120" w:after="160" w:line="360" w:lineRule="auto"/><w:ind w:left="360" w:right="180" w:firstLine="120"/>')
        body += para('List first', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
        body += para('List second', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
        body += '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>'
        for row in [('Cell A1', 'Cell B1'), ('Cell A2', 'Cell B2')]:
            body += '<w:tr>' + ''.join(f'<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>{para(t)}</w:tc>' for t in row) + '</w:tr>'
        body += '</w:tbl>'
        body += '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="independent-image" descr="Red blue independent PNG"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="colors.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="picture"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
        parts['word/media/colors.png'] = image
        parts['word/header1.xml'] = f'<w:hdr xmlns:w="{W}">{para("Independent header 中文")}</w:hdr>'
        parts['word/footer1.xml'] = f'<w:ftr xmlns:w="{W}"><w:p>{run("Independent footer ")}<w:fldSimple w:instr=" PAGE ">{run("1")}</w:fldSimple></w:p></w:ftr>'
        parts['word/numbering.xml'] = f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>'
        rels += [('picture', 'image', 'media/colors.png'), ('header', 'header', 'header1.xml'), ('footer', 'footer', 'footer1.xml'), ('numbering', 'numbering', 'numbering.xml')]
        types += [(f'/word/{kind}1.xml', f'application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml') for kind in ['header', 'footer']]
        types += [('/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml')]
        hf = '<w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/>'
    parts['word/document.xml'] = f'<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}<w:sectPr>{hf}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'
    parts['word/styles.xml'] = f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="DejaVu Sans" w:hAnsi="DejaVu Sans" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="24"/><w:color w:val="20242B"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'
    parts['word/settings.xml'] = f'<w:settings xmlns:w="{W}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>'
    parts['word/_rels/document.xml.rels'] = f'<Relationships xmlns="{PKG}">' + ''.join(f'<Relationship Id="{id}" Type="{R}/{kind}" Target="{target}"/>' for id, kind, target in rels) + '</Relationships>'
    parts['_rels/.rels'] = f'<Relationships xmlns="{PKG}"><Relationship Id="document" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>'
    parts['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' + ''.join(f'<Override PartName="{p}" ContentType="{t}"/>' for p, t in types) + '</Types>'
    with zipfile.ZipFile(ROOT / name, 'w', zipfile.ZIP_DEFLATED) as z:
        for path, contents in sorted(parts.items()):
            info = zipfile.ZipInfo(path, (2026, 10, 15, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, contents)
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()

if __name__ == '__main__':
    fixtures = [{'name': 'independent-rich', 'source': 'independent-rich.docx', 'sourceSha256': package('independent-rich.docx', True)}, {'name': 'independent-seed', 'source': 'independent-seed.docx', 'sourceSha256': package('independent-seed.docx', False)}]
    (ROOT / 'colors.png').write_bytes(png())
    (ROOT / 'manifest.json').write_text(json.dumps({'version': 1, 'provenance': 'Independent literal OOXML and standard-library PNG generator; no product import/export used.', 'fixtures': fixtures, 'image': {'path': 'colors.png', 'sha256': hashlib.sha256(png()).hexdigest()}}, ensure_ascii=False, indent=2) + '\n')
