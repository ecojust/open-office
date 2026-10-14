"""Prepare independent package audit for genuine Word Vue UI output. No product imports."""
from pathlib import Path
import sys,json
ui=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
stages=[]
for f in ['docx','odt']:
 stages.append({'name':'actual-ui-'+f,'baseline':str(ui/('ui-baseline.'+f)),'output':str(ui/('ui-lists.'+f)),'targets':['PlainTarget','ATarget'],'allowFollowing':['AChild','AContinued'],'expected':{'PlainTarget':{'level':0,'bullet':'•'},'ATarget':{'level':0,'start':'1'}}})
for name in ['ui-reopened','ui-from-odt']:
 baseline=ui/(name+'-baseline.docx')
 stages.append({'name':name,'baseline':str(baseline if baseline.exists() else ui/'ui-lists.docx'),'output':str(ui/(name+'.docx')),'targets':[],'expected':{}})
(out/'xml-plan.json').write_text(json.dumps({'stages':stages},indent=2))
print(out/'xml-plan.json')
