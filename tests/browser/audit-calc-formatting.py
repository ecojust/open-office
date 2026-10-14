"""Independent XLSX audit of the actual native fixture export; no product helpers."""
import json,sys,re
r=json.load(open(sys.argv[1]));before=r['baseline'];after=r['after'];checks=[]
def check(value,label):
 if not value: raise AssertionError(label)
 checks.append(label)
def font(c):return {n[0]:n[1] for n in c['font'][3]}
def text(c):
 def walk(n):return (n[2]if n[0]=='t'else'')+''.join(walk(x)for x in n[3])
 return walk(c['text'])if c['text']else''
def without(d,key):return {k:v for k,v in d.items()if k!=key}
def flag(v):return v is True or isinstance(v,dict)and str(v.get('val','true')).lower() in ['true','1']
def fmt(v):return re.sub(r'^\[\$-[0-9A-Fa-f]+\]','',str(v))
for key,b in before.items():
 a=after[key];row=int(re.search(r'\d+$',key)[0]);attr={1:'b',4:'sz',5:'color',8:'i'}.get(row)
 check(all(a[k]==b[k]for k in ['kind','formula','value'])and text(a)==text(b),key+' contents and formula retained')
 check(a['border']==b['border'],key+' borders retained')
 if row!=3:check(a['fill']==b['fill'],key+' fill retained')
 if row not in [2,7]:check(a['format']==b['format'],key+' number format retained')
 if row!=6:check(a['alignment']==b['alignment'],key+' alignment retained')
 else:
  check(without(a['alignment'][1],'wrapText')==without(b['alignment'][1],'wrapText'),key+' other alignment retained')
 if attr:
  check(without(font(a),attr)==without(font(b),attr),key+' unrelated font properties retained')
  check(len(a['runs'])==len(b['runs'])and all(x['text']==y['text']and without(x['font'],attr)==without(y['font'],attr)for x,y in zip(a['runs'],b['runs'])),key+' unrelated rich-run properties retained')
 else:check(a['font']==b['font']and a['runs']==b['runs'],key+' all font and rich-run properties retained')
 if row in [2,7]:check(fmt(a['format'])==('0.00'if row==2 else'General'),key+' requested number format applied')
 if row==3:check(a['fill'][3][0][1].get('patternType','none')=='none',key+' fill cleared without deleting contents')
 if row in [1,8]:
  expected=row==1
  check(all(flag(x['font'].get(attr))==expected for x in a['runs'])if a['runs']else flag(font(a).get(attr))==expected,key+' requested bold or italic applied')
 if row==6:check(a['alignment'][1].get('wrapText','false')in ['false','0'],key+' requested wrap disabled')
 if row in [4,5]:
  expect={'val':'18'}if row==4 else{'rgb':'FF112233'}
  check(all(x['font'][attr]==expect for x in a['runs'])if a['runs']else font(a)[attr]==expect,key+' requested character property applied')
print(json.dumps({'ok':True,'checks':checks},indent=2))
