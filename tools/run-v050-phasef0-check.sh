#!/usr/bin/env bash
# Phase F0 offline acceptance. Uses mock MCP schema only; never calls tools/call.
set -euo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.5.0-phaseF0-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness"
echo '========== [1/2] TypeScript build + A/B/C1/C2/D/E/F0 offline regression =========='
npm test
echo '========== [2/2] Mock fixed-window MCP tools/list contract probes =========='
RELATIVE="$(node tools/probe-fixed-window.mjs --entry test/mock-window-relative.mjs)"
ABSOLUTE="$(node tools/probe-fixed-window.mjs --entry test/mock-window-absolute.mjs)"
node - "$RELATIVE" "$ABSOLUTE" <<'NODE'
const assert=require('node:assert/strict');
const no=JSON.parse(process.argv[2]),yes=JSON.parse(process.argv[3]);
assert.equal(no.assessment.verdict,'NO_EXPLICIT_WINDOW');
assert.equal(yes.assessment.verdict,'SCHEMA_CANDIDATE');
assert.equal(no.dataQueriesExecuted,0);
assert.equal(yes.dataQueriesExecuted,0);
console.log('[OK] Relative-only MCP -> NO_EXPLICIT_WINDOW');
console.log('[OK] Absolute-schema MCP -> SCHEMA_CANDIDATE (real replay NOT verified)');
NODE
echo "[완료] F0 오프라인 검증: $LOG"
echo '실제 WhaTap MCP/HTTP 데이터 조회, Codex 수정 및 Commit/Push/PR은 수행하지 않았습니다.'
echo '실제 설치된 MCP의 시간 조회 계약 확인은 별도 명령: node tools/probe-fixed-window.mjs'
