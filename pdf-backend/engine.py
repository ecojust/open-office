"""Local PDF editor: one bounded JSON request on stdin, one JSON response.

There are deliberately no filesystem paths, URLs, eval, or network operations in
the document protocol. Every operation edits an in-memory copy of supplied bytes.
PDF coordinates are points in the unrotated page, with its top-left at (0, 0).
"""
from __future__ import annotations

import base64
import binascii
import json
import hashlib
import math
import re
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
MAX_ANNOTATION_RELATIONS = 5000
MAX_FORM_FIELDS = 2000
OPERATIONS = {
    'inspect', 'new', 'replace_text', 'add_text', 'add_image', 'highlight',
    'ink', 'rotate', 'delete', 'reorder', 'extract', 'merge',
    'page_numbers', 'watermark', 'add_note', 'update_annotation', 'delete_annotation', 'fill_field',
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
            'permissions': {k: False for k in ('edit', 'modify', 'annotate', 'assemble', 'copy', 'print', 'fillForms')}, 'pages': []}


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
            'fillForms': unrestricted or bool(perms & pymupdf.PDF_PERM_FORM),
        }
        permission['edit'] = permission['modify']
        return doc, {'encrypted': encrypted, 'authenticatedAs': auth, 'permissions': permission,
                     'sourceHash': hashlib.sha256(data).hexdigest()}
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
    # Read only local page destinations. URI / remote-file actions are never executed.
    outline = []
    for level, title, destination, action in doc.get_toc(simple=False)[:2000]:
        outline.append({'level': min(max(int(level), 1), 20), 'title': str(title)[:500],
                        'pageIndex': destination - 1 if action.get('kind') == pymupdf.LINK_GOTO and 1 <= destination <= doc.page_count else None})
    return {'pageCount': doc.page_count, 'encrypted': context['encrypted'], 'needsPassword': False,
            'signed': signed, 'signatureFields': fields, 'authenticatedAs': context['authenticatedAs'],
            'permissions': context['permissions'], 'pages': pages, 'outline': outline}


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
    permission = ('fillForms' if operation == 'fill_field' else
                  'annotate' if operation in ('highlight', 'ink', 'add_note', 'update_annotation', 'delete_annotation') else
                  'assemble' if operation in ('rotate', 'delete', 'reorder', 'merge') else
                  'copy' if operation == 'extract' else 'modify')
    if not context['permissions'][permission]:
        fail('PERMISSION_DENIED', '此 PDF 未允许这项修改，请提供文档所有者密码。')
    _, signed = signatures(doc)
    if signed and options.get('allowSignedCopy') is not True:
        fail('SIGNED_DOCUMENT', '此 PDF 含数字签名。编辑会改变签名有效性，请明确选择编辑副本。')
    return ['原 PDF 含数字签名：编辑副本不再具有原签名的完整性保证，请另存并保留原件。'] if signed else []


def annotation_token(doc, annotation):
    # xrefs can change after garbage collection. A stale UI must never modify a
    # different annotation just because it inherited the old xref number.
    return hashlib.sha256(doc.xref_object(annotation.xref).encode('utf-8')).hexdigest()


def annotation_relations(doc):
    related = set()
    count = 0
    for page in doc:
        for annotation in page.annots() or []:
            count += 1
            if count > MAX_ANNOTATION_RELATIONS:
                return None
            kind, target = doc.xref_get_key(annotation.xref, 'IRT')
            if kind == 'xref':
                related.update((annotation.xref, int(target.split()[0])))
    return related


def annotation_readonly_reason(doc, annotation, related):
    if related is None:
        return '文档批注数量超过安全编辑上限。'
    if annotation.flags & (64 | 128 | 512):
        return '此批注被文档标记为只读或锁定。'
    if annotation.xref in related:
        return '带回复或关联关系的批注暂时只读，保留完整讨论记录。'
    if annotation.type[0] not in (pymupdf.PDF_ANNOT_TEXT, pymupdf.PDF_ANNOT_HIGHLIGHT, pymupdf.PDF_ANNOT_INK):
        return '此批注类型暂时只读。'
    if doc.xref_get_key(annotation.xref, 'RC')[0] not in ('null', 'none'):
        return '此批注包含富文本备注，暂时保留原格式。'
    info = annotation.info
    if len(info.get('content', '')) > MAX_TEXT_LENGTH or len(info.get('title', '')) > 200:
        return '此批注文字超过安全编辑上限。'
    return ''


