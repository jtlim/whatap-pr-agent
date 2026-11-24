#!/usr/bin/env bash
# Phase C1 smoke: all tests + protected offline CLI checkpoint. Never runs live Codex/API/Git push.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseC1-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/2] TypeScript build + all regression, retry, analysis and pre-fix tests =========='
npm test
echo '========== [2/2] Isolated CLI checkpoint (no network, no Codex) =========='
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node - "$TMP" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const t=process.argv[2],c=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
c.outputDir=path.join(t,'runs');
fs.writeFileSync(path.join(t,'harness.json'),JSON.stringify(c,null,2),{mode:0o600});
NODE
OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TMP/harness.json")"
echo "$OUT"
ID="$(printf '%s\n' "$OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
node dist/cli.js task status --task "$ID" --config "$TMP/harness.json"
node dist/cli.js task close --task "$ID" --config "$TMP/harness.json"
echo "[완료] C1 읽기 전용/모의 실행 검증: $LOG"
echo '실제 Codex 원인 분석, 실서비스 MCP/HTTP 호출, 소스 수정, Git Push/PR 은 수행하지 않았습니다.'
