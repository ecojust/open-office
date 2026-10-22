import sys,json
from pathlib import Path
class Reader:
 def __init__(self,b):self.b=b;self.p=0
 def byte(self):v=self.b[self.p];self.p+=1;return v
 def leb(self):
  v=0;shift=0
  while True:
   c=self.byte();v|=(c&127)<<shift
   if not c&128:return v
   shift+=7
   if shift>70:raise ValueError('oversized integer')
 def take(self,n):
  v=self.b[self.p:self.p+n];self.p+=n
  if len(v)!=n:raise ValueError('truncated section')
  return v
 def string(self):return self.take(self.leb()).decode('utf-8')
 def ref(self):
  if self.byte() in (0x63,0x64):self.leb()
 def limits(self):
  flags=self.leb();self.leb()
  if flags&1:self.leb()

values=[-7554636318383037360,-7454801818899625434,-7429423314461979223,-7207276661950557992,-7131803591814180821,-6019758777144226059,-5780275611666609265,-4358396017616483017,-4143042619558893734,-2917486167113271335,-2784610183734848337,-2624729345222129160,-2622802681898502475,-2183502553742430119,-425081688584147149,457380681191578133,898638452777906692,950521141494289804,1228320887535867596,1732804360746816840,2039119943687723725,3865875329656804759,4986947095633979045,5134327459162675121,5167461299025127993,5265749391392088513,5268430586848198546,5400666402170143952,6290364617955584048,6568062526259002154]
def sleb(x):
 b=[]
 while True:
  c=x&127;x>>=7;done=(x==0 and not(c&64))or(x==-1 and c&64);b.append(c if done else c|128)
  if done:return bytes(b)
for filename in sys.argv[1:]:
 data=Path(filename).read_bytes();r=Reader(data);r.take(8);funcs=[];names={};imports=0
 while r.p<len(data):
  tag=r.byte();s=Reader(r.take(r.leb()))
  if tag==2:
   for _ in range(s.leb()):
    s.string();s.string();k=s.byte()
    if k==0:imports+=1;s.leb()
    elif k==1:s.ref();s.limits()
    elif k==2:s.limits()
    elif k==3:s.ref();s.byte()
    elif k==4:s.byte();s.leb()
  elif tag==10:
   for i in range(s.leb()):funcs.append(s.take(s.leb()))
  elif tag==0 and s.string()=='name':
   while s.p<len(s.b):
    subtag=s.byte();q=Reader(s.take(s.leb()))
    if subtag==1:
     for _ in range(q.leb()):index=q.leb();names[index]=q.string()
 candidates=[]
 for i,body in enumerate(funcs):
  known=[x for x in values if b'\x42'+sleb(x) in body]
  constants=set()
  for offset,c in enumerate(body[:-2]):
   if c!=0x42:continue
   q=Reader(body);q.p=offset+1
   try:
    x=q.leb();bits=(q.p-offset-1)*7
    if bits<=70 and q.p<len(body) and body[q.p] in (0x51,0x52,0x85):
     if body[q.p-1]&64:x-=1<<bits
     if abs(x)>2**32:constants.add(x)
   except (ValueError,IndexError):pass
  if known or (len(constants)>=7 and max(constants)-min(constants)>=2**63):
   candidates.append({'index':i+imports,'bytes':len(body),'name':names.get(i+imports,''),'knownMatches':len(known),'comparedI64Constants':len(constants),'values':sorted(constants)})
 import base64
 import re
 for c in candidates:
  c['range']=[min(c['values']),max(c['values'])] if c['values'] else []
  del c['values'];c['name']=re.sub(r'\[[0-9a-f]{16}\]','',c['name'])[:180]
 report={'file':Path(filename).name,'candidates':candidates}
 Path('/tmp/'+Path(filename).name+'-switches.json').write_text(json.dumps(report,indent=2))
 encoded=base64.b64encode(json.dumps(report).encode()).decode()
 for i in range(0,len(encoded),3000):print(f"::notice title={Path(filename).name} switch candidates {i//3000:03d}::{encoded[i:i+3000]}")
