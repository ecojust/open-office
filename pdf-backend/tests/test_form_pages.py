"""Page assembly must retain form roots and isolate copies when filled later."""
import base64
import hashlib
import re
import unittest
import pymupdf
import test_forms as forms


def opened(source):
    return pymupdf.open(stream=base64.b64decode(source), filetype='pdf')


def raster(page):
    return hashlib.sha256(page.get_pixmap().samples).hexdigest()


class FormPageTests(unittest.TestCase):
    def setUp(self):
        self.source = forms.fixture()

    def assert_flat_roots(self, source):
        with opened(source) as doc:
            widgets = [w.xref for p in doc for w in p.widgets() or []]
            kind, roots = doc.xref_get_key(doc.pdf_catalog(), 'AcroForm/Fields')
            self.assertEqual(kind, 'array')
            self.assertCountEqual([int(x) for x in re.findall(r'(\d+)\s+0\s+R', roots)], widgets)

    def test_extract_delete_reorder_preserve_widgets_pixels_and_filling(self):
        with opened(self.source) as doc:
            original = [raster(p) for p in doc]
        for operation, options, order in [('extract', {'pageIndices': [0]}, [0]), ('extract', {'pageIndices': [1]}, [1]),
                                          ('delete', {'pageIndices': [0]}, [1]), ('reorder', {'order': [1, 0]}, [1, 0])]:
            with self.subTest(operation=operation, order=order):
                result = forms.request(operation, self.source, **options)
                self.assertTrue(result['ok'], result)
                source = result['base64']; self.assert_flat_roots(source)
                with opened(source) as doc:
                    self.assertEqual([raster(p) for p in doc], [original[i] for i in order])
                item = forms.fields(source)[0]
                self.assertFalse(item['readonlyReason'], item)
                filled = forms.fill(source, item, 'After page operation')
                self.assertTrue(filled['ok'], filled)
                self.assertEqual(forms.fields(filled['base64'])[0]['value'], 'After page operation')
                self.assert_flat_roots(filled['base64'])

    def test_same_file_merged_twice_retains_independent_widgets(self):
        result = forms.request('merge', self.source, documents=[{'base64': self.source}, {'base64': self.source}])
        self.assertTrue(result['ok'], result)
        self.assertTrue(any('独立名称' in warning for warning in result['warnings']))
        source = result['base64']; self.assert_flat_roots(source)
        with opened(self.source) as original, opened(source) as doc:
            self.assertEqual([raster(p) for p in doc], [raster(original[i]) for i in (0, 1, 0, 1)])
            names = [w.field_name for p in doc for w in p.widgets() or []]
            self.assertEqual(len(names), 10); self.assertEqual(len(set(names)), 10)
            unaffected = [raster(doc[i]) for i in (0, 1, 3)]
        item = forms.fields(source, 2)[0]
        self.assertFalse(item['readonlyReason'], item)
        result = forms.fill(source, item, 'Copy only')
        self.assertTrue(result['ok'], result)
        with opened(result['base64']) as doc:
            self.assertEqual([raster(doc[i]) for i in (0, 1, 3)], unaffected)
            self.assertEqual(next(doc[0].widgets()).field_value, 'Original name')
            self.assertEqual(next(doc[2].widgets()).field_value, 'Copy only')
        self.assert_flat_roots(result['base64'])

    def test_global_defaults_materialized_separately_during_merge(self):
        sources = []
        for size, rgb, align in [(18, '.2 .6 .1', 2), (10, '.7 .1 .2', 0)]:
            def change(doc):
                doc.xref_set_key(next(doc[0].widgets()).xref, 'DA', 'null')
                doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/DA', f'(/Helv {size} Tf {rgb} rg)')
                doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/Q', str(align))
            source = forms.changed(self.source, change)
            self.assertIn('继承', forms.fields(source)[0]['readonlyReason'])
            sources.append(source)
        result = forms.request('merge', self.source, documents=[{'base64': x} for x in sources])
        self.assertTrue(result['ok'], result)
        with opened(result['base64']) as doc:
            for index, size, align in [(0, 18, 2), (2, 10, 0)]:
                page = doc[index]; widget = next(page.widgets())
                self.assertEqual(widget.text_fontsize, size)
                self.assertEqual(doc.xref_get_key(widget.xref, 'Q'), ('int', str(align)))
        item = forms.fields(result['base64'])[0]
        self.assertFalse(item['readonlyReason'], item)
        self.assertTrue(forms.fill(result['base64'], item, 'First style')['ok'])

    def test_complex_forms_reject_page_assembly_without_replacement(self):
        def orphaned_fields(doc):
            for page in doc:
                doc.xref_set_key(page.xref, 'Annots', '[]')
        mutations = [lambda doc: doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/XFA', '(xfa)'),
                     lambda doc: doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/CO', '[1 0 R]'),
                     lambda doc: doc.xref_set_key(next(doc[0].widgets()).xref, 'Kids', '[]'),
                     orphaned_fields]
        for mutation in mutations:
            source = forms.changed(self.source, mutation)
            for operation, options in [('extract', {'pageIndices': [0]}), ('reorder', {'order': [1, 0]}),
                                       ('merge', {'documents': [{'base64': source}, {'base64': self.source}]})]:
                result = forms.request(operation, source, **options)
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['error']['code'], 'FORM_PAGE_OPERATION_UNSUPPORTED')
                self.assertNotIn('base64', result)

    def test_empty_calculation_order_does_not_disable_plain_forms(self):
        source = forms.changed(self.source, lambda doc: doc.xref_set_key(doc.pdf_catalog(), 'AcroForm/CO', '[]'))
        item = forms.fields(source)[0]
        self.assertFalse(item['readonlyReason'], item)
        self.assertTrue(forms.fill(source, item, 'Allowed')['ok'])


if __name__ == '__main__':
    unittest.main()
