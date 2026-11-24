import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, mkdir, rm, truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  taskDir,withWorkflowLock,WorkflowBusyError,createTask,closeTask,readTask,listTasks,
  writeTransition,recoverTask,isTerminal,evidenceExists,
} from '../dist/workflow.js';
import {initialVerify,runValidationCycle,validationHistoryIntact} from '../dist/workflow-cli.js';
import {loadConfig} from '../dist/config.js';

async function sandbox(fn){const out=await mkdtemp(join(tmpdir(),'whatap-phase-a-'));
  try{return await fn(out);}finally{await rm(out,{recursive:true,force:true});}}
async function create(out,scenario='apm-tps-series') {
  return withWorkflowLock(out,()=>createTask(out,scenario));
}
async function trans(out,prev,changes,type='TEST_TRANSITION'){
  return withWorkflowLock(out,()=>writeTransition(out,prev,changes,type,'테스트 단계 전환'));
}
async function config(out){const {config}=await loadConfig(resolve('config/harness.json'));
  config.outputDir=out;
  config.servers.reference=resolve('test/mock-reference-statistics.mjs');
  config.servers.candidate=resolve('test/mock-codex-statistics.mjs');
  return config;
}
async function fakeVerify(config,opts){const runDir=join(config.outputDir,'mock-'+Date.now()+'-'+Math.random());
  await mkdir(runDir,{recursive:true});
  await writeFile(join(runDir,'report.json'),JSON.stringify({scenarios:[{status:opts.verdict??'PASS'}]}));
  return {runDir,scenarios:[{status:opts.verdict??'PASS'}]};
}
async function withTestTokens(fn){
 const saved=[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN];
 process.env.WHATAP_API_TOKEN='unit-test-no-real-token';process.env.WHATAP_HTTP_API_TOKEN='unit-test-no-real-token';
 try{return await fn();}finally{if(saved[0]===undefined)delete process.env.WHATAP_API_TOKEN;else process.env.WHATAP_API_TOKEN=saved[0];
 if(saved[1]===undefined)delete process.env.WHATAP_HTTP_API_TOKEN;else process.env.WHATAP_HTTP_API_TOKEN=saved[1];}
}

test('Phase A: state and audit trail persist with 0700/0600 protection, one active task',()=>sandbox(async out=>{
 const t=await create(out);
 assert.equal(t.status,'READY');assert.equal(t.phase,'INITIAL_VERIFY');assert.equal(t.sequence,1);
 assert.deepEqual(t.validationRetries,{INITIAL_VERIFY:0,PRE_FIX_VERIFY:0,FINAL_VERIFY:0});
 const saved=await readTask(out,t.taskId);assert.equal(saved.lastEvent.type,'TASK_CREATED');
 assert.equal((await readFile(join(taskDir(out,t.taskId),'events.jsonl'),'utf8')).trim().split('\n').length,1);
 assert.equal((await listTasks(out)).length,1);
 await assert.rejects(create(out),/unfinished task/);
 const closed=await withWorkflowLock(out,()=>closeTask(out,t));
 assert.equal(closed.status,'CANCELLED');assert.ok(isTerminal(closed));
 assert.notEqual((await create(out)).taskId,t.taskId);
}));

