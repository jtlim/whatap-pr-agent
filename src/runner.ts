import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StdioMcpClient } from './mcp.js';
import { assessReference, classifyMcpResult, compareRows, extractContent, verifyReferenceRequest, isWithinTimeWindow } from './validator.js';
import { parseFormattedMcp, forMcpDisplay, expectedDurationMs } from './period.js';
import type { HarnessConfig, McpTool, RunReport, Scenario, ScenarioReport, Status } from './types.js';

function scrubSecrets(value: string): string {
  const secrets = [process.env.WHATAP_API_TOKEN, process.env.WHATAP_HTTP_API_TOKEN].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return secrets.reduce((v, secret) => v.replaceAll(secret, '[REDACTED]'), value);
}
async function writeEvidence(dir: string, name: string, data: unknown): Promise<{file: string; sha256: string}> {
  const file = `raw/${name}.json`;
  const raw = scrubSecrets(JSON.stringify(data, null, 2));
  await writeFile(join(dir, file), raw + '\n', { flag: 'wx', mode: 0o600 });
  return { file, sha256: createHash('sha256').update(raw + '\n').digest('hex') };
}
function initScenario(s: Scenario): ScenarioReport {
  return {
    id: s.id, domain: s.domain, projectCode: s.projectCode,
    timeWindow: { stime: s.stime, etime: s.etime },
    referenceTool: s.referenceTool, mcpTool: s.mcpPath ? 'whatap_query_data' : null,
    mcpPath: s.mcpPath, status: 'UNVERIFIABLE', reason: 'NOT_EXECUTED',
    checks: [], reference: {}, candidate: {},
  };
}
function limitDetail(error: unknown): string {
  return scrubSecrets(String(error instanceof Error ? error.message : error)).slice(0, 800);
}
async function retry<T>(count: number, fn: () => Promise<T>): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt <= count; attempt++) {
    try { return await fn(); } catch (e) { failure = e; }
  }
  throw failure;
}
function currentRunDir(config: HarnessConfig): string {
  return resolve(config.outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
}
export async function inspectConfig(config: HarnessConfig): Promise<Array<{item: string; ok: boolean; note: string}>> {
  const checks: Array<{item: string; ok: boolean; note: string}> = [];
  for (const [name, path] of Object.entries(config.servers)) {
    const file = await stat(path).catch(() => null);
    checks.push({ item: `${name} MCP entry`, ok: file?.isFile() === true, note: path });
  }
  for (const name of ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN']) {
    checks.push({ item: name, ok: !!process.env[name], note: process.env[name] ? 'set (value hidden)' : 'missing' });
  }
  checks.push({ item: 'scenarios', ok: config.scenarios.length >= 1 && config.scenarios.every(s=>!!s.userRequest),
    note: `${config.scenarios.length} scenarios (LLM natural language requests)` });
  return checks;
}

function getMcpArgs(tool: McpTool, s: Scenario): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  if (!('timeRange' in props)) throw new Error('MCP tool does not accept relative timeRange');
  if (!('limit' in props)) throw new Error('MCP tool does not expose limit');
  if (!s.mcpTimeRange || !s.mcpLimit) throw new Error('Scenario has no relative time or limit');
  return { projectCode: s.projectCode, path: s.mcpPath, timeRange: s.mcpTimeRange, limit: s.mcpLimit };
}

