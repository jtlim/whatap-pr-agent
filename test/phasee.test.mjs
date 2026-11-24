import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,recoverTask,withWorkflowLock,hashFile} from '../dist/workflow.js';
import {analyzeTask,preFixCycle} from '../dist/phasec.js';
import {modifyTask,snapshotWorktree} from '../dist/phasec2.js';
import {finalVerifyCycle,finalVerifyAttempt,phaseDEvidenceIntact} from '../dist/phased.js';
import {submitTask,reconcileSubmission,recordHumanMerge,phaseEEvidenceIntact} from '../dist/phasee.js';
import {readTask} from '../dist/workflow.js';
const g=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
const sha=s=>createHash('sha256').update(s).digest('hex');
const period={stime:1000,etime:2000};
const args={path:'mxql/app/stat_tx_pcode',projectCode:123,timeRange:'5m',limit:100};
const diagnosis={classification:'MCP_DEFECT',problem:'TPS 수치 불일치',impact:'사용자에게 잘못된 메트릭 노출',
  causeHypothesis:'잘못된 데이터 집계',reproductionSteps:['동일 기간 MCP 조회','독립 HTTP 조회','값 비교'],
  expectedResult:'동일 메트릭',actualResult:'불일치',candidateFiles:['src/index.ts'],
  recommendedChange:'정확한 집계 사용',limitations:['추가 검증 필요'],confidence:'MEDIUM'};
async function report(dir,status='FAIL',queryArgs=args,window=period,opt={}){
  await mkdir(dir,{recursive:true});
  const candidate='{"source":"mcp"}\n',reference='{"source":"http"}\n';
  await writeFile(path.join(dir,'candidate.json'),candidate);await writeFile(path.join(dir,'reference.json'),reference);
  const sc={id:'apm-tps-series',status,reason:status==='FAIL'?'MCP_SUMMARY_MISMATCH':'ALL_MCP_DISPLAY_VALUES_MATCH',
    mcpPath:queryArgs.path,candidate:{args:queryArgs,file:'candidate.json',sha256:sha(candidate)},
    reference:{file:'reference.json',sha256:sha(reference)},timeWindow:window};
  if(opt.multicall)sc.callResults=[{...sc,index:1},{...sc,index:2}];
  const json=JSON.stringify({runDir:dir,scenarios:[sc],totals:{}})+'\n';
  await writeFile(path.join(dir,'report.json'),json);
  return {runDir:dir,scenarios:[sc],sha:sha(json)};
}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'phase-d-'));
  const main=path.join(root,'main'),worktree=path.join(root,'agent'),outputDir=path.join(root,'runs');
  await mkdir(path.join(main,'src'),{recursive:true});
  g('init','-q','-b','submission',main);
  g('-C',main,'config','user.email','test@example.invalid');g('-C',main,'config','user.name','Test');
  await writeFile(path.join(main,'README.md'),'immutable readme\n');
  await writeFile(path.join(main,'src','index.ts'),'export const value = 1;\n');
  g('-C',main,'add','.');g('-C',main,'commit','-qm','init');
  g('-C',main,'worktree','add','-qb','agent',worktree);
  let s=await withWorkflowLock(outputDir,()=>createTask(outputDir,'apm-tps-series'));
  const history=[];
  for(let i=1;i<=4;i++){
    const r=await report(path.join(root,`baseline-${i}`));
    history.push({phase:'INITIAL_VERIFY',ordinal:i,startedAt:new Date().toISOString(),verdict:'FAIL',
      timeWindow:period,reason:'MCP_SUMMARY_MISMATCH',
      evidence:{runDir:r.runDir,reportSha256:r.sha,verdict:'FAIL',at:new Date().toISOString()}});
  }
  s=await withWorkflowLock(outputDir,()=>writeTransition(outputDir,s,{phase:'ANALYZING',status:'PAUSED',validationHistory:history,
    latestValidation:history.at(-1).evidence,validationRetries:{INITIAL_VERIFY:3,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}},'MOCK_FAIL','mock'));
  const config={outputDir,servers:{candidate:path.join(worktree,'dist/index.js'),reference:'mock'},
    scenarios:[{id:'apm-tps-series',matchKeys:['time','_id_'],compareFields:['tps']}]};
  return {root,main,worktree,outputDir,config,s,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function approved(fx){
  let s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.worktree,async()=>diagnosis));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,async()=>{
    const r=await report(path.join(fx.root,'precheck'));
    return {runDir:r.runDir,scenarios:r.scenarios};
  }));
  s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
    await writeFile(path.join(fx.worktree,'src','index.ts'),'export const value = 2;\n');
    return {summary:'source fixed',rationale:'field aligned',testsRun:[],risks:[]};
  }));
  assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.status,'READY');
  return s;
}
function prepareFixture(fx,opts={}){
  let calls=0;
  return {get calls(){return calls},fn:async(_worktree,taskDir,editOrdinal,attemptOrdinal)=>{
    calls++;
    const stageDir=path.join(taskDir,`mock-build-${editOrdinal}-${attemptOrdinal}`);
    await mkdir(path.join(stageDir,'dist'),{recursive:true});
    const candidate=path.join(stageDir,'dist','index.js');
    await writeFile(candidate,'// freshly built mock candidate\n');
    const yes={ok:true,exitCode:0,stdout:'ok',stderr:'',durationMs:1};
    return {stageDir,candidate,build:opts.build===false?{...yes,ok:false}:yes,
      regression:opts.regression===false?{...yes,ok:false}:yes};
  }};
}
function verifier(fx,statuses=['PASS'],opts={}){
  let calls=0;
  return {get calls(){return calls},fn:async(config)=>{
    const idx=calls++;
    assert.notEqual(config.servers.candidate,fx.config.servers.candidate,'Must verify STAGED candidate');
    const r=await report(path.join(fx.root,`final-http-${idx}`),statuses[Math.min(idx,statuses.length-1)],
      opts.args??args,opts.period??period,{multicall:opts.multicall});
    if(opts.corrupt)await writeFile(path.join(r.runDir,'candidate.json'),'tampered');
    if(opts.mutate)await writeFile(path.join(fx.worktree,'README.md'),'unexpected\n');
    return {runDir:r.runDir,scenarios:r.scenarios};
  }};
}
const fakeClock=()=>{
  let t=Date.now();return {now:()=>t,sleep:async ms=>{t+=ms},advance:ms=>{t+=ms}};
};
async function cycle(fx,s,v,p,clock,noWait=false){
  return withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,v.fn,clock,noWait,p.fn));
}

