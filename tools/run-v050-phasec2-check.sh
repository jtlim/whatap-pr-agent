#!/usr/bin/env bash
# Phase C2 offline acceptance: build, 131+ tests and isolated CLI guard check.
# NO live Codex invocation, MCP/HTTP request, real MCP edit, Push or PR.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseC2-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/2] TypeScript build + A/B/C1/C2 offline regression and guard tests =========='
npm test
echo '========== [2/2] Isolated CLI checkpoint and unauthorized-edit denial =========='
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node - "$TMP" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const root=process.argv[2];
const cfg=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
cfg.outputDir=path.join(root,'runs');
fs.writeFileSync(path.join(root,'harness.json'),JSON.stringify(cfg,null,2),{mode:0o600});
NODE
OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TMP/harness.json")"
printf '%s\n' "$OUT"
ID="$(printf '%s\n' "$OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
node dist/cli.js task status --task "$ID" --config "$TMP/harness.json"
if node dist/cli.js task modify --task "$ID" --config "$TMP/harness.json" > "$TMP/denied.log" 2>&1; then
  cat "$TMP/denied.log"
  echo 'ERROR: C2 edit gate allowed modification without C1 approval!' >&2
  exit 1
fi
if ! grep -q 'pre-fix gate has not authorized code editing' "$TMP/denied.log"; then
  cat "$TMP/denied.log"
  echo 'ERROR: C2 edit gate failed for an unexpected reason' >&2
  exit 1
fi
echo '[OK] Phase C1 미승인 작업의 C2 코드 수정 거부'
node dist/cli.js task close --task "$ID" --config "$TMP/harness.json"
echo "[완료] Phase C2 오프라인 검증: $LOG"
echo '실제 Codex 수정, 실서비스 MCP/HTTP 호출, 실제 MCP 저장소 변경 및 원격 Git 작업은 수행하지 않았습니다.'
