#!/usr/bin/env node
/** Replay existing evidence for v0.3.0 without any API calls or writes. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { extractContent, assessReference, compareRows, verifyReferenceRequest } from '../dist/validator.js';
import { parseFormattedMcp, forMcpDisplay } from '../dist/period.js';
const root=process.cwd();
const config=JSON.parse(await readFile('config/harness.json','utf8'));
async function latest(){
 const paths=await readdir(resolve(config.outputDir),{withFileTypes:true});
 const files=await Promise.all(paths.filter(x=>x.isDirectory()).map(async x=>{
  const p=resolve(config.outputDir,x.name,'report.json');
  return {path:p,time:(await stat(p).catch(()=>({mtimeMs:-1}))).mtimeMs};
 }));
 files.sort((a,b)=>b.time-a.time);
 return files[0]?.path;
}
const reportPath=process.argv[2]?resolve(process.argv[2],'report.json'):await latest();
if(!reportPath)throw new Error('검증 실행 기록 없음');
const report=JSON.parse(await readFile(reportPath,'utf8'));
if(report.harnessVersion!=='0.3.0')throw new Error('v0.3.0 기록을 대상으로만 실행해 주세요. 과거 기록은 기존 verify-snapshots.mjs 로 확인하세요.');
const dir=resolve(reportPath,'..');
const evidence=async (meta)=>{
 if(!meta.file||!meta.sha256)return null;
 const full=resolve(dir,meta.file);
 if(!full.startsWith(dir+'/'))throw new Error('근거 파일 경로가 실행 폴더를 벗어남');
 const bytes=await readFile(full);
 if(createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw new Error(`증거 SHA-256 불일치: ${meta.file}`);
 return JSON.parse(bytes.toString('utf8'));
};
console.log(`WhaTap Harness v0.3.0 근거 재검증 (읽기 전용)\n대상: ${dir}`);
let checked=0, issues=0;
for(const r of report.scenarios){
 const s=config.scenarios.find(x=>x.id===r.id);
 if(!s)throw new Error(`설정에서 ${r.id} 없음`);
 if(!s.mcpPath){console.log(`[${r.id}] UNMAPPED: 비교할 MCP 도구 없음`);continue;}
 const m=await evidence(r.candidate);
 const ref=await evidence(r.reference);
 if(!m||!ref){ console.log(`[${r.id}] ${r.status}: MCP 또는 HTTP 원본이 없어 재비교 불가`); continue; }
 const text=extractContent(m);
 if(typeof text!=='string'){console.log(`[${r.id}] MCP 데이터가 문자열 표가 아님`);continue;}
 const parsed=parseFormattedMcp(text,[...(s.matchKeys??[]),...(s.compareFields??[])]);
 if(!parsed.ok){console.log(`[${r.id}] ${parsed.reason}`);continue;}
 const effective={...s,stime:parsed.data.period.stime,etime:parsed.data.period.etime};
 if(r.timeWindow.stime!==effective.stime||r.timeWindow.etime!==effective.etime)throw new Error(`${r.id} 저장된 기간이 실제 Period 와 다름`);
 const reference=extractContent(ref);
 const assessment=assessReference(effective,reference);
 const requestCheck=verifyReferenceRequest(effective,reference);
 if(!assessment.complete||!requestCheck.ok){console.log(`[${r.id}] HTTP 기준 데이터 불완전`);continue;}
 const comparison=compareRows({...effective,absoluteTolerance:0},forMcpDisplay(assessment.rows,s.compareFields),parsed.data.rows);
 const original=parsed.data.truncated||parsed.data.rows.length>=s.mcpLimit?'UNVERIFIABLE':comparison.status;
 checked++;
 const match=r.status===original;
 if(!match)issues++;
 console.log(`[${r.id}] 저장 판정=${r.status}, 재검증=${original} (${comparison.reason}) ${match?'일치':'판정 불일치'}`);
}
console.log(`결론: ${checked}건 재검증, 판정 불일치 ${issues}건`);
if(issues)process.exitCode=1;
