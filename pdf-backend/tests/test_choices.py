"""Real PDF single-choice fields: export values, appearance, guards and isolation."""
import base64
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

import pymupdf

from test_forms import engine, encode, request, fields, fill, changed, appearance


def fixture():
    with pymupdf.open() as doc:
        page = doc.new_page(width=500, height=620)
        page.insert_text((30, 35), 'CHOICE FORM / ORIGINAL BODY')
        for name, kind, rect, options, value, flags in [
            ('City', 3, (30, 65, 330, 103), [('bj', '北京 Beijing'), ('sh', '上海 Shanghai'), ('gz', '广州 Guangzhou')], 'bj', 2),
            ('Department', 4, (30, 145, 330, 260), [('desk', 'Front desk'), ('service', 'Customer service'), ('night', 'Night team')], 'desk', 0),
            ('Plain choice', 3, (30, 300, 330, 338), ['Morning', 'Afternoon', 'Night'], 'Morning', 0),
            ('Multiple choice', 4, (30, 380, 330, 460), ['A', 'B', 'C'], 'A', pymupdf.PDF_CH_FIELD_IS_MULTI_SELECT),
            ('Locked choice', 3, (30, 500, 330, 538), ['Keep', 'Other'], 'Keep', 1),
        ]:
            widget = pymupdf.Widget(); widget.field_name = name; widget.field_type = kind
            widget.rect = pymupdf.Rect(rect); widget.choice_values = options; widget.field_value = value
            widget.field_flags = flags; widget.text_fontsize = 14; widget.text_color = (0.1, 0.2, 0.3)
            widget.border_color = (0.2, 0.5, 0.3); widget.fill_color = (0.94, 0.97, 0.96)
            page.add_widget(widget)
        widgets = list(page.widgets())
        for item in widgets:
            doc.xref_set_key(item.xref, 'DV', pymupdf.get_pdf_str(str(item.field_value)))
            doc.xref_set_key(item.xref, 'PrivateMetadata', '(preserve this)')
        doc.xref_set_key(widgets[3].xref, 'V', '[(A)(C)]')
        doc.xref_set_key(widgets[3].xref, 'I', '[0 2]')
        page.add_text_annot((380, 65), 'Keep this note')
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(350, 300, 470, 325), 'uri': 'https://example.com/choice'})
        page = doc.new_page(width=500, height=620); page.insert_text((30, 40), 'UNCHANGED SECOND PAGE')
        doc.set_toc([[1, 'Form', 1], [1, 'Sentinel', 2]])
        return encode(doc)


def empty_fixture():
    def empty(doc):
        page = doc[0]; widget = next(page.widgets())
        widget.field_value = ''; widget.choice_values = None; widget.update()
        doc.xref_set_key(widget.xref, 'V', 'null'); doc.xref_set_key(widget.xref, 'I', 'null')
        doc.xref_set_key(widget.xref, 'Opt', '[ [() (No preference)] [(sh) (Shanghai)] ]')
    return changed(fixture(), empty)


def props(doc, widget):
    return {key: doc.xref_get_key(widget.xref, key) for key in ('Opt', 'DV', 'DA', 'Ff', 'F', 'BS', 'MK', 'Rect', 'Q', 'PrivateMetadata', 'T')}


