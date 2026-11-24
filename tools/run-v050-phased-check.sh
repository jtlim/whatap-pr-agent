#!/usr/bin/env bash
# Phase D off-line acceptance, NO live Codex, no MCP/HTTP requests and no remote Git actions.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseD-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/2] TypeScript build + Phase A/B/C1/C2/D offline regression =========='
npm test
echo '========== [2/2] Isolated CLI checkpoint and unauthorized FINAL_VERIFY denial =========='
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node - "$TMP" <<'NODE'
const fs=require('node:fs'), path=require('node:path');
const root=process.argv[2];
const cfg=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
cfg.outputDir=path.join(root,'runs');
fs.writeFileSync(path.join(root,'harness.json'),JSON.stringify(cfg,null,2),{mode:0o600});
NODE
OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TMP/harness.json")"
printf '%s\n' "$OUT"
ID="$(printf '%s\n' "$OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
node dist/cli.js task status --task "$ID" --config "$TMP/harness.json"
if node dist/cli.js task finalcheck --task "$ID" --config "$TMP/harness.json" > "$TMP/denied.log" 2>&1; then
  cat "$TMP/denied.log"
  echo 'ERROR: Phase D finalcheck passed the gate without C2 source edit' >&2
  exit 1
fi
if ! grep -q 'Not ready for final verification' "$TMP/denied.log"; then
  cat "$TMP/denied.log"
  echo 'ERROR: Phase D guard denied for an unexpected reason' >&2
  exit 1
fi
echo '[OK] C2 수정 미완료 상태에서 Phase D 최종 검증 차단'
node dist/cli.js task close --task "$ID" --config "$TMP/harness.json"
echo "[완료] Phase D 오프라인 검증: $LOG"
echo '실제 Codex 수정, 실서비스 MCP/HTTP 호출, 실제 MCP 저장소 변경, Commit/Push/PR은 수행하지 않았습니다.'
