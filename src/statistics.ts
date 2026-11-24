/** APM statistics: candidate display → same-MXQL HTTP data → independent v2 aggregates.
 * No code assumes that a 100-row MCP display is a complete one-hour query.
 */
import type { Check, Scenario, Status } from './types.js';
import type { FormattedMcpData } from './period.js';
import type { JsonRow } from './validator.js';
import { assessReference, verifyReferenceRequest, compareRows } from './validator.js';
import { forMcpDisplay } from './period.js';
import { compareSubset, checkSummary } from './agent.js';

export const FIVE_MIN = 300000;
export interface StatsOutcome {
  status: Status;
  reason: string;
  checks: Check[];
  visibleRows: number;
  fullRows: number;
  v2Rows: number;
  v2Window: {stime:number;etime:number};
  buckets: number;
}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):number|null=>{
  if(typeof v!=='number'&&typeof v!=='string')return null;
  if(typeof v==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))return null;
  const n=Number(v);return Number.isFinite(n)?n:null;
};
const normalHash=(v:unknown):string|null=>{
  if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
  if(typeof v==='string'&&/^-?\d+$/.test(v))return String(BigInt(v));
  return null;
};
export function alignedStatsWindow(stime:number,etime:number) {
  return {stime:Math.ceil(stime/FIVE_MIN)*FIVE_MIN,etime:Math.floor(etime/FIVE_MIN)*FIVE_MIN};
}
export function verifyMxqlRequest(s:Scenario, payload:unknown, period:{stime:number;etime:number}):Check {
  const r=obj(payload)?payload:{};
  const q=obj(r.request)?r.request:{};
  const p=obj(q.payload)?q.payload:{};
  const expected=`/${s.mcpPath?.replace(/^\/?mxql\//,'').replace(/^\//,'')??''}`;
  const ok=r.ok===true&&r.status===200&&q.method==='POST'&&q.path==='/open-mcp/api/flush/mxql/path'&&
    q.projectCode===s.projectCode&&p.stime===period.stime&&p.etime===period.etime&&p.mql===expected&&
    !Object.hasOwn(p,'limit')&&!Object.hasOwn(p,'param')&&!Object.hasOwn(p,'inject');
  return {code:'STATS_MXQL_REQUEST',ok,detail:ok?`동일 MXQL 경로 ${expected}, 기간·프로젝트 확인, limit/param/inject 없음`:
    `동일 MXQL HTTP 요청 조건 불일치 (경로=${String(q.path)}, mql=${String(p.mql)}, 프로젝트=${String(q.projectCode)})`};
}
export function verifyStatsV2Request(s:Scenario, payload:unknown, w:{stime:number;etime:number}):Check {
  return verifyReferenceRequest({...s,stime:w.stime,etime:w.etime},payload);
}
function readRaw(s:Scenario, payload:unknown, period:{stime:number;etime:number}):{checks:Check[],rows:JsonRow[]|null} {
  const assessment=assessReference({...s,stime:period.stime,etime:period.etime},payload,{skipStepCoverage:true});
  const request=verifyMxqlRequest(s,payload,period);
  return {checks:[...assessment.checks,request],rows:assessment.complete&&request.ok?assessment.rows:null};
}
function readV2(s:Scenario, payload:unknown, w:{stime:number;etime:number}):{checks:Check[],rows:JsonRow[]|null}{
  const r=obj(payload)?payload:{};const b=obj(r.body)?r.body:{};
  const rows=Array.isArray(b.data)?b.data:null;
  const total=finite(b.total), retrieved=finite(b.retrievedTotal);
  const valid=r.ok===true&&r.status===200&&rows!==null&&rows.every(obj)&&
    total!==null&&retrieved!==null&&Number.isSafeInteger(total)&&total===retrieved&&retrieved===rows.length;
  const req=verifyStatsV2Request(s,payload,w);
  return {checks:[{code:'STATS_V2_COMPLETE',ok:valid,
    detail:`HTTP ${String(r.status)}; 전체 ${String(b.total)} / 반환 ${String(b.retrievedTotal)} / 배열 ${rows?.length??'없음'}건`},req],
    rows:valid&&req.ok?rows as JsonRow[]:null};
}
function fail(status:Status,reason:string,checks:Check[],parsed:FormattedMcpData,full:number,v2:number,w:{stime:number;etime:number}):StatsOutcome{
  return {status,reason,checks,visibleRows:parsed.rows.length,fullRows:full,v2Rows:v2,v2Window:w,
    buckets:Math.max(0,(w.etime-w.stime)/FIVE_MIN)};
}
/** Complete visible-row fidelity (including every displayed field and dash/null transport). */
function compareDisplay(s:Scenario,parsed:FormattedMcpData,full:JsonRow[]): {status:Status;reason:string;checks:Check[];coverage:string}{
  const keys=s.matchKeys??[];
  if(!keys.length||parsed.columns.some(k=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(k)) ||
      !keys.every(k=>parsed.columns.includes(k))) {
    return {status:'UNVERIFIABLE',reason:'STATS_DISPLAY_COLUMNS_INVALID',checks:[],coverage:'unknown'};
  }
  const fields=parsed.columns.filter(f=>!keys.includes(f));
  const converted=forMcpDisplay(full,fields).map((row)=>{
    const out={...row};
    for(const f of fields){if(row[f]===undefined||row[f]===null)out[f]='-';}
    return out;
  });
  // Don't allow comparing a tiny subset with fewer columns than the MCP actually prints.
  const cmp=compareSubset({...s,matchKeys:keys,compareFields:fields},converted,parsed.rows);
  return cmp;
}
const key=(parts:Array<string|null>)=>parts.some(v=>v===null)?null:JSON.stringify(parts);
const expectedFields=(mode:NonNullable<Scenario['statisticsMode']>)=>mode==='transaction'
  ? ([['tx_count','count',0],['tx_error','error',0],['tx_time_sum','timeSum',0.01]] as const)
  : ([['count','count',0]] as const);
