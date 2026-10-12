"""Real PDF round trips; no mocked PDF implementation or user files."""
import base64
import importlib.util
from pathlib import Path
import unittest

import pymupdf

SPEC = importlib.util.spec_from_file_location('pdf_engine', Path(__file__).parents[1] / 'engine.py')
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


def b64(data):
    return base64.b64encode(data).decode('ascii')


def sample(texts=('旧合同 OLD_SECRET', '第二页 PAGE_TWO', '第三页 PAGE_THREE')):
    doc = pymupdf.open()
    for text in texts:
        page = doc.new_page(width=360, height=240)
        page.draw_rect(page.rect, color=None, fill=(0.2, 0.5, 0.35), overlay=False)
        font = engine.cjk_font(page)
        page.insert_text((30, 60), text, fontname=font, fontsize=12, color=(1, 1, 1))
        page.insert_text((30, 170), '保留邻行 KEEP_NEIGHBOR', fontname=font, fontsize=12)
    data = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return b64(data)


def request(operation, source=None, options=None, **extra):
    result = engine.process({'protocolVersion': 1, 'requestId': 'test', 'operation': operation,
                             'documentBase64': source, 'options': options or {}, **extra})
    assert result['requestId'] == 'test'
    return result


def reopened(result):
    assert result['ok'], result
    return pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf')


class PdfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = sample()

    def test_inspect_chinese_spans_and_geometry(self):
        result = request('inspect', self.source)
        self.assertTrue(result['ok'])
        self.assertEqual(result['metadata']['pageCount'], 3)
        self.assertEqual(result['metadata']['pages'][0]['width'], 360)
        self.assertTrue(result['metadata']['permissions']['edit'])
        self.assertTrue(any('旧合同' in item['text'] for item in result['textBlocks']))
        self.assertTrue(all(len(item['bbox']) == 4 for item in result['textBlocks']))

    def test_true_chinese_replacement_and_colored_background(self):
        result = request('replace_text', self.source, {'pageIndex': 0, 'rect': [20, 35, 320, 100],
                                                       'text': '新的合同 NEW_TEXT', 'fontSize': 12})
        with reopened(result) as doc:
            text = doc[0].get_text()
            self.assertNotIn('旧合同', text)
            self.assertNotIn('OLD_SECRET', text)
            self.assertIn('新的合同 NEW_TEXT', text)
            self.assertIn('保留邻行 KEEP_NEIGHBOR', text)
            self.assertTrue(any(font[1] != 'n/a' for font in doc[0].get_fonts()))
            self.assertEqual(len(doc[0].get_drawings()), 1)
            with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as before:
                self.assertEqual(doc[0].get_pixmap().pixel(25, 90), before[0].get_pixmap().pixel(25, 90))
                self.assertEqual(doc[0].get_pixmap().pixel(3, 3), before[0].get_pixmap().pixel(3, 3))

    def test_overflow_has_no_output_and_input_unchanged(self):
        before = self.source
        result = request('replace_text', before, {'pageIndex': 0, 'rect': [30, 45, 90, 65],
                                                 'text': '超长替换文字' * 100, 'fontSize': 24})
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'TEXT_OVERFLOW')
        self.assertNotIn('base64', result)
        self.assertEqual(before, self.source)
        self.assertTrue(any('OLD_SECRET' in item['text'] for item in request('inspect', before)['textBlocks']))

    def test_add_text_is_extractable_without_removing_existing(self):
        result = request('add_text', self.source, {'pageIndex': 1, 'rect': [20, 90, 330, 140],
                                                  'text': '新增中文 Added', 'fontSize': 14})
        with reopened(result) as doc:
            self.assertIn('新增中文 Added', doc[1].get_text())
            self.assertIn('PAGE_TWO', doc[1].get_text())

    def test_expanded_layout_does_not_expand_original_text_redaction(self):
        result = request('replace_text', self.source, {
            'pageIndex': 0, 'sourceRect': [20, 35, 320, 85],
            'rect': [20, 25, 340, 220], 'text': '新合同 NEW', 'fontSize': 12,
        })
        with reopened(result) as doc:
            value = doc[0].get_text()
            self.assertNotIn('OLD_SECRET', value)
            self.assertIn('新合同 NEW', value)
            self.assertIn('KEEP_NEIGHBOR', value)

    def test_password_required_invalid_and_user_modify_restriction(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw='reader', owner_pw='owner',
                                    permissions=pymupdf.PDF_PERM_PRINT))
        missing = request('inspect', locked)
        self.assertEqual(missing['error']['code'], 'PASSWORD_REQUIRED')
        self.assertTrue(missing['metadata']['needsPassword'])
        wrong = request('inspect', locked, password='wrong')
        self.assertEqual(wrong['error']['code'], 'INVALID_PASSWORD')
        inspect = request('inspect', locked, password='reader')
        self.assertTrue(inspect['metadata']['encrypted'])
        self.assertFalse(inspect['metadata']['permissions']['edit'])
        self.assertEqual(inspect['textBlocks'], [])
        denied = request('add_text', locked, {'pageIndex': 0, 'rect': [20, 90, 300, 130], 'text': '无权限'}, password='reader')
        self.assertEqual(denied['error']['code'], 'PERMISSION_DENIED')
        self.assertNotIn('base64', denied)

    def test_owner_edit_preserves_encryption_and_user_restriction(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw='reader', owner_pw='owner',
                                    permissions=pymupdf.PDF_PERM_PRINT))
        result = request('replace_text', locked, {'pageIndex': 0, 'rect': [20, 35, 320, 100], 'text': '修改 ENCRYPTED'}, password='owner')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            self.assertTrue(doc.needs_pass)
            self.assertEqual(doc.authenticate('reader'), 2)
            self.assertFalse(doc.permissions & pymupdf.PDF_PERM_MODIFY)
            self.assertIn('修改 ENCRYPTED', doc[0].get_text())
            self.assertNotIn('OLD_SECRET', doc[0].get_text())

    def test_owner_only_password_does_not_grant_modify_to_empty_password(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='',
                                    permissions=pymupdf.PDF_PERM_PRINT))
        result = request('rotate', locked, {'pageIndices': [0], 'degrees': 90})
        self.assertEqual(result['error']['code'], 'PERMISSION_DENIED')

    def test_assembly_permission_does_not_grant_text_modification(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader',
                                    permissions=pymupdf.PDF_PERM_ASSEMBLE))
        rotated = request('rotate', locked, {'pageIndices': [0], 'degrees': 90}, password='reader')
        self.assertTrue(rotated['ok'], rotated)
        denied = request('add_text', locked, {'pageIndex': 0, 'rect': [20, 20, 300, 80], 'text': '禁止'}, password='reader')
        self.assertEqual(denied['error']['code'], 'PERMISSION_DENIED')

    def test_copy_permission_allows_extraction_but_not_reordering(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader',
                                    permissions=pymupdf.PDF_PERM_COPY))
        extracted = request('extract', locked, {'pageIndices': [1]}, password='reader')
        self.assertTrue(extracted['ok'], extracted)
        self.assertEqual(extracted['metadata']['pageCount'], 1)
        denied = request('reorder', locked, {'order': [2, 1, 0]}, password='reader')
        self.assertEqual(denied['error']['code'], 'PERMISSION_DENIED')

    def test_reorder_round_trip(self):
        result = request('reorder', self.source, {'order': [2, 0, 1]})
        with reopened(result) as doc:
            self.assertIn('PAGE_THREE', doc[0].get_text())
            self.assertIn('OLD_SECRET', doc[1].get_text())
            self.assertIn('PAGE_TWO', doc[2].get_text())

    def test_extract_requested_order(self):
        result = request('extract', self.source, {'pageIndices': [2, 0]})
        with reopened(result) as doc:
            self.assertEqual(doc.page_count, 2)
            self.assertIn('PAGE_THREE', doc[0].get_text())
            self.assertIn('OLD_SECRET', doc[1].get_text())

    def test_delete_and_delete_all_rejected(self):
        result = request('delete', self.source, {'pageIndices': [1]})
        with reopened(result) as doc:
            self.assertEqual(doc.page_count, 2)
            self.assertIn('PAGE_THREE', doc[1].get_text())
        self.assertEqual(request('delete', self.source, {'pageIndices': [0, 1, 2]})['error']['code'], 'EMPTY_PDF')

    def test_rotate_keeps_unrotated_geometry(self):
        result = request('rotate', self.source, {'pageIndices': [0], 'degrees': 90})
        with reopened(result) as doc:
            self.assertEqual(doc[0].rotation, 90)
        page = result['metadata']['pages'][0]
        self.assertEqual((page['width'], page['height']), (360, 240))
        self.assertEqual(page['rotation'], 90)

    def test_merge_order(self):
        first, second = sample(('文件甲 FIRST',)), sample(('文件乙 SECOND',))
        result = request('merge', options={'documents': [{'base64': first}, {'base64': second}]})
        with reopened(result) as doc:
            self.assertEqual(doc.page_count, 2)
            self.assertIn('FIRST', doc[0].get_text())
            self.assertIn('SECOND', doc[1].get_text())

    def test_merge_encrypted_requires_explicit_unencrypted_copy(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader'))
        options = {'documents': [{'base64': locked, 'password': 'owner'}, {'base64': self.source}]}
        self.assertEqual(request('merge', options=options)['error']['code'], 'ENCRYPTED_MERGE')
        result = request('merge', options={**options, 'allowUnencryptedCopy': True})
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['warnings'])

    def test_insert_png(self):
        image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 10, 10), False)
        image.clear_with(100)
        result = request('add_image', self.source, {'pageIndex': 0, 'rect': [250, 120, 300, 180],
                                                   'imageBase64': b64(image.tobytes('png'))})
        with reopened(result) as doc:
            self.assertEqual(len(doc[0].get_images()), 1)
            self.assertIn('OLD_SECRET', doc[0].get_text())

    def test_highlight_and_handwritten_ink_are_real_annotations(self):
        highlight = request('highlight', self.source, {'pageIndex': 0, 'rects': [[25, 40, 160, 70]]})
        ink = request('ink', highlight['base64'], {'pageIndex': 0, 'paths': [[[30, 200], [50, 210], [80, 195]]], 'width': 2})
        with reopened(ink) as doc:
            types = [annot.type[0] for annot in doc[0].annots()]
            self.assertIn(pymupdf.PDF_ANNOT_HIGHLIGHT, types)
            self.assertIn(pymupdf.PDF_ANNOT_INK, types)

    def test_signed_document_copy_must_be_explicit(self):
        # A structurally signed fixture, intentionally not a valid cryptographic
        # signature: detection is distinct from certificate trust validation.
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            field = pymupdf.Widget()
            field.field_name, field.field_type = 'Signature1', pymupdf.PDF_WIDGET_TYPE_SIGNATURE
            field.rect = pymupdf.Rect(200, 180, 320, 215)
            doc[0].add_widget(field)
            widget = next(doc[0].widgets())
            value = doc.get_new_xref()
            doc.update_object(value, '<</Type/Sig/ByteRange[0 10 20 30]/Contents<0000>>>')
            doc.xref_set_key(widget.xref, 'V', f'{value} 0 R')
            signed = b64(doc.tobytes())
        self.assertTrue(request('inspect', signed)['metadata']['signed'])
        self.assertEqual(request('rotate', signed, {'pageIndices': [0], 'degrees': 90})['error']['code'], 'SIGNED_DOCUMENT')
        result = request('rotate', signed, {'pageIndices': [0], 'degrees': 90, 'allowSignedCopy': True})
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['warnings'])

    def test_invalid_and_out_of_page_requests_do_not_produce_pdf(self):
        cases = [
            ('replace_text', {'pageIndex': 0, 'rect': [-1, 0, 20, 20], 'text': 'a'}),
            ('add_text', {'pageIndex': 0, 'rect': [0, 0, 20, 20], 'text': 'a', 'fontSize': float('nan')}),
            ('reorder', {'order': [1, 1, 2]}),
            ('extract', {'pageIndices': [3]}),
            ('add_image', {'pageIndex': 0, 'rect': [0, 0, 20, 20], 'imageBase64': b64(b'<svg href="file:///etc/passwd"/>')}),
        ]
        for operation, options in cases:
            with self.subTest(operation=operation):
                result = request(operation, self.source, options)
                self.assertFalse(result['ok'])
                self.assertNotIn('base64', result)

    def test_new_blank_pdf(self):
        result = request('new', options={'pageCount': 2, 'width': 500, 'height': 700})
        with reopened(result) as doc:
            self.assertEqual(doc.page_count, 2)
            self.assertEqual(doc[0].rect.width, 500)
            self.assertEqual(doc[1].get_text(), '')


if __name__ == '__main__':
    unittest.main()
