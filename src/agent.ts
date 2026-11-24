import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { HarnessConfig, McpToolResult, RunReport, Scenario, ScenarioReport, CallReport, Status, Check } from './types.js';
import { StdioMcpClient } from './mcp.js';
import { assessReference, classifyMcpResult, compareRows, extractContent, verifyReferenceRequest, isWithinTimeWindow } from './validator.js';
import { forMcpDisplay, parseFormattedMcp, expectedDurationMs } from './period.js';
import { makeMarkdown, reasonKo } from './runner.js';
import { analyzeStats, alignedStatsWindow } from './statistics.js';
import { assessWindowSchema } from './fixed-window.js';
import {fixedReplayArgs,relativeReplayArgs,type FixedReplay,type RelativeReplay} from './replay.js';

export interface AgentOptions {
  /** F1-B: deterministic read-only replay; skips Codex entirely. */
  fixedReplay?: FixedReplay;
  /** F2: direct relative replay; the tool decides Period, Harness independently verifies HTTP. */
  relativeReplay?: RelativeReplay;
  scenarioId?: string;
  requestOverride?: string;
  /** F4: bounded recovery hint only after an observed UNMAPPED mapping failure. */
  retryGuidance?: string;
  /** Mock-injectable command for testing; normal use defaults to installed Codex. */
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Optional second Codex read-only source diagnosis, only for FAIL. */
  diagnose?: boolean;
}
type Rec = Record<string, unknown>;
export interface ObservedCall { server: string; tool: string; arguments: Rec; result: McpToolResult | null; error?: string; }
export interface CodexTrace { calls: ObservedCall[]; finalMessage: string; exitCode: number; errors: string[]; rawJsonl: string; }
const record = (v: unknown): v is Rec => !!v && typeof v==='object' && !Array.isArray(v);
const secrets = () => [process.env.WHATAP_API_TOKEN, process.env.WHATAP_HTTP_API_TOKEN].filter((s):s is string=>!!s);
const scrub = (s: string) => secrets().reduce((v,secret)=>v.replaceAll(secret,'[REDACTED]'),s);
function safeName(s:string):string {return s.replace(/[^a-z0-9-]/g,'-');}
async function store(runDir:string, name:string, v:unknown, raw=false):Promise<{file:string;sha256:string}> {
  const file=`raw/${safeName(name)}.${raw?'jsonl':'json'}`;
  const data=scrub(raw ? String(v) : JSON.stringify(v,null,2))+'\n';
  await writeFile(join(runDir,file),data,{flag:'wx',mode:0o600});
  return {file,sha256:createHash('sha256').update(data).digest('hex')};
}

/** Consume native Codex --json events; final LLM text is never treated as tool evidence. */
export function parseCodexEvents(events: unknown[]): Pick<CodexTrace,'calls'|'finalMessage'|'errors'> {
  const calls:ObservedCall[]=[]; let finalMessage=''; const errors:string[]=[];
  for (const e of events) {
    if (!record(e)) continue;
    if (e.type==='error') errors.push(String(e.message??'Codex error'));
    if (e.type==='turn.failed') errors.push('Codex turn failed');
    if (e.type!=='item.completed' || !record(e.item)) continue;
    const item=e.item;
    if (item.type==='agent_message' && typeof item.text==='string') finalMessage=item.text;
    if (item.type==='file_change') errors.push('Codex attempted a file change');
    if (item.type==='mcp_tool_call') {
      const args=record(item.arguments)?item.arguments:{};
      const value=record(item.result)?item.result:null;
      const result=value && (Array.isArray(value.content) || value.structuredContent!==undefined || value.structured_content!==undefined)
        ? {...value, structuredContent: value.structuredContent??value.structured_content} as McpToolResult : null;
      calls.push({server:String(item.server??''),tool:String(item.tool??''),arguments:args,
        result,error:item.error?String(record(item.error)?item.error.message??'tool failed':item.error):undefined});
    }
  }
  return {calls,finalMessage,errors};
}

/** Per-process Codex MCP overrides. No global Codex config or credentials are written. */
export function buildCodexArgs(config:HarnessConfig):string[] {
  const proxy=fileURLToPath(new URL('../tools/whatap-proxy.mjs',import.meta.url));
  return ['exec','--json','--ephemeral','--sandbox','read-only',
    '--skip-git-repo-check',
    // The transparent proxy forwards all MCP traffic unchanged to the genuine server.
    '-c',`mcp_servers.whatap.command=${JSON.stringify(process.execPath)}`,
    '-c',`mcp_servers.whatap.args=${JSON.stringify([proxy,config.servers.candidate])}`,
    // Codex does not automatically forward every shell variable to MCP processes.
    // The tap path is required for proxy startup; the token is required by WhaTap.
    // Pass only NAMES here. The values come from this Codex subprocess environment.
    '-c',`mcp_servers.whatap.env_vars=${JSON.stringify(['WHATAP_HARNESS_TAP_FILE','WHATAP_API_TOKEN'])}`,
    '-c','mcp_servers.whatap.enabled=true',
    // LLM may only use the candidate. HTTP reference remains Harness-owned.
    '-c','mcp_servers.whatap-http.enabled=false'];
}

/** Distinguish MCP startup/handshake failures from an LLM that chose not to call a tool. */
export function detectMcpStartupFailure(calls:ObservedCall[],errors:string[]=[]):string|null {
  const pattern=/MCP startup failed|handshaking with MCP server failed|initialize response: connection closed|failed to get client/i;
  for(const c of calls) {
    if(c.server==='whatap' && c.error && pattern.test(c.error)) return c.error;
  }
  return errors.find(e=>pattern.test(e))??null;
}

