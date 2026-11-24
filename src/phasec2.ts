/** Phase C2: guarded Codex source editing. This phase NEVER declares verification PASS. */
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { inspectAgentWorktree, validateDiagnosis, type Diagnosis } from './phasec.js';
import { readTask, hashFile, writeTransition, writeWorkflowArtifact,
  type WorkflowState, type EditAttempt } from './workflow.js';
import type { HarnessConfig } from './types.js';

const execFile=promisify(execFileCb);
const hex=(x:string)=>createHash('sha256').update(x).digest('hex');
const now=()=>new Date().toISOString();
const allowedSource=/^(?:src|lib|app|server|packages\/[^/]+\/src)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/;
const allowedTest=/(?:^|\/)(?:test|tests|__tests__)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|json)$/;
const pathSafe=(x:string)=>x!=='' && !isAbsolute(x) && !x.includes('\\') &&
  !x.split('/').some(p=>!p || p==='.' || p==='..') && !x.includes('\0') && x.length<512;
const quote=(x:string)=>x.replaceAll('|','\\|').replaceAll('\n',' ');
export type EditResult={summary:string;rationale:string;testsRun:string[];risks:string[]};
export type EditFn=(worktree:string,prompt:string,dir:string,ordinal:number)=>Promise<EditResult>;
export type Snapshot={files:Record<string,string>;root:string;head:string;status:string;indexSha256:string};
/** Only proven pre-tool schema-read failures with an identical before/after
 * source snapshot are infrastructure-only attempts. They remain in the audit
 * log but cannot consume the three substantive modification attempts. */
export function isSchemaInfrastructureFailure(a:EditAttempt):boolean {
  return a.outcome==='FAILED' &&
    typeof a.error==='string' && a.error.startsWith('Codex edit failed (exit=1, timeout=false, outputLimit=false; stderr=') &&
    a.error.includes('Failed to read output schema file') &&
    a.changedFiles.length===0 && a.forbiddenFiles.length===0 &&
    !!a.afterSha256 && a.afterSha256===a.beforeSha256;
}
export function substantiveEditCount(history:EditAttempt[]|undefined):number {
  return (history??[]).filter(a=>!isSchemaInfrastructureFailure(a)).length;
}

export function securePath(x:string):boolean {return pathSafe(x)&&(allowedSource.test(x)||allowedTest.test(x));}
function whitelisted(path:string,candidates:string[]):boolean {
  return securePath(path) && (candidates.includes(path)||allowedTest.test(path));
}
function allChanged(a:Snapshot,b:Snapshot):string[]{
  return [...new Set([...Object.keys(a.files),...Object.keys(b.files)])]
    .filter(p=>a.files[p]!==b.files[p]).sort();
}
/** Snapshot all source worktree files including ignored dependencies/caches.
 * Only the linked-worktree .git metadata is excluded. Symlinks are NEVER followed.
 * Fails closed on exceptionally large trees rather than silently dropping files.
 */
export async function snapshotWorktree(path:string):Promise<Snapshot>{
  const worktree=await inspectAgentWorktree(path);
  const files:Record<string,string>={};
  let count=0;
  async function walk(dir:string,prefix=''):Promise<void>{
    const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      if(entry.name==='.git')continue;
      const key=prefix?prefix+'/'+entry.name:entry.name;
      if(!pathSafe(key))throw Error('Unsupported worktree file path');
      if(++count>60000)throw Error('Worktree file-count limit exceeded; refusing unsafe partial snapshot');
      const p=join(dir,entry.name);
      const st=await lstat(p);
      if(st.isDirectory())await walk(p,key);
      else if(st.isSymbolicLink())files[key]='symlink:'+hex(await readlink(p));
      else if(st.isFile())files[key]='file:'+await hashFile(p);
      else throw Error('Unsupported worktree file type: '+key);
    }
  }
  await walk(worktree.path);
  // HEAD may remain unchanged even after Codex stages or mutates the Git index.
  // Preserve a hash of the index entries so a hidden git add cannot be silently accepted.
  const index=(await execFile('git',['-C',worktree.path,'ls-files','--stage','-z'],
    {encoding:'buffer',timeout:20000,maxBuffer:32*1024*1024})).stdout as Buffer;
  return {files,root:worktree.path,head:worktree.head,status:worktree.status,indexSha256:hex(index.toString('base64'))};
}
function snapshotSha(s:Snapshot):string{return hex(JSON.stringify(s));}
export function pathsAllowed(before:Snapshot,after:Snapshot,candidates:string[]):{changes:string[];forbidden:string[]}{
  const changes=allChanged(before,after);
  return {changes,forbidden:changes.filter(p=>!whitelisted(p,candidates)||
    after.files[p]?.startsWith('symlink:')||before.files[p]?.startsWith('symlink:'))};
}
const editorSchema={type:'object',additionalProperties:false,
  required:['summary','rationale','testsRun','risks'],properties:{summary:{type:'string'},rationale:{type:'string'},
    testsRun:{type:'array',items:{type:'string'}},risks:{type:'array',items:{type:'string'}}}};
