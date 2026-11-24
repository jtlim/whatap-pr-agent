# WhaTap MCP 품질 개선 과제 실행

Ubuntu에서 Node.js 22 이상, Harness와 MCP의 설치된 의존성, 빌드된 HTTP Client, 인증된 Codex CLI를 준비합니다. 서비스 조회 인증은 현재 셸의 `WHATAP_API_TOKEN` 및 `WHATAP_HTTP_API_TOKEN`을 사용합니다. 코드 변경은 별도의 깨끗한 `agent` Git worktree에서 수행합니다.

```bash
cd /home/ubuntu/wpr/whatap-harness
node tools/run-assignment.mjs --config config/harness.json --worktree /home/ubuntu/wpr/whatap-open-mcp-agent
```

이 명령은 현재 MCP 소스를 별도 디렉터리에서 빌드하고, 서버 메트릭, APM 트랜잭션·예외 통계, TPS·오류 시계열을 기존 독립 HTTP 비교기로 검증합니다. 다섯 결과와 원본 응답은 판정과 관계없이 읽기 전용 Codex에 전달합니다. 분석은 최대 2회이며, 추가 조회는 최대 2건입니다. 추가 조회는 설정된 프로젝트·도구와 최대 24시간의 과거 구간으로 제한됩니다. MCP 결함으로 분류하고 관련 소스와 독립 조회 근거를 확보한 경우 코드 편집을 1회 실행합니다. 부분 편집이나 검증 실패가 발생하면 편집 내용과 증거를 보존합니다.

수정 후에는 MCP를 새로 빌드하고 기존 MCP 테스트와 다섯 시나리오의 직접 대조를 실행합니다. 수정 대상의 변경 전 독립 불일치와 변경 후 전체 통과가 확인되어야 `VERIFIED`입니다. `PERIOD_PAIRED`에서는 각 MCP 응답의 관측 기간으로 HTTP를 조회합니다. 전후 기간이 다르면 동일한 행에 대한 재현으로 판정하지 않습니다. `FIXED_WINDOW`에서는 MCP 스키마와 정확한 반환 기간을 검증합니다.

## 사용자 개선 목표 지정

목표와 기대 동작을 UTF-8 Markdown 파일에 작성한 뒤 `--goal-file`로 전달합니다.

```bash
node tools/run-assignment.mjs --config config/harness.json \
  --worktree /home/ubuntu/wpr/whatap-open-mcp-agent \
  --goal-file ./goal.md
```

예를 들어 `goal.md`에 “`whatap_query_data`가 UTC 밀리초 `stime`과 `etime`으로 지정한 기간을 조회하고 기존 `timeRange` 조회도 유지한다”라고 작성할 수 있습니다. 초기 비교가 모두 PASS여도 내부 AI는 목표와 소스를 검토해 개선 필요성을 판단합니다. 목표는 실행 보고서에 기록되며 `--evidence`와 함께 사용할 수 있습니다.

AI가 절대시간 변경이 필요한 시나리오를 지정하면 Harness는 기존 고정 구간 재조회로 수정 전 스키마 미지원, 반환 기간 불일치 또는 독립 비교 실패를 확인합니다. 수정 후에는 같은 절대 구간을 재조회해 스키마, 정확한 반환 기간, 독립 HTTP 비교를 확인합니다. 기존 다섯 시나리오 검증과 MCP 회귀 테스트도 통과해야 `VERIFIED`입니다. 별도 검증 방식이 없는 개선에는 기존 수정 전후 데이터 비교 기준이 적용됩니다.

F8 증거를 재사용하려면 아래 명령을 실행합니다. 디렉터리 또는 개별 `report.json`을 지정할 수 있습니다. 기존 결과는 읽기 전용으로 사용하므로 첫 MCP/HTTP 수집은 생략됩니다. AI가 MCP 수정을 선택하면 현재 빌드에서 해당 시나리오의 수정 전 증거를 확보합니다.

```bash
node tools/run-assignment.mjs --config config/harness.json \
  --worktree /home/ubuntu/wpr/whatap-open-mcp-agent \
  --evidence runs/f8-e2e/full-20261124T015004Z
```

원격 제출을 실행할 때만 첫 명령에 `--allow-git-submit`을 추가합니다. 검증된 변경을 커밋하고 `jtlim/whatap-open-mcp`의 `agent`에 push한 뒤 `submission` 대상 PR을 생성하거나 기존 PR을 확인합니다. 원격 브랜치 접근과 PR 권한을 가진 Git 및 `gh` 인증이 필요합니다. 공개 PR 본문에는 실행 방법의 요약만 사용하며 실제 수치와 상세 로그는 로컬에 보관합니다.

결과 경로는 실행 종료 시 출력됩니다. 기본 설정에서는 `runs/assignment-*/assignment.md`에서 한국어 보고서를 읽고, `assignment.json`에서 전체 코드 변경, 판단, 증거 경로 및 SHA-256, 빌드·회귀 결과와 Git 상태를 확인합니다. MCP 및 HTTP 원본은 보고서에 연결된 별도 JSON 파일에 저장합니다. Codex 분석은 회차당 180초, 편집은 600초, 빌드와 테스트는 각각 180초와 300초, MCP RPC는 설정값 기준 최대 180초로 제한합니다.

종료 코드 `0`은 `VERIFIED` 또는 `NO_CHANGE`, `1`은 실행 결과 확인 필요, `2`는 명령 또는 초기화 오류입니다. 보고서는 `AI_EXECUTION_FAILED`, `VERIFICATION_FAILED`, `UNVERIFIABLE`, `SUBMISSION_FAILED`를 구분합니다. Harness 회귀 테스트는 `npm test`로 실행합니다.

---

# WhaTap Harness v0.5.0-alpha.8-f1b — Phase F1-B: 동일 절대시간 재조회 연결

## 변경

