#!/usr/bin/env python3
"""Negative controls for the independent XML semantics auditor, no browser/runtime."""
import os,sys
sys.path=[p for p in sys.path if os.path.abspath(p)!=os.path.dirname(os.path.abspath(__file__))]
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile,ZIP_DEFLATED
from types import SimpleNamespace
import importlib.util,json,unittest
from lxml import etree as E
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('complex_pptx_audit',ROOT/'inspect.py');audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
manifest=json.loads((ROOT/'manifest.json').read_text())
def fixture(name):return next(item for item in manifest['items'] if item['id']==name)
def source(name):return audit.Package(ROOT/fixture(name)['path'])
def changed(package,part,mutate):
    parts=dict(package.parts);root=E.fromstring(parts[part]);mutate(root);parts[part]=E.tostring(root)
    stream=BytesIO()
    with ZipFile(stream,'w',ZIP_DEFLATED) as z:
        for name,data in parts.items():z.writestr(name,data)
    return audit.Package(stream.getvalue())
def compare(name,original,output,scenario='noop'):
    args=SimpleNamespace(scenario=scenario,slide_order=None,expected_edit_text=None,expected_notes=None,expected_color='#146CA4',expected_font_size=28,expected_dx=10,expected_dy=0,format_object_name=None)
    return audit.audit(original,output,fixture(name),args)
def recolor_nested(doc):
    shape=doc.xpath('.//p:sp[p:nvSpPr/p:cNvPr[@name="AFFINE_CHILD"]]',namespaces=audit.NS)[0]
    def color(parent,tag):
        pr=parent.find('{'+audit.NS['a']+'}'+tag)
        if pr is None:pr=E.Element('{'+audit.NS['a']+'}'+tag);parent.insert(0,pr)
        fill=E.SubElement(pr,'{'+audit.NS['a']+'}solidFill');E.SubElement(fill,'{'+audit.NS['a']+'}srgbClr',val='146CA4')
    for paragraph in shape.xpath('./p:txBody/a:p',namespaces=audit.NS):
        pr=E.Element('{'+audit.NS['a']+'}pPr');paragraph.insert(0,pr);color(pr,'defRPr')
        for run in paragraph.xpath('./a:r|./a:fld',namespaces=audit.NS):color(run,'rPr')
        end=E.SubElement(paragraph,'{'+audit.NS['a']+'}endParaRPr');fill=E.SubElement(end,'{'+audit.NS['a']+'}solidFill');E.SubElement(fill,'{'+audit.NS['a']+'}srgbClr',val='146CA4')
