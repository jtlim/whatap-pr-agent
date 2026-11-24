/**
 * Phase A: persistent workflow state and cross-process coordination.
 * This module does NOT perform code modification or Git/GitHub actions.
 * A saved state is authoritative; the JSONL audit trail can be repaired from
 * the single lastEvent stored atomically in that state after process death.
 */
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readdir, readFile, rename, open, unlink, stat } from 'node:fs/promises';
import type { Status } from './types.js';

export type WorkflowPhase = 'INITIAL_VERIFY'|'ANALYZING'|'PRE_FIX_VERIFY'|'MODIFYING'|'FINAL_VERIFY'|
  'COMMITTING'|'PUSHING'|'CREATING_PR'|'PR_OPEN'|'DONE';
export type WorkflowStatus = 'READY'|'RUNNING'|'WAITING_RETRY'|'PAUSED'|'BLOCKED'|'PR_OPEN'|'COMPLETED'|'CANCELLED';
export type VerifyPhase = 'INITIAL_VERIFY'|'PRE_FIX_VERIFY'|'FINAL_VERIFY';
export type ValidationEvidence = { runDir:string; reportSha256:string; verdict:Status; at:string };
export type ValidationAttempt = { phase:VerifyPhase; ordinal:number; editOrdinal?:number; artifactName?:string; artifactSha256?:string; startedAt:string; finishedAt?:string; verdict?:Status; reason?:string; evidence?:ValidationEvidence|null; timeWindow?:{stime:number;etime:number}|null };
export type EditAttempt = {ordinal:number;startedAt:string;finishedAt:string;
  outcome:'COMPLETED'|'FAILED'|'BLOCKED'|'INTERRUPTED_REVIEWED';beforeSha256:string;afterSha256?:string;
  changedFiles:string[];forbiddenFiles:string[];error?:string;recordSha256?:string};