- 최초 일반 조회는 기존대로 Codex/LLM 이 MCP 도구와 인자(`timeRange`/path/params/limit)를 선택합니다. F1-B 는 초기 선택을 가로채거나 변경하지 않습니다.
- C1 `PRE_FIX_VERIFY` 는 **SHA 검증한 초기 FAIL 의 실제 단일 MCP 호출 인자**를 재사용합니다. `timeRange` 만 제거하고, 기록된 UTC Period 를 밀리초 `stime`/`etime` 으로 넘겨 **Codex 없이 MCP 를 직접 1회 호출**합니다.
- F1-A MCP 의 tools/list 에 숫자형 `stime/etime` 이 선언된 경우에만 실행하고, MCP 응답 Period 가 요청 구간과 초 단위까지 완전히 일치해야 HTTP 대조를 진행합니다. 초기 Period 의 밀리초가 0 이 아니면 조용히 반올림하지 않고 차단합니다.
- C1 에서 확인된 조회 조건/원본 증거와 동일한 고정 Period 를 D `FINAL_VERIFY` 에서 재사용합니다. 수정 소스는 별도 Staging COPY 에서 빌드/테스트하고 그 결과를 MCP 에 전달합니다.
- 조회 인자 중 `path`/`projectCode`/`query`/`savedQuery`/`limit`/`params` 및 기타 시간 외 인자는 보존합니다. 변경되면 인증을 거부합니다. MCP 의 검증되지 않은 Period, 원본 응답 부재, schema 미지원, 소스 변경은 승인하지 않습니다.
- 직접 조회와 독립 HTTP 결과의 원본 JSON 과 SHA, `fixedReplayAudit` (호출 인자 및 Period/Schema 증거)를 저장합니다. 단순 스키마 판정은 PASS 가 아닙니다.

## 범위 및 제약

- 이 버전은 **Harness 연동 구현 + 오프라인 모의 API 테스트**입니다. 사용자 실서비스 MCP/HTTP 에서 `stime/etime` 이 실제로 준수되는지 입증하는 F1-C 는 아직 별도 작업입니다.
- 별도 주입된 테스트 verifier 는 레거시 테스트의 동작을 재현하기 위해 유지합니다. **실제 기본 `runAgentHarness` 경로는 직접 고정 재조회와 추가 검사 없이는 C1/D 승인을 허용하지 않습니다.**
- 최초 조회에서 매핑되지 않은 경로나 다중 호출, 모호한 Period, 밀리초 포함 Period 등은 *fail closed* 하며 수정 허용하지 않습니다.
- 수동 Git Commit/Push/PR 이나 Codex 실제 수정은 오프라인 스크립트에서 실행하지 않습니다.
- F1-A 변경이 `agent` Worktree 에 미커밋 상태로 남아 있을 수 있으므로, F1-C 와 초기 통합 검증 전에는 기존 Git 상태를 수동 reset/clean 하지 마세요.

## Ubuntu 업그레이드 (기존 config/runs 보존)

ZIP 파일 `whatap-harness-v0.5.0-phaseF1B.zip` 을 `/home/ubuntu/` 에 업로드합니다.

```bash
set -euo pipefail
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseF1B.json
unzip -o ~/whatap-harness-v0.5.0-phaseF1B.zip
cp ~/whatap-harness-config-backup-v050-phaseF1B.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phasef1b-check.sh
```

오프라인 로그는 `~/whatap-harness-v0.5.0-phaseF1B-check.log` 입니다. 이 스크립트는 로컬 mock MCP 와 mock HTTP 서버를 사용하고 실제 WhaTap 서비스에 데이터 요청하지 않습니다.

**F1-C 전에 중요**: `config/harness.json` 의 `servers.candidate` 가 `../whatap-open-mcp-agent/dist/index.js` 등 **F1-A 로 빌드한 agent Worktree** 를 가리키는지 확인하세요. 잘못된 경로의 옛 MCP 를 호출하면 schema 에 `stime/etime` 이 없어 거부됩니다. 구성 변경은 현재 자동으로 수행하지 않습니다.

---

# WhaTap Harness v0.5.0-alpha.7-f0 — Phase F0: 절대 시간 조회 지원 계약 사전 점검

이 버전은 **Phase E 162/162 오프라인 테스트 통과 이후의 비파괴적 점검 도구 추가**입니다. 기존 A/B/C1/C2/D/E 실행 정책과 데이터 판정 게이트는 변경하지 않습니다. `whatap_query_data` 가 사용자의 설치본에서 고정 구간 조회를 받을 수 있는지 **실제 MCP `tools/list` 입력 스키마만 조회**하여 먼저 확인합니다.

## 추가된 기능

- `node tools/probe-fixed-window.mjs`: `config/harness.json` 의 candidate MCP 프로세스를 `initialize` 후 `tools/list` 만 호출합니다. `tools/call`, 사용자 데이터 조회, HTTP reference 호출, Codex 호출, 소스 수정, Git 작업은 시도하지 않습니다.
- `--entry test/mock-window-relative.mjs` 등은 네트워크 없는 테스트용 mock 서버 선택입니다.
- `NO_EXPLICIT_WINDOW`: `stime`/`etime` 인자가 없고, 상대시간 `timeRange` 중심으로 선언된 경우. 같은 절대 기간을 자동 재현할 수 있다고 판정하지 않습니다.
- `SCHEMA_CANDIDATE`: `stime`/`etime` 숫자형 입력 선언을 찾은 경우. **스키마 가능성일 뿐**, 서버가 지정 시간을 따르거나 결과가 같은지는 검증되지 않았으므로 **실서비스 재조회 검증이 별도로 필요**합니다.
- `MISSING_TOOL`, `INCOMPLETE_WINDOW`, `AMBIGUOUS_SCHEMA` 에는 자동 승인하지 않습니다. 모든 상태에서 C1/D PASS 조건은 그대로 유지됩니다.
- 도구 이름과 입력 필드명·유형·필수 여부만 표시하며 토큰 값/도구 출력/실제 조회 데이터는 수집하지 않습니다. MCP 서버의 **초기화 자체가 외부 부작용이 없는지**는 MCP 구현에 달려 있으므로 읽기 전용이라고 해도 서버 프로세스의 내부 동작까지 증명하지 않습니다.

## Ubuntu 적용 — 기존 설정과 작업 기록 보존

ZIP `whatap-harness-v0.5.0-phaseF0.zip` 을 `/home/ubuntu/` 에 업로드한 뒤 실행:

```bash
set -e
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseF0.json
unzip -o ~/whatap-harness-v0.5.0-phaseF0.zip
cp ~/whatap-harness-config-backup-v050-phaseF0.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phasef0-check.sh
```

로그는 `~/whatap-harness-v0.5.0-phaseF0-check.log`. 이 **오프라인 점검은 mock MCP만 사용**하며 실제 서비스 네트워크나 원격 Git 호출이 없습니다.

위 검증 성공 후, **별도로 설치된 실제 MCP 도구 스키마만 조회**하려면 다음 명령을 실행합니다. 이것은 실제 설치본을 시작하므로 네트워크가 불가능하다고 주장하지는 않습니다. 단 Harness가 `tools/call` 을 보내지 않습니다.

