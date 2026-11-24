/** Phase D — independent final comparison of an edited MCP candidate.
 * No Codex editing, git mutations, remote submission or PASS-by-LLM-declaration.
 * An on-disk built artifact is created in an isolated staging COPY of the agent worktree.
 */
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, symlink, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { runAgentHarness } from './agent.js';
import { inspectAgentWorktree } from './phasec.js';
import { snapshotWorktree, substantiveEditCount } from './phasec2.js';
import { extractContent, assessReference } from './validator.js';
import { parseFormattedMcp } from './period.js';
import { retryDelayMs, MAX_VALIDATION_RETRIES, hashFile, writeTransition, writeWorkflowArtifact,
  type WorkflowState, type ValidationAttempt, type ValidationEvidence } from './workflow.js';
import type { HarnessConfig, RunReport, Scenario, ScenarioReport, Status } from './types.js';
import {fixedReplayFromBaseline, relativeReplayFromBaseline, replayQuerySignature, sameFixedQuery, sameRelativeQuery} from './replay.js';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const utc=()=>new Date().toISOString();
const safe=(v:unknown)=>String(v??'').replaceAll('|','\\|').replaceAll('\n',' ').slice(0,300);
const validSha=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const within=(root:string,p:string)=>{const r=relative(resolve(root),resolve(p));return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
const cleanSecret=(v:string)=>[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN]
  .filter((x):x is string=>!!x).reduce((s,k)=>s.replaceAll(k,'[REDACTED]'),v);

export type BuildCheck={ok:boolean;exitCode:number|null;stdout:string;stderr:string;durationMs:number};
export type PreparedCandidate={stageDir:string;candidate:string;build:BuildCheck;regression:BuildCheck};
export type PrepareFn=(worktree:string,taskDir:string,editOrdinal:number,attemptOrdinal:number)=>Promise<PreparedCandidate>;
export type FinalClock={now:()=>number;sleep:(ms:number)=>Promise<unknown>};
const realClock:FinalClock={now:Date.now,sleep:ms=>pause(ms)};

/** Run a local subprocess with NO service credentials or interactive prompts. */
async function localCommand(cmd:string,args:string[],cwd:string,limitMs:number):Promise<BuildCheck>{
  const started=Date.now(),env={...process.env};
  for(const k of Object.keys(env))if(/^(WHATAP_|AWS_|GH_TOKEN$|GITHUB_TOKEN$|GIT_ASKPASS$|SSH_AUTH_SOCK$)/i.test(k))delete env[k];
  env.CI='true';env.npm_config_offline='true';env.npm_config_audit='false';env.npm_config_fund='false';
  return await new Promise(resolveResult=>{
    const p=spawn(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',overLimit=false,timedOut=false,finished=false;
    const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');setTimeout(()=>p.kill('SIGKILL'),2000).unref();},limitMs);
    p.stdout.on('data',(b:Buffer)=>{stdout+=b.toString();if(stdout.length>1024*1024){stdout=stdout.slice(-1024*1024);overLimit=true;}});
    p.stderr.on('data',(b:Buffer)=>{stderr+=b.toString();if(stderr.length>1024*1024){stderr=stderr.slice(-1024*1024);overLimit=true;}});
    const done=(code:number|null,err?:string)=>{if(finished)return;finished=true;clearTimeout(timer);
      resolveResult({ok:code===0&&!timedOut&&!overLimit,exitCode:code,
        stdout:cleanSecret(stdout).slice(-12000),stderr:cleanSecret((err??'')+stderr).slice(-12000),durationMs:Date.now()-started});};
    p.once('error',e=>done(null,String(e)));
    p.once('close',c=>done(c));
  });
}
/** A non-destructive copy means generated dist/ files cannot invalidate the C2 source snapshot.
 * No dependency download is performed. Existing node_modules are LINKED, not copied;
 * this is not an OS security sandbox, so only trusted package scripts should be run.
 */
export async function stageAndTestCandidate(worktree:string,taskDir:string,editOrdinal:number,ordinal:number,runRegression=true,copyDependencies=false):Promise<PreparedCandidate>{
  const dir=await mkdtemp(join(taskDir,`final-build-${editOrdinal}-${ordinal}-`));
  const entries=await readdir(worktree,{withFileTypes:true});
  for(const e of entries){
    if(['.git','node_modules','dist'].includes(e.name)||
      (copyDependencies&&(/^\.env(?:\.|$)/.test(e.name)||['.aws','.codex','.npmrc'].includes(e.name))))continue;
    // Never dereference symlinks while staging. Unknown external links are not safe build inputs.
    if(e.isSymbolicLink())throw Error('Source contains an unsupported top-level symlink: '+e.name);
    await cp(join(worktree,e.name),join(dir,e.name),{recursive:true,force:false,dereference:false});
  }
  const deps=join(worktree,'node_modules');
  if((await stat(deps).catch(()=>null))?.isDirectory()){
    if(copyDependencies)await cp(deps,join(dir,'node_modules'),{recursive:true,verbatimSymlinks:true});
    else await symlink(deps,join(dir,'node_modules'),'dir');
  }
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8')) as {scripts?:Record<string,string>};
  if(!manifest.scripts?.build||!manifest.scripts?.test)throw Error('MCP package must define build and test scripts for Phase D');
  const build=await localCommand('npm',['run','build'],dir,180000);
  const candidate=join(dir,'dist','index.js');
  // A successful npm exit is insufficient unless a FRESH compiled entry point exists.
  if(!build.ok||!(await stat(candidate).catch(()=>null))?.isFile()){
    return {stageDir:dir,candidate,build:{...build,ok:false,stderr:build.stderr+'\nFRESH_DIST_INDEX_MISSING_OR_BUILD_FAILED'},
      regression:{ok:false,exitCode:null,stdout:'',stderr:'NOT_RUN_BUILD_FAILED',durationMs:0}};
  }
  const regression=runRegression ? await localCommand('npm',['test'],dir,300000) :
    {ok:false,exitCode:null,stdout:'',stderr:'NOT_RUN_BASELINE_BUILD',durationMs:0};
  return {stageDir:dir,candidate,build,regression};
}

function referenceCall(s:ScenarioReport){return s.callResults?.length===1?s.callResults[0]:s;}
function sig(s:ScenarioReport):string|null{
  if(s.callResults?.length && s.callResults.length!==1)return null;
  const c=referenceCall(s);
  return replayQuerySignature(c.mcpPath,c.candidate.args);
}
function originalSig(fingerprint:string):string|null{
  try{
    const o=JSON.parse(fingerprint) as {reason?:string;query?:string;mcpPath?:string;args?:unknown};
    if(typeof o.query==='string')return o.query;
    if(typeof o.mcpPath==='string'&&Array.isArray(o.args))
      return replayQuerySignature(o.mcpPath,Object.fromEntries(o.args as [string,unknown][]));
    return null;
  }catch{return null;}
}
async function evidenceJson(root:string,meta:{file?:string;sha256?:string}):Promise<unknown>{
  if(typeof meta.file!=='string'||!validSha(meta.sha256))throw Error('No candidate/HTTP original evidence SHA/file');
  const p=resolve(root,meta.file);
  if(!within(root,p))throw Error('Evidence escapes verification run directory');
  const raw=await readFile(p);
  if(createHash('sha256').update(raw).digest('hex')!==meta.sha256)throw Error('Original MCP/HTTP evidence checksum mismatch');
  return JSON.parse(raw.toString('utf8'));
}
/** Require actual, hashed original MCP+HTTP evidence even if the report itself claims PASS. */
async function originalEvidenceIntact(r:ScenarioReport,dir:string):Promise<void>{
  if(r.callResults?.length && r.callResults.length!==1)throw Error('Final run used ambiguous/multiple MCP calls');
  const c=referenceCall(r);
  if(c.status!=='PASS'&&c.status!=='FAIL')throw Error('Not a completed comparable MCP/HTTP result');
  if(c.status!==r.status)throw Error('MCP individual call result differs from aggregate report verdict');
  const candidate=await evidenceJson(dir,c.candidate);
  const reference=await evidenceJson(dir,c.reference);
  if(!candidate||!reference)throw Error('Missing source payloads');
  if(c.reference.statistics)await evidenceJson(dir,c.reference.statistics.mxql);
  if(c.reference.boundaryAlignment){
    await evidenceJson(dir,c.reference.boundaryAlignment.original);
    for(const a of c.reference.boundaryAlignment.attempts)if(a.file)await evidenceJson(dir,a);
  }
}
function attemptForEdit(s:WorkflowState):number{
  const edit=s.editHistory?.at(-1);
  if(!edit||edit.outcome!=='COMPLETED')throw Error('No completed C2 edit awaiting final verification');
  return (s.validationHistory??[]).filter(a=>a.phase==='FINAL_VERIFY'&&a.editOrdinal===edit.ordinal).length;
}
function sampleMcp(scenario:Scenario,runDir:string,sc:ScenarioReport):Promise<Array<Record<string,unknown>>> {
  return (async()=>{
    try{const value=await evidenceJson(runDir,referenceCall(sc).candidate);
      const content=extractContent(value as Parameters<typeof extractContent>[0]);
      if(typeof content!=='string')return [];
      const parsed=parseFormattedMcp(content,[...(scenario.matchKeys??[]),...(scenario.compareFields??[])]);
      if(!parsed.ok)return [];
      return parsed.data.rows;
    }catch{return [];}
  })();
}

async function sampleHttp(scenario:Scenario,runDir:string,sc:ScenarioReport):Promise<Array<Record<string,unknown>>>{
  try{
    const meta=referenceCall(sc).reference;
    const raw=await evidenceJson(runDir,meta.statistics?.mxql??meta);
    const payload=extractContent(raw as Parameters<typeof extractContent>[0]);
    const effective={...scenario,stime:sc.timeWindow.stime,etime:sc.timeWindow.etime};
    const assessment=assessReference(effective,payload,{skipStepCoverage:true});
    return assessment.complete?assessment.rows??[]:[];
  }catch{return [];}
}
async function actualDataComparison(config:HarnessConfig,s:WorkflowState,after:ScenarioReport,afterDir:string){
  const scenario=config.scenarios.find(x=>x.id===s.scenarioId);
  if(!scenario||!s.preFix?.runDir)return {comparable:false,rowsBefore:0,rowsAfter:0,changedRows:0,examples:[],note:'기준 설정 또는 수정 전 증거 없음'};
  try {
    const pre=JSON.parse(await readFile(join(s.preFix.runDir,'report.json'),'utf8')) as RunReport;
    return await compareObservedRows(scenario,pre.scenarios[0],s.preFix.runDir,after,afterDir);
  } catch {
    return {comparable:false,rowsBefore:0,rowsAfter:0,changedRows:0,examples:[],note:'수정 전후 원본 데이터 비교 중 오류'};
  }
}

export async function compareObservedRows(scenario:Scenario,before:ScenarioReport,beforeDir:string,
  after:ScenarioReport,afterDir:string):Promise<{
  comparable:boolean;rowsBefore:number;rowsAfter:number;changedRows:number;examples:Array<Record<string,unknown>>;note:string;
}>{
  try{
    if(!before || !after || before.timeWindow.stime!==after.timeWindow.stime || before.timeWindow.etime!==after.timeWindow.etime)
      return {comparable:false,rowsBefore:0,rowsAfter:0,changedRows:0,examples:[],note:'수정 전후 절대 Period 가 달라 행 단위 비교 불가'};
    const [b,a,bHttp,aHttp]=await Promise.all([
      sampleMcp(scenario,beforeDir,before),sampleMcp(scenario,afterDir,after),
      sampleHttp(scenario,beforeDir,before),sampleHttp(scenario,afterDir,after)]);
    const k=scenario.matchKeys??[],fields=scenario.compareFields??[];
    if(!k.length||!fields.length||!a.length||!b.length)
      return {comparable:false,rowsBefore:b.length,rowsAfter:a.length,changedRows:0,examples:[],note:'원본 MCP 표시 데이터 파싱 또는 비교 키 미확보'};
    const key=(row:Record<string,unknown>)=>JSON.stringify(k.map(x=>typeof row[x]==='number'?String(row[x]):row[x]));
    const bMcp=new Map(b.map(x=>[key(x),x]));
    const aMcp=new Map(a.map(x=>[key(x),x]));
    const bRef=new Map(bHttp.map(x=>[key(x),x]));
    const aRef=new Map(aHttp.map(x=>[key(x),x]));
    const diffs=[...new Set([...bMcp.keys(),...aMcp.keys()])].filter(id=>{
      const prev=bMcp.get(id), next=aMcp.get(id);
      return !prev||!next||fields.some(f=>String(prev[f])!==String(next[f]));
    });
    const values=(row:Record<string,unknown>|undefined)=>row?Object.fromEntries(fields.map(f=>[f,row[f]])):null;
    const examples=diffs.slice(0,10).map(id=>({
      key:k.map(x=>(bMcp.get(id)??aMcp.get(id))![x]),
      before:values(bMcp.get(id)),after:values(aMcp.get(id)),
      independentHttpBefore:values(bRef.get(id)),independentHttpAfter:values(aRef.get(id)),
    }));
    return {comparable:true,rowsBefore:b.length,rowsAfter:a.length,changedRows:diffs.length,examples,
      note:'MCP 표시 행 전후 및 대응 가능한 독립 HTTP 원본 값을 함께 기록. 독립 PASS 판정은 별도 검증 결과 참조'};
  }catch{return {comparable:false,rowsBefore:0,rowsAfter:0,changedRows:0,examples:[],note:'수정 전후 원본 데이터 비교 중 오류'}};
}

/** One verification attempt (not an editing attempt); caller owns the global lock. */
export async function finalVerifyAttempt(config:HarnessConfig,s:WorkflowState,
  verify:typeof runAgentHarness=runAgentHarness,prepare:PrepareFn=stageAndTestCandidate,
  clock:FinalClock=realClock):Promise<WorkflowState>{
  if(s.phase!=='FINAL_VERIFY'||s.status!=='READY')throw Error(`Not ready for final verification: ${s.phase}/${s.status}`);
  const periodPaired=s.preFix?.mode==='PERIOD_PAIRED';
  if(!s.preFix?.reproduced||(!s.preFix.sameAbsolutePeriod&&!periodPaired)||
    !s.analysis||!s.editHistory?.length)
    throw Error('C1+C2 independent editing history missing');
  const edit=s.editHistory.at(-1)!;
  if(edit.outcome!=='COMPLETED'||!edit.afterSha256)throw Error('Last source edit is not complete');
  if(s.activeEditAttempt)throw Error('Unreconciled source edit');
  const worktree=await inspectAgentWorktree(s.analysis.worktree);
  const snapshot=await snapshotWorktree(worktree.path);
  if(digest(JSON.stringify(snapshot))!==edit.afterSha256)throw Error('Worktree changed after source edit; no verification allowed');
  const taskDir=join(config.outputDir,'tasks',s.taskId);
  const preBody=await readFile(join(taskDir,'prefx-report.json'),'utf8');
  if(digest(preBody)!==s.preFix.sha256)throw Error('Pre-fix gate SHA mismatched');
  const pre=JSON.parse(preBody) as {observedFingerprint?:string;observedPeriod?:{stime:number;etime:number}};
  if(!pre.observedFingerprint||!pre.observedPeriod||!originalSig(pre.observedFingerprint))
    throw Error('Pre-fix exact query evidence unavailable');
  const original=JSON.parse(await readFile(join(s.preFix.runDir,'report.json'),'utf8')) as RunReport;
  if(await hashFile(join(s.preFix.runDir,'report.json'))!==s.preFix.reportSha256 ||
    original.scenarios.length!==1 || original.scenarios[0].status!=='FAIL')throw Error('Original pre-fix FAIL evidence invalid');
  await originalEvidenceIntact(original.scenarios[0],s.preFix.runDir);
  let replay:ReturnType<typeof fixedReplayFromBaseline>|undefined;
  let relativeReplay:ReturnType<typeof relativeReplayFromBaseline>|undefined;
  if(verify===runAgentHarness){
    if(periodPaired){
      if(original.relativeReplayAudit?.mode!=='DIRECT_RELATIVE_MCP_CALL'||
        !original.relativeReplayAudit.schemaVerified||original.relativeReplayAudit.toolCalls!==1||
        !original.relativeReplayAudit.periodObserved)
        throw Error('Pre-fix direct relative MCP audit missing; final denied');
      relativeReplay=relativeReplayFromBaseline(original.scenarios[0]);
    }else{
    const a=original.fixedReplayAudit?.originalArgs;
    if(!a||original.fixedReplayAudit?.mode!=='DIRECT_MCP_TOOL_CALL'||
      original.fixedReplayAudit.schemaVerdict!=='SCHEMA_CANDIDATE'||
      original.fixedReplayAudit.toolCalls!==1||!original.fixedReplayAudit.periodMatched)
      throw Error('Pre-fix fixed replay attestation missing; final verification denied');
    replay=fixedReplayFromBaseline({...original.scenarios[0],
      candidate:{...original.scenarios[0].candidate,args:a}});
    }
  }
  if(sig(original.scenarios[0])!==originalSig(pre.observedFingerprint)||
    original.scenarios[0].timeWindow.stime!==pre.observedPeriod.stime||
    original.scenarios[0].timeWindow.etime!==pre.observedPeriod.etime)
    throw Error('Pre-fix original report does not match the approved query fingerprint or period');
  const used=attemptForEdit(s);
  const ordinal=s.activeValidationAttempt?.phase==='FINAL_VERIFY'?s.activeValidationAttempt.ordinal:used+1;
  if(ordinal>MAX_VALIDATION_RETRIES+1)throw Error('Final validation retry budget exhausted');
  if(s.activeValidationAttempt && (s.activeValidationAttempt.phase!=='FINAL_VERIFY'||
    s.activeValidationAttempt.editOrdinal!==edit.ordinal))throw Error('Active validation belongs to another source revision');
  const startedAt=s.activeValidationAttempt?.startedAt??utc();
  let curr=await writeTransition(config.outputDir,s,{status:'RUNNING',lastError:null,nextAttemptAt:null,
    validationRetries:{...s.validationRetries,FINAL_VERIFY:ordinal-1},
    activeValidationAttempt:{phase:'FINAL_VERIFY',ordinal,editOrdinal:edit.ordinal,startedAt}},
    'FINAL_VERIFY_STARTED',`Source revision ${edit.ordinal}, independent verification ${ordinal}/4`);
  let verdict:Status='UNVERIFIABLE',reason='NO_FINAL_VERIFICATION',observed:ScenarioReport|null=null;
  let reportDir:string|null=null,reportSha:string|null=null, prepared:PreparedCandidate|null=null;
  let dataDiff:Awaited<ReturnType<typeof actualDataComparison>>|null=null;
  try{
    prepared=await prepare(worktree.path,taskDir,edit.ordinal,ordinal);
    if(!within(taskDir,prepared.stageDir)||!within(prepared.stageDir,prepared.candidate)||
      !(await stat(prepared.candidate).catch(()=>null))?.isFile() || !prepared.build.ok || !prepared.regression.ok){
      reason=!prepared.build.ok?'CANDIDATE_BUILD_FAILED':'CANDIDATE_REGRESSION_FAILED';
    }else if(digest(JSON.stringify(await snapshotWorktree(worktree.path)))!==edit.afterSha256){
      reason='SOURCE_CHANGED_DURING_FINAL_BUILD';
    }else{
      const out=await verify({...config,servers:{...config.servers,candidate:prepared.candidate}},
        {scenarioId:s.scenarioId,...(relativeReplay?{relativeReplay}:replay?{fixedReplay:replay}:{})});
      if(!out||!out.runDir)throw Error('Final independent MCP/HTTP verification returned no run directory');
      reportDir=resolve(out.runDir);reportSha=await hashFile(join(reportDir,'report.json'));
      const disk=JSON.parse(await readFile(join(reportDir,'report.json'),'utf8')) as RunReport;
      if(disk.scenarios?.length!==1||disk.scenarios[0].id!==s.scenarioId||
         JSON.stringify(disk.scenarios[0])!==JSON.stringify(out.scenarios[0]))throw Error('Final report/scenario mismatch');
      observed=disk.scenarios[0];verdict=observed.status;reason=observed.reason;
      if(verdict==='PASS'||verdict==='FAIL'){
        await originalEvidenceIntact(observed,reportDir);
        const audit=out.fixedReplayAudit;
        const relAudit=out.relativeReplayAudit;
        const fixedAttested=verify!==runAgentHarness || (periodPaired ?
          (!!relAudit&&relAudit.mode==='DIRECT_RELATIVE_MCP_CALL'&&relAudit.schemaVerified&&
           relAudit.toolCalls===1&&relAudit.periodObserved&&!!relativeReplay&&
           sameRelativeQuery(relativeReplay,observed)&&
           relAudit.observedWindow?.stime===observed.timeWindow.stime&&
           relAudit.observedWindow?.etime===observed.timeWindow.etime) :
          (!!audit&&audit.mode==='DIRECT_MCP_TOOL_CALL'&&
           audit.schemaVerdict==='SCHEMA_CANDIDATE'&&audit.toolCalls===1&&audit.periodMatched&&
           !!replay&&audit.requestedWindow.stime===replay.window.stime&&audit.requestedWindow.etime===replay.window.etime&&
           sameFixedQuery(replay,observed)));
        const sameSig=sig(observed)===originalSig(pre.observedFingerprint)&&fixedAttested;
        const samePeriod=observed.timeWindow?.stime===pre.observedPeriod.stime&&
          observed.timeWindow?.etime===pre.observedPeriod.etime;
        if(!sameSig||(!periodPaired&&!samePeriod)){verdict='UNVERIFIABLE';reason=!sameSig?'FINAL_QUERY_ARGUMENTS_CHANGED':'FINAL_ABSOLUTE_PERIOD_CHANGED';}
        else dataDiff=await actualDataComparison(config,curr,observed,reportDir);
      }
      if(digest(JSON.stringify(await snapshotWorktree(worktree.path)))!==edit.afterSha256){
        verdict='UNVERIFIABLE';reason='SOURCE_CHANGED_DURING_FINAL_VERIFY';
      }
    }
  }catch(e){verdict='UNVERIFIABLE';reason='FINAL_EXECUTION_ERROR: '+cleanSecret(String(e)).slice(0,280);}
  // A changed source invalidates ALL subsequent decisions and must stop immediately.
  if(reason==='SOURCE_CHANGED_DURING_FINAL_BUILD'||reason==='SOURCE_CHANGED_DURING_FINAL_VERIFY'){
    verdict='UNVERIFIABLE';
  }
  const editDoc=JSON.parse(await readFile(join(taskDir,`edit-${edit.ordinal}.json`),'utf8')) as {
    rootCauseHypothesis?:string;impact?:string;reproductionSteps?:string[];expectedResult?:string;actualResult?:string;
    files?:Array<{path:string;before:string|null;after:string|null}>;codexClaim?:{rationale?:string;summary?:string}|null};
  const stamp=utc(),evidence:ValidationEvidence|null=reportDir&&reportSha?
    {runDir:reportDir,reportSha256:reportSha,verdict,at:stamp}:null;
  const nextCount=(curr.validationHistory??[]).filter(a=>a.phase==='FINAL_VERIFY'&&a.editOrdinal===edit.ordinal).length;
  if(nextCount>=MAX_VALIDATION_RETRIES+1)throw Error('Invalid final history count');
  // Report artifacts are unique, immutable-by-convention; their SHA is referenced in the workflow state.
  const artifact=`final-attempt-${edit.ordinal}-${ordinal}-${randomUUID().slice(0,8)}.json`;
  const result={taskId:curr.taskId,editOrdinal:edit.ordinal,ordinal,startedAt,finishedAt:stamp,
    verdict,reason,sourceSnapshotSha256:edit.afterSha256,sourceChanged:reason.startsWith('SOURCE_CHANGED_'),
    evidenceMode:periodPaired?'PERIOD_PAIRED':'FIXED_WINDOW',
    before:{runDir:s.preFix.runDir,sha256:s.preFix.reportSha256,status:'FAIL',absolutePeriod:pre.observedPeriod,
      exactQueryFingerprint:pre.observedFingerprint},
    after:{runDir:reportDir,sha256:reportSha,status:observed?.status??null,absolutePeriod:observed?.timeWindow??null,
      exactQuerySignature:observed?sig(observed):null},
    build:prepared?{stageDir:prepared.stageDir,candidate:prepared.candidate,
      candidateSha256:await hashFile(prepared.candidate).catch(()=>null),compile:prepared.build,regression:prepared.regression}:null,
    actualDataComparison:dataDiff,
    diagnosisAndFix:{rootCauseHypothesis:editDoc.rootCauseHypothesis,impact:editDoc.impact,
      reproductionSteps:editDoc.reproductionSteps,expectedResult:editDoc.expectedResult,actualResult:editDoc.actualResult,
      changedFilesWithSha256:editDoc.files,reasonForFix:editDoc.codexClaim?.rationale},
    nextPhase:'DECIDED_BY_HARNESS',independentVerdictOnly:true};
  const body=JSON.stringify(result,null,2)+'\n';
  await writeWorkflowArtifact(config.outputDir,curr.taskId,artifact,body);
  const reportMd=`final-attempt-${edit.ordinal}-${ordinal}-${basename(artifact,'.json').split('-').at(-1)}.md`;
  const md=[`# Phase D 수정 후 독립 검증 — ${curr.taskId}`,'',
    `- 실제 수정 시도: ${substantiveEditCount(curr.editHistory)}/3, 감사 로그 시도: ${edit.ordinal}, 최종 검증: ${ordinal}/4`,
    `- 독립 판정: **${verdict}**, 근거: ${safe(reason)}`,
    `- 수정 전 상태: FAIL, 원본 SHA: ${s.preFix.reportSha256}`,
    `- 수정 후 상태 (원본 보고): ${observed?.status??'미실행'}, 원본 SHA: ${reportSha??'미확보'}`,
    `- 검증 정책: ${periodPaired?'PERIOD_PAIRED (서로 다른 기간, 직접 행 비교 불가)':'FIXED_WINDOW'}`,
    `- 동일 조회 조건: ${observed?String(sig(observed)===originalSig(pre.observedFingerprint)):'미확인'}`,
    `- 동일 절대 기간: ${observed?String(observed.timeWindow.stime===pre.observedPeriod.stime&&observed.timeWindow.etime===pre.observedPeriod.etime):'미확인'}`,
    `- 소스 Snapshot SHA: ${edit.afterSha256}`,
    `- 빌드: ${prepared?.build.ok?'PASS':'미완료/실패'}`,`- 대상 MCP 회귀: ${prepared?.regression.ok?'PASS':'미완료/실패'}`,'',
    '## 수정 전/후 실제 데이터 비교',
    dataDiff?.comparable?`- 표시 행: 수정 전 ${dataDiff.rowsBefore}개 / 수정 후 ${dataDiff.rowsAfter}개 / 변화 감지 ${dataDiff.changedRows}개`:
      `- 비교 보류: ${dataDiff?.note??'실제 MCP/HTTP 결과가 완전히 확보되지 않음'}`,
    ...(dataDiff?.examples??[]).map(x=>`- ${safe(JSON.stringify(x))}`),'',
    '## 독립 HTTP 및 MCP 원본 증거',`- 수정 전: ${s.preFix.runDir}`,
    `- 수정 후: ${reportDir??'미확보'}`,
    `- 검증 시도 JSON: ${artifact}`,
    `- 변경 파일: ${edit.changedFiles.join(', ')||'없음'}`,'',
    '## 원인 및 영향',
    editDoc.rootCauseHypothesis??'미확보','',editDoc.impact??'미확보','',
    '## 수정 근거',editDoc.codexClaim?.rationale??'Codex 수정 사유 미확보','',
    '## 변경 파일 및 수정 전후 SHA-256',
    ...(editDoc.files??[]).map(x=>`- ${safe(x.path)}: 이전 ${safe(x.before)}, 이후 ${safe(x.after)}`),'',
    '## 제3자 재현 절차',...(editDoc.reproductionSteps??[]).map((x,i)=>`${i+1}. ${x}`),'',
    '## 검증 범위 및 재현',
    periodPaired?'1. 최초 상대시간 인자 그대로 MCP 를 재조회하고, 각 응답 Period 의 독립 HTTP 를 비교한다 (전후 동일 기간 아님).':
      '1. 동일 scenario, MCP 도구 경로/전체 인자, 동일 절대 Period 로 조회한다.',
    '2. 모든 MCP 표시 값과 동일 HTTP 경로 원본의 결과를 Harness 가 독립 대조한다.',
    '3. 소스 수정 전/후 SHA, MCP 원본 및 HTTP 원본 증거 해시를 확인한다.',
    '4. npm build/test 는 원본 Worktree 가 아닌 보존된 별도 staging 복사본에서 실행한다.',
    '',`**이 문서의 독립 판정은 ${verdict}이며, Git Commit/Push/PR 을 승인하거나 실행하지 않는다.**`].join('\n')+'\n';
  await writeWorkflowArtifact(config.outputDir,curr.taskId,reportMd,md);
  const attempt:ValidationAttempt={phase:'FINAL_VERIFY',editOrdinal:edit.ordinal,ordinal,startedAt,finishedAt:stamp,
    verdict,reason,evidence,timeWindow:observed?.timeWindow??null,artifactName:artifact,artifactSha256:digest(body)};
  const history=[...(curr.validationHistory??[]),attempt];
  const common={validationHistory:history,activeValidationAttempt:null,
    ...(evidence?{latestValidation:evidence}:{})};
  // Relative-only MCP cannot replay historical buckets. Require 2 clean FINAL PASS runs
  // with distinct observed periods before allowing a Git submission state.
  const previousFinal=(curr.validationHistory??[]).filter(a=>a.phase==='FINAL_VERIFY'&&a.editOrdinal===edit.ordinal).at(-1);
  const confirmedPairedPass=!periodPaired || (!!previousFinal&&previousFinal.verdict==='PASS'&&
    !!previousFinal.evidence&&previousFinal.timeWindow?.stime!==undefined&&
    (previousFinal.timeWindow.stime!==observed?.timeWindow.stime||
      previousFinal.timeWindow.etime!==observed?.timeWindow.etime));
  if(verdict==='PASS'&&evidence&&prepared?.build.ok&&prepared.regression.ok&&confirmedPairedPass){
    return writeTransition(config.outputDir,curr,{...common,phase:'COMMITTING',status:'PAUSED',lastError:'FINAL_VERIFY_PASS_PENDING_PHASE_E'},
      'FINAL_VERIFY_PASS','Independent MCP/HTTP and regression passed; Git submission remains disabled until Phase E');
  }
  if(periodPaired&&verdict==='PASS'&&!confirmedPairedPass&&ordinal<=MAX_VALIDATION_RETRIES){
    const wait=retryDelayMs(ordinal-1);
    return writeTransition(config.outputDir,curr,{...common,status:'WAITING_RETRY',
      nextAttemptAt:new Date(clock.now()+wait).toISOString(),lastError:'PERIOD_PAIRED_SECOND_FINAL_PASS_REQUIRED'},
      'FINAL_VERIFY_CONFIRMATION_SCHEDULED',`Second independently passed relative period required after ${wait}ms`);
  }
  // If the source changes unexpectedly, never retry blindly: manual intervention required.
  if(reason.startsWith('SOURCE_CHANGED_'))return writeTransition(config.outputDir,curr,{...common,status:'BLOCKED',lastError:reason},
    'FINAL_VERIFY_SOURCE_CHANGED','Source was altered during independent test; no automatic verification or editing');
  if((verdict==='FAIL'||verdict==='UNVERIFIABLE')&&ordinal<=MAX_VALIDATION_RETRIES){
    const delay=retryDelayMs(ordinal-1);
    return writeTransition(config.outputDir,curr,{...common,status:'WAITING_RETRY',
      nextAttemptAt:new Date(clock.now()+delay).toISOString(),lastError:`${verdict}:${reason}`},
      'FINAL_VERIFY_RETRY_SCHEDULED',`No PASS; retry independent check after ${delay}ms`);
  }
  if(verdict==='FAIL'&&evidence){
    const edits=substantiveEditCount(curr.editHistory);
    if(edits<3)return writeTransition(config.outputDir,curr,{...common,phase:'MODIFYING',status:'PAUSED',nextAttemptAt:null,
      lastError:'FINAL_VERIFY_CONFIRMED_FAIL'},'FINAL_VERIFY_FAIL_CONFIRMED',
      periodPaired?'Same original query shape still fails in new relative period; edit retry may be requested':
      'Same query and absolute period still FAIL; separate Codex edit retry may be requested');
    return writeTransition(config.outputDir,curr,{...common,status:'BLOCKED',nextAttemptAt:null,
      lastError:'FINAL_VERIFY_FAIL_FIX_BUDGET_EXHAUSTED'},'FINAL_VERIFY_FAIL_BLOCKED','No remaining Codex edit budget');
  }
  return writeTransition(config.outputDir,curr,{...common,status:'BLOCKED',nextAttemptAt:null,
    lastError:verdict==='UNVERIFIABLE'?'FINAL_VERIFY_UNVERIFIABLE_EXHAUSTED':`FINAL_VERIFY_${verdict}_NOT_RETRYABLE`},
    'FINAL_VERIFY_BLOCKED','Final independent PASS not established; no source-edit authorization');
}

export async function finalVerifyCycle(config:HarnessConfig,s:WorkflowState,
  verify:typeof runAgentHarness=runAgentHarness,clock:FinalClock=realClock,
  noWait=false,prepare:PrepareFn=stageAndTestCandidate):Promise<WorkflowState>{
  let curr=s;
  for(;;){
    if(curr.phase!=='FINAL_VERIFY')return curr;
    if(curr.status==='RUNNING')curr=await writeTransition(config.outputDir,curr,
      {status:'READY',lastError:'INTERRUPTED_FINAL_VERIFY'},'FINAL_VERIFY_RECOVERED',
      'Incomplete validation never implies PASS; reuse reserved ordinal');
    if(curr.status==='WAITING_RETRY'){
      if(!curr.nextAttemptAt)throw Error('Missing final retry deadline');
      const remaining=Math.max(0,Date.parse(curr.nextAttemptAt)-clock.now());
      if(noWait&&remaining>0)return curr;
      if(remaining>0)await clock.sleep(remaining);
      if(clock.now()<Date.parse(curr.nextAttemptAt))throw Error('Final retry deadline not reached');
      curr=await writeTransition(config.outputDir,curr,{status:'READY',nextAttemptAt:null},
        'FINAL_VERIFY_RETRY_DUE','Retrying same source revision');
    }
    if(curr.status!=='READY')return curr;
    curr=await finalVerifyAttempt(config,curr,verify,prepare,clock);
    if(noWait)return curr;
  }
}

export async function phaseDEvidenceIntact(config:HarnessConfig,s:WorkflowState):Promise<boolean>{
  try{
    for(const a of s.validationHistory??[]){
      if(a.phase!=='FINAL_VERIFY')continue;
      if(!a.artifactName||!validSha(a.artifactSha256))return false;
      const matched=/^final-attempt-([1-6])-([1-4])-([0-9a-f]{8})\.json$/.exec(a.artifactName);
      if(!matched || Number(matched[1])!==a.editOrdinal || Number(matched[2])!==a.ordinal ||
        !(s.editHistory??[]).some(e=>e.ordinal===a.editOrdinal&&e.outcome==='COMPLETED'))return false;
      const p=join(config.outputDir,'tasks',s.taskId,a.artifactName);
      if(await hashFile(p)!==a.artifactSha256)return false;
    }
    return true;
  }catch{return false;}
}
