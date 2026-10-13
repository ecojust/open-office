// Re-read already saved bytes after an independent parser/comparator fix.
// This never runs the editor, changes an Office file, or overwrites the original
// run report. A new semantic audit is distinct from a new application run.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {checkAssertions}=require('./assertions.cjs');
const {compareInspections}=require('./compare.cjs');
if(!process.argv[2])throw Error('Usage: node tests/compatibility/audit-saved.cjs <run/report.json>');
const reportPath=path.resolve(process.argv[2]),directory=path.dirname(reportPath);
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
if(!report.finishedAt||report.interruptedReason)throw Error('The original browser run did not complete; do not relabel it as a completed run');
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
const attachmentAudit=process.env.COMPAT_ATTACHMENT_AUDIT?JSON.parse(fs.readFileSync(process.env.COMPAT_ATTACHMENT_AUDIT,'utf8')):null;
let matchedAttachmentCycles=0;
const inspect=file=>{
 const proc=spawnSync(process.env.COMPAT_PYTHON||'python3',[path.join(__dirname,'inspect-output.py'),file],{encoding:'utf8',maxBuffer:24*1024*1024,timeout:60000});
 if(![0,2].includes(proc.status))throw Error('Independent parser rejected '+path.basename(file));
 return JSON.parse(proc.stdout);
};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const item of report.cases){
 const fixture=manifest.fixtures.find(fixture=>fixture.id===item.id);if(!fixture)throw Error('Missing pinned fixture '+item.id);
 const source=path.resolve(__dirname,fixture.path);
 if(!source.startsWith(__dirname+path.sep)||sha(source)!==fixture.sha256||item.sourceInspection?.file?.sha256!==fixture.sha256)throw Error('Original source identity changed: '+item.id);
 item.sourceInspection=inspect(source);
 for(const branch of item.branches){
  for(const [index,cycle] of branch.cycles.entries()){
   if(!cycle.inspection)continue;
   // Older reports predate an explicit reopened flag; the following successful
   // import/final state is the retained browser evidence for this saved file.
   cycle.reopened=!!(branch.cycles[index+1]?.importedState||(index===branch.cycles.length-1&&branch.finalState));
   const oldPath=path.resolve(directory,cycle.inspection);
   if(!oldPath.startsWith(directory+path.sep)||!oldPath.endsWith('.json'))throw Error('Invalid saved artifact path');
   const file=oldPath.slice(0,-5),old=JSON.parse(fs.readFileSync(oldPath,'utf8'));
   if(sha(file)!==old.file.sha256)throw Error('Previously inspected artifact bytes changed: '+file);
   const result=inspect(file),marker=cycle.cycle>=2?'COMPAT-EDIT-'+item.id:undefined;
   cycle.checks=checkAssertions(result,fixture.assertions||{},marker);
   cycle.preservation=compareInspections(item.sourceInspection,result,{cycle:cycle.cycle,expectedEditMarker:marker});
   if(attachmentAudit&&item.id===attachmentAudit.fixtureId&&branch.format==='docx'){
    const independent=attachmentAudit.cycles.find(entry=>entry.cycle===cycle.cycle);
    if(attachmentAudit.source.sha256!==fixture.sha256||!independent||independent.sha256!==result.file.sha256||path.resolve(__dirname,'../..',independent.output)!==file)throw Error('Supplemental attachment audit does not match these exact saved bytes');
    matchedAttachmentCycles++;
    cycle.attachmentPreservation={lossDetected:independent.lossDetected,differences:independent.differences,byteIdenticalToSource:independent.byteIdenticalToSource};
    cycle.checks.push({name:'embedded-attachment-content',ok:!independent.lossDetected,actual:independent.differences,expected:'No original attachment content lost'});
   }
   cycle.ok=cycle.checks.every(check=>check.ok)&&cycle.preservation.status!=='fail';
   cycle.status=!cycle.ok?'fail':cycle.preservation.status==='review'?'review':'pass';
   fs.writeFileSync(file+'.rechecked.json',JSON.stringify(result,null,2));
   cycle.recheckedInspection=path.relative(directory,file+'.rechecked.json');
  }
  branch.ok=branch.cycles.length===report.cycles&&branch.cycles.every(cycle=>cycle.ok)&&!branch.failures.length;
  branch.status=!branch.ok?'fail':branch.cycles.some(cycle=>cycle.status==='review')?'review':'pass';
 }
 item.ok=item.branches.length>0&&item.branches.every(branch=>branch.ok)&&!item.failures.length;
 item.status=!item.ok?'fail':item.branches.some(branch=>branch.status==='review')?'review':'pass';
}
if(attachmentAudit){
 if(matchedAttachmentCycles!==attachmentAudit.cycles.length)throw Error('Not every supplemental audited output belongs to this browser run');
 report.supplementalAttachmentAudit={path:path.relative(path.resolve(__dirname,'../..'),path.resolve(process.env.COMPAT_ATTACHMENT_AUDIT)),sha256:sha(process.env.COMPAT_ATTACHMENT_AUDIT),lossDetected:attachmentAudit.lossDetected};
}
report.recheck={at:new Date().toISOString(),originalReport:path.basename(reportPath),reason:'Independent parser/comparator correction; original Office bytes and original browser report retained',newBrowserRun:false};
const allBranches=report.cases.flatMap(item=>item.branches),allCycles=allBranches.flatMap(branch=>branch.cycles);
report.summary={fixtures:report.cases.length,passed:report.cases.filter(item=>item.status==='pass').length,needsReview:report.cases.filter(item=>item.status==='review').length,failed:report.cases.filter(item=>!item.ok).length,attemptedCycles:allCycles.length,savedCycles:allCycles.filter(cycle=>cycle.inspection).length,reopenedCycles:allCycles.filter(cycle=>cycle.reopened).length,completeCycles:allCycles.filter(cycle=>cycle.ok&&cycle.reopened).length,reopenedBranches:allBranches.filter(branch=>branch.finalState).length,externalRequests:report.externalRequests.length,pageErrors:report.pageErrors.length};
report.ok=report.implementationUnchanged!==false&&report.cases.every(item=>item.status==='pass')&&!report.externalRequests.length&&!report.pageErrors.length;
const target=path.join(directory,'rechecked-report.json');fs.writeFileSync(target,JSON.stringify(report,null,2));console.log(JSON.stringify({report:target,summary:report.summary},null,2));
if(!report.ok)process.exitCode=1;