```bash
cd ~/wpr/whatap-harness
node tools/probe-fixed-window.mjs 2>&1 | tee ~/whatap-harness-v0.5.0-phaseF0-schema.log
```

그 결과에 따라 다음 작업을 결정합니다. 스키마에 절대 기간이 없다면 **MCP 소스부터 하위 호환 방식으로 확장**한 뒤 원본 MCP 가 명시된 절대 기간을 실제로 지키는지 확인하고, 이후 Harness의 C1/D 재실행 흐름에 동일 Period 를 주입해야 합니다. 기간 필드가 있다는 이유만으로 수정·PASS·Commit 을 허용하면 안 됩니다. 실제 인증 정보가 있는 환경에서의 데이터 조회 테스트 및 Git 제출은 이 Phase F0 범위에 포함하지 않습니다.

---

# WhaTap Harness v0.5.0-alpha.6-e — Phase E: 증거 기반 Git 제출 / 사람 승인

**Phase D 148/148 통과 이후의 확장 버전입니다.** 기존 Phase A/B/C1/C2/D 기능, 설정, 스키마 v1 및 모의 테스트를 유지합니다.
이번 릴리스는 오프라인 로컬 Git 테스트까지만 수행했고, 실서비스 WhaTap/Codex/GitHub 에는 요청하지 않았습니다.

## Phase E 주요 기능

- `task submit --task ID --dry-run`: Phase D 최종 PASS, 최신 C2 수정 이력, 독립 검증 원본 파일 SHA, 수정된 Worktree 파일 SHA, 허용 파일 목록, 고정 `agent`/`submission` 상태를 **네트워크/파일 변경 없이** 점검합니다. 실제 작업이 `COMMITTING/PAUSED` 상태여야 합니다.
- `task submit --task ID --confirm-submit`: **이 명령은 실제로 Commit → origin/agent Push → agent→submission GitHub PR을 실행합니다.** 1회 실행으로 연속 진행하며 각 단계 전에 자체 상태를 저장합니다. `submission` 브랜치를 직접 수정/Push하지 않습니다. Git 리셋/리베이스/force-push/PR 자동 병합도 하지 않습니다.
- 원격 브랜치 상태가 예상과 다르거나, 테스트와 다른 파일이 staged 되었거나, 독립 증거 또는 소스가 변조되면 **즉시 중지**합니다. PR은 동일 작업과 동일 커밋이 식별되는 경우만 허용합니다.
- Commit/Push/PR 실행 도중 장애가 발생하면 `BLOCKED` 처리하고 **재실행하지 않습니다**. Git/PR 상태를 사용자가 확인한 뒤에만 `task reconcile-submit --task ID --ack-external` 로 수동 재조정합니다. 재조정 후 필요한 경우 `submit --confirm-submit` 를 별도로 실행합니다.
- 사람이 GitHub에서 PR을 검토·Merge 한 뒤에만 `task mark-merged --task ID --ack-merged` 로 완료를 기록합니다. Harness가 직접 Merge 하지는 않습니다.
- `submit-intent.json` / `submit-commit.json` / `submit-push.json` / `submit-pr.json` / `submit-merge.json` 에 실행 조건과 단계별 결과를 기록하며 상태 파일에서 SHA-256을 참조합니다. API payload, 서비스 토큰 등은 PR 본문으로 복사하지 않습니다.
- 원격 Push/PR을 수행하려면 `origin` 에 **기존 `agent`, `submission` 두 브랜치가 존재**하고 로컬 `submission` 과 원격 `submission` HEAD 가 일치해야 합니다. `agent` 는 `submission` 의 후손이어야 합니다. GitHub CLI `gh` 인증과 Git push 권한이 필요합니다.

## Ubuntu 기존 설치 업그레이드와 **오프라인 점검** (권장)

`whatap-harness-v0.5.0-phaseE.zip` 을 `/home/ubuntu/` 에 업로드합니다. 기존 `config/harness.json`, `runs/`, `node_modules`를 유지합니다.

```bash
set -e
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseE.json
unzip -o ~/whatap-harness-v0.5.0-phaseE.zip
cp ~/whatap-harness-config-backup-v050-phaseE.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phasee-check.sh
```

- 로그: `~/whatap-harness-v0.5.0-phaseE-check.log`
- 점검에는 로컬 임시 Git bare 저장소와 모의 PR Provider만 사용합니다. **실제 원격 Push/PR, 실제 Codex 수정, 실서비스 MCP/HTTP 호출은 하지 않습니다.**
- 실제 제출용 명령은 이번 오프라인 검증 절차에서 사용하지 마세요. 실제 사용 전에 고정 절대 기간 재현, Codex/빌드 스크립트 격리, 실서비스 통합 검증이 필요합니다.

## 실제 제출 명령 (현재 알파 테스트 범위 밖, 바로 실행하지 말 것)

```bash
# C1~D를 실환경에서 완전히 검증하고, 상태가 COMMITTING/PAUSED인 경우에 한함
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
node dist/cli.js task submit --task task-xxxxxxxx-xxxxxxxx --dry-run
# 사용자가 실제 Git 원격 제출을 명시적으로 승인한 경우에만:
node dist/cli.js task submit --task task-xxxxxxxx-xxxxxxxx --confirm-submit
# GitHub에서 사람이 PR을 검토 및 Merge한 다음:
node dist/cli.js task mark-merged --task task-xxxxxxxx-xxxxxxxx --ack-merged
```

**남아 있는 운영 제약:** 기존 `whatap_query_data` 는 `timeRange` 와 같은 상대 시간 범위를 사용합니다. 동일 절대 구간 재현을 제공하지 못하는 MCP 호출에 대해 C1/D 검증 게이트를 완화하지 않습니다. 따라서 현재 real-world 자동 수정 → 검증 → 제출 성공을 보장하지 않습니다. MCP의 절대 기간 조회 지원 여부를 확인하고, 필요한 경우 원본 MCP / Harness의 조회 계약을 별도 확장한 뒤 통합 테스트해야 합니다. Docker/OS sandbox 없는 외부 npm build/test 및 Codex 실행은 시스템 전체에 대한 안전한 격리를 보장하지 않습니다.

---

# WhaTap Harness v0.5.0-alpha.5-d — Phase D: 수정 후 독립 최종 검증

Phase C2 `v0.5.0-alpha.4-c2` 의 전체 파일과 테스트를 보존하고 Phase D의 **수정 후 독립 검증 게이트**를 추가했습니다.
오프라인 모의 검증 통과는 실서비스 MCP/HTTP 또는 실제 Codex 통합 검증 완료를 의미하지 않습니다.
**Commit, Push, PR 및 자동 Git 제출은 아직 미구현(Phase E)입니다.**

