#!/usr/bin/env node
// Phase F1-C evidence-only re-evaluation, with NO MCP, HTTP, Codex, or Git calls.
// Read-only qualification; never authorizes editing or submission.
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve,dirname,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractContent} from '../dist/validator.js';
import {evaluateStoredRun,overall} from './phasef1c-common.mjs';

async function main() {
  process.umask(0o077);
  const args=process.argv.slice(2);
  if(args.length!==2 || args[0]!=='--summary' || !args[1].endsWith('f1c-summary.json'))
    throw Error('Usage: node tools/phasef1c-recheck.mjs --summary /home/ubuntu/whatap-harness-f1c-.../f1c-summary.json');
  const summaryPath=resolve(args[1]);
  const base=await realpath(dirname(summaryPath));
  const evidenceRoot=await realpath(join(base,'evidence'));
  const source=JSON.parse(await readFile(summaryPath,'utf8'));
  if(source.mode!=='PHASE_F1C_LIVE_READ_ONLY' || source.runCount!==2 ||
     source.results?.length!==2 || !source.window || typeof source.scenario!=='string')
    throw Error('Not a complete original F1-C read-only summary');
  const results=[];
  const visited=new Set();
  for(const item of source.results){
    if(typeof item.evidenceDirectory!=='string')throw Error('Missing stored evidence directory');
    const runDir=await realpath(item.evidenceDirectory);
    if(!runDir.startsWith(evidenceRoot+sep)||visited.has(runDir))
      throw Error('Evidence directory outside expected root or repeated');
    visited.add(runDir);
    const report=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));
    const scenario=report.scenarios?.[0];
    const win=report.fixedReplayAudit?.requestedWindow;
    if(report.runDir!==item.evidenceDirectory || scenario?.id!==source.scenario ||
       win?.stime!==source.window.stime || win?.etime!==source.window.etime)
      throw Error('Stored report does not match original fixed-window summary');
    results.push(await evaluateStoredRun(report,extractContent));
  }
  const derived=overall(results[0],results[1]);
  const output={mode:'PHASE_F1C_STORED_EVIDENCE_RECHECK',version:2,
    sourceSummary:summaryPath,scenario:source.scenario,window:source.window,
    originalVerdict:source.verdict,runCount:2,verdict:derived.verdict,
    repeatedContentStable:derived.stable,reason:derived.reason,
    note:'Stored evidence-only reassessment. NO new WhaTap query, Codex, Git or task transition. Not a substitute for a fresh live verification.',
    hashPolicy:{candidate:'extracted MCP content SHA-256',reference:'canonical complete HTTP data rows SHA-256',
      referenceEvidence:'original HTTP evidence SHA-256 (integrity only)'},results};
  const outputPath=join(base,`f1c-rechecked-${randomUUID().slice(0,8)}.json`);
  await writeFile(outputPath,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`Original verdict: ${output.originalVerdict}; stored evidence-only verdict: ${output.verdict}`);
  console.log(`Upload this SUMMARY ONLY: ${outputPath}`);
  console.log('No new queries, code edits, task transitions, Git operations or evidence deletions performed.');
  if(output.verdict!=='PASS')process.exitCode=1;
}
main().catch(e=>{console.error('F1-C stored evidence recheck blocked:', e instanceof Error?e.message:'unknown error');process.exitCode=2;});
