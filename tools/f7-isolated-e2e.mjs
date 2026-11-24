#!/usr/bin/env node
/** F7: actual Codex + live WhaTap API E2E, isolated MCP clone and LOCAL PR, not a GitHub PR. */
import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../dist/config.js';
import {setupIsolation,assertLocalRemote,linkIsolatedDependencies,finalizeIsolatedBuildBaseline,git} from './f7-isolation.mjs';
import {readTask} from '../dist/workflow.js';
import {getF7DiagnosisSummary} from './f7-analysis-diagnostics.mjs';
import {runCodexPreflight} from './f7-codex-preflight.mjs';

process.umask(0o077);
const here=dirname(fileURLToPath(import.meta.url)),harness=resolve(here,'..');
const args=process.argv.slice(2);
const flag=(name,def)=>{const i=args.indexOf(name);return i<0?def:args[i+1];};
const allowed=new Set(['--source','--config','--output-parent','--scenario']);
for(let i=0;i<args.length;i++){if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid F7 option: '+args[i]);i++;}
const source=resolve(flag('--source',join(harness,'../whatap-open-mcp')));
const configFile=resolve(flag('--config',join(harness,'config/harness.json')));
const scenarioId=flag('--scenario','apm-tps-series');
const outputParent=resolve(flag('--output-parent',join(harness,'runs/f7-e2e')));
const runRoot=join(outputParent,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
const scrub=s=>[process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN,process.env.CODEX_API_KEY].filter(Boolean).reduce((x,secret)=>x.replaceAll(secret,'[REDACTED]'),String(s));
function checkCommand(bin){const p=spawnSync(bin,['--version'],{encoding:'utf8'});if(p.status!==0)throw Error(`Required program ${bin} not available`);}
async function run(bin,argv,cwd,env,logPath,maxMs=0){
 return new Promise((done,reject)=>{
  const proc=spawn(bin,argv,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],shell:false});
  const file=createWriteStream(logPath,{flags:'a',mode:0o600});
  let finished=false;
  const emit=x=>{const s=scrub(x.toString());process.stdout.write(s);file.write(s);};
  proc.stdout.on('data',emit);proc.stderr.on('data',emit);
  const timeout=maxMs?setTimeout(()=>proc.kill('SIGTERM'),maxMs):null;
  const end=(error,code)=>{if(finished)return;finished=true;if(timeout)clearTimeout(timeout);file.end();if(error)reject(error);else done(code);};
  proc.once('error',e=>end(e,127));proc.once('close',(code,signal)=>end(null,code??(signal?128:1)));
 });
}
async function saveJSON(file,body){await writeFile(file,JSON.stringify(body,null,2)+'\n',{mode:0o600});}
async function runE2E(){
 for(const bin of ['git','node','npm','codex'])checkCommand(bin);
 if(!process.env.WHATAP_API_TOKEN&&!process.env.WHATAP_HTTP_API_TOKEN)throw Error('WhaTap API credentials not present in environment; no live verification possible');
 const {config}=await loadConfig(configFile);
 if(config.replayPolicy!=='PERIOD_PAIRED')throw Error('F7 requires existing PERIOD_PAIRED Harness');
 if(!config.scenarios.some(s=>s.id===scenarioId))throw Error('Missing target scenario');
 if(scenarioId!=='apm-tps-series')throw Error('F7 source injection is only supported for apm-tps-series');
 if(!(await stat(config.servers.reference).catch(()=>null))?.isFile())throw Error('Independent HTTP reference entry missing');
 await mkdir(outputParent,{recursive:true,mode:0o700});
 const stage=await setupIsolation({sourceRepo:source,dest:runRoot});
 console.log('[F7] Isolated source created:',stage.root);
 console.log('[F7] Production source read-only:',stage.sourcePath);
 console.log('[F7] Production branches and origin are not modified');
 const log=join(runRoot,'f7-live.log');
 await writeFile(log,'[F7] isolated live E2E started\n',{mode:0o600});
 const summary={version:1,mode:'REAL_CODEX_LOCAL_GIT_AND_LOCAL_PR',startedAt:new Date().toISOString(),
   status:'RUNNING',scenarioId,sourceCommit:stage.sourceCommit,injectedCommit:stage.injectedCommit,
   productionSource:stage.sourcePath,workspace:stage.agent,gitRemote:stage.remote,
   externalGithubRequests:false,realCodexUsed:false,realHttpExpected:true,isolatedDefect:'TPS display-value perturbation; correction is NOT supplied to Harness or Codex',
   root:runRoot,log,report:null,taskId:null,prLocal:null,validation:null,finishTime:null,error:null};
 const summaryPath=join(runRoot,'f7-result.json');await saveJSON(summaryPath,summary);
 let code=0;
 try{
  assertLocalRemote(stage.agent,stage.remote);
  console.log('[F7.4] Preflight: Codex read-only and workspace-write shell tools using standard Linux sandbox');
  summary.codexPreflight=await runCodexPreflight({root:runRoot});
  await saveJSON(summaryPath,summary);
  console.log('[F7.4] Codex sandbox preflight PASS; starting isolated MCP build');
  console.log('[F7] Installing/building only the isolated MCP candidate');
  // Dependencies live outside the agent worktree so the strict C2 SHA snapshot
  // never traverses tens of thousands of ignored node_modules files.
  // Ignore both symlink and generated dist in the isolated Git worktrees.
  code=await run('npm',['ci','--no-audit','--no-fund'],stage.main,{},log,300000);
  if(code!==0)throw Error('Isolated candidate npm ci failed');
  await linkIsolatedDependencies({main:stage.main,agent:stage.agent});
  code=await run('npm',['run','build'],stage.agent,{},log,300000);
  if(code!==0)throw Error('Isolated candidate build failed');
  const candidate=join(stage.agent,'dist/index.js');
  if(!(await stat(candidate).catch(()=>null))?.isFile())throw Error('Isolated candidate dist/index.js not created');
  // F7.2: do NOT waive the clean-agent preflight. Reconcile ONLY tracked
  // generated dist files into both isolated baseline branches, fail for any
  // unexpected source or untracked changes and log their actual paths.
  const compiledBaseline=finalizeIsolatedBuildBaseline(stage);
  summary.injectedCommit=stage.injectedCommit;
  summary.isolatedBuildBaseline=compiledBaseline;
  await saveJSON(summaryPath,summary);
  console.log('[F7] Isolated build baseline:',compiledBaseline.advanced
    ? `local-only commit ${compiledBaseline.baselineSha}; generated files: ${compiledBaseline.files.join(', ')}`
    : 'clean; no generated Git source changes');
  const cfg={...config,servers:{...config.servers,candidate},outputDir:join(runRoot,'runs')};
  const sandboxConfig=join(runRoot,'harness-config.json');await saveJSON(sandboxConfig,cfg);
  const binDir=join(runRoot,'bin');await mkdir(binDir,{mode:0o700});
  const shim=join(binDir,'gh');
  // Never call the installed gh binary in this test. No GitHub API is contacted.
  await writeFile(shim,`#!/bin/sh\nexec "${process.execPath}" "${join(here,'f7-local-gh.mjs')}" "$@"\n`,{mode:0o700});
  await chmod(shim,0o700);
  const env={PATH:binDir+':'+process.env.PATH,F7_LOCAL_GH_STATE:join(runRoot,'local-pr.json'),
    F7_LOCAL_GIT_REMOTE:stage.remote,F7_LOCAL_AGENT_WORKTREE:stage.agent,
    GH_CONFIG_DIR:join(runRoot,'gh-no-auth'),GH_HOST:'f7-local.invalid',GH_TOKEN:'',GITHUB_TOKEN:'',
    HARNESS_PUBLISH_PUBLIC_METRICS:'YES'};
  console.log('[F7] Starting live API + REAL Codex candidate validation; local Git remote and local PR only');
  code=await run(process.execPath,[join(here,'auto-campaign.mjs'),'--config',sandboxConfig,
    '--worktree',stage.agent,'--scenario',scenarioId,'--auto-edit','--allow-git-submit',
    '--continue-on-blocked','--publish-public-metrics'],harness,env,log,2700000);
  const recordPath=join(cfg.outputDir,'campaign/latest.json');
  let record=null;try{record=JSON.parse(await readFile(recordPath,'utf8'));}catch{}
  const item=record?.results?.find(x=>x.scenarioId===scenarioId);
  summary.taskId=item?.taskId??null;summary.report=record?.report??null;summary.validation=item?.result??null;
  let completedTask=null;
  if(item?.taskId){try{completedTask=await readTask(cfg.outputDir,item.taskId);}catch(e){summary.taskLoadError=scrub(String(e?.message||e));}}
  const latestEdit=completedTask?.editHistory?.at(-1);
  const preEvidence=(completedTask?.validationHistory??[]).filter(x=>x.phase==='PRE_FIX_VERIFY'&&x.verdict==='FAIL');
  const postEvidence=(completedTask?.validationHistory??[]).filter(x=>x.phase==='FINAL_VERIFY'&&x.verdict==='PASS'&&x.editOrdinal===latestEdit?.ordinal);
  summary.realCodexUsed=!!(completedTask?.analysis||latestEdit);
  // A BLOCKED classification is not a generic Codex failure: retain the actual
  // validated diagnosis for autonomous triage without weakening any edit gate.
  summary.analysisDiagnostic=await getF7DiagnosisSummary({outputDir:cfg.outputDir,
    taskId:item?.taskId,expectedSha256:completedTask?.analysis?.sha256});
  summary.pipeline={phase:completedTask?.phase??null,status:completedTask?.status??null,
    analysisClassification:completedTask?.analysis?.classification??null,
    preFixAuthorized:completedTask?.preFix?.reproduced===true,independentPreFixFailures:preEvidence.length,
    completedEdits:(completedTask?.editHistory??[]).filter(x=>x.outcome==='COMPLETED').length,
    independentFinalPasses:postEvidence.length,finalArtifactProved:!!postEvidence.at(-1)?.artifactSha256};
  const prState=JSON.parse(await readFile(env.F7_LOCAL_GH_STATE,'utf8').catch(()=>'{"prs":[],"comments":[]}'));
  summary.prLocal=prState.prs?.[0]?{number:prState.prs[0].number,headSha:prState.prs[0].headRefOid,
    title:prState.prs[0].title,comments:prState.comments?.length??0,stateFile:env.F7_LOCAL_GH_STATE}:null;
  assertLocalRemote(stage.agent,stage.remote);
  const agentHead=git(stage.agent,'rev-parse','HEAD');
  const remoteHead=git(stage.agent,'ls-remote','origin','refs/heads/agent').split(/\s+/)[0];
  const submissionHead=git(stage.agent,'ls-remote','origin','refs/heads/submission').split(/\s+/)[0];
  summary.git={agentHead,remoteAgentHead:remoteHead,submissionHead,realPushLocal:agentHead===remoteHead,
    submissionUnchanged:submissionHead===stage.injectedCommit};
  const reportGates=summary.pipeline?.phase==='PR_OPEN'&&summary.pipeline.status==='PR_OPEN'&&
    summary.pipeline.analysisClassification==='MCP_DEFECT'&&summary.pipeline.preFixAuthorized&&
    summary.pipeline.independentPreFixFailures>=2&&summary.pipeline.completedEdits>=1&&
    summary.pipeline.independentFinalPasses>=2&&summary.pipeline.finalArtifactProved;
  const changed=git(stage.agent,'diff','--name-only',stage.injectedCommit,agentHead);
  summary.git.changedFiles=changed.split('\n').filter(Boolean);
  summary.status=code===0&&record?.finished&&item?.result==='PR_OPEN'&&!!summary.prLocal&&reportGates&&
    summary.git.changedFiles.includes('src/utils/format.ts')&&
    summary.git.realPushLocal&&summary.git.submissionUnchanged?'PASS':'INCOMPLETE';
  if(summary.status!=='PASS')summary.error=`E2E incomplete: campaignExit=${code}, result=${item?.result??'none'}, fakePr=${!!summary.prLocal}; diagnosis=${summary.analysisDiagnostic?.classification??summary.analysisDiagnostic?.status??'not-recorded'}`;
 }catch(e){summary.status=e?.code==='CODEX_INFRA_BLOCKED'?'INFRA_BLOCKED':'BLOCKED';summary.error=scrub(String(e.message||e));
  if(e?.code==='CODEX_INFRA_BLOCKED')summary.codexPreflight={status:'INFRA_BLOCKED',diagnostic:join(runRoot,'codex-preflight.json')};}
 summary.finishTime=new Date().toISOString();await saveJSON(summaryPath,summary);
 await saveJSON(join(outputParent,'latest.json'),{version:1,runRoot,summary:summaryPath,status:summary.status,at:summary.finishTime});
 const md=[`# F7 실제 Codex 격리 E2E 결과`,'',`- 판정: **${summary.status}**`,
  `- 시나리오: ${scenarioId}`,`- 실제 Codex 구조화 분석 기록: ${summary.realCodexUsed?'확인':'미확보'}`,
  `- Git 리모트: 로컬 Bare 저장소만`, `- GitHub PR 게시: **없음** (로컬 PR 기록만)`,
  `- 출처 소스 SHA: ${summary.sourceCommit}`,`- 주입된 시험 기준 SHA: ${summary.injectedCommit}`,
  `- 검증 작업: ${summary.taskId??'미확보'}`,`- 캠페인 결과: ${summary.validation??'미확보'}`,
  `- 로컬 PR 기록: ${summary.prLocal?.stateFile??'없음'}`,
  `- 보고서: ${summary.report??'미확보'}`,`- 실행 로그: ${log}`,
  `- 오류: ${summary.error??'없음'}`,
  `- Codex 샌드박스 사전 검사: ${summary.codexPreflight?.status??'NOT_COMPLETED'}`,
  `- 사전 검사 기록: ${join(runRoot,'codex-preflight.json')}`,
  `- Codex 분류: ${summary.analysisDiagnostic?.classification??'미확보'} / 무결성: ${summary.analysisDiagnostic?.integrity??'미확보'}`,
  `- 원인 분석 파일: ${summary.analysisDiagnostic?.artifact??'미확보'}`,
  `- 원인 분석 요약: ${summary.analysisDiagnostic?.summary??'미확보'}`,'',
  '## 판정 기준','',
  'PASS 는 실제 Codex 를 사용한 독립 수정 게이트와 로컬 Git commit/push, 로컬 PR 저장이 모두 확인된 경우만 인정합니다.',
  'BLOCKED/INCOMPLETE 에서는 결함의 원인·해결·PR 완료를 주장할 수 없습니다.',
  '실제 GitHub PR 및 production agent/submission Merge 는 수행하지 않습니다.'].join('\n')+'\n';
 await writeFile(join(runRoot,'f7-result.md'),md,{mode:0o600});
 console.log('[F7] '+summary.status+'; summary='+summaryPath);
 console.log('[F7] report='+join(runRoot,'f7-result.md'));
 if(summary.error)console.error('[F7] '+summary.error);
 if(summary.status!=='PASS')process.exitCode=2;
}
runE2E().catch(e=>{console.error('[F7] FATAL: '+scrub(e?.message??String(e)));process.exitCode=2;});