function validateResult(v:unknown):EditResult{
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid Codex edit report');
  const o=v as Record<string,unknown>;
  if(Object.keys(o).sort().join(',')!=='rationale,risks,summary,testsRun' ||
    !['summary','rationale'].every(k=>typeof o[k]==='string' && (o[k] as string).length>0 && (o[k] as string).length<=16000) ||
    !['testsRun','risks'].every(k=>Array.isArray(o[k])&&(o[k] as unknown[]).length<=40 &&
      (o[k] as unknown[]).every(x=>typeof x==='string'&&x.length<=2000)))throw Error('Invalid Codex edit report');
  return o as EditResult;
}
function envWithoutServiceSecrets():NodeJS.ProcessEnv{
  const env={...process.env};
  for(const k of Object.keys(env))if(/^(WHATAP_|AWS_|GH_TOKEN$|GITHUB_TOKEN$|GIT_ASKPASS$|SSH_AUTH_SOCK$)/i.test(k))delete env[k];
  return env;
}
export async function codexEdit(worktree:string,prompt:string,dir:string,ordinal:number):Promise<EditResult>{
  const schemaFile=join(dir,`edit-schema-${ordinal}.json`);
  const outputFile=join(dir,`codex-edit-result-${ordinal}.json`);
  await writeWorkflowArtifact(resolve(dir,'../..'),dir.split('/').at(-1)!,`edit-schema-${ordinal}.json`,JSON.stringify(editorSchema)+'\n');
  // Only the target worktree is writable by the Codex sandbox. MCP integrations and service tokens are disabled.
  const args=['exec','--json','--ephemeral',
    '--sandbox','workspace-write','--skip-git-repo-check',
    '-c','approval_policy="never"',
    '-c','sandbox_workspace_write.network_access=false',
    '-c','sandbox_workspace_write.writable_roots=[]',
    '-c','sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c','sandbox_workspace_write.exclude_slash_tmp=true',
    '-c','mcp_servers.whatap.enabled=false','-c','mcp_servers.whatap-http.enabled=false',
    '--output-schema',schemaFile,'--output-last-message',outputFile,prompt];
  const child=spawn('codex',args,{cwd:worktree,env:envWithoutServiceSecrets(),stdio:['ignore','pipe','pipe'],shell:false});
  let stderr='',expired=false,outputTooLarge=false,bytes=0;
  child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>2*1024*1024)outputTooLarge=true;});
  child.stderr.on('data',(b:Buffer)=>{if(stderr.length<8192)stderr+=b.toString('utf8');});
  const timeout=setTimeout(()=>{expired=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref();},900_000);
  let code:number;
  try{code=await new Promise((ok,fail)=>{child.once('error',fail);child.once('close',c=>ok(c??-1));});}
  finally{clearTimeout(timeout);}
  if(code!==0||expired||outputTooLarge)throw Error(`Codex edit failed (exit=${code}, timeout=${expired}, outputLimit=${outputTooLarge}; stderr=${stderr.slice(0,160)})`);
  return validateResult(JSON.parse(await readFile(outputFile,'utf8')));
}
async function loadAuthorization(config:HarnessConfig,s:WorkflowState):Promise<{diagnosis:Diagnosis;sourceStatus:string;worktree:string;head:string}>{
  if(s.phase!=='MODIFYING'||s.status!=='PAUSED'||!s.analysis||!s.preFix ||
    s.analysis.classification!=='MCP_DEFECT'||!s.preFix.reproduced||
    (!s.preFix.sameAbsolutePeriod&&s.preFix.mode!=='PERIOD_PAIRED'))
    throw Error('C1 independent pre-fix gate has not authorized code editing');
  const dir=join(config.outputDir,'tasks',s.taskId);
  const a=await readFile(join(dir,'analysis.json'),'utf8');
  const p=await readFile(join(dir,'prefx-report.json'),'utf8');
  if(hex(a)!==s.analysis.sha256||hex(p)!==s.preFix.sha256)throw Error('Phase C1 evidence checksum mismatch');
  if(!s.preFix.runDir || await hashFile(join(s.preFix.runDir,'report.json'))!==s.preFix.reportSha256)
    throw Error('Pre-fix HTTP/MCP report evidence missing or changed');
  const pre=JSON.parse(p) as {sameAbsolutePeriod:boolean;reproduced:boolean;preFixReportSha256:string;
    policyMode?:string;independentFailuresInDistinctWindows?:number};
  if((!pre.sameAbsolutePeriod&&pre.policyMode!=='PERIOD_PAIRED')||!pre.reproduced||
    (pre.policyMode==='PERIOD_PAIRED'&&!((pre.independentFailuresInDistinctWindows??0)>=2))||
    pre.preFixReportSha256!==s.preFix.reportSha256)
    throw Error('Pre-fix report does not authorize editing');
  const doc=JSON.parse(a) as {diagnosis:Diagnosis;sourceStatus:string;worktree:string;sourceHead:string};
  const diagnosis=validateDiagnosis(doc.diagnosis);
  if(diagnosis.classification!=='MCP_DEFECT'||s.analysis.head!==doc.sourceHead||
    resolve(doc.worktree)!==resolve(s.analysis.worktree))throw Error('Untrusted or inconsistent analysis record');
  // Built bundles may be cited as investigation evidence, but MUST NEVER grant
  // Codex edit permission. Existing signed C1 analysis.json is not rewritten.
  const buildEvidenceOnly=new Set(['dist/index.js','dist/index.js.map','dist/index.d.ts']);
  const authorizedCandidates=diagnosis.candidateFiles.filter(securePath);
  if(!authorizedCandidates.length ||
    diagnosis.candidateFiles.some(p=>!securePath(p)&&!buildEvidenceOnly.has(p)))
    throw Error('No safe MCP source paths authorized by the diagnosis');
  return {diagnosis:{...diagnosis,candidateFiles:authorizedCandidates},
    sourceStatus:doc.sourceStatus,worktree:resolve(doc.worktree),head:doc.sourceHead};
}
function promptForEdit(s:WorkflowState,d:Diagnosis,ordinal:number):string{
  return ['당신은 WhaTap MCP 코드 수정을 수행합니다. 수정 승인된 범위만 작업하세요.',
    s.preFix?.mode==='PERIOD_PAIRED' ? '동일한 원본 상대시간 조회 인자를 사용했고 서로 다른 두 관찰 기간에서 독립 MCP/HTTP 불일치를 확인했습니다. 동일 절대 기간 재현이라 주장하지 마세요.' : 'Harness 의 독립 MCP/HTTP 검증에서 같은 절대 기간의 불일치를 확인했습니다.',
    'Harness, HTTP reference client, 환경 변수, 검증 조건, 원본 로그를 수정하면 안 됩니다.',
    '네트워크 호출, MCP 호출, git add/commit/push/checkout/reset/rebase/clean 등 Git 변경 명령은 금지합니다.',
    '이 수정 단계에서는 npm build/test 또는 컴파일을 실행해 dist/나 의존성 디렉터리에 파일을 생성하지 마세요. 회귀 테스트는 다음 독립 검증 단계에서 수행합니다.',
    `이 작업은 수정 시도 ${ordinal}/3입니다. 기존 수정 내용은 유지하고 최소한으로 수정합니다.`,
    `시나리오 ${s.scenarioId}. 허용된 코드 파일: ${JSON.stringify(d.candidateFiles)}.`,
    '위 코드 파일 및 테스트 디렉터리(test/, tests/, __tests__/)의 필요한 테스트 소스 외에는 수정 금지합니다.',
    `문제: ${d.problem}`,`영향: ${d.impact}`,`원인 가설: ${d.causeHypothesis}`,
    `기대: ${d.expectedResult}`,`실제: ${d.actualResult}`,`권장 수정: ${d.recommendedChange}`,
    `재현 단계: ${JSON.stringify(d.reproductionSteps)}`,
    '가능한 경우 관련 테스트를 추가/수정하되 원본 증거와 독립 검증을 수정하지 마세요.',
    '결과에는 summary, rationale, testsRun, risks를 포함한 정확한 JSON 객체를 반환하세요.',
    '최종 독립 검증은 Harness 가 별도로 수행하므로 절대 PASS라고 선언하지 마세요.'].join('\n');
}
async function saveEditRecord(config:HarnessConfig,s:WorkflowState,a:EditAttempt,diagnosis:Diagnosis,
  before:Snapshot,after:Snapshot|undefined,codex:EditResult|undefined):Promise<{recordSha:string}>{
  const record={taskId:s.taskId,scenarioId:s.scenarioId,ordinal:a.ordinal,outcome:a.outcome,
    startedAt:a.startedAt,finishedAt:a.finishedAt,sourceHead:before.head,
    approvedSourceFiles:diagnosis.candidateFiles,allowedTestFiles:'test/, tests/, __tests__/',
    changedFiles:a.changedFiles,forbiddenFiles:a.forbiddenFiles,
    files:(a.changedFiles??[]).map(p=>({path:p,before:before.files[p]??null,after:after?.files[p]??null})),
    beforeSnapshotSha256:a.beforeSha256,afterSnapshotSha256:a.afterSha256??null,
    codexClaim:codex??null,error:a.error??null,
    beforeIndependentEvidence:{runDir:s.preFix?.runDir??null,reportSha256:s.preFix?.reportSha256??null,
      reproduced:s.preFix?.reproduced??false,sameAbsolutePeriod:s.preFix?.sameAbsolutePeriod??false},
    afterIndependentEvidence:'PENDING_PHASE_D',finalVerdict:'NOT_YET_VERIFIED',
    rootCauseHypothesis:diagnosis.causeHypothesis,impact:diagnosis.impact,
    reproductionSteps:diagnosis.reproductionSteps,expectedResult:diagnosis.expectedResult,actualResult:diagnosis.actualResult,
    generatedAt:now()};
  const body=JSON.stringify(record,null,2)+'\n';
  const file=`edit-${a.ordinal}.json`;
  await writeWorkflowArtifact(config.outputDir,s.taskId,file,body);
  const md=[`# Phase C2 코드 수정 시도 ${a.ordinal}/3 — ${s.taskId}`,'',
    `- 결과: **${a.outcome}** (최종 독립 PASS 아님)`,
    `- Worktree HEAD: ${before.head}`,
    `- 수정 전 Snapshot SHA-256: ${a.beforeSha256}`,
    `- 수정 후 Snapshot SHA-256: ${a.afterSha256??'미확보'}`,
    `- 독립 수정 전 MCP/HTTP 보고서: ${s.preFix?.runDir??'미확보'}`,
    `- 수정 후 독립 데이터 비교: **Phase D 대기**`,
    `- Codex 실행 오류: ${a.error??'없음'}`,'',
    '## 문제 및 영향',diagnosis.problem,'',diagnosis.impact,'',
    '## 원인 가설',diagnosis.causeHypothesis,'',
    '## 수정 이유',codex?.rationale??diagnosis.recommendedChange,'',
    '## 변경 파일 (수정 전/후 SHA-256)',
    '| 경로 | 이전 | 이후 |','|---|---|---|',
    ...(a.changedFiles??[]).map(p=>`| ${quote(p)} | ${before.files[p]??'미존재'} | ${after?.files[p]??'미존재'} |`),'',
    '## 허용 범위를 벗어난 파일',...(a.forbiddenFiles?.length?a.forbiddenFiles.map(p=>`- ${p}`):['없음']),'',
    '## Codex 자체 테스트 주장',...(codex?.testsRun.map(t=>`- ${t}`)??['미확인']),'',
    '## 제3자 재현 절차',...diagnosis.reproductionSteps.map((x,i)=>`${i+1}. ${x}`),'',
    '이 보고서는 AI 수정 기록이며 독립 HTTP/MCP 최종 비교 또는 회귀 테스트 성공을 증명하지 않습니다.'].join('\n')+'\n';
  await writeWorkflowArtifact(config.outputDir,s.taskId,`edit-${a.ordinal}.md`,md);
  return {recordSha:hex(body)};
}
async function writeDiff(config:HarnessConfig,s:WorkflowState,worktree:string,ordinal:number,paths:string[]):Promise<void>{
  // Only tracked Git changes are textual here. Added/untracked files retain before/after SHA in the JSON record.
  let diff='';
  if(paths.length){
    const r=await execFile('git',['-C',worktree,'diff','--no-ext-diff','HEAD','--',...paths],
      {timeout:20000,maxBuffer:2*1024*1024});
    diff=r.stdout;
  }
  await writeWorkflowArtifact(config.outputDir,s.taskId,`edit-diff-${ordinal}.md`,
    `# 누적 Git diff (tracked) — 시도 ${ordinal}\n\n\`\`\`diff\n${diff.replaceAll('```','` ` `')}\n\`\`\`\n\n미추적 파일은 edit-${ordinal}.json 의 SHA-256 및 파일 목록으로 확인하세요.\n`);
}
/** Exactly one edit attempt. CLI holds the workflow lock for this whole call. */
export async function modifyTask(config:HarnessConfig,s:WorkflowState,execute:EditFn=codexEdit):Promise<WorkflowState>{
  const approved=await loadAuthorization(config,s);
  if(s.activeEditAttempt)throw Error('Interrupted edit requires explicit inspection/reconciliation, not automatic rerun');
  const attempts=s.editHistory??[];
  const ordinal=attempts.length+1;
  const substantiveBefore=substantiveEditCount(attempts);
  const exemptBefore=attempts.length-substantiveBefore;
  if(substantiveBefore>=3||exemptBefore>3||ordinal>6)
    throw Error('Maximum substantive edit or infrastructure-recovery budget exhausted');
  if(ordinal>1){
    const last=attempts.at(-1)!;
    const lastFinal=(s.validationHistory??[]).filter(a=>a.phase==='FINAL_VERIFY').at(-1);
    const finalProvesFailure=s.lastError==='FINAL_VERIFY_CONFIRMED_FAIL'&&
      lastFinal?.verdict==='FAIL'&&!!lastFinal.evidence&&
      Date.parse(lastFinal.startedAt)>=Date.parse(last.finishedAt);
    if(last.outcome!=='FAILED'&&last.outcome!=='INTERRUPTED_REVIEWED'&&
      !finalProvesFailure)
      throw Error('No verified reason for a second source edit');
  }else if(s.lastError!=='CODE_EDITING_DISABLED_PHASE_C1'){
    throw Error('Missing Phase C1 edit authorization');
  }
  const before=await snapshotWorktree(approved.worktree);
  if(before.head!==approved.head)throw Error('Worktree HEAD changed since C1 analysis');
  if(!attempts.length && before.status!==approved.sourceStatus)throw Error('Worktree changed since Phase C1 analysis');
  if(!attempts.length && before.status!=='')throw Error('C2 requires a clean initial agent worktree');
  if(attempts.length && snapshotSha(before)!==attempts.at(-1)!.afterSha256)
    throw Error('Worktree differs from saved previous edit; no overwrite or reset');
  const startedAt=now();
  const start={taskId:s.taskId,ordinal,startedAt,snapshot:before};
  const startBody=JSON.stringify(start,null,2)+'\n';
  await writeWorkflowArtifact(config.outputDir,s.taskId,`edit-start-${ordinal}.json`,startBody);
  let curr=await writeTransition(config.outputDir,s,{status:'RUNNING',fixRetries:Math.max(0,substantiveBefore-1),
    activeEditAttempt:{ordinal,startedAt,beforeSha256:snapshotSha(before),startFileSha256:hex(startBody)},lastError:null},
    'CODE_EDIT_STARTED',`Codex source modification attempt ${ordinal}/3`);
  let claimed:EditResult|undefined;
  let error:string|undefined;
  try{claimed=validateResult(await execute(approved.worktree,promptForEdit(s,approved.diagnosis,substantiveBefore+1),
    join(config.outputDir,'tasks',s.taskId),ordinal));}
  catch(e){error=String(e instanceof Error?e.message:e).slice(0,1000);}
  let after:Snapshot|undefined;
  try{after=await snapshotWorktree(approved.worktree);}catch(e){error='WORKTREE_INSPECTION_FAILED: '+String(e).slice(0,350);}
  const changed=after?pathsAllowed(before,after,approved.diagnosis.candidateFiles):{changes:[],forbidden:[]};
  const headChanged=!!after&&(after.head!==before.head || after.root!==before.root || after.indexSha256!==before.indexSha256);
  const outcome:EditAttempt['outcome']=!after||headChanged||changed.forbidden.length?'BLOCKED':
    error||changed.changes.length===0?'FAILED':'COMPLETED';
  if(!error&&changed.changes.length===0)error='NO_SOURCE_CHANGE';
  if(headChanged)error='WORKTREE_HEAD_PATH_OR_INDEX_CHANGED';
  if(changed.forbidden.length)error='OUT_OF_SCOPE_FILE_CHANGES';
  const attempt:EditAttempt={ordinal,startedAt,finishedAt:now(),outcome,
    beforeSha256:snapshotSha(before),afterSha256:after?snapshotSha(after):undefined,
    changedFiles:changed.changes,forbiddenFiles:changed.forbidden,error};
  const {recordSha}=await saveEditRecord(config,s,attempt,approved.diagnosis,before,after,claimed);
  attempt.recordSha256=recordSha;
  if(after)try{await writeDiff(config,s,approved.worktree,ordinal,changed.changes);}catch(e){
    // A missing diff is not permission to advance. Evidence must remain complete.
    attempt.outcome='BLOCKED';attempt.error='GIT_DIFF_EVIDENCE_FAILED: '+String(e).slice(0,200);
    const rec=await saveEditRecord(config,s,attempt,approved.diagnosis,before,after,claimed);attempt.recordSha256=rec.recordSha;
  }
  const ok=attempt.outcome==='COMPLETED';
  const substantiveAfter=substantiveBefore+(isSchemaInfrastructureFailure(attempt)?0:1);
  const exemptAfter=ordinal-substantiveAfter;
  const exhausted=substantiveAfter>=3 || exemptAfter>=3 || ordinal>=6;
  curr=await writeTransition(config.outputDir,curr,{editHistory:[...attempts,attempt],activeEditAttempt:null,
    fixRetries:Math.max(0,substantiveAfter-1),
    phase:ok?'FINAL_VERIFY':'MODIFYING',status:ok?'READY':attempt.outcome==='BLOCKED'||exhausted?'BLOCKED':'PAUSED',
    lastError:ok?'FINAL_INDEPENDENT_VERIFICATION_REQUIRED':exhausted?'FIX_RETRIES_EXHAUSTED':attempt.error??'CODEX_EDIT_FAILED'},
    ok?'CODE_EDIT_COMPLETED':'CODE_EDIT_STOPPED',`Edit attempt ${ordinal} ${attempt.outcome}; independent final verification ${ok?'required':'not authorized'}`);
  return curr;
}
/** Explicit administrative repair for the known F7 missing output-schema defect.
 * All three attempts must be signed, contain no file changes, and have identical
 * snapshots. No evidence is erased and no source file is modified by this function.
 * Only call while holding the workflow lock.
 */
