#!/usr/bin/env bash
# Combined verification after installing the v0.4.5 archive. No source modifications.
set -uo pipefail
LOG="$HOME/whatap-harness-v0.4.5-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness" || exit 1
printf '\n========== [1/5] 빌드 및 자동 테스트 ==========\n'
if ! npm test; then echo '[중단] npm test 실패'; exit 1; fi
printf '\n========== [2/5] 환경 점검 ==========\n'
if ! npm run doctor; then echo '[중단] doctor 실패'; exit 1; fi
printf '\n========== [3/5] 저장된 실제 실패(5초 경계) HTTP 재조회 ==========\n'
OLD="runs/2026-11-22T18-30-53-464Z-bd173a9e"
if test -f "$OLD/report.json"; then
  node tools/probe-saved-boundary.mjs "$OLD" || echo '[확인 필요] 이전 실패 데이터 보정 실측이 일치하지 않음 (상세 로그 참조)'
else
  echo "[건너뜀] 이전 보고서가 없음: $OLD"
fi
printf '\n========== [4/5] 새로운 Codex / MCP / HTTP 검증 ==========\n'
BEFORE="$(ls -td runs/*/ 2>/dev/null | head -1 || true)"
if npm run run -- --scenario apm-error-series \
  --request '프로젝트 5490 의 최근 5분 APM 트랜잭션 오류 시계열 데이터를 빠짐없이 전부 조회해 줘. 기본 반환 건수 제한으로 일부만 반환된다면 MCP 의 limit 을 충분히 늘려서 전체 데이터를 조회해.'; then
  echo '[정상] Harness 실행 명령 완료'
else
  echo '[확인 필요] Harness 실행 명령에서 오류 발생'
fi
RUN="$(ls -td runs/*/ 2>/dev/null | head -1 || true)"
if test -z "$RUN" || ! test -f "$RUN/report.json" || test "$RUN" = "$BEFORE"; then
  echo '[중단] 새로운 검증 보고서 생성 실패'
  echo "전체 명령 출력 로그: $LOG"
  exit 1
fi
printf '\n========== [5/5] 원본 증거 오프라인 재검증 / 보고서 ==========\n'
if node tools/replay-run.mjs "$RUN"; then
  echo '[정상] 증거 재검증 완료'
else
  echo '[확인 필요] 증거 재검증 오류'
fi
cat "$RUN/report.md"
printf '\n========== 요약 ==========\n'
node - "$RUN/report.json" <<'NODE'
const fs=require('node:fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
console.log('버전:',r.harnessVersion);
console.log('합계:',JSON.stringify(r.totals));
for(const s of r.scenarios){
 console.log(`시나리오 ${s.id}: ${s.status} (${s.reason})`);
 for(const c of s.callResults??[s]){
  const a=c.reference?.boundaryAlignment;
  console.log(`  호출 ${c.index??1}: ${c.status}, MCP ${c.candidate?.parsedRows??'?'}행, HTTP ${c.reference?.rowCount??'?'}행, 경계 보정 ${a?a.selectedDeltaMs===undefined?'미입증':`+${a.selectedDeltaMs}ms`:'없음'}`);
 }
}
NODE
printf '\n한 번에 전달할 로그: %s\n' "$LOG"
