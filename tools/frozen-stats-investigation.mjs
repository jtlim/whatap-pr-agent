/** F5 postmortem: read-only, same absolute HTTP period, NO candidate MCP replay.
 * Every fresh HTTP response and CSV is saved with SHA-256. HTTP convergence is
 * not proof that an earlier failure was caused by a particular component. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {StdioMcpClient} from '../dist/mcp.js';
import {extractContent,assessReference,verifyReferenceRequest} from '../dist/validator.js';
import {verifyMxqlRequest,alignedStatsWindow,forensicStatsGroups,FIVE_MIN} from '../dist/statistics.js';
import {hashFile} from '../dist/workflow.js';
const sha=data=>createHash('sha256').update(data).digest('hex');
const obj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validWindow=w=>w&&Number.isSafeInteger(w.stime)&&w.stime>0&&Number.isSafeInteger(w.etime)&&w.etime>w.stime&&w.etime<=8640000000000000;
function redact(s){let out=String(s);for(const v of [process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN,process.env.GH_TOKEN,process.env.GITHUB_TOKEN].filter(Boolean))out=out.replaceAll(v,'[REDACTED]');return out;}
function checkFilePath(base,name){
  if(typeof name!=='string'||!/^raw\/[a-zA-Z0-9._-]+\.json$/.test(name))throw Error('Unsupported raw evidence path');
  const absolute=resolve(base,name),rel=relative(resolve(base),absolute);
  if(rel.startsWith('..')||rel.startsWith('/'))throw Error('Evidence path escapes original run');
  return absolute;
}
async function verifiedRaw(base,meta){
  if(!obj(meta)||typeof meta.sha256!=='string'||!/^([a-f0-9]{64})$/.test(meta.sha256))throw Error('Missing stored HTTP evidence SHA-256');
  const file=checkFilePath(base,meta.file);
  if(await hashFile(file)!==meta.sha256)throw Error('Archived HTTP evidence SHA mismatch');
  return JSON.parse(await readFile(file,'utf8'));
}
function readVerifiedV2(s,w,rpc){
  if(rpc?.isError)throw Error('HTTP v2 tool returned isError');
  const v2=extractContent(rpc);
  const req=verifyReferenceRequest({...s,stime:w.stime,etime:w.etime},v2);
  const body=obj(v2)&&obj(v2.body)?v2.body:null;
  const rows=body&&Array.isArray(body.data)?body.data:null;
  const complete=obj(v2)&&v2.ok===true&&v2.status===200&&rows&&rows.every(obj)&&
    Number.isSafeInteger(body.total)&&Number.isSafeInteger(body.retrievedTotal)&&
    body.total===body.retrievedTotal&&body.total===rows.length;
  if(!req.ok||!complete)throw Error('HTTP v2 request/completeness mismatch');
  return rows;
}
function validatedHttpPair(s,period,rawRpc,v2Rpc){
  const w=alignedStatsWindow(period.stime,period.etime);
  if(!validWindow(period)||w.stime>=w.etime)throw Error('Invalid fixed diagnostic period');
  if(rawRpc?.isError||v2Rpc?.isError)throw Error('Independent HTTP MCP tool returned isError');
  const raw=extractContent(rawRpc);
  const rawReq=verifyMxqlRequest(s,raw,period);
  const rawAssess=assessReference({...s,stime:period.stime,etime:period.etime},raw,{skipStepCoverage:true});
  if(!rawReq.ok||!rawAssess.complete||!rawAssess.rows)throw Error('HTTP MXQL request/completeness mismatch');
  const arr=readVerifiedV2(s,w,v2Rpc);
  const diag=forensicStatsGroups(s.statisticsMode,rawAssess.rows,arr,w);
  if(!diag.reliable)throw Error('Full HTTP group/bucket evidence incomplete');
  return {diag,rawRows:rawAssess.rows,window:w};
}
function csvCell(v){const t=String(v??'');return /[\r\n",]/.test(t)?'"'+t.replaceAll('"','""')+'"':t;}
const csvLine=cols=>cols.map(csvCell).join(',')+'\n';
async function evidenceWrite(root,file,value,json=true){
  const text=redact(json?JSON.stringify(value,null,2)+'\n':String(value));
  const full=join(root,file);await writeFile(full,text,{flag:'wx',mode:0o600});
  return {file,sha256:sha(text),bytes:Buffer.byteLength(text)};
}
function compact(d,groupFile=null){
  return {window:d.timeWindow,mxqlRows:d.mxqlRows,v2Rows:d.v2Rows,mxqlGroups:d.mxqlGroups,v2Groups:d.v2Groups,
    bucketCount:d.bucketCount,expectedBuckets:d.expectedBuckets,matching:d.matching,
    different:d.different,missingV2:d.missingV2,missingMxql:d.missingMxql,reliable:d.reliable,
    ...(groupFile?{groupFile}:{}),
    examples:d.allGroups.filter(g=>g.status!=='MATCH').slice(0,12).map(g=>({key:g.key,status:g.status,mxql:g.mxql,v2:g.v2,delta:g.delta}))};
}
async function writeGroupCsv(root,index,diag){
  const file=`groups-${index}.csv`,fields=diag.mode==='transaction'?['tx_count','tx_error','tx_time_sum']:['count'];
  let text=csvLine(['groupKey','status','metric','MXQL_full_window','HTTP_v2_full_window','MXQL_minus_v2','MXQL_bucket_contributions_json']);
  for(const group of diag.allGroups){
    const buckets=group.status==='MATCH'?'':JSON.stringify(group.mxqlBucketContributions);
    for(const field of fields)text+=csvLine([group.key,group.status,field,group.mxql?.[field],group.v2?.[field],group.delta?.[field],buckets]);
  }
  return evidenceWrite(root,file,text,false);
}
/** @returns {Promise<object>} independent diagnostic, never a PASS/edit authorizer */
export async function investigateRecoveredStats({scenario,firstFail,taskId,outputDir,referenceEntry,
  clientFactory=(entry,timeout)=>new StdioMcpClient(entry,timeout),timeoutMs=180000,
  snapshots=2,delayMs=1000,maxBucketProbes=11}={}){
  if(!scenario?.statisticsMode||!['transaction','exception'].includes(scenario.statisticsMode))
    return {status:'NOT_APPLICABLE',reason:'Not an APM statistics scenario'};
  const run=firstFail?.evidence?.runDir;
  if(!run||!firstFail?.evidence?.verified)throw Error('Original failed report has not been SHA-256 verified');
  const verifiedReportSha=firstFail.evidence.resultSha256;
  if(typeof verifiedReportSha!=='string'||!(/^[a-f0-9]{64}$/).test(verifiedReportSha)||
    await hashFile(join(run,'report.json'))!==verifiedReportSha)
    throw Error('Original FAIL report SHA mismatch before HTTP forensics');
  const oldReport=JSON.parse(await readFile(join(run,'report.json'),'utf8'));
  const old=oldReport.scenarios?.[0];
  const period=old?.timeWindow;
  if(old?.id!==scenario.id||
    !((old.status==='FAIL'&&old.reason==='STATS_AGGREGATE_DIFFERENCE')||
      (old.status==='UNVERIFIABLE'&&old.reason==='REFERENCE_INCONSISTENCY'))||
    old.callResults?.length||old.mcpTool!=='whatap_query_data'||!validWindow(period)||
    old.mcpPath!==scenario.mcpPath||old.candidate?.args?.path!==scenario.mcpPath||
    old.candidate.args.projectCode!==scenario.projectCode||
    !(/^\d+[smhdw]$/.test(String(old.candidate.args.timeRange??''))))
    return {status:'NOT_APPLICABLE',reason:'Saved FAIL cannot be anchored to one verified statistical MCP call'};
  if(!Number.isInteger(snapshots)||snapshots<1||snapshots>3||
    !Number.isInteger(maxBucketProbes)||maxBucketProbes<0||maxBucketProbes>12||
    !Number.isInteger(delayMs)||delayMs<0||delayMs>30000)throw Error('Out-of-policy fixed-window diagnostics budget');
  const root=join(resolve(outputDir),'campaign','investigations',`${taskId}-${randomUUID().slice(0,8)}`);
  await mkdir(root,{recursive:true,mode:0o700});
  const record={version:1,status:'IN_PROGRESS',scenarioId:scenario.id,taskId,
    originalPeriod:{...period},statisticsWindow:alignedStatsWindow(period.stime,period.etime),
    createdAt:new Date().toISOString(),scope:'INDEPENDENT_HTTP_ONLY_NO_MCP_REPLAY',
    sourceReport:{file:join(run,'report.json'),sha256:firstFail.evidence.resultSha256},
    snapshots:[],bucketProbes:[],limitations:[
      'MCP 자체는 최초 실패 기간으로 재호출하지 않음. 기존 상대시간 MCP 에는 명시적 절대기간 입력이 없음.',
      '후속 HTTP 재조회 결과는 최초 데이터 불일치의 원인이나 소스 수정 필요성을 자동으로 증명하지 않음.',
      'MXQL 5분 버킷 기여값과 v2 구간 전체 집계는 서로 다른 단위. 개별 v2 버킷은 별도 조회로만 측정.',
    ]};
  const saveManifest=async()=>{await writeFile(join(root,'manifest.json'),redact(JSON.stringify(record,null,2))+'\n',{mode:0o600});};
  let client;
  try{
    const storedRaw=await verifiedRaw(run,old.reference?.statistics?.mxql);
    const storedV2=await verifiedRaw(run,old.reference);
    const initial=validatedHttpPair(scenario,period,storedRaw,storedV2);
    record.initial={...compact(initial.diag),mxqlEvidence:old.reference.statistics.mxql,
      v2Evidence:{file:old.reference.file,sha256:old.reference.sha256},
      originalVerdict:old.status,originalReason:old.reason};
    record.initial.groupCsv=await writeGroupCsv(root,'initial',initial.diag);
    client=clientFactory(referenceEntry,timeoutMs);await client.start();
    let latest=null;
    for(let i=1;i<=snapshots;i++){
      if(i>1&&delayMs)await delay(delayMs);
      const sample={index:i,at:new Date().toISOString(),window:{...period},status:'UNVERIFIABLE'};
      record.snapshots.push(sample);
      try{
        const rawRpc=await client.callTool('whatap_http_mxql_path',{
          projectCode:scenario.projectCode,stime:period.stime,etime:period.etime,path:scenario.mcpPath});
        sample.mxqlEvidence=await evidenceWrite(root,`snapshot-${i}-mxql.json`,rawRpc);
        const aligned=alignedStatsWindow(period.stime,period.etime);
        const v2Rpc=await client.callTool(scenario.referenceTool,{
          projectCode:scenario.projectCode,stime:aligned.stime,etime:aligned.etime});
        sample.v2Evidence=await evidenceWrite(root,`snapshot-${i}-v2.json`,v2Rpc);
        const x=validatedHttpPair(scenario,period,rawRpc,v2Rpc);
        sample.status=x.diag.different||x.diag.missingV2||x.diag.missingMxql?'DIFFERENCE':'MATCH';
        sample.counts=compact(x.diag);
        sample.groupCsv=await writeGroupCsv(root,`snapshot-${i}`,x.diag);
        latest=x;
      }catch(e){sample.error=redact(String(e)).slice(0,750);}
    }
    if(latest&&maxBucketProbes){
      const w=latest.window;
      const bucketCount=(w.etime-w.stime)/FIVE_MIN;
      const probes=Math.min(bucketCount,maxBucketProbes);
      for(let i=0;i<probes;i++){
        const segment={stime:w.stime+i*FIVE_MIN,etime:w.stime+(i+1)*FIVE_MIN};
        const entry={window:segment,status:'UNVERIFIABLE'};
        record.bucketProbes.push(entry);
        try{
          const rpc=await client.callTool(scenario.referenceTool,{
            projectCode:scenario.projectCode,stime:segment.stime,etime:segment.etime});
          entry.httpEvidence=await evidenceWrite(root,`bucket-${i+1}-v2.json`,rpc);
          // For a bucket the MXQL reference rows come from the last verified full-window HTTP response.
          // The single-bucket v2 call is separately validated; original mismatched rows are NOT reused.
          const v2rows=readVerifiedV2(scenario,segment,rpc);
          const rawBucketRows=latest.rawRows.filter(r=>Number(r.time)===segment.stime);
          const diag=forensicStatsGroups(scenario.statisticsMode,rawBucketRows,v2rows,segment);
          if(!diag.reliable)throw Error('Bucket MXQL contributions unavailable or malformed');
          // Source MXQL is the last verified full-window HTTP response, not a fabricated 5-minute HTTP request.
          entry.mxqlSource='LAST_VERIFIED_FULL_WINDOW_SNAPSHOT';
          entry.status=diag.different||diag.missingV2||diag.missingMxql?'DIFFERENCE':'MATCH';
          entry.counts=compact(diag);
          entry.groupCsv=await writeGroupCsv(root,`bucket-${i+1}`,diag);
        }catch(e){entry.error=redact(String(e)).slice(0,750);}
      }
      if(probes<bucketCount)record.limitations.push(`버킷 상세 조회 ${probes}/${bucketCount}개; 나머지는 검증하지 않음.`);
    }
    record.status=record.snapshots.some(x=>x.status!=='UNVERIFIABLE')?'COMPLETED':'UNVERIFIABLE';
  }catch(e){
    // Cryptographic mismatch is a hard integrity error: let caller stop rather than
    // presenting a partial forensics document as a trusted result.
    if(/SHA mismatch/.test(String(e)))throw e;
    record.status='UNVERIFIABLE';record.error=redact(String(e)).slice(0,900);
  }finally{
    if(client)await client.close().catch(()=>{});
    record.finishedAt=new Date().toISOString();await saveManifest();
  }
  const manifestPath=join(root,'manifest.json');
  const manifestSha256=await hashFile(manifestPath);
  // Check every generated raw response/CSV after manifest persistence. A partial
  // or modified artifact may be mentioned, but never asserted as verified data.
  for(const meta of [record.initial?.groupCsv,
    ...record.snapshots.flatMap(x=>[x.mxqlEvidence,x.v2Evidence,x.groupCsv]),
    ...record.bucketProbes.flatMap(x=>[x.httpEvidence,x.groupCsv])].filter(Boolean)){
    const file=meta.file;
    if(typeof file!=='string'||!/^[a-z0-9-]+\.(?:csv|json)$/.test(file)||
      await hashFile(join(root,file))!==meta.sha256)
      throw Error('Generated frozen evidence SHA mismatch');
  }
  return {status:record.status,reason:record.error??null,manifestPath,manifestSha256,
    initial:record.initial??null,snapshots:record.snapshots,bucketProbes:record.bucketProbes,
    limitations:record.limitations};
}
