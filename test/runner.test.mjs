import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioMcpClient } from '../dist/mcp.js';
import { loadConfig } from '../dist/config.js';
import { runHarness } from '../dist/runner.js';
async function harnessCase(mode) {
 const tmp=await mkdtemp(join(tmpdir(),'whatap-harness-test-'));
 const {config}=await loadConfig(resolve('test/fixtures/legacy-harness.json'));
 config.servers.reference=mode==='reference-mismatch'?resolve('test/mock-reference-mismatch.mjs'):resolve('test/mock-reference.mjs');
 config.servers.candidate=resolve(`test/mock-${mode==='reference-mismatch'?'candidate-good':mode}.mjs`);
 config.outputDir=tmp;config.rpcTimeoutMs=12000;
 try{const report=await runHarness(config);return {...report,markdown:await readFile(join(report.runDir,'report.md'),'utf8')};}
 finally{await rm(tmp,{recursive:true,force:true});}
}
test('JSON-RPC stdio client accepts >2 MB without truncation',async()=>{
 const client=new StdioMcpClient(resolve('test/mock-reference.mjs'),15000);
 try{await client.start();const data=await client.callTool('huge',{});assert.equal(data.content[0].text.length,2200000);}
 finally{await client.close();}
});
test('relative 5m Period workflow PASSes three scenarios against HTTP reference',async()=>{
 const r=await harnessCase('candidate-good');
 assert.equal(r.harnessVersion,'0.3.0');
 assert.deepEqual(r.totals,{PASS:3,FAIL:0,UNVERIFIABLE:0,UNMAPPED:2,UNSUPPORTED:0});
 assert.match(r.markdown,/MCP Period/);
 for(const s of r.scenarios.filter(x=>x.mcpPath)){
  assert.equal(s.timeWindow.stime,Date.parse('2026-11-22T16:09:46Z'));
  assert.ok(s.candidate.parsedRows>=60);
  assert.equal(s.reference.httpStatus,200);
  assert.ok(s.reference.sha256&&s.candidate.sha256);
 }
});
test('numeric formatting differences are not false mismatches',async()=>{
 const r=await harnessCase('candidate-good');
 assert.equal(r.scenarios.find(s=>s.id==='apm-tps-series').status,'PASS');
});
test('incorrect TPS value in Markdown is a FAIL',async()=>{
 const r=await harnessCase('candidate-bad');
 assert.deepEqual(r.totals,{PASS:2,FAIL:1,UNVERIFIABLE:0,UNMAPPED:2,UNSUPPORTED:0});
 assert.equal(r.scenarios.find(s=>s.id==='apm-tps-series').reason,'FIELD_MISMATCH');
});
test('MCP missing row is a FAIL, not PASS',async()=>{
 const r=await harnessCase('candidate-missing');
 assert.deepEqual(r.totals,{PASS:0,FAIL:3,UNVERIFIABLE:0,UNMAPPED:2,UNSUPPORTED:0});
});
test('no Period -> no HTTP query and never PASS',async()=>{
 const r=await harnessCase('candidate-period-bad');
 assert.deepEqual(r.totals,{PASS:0,FAIL:0,UNVERIFIABLE:3,UNMAPPED:2,UNSUPPORTED:0});
 for(const s of r.scenarios.filter(x=>x.mcpPath)){
  assert.equal(s.reason,'MCP_PERIOD_MISSING_OR_INVALID');
  assert.equal(s.reference.file,undefined);
 }
});
test('truncation warning prevents PASS even with matching data',async()=>{
 const r=await harnessCase('candidate-truncated');
 assert.deepEqual(r.totals,{PASS:0,FAIL:0,UNVERIFIABLE:3,UNMAPPED:2,UNSUPPORTED:0});
 for(const s of r.scenarios.filter(x=>x.mcpPath)) assert.equal(s.reason,'MCP_OUTPUT_TRUNCATED_OR_LIMITED');
});
test('MCP tool error blocks period-based HTTP comparison',async()=>{
 const r=await harnessCase('time-error');
 assert.deepEqual(r.totals,{PASS:0,FAIL:0,UNVERIFIABLE:3,UNMAPPED:2,UNSUPPORTED:0});
 for(const s of r.scenarios.filter(x=>x.mcpPath)) assert.equal(s.reason,'MCP_QUERY_FAILED');
});
test('wrong HTTP endpoint blocks PASS',async()=>{
 const r=await harnessCase('reference-mismatch');
 assert.deepEqual(r.totals,{PASS:2,FAIL:0,UNVERIFIABLE:1,UNMAPPED:2,UNSUPPORTED:0});
 assert.equal(r.scenarios.find(s=>s.id==='server-metrics').reason,'REFERENCE_DATA_NOT_VERIFIABLY_COMPLETE');
});
test('report is Korean and APM stats are correctly UNMAPPED',async()=>{
 const r=await harnessCase('candidate-good');
 assert.match(r.markdown,/검증 보고서/);
 assert.match(r.markdown,/도구 매핑 없음.*UNMAPPED/);
 assert.match(r.markdown,/소수점 2자리/);
});
