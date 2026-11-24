import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';
import {forensicStatsGroups,FIVE_MIN} from '../dist/statistics.js';
import {initialVerify,runValidationCycle,priorVerifiedRelativeQuery} from '../dist/workflow-cli.js';
import {createTask,withWorkflowLock,writeTransition} from '../dist/workflow.js';
import {investigateRecoveredStats} from '../tools/frozen-stats-investigation.mjs';
import {writeCampaignReport} from '../tools/campaign-report.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'whatap-f5-'));
 try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}};
const start=1795461900000;
const scenarioId='apm-transaction-stats';
async function config(root){const {config:c}=await loadConfig(resolve('config/harness.json'));
 c.servers.reference=resolve('test/mock-reference-statistics.mjs');
 c.servers.candidate=resolve('test/mock-codex-statistics.mjs');
 c.outputDir=root;c.rpcTimeoutMs=15000;return c;}
function group(time,hash,n){return {time,tx_hash:hash,tx_count:n,tx_error:0,tx_time_sum:n};}
test('F5: actual group totals and MXQL bucket contributions are kept without pretending v2 is bucketed',()=>{
 const window={stime:start,etime:start+2*FIVE_MIN};
 const r=forensicStatsGroups('transaction',[group(start,111,2),group(start+FIVE_MIN,111,3),group(start,222,1)],
   [{serviceHash:111,count:4,error:0,timeSum:5}],window);
 assert.equal(r.reliable,true);assert.equal(r.mxqlGroups,2);assert.equal(r.v2Groups,1);
 assert.equal(r.matching,0);assert.equal(r.different,1);assert.equal(r.missingV2,1);
 const d=r.allGroups.find(x=>x.key==='111');
 assert.equal(d.mxql.tx_count,5);assert.equal(d.v2.tx_count,4);assert.equal(d.delta.tx_count,1);
 assert.deepEqual(d.mxqlBucketContributions.map(x=>x.values.tx_count),[2,3]);
 assert.equal(r.allGroups.find(x=>x.key==='222').status,'MISSING_IN_V2');
});
test('F5: invalid bucket/duplicated v2 identity are never a reliable forensic match',()=>{
 const w={stime:start,etime:start+FIVE_MIN};
 const d=forensicStatsGroups('transaction',[group(start+5,111,3)],
   [{serviceHash:111,count:3,error:0,timeSum:3},{serviceHash:111,count:3,error:0,timeSum:3}],w);
 assert.equal(d.reliable,false);assert.equal(d.invalidTime,1);assert.equal(d.duplicateV2,1);
});
test('F5: initial failed query is reused exactly on the next attempt (no LLM path rediscovery)',()=>fixture(async root=>{
 const c=await config(root);let state=await withWorkflowLock(root,()=>createTask(root,scenarioId));
 const oldToken=process.env.WHATAP_API_TOKEN,oldHttp=process.env.WHATAP_HTTP_API_TOKEN;
 process.env.WHATAP_API_TOKEN='f5-test-token';process.env.WHATAP_HTTP_API_TOKEN='f5-test-token';
 const args={projectCode:5490,path:'mxql/app/stat_tx_pcode',timeRange:'1h',limit:1000};
 const observed=[];
 const time={current:Date.now()+300000,now(){return this.current;},async sleep(ms){this.current+=ms;}};
 const verify=async(conf,opts)=>{
   observed.push(opts);
   const n=observed.length,verdict=n===1?'FAIL':'PASS';
   const dir=join(root,`capture-${n}`);await mkdir(dir);
   const r={scenarios:[{id:scenarioId,status:verdict,
     reason:verdict==='FAIL'?'STATS_AGGREGATE_DIFFERENCE':'STATS_AGGREGATE_MATCH',
     mcpTool:'whatap_query_data',mcpPath:args.path,candidate:{args},
     timeWindow:{stime:start+n*1000,etime:start+n*1000+3600000}}]};
   await writeFile(join(dir,'report.json'),JSON.stringify(r));
   return {runDir:dir,...r};
 };
 let result;try{result=await withWorkflowLock(root,()=>runValidationCycle(c,state,verify,time));}finally{
 if(oldToken===undefined)delete process.env.WHATAP_API_TOKEN;else process.env.WHATAP_API_TOKEN=oldToken;
 if(oldHttp===undefined)delete process.env.WHATAP_HTTP_API_TOKEN;else process.env.WHATAP_HTTP_API_TOKEN=oldHttp;
 }
 assert.equal(result.phase,'DONE');assert.deepEqual(result.validationHistory.map(x=>x.verdict),['FAIL','PASS']);
 assert.equal(observed[0].relativeReplay,undefined);
 assert.deepEqual(observed[1].relativeReplay,{originalArgs:args,mcpPath:args.path});
 assert.equal(observed[1].retryGuidance,undefined);
}));
test('F5: a report SHA mismatch refuses historical query reuse',()=>fixture(async root=>{
 const c=await config(root);let state=await withWorkflowLock(root,()=>createTask(root,scenarioId));
 const dir=join(root,'old');await mkdir(dir);await writeFile(join(dir,'report.json'),'{}');
 const at=new Date().toISOString();
 state=await withWorkflowLock(root,()=>writeTransition(root,state,{validationHistory:[{
   phase:'INITIAL_VERIFY',ordinal:1,verdict:'FAIL',reason:'STATS_AGGREGATE_DIFFERENCE',startedAt:at,
   evidence:{runDir:dir,reportSha256:'0'.repeat(64),verdict:'FAIL',at}}]},'TEST','saved'));
 await assert.rejects(()=>priorVerifiedRelativeQuery(c,state),/hash mismatch/);
}));
test('F5: frozen original FAIL period is queried twice by HTTP only; all deltas are saved with hashes',()=>fixture(async root=>{
 const c=await config(root);const s=c.scenarios.find(x=>x.id===scenarioId);
 const prev=process.env.MOCK_STATS_V2_BAD;process.env.MOCK_STATS_V2_BAD='1';
 let report;
 try{report=await runAgentHarness(c,{scenarioId,command:process.execPath,
   commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});}
 finally{if(prev===undefined)delete process.env.MOCK_STATS_V2_BAD;else process.env.MOCK_STATS_V2_BAD=prev;}
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 const body=await readFile(join(report.runDir,'report.json'));
 const firstFail={evidence:{verified:true,runDir:report.runDir,resultSha256:hash(body)}};
 const observed=[];
 const {StdioMcpClient}=await import('../dist/mcp.js');
 const result=await investigateRecoveredStats({scenario:s,firstFail,taskId:'test-task',outputDir:root,
   referenceEntry:c.servers.reference,delayMs:0,maxBucketProbes:2,timeoutMs:12000,
   clientFactory:(entry,timeout)=>{
     const client=new StdioMcpClient(entry,timeout);
     return {start:()=>client.start(),close:()=>client.close(),callTool:(tool,args)=>{
       observed.push({tool,args});return client.callTool(tool,args);
     }};
   }});
 assert.equal(result.status,'COMPLETED',result.reason??'');
 assert.equal(result.initial.different,1);
 assert.equal(result.initial.mxqlGroups,2);
 assert.equal(result.snapshots.length,2);
 assert.deepEqual(result.snapshots.map(s=>s.status),['MATCH','MATCH']);
 assert.equal(result.bucketProbes.length,2);
 const period=report.scenarios[0].timeWindow;
 for(const call of observed.slice(0,4)){
   if(call.tool==='whatap_http_mxql_path')assert.deepEqual([call.args.stime,call.args.etime],[period.stime,period.etime]);
   else assert.deepEqual([call.args.stime,call.args.etime],
     [result.initial.window.stime,result.initial.window.etime]);
 }
 assert.equal(observed.filter(x=>x.tool==='whatap_query_data').length,0);
 const audit=JSON.parse(await readFile(result.manifestPath,'utf8'));
 const data=await readFile(join(result.manifestPath,'..',result.initial.groupCsv.file),'utf8');
 assert.match(data,/groupKey,status,metric,MXQL_full_window/);
 assert.match(data,/VALUE_DIFFERENCE/);
 assert.equal(hash(data),result.initial.groupCsv.sha256);
 assert.equal(audit.scope,'INDEPENDENT_HTTP_ONLY_NO_MCP_REPLAY');
}));
test('F5: corrupted original HTTP evidence is rejected rather than labelled recovered',()=>fixture(async root=>{
 const c=await config(root);const s=c.scenarios.find(x=>x.id===scenarioId);
 const prev=process.env.MOCK_STATS_V2_BAD;process.env.MOCK_STATS_V2_BAD='1';
 let report;
 try{report=await runAgentHarness(c,{scenarioId,command:process.execPath,
   commandArgs:[resolve('test/mock-codex-statistics.mjs'),'transaction']});}
 finally{if(prev===undefined)delete process.env.MOCK_STATS_V2_BAD;else process.env.MOCK_STATS_V2_BAD=prev;}
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 const firstFail={evidence:{verified:true,runDir:report.runDir,
   resultSha256:hash(await readFile(join(report.runDir,'report.json')))}};
 const meta=report.scenarios[0].reference.statistics.mxql;
 await writeFile(join(report.runDir,meta.file),'{}');
 await assert.rejects(()=>investigateRecoveredStats({scenario:s,firstFail,taskId:'tamper',outputDir:root,
   referenceEntry:c.servers.reference,snapshots:1,delayMs:0,maxBucketProbes:0}),/SHA mismatch/);
}));
test('F5: recovered FAIL report contains independent frozen-window investigation and separate MXQL/v2 units',()=>fixture(async root=>{
 const c=await config(root);let state=await withWorkflowLock(root,()=>createTask(root,scenarioId));
 const history=[];
 for(const [ordinal,verdict] of [[1,'FAIL'],[2,'PASS']]){
   const dir=join(root,`state-${ordinal}`);await mkdir(dir);
   const body=JSON.stringify({scenarios:[{id:scenarioId,status:verdict,
     reason:verdict==='FAIL'?'STATS_AGGREGATE_DIFFERENCE':'STATS_AGGREGATE_MATCH',
     timeWindow:{stime:start,etime:start+3600000},candidate:{parsedRows:100},
     reference:{rowCount:42,statistics:{fullMxqlRows:62000,v2RowCount:verdict==='FAIL'?4219:4553,comparedBuckets:11}},
     checks:[]}]})+'\n';
   await writeFile(join(dir,'report.json'),body);
   history.push({phase:'INITIAL_VERIFY',ordinal,verdict,startedAt:new Date().toISOString(),
     reason:verdict==='FAIL'?'STATS_AGGREGATE_DIFFERENCE':'STATS_AGGREGATE_MATCH',
     timeWindow:{stime:start,etime:start+3600000},evidence:{runDir:dir,reportSha256:hash(body),verdict,at:new Date().toISOString()}});
 }
 state=await withWorkflowLock(root,()=>writeTransition(root,state,{phase:'DONE',status:'COMPLETED',
   latestValidation:history.at(-1).evidence,validationHistory:history},'TEST','finished'));
 let called=0;
 const result=await writeCampaignReport({outputDir:root,worktree:root,config:c,
   results:[{scenarioId,taskId:state.taskId}],incidentAnalyzer:async()=>({
   classification:'OTHER_UNPROVEN',summary:'검증 불가',plausibleCauses:[],confirmedFacts:[],unknowns:[],nextVerification:[]}),
 frozenInvestigator:async()=>{called++;return {status:'COMPLETED',manifestPath:'/tmp/frozen/manifest.json',
   initial:{window:{stime:start,etime:start+3600000},mxqlGroups:4553,v2Groups:4219,different:1080,missingV2:334,
     missingMxql:0,groupCsv:{file:'groups-initial.csv',sha256:'b'.repeat(64)}},
   snapshots:[{index:1,status:'MATCH',counts:{mxqlGroups:4553,v2Groups:4553,different:0,missingV2:0}}],bucketProbes:[]};}});
 assert.equal(called,1);
 const md=await readFile(result.mdPath,'utf8');
 assert.match(md,/HTTP MXQL 전체 원본: 62000행/);assert.match(md,/HTTP v2 통계 집계: 4219그룹/);
 assert.match(md,/최초 기준 불일치 기간 고정 HTTP 사후 재조회/);assert.match(md,/그룹별 실측 CSV/);
 assert.doesNotMatch(md,/MCP 표시 행 \/ HTTP 기준 행:/);
}));
