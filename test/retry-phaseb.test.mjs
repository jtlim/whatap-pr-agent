import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  withWorkflowLock,createTask,readTask,writeTransition,recoverTask,taskDir,retryDelayMs,MAX_VALIDATION_RETRIES,
} from '../dist/workflow.js';
import {initialVerify,runValidationCycle,validationHistoryIntact} from '../dist/workflow-cli.js';
import {loadConfig} from '../dist/config.js';

async function sandbox(fn){const out=await mkdtemp(join(tmpdir(),'whatap-phase-b-'));
  try{return await fn(out);}finally{await rm(out,{recursive:true,force:true});}}
async function setup(out){
 const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
 config.outputDir=out;
 config.servers.candidate=resolve('test/mock-codex-statistics.mjs');
 config.servers.reference=resolve('test/mock-reference-statistics.mjs');
 process.env.WHATAP_API_TOKEN='phase-b-test-token';
 process.env.WHATAP_HTTP_API_TOKEN='phase-b-test-token';
 const state=await withWorkflowLock(out,()=>createTask(out,'apm-exception-stats'));
 return {config,state};
}
function clock(start=1795429000000){let t=start;const sleeps=[];
 return {now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},get sleeps(){return sleeps;},advance:ms=>{t+=ms;}};
}
function executor(statuses){let i=0;const calls=[];
 const fn=async cfg=>{
   const verdict=statuses[Math.min(i,statuses.length-1)];calls.push(verdict);i++;
   if(verdict instanceof Error)throw verdict;
   const runDir=join(cfg.outputDir,'fake-report-'+i+'-'+Date.now());
   await mkdir(runDir,{mode:0o700});
   await writeFile(join(runDir,'report.json'),JSON.stringify({scenarios:[{status:verdict,reason:'MOCK_'+verdict}]}),{mode:0o600});
   await writeFile(join(runDir,'report.md'),'mock report',{mode:0o600});
   return {runDir,scenarios:[{status:verdict,reason:'MOCK_'+verdict}]};
 };
 return {fn,calls};
}

test('Phase B: retry schedule is 30/60/120 seconds and cannot exceed max budget',()=>{
 assert.deepEqual([0,1,2].map(retryDelayMs),[30000,60000,120000]);
 assert.equal(MAX_VALIDATION_RETRIES,3);
 assert.throws(()=>retryDelayMs(3));assert.throws(()=>retryDelayMs(-1));
});

test('Phase B: FAIL FAIL PASS only consumes two retries; preserves each evidence, no modifications',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','FAIL','PASS']);
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(result.phase,'DONE');assert.equal(result.status,'COMPLETED');
 assert.equal(result.validationRetries.INITIAL_VERIFY,2);assert.equal(result.fixRetries,0);
 assert.deepEqual(result.validationHistory.map(x=>x.verdict),['FAIL','FAIL','PASS']);
 assert.deepEqual(result.validationHistory.map(x=>x.ordinal),[1,2,3]);
 assert.deepEqual(c.sleeps,[30000,60000]);
 assert.equal(await validationHistoryIntact(result),true);
 const events=(await readFile(join(taskDir(out,state.taskId),'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.type==='VALIDATION_RETRY_SCHEDULED').length,2);
 assert.equal(events.filter(e=>e.type==='VERIFY_ATTEMPT_STARTED').length,3);
}));

test('Phase B: four repeated FAILs pause for diagnosis with evidence-bearing report',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','FAIL','FAIL','FAIL']);
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(result.phase,'ANALYZING');assert.equal(result.status,'PAUSED');
 assert.equal(result.validationRetries.INITIAL_VERIFY,3);assert.equal(result.fixRetries,0);
 assert.deepEqual(c.sleeps,[30000,60000,120000]);
 assert.equal(result.validationHistory.length,4);
 const report=JSON.parse(await readFile(join(taskDir(out,state.taskId),'retry-report.json'),'utf8'));
 assert.equal(report.attempts.length,4);assert.ok(report.attempts.every(a=>a.evidence?.reportSha256?.length===64));
 assert.match((await readFile(join(taskDir(out,state.taskId),'retry-report.md'),'utf8')),/FAIL/);
}));

test('Phase B: four UNVERIFIABLEs block without going into Codex fix path',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(Array(4).fill('UNVERIFIABLE'));
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(result.phase,'INITIAL_VERIFY');assert.equal(result.status,'BLOCKED');
 assert.equal(result.fixRetries,0);assert.match(result.lastError,/UNVERIFIABLE_RETRIES_EXHAUSTED/);
 assert.equal(result.validationHistory.length,4);
}));