async function codexExec(prompt:string, options:AgentOptions, config:HarnessConfig, tapFile:string):Promise<CodexTrace> {
  const command=options.command??'codex';
  const args=[...(options.commandArgs??buildCodexArgs(config)),prompt];
  const cp=spawn(command,args,{cwd:options.cwd??process.cwd(),env:{...process.env,WHATAP_HARNESS_TAP_FILE:tapFile},stdio:['ignore','pipe','pipe']});
  const timeout=options.timeoutMs??240000;
  let stdout='',stderr='',pending=''; const events:unknown[]=[];
  const decoder=new StringDecoder('utf8');
  const timer=setTimeout(()=>cp.kill('SIGTERM'),timeout);
  cp.stdout.on('data',(buf:Buffer)=>{
    const chunk=decoder.write(buf); stdout+=chunk; pending+=chunk;
    let idx:number;
    while((idx=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,idx);pending=pending.slice(idx+1);
      if(line.trim()){try{events.push(JSON.parse(line));}catch{ /* persisted for inspection */ }}
    }
  });
  cp.stderr.on('data',(buf:Buffer)=>{stderr+=buf.toString('utf8');});
  const exitCode:number=await new Promise<number>((done,reject)=>{
    cp.on('error',reject);cp.on('close',code=>done(code??-1));
  }).finally(()=>clearTimeout(timer));
  pending+=decoder.end();
  if(pending.trim()){try{events.push(JSON.parse(pending));}catch{}}
  const parsed=parseCodexEvents(events);
  if(exitCode!==0) parsed.errors.push(`Codex exit=${exitCode}; stderr=${stderr.slice(-600)}`);
  return {...parsed,exitCode,rawJsonl:stdout};
}

function init(s:Scenario):ScenarioReport {
  return {id:s.id,domain:s.domain,projectCode:s.projectCode,
    timeWindow:{stime:0,etime:0},referenceTool:s.referenceTool,
    mcpTool:null,mcpPath:null,status:'UNVERIFIABLE',reason:'NOT_EXECUTED',checks:[],reference:{},candidate:{}};
}
function promptFor(s:Scenario, override?:string, retryGuidance?:string):string {
  const request=override??s.userRequest??`프로젝트 ${s.projectCode} 의 ${s.description} 을 최근 1시간 범위로 조회해 줘.`;
  return [
    '다음은 일반 사용자의 모니터링 조회 질문입니다. 일반 사용자에게 답하듯 수행하세요.',
    request,
    ...(retryGuidance?['', '검증 경로 탐색 재시도 지침(이전 조회가 UNMAPPED 로 판정됨):', retryGuidance]:[]),
    '',
    '조회에는 연결된 기존 whatap MCP 를 사용하세요. 조회 방법, 도구, 경로, limit 은 당신이 판단하세요.',
    '코드/설정/파일 수정, 셸 명령 실행, whatap-http 호출은 하지 마세요.',
    '사용자가 요청하지 않은 조회 기간이나 조회 건수 제한을 임의로 바꾸지 마세요.',
    '조회 결과와 MCP 에서 반환된 Period 및 결과 범위를 사용자에게 전달하세요.',
  ].join('\n');
}
function selectedQueries(trace:CodexTrace,s:Scenario):ObservedCall[] {
  // Codex can legitimately retry the same metric with a larger limit. Each
  // matching tools/call is evidence and must be checked independently.
  return trace.calls.filter(c=>c.server==='whatap' && c.tool==='whatap_query_data' &&
    Number(c.arguments.projectCode)===s.projectCode &&
    (!s.statisticsMode || authorizedPath(s,c.arguments)));
}
function authorizedPath(s:Scenario,args:Rec):boolean {
  const actual=typeof args.path==='string'?args.path.replace(/^\/+/, ''):null;
  const allowed=s.allowedMcpPaths??(s.mcpPath?[s.mcpPath]:[]);
  return actual!==null && allowed.map(v=>v.replace(/^\/+/, '')).includes(actual);
}
/** Compare visible rows to an independently queried full API set. Never assume first-N order. */
export function compareSubset(s:Scenario, full:Rec[], shown:Rec[]): {status:Status;reason:string;checks:Check[];coverage:string} {
  const keys=s.matchKeys??[], fields=s.compareFields??[];
  if(keys.length===0 || fields.length===0) return {status:'UNVERIFIABLE',reason:'COMPARISON_FIELDS_UNDEFINED',checks:[],coverage:'unknown'};
  const key=(r:Rec)=>JSON.stringify(keys.map(k=>Object.hasOwn(r,k)?(typeof r[k]==='number'?String(r[k]):r[k]):'<<missing>>'));
  const map=new Map<string,Rec>();
  for(const r of full){const k=key(r);if(k.includes('<<missing>>')||map.has(k))return{status:'UNVERIFIABLE',reason:'AMBIGUOUS_RECORD_IDENTITIES',checks:[],coverage:'unknown'};map.set(k,r);}
  const checked=new Set<string>();const selected:Rec[]=[];
  for(const r of shown){
    const k=key(r);
    if(k.includes('<<missing>>')||checked.has(k))return{status:'UNVERIFIABLE',reason:'AMBIGUOUS_RECORD_IDENTITIES',checks:[],coverage:'unknown'};
    checked.add(k); const found=map.get(k);
    if(!found) return {status:'FAIL',reason:'MISSING_OR_EXTRA_RECORDS',checks:[{code:'RECORD_IDENTITIES',ok:false,detail:`MCP 레코드 ${k} 는 API 원본에서 찾을 수 없음`}],coverage:`${shown.length}/${full.length}`};
    selected.push(found);
  }
  if(!shown.length)return{status:'UNVERIFIABLE',reason:'MCP_TABLE_NO_ROWS',checks:[],coverage:'0'};
  const normalized=forMcpDisplay(selected,fields);
  const cmp=compareRows({...s,absoluteTolerance:0},normalized,shown);
  return {...cmp,coverage:`${shown.length}/${full.length}`};
}

/** Permit a shifted HTTP retry only for one exact 5-second end/start bucket swap.
 * Shared records must already match (including displayed values). This guard prevents
 * true in-range metric differences from being disguised as timestamp alignment.
 */