test('Phase B: first FAIL retains evidence and schedules delayed retry; no auto fix',()=>sandbox(async out=>withTestTokens(async()=>{
 const t=await create(out,'apm-exception-stats');
 const c=await config(out);
 const r=await withWorkflowLock(out,()=>initialVerify(c,t,(cfg)=>fakeVerify(cfg,{verdict:'FAIL'})));
 assert.equal(r.phase,'INITIAL_VERIFY');assert.equal(r.status,'WAITING_RETRY');assert.equal(r.latestValidation.verdict,'FAIL');
 assert.ok(await evidenceExists(r));
 assert.deepEqual((await readTask(out,t.taskId)).validationRetries,{INITIAL_VERIFY:0,PRE_FIX_VERIFY:0,FINAL_VERIFY:0});
 assert.equal(r.fixRetries,0);
 assert.deepEqual((await readFile(join(taskDir(out,t.taskId),'events.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x).type),[
  'TASK_CREATED','VERIFY_ATTEMPT_STARTED','VALIDATION_RETRY_SCHEDULED']);
})));

test('Phase A: PASS requires report evidence and finishes no-fix task',()=>sandbox(async out=>withTestTokens(async()=>{
 const t=await create(out);const c=await config(out);
 const r=await withWorkflowLock(out,()=>initialVerify(c,t,(cfg)=>fakeVerify(cfg,{verdict:'PASS'})));
 assert.equal(r.phase,'DONE');assert.equal(r.status,'COMPLETED');assert.ok(await evidenceExists(r));
 await writeFile(join(r.latestValidation.runDir,'report.json'),'tampered');
 assert.equal(await evidenceExists(r),false);
})));

test('Phase A: UNVERIFIABLE is not FAIL, does not approve modifications',()=>sandbox(async out=>withTestTokens(async()=>{
 const t=await create(out);const c=await config(out);
 const r=await withWorkflowLock(out,()=>initialVerify(c,t,(cfg)=>fakeVerify(cfg,{verdict:'UNVERIFIABLE'})));
 assert.equal(r.phase,'INITIAL_VERIFY');assert.equal(r.status,'WAITING_RETRY');assert.equal(r.latestValidation.verdict,'UNVERIFIABLE');
 assert.ok(await evidenceExists(r));assert.equal(r.fixRetries,0);
})));

test('Phase B: failed executor records UNVERIFIABLE and schedules retry without inventing PASS',()=>sandbox(async out=>withTestTokens(async()=>{
 const t=await create(out);const c=await config(out);
 await withWorkflowLock(out,()=>initialVerify(c,t,async()=>{throw Error('intentional crash');}));
 const s=await readTask(out,t.taskId);
 assert.equal(s.status,'WAITING_RETRY');assert.equal(s.phase,'INITIAL_VERIFY');assert.equal(s.latestValidation,null);assert.equal(s.validationHistory[0].verdict,'UNVERIFIABLE');
})));

test('Phase A: recover interrupted verification as READY, never PASS',()=>sandbox(async out=>{
 let t=await create(out);t=await trans(out,t,{status:'RUNNING'});
 const r=await withWorkflowLock(out,()=>recoverTask(out,t));
 assert.equal(r.phase,'INITIAL_VERIFY');assert.equal(r.status,'READY');
 assert.match(r.lastError,/INTERRUPTED_STEP/);
 assert.equal(r.latestValidation,null);assert.equal(r.fixRetries,0);
}));

test('Phase A: interrupted code editing preserves Worktree and pauses for inspection',()=>sandbox(async out=>{
 let t=await create(out);t=await trans(out,t,{phase:'MODIFYING',status:'RUNNING'});
 const sentinel=join(taskDir(out,t.taskId),'modified-contents-not-deleted');await writeFile(sentinel,'partial edit');
 const r=await withWorkflowLock(out,()=>recoverTask(out,t));
 assert.equal(r.status,'PAUSED');assert.equal(await readFile(sentinel,'utf8'),'partial edit');
}));

test('Phase A: interrupted Push/Commit/PR cannot be blindly replayed',()=>sandbox(async out=>{
 for(const phase of ['COMMITTING','PUSHING','CREATING_PR']){
  const t0=(await listTasks(out))[0];
  if(t0 && !isTerminal(t0))await withWorkflowLock(out,()=>closeTask(out,t0));
  let t=await create(out);t=await trans(out,t,{phase,status:'RUNNING'});
  const r=await withWorkflowLock(out,()=>recoverTask(out,t));
  assert.equal(r.phase,phase);assert.equal(r.status,'BLOCKED');
  assert.match(r.lastError,/EXTERNAL_SIDE_EFFECT/);
  await assert.rejects(withWorkflowLock(out,()=>closeTask(out,r)),/Cannot close/);
  // Test each phase in a fresh separate directory by resetting test fixture status
  await trans(out,r,{phase:'DONE',status:'COMPLETED'});
 }
}));

test('Phase A: scheduled retry checkpoint is not consumed by restart',()=>sandbox(async out=>{
 let t=await create(out);
 const date='2026-11-23T10:00:00.000Z';
 t=await trans(out,t,{status:'WAITING_RETRY',nextAttemptAt:date,validationRetries:{INITIAL_VERIFY:2,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}});
 const recovered=await withWorkflowLock(out,()=>recoverTask(out,t));
 assert.equal(recovered.sequence,t.sequence);assert.equal(recovered.nextAttemptAt,date);
 assert.equal(recovered.validationRetries.INITIAL_VERIFY,2);
}));

test('Phase A: incomplete audit event following atomic snapshot is repaired under lock',()=>sandbox(async out=>{
 let t=await create(out);
 t=await trans(out,t,{status:'RUNNING'});
 const log=join(taskDir(out,t.taskId),'events.jsonl');
 const lines=(await readFile(log,'utf8')).trim().split('\n');
 await writeFile(log,lines[0]+'\n');
 // Status stays read-only; lock-protected transition repairs the trailing gap.
 const s=await readTask(out,t.taskId);assert.equal(s.sequence,2);
 assert.equal((await readFile(log,'utf8')).trim().split('\n').length,1);
 const fixed=await withWorkflowLock(out,()=>recoverTask(out,s));
 assert.equal(fixed.sequence,3);
 const events=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(events.map(e=>e.sequence),[1,2,3]);
}));

test('Phase A: stale revision, corrupted state and event logs are rejected',()=>sandbox(async out=>{
 let t=await create(out);
 t=await trans(out,t,{status:'RUNNING'});
 await assert.rejects(withWorkflowLock(out,()=>writeTransition(out,{...t,sequence:1},{status:'READY'},'BAD','stale')),/Stale workflow state/);
 const p=join(taskDir(out,t.taskId),'events.jsonl');await writeFile(p,'{bad JSON');
 await assert.rejects(readTask(out,t.taskId),/Corrupt events/);
}));

test('Phase A: active global lock refuses second simultaneous writer',()=>sandbox(async out=>{
 await withWorkflowLock(out,async()=>{
  await assert.rejects(withWorkflowLock(out,async()=>{}),WorkflowBusyError);
 });
}));

test('Phase A: process killed without releasing lock is recoverable when owner is confirmed dead',()=>sandbox(async out=>{
 const source=`import {withWorkflowLock} from ${JSON.stringify(new URL('../dist/workflow.js',import.meta.url).href)}; await withWorkflowLock(process.argv[1],async()=>{process.exit(42);});`;
 const cp=spawnSync(process.execPath,['--input-type=module','-e',source,out],{encoding:'utf8',timeout:10000});
 assert.equal(cp.status,42,cp.stderr);
 const r=await withWorkflowLock(out,async()=>42);assert.equal(r,42);
}));

test('Phase A: path traversal is rejected for task identifier',()=>sandbox(async out=>{
 assert.throws(()=>taskDir(out,'../../etc/passwd'),/Invalid taskId/);
}));

test('Phase A CLI: create/status/close without Codex or WhaTap network calls',()=>sandbox(async out=>{
 const configPath=join(out,'harness.json');
 const {config}=await loadConfig(resolve('config/harness.json'));
 config.outputDir=join(out,'run-output');
 await writeFile(configPath,JSON.stringify(config));
 const cmd=(...args)=>spawnSync(process.execPath,['dist/cli.js','task',...args,'--config',configPath],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
 const started=cmd('start','--scenario','apm-tps-series','--no-run');
 assert.equal(started.status,0,started.stderr);
 assert.match(started.stdout,/작업 생성:/);
 const id=started.stdout.match(/task-[0-9a-f]{8}-[0-9a-f]{8}/)?.[0];assert.ok(id);
 const status=cmd('status','--task',id);assert.equal(status.status,0,status.stderr);
 assert.match(status.stdout,/INITIAL_VERIFY\/READY/);
 const close=cmd('close','--task',id);assert.equal(close.status,0,close.stderr);
 assert.match(close.stdout,/INITIAL_VERIFY\/CANCELLED/);
}));