## 기능 요약

- `task finalcheck --task ID` (또는 FINAL_VERIFY 작업의 `task resume`): C1 동일 절대 기간/동일 MCP 조회 조건 재현과 C2 성공적인 수정 내역을 확인한 작업에만 진입합니다.
- C2 수정 직후의 Worktree SHA-256을 다시 검사합니다. C2 이후 사람이 파일을 바꾸면 빌드 또는 MCP/HTTP 호출 전에 차단합니다.
- 수정된 `agent` Worktree의 **복사본을 runs/tasks/<ID>/final-build-... 디렉터리에 생성**하고, 복사본의 `npm run build`, `npm test`를 실행합니다. 새로 생성된 `dist/index.js`가 없으면 기존 빌드 산출물을 재사용하지 않고 UNVERIFIABLE로 처리합니다.
- Codex와 분리된 Harness가 그 새 빌드 결과를 MCP로 호출하고, 별도의 HTTP reference를 조회합니다. 기존에 승인된 **MCP 경로, 모든 도구 인자, 동일한 절대 Period**를 만족하고 양쪽 원본 증거의 SHA-256 및 Harness의 실제 대조 판정이 PASS인 경우에만 Git 제출 **대기 상태(`COMMITTING/PAUSED`)**로 이동합니다. 이 단계에서 Git 명령은 실행하지 않습니다.
- 각 수정 시도별 최종 검증은 초기 1회 + 30/60/120초의 3회 재검증으로 제한합니다. FAIL / UNVERIFIABLE 재시도는 Codex 수정 횟수를 소모하지 않습니다. 최종 FAIL이 동일 조건에서 확정되고 수정 예산이 남은 경우 `MODIFYING/PAUSED`로 돌아가며, **재수정은 별도 `task modify` 명령으로만 실행**할 수 있습니다. 3회 수정을 모두 사용했거나 UNVERIFIABLE을 소진하면 BLOCKED입니다.
- `final-attempt-<edit>-<validation>-<id>.json/.md`에 수정 전후 실제 MCP 표시 행 샘플, 가능한 경우 독립 HTTP 행, 원본 증거와 SHA, 빌드/테스트 결과, 조회 조건, 최종 판정, 재현 절차를 남깁니다. JSON의 SHA를 상태 이력에 기록합니다. 검사 도중 프로세스가 죽으면 마지막 미완료 검증을 PASS로 처리하지 않고 동일 시도 번호로 다시 검증합니다.
- 추가 Codex 수정 시도 및 재검증 예산을 별도로 유지합니다. 수정 파일/원본 증거를 자동 삭제하거나 reset 하지 않습니다.

### 중요한 제약

1. C1의 **이동하는 상대시간 Period** 문제를 임의로 우회하지 않습니다. `5m`, `1h` 등의 상대시간 조회는 다시 호출하면 절대 Period가 이동하는 경우가 많아서, 현재 게이트가 실제로 PASS에 이르지 못할 수 있습니다. 동일 절대 Period 재현 지원은 별도 개선이 필요합니다. C1의 `PRE_FIX_VERIFY` 자체가 통과되지 않는다면 D까지 진입할 수 없습니다.
2. 별도 스테이징 복사본은 원본 Worktree의 `dist/` 변경을 피하기 위한 것이지 **OS 수준의 명령 실행 격리**가 아닙니다. 원본의 `node_modules`는 설치 없이 재사용하기 위해 symlink로 연결됩니다. npm 스크립트가 외부 경로를 변경하는 것까지는 격리하지 못하므로, 실제 적용 전 MCP 저장소의 `build`/`test` 스크립트가 안전한지 별도 검토해야 합니다. 네트워크나 로컬 시스템에 대한 권한을 실질적으로 제한하려면 OS 샌드박스 또는 컨테이너 격리를 후속 적용해야 합니다.
3. Python/Node 등 다른 스택을 자동 발견하는 범용 빌드가 아니라, **`package.json` build/test + `dist/index.js`** 구조인 현재 WhaTap MCP를 대상으로 합니다. 빌드 누락/실패는 독립 API 데이터 FAIL로 과장하지 않습니다.
4. 테스트는 모의 Codex, 모의 MCP/HTTP 보고서, 별도 Git Worktree 및 로컬 더미 npm 빌드로 수행합니다. Ubuntu의 실제 Codex CLI 및 실제 서비스 API 호출은 이 패키지의 오프라인 점검에서 수행하지 않습니다.
5. 현재 원본 증거는 SHA-256 무결성 기록이지만 공격자가 state.json과 모든 원본을 함께 바꿀 수 있는 상황까지 인증하는 전자서명은 아닙니다. `runs/`에 서비스 데이터/Exception 메시지가 포함될 수 있으므로 외부 공유와 저장소 커밋을 금지해야 합니다.

## Ubuntu 기존 환경 업그레이드 + 오프라인 점검

ZIP 파일 `whatap-harness-v0.5.0-phaseD.zip`을 이전과 같이 Ubuntu 사용자의 `$HOME`에 업로드하고 아래를 **한 번에 실행**하세요.

```bash
set -e
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseD.json
unzip -o ~/whatap-harness-v0.5.0-phaseD.zip
cp ~/whatap-harness-config-backup-v050-phaseD.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phased-check.sh
```

- 로그: `/home/ubuntu/whatap-harness-v0.5.0-phaseD-check.log`
- 기존 `config/harness.json`, `runs/`, `node_modules`를 삭제하거나 덮어쓰지 않습니다.
- 다른 사용자 홈이더라도 `$HOME` 경로에 기록되며, 실행은 외부 서비스 호출 없이 완료됩니다.

## 실제 서비스 작업 진행 (오프라인 테스트 통과 후, 별도 승인 필요)

```bash
# C1 수정 전 게이트 PASS, C2 수정 완료 상태에서만
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
node dist/cli.js task finalcheck --task task-xxxxxxxx-xxxxxxxx --no-wait
# WAITING_RETRY 상태이면 기존 예약 시간 이후 다음 실행
node dist/cli.js task resume --task task-xxxxxxxx-xxxxxxxx --no-wait
# FINAL_VERIFY_CONFIRMED_FAIL 이라면 남은 수정 횟수만큼 수동 실행 가능
node dist/cli.js task modify --task task-xxxxxxxx-xxxxxxxx
# 다시 최종 검증
node dist/cli.js task finalcheck --task task-xxxxxxxx-xxxxxxxx --no-wait
```