class InspectorControls(unittest.TestCase):
    def test_all_sources_parse_and_self_compare(self):
        for item in manifest['items']:
            with self.subTest(item=item['id']):
                package=source(item['id']);self.assertFalse(package.errors);self.assertTrue(compare(item['id'],package,package)['passed'])
    def test_changed_motion_path_is_detected_without_count_changes(self):
        name='motion-triggers-connectors';a=source(name)
        b=changed(a,a.slides[0],lambda doc:doc.xpath('.//p:animMotion',namespaces=audit.NS)[0].set('path','M 0 0 L 0.9 0.9 E'))
        self.assertFalse(b.errors);r=compare(name,a,b);self.assertFalse(r['passed']);self.assertTrue(any('motion path' in c['name'] and not c['passed'] for c in r['checks']))
    def test_valid_but_wrong_trigger_reference_is_detected(self):
        name='motion-triggers-connectors';a=source(name)
        def mutate(doc):
            target=doc.xpath('.//p:cNvPr[@name="CONNECTOR_DEST"]/@id',namespaces=audit.NS)[0]
            doc.xpath('.//p:cond/p:tgtEl/p:spTgt',namespaces=audit.NS)[0].set('spid',target)
        b=changed(a,a.slides[0],mutate);self.assertFalse(b.errors);self.assertFalse(compare(name,a,b)['passed'])
    def test_unchanged_element_counts_do_not_hide_rich_run_damage(self):
        name='typography-rich';a=source(name)
        b=changed(a,a.slides[0],lambda doc:doc.xpath('.//a:rPr[@sz]',namespaces=audit.NS)[1].set('sz','1400'))
        self.assertFalse(compare(name,a,b)['passed'])
    def test_picture_crop_value_damage_is_detected(self):
        name='nested-groups-images';a=source(name)
        b=changed(a,a.slides[0],lambda doc:doc.xpath('.//a:srcRect',namespaces=audit.NS)[0].set('l','31000'))
        self.assertFalse(compare(name,a,b)['passed'])
    def test_dangling_shape_reference_is_detected(self):
        name='motion-triggers-connectors';a=source(name)
        b=changed(a,a.slides[0],lambda doc:doc.xpath('.//a:stCxn',namespaces=audit.NS)[0].set('id','999999'))
        self.assertTrue(any(e['kind']=='dangling_shape_reference' for e in b.errors))
    def test_diagram_byte_tampering_is_detected(self):
        name='poi-smartart-venn';a=source(name);part=next(p for p in a.parts if p.startswith('ppt/diagrams/data') and p.endswith('.xml'))
        b=changed(a,part,lambda doc:doc.set('auditChanged','true'))
        self.assertFalse(compare(name,a,b)['passed'])
    def test_format_color_preserves_unrelated_run_fields_and_styles(self):
        name='typography-rich';a=source(name)
        def recolor(doc):
            shape=doc.xpath('.//p:sp[p:nvSpPr/p:cNvPr[@name="RICH_RUNS"]]',namespaces=audit.NS)[0]
            for run in shape.xpath('.//a:r|.//a:fld',namespaces=audit.NS):
                pr=run.find('{'+audit.NS['a']+'}rPr')
                if pr is None:pr=E.Element('{'+audit.NS['a']+'}rPr');run.insert(0,pr)
                for fill in pr.findall('{'+audit.NS['a']+'}solidFill'):pr.remove(fill)
                fill=E.SubElement(pr,'{'+audit.NS['a']+'}solidFill');E.SubElement(fill,'{'+audit.NS['a']+'}srgbClr',val='146CA4')
        b=changed(a,a.slides[0],recolor);self.assertTrue(compare(name,a,b,'format-color')['passed'])
        c=changed(b,b.slides[0],lambda doc:doc.xpath('.//p:sp[p:nvSpPr/p:cNvPr[@name="RICH_RUNS"]]//a:rPr[@b]',namespaces=audit.NS)[0].set('b','0'))
        self.assertFalse(compare(name,a,c,'format-color')['passed'])
    def test_affine_group_move_preserves_original_children_and_coordinate_system(self):
        name='affine-group-mc-custom';a=source(name)
        def move(doc):
            off=doc.xpath('.//p:grpSp[p:nvGrpSpPr/p:cNvPr[@name="AFFINE_GROUP"]]/p:grpSpPr/a:xfrm/a:off',namespaces=audit.NS)[0];off.set('x',str(int(off.get('x'))+360000))
        b=changed(a,a.slides[0],move)
        self.assertTrue(compare(name,a,b,'move-object')['passed'])
        def damage(doc):doc.xpath('.//p:sp[p:nvSpPr/p:cNvPr[@name="AFFINE_CHILD"]]/p:spPr/a:xfrm',namespaces=audit.NS)[0].set('rot','0')
        c=changed(b,b.slides[0],damage)
        self.assertFalse(compare(name,a,c,'move-object')['passed'])
    def test_nested_requested_color_allows_only_empty_property_wrappers(self):
        name='affine-group-mc-custom';a=source(name);b=changed(a,a.slides[0],recolor_nested)
        self.assertTrue(compare(name,a,b,'nested-format-color')['passed'])
        self.assertFalse(compare(name,a,b,'noop')['passed'])
    def test_nested_requested_color_still_detects_unrelated_damage(self):
        name='affine-group-mc-custom';a=source(name);b=changed(a,a.slides[0],recolor_nested)
        target='.//p:sp[p:nvSpPr/p:cNvPr[@name="AFFINE_CHILD"]]'
        def field_damage(doc):
            run=doc.xpath(target+'//a:r',namespaces=audit.NS)[0]
            run.tag='{'+audit.NS['a']+'}fld';run.set('id','{00000000-0000-0000-0000-000000000001}');run.set('type','slidenum')
        def sibling_color_damage(doc):
            shape=doc.xpath('.//p:sp[p:nvSpPr/p:cNvPr[@name="AFFINE_SECOND"]]',namespaces=audit.NS)[0]
            run=shape.xpath('.//a:r',namespaces=audit.NS)[0];pr=E.Element('{'+audit.NS['a']+'}rPr');run.insert(0,pr)
            fill=E.SubElement(pr,'{'+audit.NS['a']+'}solidFill');E.SubElement(fill,'{'+audit.NS['a']+'}srgbClr',val='146CA4')
        mutations={
            'bodyPr':lambda doc:doc.xpath(target+'/p:txBody/a:bodyPr',namespaces=audit.NS)[0].set('anchor','b'),
            'childTransform':lambda doc:doc.xpath(target+'/p:spPr/a:xfrm/a:off',namespaces=audit.NS)[0].set('x','123'),
            'otherShapeColor':sibling_color_damage,
            'fieldStructure':field_damage,
        }
        for label,mutate in mutations.items():
            with self.subTest(damage=label):
                c=changed(b,b.slides[0],mutate);self.assertFalse(c.errors)
                self.assertFalse(compare(name,a,c,'nested-format-color')['passed'])
    def test_mc_scope_checks_requires_namespace_and_allows_exclusive_branch_ids(self):
        name='affine-group-mc-custom';a=source(name)
        self.assertFalse(a.errors)
        b=changed(a,a.slides[0],lambda doc:E.cleanup_namespaces(doc))
        self.assertTrue(any(e['kind']=='undeclared_mc_requires_prefix' for e in b.errors))
if __name__=='__main__':unittest.main()
