import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,readTask,recoverTask,withWorkflowLock} from '../dist/workflow.js';
import {analyzeTask,preFixCycle,phaseCEvidenceIntact,validateDiagnosis,inspectAgentWorktree} from '../dist/phasec.js';
const hash = s=>createHash('sha256').update(s).digest('hex');
const g = (...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
const diagnosis={classification:'MCP_DEFECT',problem:'통계 불일치',impact:'표시값 오류',
  causeHypothesis:'MCP 집계 과정에서 오류가 발생한 것으로 추정',reproductionSteps:['같은 조건으로 MCP 및 독립 HTTP 호출','수치 비교'],
  expectedResult:'기준 API 와 동일한 값',actualResult:'표시값 불일치',candidateFiles:['src/index.ts'],
  recommendedChange:'집계 코드를 검토해야 함',limitations:['원인 가설이 확정된 것은 아님'],confidence:'MEDIUM'};
function scenario(status='FAIL',reason='MCP_SUMMARY_MISMATCH',period={stime:1000,etime:2000},limit=100){
  return {id:'apm-tps-series',status,reason,mcpPath:'mxql/app/stat_tx_pcode',
    candidate:{args:status==='FAIL'?{path:'mxql/app/stat_tx_pcode',projectCode:123,timeRange:'5m',limit}:{}},
    timeWindow:period};
}
async function writeMockReport(dir,sc){
  await mkdir(dir,{recursive:true});
  const candidateData='{\"type\":\"candidate\"}\n';
  const referenceData='{\"type\":\"http-reference\"}\n';
  await writeFile(path.join(dir,'candidate.json'),candidateData);
  await writeFile(path.join(dir,'reference.json'),referenceData);
  if(sc.status==='FAIL'){
    sc.candidate={...sc.candidate,file:'candidate.json',sha256:hash(candidateData)};
    sc.reference={...sc.reference,file:'reference.json',sha256:hash(referenceData)};
  }
  const text=JSON.stringify({harnessVersion:'0.5.0-alpha.3-c1',runDir:dir,scenarios:[sc],totals:{}})+'\n';
  await writeFile(path.join(dir,'report.json'),text);
  return {runDir:dir,scenarios:[sc],sha:hash(text)};
}
async function setup(){
  const root=await mkdtemp(path.join(os.tmpdir(),'phasec1-'));
  const main=path.join(root,'base'),worktree=path.join(root,'agent'),outputDir=path.join(root,'runs');
  await mkdir(main,{recursive:true});g('init','-q','-b','submission',main);
  g('-C',main,'config','user.email','test@example.invalid');g('-C',main,'config','user.name','Test');
  await writeFile(path.join(main,'README.md'),'hello\n');g('-C',main,'add','.');g('-C',main,'commit','-qm','init');
  g('-C',main,'worktree','add','-qb','agent',worktree);
  let s=await withWorkflowLock(outputDir,()=>createTask(outputDir,'apm-tps-series'));
  const history=[];
  for(let i=1;i<=4;i++){
    const run=await writeMockReport(path.join(root,`baseline-${i}`),scenario('FAIL','MCP_SUMMARY_MISMATCH',{stime:1000+i,etime:2000+i}));
    history.push({phase:'INITIAL_VERIFY',ordinal:i,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
      verdict:'FAIL',reason:'MCP_SUMMARY_MISMATCH',timeWindow:run.scenarios[0].timeWindow,
      evidence:{runDir:run.runDir,reportSha256:run.sha,verdict:'FAIL',at:new Date().toISOString()}});
  }
  s=await withWorkflowLock(outputDir,()=>writeTransition(outputDir,s,{
    phase:'ANALYZING',status:'PAUSED',validationHistory:history,latestValidation:history.at(-1).evidence,
    validationRetries:{INITIAL_VERIFY:3,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}},'TEST_BASELINE','multiple fails'));
  const config={outputDir,servers:{candidate:path.join(worktree,'dist/index.js'),reference:'unused'},scenarios:[],rpcTimeoutMs:1000,retryCount:0};
  return {root,main,worktree,outputDir,config,s,async cleanup(){await rm(root,{recursive:true,force:true});}};
}
async function ready(fx,analysis=diagnosis){return withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.worktree,async()=>analysis));}
function verifier(fx,scs){let n=0;return {run:async()=>{
  const sc=scs[Math.min(n,scs.length-1)];
  const report=await writeMockReport(path.join(fx.root,'pre-'+(++n)),sc);
  return report;}, get count(){return n;}};}

