#!/usr/bin/env bash
# v0.4.6 APM statistics integrated validation: tests, doctor, 2 actual Codex queries, replay, Korean reports.
set -uo pipefail
umask 077
LOG="$HOME/whatap-harness-v0.4.6-check.log"
exec > >(tee "$LOG") 2>&1
cd "$HOME/wpr/whatap-harness" || exit 1
printf '\n========== [1/4] 전체 자동 테스트 =========='; printf '\n'
if ! npm test; then echo '[중단] TypeScript 빌드 또는 자동 테스트 실패'; exit 1; fi
printf '\n========== [2/4] 환경 점검 =========='; printf '\n'
if ! npm run doctor; then echo '[중단] Codex/MCP/토큰 환경 점검 실패'; exit 1; fi
printf '\n========== [3/4] APM 통계 2종 실환경 검증 =========='; printf '\n'
# Explicit path hints appear only in the *user question* for the first integration smoke test.
# Harness does not force tool args, paths, or limits. Natural language discovery is a separate quality check.
ids=('apm-transaction-stats' 'apm-exception-stats')
queries=(
  '프로젝트 5490 의 최근 1시간 APM 서비스별 트랜잭션 통계를 조회해 줘. 실행 가능한 MXQL 경로 mxql/app/stat_tx_pcode 를 사용해 호출 건수, 오류 건수, 응답시간 합계를 확인해 줘. 일부 행만 반환되면 그 사실을 알려줘.'
  '프로젝트 5490 의 최근 1시간 APM Exception 클래스·서비스·메시지별 발생 통계를 조회해 줘. 실행 가능한 MXQL 경로 mxql/app/stat_error_pcode 를 사용하고 일부 행만 반환되면 그 사실을 알려줘.'
)
files=()
exitStatus=0
for idx in 0 1; do
  sid="${ids[$idx]}"
  temp="$(mktemp)"
  echo "--- $sid ---"
  npm run run -- --scenario "$sid" --request "${queries[$idx]}" 2>&1 | tee "$temp"
  code="${PIPESTATUS[0]}"
  report="$(sed -n 's/^한국어 보고서: //p' "$temp" | tail -1)"
  rm -f "$temp"
  if [[ "$code" -ne 0 ]]; then echo "[확인 필요] 실행 종료 코드: $code";exitStatus=1;fi
  if [[ -z "$report" || ! -f "$report" ]]; then
    echo "[오류] 신규 $sid 보고서 생성 실패";exitStatus=1;continue
  fi
  run="$(dirname "$report")"
  files+=("$run/report.json")
  echo "--- $sid: 저장된 증거 오프라인 재검증 ---"
  if ! node tools/replay-run.mjs "$run"; then echo "[오류] $sid 오프라인 재검증 불일치";exitStatus=1;fi
  cat "$report"
done
printf '\n========== [4/4] 최종 검증 요약 =========='; printf '\n'
node - "${files[@]}" <<'NODE'
const fs=require('node:fs');
let bad=0;
for(const file of process.argv.slice(2)){
 const run=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const s of run.scenarios){
  const z=s.reference?.statistics;
  console.log(`${s.id}: ${s.status} (${s.reason}), MCP 표시=${s.candidate.parsedRows??'?'}행, MXQL 전체=${z?.fullMxqlRows??'?'}행, v2=${z?.v2RowCount??'?'}그룹, 5분 버킷=${z?.comparedBuckets??'?'}`);
  if(s.status!=='PASS')bad++;
 }
}
if(bad){console.log(`확인 필요한 시나리오: ${bad}건`);process.exitCode=1;}
NODE
if [[ "$?" -ne 0 ]]; then exitStatus=1; fi
echo "전체 로그: $LOG"
exit "$exitStatus"
