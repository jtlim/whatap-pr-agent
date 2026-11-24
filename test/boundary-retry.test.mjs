import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { replaySavedRun } from './fixtures/replay.mjs';
import { loadConfig } from '../dist/config.js';
import { runAgentHarness, isBoundaryOnlyShift } from '../dist/agent.js';

async function runBoundary(codexMode='',referenceMode='') {
 const tmp=await mkdtemp(join(tmpdir(),'boundary-realign-'));
 const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
 config.servers.reference=resolve(`test/mock-reference-boundary-error${referenceMode?'-'+referenceMode:''}.mjs`);
 config.outputDir=tmp;
 const cmd=resolve(`test/mock-codex-boundary-error${codexMode?'-'+codexMode:''}.mjs`);
 const report=await runAgentHarness(config,{scenarioId:'apm-error-series',
   requestOverride:'프로젝트 5490 최근 5분 오류 시계열 전체 조회',
   command:process.execPath,commandArgs:[cmd]});
 return {tmp,report,detail:report.scenarios[0]};
}
test('aligned single-bucket shift is retried +1ms and ALL 60 row values and summary match independently',async()=>{
 const {tmp,report,detail}=await runBoundary();
 try {
  assert.equal(report.harnessVersion,'0.5.0-alpha.11-f5-forensics');
  assert.equal(detail.status,'PASS');
  assert.equal(detail.reason,'MATCHING_DATA_BOUNDARY_REALIGNED');
  const a=detail.reference.boundaryAlignment;
  assert.equal(a.selectedDeltaMs,1);
  assert.equal(a.original.rowCount,60);
  assert.equal(detail.reference.rowCount,60);
  assert.match(detail.reference.file,/boundary-1ms/);
  assert.match(a.original.file,/apm-error-series-reference.json/);
  assert.notEqual(detail.reference.file,a.original.file);
  assert.equal(a.attempts.length,1);
  assert.ok(detail.checks.some(c=>c.code==='BOUNDARY_REALIGNED'&&c.ok));
  const md=await readFile(join(report.runDir,'report.md'),'utf8');
  assert.match(md,/경계 보정/);
  assert.match(md,/최초 HTTP 범위/);
  const rr=replaySavedRun(report.runDir);
  assert.equal(rr.status,0,rr.stdout+'\n'+rr.stderr);
  assert.match(rr.stdout,/재검증=PASS/);
 } finally {await rm(tmp,{recursive:true,force:true});}
});
test('historical incident: first aligned query realigns, second unaligned query passes; aggregate and replay PASS',async()=>{
 const {tmp,report,detail}=await runBoundary('multi');
 try {
  assert.equal(detail.status,'PASS');
  assert.equal(detail.reason,'MULTI_CALL_ALL_PASS');
  const [first,second]=detail.callResults;
  assert.equal(first.status,'PASS');
  assert.equal(first.reference.boundaryAlignment.selectedDeltaMs,1);
  assert.equal(second.status,'PASS');
  assert.equal(second.reference.boundaryAlignment,undefined);
  assert.equal(first.candidate.parsedRows,60);
  assert.equal(second.candidate.parsedRows,60);
  const rr=replaySavedRun(report.runDir);
  assert.equal(rr.status,0,rr.stdout+'\n'+rr.stderr);
  assert.match(rr.stdout,/재검증 2개 MCP 호출/);
 } finally {await rm(tmp,{recursive:true,force:true});}
});

test('if backend discards request milliseconds, retry +1000ms then PASS',async()=>{
 const {tmp,report,detail}=await runBoundary('','ignore-millis');
 try {
  assert.equal(detail.status,'PASS');
  const a=detail.reference.boundaryAlignment;
  assert.equal(a.selectedDeltaMs,1000);
  assert.equal(a.attempts.length,2);
  assert.notEqual(a.attempts[0].status,'PASS');
  assert.equal(a.attempts[1].status,'PASS');
  const rr=replaySavedRun(report.runDir);
  assert.equal(rr.status,0,rr.stderr+'\n'+rr.stdout);
 } finally {await rm(tmp,{recursive:true,force:true});}
});
test('different value inside the shared 59 rows prevents even attempting alignment',async()=>{
 const {tmp,detail}=await runBoundary('bad-interior');
 try {
  assert.equal(detail.status,'FAIL');
  assert.equal(detail.reference.boundaryAlignment,undefined);
  assert.equal(detail.reference.file,'raw/apm-error-series-reference.json');
 } finally {await rm(tmp,{recursive:true,force:true});}
});
test('wrong endpoint value cannot be turned into PASS by a shifted HTTP query',async()=>{
 const {tmp,report,detail}=await runBoundary('bad-end');
 try {
  assert.equal(detail.status,'FAIL');
  const a=detail.reference.boundaryAlignment;
  assert.equal(a.selectedDeltaMs,undefined);
  assert.ok(a.attempts.every(x=>x.status==='FAIL'));
  const rr=replaySavedRun(report.runDir);
  assert.equal(rr.status,0,rr.stderr+'\n'+rr.stdout);
  assert.match(rr.stdout,/보고서=FAIL \/ 재검증=FAIL/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
test('reference missing endpoint remains FAIL, even after multiple boundary retries',async()=>{
 const {tmp,detail}=await runBoundary('','omit-end');
 try {
  assert.equal(detail.status,'FAIL');
  assert.equal(detail.reference.boundaryAlignment.selectedDeltaMs,undefined);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
test('replay detects corruption of original HTTP evidence after successful re-alignment',async()=>{
 const {tmp,report,detail}=await runBoundary();
 try {
  const orig=join(report.runDir,detail.reference.boundaryAlignment.original.file);
  await writeFile(orig,'{}\n');
  const rr=replaySavedRun(report.runDir);
  assert.notEqual(rr.status,0);
  assert.match(rr.stderr,/증거 파일 손상/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
test('alignment guard rejects fake shift, non-5-second timestamp, and unrelated metric differences',()=>{
 const stime=Date.parse('2026-11-22T18:26:00Z'), etime=stime+300000;
 const s={domain:'timeseries',stime,etime,expectedStepMs:5000,matchKeys:['time','_id_'],compareFields:['tx_error']};
 const a=Array.from({length:60},(_,i)=>({time:stime+i*5000,_id_:'x',tx_error:i%5}));
 const b=Array.from({length:60},(_,i)=>({time:stime+(i+1)*5000,_id_:'x',tx_error:(i+1)%5}));
 assert.equal(isBoundaryOnlyShift(s,a,b),true);
 assert.equal(isBoundaryOnlyShift(s,a,b.map((r,i)=>i===1?{...r,tx_error:99}:r)),false);
 assert.equal(isBoundaryOnlyShift({...s,stime:stime+1000,etime:etime+1000},a,b),false);
 assert.equal(isBoundaryOnlyShift({...s,domain:'server'},a,b),false);
 assert.equal(isBoundaryOnlyShift(s,a,b.map((r,i)=>i===59?{...r,time:etime+5000}:r)),false);
});