export function isBoundaryOnlyShift(s:Scenario, full:Rec[], shown:Rec[]):boolean {
  const step=s.expectedStepMs;
  if(s.domain!=='timeseries'||step!==5000||s.stime%step!==0||s.etime%step!==0||
     full.length!==shown.length||shown.length<2)return false;
  const keys=s.matchKeys??[];
  if(!keys.includes('time')||keys.length<2)return false;
  const key=(r:Rec)=>JSON.stringify(keys.map(k=>Object.hasOwn(r,k)?
    (typeof r[k]==='number'?String(r[k]):r[k]):'<<missing>>'));
  const a=new Map(full.map(r=>[key(r),r]));
  const b=new Map(shown.map(r=>[key(r),r]));
  if(a.size!==full.length||b.size!==shown.length)return false;
  const onlyA=full.filter(r=>!b.has(key(r)));
  const onlyB=shown.filter(r=>!a.has(key(r)));
  if(onlyA.length!==1||onlyB.length!==1||onlyA[0].time!==s.stime||onlyB[0].time!==s.etime)return false;
  if(keys.filter(k=>k!=='time').some(k=>onlyA[0][k]!==onlyB[0][k]))return false;
  const commonA=full.filter(r=>b.has(key(r)));
  const commonB=shown.filter(r=>a.has(key(r)));
  return compareSubset(s,commonA,commonB).status==='PASS';
}

