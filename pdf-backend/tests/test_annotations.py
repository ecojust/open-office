"""Annotation management: real serialized PDF output, preserving non-target objects."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location('annotation_engine', Path(__file__).parents[1] / 'engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def encode(doc, **kwargs):
    return base64.b64encode(doc.tobytes(garbage=4, deflate=True, **kwargs)).decode('ascii')


def request(operation, source, **options):
    password = options.pop('password', None)
    return engine.process({'protocolVersion': 1, 'requestId': 'annotations', 'operation': operation,
                           'documentBase64': source, 'password': password, 'options': options})


def annotations(source, page=0, **options):
    result = request('inspect', source, pageIndices=[page], **options)
    assert result['ok'], result
    return result['annotations']


def mutate(source, item, operation='update_annotation', **options):
    return request(operation, source, pageIndex=item['pageIndex'], annotationId=item['id'],
                   expectedToken=item['token'], **options)


def fixture():
    with pymupdf.open() as doc:
        page = doc.new_page(width=360, height=480)
        page.insert_text((40, 100), 'ORIGINAL BODY')
        page.add_highlight_annot(pymupdf.Rect(35, 85, 160, 105)).set_info(content='highlight', title='Reviewer')
        ink = page.add_ink_annot([[(40, 150), (90, 180), (160, 150)]])
        ink.set_colors(stroke=(0.2, 0.3, 0.7)); ink.set_opacity(0.6); ink.update()
        ink.set_info(content='ink')
        page.add_text_annot((30, 210), 'note')
        page.add_rect_annot(pymupdf.Rect(40, 260, 110, 300)).set_info(content='square')
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(30, 320, 120, 345), 'uri': 'https://example.com/'})
        widget = pymupdf.Widget(); widget.field_name = 'KeptField'; widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.rect = pymupdf.Rect(30, 360, 150, 390); widget.field_value = 'KeptValue'; page.add_widget(widget)
        doc.new_page(width=360, height=480).insert_text((40, 100), 'SECOND BODY')
        doc.set_toc([[1, 'Original bookmark', 2]])
        return encode(doc)


def annotation_appearance(doc, annotation):
    preserved = {key: doc.xref_get_key(annotation.xref, key) for key in ('Rect', 'QuadPoints', 'InkList', 'C', 'CA', 'F', 'BS', 'M')}
    kind, ap = doc.xref_get_key(annotation.xref, 'AP/N')
    preserved['appearance'] = doc.xref_stream(int(ap.split()[0])) if kind == 'xref' else (kind, ap)
    return preserved


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.source = fixture()

    def assert_preserved(self, data):
        with pymupdf.open(stream=base64.b64decode(data), filetype='pdf') as doc:
            self.assertIn('ORIGINAL BODY', doc[0].get_text())
            self.assertIn('SECOND BODY', doc[1].get_text())
            self.assertEqual(doc[0].get_links()[0]['uri'], 'https://example.com/')
            widget = next(doc[0].widgets())
            self.assertEqual((widget.field_name, widget.field_value), ('KeptField', 'KeptValue'))
            self.assertEqual(doc.get_toc(), [[1, 'Original bookmark', 2]])

    def test_read_types_and_independent_readback(self):
        items = annotations(self.source)
        self.assertEqual([item['type'] for item in items], ['Highlight', 'Ink', 'Text', 'Square'])
        self.assertFalse(items[0]['readonlyReason'])
        self.assertTrue(items[3]['readonlyReason'])
        self.assertTrue(all(len(item['token']) == 64 for item in items))
        self.assertEqual(annotations(self.source, 1), [])

    def test_edit_highlight_and_ink_preserves_appearance_and_all_other_objects(self):
        for kind in ('Highlight', 'Ink'):
            source = self.source
            item = next(item for item in annotations(source) if item['type'] == kind)
            with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before:
                page = before[0]; original = next(a for a in page.annots() if a.type[1] == kind)
                appearance = annotation_appearance(before, original)
                raster = hashlib.sha256(page.get_pixmap().samples).hexdigest()
            changed = mutate(source, item, content='中文审核\n需要复核', author='审阅者')
            self.assertTrue(changed['ok'], changed)
            with pymupdf.open(stream=base64.b64decode(changed['base64']), filetype='pdf') as after:
                page = after[0]; edited = next(a for a in page.annots() if a.type[1] == kind)
                self.assertEqual(edited.info['content'], '中文审核\n需要复核')
                self.assertEqual(edited.info['title'], '审阅者')
                self.assertEqual(annotation_appearance(after, edited), appearance)
                self.assertEqual(hashlib.sha256(page.get_pixmap().samples).hexdigest(), raster)
            self.assert_preserved(changed['base64'])

    def test_note_add_reinspect_edit_delete_and_other_annotations_survive(self):
        added = request('add_note', self.source, pageIndex=1, point=[70, 80], content='中文便签', author='作者')
        self.assertTrue(added['ok'], added)
        item = annotations(added['base64'], 1)[0]
        changed = mutate(added['base64'], item, content='新内容', author='新作者')
        self.assertTrue(changed['ok'], changed)
        updated = annotations(changed['base64'], 1)[0]
        self.assertEqual(updated['content'], '新内容')
        removed = mutate(changed['base64'], updated, 'delete_annotation')
        self.assertTrue(removed['ok'], removed)
        self.assertEqual(annotations(removed['base64'], 1), [])
        self.assertEqual([(x['type'], x['content']) for x in annotations(removed['base64'])],
                         [(x['type'], x['content']) for x in annotations(self.source)])
        self.assert_preserved(removed['base64'])

    def test_stale_identifier_wrong_page_and_bad_token_refused(self):
        item = annotations(self.source)[0]
        changed = mutate(self.source, item, content='changed', author='')
        stale = mutate(changed['base64'], item, content='stale', author='')
        self.assertEqual(stale['error']['code'], 'STALE_ANNOTATION')
        wrong_page = mutate(self.source, {**item, 'pageIndex': 1}, 'delete_annotation')
        self.assertEqual(wrong_page['error']['code'], 'STALE_ANNOTATION')
        bad_token = mutate(self.source, {**item, 'token': 'bogus'}, 'delete_annotation')
        self.assertEqual(bad_token['error']['code'], 'STALE_ANNOTATION')
        self.assertNotIn('base64', stale)

    def test_readonly_flags_rich_contents_and_unimplemented_types_refused(self):
        for flag in (64, 128, 512):
            with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
                page = doc[0]; annotation = next(page.annots()); annotation.set_flags(flag)
                data = encode(doc)
            item = annotations(data)[0]
            self.assertTrue(item['readonlyReason'])
            self.assertEqual(mutate(data, item, 'delete_annotation')['error']['code'], 'READONLY_ANNOTATION')
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            page = doc[0]; annotation = next(page.annots())
            doc.xref_set_key(annotation.xref, 'RC', pymupdf.get_pdf_str('<p>Rich content</p>'))
            data = encode(doc)
        item = annotations(data)[0]
        self.assertIn('富文本', item['readonlyReason'])
        self.assertEqual(mutate(data, item, content='x', author='')['error']['code'], 'READONLY_ANNOTATION')
        item = annotations(self.source)[3]
        self.assertEqual(mutate(self.source, item, 'delete_annotation')['error']['code'], 'READONLY_ANNOTATION')

    def test_cross_page_reply_relationship_preserved_and_locked(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            page = doc[0]; parent = next(page.annots()); parent_xref = parent.xref
            page = doc[1]; reply = page.add_text_annot((40, 40), 'Reply')
            doc.xref_set_key(reply.xref, 'IRT', f'{parent_xref} 0 R')
            data = encode(doc)
        for index in (0, 1):
            item = annotations(data, index)[0]
            self.assertIn('回复', item['readonlyReason'])
            self.assertEqual(mutate(data, item, 'delete_annotation')['error']['code'], 'READONLY_ANNOTATION')

    def test_relation_scan_budget_is_readonly_instead_of_partial_authorization(self):
        with patch.object(engine, 'MAX_ANNOTATION_RELATIONS', 2):
            items = annotations(self.source)
            self.assertTrue(all(item['readonlyReason'] for item in items))
            result = mutate(self.source, items[0], 'delete_annotation')
            self.assertEqual(result['error']['code'], 'READONLY_ANNOTATION')

    def test_all_annotation_mutations_require_explicit_signed_copy(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            page = doc[0]
            field = pymupdf.Widget(); field.field_name = 'Signature1'; field.field_type = pymupdf.PDF_WIDGET_TYPE_SIGNATURE
            field.rect = pymupdf.Rect(200, 350, 300, 390); page.add_widget(field)
            widget = next(item for item in page.widgets() if item.field_name == 'Signature1')
            value = doc.get_new_xref(); doc.update_object(value, '<</Type/Sig/ByteRange[0 10 20 30]/Contents<0000>>>')
            doc.xref_set_key(widget.xref, 'V', f'{value} 0 R')
            data = encode(doc)
        item = annotations(data)[0]
        for operation, extra in (('add_note', {'point': [20, 20], 'content': 'note'}),
                                 ('update_annotation', {'annotationId': item['id'], 'expectedToken': item['token'], 'content': 'edited'}),
                                 ('delete_annotation', {'annotationId': item['id'], 'expectedToken': item['token']})):
            refused = request(operation, data, pageIndex=0, **extra)
            self.assertEqual(refused['error']['code'], 'SIGNED_DOCUMENT')
            allowed = request(operation, data, pageIndex=0, allowSignedCopy=True, **extra)
            self.assertTrue(allowed['ok'], allowed)
            self.assertTrue(allowed['warnings'])

    def test_annotation_permissions_preserve_encryption(self):
        for permission, allowed in ((pymupdf.PDF_PERM_ANNOTATE, True), (pymupdf.PDF_PERM_MODIFY, False)):
            with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
                encrypted = encode(doc, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader', permissions=permission)
            result = request('add_note', encrypted, password='reader', pageIndex=0, point=[40, 40], content='Authorized comment')
            self.assertEqual(result['ok'], allowed, result)
            if allowed:
                with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
                    self.assertTrue(doc.needs_pass)
                    self.assertEqual(doc.authenticate('reader'), 2)
                    self.assertTrue(doc.permissions & pymupdf.PDF_PERM_ANNOTATE)
                    self.assertFalse(doc.permissions & pymupdf.PDF_PERM_MODIFY)
            else:
                self.assertEqual(result['error']['code'], 'PERMISSION_DENIED')

    def test_notes_on_rotated_cropped_pages_keep_expected_unrotated_coordinates(self):
        for rotation in (0, 90, 180, 270):
            with pymupdf.open() as doc:
                page = doc.new_page(width=500, height=700)
                page.set_cropbox(pymupdf.Rect(50, 60, 450, 640)); page.set_rotation(rotation)
                data = encode(doc)
            added = request('add_note', data, pageIndex=0, point=[80, 120], content='Position')
            self.assertTrue(added['ok'], added)
            with pymupdf.open(stream=base64.b64decode(added['base64']), filetype='pdf') as doc:
                page = doc[0]; annotation = next(page.annots())
                self.assertEqual(page.rotation, rotation)
                self.assertEqual(list(page.cropbox), [50, 60, 450, 640])
                self.assertEqual(list(annotation.rect)[:2], [80, 120])
                self.assertEqual(annotations(added['base64'])[0]['rect'], list(annotation.rect))

    def test_malformed_notes_fail_without_producing_replacement_pdf(self):
        for options in ({'point': [355, 470], 'content': 'x'}, {'point': [20, 20], 'content': ''},
                        {'point': [20, 20], 'content': 'x\x00y'}, {'point': [20, 20], 'content': 'x' * 20001},
                        {'point': [True, 20], 'content': 'x'}, {'point': [20, 20], 'content': 'x', 'author': 'x' * 201}):
            result = request('add_note', self.source, pageIndex=0, **options)
            self.assertFalse(result['ok'], result)
            self.assertNotIn('base64', result)
        self.assert_preserved(self.source)


if __name__ == '__main__':
    unittest.main()