test('Phase B: mixed failures count against one validation budget, not fix retries',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','UNVERIFIABLE','FAIL','PASS']);
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(result.status,'COMPLETED');assert.equal(result.fixRetries,0);
 assert.equal(result.validationRetries.INITIAL_VERIFY,3);
 assert.deepEqual(result.validationHistory.map(a=>a.verdict),['FAIL','UNVERIFIABLE','FAIL','PASS']);
 assert.deepEqual(c.sleeps,[30000,60000,120000]);
}));

test('Phase B: no-wait mode saves a durable checkpoint, and a later resume uses original due time',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','PASS']);
 const first=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c,true));
 assert.equal(first.status,'WAITING_RETRY');assert.equal(first.validationRetries.INITIAL_VERIFY,0);
 assert.deepEqual(c.sleeps,[]);
 const saved=await readTask(out,state.taskId);
 assert.equal(Date.parse(saved.nextAttemptAt)-c.now(),30000);
 const still=await withWorkflowLock(out,()=>runValidationCycle(config,saved,v.fn,c,true));
 assert.equal(still.sequence,saved.sequence);
 c.advance(30000);
 const resumed=await withWorkflowLock(out,()=>runValidationCycle(config,saved,v.fn,c));
 assert.equal(resumed.status,'COMPLETED');assert.equal(resumed.validationRetries.INITIAL_VERIFY,1);
 assert.equal(c.sleeps.length,0);
}));

test('Phase B: SIGKILL between reservation and outcome does not consume a retry twice',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','PASS']);
 const first=await withWorkflowLock(out,()=>initialVerify(config,state,v.fn,c));
 const due=await withWorkflowLock(out,()=>writeTransition(out,first,{status:'READY',nextAttemptAt:null},'TEST_DUE','due'));
 const inFlight=await withWorkflowLock(out,()=>writeTransition(out,due,{
   status:'RUNNING',validationRetries:{...due.validationRetries,INITIAL_VERIFY:1},
   activeValidationAttempt:{phase:'INITIAL_VERIFY',ordinal:2,startedAt:new Date(c.now()).toISOString()},
 },'TEST_STARTED','reserved but crashed'));
 const revived=await withWorkflowLock(out,()=>recoverTask(out,inFlight));
 assert.equal(revived.status,'READY');assert.equal(revived.activeValidationAttempt.ordinal,2);
 const final=await withWorkflowLock(out,()=>runValidationCycle(config,revived,v.fn,c));
 assert.equal(final.status,'COMPLETED');assert.equal(final.validationRetries.INITIAL_VERIFY,1);
 assert.deepEqual(final.validationHistory.map(a=>a.ordinal),[1,2]);
}));

test('Phase B: evidence tampering in any historical attempt is detected',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','PASS']);
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(await validationHistoryIntact(result),true);
 await writeFile(join(result.validationHistory[0].evidence.runDir,'report.json'),'tampered');
 assert.equal(await validationHistoryIntact(result),false);
}));

test('Phase B: executor exception means unverifiable, not a fabricated FAIL/PASS',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock();
 const result=await withWorkflowLock(out,()=>initialVerify(config,state,async()=>{throw Error('Transient RPC error');},c));
 assert.equal(result.status,'WAITING_RETRY');assert.equal(result.latestValidation,null);
 assert.equal(result.validationHistory[0].verdict,'UNVERIFIABLE');
 assert.equal(result.validationHistory[0].evidence,null);
}));

test('Phase F4: unmapped retries twice with bounded mapping guidance, then BLOCKED without edits',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['UNMAPPED']);
 const result=await withWorkflowLock(out,()=>runValidationCycle(config,state,v.fn,c));
 assert.equal(result.status,'BLOCKED');assert.equal(result.validationRetries.INITIAL_VERIFY,2);
 assert.equal(result.validationHistory.length,3);assert.deepEqual(c.sleeps,[1000,1000]);
 assert.equal(result.fixRetries,0);
}));

test('Phase B: a FAIL after a recovered previously RUNNING attempt retains history and backoff',()=>sandbox(async out=>{
 const {config,state}=await setup(out),c=clock(),v=executor(['FAIL','PASS']);
 const first=await withWorkflowLock(out,()=>initialVerify(config,state,v.fn,c));
 const before=await readTask(out,state.taskId);
 assert.equal(first.nextAttemptAt,before.nextAttemptAt);
 const resumed=await withWorkflowLock(out,()=>runValidationCycle(config,before,v.fn,c));
 assert.equal(resumed.status,'COMPLETED');assert.equal(resumed.validationRetries.INITIAL_VERIFY,1);
 assert.deepEqual(c.sleeps,[30000]);
}));