def read_annotations(doc, options, context):
    if options.get('includeAnnotations') is False:
        return {}
    if not (context['permissions']['copy'] or context['permissions']['annotate']):
        return {'annotations': [], 'annotationPages': [], 'annotationsTruncated': False}
    selected = options.get('pageIndices', [0])
    selected = indices(selected, doc.page_count, allow_empty=True)
    if len(selected) > 50:
        fail('INPUT_LIMIT', '每次最多读取 50 页批注。')
    related = annotation_relations(doc)
    output, text_size = [], 0
    for index in selected:
        page = doc[index]
        for annotation in page.annots() or []:
            info = annotation.info
            content, title = info.get('content', ''), info.get('title', '')
            text_size += min(len(content), MAX_TEXT_LENGTH) + min(len(title), 200)
            if len(output) >= 1000 or text_size > 250_000:
                return {'annotations': output, 'annotationPages': selected, 'annotationsTruncated': True}
            output.append({'id': annotation.xref, 'pageIndex': index,
                           'type': annotation.type[1], 'rect': list(annotation.rect),
                           'content': content[:MAX_TEXT_LENGTH], 'author': title[:200],
                           'token': annotation_token(doc, annotation),
                           'readonlyReason': annotation_readonly_reason(doc, annotation, related)})
    return {'annotations': output, 'annotationPages': selected, 'annotationsTruncated': False}


def annotation_text(value, name, maximum, allow_empty=True):
    if not isinstance(value, str) or len(value) > maximum or '\x00' in value or (not allow_empty and not value.strip()):
        fail('INVALID_OPTIONS', f'{name} 需要有效文字，最多 {maximum} 字。')
    return value


def edit_annotation(doc, options, operation):
    page = doc[page_index(options, doc.page_count)]
    if operation == 'add_note':
        point = options.get('point')
        if not isinstance(point, list) or len(point) != 2:
            fail('INVALID_OPTIONS', '便签需要页面上的放置坐标。')
        box = bounds(page)
        x, y = [number(value, '便签坐标', 0, 1_000_000) for value in point]
        if x + 20 > box.width or y + 20 > box.height:
            fail('INVALID_OPTIONS', '便签图标需要完整放在页面内。')
        content = annotation_text(options.get('content'), '批注内容', MAX_TEXT_LENGTH, False)
        author = annotation_text(options.get('author', ''), '作者', 200)
        # Text icons carry NoRotate. MuPDF offsets their reported unrotated
        # bounds by the 16 pt icon size on rotated pages; compensate so the UI's
        # top-left placement and the saved visible icon agree.
        dx, dy = {0: (0, 0), 90: (0, 16), 180: (16, 16), 270: (16, 0)}[page.rotation]
        annotation = page.add_text_annot((x + dx, y + dy), content, icon='Note')
        annotation.set_info(title=author)
        return
    xref = integer(options.get('annotationId'), 'annotationId', 1, doc.xref_length() - 1)
    annotation = next((item for item in page.annots() or [] if item.xref == xref), None)
    if annotation is None or options.get('expectedToken') != annotation_token(doc, annotation):
        fail('STALE_ANNOTATION', '批注已改变或不在此页，请重新选择后再编辑。')
    reason = annotation_readonly_reason(doc, annotation, annotation_relations(doc))
    if reason:
        fail('READONLY_ANNOTATION', reason)
    if operation == 'delete_annotation':
        page.delete_annot(annotation)
    else:
        content = annotation_text(options.get('content'), '批注内容', MAX_TEXT_LENGTH)
        author = annotation_text(options.get('author', ''), '作者', 200)
        # Contents and T are metadata. Do not regenerate AP or touch geometry,
        # color, opacity, ink points, quad points, dates or existing actions.
        annotation.set_info(content=content, title=author)


def has_pdf_key(doc, xref, key):
    return doc.xref_get_key(xref, key)[0] not in ('null', 'none')


def pdf_name(value):
    # Names, unlike PDF strings, must escape delimiter and non-ASCII bytes.
    return '/' + ''.join(chr(byte) if 33 <= byte <= 126 and chr(byte) not in '#/%()<>[]{}' else f'#{byte:02X}'
                         for byte in value.encode('utf-8'))


