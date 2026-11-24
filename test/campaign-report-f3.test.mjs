import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createTask,writeTransition,withWorkflowLock} from '../dist/workflow.js';
import {recoveryClass,writeCampaignReport} from '../tools/campaign-report.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('F3: recovered FAIL remains visible, repeated PASS does not overwrite original incident',async()=>{
  const root=await mkdtemp(join(tmpdir(),'f3-campaign-'));
  try{
    let s=await withWorkflowLock(root,()=>createTask(root,'apm-transaction-stats'));
    const arr=[];
    for(const [n,verdict,reason] of [[1,'FAIL','STATS_AGGREGATE_DIFFERENCE'],[2,'PASS','MATCHING_DATA']]){
      const dir=join(root,`run-${n}`);await mkdir(dir);
      const w={stime:1795461920000+(n-1)*60000,etime:1795465520000+(n-1)*60000};
      const r={runDir:dir,scenarios:[{id:s.scenarioId,status:verdict,reason,timeWindow:w,
        checks:[{code:'STATS_AGGREGATE',ok:verdict==='PASS',detail:reason}],candidate:{parsedRows:100},
        reference:{rowCount:29482}}]};
      const raw=JSON.stringify(r)+'\n';await writeFile(join(dir,'report.json'),raw);
      arr.push({phase:'INITIAL_VERIFY',ordinal:n,verdict,reason,
        startedAt:new Date().toISOString(),timeWindow:w,
        evidence:{runDir:dir,reportSha256:hash(raw),verdict,at:new Date().toISOString()}});
    }
    s=await withWorkflowLock(root,()=>writeTransition(root,s,{phase:'DONE',status:'COMPLETED',
      validationHistory:arr,latestValidation:arr.at(-1).evidence},'TEST_RECOVERED','final pass'));
    assert.equal(recoveryClass(s),'RECOVERED_FAIL');
    const output=await writeCampaignReport({outputDir:root,worktree:root,analyzeRecovered:false,
      results:[{taskId:s.taskId,scenarioId:s.scenarioId,result:'RECOVERED_FAIL'}]});
    const md=await readFile(output.mdPath,'utf8');
    assert.match(md,/RECOVERED_FAIL/);assert.match(md,/STATS_AGGREGATE_DIFFERENCE/);
    assert.match(md,/MATCHING_DATA/);assert.match(md,/Period 가 다른/);
    // A stored report cannot be trusted after its SHA changes.
    await writeFile(join(root,'run-1','report.json'),'{}');
    await assert.rejects(()=>writeCampaignReport({outputDir:root,worktree:root,analyzeRecovered:false,
      results:[{taskId:s.taskId,scenarioId:s.scenarioId,result:'RECOVERED_FAIL'}]}),/SHA mismatch/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('F3: public report requires explicit consent before any Phase E action',async()=>{
  const {buildSubmissionReport}=await import('../dist/submission-report.js');
  await assert.rejects(()=>buildSubmissionReport({scenarios:[]},{preFix:{mode:'PERIOD_PAIRED'}},
    {publishMetrics:false}),/PUBLIC_METRICS_CONFIRMATION_REQUIRED/);
});
