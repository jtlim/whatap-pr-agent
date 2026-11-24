import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,withWorkflowLock} from '../dist/workflow.js';
import {initialVerify,runValidationCycle} from '../dist/workflow-cli.js';
import {loadConfig} from '../dist/config.js';
import {validWindow,formatWindow,recoveryClass,readOnlyIncidentAI,writeCampaignReport} from '../tools/campaign-report.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'f4-harness-'));
  try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}};
const envTokens=async fn=>{
 const a=process.env.WHATAP_API_TOKEN,b=process.env.WHATAP_HTTP_API_TOKEN;
 process.env.WHATAP_API_TOKEN='f4-test-private-token';
 process.env.WHATAP_HTTP_API_TOKEN='f4-test-private-token';
 try{return await fn();}finally{
  if(a===undefined)delete process.env.WHATAP_API_TOKEN;else process.env.WHATAP_API_TOKEN=a;
  if(b===undefined)delete process.env.WHATAP_HTTP_API_TOKEN;else process.env.WHATAP_HTTP_API_TOKEN=b;
 }};
async function config(root){
 const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
 config.outputDir=root;config.servers.reference=resolve('test/mock-reference-statistics.mjs');
 config.servers.candidate=resolve('test/mock-codex-statistics.mjs');
 return config;
}
async function fakeRun(config,opts,status){
 const runDir=join(config.outputDir,`mock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
 await mkdir(runDir,{recursive:true});
 const scenario={id:opts.scenarioId,status,reason:status==='PASS'?'MATCHING_DATA':'LLM_NO_EQUIVALENT_MCP_STAT_QUERY',
   timeWindow:status==='UNMAPPED'?{stime:0,etime:0}:{stime:1795461920000,etime:1795465520000},
   checks:status==='UNMAPPED'?[{code:'STATS_OTHER_PATH_PROBES',ok:false,detail:'다른 경로 4회'}]:[]};
 await writeFile(join(runDir,'report.json'),JSON.stringify({scenarios:[scenario]})+'\n');
 return {runDir,scenarios:[scenario]};
}
test('F4: missing Period never formats Unix epoch as a real observation',()=>{
 for(const w of [null,undefined,{stime:0,etime:0},{stime:0,etime:1795465520000},
   {stime:NaN,etime:3},{stime:999,etime:999},{stime:2000,etime:1000}]){
   assert.equal(validWindow(w),false);assert.match(formatWindow(w),/미확보/);
   assert.doesNotMatch(formatWindow(w),/1970/);
 }
 assert.match(formatWindow({stime:1795461920000,etime:1795465520000}),/2026-11-24/);
});
test('F4: the first autonomous mapping attempt is unguided, then a bounded guided retry passes',()=>fixture(root=>envTokens(async()=>{
 const c=await config(root);let s=await withWorkflowLock(root,()=>createTask(root,'apm-transaction-stats'));
 const observations=[];const clock={current:Date.UTC(2026,10,24),now(){return this.current;},async sleep(ms){this.current+=ms;}};
 const verify=async(config,opts)=>{
   observations.push(opts);
   return fakeRun(config,opts,observations.length===1?'UNMAPPED':'PASS');
 };
 s=await withWorkflowLock(root,()=>runValidationCycle(c,s,verify,clock));
 assert.equal(s.phase,'DONE');assert.equal(s.status,'COMPLETED');assert.equal(s.fixRetries,0);
 assert.deepEqual(s.validationHistory.map(a=>a.verdict),['UNMAPPED','PASS']);
 assert.equal(observations[0].retryGuidance,undefined);
 assert.match(observations[1].retryGuidance,/mxql\/app\/stat_tx_pcode/);
 assert.match(observations[1].retryGuidance,/실제 whatap_query_data/);
 assert.equal(recoveryClass(s),'RECOVERED_UNMAPPED');
 const audit=await writeCampaignReport({outputDir:root,results:[{scenarioId:s.scenarioId,taskId:s.taskId}],
   worktree:root,analyzeRecovered:false});
 const text=await readFile(audit.mdPath,'utf8');
 assert.match(text,/RECOVERED_UNMAPPED/);assert.match(text,/유효한 MCP Period 없음/);
 assert.doesNotMatch(text,/1970-01-01/);
})));
test('F4: unresolved mapping remains BLOCKED, never escalates to code edit',()=>fixture(root=>envTokens(async()=>{
 const c=await config(root);const s=await withWorkflowLock(root,()=>createTask(root,'apm-transaction-stats'));
 const clock={current:Date.UTC(2026,10,24),now(){return this.current;},async sleep(ms){this.current+=ms;}};
 let calls=0;
 const state=await withWorkflowLock(root,()=>runValidationCycle(c,s,async(config,opts)=>{
   calls++;return fakeRun(config,opts,'UNMAPPED');
 },clock));
 assert.equal(calls,3);assert.equal(state.status,'BLOCKED');
 assert.equal(state.phase,'INITIAL_VERIFY');assert.equal(state.lastError,'UNMAPPED_NOT_RETRYABLE');
 assert.equal(state.fixRetries,0);
 assert.equal(state.validationHistory.length,3);
})));
test('F4: Markdown summary table is contiguous; all records follow below table',()=>fixture(async root=>{
 let s=await withWorkflowLock(root,()=>createTask(root,'apm-tps-series'));
 const dir=join(root,'mock');await mkdir(dir);
 const body=JSON.stringify({scenarios:[{id:s.scenarioId,status:'PASS',reason:'MATCHING_DATA',timeWindow:{stime:1,etime:2}}]})+'\n';
 await writeFile(join(dir,'report.json'),body);
 const attempt={phase:'INITIAL_VERIFY',ordinal:1,startedAt:new Date().toISOString(),verdict:'PASS',reason:'MATCHING_DATA',
    evidence:{runDir:dir,reportSha256:digest(body),verdict:'PASS',at:new Date().toISOString()}};
 s=await withWorkflowLock(root,()=>writeTransition(root,s,{phase:'DONE',status:'COMPLETED',
    validationHistory:[attempt],latestValidation:attempt.evidence},'TEST_END','PASS'));
 const out=await writeCampaignReport({outputDir:root,results:[{scenarioId:s.scenarioId,taskId:s.taskId}],
    worktree:root,analyzeRecovered:false});
 const md=await readFile(out.mdPath,'utf8');
 const tableStart=md.indexOf('| 시나리오');const rowIndex=md.indexOf('| apm-tps-series');
 const heading=md.indexOf('## apm-tps-series');
 assert.ok(tableStart>=0&&rowIndex>tableStart&&heading>rowIndex);
 assert.ok(md.slice(tableStart,heading).trim().split('\n').every(v=>v.startsWith('|')));
}));
test('F4: incident Codex uses supported flags and strips WhaTap credentials',()=>fixture(async root=>{
 const bin=join(root,'stub-codex.mjs');
 await writeFile(bin,`#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a.includes('--ignore-user-config')||a.includes('--ignore-rules'))process.exit(25);
if(process.env.WHATAP_API_TOKEN)process.exit(26);
const file=a[a.indexOf('--output-last-message')+1];
writeFileSync(file,JSON.stringify({classification:'OTHER_UNPROVEN',summary:'원인 미확정',plausibleCauses:['지연'],confirmedFacts:['실패 후 성공'],unknowns:['원인'],nextVerification:['원본 분석']}));
`);
 await chmod(bin,0o700);
 const prev=process.env.WHATAP_API_TOKEN;process.env.WHATAP_API_TOKEN='do-not-copy';
 try{
  const r=await readOnlyIncidentAI({scenario:'test'},{worktree:root,taskDir:root,bin,timeoutMs:3000});
  assert.equal(r.classification,'OTHER_UNPROVEN');
  const files=await readdir(root);assert.ok(files.some(f=>f.endsWith('-diagnostics.json')));
 }finally{if(prev===undefined)delete process.env.WHATAP_API_TOKEN;else process.env.WHATAP_API_TOKEN=prev;}
}));
test('F4: incident Codex error records stderr and does not claim a diagnosis',()=>fixture(async root=>{
 const bin=join(root,'stub-failure.mjs');
 await writeFile(bin,`#!/usr/bin/env node\nconsole.error('unsupported option test-error');process.exit(1);\n`);await chmod(bin,0o700);
 await assert.rejects(()=>readOnlyIncidentAI({}, {worktree:root,taskDir:root,bin,timeoutMs:3000}),/stderr=unsupported option test-error/);
 const diagnostics=(await readdir(root)).find(f=>f.endsWith('-diagnostics.json'));
 assert.ok(diagnostics);
 const record=JSON.parse(await readFile(join(root,diagnostics),'utf8'));
 assert.equal(record.exitCode,1);assert.equal(record.attempts,1);
 assert.match(record.stderr,/unsupported option test-error/);
}));