def checkbox_states(widget):
    # MuPDF button_states/on_state expose escaped PDF names, but field_value and
    # xref_get_key return decoded names. Normalize once before comparing/writing.
    try:
        return [re.sub(rb'#([0-9a-fA-F]{2})', lambda match: bytes([int(match[1], 16)]), state.encode('utf-8')).decode('utf-8')
                for state in (widget.button_states() or {}).get('normal') or []]
    except (ValueError, UnicodeError):
        return []


def checkbox_on_state(widget):
    return next((state for state in checkbox_states(widget) if state != 'Off'), None)


def form_inventory(doc):
    """Bounded whole-file checks: a field elsewhere can share a name/action.

    Do not call a JavaScript engine, execute actions, or repair a field tree.
    Unsupported structures stay in the original PDF and are explicitly read-only.
    """
    catalog = doc.pdf_catalog()
    reason = ''
    if has_pdf_key(doc, catalog, 'AcroForm/XFA'):
        reason = '此文档含 XFA 表单，暂时只读。'
    elif any(has_pdf_key(doc, catalog, key) for key in ('AA', 'OpenAction', 'Names/JavaScript', 'AcroForm/AA')) or doc.xref_get_key(catalog, 'AcroForm/CO') not in (('null', 'null'), ('array', '[]')):
        reason = '此文档含动作、脚本或计算链，表单暂时只读；不会执行文档脚本。'
    elif doc.xref_get_key(catalog, 'AcroForm/NeedAppearances') == ('bool', 'true'):
        reason = '此表单要求阅读器重建全部外观，暂时只读以保留原内容。'
    fields, names, count = {}, {}, 0
    for page in doc:
        if has_pdf_key(doc, page.xref, 'AA'):
            reason = reason or '页面含动作，表单暂时只读；不会执行文档脚本。'
        # Includes widgets and link/other annotation actions without invoking them.
        for xref, _, _ in page.annot_xrefs():
            count += 1
            if count > MAX_ANNOTATION_RELATIONS:
                return fields, names, '文档批注数量超过表单安全检查上限。', True
            if any(has_pdf_key(doc, xref, key) for key in ('AA', 'A/JS', 'A/Next')) or doc.xref_get_key(xref, 'A/S') == ('name', '/JavaScript'):
                reason = reason or '文档含关联动作或脚本，表单暂时只读；不会执行文档脚本。'
        for widget in page.widgets() or []:
            if len(fields) >= MAX_FORM_FIELDS:
                return fields, names, '文档字段数量超过安全编辑上限。', True
            fields[widget.xref] = page.number
            name = widget.field_name or ''
            names[name] = names.get(name, 0) + 1
            if any(has_pdf_key(doc, widget.xref, key) for key in ('A', 'AA')):
                reason = reason or '表单含动作或脚本，暂时只读；不会执行文档脚本。'
    if fields:
        kind, roots = doc.xref_get_key(catalog, 'AcroForm/Fields')
        # Accept only flat, unique top-level widget references. Parent/Kids and
        # orphan/tree inconsistencies need cross-widget updates we do not claim.
        root_ids = [int(value) for value in re.findall(r'(\d+)\s+\d+\s+R', roots)]
        if kind != 'array' or not re.fullmatch(r'\[\s*(?:\d+\s+\d+\s+R\s*)*\]', roots) or len(root_ids) != len(fields) or set(root_ids) != set(fields):
            reason = reason or '表单含父子字段或复杂字段树，暂时只读。'
    return fields, names, reason, False


