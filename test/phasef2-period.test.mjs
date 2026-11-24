import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runAgentHarness} from '../dist/agent.js';
import {relativeReplayFromBaseline,relativeReplayArgs,sameRelativeQuery} from '../dist/replay.js';
import {createTask,writeTransition,withWorkflowLock} from '../dist/workflow.js';
import {analyzeTask,preFixCycle} from '../dist/phasec.js';
import {modifyTask} from '../dist/phasec2.js';
import {finalVerifyCycle} from '../dist/phased.js';
import {submitTask,phaseEEvidenceIntact} from '../dist/phasee.js';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
const hash=s=>createHash('sha256').update(s).digest('hex');
const beginning=Date.parse('2026-11-22T16:09:46Z');
const args={path:'v2/sys/server_base',projectCode:33194,timeRange:'5m',limit:150};
const diagnosis={classification:'MCP_DEFECT',problem:'서버 CPU 값 불일치',impact:'잘못된 CPU 사용률 표시',
  causeHypothesis:'MCP 수치 직렬화 오류',reproductionSteps:['상대시간 5m 조회','응답 Period 를 HTTP 로 대조'],
  expectedResult:'8.10',actualResult:'99.99',candidateFiles:['src/index.ts'],recommendedChange:'필드 변환 정정',
  limitations:['모의 통합 테스트'],confidence:'MEDIUM'};
const candidate=resolve('test/mock-f2-relative.mjs'),reference=resolve('test/mock-f2-reference.mjs');
const scenario={id:'server-metrics',domain:'server',projectCode:33194,mcpPath:'v2/sys/server_base',
  allowedMcpPaths:['v2/sys/server_base'],matchKeys:['time','_id_'],compareFields:['cpu','memory_pused'],
  referenceTool:'whatap_http_server_metrics'};
const clock={now:()=>Date.now()+200000,sleep:async()=>{}};
function inputReport(){return {id:'server-metrics',mcpTool:'whatap_query_data',mcpPath:'v2/sys/server_base',
  status:'FAIL',reason:'FIELD_MISMATCH',timeWindow:{stime:beginning,etime:beginning+300000},candidate:{args},reference:{}};}
function baseConfig(outputDir){return {replayPolicy:'PERIOD_PAIRED',outputDir,servers:{candidate,reference},
  rpcTimeoutMs:20000,retryCount:0,scenarios:[scenario]};}
