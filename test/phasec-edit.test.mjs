import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,readTask,recoverTask,withWorkflowLock,writeWorkflowArtifact} from '../dist/workflow.js';
import {analyzeTask,preFixCycle} from '../dist/phasec.js';
import {modifyTask,reconcileInterruptedEdit,phaseC2EvidenceIntact,snapshotWorktree} from '../dist/phasec2.js';
const g=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
const h=s=>createHash('sha256').update(s).digest('hex');
const diagnosis={classification:'MCP_DEFECT',problem:'시계열 TPS 불일치',impact:'MCP 지표가 잘못 표시됨',
  causeHypothesis:'MCP 집계 시 잘못된 배열 선택',reproductionSteps:['MCP 조회','같은 기간의 HTTP 조회','시계열 비교'],
  expectedResult:'HTTP 와 동일',actualResult:'MCP 값 상이',candidateFiles:['src/index.ts'],
  recommendedChange:'잘못된 배열 선택만 수정',limitations:['검증은 별도'],confidence:'MEDIUM'};
const period={stime:1000,etime:2000};
function scenario(){return {id:'apm-tps-series',status:'FAIL',reason:'MCP_SUMMARY_MISMATCH',
  mcpPath:'mxql/app/stat_tx_pcode',candidate:{args:{path:'mxql/app/stat_tx_pcode',projectCode:123,timeRange:'5m',limit:100}},timeWindow:period};}
async function report(dir){
  await mkdir(dir,{recursive:true});
  const candidate='{"source":"mcp"}\n',reference='{"source":"http"}\n';
  await writeFile(path.join(dir,'candidate.json'),candidate);
  await writeFile(path.join(dir,'reference.json'),reference);
  const sc=scenario();sc.candidate={...sc.candidate,file:'candidate.json',sha256:h(candidate)};
  sc.reference={file:'reference.json',sha256:h(reference)};
  const json=JSON.stringify({runDir:dir,scenarios:[sc],totals:{}})+'\n';
  await writeFile(path.join(dir,'report.json'),json);
  return {runDir:dir,scenarios:[sc],sha:h(json)};
}
async function setup(){
  const root=await mkdtemp(path.join(tmpdir(),'phasec2-'));
  const main=path.join(root,'main'),worktree=path.join(root,'agent'),outputDir=path.join(root,'runs');
  await mkdir(path.join(main,'src'),{recursive:true});
  g('init','-q','-b','submission',main);
  g('-C',main,'config','user.email','test@example.invalid');g('-C',main,'config','user.name','Test');
  await writeFile(path.join(main,'README.md'),'do not edit\n');
  await writeFile(path.join(main,'src','index.ts'),'export const value = 1;\n');
  g('-C',main,'add','.');g('-C',main,'commit','-qm','init');
  g('-C',main,'worktree','add','-qb','agent',worktree);
  let s=await withWorkflowLock(outputDir,()=>createTask(outputDir,'apm-tps-series'));
  const history=[];
  for(let i=1;i<=4;i++){
    const r=await report(path.join(root,`baseline-${i}`));
    history.push({phase:'INITIAL_VERIFY',ordinal:i,startedAt:new Date().toISOString(),verdict:'FAIL',
      timeWindow:period,reason:'MCP_SUMMARY_MISMATCH',evidence:{runDir:r.runDir,reportSha256:r.sha,verdict:'FAIL',at:new Date().toISOString()}});
  }
  s=await withWorkflowLock(outputDir,()=>writeTransition(outputDir,s,{phase:'ANALYZING',status:'PAUSED',validationHistory:history,
    latestValidation:history.at(-1).evidence,validationRetries:{INITIAL_VERIFY:3,PRE_FIX_VERIFY:0,FINAL_VERIFY:0}},'MOCK_FAIL','mock'));
  const config={outputDir,servers:{candidate:path.join(worktree,'dist/index.js'),reference:'unused'},scenarios:[]};
  return {root,main,worktree,outputDir,config,s,cleanup:()=>rm(root,{recursive:true,force:true})};
}
async function gate(fx,diagnosisOverride=diagnosis){
  let s=await withWorkflowLock(fx.outputDir,()=>analyzeTask(fx.config,fx.s,fx.worktree,async()=>diagnosisOverride));
  s=await withWorkflowLock(fx.outputDir,()=>preFixCycle(fx.config,s,async()=>{
    const r=await report(path.join(fx.root,'precheck'));
    return {runDir:r.runDir,scenarios:r.scenarios};
  }));
  assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');
  return s;
}
const changeSrc=async fx=>{await writeFile(path.join(fx.worktree,'src/index.ts'),'export const value = 2;\n');
  return {summary:'잘못된 값 수정',rationale:'집계 선택 수정',testsRun:['unit mock'],risks:[]};};

