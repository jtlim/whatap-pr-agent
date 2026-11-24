# WhaTap Harness v0.1.0 실측 증거 재검증 도구

기존 `whatap-harness` 소스를 수정하지 않고, `runs/` 에 저장된 **실제 WhaTap HTTP API 응답과 실제 MCP 결과**를 사용해 검증 로직을 확인합니다.

## 설치 (기존 Harness 폴더 안에서)

```bash
cd /home/ubuntu/wpr/whatap-harness
unzip /home/ubuntu/wpr/whatap-validation-audit.zip
```

추가 NPM 패키지 불필요. 기존 Harness `npm test` 에서 빌드한 `dist/validator.js` 를 사용합니다.

## 실행

```bash
cd /home/ubuntu/wpr/whatap-harness
node tools/verify-snapshots.mjs
```

`runs/` 에서 가장 최근 `report.json` 을 자동 선택합니다. 특정 실행을 지정하려면:

```bash
node tools/verify-snapshots.mjs runs/2026-11-22T11-51-40-802Z-XXXXXXXX
```

시나리오 순서:
1. 실측 HTTP 서버 데이터와 동일한 복제본을 비교해 PASS 확인
2. 실측 CPU 값 하나 변조 후 FAIL 확인
3. 실측 TPS 데이터에서 5초 간격 하나 제거 후 FAIL 및 누락 탐지 확인
4. 필수 필드 삭제, 숫자→문자열 변경 후 FAIL 확인. 추가로 양쪽 모두 문자열일 때 잘못 PASS 되는지 검사
5. 저장된 **실제** MCP 응답과 실측 HTTP 응답을 비교/판정. 현재 절대 시간 형식 오류이면 정직하게 UNVERIFIABLE 보고

실제 API 재호출, MCP 재호출, 파일 쓰기, WhaTap MCP 코드 수정은 전혀 없습니다. SHA-256 검증 및 요청 조건 검증 후 데이터를 읽습니다. 원본 데이터 출력 없이 한국어 결과만 출력합니다.

**주의:** 현재 v0.1.0 비교기에서 양쪽의 숫자 필드가 동일한 문자열이면 잘못 PASS 처리하는 결함이 있을 가능성이 있습니다. 감사 도구는 이 문제를 발견하면 `문제` 로 출력하고 종료 코드 `1` 을 설정합니다. 이 결과는 감사 도구의 오작동이 아니라 발견한 검증기 결함을 뜻합니다. 기존 코드의 실제 수정은 다음 단계에서 진행할 수 있습니다.

실제 MCP 에서 절대 시간 조회가 실패하면 5번은 값 비교 불가능으로 남습니다. 이 경우 과거 저장된 데이터로 결과를 꾸며 PASS 처리하지 않습니다.