test('F2: relative query args preserved; invalid absolute/multiple MCP call rejected',()=>{
 const replay=relativeReplayFromBaseline(inputReport());
 assert.deepEqual(relativeReplayArgs(replay),args);
 assert.equal(sameRelativeQuery(replay,{...inputReport(),candidate:{args:{...args}}}),true);
 assert.equal(sameRelativeQuery(replay,{...inputReport(),candidate:{args:{...args,limit:200}}}),false);
 assert.throws(()=>relativeReplayFromBaseline({...inputReport(),callResults:[{}]}));
 assert.throws(()=>relativeReplayFromBaseline({...inputReport(),candidate:{args:{...args,etime:15}}}));
});
test('F2: directly invokes relative-only MCP, extracts Period, independently compares HTTP, no Codex',async()=>{
 const root=await mkdtemp(join(tmpdir(),'f2-direct-'));
 try{
  process.env.F2_MOCK_COUNTER_FILE=join(root,'counter');
  process.env.F2_MOCK_BAD='0';
  const out=await runAgentHarness(baseConfig(root),{scenarioId:'server-metrics',relativeReplay:relativeReplayFromBaseline(inputReport())});
  assert.equal(out.scenarios[0].status,'PASS',out.scenarios[0].reason);
  assert.equal(out.relativeReplayAudit.mode,'DIRECT_RELATIVE_MCP_CALL');
  assert.equal(out.relativeReplayAudit.toolCalls,1);
  assert.equal(out.relativeReplayAudit.schemaVerified,true);
  assert.equal(out.relativeReplayAudit.periodObserved,true);
  assert.equal(out.scenarios[0].timeWindow.stime,beginning+10000);
  assert.deepEqual(out.scenarios[0].candidate.args,args);
  assert.equal(out.fixedReplayAudit,undefined);
  process.env.F2_MOCK_BAD='1';
  const bad=await runAgentHarness(baseConfig(root),{scenarioId:'server-metrics',relativeReplay:relativeReplayFromBaseline(inputReport())});
  assert.equal(bad.scenarios[0].status,'FAIL',bad.scenarios[0].reason);
  assert.equal(bad.scenarios[0].reason,'FIELD_MISMATCH');
  assert.equal(bad.scenarios[0].timeWindow.stime,beginning+20000);
 }finally{delete process.env.F2_MOCK_COUNTER_FILE;delete process.env.F2_MOCK_BAD;await rm(root,{recursive:true,force:true});}
});
test('F2: no relative schema or missing Period cannot produce PASS',async()=>{
 const root=await mkdtemp(join(tmpdir(),'f2-refuse-'));
 try{
  process.env.F2_MOCK_NO_SCHEMA='1';
  let out=await runAgentHarness(baseConfig(root),{scenarioId:'server-metrics',relativeReplay:relativeReplayFromBaseline(inputReport())});
  assert.notEqual(out.scenarios[0].status,'PASS');
  assert.equal(out.relativeReplayAudit.toolCalls,0);
  delete process.env.F2_MOCK_NO_SCHEMA;
  process.env.F2_MOCK_NO_PERIOD='1';
  out=await runAgentHarness(baseConfig(root),{scenarioId:'server-metrics',relativeReplay:relativeReplayFromBaseline(inputReport())});
  assert.notEqual(out.scenarios[0].status,'PASS');
  assert.equal(out.relativeReplayAudit.periodObserved,false);
 }finally{delete process.env.F2_MOCK_NO_SCHEMA;delete process.env.F2_MOCK_NO_PERIOD;await rm(root,{recursive:true,force:true});}
});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'f2-flow-'));
 const main=join(root,'main'),agent=join(root,'agent'),outputDir=join(root,'runs');
 await mkdir(join(main,'src'),{recursive:true});await mkdir(join(main,'dist'));
 await writeFile(join(main,'src/index.ts'),'export const corrected = false;\n');
 const source=await readFile(candidate,'utf8');
 await writeFile(join(main,'dist/index.js'),source.replace("const badData=process.env.F2_MOCK_BAD==='1';","const badData=true;"));
 await writeFile(join(main,'package.json'),'{"type":"module"}\n');
 git('init','-q','-b','submission',main);
 git('-C',main,'config','user.name','Test');git('-C',main,'config','user.email','test@example.invalid');
 git('-C',main,'add','.');git('-C',main,'commit','-qm','baseline');
 git('-C',main,'worktree','add','-qb','agent',agent);
 const config={...baseConfig(outputDir),servers:{candidate:join(agent,'dist/index.js'),reference}};
 let s=await withWorkflowLock(outputDir,()=>createTask(outputDir,'server-metrics'));
 const history=[];
 for(let i=1;i<=4;i++){
  const runDir=join(root,`baseline-${i}`);await mkdir(runDir);
  const candidateData=JSON.stringify({content:[{type:'text',text:'baseline sample'}]})+'\n';
  const referenceData=JSON.stringify({content:[{type:'text',text:'HTTP sample'}]})+'\n';
  await writeFile(join(runDir,'candidate.json'),candidateData);await writeFile(join(runDir,'reference.json'),referenceData);
  const sc={...inputReport(),candidate:{args,file:'candidate.json',sha256:hash(candidateData)},
    reference:{file:'reference.json',sha256:hash(referenceData)}};
  const body=JSON.stringify({runDir,scenarios:[sc]})+'\n';await writeFile(join(runDir,'report.json'),body);
  history.push({phase:'INITIAL_VERIFY',ordinal:i,startedAt:new Date().toISOString(),verdict:'FAIL',
    reason:'FIELD_MISMATCH',timeWindow:sc.timeWindow,evidence:{runDir,reportSha256:hash(body),verdict:'FAIL',at:new Date().toISOString()}});
 }
 s=await withWorkflowLock(outputDir,()=>writeTransition(outputDir,s,{phase:'ANALYZING',status:'PAUSED',
   validationHistory:history,latestValidation:history.at(-1).evidence,
   validationRetries:{INITIAL_VERIFY:3,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}},'TEST_BASELINE','mock only'));
 return {root,agent,outputDir,s,config,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('F2: C1 requires two independent new mismatches across distinct observed Periods before source-edit permission',async()=>{
 const fx=await fixture();
 try{
  process.env.F2_MOCK_COUNTER_FILE=join(fx.root,'counter');
  let s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.agent,async()=>diagnosis));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,undefined,true));
  assert.equal(s.phase,'PRE_FIX_VERIFY');assert.equal(s.status,'WAITING_RETRY');
  assert.equal(s.preFix.reproduced,false);
  assert.equal(s.validationHistory.at(-1).verdict,'FAIL');
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,clock,true));
  assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');
  assert.equal(s.preFix.reproduced,true);assert.equal(s.preFix.mode,'PERIOD_PAIRED');
  assert.equal(s.preFix.sameAbsolutePeriod,false);
  const a=s.validationHistory.filter(x=>x.phase==='PRE_FIX_VERIFY');
  assert.equal(a.length,2);
  assert.notEqual(a[0].timeWindow.stime,a[1].timeWindow.stime);
  const d=JSON.parse(await readFile(join(fx.outputDir,'tasks',s.taskId,'prefx-report.json')));
  assert.equal(d.independentFailuresInDistinctWindows,2);
 }finally{delete process.env.F2_MOCK_COUNTER_FILE;await fx.cleanup();}
});
test('F2: C1 paired gate > C2 edit > D requires two independent PASS in distinct Periods; no Git',async()=>{
 const fx=await fixture();
 try{
  process.env.F2_MOCK_COUNTER_FILE=join(fx.root,'counter');
  let s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.agent,async()=>diagnosis));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,undefined,true));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,clock,true));
  s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
    await writeFile(join(fx.agent,'src/index.ts'),'export const corrected = true;\n');
    return {summary:'fixed',rationale:'correct conversion',testsRun:['offline'],risks:[]};
  }));
  assert.equal(s.phase,'FINAL_VERIFY');
  const prepare=async(_worktree,taskDir,editOrdinal,ordinal)=>{
    const stageDir=join(taskDir,`f2-fixture-${editOrdinal}-${ordinal}`);await mkdir(stageDir,{recursive:true});
    const outfile=join(stageDir,'index.js');await copyFile(candidate,outfile);
    await writeFile(join(stageDir,'package.json'),'{"type":"module"}\n');
    const ok={ok:true,exitCode:0,stdout:'offline mock',stderr:'',durationMs:1};
    return {stageDir,candidate:outfile,build:ok,regression:ok};
  };
  s=await withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,undefined,undefined,true,prepare));
  assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.status,'WAITING_RETRY');
  assert.equal(s.validationHistory.at(-1).verdict,'PASS');
  s=await withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,undefined,clock,true,prepare));
  assert.equal(s.phase,'COMMITTING');assert.equal(s.status,'PAUSED');
  const reports=s.validationHistory.filter(x=>x.phase==='FINAL_VERIFY');
  assert.equal(reports.length,2);assert.notEqual(reports[0].timeWindow.stime,reports[1].timeWindow.stime);
  assert.equal(git('-C',fx.agent,'branch','--show-current'),'agent');
  assert.equal(git('-C',fx.agent,'log','-1','--format=%s'),'baseline');
 }finally{delete process.env.F2_MOCK_COUNTER_FILE;await fx.cleanup();}
});

