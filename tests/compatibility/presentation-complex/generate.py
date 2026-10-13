#!/usr/bin/env python3
"""Original OOXML stress fixtures with fixed corpus digests and top-level ZIP timestamps. Not Office-authored samples. SPDX-License-Identifier: MIT"""
import os, sys
# Avoid shadowing Python's standard inspect module with this CLI's filename.
sys.path = [entry for entry in sys.path if os.path.abspath(entry) != os.path.dirname(os.path.abspath(__file__))]
from pathlib import Path
from datetime import datetime
from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED
from io import BytesIO
import copy,hashlib,json
from lxml import etree as E
from PIL import Image,ImageDraw
from pptx import Presentation
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN,MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE,MSO_CONNECTOR
from pptx.enum.chart import XL_CHART_TYPE
from pptx.chart.data import CategoryChartData
from pptx.oxml.xmlchemy import OxmlElement

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'fixtures/generated'
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
STAMP=datetime(2025,2,12,12,0,0)
ITEMS=[]
def el(tag,**attrs):
    n=OxmlElement(tag)
    for k,v in attrs.items():n.set(k,str(v))
    return n
def new(title,slides=1):
    p=Presentation();p.slide_width=Inches(13.333333);p.slide_height=Inches(7.5)
    p.core_properties.title=title;p.core_properties.author='Open Office original compatibility fixtures';p.core_properties.subject='Synthetic OOXML; not Microsoft Office authored';p.core_properties.created=STAMP;p.core_properties.modified=STAMP
    for i in range(slides):
        slide=p.slides.add_slide(p.slide_layouts[6]);textbox(slide,'SAFE_EDIT',f'{title} / SAFE_EDIT / page {i+1}',.35,6.95,12,.3,12)
        slide.notes_slide.notes_text_frame.text=f'{title} / ORIGINAL-NOTE-{i+1}'
    return p

def textbox(slide,name,text,x,y,w,h,size=24):
    shape=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h));shape.name=name
    shape.text=text
    for paragraph in shape.text_frame.paragraphs:
        for run in paragraph.runs:run.font.size=Pt(size)
    return shape

def graphic(shape,name,fill='DCE8FF'):
    shape.name=name;shape.fill.solid();shape.fill.fore_color.rgb=RGBColor.from_string(fill)
    return shape

def png():
    im=Image.new('RGBA',(240,120),(245,248,252,220));d=ImageDraw.Draw(im)
    d.rectangle((0,0,79,119),fill=(220,30,60,255));d.ellipse((75,10,160,95),fill=(20,170,90,180));d.rectangle((170,10,230,105),fill=(30,80,230,100))
    stream=BytesIO();im.save(stream,'PNG');return stream.getvalue()

