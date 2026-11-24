import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';
import {fixedReplayArgs,fixedReplayFromBaseline,replayQuerySignature,sameFixedQuery} from '../dist/replay.js';
const stime=Date.parse('2026-11-22T16:09:46.001Z'),etime=Date.parse('2026-11-22T16:14:46.987Z');
const args={projectCode:33194,path:'v2/sys/server_base',timeRange:'5m',limit:150,
  params:{filter:'production'}};
const before={id:'server-metrics',status:'FAIL',reason:'FIELD_MISMATCH',mcpTool:'whatap_query_data',mcpPath:'v2/sys/server_base',
  candidate:{args},timeWindow:{stime,etime}};
const replay=fixedReplayFromBaseline(before);
const good=resolve('test/mock-f1b-good.mjs');
const ref=resolve('test/mock-f1b-reference.mjs');
async function run(candidate=good, spec=replay, scenarioId='server-metrics'){
  const dir=await mkdtemp(join(tmpdir(),'phase-f1b-'));
  try {
    const {config}=await loadConfig(resolve('test/fixtures/harness.json'));
    config.outputDir=dir;config.servers={candidate,reference:ref};
    const r=await runAgentHarness(config,{scenarioId,fixedReplay:spec,
      command:'/this-path-does-not-exist/codex'});
    const original=JSON.parse(await readFile(join(r.runDir,'report.json'),'utf8'));
    return {r,original};
  }finally{await rm(dir,{recursive:true,force:true});}
}
test('F1-B: preserve all non-time args and replace only timeRange with stime/etime',()=>{
  assert.deepEqual(fixedReplayArgs(replay),{projectCode:33194,path:'v2/sys/server_base',limit:150,params:{filter:'production'},stime,etime});
  assert.deepEqual(args,{projectCode:33194,path:'v2/sys/server_base',timeRange:'5m',limit:150,params:{filter:'production'}});
  assert.equal(replayQuerySignature(before.mcpPath,args),replayQuerySignature(before.mcpPath,fixedReplayArgs(replay)));
  assert.equal(sameFixedQuery(replay,{...before,candidate:{args:fixedReplayArgs(replay)}}),true);
  assert.equal(sameFixedQuery(replay,{...before,candidate:{args:{...fixedReplayArgs(replay),limit:720}}}),false);
});
test('F1-B: direct MCP+HTTP fixed replay is independent of Codex and preserves audit',async()=>{
  const {r,original}=await run();
  const {r: repeated}=await run();
  assert.equal(repeated.scenarios[0].status,'PASS',repeated.scenarios[0].candidate.error);
  assert.deepEqual(repeated.scenarios[0].candidate.args,r.scenarios[0].candidate.args);
  assert.deepEqual(repeated.scenarios[0].timeWindow,{stime,etime});
  assert.equal(repeated.fixedReplayAudit.toolCalls,1);
  assert.equal(r.scenarios[0].status,'PASS');
  assert.deepEqual(r.scenarios[0].timeWindow,{stime,etime});
  assert.deepEqual(r.scenarios[0].candidate.args,fixedReplayArgs(replay));
  assert.equal(r.scenarios[0].reference.rowCount,1);
  assert.equal(r.fixedReplayAudit.mode,'DIRECT_MCP_TOOL_CALL');
  assert.equal(r.fixedReplayAudit.schemaVerdict,'SCHEMA_CANDIDATE');
  assert.equal(r.fixedReplayAudit.toolCalls,1);
  assert.equal(r.fixedReplayAudit.periodMatched,true);
  assert.deepEqual(original.fixedReplayAudit,r.fixedReplayAudit);
  assert.ok(r.scenarios[0].candidate.sha256 && r.scenarios[0].reference.sha256);
});
test('F1-B: same absolute period but bad value is FAIL, not an approved PASS',async()=>{
  const {r}=await run(resolve('test/mock-f1b-bad-data.mjs'));
  assert.equal(r.scenarios[0].status,'FAIL');
  assert.equal(r.scenarios[0].reason,'FIELD_MISMATCH');
});
test('F1-B: wrong MCP Period is UNVERIFIABLE before HTTP call',async()=>{
  const {r}=await run(resolve('test/mock-f1b-wrong-period.mjs'));
  assert.equal(r.scenarios[0].status,'UNVERIFIABLE');
  assert.equal(r.scenarios[0].reason,'FIXED_REPLAY_PERIOD_MISMATCH');
  assert.equal(r.scenarios[0].reference.file,undefined);
  assert.equal(r.fixedReplayAudit.periodMatched,false);
});
test('F1-B: no explicit window schema refuses data query and PASS',async()=>{
  const {r}=await run(resolve('test/mock-f1b-no-schema.mjs'));
  assert.equal(r.scenarios[0].status,'UNVERIFIABLE');
  assert.equal(r.scenarios[0].reason,'FIXED_REPLAY_SCHEMA_NOT_SUPPORTED');
  assert.equal(r.fixedReplayAudit.toolCalls,0);
});
test('F1-B: historical milliseconds survive baseline reconstruction and replay arguments',()=>{
  const window={stime:stime+1,etime};
  const reconstructed=fixedReplayFromBaseline({...before,timeWindow:window});
  assert.deepEqual(reconstructed.window,window);
  assert.deepEqual(fixedReplayArgs(reconstructed),{...fixedReplayArgs(replay),...window});
});
test('F1-B: missing, contradictory, or malicious original time arguments rejected',()=>{
  assert.throws(()=>fixedReplayFromBaseline({...before,candidate:{args:{...args,stime}}}),/cannot be replayed/);
  assert.throws(()=>fixedReplayFromBaseline({...before,candidate:{args:{...args,etime}}}),/cannot be replayed/);
  assert.throws(()=>fixedReplayFromBaseline({...before,callResults:[{}]}),/one failed original/);
  assert.throws(()=>fixedReplayArgs({...replay,originalArgs:{...args,stime}}),/Invalid/);
});
test('F1-B: candidate project/path changed is never an approved fixed replay',async()=>{
  await assert.rejects(()=>run(good,{...replay,originalArgs:{...args,projectCode:999}}),/not allowed by fixed scenario/);
  await assert.rejects(()=>run(good,{...replay,mcpPath:'v2/app/tps_pcode'}),/Invalid fixed-window replay request/);
});

