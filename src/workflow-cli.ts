/** Durable Harness workflow phases A/B/C1/C2/D/E. */
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { inspectConfig } from './runner.js';
import { runAgentHarness } from './agent.js';
import {relativeReplayArgs,type RelativeReplay} from './replay.js';
import {readFile} from 'node:fs/promises';
import { analyzeTask, preFixCycle, phaseCEvidenceIntact } from './phasec.js';
import { modifyTask, reconcileInterruptedEdit, phaseC2EvidenceIntact } from './phasec2.js';
import { finalVerifyCycle, phaseDEvidenceIntact } from './phased.js';
import { submitTask,reconcileSubmission,recordHumanMerge,phaseEEvidenceIntact } from './phasee.js';
import type { HarnessConfig, Status } from './types.js';
import {
  withWorkflowLock,createTask,readTask,listTasks,writeTransition,recoverTask,closeTask,
  hashFile,evidenceExists,writeWorkflowArtifact,MAX_VALIDATION_RETRIES,retryDelayMs,type WorkflowState,type ValidationAttempt,
} from './workflow.js';

function flag(rest:string[],name:string):string|undefined {
  const at=rest.indexOf(name);
  if(at<0)return undefined;
  const v=rest[at+1];
  if(!v||v.startsWith('--'))throw new Error(`Missing value for ${name}`);
  return v;
}
const active=(s:WorkflowState)=>!['COMPLETED','CANCELLED'].includes(s.status);
function display(s:WorkflowState, verbose=false):void {
  console.log(`TASK ${s.taskId}  ${s.phase}/${s.status}  scenario=${s.scenarioId}`);
  console.log(`  branches=${s.workBranch} -> ${s.baseBranch}  sequence=${s.sequence}`);
  console.log(`  validationRetries=${JSON.stringify(s.validationRetries)}  fixRetries=${s.fixRetries}`);
  if(s.latestValidation)console.log(`  latestValidation=${s.latestValidation.verdict} report=${join(s.latestValidation.runDir,'report.json')}`);
  if(s.submission?.prUrl)console.log(`  review PR: ${s.submission.prUrl}`);
  if(s.lastError)console.log(`  lastError=${s.lastError}`);
  if(s.nextAttemptAt)console.log(`  nextAttemptAt=${s.nextAttemptAt}`);
  if(verbose)console.log(JSON.stringify(s,null,2));
}
async function available(config:HarnessConfig):Promise<void> {
  const issues=(await inspectConfig(config)).filter(c=>!c.ok);
  if(issues.length)throw new Error('Verification preflight failed: '+issues.map(c=>`${c.item} (${c.note})`).join(', '));
}
function scrub(message:string):string {
  const secrets=[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN].filter((v):v is string=>!!v);
  return secrets.reduce((v,k)=>v.replaceAll(k,'[REDACTED]'),message).slice(0,400);
}
export interface RetryClock { now:()=>number; sleep:(ms:number)=>Promise<unknown> }
const realClock:RetryClock={now:Date.now,sleep:ms=>pause(ms)};

/** F5: a previous verified MCP query is more reliable than asking Codex to
 * rediscover a path on every retry. Historical JSON and the original arguments
 * must match the stored SHA and scenario allowlist; never infer from LLM prose.
 * The original relative timeRange is preserved, NOT converted into an absolute MCP query. */
export async function priorVerifiedRelativeQuery(config:HarnessConfig,s:WorkflowState):Promise<RelativeReplay|null>{
  const scenario=config.scenarios.find(x=>x.id===s.scenarioId);
  if(!scenario)return null;
  const accepted=scenario.allowedMcpPaths??(scenario.mcpPath?[scenario.mcpPath]:[]);
  for(const attempt of [...(s.validationHistory??[])].reverse()){
    if(attempt.phase!=='INITIAL_VERIFY'||!['FAIL','PASS','UNVERIFIABLE'].includes(String(attempt.verdict??''))||
      !attempt.evidence?.reportSha256)continue;
    const reportPath=join(attempt.evidence.runDir,'report.json');
    if(await hashFile(reportPath)!==attempt.evidence.reportSha256)
      throw Error('Historical query evidence hash mismatch; cannot reuse tool arguments');
    const report=JSON.parse(await readFile(reportPath,'utf8'));
    const r=report.scenarios?.[0];
    const a=r?.candidate?.args,p=r?.mcpPath;
    if(r?.id!==scenario.id||r?.mcpTool!=='whatap_query_data'||r?.callResults?.length||
      !accepted.includes(String(p??''))||!a||typeof a!=='object'||Array.isArray(a)||
      a.projectCode!==scenario.projectCode||a.path!==p||
      !Number.isSafeInteger(r.timeWindow?.stime)||r.timeWindow.stime<=0||
      !Number.isSafeInteger(r.timeWindow?.etime)||r.timeWindow.etime<=r.timeWindow.stime)continue;
    const replay={originalArgs:a as Record<string,unknown>,mcpPath:p as string};
    try{relativeReplayArgs(replay);return replay;}catch{continue;}
  }
  return null;
}