function hosted(fx){
  const remote=path.join(fx.root,'remote.git');
  g('init','--bare','-q',remote);
  g('-C',fx.main,'remote','add','origin',remote);
  g('-C',fx.main,'push','-q','origin','agent','submission');
  let pr=null,creates=0,pushes=0,failAfterPush=false;
  const heads=async wt=>{
    const lines=g('-C',wt,'ls-remote','--heads','origin').split('\n');
    const refs=Object.fromEntries(lines.filter(Boolean).map(x=>{const [sha,ref]=x.split(/\s+/);return [ref,sha]}));
    return {agent:refs['refs/heads/agent']??null,submission:refs['refs/heads/submission']??null};
  };
  const host={remoteHeads:heads,
    async publish(wt,sha){pushes++;g('-C',wt,'push','-q','origin',`${sha}:refs/heads/agent`);
      if(failAfterPush)throw Error('Simulated timeout AFTER server accepted push');},
    async listOpen(){return pr&&pr.state==='OPEN'?[pr]:[]},
    async createPr(wt,title,body){creates++;pr={number:1,url:'https://github.com/test/project/pull/1',
      headOid:g('-C',wt,'rev-parse','HEAD'),headRefName:'agent',baseRefName:'submission',body,state:'OPEN',mergedAt:null};return pr},
    async viewPr(_wt,n){if(!pr||pr.number!==n)throw Error('PR missing');return pr},
  };
  return {host,heads,remote,get creates(){return creates},get pushes(){return pushes},
    set failAfterPush(x){failAfterPush=x},set pr(x){pr=x},get pr(){return pr}};
}
async function preparedSubmission(){
  const fx=await fixture();const hosting=hosted(fx);
  const s=await approved(fx);const p=prepareFixture(fx),v=verifier(fx,['PASS']);
  const approvedState=await cycle(fx,s,v,p,fakeClock());
  assert.equal(approvedState.phase,'COMMITTING');
  return {...fx,hosting,s:approvedState};
}
const act=(fx,s,fn)=>withWorkflowLock(fx.outputDir,()=>fn(fx.config,s,fx.hosting.host));

