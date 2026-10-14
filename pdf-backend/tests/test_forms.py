"""AcroForm filling: actual serialized values/AP, permissions and fail-closed guards."""
import base64
import importlib.util
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location('forms_engine', Path(__file__).parents[1] / 'engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def encode(doc, **kwargs):
    return base64.b64encode(doc.tobytes(garbage=4, deflate=True, **kwargs)).decode('ascii')


def request(operation, source, **options):
    password = options.pop('password', None)
    return engine.process({'protocolVersion': 1, 'requestId': 'forms', 'operation': operation,
                           'documentBase64': source, 'password': password, 'options': options})


def fields(source, page=0, **options):
    result = request('inspect', source, pageIndices=[page], **options)
    assert result['ok'], result
    return result['formFields']


def fill(source, item, value, **options):
    return request('fill_field', source, pageIndex=item['pageIndex'], fieldId=item['id'],
                   expectedToken=item['token'], value=value, **options)


def fixture():
    with pymupdf.open() as doc:
        page = doc.new_page(width=450, height=550)
        page.insert_text((35, 45), 'APPLICATION FORM / ORIGINAL BODY')
        for name, kind, rect, value, flags in [
            ('Full name', pymupdf.PDF_WIDGET_TYPE_TEXT, (35, 70, 310, 103), 'Original name', 2),
            ('Details', pymupdf.PDF_WIDGET_TYPE_TEXT, (35, 130, 310, 210), 'First line\nSecond line', 4096),
            ('Consent', pymupdf.PDF_WIDGET_TYPE_CHECKBOX, (35, 240, 58, 263), 'Off', 0),
            ('Read only', pymupdf.PDF_WIDGET_TYPE_TEXT, (35, 290, 310, 323), 'Preserved', 1),
        ]:
            widget = pymupdf.Widget(); widget.field_name = name; widget.field_type = kind
            widget.rect = pymupdf.Rect(rect); widget.field_value = value; widget.field_flags = flags
            widget.text_fontsize = 14; widget.text_color = (0.1, 0.2, 0.3); widget.border_color = (0.2, 0.5, 0.3)
            widget.fill_color = (0.94, 0.97, 0.96); widget.text_maxlen = 40 if name == 'Full name' else 0
            page.add_widget(widget)
        widgets = list(page.widgets()); name, _, checkbox, _ = widgets
        doc.xref_set_key(name.xref, 'DV', '(Default stays)')
        doc.xref_set_key(name.xref, 'PrivateMetadata', '(untouched)')
        # A custom export name must remain intact, not be replaced with /Yes.
        ap = doc.xref_get_key(checkbox.xref, 'AP/N')[1].replace('/Yes', '/Accepted')
        doc.xref_set_key(checkbox.xref, 'AP/N', ap)
        page.add_text_annot((340, 70), 'Keep this note')
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(35, 360, 160, 385), 'uri': 'https://example.com/'})
        page = doc.new_page(width=450, height=550); page.insert_text((35, 45), 'SECOND PAGE')
        widget = pymupdf.Widget(); widget.field_name = 'Second page'; widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.rect = pymupdf.Rect(35, 70, 310, 103); widget.field_value = 'Page two'; page.add_widget(widget)
        doc.set_toc([[1, 'Application', 1], [1, 'Second page', 2]])
        return encode(doc)


def changed(source, callback):
    with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as doc:
        callback(doc)
        return encode(doc)


def appearance(doc, widget, state=None):
    path = 'AP/N' + ('/' + engine.pdf_name(state)[1:] if state else '')
    kind, ref = doc.xref_get_key(widget.xref, path)
    assert kind == 'xref', (kind, ref)
    return doc.xref_stream(int(ref.split()[0]))


def properties(doc, widget):
    return {key: doc.xref_get_key(widget.xref, key) for key in ('Rect', 'F', 'Ff', 'DA', 'BS', 'MK', 'DV', 'MaxLen', 'PrivateMetadata', 'Q', 'T')}


