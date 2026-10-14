"""Independent read-only DOCX/ODT structural audit. No product imports.
Usage: python inspect-package.py document.docx [output.json]
"""
from pathlib import Path
from zipfile import ZipFile
from lxml import etree as E
import json,sys,hashlib
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';PKG='http://schemas.openxmlformats.org/package/2006/relationships'
T='urn:oasis:names:tc:opendocument:xmlns:text:1.0';S='urn:oasis:names:tc:opendocument:xmlns:style:1.0';X='http://www.w3.org/1999/xlink';XML='http://www.w3.org/XML/1998/namespace'
qn=lambda ns,n:'{'+ns+'}'+n

def canonical(node,link_targets=None,styles=None):
 if node is None:return None
 attrs=[]
 for key,value in sorted(node.attrib.items()):
  if key.startswith('{'+W+'}rsid'):continue
  if key==qn(R,'id')and link_targets is not None:value=link_targets.get(value,value)
  if key==qn(T,'style-name')and styles is not None:value=styles.get(value,value)
  attrs.append([key,value])
 return [node.tag,attrs,node.text or'',[[canonical(c,link_targets,styles),c.tail or'']for c in node]]

def docx(parts):
 ns={'w':W};d=E.fromstring(parts['word/document.xml']);nr=E.fromstring(parts.get('word/numbering.xml',f'<w:numbering xmlns:w="{W}"/>'));rels=E.fromstring(parts.get('word/_rels/document.xml.rels',f'<Relationships xmlns="{PKG}"/>'));links={n.get('Id'):n.get('Target')for n in rels};style=E.fromstring(parts.get('word/styles.xml',f'<w:styles xmlns:w="{W}"/>'));paragraphStyles={n.get(qn(W,'styleId')):n.find(qn(W,'pPr'))for n in style if n.tag==qn(W,'style')};nums={n.get(qn(W,'numId')):n for n in nr.findall('w:num',ns)};abstra={n.get(qn(W,'abstractNumId')):n for n in nr.findall('w:abstractNum',ns)}
 def value(node,path,default=None):
  n=node.find(path,ns)if node is not None else None
  return n.get(qn(W,'val'),default)if n is not None else default
 def merge_num(ppr):
  inherited=paragraphStyles.get(value(ppr,'w:pStyle'))
  num=value(ppr,'w:numPr/w:numId',value(inherited,'w:numPr/w:numId'));level=value(ppr,'w:numPr/w:ilvl',value(inherited,'w:numPr/w:ilvl','0'))
  return num,level
 result=[]
 for p in d.findall('.//w:body/w:p',ns):
  text=''.join(p.itertext()) # field instructions kept separately from display below
  display=''.join(p.xpath('.//w:t/text()',namespaces=ns));pr=p.find(qn(W,'pPr'));num,level=merge_num(pr);rule={}
  if num not in[None,'0']and num in nums:
   numNode=nums[num];abstract=value(numNode,'w:abstractNumId');an=abstra.get(abstract);lvl=next((c for c in an.findall('w:lvl',ns)if c.get(qn(W,'ilvl'))==level),None)if an is not None else None;over=next((c for c in numNode.findall('w:lvlOverride',ns)if c.get(qn(W,'ilvl'))==level),None)
   override=over.find(qn(W,'lvl'))if over is not None else None;actual=override if override is not None else lvl
   rule={'format':value(actual,'w:numFmt'),'text':value(actual,'w:lvlText'),'start':value(over,'w:startOverride',value(actual,'w:start','1')),'restart':value(actual,'w:lvlRestart'),'level':int(level),'abstractId':abstract,'numId':num,'levelDefinition':canonical(actual),'override':canonical(over)}
  if rule and rule['format']=='bullet':
   fonts=actual.find('w:rPr/w:rFonts',ns) if actual is not None else None
   symbol=fonts is not None and fonts.get(qn(W,'ascii'))=='Symbol'
   rule['bullet']='•' if symbol and rule['text']=='\uf0b7' else rule['text']
  result.append({'text':display,'name':display.split(' ')[0],'list':rule or None,'inline':[canonical(n,links)for n in p if n.tag!=qn(W,'pPr')],'paragraphPropertiesWithoutList':[canonical(n)for n in pr if n.tag not in[qn(W,'numPr')]]if pr is not None else[],'links':[{'text':''.join(n.xpath('.//w:t/text()',namespaces=ns)),'target':links.get(n.get(qn(R,'id'))),'attrs':{k:v for k,v in n.attrib.items()if k!=qn(R,'id')}}for n in p.findall('.//w:hyperlink',ns)],'fieldInstructions':p.xpath('.//w:instrText/text()',namespaces=ns),'fieldCharacters':[n.get(qn(W,'fldCharType'))for n in p.findall('.//w:fldChar',ns)]})
 return {'kind':'docx','paragraphs':result,'numbering':canonical(nr)}

