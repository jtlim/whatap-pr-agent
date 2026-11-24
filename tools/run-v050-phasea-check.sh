#!/usr/bin/env bash
# Phase A offline smoke: build/tests + persistent state CLI, WITHOUT Codex/API/Git writes.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseA-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/3] TypeScript 빌드 + 기존/새 자동 테스트 =========='
npm test
echo '========== [2/3] 격리된 임시 설정으로 CLI 상태 저장 시험 =========='
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
node - "$TEMP" <<'NODE'
const fs = require('node:fs');
const path=require('node:path');
const temp=process.argv[2];
const c=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
c.outputDir=path.join(temp,'runs');
c.servers.candidate=path.resolve('../whatap-open-mcp/dist/index.js');
c.servers.reference=path.resolve('../whatap-http-agent/dist/index.js');
fs.writeFileSync(path.join(temp,'harness.json'),JSON.stringify(c,null,2),{mode:0o600});
NODE
TASK_OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TEMP/harness.json")"
echo "$TASK_OUT"
TASK_ID="$(printf '%s\n' "$TASK_OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
if [[ -z "$TASK_ID" ]];then echo '작업 ID 추출 실패';exit 1;fi
node dist/cli.js task status --task "$TASK_ID" --config "$TEMP/harness.json"
node dist/cli.js task close --task "$TASK_ID" --config "$TEMP/harness.json"
echo '========== [3/3] 저장 상태·이벤트 로그 확인 =========='
node - "$TEMP" "$TASK_ID" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const dir=path.join(process.argv[2],'runs','tasks',process.argv[3]);
const s=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
const events=fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
if(s.status!=='CANCELLED'||s.sequence!==2||events.length!==2||events[1].type!=='TASK_CANCELLED')throw Error('state/event mismatch');
const stateMode=fs.statSync(path.join(dir,'state.json')).mode & 0o777;
const taskMode=fs.statSync(dir).mode & 0o777;
if(stateMode!==0o600 || taskMode!==0o700)throw Error('unsafe permission');
console.log('Phase A CLI 저장·취소·감사 로그 PASS; state=0600 / taskDir=0700');
NODE
printf '\n[완료] 전체 로그: %s\n' "$LOG"
printf '실제 Codex/MCP/HTTP/Git 작업은 이 점검에서 실행하지 않았습니다.\n'