test('E: no D PASS -> no commit or remote calls',async()=>{
  const fx=await fixture();try{
    const h=hosted(fx);let calls=0;const host={...h.host,remoteHeads:async()=>{calls++;throw Error('called')}};
    await assert.rejects(()=>submitTask(fx.config,fx.s,host,true),/FINAL_VERIFY_PASS_REQUIRED/);
    await assert.rejects(()=>submitTask(fx.config,fx.s,host),/FINAL_VERIFY_PASS_REQUIRED/);
    assert.equal(calls,0);
  }finally{await fx.cleanup()}
});
test('E: dry-run is local, offline, and side-effect free',async()=>{
  const fx=await preparedSubmission();try{
    const orig=g('-C',fx.worktree,'rev-parse','HEAD');
    const none={...fx.hosting.host,remoteHeads:async()=>{throw Error('network contacted')}};
    const result=await submitTask(fx.config,fx.s,none,true);
    assert.equal(result.sequence,fx.s.sequence);
    assert.equal(g('-C',fx.worktree,'rev-parse','HEAD'),orig);
    assert.equal(fx.hosting.pushes,0);
  }finally{await fx.cleanup()}
});
test('E: final PASS -> one agent commit, push, PR; submission branch unchanged',async()=>{
  const fx=await preparedSubmission();try{
    const before=g('-C',fx.main,'rev-parse','submission');
    const result=await act(fx,fx.s,submitTask);
    assert.equal(result.phase,'PR_OPEN');assert.equal(result.status,'PR_OPEN');
    assert.equal(result.submission.prNumber,1);assert.equal(fx.hosting.creates,1);assert.equal(fx.hosting.pushes,1);
    assert.equal(g('-C',fx.worktree,'rev-parse','HEAD'),result.submission.commitSha);
    assert.equal(g('-C',fx.main,'rev-parse','submission'),before);
    assert.equal((await fx.hosting.heads(fx.worktree)).submission,before);
    assert.equal((await fx.hosting.heads(fx.worktree)).agent,result.submission.commitSha);
    assert.equal(await phaseEEvidenceIntact(fx.config,result),true);
    await assert.rejects(()=>act(fx,result,submitTask),/submission already handled/);
  }finally{await fx.cleanup()}
});
test('E: git path additions not in approved edit reject before commit',async()=>{
  const fx=await preparedSubmission();try{
    await writeFile(path.join(fx.worktree,'src','injected.ts'),'untrusted\n');
    await assert.rejects(()=>act(fx,fx.s,submitTask),/Source edited after final/);
    assert.equal(fx.hosting.pushes,0);
  }finally{await fx.cleanup()}
});
test('E: remote agent movement aborts without altering local branch',async()=>{
  const fx=await preparedSubmission();try{
    const old=g('-C',fx.worktree,'rev-parse','HEAD');
    const host={...fx.hosting.host,remoteHeads:async()=>({agent:'a'.repeat(40),submission:fx.s.analysis.head})};
    await assert.rejects(()=>submitTask(fx.config,fx.s,host),/Remote branch changed/);
    assert.equal(g('-C',fx.worktree,'rev-parse','HEAD'),old);
  }finally{await fx.cleanup()}
});
test('E: evidence tampering prevents submission',async()=>{
  const fx=await preparedSubmission();try{
    const attempt=fx.s.validationHistory.at(-1);
    await writeFile(path.join(fx.outputDir,'tasks',fx.s.taskId,attempt.artifactName),'\nmodified');
    await assert.rejects(()=>act(fx,fx.s,submitTask),/Historical verification evidence checksum mismatch/);
    assert.equal(fx.hosting.pushes,0);
  }finally{await fx.cleanup()}
});
test('E: push succeeds remotely but client loses response -> BLOCKED then human reconciliation',async()=>{
  const fx=await preparedSubmission();try{
    fx.hosting.failAfterPush=true;
    await assert.rejects(()=>act(fx,fx.s,submitTask),/Simulated timeout/);
    let state=await readTask(fx.outputDir,fx.s.taskId);
    assert.equal(state.phase,'PUSHING');assert.equal(state.status,'BLOCKED');
    await assert.rejects(()=>act(fx,state,submitTask),/submission already handled/);
    state=await act(fx,state,reconcileSubmission);
    assert.equal(state.phase,'CREATING_PR');assert.equal(state.status,'PAUSED');
    fx.hosting.failAfterPush=false;
    state=await act(fx,state,submitTask);
    assert.equal(state.phase,'PR_OPEN');assert.equal(fx.hosting.pushes,1);
  }finally{await fx.cleanup()}
});
test('E: human merge only after provider confirms target PR merged',async()=>{
  const fx=await preparedSubmission();try{
    let state=await act(fx,fx.s,submitTask);
    await assert.rejects(()=>act(fx,state,recordHumanMerge),/Human-approved merge not independently confirmed/);
    fx.hosting.pr={...fx.hosting.pr,state:'MERGED',mergedAt:new Date().toISOString()};
    state=await act(fx,state,recordHumanMerge);
    assert.equal(state.phase,'DONE');assert.equal(state.status,'COMPLETED');
    assert.equal(await phaseEEvidenceIntact(fx.config,state),true);
  }finally{await fx.cleanup()}
});
test('E: unrelated existing PR refuses to adopt or create duplicate',async()=>{
  const fx=await preparedSubmission();try{
    const old=fx.s.analysis.head;
    fx.hosting.pr={number:66,url:'https://github.com/test/project/pull/66',headOid:old,
      headRefName:'agent',baseRefName:'submission',body:'Other task',state:'OPEN',mergedAt:null};
    await assert.rejects(()=>act(fx,fx.s,submitTask),/unrelated or ambiguous open PR/);
    assert.equal(fx.hosting.creates,0);
    const s=await readTask(fx.outputDir,fx.s.taskId);
    assert.equal(s.phase,'CREATING_PR');assert.equal(s.status,'PAUSED');
  }finally{await fx.cleanup()}
});
test('E: PR create succeeds but confirmation fails -> explicit reconciliation adopts existing PR',async()=>{
  const fx=await preparedSubmission();try{
    let viewFails=true;
    const host={...fx.hosting.host,async viewPr(wt,n){
      if(viewFails){viewFails=false;throw Error('temporary GitHub response failure');}
      return fx.hosting.host.viewPr(wt,n);
    }};
    await assert.rejects(()=>withWorkflowLock(fx.outputDir,()=>submitTask(fx.config,fx.s,host)),/temporary GitHub/);
    let s=await readTask(fx.outputDir,fx.s.taskId);
    assert.equal(s.phase,'CREATING_PR');assert.equal(s.status,'BLOCKED');
    s=await act(fx,s,reconcileSubmission);
    assert.equal(s.phase,'PR_OPEN');assert.equal(s.status,'PR_OPEN');
    assert.equal(fx.hosting.creates,1);
  }finally{await fx.cleanup()}
});
test('E: remote submission ref drift aborts before commit/push',async()=>{
  const fx=await preparedSubmission();try{
    const oldHead=g('-C',fx.worktree,'rev-parse','HEAD');
    const host={...fx.hosting.host,remoteHeads:async()=>({agent:oldHead,submission:'b'.repeat(40)})};
    await assert.rejects(()=>submitTask(fx.config,fx.s,host),/Remote branch changed/);
    assert.equal(g('-C',fx.worktree,'rev-parse','HEAD'),oldHead);
    assert.equal(fx.hosting.pushes,0);
  }finally{await fx.cleanup()}
});
test('E: mutation after remote preflight but before staging is detected',async()=>{
  const fx=await preparedSubmission();try{
    const host={...fx.hosting.host,async remoteHeads(wt){
      await writeFile(path.join(wt,'src','index.ts'),'export const value = 999;\n');
      return fx.hosting.heads(wt);
    }};
    await assert.rejects(()=>submitTask(fx.config,fx.s,host),/Source changed between preflight and Git staging/);
    assert.equal(fx.hosting.pushes,0);
    assert.equal(g('-C',fx.worktree,'rev-parse','HEAD'),fx.s.analysis.head);
  }finally{await fx.cleanup()}
});
test('E: tampering with Git commit checkpoint prevents push',async()=>{
  const fx=await preparedSubmission();try{
    const host={...fx.hosting.host,async publish(){throw Error('publish failed before transport')}};
    await assert.rejects(()=>submitTask(fx.config,fx.s,host),/publish failed/);
    let s=await readTask(fx.outputDir,fx.s.taskId);
    assert.equal(s.phase,'PUSHING');
    await writeFile(path.join(fx.outputDir,'tasks',s.taskId,'submit-commit.json'),'{}');
    assert.equal(await phaseEEvidenceIntact(fx.config,s),false);
    await assert.rejects(()=>act(fx,s,reconcileSubmission),/Commit evidence tampering/);
  }finally{await fx.cleanup()}
});
test('E: interrupted Git operation never auto resumes',async()=>{
  const fx=await preparedSubmission();try{
    const s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,fx.s,
      {status:'RUNNING'},'SIMULATE_CRASH','before remote action'));
    const recovered=await withWorkflowLock(fx.outputDir,()=>recoverTask(fx.outputDir,s));
    assert.equal(recovered.phase,'COMMITTING');assert.equal(recovered.status,'BLOCKED');
    await assert.rejects(()=>act(fx,recovered,submitTask),/submission already handled/);
  }finally{await fx.cleanup()}
});