def page_operation_form(doc):
    """Validate the flat field graph before page selection or grafting it.

    Document.select removes the catalog AcroForm while keeping page widgets.
    Complex trees/actions require cross-page remapping we do not implement.
    """
    fields, _, reason, truncated = form_inventory(doc)
    kind, value = doc.xref_get_key(doc.pdf_catalog(), 'AcroForm')
    if not fields and kind == 'null':
        return None
    if truncated or reason or kind not in ('dict', 'xref'):
        fail('FORM_PAGE_OPERATION_UNSUPPORTED', '此 PDF 含复杂表单或关联动作，暂不支持调整或合并页面；原文件未修改。')
    root_kind, roots = doc.xref_get_key(doc.pdf_catalog(), 'AcroForm/Fields')
    root_ids = [int(value) for value in re.findall(r'(\d+)\s+\d+\s+R', roots)]
    if root_kind != 'array' or not re.fullmatch(r'\[\s*(?:\d+\s+\d+\s+R\s*)*\]', roots) or len(root_ids) != len(fields) or set(root_ids) != set(fields):
        fail('FORM_PAGE_OPERATION_UNSUPPORTED', '此 PDF 含非页面字段或不完整的表单引用，暂不支持调整或合并页面；原文件未修改。')
    for xref in fields:
        if any(has_pdf_key(doc, xref, key) for key in ('Parent', 'Kids')):
            fail('FORM_PAGE_OPERATION_UNSUPPORTED', '此 PDF 含父子表单字段，暂不支持调整或合并页面；原文件未修改。')
    return doc.xref_object(int(value.split()[0])) if kind == 'xref' else value


def select_pages_with_forms(doc, pages, context):
    form = page_operation_form(doc)
    doc.select(pages)
    if form is not None:
        # A private copy keeps form defaults/resources and unknown metadata; only
        # the verified flat Fields array is filtered to widgets on retained pages.
        xref = doc.get_new_xref()
        doc.update_object(xref, form)
        roots = [widget.xref for page in doc for widget in page.widgets() or []]
        doc.xref_set_key(xref, 'Fields', '[' + ' '.join(f'{item} 0 R' for item in roots) + ']')
        doc.xref_set_key(doc.pdf_catalog(), 'AcroForm', f'{xref} 0 R')
        context['preserveFonts'] = True


def preserve_merge_form_defaults(doc):
    # A merged file has only one AcroForm dictionary. Materialize defaults on
    # source fields before grafting so one file's DA/Q cannot affect another's.
    catalog = doc.pdf_catalog()
    default_da = doc.xref_get_key(catalog, 'AcroForm/DA')
    default_q = doc.xref_get_key(catalog, 'AcroForm/Q')
    for page in doc:
        for widget in page.widgets() or []:
            if widget.field_type not in (pymupdf.PDF_WIDGET_TYPE_TEXT, pymupdf.PDF_WIDGET_TYPE_COMBOBOX, pymupdf.PDF_WIDGET_TYPE_LISTBOX):
                continue
            if not has_pdf_key(doc, widget.xref, 'DA') and default_da[0] == 'string':
                doc.xref_set_key(widget.xref, 'DA', pymupdf.get_pdf_str(default_da[1]))
            if not has_pdf_key(doc, widget.xref, 'Q'):
                if default_q[0] not in ('null', 'int') or default_q[0] == 'int' and default_q[1] not in ('0', '1', '2'):
                    fail('FORM_PAGE_OPERATION_UNSUPPORTED', '此表单的默认排版无法可靠合并；原文件未修改。')
                doc.xref_set_key(widget.xref, 'Q', default_q[1] if default_q[0] == 'int' else '0')