def normalize(path,patch=None):
    with ZipFile(path) as z:parts={n:z.read(n) for n in z.namelist()}
    if patch:patch(parts)
    with ZipFile(path,'w') as z:
        for name,data in sorted(parts.items()):
            info=ZipInfo(name,(2025,2,12,12,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data)

def save(p,name,features,protected,patch=None,animation=False):
    path=OUT/(name+'.pptx');p.save(path);normalize(path,patch)
    data=path.read_bytes()
    item={'id':name,'path':str(path.relative_to(ROOT)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'provenance':{'kind':'generated','license':'MIT','generator':'generate.py','producerDeclared':'Original python-pptx + explicit OOXML fixture; not Office/WPS/LibreOffice-authored','reproducibleTimestamp':STAMP.isoformat()+'Z'},'expected':{'slides':len(p.slides),'textIncludes':[name],'unsupportedFeatures':features,'protectedShapes':protected},'screenshots':[0],'editPageIndex':0,'editObjectName':'SAFE_EDIT','preserveParts':['ppt/media/*','ppt/charts/*','ppt/embeddings/*','ppt/slideMasters/*','ppt/slideLayouts/*','ppt/theme/*','ppt/diagrams/*']}
    if animation:
        item['animationTarget']={'slideIndex':0,'shapeName':'ANIMATED_TARGET'}
        item['animationTrigger']={'slideIndex':0,'shapeName':'TRIGGER_BUTTON'}
    if name=='typography-rich':item.update(formatObjectName='RICH_RUNS',formatSlideIndex=0)
    if name=='nested-groups-images':item['duplicateObjectName']='CONNECTED_GROUP'
    if name=='affine-group-mc-custom':item.update(moveObjectName='AFFINE_GROUP',copySelectionNames=['FREE_A','FREE_B','FREE_CONNECTOR'],codecNestedFormatObjectName='AFFINE_CHILD',codecNestedFormatSlideIndex=0)
    ITEMS.append(item)

def typography():
    name='typography-rich';p=new(name);s=p.slides[0]
    shape=textbox(s,'RICH_RUNS','',.6,.4,11.8,3.2);tf=shape.text_frame;tf.margin_left=Inches(.18);tf.margin_right=Inches(.31)
    para=tf.paragraphs[0];para.alignment=PP_ALIGN.CENTER;para.space_before=Pt(9);para.space_after=Pt(14);para.line_spacing=1.35
    for text,font,size,color,bold,italic in [('Rich run 文字 ','Arial',30,'B51D46',True,False),('mix ± ∑ ','Cambria',21,'1565A8',False,True),('大标题','Noto Sans CJK SC',42,'248046',True,False)]:
        r=para.add_run();r.text=text;r.font.name=font;r.font.size=Pt(size);r.font.bold=bold;r.font.italic=italic;r.font.color.rgb=RGBColor.from_string(color)
    field=el('a:fld',id='{12345678-1234-1234-1234-123456789ABC}',type='slidenum');field.append(el('a:rPr',lang='en-US',sz='1800'));ft=el('a:t');ft.text='1';field.append(ft);para._p.append(field)
    para.runs[0].hyperlink.address='https://example.invalid/rich-run'
    q=tf.add_paragraph();q.text='Paragraph with tab\tsecond column and manual break\n下一行';q.alignment=PP_ALIGN.RIGHT;q.space_before=Pt(6);q.space_after=Pt(17);q.line_spacing=Pt(34)
    r=q.runs[0];r.font.size=Pt(18);r.font.underline=True;r._r.get_or_add_rPr().set('baseline','18000');r._r.get_or_add_rPr().set('spc','120')
    bullets=textbox(s,'BULLETS','Nested bullet one\nNested bullet two\n编号列表',.8,4,10,2.1,23)
    for i,para in enumerate(bullets.text_frame.paragraphs):
        para.level=i%2;pr=para._p.get_or_add_pPr();pr.set('marL',str(320000+i*160000));pr.set('indent','-160000');pr.append(el('a:buChar',char='•' if i<2 else '➤'))
    save(p,name,['mixed-runs','superscript','character-spacing','paragraph-spacing','bullets-tabs'],['RICH_RUNS','BULLETS'])

def layout():
    name='text-layout-vertical';p=new(name);s=p.slides[0]
    defs=[('TOP_ZERO',.5,.4,3.7,2.6,'t','0','0','0','0',None,None),('CENTER_ASYM',4.8,.4,3.7,2.6,'ctr','170000','420000','95000','230000',None,None),('BOTTOM_NOWRAP',9,.4,3.7,2.6,'b','220000','60000','320000','0',None,None),('ROTATED_POS',.5,3.65,3.7,2.7,'ctr','0','0','0','0','5400000',None),('ROTATED_NEG',4.8,3.65,3.7,2.7,'ctr','90000','190000','210000','70000','-5400000',None),('EAST_ASIAN_VERTICAL',9,3.65,3.7,2.7,'t','90000','90000','50000','50000',None,'eaVert')]
    for name2,x,y,w,h,anchor,l,r,t,b,rot,vert in defs:
        shape=textbox(s,name2,'Text layout\n中文布局测试',x,y,w,h,24);graphic(shape,name2,'ECF4FA');body=shape.text_frame._txBody.bodyPr
        for k,v in {'anchor':anchor,'lIns':l,'rIns':r,'tIns':t,'bIns':b,'wrap':'none' if name2=='BOTTOM_NOWRAP' else 'square'}.items():body.set(k,v)
        if rot:body.set('rot',rot)
        if vert:body.set('vert',vert)
    save(p,name,['anchor-insets','no-wrap','body-rotation','east-asian-vertical'],[d[0] for d in defs])

def groups():
    name='nested-groups-images';p=new(name);s=p.slides[0]
    outer=s.shapes.add_group_shape();outer.name='OUTER_GROUP';inner=outer.shapes.add_group_shape();inner.name='INNER_GROUP'
    rect=graphic(inner.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,Inches(1),Inches(1),Inches(3),Inches(1.5)),'GROUP_RECT');rect.text='Nested rotation / preserve children'
    pic=inner.shapes.add_picture(BytesIO(png()),Inches(1.2),Inches(2.8),Inches(4),Inches(2));pic.name='CROPPED_FLIPPED_IMAGE';pic.crop_left=.15;pic.crop_right=.1;pic.crop_top=.08;pic.crop_bottom=.12
    xfrm=pic._element.spPr.xfrm;xfrm.set('flipH','1');pic._element.blipFill.blip.append(el('a:alphaModFix',amt='68000'))
    inner.rotation=18;outer.shapes.add_shape(MSO_SHAPE.OVAL,Inches(6),Inches(1),Inches(2),Inches(2)).name='GROUP_ELLIPSE';outer.shapes._recalculate_extents();outer.rotation=-8
    direct=s.shapes.add_picture(BytesIO(png()),Inches(8.5),Inches(2.3),Inches(3.6),Inches(1.8));direct.name='ALPHA_CROP_IMAGE';direct.crop_left=.1;direct.crop_bottom=.2;direct._element.blipFill.blip.append(el('a:alphaModFix',amt='40000'))
    connected=s.shapes.add_group_shape();connected.name='CONNECTED_GROUP'
    a=graphic(connected.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(8),Inches(.3),Inches(1.7),Inches(.7)),'CONNECT_A')
    b=graphic(connected.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(10.5),Inches(.3),Inches(1.7),Inches(.7)),'CONNECT_B')
    conn=connected.shapes.add_connector(MSO_CONNECTOR.STRAIGHT,a.left+a.width,a.top+a.height//2,b.left,b.top+b.height//2);conn.name='GROUP_CONNECTOR';conn.begin_connect(a,2);conn.end_connect(b,0)
    save(p,name,['nested-groups','group-rotation','picture-crop','picture-flip','alpha'],['OUTER_GROUP','ALPHA_CROP_IMAGE','CONNECTED_GROUP'])

def tables():
    name='merged-styled-tables';p=new(name);s=p.slides[0]
    shape=s.shapes.add_table(4,4,Inches(.6),Inches(.8),Inches(12),Inches(5.5));shape.name='MERGED_TABLE';table=shape.table
    for i,row in enumerate(table.rows):
        row.height=Inches([.7,1.4,1.6,1.8][i])
        for j,cell in enumerate(row.cells):
            cell.text=f'CELL-{i+1}-{j+1}\n中文';cell.margin_left=Inches(.07+j*.035);cell.margin_top=Inches(.05+i*.025);cell.fill.solid();cell.fill.fore_color.rgb=RGBColor(230-i*15,235-j*15,245-i*8)
    table.cell(0,0).merge(table.cell(0,3));table.cell(0,0).text='MERGED HEADER / 四列合并'
    table.cell(1,0).merge(table.cell(2,0));table.cell(1,0).text='VERTICAL MERGE'
    tc=table.cell(3,2)._tc.get_or_add_tcPr();tc.set('vert','vert270');tc.set('anchor','ctr');line=el('a:lnB',w='25400');fill=el('a:solidFill');fill.append(el('a:srgbClr',val='D51E3E'));line.append(fill);tc.append(line)
    save(p,name,['merged-cells','nonuniform-rows','cell-margins','vertical-cell-text','cell-borders'],['MERGED_TABLE'])

def charts():
    name='combo-and-doughnut-charts';p=new(name);s=p.slides[0]
    data=CategoryChartData();data.categories=['Alpha','Beta','Gamma'];data.add_series('Revenue',[12.5,27,19]);data.add_series('Trend',[6,18,24])
    frame=s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,Inches(.45),Inches(.7),Inches(7.5),Inches(5.7),data);frame.name='COMBO_CHART';chart=frame.chart;chart.has_title=True;chart.chart_title.text_frame.text='Combo bars + line / 图表缓存'
    plot=chart._chartSpace.find('.//{'+NS['c']+'}plotArea');bar=plot.find('{'+NS['c']+'}barChart');series=bar.findall('{'+NS['c']+'}ser');line=el('c:lineChart');line.append(el('c:grouping',val='standard'));line.append(series[1]);bar.remove(series[1]) if series[1].getparent() is bar else None
    for axis in bar.findall('{'+NS['c']+'}axId'):line.append(copy.deepcopy(axis))
    plot.insert(1,line)
    d=CategoryChartData();d.categories=['产品 A','产品 B','产品 C'];d.add_series('Mix',[30,45,25]);ring=s.shapes.add_chart(XL_CHART_TYPE.DOUGHNUT,Inches(8.15),Inches(1.2),Inches(4.8),Inches(4.8),d);ring.name='DOUGHNUT_CHART';ring.chart.has_title=True;ring.chart.chart_title.text_frame.text='Product composition'
    save(p,name,['combination-chart','doughnut-chart','editable-xlsx-workbooks','cached-series'],['COMBO_CHART','DOUGHNUT_CHART'])