test('C2: refuses editing without independently reproduced C1 evidence',async()=>{
  const fx=await setup();try{
    await assert.rejects(()=>modifyTask(fx.config,fx.s,changeSrc),/pre-fix gate/);
    assert.equal((await readTask(fx.outputDir,fx.s.taskId)).fixRetries,0);
  }finally{await fx.cleanup();}
});
test('C2: approved source edit records hashes and moves ONLY to FINAL_VERIFY/READY',async()=>{
  const fx=await setup();try{
    const s=await gate(fx);
    const result=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    assert.equal(result.phase,'FINAL_VERIFY');assert.equal(result.status,'READY');
    assert.equal(result.fixRetries,0);assert.equal(result.editHistory[0].outcome,'COMPLETED');
    assert.deepEqual(result.editHistory[0].changedFiles,['src/index.ts']);
    assert.equal(await phaseC2EvidenceIntact(fx.config,result),true);
    const record=JSON.parse(await readFile(path.join(fx.outputDir,'tasks',s.taskId,'edit-1.json')));
    assert.equal(record.finalVerdict,'NOT_YET_VERIFIED');
    assert.equal(record.afterIndependentEvidence,'PENDING_PHASE_D');
    await assert.rejects(()=>modifyTask(fx.config,result,changeSrc),/gate/);
  }finally{await fx.cleanup();}
});
test('C2: only candidate paths and test source may change',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await writeFile(path.join(fx.worktree,'README.md'),'unauthorized\n');return changeSrc(fx);
    }));
    assert.equal(s.status,'BLOCKED');assert.equal(s.editHistory[0].outcome,'BLOCKED');
    assert.deepEqual(s.editHistory[0].forbiddenFiles,['README.md']);
    assert.equal(await readFile(path.join(fx.worktree,'README.md'),'utf8'),'unauthorized\n');
  }finally{await fx.cleanup();}
});
test('C2: successful second attempt is forbidden without FINAL_VERIFY confirmed failure',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,s,{phase:'MODIFYING',status:'PAUSED'},'SIMULATE','invalid return'));
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/verified reason/);
  }finally{await fx.cleanup();}
});
test('C2: Codex failure preserves partial edits and consumes separate fix budget',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await writeFile(path.join(fx.worktree,'src/index.ts'),'export const value = 9;\n');throw Error('model unavailable');
    }));
    assert.equal(s.phase,'MODIFYING');assert.equal(s.status,'PAUSED');assert.equal(s.fixRetries,0);
    assert.equal(s.editHistory[0].outcome,'FAILED');
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.fixRetries,1);
    assert.equal(s.editHistory.length,2);
    assert.equal(await phaseC2EvidenceIntact(fx.config,s),true);
  }finally{await fx.cleanup();}
});
test('C2: three failed edit attempts stop at cap and keep worktree',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    for(let i=1;i<=3;i++)s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await writeFile(path.join(fx.worktree,'src/index.ts'),`export const value = ${i+1};\n`);
      throw Error('test failure');
    }));
    assert.equal(s.status,'BLOCKED');assert.equal(s.fixRetries,2);assert.equal(s.editHistory.length,3);
    assert.equal(s.lastError,'FIX_RETRIES_EXHAUSTED');
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    assert.equal(await readFile(path.join(fx.worktree,'src/index.ts'),'utf8'),'export const value = 4;\n');
  }finally{await fx.cleanup();}
});
test('C2: file edit before a retry must match saved SHA manifest',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{throw Error('noop');}));
    await writeFile(path.join(fx.worktree,'src/index.ts'),'export const value = 456;\n');
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/differs from saved previous edit/);
  }finally{await fx.cleanup();}
});
test('C2: tampered C1 pre-fix and C2 report evidence both prevent trust',async()=>{
  const fx=await setup();try{
    const s=await gate(fx);
    await writeFile(path.join(fx.outputDir,'tasks',s.taskId,'prefx-report.json'),'{}\n');
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/checksum mismatch/);
  }finally{await fx.cleanup();}
  const gx=await setup();try{
    let s=await gate(gx);
    s=await withWorkflowLock(gx.outputDir,()=>modifyTask(gx.config,s,async()=>changeSrc(gx)));
    await writeFile(path.join(gx.outputDir,'tasks',s.taskId,'edit-1.json'),'tampered\n');
    assert.equal(await phaseC2EvidenceIntact(gx.config,s),false);
  }finally{await gx.cleanup();}
});
test('C2: interruption recovers to PAUSED and refuses automatic re-edit',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,s,{status:'RUNNING',
      activeEditAttempt:{ordinal:1,startedAt:new Date().toISOString(),beforeSha256:'a'.repeat(64),startFileSha256:'b'.repeat(64)}} ,'SIMULATE_CRASH','mock'));
    s=await withWorkflowLock(fx.outputDir,()=>recoverTask(fx.outputDir,s));
    assert.equal(s.status,'PAUSED');assert.ok(s.activeEditAttempt);
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/explicit inspection/);
  }finally{await fx.cleanup();}
});
test('C2: explicit interruption reconciliation preserves partial edits and counts attempt',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    const before=await snapshotWorktree(fx.worktree);
    const body=JSON.stringify({taskId:s.taskId,ordinal:1,startedAt:new Date().toISOString(),snapshot:before},null,2)+'\n';
    await writeWorkflowArtifact(fx.outputDir,s.taskId,'edit-start-1.json',body);
    s=await withWorkflowLock(fx.outputDir,()=>writeTransition(fx.outputDir,s,{status:'RUNNING',
      activeEditAttempt:{ordinal:1,startedAt:new Date().toISOString(),beforeSha256:h(JSON.stringify(before)),startFileSha256:h(body)}},
      'SIMULATED_KILL','edit process killed after checkpoint'));
    await writeFile(path.join(fx.worktree,'src/index.ts'),'export const value = 33;\n');
    s=await withWorkflowLock(fx.outputDir,()=>recoverTask(fx.outputDir,s));
    assert.equal(s.status,'PAUSED');assert.ok(s.activeEditAttempt);
    s=await withWorkflowLock(fx.outputDir,()=>reconcileInterruptedEdit(fx.config,s));
    assert.equal(s.status,'PAUSED');assert.equal(s.activeEditAttempt,null);
    assert.equal(s.editHistory[0].outcome,'INTERRUPTED_REVIEWED');
    assert.equal(await phaseC2EvidenceIntact(fx.config,s),true);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.fixRetries,1);
    assert.equal(s.editHistory.length,2);
  }finally{await fx.cleanup();}
});
test('C2: no source change cannot create false PASS',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>({summary:'수정',rationale:'검토',testsRun:[],risks:[]})));
    assert.equal(s.status,'PAUSED');assert.equal(s.editHistory[0].error,'NO_SOURCE_CHANGE');
  }finally{await fx.cleanup();}
});
test('C2: symlink injection outside candidate paths is rejected and preserved for inspection',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await symlink(path.join(fx.worktree,'src','index.ts'),path.join(fx.worktree,'src','danger.ts'));
      return changeSrc(fx);
    }));
    assert.equal(s.status,'BLOCKED');assert.deepEqual(s.editHistory[0].forbiddenFiles,['src/danger.ts']);
  }finally{await fx.cleanup();}
});
test('C2: editing an ordinary test file is allowed but cannot itself certify PASS',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await mkdir(path.join(fx.worktree,'test'),{recursive:true});
      await writeFile(path.join(fx.worktree,'test','index.test.mjs'),'// test only\n');
      return changeSrc(fx);
    }));
    assert.deepEqual(s.editHistory[0].changedFiles,['src/index.ts','test/index.test.mjs']);
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.status,'READY');
  }finally{await fx.cleanup();}
});
test('C2: prohibited Git staging is detected even if worktree HEAD is unchanged',async()=>{
  const fx=await setup();try{
    let s=await gate(fx);
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      const result=await changeSrc(fx);
      g('-C',fx.worktree,'add','src/index.ts');return result;
    }));
    assert.equal(s.status,'BLOCKED');
    assert.equal(s.editHistory[0].error,'WORKTREE_HEAD_PATH_OR_INDEX_CHANGED');
    assert.equal(g('-C',fx.worktree,'diff','--cached','--name-only'),'src/index.ts');
  }finally{await fx.cleanup();}
});


