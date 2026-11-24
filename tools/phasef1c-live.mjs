#!/usr/bin/env node
// PHASE F1-C: two strictly read-only live MCP + independent HTTP queries.
// Never runs Codex, edits Git, transitions a Harness task, or creates a PR.
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {stat,mkdir,mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {loadConfig} from '../dist/config.js';
import {runAgentHarness} from '../dist/agent.js';
import {extractContent} from '../dist/validator.js';
import {parseArgs,fixedWindow,evaluateStoredRun,overall} from './phasef1c-common.mjs';

function redact(v){
  let s=String(v);
  for(const secret of [process.env.WHATAP_API_TOKEN,process.env.WHATAP_HTTP_API_TOKEN]){
    if(secret)s=s.replaceAll(secret,'[REDACTED]');
  }
  return s.replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]').slice(0,300);
}
const exists=async p=>{try{return (await stat(p)).isFile();}catch{return false;}};

async function main(){
  process.umask(0o077);
  const opts=parseArgs(process.argv.slice(2));
  const {config}=await loadConfig(resolve(opts.config));
  const candidate=resolve(opts.candidate??join(homedir(),'wpr/whatap-open-mcp-agent/dist/index.js'));
  const reference=config.servers.reference;
  const scenario=config.scenarios.find(s=>s.id===opts.scenario);
  if(!scenario||!scenario.mcpPath||scenario.domain!=='timeseries'||scenario.expectedStepMs!==5000)
    throw Error('F1-C probe is restricted to an explicitly configured 5-second time series scenario');
  const ready={candidateExists:await exists(candidate),referenceExists:await exists(reference),
    candidateTokenPresent:!!process.env.WHATAP_API_TOKEN,
    httpTokenPresent:!!process.env.WHATAP_HTTP_API_TOKEN};
  const window=fixedWindow(opts);
  if(!opts.confirmLive){
    console.log(JSON.stringify({mode:'PHASE_F1C_PREFLIGHT_ONLY',ready,scenario:scenario.id,
      fixedWindow:window,readQueriesExecuted:0,noGitChanges:true,
      hint:'Pass --confirm-live-read-only only after reviewing preflight; actual WhaTap reads then occur'},null,2));
    return;
  }
  if(Object.values(ready).some(x=>!x))throw Error('Missing executable or API token environment; no live queries attempted');
  const base=await mkdtemp(join(homedir(),'whatap-harness-f1c-'));
  await chmod(base,0o700);
  config.outputDir=join(base,'evidence');
  await mkdir(config.outputDir,{recursive:true,mode:0o700});
  await chmod(config.outputDir,0o700);
  config.servers={candidate,reference}; // runtime override only, never persist to config/harness.json
  const duration=(window.etime-window.stime)/60_000;
  const originalArgs={projectCode:scenario.projectCode,path:scenario.mcpPath,
    timeRange:`${duration}m`,limit:opts.limit};
  const fixedReplay={originalArgs,mcpPath:scenario.mcpPath,window};
  const summary={mode:'PHASE_F1C_LIVE_READ_ONLY',version:2,scenario:scenario.id,window,
    hashPolicy:{candidate:'extracted MCP content SHA-256',reference:'canonical complete HTTP data rows SHA-256',
      referenceEvidence:'original HTTP evidence SHA-256 (integrity only)'},
    runCount:0,verdict:'UNVERIFIABLE',note:'Read-only qualification only; no task transition, edit permission or Git submission',
    results:[],repeatedContentStable:false,reason:'Not executed'};
  try{
    for(let i=1;i<=2;i++){
      console.log(`F1-C live query ${i}/2: ${scenario.id}; same fixed window`);
      const report=await runAgentHarness(config,{scenarioId:scenario.id,fixedReplay},()=>{});
      summary.runCount++;
      const row=await evaluateStoredRun(report,extractContent);
      // Full paths are printed so that private raw evidence stays on the Ubuntu host.
      summary.results.push(row);
      console.log(`  ${row.status} / ${row.reason}; period=${row.requestedPeriodMatched}; fullRows=${row.fullCoverage}; evidence=${row.evidenceIntegrity}`);
    }
    const result=overall(summary.results[0],summary.results[1]);
    summary.verdict=result.verdict;
    summary.repeatedContentStable=result.stable;
    summary.reason=result.reason;
  }catch(e){summary.verdict='UNVERIFIABLE';summary.reason='EXECUTION_ERROR: '+redact(e instanceof Error?e.message:e);}
  const summaryPath=join(base,'f1c-summary.json');
  await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  console.log(`F1-C verdict: ${summary.verdict}; repeated data stable: ${summary.repeatedContentStable}`);
  console.log(`Upload this SUMMARY ONLY: ${summaryPath}`);
  console.log('Full raw MCP/HTTP evidence stays on this host; DO NOT upload it or commit it to Public GitHub.');
  if(summary.verdict!=='PASS')process.exitCode=1;
}
main().catch(e=>{console.error('F1-C preflight stopped:',redact(e instanceof Error?e.message:e));process.exitCode=2;});