test('F1-B: query fingerprint ignores time mode only, not params/limit/path/reason',async()=>{
  const {fingerprint}=await import('../dist/phasec.js');
  const fixed={...before,candidate:{args:fixedReplayArgs(replay)}};
  assert.equal(fingerprint(before),fingerprint(fixed));
  assert.notEqual(fingerprint(before),fingerprint({...fixed,reason:'MISSING_OR_EXTRA_RECORDS'}));
  assert.notEqual(fingerprint(before),fingerprint({...fixed,candidate:{args:{...fixedReplayArgs(replay),limit:151}}}));
  assert.notEqual(fingerprint(before),fingerprint({...fixed,candidate:{args:{...fixedReplayArgs(replay),params:{filter:'staging'}}}}));
});
test('F1-B: replay refuses mismatched source and unknown scenario without network calls',async()=>{
  for (const window of [{stime,etime:stime},{stime,etime:stime-1},{stime:stime+0.5,etime},{stime:0,etime}]) {
    await assert.rejects(()=>run(good,{...replay,window}),/Invalid fixed-window replay request/);
  }
  await assert.rejects(()=>run(good,replay,'unknown'),/requires one known scenario/);
  await assert.rejects(()=>run(good,{...replay,mcpPath:'other',originalArgs:{...args,path:'other'}}),/not allowed by fixed scenario/);
  await assert.rejects(()=>run(good,{...replay,originalArgs:{...args,path:'other'}}),/Invalid fixed-window replay request/);
});
