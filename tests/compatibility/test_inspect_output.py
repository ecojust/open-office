"""Real package/readback tests for the independent compatibility inspector.

Run: pdf-backend/.venv/bin/python -m unittest discover -s tests/compatibility -p 'test_*.py'
No browser, Office engine, network or user files are used.
"""
import importlib.util
import io
import json
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('compat_inspector', HERE / 'inspect-output.py')
inspector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inspector)
NS = inspector.NS


def package(parts):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in parts.items():
            z.writestr(name, value)
    return output.getvalue()


def relationship(items):
    return '<Relationships xmlns="' + NS['pr'] + '">' + ''.join(
        '<Relationship Id="' + rid + '" Type="' + NS['r'] + '/' + kind + '" Target="' + target + '"/>'
        for rid, kind, target in items) + '</Relationships>'


def ooxml(main, text, extras=None):
    parts = {'[Content_Types].xml': '<Types xmlns="' + NS['ct'] + '"/>',
             '_rels/.rels': relationship([('rId1', 'officeDocument', main)]), main: text}
    parts.update(extras or {})
    return package(parts)


def odf(kind, content, extras=None):
    parts = {'mimetype': 'application/vnd.oasis.opendocument.' + kind,
             'content.xml': '<office:document-content ' + ' '.join('xmlns:' + k + '="' + v + '"' for k, v in NS.items()) + '><office:body>' + content + '</office:body></office:document-content>'}
    parts.update(extras or {})
    return package(parts)


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='open-office-independent-inspection-')
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def inspect(self, data, filename='fixture.docx', **kwargs):
        path = self.root / filename
        path.write_bytes(data)
        return inspector.inspect(path, **kwargs)

    def rejected(self, data, code):
        report = self.inspect(data)
        self.assertFalse(report['ok'])
        self.assertEqual(report['inspection'], 'rejected')
        self.assertEqual(report['errors'][0]['code'], code)
        return report

    def test_path_traversal_and_absolute_paths_are_rejected_without_extracting(self):
        for name in ['../evil', '/tmp/evil', 'C:/evil', 'a\\evil', 'a/./evil', 'a//evil']:
            with self.subTest(name=name):
                self.rejected(package({name: 'x'}), 'UNSAFE_ZIP_PATH')

    def test_case_collisions_and_symlinks_are_rejected(self):
        self.rejected(package({'word/a.xml': '<a/>', 'word/A.xml': '<a/>'}), 'DUPLICATE_ZIP_PATH')
        info = zipfile.ZipInfo('link'); info.create_system = 3; info.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.rejected(package({info: '/etc/passwd'}), 'ZIP_SYMLINK')

    def test_encrypted_zip_flag_is_never_ignored(self):
        data = bytearray(package({'a.txt': 'hello'}))
        struct.pack_into('<H', data, 6, struct.unpack_from('<H', data, 6)[0] | 1)
        offset = data.index(b'PK\x01\x02')
        struct.pack_into('<H', data, offset + 8, struct.unpack_from('<H', data, offset + 8)[0] | 1)
        self.rejected(bytes(data), 'ENCRYPTED_ZIP')

    def test_expansion_and_entry_budgets_are_enforced_before_semantic_parsing(self):
        with patch.dict(inspector.LIMITS, expandedBytes=20):
            self.rejected(package({'a.txt': 'x' * 21}), 'ZIP_LIMIT')
        with patch.dict(inspector.LIMITS, zipEntries=1):
            self.rejected(package({'a': 'x', 'b': 'x'}), 'ZIP_LIMIT')

    def test_xml_dtd_in_utf8_and_utf16_and_custom_parts_is_rejected(self):
        value = '<!DOCTYPE a [<!ENTITY x "EXPANDED">]><a>&x;</a>'
        for encoding in ('utf-8', 'utf-16'):
            self.rejected(package({'custom.xml': value.encode(encoding)}), 'UNSAFE_XML')

    def test_malformed_and_deep_xml_are_rejected(self):
        self.rejected(package({'x.xml': '<root>'}), 'INVALID_XML')
        with patch.dict(inspector.LIMITS, xmlDepth=3):
            self.rejected(package({'x.xml': '<a><b><c><d/></c></b></a>'}), 'XML_LIMIT')

    def test_crc_corruption_is_rejected(self):
        data = bytearray(package({'x.txt': 'real data'}))
        offset = data.index(b'PK\x01\x02')
        struct.pack_into('<I', data, offset + 16, 0)
        self.rejected(bytes(data), 'INVALID_ZIP')

    def test_legacy_ole_is_explicitly_unsupported(self):
        result = self.inspect(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\0' * 504, 'old.doc')
        self.assertFalse(result['ok']); self.assertEqual(result['inspection'], 'unsupported')
        self.assertFalse(result['legacy']['contentParsed'])

    def test_actual_ooxml_root_wins_over_filename_extension(self):
        data = ooxml('word/main.xml', '<w:document xmlns:w="' + NS['w'] + '"><w:body><w:p><w:r><w:t>Actual Word</w:t></w:r></w:p></w:body></w:document>')
        result = self.inspect(data, 'not-a-spreadsheet.xlsx')
        self.assertTrue(result['ok']); self.assertEqual(result['format'], 'docx')
        self.assertIn('Actual Word', result['coreText']['strings'])
        self.assertEqual(result['zipSafety']['crcCheckedEntries'], 3)

    def test_word_comments_notes_headers_styles_and_tracked_text_are_real_parts(self):
        w = NS['w']
        main = f'<w:document xmlns:w="{w}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Original </w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>NEW</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>OLD</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        extras = {'word/_rels/document.xml.rels': relationship([('styles', 'styles', 'styles.xml'), ('c', 'comments', 'comments.xml'), ('n', 'footnotes', 'footnotes.xml'), ('h', 'header', 'header1.xml')]),
                  'word/styles.xml': f'<w:styles xmlns:w="{w}"><w:style w:styleId="Heading1" w:type="paragraph"><w:name w:val="Heading 1"/></w:style></w:styles>',
                  'word/comments.xml': f'<w:comments xmlns:w="{w}"><w:comment w:id="7"><w:p><w:r><w:t>Comment evidence</w:t></w:r></w:p></w:comment></w:comments>',
                  'word/footnotes.xml': f'<w:footnotes xmlns:w="{w}"><w:footnote w:id="3"><w:p><w:r><w:t>Footnote evidence</w:t></w:r></w:p></w:footnote></w:footnotes>',
                  'word/header1.xml': f'<w:hdr xmlns:w="{w}"><w:p><w:r><w:t>Header evidence</w:t></w:r></w:p></w:hdr>'}
        result = self.inspect(ooxml('word/document.xml', main, extras))
        self.assertTrue(result['ok']); word = result['word']
        self.assertEqual(word['paragraphs'][0]['text'], 'Original NEW')
        self.assertEqual(word['paragraphs'][0]['textIncludingDeleted'], 'Original NEWOLD')
        self.assertEqual(len(word['trackedChanges']), 2)
        self.assertEqual(word['tables'][0]['rows'][0][0]['columnSpan'], '2')
        self.assertEqual(word['styles'][0]['id'], 'Heading1')
        self.assertEqual(word['comments'][0]['id'], '7')
        self.assertEqual(word['footnotes'][0]['text'], 'Footnote evidence')
        self.assertEqual(word['headers'][0]['text'], 'Header evidence')

    def test_xlsx_order_cell_types_formulas_values_and_merges(self):
        s, r = NS['s'], NS['r']
        main = f'<workbook xmlns="{s}" xmlns:r="{r}"><sheets><sheet name="Second first" sheetId="2" r:id="r2"/><sheet name="First hidden" sheetId="1" state="hidden" r:id="r1"/></sheets></workbook>'
        sheet = f'<worksheet xmlns="{s}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(40,2)</f><v>42</v></c><c r="C1" t="inlineStr"><is><t>00123</t></is></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData><mergeCells><mergeCell ref="A2:C2"/></mergeCells></worksheet>'
        extras = {'xl/_rels/workbook.xml.rels': relationship([('r1', 'worksheet', 'worksheets/sheet1.xml'), ('r2', 'worksheet', 'worksheets/sheet2.xml'), ('str', 'sharedStrings', 'sharedStrings.xml')]),
                  'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{s}"/>', 'xl/worksheets/sheet2.xml': sheet,
                  'xl/sharedStrings.xml': f'<sst xmlns="{s}"><si><r><t>中文</t></r><r><t> rich</t></r></si></sst>'}
        result = self.inspect(ooxml('xl/workbook.xml', main, extras))
        self.assertTrue(result['ok']); sheets = result['spreadsheet']['sheets']
        self.assertEqual([v['name'] for v in sheets], ['Second first', 'First hidden'])
        cells = {c['address']: c for c in sheets[0]['cells']}
        self.assertEqual(cells['A1']['value'], '中文 rich')
        self.assertEqual((cells['B1']['type'], cells['B1']['formula'], cells['B1']['value']), ('formula', 'SUM(40,2)', 42))
        self.assertEqual((cells['C1']['type'], cells['C1']['value']), ('text', '00123'))
        self.assertIs(cells['D1']['value'], True)
        self.assertEqual(cells['E1']['value'], '#DIV/0!')
        self.assertEqual(sheets[0]['mergedRanges'], ['A2:C2'])

    def test_missing_internal_and_external_links_are_not_fetched(self):
        main = '<w:document xmlns:w="' + NS['w'] + '"><w:body/></w:document>'
        extras = {'word/_rels/document.xml.rels': '<Relationships xmlns="' + NS['pr'] + '"><Relationship Id="x" Type="' + NS['r'] + '/hyperlink" Target="https://example.invalid/not-fetched" TargetMode="External"/><Relationship Id="h" Type="' + NS['r'] + '/header" Target="missing.xml"/></Relationships>'}
        result = self.inspect(ooxml('word/document.xml', main, extras))
        self.assertFalse(result['zipSafety']['externalTargetsFetched'])
        self.assertEqual(result['features']['hyperlinks'], 1)
        self.assertIn('MISSING_RELATIONSHIP_TARGET', [x['code'] for x in result['warnings']])

    def test_odf_repeated_rows_typed_values_and_formula(self):
        body = '<office:spreadsheet><table:table table:name="Repeat"><table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>00123</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="42" table:formula="of:=SUM([.C1:.D1])"><text:p>42</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet>'
        result = self.inspect(odf('spreadsheet', body), 'repeat.ods')
        self.assertTrue(result['ok']); sheet = result['spreadsheet']['sheets'][0]
        self.assertEqual(sheet['cellCount'], 4)
        self.assertEqual([c['address'] for c in sheet['cells']], ['A1', 'B1', 'A2', 'B2'])
        self.assertEqual(sheet['cells'][1]['value'], 42)
        self.assertEqual(sheet['cells'][1]['formula'], 'of:=SUM([.C1:.D1])')

    def test_odf_text_spacing_notes_and_changes(self):
        body = '<office:text><text:h text:outline-level="1">Heading</text:h><text:p>A<text:s text:c="3"/>B<text:tab/>C<text:line-break/>D</text:p><text:note text:id="n1" text:note-class="footnote"><text:note-body><text:p>Footnote</text:p></text:note-body></text:note><text:tracked-changes><text:changed-region><text:deletion><text:p>Deleted</text:p></text:deletion></text:changed-region></text:tracked-changes></office:text>'
        result = self.inspect(odf('text', body), 'text.odt')
        self.assertTrue(result['ok'])
        self.assertEqual(result['word']['paragraphs'][1]['text'], 'A   B\tC\nD')
        self.assertEqual(result['features']['footnotes'], 1)
        self.assertEqual(result['features']['trackedChanges'], 1)

    def test_odt_review_and_note_scopes_never_pollute_visible_body_text(self):
        content = '<office:text><text:tracked-changes><text:changed-region text:id="deleted-1"><text:deletion><office:change-info><dc:creator>Reviewer</dc:creator><dc:date>2025-01-15</dc:date></office:change-info><text:p>OLD-REVISED-TEXT</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Review this proposal: <office:annotation office:name="comment-1"><dc:creator>Compatibility Author</dc:creator><dc:date>2025-01-15</dc:date><text:p>EDITOR-COMMENT</text:p></office:annotation>COMMENT-ANCHOR<office:annotation-end office:name="comment-1"/></text:p><text:p>Reference with footnote<text:note text:id="note-1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>FOOTNOTE-PERSISTENT</text:p></text:note-body></text:note> and a tail.</text:p></office:text>'
        report = self.inspect(odf('text', content), 'review-scopes.odt')
        self.assertTrue(report['ok'], report['errors'])
        word = report['word']
        self.assertEqual([p['text'] for p in word['paragraphs']], ['Review this proposal: COMMENT-ANCHOR', 'Reference with footnote and a tail.'])
        self.assertEqual(word['comments'], [{'name': 'comment-1', 'author': 'Compatibility Author', 'date': '2025-01-15', 'text': 'EDITOR-COMMENT'}])
        self.assertEqual(word['footnotes'], [{'id': 'note-1', 'kind': 'footnote', 'citation': '1', 'text': 'FOOTNOTE-PERSISTENT'}])
        self.assertEqual(word['trackedChanges'], [{'kind': 'deletion', 'id': 'deleted-1', 'author': 'Reviewer', 'date': '2025-01-15', 'text': 'OLD-REVISED-TEXT'}])
        self.assertIn('EDITOR-COMMENT', report['coreText']['strings'])
        self.assertIn('FOOTNOTE-PERSISTENT', report['coreText']['strings'])
        self.assertNotIn('OLD-REVISED-TEXT', report['coreText']['strings'])

    def test_existing_real_writer_odt_review_export_matches_source_body_scope(self):
        source_path = HERE / 'fixtures/generated/writer-review-footnotes.docx'
        output_path = HERE.parents[1] / 'test-results/compatibility/local-only-full/writer-review-footnotes/odt-cycle-1.odt'
        if not source_path.exists() or not output_path.exists():
            self.skipTest('The independently generated real-engine review round trip is not present.')
        source, output = inspector.inspect(source_path), inspector.inspect(output_path)
        self.assertTrue(source['ok'], source['errors']); self.assertTrue(output['ok'], output['errors'])
        source_text = [p['text'] for p in source['word']['paragraphs']]
        output_text = [p['text'] for p in output['word']['paragraphs']]
        for expected in ('Review this proposal: COMMENT-ANCHOR', 'Reference with footnote', 'Revision sample: NEW-REVISED-TEXT'):
            self.assertIn(expected, source_text)
            self.assertIn(expected, output_text)
        self.assertNotIn('OLD-REVISED-TEXT', output_text)
        self.assertEqual(output['word']['comments'][0]['text'], source['word']['comments'][0]['text'])
        source_notes = [note['text'] for note in source['word']['footnotes'] if 'FOOTNOTE-PERSISTENT' in note['text']]
        self.assertEqual([note['text'] for note in output['word']['footnotes']], source_notes)

    def test_reporting_limits_cannot_be_mistaken_for_complete_success(self):
        main = '<w:document xmlns:w="' + NS['w'] + '"><w:body><w:p><w:r><w:t>too much text</w:t></w:r></w:p></w:body></w:document>'
        with patch.dict(inspector.LIMITS, textCharacters=3):
            result = self.rejected(ooxml('word/document.xml', main), 'REPORT_LIMIT')
            self.assertTrue(result['truncated'])

    def test_rtf_unicode_hex_destinations_and_binary_objects(self):
        value = br'{\rtf1\ansi\ansicpg1252\uc1 {\fonttbl{\f0 hidden font;}}Hello \'e9 \u20013?\u25991?\par {\header Header text}{\footnote Footnote text}{\pict 001122}{\object{\objdata 0101}}Second}'
        result = self.inspect(value, 'rich.rtf')
        self.assertTrue(result['ok'])
        self.assertIn('Hello é 中文', result['word']['paragraphs'][0]['text'])
        self.assertNotIn('hidden font', ''.join(result['coreText']['strings']))
        self.assertEqual(result['features']['images'], 1)
        self.assertEqual(result['features']['embeddedObjects'], 1)
        self.assertEqual(result['word']['headers'][0]['text'], 'Header text')

    def test_rtf_unclosed_groups_are_rejected(self):
        self.rejected(br'{\rtf1 unfinished', 'INVALID_RTF')

    def test_rtf_cell_delimiters_are_blocks_but_literal_tabs_are_preserved(self):
        report = self.inspect(br'{\rtf1 Genuine\tab tab\par \trowd\cellx1000\cellx2000\intbl Item\cell Count\cell\row\trowd\cellx1000\cellx2000\intbl RTF-TABLE-SENTINEL\cell 42\cell\row}', 'cells.rtf')
        self.assertTrue(report['ok'], report['errors'])
        self.assertEqual([p['text'] for p in report['word']['paragraphs'] if p['text']], ['Genuine\ttab', 'Item', 'Count', 'RTF-TABLE-SENTINEL', '42'])
        self.assertEqual(report['word']['tables']['cellControlCount'], 4)

    def test_existing_real_rtf_exports_preserve_each_table_cell_text(self):
        source_path = HERE / 'fixtures/generated/writer-unicode-tables.rtf'
        output_folder = HERE.parents[1] / 'test-results/compatibility/local-only-full/writer-unicode-tables'
        if not source_path.exists() or not output_folder.exists():
            self.skipTest('The independent real-engine RTF round trip is not present.')
        source = inspector.inspect(source_path)
        expected = [p['text'] for p in source['word']['paragraphs'] if p['text']]
        self.assertIn('Item', expected); self.assertIn('Count', expected)
        for kind in ('docx', 'odt'):
            for cycle in range(1, 4):
                path = output_folder / (kind + '-cycle-' + str(cycle) + '.' + kind)
                if not path.exists():
                    continue
                output = inspector.inspect(path)
                self.assertTrue(output['ok'], output['errors'])
                actual = '\n'.join(p['text'] for p in output['word']['paragraphs'])
                offset = 0
                for value in expected:
                    found = actual.find(value, offset)
                    self.assertGreaterEqual(found, 0, (path.name, value))
                    offset = found + len(value)

    def test_odf_page_layout_properties_are_not_fake_header_objects(self):
        styles = '<office:document-styles ' + ' '.join('xmlns:' + k + '="' + v + '"' for k, v in NS.items()) + '><office:automatic-styles><style:page-layout style:name="Page"><style:header-style><style:header-footer-properties fo:margin="0cm"/></style:header-style><style:footer-style/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default"><style:header><text:p>REAL HEADER</text:p></style:header><style:footer><text:p>REAL FOOTER</text:p></style:footer></style:master-page></office:master-styles></office:document-styles>'
        report = self.inspect(odf('text', '<office:text><text:p>Body</text:p></office:text>', {'styles.xml': styles}), 'header-layout.odt')
        self.assertTrue(report['ok'], report['errors'])
        self.assertEqual(report['word']['headers'], [{'kind': 'header', 'text': 'REAL HEADER'}])
        self.assertEqual(report['word']['footers'], [{'kind': 'footer', 'text': 'REAL FOOTER'}])

    def test_odp_speaker_notes_are_distinct_from_visible_slide_text_and_in_core_text(self):
        data = odf('presentation', '<office:presentation><draw:page draw:name="One"><draw:frame><draw:text-box><text:p>Visible slide</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>COMPAT-EDIT-presentation-rich</text:p><text:p>Second note line</text:p></draw:text-box></draw:frame></presentation:notes></draw:page></office:presentation>')
        report = self.inspect(data, 'notes.odp')
        self.assertTrue(report['ok'], report['errors'])
        slide = report['presentation']['slides'][0]
        self.assertEqual(slide['texts'], ['Visible slide'])
        self.assertEqual(slide['notes'], [{'text': 'COMPAT-EDIT-presentation-rich\nSecond note line'}])
        self.assertIn('COMPAT-EDIT-presentation-rich', '\n'.join(report['coreText']['strings']))

    def test_empty_libreoffice_optional_accelerator_slot_is_not_document_xml(self):
        content = '<office:text><text:p>Real content remains parsed</text:p></office:text>'
        result = self.inspect(odf('text', content, {'Configurations2/accelerator/current.xml': b''}), 'config.odt')
        self.assertTrue(result['ok']); self.assertIn('Real content remains parsed', result['coreText']['strings'])
        self.assertIn('EMPTY_OPTIONAL_CONFIGURATION', [warning['code'] for warning in result['warnings']])
        self.rejected(odf('text', content, {'Configurations2/accelerator/current.xml': b'<broken'}), 'INVALID_XML')
        self.rejected(odf('text', content, {'content.xml': b''}), 'INVALID_XML')

    def test_xlsx_charts_and_conditional_rules_preserve_sources_and_indexed_values(self):
        path = HERE / 'fixtures/generated/calc-rich.xlsx'
        if not path.exists():
            self.skipTest('Shared generated XLSX fixture has not been created.')
        result = inspector.inspect(path)
        self.assertTrue(result['ok'], result['errors'])
        chart = result['package']['charts'][0]
        self.assertEqual(chart['chartTypes'], ['barChart'])
        self.assertEqual(chart['series'][0]['categories']['formula'], 'Data!$A$2:$A$5')
        self.assertEqual(chart['series'][0]['values']['formula'], 'Data!$D$2:$D$5')
        self.assertEqual([point['value'] for point in chart['series'][0]['values']['values']], ['80', '36', '40', '72'])
        linked = [item for sheet in result['spreadsheet']['sheets'] for item in sheet['charts']]
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0]['part'], chart['part'])
        rules = [rule for sheet in result['spreadsheet']['sheets'] for group in sheet['conditionalRules'] for rule in group['rules']]
        self.assertTrue(rules)
        self.assertTrue(any(rule['type'] == 'colorScale' and 'colorScale' in rule['xml'] for rule in rules))

    def test_pptx_slide_relationship_order_notes_and_embedded_media_digest(self):
        main = '<p:presentation xmlns:p="' + NS['p'] + '" xmlns:r="' + NS['r'] + '"><p:sldIdLst><p:sldId id="257" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst></p:presentation>'
        def slide(text):
            return '<p:sld xmlns:p="' + NS['p'] + '" xmlns:a="' + NS['a'] + '"><p:cSld name="' + text + '"><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:transition><p:fade/></p:transition><p:timing><p:animEffect transition="in" filter="fade"/></p:timing></p:sld>'
        import hashlib
        media = b'Independent embedded audio bytes'
        parts = {'ppt/_rels/presentation.xml.rels': relationship([('first', 'slide', 'slides/slide1.xml'), ('second', 'slide', 'slides/slide2.xml')]),
                 'ppt/slides/slide1.xml': slide('FIRST'), 'ppt/slides/slide2.xml': slide('SECOND'),
                 'ppt/slides/_rels/slide2.xml.rels': relationship([('sound', 'audio', '../media/sound.wav'), ('note', 'notesSlide', '../notesSlides/notesSlide2.xml')]),
                 'ppt/media/sound.wav': media,
                 'ppt/notesSlides/notesSlide2.xml': '<p:notes xmlns:p="' + NS['p'] + '" xmlns:a="' + NS['a'] + '"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Spoken NOTES</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'}
        report = self.inspect(ooxml('ppt/presentation.xml', main, parts), 'presentation.pptx')
        self.assertTrue(report['ok'], report['errors'])
        slides = report['presentation']['slides']
        self.assertEqual([slide['texts'] for slide in slides], [['SECOND'], ['FIRST']])
        self.assertEqual(slides[0]['notes'][0]['texts'], ['Spoken NOTES'])
        self.assertIn('Spoken NOTES', report['coreText']['strings'])
        self.assertEqual(slides[0]['media'][0]['sha256'], hashlib.sha256(media).hexdigest())
        self.assertEqual(slides[0]['transitions'][0]['effects'], ['fade'])
        self.assertEqual(slides[0]['animations'][0]['kind'], 'animEffect')

    def test_odp_editable_embedded_chart_resolves_real_object_and_cached_data(self):
        content = '<office:presentation><draw:page draw:name="One"><draw:frame><draw:object xlink:href="./Object 1"/></draw:frame></draw:page></office:presentation>'
        chart = '<office:document-content ' + ' '.join('xmlns:' + k + '="' + v + '"' for k, v in NS.items()) + '><office:body><office:chart><chart:chart chart:class="chart:bar"><chart:plot-area table:cell-range-address="Data.A1:B2"><chart:axis><chart:categories table:cell-range-address="Data.A2:A2"/></chart:axis><chart:series chart:values-cell-range-address="Data.B2:B2"/></chart:plot-area><table:table table:name="local-table"><table:table-row><table:table-cell office:value-type="string"><text:p>Revenue</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell></table:table-row></table:table></chart:chart></office:chart></office:body></office:document-content>'
        report = self.inspect(odf('presentation', content, {'Object 1/content.xml': chart}), 'chart.odp')
        self.assertTrue(report['ok'], report['errors'])
        item = report['presentation']['slides'][0]['charts'][0]
        self.assertEqual(item['part'], 'Object 1/content.xml')
        self.assertEqual(item['chartClass'], 'chart:bar')
        self.assertEqual(item['series'][0]['valuesRange'], 'Data.B2:B2')
        self.assertEqual(item['cachedTables'][0]['cells'][1]['value'], 42)

    def test_cli_outputs_only_valid_json_and_distinct_supported_unsupported_error_exit_codes(self):
        fixtures = [('valid.rtf', br'{\rtf1 text}', 0, 'parsed'), ('old.doc', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\0' * 512, 2, 'unsupported'), ('unsafe.zip', package({'../escape': 'forbidden'}), 1, 'rejected')]
        for name, data, status, inspection in fixtures:
            path = self.root / name; path.write_bytes(data)
            completed = subprocess.run([sys.executable, str(HERE / 'inspect-output.py'), str(path)], capture_output=True, text=True, timeout=10)
            self.assertEqual(completed.returncode, status)
            self.assertEqual(json.loads(completed.stdout)['inspection'], inspection)
            self.assertEqual(completed.stderr, '')

    def test_invalid_pdf_is_a_structured_rejection_not_an_uncaught_process_error(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest('PyMuPDF unavailable.')
        result = self.inspect(b'%PDF-1.7\nnot a complete PDF', 'broken.pdf')
        self.assertFalse(result['ok']); self.assertEqual(result['inspection'], 'rejected')
        self.assertEqual(result['errors'][0]['code'], 'INVALID_PDF')

    def test_generated_rich_fixtures_have_real_structural_features(self):
        for filename, format_, feature in [('writer-rich.docx', 'docx', 'tables'), ('calc-rich.xlsx', 'xlsx', 'charts'), ('presentation-rich.pptx', 'pptx', 'charts')]:
            path = HERE / 'fixtures/generated' / filename
            if not path.exists():
                continue
            result = inspector.inspect(path)
            self.assertTrue(result['ok'], result['errors']); self.assertEqual(result['format'], format_)
            self.assertGreaterEqual(result['features'][feature], 1)
            self.assertGreaterEqual(result['features']['images'], 1)

    def test_simple_and_complex_word_fields_are_read_in_body_headers_and_footers(self):
        tree = inspector.xml(('<w:p xmlns:w="' + NS['w'] + '"><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:instrText> NUMPAGES </w:instrText></w:r></w:p>').encode())
        self.assertEqual([field.strip() for field in inspector.word_fields(tree)], ['PAGE', 'NUMPAGES'])
        path = HERE / 'fixtures/generated/writer-rich.docx'
        if path.exists():
            result = inspector.inspect(path)
            self.assertTrue(result['ok'], result['errors'])
            self.assertIn('PAGE', [field.strip() for footer in result['word']['footers'] for field in footer['fields']])

    def test_word_dynamic_field_cache_does_not_replace_constant_footer_text(self):
        data = ('<w:ftr xmlns:w="' + NS['w'] + '"><w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>27</w:t></w:r></w:fldSimple><w:r><w:t> of </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>NUMPAGES</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>42</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t> protected footer</w:t></w:r></w:p></w:ftr>').encode()
        tree = inspector.xml(data)
        self.assertEqual(inspector.word_text_without_field_results(tree), 'Page  of  protected footer')
        self.assertEqual(inspector.word_fields(tree), ['PAGE', 'NUMPAGES'])

    def test_word_tab_stop_definitions_are_not_text_but_run_tabs_remain(self):
        tree = inspector.xml(('<w:hdr xmlns:w="' + NS['w'] + '"><w:p><w:pPr><w:tabs><w:tab w:val="clear" w:pos="709"/><w:tab w:val="right" w:pos="8506"/></w:tabs></w:pPr><w:r><w:t>Header</w:t><w:tab/><w:t>After real tab</w:t></w:r></w:p></w:hdr>').encode())
        self.assertEqual(inspector.plain_text(tree), 'Header\tAfter real tab')
        self.assertEqual(inspector.word_text_without_field_results(tree), 'Header\tAfter real tab')

    def test_odf_bitmap_fill_counts_only_referenced_live_styles(self):
        styles = '<office:document-styles ' + ' '.join('xmlns:' + k + '="' + v + '"' for k, v in NS.items()) + '><office:styles><draw:fill-image draw:name="Texture" xlink:href="Pictures/pattern.png"/><style:style style:name="Used" style:family="graphic"><style:graphic-properties draw:fill="bitmap" draw:fill-image-name="Texture"/></style:style><style:style style:name="Unused" style:family="graphic"><style:graphic-properties draw:fill="bitmap" draw:fill-image-name="Texture"/></style:style></office:styles></office:document-styles>'
        body = '<office:presentation><draw:page draw:name="Page"><draw:custom-shape draw:style-name="Used"/></draw:page></office:presentation>'
        report = self.inspect(odf('presentation', body, {'styles.xml': styles, 'Pictures/pattern.png': b'fixture-image-bytes'}), 'fill.odp')
        self.assertTrue(report['ok'], report['errors']); self.assertEqual(report['features']['images'], 1)
        self.assertEqual(report['odf']['imageReferences'][0]['kind'], 'bitmap-fill')
        self.assertEqual(report['odf']['imageReferences'][0]['styleName'], 'Used')
        no_reference = self.inspect(odf('presentation', '<office:presentation><draw:page draw:name="Page"/></office:presentation>', {'styles.xml': styles, 'Pictures/pattern.png': b'fixture-image-bytes'}), 'unused-fill.odp')
        self.assertEqual(no_reference['features']['images'], 0)

    def test_odf_embedded_ole_and_native_object_contents_are_independently_resolved(self):
        body = '<office:text><text:p><draw:frame><draw:object-ole xlink:href="./Obj1"/></draw:frame><draw:frame><draw:object xlink:href="./Object 2"/></draw:frame></text:p></office:text>'
        native = '<office:document-content xmlns:office="' + NS['office'] + '"><office:body><office:text/></office:body></office:document-content>'
        report = self.inspect(odf('text', body, {'Obj1': b'opaque-ole-bytes', 'Object 2/content.xml': native}), 'embedded.odt')
        self.assertTrue(report['ok'], report['errors']); self.assertEqual(report['features']['embeddedObjects'], 2)
        self.assertEqual([obj['part'] for obj in report['odf']['embeddedObjects']], ['Obj1', 'Object 2/content.xml'])
        self.assertTrue(all(obj['sha256'] and obj['bytes'] > 0 for obj in report['odf']['embeddedObjects']))
        missing = self.inspect(odf('text', body, {'Obj1': b'opaque-ole-bytes'}), 'missing-embedded.odt')
        self.assertEqual(missing['features']['embeddedObjects'], 1)
        self.assertIn('MISSING_RELATIONSHIP_TARGET', [warning['code'] for warning in missing['warnings']])

    def test_embedding_relationship_metadata_is_not_counted_as_another_document(self):
        main = '<w:document xmlns:w="' + NS['w'] + '"><w:body/></w:document>'
        report = self.inspect(ooxml('word/document.xml', main, {'word/embeddings/book.xlsx': b'opaque-workbook', 'word/embeddings/_rels/book.xlsx.rels': relationship([])}), 'embedding-metadata.docx')
        self.assertTrue(report['ok'], report['errors']); self.assertEqual(report['features']['embeddedObjects'], 1)
        self.assertEqual([item['part'] for item in report['package']['embeddedObjects']], ['word/embeddings/book.xlsx'])

    def test_pdf_actual_pages_text_and_bounded_previews(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest('Run with the existing pdf-backend/.venv Python for real PDF checks.')
        doc = pymupdf.open()
        for text in ['Independent page ONE', 'Independent page TWO']:
            page = doc.new_page(); page.insert_text((50, 70), text)
        data = doc.tobytes(); doc.close()
        result = self.inspect(data, 'proof.pdf', preview_dir=self.root / 'previews')
        self.assertTrue(result['ok']); self.assertEqual(result['pdf']['pageCount'], 2)
        self.assertIn('Independent page TWO', result['pdf']['pages'][1]['text'])
        self.assertEqual(len(list((self.root / 'previews').glob('*.png'))), 2)

    def test_pdf_password_and_copy_permissions_are_not_bypassed(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest('PyMuPDF unavailable.')
        doc = pymupdf.open(); doc.new_page()
        data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader', permissions=pymupdf.PDF_PERM_PRINT)
        self.rejected(data, 'PDF_PASSWORD_REQUIRED')
        no_open_password = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='', permissions=pymupdf.PDF_PERM_PRINT)
        result = self.inspect(no_open_password, 'protected.pdf')
        self.assertFalse(result['ok']); self.assertEqual(result['errors'][0]['code'], 'PDF_COPY_RESTRICTED')
        doc.close()


if __name__ == '__main__':
    unittest.main()
