/** Read a completed Codex diagnosis as diagnostic evidence, never as edit authorization. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export async function getF7DiagnosisSummary({outputDir,taskId,expectedSha256}) {
  if(!taskId)return {status:'NOT_RECORDED',integrity:'UNVERIFIABLE'};
  const artifact=join(outputDir,'tasks',taskId,'analysis.json');
  let body;
  try {body=await readFile(artifact);}catch(e) {
    return {status:'NOT_RECORDED',integrity:'UNVERIFIABLE',artifact};
  }
  if(!expectedSha256||!/^[a-f0-9]{64}$/.test(expectedSha256)||body.length>1024*1024 ||
     createHash('sha256').update(body).digest('hex')!==expectedSha256) {
    return {status:'INTEGRITY_FAILURE',integrity:'FAIL',artifact};
  }
  try{
    const data=JSON.parse(body.toString('utf8'));
    if(data?.taskId!==taskId || !data?.diagnosis || typeof data.diagnosis.classification!=='string')
      return {status:'INVALID_SCHEMA',integrity:'FAIL',artifact};
    const d=data.diagnosis;
    return {status:'RECORDED',integrity:'PASS',artifact,
      classification:String(d.classification).slice(0,64),
      confidence:String(d.confidence??'').slice(0,64),
      summary:String(d.causeHypothesis??d.problem??'').slice(0,1000),
      candidateFiles:Array.isArray(d.candidateFiles)?d.candidateFiles.slice(0,30):[],
      limitations:Array.isArray(d.limitations)?d.limitations.slice(0,10):[]};
  }catch{return {status:'INVALID_JSON',integrity:'FAIL',artifact};}
}
