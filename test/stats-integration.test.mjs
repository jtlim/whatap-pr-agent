import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';

async function runStat(mode='transaction',options={}){
 const tmp=await mkdtemp(join(tmpdir(),'whatap-stat-integ-'));
 try{
  const {config}=await loadConfig(resolve('config/harness.json'));
  config.servers.reference=resolve('test/mock-reference-statistics.mjs');
  config.outputDir=tmp;
  const old=Object.fromEntries(Object.entries(options.env??{}).map(([k])=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(options.env??{}))process.env[k]=v;
  try {
   const report=await runAgentHarness(config,{scenarioId:mode==='transaction'?'apm-transaction-stats':'apm-exception-stats',
    command:process.execPath,commandArgs:[resolve('test/mock-codex-statistics.mjs'),mode]});
   const markdown=await readFile(join(report.runDir,'report.md'),'utf8');
   return {report,markdown,tmp};
  }finally {for(const [k,v] of Object.entries(old)) if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }finally {if(!options.preserve)await rm(tmp,{recursive:true,force:true});}
}
for(const mode of ['transaction','exception']){
 test(`${mode} displays a subset but validates ALL raw MXQL against v2 aggregate`,async()=>{
  const {report,markdown}=await runStat(mode);
  const r=report.scenarios[0];
  assert.equal(r.status,'PASS',JSON.stringify(r,null,2));
  assert.equal(r.reason,'STATS_AGGREGATE_MATCH');
  assert.equal(r.candidate.parsedRows,4);
  assert.equal(r.reference.statistics.fullMxqlRows,22);
  assert.equal(r.reference.statistics.v2RowCount,2);
  assert.equal(r.reference.statistics.comparedBuckets,11);
  assert.ok(r.checks.find(x=>x.code==='STATS_AGGREGATE'&&x.ok));
  assert.match(markdown,/전체 집계 일치는 HTTP MXQL 전체 원본/);
  assert.match(markdown,/4\/22/);
 });
 test(`${mode} restores saved evidence in offline replay`,async()=>{
  const {report,tmp}=await runStat(mode,{preserve:true});
  try{
   const cp=spawnSync(process.execPath,['tools/replay-run.mjs',report.runDir],{encoding:'utf8'});
   assert.equal(cp.status,0,cp.stderr+'\n'+cp.stdout);
   assert.match(cp.stdout,/보고서=PASS \/ 재검증=PASS/);
   assert.match(cp.stdout,/판정 불일치\/증거 오류 0개/);
  }finally{await rm(tmp,{recursive:true,force:true});}
 });
}
test('statistic numeric value mismatch in MCP display is FAIL, not hidden by full v2 aggregate PASS',async()=>{
 const {report}=await runStat('transaction',{env:{MOCK_STATS_CANDIDATE_BAD:'1'}});
 assert.equal(report.scenarios[0].status,'FAIL');
 assert.equal(report.scenarios[0].reason,'FIELD_MISMATCH');
});
test('statistic HTTP MXQL source differs from MCP so display comparison is FAIL',async()=>{
 const {report}=await runStat('exception',{env:{MOCK_STATS_RAW_BAD:'1'}});
 assert.equal(report.scenarios[0].status,'FAIL');
});
test('statistic v2 count mismatch is REFERENCE_INCONSISTENCY without authorizing MCP edits',async()=>{
 const {report}=await runStat('transaction',{env:{MOCK_STATS_V2_BAD:'1'}});
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 assert.equal(report.scenarios[0].reason,'REFERENCE_INCONSISTENCY');
});
test('partial HTTP v2 response never PASSes',async()=>{
 const {report}=await runStat('exception',{env:{MOCK_STATS_V2_PARTIAL:'1'}});
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 assert.equal(report.scenarios[0].reason,'STATS_V2_REFERENCE_INCOMPLETE');
});
test('missing entire bucket never gives full aggregation PASS',async()=>{
 const {report}=await runStat('transaction',{env:{MOCK_STATS_MISSING_BUCKET:'1'}});
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 assert.equal(report.scenarios[0].reason,'STATS_AGGREGATE_INCOMPLETE');
});
test('yard template exploration is reported but verified executable query can PASS',async()=>{
 const {report}=await runStat('exception',{env:{MOCK_STATS_EXTRA_PROBE:'1'}});
 assert.equal(report.scenarios[0].status,'PASS');
 assert.match(report.scenarios[0].checks.find(x=>x.code==='STATS_OTHER_PATH_PROBES').detail,/error_stat/);
});
test('when no executable statistics query was selected, report UNMAPPED',async()=>{
 const {report}=await runStat('exception',{env:{MOCK_STATS_PROBE_ONLY:'1'}});
 assert.equal(report.scenarios[0].status,'UNMAPPED');
 assert.equal(report.scenarios[0].reason,'LLM_NO_EQUIVALENT_MCP_STAT_QUERY');
});
test('offline replay rejects corrupted statistics HTTP evidence',async()=>{
 const {report,tmp}=await runStat('exception',{preserve:true});
 try{
  const meta=report.scenarios[0].reference.statistics.mxql;
  await writeFile(join(report.runDir,meta.file),'{}');
  const cp=spawnSync(process.execPath,['tools/replay-run.mjs',report.runDir],{encoding:'utf8'});
  assert.notEqual(cp.status,0);
  assert.match(cp.stderr+/\n/+cp.stdout,/증거 파일 손상/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('two valid transaction statistics queries are independently compared and retained',async()=>{
 const {report,markdown,tmp}=await runStat('transaction',{preserve:true,env:{MOCK_STATS_TWO_VALID:'1'}});
 try{
  const r=report.scenarios[0];
  assert.equal(r.status,'PASS');
  assert.deepEqual(r.callResults.map(x=>x.status),['PASS','PASS']);
  assert.deepEqual(r.callResults.map(x=>x.candidate.parsedRows),[4,6]);
  assert.notEqual(r.callResults[0].reference.statistics.mxql.file,r.callResults[1].reference.statistics.mxql.file);
  const cp=spawnSync(process.execPath,['tools/replay-run.mjs',report.runDir],{encoding:'utf8'});
  assert.equal(cp.status,0,cp.stderr+'\n'+cp.stdout);
  assert.match(cp.stdout,/재검증 2개 MCP 호출/);
  assert.match(markdown,/MCP 조회 호출 2/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
test('later bad statistics query cannot hide behind earlier PASS',async()=>{
 const {report}=await runStat('transaction',{env:{MOCK_STATS_TWO_VALID:'1',MOCK_STATS_SECOND_BAD:'1'}});
 assert.equal(report.scenarios[0].status,'FAIL');
 assert.deepEqual(report.scenarios[0].callResults.map(x=>x.status),['PASS','FAIL']);
});
test('failed executable query followed by success remains incomplete',async()=>{
 const {report}=await runStat('exception',{env:{MOCK_STATS_FIRST_ERROR:'1'}});
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 assert.deepEqual(report.scenarios[0].callResults.map(x=>x.status),['UNVERIFIABLE','PASS']);
});