test('Phase C1: structured diagnosis validates required fields and blocks source path traversal',()=>{
  assert.equal(validateDiagnosis(diagnosis).classification,'MCP_DEFECT');
  assert.throws(()=>validateDiagnosis({...diagnosis,candidateFiles:['../harness/src/validator.ts']}));
  assert.throws(()=>validateDiagnosis({...diagnosis,reproductionSteps:[]}));
  assert.throws(()=>validateDiagnosis({...diagnosis,classification:'CONFIRMED_BY_AI'}));
});
test('Phase C1: Codex read-only analysis records SHA, does not edit source, advances to independent gate',async()=>{
  const fx=await setup();try{
    const s=await ready(fx);
    assert.equal(s.phase,'PRE_FIX_VERIFY');assert.equal(s.status,'READY');
    assert.equal(s.fixRetries,0);
    assert.equal(await phaseCEvidenceIntact(fx.config,s),true);
    assert.equal((await inspectAgentWorktree(fx.worktree)).status,'');
    assert.equal(JSON.parse(await readFile(path.join(fx.outputDir,'tasks',s.taskId,'analysis.json'))).diagnosis.impact,'표시값 오류');
  }finally{await fx.cleanup();}
});
test('Phase C1: API limitation report does not authorize MCP modification',async()=>{
  const fx=await setup();try{
    const s=await ready(fx,{...diagnosis,classification:'API_LIMITATION'});
    assert.equal(s.phase,'ANALYZING');assert.equal(s.status,'BLOCKED');assert.equal(s.fixRetries,0);
  }finally{await fx.cleanup();}
});
test('Phase C1: read-only analysis detects attempted source changes',async()=>{
  const fx=await setup();try{
    await assert.rejects(()=>withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.worktree,async()=>{
      await writeFile(path.join(fx.worktree,'README.md'),'changed by analyzer\n');return diagnosis;
    })),/Worktree changed during read-only analysis/);
    const s=await readTask(fx.outputDir,fx.s.taskId);
    assert.equal(s.phase,'ANALYZING');assert.equal(s.status,'BLOCKED');
  }finally{await fx.cleanup();}
});
test('Phase C1: matching query but different relative time window pauses without edit permission',async()=>{
  const fx=await setup();try{
    let s=await ready(fx);
    const v=verifier(fx,[scenario('FAIL','MCP_SUMMARY_MISMATCH',{stime:9000,etime:10000})]);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,v.run));
    assert.equal(s.phase,'PRE_FIX_VERIFY');assert.equal(s.status,'PAUSED');
    assert.equal(s.lastError,'RELATIVE_WINDOW_REPRODUCED_BUT_FIXED_PERIOD_NOT_VERIFIED');
    assert.equal(s.preFix.reproduced,true);assert.equal(s.preFix.sameAbsolutePeriod,false);
    assert.equal(s.fixRetries,0);assert.equal(v.count,1);
    assert.equal(await phaseCEvidenceIntact(fx.config,s),true);
  }finally{await fx.cleanup();}
});
test('Phase C1: different limit or mismatch reason blocks source modification',async()=>{
  const fx=await setup();try{
    let s=await ready(fx);
    const v=verifier(fx,[scenario('FAIL','MCP_SUMMARY_MISMATCH',{stime:9000,etime:10000},50)]);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,v.run));
    assert.equal(s.phase,'PRE_FIX_VERIFY');assert.equal(s.status,'BLOCKED');
    assert.equal(s.fixRetries,0);
  }finally{await fx.cleanup();}
});
test('Phase C1: UNVERIFIABLE pre-fix retries 30/60/120, eventually blocks without consuming fix retry',async()=>{
  const fx=await setup();try{
    let s=await ready(fx);
    let t=1000000000000;const sleeps=[];
    const clk={now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;}};
    const v=verifier(fx,[scenario('UNVERIFIABLE','REFERENCE_MCP_UNAVAILABLE')]);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,v.run,clk));
    assert.equal(s.status,'BLOCKED');assert.equal(s.lastError,'PRE_FIX_UNVERIFIABLE_EXHAUSTED');
    assert.equal(s.validationRetries.PRE_FIX_VERIFY,3);assert.equal(s.fixRetries,0);
    assert.deepEqual(sleeps,[30000,60000,120000]);assert.equal(v.count,4);
  }finally{await fx.cleanup();}
});
test('Phase C1: pre-fix scheduled retry survives restart with its deadline and count',async()=>{
  const fx=await setup();try{
    let s=await ready(fx);let t=1000000000000;
    const clk={now:()=>t,sleep:async ms=>{t+=ms;}};
    const v=verifier(fx,[scenario('UNVERIFIABLE','REFERENCE_MCP_UNAVAILABLE'),scenario()]);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,v.run,clk,true));
    assert.equal(s.status,'WAITING_RETRY');const deadline=s.nextAttemptAt;
    const recovered=await readTask(fx.outputDir,s.taskId);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,recovered,v.run,clk));
    assert.equal(s.phase,'PRE_FIX_VERIFY');assert.equal(s.status,'PAUSED');
    assert.equal(s.validationRetries.PRE_FIX_VERIFY,1);assert.ok(deadline);assert.equal(v.count,2);
  }finally{await fx.cleanup();}
});
test('Phase C1: cannot analyze main checkout or non-agent branch',async()=>{
  const fx=await setup();try{
    await assert.rejects(()=>inspectAgentWorktree(fx.main),/separate linked Git worktree/);
    g('-C',fx.worktree,'checkout','-qb','not-agent');
    await assert.rejects(()=>inspectAgentWorktree(fx.worktree),/branch must be agent/);
  }finally{await fx.cleanup();}
});

test('Phase C1: interrupted read-only diagnosis recovers to PAUSED without falsely approving edits',async()=>{
  const fx=await setup();try{
    let s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,fx.s,{status:'RUNNING'},'TEST','crash'));
    s=await withWorkflowLock(fx.outputDir,()=>recoverTask(fx.outputDir,s));
    assert.equal(s.phase,'ANALYZING');assert.equal(s.status,'PAUSED');
    assert.equal(s.fixRetries,0);assert.equal((await inspectAgentWorktree(fx.worktree)).status,'');
  }finally{await fx.cleanup();}
});

test('Phase C1: same absolute period and exact mismatch permits next editing phase but never edits itself',async()=>{
  const fx=await setup();try{
    let s=await ready(fx);
    const v=verifier(fx,[scenario('FAIL','MCP_SUMMARY_MISMATCH',{stime:1004,etime:2004})]);
    s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,v.run));
    assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');
    assert.equal(s.preFix.sameAbsolutePeriod,true);assert.equal(s.fixRetries,0);
    assert.equal((await inspectAgentWorktree(fx.worktree)).status,'');
  }finally{await fx.cleanup();}
});
