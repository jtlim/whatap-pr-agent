#!/usr/bin/env node
/**
 * WhaTap Harness F2 automatic scenario runner.
 * Uses ONLY the existing audited CLI for state changes; no direct worktree edits,
 * no direct Git/GitHub side effects, and no invented verification passes.
 */
import { spawn, execFileSync } from 'node:child_process';
import { open, readFile, readdir, mkdir, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { readTask, listTasks } from '../dist/workflow.js';
import { writeCampaignReport,recoveryClass } from './campaign-report.mjs';

process.umask(0o077);
const argv = process.argv.slice(2);
function option(flag) { const index=argv.indexOf(flag); if(index<0)return null; const x=argv[index+1]; if(!x||x.startsWith('--'))throw Error(`Missing ${flag}`); return x; }
function ensureKnown(){
  const withValue=new Set(['--config','--worktree','--scenario','--max-actions']);
  const booleans=new Set(['--auto-edit','--continue-on-blocked','--allow-git-submit','--publish-public-metrics']);
  for(let i=0;i<argv.length;i++){
    if(withValue.has(argv[i])){i++;if(i>=argv.length)throw Error('Missing option value');continue;}
    if(!booleans.has(argv[i]))throw Error(`Unknown option ${argv[i]}`);
  }
}
ensureKnown();
const has=x=>argv.includes(x);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=resolve(option('--config')||join(root,'config/harness.json'));
const worktree=resolve(option('--worktree')||join(root,'../whatap-open-mcp-agent'));
const maxActions=Number(option('--max-actions')||'80');
if(!Number.isSafeInteger(maxActions)||maxActions<1||maxActions>500)throw Error('Invalid --max-actions (1..500)');
const allowEdit=has('--auto-edit');
const continueBlocked=has('--continue-on-blocked');
const allowGit=has('--allow-git-submit');
const publicMetrics=has('--publish-public-metrics');
if(allowGit && !has('--auto-edit'))throw Error('Git submit requires --auto-edit');
if(allowGit && !publicMetrics)throw Error('Auto PR requires --publish-public-metrics explicit acknowledgement for actual service data');
if(publicMetrics&&!allowGit)throw Error('Public metrics option requires --allow-git-submit');
if(publicMetrics)process.env.HARNESS_PUBLISH_PUBLIC_METRICS='YES';

function sanitized(s){const secrets=[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN].filter(Boolean);return secrets.reduce((str,x)=>str.replaceAll(x,'[REDACTED]'),String(s));}
async function execCli(args, timeoutMs=1200000) {
  const title=`node dist/cli.js ${args.map(s=>s.startsWith('--')?s:'…').join(' ')}`;
  console.log(`\n[AUTO] ${title}`);
  return new Promise((resolvePromise,reject)=>{
    const proc=spawn(process.execPath,[join(root,'dist/cli.js'),'task',...args,'--config',configPath],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const limit=400000;
    proc.stdout.on('data',buf=>{const s=sanitized(buf.toString());process.stdout.write(s);stdout=(stdout+s).slice(-limit);});
    proc.stderr.on('data',buf=>{const s=sanitized(buf.toString());process.stderr.write(s);stderr=(stderr+s).slice(-limit);});
    const timer=setTimeout(()=>{proc.kill('SIGTERM');},timeoutMs);
    proc.on('error',err=>{clearTimeout(timer);reject(err);});
    proc.on('close',(code,signal)=>{clearTimeout(timer);if(code===0)resolvePromise({stdout,stderr});else reject(Error(`CLI failed: exit=${code} signal=${signal||'none'}; ${stderr.slice(-1100)||stdout.slice(-1100)}`));});
  });
}
async function persist(path,obj) {
  const temp=`${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd=await open(temp,'wx',0o600);try{await fd.writeFile(JSON.stringify(obj,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  await rename(temp,path);
}
function positiveResult(state) {return state.phase==='DONE'&&state.status==='COMPLETED'&&state.latestValidation?.verdict==='PASS';}
function classify(state) {
  if(positiveResult(state))return recoveryClass(state);
  if(state.phase==='PR_OPEN'&&state.status==='PR_OPEN')return 'PR_OPEN';
  if(state.phase==='COMMITTING'&&state.status==='PAUSED')return 'VERIFIED_AWAITING_REPORT_GATE';
  if(state.status==='BLOCKED')return 'BLOCKED';
  if(state.status==='CANCELLED')return 'CANCELLED';
  return `${state.phase}/${state.status}`;
}
export function nextAction(state,{allowEdit=false,allowGit=false,continueBlocked=false}={}) {
  if(state.phase==='DONE'||state.status==='COMPLETED'||state.status==='CANCELLED')return {kind:'done'};
  if(state.phase==='PR_OPEN'&&state.status==='PR_OPEN')return {kind:'done'}; // PR submitted; only human merge remains
  if(state.status==='BLOCKED'){
    const noEdits=!state.activeEditAttempt && !(state.editHistory?.length) &&
      !['MODIFYING','FINAL_VERIFY','COMMITTING','PUSHING','CREATING_PR'].includes(state.phase);
    return continueBlocked && noEdits
      ? {kind:'close',reason:'FAILED_TASK_ARCHIVED_NOT_PASSED'} : {kind:'stop',reason:'BLOCKED_REQUIRES_REVIEW'};
  }
  if(['COMMITTING','PUSHING','CREATING_PR'].includes(state.phase)) {
    if(state.status!=='PAUSED')return {kind:'stop',reason:'GIT_SIDE_EFFECT_RECONCILIATION_REQUIRED'};
    if(!allowGit)return {kind:'stop',reason:'GIT_SUBMIT_NOT_AUTHORIZED'};
    return {kind:'submit'};
  }
  if(state.phase==='INITIAL_VERIFY')return {kind:'resume'};
  if(state.phase==='ANALYZING')return state.status==='PAUSED' && !String(state.lastError||'').startsWith('INTERRUPTED')
    ? {kind:'analyze'}:{kind:'stop',reason:'ANALYSIS_INTERRUPTED'};
  if(state.phase==='PRE_FIX_VERIFY')return {kind:'precheck'};
  if(state.phase==='MODIFYING')return state.status==='PAUSED'&&allowEdit&&
    !state.activeEditAttempt&&!/PARTIAL|INTERRUPTED/.test(String(state.lastError||''))
    ? {kind:'modify'} : {kind:'stop',reason:allowEdit?'EDIT_INTERRUPTED_OR_NOT_READY':'AUTO_EDIT_NOT_AUTHORIZED'};
  if(state.phase==='FINAL_VERIFY')return {kind:'finalcheck'};
  return {kind:'stop',reason:'UNKNOWN_WORKFLOW_STATE'};
}
async function main(){
  const {config}=await loadConfig(configPath);
  if(config.replayPolicy!=='PERIOD_PAIRED')throw Error('This runner expects F2 PERIOD_PAIRED config.');
  if(allowEdit){
    const git=(...a)=>execFileSync('git',['-C',worktree,...a],{encoding:'utf8',timeout:15000}).trim();
    if(git('branch','--show-current')!=='agent')throw Error('Auto-edit requires the agent branch, not a feature branch');
    if(git('status','--porcelain'))throw Error('Auto-edit requires a clean agent Worktree');
    if(git('rev-parse','HEAD')!==git('rev-parse','refs/heads/submission'))throw Error('Auto-edit requires agent and local submission at same commit');
    const { realpath }=await import('node:fs/promises');
    const candidate=await realpath(config.servers.candidate);
    const agentEntry=await realpath(join(worktree,'dist/index.js'));
    if(candidate!==agentEntry)throw Error('Harness candidate must point to the agent worktree/dist/index.js for auto-edit. Update config after backup.');
  }
  const ids=option('--scenario')?[option('--scenario')]:config.scenarios.map(s=>s.id);
  if(ids.some(x=>!config.scenarios.some(s=>s.id===x)))throw Error('Unknown --scenario');
  const reportDir=resolve(config.outputDir,'campaign');await mkdir(reportDir,{recursive:true,mode:0o700});
  const lockFile=join(reportDir,'.auto-campaign.lock');
  let fd;
  try{fd=await open(lockFile,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error(`Previous campaign lock exists at ${lockFile}. Confirm whether runner is still alive; NEVER delete a live lock.`);throw e;}
  const lock={pid:process.pid,createdAt:new Date().toISOString(),token:randomUUID()};
  await fd.writeFile(JSON.stringify(lock));await fd.close();
  const recordFile=join(reportDir,'latest.json');
  const campaignOptions={scenarioIds:ids,autoEdit:allowEdit,allowGit,publicMetrics,continueOnBlocked:continueBlocked};
  let prior=null;
  try{prior=JSON.parse(await readFile(recordFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const canResume=prior && prior.finished===false && Array.isArray(prior.results) &&
    JSON.stringify(prior.options)===JSON.stringify(campaignOptions);
  const results=canResume?prior.results:[];
  let totalActions=0;
  if(canResume)console.log(`[AUTO] Resuming durable campaign from ${recordFile}`);
  try {
    const active=(await listTasks(config.outputDir)).find(s=>!['COMPLETED','CANCELLED'].includes(s.status));
    if(active&&!ids.includes(active.scenarioId))throw Error(`Active unrelated task ${active.taskId} (${active.scenarioId}) blocks campaign. Do not close it automatically.`);
    const firstId=active?.scenarioId;
    const runOrder=firstId?[firstId,...ids.filter(x=>x!==firstId)]:ids;
    for(const scenarioId of runOrder){
      let item=results.find(x=>x.scenarioId===scenarioId);
      if(item && (['PASS','RECOVERED_FAIL','RECOVERED_UNMAPPED','RECOVERED_REFERENCE','PR_OPEN'].includes(item.result)||item.result?.startsWith('BLOCKED_ARCHIVED:'))){
        console.log(`[AUTO] Skip already completed ${scenarioId}: ${item.result}`);continue;
      }
      if(!item){item={scenarioId,taskId:null,result:'STARTING',actions:[],lastError:null,report:null,reportSha256:null};results.push(item);}
      await persist(recordFile,{version:1,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:false,options:campaignOptions,results});
      let state=(await listTasks(config.outputDir)).find(s=>!['COMPLETED','CANCELLED'].includes(s.status));
      if(item.taskId && state && state.taskId!==item.taskId)throw Error(`Unexpected different unfinished task ${state.taskId}; saved campaign requires ${item.taskId}`);
      if(item.taskId && !state){
        const old=await readTask(config.outputDir,item.taskId);
        if(!['COMPLETED','CANCELLED'].includes(old.status))state=old;
        else {item.result=classify(old);console.log(`[AUTO] Recover completed task: ${scenarioId} ${item.result}`);continue;}
      }
      if(state&&state.scenarioId!==scenarioId)throw Error(`Unexpected active task ${state.taskId}; previous task not closed`);
      if(!state){
        if(++totalActions>maxActions)throw Error('Campaign max-action budget reached');
        const previous=new Set((await listTasks(config.outputDir)).map(s=>s.taskId));
        await execCli(['start','--scenario',scenarioId,'--no-run']);
        state=(await listTasks(config.outputDir)).find(s=>!previous.has(s.taskId));
        if(!state)throw Error('Task start produced no new durable state');
      }
      item.taskId=state.taskId;
      for(;;){
        // readTask validates durable event log and source-of-truth schema.
        state=await readTask(config.outputDir,item.taskId);
        item.result=classify(state);item.lastError=state.lastError;item.report=state.latestValidation?.runDir||null;item.reportSha256=state.latestValidation?.reportSha256||null;
        await persist(recordFile,{version:1,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:false,options:campaignOptions,results});
        const decision=nextAction(state,{allowEdit,allowGit,continueBlocked});
        if(decision.kind==='done'){console.log(`[AUTO] ${scenarioId}: ${item.result}`);break;}
        if(decision.kind==='stop'){
          item.result=`STOPPED:${decision.reason}`;
          console.error(`[AUTO] ${scenarioId}: ${item.result}; preserved task ${item.taskId}`);
          await persist(recordFile,{version:1,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:false,options:campaignOptions,results});
          throw Error(`${item.result} (${state.phase}/${state.status}): ${item.taskId}`);
        }
        if(++totalActions>maxActions)throw Error('Campaign max-action budget reached');
        const command=decision.kind==='analyze'?['analyze','--task',item.taskId,'--worktree',worktree]:
          decision.kind==='submit'?['submit','--task',item.taskId,'--confirm-submit']:
          decision.kind==='close'?['close','--task',item.taskId]:
          [decision.kind==='resume'?'resume':decision.kind,'--task',item.taskId];
        item.actions.push({at:new Date().toISOString(),command:decision.kind,phase:state.phase,status:state.status});
        await persist(recordFile,{version:2,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:false,options:campaignOptions,results});
        await execCli(command);
        if(decision.kind==='close'){
          item.result=`BLOCKED_ARCHIVED:${state.lastError||state.phase}`;
          console.error(`[AUTO] ${scenarioId}: ${item.result}; evidence retained, NOT counted as PASS`);
          break;
        }
      }
    }
    const audit=await writeCampaignReport({outputDir:config.outputDir,results,worktree,config,analyzeRecovered:true});
    await persist(recordFile,{version:2,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:true,
      options:campaignOptions,results,report:audit.mdPath});
    console.log(`\n[AUTO] All configured scenarios processed. Campaign: ${recordFile}`);
    console.log(`[AUTO] Korean evidence report: ${audit.mdPath}`);
    if(results.some(x=>!['PASS','RECOVERED_FAIL','RECOVERED_UNMAPPED','RECOVERED_REFERENCE','PR_OPEN'].includes(x.result)))process.exitCode=1;
  } catch(e) {
    try {await writeCampaignReport({outputDir:config.outputDir,results,worktree,analyzeRecovered:false});}
    catch(auditError){console.error('[AUTO] Partial report error:',sanitized(auditError.message||String(auditError)));}
    await persist(recordFile,{version:2,startedAt:lock.createdAt,updatedAt:new Date().toISOString(),finished:false,options:campaignOptions,error:sanitized(e.message||String(e)),results});
    console.error(`[AUTO] STOPPED: ${sanitized(e.message||String(e))}`);
    process.exitCode=2;
  } finally {try{const same=JSON.parse(await readFile(lockFile,'utf8'));if(same.token===lock.token)await unlink(lockFile);}catch{}}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(err=>{console.error('[AUTO] Fatal:',sanitized(err.message||String(err)));process.exitCode=2;});