function groupKey(mode:'transaction'|'exception',r:JsonRow,fromV2:boolean):string|null {
  return mode==='transaction'?normalHash(r[fromV2?'serviceHash':'tx_hash']):
    key([normalHash(r.classHash),normalHash(r.serviceHash),normalHash(r[fromV2?'msgHash':'msg'])]);
}
function compareAggregate(mode:'transaction'|'exception',rows:JsonRow[],v2:JsonRow[],w:{stime:number;etime:number}) {
  const cols=expectedFields(mode);
  const a=new Map<string,Record<string,number>>();const b=new Map<string,Record<string,number>>();
  const buckets=new Set<number>();let invalidRaw=0,invalidV2=0,dupV2=0,invalidWindow=0;
  for(const r of rows){
    const t=finite(r.time);
    if(t===null || t%FIVE_MIN!==0){invalidWindow++;continue;}
    if(t<w.stime||t>=w.etime)continue;
    buckets.add(t);
    const k=groupKey(mode,r,false);
    if(k===null){invalidRaw++;continue;}
    let x=a.get(k);if(!x){x={};for(const [src] of cols)x[src]=0;a.set(k,x);}
    for(const [src] of cols){const n=finite(r[src]);if(n===null){invalidRaw++;break;}x[src]+=n;}
  }
  for(const r of v2){
    const k=groupKey(mode,r,true);
    if(k===null){invalidV2++;continue;}
    if(b.has(k)) {dupV2++;continue;}
    const x:Record<string,number>={};let valid=true;
    for(const [src,dst] of cols){const n=finite(r[dst]);if(n===null){valid=false;break;}x[src]=n;}
    if(!valid){invalidV2++;continue;}
    b.set(k,x);
  }
  const expectedCount=(w.etime-w.stime)/FIVE_MIN;
  const completeBuckets=Number.isInteger(expectedCount)&&expectedCount>0&&buckets.size===expectedCount&&
    [...buckets].every(t=>t>=w.stime&&t<w.etime);
  const badInputs=invalidRaw>0||invalidV2>0||dupV2>0||invalidWindow>0||!completeBuckets;
  let missingA=0,missingB=0,different=0,matching=0;
  const examples:string[]=[];
  for(const [k,one] of a){
    const other=b.get(k);
    if(!other){missingB++;continue;}
    let same=true;
    for(const [src,,tolerance] of cols){
      if(!Number.isFinite(one[src])||!Number.isFinite(other[src])||Math.abs(one[src]-other[src])>tolerance){same=false;break;}
    }
    if(same) matching++;
    else {different++;if(examples.length<3)examples.push(`집계 해시 ${k.slice(0,20)}: 수치 불일치`);}
  }
  for(const k of b.keys())if(!a.has(k))missingA++;
  const ok=!badInputs&&missingA===0&&missingB===0&&different===0&&matching>0;
  // F6: the visible MCP rows and summary have already passed the independent
  // same-MXQL transport comparison. Divergence between two HTTP reference APIs
  // therefore cannot authorize a change to MCP source code.
  const verdict:Status=badInputs?'UNVERIFIABLE':ok?'PASS':'UNVERIFIABLE';
  const reason=badInputs?'STATS_AGGREGATE_INCOMPLETE':ok?'STATS_AGGREGATE_MATCH':'REFERENCE_INCONSISTENCY';
  const check:Check={code:'STATS_AGGREGATE',ok,detail:
    `5분 버킷 ${buckets.size}/${expectedCount}; 그룹 MXQL=${a.size}, v2=${b.size}; 일치=${matching}, 값 차이=${different}, MXQL 누락=${missingA}, v2 누락=${missingB}; 유효하지 않은 원본=${invalidRaw}, v2=${invalidV2}, 중복=${dupV2}, 시각=${invalidWindow}`+
     (examples.length?`; 예시: ${examples.join('; ')}`:'')};
  return {verdict,reason,check,bucketCount:buckets.size};
}
/** Pure validator; also used by offline replay with SHA-authenticated saved responses. */
export function analyzeStats(s:Scenario,parsed:FormattedMcpData,rawText:string,mxqlPayload:unknown,v2Payload:unknown):StatsOutcome{
  const w=alignedStatsWindow(parsed.period.stime,parsed.period.etime);
  const checks:Check[]=[];
  const mode=s.statisticsMode;
  if(!mode || !s.mcpPath || w.stime>=w.etime){return fail('UNVERIFIABLE','STATS_WINDOW_UNAVAILABLE',checks,parsed,0,0,w);}
  const raw=readRaw(s,mxqlPayload,parsed.period);
  checks.push(...raw.checks);
  if(!raw.rows)return fail('UNVERIFIABLE','STATS_MXQL_REFERENCE_INCOMPLETE',checks,parsed,0,0,w);
  const visible=compareDisplay(s,parsed,raw.rows);
  checks.push(...visible.checks);
  checks.push({code:'STATS_MCP_COVERAGE',ok:true,
    detail:`MCP 표시 ${parsed.rows.length}/${raw.rows.length}행. 제한 알림=${parsed.truncated}. 이 검증은 표시 행 전부에 대한 정확성만 보장`});
  const summary=checkSummary(rawText,{...s,compareFields:parsed.columns},raw.rows,parsed.rows);checks.push(summary);
  if(visible.status!=='PASS')return fail(visible.status,visible.reason,checks,parsed,raw.rows.length,0,w);
  if(!summary.ok)return fail('FAIL','MCP_SUMMARY_MISMATCH',checks,parsed,raw.rows.length,0,w);
  const v2=readV2(s,v2Payload,w);checks.push(...v2.checks);
  if(!v2.rows)return fail('UNVERIFIABLE','STATS_V2_REFERENCE_INCOMPLETE',checks,parsed,raw.rows.length,0,w);
  const aggregate=compareAggregate(mode,raw.rows,v2.rows,w);checks.push(aggregate.check);
  return {...fail(aggregate.verdict,aggregate.reason,checks,parsed,raw.rows.length,v2.rows.length,w),buckets:aggregate.bucketCount};
}