/** Verify formatted Summary fields against *unrounded API rows* corresponding to displayed records. */
export function checkSummary(text:string,s:Scenario,full:Rec[],shown:Rec[]):Check {
  const summary=/\*\*Summary\*\*\s*\(([^\n)]*)\):\s*([^\n]+)/.exec(text);
  if(!summary) return {code:'MCP_SUMMARY',ok:true,detail:'MCP 요약 통계 없음 (검증 대상 없음)'};
  const fields=summary[2].split(/\s+\|\s+/);
  const key=(r:Rec)=>JSON.stringify((s.matchKeys??[]).map(k=>typeof r[k]==='number'?String(r[k]):r[k]));
  const map=new Map(full.map(r=>[key(r),r]));
  const originals=shown.map(r=>map.get(key(r))).filter((r):r is Rec=>!!r);
  if(originals.length!==shown.length) return {code:'MCP_SUMMARY',ok:false,detail:'요약에 대응하는 원본 행을 확정할 수 없음'};
  const reasons:string[]=[];let matched=0;
  for(const piece of fields){
    const m=/^\*\*([^*]+)\*\*\s*\(([-\d.eE+]+)\s*[–-]\s*([-\d.eE+]+).*?,\s*avg\s+([-\d.eE+]+)/.exec(piece.trim());
    if(!m){reasons.push(`요약 해석 불가: ${piece.slice(0,50)}`);continue;}
    const col=m[1]; const vals=originals.map(r=>r[col]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
    if(vals.length<2){reasons.push(`${col}: 원본 숫자 데이터 부족`);continue;}
    const f=(v:number)=>Number.isInteger(v)?String(v):v.toFixed(1);
    const actual=[f(Math.min(...vals)),f(Math.max(...vals)),f(vals.reduce((a,b)=>a+b,0)/vals.length)];
    const expected=[m[2],m[3],m[4]];
    if(actual.some((v,i)=>Number(v)!==Number(expected[i])))reasons.push(`${col}: MCP [${expected}] / API 계산 [${actual}]`);
    else matched++;
  }
  const rowPrefix=summary[1].match(/^(\d+)(?:\s+of\s+(\d+))?\s+rows/);
  if(rowPrefix && Number(rowPrefix[1])!==shown.length)reasons.push(`요약의 표시 행 수 ${rowPrefix[1]} != 실제 표 ${shown.length}`);
  return {code:'MCP_SUMMARY',ok:reasons.length===0&&matched>0,
    detail:reasons.length?reasons.join('; '):`표시된 ${shown.length}행의 원본 수치로 계산한 요약 ${matched}개 필드 일치`};
}

async function compareOne(refClient:StdioMcpClient,s:Scenario,r:ScenarioReport,runDir:string,call:ObservedCall,
  evidenceSuffix='',fixedWindow?:{stime:number;etime:number}):Promise<void> {
  r.mcpTool=call.tool; r.mcpPath=typeof call.arguments.path==='string'?call.arguments.path:null;
  r.candidate.args=call.arguments;
  if(call.error || !call.result){r.reason='MCP_TOOL_RESULT_MISSING';r.candidate.error=call.error??'Codex event lacks tool result';return;}
  Object.assign(r.candidate,await store(runDir,`${s.id}${evidenceSuffix}-candidate`,call.result));
  const classified=classifyMcpResult(call.result);
  if(classified.kind==='error'){r.reason='MCP_QUERY_FAILED';r.candidate.error=classified.error?.slice(0,800);return;}
  if(classified.kind!=='formatted'){r.reason='MCP_PERIOD_MISSING_OR_INVALID';return;}
  const text=classified.text??'';
  const parsed=parseFormattedMcp(text,[...(s.matchKeys??[]),...(s.compareFields??[])]);
  if(!parsed.ok){r.reason=parsed.reason;return;}
  const data=parsed.data;
  r.candidate.period=data.period.label;r.candidate.parsedRows=data.rows.length;
  r.candidate.comparisonPrecision='표시 수치(실수 소수점 2자리) 기준';
  r.timeWindow={stime:data.period.stime,etime:data.period.etime};
  // Verify the exact requested period BEFORE any independent HTTP call. The
  // existing Markdown Period contains seconds only; F1-B therefore refuses
  // source windows with sub-second precision rather than rounding them.
  if(fixedWindow&&(data.period.stime!==fixedWindow.stime||data.period.etime!==fixedWindow.etime)){
    r.reason='FIXED_REPLAY_PERIOD_MISMATCH';return;
  }
  const actualDuration=expectedDurationMs(String(call.arguments.timeRange??''));
  if(actualDuration!==null && data.period.etime-data.period.stime!==actualDuration){
    r.reason='MCP_PERIOD_DURATION_MISMATCH';return;
  }
  if(!authorizedPath(s,call.arguments)){r.reason='MCP_METRIC_MAPPING_UNVERIFIED';return;}
  // Candidate times must be plausible; exact API query is bound to candidate period.
  const effective={...s,stime:data.period.stime,etime:data.period.etime};
  if(!data.rows.every(row=>isWithinTimeWindow(effective,row.time))){
    r.reason='MCP_ROWS_OUTSIDE_PERIOD';return;
  }
  if(s.statisticsMode){
    // Keep the raw same-path HTTP read isolated from Codex. Compare ALL visible
    // MCP fields first; independently aggregate the complete HTTP MXQL result
    // and compare against the v2 service/exception statistics endpoint.
    const w=alignedStatsWindow(data.period.stime,data.period.etime);
    if(w.stime>=w.etime){r.reason='STATS_WINDOW_UNAVAILABLE';return;}
    const raw=await refClient.callTool('whatap_http_mxql_path',{
      projectCode:s.projectCode,stime:data.period.stime,etime:data.period.etime,path:s.mcpPath});
    const rawMeta=await store(runDir,`${s.id}${evidenceSuffix}-reference-mxql`,raw);
    r.reference.statistics={mxql:{...rawMeta},v2Window:w};
    // Preserve both evidence objects even on failed HTTP/API validation.
    const v2=await refClient.callTool(s.referenceTool,{projectCode:s.projectCode,stime:w.stime,etime:w.etime});
    Object.assign(r.reference,await store(runDir,`${s.id}${evidenceSuffix}-reference`,v2));
    const mxqlPayload=extractContent(raw),v2Payload=extractContent(v2);
    const result=analyzeStats(s,data,text,mxqlPayload,v2Payload);
    r.status=result.status;r.reason=result.reason;r.checks.push(...result.checks);
    r.reference.statistics={mxql:{...rawMeta,
      httpStatus:record(mxqlPayload)&&typeof mxqlPayload.status==='number'?mxqlPayload.status:undefined,
      rowCount:result.fullRows},v2Window:w,v2RowCount:result.v2Rows,
      comparedBuckets:result.buckets,visibleMcpRows:result.visibleRows,fullMxqlRows:result.fullRows};
    r.reference.rowCount=result.v2Rows;
    r.reference.httpStatus=record(v2Payload)&&typeof v2Payload.status==='number'?v2Payload.status:undefined;
    if(record(v2Payload)){
      const request=record(v2Payload.request)?v2Payload.request:{};
      const body=record(v2Payload.body)?v2Payload.body:{};
      r.reference.apiPath=typeof request.path==='string'?request.path:undefined;
      r.reference.total=typeof body.total==='number'?body.total:undefined;
      r.reference.retrievedTotal=typeof body.retrievedTotal==='number'?body.retrievedTotal:undefined;
    }
    r.candidate.comparisonPrecision='MCP 표시값/결측 렌더링 대조 + HTTP MXQL 전체 원본을 통한 v2 통계 집계';
    return;
  }
  const endRows=data.rows.filter(row=>row.time===data.period.etime).length;
  if(endRows)r.checks.push({code:'MCP_END_BUCKET',ok:true,
    detail:`종료 시각과 같은 ${s.expectedStepMs}ms 정렬 행 ${endRows}건을 허용. 독립 HTTP API 의 동일 식별자·값과 반드시 비교합니다`});
  const refResult=await refClient.callTool(s.referenceTool,{projectCode:s.projectCode,stime:data.period.stime,etime:data.period.etime});
  Object.assign(r.reference,await store(runDir,`${s.id}${evidenceSuffix}-reference`,refResult));
  const payload=extractContent(refResult);
  if(refResult.isError){r.reason='REFERENCE_TOOL_ERROR';r.reference.error=JSON.stringify(payload).slice(0,800);return;}
  // Full-range time-series coverage is informational here: the reference itself may have gaps.
  // Keep expectedStepMs for strict right-boundary validation, disabling only gap coverage.
  const assessment=assessReference(effective,payload,{skipStepCoverage:true});
  const request=verifyReferenceRequest(effective,payload);
  r.checks.push(...assessment.checks,request);
  const outer=record(payload)?payload:{};
  r.reference.httpStatus=typeof outer.status==='number'?outer.status:undefined;
  r.reference.rowCount=assessment.rows?.length;
  if(!assessment.complete || !request.ok || !assessment.rows){r.reason='REFERENCE_DATA_NOT_VERIFIABLY_COMPLETE';return;}
  const full=assessment.rows;
  const result=compareSubset(s,full,data.rows);
  r.status=result.status;r.reason=result.reason;r.checks.push(...result.checks);
  r.checks.push({code:'DISPLAY_COVERAGE',ok:true,detail:`표시된 ${data.rows.length}행 / HTTP API 반환 ${full.length}행 (${result.coverage}); 전체 데이터 일치 판정과 구분`});
  if(data.truncated)r.checks.push({code:'MCP_LIMIT_NOTICE',ok:true,detail:'MCP 자체 출력 제한 안내가 있음. 비교는 실제 표시된 행만 수행'});
  const summary=checkSummary(text,s,full,data.rows);r.checks.push(summary);
  if(!summary.ok){r.status='FAIL';r.reason='MCP_SUMMARY_MISMATCH';}

  // WhaTap can use bucket-end labels (stime,etime] while the HTTP reference
  // uses bucket-start labels [stime,etime) exactly on a 5-second boundary.
  // Retry ONLY if the two sets differ by the one expected pair, and every
  // shared bucket's measured values already match. Never translate row values.
  if(!fixedWindow && result.status==='FAIL' && result.reason==='MISSING_OR_EXTRA_RECORDS' &&
     isBoundaryOnlyShift(effective,full,data.rows)) {
    const original={file:r.reference.file!,sha256:r.reference.sha256!,timeWindow:{...r.timeWindow},
      httpStatus:r.reference.httpStatus,rowCount:r.reference.rowCount};
    const alignment: NonNullable<ScenarioReport['reference']['boundaryAlignment']>={original,attempts:[]};
    r.reference.boundaryAlignment=alignment;
    r.checks.push({code:'BOUNDARY_SHIFT_DETECTED',ok:true,
      detail:`HTTP 시작 버킷 ${new Date(effective.stime).toISOString()} 과 MCP 종료 버킷 ${new Date(effective.etime).toISOString()} 만 서로 다름. 공통 ${full.length-1}행의 값은 일치`});
    // +1ms normally selects the next 5-second bucket. +1000ms is a safe
    // second probe for HTTP backends that truncate input milliseconds to seconds.
    for(const deltaMs of [1,1000]) {
      const shifted={...effective,stime:effective.stime+deltaMs,etime:effective.etime+deltaMs};
      const attempt={deltaMs,timeWindow:{stime:shifted.stime,etime:shifted.etime},
        file:'',sha256:'',status:'UNVERIFIABLE' as Status,reason:'REFERENCE_TOOL_FAILED'};
      alignment.attempts.push(attempt);
      try {
        const alternative=await refClient.callTool(s.referenceTool,{
          projectCode:s.projectCode,stime:shifted.stime,etime:shifted.etime});
        const meta=await store(runDir,`${s.id}${evidenceSuffix}-reference-boundary-${deltaMs}ms`,alternative);
        attempt.file=meta.file;attempt.sha256=meta.sha256;
        if(alternative.isError){attempt.reason='REFERENCE_TOOL_ERROR';continue;}
        const alternatePayload=extractContent(alternative);
        const alternateAssessment=assessReference(shifted,alternatePayload,{skipStepCoverage:true});
        const alternateRequest=verifyReferenceRequest(shifted,alternatePayload);
        if(!alternateAssessment.complete||!alternateRequest.ok||!alternateAssessment.rows){
          attempt.reason='REFERENCE_DATA_NOT_VERIFIABLY_COMPLETE';continue;
        }
        const cmp=compareSubset(s,alternateAssessment.rows,data.rows);
        const sum=checkSummary(text,s,alternateAssessment.rows,data.rows);
        attempt.status=cmp.status;
        attempt.reason=!sum.ok?'MCP_SUMMARY_MISMATCH':cmp.reason;
        if(!sum.ok)attempt.status='FAIL';
        if(cmp.status!=='PASS'||!sum.ok)continue;
        alignment.selectedDeltaMs=deltaMs;
        r.reference.file=meta.file;r.reference.sha256=meta.sha256;
        r.reference.rowCount=alternateAssessment.rows.length;
        r.reference.httpStatus=record(alternatePayload)&&typeof alternatePayload.status==='number'?alternatePayload.status:undefined;
        r.status='PASS';r.reason='MATCHING_DATA_BOUNDARY_REALIGNED';
        // Failed initial-record checks are informative, not failed checks on
        // the selected independent HTTP evidence after a proven re-alignment.
        r.checks=r.checks.filter(c=>!['RECORD_IDENTITIES','MCP_SUMMARY','DISPLAY_COVERAGE'].includes(c.code));
        r.checks.push({code:'BOUNDARY_REALIGNED',ok:true,detail:
          `최초 HTTP ${effective.stime}~${effective.etime} 은 경계 버킷 1개 차이. 독립 보정 조회 +${deltaMs}ms (${shifted.stime}~${shifted.etime}) 에서 MCP ${data.rows.length}행 전체의 식별자·표시값·원본 요약이 일치함. 두 HTTP 응답 증거를 보관함`});
        r.checks.push(...alternateAssessment.checks,alternateRequest,...cmp.checks,sum,
          {code:'DISPLAY_COVERAGE',ok:true,detail:`표시된 ${data.rows.length}행 / 보정 HTTP API 반환 ${alternateAssessment.rows.length}행 (${cmp.coverage}); 전체 데이터 일치 판정과 구분`});
        break;
      }catch(e){attempt.reason='REFERENCE_TOOL_FAILED';
        r.checks.push({code:'BOUNDARY_RETRY_ERROR',ok:false,detail:`+${deltaMs}ms HTTP 재조회 실패: ${String(e).slice(0,200)}`});}
    }
    if(alignment.selectedDeltaMs===undefined){
      r.checks.push({code:'BOUNDARY_REALIGNED',ok:false,detail:'경계 보정 HTTP 조회로 동일 식별자·값·요약을 입증하지 못함. 최초 FAIL 유지'});
    }
  }
}

/** A single MCP call directly from Harness, with exact replay args and separate HTTP reference.
 * This path never invokes Codex. The MCP implementation itself is untrusted.
 */
async function directFixedReplay(config:HarnessConfig,options:AgentOptions,onProgress:(s:string)=>void):Promise<RunReport>{
  const s=config.scenarios.find(x=>x.id===options.scenarioId);
  if(!s||!options.fixedReplay)throw Error('Fixed replay requires one known scenario');
  const spec=options.fixedReplay,args=fixedReplayArgs(spec);
  if(Number(args.projectCode)!==s.projectCode||
     !(s.allowedMcpPaths??(s.mcpPath?[s.mcpPath]:[])).includes(spec.mcpPath))
    throw Error('Replay path/project not allowed by fixed scenario');
  const startedAt=new Date().toISOString();
  const runDir=resolve(config.outputDir,`${startedAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(join(runDir,'raw'),{recursive:true,mode:0o700});
  const r=init(s);r.mcpTool='whatap_query_data';r.mcpPath=spec.mcpPath;r.candidate.args=args;
  const audit:NonNullable<RunReport['fixedReplayAudit']>={mode:'DIRECT_MCP_TOOL_CALL',
    originalArgs:spec.originalArgs,replayArgs:args,requestedWindow:spec.window,
    schemaVerdict:'UNINSPECTED',toolCalls:0,periodMatched:false};
  const candidate=new StdioMcpClient(config.servers.candidate,config.rpcTimeoutMs);
  const reference=new StdioMcpClient(config.servers.reference,config.rpcTimeoutMs);
  try{
    await candidate.start();
    const assessment=assessWindowSchema(await candidate.listTools());
    audit.schemaVerdict=assessment.verdict;
    if(assessment.verdict!=='SCHEMA_CANDIDATE'){
      r.reason='FIXED_REPLAY_SCHEMA_NOT_SUPPORTED';
    }else{
      await reference.start();
      // Do not delegate argument selection to an LLM and never modify the candidate source.
      onProgress(`F1-B direct MCP replay ${s.id}: ${spec.window.stime}~${spec.window.etime}`);
      audit.toolCalls=1;
      const result=await candidate.callTool('whatap_query_data',args);
      await compareOne(reference,s,r,runDir,
        {server:'whatap',tool:'whatap_query_data',arguments:args,result},'',spec.window);
      audit.periodMatched=r.timeWindow.stime===spec.window.stime&&r.timeWindow.etime===spec.window.etime;
    }
  }catch(e){r.status='UNVERIFIABLE';r.reason='FIXED_REPLAY_EXECUTION_FAILED';
    r.candidate.error=scrub(String(e)).slice(0,500);
  }finally{await candidate.close().catch(()=>{});await reference.close().catch(()=>{});}
  const totals={PASS:0,FAIL:0,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0} satisfies Record<Status,number>;
  totals[r.status]++;
  const report:RunReport={harnessVersion:'0.5.0-alpha.11-f5-forensics',startedAt,finishedAt:new Date().toISOString(),
    runDir,mode:'observe-only',sourceModified:false,scenarios:[r],totals,fixedReplayAudit:audit,
    notes:['F1-B: Codex를 호출하지 않고 최초 저장된 도구 인자의 시간 범위만 stime/etime 으로 고정해 직접 재조회했습니다.',
      '동일한 MCP Period 및 HTTP 결과 검증이 실패하면 PASS 또는 수정 권한을 허용하지 않습니다.',
      '스키마 후보 판정 자체는 실제 데이터가 일치한다는 증거가 아닙니다.']};
  await writeFile(join(runDir,'report.json'),scrub(JSON.stringify(report,null,2))+'\n',{mode:0o600});
  await writeFile(join(runDir,'report.md'),scrub(makeMarkdown(report)),{mode:0o600});
  return report;
}

async function directRelativeReplay(config:HarnessConfig,options:AgentOptions,onProgress:(s:string)=>void):Promise<RunReport>{
  const s=config.scenarios.find(x=>x.id===options.scenarioId);
  if(!s||!options.relativeReplay)throw Error('Relative replay requires one known scenario');
  const spec=options.relativeReplay,args=relativeReplayArgs(spec);
  if(Number(args.projectCode)!==s.projectCode||
     !(s.allowedMcpPaths??(s.mcpPath?[s.mcpPath]:[])).includes(spec.mcpPath))
    throw Error('Relative replay query does not match allowlisted project/path');
  const startedAt=new Date().toISOString();
  const runDir=resolve(config.outputDir,`${startedAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(join(runDir,'raw'),{recursive:true,mode:0o700});
  const r=init(s);r.mcpTool='whatap_query_data';r.mcpPath=spec.mcpPath;r.candidate.args=args;
  const audit:NonNullable<RunReport['relativeReplayAudit']>={mode:'DIRECT_RELATIVE_MCP_CALL',
    originalArgs:spec.originalArgs,replayArgs:args,toolCalls:0,schemaVerified:false,periodObserved:false,observedWindow:null};
  const candidate=new StdioMcpClient(config.servers.candidate,config.rpcTimeoutMs);
  const reference=new StdioMcpClient(config.servers.reference,config.rpcTimeoutMs);
  try{
    await candidate.start();
    const tools=await candidate.listTools();
    const matches=tools.filter(t=>t.name==='whatap_query_data');
    const schema=matches[0]?.inputSchema;
    // Legacy MCP may not have absolute-time fields. The relative-time field MUST be declared.
    audit.schemaVerified=matches.length===1&&!!schema?.properties&&'timeRange' in schema.properties;
    if(!audit.schemaVerified)r.reason='RELATIVE_REPLAY_SCHEMA_NOT_SUPPORTED';
    else{
      await reference.start();
      onProgress(`F2 direct original relative MCP call ${s.id}: ${String(args.timeRange)}`);
      audit.toolCalls=1;
      const result=await candidate.callTool('whatap_query_data',args);
      await compareOne(reference,s,r,runDir,
        {server:'whatap',tool:'whatap_query_data',arguments:args,result});
      audit.periodObserved=Number.isSafeInteger(r.timeWindow.stime)&&r.timeWindow.stime>0&&
        Number.isSafeInteger(r.timeWindow.etime)&&r.timeWindow.etime>r.timeWindow.stime&&
        !!r.candidate.period;
      audit.observedWindow=audit.periodObserved?{...r.timeWindow}:null;
    }
  }catch(e){r.status='UNVERIFIABLE';r.reason='RELATIVE_REPLAY_EXECUTION_FAILED';
    r.candidate.error=scrub(String(e)).slice(0,500);
  }finally{await candidate.close().catch(()=>{});await reference.close().catch(()=>{});}
  const totals={PASS:0,FAIL:0,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0} satisfies Record<Status,number>;
  totals[r.status]++;
  const report:RunReport={harnessVersion:'0.5.0-alpha.11-f5-forensics',startedAt,finishedAt:new Date().toISOString(),
    runDir,mode:'observe-only',sourceModified:false,scenarios:[r],totals,relativeReplayAudit:audit,
    notes:['F2: Codex 없이 초기 저장된 MCP 인자를 상대시간 그대로 재호출했습니다.',
      'MCP 응답 Period 를 Unix ms 로 변환한 뒤 해당 Period 의 독립 HTTP 응답 전체를 비교했습니다.',
      '이 회차의 Period 는 이전 회차와 다를 수 있습니다. 동일 절대기간 재현 또는 같은 행의 수정 전후 비교를 주장하지 않습니다.']};
  await writeFile(join(runDir,'report.json'),scrub(JSON.stringify(report,null,2))+'\n',{mode:0o600});
  await writeFile(join(runDir,'report.md'),scrub(makeMarkdown(report)),{mode:0o600});
  return report;
}

export async function runAgentHarness(config:HarnessConfig,options:AgentOptions={},onProgress:(s:string)=>void=()=>{}):Promise<RunReport> {
  if(options.fixedReplay&&options.relativeReplay)throw Error('Select exactly one replay strategy');
  if(options.relativeReplay)return directRelativeReplay(config,options,onProgress);
  if(options.fixedReplay)return directFixedReplay(config,options,onProgress);
  const startedAt=new Date().toISOString();
  const runDir=resolve(config.outputDir,`${startedAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(join(runDir,'raw'),{recursive:true,mode:0o700});
  const list=options.scenarioId?config.scenarios.filter(s=>s.id===options.scenarioId):config.scenarios;
  if(!list.length)throw new Error(`알 수 없는 시나리오: ${options.scenarioId}`);
  if(options.requestOverride&&list.length!==1)throw new Error('--request 는 --scenario 와 함께 사용하세요');
  const reports=list.map(init);
  const refClient=new StdioMcpClient(config.servers.reference,config.rpcTimeoutMs);
  let refError='';
  try{await refClient.start();}catch(e){refError=String(e);}
  try{
    for(let i=0;i<list.length;i++){
      const s=list[i],r=reports[i];
      onProgress(`[${i+1}/${list.length}] LLM 사용자 요청: ${s.id}`);
      const prompt=promptFor(s,options.requestOverride,options.retryGuidance);
      await store(runDir,`${s.id}-user-request`,{prompt});
      let trace:CodexTrace;
      const tapFile=join(runDir,'raw',`${s.id}-mcp-tap.jsonl`);
      try{trace=await codexExec(prompt,options,config,tapFile);}catch(e){r.reason='CODEX_EXEC_FAILED';r.candidate.error=String(e);continue;}
      await store(runDir,`${s.id}-codex-events`,trace.rawJsonl,true);
      await store(runDir,`${s.id}-llm-answer`,{text:trace.finalMessage,errors:trace.errors});
      // Keep the Codex event calls for startup diagnostics even if the proxy tap
      // contains no tools/call records. Failed resource probes do not enter the tap.
      const codexEventCalls=trace.calls;
      // Prefer the transparent MCP tap: Codex JSONL may truncate large MCP responses
      // or hide native MCP calls inside generated code. Never infer from final text.
      const tapData=await readFile(tapFile,'utf8').catch(()=>null);
      if(tapData!==null){
        const tapCalls:ObservedCall[]=[];
        for(const line of tapData.split(/\r?\n/)){
          if(!line.trim())continue;
          try{const v=JSON.parse(line);if(record(v)&&record(v.request)&&record(v.response)){
            const req=v.request as Rec,res=v.response as Rec;
            const param=record(req.params)?req.params:{};
            const args=record(param.arguments)?param.arguments:{};
            tapCalls.push({server:'whatap',tool:String(param.name??''),arguments:args,
              result:record(res.result)?res.result as McpToolResult:null,
              error:res.error?JSON.stringify(res.error):undefined});
          }}catch{r.reason='MCP_TAP_INVALID';}
        }
        // tapFile already exists as an on-disk redacted original, no duplicate write.
        if(tapCalls.length>0) trace.calls=tapCalls;
      }
      if(trace.exitCode!==0){r.reason='CODEX_EXEC_FAILED';r.candidate.error=trace.errors.join('; ').slice(0,800);continue;}
      const queries=selectedQueries(trace,s);
      if(queries.length===0){
        // A failed handshake is an infrastructure failure, not an LLM choice.
        const startupError=detectMcpStartupFailure(codexEventCalls,trace.errors);
        if(startupError){
          r.status='UNVERIFIABLE';r.reason='MCP_STARTUP_FAILED';
          r.candidate.error=startupError.slice(0,1600);
          continue;
        }
        r.status=(!s.mcpPath||s.statisticsMode)?'UNMAPPED':'UNVERIFIABLE';
        r.reason=s.statisticsMode?'LLM_NO_EQUIVALENT_MCP_STAT_QUERY':'LLM_NO_MATCHING_MCP_QUERY';
        if(s.statisticsMode){
          const probes=trace.calls.filter(c=>c.server==='whatap'&&c.tool==='whatap_query_data'&&Number(c.arguments.projectCode)===s.projectCode);
          if(probes.length)r.checks.push({code:'STATS_OTHER_PATH_PROBES',ok:false,detail:`동등성이 확인된 경로 조회 없음. 다른 조회 ${probes.length}회: `+probes.map(x=>String(x.arguments.path??'')).slice(0,10).join(', ')});
        }
        continue;
      }
      if(s.statisticsMode){
        const other=trace.calls.filter(c=>c.server==='whatap'&&c.tool==='whatap_query_data'&&
          Number(c.arguments.projectCode)===s.projectCode&&!authorizedPath(s,c.arguments));
        if(other.length)r.checks.push({code:'STATS_OTHER_PATH_PROBES',ok:true,
          detail:`LLM 이 동등성 미확인/실행 불가 경로를 ${other.length}회 탐색. 이 조회들은 PASS 근거에 사용하지 않음: `+
            other.map(v=>String(v.arguments.path??'(경로 없음)')).slice(0,10).join(', ')});
      }
      const multiple=queries.length>1;
      const results:ScenarioReport[]=[];
      for(const [callIndex,call] of queries.entries()){
        // Per-call state avoids mixing different Period windows or overwriting
        // evidence when Codex makes multiple tools/call requests.
        const each=init(s);
        each.mcpTool=call.tool;
        each.mcpPath=typeof call.arguments.path==='string'?call.arguments.path:null;
        each.candidate.args=call.arguments;
        if(refError){
          each.reason='REFERENCE_MCP_UNAVAILABLE';
          each.reference.error=refError;
        }else if(!options.requestOverride && s.expectedDuration &&
          expectedDurationMs(String(call.arguments.timeRange??''))!==null &&
          expectedDurationMs(s.expectedDuration)!==expectedDurationMs(String(call.arguments.timeRange??''))){
          each.reason='LLM_SELECTED_DIFFERENT_TIME_RANGE';
        }else{
          try{
            await compareOne(refClient,s,each,runDir,call,multiple?`-call-${callIndex+1}`:'');
          }catch(e){
            each.reason='REFERENCE_TOOL_FAILED';each.reference.error=String(e).slice(0,800);
          }
        }
        results.push(each);
        if(multiple)onProgress(`  ${s.id} 호출 ${callIndex+1}/${queries.length}: ${each.status} (${reasonKo(each.reason)})`);
      }
      // Retain the historical flat schema for single-call reports. For multiple
      // calls, expose every independently checked record and preserve the final
      // observed response in the existing flat fields for older consumers.
      const last=results.at(-1)!;
      r.timeWindow=last.timeWindow;
      r.mcpTool=last.mcpTool;r.mcpPath=last.mcpPath;
      r.reference=last.reference;r.candidate=last.candidate;
      if(!multiple){
        r.status=last.status;r.reason=last.reason;r.checks=[...r.checks,...last.checks];
      }else{
        r.callResults=results.map((x,index):CallReport=>({
          index:index+1,status:x.status,reason:x.reason,mcpTool:x.mcpTool,
          mcpPath:x.mcpPath,timeWindow:x.timeWindow,checks:x.checks,
          reference:x.reference,candidate:x.candidate,
        }));
        const passes=results.filter(x=>x.status==='PASS').length;
        const failures=results.filter(x=>x.status==='FAIL').length;
        if(failures>0){r.status='FAIL';r.reason='MULTI_CALL_ANY_FAILED';}
        else if(passes===results.length){r.status='PASS';r.reason='MULTI_CALL_ALL_PASS';}
        else{r.status='UNVERIFIABLE';r.reason='MULTI_CALL_INCOMPLETE';}
        r.checks=[...r.checks,{code:'MULTI_CALL_RESULTS',ok:r.status==='PASS',
          detail:`MCP 조회 ${queries.length}회 개별 비교: PASS ${passes}회, FAIL ${failures}회, 검증 불가 ${queries.length-passes-failures}회. 각 호출의 HTTP Period 및 원본 증거는 아래에 기록` }];
      }
      if(options.diagnose && r.status==='FAIL') {
        onProgress(`  ${s.id}: 데이터 불일치 → Codex 읽기 전용 소스 진단`);
        const sourceRoot=dirname(dirname(config.servers.candidate));
        const diagnosticCall=r.callResults?.find(x=>x.status==='FAIL')??r;
        const prompt=[`다음은 WhaTap MCP 검증 중 발견한 불일치입니다.`,
          `실제 MCP 소스 디렉터리: ${sourceRoot}`,
          `시나리오: ${s.id}; MCP 함수: ${diagnosticCall.mcpTool}; 사용 인자: ${JSON.stringify(diagnosticCall.candidate.args)}`,
          `판정 이유: ${diagnosticCall.reason}; 검사 근거: ${JSON.stringify(diagnosticCall.checks)}`,
          `원본 증거: ${join(runDir,diagnosticCall.candidate.file??'')}, ${join(runDir,diagnosticCall.reference.file??'')}`,
          `복수 호출의 판정: ${JSON.stringify(r.callResults?.map(x=>({index:x.index,status:x.status,reason:x.reason})))}`,
          '실제 파일을 읽어서 소스 함수와 가능한 원인을 한국어로 설명하세요. API 데이터 지연 갱신과 경계 시간 차이도 구분하세요.',
          'MCP 코드, 설정, 파일을 수정하거나 HTTP/API 요청을 보내지 마세요. 근거 없는 원인은 추측이라고 표시하세요.',
        ].join('\n');
        try {
          const diagnostic=await codexExec(prompt,{...options,cwd:sourceRoot,timeoutMs:180000},config,
            join(runDir,'raw',`${s.id}-diagnosis-tap.jsonl`));
          const result=await store(runDir,`${s.id}-read-only-diagnosis`,{text:diagnostic.finalMessage,
            errors:diagnostic.errors,exitCode:diagnostic.exitCode});
          r.checks.push({code:'AI_DIAGNOSIS',ok:diagnostic.exitCode===0,
            detail:`진단 파일: ${result.file}; 별도 읽기 전용 분석이며 Harness 판정에 영향 없음`});
        }catch(e){r.checks.push({code:'AI_DIAGNOSIS',ok:false,detail:`진단 실패: ${String(e).slice(0,300)}`});}
      }
      onProgress(`  ${s.id}: ${r.status} (${reasonKo(r.reason)})`);
    }
  }finally{await refClient.close().catch(()=>{});}
  const totals={PASS:0,FAIL:0,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0} satisfies Record<Status,number>;
  for(const r of reports)totals[r.status]++;
  const report:RunReport={harnessVersion:'0.5.0-alpha.11-f5-forensics',startedAt,finishedAt:new Date().toISOString(),runDir,
    mode:'observe-only',sourceModified:false,scenarios:reports,totals,
    notes:['사용자 언어의 요청을 Codex LLM 에 전달했으며 MCP 시간 범위·limit·path 를 Harness 가 지정하지 않았습니다.',
      '검증의 근거는 Codex 최종 문장이 아닌 기록된 WhaTap MCP 도구 호출 인자와 원본 도구 응답입니다.',
      '기준 HTTP 조회는 MCP Period 를 사용합니다. 정확히 5초 정렬 경계의 한 버킷 차이가 확인될 때만 +1ms / +1000ms 독립 재조회로 대조하며 원본·보정 증거를 모두 남깁니다. API 경로는 사전 정의된 독립 경로를 사용합니다.',
      'MCP 가 표시한 일부 행만 맞으면 표시 행 정확도 PASS 입니다. 전체 행 검증으로 간주하지 않습니다.',
      'MCP 숫자는 표시 정밀도(소수점 둘째 자리)로, 요약 통계는 원본 수치와 동일한 계산/표시 기준으로 비교합니다.',
      '선택한 MCP 쿼리 경로의 지표 동등성을 보장할 수 없으면 PASS 를 허용하지 않습니다.',
      'APM 통계는 MCP 표시 행 전부를 동일 MXQL HTTP 원본과 대조한 뒤, HTTP 전체 MXQL 행의 5분 버킷 합계를 v2 통계와 독립 비교합니다. MCP 자체의 전체 데이터 반환을 의미하지 않습니다.',
      'Codex MCP 이벤트에서 실제 도구 응답이 누락/잘린 경우 이 Harness 는 LLM 의 설명만으로 PASS 처리하지 않습니다.',
      '동일 프로젝트 조회가 여러 번 발생하면 각 MCP 도구 호출을 독립적인 Period 로 HTTP 조회·대조합니다. 모든 호출이 PASS 여야 시나리오 전체가 PASS 이며, 하나라도 FAIL 이면 전체 FAIL 입니다.',
      '소스 수정과 AI 자동 수정은 비활성화되어 있습니다. --diagnose 옵션은 FAIL 발생 시 읽기 전용 분석만 수행합니다.'],};
  await writeFile(join(runDir,'report.json'),scrub(JSON.stringify(report,null,2))+'\n',{mode:0o600});
  await writeFile(join(runDir,'report.md'),scrub(makeMarkdown(report)),{mode:0o600});
  return report;
}
