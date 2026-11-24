#!/usr/bin/env bash
# No network, no Codex, no Git write. All new F1-C tests use synthetic MCPs.
set -euo pipefail
umask 077
cd "$HOME/wpr/whatap-harness"
LOG="$HOME/whatap-harness-v0.5.0-phaseF1C-offline-check.log"
exec > >(tee "$LOG") 2>&1
echo '========== [1/2] Existing + F1-C regression (synthetic MCP/HTTP only) =========='
npm test
echo '========== [2/2] F1-C preflight: no tools/call or HTTP =========='
node tools/phasef1c-live.mjs
echo "[OK] F1-C offline checks completed: $LOG"
echo '실제 WhaTap 조회 및 Codex/Git 변경은 수행하지 않았습니다.'
