import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { compareSubset, checkSummary, runAgentHarness, parseCodexEvents, buildCodexArgs, detectMcpStartupFailure } from '../dist/agent.js';
const mock=resolve('test/mock-codex.mjs');
async function runOne(id,request) {
 const tmp=await mkdtemp(join(tmpdir(),'agent-harness-'));
 const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
 config.servers.reference=resolve('test/mock-reference.mjs');
 config.outputDir=tmp;
 try {return await runAgentHarness(config,{scenarioId:id,requestOverride:request,command:process.execPath,
    commandArgs:[mock],cwd:process.cwd()});}
 finally{await rm(tmp,{recursive:true,force:true});}
}
test('Codex JSONL parser extracts real tool call rather than agent narrative',()=>{
 const ev=[{type:'item.completed',item:{type:'agent_message',text:'60건 맞았습니다'}},
  {type:'item.completed',item:{type:'mcp_tool_call',server:'whatap',tool:'whatap_query_data',arguments:{timeRange:'1h',limit:123},result:{content:[{type:'text',text:'data'}]}}}];
 const t=parseCodexEvents(ev);
 assert.equal(t.calls.length,1);assert.equal(t.calls[0].arguments.limit,123);
});
test('LLM chooses parameters: Harness does not inject limit or path into Codex tool args',async()=>{
 const r=await runOne('apm-tps-series','프로젝트 5490 TPS 최근 5분 조회');
 assert.equal(r.totals.PASS,1);
 assert.equal(r.scenarios[0].candidate.args.limit,undefined);
 assert.equal(r.scenarios[0].candidate.args.timeRange,'5m');
 assert.equal(r.scenarios[0].reference.rowCount,60);
});
test('server metric natural-language request can be compared against independently queried HTTP',async()=>{
 const r=await runOne('server-metrics','프로젝트 33194 CPU 메모리 최근 5분 조회');
 assert.equal(r.scenarios[0].status,'PASS');
 assert.equal(r.scenarios[0].reference.rowCount,300);
});
test('APM stats no equivalent MCP tool are UNMAPPED, not falsely PASS',async()=>{
 const r=await runOne('apm-transaction-stats');
 assert.equal(r.scenarios[0].status,'UNMAPPED');
});
test('subset is a PASS only for actually displayed rows and explicitly reports coverage',()=>{
 const s={matchKeys:['time','_id_'],compareFields:['tps']};
 const a=Array.from({length:101},(_,i)=>({time:i,_id_:'x',tps:2}));
 const r=compareSubset(s,a,a.slice(0,100));
 assert.equal(r.status,'PASS');assert.equal(r.coverage,'100/101');
});
test('subset wrong display value fails',()=>{
 const s={matchKeys:['time','_id_'],compareFields:['tps']};
 const a=[{time:0,_id_:1,tps:2}];
 const b=[{time:0,_id_:'1',tps:'5'}];
 assert.equal(compareSubset(s,a,b).status,'FAIL');
});
test('MCP Summary values are checked against raw reference, not rounded display values',()=>{
 const s={matchKeys:['time','_id_'],compareFields:['tps']};
 const raw=[{time:0,_id_:'x',tps:5.398},{time:5,_id_:'x',tps:8.796},{time:10,_id_:'x',tps:5.597}];
 const shown=raw.map(r=>({...r,tps:r.tps.toFixed(2)}));
 const summary='**Summary** (3 rows): **tps** (5.4–8.8, avg 6.6)';
 assert.equal(checkSummary(summary,s,raw,shown).ok,true);
 assert.equal(checkSummary(summary.replace('avg 6.6','avg 8.8'),s,raw,shown).ok,false);
});


test('Codex MCP proxy receives required tap and API token environment variable NAMES', async()=>{
  const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
  const args=buildCodexArgs(config);
  const overrides=args.filter((v,i)=>i>0 && args[i-1]==='-c');
  assert.ok(overrides.some(v=>v.includes('mcp_servers.whatap.env_vars=') &&
    v.includes('WHATAP_HARNESS_TAP_FILE') && v.includes('WHATAP_API_TOKEN')));
  assert.ok(overrides.some(v=>v.includes('mcp_servers.whatap.args=') && v.includes('whatap-proxy.mjs')));
  assert.ok(overrides.includes('mcp_servers.whatap-http.enabled=false'));
  assert.equal(args.includes('limit'),false);
  assert.equal(args.includes('timeRange'),false);
  assert.equal(args.some(v=>v.includes('test-token-should-not-be-in-cli-args')),false);
});

test('Codex events distinguish WhaTap MCP startup failure from LLM not calling a tool',()=>{
  const events=[{type:'item.completed',item:{type:'mcp_tool_call',server:'whatap',tool:'list_mcp_resources',status:'failed',arguments:{},
    error:{message:'resources/list failed: failed to get client: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response'}}}];
  const parsed=parseCodexEvents(events);
  assert.equal(parsed.calls.length,1);
  assert.match(detectMcpStartupFailure(parsed.calls,parsed.errors),/MCP startup failed/);
  assert.equal(detectMcpStartupFailure([],[]),null);
  assert.equal(detectMcpStartupFailure([{server:'whatap',tool:'list_mcp_resources',arguments:{},result:null,error:'Method not found'}]),null);
});

test('failed WhaTap MCP handshake becomes MCP_STARTUP_FAILED in report even if TAP file is empty',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'agent-startup-'));
  try {
    const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
    config.servers.reference=resolve('test/mock-reference.mjs');
    config.outputDir=tmp;
    const report=await runAgentHarness(config,{
      scenarioId:'apm-tps-series',requestOverride:'프로젝트 5490 최근 5분 TPS',
      command:process.execPath,commandArgs:[resolve('test/mock-codex-startup-failed.mjs')]
    });
    assert.equal(report.scenarios[0].status,'UNVERIFIABLE');
    assert.equal(report.scenarios[0].reason,'MCP_STARTUP_FAILED');
    assert.match(report.scenarios[0].candidate.error,/handshaking with MCP server failed/);
    assert.equal(report.scenarios[0].reference.rowCount,undefined);
    const md=await readFile(join(report.runDir,'report.md'),'utf8');
    assert.match(md,/초기화\(핸드셰이크\)가 실패/);
    assert.match(md,/MCP startup failed/);
    assert.match(md,/Harness 버전: 0\.5\.0-alpha\.11-f5-forensics/);
  } finally {await rm(tmp,{recursive:true,force:true});}
});

test('LLM no tool call is still LLM_NO_MATCHING_MCP_QUERY, not an MCP startup failure',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'agent-no-tool-'));
  try {
    const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
    config.servers.reference=resolve('test/mock-reference.mjs');
    config.outputDir=tmp;
    const report=await runAgentHarness(config,{
      scenarioId:'apm-tps-series',requestOverride:'프로젝트 5490 최근 5분 TPS',
      command:process.execPath,commandArgs:[resolve('test/mock-codex-no-tools.mjs')]
    });
    assert.equal(report.scenarios[0].reason,'LLM_NO_MATCHING_MCP_QUERY');
  } finally {await rm(tmp,{recursive:true,force:true});}
});
