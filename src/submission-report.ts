/**
 * Phase E Korean evidence report for PERIOD_PAIRED.
 * Original evidence is read by SHA-256; untrusted report prose never becomes a PASS.
 * Generates PUBLIC PR comments containing every compared field, split into bounded parts.
 * Do not confuse different relative observation windows with before/after the same sample.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HarnessConfig, RunReport, Scenario, ScenarioReport } from './types.js';
import type { WorkflowState, ValidationAttempt } from './workflow.js';
import { hashFile } from './workflow.js';
import { classifyMcpResult, extractContent } from './validator.js';
import { parseFormattedMcp, forMcpDisplay } from './period.js';
import { compareSubset } from './agent.js';
import { analyzeStats } from './statistics.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const clean=(v:unknown)=>{let str=String(v??'');for(const key of ['WHATAP_API_TOKEN','WHATAP_HTTP_API_TOKEN']){const secret=process.env[key];if(secret)str=str.replaceAll(secret,'[REDACTED]');}return str.replaceAll('|','\\|').replace(/\r?\n/g,' ').replace(/[<>]/g,x=>x==='<'?'&lt;':'&gt;');};
const num=(v:unknown):number|null=>{
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)&&Number.isFinite(Number(v)))return Number(v);
  return null;
};
const kst=(n:number)=>new Date(n).toLocaleString('sv-SE',{timeZone:'Asia/Seoul'}).replace(' ',' ')+ ' KST';
const keyValues=(r:Record<string,unknown>,keys:string[])=>JSON.stringify(keys.map(k=>r[k]));
const stableKey=(r:Record<string,unknown>,keys:string[])=>JSON.stringify(keys.map(k=>{
  const v=r[k];return typeof v==='number'&&Number.isFinite(v)?String(v):v;
}));
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function rowsFromPayload(x:unknown):Record<string,unknown>[]{
  const p=obj(x)?x:{};const body=p.body;
  const v=Array.isArray(body)?body:obj(body)?body.data:undefined;
  if(!Array.isArray(v)||v.some(r=>!obj(r)))throw Error('REPORT_HTTP_ROWS_NOT_AVAILABLE');
  return (v as Record<string,unknown>[]).filter(r=>!Object.hasOwn(r,'_head_'));
}
async function verifiedJson(root:string,meta:{file?:string;sha256?:string}):Promise<unknown>{
  if(!meta.file||!meta.sha256||!/^[a-f0-9]{64}$/.test(meta.sha256))throw Error('REPORT_MISSING_RAW_EVIDENCE');
  const name=resolve(root,meta.file),base=resolve(root)+sep;
  if(!name.startsWith(base))throw Error('REPORT_EVIDENCE_TRAVERSAL');
  if(await hashFile(name)!==meta.sha256)throw Error('REPORT_EVIDENCE_HASH_MISMATCH');
  return JSON.parse(await readFile(name,'utf8'));
}
async function verifiedRun(s:WorkflowState,a:ValidationAttempt):Promise<{r:ScenarioReport;root:string}>{
  if(!a.evidence||!a.evidence.reportSha256||await hashFile(join(a.evidence.runDir,'report.json'))!==a.evidence.reportSha256)
    throw Error('REPORT_MISSING_OR_TAMPERED_RUN');
  const run=JSON.parse(await readFile(join(a.evidence.runDir,'report.json'),'utf8')) as RunReport;
  if(run.scenarios?.length!==1||run.scenarios[0]?.id!==s.scenarioId||run.scenarios[0]?.status!==a.verdict)
    throw Error('REPORT_SCENARIO_OR_VERDICT_MISMATCH');
  return {r:run.scenarios[0],root:a.evidence.runDir};
}
function publicID(row:Record<string,unknown>,keys:string[]):string{
  // Never publish raw identifiers; the same key has the same pseudonym per report.
  return sha(stableKey(row,keys)).slice(0,16);
}
function value(v:unknown):string{
  if(v===undefined)return '필드 없음';if(v===null)return 'null';
  if(typeof v==='number')return Number.isFinite(v)?String(v):'비정상 숫자';
  if(typeof v==='string' && /^[-+0-9.eE]+$/.test(v))return clean(v);
  return '비수치/가림';
}
const groupKey=(mode:'transaction'|'exception',r:Record<string,unknown>,isV2:boolean):string|null=>{
  const keyNum=(v:unknown)=>{
    if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
    if(typeof v==='string'&&/^-?\d+$/.test(v))return String(BigInt(v));
    return null;
  };
  if(mode==='transaction')return keyNum(r[isV2?'serviceHash':'tx_hash']);
  const parts=[r.classHash,r.serviceHash,r[isV2?'msgHash':'msg']].map(keyNum);
  return parts.includes(null)?null:JSON.stringify(parts);
};
function aggregateLines(scenario:Scenario,mxql:Record<string,unknown>[],v2:Record<string,unknown>[],
  period:{stime:number;etime:number}):string[]{
  const mode=scenario.statisticsMode!;
  const stime=Math.ceil(period.stime/300000)*300000,etime=Math.floor(period.etime/300000)*300000;
  const fields=mode==='transaction'?[['tx_count','count',0],['tx_error','error',0],['tx_time_sum','timeSum',0.01]] as const:
    [['count','count',0]] as const;
  const sums=new Map<string,Record<string,number>>();const targets=new Map<string,Record<string,unknown>>();
  for(const row of mxql){
    const t=num(row.time);if(t===null||t%300000!==0||t<stime||t>=etime)continue;
    const k=groupKey(mode,row,false);if(k===null)throw Error('REPORT_INVALID_AGGREGATION_KEY');
    const a=sums.get(k)??{};
    for(const [source] of fields){const n=num(row[source]);if(n===null)throw Error('REPORT_INVALID_AGGREGATION_METRIC');a[source]=(a[source]??0)+n;}
    sums.set(k,a);
  }
  for(const row of v2){const k=groupKey(mode,row,true);if(k===null||targets.has(k))throw Error('REPORT_INVALID_OR_DUPLICATE_V2_KEY');targets.set(k,row);}
  const out=['| 그룹 익명 ID | 필드 | MXQL 원본 합계 | 독립 HTTP v2 | 차이(절댓값) | 결과 |','|---|---|---:|---:|---:|---|'];
  for(const k of [...new Set([...sums.keys(),...targets.keys()])].sort()){
    const a=sums.get(k),b=targets.get(k);
    for(const [src,dst,tol] of fields){
      const x=a?.[src],y=b?num(b[dst]):null,good=x!==undefined&&y!==null&&Math.abs(x-y)<=tol;
      out.push(`| ${sha(k).slice(0,16)} | ${src} | ${value(x)} | ${value(y===null?undefined:y)} | ${x===undefined||y===null?'—':value(Math.abs(x-y))} | ${good?'PASS':'FAIL'} |`);
    }
  }
  if(!sums.size||!targets.size)throw Error('REPORT_EMPTY_AGGREGATION');
  return out;
}
async function attemptRows(scenario:Scenario,r:ScenarioReport,root:string):Promise<{lines:string[];metrics:number;details:string[]}>{
  if(r.callResults?.length && r.callResults.length!==1)throw Error('REPORT_AMBIGUOUS_MCP_CALLS');
  const c=r.callResults?.[0]??r;
  const candidate=await verifiedJson(root,c.candidate);
  const ref=await verifiedJson(root,c.reference);
  const parsedTransport=classifyMcpResult(candidate as any);
  if(parsedTransport.kind!=='formatted')throw Error('REPORT_UNSUPPORTED_CANDIDATE_FORMAT');
  const keys=scenario.matchKeys??[], fields=scenario.compareFields??[];
  if(!keys.length||!fields.length)throw Error('REPORT_MISSING_COMPARISON_CONTRACT');
  const parsed=parseFormattedMcp(parsedTransport.text??'',[...keys,...fields]);
  if(!parsed.ok)throw Error('REPORT_CANDIDATE_PARSE_FAILED:'+parsed.reason);
  if(parsed.data.period.stime!==c.timeWindow.stime||parsed.data.period.etime!==c.timeWindow.etime)
    throw Error('REPORT_MCP_PERIOD_MISMATCH');
  const refPayload=extractContent(ref as any);
  const rawMxql=scenario.statisticsMode&&c.reference.statistics?.mxql ? extractContent(
    await verifiedJson(root,c.reference.statistics.mxql) as any):null;
  if(scenario.statisticsMode&&!rawMxql)throw Error('REPORT_STATS_MXQL_REQUIRED');
  const source=rowsFromPayload(rawMxql??refPayload);
  // Validate only rows actually shown by MCP. The HTTP response may contain
  // 720 rows while the MCP intentionally displays 100, both before and after
  // editing. Reuse the same comparator as the independent PERIOD_PAIRED gate.
  const cmp=compareSubset({...scenario,stime:r.timeWindow.stime,etime:r.timeWindow.etime},source,parsed.data.rows);
  // If the full report is FAIL due to an aggregation mismatch, the displayed subset can legitimately PASS.
  const check=c.checks?.find(x=>x.code==='FIELD_VALUES');
  if(check?.ok&&cmp.status!=='PASS')throw Error('REPORT_DISPLAY_DISAGREES_WITH_VALIDATOR');
  const refMap=new Map(source.map(row=>[stableKey(row,keys),row]));
  if(refMap.size!==source.length)throw Error('REPORT_REFERENCE_DUPLICATE_KEYS');
  const mcpMap=new Map(parsed.data.rows.map(row=>[stableKey(row,keys),row]));
  if(mcpMap.size!==parsed.data.rows.length)throw Error('REPORT_MCP_DUPLICATE_KEYS');
  // The detailed display comparison must not label unshown HTTP rows as MCP omissions.
  const reportKeys=[...mcpMap.keys()].sort();
  const lines=['| 시각(KST) | 레코드 익명 ID | 측정 필드 | 독립 HTTP 원본값 | MCP 표시값 | 표시 기준 HTTP 값 | 차이(표시 기준) | 판정 |',
    '|---|---|---|---:|---:|---:|---:|---|'];
  for(const k of reportKeys){
    const reference=refMap.get(k),candidateRow=mcpMap.get(k);
    for(const field of fields){
      const x=reference?.[field],y=candidateRow?.[field],rounded=reference?forMcpDisplay([reference],[field])[0][field]:undefined;
      const delta=num(y)!==null&&num(rounded)!==null?Math.abs(num(y)!-num(rounded)!):null;
      const eq=reference!==undefined&&candidateRow!==undefined&&(
        delta!==null?delta<=(scenario.absoluteTolerance??0):Object.is(y,rounded));
      const sample=candidateRow??reference!;
      lines.push(`| ${typeof sample.time==='number'?kst(sample.time):'—'} | ${publicID(sample,keys)} | ${clean(field)} | ${value(x)} | ${value(y)} | ${value(rounded)} | ${delta===null?'—':value(delta)} | ${eq?'PASS':'FAIL'} |`);
    }
  }
  if(!reportKeys.length)throw Error('REPORT_ZERO_DISPLAY_ROWS');
  const details=[];
  if(scenario.statisticsMode){
    const v2=rowsFromPayload(refPayload);
    const agg=aggregateLines(scenario,source,v2,r.timeWindow);
    details.push(`독립 집계 전수 비교: HTTP MXQL ${source.length}행, HTTP v2 ${v2.length}그룹`,...agg);
    // Re-run established validator against original evidence, do not invent aggregate conclusions.
    const analysis=analyzeStats(scenario,parsed.data,parsedTransport.text!,rawMxql,refPayload);
    if(analysis.status!==c.status)throw Error('REPORT_AGGREGATE_VERDICT_MISMATCH');
  }
  return {lines,metrics:lines.length-2,details};
}
export interface CompleteReport {title:string; body:string; parts:string[]; manifest:string; rowCount:number}
/**
 * Build output before any git side effect. Fails closed if raw evidence is missing,
 * response rows cannot be parsed or public report would be too big to publish fully.
 */
