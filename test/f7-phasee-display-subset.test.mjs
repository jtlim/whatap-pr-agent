import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {buildSubmissionReport} from '../dist/submission-report.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const iso=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC';

test('F7 Phase E: 100 visible TPS rows of 720 HTTP rows compare as subset; full unseen rows are not mislabeled FAIL',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'f7-phasee-subset-'));
  try{
    const t='task-12345678-abcdef12';
    const dir=path.join(root,'tasks',t);await mkdir(dir,{recursive:true});
    const stime=Date.UTC(2026,10,24,0,0,0),etime=stime+3600000;
    const rows=Array.from({length:720},(_,i)=>({time:stime+5000*(i+1),_id_:'srv1',tps:100+i/10}));
    const displayed=rows.slice(0,100);
    const makeAttempt=async(which,bad)=>{
      const runDir=path.join(root,which);await mkdir(runDir,{recursive:true});
      const mcpText=`**Period**: ${iso(stime)} → ${iso(etime)}\n\n| time | _id_ | tps |\n| --- | --- | --- |\n`+
        displayed.map(r=>`| ${iso(r.time)} | ${r._id_} | ${Number((r.tps+(bad?1:0)).toFixed(2))} |`).join('\n')+'\n';
      const mcp=JSON.stringify({content:[{type:'text',text:mcpText}]})+'\n';
      const http=JSON.stringify({content:[{type:'text',text:JSON.stringify({ok:true,status:200,body:rows})}]})+'\n';
      await writeFile(path.join(runDir,'mcp.json'),mcp);
      await writeFile(path.join(runDir,'http.json'),http);
      const status=bad?'FAIL':'PASS';
      const r={id:'apm-tps-series',status,reason:bad?'FIELD_MISMATCH':'MATCHING_DATA',
        timeWindow:{stime,etime},
        candidate:{file:'mcp.json',sha256:sha(mcp)},reference:{file:'http.json',sha256:sha(http)},
        checks:[{code:'FIELD_VALUES',ok:!bad,detail:bad?'100 mismatches':'0 mismatches'}]};
      const report=JSON.stringify({runDir,scenarios:[r]})+'\n';
      await writeFile(path.join(runDir,'report.json'),report);
      return {phase:bad?'PRE_FIX_VERIFY':'FINAL_VERIFY',ordinal:1,verdict:status,reason:r.reason,
        evidence:{runDir,reportSha256:sha(report),verdict:status},timeWindow:{stime,etime}};
    };
    const pre=await makeAttempt('pre',true),fin=await makeAttempt('final',false);
    const diagnosis={diagnosis:{problem:'numeric display wrong',impact:'misleading TPS',causeHypothesis:'formatter',
      reproductionSteps:['run a query','compare to HTTP']}};
    await writeFile(path.join(dir,'analysis.json'),JSON.stringify(diagnosis));
    await writeFile(path.join(dir,'edit-1.json'),JSON.stringify({changedFiles:['src/utils/format.ts'],
      files:[{path:'src/utils/format.ts',before:'a'.repeat(64),after:'b'.repeat(64)}]}));
    const state={taskId:t,scenarioId:'apm-tps-series',preFix:{mode:'PERIOD_PAIRED',reproduced:true},
      editHistory:[{ordinal:1,outcome:'COMPLETED'}],validationHistory:[pre,fin]};
    const cfg={outputDir:root,scenarios:[{id:'apm-tps-series',matchKeys:['time','_id_'],
      compareFields:['tps'],domain:'timeseries',projectCode:5490}]};
    const result=await buildSubmissionReport(cfg,state,{publishMetrics:true});
    assert.equal(result.rowCount,200,'only the 100 displayed rows from each independent observation');
    const [prePart,finalPart]=result.parts.join('').split('### FINAL_VERIFY #1');
    assert.match(prePart,/\| FAIL \|/,'real pre-fix mismatches remain visible');
    assert.ok(finalPart,'final section exists');
    assert.doesNotMatch(finalPart,/\| FAIL \|/,'do not mark 620 undisplayed HTTP rows as MCP failures');
    assert.equal((finalPart.match(/\| PASS \|/g)??[]).length,100);
    assert.match(result.body,/독립 검증/);
  } finally {await rm(root,{recursive:true,force:true});}
});