test('C2: generated dist reference does not revoke safe src authorization, and original C1 evidence is unchanged',async()=>{
  const fx=await setup();try{
    const d={...diagnosis,candidateFiles:['src/index.ts','dist/index.js']};
    const s=await gate(fx,d);
    const evidence=await readFile(path.join(fx.outputDir,'tasks',s.taskId,'analysis.json'),'utf8');
    assert.deepEqual(JSON.parse(evidence).diagnosis.candidateFiles,d.candidateFiles);
    let prompt='';
    const result=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async(worktree,text)=>{
      prompt=text;return changeSrc(fx);
    }));
    assert.equal(result.phase,'FINAL_VERIFY');
    assert.equal(result.status,'READY');
    assert.match(prompt,/허용된 코드 파일: \["src\/index\.ts"\]/);
    assert.doesNotMatch(prompt,/허용된 코드 파일:.*dist\/index\.js/);
    assert.deepEqual(result.editHistory[0].changedFiles,['src/index.ts']);
    assert.equal(await readFile(path.join(fx.outputDir,'tasks',s.taskId,'analysis.json'),'utf8'),evidence);
  }finally{await fx.cleanup();}
});

test('C2: dist bundle is never an approved write target even when present in analysis evidence',async()=>{
  const fx=await setup();try{
    const s=await gate(fx,{...diagnosis,candidateFiles:['src/index.ts','dist/index.js']});
    const result=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      await mkdir(path.join(fx.worktree,'dist'),{recursive:true});
      await writeFile(path.join(fx.worktree,'dist/index.js'),'unauthorized edit\n');
      return changeSrc(fx);
    }));
    assert.equal(result.status,'BLOCKED');
    assert.deepEqual(result.editHistory[0].forbiddenFiles,['dist/index.js']);
  }finally{await fx.cleanup();}
});