/** Persist one evidence-bearing attempt; schedule retries without touching fixRetries. */
export async function initialVerify(
  config:HarnessConfig,s:WorkflowState,verifyFn:typeof runAgentHarness=runAgentHarness,clock:RetryClock=realClock,
):Promise<WorkflowState> {
  if(s.phase!=='INITIAL_VERIFY'||s.status!=='READY')throw new Error(`Not ready for initial verification: ${s.phase}/${s.status}`);
  await available(config);
  const existing=s.activeValidationAttempt;
  if(existing && existing.phase!=='INITIAL_VERIFY')throw new Error('In-flight verification phase mismatch');
  // A killed process can resume the same ordinal, rather than consuming a retry twice.
  const ordinal=existing?.ordinal??(s.validationHistory?.length??0)+1;
  if(ordinal>MAX_VALIDATION_RETRIES+1)throw new Error('Verification retry budget exhausted');
  const startedAt=existing?.startedAt??new Date(clock.now()).toISOString();
  const retries={...s.validationRetries,INITIAL_VERIFY:Math.max(s.validationRetries.INITIAL_VERIFY,ordinal-1)};
  let curr=await writeTransition(config.outputDir,s,{
    status:'RUNNING',lastError:null,nextAttemptAt:null,validationRetries:retries,
    activeValidationAttempt:{phase:'INITIAL_VERIFY',ordinal,startedAt},
  },'VERIFY_ATTEMPT_STARTED',`검증 ${ordinal}/${MAX_VALIDATION_RETRIES+1}; 재시도 ${ordinal-1}/${MAX_VALIDATION_RETRIES}`);
  let verdict:Status='UNVERIFIABLE';
  let reason='UNKNOWN';
  let evidence:WorkflowState['latestValidation']=null;
  let timeWindow:ValidationAttempt['timeWindow']=null;
  try {
    const scenario=config.scenarios.find(x=>x.id===curr.scenarioId);
    const priorUnmapped=(curr.validationHistory??[]).filter(x=>x.phase==='INITIAL_VERIFY'&&x.verdict==='UNMAPPED');
    // The first attempt remains fully agent-selected. If and ONLY IF it failed to map,
    // allow a bounded second attempt grounded in the trusted scenario's allowlist.
    // A prompted path is NOT sufficient for PASS: MCP response + same-Period HTTP must still agree.
    const approved=scenario?.allowedMcpPaths??(scenario?.mcpPath?[scenario.mcpPath]:[]);
    const retryGuidance=priorUnmapped.length&&approved.length
      ? `이전에 시도한 경로는 이 시나리오의 데이터 동등성이 확인되지 않았습니다. 검증 기준의 후보 MXQL 경로: ${approved.join(', ')}. 실제 whatap_query_data 도구로 경로와 projectCode ${scenario!.projectCode} 및 최근 1시간 구간을 조회하세요. 호출 성공과 반환 Period 를 확인하세요. 이 힌트는 API 데이터 일치나 MCP 기능 지원을 보장하지 않습니다.`
      : undefined;
    const anchored=ordinal>1?await priorVerifiedRelativeQuery(config,curr):null;
    if(anchored)console.log(`F5: 이전 SHA 검증 MCP 호출의 경로/인자를 그대로 재사용합니다 (${curr.scenarioId}); 반환 Period 는 새로 독립 검증`);
    const report=await verifyFn(config,{scenarioId:curr.scenarioId,
      ...(anchored?{relativeReplay:anchored}:retryGuidance?{retryGuidance}:{})},msg=>console.log(msg));
    verdict=report.scenarios[0]?.status??'UNVERIFIABLE';
    reason=report.scenarios[0]?.reason??'NO_SCENARIO_RESULT';
    const w=report.scenarios[0]?.timeWindow;
    if(w && Number.isFinite(w.stime) && Number.isFinite(w.etime) && w.stime>0 && w.etime>w.stime)
      timeWindow={stime:w.stime,etime:w.etime};
    evidence={runDir:resolve(report.runDir),reportSha256:await hashFile(join(report.runDir,'report.json')),
      verdict,at:new Date(clock.now()).toISOString()};
    console.log(`검증 보고서: ${join(report.runDir,'report.md')}`);
  } catch(e) {
    reason=`EXECUTION_ERROR: ${scrub(String(e instanceof Error?e.message:e))}`;
    console.error(`검증 실행 불가: ${reason}`);
  }
  const history:ValidationAttempt[]=[...(curr.validationHistory??[]),{
    phase:'INITIAL_VERIFY',ordinal,startedAt,finishedAt:new Date(clock.now()).toISOString(),verdict,reason,evidence,timeWindow,
  }];
  const common={validationHistory:history,activeValidationAttempt:null,
    ...(evidence?{latestValidation:evidence}:{})};
  if(verdict==='PASS' && evidence) {
    curr=await writeTransition(config.outputDir,curr,{...common,phase:'DONE',status:'COMPLETED',nextAttemptAt:null,lastError:null},
      'INITIAL_VERIFY_PASS',`검증 ${ordinal}번째 PASS; 독립 검증 성공`);
  } else if((verdict==='FAIL'||verdict==='UNVERIFIABLE'||(verdict==='UNMAPPED'&&ordinal<=2)) && ordinal<=MAX_VALIDATION_RETRIES) {
    // Mapping failures are query-planning errors, not backend data consistency delays.
    // One guided retry is enough to resolve a mistaken LLM path without a long sleep.
    const delay=verdict==='UNMAPPED'?1000:retryDelayMs(ordinal-1);
    const nextAttemptAt=new Date(clock.now()+delay).toISOString();
    curr=await writeTransition(config.outputDir,curr,{...common,status:'WAITING_RETRY',nextAttemptAt,
      lastError:`${verdict}:${reason}`},'VALIDATION_RETRY_SCHEDULED',
      `${verdict}; ${delay/1000}초 후 재검증 (다음 ${ordinal+1}/${MAX_VALIDATION_RETRIES+1}); 원래 UNMAPPED 증거 보존`);
  } else if(verdict==='FAIL') {
    curr=await writeTransition(config.outputDir,curr,{...common,phase:'ANALYZING',status:'PAUSED',nextAttemptAt:null,
      lastError:'FAIL_RETRIES_EXHAUSTED_REQUIRES_ANALYSIS'},'VALIDATION_FAIL_EXHAUSTED',
      '총 4회 FAIL/UNVERIFIABLE 시도 후 마지막 FAIL. Codex 분석은 Phase C에서 연결; 자동 수정 없음');
  } else {
    curr=await writeTransition(config.outputDir,curr,{...common,status:'BLOCKED',nextAttemptAt:null,
      lastError:verdict==='UNVERIFIABLE'?'UNVERIFIABLE_RETRIES_EXHAUSTED':`${verdict}_NOT_RETRYABLE`},
      'VALIDATION_BLOCKED',`검증 판정=${verdict}; 코드 자동 수정 금지`);
  }
  if(curr.status==='BLOCKED'||curr.status==='PAUSED') {
    const summary={taskId:curr.taskId,scenarioId:curr.scenarioId,phase:curr.phase,status:curr.status,
      lastError:curr.lastError,validationRetries:curr.validationRetries,fixRetries:curr.fixRetries,
      attempts:curr.validationHistory??[],note:'AI 코드 수정 미실행; 원본 증거는 각 runDir 내에 보관'};
    await writeWorkflowArtifact(config.outputDir,curr.taskId,'retry-report.json',JSON.stringify(summary,null,2)+'\n');
    const lines=[`# 검증 재시도 종료 보고 — ${curr.taskId}`,'',`- 상태: ${curr.phase}/${curr.status}`,
      `- 사유: ${curr.lastError}`,'- Codex 자동 수정: 미실행','',
      '| 시도 | 결과 | 관찰 기간 (UTC ms) | 이유 | 증거 SHA-256 |','|---:|---|---|---|---|',
      ...(curr.validationHistory??[]).map(a=>`| ${a.ordinal} | ${a.verdict??'UNKNOWN'} | ${a.timeWindow?`${a.timeWindow.stime}~${a.timeWindow.etime}`:'미확보'} | ${(a.reason??'').replaceAll('|','\\|').replaceAll('\n',' ')} | ${a.evidence?.reportSha256??'없음'} |`),'',
      '검증 증거는 별도 실행 디렉터리에 저장됩니다. 이 보고서만으로 원인 코드가 확정된 것은 아닙니다.',
      '상대 시간 범위를 사용한 재시도는 관찰 시간창이 달라질 수 있으며 동일 레코드의 재현으로 단정하지 않습니다.'];
    await writeWorkflowArtifact(config.outputDir,curr.taskId,'retry-report.md',lines.join('\n')+'\n');
  }
  if(evidence)console.log(`증거 무결성: ${await evidenceExists(curr)?'OK':'FAILED'}`);
  return curr;
}