def animations():
    name='motion-triggers-connectors';p=new(name,2);s=p.slides[0]
    target=graphic(s.shapes.add_shape(MSO_SHAPE.ROUND_2_SAME_RECTANGLE,Inches(2.2),Inches(2),Inches(3.1),Inches(1.7)),'ANIMATED_TARGET');target.text='MOTION TARGET'
    trigger=graphic(s.shapes.add_shape(MSO_SHAPE.OVAL,Inches(.6),Inches(3.8),Inches(2),Inches(1.2)),'TRIGGER_BUTTON','F3DACA');trigger.text='CLICK TRIGGER'
    end=graphic(s.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(9),Inches(2.8),Inches(2.8),Inches(1.7)),'CONNECTOR_DEST');end.text='DESTINATION'
    connector=s.shapes.add_connector(MSO_CONNECTOR.ELBOW,target.left+target.width,target.top+target.height//2,end.left,end.top+end.height//2);connector.name='BOUND_CONNECTOR';connector.begin_connect(target,2);connector.end_connect(end,0)
    link=textbox(s,'INTERNAL_SLIDE_LINK','Jump to second slide',7.2,.8,4.5,.5,22);link.click_action.target_slide=p.slides[1]
    textbox(p.slides[1],'TARGET_SLIDE_TEXT','LINK TARGET / duplicate and reorder stability',1,1,11,2,30)
    safe=target.shape_id;button=trigger.shape_id
    timing=f'''<p:timing xmlns:p="{NS['p']}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" presetID="1" presetClass="path" nodeType="clickEffect" fill="hold"><p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="{button}"/></p:tgtEl></p:cond></p:stCondLst><p:childTnLst><p:animMotion origin="layout" path="M 0 0 L 0.25 0.10 C 0.30 0.10 0.40 0.30 0.45 0.20 E" pathEditMode="relative" rAng="0"><p:cBhvr additive="base"><p:cTn id="4" dur="1800" fill="hold"/><p:tgtEl><p:spTgt spid="{safe}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr></p:animMotion><p:animRot by="5400000"><p:cBhvr additive="base"><p:cTn id="5" dur="700" fill="hold"/><p:tgtEl><p:spTgt spid="{safe}"/></p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="{safe}" grpId="0" build="allAtOnce"/></p:bldLst></p:timing>'''
    s._element.append(E.fromstring(timing))
    save(p,name,['motion-path','onClick-trigger','rotation-animation','build-list','bound-connector','internal-slide-link'],['ANIMATED_TARGET','TRIGGER_BUTTON','CONNECTOR_DEST','BOUND_CONNECTOR','INTERNAL_SLIDE_LINK'],animation=True)

def links():
    name='slide-links-inheritance';p=new(name,3)
    for i,s in enumerate(p.slides):
        textbox(s,'PAGE_MARKER',f'REFERENCED-PAGE-{i+1}',.8,.8,11,1,32)
        link=textbox(s,'LINK_TO_FIRST' if i else 'LINK_TO_LAST','Internal slide jump',1,2.2,10,.7,25);link.click_action.target_slide=p.slides[0 if i else 2]
        external=textbox(s,'EXTERNAL_LINK','example.invalid / never load',1,3.3,10,.7,24);external.text_frame.paragraphs[0].runs[0].hyperlink.address='https://example.invalid/complex-fixture'
    p.slides[1]._element.set('show','0')
    def patch(parts):
        master=E.fromstring(parts['ppt/slideMasters/slideMaster1.xml']);tree=master.find('.//{'+NS['p']+'}spTree')
        logo=copy.deepcopy(p.slides[0].shapes[1]._element);logo.find('.//{'+NS['p']+'}cNvPr').set('id','450');logo.find('.//{'+NS['p']+'}cNvPr').set('name','MASTER_LOGO')
        for text in logo.findall('.//{'+NS['a']+'}t'):text.text='INHERITED LOGO'
        off=logo.find('.//{'+NS['a']+'}off');off.set('x','8500000');off.set('y','5700000');tree.append(logo);parts['ppt/slideMasters/slideMaster1.xml']=E.tostring(master,xml_declaration=True,encoding='UTF-8',standalone=True)
        doc=E.fromstring(parts['ppt/presentation.xml']);ids=doc.find('{'+NS['p']+'}sldIdLst');rels=[entry.get('{'+NS['r']+'}id') for entry in ids]
        shows=E.Element('{'+NS['p']+'}custShowLst');show=E.SubElement(shows,'{'+NS['p']+'}custShow',name='Repeated references',id='0');lst=E.SubElement(show,'{'+NS['p']+'}sldLst')
        for rid in [rels[0],rels[2],rels[0],rels[1]]:E.SubElement(lst,'{'+NS['p']+'}sld',{'{'+NS['r']+'}id':rid})
        doc.insert(list(doc).index(doc.find('{'+NS['p']+'}defaultTextStyle')),shows);parts['ppt/presentation.xml']=E.tostring(doc,xml_declaration=True,encoding='UTF-8',standalone=True)
    save(p,name,['internal-slide-links','external-link-disabled','custom-show-repeated-slide','hidden-slide','master-inheritance'],['PAGE_MARKER','LINK_TO_FIRST','LINK_TO_LAST','EXTERNAL_LINK'],patch)

def placeholder_inheritance():
    name='placeholder-inheritance';p=Presentation();p.slide_width=Inches(13.333333);p.slide_height=Inches(7.5)
    p.core_properties.created=STAMP;p.core_properties.modified=STAMP;p.core_properties.title=name
    s=p.slides.add_slide(p.slide_layouts[1]);title=s.shapes.title;title.name='INHERITED_TITLE';title.text='Partial xfrm / inherited bodyPr 中文'
    props=title._element.spPr
    for node in list(props):props.remove(node)
    props.append(el('a:xfrm',rot='1800000'))
    body=title.text_frame._txBody.bodyPr;body.attrib.clear();body.set('wrap','none');body.set('rot','-5400000')
    textbox(s,'SAFE_EDIT',name+' / SAFE_EDIT',.35,6.95,12,.3,12);s.notes_slide.notes_text_frame.text='Inherited layout test notes'
    layout_title=p.slide_layouts[1].placeholders[0]
    xfrm=layout_title._element.spPr.get_or_add_xfrm();xfrm.set('rot','0')
    for node in list(xfrm):xfrm.remove(node)
    xfrm.append(el('a:off',x='600000',y='500000'));xfrm.append(el('a:ext',cx='9000000',cy='1800000'))
    lb=layout_title.text_frame._txBody.bodyPr;lb.attrib.clear();lb.set('rIns','410000')
    master_title=p.slide_master.placeholders[0]
    mb=master_title.text_frame._txBody.bodyPr;mb.attrib.clear();mb.set('anchor','ctr');mb.set('lIns','310000');mb.set('tIns','140000')
    save(p,name,['partial-transform-inheritance','bodyPr-per-attribute-inheritance','own-rotation-layout-offset'],['INHERITED_TITLE'])

def affine_group_mc():
    name='affine-group-mc-custom';p=new(name);s=p.slides[0]
    group=s.shapes.add_group_shape();group.name='AFFINE_GROUP'
    shape=graphic(group.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(1),Inches(1),Inches(2.2),Inches(1.5)),'AFFINE_CHILD');shape.text='Rotated child / 非均匀缩放';shape.rotation=28
    second=graphic(group.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(4),Inches(2),Inches(2.4),Inches(1.2)),'AFFINE_SECOND','FCE5D5');second.text='Preserve local xfrm'
    xf=group._element.grpSpPr.xfrm;xf.ext.set('cx',str(int(int(xf.ext.get('cx'))*1.4)));xf.ext.set('cy',str(int(int(xf.ext.get('cy'))*.65)));group.rotation=12
    free_a=graphic(s.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(.7),Inches(5.65),Inches(1.7),Inches(.7)),'FREE_A')
    free_b=graphic(s.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(4.7),Inches(5.65),Inches(1.7),Inches(.7)),'FREE_B')
    free=s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT,free_a.left+free_a.width,free_a.top+free_a.height//2,free_b.left,free_b.top+free_b.height//2);free.name='FREE_CONNECTOR';free.begin_connect(free_a,2);free.end_connect(free_b,0)
    custom=graphic(s.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(8.9),Inches(3.9),Inches(3.3),Inches(1.5)),'CUSTOM_BEZIER_ROOT');custom.text='Custom Bézier path'
    sppr=custom._element.spPr;sppr.remove(sppr.find('{'+NS['a']+'}prstGeom'))
    geom=E.fromstring(f'<a:custGeom xmlns:a="{NS["a"]}"><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst><a:path w="21600" h="21600"><a:moveTo><a:pt x="0" y="21600"/></a:moveTo><a:cubicBezTo><a:pt x="0" y="0"/><a:pt x="21600" y="0"/><a:pt x="21600" y="21600"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom>');sppr.insert(1,geom)
    def patch(parts):
        part='ppt/slides/slide1.xml';old=E.fromstring(parts[part]);nsmap=dict(old.nsmap);nsmap.update(mc='http://schemas.openxmlformats.org/markup-compatibility/2006',p14='http://schemas.microsoft.com/office/powerpoint/2010/main')
        doc=E.Element(old.tag,nsmap=nsmap);doc.attrib.update(old.attrib)
        for child in list(old):doc.append(child)
        ac=E.Element('{'+nsmap['mc']+'}AlternateContent');choice=E.SubElement(ac,'{'+nsmap['mc']+'}Choice',Requires='p14');fallback=E.SubElement(ac,'{'+nsmap['mc']+'}Fallback')
        for branch,label in [(choice,'MC_CHOICE'),(fallback,'MC_FALLBACK')]:
            shape=copy.deepcopy(custom._element);meta=shape.find('.//{'+NS['p']+'}cNvPr');meta.set('id','9000');meta.set('name',label)
            for text in shape.findall('.//{'+NS['a']+'}t'):text.text=label+' namespace inheritance'
            xfrm=shape.find('.//{'+NS['a']+'}xfrm');xfrm.find('{'+NS['a']+'}off').set('y','700000')
            branch.append(shape)
        doc.find('.//{'+NS['p']+'}spTree').append(ac);parts[part]=E.tostring(doc,xml_declaration=True,encoding='UTF-8',standalone=True)
    save(p,name,['nonuniform-group-scale','rotated-child','move-preserves-child-xfrm','mc-choice-fallback-shared-id','ancestor-only-requires-prefix','custom-bezier-geometry'],['AFFINE_GROUP','CUSTOM_BEZIER_ROOT','MC_CHOICE'],patch)

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    for make in [typography,layout,groups,tables,charts,animations,links,placeholder_inheritance,affine_group_mc]:make()
    upstream=ROOT/'fixtures/upstream/SOURCES.json'
    if upstream.exists():
        content=json.loads(upstream.read_text())
        for item in content['files']:
            ITEMS.append({'id':item['id'],'path':'fixtures/upstream/'+item['path'],'bytes':item['bytes'],'sha256':item['sha256'],'provenance':{'kind':'upstream',**{key:item[key] for key in ['sourceUrl','sourceCommit','license','producerDeclared','modified']},'licensePath':'fixtures/upstream/'+item['licensePath'],'noticePath':'fixtures/upstream/'+item['noticePath']},'expected':{'slides':item['zipInspection']['slideCount'],'textIncludes':[],'unsupportedFeatures':['smartart',item['zipInspection']['layouts'][0]['layoutName']],'protectedShapes':[]},'screenshots':[0],'editPageIndex':0,'preserveParts':['ppt/diagrams/*','ppt/media/*','ppt/theme/*','ppt/slideMasters/*','ppt/slideLayouts/*']})
    manifest={'schemaVersion':1,'description':'Original OOXML stress cases plus separately licensed pinned upstream SmartArt. Source validity and preservation are separate from visual fidelity/playback claims.','items':ITEMS}
    (ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'generated':9,'total':len(ITEMS),'manifest':str(ROOT/'manifest.json')}))
if __name__=='__main__':main()