class FormTests(unittest.TestCase):
    def setUp(self):
        self.source = fixture()

    def assert_rejected(self, source, fragment=None):
        item = fields(source)[0]
        self.assertTrue(item['readonlyReason'], item)
        if fragment:
            self.assertIn(fragment, item['readonlyReason'])
        result = fill(source, item, 'Changed')
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['error']['code'], 'READONLY_FIELD')
        self.assertNotIn('base64', result)

    def test_current_page_inventory_and_readonly(self):
        items = fields(self.source)
        self.assertEqual([x['name'] for x in items], ['Full name', 'Details', 'Consent', 'Read only'])
        self.assertEqual(items[2]['value'], False)
        self.assertTrue(items[0]['required'])
        self.assertEqual(items[0]['maxLength'], 40)
        self.assertTrue(items[1]['multiline'])
        self.assertTrue(items[3]['readonlyReason'])
        self.assertEqual(len(fields(self.source, 1)), 1)
        self.assertTrue(all(len(x['token']) == 64 for x in items))

    def test_chinese_text_real_value_appearance_and_non_target_preserved(self):
        result = fill(self.source, fields(self.source)[0], '中文姓名 Alice')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets()), list(ap.widgets())
            self.assertEqual(new[0].field_value, '中文姓名 Alice')
            self.assertIn('中文姓名 Alice', ap.get_text())
            self.assertNotEqual(appearance(before, old[0]), appearance(after, new[0]))
            for i in range(4): self.assertEqual(properties(before, old[i]), properties(after, new[i]))
            for i in (1, 3): self.assertEqual(appearance(before, old[i]), appearance(after, new[i]))
            for state in ('Off', 'Accepted'): self.assertEqual(appearance(before, old[2], state), appearance(after, new[2], state))
            self.assertEqual(next(ap.annots()).info['content'], 'Keep this note')
            self.assertEqual(ap.get_links()[0]['uri'], 'https://example.com/')
            self.assertEqual(before.get_toc(), after.get_toc())
            self.assertIn('ORIGINAL BODY', ap.get_text())
        reread = fields(result['base64'])[0]
        self.assertFalse(reread['readonlyReason'])
        self.assertTrue(fill(result['base64'], reread, '再改一次')['ok'])

    def test_checkbox_custom_state_keeps_appearance_bytes(self):
        result = fill(self.source, fields(self.source)[2], True)
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets())[2], list(ap.widgets())[2]
            self.assertEqual(new.field_value, 'Accepted')
            self.assertEqual(after.xref_get_key(new.xref, 'AS'), ('name', '/Accepted'))
            self.assertEqual(properties(before, old), properties(after, new))
            for state in ('Off', 'Accepted'): self.assertEqual(appearance(before, old, state), appearance(after, new, state))
        second = fill(result['base64'], fields(result['base64'])[2], False)
        self.assertTrue(second['ok'], second)
        self.assertFalse(fields(second['base64'])[2]['value'])

    def test_checkbox_escaped_export_name(self):
        def rename(doc):
            page = doc[0]; widget = list(page.widgets())[2]
            ap = doc.xref_get_key(widget.xref, 'AP/N')[1].replace('/Accepted', '/Agreed#20now')
            doc.xref_set_key(widget.xref, 'AP/N', ap)
        source = changed(self.source, rename)
        item = fields(source)[2]
        self.assertFalse(item['readonlyReason'], item)
        result = fill(source, item, True)
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            page = doc[0]; widget = list(page.widgets())[2]
            self.assertEqual(widget.field_value, 'Agreed now')
            self.assertEqual(engine.checkbox_on_state(widget), 'Agreed now')
            self.assertEqual(doc.xref_get_key(widget.xref, 'AS'), ('name', '/Agreed now'))

    def test_multiline_and_limits(self):
        items = fields(self.source)
        result = fill(self.source, items[1], '第一行\nSecond line')
        self.assertTrue(result['ok'], result)
        self.assertEqual(fields(result['base64'])[1]['value'], '第一行\nSecond line')
        for value in ('x' * 41, 'line1\nline2', 'NUL\x00', 42):
            result = fill(self.source, items[0], value)
            self.assertEqual(result['error']['code'], 'INVALID_OPTIONS', result)
        self.assertEqual(fill(self.source, items[2], 'Yes')['error']['code'], 'INVALID_OPTIONS')
        self.assertTrue(fill(self.source, items[0], '')['ok'])

    def test_stale_document_token_and_wrong_page(self):
        item = fields(self.source)[0]
        result = fill(self.source, item, 'First edit')
        self.assertEqual(fill(result['base64'], item, 'Stale')['error']['code'], 'STALE_FIELD')
        wrong = {**item, 'pageIndex': 1}
        self.assertEqual(fill(self.source, wrong, 'No')['error']['code'], 'STALE_FIELD')

    def test_special_flags_rich_values_and_locked(self):
        for flags in (1, 8192, 1048576, 16777216, 33554432, 1 << 30):
            with self.subTest(flags=flags):
                source = changed(self.source, lambda doc: doc.xref_set_key(next(doc[0].widgets()).xref, 'Ff', str(flags)))
                self.assert_rejected(source)
                if flags == 8192: self.assertEqual(fields(source)[0]['value'], '')
        for key, value in [('RV', '(rich)'), ('F', '128'), ('AP/R', '<< /Rollover true >>')]:
            source = changed(self.source, lambda doc: doc.xref_set_key(next(doc[0].widgets()).xref, key, value))
            self.assert_rejected(source)

    def test_global_actions_xfa_calculation_and_other_page_duplicates(self):
        for key, value in [('AcroForm/XFA', '(xfa)'), ('AcroForm/NeedAppearances', 'true'), ('AcroForm/CO', '[1 0 R]'), ('Names/JavaScript', '<< /Names [] >>'), ('AA', '<< /WC << /S /JavaScript /JS (throw dangerous) >> >>'), ('OpenAction', '[0 /Fit]')]:
            with self.subTest(key=key):
                self.assert_rejected(changed(self.source, lambda doc: doc.xref_set_key(doc.pdf_catalog(), key, value)))
        def action(doc):
            doc.xref_set_key(next(doc[1].widgets()).xref, 'AA', '<< /V << /S /JavaScript /JS (throw dangerous) >> >>')
        self.assert_rejected(changed(self.source, action))
        self.assert_rejected(changed(self.source, lambda doc: doc.xref_set_key(next(doc[1].widgets()).xref, 'T', '(Full name)')), '重复')

    def test_tree_and_malformed_roots_are_readonly(self):
        self.assert_rejected(changed(self.source, lambda doc: doc.xref_set_key(next(doc[0].widgets()).xref, 'Kids', '[]')), '父子')
        def malformed(doc):
            kind, roots = doc.xref_get_key(doc.pdf_catalog(), 'AcroForm/Fields')
            doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/Fields', roots[:-1] + ' (not a reference)]')
        self.assert_rejected(changed(self.source, malformed), '树')

    def test_custom_or_disguised_fonts_are_readonly(self):
        self.assert_rejected(changed(self.source, lambda doc: doc.xref_set_key(next(doc[0].widgets()).xref, 'DA', '(0 0 0 rg /Custom 12 Tf)')), '字体')
        for key, value in [('Subtype', '/Type0'), ('Encoding', '<< /Differences [65 /Z] >>'), ('FontDescriptor', '<< /FontName /Helvetica >>')]:
            def modify(doc):
                widget = next(doc[0].widgets())
                ref = int(doc.xref_get_key(widget.xref, 'AP/N/Resources/Font/Helv')[1].split()[0])
                doc.xref_set_key(ref, key, value)
            self.assert_rejected(changed(self.source, modify), '字体')

    def test_shared_appearance_does_not_change_second_widget(self):
        def share(doc):
            page = doc[0]; widgets = list(page.widgets())
            ap_ref = doc.get_new_xref(); doc.update_object(ap_ref, doc.xref_get_key(widgets[0].xref, 'AP')[1])
            for item in widgets[:2]: doc.xref_set_key(item.xref, 'AP', f'{ap_ref} 0 R')
        source = changed(self.source, share)
        result = fill(source, fields(source)[0], 'Target only')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = list(bp.widgets()), list(ap.widgets())
            self.assertEqual(appearance(before, old[1]), appearance(after, new[1]))
            self.assertNotEqual(appearance(after, new[0]), appearance(after, new[1]))

    def test_fill_permission_is_independent_and_encryption_stays(self):
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            source = encode(doc, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user', permissions=pymupdf.PDF_PERM_FORM)
        inspection = request('inspect', source, password='user', pageIndices=[0])
        self.assertTrue(inspection['ok'], inspection)
        self.assertTrue(inspection['metadata']['permissions']['fillForms'])
        self.assertFalse(inspection['metadata']['permissions']['modify'])
        self.assertEqual(inspection['textBlocks'], [])
        result = fill(source, inspection['formFields'][0], 'Permitted fill', password='user')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            self.assertTrue(doc.needs_pass)
            self.assertEqual(doc.authenticate('wrong'), 0)
            self.assertTrue(doc.authenticate('user'))
            self.assertEqual(next(doc[0].widgets()).field_value, 'Permitted fill')
            self.assertTrue(doc.permissions & pymupdf.PDF_PERM_FORM)
            self.assertFalse(doc.permissions & pymupdf.PDF_PERM_MODIFY)
        with pymupdf.open(stream=base64.b64decode(self.source), filetype='pdf') as doc:
            source = encode(doc, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user', permissions=pymupdf.PDF_PERM_COPY)
        item = fields(source, password='user')[0]
        self.assertEqual(fill(source, item, 'Denied', password='user')['error']['code'], 'PERMISSION_DENIED')
        item = fields(source, password='owner')[0]
        self.assertTrue(fill(source, item, 'Owner', password='owner')['ok'])

    def test_signed_copy_and_budget(self):
        def signature(doc):
            doc.xref_set_key(doc.pdf_catalog(), 'Perms', '<< /DocMDP 1 0 R >>')
        source = changed(self.source, signature); item = fields(source)[0]
        self.assertEqual(fill(source, item, 'Copy')['error']['code'], 'SIGNED_DOCUMENT')
        result = fill(source, item, 'Copy', allowSignedCopy=True)
        self.assertTrue(result['ok'], result); self.assertTrue(result['warnings'])
        with patch.object(engine, 'MAX_FORM_FIELDS', 2):
            result = request('inspect', self.source)
            self.assertTrue(result['formsTruncated'])
            self.assertTrue(all(item['readonlyReason'] for item in result['formFields']))
            self.assertEqual(fill(self.source, result['formFields'][0], 'No')['error']['code'], 'READONLY_FIELD')

    def test_shared_style_dictionaries_and_other_page_remain_exact(self):
        def share(doc):
            page = doc[0]; widgets = list(page.widgets())
            # D is legal but unused with solid S: preserve unknown style metadata
            # too. Widget.update formerly rounded it through the shared object.
            border = doc.get_new_xref()
            doc.update_object(border, '<< /Type /Border /W 1 /S /S /D [2.5 1.25] /Private (keep) >>')
            marker = doc.get_new_xref()
            doc.update_object(marker, doc.xref_get_key(widgets[0].xref, 'MK')[1])
            doc.xref_set_key(marker, 'Private', '(shared marker)')
            for widget in widgets[:2]:
                doc.xref_set_key(widget.xref, 'BS', f'{border} 0 R')
                doc.xref_set_key(widget.xref, 'MK', f'{marker} 0 R')
        source = changed(self.source, share)
        def snapshot(data):
            with pymupdf.open(stream=base64.b64decode(data), filetype='pdf') as doc:
                page = doc[0]; widgets = list(page.widgets())
                dictionaries = [[doc.xref_object(int(doc.xref_get_key(widget.xref, key)[1].split()[0]))
                                 for key in ('BS', 'MK')] for widget in widgets[:2]]
                return (dictionaries, appearance(doc, widgets[1]),
                        hashlib.sha256(page.get_pixmap(annots=False).samples).hexdigest(),
                        hashlib.sha256(page.get_pixmap(clip=widgets[1].rect).samples).hexdigest(),
                        hashlib.sha256(doc[1].get_pixmap().samples).hexdigest(),
                        [(widget.field_name, widget.field_value) for widget in widgets[1:]])
        expected = snapshot(source)
        for value in ('中文姓名', 'Second save'):
            result = fill(source, fields(source)[0], value)
            self.assertTrue(result['ok'], result)
            self.assertEqual(snapshot(result['base64']), expected)
            self.assertEqual(fields(result['base64'])[0]['value'], value)
            source = result['base64']

    def test_dashed_text_appearance_readonly_but_other_fields_still_editable(self):
        def dash(doc):
            widget = next(doc[0].widgets())
            doc.xref_set_key(widget.xref, 'BS', '<</W 1 /S /D /D [2.5 1.25]>>')
            ref = int(doc.xref_get_key(widget.xref, 'AP/N')[1].split()[0])
            # Actual saved appearance has the dashed border, not just its style.
            stream = doc.xref_stream(ref).replace(b'q\n', b'q\n[2.5 1.25] 0 d\n', 1)
            doc.update_stream(ref, stream)
        source = changed(self.source, dash)
        self.assert_rejected(source, '虚线')
        other = fields(source)[1]
        self.assertFalse(other['readonlyReason'])
        result = fill(source, other, 'Only this field')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
            bp, ap = before[0], after[0]; old, new = next(bp.widgets()), next(ap.widgets())
            self.assertEqual(appearance(before, old), appearance(after, new))
            self.assertEqual(before.xref_get_key(old.xref, 'BS'), after.xref_get_key(new.xref, 'BS'))
            self.assertEqual(bp.get_pixmap(clip=old.rect).samples, ap.get_pixmap(clip=new.rect).samples)

    def test_independent_widget_rotations_keep_transform_and_other_page(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                def rotate(doc):
                    page = doc[0]; widget = next(page.widgets())
                    doc.xref_set_key(widget.xref, 'MK/R', str(rotation)); widget.update()
                source = changed(self.source, rotate)
                result = fill(source, fields(source)[0], 'Changed name')
                self.assertTrue(result['ok'], result)
                with pymupdf.open(stream=base64.b64decode(source), filetype='pdf') as before, pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as after:
                    bp, ap = before[0], after[0]; old, new = next(bp.widgets()), next(ap.widgets())
                    self.assertEqual(before.xref_get_key(old.xref, 'MK'), after.xref_get_key(new.xref, 'MK'))
                    for key in ('Matrix', 'BBox'):
                        self.assertEqual(before.xref_get_key(old.xref, 'AP/N/' + key), after.xref_get_key(new.xref, 'AP/N/' + key))
                    self.assertEqual(bp.get_pixmap(annots=False).samples, ap.get_pixmap(annots=False).samples)
                    self.assertEqual(before[1].get_pixmap().samples, after[1].get_pixmap().samples)

    def test_rotated_crop_page_uses_document_coordinates(self):
        def crop(doc):
            page = doc[0]; page.set_cropbox(pymupdf.Rect(20, 20, 430, 530)); page.set_rotation(90)
        source = changed(self.source, crop); item = fields(source)[0]
        self.assertEqual(item['rect'], [15, 50, 290, 83])
        result = fill(source, item, 'Rotated form')
        self.assertTrue(result['ok'], result)
        with pymupdf.open(stream=base64.b64decode(result['base64']), filetype='pdf') as doc:
            self.assertEqual(doc[0].rotation, 90)
            self.assertIn('Rotated form', doc[0].get_text())
            self.assertEqual(list(next(doc[0].widgets()).rect), item['rect'])


if __name__ == '__main__':
    unittest.main()
