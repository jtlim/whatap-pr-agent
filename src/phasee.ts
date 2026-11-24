/** Phase E: evidence-gated Git submission. No merge, branch reset, force push or automatic recovery. */
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {phaseCEvidenceIntact,inspectAgentWorktree} from './phasec.js';
import {phaseC2EvidenceIntact,snapshotWorktree} from './phasec2.js';
import {phaseDEvidenceIntact} from './phased.js';
import {hashFile,writeTransition,writeWorkflowArtifact,type WorkflowState,type SubmissionState} from './workflow.js';
import type {HarnessConfig} from './types.js';
import {buildSubmissionReport,type CompleteReport} from './submission-report.js';

const execFile=promisify(execFileCb);
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
const validSha=(x:unknown):x is string=>typeof x==='string' && /^[a-f0-9]{40,64}$/.test(x);
const now=()=>new Date().toISOString();
const safePath=(s:string)=>!!s&&!s.startsWith('/')&&!s.startsWith('-')&&!s.includes('\\')&&
  !s.split('/').some(p=>!p||p==='.'||p==='..')&&s.length<500;
const same=(a:string[],b:string[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const sorted=(a:string[])=>[...a].sort();

async function command(bin:string,args:string[],cwd?:string,limit=60000,buffer=2*1024*1024):Promise<string>{
  const {stdout}=await execFile(bin,args,{cwd,timeout:limit,maxBuffer:buffer,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'}});
  return stdout;
}
const git=(wt:string,...args:string[])=>command('git',['-C',wt,...args]);
function pathsFromStatus(s:string):string[]{
  const records=s.split('\0').filter(Boolean);
  return records.map(rec=>{
    if(rec.length<4||rec[2]!==' '||/[RCU]/.test(rec.slice(0,2)))throw Error('Unsupported Git index or rename state; inspect manually');
    const p=rec.slice(3);
    if(!safePath(p))throw Error('Unsafe Git path in status');
    return p;
  });
}
async function localStatus(wt:string):Promise<string[]>{
  return pathsFromStatus(await git(wt,'status','--porcelain=v1','-z','--untracked-files=all'));
}
export interface PrInfo {number:number;url:string;headOid:string;headRefName:string;baseRefName:string;
  body:string;state:'OPEN'|'MERGED'|'CLOSED';mergedAt?:string|null;}
export interface SubmissionHost {
  remoteHeads(worktree:string):Promise<{agent:string|null;submission:string|null}>;
  publish(worktree:string,commitSha:string):Promise<void>;
  listOpen(worktree:string):Promise<PrInfo[]>;
  createPr(worktree:string,title:string,body:string):Promise<PrInfo>;
  viewPr(worktree:string,number:number):Promise<PrInfo>;
  publishReportParts?(worktree:string,prNumber:number,taskId:string,parts:string[]):Promise<void>;
  reportPartsMatch?(worktree:string,prNumber:number,taskId:string,parts:string[]):Promise<boolean>;
}
const prFields='number,url,headRefOid,headRefName,baseRefName,body,state,mergedAt';
async function repoSlug(wt:string):Promise<string>{
  const slug=(await command('gh',['repo','view','--json','nameWithOwner','--jq','.nameWithOwner'],wt)).trim();
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug))throw Error('Unsafe GitHub repository slug');
  return slug;
}
async function botLogin(wt:string):Promise<string>{
  const name=(await command('gh',['api','user','--jq','.login'],wt)).trim();
  if(!/^[A-Za-z0-9-]+$/.test(name))throw Error('Cannot verify authenticated bot identity');
  return name;
}
const partMarker=(taskId:string,i:number,body:string)=>`<!-- whatap-harness-evidence:${taskId}:${i+1}:${sha(body)} -->`;
async function reportComments(wt:string,pr:number):Promise<Array<{body:string;login:string}>>{
  const slug=await repoSlug(wt);
  const raw=await command('gh',['api',`repos/${slug}/issues/${pr}/comments?per_page=100`],wt,120000,12000000);
  const comments=JSON.parse(raw);
  if(!Array.isArray(comments))throw Error('Invalid GitHub issue comments listing');
  return comments.map(x=>({body:String(x.body??''),login:String(x.user?.login??'')}));
}
async function matchParts(wt:string,pr:number,taskId:string,parts:string[]):Promise<boolean>{
  const own=await botLogin(wt),comments=(await reportComments(wt,pr)).filter(c=>c.login===own);
  return parts.every((body,i)=>{
    const marker=partMarker(taskId,i,body);
    const matches=comments.filter(c=>c.body.startsWith(`<!-- whatap-harness-evidence:${taskId}:${i+1}:`));
    return matches.length===1&&matches[0].body===marker+'\n'+body;
  });
}

function parsePr(o:any):PrInfo{
  if(!o||!Number.isSafeInteger(o.number)||o.number<=0||typeof o.url!=='string'||
    !/^https:\/\//.test(o.url)||!validSha(o.headRefOid)||typeof o.body!=='string'||
    o.headRefName!=='agent'||o.baseRefName!=='submission'||!['OPEN','MERGED','CLOSED'].includes(o.state))
    throw Error('GitHub PR identity or base/head is invalid');
  return {number:o.number,url:o.url,headOid:o.headRefOid,headRefName:o.headRefName,
    baseRefName:o.baseRefName,body:o.body,state:o.state,mergedAt:o.mergedAt??null};
}
export const realSubmissionHost:SubmissionHost={
  async remoteHeads(wt){
    const out=await git(wt,'ls-remote','--heads','origin','refs/heads/agent','refs/heads/submission');
    const found=new Map<string,string>();
    for(const line of out.split('\n').filter(Boolean)){
      const m=/^([a-f0-9]{40,64})\s+refs\/heads\/(agent|submission)$/.exec(line);
      if(!m)throw Error('Unexpected remote ref response');found.set(m[2],m[1]);
    }
    return {agent:found.get('agent')??null,submission:found.get('submission')??null};
  },
  async publish(wt,commitSha){await git(wt,'push','origin',`${commitSha}:refs/heads/agent`);},
  async listOpen(wt){
    const data=JSON.parse(await command('gh',['pr','list','--head','agent','--base','submission','--state','open',
      '--json',prFields],wt));
    if(!Array.isArray(data))throw Error('Invalid PR listing');return data.map(parsePr);
  },
  async createPr(wt,title,body){
    await command('gh',['pr','create','--base','submission','--head','agent','--title',title,'--body',body],wt);
    // Re-query; never infer PR number or identity from free-form CLI stdout.
    const prs=await realSubmissionHost.listOpen(wt);
    if(prs.length!==1)throw Error('PR created but cannot identify exactly one matching PR');
    return prs[0];
  },
  async viewPr(wt,num){return parsePr(JSON.parse(await command('gh',['pr','view',String(num),'--json',prFields],wt)));},
  async reportPartsMatch(wt,pr,taskId,parts){return matchParts(wt,pr,taskId,parts);},
  async publishReportParts(wt,pr,taskId,parts){
    const slug=await repoSlug(wt),own=await botLogin(wt);
    const previous=(await reportComments(wt,pr)).filter(c=>c.login===own);
    for(let i=0;i<parts.length;i++){
      const marker=partMarker(taskId,i,parts[i]);
      const existing=previous.filter(c=>c.login===own&&
        c.body.startsWith(`<!-- whatap-harness-evidence:${taskId}:${i+1}:`));
      if(existing.length){
        if(existing.length!==1||existing[0].body!==marker+'\n'+parts[i])
          throw Error('Existing public evidence part conflicts with approved local hash');
        continue; // Idempotent publication after a lost API response.
      }
      const body=marker+'\n'+parts[i];
      const sent=JSON.parse(await command('gh',['api',`repos/${slug}/issues/${pr}/comments`,
        '--method','POST','-f',`body=${body}`],wt,120000,12000000));
      if(sent.body!==body||sent.user?.login!==own)throw Error('Published PR comment not confirmed');
      previous.push({body,login:own});
    }
    if(!(await matchParts(wt,pr,taskId,parts)))throw Error('Published evidence comments mismatch');
  },
};

async function approved(config:HarnessConfig,s:WorkflowState):Promise<{
 worktree:string;head:string;baseHead:string;files:string[];snapshot:string;fileManifestSha:string;finalSha:string;finalArtifactSha:string;
}>{
  if(s.phase!=='COMMITTING'||s.status!=='PAUSED'||!s.analysis||!s.preFix?.reproduced||
    (!s.preFix.sameAbsolutePeriod&&s.preFix.mode!=='PERIOD_PAIRED')||!s.editHistory?.length)
    throw Error(`FINAL_VERIFY_PASS_REQUIRED: ${s.phase}/${s.status}`);
  // F2 public-data publication is permitted only with an explicit acknowledgement.
  // Every actual comparison value must be reconstructed from hashed evidence before Git.
  if(s.preFix.mode==='PERIOD_PAIRED' && process.env.HARNESS_PUBLISH_PUBLIC_METRICS!=='YES')
    throw Error('PUBLIC_METRICS_CONFIRMATION_REQUIRED: do not publish real service metrics without authorization');
  const edit=s.editHistory.at(-1)!;
  const finals=(s.validationHistory??[]).filter(a=>a.phase==='FINAL_VERIFY'&&a.editOrdinal===edit.ordinal);
  const final=finals.at(-1);
  if(edit.outcome!=='COMPLETED'||!edit.afterSha256||!edit.changedFiles.length||
    !final||final.verdict!=='PASS'||!final.artifactName||!final.artifactSha256||
    !final.evidence||final.evidence.verdict!=='PASS'||s.latestValidation?.reportSha256!==final.evidence.reportSha256)
    throw Error('Final PASS for latest edited revision is not established');
  if(!(await phaseCEvidenceIntact(config,s))||!(await phaseC2EvidenceIntact(config,s))||
    !(await phaseDEvidenceIntact(config,s))||
    await hashFile(join(final.evidence.runDir,'report.json'))!==final.evidence.reportSha256)
    throw Error('Historical verification evidence checksum mismatch');
  const worktree=await inspectAgentWorktree(s.analysis.worktree);
  if(worktree.head!==s.analysis.head)throw Error('agent HEAD differs from source reviewed in Phase C1');
  const snap=sha(JSON.stringify(await snapshotWorktree(worktree.path)));
  if(snap!==edit.afterSha256)throw Error('Source edited after final independent PASS');
  const changed=sorted(edit.changedFiles);
  if(changed.some(p=>!safePath(p))||new Set(changed).size!==changed.length)throw Error('Unsafe source path in edit evidence');
  const actual=sorted(await localStatus(worktree.path));
  if(!same(actual,changed))throw Error(`Worktree paths disagree with verified edits: actual=${actual.join(',')}`);
  if((await git(worktree.path,'diff','--cached','--name-only')).trim())throw Error('Pre-staged Git index changes are forbidden');
  const baseHead=(await git(worktree.path,'rev-parse','refs/heads/submission')).trim();
  if(!validSha(baseHead))throw Error('Local submission HEAD missing');
  await git(worktree.path,'merge-base','--is-ancestor',baseHead,worktree.head);
  return {worktree:worktree.path,head:worktree.head,baseHead,files:changed,snapshot:snap,
    fileManifestSha:sha(JSON.stringify((await snapshotWorktree(worktree.path)).files)),
    finalSha:final.evidence.reportSha256,finalArtifactSha:final.artifactSha256};
}
function doc(x:unknown):string{return JSON.stringify(x,null,2)+'\n';}
async function artifact(config:HarnessConfig,s:WorkflowState,name:string,data:unknown):Promise<string>{
  const content=doc(data);await writeWorkflowArtifact(config.outputDir,s.taskId,name,content);return sha(content);
}
async function assertRemote(host:SubmissionHost,wt:string,agent:string,base:string):Promise<void>{
  const remote=await host.remoteHeads(wt);
  if(remote.agent!==agent||remote.submission!==base)throw Error(
    `Remote branch changed or missing (agent=${remote.agent??'absent'},submission=${remote.submission??'absent'}); no force push`);
}
async function commitStep(config:HarnessConfig,s:WorkflowState,host:SubmissionHost):Promise<WorkflowState>{
  const g=await approved(config,s);
  const paired=s.preFix?.mode==='PERIOD_PAIRED';
  if(paired&&(!host.publishReportParts||!host.reportPartsMatch))
    throw Error('PUBLIC_REPORT_HOST_CAPABILITIES_MISSING');
  const report=paired?await buildSubmissionReport(config,s,{publishMetrics:true}):null;
  // Finish every report gate before the first Git side effect.
  await assertRemote(host,g.worktree,g.head,g.baseHead);
  const proof:SubmissionState={initialHead:g.head,baseHead:g.baseHead,snapshotSha256:g.snapshot,
    finalReportSha256:g.finalSha,finalArtifactSha256:g.finalArtifactSha};
  const reportSha=report?await artifact(config,s,'publication-report.json',report):null;
  proof.intentSha256=await artifact(config,s,'submit-intent.json',{pubReportSha256:reportSha,
    taskId:s.taskId,at:now(),stage:'COMMITTING',branch:'agent',baseBranch:'submission',
    originalHead:g.head,baseHead:g.baseHead,verifiedFiles:g.files,sourceSha256:g.snapshot,
    finalEvidenceSha256:g.finalSha,finalArtifactSha256:g.finalArtifactSha,remoteVerified:true});
  let cur=await writeTransition(config.outputDir,s,{submission:proof,status:'RUNNING',lastError:null},
    'GIT_COMMIT_STARTED','Durable intent saved before staging and committing approved files');
  try{
    await git(g.worktree,'add','-A','--',...g.files);
    const staged=sorted((await git(g.worktree,'diff','--cached','--name-only','-z')).split('\0').filter(Boolean));
    if(!same(staged,g.files))throw Error('Staged paths differ from Phase D approved source changes');
    if(sha(JSON.stringify((await snapshotWorktree(g.worktree)).files))!==g.fileManifestSha)
      throw Error('Source changed between preflight and Git staging');
    const msg=`fix(mcp): ${s.scenarioId} verified (${s.taskId})`;
    await git(g.worktree,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m',msg);
    const newHead=(await git(g.worktree,'rev-parse','HEAD')).trim();
    if(!validSha(newHead)||newHead===g.head||(await git(g.worktree,'rev-parse','HEAD^')).trim()!==g.head)
      throw Error('Unexpected commit ancestry');
    if((await localStatus(g.worktree)).length)throw Error('Unexpected Git changes remained after commit');
    const committed=sorted((await git(g.worktree,'diff','--name-only','-z',g.head,newHead)).split('\0').filter(Boolean));
    if(!same(committed,g.files))throw Error('Committed file list diverges from approved edits');
    if((await git(g.worktree,'rev-parse','refs/heads/submission')).trim()!==g.baseHead)
      throw Error('submission branch mutated during commit');
    const commitEvidence=await artifact(config,s,'submit-commit.json',{
      taskId:s.taskId,at:now(),parent:g.head,commit:newHead,baseHead:g.baseHead,files:committed});
    cur=await writeTransition(config.outputDir,cur,{phase:'PUSHING',status:'PAUSED',lastError:null,
      submission:{...proof,commitSha:newHead,commitSha256:commitEvidence}},
      'GIT_COMMITTED',`Committed approved agent changes to ${newHead}; remote not yet modified`);
    return cur;
  }catch(e){await writeTransition(config.outputDir,cur,{status:'BLOCKED',lastError:'GIT_COMMIT_RECONCILIATION_REQUIRED'},
    'GIT_COMMIT_BLOCKED',String(e).slice(0,200));throw e;}
}
async function verifyCommitted(config:HarnessConfig,s:WorkflowState):Promise<{wt:string;p:SubmissionState}>{
  const p=s.submission;
  if(!p||!validSha(p.commitSha)||!validSha(p.commitSha256)||!validSha(p.initialHead)||!validSha(p.baseHead))
    throw Error('Committed evidence missing');
  if(await hashFile(join(config.outputDir,'tasks',s.taskId,'submit-commit.json'))!==p.commitSha256)
    throw Error('Commit evidence tampering detected');
  const wt=(await inspectAgentWorktree(s.analysis!.worktree)).path;
  if((await git(wt,'rev-parse','HEAD')).trim()!==p.commitSha||
    (await git(wt,'rev-parse','HEAD^')).trim()!==p.initialHead||
    (await git(wt,'rev-parse','refs/heads/submission')).trim()!==p.baseHead||
    (await localStatus(wt)).length)throw Error('Git working state changed since approved commit');
  return {wt,p};
}
async function pushStep(config:HarnessConfig,s:WorkflowState,host:SubmissionHost):Promise<WorkflowState>{
  if(s.phase!=='PUSHING'||s.status!=='PAUSED')throw Error('Not ready for Push');
  const {wt,p}=await verifyCommitted(config,s);
  await assertRemote(host,wt,p.initialHead,p.baseHead);
  let cur=await writeTransition(config.outputDir,s,{status:'RUNNING'},'GIT_PUSH_STARTED','Remote precondition verified before push');
  try{
    await host.publish(wt,p.commitSha!);
    await assertRemote(host,wt,p.commitSha!,p.baseHead);
    const pushEvidence=await artifact(config,s,'submit-push.json',{
      taskId:s.taskId,at:now(),remote:'origin',branch:'agent',pushed:p.commitSha,baseHead:p.baseHead,force:false});
    cur=await writeTransition(config.outputDir,cur,{phase:'CREATING_PR',status:'PAUSED',lastError:null,
      submission:{...p,pushSha256:pushEvidence}},'GIT_PUSH_VERIFIED','origin/agent updated; submission untouched');
    return cur;
  }catch(e){await writeTransition(config.outputDir,cur,{status:'BLOCKED',lastError:'GIT_PUSH_RECONCILIATION_REQUIRED'},
    'GIT_PUSH_BLOCKED',String(e).slice(0,200));throw e;}
}
function prMatches(pr:PrInfo,s:WorkflowState,p:SubmissionState):boolean{
  return pr.state==='OPEN'&&pr.headOid===p.commitSha&&pr.headRefName==='agent'&&
    pr.baseRefName==='submission'&&pr.body.includes(s.taskId);
}
async function savePr(config:HarnessConfig,s:WorkflowState,p:SubmissionState,pr:PrInfo):Promise<WorkflowState>{
  const prSha=await artifact(config,s,'submit-pr.json',{
    taskId:s.taskId,at:now(),number:pr.number,url:pr.url,headOid:pr.headOid,
    head:pr.headRefName,base:pr.baseRefName,state:pr.state});
  return writeTransition(config.outputDir,s,{phase:'PR_OPEN',status:'PR_OPEN',lastError:null,
    submission:{...p,prNumber:pr.number,prUrl:pr.url,prSha256:prSha}},'PR_OPENED',
    `PR #${pr.number} created/identified; HUMAN review + merge only`);
}
async function prStep(config:HarnessConfig,s:WorkflowState,host:SubmissionHost):Promise<WorkflowState>{
  if(s.phase!=='CREATING_PR'||s.status!=='PAUSED')throw Error('Not ready for PR');
  const {wt,p}=await verifyCommitted(config,s);
  if(!p.pushSha256||await hashFile(join(config.outputDir,'tasks',s.taskId,'submit-push.json'))!==p.pushSha256)
    throw Error('Push verification evidence missing/tampered');
  await assertRemote(host,wt,p.commitSha!,p.baseHead);
  const existing=await host.listOpen(wt);
  if(existing.some(x=>!prMatches(x,s,p))||existing.length>1)
    throw Error('agent->submission has unrelated or ambiguous open PR; manual review required');
  const paired=s.preFix?.mode==='PERIOD_PAIRED';
  let complete:CompleteReport|null=null;
  if(paired){
    const intent=JSON.parse(await readFile(join(config.outputDir,'tasks',s.taskId,'submit-intent.json'),'utf8'));
    const publication=join(config.outputDir,'tasks',s.taskId,'publication-report.json');
    if(!intent.pubReportSha256||await hashFile(publication)!==intent.pubReportSha256)
      throw Error('PUBLIC_REPORT_EVIDENCE_TAMPERED');
    complete=JSON.parse(await readFile(publication,'utf8')) as CompleteReport;
    if(!complete.body.includes(s.taskId)||!Array.isArray(complete.parts)||!complete.parts.length||
      !host.publishReportParts||!host.reportPartsMatch)throw Error('PUBLIC_REPORT_INCOMPLETE');
  }
  let cur=await writeTransition(config.outputDir,s,{status:'RUNNING'},'PR_CREATION_STARTED','Checking/creating GitHub PR');
  try{
    const body=`## WhaTap Harness validated MCP correction\n\nTask: ${s.taskId}\nScenario: ${s.scenarioId}\nIndependent final verification: PASS\nSource commit: ${p.commitSha}\nValidation report SHA-256: ${p.finalReportSha256}\n\nOriginal raw evidence remains private in Harness runs/; no credentials or metric payloads are attached.\n\n**Human review and merge required. Harness must not auto-merge.**`;
    const reportBody=complete?.body??body;
    const title=complete?.title??`fix(mcp): ${s.scenarioId} [${s.taskId}]`;
    const pr=existing[0]??await host.createPr(wt,title,reportBody);
    const checked=await host.viewPr(wt,pr.number);
    if(!prMatches(checked,s,p)|| (complete&&checked.body!==reportBody))
      throw Error('Created PR identity/body does not match approved evidence');
    if(complete){
      await host.publishReportParts!(wt,pr.number,s.taskId,complete.parts);
      if(!(await host.reportPartsMatch!(wt,pr.number,s.taskId,complete.parts)))
        throw Error('Published public evidence is not complete');
    }
    return await savePr(config,cur,p,checked);
  }catch(e){await writeTransition(config.outputDir,cur,{status:'BLOCKED',lastError:'PR_RECONCILIATION_REQUIRED'},
    'PR_CREATION_BLOCKED',String(e).slice(0,200));throw e;}
}
/** Direct git operations always require the explicit command flag; dry-run is read only and offline. */
export async function submitTask(config:HarnessConfig,s:WorkflowState,host:SubmissionHost=realSubmissionHost,
  dryRun=false):Promise<WorkflowState>{
  if(dryRun){await approved(config,s);return s;}
  if(!(['COMMITTING','PUSHING','CREATING_PR'].includes(s.phase) && s.status==='PAUSED'))
    throw Error(`FINAL_VERIFY_PASS_REQUIRED or submission already handled: ${s.phase}/${s.status}`);
  let cur=s;
  if(cur.phase==='COMMITTING')cur=await commitStep(config,cur,host);
  if(cur.phase==='PUSHING')cur=await pushStep(config,cur,host);
  if(cur.phase==='CREATING_PR')cur=await prStep(config,cur,host);
  if(cur.phase!=='PR_OPEN'||cur.status!=='PR_OPEN')throw Error(`Submission incomplete: ${cur.phase}/${cur.status}`);
  return cur;
}
/** External side effects may have completed during a crash. An acknowledgement is needed before any replay. */
export async function reconcileSubmission(config:HarnessConfig,s:WorkflowState,host:SubmissionHost=realSubmissionHost):Promise<WorkflowState>{
  if(!['COMMITTING','PUSHING','CREATING_PR'].includes(s.phase)||s.status!=='BLOCKED')
    throw Error('Only interrupted/blocked external Git stage is reconcilable');
  if(!s.submission)throw Error('Durable Git intent not found');
  const p=s.submission,wt=(await inspectAgentWorktree(s.analysis!.worktree)).path;
  if(!validSha(p.intentSha256)||await hashFile(join(config.outputDir,'tasks',s.taskId,'submit-intent.json'))!==p.intentSha256)
    throw Error('Git intent evidence modified or missing');
  if(s.phase==='COMMITTING'){
    const head=(await git(wt,'rev-parse','HEAD')).trim();
    if(head===p.initialHead && !(await git(wt,'diff','--cached','--name-only')).trim()){
      // No commit was made; only an explicit acknowledgement reopens the gate.
      return writeTransition(config.outputDir,s,{status:'PAUSED',lastError:null},'GIT_COMMIT_RECONCILED','No commit and no staged files; explicit retry permitted');
    }
    if((await git(wt,'rev-parse','HEAD^')).trim()!==p.initialHead||
      !(await git(wt,'log','-1','--format=%B')).includes(s.taskId)||
      (await localStatus(wt)).length)throw Error('Commit cannot be safely attributed to this task');
    const files=sorted((await git(wt,'diff','--name-only','-z',p.initialHead,head)).split('\0').filter(Boolean));
    const intent=JSON.parse(await readFile(join(config.outputDir,'tasks',s.taskId,'submit-intent.json'),'utf8'));
    if(!same(files,sorted(intent.verifiedFiles??[])) ||
      (await git(wt,'rev-parse','refs/heads/submission')).trim()!==p.baseHead)
      throw Error('Reconciled commit differs from originally approved files/base');
    const commitEvidence=await artifact(config,s,'submit-commit.json',{
      taskId:s.taskId,at:now(),parent:p.initialHead,commit:head,baseHead:p.baseHead,files});
    return writeTransition(config.outputDir,s,{phase:'PUSHING',status:'PAUSED',lastError:null,
      submission:{...p,commitSha:head,commitSha256:commitEvidence}},'GIT_COMMIT_RECONCILED',
      'Existing task commit identified after explicit manual acknowledgement');
  }
  const {p:approvedCommit}=await verifyCommitted(config,s);
  const remote=await host.remoteHeads(wt);
  if(remote.submission!==p.baseHead)throw Error('submission remote moved; no automatic recovery');
  if(s.phase==='PUSHING'){
    if(remote.agent===p.initialHead)
      return writeTransition(config.outputDir,s,{status:'PAUSED',lastError:null},'GIT_PUSH_RECONCILED','Push did not reach remote; retry permitted');
    if(remote.agent!==p.commitSha)throw Error('Remote agent moved to unknown commit');
    const pushEvidence=await artifact(config,s,'submit-push.json',{
      taskId:s.taskId,at:now(),remote:'origin',branch:'agent',pushed:p.commitSha,baseHead:p.baseHead,force:false});
    return writeTransition(config.outputDir,s,{phase:'CREATING_PR',status:'PAUSED',lastError:null,
      submission:{...approvedCommit,pushSha256:pushEvidence}},'GIT_PUSH_RECONCILED',
      'Remote already has approved agent commit; no duplicate push');
  }
  if(remote.agent!==p.commitSha)throw Error('PR cannot be recovered: wrong remote head');
  const found=await host.listOpen(wt);
  if(found.length>1||found.some(pr=>!prMatches(pr,s,p)))throw Error('Ambiguous/unrelated PR; manual review required');
  if(found.length===1){
    const checked=await host.viewPr(wt,found[0].number);
    if(!prMatches(checked,s,p))throw Error('Existing PR identity changed during reconciliation');
    if(s.preFix?.mode==='PERIOD_PAIRED'){
      const intent=JSON.parse(await readFile(join(config.outputDir,'tasks',s.taskId,'submit-intent.json'),'utf8'));
      const publication=join(config.outputDir,'tasks',s.taskId,'publication-report.json');
      if(!intent.pubReportSha256||await hashFile(publication)!==intent.pubReportSha256)
        throw Error('Public report integrity unknown after PR creation');
      const report=JSON.parse(await readFile(publication,'utf8')) as CompleteReport;
      if(checked.body!==report.body||!host.reportPartsMatch||
        !(await host.reportPartsMatch(wt,checked.number,s.taskId,report.parts)))
        throw Error('Public PR evidence incomplete: human reconciliation required before trusting PR');
    }
    return savePr(config,s,p,checked);
  }
  return writeTransition(config.outputDir,s,{status:'PAUSED',lastError:null},'PR_CREATION_RECONCILED',
    'No PR found; explicit new submit action may attempt create');
}
/** Human merges the PR in GitHub. This command only verifies the existing merged PR. */
export async function recordHumanMerge(config:HarnessConfig,s:WorkflowState,host:SubmissionHost=realSubmissionHost):Promise<WorkflowState>{
  if(s.phase!=='PR_OPEN'||s.status!=='PR_OPEN'||!s.submission?.prNumber||!s.submission.prSha256)
    throw Error('No submitted PR to verify');
  if(!(await phaseEEvidenceIntact(config,s)))throw Error('Submission evidence integrity failed');
  const wt=s.analysis!.worktree,pr=await host.viewPr(wt,s.submission.prNumber);
  if(pr.state!=='MERGED'||!pr.mergedAt||pr.number!==s.submission.prNumber||
    pr.url!==s.submission.prUrl||pr.headOid!==s.submission.commitSha||
    pr.headRefName!=='agent'||pr.baseRefName!=='submission')throw Error('Human-approved merge not independently confirmed');
  const mergedSha=await artifact(config,s,'submit-merge.json',{
    taskId:s.taskId,at:now(),number:pr.number,url:pr.url,mergedAt:pr.mergedAt,commit:s.submission.commitSha});
  return writeTransition(config.outputDir,s,{phase:'DONE',status:'COMPLETED',lastError:null,
    submission:{...s.submission,mergeSha256:mergedSha}},'PR_MERGE_CONFIRMED',
    'Human merged approved PR; Harness recorded verification only');
}
export async function phaseEEvidenceIntact(config:HarnessConfig,s:WorkflowState):Promise<boolean>{
  try{
    const p=s.submission;
    if(!p)return !['PUSHING','CREATING_PR','PR_OPEN'].includes(s.phase);
    if(!p.intentSha256 ||
      (['PUSHING','CREATING_PR','PR_OPEN'].includes(s.phase)&&!p.commitSha256) ||
      (['CREATING_PR','PR_OPEN'].includes(s.phase)&&!p.pushSha256) ||
      (s.phase==='PR_OPEN'&&!p.prSha256) ||
      (s.phase==='DONE' && s.status==='COMPLETED'&&!p.mergeSha256))return false;
    if(s.preFix?.mode==='PERIOD_PAIRED'&&p.intentSha256){
      const intent=JSON.parse(await readFile(join(config.outputDir,'tasks',s.taskId,'submit-intent.json'),'utf8'));
      if(!intent.pubReportSha256||
        await hashFile(join(config.outputDir,'tasks',s.taskId,'publication-report.json'))!==intent.pubReportSha256)return false;
    }
    for(const [name,key] of [['submit-intent.json',p.intentSha256],['submit-commit.json',p.commitSha256],
      ['submit-push.json',p.pushSha256],['submit-pr.json',p.prSha256],['submit-merge.json',p.mergeSha256]] as const){
      if(key && (await hashFile(join(config.outputDir,'tasks',s.taskId,name)))!==key)return false;
    }
    return true;
  }catch{return false;}
}