/** F5 read-only investigation: retains actual per-key totals and MXQL bucket contributions.
 * The v2 endpoint returns full-window aggregates; bucketContributions are NOT v2
 * bucket measurements. This function does not grant PASS or code-edit permissions. */
export interface StatsForensicGroup {
  key:string;
  status:'MATCH'|'VALUE_DIFFERENCE'|'MISSING_IN_V2'|'MISSING_IN_MXQL';
  mxql:Record<string,number>|null;
  v2:Record<string,number>|null;
  delta:Record<string,number|null>;
  mxqlBucketContributions:Array<{bucketStartMs:number;rawRowCount:number;values:Record<string,number>}>;
}
export interface StatsForensicResult {
  mode:'transaction'|'exception';
  timeWindow:{stime:number;etime:number};
  bucketCount:number;expectedBuckets:number;
  mxqlRows:number;v2Rows:number;
  mxqlGroups:number;v2Groups:number;
  matching:number;different:number;missingV2:number;missingMxql:number;
  invalidRaw:number;invalidV2:number;duplicateV2:number;invalidTime:number;
  reliable:boolean;
  allGroups:StatsForensicGroup[];
}
export function forensicStatsGroups(mode:'transaction'|'exception', rawRows:JsonRow[], v2Rows:JsonRow[], w:{stime:number;etime:number}):StatsForensicResult {
  const fields=expectedFields(mode);
  const makeZero=()=>Object.fromEntries(fields.map(([src])=>[src,0])) as Record<string,number>;
  const raw=new Map<string,Record<string,number>>();
  const byBucket=new Map<string,Map<number,{rawRowCount:number;values:Record<string,number>}>>();
  const v2=new Map<string,Record<string,number>>();
  const bucketSet=new Set<number>();
  let invalidRaw=0,invalidV2=0,duplicateV2=0,invalidTime=0;
  for(const r of rawRows){
    const t=finite(r.time);
    if(t===null||t%FIVE_MIN!==0){invalidTime++;continue;}
    if(t<w.stime||t>=w.etime)continue;
    bucketSet.add(t);
    const k=groupKey(mode,r,false);
    if(k===null){invalidRaw++;continue;}
    const additions:Record<string,number>={};let valid=true;
    for(const [src] of fields){const n=finite(r[src]);if(n===null){valid=false;break;}additions[src]=n;}
    if(!valid){invalidRaw++;continue;}
    if(!raw.has(k))raw.set(k,makeZero());
    const totals=raw.get(k)!;
    for(const [src] of fields)totals[src]+=additions[src];
    if(!byBucket.has(k))byBucket.set(k,new Map());
    const buckets=byBucket.get(k)!;
    if(!buckets.has(t))buckets.set(t,{rawRowCount:0,values:makeZero()});
    const bucket=buckets.get(t)!;bucket.rawRowCount++;
    for(const [src] of fields)bucket.values[src]+=additions[src];
  }
  for(const r of v2Rows){
    const k=groupKey(mode,r,true);
    if(k===null){invalidV2++;continue;}
    if(v2.has(k)){duplicateV2++;continue;}
    const vals:Record<string,number>={};let valid=true;
    for(const [src,dst] of fields){const n=finite(r[dst]);if(n===null){valid=false;break;}vals[src]=n;}
    if(!valid){invalidV2++;continue;}
    v2.set(k,vals);
  }
  const expectedBuckets=(w.etime-w.stime)/FIVE_MIN;
  const allKeys=[...new Set([...raw.keys(),...v2.keys()])].sort();
  let matching=0,different=0,missingV2=0,missingMxql=0;
  const allGroups:StatsForensicGroup[]=allKeys.map(k=>{
    const a=raw.get(k)??null,b=v2.get(k)??null;
    let status:StatsForensicGroup['status'];
    if(!a){missingMxql++;status='MISSING_IN_MXQL';}
    else if(!b){missingV2++;status='MISSING_IN_V2';}
    else if(fields.some(([src,,tol])=>!Number.isFinite(a[src])||!Number.isFinite(b[src])||Math.abs(a[src]-b[src])>tol)){
      different++;status='VALUE_DIFFERENCE';
    }else{matching++;status='MATCH';}
    const deltas=Object.fromEntries(fields.map(([src])=>[src,a&&b?a[src]-b[src]:null]));
    const contrib=status==='MATCH'?[]:[...(byBucket.get(k)??new Map()).entries()]
      .sort(([t1],[t2])=>t1-t2)
      .map(([bucketStartMs,v])=>({bucketStartMs,rawRowCount:v.rawRowCount,values:v.values}));
    return {key:k,status,mxql:a,v2:b,delta:deltas,mxqlBucketContributions:contrib};
  });
  const reliable=Number.isSafeInteger(expectedBuckets)&&expectedBuckets>0&&
    bucketSet.size===expectedBuckets&&invalidRaw===0&&invalidV2===0&&duplicateV2===0&&invalidTime===0;
  return {mode,timeWindow:{...w},bucketCount:bucketSet.size,expectedBuckets,
    mxqlRows:rawRows.length,v2Rows:v2Rows.length,mxqlGroups:raw.size,v2Groups:v2.size,
    matching,different,missingV2,missingMxql,invalidRaw,invalidV2,duplicateV2,invalidTime,
    reliable,allGroups};
}