`COMMITTING/PAUSED`는 Git 제출이 실행되었다는 의미가 아닙니다. **Phase E가 구현되고 별도 안전 게이트를 통과하기 전까지 커밋/푸시/PR을 자동 실행하지 않습니다.**

---

# WhaTap Harness v0.5.0-alpha.4-c2 — Phase C2: 승인된 소스 수정 + 증거 보존

이 패키지는 이전 `v0.5.0-alpha.3-c1` 전체 소스를 그대로 포함하고, **C1의 독립 수정 전 게이트를 실제로 통과한 경우에만** Codex 를 `workspace-write` 샌드박스에서 실행할 수 있게 확장한 것입니다. Phase A/B/C1의 기존 실행 흐름과 `agent` / `submission` 브랜치 정책을 유지합니다.

**현재 범위는 수정 실행 및 수정 이력 보존까지입니다.** 수정 후의 `FINAL_VERIFY`, 회귀 테스트 결과에 따른 수정 재시도 승인, Git Commit/Push/PR 은 **Phase D/E 과제**입니다. Codex 의 자체 성공 보고를 최종 PASS로 취급하지 않습니다.

## 이번에 구현한 기능

- `task modify --task ID`: C1에서 `MODIFYING/PAUSED`, `MCP_DEFECT` 분석, 동일한 절대 기간의 원본 불일치 재현, 관련 `analysis.json` 및 `prefx-report.json` 원본 SHA 검증을 모두 통과한 작업에만 Codex 수정 1회를 허용합니다. C1 과정에서 수정 대기 상태가 만들어졌다는 이유만으로 검증 근거를 생략하지 않습니다.
- 별도 linked Git Worktree의 고정 `agent` 브랜치에서만 수정합니다. 원본 Checkout이나 다른 브랜치에서는 실행하지 않습니다. Codex 의 작업 범위는 원인 분석에 명시된 MCP 소스 파일 및 필요한 테스트 파일입니다. 테스트 디렉터리는 `test/`, `tests/`, `__tests__/` 를 허용합니다. 기타 파일, Harness/HTTP 검증 코드, 토큰, Git 인덱스, HEAD 변경은 거부합니다. 수정 금지 파일이 변경되면 **자동 복구/삭제하지 않고** Worktree를 보존하며 작업을 차단합니다.
- `edit-start-N.json` 은 Codex 실행 이전에 기록되는 내구성 체크포인트이고, 종료 후 `edit-N.json`, `edit-N.md`, `edit-diff-N.md` 에 변경 파일, 수정 전·후 SHA-256, 원인/영향/재현 절차, Codex 의 자체 주장과 검증 보류 상태를 남깁니다. Worktree 스냅샷은 `.git` 메타데이터를 제외한 일반/미추적/무시된 파일을 포함하고 심볼릭 링크를 따라가지 않습니다. 60,000개 이상의 파일이 있으면 부분 검사로 넘어가지 않고 실패합니다.
- 수정 시도는 **최초 1회 + 추가 2회**, `fixRetries` 와 `validationRetries` 를 독립적으로 사용합니다. 동일 Worktree의 이전 수정 내용은 재시도에서 그대로 유지하고 자동 `reset`, `clean`, `rebase`, 강제 Checkout은 하지 않습니다.
- Codex 실패와 정상 종료 후 변경 없음은 최종 PASS가 아닙니다. 범위 내 부분 변경은 그대로 보존하고 `MODIFYING/PAUSED` 로 정지합니다. 시도 3회가 소진되면 `BLOCKED` 로 처리합니다. 변경이 있는 정상 종료는 `FINAL_VERIFY/READY` 로 전이하며 **최종 검증 결과는 미확정**입니다.
- 실행 중 프로세스가 죽은 경우 `task resume` 은 `PAUSED` 로만 복구합니다. Codex 수정 재실행은 자동 수행하지 않습니다. 사용자가 실제 Worktree 상태를 수동 확인한 다음 `task reconcile-edit --task ID --ack-partial` 을 명시해야 이미 예약된 수정 시도를 소비한 것으로 확정하고 다음 시도를 할 수 있습니다. 허용하지 않은 변경이 발견되면 차단됩니다.
- Codex 에는 `WHATAP_*`, `AWS_*`, `GH_TOKEN`, `GITHUB_TOKEN` 등의 환경 변수와 서비스 MCP 연동을 전달하지 않도록 설정했습니다. Codex 의 네트워크 접근 제한 및 `workspace-write` 적용 여부는 실 Ubuntu 환경에서 실제 CLI 정책 확인이 필요합니다.

### 설치 및 오프라인 점검 (이전 C1과 같은 방식)

`whatap-harness-v0.5.0-phaseC2.zip` 파일을 Ubuntu 사용자 홈(`~/`)에 업로드한 후 다음 명령 블록을 실행합니다. **설정 파일과 기존 runs/ 는 유지**합니다.

```bash
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseC2.json
unzip -o ~/whatap-harness-v0.5.0-phaseC2.zip
cp ~/whatap-harness-config-backup-v050-phaseC2.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phasec2-check.sh
```

로그는 `~/whatap-harness-v0.5.0-phaseC2-check.log` 에 기록합니다. 이 스크립트는 기존 회귀 테스트, C2 신규 모의 Worktree 테스트, 가짜 CLI `task modify` 거부 테스트만 실행합니다. **실제 Codex, 실서비스 WhaTap API, 실제 MCP 저장소 변경, Push/PR은 실행하지 않습니다.** 기존 `node_modules` 를 보존합니다. 신규 설치에는 `npm install` 이 선행되어야 합니다.

### C2 수정 실행 (실환경에서 Codex 가 실제 MCP 소스를 수정하므로 별도 명령)

```bash
# C1 수정 전 독립 게이트가 PASS로 통과하여 MODIFYING/PAUSED 상태인 작업만
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
node dist/cli.js task modify --task task-xxxxxxxx-xxxxxxxx

# 소스 변경과 검증 대기 상태를 확인
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
git -C ~/wpr/whatap-open-mcp-agent status --short
git -C ~/wpr/whatap-open-mcp-agent diff --stat
```

수정 후 `FINAL_VERIFY/READY` 이면 **Phase D 구현 전까지 더 진행하지 마세요.** Codex 가 소스를 수정했어도 MCP/HTTP 전송값이 실제로 맞는지는 아직 판단하지 않았습니다. 실제 수정 이전의 `5m` 와 같은 **상대시간 조회는 대부분 C1의 동일 절대 기간 게이트를 통과하지 못할 수 있습니다.** 고정 시간 구간 재현 지원은 별도 설계/구현이 필요하며 이 패키지에서 조건을 느슨하게 하지 않았습니다.