export async function runHarness(config: HarnessConfig, onProgress: (s: string) => void = () => {}): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const runDir = currentRunDir(config);
  await mkdir(join(runDir, 'raw'), { recursive: true, mode: 0o700 });
  const reports = config.scenarios.map(initScenario);
  let candidate: StdioMcpClient | undefined;
  let refClient: StdioMcpClient | undefined;
  let candidateTools: McpTool[] = [], referenceTools: McpTool[] = [];
  let candidateStartupError: string | undefined, referenceStartupError: string | undefined;
  onProgress('1/2단계: WhaTap MCP 상대 시간 조회 및 Period 확인');
  try {
    candidate = new StdioMcpClient(config.servers.candidate, config.rpcTimeoutMs);
    await candidate.start();
    candidateTools = await candidate.listTools();
    await writeEvidence(runDir, 'candidate-tool-schemas', candidateTools);
  } catch (e) { candidateStartupError = limitDetail(e); }
  try {
    refClient = new StdioMcpClient(config.servers.reference, config.rpcTimeoutMs);
    await refClient.start();
    referenceTools = await refClient.listTools();
  } catch (e) { referenceStartupError = limitDetail(e); }

  try {
    for (const [i, s] of config.scenarios.entries()) {
      const r = reports[i];
      let candidateRows: Array<Record<string, unknown>> | undefined;
      if (!s.mcpPath) {
        r.status = 'UNMAPPED'; r.reason = 'NO_EQUIVALENT_MCP_STATISTICS_TOOL_CONFIGURED';
        onProgress(`  MCP ${s.id}: UNMAPPED (APM 통계 도구 매핑 없음)`);
      } else if (candidateStartupError) {
        r.reason = 'CANDIDATE_MCP_UNAVAILABLE'; r.candidate.error = candidateStartupError;
      } else {
        const tool = candidateTools.find(t => t.name === 'whatap_query_data');
        if (!tool) { r.status = 'UNSUPPORTED'; r.reason = 'CANDIDATE_QUERY_TOOL_MISSING'; }
        else {
          try {
            const args = getMcpArgs(tool, s);
            r.candidate.args = args; r.candidate.requestedLimit = s.mcpLimit;
            const result = await retry(config.retryCount, () => candidate!.callTool('whatap_query_data', args));
            Object.assign(r.candidate, await writeEvidence(runDir, `${s.id}-candidate`, result));
            const parsed = classifyMcpResult(result);
            if (parsed.kind === 'error') {
              r.reason = 'MCP_QUERY_FAILED'; r.candidate.error = scrubSecrets(parsed.error ?? '').slice(0, 1000);
            } else if (parsed.kind === 'raw') {
              // Some future MCP versions may return JSON. Without an exposed exact
              // query window, this is not enough to bind an independent HTTP request.
              r.reason = 'MCP_PERIOD_MISSING_OR_INVALID';
            } else {
              const formatted = parseFormattedMcp(parsed.text ?? '', [...(s.matchKeys ?? []), ...(s.compareFields ?? [])]);
              if (!formatted.ok) {
                r.reason = formatted.reason;
                r.candidate.evidence = scrubSecrets(parsed.text ?? '').slice(0, 600);
              } else {
                const data = formatted.data;
                const duration = expectedDurationMs(s.mcpTimeRange ?? '');
                r.candidate.period = data.period.label;
                r.candidate.parsedRows = data.rows.length;
                r.timeWindow = { stime: data.period.stime, etime: data.period.etime };
                r.candidate.comparisonPrecision = 'MCP 출력 기준: 실수 소수점 2자리';
                const within = data.rows.every(row => isWithinTimeWindow({...s,stime:data.period.stime,etime:data.period.etime},row.time));
                r.checks.push({code:'MCP_PERIOD',ok:duration===data.period.etime-data.period.stime,
                  detail:`MCP ${s.mcpTimeRange} · ${data.period.label} · 실제 ${data.period.etime-data.period.stime}ms`});
                r.checks.push({code:'MCP_ROW_WINDOW',ok:within,detail:within?'MCP 표의 모든 타임스탬프가 Period 내에 있음':'MCP 표에 Period 밖의 행 존재'});
                r.checks.push({code:'MCP_TRUNCATION',ok:!data.truncated && data.rows.length < s.mcpLimit!,
                  detail:`MCP 표 ${data.rows.length}건 / 요청 limit=${s.mcpLimit} / 출력 잘림 경고=${data.truncated}`});
                if (duration !== data.period.etime-data.period.stime) r.reason = 'MCP_PERIOD_DURATION_MISMATCH';
                else if (!within) r.reason = 'MCP_ROWS_OUTSIDE_PERIOD';
                else if (data.truncated || data.rows.length >= s.mcpLimit!) r.reason = 'MCP_OUTPUT_TRUNCATED_OR_LIMITED';
                else candidateRows = data.rows;
              }
            }
          } catch(e) { r.reason = 'CANDIDATE_TOOL_CALL_FAILED'; r.candidate.error = limitDetail(e); }
        }
        onProgress(`  MCP ${s.id}: ${candidateRows ? `${candidateRows.length}건 · Period 확인` : reasonKo(r.reason)}`);
      }

      // The reference query deliberately follows the candidate and reuses only
      // its Period. API endpoint, query path and project remain scenario-owned.
      // Unmapped APM stats retain the fixed archive window for reference-only checks.
      onProgress(`2/2단계: HTTP 기준 조회 — ${s.id}`);
      if (referenceStartupError) {
        r.reference.error=referenceStartupError;
        if (candidateRows) r.reason='REFERENCE_MCP_UNAVAILABLE';
        continue;
      }
      if (!referenceTools.some(t=>t.name===s.referenceTool)) {
        r.reference.error=`Missing ${s.referenceTool}`;
        if (candidateRows) r.reason='REFERENCE_TOOL_NOT_FOUND';
        continue;
      }
      // When the candidate did not produce a period, do not fabricate one.
      if (s.mcpPath && !candidateRows) continue;
      const effective: Scenario = {...s, stime:r.timeWindow.stime, etime:r.timeWindow.etime};
      try {
        const response = await retry(config.retryCount, () => refClient!.callTool(s.referenceTool, {
          projectCode:s.projectCode,stime:effective.stime,etime:effective.etime,
        }));
        Object.assign(r.reference, await writeEvidence(runDir, `${s.id}-reference`, response));
        const payload = extractContent(response);
        if (response.isError) {
          r.reference.error=scrubSecrets(JSON.stringify(payload)).slice(0, 800);
          if (candidateRows) r.reason='REFERENCE_TOOL_ERROR';
          continue;
        }
        const assessment=assessReference(effective,payload);
        const requestCheck=verifyReferenceRequest(effective,payload);
        assessment.checks.push(requestCheck);
        if (!requestCheck.ok) assessment.complete=false;
        r.checks.push(...assessment.checks);
        const wrapped=payload as {status?:number;request?:{path?:string}};
        r.reference.httpStatus=wrapped?.status;
        r.reference.apiPath=wrapped?.request?.path;
        r.reference.rowCount=assessment.rows?.length;
        r.reference.total=assessment.total;
        r.reference.retrievedTotal=assessment.retrievedTotal;
        if (!assessment.complete) {
          if (candidateRows) r.reason='REFERENCE_DATA_NOT_VERIFIABLY_COMPLETE';
        } else if (candidateRows) {
          // whatap_query_data intentionally converts noninteger numeric fields
          // to fixed two-decimal text. Compare against exactly that representation.
          const normalized=forMcpDisplay(assessment.rows!,s.compareFields ?? []);
          const comparison=compareRows({...effective,absoluteTolerance:0}, normalized, candidateRows);
          r.status=comparison.status;
          r.reason=comparison.reason;
          r.checks.push(...comparison.checks);
        }
        onProgress(`  HTTP ${s.id}: ${r.reference.httpStatus}, ${r.reference.rowCount}건 · 판정 ${r.status} (${reasonKo(r.reason)})`);
      } catch(e) {
        r.reference.error=limitDetail(e);
        if (candidateRows) r.reason='REFERENCE_TOOL_FAILED';
        onProgress(`  HTTP ${s.id}: 오류 ${r.reference.error}`);
      }
    }
  } finally { await candidate?.close(); await refClient?.close(); }
  const totals = {PASS:0, FAIL:0,UNVERIFIABLE:0,UNMAPPED:0,UNSUPPORTED:0} satisfies Record<Status,number>;
  for(const r of reports) totals[r.status]++;
  const report: RunReport={
    harnessVersion:'0.3.0',startedAt,finishedAt:new Date().toISOString(),runDir,
    mode:'observe-only',sourceModified:false,scenarios:reports,totals,
    notes:[
      'AI/Codex 호출 및 WhaTap MCP 소스 수정은 수행하지 않았습니다.',
      '비교 가능 항목은 MCP 상대 시간 조회 → 표시된 UTC Period → HTTP API 동일 구간 조회 순서로 실행했습니다.',
      'HTTP 요청의 프로젝트·MXQL 경로는 고정 시나리오가 선택하며 MCP 출력으로 변경하지 않습니다.',
      'MCP 는 시간의 밀리초를 표시하지 않습니다. 실제 전송된 시각과 최대 999ms 차이가 있을 수 있습니다.',
      'MCP 는 실수를 소수점 둘째 자리로 표시합니다. PASS 는 원본 전 자릿수 일치가 아닌 MCP 출력 정밀도 기준 일치입니다.',
      'MCP 에서 원본 조회 결과가 잘렸거나 요청 limit 에 도달한 경우 PASS 처리하지 않습니다.',
      'MCP 표에 없는 필드·모호한 식별자·표 파싱 실패는 PASS 처리하지 않습니다.',
      'APM 통계 두 시나리오는 MCP 도구 매핑이 없어 기존 고정 시간에 대한 HTTP 기준 데이터만 수집합니다.',
      'API 재조회 시점에 데이터가 지연 유입되면 일부 값이 달라질 수 있습니다.',
      'WhaTap MCP 의 실제 전송 HTTP 요청 및 Text/Path API 선택은 MCP 도구 응답만으로 독립 확인할 수 없습니다.',
      'Harness 는 외부 API 응답을 임의로 자르지 않지만, MCP 및 서비스 자체의 응답 제한은 별개입니다.',
    ],
  };
  await writeFile(join(runDir,'report.json'),scrubSecrets(JSON.stringify(report,null,2))+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(runDir,'report.md'),scrubSecrets(makeMarkdown(report)),{mode:0o600,flag:'wx'});
  return report;
}

