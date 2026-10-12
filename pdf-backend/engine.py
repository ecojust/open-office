"""Local PDF editor: one bounded JSON request on stdin, one JSON response.

There are deliberately no filesystem paths, URLs, eval, or network operations in
the document protocol. Every operation edits an in-memory copy of supplied bytes.
PDF coordinates are points in the unrotated page, with its top-left at (0, 0).
"""
from __future__ import annotations

import base64
import binascii
import json
import math
import struct
import sys

import pymupdf

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 100 * 1024 * 1024
MAX_PDF_BYTES = 40 * 1024 * 1024
# Every successful output must remain a valid input for the next edit/reopen.
MAX_OUTPUT_BYTES = MAX_PDF_BYTES
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PAGES = 500
MAX_MERGE_DOCUMENTS = 20
MAX_TEXT_LENGTH = 20_000
MAX_TEXT_BLOCKS = 6_000
OPERATIONS = {
    'inspect', 'new', 'replace_text', 'add_text', 'add_image', 'highlight',
    'ink', 'rotate', 'delete', 'reorder', 'extract', 'merge',
}


class PdfError(Exception):
    def __init__(self, code, message, details=None, metadata=None):
        super().__init__(message)
        self.code, self.message = code, message
        self.details, self.metadata = details, metadata


def fail(code, message, details=None, metadata=None):
    raise PdfError(code, message, details, metadata)


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        fail('INVALID_OPTIONS', f'{name} 必须在 {low} 至 {high} 之间。')
    return float(value)


def integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        fail('INVALID_OPTIONS', f'{name} 必须是 {low} 至 {high} 之间的整数。')
    return value


