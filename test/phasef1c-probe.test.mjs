import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {parseArgs,fixedWindow,summarizeRun,overall,referenceRowsDigest} from '../tools/phasef1c-common.mjs';
const base={status:'PASS',reason:'MATCHING_DATA',requestedPeriodMatched:true,fullCoverage:true,
  requiredChecksPassed:true,evidenceIntegrity:true,eligible:true,hashes:{candidate:'a',reference:'b'}};
const t=Date.parse('2026-11-24T03:00:00.000Z');
function opts(x={}){return {...parseArgs([]),...x};}
test('F1-C explicit live opt-in required; unknown flags rejected',()=>{
  assert.equal(parseArgs([]).confirmLive,false);
  assert.equal(parseArgs(['--confirm-live-read-only']).confirmLive,true);
  assert.throws(()=>parseArgs(['--bogus','1']),/Invalid option/);
  assert.throws(()=>parseArgs(['--limit','1','--limit','2']),/Invalid option/);
  assert.throws(()=>parseArgs(['--confirm-live-read-only','--confirm-live-read-only']),/duplicate/);
});
test('F1-C fixed window stays second-aligned but not 5-second boundary',()=>{
  const w=fixedWindow(opts(),t);
  assert.equal(w.etime-w.stime,300000);
  assert.equal(w.stime%5000,1000);
  assert.equal(w.etime%5000,1000);
  assert.ok(w.etime<t-10*60_000);
});
test('F1-C cannot use future, unsafe or partial explicit window',()=>{
  assert.throws(()=>fixedWindow(opts({stime:1000}),t),/together/);
  assert.throws(()=>fixedWindow(opts({stime:t-300000,etime:t}),t),/Unsafe/);
  assert.throws(()=>fixedWindow(opts({stime:t-7200000,etime:t-1800000}),t),/Unsafe/);
  assert.throws(()=>fixedWindow(opts({stime:t-1300000+1,etime:t-1000000}),t),/Unsafe/);
});
test('F1-C requires 2 valid and stable runs',()=>{
  assert.equal(overall(base,base).verdict,'PASS');
  assert.equal(overall(base,{...base,hashes:{candidate:'changed',reference:'b'}}).verdict,'UNVERIFIABLE');
  assert.equal(overall(base,{...base,status:'FAIL',eligible:false}).verdict,'FAIL');
  assert.equal(overall(base,{...base,fullCoverage:false,eligible:false}).verdict,'UNVERIFIABLE');
});
test('F1-C no partial or truncated results can pass',()=>{
  const sc={status:'PASS',reason:'MATCHING_DATA',timeWindow:{stime:t-300000,etime:t},
    candidate:{parsedRows:1},reference:{rowCount:2},checks:[],};
  const report={scenarios:[sc],fixedReplayAudit:{periodMatched:true,
    requestedWindow:{stime:t-300000,etime:t},schemaVerdict:'SCHEMA_CANDIDATE',toolCalls:1},runDir:'/tmp/some'};
  assert.equal(summarizeRun(report,{valid:true}).eligible,false);
  sc.reference.rowCount=1;
  sc.checks=['HTTP_OK','PARSE_ROWS','TIME_WINDOW','REFERENCE_REQUEST','MATCH_KEYS','MCP_SUMMARY']
    .map(code=>({code,ok:true}));
  assert.equal(summarizeRun(report,{valid:true,candidate:'a',reference:'b'}).eligible,true);
  sc.checks.push({code:'MCP_LIMIT_NOTICE',ok:true});
  assert.equal(summarizeRun(report,{valid:true,candidate:'a',reference:'b'}).eligible,false);
});
test('F1-C repeat reference digest ignores timing metadata and object/row order',()=>{
  const rows=[{time:1000,_id_:1,tps:12.5,x:{a:1,b:2}}, {time:2000,_id_:1,tps:9.5}];
  const a={status:200,durationMs:18,body:[{_head_:{tps:'P'}},...rows]};
  const b={durationMs:248,status:200,body:[{tps:9.5,_id_:1,time:2000},
    {x:{b:2,a:1},tps:12.5,_id_:1,time:1000},{_head_:{tps:'P'}}]};
  assert.equal(referenceRowsDigest(a).rowCount,2);
  assert.equal(referenceRowsDigest(a).sha256,referenceRowsDigest(b).sha256);
  assert.notEqual(JSON.stringify(a),JSON.stringify(b));
});
test('F1-C repeat reference digest includes *all* columns, even unverified ancillary values',()=>{
  const row={time:1000,_id_:'1',tps:12.5,extra:'a'};
  const orig={body:[row]};
  const diff={body:[{...row,extra:'b'}]};
  assert.notEqual(referenceRowsDigest(orig).sha256,referenceRowsDigest(diff).sha256);
  assert.throws(()=>referenceRowsDigest({body:{data:[]}}),/empty/);
  assert.throws(()=>referenceRowsDigest({body:{data:[null]}}),/malformed/);
});
test('F1-C CLI without explicit opt-in does not call MCP',()=>{
  const r=spawnSync(process.execPath,['tools/phasef1c-live.mjs'],{encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,r.stderr);
  const o=JSON.parse(r.stdout);
  assert.equal(o.mode,'PHASE_F1C_PREFLIGHT_ONLY');
  assert.equal(o.readQueriesExecuted,0);
});

// Full stdio integration with synthetic candidate and synthetic HTTP MCP only.
// HOME is redirected to a disposable temp directory to keep user data untouched.
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
async function runWithMocks(candidate,options={}){
  const home=await mkdtemp(join(tmpdir(),'whatap-f1c-smoke-'));
  try{
    const config=join(home,'config.json');
    const root=resolve('.');
    const mockScenario={id:'smoke-series',domain:'timeseries',description:'mock F1C',
      projectCode:33194,stime:1795336800000,etime:1795338600000,
      referenceTool:'whatap_http_server_metrics',mcpPath:'v2/sys/server_base',
      allowedMcpPaths:['v2/sys/server_base'],expectedStepMs:5000,
      matchKeys:['time','_id_'],compareFields:['cpu','memory_pused'],userRequest:'mock'};
    await writeFile(config,JSON.stringify({servers:{candidate,reference:options.reference??join(root,'test/mock-f1b-reference.mjs')},
      outputDir:'runs',rpcTimeoutMs:10000,retryCount:0,scenarios:[mockScenario]}));
    const r=spawnSync(process.execPath,['tools/phasef1c-live.mjs','--config',config,'--candidate',candidate,
      '--scenario','smoke-series','--stime','1795363786000','--etime','1795364086000',
      '--confirm-live-read-only'],{encoding:'utf8',timeout:12000,
      env:{...process.env,HOME:home,MOCK_F1C_CHANGED_ROW:options.changeRow?'1':'0',MOCK_F1C_STATE_FILE:join(home,'mock-ref-counter'),WHATAP_API_TOKEN:'mock-only',WHATAP_HTTP_API_TOKEN:'mock-only'}});
    const entries=await import('node:fs/promises').then(f=>f.readdir(home));
    const evidenceDir=entries.find(s=>s.startsWith('whatap-harness-f1c-'));
    assert.ok(evidenceDir,`Expected private probe directory: ${r.stdout} ${r.stderr}`);
    const summary=JSON.parse(await readFile(join(home,evidenceDir,'f1c-summary.json'),'utf8'));
    let recheck;
    if(options.tamperEvidence){
      const runDir=summary.results[0].evidenceDirectory;
      const report=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));
      const referenceFile=join(runDir,report.scenarios[0].reference.file);
      await writeFile(referenceFile,(await readFile(referenceFile,'utf8')).replace('durationMs', 'durationMs_tampered'));
    }
    if(options.recheck){
      const rr=spawnSync(process.execPath,['tools/phasef1c-recheck.mjs','--summary',join(home,evidenceDir,'f1c-summary.json')],
        {encoding:'utf8',timeout:5000,env:{...process.env,HOME:home}});
      const match=rr.stdout.match(/Upload this SUMMARY ONLY: (.+\.json)/);
      recheck={exitCode:rr.status,stderr:rr.stderr,stdout:rr.stdout,
        summary:match?JSON.parse(await readFile(match[1],'utf8')):null};
    }
    return {r,summary,recheck};
  }finally{await rm(home,{recursive:true,force:true});}
}
test('F1-C synthetic live protocol: two equal fixed replays PASS with independent HTTP',async()=>{
  const {r,summary}=await runWithMocks(resolve('test/mock-f1b-good.mjs'));
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  assert.equal(summary.verdict,'PASS');
  assert.equal(summary.runCount,2);
  assert.equal(summary.repeatedContentStable,true);
  assert.ok(summary.results.every(x=>x.eligible && x.fullCoverage && x.evidenceIntegrity));
});
test('F1-C synthetic live protocol: wrong candidate Period never becomes PASS',async()=>{
  const {r,summary}=await runWithMocks(resolve('test/mock-f1b-wrong-period.mjs'));
  assert.equal(r.status,1,r.stdout+'\n'+r.stderr);
  assert.equal(summary.verdict,'UNVERIFIABLE');
  assert.ok(summary.results.every(x=>!x.eligible));
});

