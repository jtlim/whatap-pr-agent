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
test('D: no source edit -> no independent final verification',async()=>{
  const fx=await fixture();try{
    await assert.rejects(()=>finalVerifyAttempt(fx.config,fx.s,async()=>{throw Error('called')},async()=>{throw Error('called')}),/Not ready/);
  }finally{await fx.cleanup();}
});
test('D: PASS with same query+absolute Period only authorizes COMMITTING/PAUSED, not Git',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS']),clock=fakeClock();
    const result=await cycle(fx,s,v,p,clock);
    assert.equal(result.phase,'COMMITTING');assert.equal(result.status,'PAUSED');
    assert.equal(result.lastError,'FINAL_VERIFY_PASS_PENDING_PHASE_E');
    assert.equal(result.fixRetries,0);assert.equal(result.validationHistory.at(-1).verdict,'PASS');
    assert.equal(await phaseDEvidenceIntact(fx.config,result),true);
    assert.equal(g('-C',fx.main,'status','--porcelain'),'');
    assert.equal(g('-C',fx.main,'branch','--show-current'),'submission');
    assert.equal((await snapshotWorktree(fx.worktree)).head,fx.s.analysis?.head??g('-C',fx.worktree,'rev-parse','HEAD'));
  }finally{await fx.cleanup();}
});
test('D: moving absolute period cannot produce PASS',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS'],{period:{stime:2000,etime:3000}});
    const result=await cycle(fx,s,v,p,fakeClock(),true);
    assert.equal(result.phase,'FINAL_VERIFY');assert.equal(result.status,'WAITING_RETRY');
    assert.equal(result.validationHistory.at(-1).verdict,'UNVERIFIABLE');
    assert.equal(result.validationHistory.at(-1).reason,'FINAL_ABSOLUTE_PERIOD_CHANGED');
  }finally{await fx.cleanup();}
});
test('D: changed MCP arguments cannot produce PASS even if API matches',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS'],{args:{...args,limit:720}});
    const result=await cycle(fx,s,v,p,fakeClock(),true);
    assert.equal(result.validationHistory.at(-1).verdict,'UNVERIFIABLE');
    assert.equal(result.validationHistory.at(-1).reason,'FINAL_QUERY_ARGUMENTS_CHANGED');
  }finally{await fx.cleanup();}
});
test('D: four independently confirmed FAILs allow only a separate C2 edit retry',async()=>{
  const fx=await fixture();try{
    let s=await approved(fx);const p=prepareFixture(fx),v=verifier(fx,['FAIL']),clock=fakeClock();
    s=await cycle(fx,s,v,p,clock);
    assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');
    assert.equal(s.lastError,'FINAL_VERIFY_CONFIRMED_FAIL');assert.equal(s.fixRetries,0);
    assert.equal(s.validationRetries.FINAL_VERIFY,3);
    assert.equal(s.validationHistory.filter(x=>x.phase==='FINAL_VERIFY').length,4);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await writeFile(path.join(fx.worktree,'src','index.ts'),'export const value = 3;\n');
      return {summary:'second fix',rationale:'retry',testsRun:[],risks:[]};
    }));
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.fixRetries,1);
  }finally{await fx.cleanup();}
});
test('D: FAIL then PASS does not authorize another edit',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['FAIL','PASS']);
    const result=await cycle(fx,s,v,p,fakeClock());
    assert.equal(result.phase,'COMMITTING');assert.equal(result.status,'PAUSED');
    assert.deepEqual(result.validationHistory.filter(x=>x.phase==='FINAL_VERIFY').map(x=>x.verdict),['FAIL','PASS']);
    assert.equal(result.fixRetries,0);
  }finally{await fx.cleanup();}
});
test('D: UNVERIFIABLE exhausts 30/60/120 retries without granting a new edit',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS'],{period:{stime:2000,etime:3000}});
    const result=await cycle(fx,s,v,p,fakeClock());
    assert.equal(result.phase,'FINAL_VERIFY');assert.equal(result.status,'BLOCKED');
    assert.equal(result.lastError,'FINAL_VERIFY_UNVERIFIABLE_EXHAUSTED');
    assert.equal(result.fixRetries,0);
    assert.equal(result.validationHistory.filter(x=>x.phase==='FINAL_VERIFY').length,4);
  }finally{await fx.cleanup();}
});
test('D: build/test failures are never represented as validated MCP data failure',async()=>{
  for(const k of ['build','regression']){
    const fx=await fixture();try{
      const s=await approved(fx),p=prepareFixture(fx,{[k]:false}),v=verifier(fx,['PASS']);
      const result=await cycle(fx,s,v,p,fakeClock(),true);
      assert.equal(v.calls,0);assert.equal(result.validationHistory.at(-1).verdict,'UNVERIFIABLE');
      assert.equal(result.status,'WAITING_RETRY');
    }finally{await fx.cleanup();}
  }
});
test('D: edited source changed BEFORE final verification is rejected without building',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx);await writeFile(path.join(fx.worktree,'README.md'),'malicious\n');
    const p=prepareFixture(fx),v=verifier(fx,['PASS']);
    await assert.rejects(()=>cycle(fx,s,v,p,fakeClock()),/Worktree changed after source edit/);
    assert.equal(p.calls,0);assert.equal(v.calls,0);
  }finally{await fx.cleanup();}
});
test('D: tampered raw MCP evidence never creates a PASS',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS'],{corrupt:true});
    const result=await cycle(fx,s,v,p,fakeClock(),true);
    assert.equal(result.validationHistory.at(-1).verdict,'UNVERIFIABLE');
    assert.match(result.validationHistory.at(-1).reason,/FINAL_EXECUTION_ERROR/);
  }finally{await fx.cleanup();}
});
test('D: worktree mutated during MCP/HTTP check is immediately blocked',async()=>{
  const fx=await fixture();try{
    const s=await approved(fx),p=prepareFixture(fx),v=verifier(fx,['PASS'],{mutate:true});
    const result=await cycle(fx,s,v,p,fakeClock());
    assert.equal(result.status,'BLOCKED');assert.equal(result.lastError,'SOURCE_CHANGED_DURING_FINAL_VERIFY');
  }finally{await fx.cleanup();}
});
test('D: no-wait saves original retry deadline and resume uses due time',async()=>{
  const fx=await fixture();try{
    let s=await approved(fx);const p=prepareFixture(fx),v=verifier(fx,['FAIL','PASS']),clock=fakeClock();
    s=await cycle(fx,s,v,p,clock,true);
    const due=s.nextAttemptAt;
    assert.equal(s.status,'WAITING_RETRY');assert.equal(v.calls,1);
    s=await cycle(fx,s,v,p,clock,true);
    assert.equal(s.nextAttemptAt,due);assert.equal(v.calls,1);
    clock.advance(30000);
    s=await cycle(fx,s,v,p,clock,true);
    assert.equal(s.phase,'COMMITTING');assert.equal(v.calls,2);
  }finally{await fx.cleanup();}
});
test('D: interrupted RUNNING final check reuses reserved ordinal (never PASS by recovery)',async()=>{
  const fx=await fixture();try{
    let s=await approved(fx);
    s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,s,{status:'RUNNING',
      activeValidationAttempt:{phase:'FINAL_VERIFY',ordinal:1,editOrdinal:1,startedAt:new Date().toISOString()}},
      'CRASH','test'));
    s=await withWorkflowLock(fx.outputDir,()=>recoverTask(fx.outputDir,s));
    assert.equal(s.status,'READY');assert.equal(s.activeValidationAttempt.ordinal,1);
    s=await cycle(fx,s,verifier(fx,['PASS']),prepareFixture(fx),fakeClock());
    assert.equal(s.phase,'COMMITTING');
    assert.equal(s.validationHistory.filter(x=>x.phase==='FINAL_VERIFY').length,1);
    assert.equal(s.validationHistory.at(-1).ordinal,1);
  }finally{await fx.cleanup();}
});
test('D: report artifact modification breaks durable SHA and blocks trust',async()=>{
  const fx=await fixture();try{
    const s=await cycle(fx,await approved(fx),verifier(fx,['PASS']),prepareFixture(fx),fakeClock());
    const a=s.validationHistory.at(-1);
    assert.equal(await phaseDEvidenceIntact(fx.config,s),true);
    await writeFile(path.join(fx.outputDir,'tasks',s.taskId,a.artifactName),'tamper\n');
    assert.equal(await phaseDEvidenceIntact(fx.config,s),false);
  }finally{await fx.cleanup();}
});
test('D: extra tool calls cannot be reduced into one silently passing result',async()=>{
  const fx=await fixture();try{
    const s=await cycle(fx,await approved(fx),verifier(fx,['PASS'],{multicall:true}),prepareFixture(fx),fakeClock(),true);
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.status,'WAITING_RETRY');
    assert.equal(s.validationHistory.at(-1).verdict,'UNVERIFIABLE');
  }finally{await fx.cleanup();}
});
test('D: real build+test stage executes from COPY and does not change original worktree',async()=>{
  const {stageAndTestCandidate}=await import('../dist/phased.js');
  const fx=await fixture();try{
    const m={name:'mock-mcp',version:'1.0',scripts:{
      build:'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/index.js\',\'new output\')"',
      test:'node -e "if(require(\'fs\').readFileSync(\'dist/index.js\',\'utf8\')!==\'new output\')process.exit(1)"'}};
    await writeFile(path.join(fx.worktree,'package.json'),JSON.stringify(m));
    await mkdir(path.join(fx.worktree,'dist'));await writeFile(path.join(fx.worktree,'dist','index.js'),'STALE\n');
    const sourceBefore=await readFile(path.join(fx.worktree,'dist','index.js'),'utf8');
    const out=await stageAndTestCandidate(fx.worktree,path.join(fx.outputDir,'tasks',fx.s.taskId),1,1);
    assert.equal(out.build.ok,true);assert.equal(out.regression.ok,true);
    assert.equal(await readFile(out.candidate,'utf8'),'new output');
    assert.equal(await readFile(path.join(fx.worktree,'dist','index.js'),'utf8'),sourceBefore);
  }finally{await fx.cleanup();}
});
test('D: npm build successful but stale/unbuilt dist cannot be reused',async()=>{
  const {stageAndTestCandidate}=await import('../dist/phased.js');
  const fx=await fixture();try{
    await writeFile(path.join(fx.worktree,'package.json'),JSON.stringify({scripts:{
      build:'node -e "process.exit(0)"',test:'node -e "process.exit(0)"'}}));
    await mkdir(path.join(fx.worktree,'dist'));await writeFile(path.join(fx.worktree,'dist','index.js'),'OLD\n');
    const out=await stageAndTestCandidate(fx.worktree,path.join(fx.outputDir,'tasks',fx.s.taskId),1,1);
    assert.equal(out.build.ok,false);assert.match(out.build.stderr,/FRESH_DIST/);
    assert.equal((await stat(out.candidate).catch(()=>null)),null);
  }finally{await fx.cleanup();}
});