/** Verify all prior evidence when recovering across process restarts. */
export async function validationHistoryIntact(s:WorkflowState):Promise<boolean> {
  for (const a of s.validationHistory??[]) {
    if(!a.evidence)continue; // failed to obtain a complete report, never implies PASS
    try {if(await hashFile(join(a.evidence.runDir,'report.json'))!==a.evidence.reportSha256)return false;}
    catch{return false;}
  }
  return true;
}

/** Automated 30/60/120s backoff; waiting deadline and attempt count are durable. */
export async function runValidationCycle(
  config:HarnessConfig,s:WorkflowState,verifyFn:typeof runAgentHarness=runAgentHarness,
  clock:RetryClock=realClock,noWait=false,
):Promise<WorkflowState> {
  let curr=s;
  for(;;) {
    if(curr.phase!=='INITIAL_VERIFY')return curr;
    if(curr.status==='RUNNING'){
      curr=await recoverTask(config.outputDir,curr);
      console.log('중단된 검증 시도를 재개합니다. 이미 예약된 재시도 횟수는 중복 차감하지 않습니다.');
    }
    if(curr.status==='WAITING_RETRY'){
      if(!curr.nextAttemptAt)throw new Error('Corrupt retry checkpoint: missing deadline');
      const waitMs=Math.max(0,Date.parse(curr.nextAttemptAt)-clock.now());
      if(noWait && waitMs>0) return curr;
      if(waitMs>0){console.log(`재검증 예약 시각 ${curr.nextAttemptAt}; ${waitMs}ms 대기`);await clock.sleep(waitMs);}
      if(clock.now()<Date.parse(curr.nextAttemptAt)){
        if(noWait)return curr;
        throw new Error('Retry clock did not advance to scheduled deadline');
      }
      curr=await writeTransition(config.outputDir,curr,{status:'READY',nextAttemptAt:null},
        'VALIDATION_RETRY_DUE','예약된 재검증 재개');
    }
    if(curr.status!=='READY')return curr;
    curr=await initialVerify(config,curr,verifyFn,clock);
    if(noWait)return curr;
  }
}