test('F1-C live metadata-only drift PASSes; evidence hashes still differ and offline recheck PASSes',async()=>{
  const {r,summary,recheck}=await runWithMocks(resolve('test/mock-f1b-good.mjs'),{
    reference:resolve('test/mock-f1c-volatile-reference.mjs'),recheck:true});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  assert.equal(summary.verdict,'PASS');
  assert.equal(summary.results.length,2);
  assert.equal(summary.results[0].hashes.reference,summary.results[1].hashes.reference);
  assert.notEqual(summary.results[0].hashes.referenceEvidence,summary.results[1].hashes.referenceEvidence);
  assert.equal(recheck.exitCode,0,recheck.stdout+'\n'+recheck.stderr);
  assert.equal(recheck.summary.verdict,'PASS');
});
test('F1-C raw HTTP row drift is UNVERIFIABLE even if separately compared metrics pass',async()=>{
  const {r,summary}=await runWithMocks(resolve('test/mock-f1b-good.mjs'),{
    reference:resolve('test/mock-f1c-volatile-reference.mjs'),changeRow:true});
  assert.equal(r.status,1,r.stdout+'\n'+r.stderr);
  assert.equal(summary.results[0].status,'PASS');
  assert.equal(summary.results[1].status,'PASS');
  assert.equal(summary.verdict,'UNVERIFIABLE');
  assert.notEqual(summary.results[0].hashes.reference,summary.results[1].hashes.reference);
});

test('F1-C stored-evidence replay never PASSes altered raw HTTP evidence',async()=>{
  const {r,summary,recheck}=await runWithMocks(resolve('test/mock-f1b-good.mjs'),{
    reference:resolve('test/mock-f1c-volatile-reference.mjs'),recheck:true,tamperEvidence:true});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  assert.equal(summary.verdict,'PASS'); // Before tampering
  assert.equal(recheck.exitCode,1,recheck.stdout+'\n'+recheck.stderr);
  assert.equal(recheck.summary.verdict,'UNVERIFIABLE');
  assert.equal(recheck.summary.results[0].evidenceIntegrity,false);
});