def decode_base64(value, name, limit):
    if not isinstance(value, str) or not value or len(value) > 4 * ((limit + 2) // 3):
        fail('INPUT_LIMIT', f'{name} 为空或超过大小限制。')
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        fail('INVALID_BASE64', f'{name} 不是有效的 Base64。')
    if not data or len(data) > limit:
        fail('INPUT_LIMIT', f'{name} 超过大小限制。')
    return data


def page_index(options, count):
    return integer(options.get('pageIndex'), 'pageIndex', 0, count - 1)


def indices(value, count, name='pageIndices', allow_empty=False):
    if not isinstance(value, list) or len(value) > count or (not value and not allow_empty):
        fail('INVALID_OPTIONS', f'{name} 需要提供有效的页码数组。')
    result = [integer(v, name, 0, count - 1) for v in value]
    if len(set(result)) != len(result):
        fail('INVALID_OPTIONS', f'{name} 不能包含重复页码。')
    return result


def bounds(page):
    # page.rect follows /Rotate, while text and editing coordinates do not.
    rect = page.rect * page.derotation_matrix
    return pymupdf.Rect(0, 0, rect.width, rect.height)


def rectangle(value, page):
    if not isinstance(value, list) or len(value) != 4:
        fail('INVALID_OPTIONS', 'rect 需要四个坐标 [x0,y0,x1,y1]。')
    values = [number(v, '坐标', -1_000_000, 1_000_000) for v in value]
    rect = pymupdf.Rect(values)
    if rect.is_empty or not rect.is_valid or rect.width < 0.1 or rect.height < 0.1:
        fail('INVALID_OPTIONS', '选区的宽和高必须大于零。')
    box = bounds(page)
    tolerance = 0.01
    if rect.x0 < -tolerance or rect.y0 < -tolerance or rect.x1 > box.width + tolerance or rect.y1 > box.height + tolerance:
        fail('INVALID_OPTIONS', '选区必须位于页面内。')
    return rect


def color(value, default=(0, 0, 0)):
    if value is None:
        return tuple(default)
    if not isinstance(value, list) or len(value) != 3:
        fail('INVALID_OPTIONS', '颜色需要三个 0 至 1 之间的 RGB 分量。')
    return tuple(number(v, '颜色', 0, 1) for v in value)


def locked_metadata():
    return {'pageCount': None, 'encrypted': True, 'needsPassword': True,
            'signed': False, 'signatureFields': 0, 'authenticatedAs': 'none',
            'permissions': {k: False for k in ('edit', 'modify', 'annotate', 'assemble', 'copy', 'print')}, 'pages': []}


def open_document(value, password=None):
    data = decode_base64(value, 'PDF 文件', MAX_PDF_BYTES)
    if b'%PDF-' not in data[:1024]:
        fail('INVALID_PDF', '此文件不是 PDF。')
    if password is not None and (not isinstance(password, str) or len(password) > 256):
        fail('INVALID_OPTIONS', 'PDF 密码格式无效。')
    try:
        doc = pymupdf.open(stream=data, filetype='pdf')
    except Exception:
        fail('INVALID_PDF', '无法读取此 PDF，文件可能损坏。')
    try:
        encrypted = bool(doc.needs_pass or doc.is_encrypted)
        authentication = doc.authenticate(password or '')
        if doc.is_encrypted:
            code = 'PASSWORD_REQUIRED' if not password else 'INVALID_PASSWORD'
            message = '请输入 PDF 打开密码。' if not password else 'PDF 密码不正确。'
            fail(code, message, metadata=locked_metadata())
        encryption_description = (doc.metadata or {}).get('encryption')
        encrypted = encrypted or bool(encryption_description)
        if doc.page_count < 1 or doc.page_count > MAX_PAGES:
            fail('PAGE_LIMIT', f'PDF 需要有 1 至 {MAX_PAGES} 页。')
        if doc.is_repaired:
            fail('REPAIRED_PDF', '此 PDF 需要结构修复，请先用可信 PDF 工具修复副本后再编辑。')
        auth = 'owner' if authentication & 4 else ('user' if encrypted and authentication & 2 else 'none')
        unrestricted = auth == 'owner' or not encrypted
        perms = doc.permissions
        permission = {
            'modify': unrestricted or bool(perms & pymupdf.PDF_PERM_MODIFY),
            'annotate': unrestricted or bool(perms & pymupdf.PDF_PERM_ANNOTATE),
            'assemble': unrestricted or bool(perms & (pymupdf.PDF_PERM_MODIFY | pymupdf.PDF_PERM_ASSEMBLE)),
            'copy': unrestricted or bool(perms & pymupdf.PDF_PERM_COPY),
            'print': unrestricted or bool(perms & pymupdf.PDF_PERM_PRINT),
        }
        permission['edit'] = permission['modify']
        return doc, {'encrypted': encrypted, 'authenticatedAs': auth, 'permissions': permission}
    except Exception:
        doc.close()
        raise


def signatures(doc):
    count, signed = 0, doc.get_sigflags() == 3
    for page in doc:
        for widget in page.widgets() or []:
            if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
                count += 1
                kind, value = doc.xref_get_key(widget.xref, 'V')
                if kind not in ('null', 'none') and value not in ('null', ''):
                    signed = True
    # Certification signatures can also be referenced from the catalog.
    kind, value = doc.xref_get_key(doc.pdf_catalog(), 'Perms/DocMDP')
    signed = signed or (kind == 'xref' and value != 'null')
    return count, bool(signed)


def metadata(doc, context):
    fields, signed = signatures(doc)
    pages = []
    for index, page in enumerate(doc):
        box = bounds(page)
        pages.append({'index': index, 'width': box.width, 'height': box.height,
                      'rotation': page.rotation, 'mediaBox': list(page.mediabox), 'cropBox': list(page.cropbox)})
    return {'pageCount': doc.page_count, 'encrypted': context['encrypted'], 'needsPassword': False,
            'signed': signed, 'signatureFields': fields, 'authenticatedAs': context['authenticatedAs'],
            'permissions': context['permissions'], 'pages': pages}


def text_blocks(doc, options, permitted=True):
    if options.get('includeText') is False or not permitted:
        return []
    selected = options.get('pageIndices')
    selected = indices(selected, doc.page_count, allow_empty=True) if selected is not None else list(range(min(20, doc.page_count)))
    if len(selected) > 50:
        fail('INPUT_LIMIT', '每次最多提取 50 页文字。')
    output, total_text = [], 0
    for page_index_ in selected:
        page = doc[page_index_]
        text = page.get_text('dict', flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
        for bi, block in enumerate(text.get('blocks', [])):
            for li, line in enumerate(block.get('lines', [])):
                for si, span in enumerate(line.get('spans', [])):
                    value = span.get('text', '')
                    if not value:
                        continue
                    total_text += len(value)
                    if len(output) >= MAX_TEXT_BLOCKS or total_text > 250_000:
                        return output
                    rgb = span.get('color', 0)
                    output.append({'id': f'{page_index_}:{bi}:{li}:{si}', 'pageIndex': page_index_,
                                   'text': value, 'bbox': list(span['bbox']), 'origin': list(span['origin']),
                                   'direction': list(line.get('dir', (1, 0))), 'font': span['font'], 'fontSize': span['size'],
                                   'color': [(rgb >> 16 & 255) / 255, (rgb >> 8 & 255) / 255, (rgb & 255) / 255]})
    return output


def authorize(doc, context, operation, options):
    permission = ('annotate' if operation in ('highlight', 'ink') else
                  'assemble' if operation in ('rotate', 'delete', 'reorder', 'merge') else
                  'copy' if operation == 'extract' else 'modify')
    if not context['permissions'][permission]:
        fail('PERMISSION_DENIED', '此 PDF 未允许这项修改，请提供文档所有者密码。')
    _, signed = signatures(doc)
    if signed and options.get('allowSignedCopy') is not True:
        fail('SIGNED_DOCUMENT', '此 PDF 含数字签名。编辑会改变签名有效性，请明确选择编辑副本。')
    return ['原 PDF 含数字签名：编辑副本不再具有原签名的完整性保证，请另存并保留原件。'] if signed else []


def cjk_font(page):
    existing = {item[4] for item in page.get_fonts()}
    suffix = page.parent.xref_length()
    name = f'OpenOfficeCJK{suffix}'
    while name in existing:
        suffix += 1
        name = f'OpenOfficeCJK{suffix}'
    # MuPDF's bundled Unicode CJK font; no system font or network is consulted.
    font = pymupdf.Font('cjk')
    page.insert_font(fontname=name, fontbuffer=font.buffer)
    return name


def write_text(page, options, replace=False):
    rect = rectangle(options.get('rect'), page)
    source_rect = rectangle(options.get('sourceRect', options.get('rect')), page) if replace else rect
    text = options.get('text')
    if not isinstance(text, str) or not text or len(text) > MAX_TEXT_LENGTH or '\x00' in text:
        fail('INVALID_OPTIONS', f'请输入 1 至 {MAX_TEXT_LENGTH} 个字符。')
    size = number(options.get('fontSize', 12), 'fontSize', 4, 144)
    align = integer(options.get('align', 0), 'align', 0, 3)
    rgb = color(options.get('color'))
    if replace:
        # Only selected text is removed. White painting would damage colored
        # backgrounds and would leave original text recoverable.
        overlapping = [block for block in text_blocks(page.parent, {'pageIndices': [page.number]})
                       if pymupdf.Rect(block['bbox']).intersects(source_rect)]
        if not overlapping:
            fail('NO_TEXT', '选区内没有可编辑的 PDF 文字；扫描图片不属于原文文字。')
        page.add_redact_annot(source_rect, fill=False, cross_out=False)
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                              text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    name = cjk_font(page)
    available = page.insert_textbox(rect, text, fontname=name, fontsize=size, color=rgb, align=align)
    if available < -0.01:
        fail('TEXT_OVERFLOW', '文字无法完整放入选区，请扩大文字区域或减小字号。原 PDF 未修改。',
             {'missingHeight': round(-available, 3)})


def image_dimensions(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24 and data[12:16] == b'IHDR':
        return struct.unpack('>II', data[16:24])
    if data.startswith(b'\xff\xd8'):
        position = 2
        while position + 4 <= len(data):
            if data[position] != 0xFF:
                break
            while position < len(data) and data[position] == 0xFF:
                position += 1
            if position >= len(data):
                break
            marker = data[position]
            position += 1
            if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
                continue
            if position + 2 > len(data):
                break
            length = int.from_bytes(data[position:position + 2], 'big')
            if length < 2 or position + length > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and length >= 8:
                height, width = struct.unpack('>HH', data[position + 3:position + 7])
                return width, height
            position += length
    fail('INVALID_IMAGE', '仅支持有效的 PNG 或 JPEG 图片。')


def add_image(page, options):
    rect = rectangle(options.get('rect'), page)
    image = decode_base64(options.get('imageBase64'), '图片', MAX_IMAGE_BYTES)
    width, height = image_dimensions(image)
    if width < 1 or height < 1 or width > 16_000 or height > 16_000 or width * height > 24_000_000:
        fail('IMAGE_LIMIT', '图片不得超过 2400 万像素，宽高不得超过 16000 像素。')
    try:
        page.insert_image(rect, stream=image, keep_proportion=True)
    except Exception:
        fail('INVALID_IMAGE', '图片无法解码。')


def add_highlight(page, options):
    values = options.get('rects')
    if not isinstance(values, list) or not values or len(values) > 200:
        fail('INVALID_OPTIONS', '高亮需要 1 至 200 个文字区域。')
    rects = [rectangle(value, page) for value in values]
    annot = page.add_highlight_annot(rects)
    annot.set_colors(stroke=color(options.get('color'), (1, 0.82, 0.15)))
    annot.set_opacity(number(options.get('opacity', 0.45), 'opacity', 0.05, 1))
    annot.update()


def add_ink(page, options):
    paths = options.get('paths')
    if not isinstance(paths, list) or not paths or len(paths) > 100:
        fail('INVALID_OPTIONS', '手写笔迹需要 1 至 100 条路径。')
    box, checked, count = bounds(page), [], 0
    for path in paths:
        if not isinstance(path, list) or len(path) < 2:
            fail('INVALID_OPTIONS', '每条笔迹至少包含两个点。')
        count += len(path)
        if count > 20_000:
            fail('INPUT_LIMIT', '笔迹坐标过多。')
        points = []
        for point in path:
            if not isinstance(point, list) or len(point) != 2:
                fail('INVALID_OPTIONS', '笔迹坐标格式错误。')
            points.append((number(point[0], 'x', 0, box.width), number(point[1], 'y', 0, box.height)))
        checked.append(points)
    annot = page.add_ink_annot(checked)
    annot.set_colors(stroke=color(options.get('color')))
    annot.set_border(width=number(options.get('width', 2), 'width', 0.2, 30))
    annot.update()


def output_document(doc, context, options, warnings):
    doc.subset_fonts()
    data = doc.tobytes(garbage=4, deflate=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    if len(data) > MAX_OUTPUT_BYTES:
        fail('OUTPUT_LIMIT', '编辑结果超过可重新打开的文件大小限制，请分批处理页面或减小图片。',
             {'maximumBytes': MAX_OUTPUT_BYTES})
    return {'base64': base64.b64encode(data).decode('ascii'), 'metadata': metadata(doc, context),
            'textBlocks': text_blocks(doc, {}, context['permissions']['copy']), 'warnings': warnings}


def new_context():
    return {'encrypted': False, 'authenticatedAs': 'none',
            'permissions': {k: True for k in ('edit', 'modify', 'annotate', 'assemble', 'copy', 'print')}}


def process(request):
    request_id = request.get('requestId', '') if isinstance(request, dict) else ''
    if not isinstance(request_id, str) or len(request_id) > 128:
        request_id = ''
    response = {'protocolVersion': PROTOCOL_VERSION, 'requestId': request_id, 'ok': False, 'warnings': []}
    doc = None
    try:
        if not isinstance(request, dict) or request.get('protocolVersion') != PROTOCOL_VERSION:
            fail('PROTOCOL_ERROR', '不支持的 PDF 请求协议。')
        operation = request.get('operation')
        options = request.get('options', {})
        if operation not in OPERATIONS or not isinstance(options, dict):
            fail('INVALID_OPERATION', '未知的 PDF 操作或选项。')
        if operation == 'new':
            doc = pymupdf.open()
            for _ in range(integer(options.get('pageCount', 1), 'pageCount', 1, 100)):
                doc.new_page(width=number(options.get('width', 595), 'width', 72, 4000),
                             height=number(options.get('height', 842), 'height', 72, 4000))
            context, warnings = new_context(), []
        elif operation == 'merge':
            documents = options.get('documents')
            if not isinstance(documents, list) or not 2 <= len(documents) <= MAX_MERGE_DOCUMENTS:
                fail('INVALID_OPTIONS', '合并需要 2 至 20 个 PDF。')
            doc, context, warnings, total_input = pymupdf.open(), new_context(), [], 0
            for item in documents:
                if not isinstance(item, dict):
                    fail('INVALID_OPTIONS', '合并文件格式错误。')
                total_input += len(item.get('base64', '')) if isinstance(item.get('base64'), str) else MAX_REQUEST_BYTES
                if total_input > 80 * 1024 * 1024:
                    fail('INPUT_LIMIT', '合并文件总量过大，请分批处理。')
                other, other_context = open_document(item.get('base64'), item.get('password'))
                try:
                    warnings.extend(authorize(other, other_context, operation, options))
                    if not other_context['permissions']['copy']:
                        fail('PERMISSION_DENIED', '此 PDF 不允许复制内容，无法合并。')
                    if doc.page_count + other.page_count > MAX_PAGES:
                        fail('PAGE_LIMIT', '合并后不能超过 500 页。')
                    if other_context['encrypted']:
                        if options.get('allowUnencryptedCopy') is not True:
                            fail('ENCRYPTED_MERGE', '合并会生成新的未加密文件，请明确允许导出未加密副本。')
                        warnings.append('合并输出为新建未加密 PDF，原加密文件保持不变。')
                    doc.insert_pdf(other)
                finally:
                    other.close()
        else:
            doc, context = open_document(request.get('documentBase64'), request.get('password'))
            if operation == 'inspect':
                return {**response, 'ok': True, 'metadata': metadata(doc, context),
                        'textBlocks': text_blocks(doc, options, context['permissions']['copy'])}
            warnings = authorize(doc, context, operation, options)
            if operation in ('replace_text', 'add_text', 'add_image', 'highlight', 'ink'):
                page = doc[page_index(options, doc.page_count)]
                if operation in ('replace_text', 'add_text'):
                    write_text(page, options, operation == 'replace_text')
                elif operation == 'add_image':
                    add_image(page, options)
                elif operation == 'highlight':
                    add_highlight(page, options)
                else:
                    add_ink(page, options)
            elif operation == 'rotate':
                pages = indices(options.get('pageIndices'), doc.page_count)
                degrees = options.get('degrees')
                if degrees not in (-270, -180, -90, 90, 180, 270):
                    fail('INVALID_OPTIONS', '旋转角度必须是 90、180 或 270 度。')
                for index in pages:
                    doc[index].set_rotation((doc[index].rotation + degrees) % 360)
            elif operation in ('delete', 'extract'):
                pages = indices(options.get('pageIndices'), doc.page_count)
                if operation == 'delete':
                    pages = [index for index in range(doc.page_count) if index not in pages]
                    if not pages:
                        fail('EMPTY_PDF', '至少保留一页，不能删除全部页面。')
                doc.select(pages)
            elif operation == 'reorder':
                order = indices(options.get('order'), doc.page_count, 'order')
                if len(order) != doc.page_count:
                    fail('INVALID_OPTIONS', '重排需要完整的页码排列，提取部分页面请使用提取功能。')
                doc.select(order)
        result = output_document(doc, context, options, list(dict.fromkeys(warnings)))
        return {**response, 'ok': True, **result}
    except PdfError as error:
        response['error'] = {'code': error.code, 'message': error.message}
        if error.details is not None:
            response['error']['details'] = error.details
        if error.metadata is not None:
            response['metadata'] = error.metadata
        return response
    except Exception:
        # Parser internals must not expose document content, passwords or paths.
        response['error'] = {'code': 'PDF_OPERATION_FAILED', 'message': '此 PDF 的结构不支持当前操作。原文件未修改。'}
        return response
    finally:
        if doc is not None:
            doc.close()


def engine_info():
    return {'engine': 'pymupdf', 'version': pymupdf.VersionBind, 'mupdfVersion': pymupdf.VersionFitz, 'protocolVersion': PROTOCOL_VERSION,
            'local': True, 'operations': sorted(OPERATIONS), 'maxPdfBytes': MAX_PDF_BYTES, 'maxPages': MAX_PAGES}


def self_test():
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    name = cjk_font(page)
    page.insert_text((30, 50), '原文 OLD', fontname=name, fontsize=12)
    page.insert_text((30, 130), '保留 KEEP', fontname=name, fontsize=12)
    source = base64.b64encode(doc.tobytes(garbage=4, deflate=True)).decode('ascii')
    doc.close()
    result = process({'protocolVersion': 1, 'requestId': 'self-test', 'operation': 'replace_text',
                      'documentBase64': source, 'options': {'pageIndex': 0, 'rect': [20, 25, 240, 85], 'text': '新文 NEW', 'fontSize': 12}})
    if not result['ok']:
        raise RuntimeError('Local PDF editing self-test failed')
    check = pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf')
    value = check[0].get_text()
    check.close()
    if '原文' in value or 'OLD' in value or '新文 NEW' not in value or '保留 KEEP' not in value:
        raise RuntimeError('Local PDF editing round-trip self-test failed')
    return {**engine_info(), 'selfTest': True, 'status': 'PASSED', 'chineseReplacementVerified': True}


def main():
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    if '--info' in sys.argv[1:]:
        response = engine_info()
    elif '--self-test' in sys.argv[1:]:
        response = self_test()
    else:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        try:
            if len(raw) > MAX_REQUEST_BYTES:
                fail('INPUT_LIMIT', 'PDF 请求超过 100 MiB 限制。')
            request = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non-finite number')))
            response = process(request)
        except (PdfError, ValueError, UnicodeDecodeError, RecursionError):
            response = {'protocolVersion': 1, 'requestId': '', 'ok': False, 'warnings': [],
                        'error': {'code': 'INVALID_REQUEST', 'message': 'PDF 请求无效或超过限制。'}}
    sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