export async function resumeBlockedSchemaInfrastructureFailure(config:HarnessConfig,s:WorkflowState):Promise<WorkflowState> {
  if(s.phase!=='MODIFYING'||s.status!=='BLOCKED'||s.lastError!=='FIX_RETRIES_EXHAUSTED'||s.activeEditAttempt)
    throw Error('Expected blocked F7 schema infrastructure failure');
  const attempts=s.editHistory??[];
  if(attempts.length!==3||attempts.some(a=>!isSchemaInfrastructureFailure(a)))
    throw Error('Non-infrastructure edit attempt detected; recovery refused');
  if(!await phaseC2EvidenceIntact(config,s))
    throw Error('Saved edit evidence hashes do not match; recovery refused');
  const taskPath=join(config.outputDir,'tasks',s.taskId);
  for(const a of attempts){
    const expected=JSON.parse(await readFile(join(taskPath,`edit-schema-${a.ordinal}.json`),'utf8')) as {type?:string};
    if(expected.type!=='object')throw Error('The recorded Codex output schema is not valid');
    const erroneous=await lstat(join(taskPath,`codex-edit-schema-${a.ordinal}.json`)).catch(()=>null);
    if(erroneous)throw Error('Old erroneous schema file unexpectedly exists; manual review required');
  }
  const approval=await loadAuthorization(config,{...s,status:'PAUSED'});
  const snapshot=await snapshotWorktree(approval.worktree);
  if(snapshotSha(snapshot)!==attempts.at(-1)!.afterSha256||snapshot.status!==approval.sourceStatus||snapshot.head!==approval.head)
    throw Error('Isolated worktree changed after schema failures; recovery refused');
  return writeTransition(config.outputDir,s,{status:'PAUSED',lastError:'SCHEMA_INFRASTRUCTURE_FAILURE_RECOVERED',fixRetries:0},
    'SCHEMA_INFRASTRUCTURE_RECOVERED',
    'Three signed Codex schema-read failures had no source changes; the three substantive edit attempts remain available');
}
/** Manual recovery only. Never starts Codex, resets files, or approves a final verdict. */
export async function reconcileInterruptedEdit(config:HarnessConfig,s:WorkflowState):Promise<WorkflowState>{
  if(s.phase!=='MODIFYING'||s.status!=='PAUSED'||!s.activeEditAttempt)
    throw Error('No interrupted editing attempt awaiting reconciliation');
  const approved=await loadAuthorization(config,s);
  const a=s.activeEditAttempt;
  const dir=join(config.outputDir,'tasks',s.taskId);
  const text=await readFile(join(dir,`edit-start-${a.ordinal}.json`),'utf8');
  if(hex(text)!==a.startFileSha256)throw Error('Interrupted edit start evidence hash mismatch');
  const prior=JSON.parse(text) as {snapshot:Snapshot};
  if(snapshotSha(prior.snapshot)!==a.beforeSha256)throw Error('Interrupted edit snapshot hash mismatch');
  const after=await snapshotWorktree(approved.worktree);
  const {changes,forbidden}=pathsAllowed(prior.snapshot,after,approved.diagnosis.candidateFiles);
  const wrongHead=after.head!==prior.snapshot.head || after.indexSha256!==prior.snapshot.indexSha256;
  const outcome:EditAttempt['outcome']=forbidden.length||wrongHead?'BLOCKED':'INTERRUPTED_REVIEWED';
  const attempt:EditAttempt={ordinal:a.ordinal,startedAt:a.startedAt,finishedAt:now(),outcome,
    beforeSha256:a.beforeSha256,afterSha256:snapshotSha(after),changedFiles:changes,
    forbiddenFiles:forbidden,error:wrongHead?'WORKTREE_HEAD_CHANGED':forbidden.length?'OUT_OF_SCOPE_FILE_CHANGES':'INTERRUPTED_EDIT_ACKNOWLEDGED'};
  const {recordSha}=await saveEditRecord(config,s,attempt,approved.diagnosis,prior.snapshot,after,undefined);
  attempt.recordSha256=recordSha;
  await writeDiff(config,s,approved.worktree,a.ordinal,changes);
  return writeTransition(config.outputDir,s,{editHistory:[...(s.editHistory??[]),attempt],activeEditAttempt:null,
    status:outcome==='BLOCKED'||a.ordinal>=3?'BLOCKED':'PAUSED',fixRetries:Math.max(0,substantiveEditCount([...(s.editHistory??[]),attempt])-1),
    lastError:outcome==='BLOCKED'?attempt.error!:'INTERRUPTED_EDIT_REVIEWED'},
    'INTERRUPTED_EDIT_RECONCILED',`Human explicitly acknowledged interrupted attempt ${a.ordinal}; no automatic replay`);
}
export async function phaseC2EvidenceIntact(config:HarnessConfig,s:WorkflowState):Promise<boolean>{
  const dir=join(config.outputDir,'tasks',s.taskId);
  try{
    for(const a of s.editHistory??[]){
      const body=await readFile(join(dir,`edit-${a.ordinal}.json`),'utf8');
      if(hex(body)!==a.recordSha256)return false;
      const start=await readFile(join(dir,`edit-start-${a.ordinal}.json`),'utf8');
      const parsed=JSON.parse(start) as {snapshot:Snapshot};
      if(snapshotSha(parsed.snapshot)!==a.beforeSha256)return false;
    }
    if(s.activeEditAttempt){
      const a=s.activeEditAttempt;
      const text=await readFile(join(dir,`edit-start-${a.ordinal}.json`),'utf8');
      if(hex(text)!==a.startFileSha256)return false;
    }
  }catch{return false;}
  return true;
}