### 수정 중 프로세스 중단 시

```bash
node dist/cli.js task resume --task task-xxxxxxxx-xxxxxxxx
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
git -C ~/wpr/whatap-open-mcp-agent status --short
git -C ~/wpr/whatap-open-mcp-agent diff
# 위 파일과 불일치 원인을 직접 확인한 경우에만:
node dist/cli.js task reconcile-edit --task task-xxxxxxxx-xxxxxxxx --ack-partial
```

이 명령은 수정 시도 하나를 **중단된 시도로 소비**하고 보존된 변경을 재평가하지만, 승인 없이 자동 편집을 재실행하거나 원본을 삭제하지 않습니다. 남은 수정 시도가 있으면 이후 `task modify` 를 별도로 호출해야 합니다.

### 한계와 다음 단계

- 테스트는 자체 모의 Git Worktree/가짜 Codex Executor로 실행합니다. Ubuntu 실 Codex CLI의 특정 플래그 지원 여부 및 sandbox 효과는 통합 확인 전까지 검증되지 않았습니다.
- C1의 절대기간 불일치 게이트를 우회하지 않았으며, C2는 실행된 MCP 수정 결과의 인과관계를 확정하지 않습니다.
- 스냅샷 및 Git 검사로 Worktree 내부 변경을 통제하지만, 운영체제 수준의 외부 파일 변조 방지를 증명하는 것은 아닙니다. Codex 의 sandbox는 추가 보호층입니다.
- 테스트 파일 변경만으로 회귀 성공을 주장하지 않으며, Phase D에서 새 MCP 빌드/독립 HTTP/MCP 검증 및 전체 회귀 테스트가 필요합니다.
- Phase E의 Commit/Push/PR 동작은 여전히 구현 및 호출하지 않습니다.

---

# WhaTap Harness v0.5.0-alpha.3-c1 — Phase C/1: AI 원인 분석 + 수정 전 독립 게이트

이 버전은 Phase B(`0.5.0-alpha.2`)의 검증 1회 + 재시도 3회(30/60/120초) 위에 **Codex 구조화된 읽기 전용 원인 분석**과 **수정 전 새로운 MCP/HTTP 대조**를 추가한 **Phase C 1차 구현**입니다.

**중요:** 이번 패키지에서는 코드 수정, 최종 수정 후 재검증, Git Commit/Push/PR 을 수행하지 않습니다. 해당 기능은 Phase C/2 이후입니다. Git/Worktree 관리는 사용자와 합의한 고정 `agent` / `submission` 브랜치 정책을 준수합니다. 이 패키지는 원격 Git 조작을 전혀 하지 않습니다.

## 추가 기능

- `ANALYZING/PAUSED` 작업에서 `task analyze --task ID --worktree PATH` 로 Codex 를 `read-only` 샌드박스에서 실행하고, 메인 Git checkout 대신 별도의 linked Git Worktree(브랜치 `agent`)만 사용합니다. Codex 에 WhaTap 토큰을 전달하지 않고 글로벌 사용자 Codex 설정/규칙을 사용하지 않습니다. 구조화된 결과는 엄격히 검증된 `analysis.json` 과 한국어 `analysis.md` 로 보존합니다. 실제 Codex CLI 가 필요합니다.
- Codex 보고서에는 문제/영향/원인 가설/재현 절차/기대·실제 결과/수정 후보/제약을 강제합니다. **Codex 진술 자체는 독립 검증 결과로 취급하지 않습니다.** `API_LIMITATION`, `HARNESS_DEFECT`, `UNKNOWN` 의 경우 MCP 수정으로 연결하지 않습니다.
- `task precheck --task ID` 는 별도의 새 `runAgentHarness` 검증을 수행하고 원본 MCP/HTTP 저장 증거를 대조합니다. 기존 FAIL 과 새로운 FAIL 의 **MCP 실제 경로·전체 호출 인자·불일치 사유**가 동일해야 합니다. 기존 또는 새 원본 증거의 SHA-256 이 다르면 게이트가 통과하지 않습니다.
- **절대 Period 까지 동일한 경우**에만 다음 상태 `MODIFYING/PAUSED` 로 이동합니다. 상대 조회 구간(`5m` 등)이 움직여 같은 종류의 FAIL 이 나와도 `PRE_FIX_VERIFY/PAUSED` 로 남겨 **같은 레코드를 확인했다고 과장하거나 자동 수정 허용하지 않습니다**. 고정 Period 조회 지원은 다음 단계의 과제로 남깁니다.
- `PRE_FIX_VERIFY` 중 UNVERIFIABLE 시 30/60/120초 자동 재시도하며 별도 `validationRetries.PRE_FIX_VERIFY` 카운터를 기록합니다. 수정 시도 횟수(`fixRetries`)를 소비하지 않습니다. 프로세스 재실행은 기존 예약 시간을 유지합니다.
- 분석 중 종료되면 Worktree 를 유지하고 `ANALYZING/PAUSED` 로 복구합니다. 독립 재검증 중 종료되면 미완료 시도를 PASS 로 취급하지 않고 같은 ordinal 로 복구합니다. 모든 진단/중간 검증 문서는 `runs/tasks/<task-id>/` 의 JSON/Markdown 으로 저장됩니다.

**현재 한계:** 복수 MCP 호출에서 어떤 호출이 원인인지 불명확한 경우, 원인 분류를 MCP 코드 결함으로 확정하지 않습니다. 고정 절대 Period 로 MCP 를 재조회할 수 없는 기존 상대 시간 조회는 다음 단계에서 별도 설계가 필요합니다. 읽기 전용 Codex 분석 자체는 이 개발 컨테이너에서 실제 서비스 호출을 검증하지 못했으며 Ubuntu 에서 별도 확인해야 합니다.

## Ubuntu 기존 설치에 적용

SCP 로 `whatap-harness-v0.5.0-phaseC1.zip` 파일을 `~/` 에 업로드한 뒤 다음 하나의 명령 블록을 실행합니다. 기존 설정과 runs 디렉터리는 보존됩니다.

```bash
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseC1.json
unzip -o ~/whatap-harness-v0.5.0-phaseC1.zip
cp ~/whatap-harness-config-backup-v050-phaseC1.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phasec1-check.sh
```

점검 로그: `~/whatap-harness-v0.5.0-phaseC1-check.log`. 해당 스크립트는 **오프라인 테스트만 수행**하며 실제 Codex·WhaTap API·Git 원격 조작은 하지 않습니다.

