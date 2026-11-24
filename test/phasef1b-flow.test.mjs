import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,withWorkflowLock} from '../dist/workflow.js';
import {analyzeTask,preFixCycle} from '../dist/phasec.js';
import {modifyTask} from '../dist/phasec2.js';
import {finalVerifyCycle} from '../dist/phased.js';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
const hash=s=>createHash('sha256').update(s).digest('hex');
const stime=Date.parse('2026-11-22T16:09:46Z'),etime=Date.parse('2026-11-22T16:14:46Z');
const args={path:'v2/sys/server_base',projectCode:33194,timeRange:'5m',limit:150};
const diagnosis={classification:'MCP_DEFECT',problem:'서버 CPU 값 불일치',impact:'잘못된 CPU 사용률 표시',
  causeHypothesis:'MCP 테이블 형식 변환 오류',reproductionSteps:['같은 기간으로 조회','HTTP와 대조'],
  expectedResult:'CPU 값이 8.10',actualResult:'CPU 값이 99.99',candidateFiles:['src/index.ts'],
  recommendedChange:'값 변환 로직 수정',limitations:['모의 테스트'],confidence:'MEDIUM'};
const src=resolve('test/mock-f1b-server.mjs');
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'phase-f1b-flow-'));
  const main=join(root,'main'),agent=join(root,'agent'),outputDir=join(root,'runs');
  await mkdir(join(main,'src'),{recursive:true});await mkdir(join(main,'dist'));
  await writeFile(join(main,'src','index.ts'),'export const corrected = false;\n');
  await writeFile(join(main,'dist','index.js'),(await readFile(src,'utf8')).replace("const badData=name.includes('bad-data');",'const badData=true;'));
  await writeFile(join(main,'package.json'),'{"type":"module"}\n');
  git('init','-q','-b','submission',main);
  git('-C',main,'config','user.name','Test');git('-C',main,'config','user.email','test@example.invalid');
  git('-C',main,'add','.');git('-C',main,'commit','-qm','baseline');
  git('-C',main,'worktree','add','-qb','agent',agent);
  const config={outputDir,servers:{candidate:join(agent,'dist/index.js'),reference:resolve('test/mock-f1b-reference.mjs')},
    rpcTimeoutMs:10000,retryCount:0,scenarios:[{id:'server-metrics',domain:'server',
      projectCode:33194,mcpPath:'v2/sys/server_base',allowedMcpPaths:['v2/sys/server_base'],
      matchKeys:['time','_id_'],compareFields:['cpu','memory_pused'],referenceTool:'whatap_http_server_metrics'}]};
  let s=await withWorkflowLock(outputDir,()=>createTask(outputDir,'server-metrics'));
  const history=[];
  for(let i=1;i<=4;i++){
    const runDir=join(root,`baseline-${i}`);await mkdir(runDir);
    const candidateData=JSON.stringify({content:[{type:'text',text:'baseline sample'}]})+'\n';
    const referenceData=JSON.stringify({content:[{type:'text',text:'HTTP sample'}]})+'\n';
    await writeFile(join(runDir,'candidate.json'),candidateData);await writeFile(join(runDir,'reference.json'),referenceData);
    const sc={id:'server-metrics',mcpTool:'whatap_query_data',mcpPath:'v2/sys/server_base',
      status:'FAIL',reason:'FIELD_MISMATCH',timeWindow:{stime,etime},
      candidate:{args,file:'candidate.json',sha256:hash(candidateData)},
      reference:{file:'reference.json',sha256:hash(referenceData)}};
    const body=JSON.stringify({runDir,scenarios:[sc]})+'\n';await writeFile(join(runDir,'report.json'),body);
    history.push({phase:'INITIAL_VERIFY',ordinal:i,startedAt:new Date().toISOString(),verdict:'FAIL',
      reason:'FIELD_MISMATCH',timeWindow:{stime,etime},
      evidence:{runDir,reportSha256:hash(body),verdict:'FAIL',at:new Date().toISOString()}});
  }
  s=await withWorkflowLock(outputDir,()=>writeTransition(outputDir,s,{phase:'ANALYZING',status:'PAUSED',
    validationHistory:history,latestValidation:history.at(-1).evidence,
    validationRetries:{INITIAL_VERIFY:3,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}},'TEST_BASELINE','mock only'));
  return {root,main,agent,config,outputDir,s,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function throughPreFix(fx){
  let s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.agent,async()=>diagnosis));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,undefined,true));
  return s;
}
test('F1-B integration: real default C1 gate replays fixed period with MCP+HTTP and authorizes C2 only on reproduced FAIL',async()=>{
  const fx=await fixture();
  try {
    const s=await throughPreFix(fx);
    assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');
    assert.equal(s.preFix.reproduced,true);assert.equal(s.preFix.sameAbsolutePeriod,true);
    const report=JSON.parse(await readFile(join(s.preFix.runDir,'report.json')));
    assert.equal(report.scenarios[0].status,'FAIL');
    assert.equal(report.scenarios[0].reason,'FIELD_MISMATCH');
    assert.equal(report.fixedReplayAudit.mode,'DIRECT_MCP_TOOL_CALL');
    assert.equal(report.fixedReplayAudit.toolCalls,1);
    assert.deepEqual(report.fixedReplayAudit.requestedWindow,{stime,etime});
    assert.equal(report.scenarios[0].candidate.args.timeRange,undefined);
    assert.equal(report.scenarios[0].candidate.args.limit,150);
    assert.equal(git('-C',fx.main,'branch','--show-current'),'submission');
  }finally{await fx.cleanup();}
});
test('F1-B integration: C1 fixed replay > C2 edit > D final direct fixed replay PASS without Git',async()=>{
  const fx=await fixture();
  try{
    let s=await throughPreFix(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await writeFile(join(fx.agent,'src','index.ts'),'export const corrected = true;\n');
      return {summary:'fixed',rationale:'correct conversion',testsRun:['offline'],risks:[]};
    }));
    assert.equal(s.phase,'FINAL_VERIFY');
    const prepare=async(_worktree,taskDir,editOrdinal,ordinal)=>{
      const stageDir=join(taskDir,`f1b-fixture-${editOrdinal}-${ordinal}`);
      await mkdir(stageDir,{recursive:true});
      await writeFile(join(stageDir,'package.json'),'{"type":"module"}\n');
      const candidate=join(stageDir,'index.js');
      await copyFile(src,candidate);
      const ok={ok:true,exitCode:0,stdout:'offline mock',stderr:'',durationMs:1};
      return {stageDir,candidate,build:ok,regression:ok};
    };
    s=await withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,undefined,undefined,true,prepare));
    assert.equal(s.phase,'COMMITTING');assert.equal(s.status,'PAUSED');
    assert.equal(s.validationHistory.at(-1).verdict,'PASS');
    const last=s.validationHistory.at(-1);
    const report=JSON.parse(await readFile(join(last.evidence.runDir,'report.json')));
    assert.equal(report.scenarios[0].status,'PASS');
    assert.deepEqual(report.fixedReplayAudit.requestedWindow,{stime,etime});
    assert.equal(report.fixedReplayAudit.toolCalls,1);
    assert.equal(git('-C',fx.main,'branch','--show-current'),'submission');
    assert.equal(git('-C',fx.main,'status','--porcelain'),'');
  }finally{await fx.cleanup();}
});