def form_readonly_reason(doc, widget, names, global_reason):
    if global_reason:
        return global_reason
    if widget.field_flags & pymupdf.PDF_FIELD_IS_READ_ONLY:
        return '此字段被文档标记为只读。'
    annotation_flags = doc.xref_get_key(widget.xref, 'F')
    if annotation_flags[0] == 'int' and int(annotation_flags[1]) & (1 | 2 | 32 | 64 | 128 | 512):
        return '此字段被标记为隐藏、只读或锁定。'
    if any(has_pdf_key(doc, widget.xref, key) for key in ('Parent', 'Kids')):
        return '此字段含父子关联，暂时只读。'
    if not widget.field_name or names.get(widget.field_name) != 1:
        return '字段名称为空或在文档中重复，暂时只读。'
    if widget.field_type not in (pymupdf.PDF_WIDGET_TYPE_TEXT, pymupdf.PDF_WIDGET_TYPE_CHECKBOX):
        return '此字段类型暂时只读；当前支持普通文本框和独立复选框。'
    if has_pdf_key(doc, widget.xref, 'RV'):
        return '此字段包含富文本值，暂时保留原格式。'
    try:
        rectangle(list(widget.rect), widget.parent)
    except PdfError:
        return '字段区域不完整地位于页面内，暂时只读。'
    if widget.field_type == pymupdf.PDF_WIDGET_TYPE_TEXT:
        if not has_pdf_key(doc, widget.xref, 'DA') and has_pdf_key(doc, doc.pdf_catalog(), 'AcroForm/DA'):
            return '此文本框继承文档级文字外观，暂时只读以保留原排版。'
        allowed = 2 | 4 | pymupdf.PDF_TX_FIELD_IS_MULTILINE | pymupdf.PDF_TX_FIELD_IS_DO_NOT_SCROLL | pymupdf.PDF_TX_FIELD_IS_DO_NOT_SPELL_CHECK
        if widget.field_flags & ~allowed:
            return '密码、分格、文件选择、富文本或特殊文本框暂时只读。'
        if any(has_pdf_key(doc, widget.xref, key) for key in ('AP/R', 'AP/D')):
            return '此文本框含交互外观，暂时只读以保留显示状态。'
        if doc.xref_get_key(widget.xref, 'BS/S') == ('name', '/D'):
            return '此文本框使用虚线边框，暂时只读以保留原外观。'
        if len(str(widget.field_value or '')) > MAX_TEXT_LENGTH:
            return '字段文字超过安全编辑上限。'
        if widget.text_maxlen < 0 or doc.xref_get_key(widget.xref, 'V')[0] not in ('string', 'null'):
            return '此文本框的值或长度限制格式异常，暂时只读。'
        font = widget.text_font or ''
        expected = {'Helv': '/Helvetica', 'Cour': '/Courier', 'TiRo': '/Times-Roman'}.get(font)
        # Widget.update silently substitutes other names with Helv. Never do that
        # to a user font or a custom font disguised under a standard resource name.
        if not expected:
            return '此文本框使用自定义字体，暂时只读以保留原外观。'
        resources = [(doc.pdf_catalog(), f'AcroForm/DR/Font/{font}'), (widget.xref, f'AP/N/Resources/Font/{font}')]
        resources = [(xref, path) for xref, path in resources if has_pdf_key(doc, xref, path)]
        if not resources or any(doc.xref_get_key(xref, path + '/BaseFont') != ('name', expected)
                                or doc.xref_get_key(xref, path + '/Subtype') != ('name', '/Type1')
                                or doc.xref_get_key(xref, path + '/Encoding') not in (('name', '/WinAnsiEncoding'), ('null', 'null'))
                                for xref, path in resources):
            return '此文本框字体资源无法可靠保留，暂时只读。'
        if any(has_pdf_key(doc, xref, path + '/FontDescriptor') for xref, path in resources):
            return '此文本框使用嵌入字体，暂时只读以保留原外观。'
        if doc.xref_get_key(widget.xref, 'AP/N')[0] != 'xref':
            return '此文本框没有可验证的普通外观，暂时只读。'
    else:
        if widget.field_flags & ~(2 | 4):
            return '此复选框包含特殊行为，暂时只读。'
        states = checkbox_states(widget)
        on = checkbox_on_state(widget)
        if len(states) != 2 or states.count('Off') != 1 or not isinstance(on, str) or on == 'Off' or on not in states:
            return '此复选框没有唯一的开/关外观，暂时只读。'
        for state in states:
            # A slash cannot be distinguished from a nested key by this API.
            if '/' in state:
                return '此复选框使用特殊外观名称，暂时只读。'
            kind, reference = doc.xref_get_key(widget.xref, 'AP/N/' + state)
            if kind != 'xref' or not doc.xref_is_stream(int(reference.split()[0])):
                return '此复选框外观不完整，暂时只读。'
        if widget.field_value not in states:
            return '此复选框值与外观状态不一致，暂时只读。'
    return ''


def form_token(doc, widget, context):
    return hashlib.sha256((context['sourceHash'] + ':' + str(widget.xref) + ':' + doc.xref_object(widget.xref)).encode('utf-8')).hexdigest()


