#!/usr/bin/env bash
# Phase B smoke: offline only. No real Codex / Whatap HTTP / GitHub calls.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseB-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/3] TypeScript build + all regression/retry tests =========='
npm test
echo '========== [2/3] CLI checkpoint exercise in isolated directory =========='
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
node - "$TEMP" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const t=process.argv[2];const c=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
c.outputDir=path.join(t,'runs');c.servers.candidate=path.resolve('../whatap-open-mcp/dist/index.js');
c.servers.reference=path.resolve('../whatap-http-agent/dist/index.js');
fs.writeFileSync(path.join(t,'harness.json'),JSON.stringify(c,null,2),{mode:0o600});
NODE
OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TEMP/harness.json")"
echo "$OUT"
ID="$(printf '%s\n' "$OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
node dist/cli.js task status --task "$ID" --config "$TEMP/harness.json"
node dist/cli.js task close --task "$ID" --config "$TEMP/harness.json"
echo '========== [3/3] Automatic retries with simulated time (no network or real waiting) =========='
node --input-type=module - "$TEMP" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from './dist/config.js';
import {createTask,withWorkflowLock} from './dist/workflow.js';
import {runValidationCycle,validationHistoryIntact} from './dist/workflow-cli.js';
const base=process.argv[2];const {config}=await loadConfig(path.join(base,'harness.json'));
const out=path.join(base,'phase-b-mock-runs');config.outputDir=out;
config.servers.candidate=path.resolve('test/mock-codex-statistics.mjs');
config.servers.reference=path.resolve('test/mock-reference-statistics.mjs');
process.env.WHATAP_API_TOKEN='offline-mock';process.env.WHATAP_HTTP_API_TOKEN='offline-mock';
let t=Date.parse('2026-11-23T12:00:00Z');const delays=[];
const clk={now:()=>t,sleep:async ms=>{delays.push(ms);t+=ms;}};
let attempt=0;const verdicts=['FAIL','UNVERIFIABLE','FAIL','PASS'];
const execMock=async cfg=>{
  const status=verdicts[attempt++];const dir=path.join(cfg.outputDir,'fake-'+attempt);
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({scenarios:[{status}]}),{mode:0o600});
  await fs.writeFile(path.join(dir,'report.md'),status,{mode:0o600});
  return {runDir:dir,scenarios:[{status,reason:'OFFLINE_TEST'}]};
};
const s=await withWorkflowLock(out,()=>createTask(out,'apm-tps-series'));
const done=await withWorkflowLock(out,()=>runValidationCycle(config,s,execMock,clk));
if(done.status!=='COMPLETED'||done.fixRetries!==0||done.validationRetries.INITIAL_VERIFY!==3||
   attempt!==4||JSON.stringify(delays)!=='[30000,60000,120000]'||!await validationHistoryIntact(done))
  throw Error('Phase B retry smoke failed');
console.log(`Phase B 자동 검증 PASS: ${attempt}회, 대기=${delays.join('/')}ms, 수정 재시도=${done.fixRetries}, 증거 무결성=OK`);
NODE
printf '\n[완료] Phase B 오프라인 점검: %s\n' "$LOG"