export async function workflowCommand(config:HarnessConfig,rest:string[]):Promise<void> {
  process.umask(0o077);
  const [action,...args]=rest;
  if(!['start','status','resume','verify','close','analyze','precheck','modify','reconcile-edit','finalcheck','submit','reconcile-submit','mark-merged'].includes(action??''))
    throw new Error('Usage: task start --scenario ID [--no-run] [--no-wait] | status [--task ID] | resume --task ID [--no-wait] | verify --task ID [--no-wait] | analyze --task ID --worktree PATH | precheck --task ID | modify --task ID | finalcheck --task ID [--no-wait] | reconcile-edit --task ID --ack-partial | submit --task ID --dry-run|--confirm-submit | reconcile-submit --task ID --ack-external | mark-merged --task ID --ack-merged | close --task ID');
  const taskId=flag(args,'--task');
  if(action==='status'){
    if(taskId){display(await readTask(config.outputDir,taskId),args.includes('--json'));return;}
    const states=await listTasks(config.outputDir);
    if(!states.length){console.log('저장된 작업 없음');return;}
    display(states.find(active)??states[0],args.includes('--json'));
    return;
  }
  await withWorkflowLock(config.outputDir,async()=>{
    if(action==='start'){
      const scenarioId=flag(args,'--scenario');
      if(!scenarioId||!config.scenarios.some(s=>s.id===scenarioId))throw new Error('Unknown/missing --scenario ID');
      let task=await createTask(config.outputDir,scenarioId);
      console.log(`작업 생성: ${task.taskId} (${join(config.outputDir,'tasks',task.taskId)})`);
      if(!args.includes('--no-run'))task=await runValidationCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait'));
      display(task);return;
    }
    if(!taskId)throw new Error(`--task ID is required for ${action}`);
    let task=await readTask(config.outputDir,taskId,true);
    if((task.latestValidation && !(await evidenceExists(task)))||!(await validationHistoryIntact(task))||!(await phaseCEvidenceIntact(config,task))||!(await phaseC2EvidenceIntact(config,task))||!(await phaseDEvidenceIntact(config,task))||!(await phaseEEvidenceIntact(config,task)))
      throw new Error('Saved validation evidence hash mismatch/missing; refusing to resume task');
    if(action==='submit'){
      if(args.includes('--dry-run')===args.includes('--confirm-submit'))throw Error('Choose exactly one of --dry-run or --confirm-submit');
      task=await submitTask(config,task,undefined,args.includes('--dry-run'));
      if(args.includes('--dry-run'))console.log('[OK] Local read-only submission preflight; no commit, push, PR, or remote calls');
      display(task);return;
    }
    if(action==='reconcile-submit'){
      if(!args.includes('--ack-external'))throw Error('Explicit --ack-external required after checking Git/PR side effects');
      task=await reconcileSubmission(config,task);display(task);return;
    }
    if(action==='mark-merged'){
      if(!args.includes('--ack-merged'))throw Error('Explicit --ack-merged required after human PR merge');
      task=await recordHumanMerge(config,task);display(task);return;
    }
    if(action==='close'){task=await closeTask(config.outputDir,task);display(task);return;}
    if(action==='analyze'){
      const worktree=flag(args,'--worktree');if(!worktree)throw new Error('--worktree PATH is required');
      task=await analyzeTask(config,task,worktree);display(task);return;
    }
    if(action==='precheck'){task=await preFixCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait'));display(task);return;}
    if(action==='modify'){task=await modifyTask(config,task);display(task);return;}
    if(action==='finalcheck'){
      if(task.phase!=='FINAL_VERIFY'||!['READY','WAITING_RETRY','RUNNING'].includes(task.status))
        throw new Error(`Not ready for final verification: ${task.phase}/${task.status}`);
      task=await finalVerifyCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait'));display(task);return;
    }
    if(action==='reconcile-edit'){
      if(!args.includes('--ack-partial'))throw new Error('Explicit --ack-partial required after inspecting preserved worktree and status');
      if(task.phase==='MODIFYING'&&task.status==='RUNNING')task=await recoverTask(config.outputDir,task);
      task=await reconcileInterruptedEdit(config,task);display(task);return;
    }
    if(action==='verify' && !(task.phase==='INITIAL_VERIFY' && task.status==='READY'))
      throw new Error(`Task not ready for verification: ${task.phase}/${task.status}`);
    if(action==='resume' && task.phase!=='INITIAL_VERIFY' && task.status==='RUNNING'){
      task=await recoverTask(config.outputDir,task);
      console.log('중단된 후속 단계를 검토 대기 상태로 복구했습니다.');
    }
    if(action==='resume' && task.status==='BLOCKED' && task.phase==='INITIAL_VERIFY'){
      console.log(`검증이 차단된 상태 (${task.lastError}); 재시도 한도/근거를 보존하고 자동 재개하지 않습니다.`);
    }else{
      task=task.phase==='PRE_FIX_VERIFY' ?
        await preFixCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait')) :
        task.phase==='FINAL_VERIFY' ?
        await finalVerifyCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait')) :
        await runValidationCycle(config,task,runAgentHarness,realClock,args.includes('--no-wait'));
      if(task.phase!=='DONE' && task.phase!=='INITIAL_VERIFY')
        console.log(`현재 ${task.phase} 상태. 읽기 전용 분석은 task analyze, 중간 검증은 task precheck; 실제 코드 수정은 task modify, 최종 독립 검증은 task finalcheck, Git 제출은 task submit --confirm-submit 를 명시적으로 실행해야 합니다.`);
    }
    display(task);
  });
}