test('F6 isolated MCP fault injection: read-only diagnosis > paired C1/C2/D > agent commit/push > mocked PR; no merge',async()=>{
 const fx=await fixture();
 try{
  process.env.F2_MOCK_COUNTER_FILE=join(fx.root,'counter');
  process.env.HARNESS_PUBLISH_PUBLIC_METRICS='YES';
  // Upgrade historical fixture evidence to actual hashed transport messages rather than placeholders.
  const format=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';
  for(let i=1;i<=4;i++){
    const dir=join(fx.root,`baseline-${i}`),stime=beginning,etime=beginning+300000;
    const mcp={content:[{type:'text',text:`**Period**: ${format(stime)} → ${format(etime)}\n\n| time | _id_ | _name_ | cpu (%) | memory_pused (%) |\n| --- | --- | --- | --- | --- |\n| ${format(stime+5000)} | 1 | srv1 | 99.99 | 60.20 |\n`}]};
    const http={content:[{type:'text',text:JSON.stringify({ok:true,status:200,
      body:[{time:stime+5000,_id_:'1',cpu:8.1,memory_pused:60.2}]})}]};
    const c=JSON.stringify(mcp)+'\n',r=JSON.stringify(http)+'\n';
    await writeFile(join(dir,'candidate.json'),c);await writeFile(join(dir,'reference.json'),r);
    const reportFile=join(dir,'report.json');
    const rep=JSON.parse(await readFile(reportFile));
    rep.scenarios[0].candidate.sha256=hash(c);rep.scenarios[0].reference.sha256=hash(r);
    const contents=JSON.stringify(rep)+'\n';await writeFile(reportFile,contents);
    fx.s.validationHistory[i-1].evidence.reportSha256=hash(contents);
    if(i===4)fx.s.latestValidation=fx.s.validationHistory[i-1].evidence;
  }
  // Persist updated baseline state via supported transition (with real checksums).
  let s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,fx.s,
    {validationHistory:fx.s.validationHistory,latestValidation:fx.s.latestValidation},'F3_SEEDED_EVIDENCE','hashed baseline fixtures'));
  s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,s,fx.agent,async()=>diagnosis));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,undefined,true));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,undefined,clock,true));
  s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
    await writeFile(join(fx.agent,'src/index.ts'),'export const corrected = true;\n');
    return {summary:'fixed',rationale:'correct conversion',testsRun:['offline'],risks:[]};
  }));
  const prepare=async(_worktree,taskDir,editOrdinal,ordinal)=>{
    const stageDir=join(taskDir,`f3-fixture-${editOrdinal}-${ordinal}`);await mkdir(stageDir,{recursive:true});
    const outfile=join(stageDir,'index.js');await copyFile(candidate,outfile);
    await writeFile(join(stageDir,'package.json'),'{}\n');
    const ok={ok:true,exitCode:0,stdout:'verified',stderr:'',durationMs:1};
    return {stageDir,candidate:outfile,build:ok,regression:ok};
  };
  s=await withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,undefined,undefined,true,prepare));
  s=await withWorkflowLock(fx.outputDir,()=>finalVerifyCycle(fx.config,s,undefined,clock,true,prepare));
  assert.equal(s.phase,'COMMITTING');
  const {buildSubmissionReport}=await import('../dist/submission-report.js');
  const out=await buildSubmissionReport(fx.config,s,{publishMetrics:true});
  assert.equal(out.rowCount,16);
  assert.match(out.body,/독립 검증/);
  assert.match(out.parts.join(''),/99\.99/);
  assert.match(out.parts.join(''),/8\.1/);
  assert.match(out.parts.join(''),/FAIL/);
  assert.match(out.parts.join(''),/PASS/);
  const remote=join(fx.root,'remote.git');
  git('init','--bare','-q',remote);git('-C',join(fx.root,'main'),'remote','add','origin',remote);
  git('-C',join(fx.root,'main'),'push','-q','origin','submission','agent');
  let pr=null,parts=[];
  const refs=()=>Object.fromEntries(git('-C',fx.agent,'ls-remote','--heads','origin').split('\n').filter(Boolean).map(x=>{
    const [id,ref]=x.split(/\s+/);return [ref,id];}));
  const host={async remoteHeads(){const x=refs();return {agent:x['refs/heads/agent'],submission:x['refs/heads/submission']};},
    async publish(wt,commit){git('-C',wt,'push','-q','origin',`${commit}:refs/heads/agent`);},
    async listOpen(){return pr?[pr]:[]},
    async createPr(wt,title,body){pr={number:17,url:'https://github.com/test/sample/pull/17',headOid:git('-C',wt,'rev-parse','HEAD'),
       headRefName:'agent',baseRefName:'submission',body,state:'OPEN',mergedAt:null,title};return pr;},
    async viewPr(){return pr;},
    async publishReportParts(_wt,_number,_task,values){parts=values;},
    async reportPartsMatch(_wt,_number,_task,values){return JSON.stringify(parts)===JSON.stringify(values);}};
  let result=await withWorkflowLock(fx.outputDir,()=>submitTask(fx.config,s,host));
  assert.equal(result.phase,'PR_OPEN');assert.equal(result.submission.prNumber,17);
  assert.equal(pr.body,out.body);assert.deepEqual(parts,out.parts);
  assert.equal(git('-C',join(fx.root,'main'),'rev-parse','submission'),s.analysis.head);
  assert.equal(await phaseEEvidenceIntact(fx.config,result),true);
 }finally{delete process.env.F2_MOCK_COUNTER_FILE;delete process.env.HARNESS_PUBLISH_PUBLIC_METRICS;await fx.cleanup();}
});