export async function buildSubmissionReport(config:HarnessConfig,s:WorkflowState,
  options:{publishMetrics:boolean}):Promise<CompleteReport>{
  if(s.preFix?.mode!=='PERIOD_PAIRED')throw Error('REPORT_ONLY_PERIOD_PAIRED');
  if(!options.publishMetrics)throw Error('PUBLIC_METRICS_CONFIRMATION_REQUIRED');
  const scenario=config.scenarios.find(x=>x.id===s.scenarioId);
  if(!scenario)throw Error('REPORT_UNKNOWN_SCENARIO');
  const taskDir=join(config.outputDir,'tasks',s.taskId);
  const analysis=JSON.parse(await readFile(join(taskDir,'analysis.json'),'utf8'));
  const edit=s.editHistory?.at(-1);
  if(!edit||edit.outcome!=='COMPLETED'||!s.preFix?.reproduced)throw Error('REPORT_NOT_VERIFIED');
  const editReport=JSON.parse(await readFile(join(taskDir,`edit-${edit.ordinal}.json`),'utf8'));
  const desc=analysis.diagnosis;
  if(!desc||!Array.isArray(desc.reproductionSteps)||!desc.reproductionSteps.length ||
    !Array.isArray(editReport.changedFiles)||!editReport.changedFiles.length)throw Error('REPORT_NO_REPRODUCTION_OR_SOURCE_DIFF');
  const attempts=(s.validationHistory??[]).filter(a=>a.evidence&&['INITIAL_VERIFY','PRE_FIX_VERIFY','FINAL_VERIFY'].includes(a.phase));
  if(!attempts.some(a=>a.phase==='PRE_FIX_VERIFY'&&a.verdict==='FAIL')||
    !attempts.some(a=>a.phase==='FINAL_VERIFY'&&a.verdict==='PASS'))throw Error('REPORT_NO_PRE_POST_DATA');
  const docs:string[]=[];let rowCount=0;
  const lines=[`# WhaTap MCP 자동 수정 및 독립 검증 — ${clean(s.scenarioId)}`,'',
    `- Harness Task: \`${s.taskId}\``,
    `- 작업 브랜치: \`agent\` / 대상: \`submission\``,
    '- 본 보고서는 Harness 가 보존한 MCP/HTTP 원본 증거를 SHA-256 으로 재검사해 생성했습니다.',
    '- **상대시간 모드의 서로 다른 Period 는 동일 행의 수정 전후 측정값이 아닙니다.** 각 시도에서만 MCP 와 독립 HTTP 를 비교합니다.',
    '', '## 현상 · 영향 · Codex 원인 가설',
    clean(desc.problem),'',clean(desc.impact),'',clean(desc.causeHypothesis),'',
    '## 소스 수정 및 근거',clean(editReport.codexClaim?.rationale??editReport.rootCauseHypothesis),'',
    '| 파일 | 수정 전 SHA-256 | 수정 후 SHA-256 |','|---|---|---|',
    ...(editReport.files??[]).map((f:any)=>`| \`${clean(f.path)}\` | \`${clean(f.before)}\` | \`${clean(f.after)}\` |`),'',
    '## 제3자 재현 절차',...(desc.reproductionSteps as string[]).map((x,i)=>`${i+1}. ${clean(x)}`),'',
    '## 회귀 테스트와 독립 검증',
    '- Phase D 는 별도의 Worktree 복사본에서 Build/Test 를 실행했고, 최종 PASS 는 두 개의 독립 상대기간에서 확인되었습니다.',
    '- 전체 코드 변경은 GitHub PR 의 **Files changed** 탭에서 확인 가능합니다.',
    '', '| 단계 | 시도 | 요청 Period (KST) | 판정 | 결과 사유 | HTTP/MCP 증거 SHA-256 |',
    '|---|---:|---|---|---|---|'];
  for(const attempt of attempts){
    const {r,root}=await verifiedRun(s,attempt);
    const w=r.timeWindow;
    lines.push(`| ${attempt.phase} | ${attempt.ordinal} | ${kst(w.stime)} ~ ${kst(w.etime)} | ${attempt.verdict} | ${clean(attempt.reason)} | \`${clean(r.reference.sha256)}\` / \`${clean(r.candidate.sha256)}\` |`);
    const parsed=await attemptRows(scenario,r,root);
    rowCount+=parsed.metrics;
    docs.push(`### ${attempt.phase} #${attempt.ordinal} (${attempt.verdict})\n\n`,
      `관찰 기간 ${kst(w.stime)} ~ ${kst(w.etime)}; 독립 비교 필드 수 ${parsed.metrics}\n\n`,
      parsed.lines.join('\n'),'\n\n',parsed.details.join('\n'),'\n\n');
  }
  if(rowCount<=0)throw Error('REPORT_EMPTY_ROW_COMPARISON');
  lines.push('',`## 실제 데이터 전수 비교 — ${rowCount}개 필드 단위 비교`,
    '각 테이블은 다른 관찰 기간을 분리해 기록하며 측정값과 판정 결과를 생략하지 않습니다.',
    '아래의 PR 댓글(연속된 보고서 파트)에 모든 비교값이 기록됩니다.','',
    '## 한계와 보안',
    '- Public 저장소이므로 아래에 게시된 수치와 시각은 공개됩니다. 원본 응답 전체와 인증정보는 게시하지 않습니다.',
    '- 내부 식별자는 결정적 익명 ID 로 치환하며, 원본 raw 증거는 접근 제한된 Ubuntu Harness 출력 디렉터리에 보존됩니다.',
    '- `UNVERIFIABLE` 또는 누락된 행은 결코 PASS 로 표현하지 않습니다.',
    '- 코드 결함 원인은 Codex 가 제안한 가설이며, 각 기간의 독립 비교 PASS 가 그 가설의 모든 인과관계를 증명하지는 않습니다.',
    '', '**사람의 코드 검토와 Merge 승인이 필요합니다.**');
  const partMax=28500;
  const content=docs.join('');
  const chunks:string[]=[];let buffer='';let header='';let separator='';
  const split=content.split('\n');
  for(let n=0;n<split.length;n++){
    const line=split[n];
    if(line.startsWith('| 시각(')||line.startsWith('| 그룹 ')){
      header=line;separator=split[n+1]??'';
    }
    if(line.length>partMax)throw Error('REPORT_SINGLE_DATA_LINE_TOO_LONG');
    if(buffer.length+line.length+1>partMax && buffer){
      chunks.push(buffer);buffer='';
      // GitHub renders each comment independently. Restore a table header after splitting rows.
      if(line.startsWith('| ')&&!line.startsWith('|---')&&line!==header&&header&&separator)
        buffer=header+'\n'+separator+'\n';
    }
    buffer+=line+'\n';
  }
  if(buffer)chunks.push(buffer);
  if(!chunks.length||chunks.length>90||content.length>2400000)throw Error('REPORT_PUBLIC_DATA_SIZE_LIMIT; needs reviewed publication plan');
  const partHashes=chunks.map(sha);
  const body=lines.join('\n')+'\n\n'+chunks.map((_,i)=>`- 데이터 파트 ${i+1}/${chunks.length}: SHA-256 \`${partHashes[i]}\``).join('\n')+'\n';
  if(body.length>60000)throw Error('REPORT_PR_BODY_TOO_LONG');
  const title=`fix(mcp): ${s.scenarioId} 독립 검증 완료 [${s.taskId}]`;
  const manifest=JSON.stringify({version:1,taskId:s.taskId,reportBodySha256:sha(body),
    partSha256:partHashes,rowCount,publicMetrics:true},null,2)+'\n';
  return {title,body,parts:chunks,manifest,rowCount};
}
