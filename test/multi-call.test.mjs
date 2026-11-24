import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import { replaySavedRun } from './fixtures/replay.mjs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';

async function runMulti(mode='',preserve=false,referenceMode=''){
 const tmp=await mkdtemp(join(tmpdir(),'agent-multicall-'));
 try{
  const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
  config.servers.reference=resolve(`test/mock-reference-multi${referenceMode?'-'+referenceMode:''}.mjs`);
  config.outputDir=tmp;
  const cmd=`test/mock-codex-multi${mode?'-'+mode:''}.mjs`;
  const report=await runAgentHarness(config,{scenarioId:'apm-tps-series',
   requestOverride:'프로젝트 5490 최근 1시간 TPS 전체 조회',
   command:process.execPath,commandArgs:[resolve(cmd)]});
  const markdown=await readFile(join(report.runDir,'report.md'),'utf8');
  const json=JSON.parse(await readFile(join(report.runDir,'report.json'),'utf8'));
  return {report,markdown,json,tmp};
 }finally{if(!preserve)await rm(tmp,{recursive:true,force:true});}
}

test('two calls with different Periods and limits both compare independently to HTTP and PASS',async()=>{
 const {report,markdown,json}=await runMulti();
 assert.equal(report.harnessVersion,'0.5.0-alpha.11-f5-forensics');
 assert.deepEqual(report.totals,{PASS:1,FAIL:0,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0});
 const [first,second]=report.scenarios[0].callResults;
 assert.equal(first.status,'PASS');assert.equal(second.status,'PASS');
 assert.equal(first.candidate.args.limit,undefined);
 assert.equal(second.candidate.args.limit,721);
 assert.equal(first.candidate.parsedRows,100);
 assert.equal(second.candidate.parsedRows,720);
 assert.equal(first.reference.rowCount,720);
 assert.equal(second.reference.rowCount,720);
 assert.equal(second.timeWindow.stime-first.timeWindow.stime,10_000);
 assert.match(first.checks.find(x=>x.code==='DISPLAY_COVERAGE').detail,/100\/720/);
 assert.match(second.checks.find(x=>x.code==='DISPLAY_COVERAGE').detail,/720\/720/);
 assert.match(first.reference.file,/call-1-reference/);
 assert.match(second.reference.file,/call-2-reference/);
 assert.notEqual(first.reference.file,second.reference.file);
 assert.notEqual(first.candidate.file,second.candidate.file);
 assert.ok(first.reference.sha256 && second.reference.sha256);
 assert.equal(json.scenarios[0].callResults.length,2);
 assert.match(markdown,/MCP 조회 호출 1/);
 assert.match(markdown,/MCP 조회 호출 2/);
 assert.match(markdown,/limit\\?":721/);
 assert.match(markdown,/모든 MCP 조회 호출의 표시 데이터/);
});

test('failure on FIRST call cannot be hidden by later successful 720-row retry',async()=>{
 const {report}=await runMulti('first-bad');
 assert.equal(report.scenarios[0].status,'FAIL');
 assert.equal(report.scenarios[0].reason,'MULTI_CALL_ANY_FAILED');
 assert.deepEqual(report.scenarios[0].callResults.map(c=>c.status),['FAIL','PASS']);
 assert.equal(report.totals.FAIL,1);
});

test('failure on SECOND call still fails even when first limited query passes',async()=>{
 const {report}=await runMulti('second-bad');
 assert.equal(report.scenarios[0].status,'FAIL');
 assert.deepEqual(report.scenarios[0].callResults.map(c=>c.status),['PASS','FAIL']);
});

test('one unparsable Period makes aggregate UNVERIFIABLE, while first PASS remains visible',async()=>{
 const {report,markdown}=await runMulti('unverifiable');
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
 assert.equal(report.scenarios[0].reason,'MULTI_CALL_INCOMPLETE');
 assert.deepEqual(report.scenarios[0].callResults.map(c=>c.status),['PASS','UNVERIFIABLE']);
 assert.equal(report.scenarios[0].callResults[1].reference.file,undefined);
 assert.match(markdown,/MCP_PERIOD_MISSING_OR_INVALID/);
});

test('offline replay independently checks BOTH stored MCP/HTTP evidence pairs',async()=>{
 const {report,tmp}=await runMulti('',true);
 try{
  const cp=replaySavedRun(report.runDir);
  assert.equal(cp.status,0,cp.stderr+'\n'+cp.stdout);
  assert.match(cp.stdout,/apm-tps-series 호출 1: 보고서=PASS \/ 재검증=PASS \/ 100\/720/);
  assert.match(cp.stdout,/apm-tps-series 호출 2: 보고서=PASS \/ 재검증=PASS \/ 720\/720/);
  assert.match(cp.stdout,/재검증 2개 MCP 호출, 판정 불일치\/증거 오류 0개/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});


test('aligned 1-hour TPS bucket-end: 17:00:25 through 18:00:20, 720 rows, each call PASS',async()=>{
 const {report,markdown}=await runMulti('endpoint');
 const [first,second]=report.scenarios[0].callResults;
 assert.equal(report.scenarios[0].status,'PASS');
 assert.equal(first.candidate.parsedRows,100);
 assert.equal(first.reference.rowCount,720);
 assert.equal(first.status,'PASS');
 assert.equal(second.candidate.parsedRows,720);
 assert.equal(second.reference.rowCount,720);
 assert.equal(second.status,'PASS');
 assert.ok(second.checks.some(c=>c.code==='MCP_END_BUCKET'&&c.ok));
 assert.match(markdown,/시계열 종료 버킷/);
 assert.match(markdown,/720\/720/);
});

test('aligned endpoint is not automatically trusted if HTTP API omitted final sample',async()=>{
 const {report}=await runMulti('endpoint',false,'omit-endpoint');
 const [first,second]=report.scenarios[0].callResults;
 assert.equal(first.status,'PASS');
 assert.equal(second.status,'FAIL');
 assert.equal(second.reason,'MISSING_OR_EXTRA_RECORDS');
 assert.equal(second.reference.rowCount,719);
 assert.equal(report.scenarios[0].status,'FAIL');
});

test('endpoint bucket with wrong TPS value is FAIL, not boundary-skipped PASS',async()=>{
 const {report}=await runMulti('endpoint-bad-value');
 assert.equal(report.scenarios[0].status,'FAIL');
 assert.deepEqual(report.scenarios[0].callResults.map(c=>c.status),['PASS','FAIL']);
 assert.equal(report.scenarios[0].callResults[1].reason,'FIELD_MISMATCH');
});

test('timestamp one bucket beyond endpoint is UNVERIFIABLE before HTTP call',async()=>{
 const {report}=await runMulti('endpoint-outside');
 const [first,second]=report.scenarios[0].callResults;
 assert.equal(first.status,'PASS');
 assert.equal(second.status,'UNVERIFIABLE');
 assert.equal(second.reason,'MCP_ROWS_OUTSIDE_PERIOD');
 assert.equal(second.reference.file,undefined);
 assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
});

test('offline replay checks aligned 720-row endpoint evidence without relaxing value equality',async()=>{
 const {report,tmp}=await runMulti('endpoint',true);
 try{
  const cp=replaySavedRun(report.runDir);
  assert.equal(cp.status,0,cp.stderr+'\n'+cp.stdout);
  assert.match(cp.stdout,/호출 2: 보고서=PASS \/ 재검증=PASS \/ 720\/720/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
