"""Compare native-stabilized DOCX/ODT before/after package exports.
Pass a JSON plan whose stages have baseline, output, targets, expected dictionary.
All paths are relative to the plan's directory. This never imports product code.
"""
from pathlib import Path
import json,sys,datetime,hashlib,importlib.util
base=Path(__file__).parent;spec=importlib.util.spec_from_file_location('inspect_package',base/'inspect-word-lists.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
planPath=Path(sys.argv[1]);plan=json.loads(planPath.read_text());report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':[],'failures':[],'stages':[]}
def check(ok,label):
 if not ok:report['failures'].append(label)
 else:report['checks'].append(label)
def semanticRule(rule,kind):
 if rule is None:return None
 keep=['format','text','start','restart','level','levelDefinition']if kind=='docx'else['level','start','format','bullet','levelDefinition']
 return {k:rule.get(k)for k in keep}
try:
 for stage in plan['stages']:
  before=mod.inspect(planPath.parent/stage['baseline']);after=mod.inspect(planPath.parent/stage['output']);name=stage['name'];b={p['name']:p for p in before['paragraphs']};a={p['name']:p for p in after['paragraphs']};targets=set(stage.get('targets',[]));follow=set(stage.get('allowFollowing',[]))
  check(before['kind']==after['kind'],name+' matching export formats')
  check([p['name']for p in before['paragraphs']]==[p['name']for p in after['paragraphs']],name+' same paragraph order and count')
  for key,prev in b.items():
   cur=a[key];check(prev['text']==cur['text'],name+' body text preserved '+key)
   check(prev['inline']==cur['inline'],name+' inline runs, character formatting, hyperlink structure and fields preserved '+key)
   check(prev['links']==cur['links'],name+' hyperlink targets and metadata preserved '+key)
   fields=['fieldInstructions','fieldCharacters']if before['kind']=='docx'else['pageFields']
   check(all(prev[f]==cur[f]for f in fields),name+' actual field instructions and identity retained '+key)
   if key not in targets|follow:
    properties='paragraphPropertiesWithoutList' if before['kind']=='docx' else 'paragraphStyle'
    check(prev[properties]==cur[properties],name+' non-target paragraph formatting unchanged '+key)
    check(semanticRule(prev['list'],before['kind'])==semanticRule(cur['list'],after['kind']),name+' non-target numbering definition unchanged '+key)
  for key,expected in stage.get('expected',{}).items():
   cur=a[key]['list']
   if expected is None:check(cur is None,name+' target unlisted '+key)
   else:
    check(cur is not None,name+' target listed '+key)
    for attr,value in expected.items():check(cur.get(attr)==value,name+' target '+attr+'='+str(value)+' '+key)
  # Independent non-target list instances must remain separate even if the
  # serializer chooses different numeric identifiers on each export.
  names=[k for k in b if k not in targets|follow and b[k]['list']is not None]
  if before['kind']=='docx':
   for i,k in enumerate(names):
    for j in names[i+1:]:
     if a[k]['list']is not None and a[j]['list']is not None:check((b[k]['list']['numId']==b[j]['list']['numId'])==(a[k]['list']['numId']==a[j]['list']['numId']),name+' non-target list membership relation '+k+'/'+j)
  report['stages'].append({'name':name,'baseline':{'path':before['path'],'sha256':before['sha256']},'output':{'path':after['path'],'sha256':after['sha256']},'targetLists':{k:a[k]['list']for k in targets}})
 report['ok']=not report['failures'];print(json.dumps({'ok':report['ok'],'checks':len(report['checks']),'stages':len(report['stages']),'failures':report['failures']}))
except Exception as e:report['ok']=False;report['error']=str(e);raise
finally:(planPath.parent/'independent-xml-report.json').write_text(json.dumps(report,indent=2)+'\n')

if not report.get('ok'):sys.exit(1)
