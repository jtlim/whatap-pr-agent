#!/usr/bin/env bash
# F1-B offline-only verification. Uses local synthetic candidate and reference MCP.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseF1B-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/3] TypeScript build + all A/B/C1/C2/D/E/F0/F1B regression =========='
npm test
echo '========== [2/3] Mock candidate schema checks (tools/list only) =========='
RELATIVE="$(node tools/probe-fixed-window.mjs --entry test/mock-window-relative.mjs)"
ABSOLUTE="$(node tools/probe-fixed-window.mjs --entry test/mock-window-absolute.mjs)"
node - "$RELATIVE" "$ABSOLUTE" <<'NODE'
const assert=require('node:assert/strict');
const no=JSON.parse(process.argv[2]),yes=JSON.parse(process.argv[3]);
assert.equal(no.assessment.verdict,'NO_EXPLICIT_WINDOW');
assert.equal(yes.assessment.verdict,'SCHEMA_CANDIDATE');
assert.equal(no.dataQueriesExecuted,0);assert.equal(yes.dataQueriesExecuted,0);
console.log('[OK] Relative-only rejected; explicit-window schema candidate found');
NODE
echo '========== [3/3] Regression check: no real MCP, no Codex, no Git changes =========='
echo "[완료] F1-B 오프라인 검증: $LOG"
echo '실제 WhaTap API/MCP 데이터 조회, Codex 수정, Commit/Push/PR은 수행하지 않았습니다.'
