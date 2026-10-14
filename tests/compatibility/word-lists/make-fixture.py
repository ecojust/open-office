from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from xml.sax.saxutils import escape
import json,hashlib
r=Path(__file__).parent
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def run(s,props=''):return '<w:r>'+('<w:rPr>'+props+'</w:rPr>'if props else'')+'<w:t xml:space="preserve">'+escape(s)+'</w:t></w:r>'
def para(name,num=None,level=0,rich=False):
 p='<w:p><w:pPr><w:spacing w:after="120"/>'
 if num:p+=f'<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{num}"/></w:numPr>'
 p+='</w:pPr>'+run(name+' ')
 if rich:p+=run('BoldKeep','<w:b/><w:color w:val="2356A0"/>')+run(' ')+f'<w:hyperlink r:id="rIdLink">'+run('LinkKeep','<w:i/>')+'</w:hyperlink>'+run(' ')+ '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'+run('1')+'<w:r><w:fldChar w:fldCharType="end"/></w:r>'
 return p+'</w:p>'
specs=[('PlainTarget',None,0,True),('AFirst',1,0,False),('ATarget',1,0,True),('AChild',1,1,False),('Separator',None,0,False),('BFirst',2,0,False),('BSecond',2,0,False),('BulletFirst',3,0,False),('BulletSecond',3,0,False),('AContinued',1,0,False),('PlainSentinel',None,0,False)]
body=''.join(para(*s)for s in specs)
levels=''.join(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%{i+1}."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="{720*(i+1)}"/></w:tabs><w:ind w:left="{720*(i+1)}" w:hanging="360"/></w:pPr></w:lvl>'for i in range(3))
parts={
'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
'_rels/.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdOffice" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
'word/document.xml':f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
'word/_rels/document.xml.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNumbering" Type="{R}/numbering" Target="numbering.xml"/><Relationship Id="rIdStyles" Type="{R}/styles" Target="styles.xml"/><Relationship Id="rIdLink" Type="{R}/hyperlink" Target="https://example.com/retain?x=1&amp;y=2" TargetMode="External"/></Relationships>',
'word/styles.xml':f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
'word/numbering.xml':f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="10"><w:multiLevelType w:val="multilevel"/>{levels}</w:abstractNum><w:abstractNum w:abstractNumId="20"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="20"/></w:num></w:numbering>'}
with ZipFile(r/'independent-lists.docx','w',ZIP_DEFLATED)as z:
 for name,xml in parts.items():z.writestr(name,'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+xml)
manifest={'name':'independent-lists.docx','sha256':hashlib.sha256((r/'independent-lists.docx').read_bytes()).hexdigest(),'paragraphs':[{'name':s[0],'numId':s[1],'level':s[2],'rich':s[3]}for s in specs],'invariants':['All paragraphs retain body text and character properties','LinkKeep retains external hyperlink target','Two PAGE fields remain fields','A/B lists share abstractNum 10 in input but have independent numIds 1 and 2','PlainSentinel remains unlisted']}
(r/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