def odt(parts):
 d=E.fromstring(parts['content.xml']);ns={'text':T,'style':S};styleNodes=[]
 for name in ['styles.xml','content.xml']:
  if name in parts:styleNodes.extend(E.fromstring(parts[name]).findall('.//'+qn(S,'style')))
 def styleValue(node):
  return {'family':node.get(qn(S,'family')),'parent':node.get(qn(S,'parent-style-name')),'properties':[canonical(n)for n in node]}
 styles={n.get(qn(S,'name')):styleValue(n)for n in styleNodes};listStyles={n.get(qn(S,'name')):n for n in d.findall('.//'+qn(T,'list-style'))}
 if 'styles.xml'in parts:
  for n in E.fromstring(parts['styles.xml']).findall('.//'+qn(T,'list-style')):listStyles.setdefault(n.get(qn(S,'name')),n)
 result=[]
 for p in d.findall('.//'+qn(T,'p'))+d.findall('.//'+qn(T,'h')):
  def visible(n):
   out=n.text or''
   for c in n:
    out+=(' '*int(c.get(qn(T,'c'),'1'))if c.tag==qn(T,'s')else'\t'if c.tag==qn(T,'tab')else'\n'if c.tag==qn(T,'line-break')else visible(c))+(c.tail or'')
   return out
  text=visible(p);anc=list(p.iterancestors());lists=[n for n in anc if n.tag==qn(T,'list')];item=next((n for n in anc if n.tag==qn(T,'list-item')),None);rule=None
  if lists:
   li=lists[0];styleName=next((n.get(qn(T,'style-name'))for n in lists if n.get(qn(T,'style-name'))),None);style=listStyles.get(styleName);level=len(lists);lvl=next((n for n in style if n.get(qn(T,'level'))==str(level)),None)if style is not None else None
   rule={'level':level-1,'styleName':styleName,'id':li.get(qn(XML,'id')),'continueList':li.get(qn(T,'continue-list')),'continueNumbering':li.get(qn(T,'continue-numbering')),'start':item.get(qn(T,'start-value'))if item is not None else None,'levelDefinition':canonical(lvl),'format':lvl.get(qn(S,'num-format'))if lvl is not None else None,'bullet':lvl.get(qn(T,'bullet-char'))if lvl is not None else None}
  # Ignore paragraph wrapper attributes when comparing inline contents; resolve
  # automatic text-style names so harmless serializer renumbering is visible.
  result.append({'text':text,'name':text.split(' ')[0],'list':rule,'inline':{'text':p.text or'','children':[[canonical(c,None,styles),c.tail or'']for c in p]},'paragraphStyle':styles.get(p.get(qn(T,'style-name'))),'links':[{'text':visible(n),'target':n.get(qn(X,'href')),'attributes':dict(n.attrib)}for n in p.findall('.//'+qn(T,'a'))],'pageFields':[canonical(n)for n in p.findall('.//'+qn(T,'page-number'))]})
 return {'kind':'odt','paragraphs':result}

def inspect(path):
 path=Path(path)
 with ZipFile(path)as z:parts={name:z.read(name)for name in z.namelist()}
 out=docx(parts)if 'word/document.xml'in parts else odt(parts)
 return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),**out}
if __name__=='__main__':
 out=inspect(sys.argv[1]);s=json.dumps(out,indent=2)+'\n'
 if len(sys.argv)>2:Path(sys.argv[2]).write_text(s)
 else:print(s)