const STATUS_KO: Record<Status,string> = {PASS:'일치',FAIL:'불일치',UNVERIFIABLE:'검증 불가',UNMAPPED:'도구 매핑 없음',UNSUPPORTED:'기능 미지원'};
const REASON_KO:Record<string,string> = {
  STATS_AGGREGATE_MATCH:'MCP 표시 행과 HTTP MXQL 원본이 일치하고, 5분 버킷 집계가 HTTP v2 통계와 일치함',
  STATS_AGGREGATE_DIFFERENCE:'같은 구간의 전체 MXQL 집계와 HTTP v2 통계가 불일치함 (F5 이전 기록)',
  REFERENCE_INCONSISTENCY:'MCP 표시값은 HTTP MXQL 과 일치했으나 독립 HTTP MXQL/v2 기준끼리 불일치함 (수정 금지)',
  STATS_AGGREGATE_INCOMPLETE:'5분 버킷·식별자·수치 중 집계를 확정할 수 없는 데이터가 있음',
  STATS_MXQL_REFERENCE_INCOMPLETE:'동일 MXQL HTTP 원본 또는 요청 조건이 불완전함',
  STATS_V2_REFERENCE_INCOMPLETE:'HTTP v2 통계 결과가 불완전하거나 요청 조건이 다름',
  STATS_WINDOW_UNAVAILABLE:'5분 단위 집계에 사용할 완전한 구간이 없음',
  STATS_DISPLAY_COLUMNS_INVALID:'MCP 통계 표에 필수 열이 없거나 열 이름이 잘못됨',
  LLM_NO_EQUIVALENT_MCP_STAT_QUERY:'LLM 이 통계에 대응하는 실행 가능한 MCP 조회 경로를 선택하지 못함',
  MATCHING_DATA:'API 와 MCP 표시값이 동일함',FIELD_MISMATCH:'API 와 MCP 의 필드 값이 다름',
  MISSING_OR_EXTRA_RECORDS:'API 와 MCP 의 레코드가 누락되거나 추가됨',
  AMBIGUOUS_RECORD_IDENTITIES:'레코드 식별자가 중복되었거나 누락됨',
  COMPARISON_FIELDS_UNDEFINED:'비교할 필드가 설정되지 않음',
  COMPARISON_FIELD_ABSENT_IN_BOTH:'API 와 MCP 양쪽에 비교 필드가 없음',
  NOT_EXECUTED:'아직 실행되지 않음',
  CANDIDATE_MCP_UNAVAILABLE:'WhaTap MCP 서버 연결 실패',
  CANDIDATE_QUERY_TOOL_MISSING:'MCP 조회 도구 없음',
  CANDIDATE_TOOL_CALL_FAILED:'MCP 도구 호출 실패',
  MCP_QUERY_FAILED:'MCP 가 조회 오류를 반환함',
  MCP_PERIOD_MISSING_OR_INVALID:'MCP 응답에서 UTC Period 를 추출하지 못함',
  MCP_PERIOD_DURATION_MISMATCH:'MCP Period 의 길이가 요청한 상대 시간과 다름',
  MCP_ROWS_OUTSIDE_PERIOD:'MCP 표에 Period 밖의 시각 존재',
  MCP_OUTPUT_TRUNCATED_OR_LIMITED:'MCP 출력이 잘렸거나 요청 행 제한에 도달함',
  MCP_DATA_TABLE_MISSING_OR_AMBIGUOUS:'MCP 데이터 표를 유일하게 식별하지 못함',
  MCP_DUPLICATED_TABLE_COLUMNS:'MCP 표에 중복 열 이름 존재',
  MCP_TABLE_ROW_WIDTH_INVALID:'MCP 표의 열 수가 일치하지 않음',
  MCP_TABLE_TIMESTAMP_INVALID:'MCP 표의 시각을 변환하지 못함',
  MCP_TABLE_NO_ROWS:'MCP 표에 비교 가능한 행이 없음',
  REFERENCE_MCP_UNAVAILABLE:'HTTP 기준 서버 연결 실패',
  REFERENCE_TOOL_NOT_FOUND:'HTTP 기준 조회 도구 없음',
  REFERENCE_TOOL_ERROR:'HTTP 기준 조회 도구 오류',
  REFERENCE_TOOL_FAILED:'HTTP 기준 호출 실패',
  REFERENCE_DATA_NOT_VERIFIABLY_COMPLETE:'HTTP 기준 응답의 범위·건수·요청 조건을 검증할 수 없음',
  NO_EQUIVALENT_MCP_STATISTICS_TOOL_CONFIGURED:'대응 APM 통계 MCP 도구가 설정되지 않음',
  LLM_NO_MATCHING_MCP_QUERY:'LLM 이 해당 프로젝트의 비교 가능한 조회 도구를 호출하지 않음',
  MCP_STARTUP_FAILED:'Codex 에서 WhaTap MCP 초기화(핸드셰이크)가 실패함',
  LLM_MULTIPLE_QUERIES_AMBIGUOUS:'LLM 조회 도구 호출이 여러 개여서 검증 대상을 하나로 확정하지 못함',
  MULTI_CALL_ALL_PASS:'모든 MCP 조회 호출의 표시 데이터가 HTTP 기준과 일치함',
  MULTI_CALL_ANY_FAILED:'복수 MCP 조회 호출 중 하나 이상이 HTTP 기준과 불일치함',
  MULTI_CALL_INCOMPLETE:'복수 MCP 조회 호출 중 검증 불가 항목이 있어 전체 일치를 확정할 수 없음',
  MCP_TAP_INVALID:'MCP 요청·응답 기록 파싱 실패',
  LLM_SELECTED_DIFFERENT_TIME_RANGE:'LLM 이 사용자가 요청한 기간과 다른 기간을 조회함',
  CODEX_EXEC_FAILED:'Codex 실행 실패 (환경 또는 샌드박스 오류 가능)',
  MCP_TOOL_RESULT_MISSING:'Codex 실행 기록에 MCP 도구 원본 응답이 누락됨',
  MCP_METRIC_MAPPING_UNVERIFIED:'MCP 가 선택한 쿼리와 HTTP 지표의 동등성을 증명할 수 없음',
  MCP_SUMMARY_MISMATCH:'MCP 요약 통계가 대응하는 원본 데이터 계산값과 다름',
  MATCHING_DATA_BOUNDARY_REALIGNED:'5초 경계 보정 HTTP 조회에서 MCP 표시값·요약 통계까지 모두 일치함',
};
export function reasonKo(code:string):string {return REASON_KO[code]??`미등록 사유 코드: ${code}`;}
const CHECK_KO:Record<string,string>={STATS_MXQL_REQUEST:'동일 MXQL HTTP 요청 검증',STATS_V2_COMPLETE:'v2 통계 결과 완전성',STATS_MCP_COVERAGE:'통계 MCP 표시 범위',STATS_AGGREGATE:'HTTP v2 집계 대조',STATS_OTHER_PATH_PROBES:'비동등 MCP 경로 탐색',HTTP_OK:'HTTP 상태',PARSE_ROWS:'데이터 배열',STATS_COMPLETENESS:'통계 건수',
  TIME_WINDOW:'조회 시간 범위',TIMESERIES_COVERAGE:'시계열 구간 완전성',MATCH_KEYS:'레코드 식별자',
  RECORD_IDENTITIES:'레코드 대조',FIELD_VALUES:'필드 값',REFERENCE_REQUEST:'HTTP 기준 요청 조건',
  INVALID_REFERENCE:'HTTP 기준 응답 형식',MCP_PERIOD:'MCP 기간',MCP_ROW_WINDOW:'MCP 데이터 시각',MCP_TRUNCATION:'MCP 표시 건수',MCP_END_BUCKET:'시계열 종료 버킷',MCP_SUMMARY:'MCP 요약 통계',DISPLAY_COVERAGE:'표시 데이터 검증 범위',MCP_LIMIT_NOTICE:'MCP 조회 제한 알림',AI_DIAGNOSIS:'AI 원인 분석 (읽기 전용)',MULTI_CALL_RESULTS:'복수 호출 검증 결과',BOUNDARY_SHIFT_DETECTED:'시계열 경계 차이 감지',BOUNDARY_REALIGNED:'시계열 경계 보정 검증',BOUNDARY_RETRY_ERROR:'경계 보정 재조회 오류'};