def read_forms(doc, options, context):
    if options.get('includeForms') is False:
        return {}
    selected = indices(options.get('pageIndices', [0]), doc.page_count, allow_empty=True)
    if len(selected) > 50:
        fail('INPUT_LIMIT', '每次最多读取 50 页表单。')
    if not (context['permissions']['copy'] or context['permissions']['fillForms']):
        return {'formFields': [], 'formPages': selected, 'formsTruncated': False}
    fields, names, reason, truncated = form_inventory(doc)
    output, text_size = [], 0
    for index in selected:
        page = doc[index]
        for widget in page.widgets() or []:
            if len(output) >= 500 or text_size > 250_000:
                return {'formFields': output, 'formPages': selected, 'formsTruncated': True}
            protected = bool(widget.field_flags & pymupdf.PDF_TX_FIELD_IS_PASSWORD)
            value = '' if protected else str(widget.field_value or '')[:MAX_TEXT_LENGTH]
            text_size += len(value)
            output.append({'id': widget.xref, 'pageIndex': index, 'name': (widget.field_label or widget.field_name or '未命名字段')[:500],
                           'type': widget.field_type_string, 'rect': list(widget.rect),
                           'value': isinstance(checkbox_on_state(widget), str) and widget.field_value == checkbox_on_state(widget) if widget.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX else value,
                           'maxLength': min(widget.text_maxlen or MAX_TEXT_LENGTH, MAX_TEXT_LENGTH),
                           'multiline': bool(widget.field_flags & pymupdf.PDF_TX_FIELD_IS_MULTILINE),
                           'required': bool(widget.field_flags & pymupdf.PDF_FIELD_IS_REQUIRED),
                           'token': form_token(doc, widget, context),
                           'readonlyReason': form_readonly_reason(doc, widget, names, reason)})
    return {'formFields': output, 'formPages': selected, 'formsTruncated': truncated}


def fill_field(doc, options, context):
    page = doc[page_index(options, doc.page_count)]
    xref = integer(options.get('fieldId'), 'fieldId', 1, doc.xref_length() - 1)
    widget = next((item for item in page.widgets() or [] if item.xref == xref), None)
    if widget is None or options.get('expectedToken') != form_token(doc, widget, context):
        fail('STALE_FIELD', '表单已改变或字段不在此页，请重新选择。')
    _, names, reason, _ = form_inventory(doc)
    reason = form_readonly_reason(doc, widget, names, reason)
    if reason:
        fail('READONLY_FIELD', reason)
    value = options.get('value')
    if widget.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
        if not isinstance(value, bool):
            fail('INVALID_OPTIONS', '复选框值必须为勾选或未勾选。')
        state = pdf_name(checkbox_on_state(widget) if value else 'Off')
        # Preserve both original appearance streams, export name and style.
        doc.xref_set_key(xref, 'V', state)
        doc.xref_set_key(xref, 'AS', state)
    else:
        value = annotation_text(value, '字段内容', min(widget.text_maxlen or MAX_TEXT_LENGTH, MAX_TEXT_LENGTH))
        if any(ord(char) < 32 and char not in '\r\n' for char in value):
            fail('INVALID_OPTIONS', '字段内容不能含不可见控制字符。')
        if not widget.field_flags & pymupdf.PDF_TX_FIELD_IS_MULTILINE and any(char in value for char in '\r\n'):
            fail('INVALID_OPTIONS', '此字段为单行文本，不能填写换行。')
        original = doc.xref_object(xref)
        original_ap = doc.xref_get_key(xref, 'AP')
        original_font = doc.xref_get_key(xref, f'AP/N/Resources/Font/{widget.text_font}')
        # Widget.update writes through indirect style dictionaries. They can be
        # shared by unrelated fields, so regenerate with private dictionary
        # copies before restoring the original widget and its references.
        for key in ('BS', 'MK'):
            kind, reference = doc.xref_get_key(xref, key)
            if kind == 'xref':
                doc.xref_set_key(xref, key, doc.xref_object(int(reference.split()[0])))
        # An appearance stream/dictionary may be shared with another widget.
        # Detach it before regeneration so the other field is never overwritten.
        doc.xref_set_key(xref, 'AP', 'null')
        widget.field_value = value
        # This operation changes only the value. PyMuPDF's widget properties
        # round dash lengths to integers; rewriting them would also change the
        # generated border. Let the original PDF style drive the appearance.
        widget.border_dashes = None
        widget.fill_color = None
        widget.border_color = None
        widget.update()
        generated = {key: doc.xref_get_key(xref, key) for key in ('V', 'AP/N')}
        if generated['AP/N'][0] != 'xref' or not doc.xref_is_stream(int(generated['AP/N'][1].split()[0])):
            fail('FORM_APPEARANCE_FAILED', '未能生成表单外观，原文件未修改。')
        new_appearance = int(generated['AP/N'][1].split()[0])
        font_path = f'Resources/Font/{widget.text_font}'
        # All-CJK text uses Song in its AP; retain the original DA font resource
        # too, so later edits (including Latin text) can still validate it.
        if original_font[0] == 'xref' and not has_pdf_key(doc, new_appearance, font_path):
            doc.xref_set_key(new_appearance, font_path, original_font[1])
        # PyMuPDF also rewrites border / DA / flags / default properties. Restore
        # the entire dictionary, then transfer only new value and normal AP.
        doc.update_object(xref, original)
        if original_ap[0] == 'xref':
            # xref_set_key's nested setter requires direct dictionaries. A direct
            # copy also prevents writing through the original shared AP object.
            doc.xref_set_key(xref, 'AP', doc.xref_object(int(original_ap[1].split()[0])))
        doc.xref_set_key(xref, 'V', pymupdf.get_pdf_str(value))
        doc.xref_set_key(xref, 'AP/N', generated['AP/N'][1])


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