test('C2: arbitrary out-of-scope diagnosis path remains blocked',async()=>{
  const fx=await setup();try{
    const s=await gate(fx,{...diagnosis,candidateFiles:['src/index.ts','tools/untrusted.js']});
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/No safe MCP source paths/);
    assert.equal((await readTask(fx.outputDir,s.taskId)).fixRetries,0);
  }finally{await fx.cleanup();}
});

test('C2: generated output alone cannot authorize code edits',async()=>{
  const fx=await setup();try{
    const s=await gate(fx,{...diagnosis,candidateFiles:['dist/index.js']});
    await assert.rejects(()=>modifyTask(fx.config,s,async()=>changeSrc(fx)),/No safe MCP source paths/);
    assert.equal((await readTask(fx.outputDir,s.taskId)).fixRetries,0);
  }finally{await fx.cleanup();}
});

test('F7 schema path: Codex receives exactly the schema file written to durable tasks dir',async()=>{
  const {codexEdit}=await import('../dist/phasec2.js');
  const root=await mkdtemp(path.join(tmpdir(),'f7-schema-test-'));
  const task='task-abcdef12-12345678';
  const dir=path.join(root,'runs','tasks',task);
  const bin=path.join(root,'bin');
  const oldPath=process.env.PATH;
  try{
    await mkdir(dir,{recursive:true});await mkdir(bin);
    const fake=`#!${process.execPath}\nconst fs=require('node:fs');\nconst a=process.argv.slice(2);\nconst at=x=>a[a.indexOf(x)+1];\nconst schema=at('--output-schema');\nif(!schema.endsWith('edit-schema-1.json')||!fs.existsSync(schema))process.exit(12);\nconst parsed=JSON.parse(fs.readFileSync(schema,'utf8'));\nif(parsed.type!=='object')process.exit(13);\nfs.writeFileSync(at('--output-last-message'),JSON.stringify({summary:'ok',rationale:'tested',testsRun:[],risks:[]}));\n`;
    await writeFile(path.join(bin,'codex'),fake,{mode:0o755});
    process.env.PATH=bin+path.delimiter+oldPath;
    const result=await codexEdit(root,'read schema',dir,1);
    assert.equal(result.summary,'ok');
    assert.equal(JSON.parse(await readFile(path.join(dir,'edit-schema-1.json'))).type,'object');
  } finally {process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});

test('F7 schema infra errors stay auditable, do not consume three source edit attempts, and manual restore is guarded',async()=>{
  const {resumeBlockedSchemaInfrastructureFailure,substantiveEditCount}=await import('../dist/phasec2.js');
  const fx=await setup();try{
    let s=await gate(fx);
    const fail=async (_worktree,_prompt,dir,ordinal)=>{await writeWorkflowArtifact(fx.outputDir,s.taskId,`edit-schema-${ordinal}.json`,JSON.stringify({type:'object'}));throw Error('Codex edit failed (exit=1, timeout=false, outputLimit=false; stderr=Reading additional input from stdin...\\nFailed to read output schema file /fake/schema)');};
    for(let i=1;i<=3;i++){
      s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,fail));
      assert.equal(s.editHistory.length,i);
      assert.equal(substantiveEditCount(s.editHistory),0);
      assert.equal(s.fixRetries,0);
      assert.equal(await phaseC2EvidenceIntact(fx.config,s),true);
      assert.equal(s.status,i<3?'PAUSED':'BLOCKED');
    }
    s=await withWorkflowLock(fx.outputDir,()=>resumeBlockedSchemaInfrastructureFailure(fx.config,s));
    assert.equal(s.status,'PAUSED');assert.equal(s.editHistory.length,3);
    assert.equal(s.lastError,'SCHEMA_INFRASTRUCTURE_FAILURE_RECOVERED');
    s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>changeSrc(fx)));
    assert.equal(s.phase,'FINAL_VERIFY');assert.equal(s.status,'READY');
    assert.equal(s.editHistory.length,4);assert.equal(s.editHistory[3].ordinal,4);
    assert.equal(s.fixRetries,0);assert.equal(substantiveEditCount(s.editHistory),1);
    assert.equal(await phaseC2EvidenceIntact(fx.config,s),true);
  }finally{await fx.cleanup();}
});

test('F7 schema infra administrative resume refuses genuine source modifications or forged failure classification',async()=>{
  const {resumeBlockedSchemaInfrastructureFailure}=await import('../dist/phasec2.js');
  const fx=await setup();try{
    let s=await gate(fx);
    for(let i=1;i<=3;i++)s=await withWorkflowLock(fx.outputDir,()=>modifyTask(fx.config,s,async()=>{
      throw Error('model bad output, not schema read error');
    }));
    assert.equal(s.status,'BLOCKED');
    await assert.rejects(()=>withWorkflowLock(fx.outputDir,()=>resumeBlockedSchemaInfrastructureFailure(fx.config,s)),/Non-infrastructure edit attempt/);
    assert.equal((await readTask(fx.outputDir,s.taskId)).status,'BLOCKED');
  }finally{await fx.cleanup();}
});
