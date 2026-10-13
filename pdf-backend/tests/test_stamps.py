"""Real persisted PDF stamps: rotation, crop boxes, content, permissions and outline."""
import base64
import unittest
import pymupdf
from test_engine import engine, request, reopened, b64


def fixture():
    doc = pymupdf.open()
    for rotation in (0, 90, 180, 270):
        page = doc.new_page(width=500, height=600)
        page.draw_rect(page.rect, color=None, fill=(0.2, 0.5, 0.35))
        page.insert_text((80, 100), f'KEEP PAGE {rotation}', fontsize=12)
        page.set_cropbox(pymupdf.Rect(30, 40, 470, 560))
        page.set_rotation(rotation)
    doc.set_toc([[1, '第一章', 1], [2, '旋转章节', 2], [1, '末章', 4]])
    result = b64(doc.tobytes())
    doc.close()
    return result


class StampTests(unittest.TestCase):
    def test_numbers_are_upright_at_displayed_footer_after_all_rotations_and_crops(self):
        source = fixture()
        result = request('page_numbers', source, {'format': 'number-total'})
        with reopened(result) as doc:
            self.assertEqual(doc.get_toc(), [[1, '第一章', 1], [2, '旋转章节', 2], [1, '末章', 4]])
            for index, page in enumerate(doc):
                self.assertEqual(page.rotation, index * 90)
                self.assertEqual(list(page.cropbox), [30, 40, 470, 560])
                self.assertIn(f'KEEP PAGE {index*90}', page.get_text())
                line = next(line for block in page.get_text('dict')['blocks'] for line in block.get('lines', [])
                            if ''.join(span['text'] for span in line['spans']) == f'{index+1} / 4')
                displayed = pymupdf.Rect(line['bbox']) * page.rotation_matrix
                self.assertGreater(displayed.y0, page.rect.height * .85)
                self.assertLessEqual(displayed.y1, page.rect.height)
                self.assertAlmostEqual((displayed.x0 + displayed.x1) / 2, page.rect.width / 2, delta=2)
                direction = pymupdf.Point(line['dir']) * page.rotation_matrix - pymupdf.Point(0, 0) * page.rotation_matrix
                self.assertAlmostEqual(direction.x, 1, places=4)
                self.assertAlmostEqual(direction.y, 0, places=4)

    def test_selected_numbering_uses_document_positions_and_chinese_survives_reopen(self):
        result = request('page_numbers', fixture(), {'pageIndices': [1, 3], 'format': 'chinese', 'position': 'top-right'})
        with reopened(result) as doc:
            self.assertNotIn('第', doc[0].get_text())
            self.assertIn('第 2 页 / 共 4 页', doc[1].get_text())
            self.assertNotIn('第', doc[2].get_text())
            self.assertIn('第 4 页 / 共 4 页', doc[3].get_text())

    def test_watermark_keeps_original_content_and_transparency_and_outline(self):
        source = fixture()
        result = request('watermark', source, {'text': '内部评审 Draft', 'fontSize': 24, 'opacity': .2, 'pageIndices': [0]})
        with reopened(result) as doc, pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before:
            self.assertIn('内部评审 Draft', doc[0].get_text())
            self.assertIn('KEEP PAGE 0', doc[0].get_text())
            self.assertNotIn('Draft', doc[1].get_text())
            self.assertEqual(doc[0].get_pixmap().pixel(2, 2), before[0].get_pixmap().pixel(2, 2))
            spans = doc[0].get_texttrace()
            self.assertTrue(any(abs(span['opacity'] - .2) < .001 for span in spans))
            inspected = request('inspect', result['base64'])
            self.assertEqual(inspected['metadata']['outline'][1], {'level': 2, 'title': '旋转章节', 'pageIndex': 1})

    def test_overflow_rejects_without_partial_pdf_or_mutating_source(self):
        source = fixture()
        result = request('watermark', source, {'text': '宽文字' * 30, 'fontSize': 100})
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'TEXT_OVERFLOW')
        self.assertNotIn('base64', result)
        self.assertTrue(request('inspect', source)['ok'])

    def test_permission_and_signature_protections_are_shared_by_new_operations(self):
        with pymupdf.open(stream=base64.b64decode(fixture()), filetype='pdf') as doc:
            locked = b64(doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader', permissions=pymupdf.PDF_PERM_PRINT))
        for operation in ('watermark', 'page_numbers'):
            self.assertEqual(request(operation, locked, password='reader')['error']['code'], 'PERMISSION_DENIED')
            allowed = request(operation, locked, password='owner')
            with reopened(allowed) as doc:
                self.assertTrue(doc.needs_pass)
                doc.authenticate('reader')
                self.assertFalse(doc.permissions & pymupdf.PDF_PERM_MODIFY)
        with pymupdf.open(stream=base64.b64decode(fixture()), filetype='pdf') as doc:
            page = doc[0]; widget = pymupdf.Widget(); widget.field_name = 'Signature'; widget.field_type = pymupdf.PDF_WIDGET_TYPE_SIGNATURE; widget.rect = pymupdf.Rect(20, 20, 100, 50)
            page.add_widget(widget); widget = next(page.widgets()); value = doc.get_new_xref(); doc.update_object(value, '<</Type/Sig/ByteRange[0 1 2 3]/Contents<0123>>>'); doc.xref_set_key(widget.xref, 'V', f'{value} 0 R')
            signed = b64(doc.tobytes())
        for operation in ('watermark', 'page_numbers'):
            self.assertEqual(request(operation, signed)['error']['code'], 'SIGNED_DOCUMENT')
            self.assertTrue(request(operation, signed, {'allowSignedCopy': True})['ok'])

    def test_invalid_inputs_rejected_and_external_bookmark_has_no_navigation_target(self):
        for options in ({'pageIndices': []}, {'pageIndices': [0, 0]}, {'opacity': float('nan')}, {'text': 'line\nline'}, {'fontSize': 1000}):
            self.assertFalse(request('watermark', fixture(), options)['ok'])
        with pymupdf.open(stream=base64.b64decode(fixture()), filetype='pdf') as doc:
            doc.set_toc([
                [1, '外部目标', -1, {'kind': pymupdf.LINK_URI, 'uri': 'https://example.invalid/'}],
                [1, '另一个文件的页码', -1, {'kind': pymupdf.LINK_GOTOR, 'file': 'other.pdf', 'page': 1, 'zoom': 0}],
            ])
            result = request('inspect', b64(doc.tobytes()))
        self.assertIsNone(result['metadata']['outline'][0]['pageIndex'])
        self.assertIsNone(result['metadata']['outline'][1]['pageIndex'])


if __name__ == '__main__':
    unittest.main()
