#!/usr/bin/env bash
# Phase E offline acceptance only. Local temporary bare Git remotes are used in tests;
# no live Codex, WhaTap MCP/HTTP, GitHub API, or real origin Push/PR is performed.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseE-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/2] TypeScript build + A/B/C1/C2/D/E offline regression =========='
npm test
echo '========== [2/2] Isolated CLI checkpoint + unverified Git submission refusal =========='
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
node - "$TMP" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];
const cfg=JSON.parse(fs.readFileSync('config/harness.json','utf8'));
cfg.outputDir=path.join(root,'runs');
fs.writeFileSync(path.join(root,'harness.json'),JSON.stringify(cfg,null,2),{mode:0o600});
NODE
OUT="$(node dist/cli.js task start --scenario apm-tps-series --no-run --config "$TMP/harness.json")"
printf '%s\n' "$OUT"
ID="$(printf '%s\n' "$OUT" | grep -oE 'task-[0-9a-f]{8}-[0-9a-f]{8}' | head -1)"
node dist/cli.js task status --task "$ID" --config "$TMP/harness.json"
for MODE in --dry-run --confirm-submit; do
  if node dist/cli.js task submit --task "$ID" "$MODE" --config "$TMP/harness.json" > "$TMP/deny.log" 2>&1; then
    echo "ERROR: unverified task was permitted to submit ($MODE)" >&2
    exit 1
  fi
  if ! grep -q 'FINAL_VERIFY_PASS_REQUIRED' "$TMP/deny.log"; then
    cat "$TMP/deny.log"
    echo 'ERROR: submission rejected for wrong reason' >&2
    exit 1
  fi
done
echo '[OK] Phase D PASS 없는 작업의 Commit/Push/PR 차단 (dry-run / confirm-submit)'
node dist/cli.js task close --task "$ID" --config "$TMP/harness.json"
echo "[완료] Phase E 오프라인 검증: $LOG"
echo '실제 Codex 수정, 실서비스 MCP/HTTP 호출, 실제 MCP 저장소 Commit/Push/PR 및 외부 GitHub PR은 수행하지 않았습니다.'