## 실제 AI 분석 / 중간 검증(실서비스·Codex 필요, 자동 실행하지 않음)

```bash
# 기존 Phase B 검증이 4회 후 실제 FAIL 로 종료되어 ANALYZING/PAUSED 인 경우만
node dist/cli.js task analyze --task task-xxxxxxxx-xxxxxxxx --worktree ~/wpr/whatap-open-mcp-agent

# 원인 분류가 MCP_DEFECT 일 때만. 실제 WhaTap API 재호출 발생
node dist/cli.js task precheck --task task-xxxxxxxx-xxxxxxxx

# 작업 상태 및 근거
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json
```

`--worktree` 경로는 실제로 생성되어 있어야 하는 Git linked Worktree 여야 하고 현재 브랜치는 반드시 `agent` 여야 합니다. 기존 MCP checkout 에서 직접 실행하지 않습니다. WhaTap API 토큰은 HTTP 검증 단계에서만 종전 환경변수로 전달되며, 분석 Codex 의 환경에서는 제거합니다. 분석 결과를 바탕으로 **코드를 수정하는 명령은 아직 존재하지 않습니다**.

---

# WhaTap Harness v0.5.0-alpha.2 — Phase B: 자동 검증 재시도 및 중단 복구

이 버전은 v0.5.0-alpha.1(Phase A) 위에 **FAIL / UNVERIFIABLE 자동 검증 재시도**를 추가합니다. Codex AI 자동 수정, Git Commit/Push/PR 자동화는 아직 수행하지 않습니다. v0.4.6 에서 검증된 5개 지표의 독립 API 대조 로직은 그대로 유지합니다.

## 동작 정책

- **최초 검증 1회 + 추가 재시도 최대 3회**, 대기 시간은 30초 → 60초 → 120초 (Exponential Backoff) 입니다.
- FAIL 은 실제 대조 불일치로, 한도를 소진하고 최종 판정도 FAIL 이면 `ANALYZING/PAUSED` 에서 **원인 분석 대기**합니다. 자동 코드 수정은 하지 않습니다.
- UNVERIFIABLE 는 판정 근거 부족/실행 불능을 의미하며, 한도 소진 후 `INITIAL_VERIFY/BLOCKED` 에 남깁니다. **MCP 버그로 단정하지 않습니다.** 실행 예외도 UNVERIFIABLE 로 기록하고 검증 근거가 없다는 사실을 구분합니다.
- UNMAPPED/UNSUPPORTED 는 재시도만으로 해결되지 않는 상태로 취급해 자동 재시도 없이 차단하고 보고합니다.
- 중간에 PASS 하면 즉시 성공 종료합니다. `validationRetries` 와 `fixRetries` 는 별개로 관리하며, Phase B 는 `fixRetries` 를 전혀 소비하지 않습니다.
- `runs/tasks/<taskId>/state.json` 의 `nextAttemptAt`, `validationRetries`, `validationHistory`, `activeValidationAttempt` 를 안전하게 기록하고, 재개해도 이미 예약된 재시도를 중복 차감하지 않습니다. 완료된 모든 검증의 증거 해시를 검사합니다.
- 결과가 반복되어 종료되면 `retry-report.json` 과 `retry-report.md` 에 전체 시도/결과/증거 해시를 보존합니다. 기존 `runs/<run-id>/` 의 원본 파일은 변경하지 않습니다.
- **주의:** 기존 Codex MCP 도구의 `1h` 같은 상대 시간 표현을 사용하는 경우 재시도 시 관찰 기간이 달라질 수 있습니다. 매 시도의 기간을 별도로 저장하며, 동일 레코드/동일 기간의 재현으로 과장하지 않습니다. 고정 기간 재현과 코드 원인 분석은 Phase C 중간 검증에서 처리합니다.

## Ubuntu 적용 및 오프라인 검사

ZIP 을 `~/whatap-harness-v0.5.0-phaseB.zip` 으로 SCP 업로드한 뒤 다음을 실행합니다. 기존 설정과 `runs/` 를 보존합니다.

```bash
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v050-phaseB.json
unzip -o ~/whatap-harness-v0.5.0-phaseB.zip
cp ~/whatap-harness-config-backup-v050-phaseB.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
bash tools/run-v050-phaseb-check.sh
```

신규 디렉터리에 처음 설치하는 경우 `npm install` 로 의존성을 먼저 설치해야 합니다. 기존 `~/wpr/whatap-harness` 에 덮어쓰면 `node_modules` 는 유지됩니다.

로그는 `~/whatap-harness-v0.5.0-phaseB-check.log` 입니다. 자동 테스트와 가상 시계를 사용하는 재시도 테스트가 포함되며 **실제 Codex/MCP/HTTP/GitHub 호출은 없습니다.**

## 작업 CLI

```bash
# 실제 검증 + 실패 시 자동으로 30/60/120초 대기 후 최대 3회 재검증
node dist/cli.js task start --scenario apm-tps-series

# 저장된 작업의 예약 시각/이력을 확인 (조회 전용)
node dist/cli.js task status --task task-xxxxxxxx-xxxxxxxx --json

# 강제 종료 후 마지막 체크포인트부터 재개 (대기 시각 존중)
node dist/cli.js task resume --task task-xxxxxxxx-xxxxxxxx

# 대기하지 않고 현재 결과만 남긴 뒤 프로세스 종료, 이후 resume 필요
node dist/cli.js task start --scenario apm-tps-series --no-wait

# 검증 없이 작업 상태만 생성
node dist/cli.js task start --scenario apm-tps-series --no-run
```

`task resume` 도 `--no-wait` 를 지원합니다. 실행 프로세스가 살아 있는 동안은 자동 대기/재시도하지만, 서버 재부팅 등으로 프로세스가 종료되면 **`resume` 명령을 다시 실행해야 합니다**. systemd 자동 재시작은 후속 단계에서 논의합니다. 하나의 Worktree 에 대해 실행 잠금은 대기 시간에도 유지됩니다. 다른 검증 작업과 병행하지 않습니다. 구버전 Phase A 의 상태 파일은 `validationHistory` 필드가 없더라도 계속 읽을 수 있습니다.

---

---

# WhaTap Harness v0.4.6 — APM 통계 2종 정식 검증 통합

기존 v0.4.5 에는 서버·TPS·오류 시계열 비교는 있었지만 트랜잭션·Exception 통계는 `UNMAPPED` 였습니다. v0.4.6 은 실측으로 검증된 두 MXQL 경로를 **Harness 의 5개 정식 시나리오**에 추가합니다.