class ChoiceTests(unittest.TestCase):
    def setUp(self):
        self.source = fixture()

    def reject(self, source, fragment=None):
        item = fields(source)[0]
        self.assertTrue(item['readonlyReason'], item)
        if fragment: self.assertIn(fragment, item['readonlyReason'])
        result = fill(source, item, 'sh')
        self.assertEqual(result['error']['code'], 'READONLY_FIELD', result)
        self.assertNotIn('base64', result)

    def mutate(self, key, value):
        def mutate(doc):
            xref = next(doc[0].widgets()).xref
            if key.startswith('AP/N/'):
                xref = int(doc.xref_get_key(xref, 'AP/N')[1].split()[0])
                doc.xref_set_key(xref, key[5:], value)
            else:
                doc.xref_set_key(xref, key, value)
        return changed(self.source, mutate)

    def test_inventory_distinguishes_export_values_and_display_labels(self):
        items = fields(self.source)
        self.assertEqual(items[0]['value'], 'bj')
        self.assertEqual(items[0]['displayValue'], '北京 Beijing')
        self.assertEqual(items[0]['choices'][1], {'value': 'sh', 'label': '上海 Shanghai'})
        self.assertEqual(items[2]['choices'][1], {'value': 'Afternoon', 'label': 'Afternoon'})
        self.assertTrue(all(not item['readonlyReason'] for item in items[:3]))
        self.assertTrue(items[3]['readonlyReason']); self.assertTrue(items[4]['readonlyReason'])
        self.assertEqual(items[3]['displayValue'], '多选值（只读）')

    def test_combo_real_value_label_appearance_and_untouched_objects(self):
        result = fill(self.source, fields(self.source)[0], 'sh')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets()), list(ap.widgets())
            self.assertEqual(new[0].field_value, 'sh'); self.assertEqual(after.xref_get_key(new[0].xref, 'I'), ('array', '[1]'))
            self.assertIn('上海 Shanghai', ap.get_text()); self.assertNotIn('(sh) Tj', appearance(after, new[0]).decode())
            for left, right in zip(old, new): self.assertEqual(props(before, left), props(after, right))
            for i in range(1, 5): self.assertEqual(appearance(before, old[i]), appearance(after, new[i]))
            self.assertEqual(before[1].get_pixmap().samples, after[1].get_pixmap().samples)
            self.assertEqual(before.get_toc(), after.get_toc()); self.assertEqual(next(ap.annots()).info['content'], 'Keep this note')
            self.assertEqual(ap.get_links()[0]['uri'], 'https://example.com/choice')
        reread = fields(result['base64'])[0]
        self.assertFalse(reread['readonlyReason']); self.assertEqual(reread['displayValue'], '上海 Shanghai')
        second = fill(result['base64'], reread, 'gz'); self.assertTrue(second['ok'], second)
        self.assertEqual(fields(second['base64'])[0]['value'], 'gz')

    def test_list_selection_scroll_index_and_vector_highlight(self):
        for value, index in [('service', 1), ('night', 2), ('desk', 0)]:
            with self.subTest(value=value):
                result = fill(self.source, fields(self.source)[1], value); self.assertTrue(result['ok'], result)
                with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
                    page = doc[0]; widget = list(page.widgets())[1]
                    self.assertEqual(widget.field_value, value)
                    self.assertEqual(doc.xref_get_key(widget.xref, 'I'), ('array', f'[{index}]'))
                    self.assertEqual(doc.xref_get_key(widget.xref, 'TI'), ('int', str(index)))
                    ap = appearance(doc, widget)
                    self.assertIn(b'q 0.78 0.87 0.98 rg ', ap)
                    self.assertEqual(ap.count(b' re f Q\n'), 1)
                    # Chosen row is visible at the top; a saved PDF renderer can
                    # display the selection without interactive HTML widgets.
                    label = ['Front desk', 'Customer service', 'Night team'][index]
                    self.assertIn(label, page.get_text(clip=widget.rect))
                self.assertFalse(fields(result['base64'])[1]['readonlyReason'])

    def test_chinese_list_labels_duplicate_labels_and_escaped_export_values(self):
        def modify(doc):
            page = doc[0]; widget = list(page.widgets())[1]
            widget.choice_values = [('a(1)', '同名 A'), ('b\\2', '同名 A'), ('中文', '上海 B'), ('😀', 'Export only')]; widget.field_value = 'a(1)'; widget.update()
        source = changed(self.source, modify)
        for value, index in [('b\\2', 1), ('中文', 2), ('😀', 3)]:
            result = fill(source, fields(source)[1], value); self.assertTrue(result['ok'], result)
            with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
                page = doc[0]; widget = list(page.widgets())[1]
                self.assertEqual(widget.field_value, value); self.assertEqual(doc.xref_get_key(widget.xref, 'I'), ('array', f'[{index}]'))
                self.assertIn(['同名 A', '同名 A', '上海 B', 'Export only'][index], page.get_text(clip=widget.rect))

    def test_invalid_values_are_not_coerced_or_returned_as_edited_pdf(self):
        item = fields(self.source)[0]
        for value in ('unknown', '上海 Shanghai', ['bj', 'sh'], None, True, 1):
            with self.subTest(value=value):
                result = fill(self.source, item, value)
                self.assertEqual(result['error']['code'], 'INVALID_OPTIONS', result); self.assertNotIn('base64', result)

    def test_flags_and_structure_fail_closed(self):
        for flags in (1, 131072 | 262144, 131072 | 2097152, 131072 | 524288, 131072 | 33554432, 1 << 30):
            self.reject(self.mutate('Ff', str(flags)))
        for key, value in [('Kids', '[]'), ('AA', '<< /V << /S /JavaScript /JS (danger) >> >>'), ('AP/R', '<<>>'), ('MK/R', '90'), ('BS/S', '/D'), ('RV', '(rich)')]:
            self.reject(self.mutate(key, value))
        self.reject(changed(self.source, lambda doc: doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/XFA', '(xfa)')))
        self.reject(changed(self.source, lambda doc: doc.xref_set_key(list(doc[0].widgets())[1].xref, 'T', '(City)')))

    def test_malformed_indices_values_options_and_budgets_fail_closed(self):
        for key, value in [('I', '[1]'), ('I', '[0 2]'), ('I', '[-1]'), ('I', '(0)'), ('V', '[(bj)(sh)]'), ('V', '(outside)'), ('TI', '-1'), ('TI', '20'), ('TI', '1.5'), ('Opt', '[]'), ('Opt', '[(bj)(bj)]'), ('Opt', '[[(bj)()]]'), ('Opt', '[(bad\\000)]')]:
            self.reject(self.mutate(key, value))
        with patch.object(engine, 'MAX_CHOICE_OPTIONS', 2): self.reject(self.source, '250')
        with patch.object(engine, 'MAX_CHOICE_TEXT', 10): self.reject(self.source, '过长')

    def test_default_and_current_empty_choice_values(self):
        source = self.mutate('Opt', '[[(bj)(Beijing)][()(None)][(sh)(Shanghai)]]')
        result = fill(source, fields(source)[0], '')
        self.assertTrue(result['ok'], result)
        item = fields(result['base64'])[0]; self.assertEqual(item['value'], ''); self.assertEqual(item['displayValue'], 'None')
        self.assertFalse(item['readonlyReason']); self.assertTrue(fill(result['base64'], item, 'sh')['ok'])

    def test_custom_fonts_shared_appearance_and_styles(self):
        self.reject(self.mutate('DA', '(0 0 0 rg /Custom 12 Tf)'), '字体')
        def share(doc):
            page = doc[0]; widgets = list(page.widgets())
            for key in ('AP', 'MK', 'BS'):
                ref = doc.get_new_xref(); doc.update_object(ref, doc.xref_get_key(widgets[0].xref, key)[1])
                for widget in widgets[:2]: doc.xref_set_key(widget.xref, key, f'{ref} 0 R')
        source = changed(self.source, share)
        result = fill(source, fields(source)[0], 'sh'); self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets())[1], list(ap.widgets())[1]
            self.assertEqual(appearance(before, old), appearance(after, new))
            # References may renumber during garbage collection; compare content.
            for key in ('MK', 'BS'):
                left = int(before.xref_get_key(old.xref, key)[1].split()[0]); right = int(after.xref_get_key(new.xref, key)[1].split()[0])
                self.assertEqual(before.xref_object(left), after.xref_object(right))

    def test_signed_fill_permissions_and_stale_token_remain_enforced(self):
        item = fields(self.source)[0]; result = fill(self.source, item, 'sh')
        self.assertEqual(fill(result['base64'], item, 'gz')['error']['code'], 'STALE_FIELD')
        source = changed(self.source, lambda doc: doc.xref_set_key(doc.pdf_catalog(), 'Perms', '<< /DocMDP 1 0 R >>'))
        self.assertEqual(fill(source, fields(source)[0], 'sh')['error']['code'], 'SIGNED_DOCUMENT')
        self.assertTrue(fill(source, fields(source)[0], 'sh', allowSignedCopy=True)['ok'])
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            locked = encode(doc, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user', permissions=pymupdf.PDF_PERM_COPY)
        self.assertEqual(fill(locked, fields(locked, password='user')[0], 'sh', password='user')['error']['code'], 'PERMISSION_DENIED')

    def test_unselected_and_selected_empty_export_are_distinct(self):
        source = empty_fixture(); item = fields(source)[0]
        self.assertEqual(item['value'], ''); self.assertEqual(item['displayValue'], '')
        self.assertIsNone(item['selectedIndex']); self.assertFalse(item['readonlyReason'])
        result = fill(source, item, ''); self.assertTrue(result['ok'], result)
        current = fields(result['base64'])[0]
        self.assertEqual(current['value'], ''); self.assertEqual(current['selectedIndex'], 0)
        self.assertEqual(current['displayValue'], 'No preference')
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            page = doc[0]; widget = next(page.widgets())
            self.assertEqual(doc.xref_get_key(widget.xref, 'V'), ('string', ''))
            self.assertIn('No preference', page.get_text(clip=widget.rect))

    def test_custom_graphics_opacity_and_transform_stay_readonly(self):
        for key, value in [('AP/N/Resources/ExtGState', '<< /Fade << /ca .2 /CA .2 >> >>'), ('AP/N/Resources/XObject', '<<>>'), ('AP/N/Resources/Pattern', '<<>>'), ('AP/N/Resources/Shading', '<<>>'), ('AP/N/Resources/ColorSpace', '<<>>'), ('AP/N/Group', '<< /S /Transparency >>'), ('AP/N/Matrix', '[2 0 0 2 0 0]')]:
            with self.subTest(key=key): self.reject(self.mutate(key, value))

    def test_unsupported_complex_labels_are_readonly_without_affecting_supported_scripts(self):
        for label in ('القاهرة', 'אבג', 'देवनागरी', '😀', '𠮷', '\ufefb', 'a\u202eb'):
            source = self.mutate('Opt', '[[(bj)(Beijing)][(sh)' + pymupdf.get_pdf_str(label) + ']]')
            self.reject(source, '复杂文字')
        for label in ('Москва', 'Ελλάδα', '上海 Shanghai'):
            source = self.mutate('Opt', '[[(bj)(Beijing)][(sh)' + pymupdf.get_pdf_str(label) + ']]')
            result = fill(source, fields(source)[0], 'sh'); self.assertTrue(result['ok'], result)
            with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
                page = doc[0]; widget = next(page.widgets()); self.assertIn(label, page.get_text(clip=widget.rect))

    def test_zero_width_border_is_not_silently_added(self):
        result = fill(self.source, fields(self.source)[0], 'sh'); self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            page = doc[0]; widget = next(page.widgets()); ap = appearance(doc, widget)
            self.assertEqual(doc.xref_get_key(widget.xref, 'BS/W'), ('int', '0'))
            self.assertIn(b'0 w\n', ap); self.assertNotIn(b'1 w\n', ap)
            self.assertNotIn(b' RG\n', ap)

    def test_unverifiable_generated_list_appearance_is_not_saved(self):
        with patch.object(engine, 'highlight_choice_appearance', side_effect=engine.PdfError('FORM_APPEARANCE_FAILED', 'layout changed')):
            result = fill(self.source, fields(self.source)[1], 'night')
        self.assertEqual(result['error']['code'], 'FORM_APPEARANCE_FAILED'); self.assertNotIn('base64', result)


if __name__ == '__main__':
    unittest.main()