def guard_text_replacement(page, source_rect, target_rect):
    # apply_redactions applies every pending redaction on the page, not just the
    # one we add below. Never implicitly commit somebody else's redactions.
    if len(page.annot_xrefs()) > MAX_ANNOTATION_RELATIONS:
        fail('TEXT_OBJECT_CHECK_LIMIT', '此页控件或批注过多，无法安全检查原文替换；原文件未修改。')
    annotations = list(page.annots() or [])
    if any(annotation.type[0] == pymupdf.PDF_ANNOT_REDACT for annotation in annotations):
        fail('PENDING_REDACTION', '此页含待处理的涂抹批注，暂不支持替换正文，以免同时应用其他涂抹；原文件未修改。')
    objects = [(widget.rect, '表单字段') for widget in page.widgets() or []]
    objects.extend((annotation.rect, '批注') for annotation in annotations)
    objects.extend((link['from'], '链接') for link in page.get_links())
    for bounds_, label in objects:
        bounds_ = pymupdf.Rect(bounds_)
        if not bounds_.is_valid or bounds_.is_infinite:
            fail('TEXT_OBJECT_CHECK_LIMIT', '此页含无法可靠定位的控件或批注，暂不支持原文替换；原文件未修改。')
        if bounds_.intersects(source_rect) or bounds_.intersects(target_rect):
            fail('TEXT_OBJECT_INTERSECTION', f'替换区域与{label}重叠，不能将其当作正文覆盖。请使用表单或批注工具处理，或缩小文字区域；原文件未修改。')


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
        guard_text_replacement(page, source_rect, rect)
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
    if not context.get('preserveFonts'):
        doc.subset_fonts()
    data = doc.tobytes(garbage=4, deflate=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    if len(data) > MAX_OUTPUT_BYTES:
        fail('OUTPUT_LIMIT', '编辑结果超过可重新打开的文件大小限制，请分批处理页面或减小图片。',
             {'maximumBytes': MAX_OUTPUT_BYTES})
    return {'base64': base64.b64encode(data).decode('ascii'), 'metadata': metadata(doc, context),
            'textBlocks': text_blocks(doc, {}, context['permissions']['copy']), 'warnings': warnings}


def stamp_pages(doc, options, operation):
    selected = indices(options.get('pageIndices', list(range(doc.page_count))), doc.page_count)
    watermark = operation == 'watermark'
    size = number(options.get('fontSize', 44 if watermark else 10), '字号', 8, 144 if watermark else 32)
    rgb = color(options.get('color'), (0.35, 0.39, 0.46))
    opacity = number(options.get('opacity', 0.16 if watermark else 1), '不透明度', 0.05, 0.8 if watermark else 1)
    text = options.get('text', '草稿') if watermark else ''
    if watermark and (not isinstance(text, str) or not text.strip() or len(text) > 120
                      or any(ord(char) < 32 for char in text)):
        fail('INVALID_OPTIONS', '水印需要 1 至 120 个字符的单行文字。')
    style = options.get('format', 'number-total')
    if not watermark and style not in ('number', 'number-total', 'chinese'):
        fail('INVALID_OPTIONS', '未知的页码格式。')
    position = options.get('position', 'bottom-center')
    if not watermark and position not in ('bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right'):
        fail('INVALID_OPTIONS', '请选择页码在页眉或页脚的位置。')
    # Work in displayed page coordinates, then map the overlay back through /Rotate.
    # This preserves original content, CropBox, page rotation, links and annotations.
    font = pymupdf.Font('cjk')
    overlay = pymupdf.open()
    try:
        for index in selected:
            page = doc[index]
            width, height = page.rect.width, page.rect.height
            stamp = overlay.new_page(width=width, height=height)
            stamp.insert_font(fontname='StampCJK', fontbuffer=font.buffer)
            if watermark:
                value = text.strip()
                region = pymupdf.Rect(18, max(0, height / 2 - size * 0.7), width - 18, min(height, height / 2 + size * 1.8))
                align = 1
            else:
                value = str(index + 1) if style == 'number' else (f'第 {index + 1} 页 / 共 {doc.page_count} 页' if style == 'chinese' else f'{index + 1} / {doc.page_count}')
                top = 16 if position.startswith('top') else height - 16 - size * 1.6
                region = pymupdf.Rect(18, top, width - 18, top + size * 1.6)
                align = {'left': 0, 'center': 1, 'right': 2}[position.split('-')[1]]
            if region.is_empty or region.y0 < 0 or region.y1 > height:
                fail('TEXT_OVERFLOW', '页面过小，无法放置所选字号的页码或水印。请减小字号。')
            # Keep stamps to a single line; overflow rejects the entire transaction.
            if font.text_length(value, fontsize=size) > region.width:
                fail('TEXT_OVERFLOW', '页码或水印过长，无法完整放入页面。请缩短文字或减小字号。')
            if stamp.insert_textbox(region, value, fontname='StampCJK', fontsize=size, align=align,
                                    color=rgb, fill_opacity=opacity) < -0.01:
                fail('TEXT_OVERFLOW', '所选字号无法完整放入页面。请减小字号。')
        # MuPDF's graft map records source xref bounds on first import: finish
        # constructing the overlay document before importing any of its pages.
        for overlay_index, index in enumerate(selected):
            page = doc[index]
            rotation = page.rotation
            # show_pdf_page's coordinate transform on a rotated CropBox includes
            # different offsets. Insert in its unrotated space, then restore /Rotate.
            try:
                page.set_rotation(0)
                page.show_pdf_page(bounds(page), overlay, overlay_index, rotate=rotation, overlay=True)
            finally:
                page.set_rotation(rotation)
    finally:
        overlay.close()


def new_context():
    return {'encrypted': False, 'authenticatedAs': 'none',
            'permissions': {k: True for k in ('edit', 'modify', 'annotate', 'assemble', 'copy', 'print', 'fillForms')}}


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
                    form = page_operation_form(other)
                    if form is not None:
                        context['preserveFonts'] = True
                        preserve_merge_form_defaults(other)
                        existing_names = {widget.field_name for page in doc for widget in page.widgets() or []}
                        if any(widget.field_name in existing_names for page in other for widget in page.widgets() or []):
                            warnings.append('合并中的同名表单字段已使用独立名称，填写某一份不会联动另一份。')
                    # Duplicate field names must become independent fields, not
                    # a parent/Kids group whose values are linked across pages.
                    doc.insert_pdf(other, widgets=True, join_duplicates=False)
                finally:
                    other.close()
        else:
            doc, context = open_document(request.get('documentBase64'), request.get('password'))
            if operation == 'inspect':
                return {**response, 'ok': True, 'metadata': metadata(doc, context),
                        'textBlocks': text_blocks(doc, options, context['permissions']['copy']),
                        **read_annotations(doc, options, context), **read_forms(doc, options, context)}
            warnings = authorize(doc, context, operation, options)
            if operation == 'fill_field':
                context['preserveFonts'] = True
                fill_field(doc, options, context)
            elif operation in ('add_note', 'update_annotation', 'delete_annotation'):
                edit_annotation(doc, options, operation)
            elif operation in ('page_numbers', 'watermark'):
                stamp_pages(doc, options, operation)
            elif operation in ('replace_text', 'add_text', 'add_image', 'highlight', 'ink'):
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
                select_pages_with_forms(doc, pages, context)
            elif operation == 'reorder':
                order = indices(options.get('order'), doc.page_count, 'order')
                if len(order) != doc.page_count:
                    fail('INVALID_OPTIONS', '重排需要完整的页码排列，提取部分页面请使用提取功能。')
                select_pages_with_forms(doc, order, context)
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
