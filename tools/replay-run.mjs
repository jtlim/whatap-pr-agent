#!/usr/bin/env node
/** Independent read-only replay of v0.4.x saved tool results, no API or LLM calls. */
import { readFile,readdir,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { extractContent,assessReference,verifyReferenceRequest,isWithinTimeWindow } from '../dist/validator.js';
import { parseFormattedMcp } from '../dist/period.js';
import { compareSubset,checkSummary,isBoundaryOnlyShift } from '../dist/agent.js';
import { analyzeStats } from '../dist/statistics.js';
const cfg=JSON.parse(await readFile('config/harness.json','utf8'));
const runs=resolve(cfg.outputDir);
let target=process.argv[2];
if(!target){
 const files=await readdir(runs,{withFileTypes:true});
 const times=await Promise.all(files.filter(d=>d.isDirectory()).map(async d=>{
   const path=resolve(runs,d.name,'report.json');return {path,mtime:(await stat(path).catch(()=>({mtimeMs:-1}))).mtimeMs};
 }));
 target=times.sort((a,b)=>b.mtime-a.mtime)[0]?.path;
}else target=resolve(target,'report.json');
if(!target)throw Error('재검증할 보고서 없음');
const report=JSON.parse(await readFile(target,'utf8'));
if(!['0.4.0','0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.5.0-alpha.1','0.5.0-alpha.2','0.5.0-alpha.3-c1','0.5.0-alpha.4-c2','0.5.0-alpha.5-d','0.5.0-alpha.10-f4-auto','0.5.0-alpha.11-f5-forensics','0.5.0-alpha.12-f6-reference-guard'].includes(report.harnessVersion))throw Error('v0.4.x 및 v0.5.0-alpha.2 보고서를 지원합니다. v0.3.0 은 replay-run-v03.mjs 를 사용하세요.');
const dir=resolve(target,'..');let count=0,issues=0;
async function evidence(meta){
 if(!meta.file||!meta.sha256)return null;
 const p=resolve(dir,meta.file);if(!p.startsWith(dir+'/'))throw Error('근거 경로가 실행 디렉터리 밖');
 const buf=await readFile(p);
 if(createHash('sha256').update(buf).digest('hex')!==meta.sha256)throw Error(`증거 파일 손상: ${p}`);
 return JSON.parse(buf.toString('utf8'));
}
function combine(statuses){
 if(statuses.includes('FAIL'))return 'FAIL';
 return statuses.length && statuses.every(x=>x==='PASS')?'PASS':'UNVERIFIABLE';
}
for(const r of report.scenarios){
 const s=cfg.scenarios.find(v=>v.id===r.id);
 if(!s)throw Error(`시나리오 없음: ${r.id}`);
 const calls=r.callResults?.length?r.callResults:[r];
 const derivedStatuses=[];
 for(const c of calls){
  const prefix=r.callResults?.length?`${r.id} 호출 ${c.index}`:r.id;
  // Authenticate every stored blob, even when the other side is missing.
  const m=await evidence(c.candidate),h=await evidence(c.reference);
  if(!m||!h){
   if(c.status==='PASS'||c.status==='FAIL'){
    console.log(`${prefix}: 비교 결과는 ${c.status} 인데 원본 증거가 누락됨`);
    issues++;
   }else console.log(`${prefix}: ${c.status} (비교용 원본 부족으로 재검증 제외)`);
   derivedStatuses.push('UNVERIFIABLE');
   continue;
  }
  const raw=extractContent(m);
  if(typeof raw!=='string'){console.log(`${prefix}: 형식 오류`);issues++;derivedStatuses.push('UNVERIFIABLE');continue;}
  const parsed=parseFormattedMcp(raw,[...(s.matchKeys??[]),...(s.compareFields??[])]);
  if(!parsed.ok){console.log(`${prefix}: 파싱 오류 ${parsed.reason}`);issues++;derivedStatuses.push('UNVERIFIABLE');continue;}
  if(parsed.data.period.stime!==c.timeWindow.stime||parsed.data.period.etime!==c.timeWindow.etime){
   console.log(`${prefix}: Period 바뀜`);issues++;derivedStatuses.push('UNVERIFIABLE');continue;
  }
  const effective={...s,stime:c.timeWindow.stime,etime:c.timeWindow.etime};
  if(!parsed.data.rows.every(row=>isWithinTimeWindow(effective,row.time))){
   console.log(`${prefix}: MCP 행이 허용된 Period 밖에 있음`);
   issues++;derivedStatuses.push('UNVERIFIABLE');continue;
  }
  const ref=extractContent(h);
  if(s.statisticsMode){
   const statMeta=c.reference.statistics;
   if(!statMeta || !statMeta.mxql || !statMeta.v2Window){
    console.log(`${prefix}: 통계 MXQL 원본 또는 정렬 기간 증거 누락`);
    issues++;derivedStatuses.push('UNVERIFIABLE');continue;
   }
   const rawEvidence=await evidence(statMeta.mxql);
   if(!rawEvidence){console.log(`${prefix}: MXQL 증거 미확보`);issues++;derivedStatuses.push('UNVERIFIABLE');continue;}
   const result=analyzeStats(s,parsed.data,raw,extractContent(rawEvidence),ref);
   const windowOK=result.v2Window.stime===statMeta.v2Window.stime && result.v2Window.etime===statMeta.v2Window.etime;
   const metadataOK=result.visibleRows===statMeta.visibleMcpRows && result.fullRows===statMeta.fullMxqlRows &&
     result.v2Rows===statMeta.v2RowCount && result.buckets===statMeta.comparedBuckets;
   // Preserve old F5 report semantics: the SAME saved HTTP inconsistency was
   // historically labelled FAIL. F6 changes the safety classification, not data.
   const oldReference=report.harnessVersion==='0.5.0-alpha.11-f5-forensics'&&
     c.status==='FAIL'&&c.reason==='STATS_AGGREGATE_DIFFERENCE'&&
     result.status==='UNVERIFIABLE'&&result.reason==='REFERENCE_INCONSISTENCY';
   const recordedPolicyStatus=oldReference?'FAIL':result.status;
   const ok=recordedPolicyStatus===c.status && windowOK && metadataOK;
   if(!ok)issues++;
   derivedStatuses.push(recordedPolicyStatus);
   count++;
   console.log(`${prefix}: 보고서=${c.status} / 재검증=${recordedPolicyStatus}${oldReference?' (F5 레거시 FAIL=F6 기준 불일치; 자동 수정 금지)':''} / MCP ${result.visibleRows}행, HTTP MXQL ${result.fullRows}행, v2 ${result.v2Rows}그룹 ${ok?'일치':'불일치'}`);
   continue;
  }
  const align=c.reference.boundaryAlignment;
  let effectiveReference=effective;
  if(align){
   // Replay must authenticate BOTH HTTP evidence sets and independently prove
   // the original mismatch is solely the expected one-bucket shift.
   const orig=await evidence(align.original);
   const sameWindow=align.original.timeWindow.stime===effective.stime &&
    align.original.timeWindow.etime===effective.etime;
   const originalPayload=orig?extractContent(orig):null;
   const originalAssessment=orig?assessReference(effective,originalPayload,{skipStepCoverage:true}):null;
   const originalRequest=orig?verifyReferenceRequest(effective,originalPayload):null;
   if(!sameWindow||!originalAssessment?.complete||!originalRequest?.ok||!originalAssessment.rows||
      !isBoundaryOnlyShift(effective,originalAssessment.rows,parsed.data.rows)){
    console.log(`${prefix}: 최초 경계 차이 증거가 성립하지 않음`);
    issues++;derivedStatuses.push('UNVERIFIABLE');continue;
   }
   let attemptIntegrity=true;
   for(const attempt of align.attempts){
    if(![1,1000].includes(attempt.deltaMs) ||
      attempt.timeWindow.stime!==effective.stime+attempt.deltaMs ||
      attempt.timeWindow.etime!==effective.etime+attempt.deltaMs){
      attemptIntegrity=false;break;
    }
    if(attempt.file){
     const originalAttempt=await evidence(attempt);
     const payload=originalAttempt?extractContent(originalAttempt):null;
     if(!originalAttempt||!verifyReferenceRequest({...effective,...attempt.timeWindow},payload).ok){
      attemptIntegrity=false;break;
     }
    }else if(attempt.status==='PASS'){attemptIntegrity=false;break;}
   }
   const selected=align.attempts.find(v=>v.deltaMs===align.selectedDeltaMs);
   if(align.selectedDeltaMs!==undefined){
    if(!selected||selected.status!=='PASS'||selected.file!==c.reference.file||
       selected.sha256!==c.reference.sha256)attemptIntegrity=false;
    else effectiveReference={...effective,...selected.timeWindow};
   }else if(c.reference.file!==align.original.file || c.reference.sha256!==align.original.sha256){
    attemptIntegrity=false;
   }
   if(!attemptIntegrity){
    console.log(`${prefix}: 보정 조회 증거 또는 선택 기록 오류`);
    issues++;derivedStatuses.push('UNVERIFIABLE');continue;
   }
  }
  const a=assessReference(effectiveReference,ref,{skipStepCoverage:true}),q=verifyReferenceRequest(effectiveReference,ref);
  if(!a.complete||!q.ok||!a.rows){
   console.log(`${prefix}: API 기준 불완전`);issues++;derivedStatuses.push('UNVERIFIABLE');continue;
  }
  const comparison=compareSubset(s,a.rows,parsed.data.rows);
  const sum=checkSummary(raw,s,a.rows,parsed.data.rows);
  const derived=sum.ok?comparison.status:'FAIL';
  const ok=derived===c.status;count++;if(!ok)issues++;
  derivedStatuses.push(derived);
  console.log(`${prefix}: 보고서=${c.status} / 재검증=${derived} / ${comparison.coverage}행 ${ok?'일치':'불일치'}`);
 }
 if(r.callResults?.length){
  const aggregate=combine(derivedStatuses),ok=aggregate===r.status;
  if(!ok)issues++;
  console.log(`${r.id} 전체: 보고서=${r.status} / 재검증=${aggregate} ${ok?'일치':'불일치'}`);
 }
}
console.log(`재검증 ${count}개 MCP 호출, 판정 불일치/증거 오류 ${issues}개`);
if(issues)process.exitCode=1;
