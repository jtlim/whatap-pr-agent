import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {phaseDEvidenceIntact} from '../dist/phased.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
test('F7 Phase D accepts signed fourth edit ordinal only when metadata and SHA match',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'f7-ordinal-'));
 try{
  const id='task-12345678-abcdef12',dir=path.join(root,'tasks',id);
  await mkdir(dir,{recursive:true});
  const name='final-attempt-4-2-aabbccdd.json',body='{"verdict":"PASS"}\n';
  await writeFile(path.join(dir,name),body);
  const hist=[1,2,3].map(ordinal=>({ordinal,outcome:'FAILED'}));hist.push({ordinal:4,outcome:'COMPLETED'});
  const entry={phase:'FINAL_VERIFY',editOrdinal:4,ordinal:2,artifactName:name,artifactSha256:sha(body)};
  const s={taskId:id,editHistory:hist,validationHistory:[entry]},cfg={outputDir:root};
  assert.equal(await phaseDEvidenceIntact(cfg,s),true);
  assert.equal(await phaseDEvidenceIntact(cfg,{...s,validationHistory:[{...entry,editOrdinal:3}]}),false);
  assert.equal(await phaseDEvidenceIntact(cfg,{...s,validationHistory:[{...entry,ordinal:1}]}),false);
  assert.equal(await phaseDEvidenceIntact(cfg,{...s,editHistory:hist.slice(0,3)}),false);
  await writeFile(path.join(dir,name),'tampered\n');
  assert.equal(await phaseDEvidenceIntact(cfg,s),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