const DOMAIN_KO={server:'서버',apm:'APM 통계',timeseries:'시계열'} as const;
function windowText(domain: ScenarioReport['domain'], window: ScenarioReport['timeWindow']): string {
  if(!window.stime || !window.etime)return 'MCP Period 미확보';
  return `${window.stime} ~ ${window.etime} (Unix 밀리초; ${domain==='timeseries'
    ? '5초 정렬 종료 시각의 시계열 행은 HTTP 값 대조 조건으로 허용'
    : '종료 시각 제외'})`;
}
const SCENARIO_KO:Record<string,string>={'server-metrics':'서버 CPU·메모리','apm-transaction-stats':'APM 트랜잭션 통계',
  'apm-exception-stats':'APM 예외 통계','apm-tps-series':'APM TPS 시계열','apm-error-series':'APM 오류 시계열'};
function timeKo(iso:string):string {return `${new Date(iso).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})} KST`;}
function markdownEscape(v:unknown):string {return String(v??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');}
function boundaryDetails(ref:ScenarioReport['reference']):string[] {
  const a=ref.boundaryAlignment;
  if(!a)return [];
  return [
    `- **경계 보정:** ${a.selectedDeltaMs===undefined?'시도했으나 검증 실패':`+${a.selectedDeltaMs}ms HTTP 재조회로 검증 성공`}`,
    `- 최초 HTTP 범위: ${a.original.timeWindow.stime} ~ ${a.original.timeWindow.etime}; 증거 ${a.original.file}; SHA-256 ${a.original.sha256}`,
    ...a.attempts.map(v=>`- 보정 HTTP +${v.deltaMs}ms: ${v.timeWindow.stime} ~ ${v.timeWindow.etime}; ${v.status} (${v.reason}); 증거 ${v.file||'없음'}; SHA-256 ${v.sha256||'없음'}`),
  ];
}
function statsDetails(ref:ScenarioReport['reference']):string[]{
  const t=ref.statistics;
  if(!t)return [];
  return [
    `- 동일 MXQL HTTP 원본 증거: ${markdownEscape(t.mxql.file)}; SHA-256 ${t.mxql.sha256}`,
    `- MCP 표시/HTTP MXQL 전체 행: ${t.visibleMcpRows??'미확인'} / ${t.fullMxqlRows??'미확인'}건`,
    `- v2 HTTP 집계 범위: ${t.v2Window.stime} ~ ${t.v2Window.etime} (Unix 밀리초, [stime,etime))`,
    `- v2 HTTP 통계 그룹: ${t.v2RowCount??'미확인'}개; 집계 버킷: ${t.comparedBuckets??'미확인'}개`,
    '- 전체 집계 일치는 HTTP MXQL 전체 원본에 대한 것이며, MCP 가 전체 행을 표시했다는 뜻은 아닙니다.',
  ];
}
function callDetails(r:ScenarioReport):string[] {
  if(!r.callResults?.length)return [];
  return [
    `- **조회 호출 수:** ${r.callResults.length}회 (모든 호출 개별 검증)`,
    '- **상단 API/MCP 행 수 및 증거 파일:** 마지막 기록 호출 기준. 전체 판정은 모든 호출을 종합한 결과입니다.',
    '',
    ...r.callResults.flatMap(c=>[
      `#### MCP 조회 호출 ${c.index}`,'',
      `- **판정:** ${STATUS_KO[c.status]} (${c.status})`,
      `- **판정 이유:** ${reasonKo(c.reason)} (${c.reason})`,
      `- MCP 호출 인자: ${markdownEscape(JSON.stringify(c.candidate.args??{}))}`,
      ...(c.candidate.period?[`- MCP Period: ${markdownEscape(c.candidate.period)}`]:[]),
      `- MCP 표시 행: ${c.candidate.parsedRows??'미확인'}건 / HTTP API 행: ${c.reference.rowCount??'미확인'}건`,
      `- HTTP 상태: ${c.reference.httpStatus??'미확인'}`,
      `- HTTP 조회 범위: ${windowText(r.domain,c.timeWindow)}`,
      ...boundaryDetails(c.reference),
      ...statsDetails(c.reference),
      `- 기준 HTTP 응답 파일: ${markdownEscape(c.reference.file??'없음')}`,
      `- 기준 HTTP SHA-256: ${markdownEscape(c.reference.sha256??'없음')}`,
      `- MCP 응답 파일: ${markdownEscape(c.candidate.file??'없음')}`,
      `- MCP 응답 SHA-256: ${markdownEscape(c.candidate.sha256??'없음')}`,
      ...(c.reference.error?[`- HTTP 기준 오류: ${markdownEscape(c.reference.error)}`]:[]),
      ...(c.candidate.error?[`- MCP 오류: ${markdownEscape(c.candidate.error)}`]:[]),
      ...c.checks.map(check=>`- ${check.ok?'통과':'문제'} | ${CHECK_KO[check.code]??check.code} (${check.code}): ${markdownEscape(check.detail)}`),
      '',
    ]),
  ];
}
export function makeMarkdown(report:RunReport):string {
  const lines=[
    '# WhaTap Harness — 검증 보고서 (읽기 전용)','',
    `- 시작: ${timeKo(report.startedAt)}`,`- 종료: ${timeKo(report.finishedAt)}`,
    `- Harness 버전: ${report.harnessVersion}`,'- WhaTap MCP 소스 수정: 없음','- AI 코드 수정: 비활성화','',
    '## 결과 요약','',
    `- 일치(PASS): ${report.totals.PASS}건`, `- 불일치(FAIL): ${report.totals.FAIL}건`,
    `- 검증 불가(UNVERIFIABLE): ${report.totals.UNVERIFIABLE}건`,
    `- 도구 매핑 없음(UNMAPPED): ${report.totals.UNMAPPED}건`,
    `- 기능 미지원(UNSUPPORTED): ${report.totals.UNSUPPORTED}건`,'',
    '| 검증 항목 | 분야 | 기준 HTTP | API 행 | MCP 표시 행 | 판정 | 사유 |',
    '|---|---|---:|---:|---:|---|---|',
    ...report.scenarios.map(r=>`| ${SCENARIO_KO[r.id]??r.id} | ${DOMAIN_KO[r.domain]} | ${r.reference.httpStatus??'미확인'} | ${r.reference.rowCount??'미확인'}건 | ${r.candidate.parsedRows??'미확인'}건 | ${STATUS_KO[r.status]} (${r.status}) | ${markdownEscape(reasonKo(r.reason))} |`),
    '','## 검증 증거 및 상세 결과','',
    ...report.scenarios.flatMap(r=>[
      `### ${SCENARIO_KO[r.id]??r.id} (${r.id})`,'',
      `- **판정:** ${STATUS_KO[r.status]} (${r.status})`,
      `- **판정 이유:** ${reasonKo(r.reason)} (${r.reason})`,
      `- MCP 실제 조회 인자${r.callResults?.length?' (마지막 기록 호출)':''}: ${r.candidate.args?markdownEscape(JSON.stringify(r.candidate.args)):'호출하지 않음'}`,
      ...(r.candidate.period?[`- MCP Period: ${markdownEscape(r.candidate.period)}`]:[]),
      ...(r.candidate.parsedRows!==undefined?[`- MCP 파싱된 데이터: ${r.candidate.parsedRows}건`]:[]),
      ...(r.candidate.comparisonPrecision?[`- 비교 기준: ${r.candidate.comparisonPrecision}`]:[]),
      `- HTTP 조회 범위: ${windowText(r.domain,r.timeWindow)}`,
      ...(!r.callResults?.length?boundaryDetails(r.reference):[]),
      ...(!r.callResults?.length?statsDetails(r.reference):[]),
      `- 기준 HTTP 응답 파일: ${markdownEscape(r.reference.file??'없음')}`,
      `- 기준 HTTP SHA-256: ${markdownEscape(r.reference.sha256??'없음')}`,
      `- MCP 응답 파일: ${markdownEscape(r.candidate.file??'호출하지 않음')}`,
      `- MCP 응답 SHA-256: ${markdownEscape(r.candidate.sha256??'없음')}`,
      ...(r.reference.error?[`- HTTP 기준 오류: ${markdownEscape(r.reference.error)}`]:[]),
      ...(r.candidate.error?[`- MCP 오류 원문: ${markdownEscape(r.candidate.error)}`]:[]),
      ...(r.candidate.evidence?[`- MCP 응답 요약: ${markdownEscape(r.candidate.evidence)}`]:[]),
      ...r.checks.map(c=>`- ${c.ok?'통과':'문제'} | ${CHECK_KO[c.code]??c.code} (${c.code}): ${markdownEscape(c.detail)}`),
      '',
      ...callDetails(r),
    ]),
    '## 검증의 한계','',...report.notes.map(n=>`- ${n}`),'',
  ];
  return lines.join('\n');
}