| 통계 | 기존 WhaTap MCP 의 실행 가능 MXQL | 독립 HTTP v2 통계 | 5분 버킷 집계 키 | 값 |
|---|---|---|---|---|
| 트랜잭션 | `mxql/app/stat_tx_pcode` | `/open/api/v2/stat/transaction` | `tx_hash` ↔ `serviceHash` | `tx_count/count`, `tx_error/error`, `tx_time_sum/timeSum` |
| Exception | `mxql/app/stat_error_pcode` | `/open/api/v2/stat/error` | `classHash + serviceHash + MXQL.msg` ↔ `classHash + serviceHash + v2.msgHash` | `count` |

## 검증 동작

1. Codex 에 자연어 질문을 주고 기존 Whatap MCP 의 실제 `tools/call` 을 기록합니다. Harness 는 MCP 호출의 `path/timeRange/limit` 을 강제하지 않습니다.
2. MCP 의 실제 `Period` 로 독립 HTTP `whatap_http_mxql_path` 를 조회하고, **모든 표시 열**을 비교합니다(결측 원본 `undefined/null` ↔ 표시 `-` 포함). MCP 표가 100건만 표시해도 이 100건에 대한 전송/렌더링 정확성을 검증합니다.
3. `Period` 내에 완전히 들어오는 5분 버킷만을 고릅니다: `ceil(stime/300000)*300000` 부터 `floor(etime/300000)*300000` **미만**까지. 같은 구간의 독립 HTTP v2 통계를 조회합니다.
4. HTTP MXQL **전체 데이터**를 직접 집계해 v2 의 모든 해시별 그룹·수치와 비교합니다. 이 단계는 **MCP 가 전체 데이터 행을 반환했다는 주장이 아닙니다.** 기간·그룹·필드·원본 완전성 확인이 실패하면 `UNVERIFIABLE`, 실제 수치 차이가 입증되면 `FAIL` 입니다.
5. `runs/*/report.json` 과 `report.md` 에 HTTP MXQL 와 v2 원본 증거 파일·SHA-256·MCP 표시 행/HTTP 전체 행·버킷 개수를 보관합니다. `tools/replay-run.mjs` 는 API 재호출 없이 모든 증거를 다시 검증합니다.

**주의:** 이번 버전은 읽기 전용이며 AI 자동 코드 수정은 아직 구현하지 않았습니다. 실행 불가능한 Yard 템플릿 탐색은 통계 검증에 억지로 포함하지 않고 별도 안내합니다. 같은 통계 경로를 여러 번 조회한 경우에는 기존 규칙대로 **모든 유효 조회를 개별 비교**합니다.

## Ubuntu 업그레이드 및 통합 재검증 (명령 블록 하나)

SCP 로 `whatap-harness-v0.4.6.zip` 를 `~/` 에 업로드해 주세요. `~/wpr` 의 기존 Harness·MCP·HTTP Client 가 설치되어 있어야 합니다. `WHATAP_API_TOKEN`, `WHATAP_HTTP_API_TOKEN` 이 **현재 셸에 export** 되어 있어야 합니다.

```bash
cd ~/wpr
cp whatap-harness/config/harness.json ~/whatap-harness-config-backup-v046.json
unzip -o ~/whatap-harness-v0.4.6.zip
cp ~/whatap-harness-config-backup-v046.json whatap-harness/config/harness.json
cd ~/wpr/whatap-harness
node tools/migrate-v046-config.mjs
bash tools/run-v046-check.sh
```

`tools/migrate-v046-config.mjs` 는 기존 설정을 유지하며 **APM 통계 2개 시나리오의 매핑만** 반영합니다. 유저가 수정한 다른 설정과 질문은 보존합니다. `runs/` 는 덮어쓰거나 삭제하지 않습니다.

`tools/run-v046-check.sh` 는 빌드/자동 테스트, 환경 점검, APM 통계 2종 Codex 실제 조회, 오프라인 재검증, 보고서/요약을 실행합니다. **전체 로그: `~/whatap-harness-v0.4.6-check.log`**.  초기 통합 확인에서는 LLM 이 알고 있는 실행 가능 경로를 **사용자 요청 문장에 힌트로 제공**합니다. 자동 도구 경로 발견 능력 자체는 이후 MCP 카탈로그 개선 검증으로 분리합니다.

기존 5개 전체 시나리오 실행: `npm run run` (시간 및 토큰 비용 발생). 자동화된 API 비교를 다시 실행하지 않고 증거 재검증만 하려면 `node tools/replay-run.mjs runs/<run-id>`.

## 범위와 한계

- 트랜잭션 집계는 건수/오류/응답시간 합계에 한정합니다. 모든 상세 지표나 LLM 최종 서술 전체의 완전성을 자동 보장하지 않습니다.
- Exception 집계는 클래스·서비스·**메시지 해시**별 발생 건수에 한정합니다. 원문 메시지의 정확성은 별도 검증 대상입니다.
- 독립 HTTP MXQL 와 v2 API 의 응답은 읽기 전용이며 실제 값이 조회 중 갱신될 수 있습니다. 결과가 변하면 증거를 남긴 뒤 추가 조사해야 합니다.
- MCP 기본 표시 100건 제한은 그대로입니다. `PASS` 는 표시 행 원본 대조와 독립 HTTP 전체 집계가 각각 성공했다는 의미이며 **전체 데이터를 MCP 가 전달했다는 뜻이 아닙니다.**
- API 통계 반환 `total/retrievedTotal` 의 일치, 5분 버킷 완전성, 필드가 숫자인지 등을 확인하지 못하면 전체 집계 PASS 가 나오지 않습니다.
- 토큰은 환경변수로만 전달하고 결과는 `runs/` 에 권한 제한으로 보관합니다. 실행 결과에는 Exception 메시지 원문이 포함될 수 있으므로 원본 증거 디렉터리를 공개 저장소에 올리지 마세요.
- 본 배포 환경에서는 **실제 Ubuntu Codex/WhaTap API 호출을 실행하지 않았습니다.** 모의 서버·Codex 로 실행 및 회귀 테스트를 완료했고, 제공한 명령 블록이 실환경 검증 단계입니다.

## 기존 기능

v0.4.5 의 5초 버킷 보정(동일 경로의 HTTP 경계 재조회), 복수 MCP 호출 독립 검증, 프록시 기록, 한국어 보고서, 오프라인 재검증은 유지합니다. 기존 성공/실패 시나리오 회귀 테스트도 계속 수행합니다.
