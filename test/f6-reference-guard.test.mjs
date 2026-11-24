import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';
import {createTask,withWorkflowLock,writeTransition} from '../dist/workflow.js';
import {runValidationCycle} from '../dist/workflow-cli.js';
import {fingerprint,analyzeTask} from '../dist/phasec.js';
import {nextAction} from '../tools/auto-campaign.mjs';
import {recoveryClass,writeCampaignReport} from '../tools/campaign-report.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const withRoot=async fn=>{const root=await mkdtemp(join(tmpdir(),'f6-reference-'));try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}};
const scenario='apm-transaction-stats';
async function config(root){
 const {config:c}=await loadConfig(resolve('config/harness.json'));
 c.servers.reference=resolve('test/mock-reference-statistics.mjs');
 c.servers.candidate=resolve('test/mock-codex-statistics.mjs');
 c.outputDir=root;c.rpcTimeoutMs=15000;c.replayPolicy='PERIOD_PAIRED';return c;
}
const clock=()=>{let t=Date.now()+120000;return {now:()=>t,sleep:async ms=>{t+=ms}};};
const credentials=async fn=>{
 const old=Object.fromEntries(['WHATAP_API_TOKEN','WHATAP_HTTP_API_TOKEN','MOCK_STATS_V2_BAD'].map(k=>[k,process.env[k]]));
 process.env.WHATAP_API_TOKEN='f6-offline-fixture';process.env.WHATAP_HTTP_API_TOKEN='f6-offline-fixture';
 try{return await fn();}finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
};
test('F6: direct HTTP v2 discrepancy is REFERENCE_INCONSISTENCY; a real MCP display mismatch remains FAIL',()=>withRoot(async root=>{
 const c=await config(root);
 await credentials(async()=>{
  process.env.MOCK_STATS_V2_BAD='1';
  const r=await runAgentHarness(c,{scenarioId:scenario,command:process.execPath,
    commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});
  assert.equal(r.scenarios[0].status,'UNVERIFIABLE');
  assert.equal(r.scenarios[0].reason,'REFERENCE_INCONSISTENCY');
  assert.ok(r.scenarios[0].checks.some(x=>x.code==='STATS_AGGREGATE'&&!x.ok));
  assert.equal(fingerprint(r.scenarios[0]),null);
  process.env.MOCK_STATS_V2_BAD='0';
  process.env.MOCK_STATS_CANDIDATE_BAD='1';
  try{
   const broken=await runAgentHarness(c,{scenarioId:scenario,command:process.execPath,
    commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});
   assert.equal(broken.scenarios[0].status,'FAIL');
   assert.notEqual(broken.scenarios[0].reason,'REFERENCE_INCONSISTENCY');
  }finally{delete process.env.MOCK_STATS_CANDIDATE_BAD;}
 });
}));
test('F6: four independent HTTP reference contradictions cannot enter Codex analysis or editing',()=>withRoot(async root=>{
 const c=await config(root);
 await credentials(async()=>{
  process.env.MOCK_STATS_V2_BAD='1';
  let s=await withWorkflowLock(root,()=>createTask(root,scenario));
  const invoked=[];
  const mockedVerifier=async(conf,opts)=>{
   invoked.push(opts);
   return runAgentHarness(conf,{scenarioId:scenario,command:process.execPath,
     commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});
  };
  s=await withWorkflowLock(root,()=>runValidationCycle(c,s,mockedVerifier,clock()));
  assert.equal(s.status,'BLOCKED');assert.equal(s.phase,'INITIAL_VERIFY');
  assert.equal(s.validationHistory.length,4);
  assert.deepEqual(s.validationHistory.map(x=>x.verdict),Array(4).fill('UNVERIFIABLE'));
  assert.deepEqual(s.validationHistory.map(x=>x.reason),Array(4).fill('REFERENCE_INCONSISTENCY'));
  assert.equal(invoked.length,4);
  assert.equal(nextAction(s,{allowEdit:true,allowGit:true,continueBlocked:true}).kind,'close');
  await assert.rejects(()=>analyzeTask(c,s,root,async()=>{throw Error('not expected');}),/Diagnosis not allowed/);
  assert.equal(s.editHistory?.length??0,0);
 });
}));
test('F6: legacy F5 HTTP-v2-only FAIL evidence is not accepted as an MCP defect fingerprint',()=>{
 const sc={id:scenario,status:'FAIL',reason:'STATS_AGGREGATE_DIFFERENCE',
  mcpPath:'mxql/app/stat_tx_pcode',candidate:{args:{path:'mxql/app/stat_tx_pcode',projectCode:5490,timeRange:'1h'}}};
 assert.equal(fingerprint(sc),null);
 assert.equal(fingerprint({...sc,reason:'REFERENCE_INCONSISTENCY'}),null);
 assert.notEqual(fingerprint({...sc,reason:'FIELD_MISMATCH'}),null);
});
test('F6: recovered reference instability produces separate category, frozen HTTP evidence and Korean report',()=>withRoot(async root=>{
 const c=await config(root);let s=await withWorkflowLock(root,()=>createTask(root,scenario));
 const attempts=[];
 for(const [i,status,reason] of [[1,'UNVERIFIABLE','REFERENCE_INCONSISTENCY'],[2,'PASS','STATS_AGGREGATE_MATCH']]){
  const dir=join(root,`fixture-${i}`);await mkdir(dir);
  const report={scenarios:[{id:scenario,status,reason,
    timeWindow:{stime:1795461900000+i*5000,etime:1795465500000+i*5000},
    candidate:{parsedRows:100},reference:{statistics:{fullMxqlRows:25000,v2RowCount:i===1?80:100,comparedBuckets:11}},checks:[]}]};
  const body=JSON.stringify(report)+'\n';await writeFile(join(dir,'report.json'),body);
  attempts.push({phase:'INITIAL_VERIFY',ordinal:i,verdict:status,reason,
   startedAt:new Date().toISOString(),timeWindow:report.scenarios[0].timeWindow,
   evidence:{runDir:dir,reportSha256:sha(body),verdict:status,at:new Date().toISOString()}});
 }
 s=await withWorkflowLock(root,()=>writeTransition(root,s,{phase:'DONE',status:'COMPLETED',
  validationHistory:attempts,latestValidation:attempts[1].evidence},'F6_TEST','stable'));
 assert.equal(recoveryClass(s),'RECOVERED_REFERENCE');
 let investigated=0;let diagnosed=0;
 const r=await writeCampaignReport({outputDir:root,worktree:root,config:c,
  results:[{scenarioId:scenario,taskId:s.taskId}],incidentAnalyzer:async()=>{
   diagnosed++;return {classification:'TRANSIENT_BACKEND',summary:'원인 미확정',confirmedFacts:[],plausibleCauses:[],unknowns:[],nextVerification:[]};
  },frozenInvestigator:async()=>{
   investigated++;return {status:'COMPLETED',manifestPath:join(root,'evidence','manifest.json'),
    snapshots:[{index:1,status:'MATCH'},{index:2,status:'MATCH'}],bucketProbes:[{status:'MATCH'}],
    initial:{window:{stime:1795461905000,etime:1795465505000},mxqlGroups:100,v2Groups:80,different:20,missingV2:0}};
  }});
 assert.equal(investigated,1);assert.equal(diagnosed,1);
 const md=await readFile(r.mdPath,'utf8');
 assert.match(md,/RECOVERED_REFERENCE/);assert.match(md,/TRANSIENT_REFERENCE/);
 assert.match(md,/F6 최초 기준 불일치 기간 고정 HTTP 사후 재조회/);
 const report=JSON.parse(await readFile(r.jsonPath,'utf8'));
 assert.equal(report.tasks[0].referenceDisposition,'TRANSIENT_REFERENCE');
 assert.equal(report.tasks[0].classification,'RECOVERED_REFERENCE');
 assert.equal(s.editHistory?.length??0,0);
}));
test('F6: F5 legacy reference-only FAIL report replays without rewriting the historical verdict',()=>withRoot(async root=>{
 const c=await config(root);
 await credentials(async()=>{
  process.env.MOCK_STATS_V2_BAD='1';
  const r=await runAgentHarness(c,{scenarioId:scenario,command:process.execPath,
   commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});
  const file=join(r.runDir,'report.json');const doc=JSON.parse(await readFile(file,'utf8'));
  doc.harnessVersion='0.5.0-alpha.11-f5-forensics';
  doc.scenarios[0].status='FAIL';doc.scenarios[0].reason='STATS_AGGREGATE_DIFFERENCE';
  doc.totals={PASS:0,FAIL:1,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0};
  await writeFile(file,JSON.stringify(doc)+'\n');
  const {spawnSync}=await import('node:child_process');
  const replay=spawnSync(process.execPath,['tools/replay-run.mjs',r.runDir],{cwd:resolve('.'),encoding:'utf8'});
  assert.equal(replay.status,0,replay.stderr+'\n'+replay.stdout);
  assert.match(replay.stdout,/F5 레거시 FAIL=F6 기준 불일치/);
  assert.match(replay.stdout,/판정 불일치\/증거 오류 0개/);
 });
}));
test('F6: persistent reference contradiction is reported with no recovery or edit authorization',()=>withRoot(async root=>{
 const c=await config(root);let s=await withWorkflowLock(root,()=>createTask(root,scenario));
 const dir=join(root,'reference-unresolved');await mkdir(dir);
 const sc={id:scenario,status:'UNVERIFIABLE',reason:'REFERENCE_INCONSISTENCY',
   timeWindow:{stime:1795461900000,etime:1795465500000},
   reference:{statistics:{fullMxqlRows:21000,v2RowCount:80,comparedBuckets:11}},candidate:{parsedRows:100},checks:[]};
 const body=JSON.stringify({scenarios:[sc]})+'\n';await writeFile(join(dir,'report.json'),body);
 const at=new Date().toISOString();
 const a={phase:'INITIAL_VERIFY',ordinal:1,verdict:'UNVERIFIABLE',reason:'REFERENCE_INCONSISTENCY',startedAt:at,
   evidence:{runDir:dir,reportSha256:sha(body),verdict:'UNVERIFIABLE',at}};
 s=await withWorkflowLock(root,()=>writeTransition(root,s,{status:'BLOCKED',validationHistory:[a],
   latestValidation:a.evidence,lastError:'UNVERIFIABLE_RETRIES_EXHAUSTED'},'F6_MOCK_BLOCK','reference only'));
 const r=await writeCampaignReport({outputDir:root,worktree:root,config:c,
  results:[{scenarioId:scenario,taskId:s.taskId}],
  frozenInvestigator:async()=>({status:'COMPLETED',snapshots:[{status:'DIFFERENCE'},{status:'DIFFERENCE'}],bucketProbes:[]}),
  incidentAnalyzer:async()=>({classification:'OTHER_UNPROVEN',summary:'unresolved',confirmedFacts:[],plausibleCauses:[],unknowns:[],nextVerification:[]})});
 const doc=JSON.parse(await readFile(r.jsonPath,'utf8'));
 assert.equal(doc.tasks[0].referenceDisposition,'PERSISTENT_REFERENCE');
 assert.equal(doc.tasks[0].editHistory.length,0);
 assert.match(await readFile(r.mdPath,'utf8'),/PERSISTENT_REFERENCE/);
}));
