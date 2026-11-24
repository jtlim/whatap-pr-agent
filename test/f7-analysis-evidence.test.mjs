import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {diagnosisObservation, diagnosisPrompt} from '../dist/phasec.js';
import {getF7DiagnosisSummary} from '../tools/f7-analysis-diagnostics.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');

test('F7.3: Codex receives authenticated comparison delta and source-tracing instructions, but not the injected fix',()=>{
 const report={id:'apm-tps-series',projectCode:42,mcpTool:'whatap_query_data',mcpPath:'v2/app/tps',
  candidate:{args:{projectCode:42,path:'v2/app/tps',timeRange:'1h',limit:100,params:{token:'SECRET-NOT-ALLOWED'}}},
  checks:[{code:'FIELD_VALUES',ok:false,detail:'값 불일치 100건; API=108.86 MCP=109.86'},
   {code:'HTTP_OK',ok:true,detail:'normal'}]};
 const observation=diagnosisObservation(report);
 assert.equal(observation.query.projectCode,42);
 assert.equal(observation.query.timeRange,'1h');
 assert.equal(observation.query.params,undefined);
 assert.deepEqual(observation.failedChecks,[{code:'FIELD_VALUES',detail:'값 불일치 100건; API=108.86 MCP=109.86'}]);
 const evidence=[{runDir:'/isolated/runs/1',fingerprint:'same-query',reason:'FIELD_MISMATCH',
   period:{stime:1795471580000,etime:1795475180000},observation}];
 const prompt=diagnosisPrompt({scenarioId:'apm-tps-series'},evidence);
 assert.match(prompt,/API=108\.86 MCP=109\.86/);
 assert.match(prompt,/코드.*경로를 실제로 추적/);
 assert.match(prompt,/MCP_DEFECT 로 분류하지 마세요/);
 assert.doesNotMatch(prompt,/SECRET-NOT-ALLOWED|if \(field === "tps"\)/);
});

test('F7.3: Codex classification retained with verified SHA, including blocked UNKNOWN',async()=>{
 const root=await mkdtemp(join(tmpdir(),'f73-diagnosis-'));
 try{
  const id='task-evidence-01',dir=join(root,'tasks',id);await mkdir(dir,{recursive:true});
  const original=JSON.stringify({taskId:id,diagnosis:{classification:'UNKNOWN',confidence:'LOW',
    causeHypothesis:'원본에 접근하지 못해 원인 불명',candidateFiles:[],limitations:['read-only']}})+'\n';
  await writeFile(join(dir,'analysis.json'),original);
  const result=await getF7DiagnosisSummary({outputDir:root,taskId:id,expectedSha256:sha(original)});
  assert.equal(result.status,'RECORDED');assert.equal(result.integrity,'PASS');
  assert.equal(result.classification,'UNKNOWN');assert.equal(result.confidence,'LOW');
  assert.match(result.summary,/원본에 접근하지/);
  assert.equal((await readFile(result.artifact,'utf8')),original);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('F7.3: missing or SHA-mismatched diagnosis cannot be reported as verified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'f73-tamper-'));
 try{
  const id='task-evidence-02',dir=join(root,'tasks',id);await mkdir(dir,{recursive:true});
  let r=await getF7DiagnosisSummary({outputDir:root,taskId:id,expectedSha256:sha('abc')});
  assert.equal(r.status,'NOT_RECORDED');assert.equal(r.integrity,'UNVERIFIABLE');
  await writeFile(join(dir,'analysis.json'),'{}\n');
  r=await getF7DiagnosisSummary({outputDir:root,taskId:id,expectedSha256:sha('another')});
  assert.equal(r.status,'INTEGRITY_FAILURE');assert.equal(r.integrity,'FAIL');
 }finally{await rm(root,{recursive:true,force:true});}
});
