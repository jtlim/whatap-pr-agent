#!/usr/bin/env node
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { inspectConfig } from './runner.js';
import { runAgentHarness } from './agent.js';
import { workflowCommand } from './workflow-cli.js';

async function main(): Promise<void> {
  const [command = 'doctor', ...rest] = process.argv.slice(2);
  if (!['doctor', 'run', 'task'].includes(command)) {
    throw new Error('사용법: node dist/cli.js doctor|run|task [--config config/harness.json]');
  }
  const ci = rest.indexOf('--config');
  const path = resolve(ci >= 0 ? rest[ci + 1] : 'config/harness.json');
  const { config } = await loadConfig(path);
  if (command === 'task') { await workflowCommand(config, ci >= 0 ? rest.filter((v,i)=> i!==ci && i!==ci+1) : rest); return; }
  const checks = await inspectConfig(config);
  if (command === 'doctor') {
    const codex = spawnSync('codex',['--version'],{encoding:'utf8'});
    checks.push({item:'Codex CLI',ok:codex.status===0,note:codex.status===0?(codex.stdout.trim()||'available'):'not found or failed'});
    for (const c of checks) console.log(`${c.ok ? 'OK' : 'MISSING'} ${c.item}: ${c.note}`);
    if (checks.some(c => !c.ok)) process.exitCode = 2;
    console.log('환경 점검은 읽기 전용입니다. API 요청이나 파일 변경은 하지 않았습니다.');
    return;
  }
  if (checks.some(c => !c.ok)) {
    console.error('사전 환경 점검 실패 — 다음 항목을 확인하세요:');
    for (const c of checks.filter(c => !c.ok)) {
      console.error(`  MISSING ${c.item}: ${c.note}`);
    }
    console.error('환경변수는 현재 터미널에서 설정되어 있어야 합니다. 설정 내용은 출력하지 않습니다.');
    process.exitCode = 2;
    return;
  }
  const scenarioIndex=rest.indexOf('--scenario');
  const requestIndex=rest.indexOf('--request');
  const report = await runAgentHarness(config, {
    scenarioId:scenarioIndex>=0?rest[scenarioIndex+1]:undefined,
    requestOverride:requestIndex>=0?rest[requestIndex+1]:undefined,
    diagnose:rest.includes('--diagnose'),
  },msg=>console.log(msg));
  console.log(`\n한국어 보고서: ${report.runDir}/report.md`);
  console.log(`JSON 원본: ${report.runDir}/report.json`);
  console.log('판정 집계:', JSON.stringify(report.totals));
  // UNVERIFIABLE and UNSUPPORTED are expected on first run, not a process crash.
  if (report.totals.FAIL > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('Harness 실행 실패:', e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
});