export const MAX_VALIDATION_RETRIES=3;
export const VALIDATION_BACKOFF_MS=[30000,60000,120000] as const;
export function retryDelayMs(retriesConsumed:number):number {
  if(!Number.isInteger(retriesConsumed)||retriesConsumed<0||retriesConsumed>=MAX_VALIDATION_RETRIES)throw new Error('Invalid retry schedule index');
  return VALIDATION_BACKOFF_MS[retriesConsumed];
}
export type WorkflowEvent = {
  sequence:number; eventId:string; at:string; type:string; phase:WorkflowPhase;
  status:WorkflowStatus; detail:string;
};
export type SubmissionState = {
  initialHead:string; baseHead:string; snapshotSha256:string;
  finalReportSha256:string; finalArtifactSha256:string;
  intentSha256?:string; commitSha?:string; commitSha256?:string;
  pushSha256?:string; prNumber?:number; prUrl?:string; prSha256?:string; mergeSha256?:string;
};
export type WorkflowState = {
  schemaVersion:1; taskId:string; scenarioId:string; createdAt:string; updatedAt:string;
  phase:WorkflowPhase; status:WorkflowStatus; sequence:number;
  baseBranch:'submission'; workBranch:'agent';
  validationRetries: Record<'INITIAL_VERIFY'|'PRE_FIX_VERIFY'|'FINAL_VERIFY',number>;
  fixRetries:number; nextAttemptAt:string|null;
  submission?:SubmissionState;
  editHistory?:EditAttempt[];
  activeEditAttempt?:{ordinal:number;startedAt:string;beforeSha256:string;startFileSha256:string}|null;
  analysis?: {sha256:string;worktree:string;head:string;classification:string};
  preFix?: {sha256:string;runDir:string;reportSha256:string;sameAbsolutePeriod:boolean;reproduced:boolean;
    mode?:'FIXED_WINDOW'|'PERIOD_PAIRED'};
  latestValidation: ValidationEvidence|null;
  /** Optional for backward compatibility with Phase A state files. */
  validationHistory?: ValidationAttempt[];
  /** Persistent ordinal reserved before launching a validation; crash recovery reuses it. */
  activeValidationAttempt?: {phase:VerifyPhase; ordinal:number; editOrdinal?:number; startedAt:string}|null;
  lastError:string|null; lastEvent:WorkflowEvent;
};
const validId=/^task-[0-9a-f]{8}-[0-9a-f]{8}$/;
const finalStatus=new Set<WorkflowStatus>(['COMPLETED','CANCELLED']);
const phases = new Set<WorkflowPhase>(['INITIAL_VERIFY','ANALYZING','PRE_FIX_VERIFY','MODIFYING','FINAL_VERIFY','COMMITTING','PUSHING','CREATING_PR','PR_OPEN','DONE']);
const statuses = new Set<WorkflowStatus>(['READY','RUNNING','WAITING_RETRY','PAUSED','BLOCKED','PR_OPEN','COMPLETED','CANCELLED']);
export function taskDir(outputDir:string, taskId:string):string {
  if (!validId.test(taskId)) throw new Error('Invalid taskId (path traversal rejected)');
  return join(outputDir,'tasks',taskId);
}
export function taskRoot(outputDir:string):string{return join(outputDir,'tasks');}
export function isTerminal(state:WorkflowState):boolean{return finalStatus.has(state.status);}
const now=()=>new Date().toISOString();
function assertState(s:WorkflowState):void {
  if(s.schemaVersion!==1 || !validId.test(s.taskId) || !/^[a-z][a-z0-9-]*$/.test(s.scenarioId) ||
    !phases.has(s.phase) || !statuses.has(s.status) || s.baseBranch!=='submission' || s.workBranch!=='agent' ||
    !Number.isSafeInteger(s.sequence) || s.sequence<1 || !s.lastEvent || s.lastEvent.sequence!==s.sequence ||
    !Number.isSafeInteger(s.fixRetries) || s.fixRetries<0 || s.fixRetries>2 ||
    (s.editHistory!==undefined && (!Array.isArray(s.editHistory) || s.editHistory.length>6 ||
      s.editHistory.some((a,i)=>a.ordinal!==i+1 || !['COMPLETED','FAILED','BLOCKED','INTERRUPTED_REVIEWED'].includes(a.outcome) ||
        !/^[a-f0-9]{64}$/.test(a.beforeSha256) || !Array.isArray(a.changedFiles) || !Array.isArray(a.forbiddenFiles) ||
        (a.afterSha256!==undefined&&!/^[a-f0-9]{64}$/.test(a.afterSha256)) ||
        !/^[a-f0-9]{64}$/.test(a.recordSha256??'')))) ||
    (s.activeEditAttempt!==undefined && s.activeEditAttempt!==null &&
      (!Number.isSafeInteger(s.activeEditAttempt.ordinal)||s.activeEditAttempt.ordinal<1||s.activeEditAttempt.ordinal>6||
        !/^[a-f0-9]{64}$/.test(s.activeEditAttempt.beforeSha256)||
        !/^[a-f0-9]{64}$/.test(s.activeEditAttempt.startFileSha256))) ||
    (s.validationHistory!==undefined && (!Array.isArray(s.validationHistory) || s.validationHistory.some(a=>
      !['INITIAL_VERIFY','PRE_FIX_VERIFY','FINAL_VERIFY'].includes(a.phase) || !Number.isSafeInteger(a.ordinal) || a.ordinal<1 ||
      !Number.isFinite(Date.parse(a.startedAt)) || (a.editOrdinal!==undefined && (!Number.isInteger(a.editOrdinal)||a.editOrdinal<1||a.editOrdinal>6)) || (a.artifactSha256!==undefined&&!/^[a-f0-9]{64}$/.test(a.artifactSha256)) || (a.verdict!==undefined && !['PASS','FAIL','UNVERIFIABLE','UNMAPPED','UNSUPPORTED'].includes(a.verdict))))) ||
    (s.activeValidationAttempt!==undefined && s.activeValidationAttempt!==null &&
      (!['INITIAL_VERIFY','PRE_FIX_VERIFY','FINAL_VERIFY'].includes(s.activeValidationAttempt.phase) ||
      !Number.isSafeInteger(s.activeValidationAttempt.ordinal) || s.activeValidationAttempt.ordinal<1 ||
      !Number.isFinite(Date.parse(s.activeValidationAttempt.startedAt)) || (s.activeValidationAttempt.editOrdinal!==undefined && (!Number.isInteger(s.activeValidationAttempt.editOrdinal)||s.activeValidationAttempt.editOrdinal<1||s.activeValidationAttempt.editOrdinal>6)))) ||
    !['INITIAL_VERIFY','PRE_FIX_VERIFY','FINAL_VERIFY'].every(k=>Number.isSafeInteger(s.validationRetries?.[k as keyof typeof s.validationRetries]) && s.validationRetries[k as keyof typeof s.validationRetries]>=0) ||
    (s.submission!==undefined && (![s.submission.initialHead,s.submission.baseHead].every(x=>/^[a-f0-9]{40,64}$/.test(x)) ||
      ![s.submission.snapshotSha256,s.submission.finalReportSha256,s.submission.finalArtifactSha256].every(x=>/^[a-f0-9]{64}$/.test(x)) ||
      [s.submission.intentSha256,s.submission.commitSha256,s.submission.pushSha256,s.submission.prSha256,s.submission.mergeSha256].some(x=>x!==undefined&&!/^[a-f0-9]{64}$/.test(x)) ||
      (s.submission.commitSha!==undefined&&!/^[a-f0-9]{40,64}$/.test(s.submission.commitSha)) ||
      (s.submission.prNumber!==undefined&&(!Number.isSafeInteger(s.submission.prNumber)||s.submission.prNumber<1)))) ||
    (s.analysis!==undefined && (!/^[a-f0-9]{64}$/.test(s.analysis.sha256) || !/^[a-f0-9]{40,64}$/.test(s.analysis.head) || typeof s.analysis.worktree!=='string')) ||
    (s.preFix!==undefined && (!/^[a-f0-9]{64}$/.test(s.preFix.sha256) || (s.preFix.runDir!=='' && !/^[a-f0-9]{64}$/.test(s.preFix.reportSha256)))) ||
    (s.status==='COMPLETED' && s.phase!=='DONE') || (s.status==='PR_OPEN' && s.phase!=='PR_OPEN') ||
    (s.nextAttemptAt!==null && (!Number.isFinite(Date.parse(s.nextAttemptAt))))) {
    throw new Error('Invalid/corrupted workflow state; refusing to resume');
  }
}
async function atomicWrite(path:string, content:string):Promise<void> {
  const temp=path+`.tmp-${process.pid}-${randomUUID()}`;
  const fh=await open(temp,'wx',0o600);
  try {await fh.writeFile(content,'utf8');await fh.sync();} finally {await fh.close();}
  try {await rename(temp,path);} catch(e){await unlink(temp).catch(()=>{});throw e;}
  // Best effort directory durability (Linux ext4/xfs). Never mark a checkpoint
  // successful based only on volatile memory.
  try{const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}}catch{}
}
async function appendEvent(dir:string,e:WorkflowEvent):Promise<void> {
  const fh=await open(join(dir,'events.jsonl'),'a',0o600);
  try {await fh.writeFile(JSON.stringify(e)+'\n');await fh.sync();} finally {await fh.close();}
}
async function reconcileEventLog(dir:string,s:WorkflowState,repair:boolean):Promise<void> {
  const path=join(dir,'events.jsonl');
  const content=await readFile(path,'utf8').catch((e:NodeJS.ErrnoException)=>{
    if(e.code==='ENOENT')return '';throw e;
  });
  const lines=content.trim().split('\n').filter(Boolean);
  let previous=0;
  for (const line of lines) {
    let event:WorkflowEvent;
    try {event=JSON.parse(line) as WorkflowEvent;}catch{throw new Error('Corrupt events.jsonl; manual investigation required');}
    if(event.sequence!==previous+1 || typeof event.eventId!=='string') throw new Error('Invalid events.jsonl sequence');
    previous=event.sequence;
  }
  if(previous===s.sequence) {
    if(lines.length && JSON.parse(lines.at(-1)!).eventId!==s.lastEvent.eventId)
      throw new Error('Workflow log disagrees with state; refusing to continue');
    return;
  }
  // Only the most recent event can be missing: every transition first verifies
  // log integrity and then writes one new snapshot and one appended event.
  if(previous===s.sequence-1) {if(repair)await appendEvent(dir,s.lastEvent);return;}
  throw new Error('Workflow state/event gap too large; refusing to continue');
}
export async function readTask(outputDir:string,id:string,repairEventLog=false):Promise<WorkflowState> {
  const dir=taskDir(outputDir,id);
  const content=await readFile(join(dir,'state.json'),'utf8');
  const s=JSON.parse(content) as WorkflowState;
  assertState(s);
  if(s.taskId!==id) throw new Error('Workflow taskId does not match its directory');
  await reconcileEventLog(dir,s,repairEventLog);
  return s;
}
export async function writeTransition(outputDir:string,previous:WorkflowState,changes:Partial<Omit<WorkflowState,'taskId'|'schemaVersion'|'sequence'|'lastEvent'|'createdAt'|'scenarioId'|'baseBranch'|'workBranch'>>,type:string,detail:string):Promise<WorkflowState> {
  const dir=taskDir(outputDir,previous.taskId);
  // All callers must hold the global lock. Compare-and-swap protects against
  // accidental stale snapshot updates even if a caller violates that contract.
  const stored=await readTask(outputDir,previous.taskId,true);
  if(stored.sequence!==previous.sequence)throw new Error('Stale workflow state, refusing overwrite');
  const result={...previous,...changes,updatedAt:now(),sequence:previous.sequence+1};
  result.lastEvent={sequence:result.sequence,eventId:randomUUID(),at:result.updatedAt,type,phase:result.phase,status:result.status,detail};
  assertState(result);
  await atomicWrite(join(dir,'state.json'),JSON.stringify(result,null,2)+'\n');
  await appendEvent(dir,result.lastEvent);
  return result;
}
export async function listTasks(outputDir:string):Promise<WorkflowState[]> {
  const root=taskRoot(outputDir);
  const files=await readdir(root,{withFileTypes:true}).catch((e:NodeJS.ErrnoException)=>{
    if(e.code==='ENOENT')return []; throw e;
  });
  const result:WorkflowState[]=[];
  for (const e of files) if(e.isDirectory() && validId.test(e.name)) result.push(await readTask(outputDir,e.name));
  return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function createTask(outputDir:string,scenarioId:string):Promise<WorkflowState> {
  if(!/^[a-z][a-z0-9-]*$/.test(scenarioId)) throw new Error('Invalid scenarioId');
  const active=(await listTasks(outputDir)).find(s=>!isTerminal(s));
  if(active)throw new Error(`An unfinished task already exists: ${active.taskId} (${active.phase}/${active.status}). Resolve it before starting another.`);
  const id=`task-${Date.now().toString(16).slice(-8).padStart(8,'0')}-${randomUUID().slice(0,8)}`;
  const dir=taskDir(outputDir,id);
  await mkdir(dir,{recursive:false,mode:0o700});
  const date=now();
  const s:WorkflowState={schemaVersion:1,taskId:id,scenarioId,createdAt:date,updatedAt:date,
    phase:'INITIAL_VERIFY',status:'READY',sequence:1,baseBranch:'submission',workBranch:'agent',
    validationRetries:{INITIAL_VERIFY:0,PRE_FIX_VERIFY:0,FINAL_VERIFY:0},fixRetries:0,
    nextAttemptAt:null,latestValidation:null,validationHistory:[],activeValidationAttempt:null,lastError:null,
    lastEvent:{sequence:1,eventId:randomUUID(),at:date,type:'TASK_CREATED',phase:'INITIAL_VERIFY',status:'READY',detail:`scenario=${scenarioId}`}};
  await atomicWrite(join(dir,'state.json'),JSON.stringify(s,null,2)+'\n');
  await appendEvent(dir,s.lastEvent);
  return s;
}
export async function recoverTask(outputDir:string,state:WorkflowState):Promise<WorkflowState> {
  if(state.status!=='RUNNING')return state;
  if(['COMMITTING','PUSHING','CREATING_PR'].includes(state.phase)) {
    return writeTransition(outputDir,state,{status:'BLOCKED',lastError:'EXTERNAL_SIDE_EFFECT_RECONCILIATION_REQUIRED'},
      'RECOVERY_BLOCKED','외부 Git/GitHub 동작의 완료 여부를 확인하기 전에는 재실행 금지');
  }
  if(state.phase==='ANALYZING') {
    return writeTransition(outputDir,state,{status:'PAUSED',lastError:'INTERRUPTED_CODEX_DIAGNOSIS'},
      'RECOVERY_PAUSED','Codex 원인 분석 중 중단. 소스는 보존하고 분석 재실행을 기다림');
  }
  if(state.phase==='MODIFYING') {
    return writeTransition(outputDir,state,{status:'PAUSED',lastError:'PARTIAL_WORKTREE_REQUIRES_INSPECTION'},
      'RECOVERY_PAUSED','부분 수정 Worktree 보존; Codex 재개는 후속 단계에서 구현');
  }
  // A read-only validation that died mid-flight has no complete PASS evidence.
  // It may be rerun, but never treated as successfully completed.
  return writeTransition(outputDir,state,{status:'READY',lastError:'INTERRUPTED_STEP_REQUIRES_REEXECUTION'},
    'RECOVERY_READY','미완료 단계는 PASS로 취급하지 않음; 재실행 대기');
}
export async function closeTask(outputDir:string,state:WorkflowState):Promise<WorkflowState> {
  if(isTerminal(state))throw new Error('Task already terminal');
  if(state.status==='RUNNING'||['COMMITTING','PUSHING','CREATING_PR','PR_OPEN'].includes(state.phase))
    throw new Error('Cannot close an active or externally pending Git/PR operation');
  return writeTransition(outputDir,state,{status:'CANCELLED',lastError:'USER_CANCELLED'},'TASK_CANCELLED',
    '사용자 요청으로 작업을 닫음; 기존 검증 증거는 유지');
}

export class WorkflowBusyError extends Error {constructor(message:string){super(message);this.name='WorkflowBusyError';}}
interface LockOwner {token:string;pid:number;host:string;startedAt:string;procStart:string|null;}
async function procStart(pid:number):Promise<string|null> {
  if(process.platform!=='linux')return null;
  const src=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);
  if(!src)return null;
  return src.slice(src.lastIndexOf(')')+2).trim().split(/\s+/)[19]??null;
}
async function deadOwner(owner:LockOwner):Promise<boolean> {
  if(!owner || typeof owner.pid!=='number' || !Number.isInteger(owner.pid) || owner.pid<=0 || owner.host!==hostname())return false;
  try {process.kill(owner.pid,0);} catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
  if(owner.procStart){const current=await procStart(owner.pid);return current!==null && current!==owner.procStart;}
  return false;
}
/** Single-worktree process lock for all state mutation and execution. */
export async function withWorkflowLock<T>(outputDir:string,fn:()=>Promise<T>):Promise<T> {
  const root=taskRoot(outputDir);await mkdir(root,{recursive:true,mode:0o700});
  const lock=join(root,'.workflow.lock');
  const owner:LockOwner={token:randomUUID(),pid:process.pid,host:hostname(),startedAt:now(),procStart:await procStart(process.pid)};
  let h;
  for(let attempt=0;attempt<2;attempt++){
    try {h=await open(lock,'wx',0o600);break;}catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      let old:LockOwner;
      try {old=JSON.parse(await readFile(lock,'utf8')) as LockOwner;}catch{
        throw new WorkflowBusyError(`Workflow lock incomplete/unreadable: ${lock}; do not delete until the owner is checked`);
      }
      if(!(await deadOwner(old)))throw new WorkflowBusyError(`Workflow in use by PID ${old.pid} on ${old.host}; refusing concurrent execution`);
      // A crashed owner can leave a lock. Recheck token before unlinking;
      // never steal a lock with an unknown or still-living owner.
      const current=JSON.parse(await readFile(lock,'utf8')) as LockOwner;
      if(current.token!==old.token)throw new WorkflowBusyError('Lock owner changed while attempting recovery');
      await unlink(lock).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    }
  }
  if(!h)throw new WorkflowBusyError('Workflow lock unavailable');
  try{
    await h.writeFile(JSON.stringify(owner)+'\n');await h.sync();await h.close();h=undefined;
    return await fn();
  }finally{
    if(h)await h.close();
    // Never remove a lock created by a different process.
    try {const current=JSON.parse(await readFile(lock,'utf8')) as LockOwner;
      if(current.token===owner.token)await unlink(lock);
    }catch{}
  }
}
export async function writeWorkflowArtifact(outputDir:string, taskId:string, name:string, content:string):Promise<void> {
  if(!/^[a-z][a-z0-9-]*\.(json|md)$/.test(name))throw new Error('Invalid workflow artifact name');
  await atomicWrite(join(taskDir(outputDir,taskId),name),content);
}
export async function hashFile(path:string):Promise<string>{
  const bytes=await readFile(path);return createHash('sha256').update(bytes).digest('hex');
}
export async function evidenceExists(state:WorkflowState):Promise<boolean>{
  if(!state.latestValidation)return false;
  const p=join(state.latestValidation.runDir,'report.json');
  const info=await stat(p).catch(()=>null);
  return !!info?.isFile() && await hashFile(p)===state.latestValidation.reportSha256;
}
