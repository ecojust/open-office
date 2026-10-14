"""Text replacement must not masquerade as editing/redacting live PDF objects."""
import base64
import unittest
from unittest.mock import patch
import pymupdf
import test_forms as forms


def opened(source):
    return pymupdf.open(stream=base64.b64decode(source), filetype='pdf')


def replace(source, **options):
    return forms.request('replace_text', source, pageIndex=0, sourceRect=options.pop('sourceRect', [30, 30, 330, 52]),
                         rect=options.pop('rect', [30, 30, 330, 52]), text='NEW BODY', fontSize=10, **options)


class TextObjectIntersectionTests(unittest.TestCase):
    def setUp(self):
        self.source = forms.fixture()

    def assert_refused(self, result, code):
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['error']['code'], code)
        self.assertNotIn('base64', result)

    def test_source_and_expanded_destination_cannot_overwrite_widget(self):
        for source_rect, rect in [([35, 70, 310, 103], [35, 70, 310, 103]),
                                  ([30, 30, 330, 52], [30, 30, 330, 110])]:
            self.assert_refused(replace(self.source, sourceRect=source_rect, rect=rect), 'TEXT_OBJECT_INTERSECTION')
        with opened(self.source) as doc:
            page = doc[0]; widget = next(page.widgets())
            self.assertEqual(widget.field_value, 'Original name')
            self.assertIn(b'Original name', forms.appearance(doc, widget))

    def test_intersecting_highlight_note_ink_and_link_are_refused(self):
        for kind in ('highlight', 'note', 'ink', 'link'):
            def add(doc):
                page = doc[0]
                if kind == 'highlight': page.add_highlight_annot(pymupdf.Rect(35, 31, 250, 49))
                elif kind == 'note': page.add_text_annot((60, 30), 'Comment about body')
                elif kind == 'ink': page.add_ink_annot([[(40, 40), (120, 48)]])
                else: page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(35, 31, 250, 49), 'uri': 'https://example.com/overlap'})
            source = forms.changed(self.source, add)
            self.assert_refused(replace(source), 'TEXT_OBJECT_INTERSECTION')

    def test_existing_redaction_elsewhere_is_not_implicitly_applied(self):
        def add(doc):
            page = doc[0]; page.insert_text((35, 430), 'SECRET ELSEWHERE')
            page.add_redact_annot(page.search_for('SECRET ELSEWHERE')[0])
        source = forms.changed(self.source, add)
        self.assert_refused(replace(source), 'PENDING_REDACTION')
        with opened(source) as doc:
            self.assertIn('SECRET ELSEWHERE', doc[0].get_text())
            self.assertTrue(any(a.type[0] == pymupdf.PDF_ANNOT_REDACT for a in doc[0].annots()))

    def test_unrelated_widgets_appearances_annotations_and_other_page_preserved(self):
        result = replace(self.source)
        self.assertTrue(result['ok'], result)
        with opened(self.source) as before, opened(result['base64']) as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets()), list(ap.widgets())
            self.assertNotIn('ORIGINAL BODY', ap.get_text())
            self.assertIn('NEW BODY', ap.get_text())
            for old_widget, new_widget in zip(old, new):
                self.assertEqual((old_widget.field_name, old_widget.field_value), (new_widget.field_name, new_widget.field_value))
                self.assertEqual(forms.properties(before, old_widget), forms.properties(after, new_widget))
                if old_widget.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
                    for state in ('Off', 'Accepted'):
                        self.assertEqual(forms.appearance(before, old_widget, state), forms.appearance(after, new_widget, state))
                else: self.assertEqual(forms.appearance(before, old_widget), forms.appearance(after, new_widget))
                self.assertEqual(bp.get_pixmap(clip=old_widget.rect).samples, ap.get_pixmap(clip=new_widget.rect).samples)
            self.assertEqual(next(bp.annots()).info, next(ap.annots()).info)
            self.assertEqual(bp.get_links()[0]['uri'], ap.get_links()[0]['uri'])
            self.assertEqual(before[1].get_pixmap().samples, after[1].get_pixmap().samples)
            self.assertEqual(before.get_toc(), after.get_toc())
        item = forms.fields(result['base64'])[0]
        self.assertFalse(item['readonlyReason'], item)
        self.assertTrue(forms.fill(result['base64'], item, 'Still editable')['ok'])

    def test_redaction_on_another_page_does_not_block_or_apply(self):
        def add(doc):
            page = doc[1]; page.add_redact_annot(page.search_for('SECOND PAGE')[0])
        source = forms.changed(self.source, add)
        result = replace(source)
        self.assertTrue(result['ok'], result)
        with opened(source) as before, opened(result['base64']) as after:
            self.assertEqual(before[1].get_pixmap().samples, after[1].get_pixmap().samples)
            self.assertIn('SECOND PAGE', after[1].get_text())
            self.assertTrue(any(a.type[0] == pymupdf.PDF_ANNOT_REDACT for a in after[1].annots()))

    def test_crop_and_page_rotation_keep_widget_intersection_coordinates(self):
        for rotation in (0, 90, 180, 270):
            def change(doc):
                page = doc[0]; page.set_cropbox(pymupdf.Rect(20, 20, 430, 530)); page.set_rotation(rotation)
            source = forms.changed(self.source, change)
            rect = forms.fields(source)[0]['rect']
            self.assert_refused(replace(source, sourceRect=rect, rect=rect), 'TEXT_OBJECT_INTERSECTION')

    def test_object_scan_budget_fails_without_replacement_pdf(self):
        with patch.object(forms.engine, 'MAX_ANNOTATION_RELATIONS', 2):
            self.assert_refused(replace(self.source), 'TEXT_OBJECT_CHECK_LIMIT')


if __name__ == '__main__':
    unittest.main()
