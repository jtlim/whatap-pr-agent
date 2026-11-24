#!/usr/bin/env node
/**
 * Read-only historical boundary probe.
 * Reuses an existing MCP candidate and exact Period from an earlier FAILED run,
 * calls only the independent HTTP reference using original and shifted windows,
 * and prints a compact result. Does not change historical report or source files.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { StdioMcpClient } from '../dist/mcp.js';
import { extractContent, assessReference, verifyReferenceRequest } from '../dist/validator.js';
import { parseFormattedMcp } from '../dist/period.js';
import { compareSubset, checkSummary, isBoundaryOnlyShift } from '../dist/agent.js';

const runDir=resolve(process.argv[2]??'runs/2026-11-22T18-30-53-464Z-bd173a9e');
const report=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));
const scenario=report.scenarios.find(s=>s.id==='apm-error-series');
if(!scenario)throw Error('저장된 APM 오류 시계열 결과가 없습니다');
const call=(scenario.callResults?.length?scenario.callResults:[scenario]).find(c=>c.status==='FAIL');
if(!call||!call.candidate?.file||!call.reference?.file)throw Error('원본 MCP/HTTP 실패 증거가 없습니다');
const {config}=await loadConfig(resolve('config/harness.json'));
const spec=config.scenarios.find(s=>s.id==='apm-error-series');
if(!spec)throw Error('현재 APM 오류 시계열 설정 없음');
async function openEvidence(meta){
 const target=resolve(runDir,meta.file);
 if(!target.startsWith(runDir+sep))throw Error('증거 경로가 실행 디렉터리 밖');
 const data=await readFile(target);
 if(createHash('sha256').update(data).digest('hex')!==meta.sha256)throw Error('원본 증거 SHA-256 이 일치하지 않음');
 return JSON.parse(data.toString('utf8'));
}
const candidate=await openEvidence(call.candidate);
const original=await openEvidence(call.reference);
const text=extractContent(candidate);
if(typeof text!=='string')throw Error('MCP 원문 형식이 예상과 다름');
const parsed=parseFormattedMcp(text,[...(spec.matchKeys??[]),...(spec.compareFields??[])]);
if(!parsed.ok)throw Error(`MCP 표 파싱 불가: ${parsed.reason}`);
const period=parsed.data.period;
if(call.timeWindow.stime!==period.stime||call.timeWindow.etime!==period.etime)throw Error('원본 MCP Period 와 저장된 보고서가 다름');
const effective={...spec,...call.timeWindow};
const origPayload=extractContent(original);
const a=assessReference(effective,origPayload,{skipStepCoverage:true});
const q=verifyReferenceRequest(effective,origPayload);
if(!a.complete||!a.rows||!q.ok||!isBoundaryOnlyShift(effective,a.rows,parsed.data.rows)){
 throw Error('저장된 실패는 5초 경계의 단일 시작·종료 버킷 차이만으로 설명되지 않음');
}
console.log('=== 저장된 실패 MCP 응답 기준 5초 경계 실측 ===');
console.log(`MCP Period: ${new Date(period.stime).toISOString()} ~ ${new Date(period.etime).toISOString()}`);
console.log(`원본 HTTP: ${a.rows.length}건, MCP: ${parsed.data.rows.length}건, 공통 ${a.rows.length-1}건 값 일치`);
const ref=new StdioMcpClient(config.servers.reference,config.rpcTimeoutMs);
await ref.start();
let pass=false;
try {
 for(const deltaMs of [1,1000]){
  const shifted={...effective,stime:effective.stime+deltaMs,etime:effective.etime+deltaMs};
  const response=await ref.callTool(spec.referenceTool,{projectCode:spec.projectCode,stime:shifted.stime,etime:shifted.etime});
  const payload=extractContent(response);
  const assessment=assessReference(shifted,payload,{skipStepCoverage:true});
  const request=verifyReferenceRequest(shifted,payload);
  if(response.isError||!assessment.complete||!request.ok||!assessment.rows){
   console.log(`+${deltaMs}ms: HTTP 기준 응답 검증 불가`);continue;
  }
  const cmp=compareSubset(spec,assessment.rows,parsed.data.rows);
  const sum=checkSummary(text,spec,assessment.rows,parsed.data.rows);
  console.log(`+${deltaMs}ms: HTTP ${assessment.rows.length}건, MCP ${parsed.data.rows.length}건, 식별자·값 ${cmp.status}, 요약 ${sum.ok?'PASS':'FAIL'}`);
  if(cmp.status==='PASS'&&sum.ok){pass=true;break;}
 }
}finally{await ref.close();}
console.log(`저장된 실제 MCP 결과의 보정 검증: ${pass?'PASS':'FAIL'}`);
if(!pass)process.exitCode=1;
