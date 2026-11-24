import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assessReference, classifyMcpResult, compareRows, extractContent, verifyReferenceRequest, type JsonRow } from './validator.js';
import { forMcpDisplay, parseFormattedMcp, withExactMcpPeriod } from './period.js';
import { checkSummary } from './agent.js';
import { analyzeStats, forensicStatsGroups } from './statistics.js';
import type { AssignmentReport } from './assignment.js';
import type { CallReport, McpToolResult, Scenario, ScenarioReport } from './types.js';

type Window = ScenarioReport['timeWindow'];
type Evidence = NonNullable<AssignmentReport['before']>;
type Raw = { file?: string; sha256?: string };
const unknown = '미확인';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const timestamp = (ms: number) => Number.isSafeInteger(ms) && ms > 0 && ms < 8.64e15 - 32400000
  ? new Date(ms).toISOString() + ' / ' + new Date(ms + 32400000).toISOString().replace('Z', '+09:00') : unknown;
const period = (w?: Window | null) => w && w.etime > w.stime ? timestamp(w.stime) + ' ~ ' + timestamp(w.etime) : unknown;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const numeric = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))
  && Number.isFinite(Number(v)) ? Number(v) : null;

async function checked(path: string, sha?: string) {
  const bytes = await readFile(path);
  if (!sha || digest(bytes) !== sha) throw Error('보고서 원본 증거 SHA-256 불일치');
  return JSON.parse(bytes.toString());
}

async function raw(path: string, meta: Raw): Promise<McpToolResult> {
  if (!meta.file) throw Error('보고서 원본 응답 누락');
  const root = dirname(await realpath(path));
  const resolved = await realpath(resolve(root, meta.file));
  if (!resolved.startsWith(root + sep)) throw Error('보고서 원본 경로가 실행 디렉터리를 벗어났습니다.');
  return checked(resolved, meta.sha256);
}

function httpData(result: McpToolResult) {
  const payload = obj(extractContent(result));
  const body = obj(payload.body);
  const data = Array.isArray(payload.body) ? payload.body : body.data;
  const request = obj(payload.request);
  const args = obj(request.payload);
  return { request, args, status: payload.status, total: body.total, retrievedTotal: body.retrievedTotal,
    rows: Array.isArray(data) ? data.filter(row => row && typeof row === 'object' && !Object.hasOwn(row, '_head_')) as JsonRow[] : null };
}

async function compareEvidence(s: Scenario, call: ScenarioReport | CallReport, path: string) {
  const { candidate, reference } = call;
  const requestArgs = candidate.args;
  const response = candidate.file ? await raw(path, candidate) : undefined;
  const httpRaw = reference.file ? await raw(path, reference) : undefined;
  const mxqlRaw = reference.statistics ? await raw(path, reference.statistics.mxql) : undefined;
  const http = httpRaw && httpData(httpRaw);
  const mxql = mxqlRaw && httpData(mxqlRaw);
  const source = mxql ?? http;
  const referenceWindow = reference.boundaryAlignment?.attempts.find(
    attempt => attempt.deltaMs === reference.boundaryAlignment?.selectedDeltaMs)?.timeWindow ?? call.timeWindow;
  const effective = { ...s, ...referenceWindow };
  const directHttp = httpRaw && extractContent(httpRaw);
  const referenceVerified = !mxql && !!directHttp &&
    verifyReferenceRequest(effective, directHttp).ok && assessReference(effective, directHttp, { skipStepCoverage: true }).complete;
  const transport = response && classifyMcpResult(response);
  const keys = s.matchKeys ?? [];
  const envelope = obj(response?.structuredContent);
  const parsed = transport?.kind === 'formatted' && parseFormattedMcp(
    withExactMcpPeriod(transport.text!, envelope.stime, envelope.etime) ?? transport.text!, [...keys, ...(s.compareFields ?? [])]);
  const mcp = parsed && parsed.ok ? parsed.data : undefined;
  const fields = s.statisticsMode && mcp ? mcp.columns.filter(field => !keys.includes(field)) : s.compareFields ?? [];
  const pairs: Array<{ key: string; time: number | null; field: string; mcp: unknown; http: unknown;
    displayedHttp: unknown; delta: number | null; verdict: '일치' | '불일치' | '누락' }> = [];
  let matched = 0;
  const referenceKey = (row: JsonRow) => {
    if (!keys.every(key => Object.hasOwn(row, key))) throw Error('비교 행 식별 필드 누락');
    return JSON.stringify(keys.map(key => typeof row[key] === 'number' ? String(row[key]) : row[key]));
  };
  if (mcp && source?.rows && fields.length && keys.length) {
    const rows = new Map(source.rows.map(row => [referenceKey(row), row]));
    const shown = new Set<string>();
    if (rows.size !== source.rows.length) throw Error('HTTP 비교 행 식별 키 중복');
    for (const row of mcp.rows) {
      const key = referenceKey(row);
      if (shown.has(key)) throw Error('MCP 비교 행 식별 키 중복');
      shown.add(key);
      const ref = rows.get(key);
      matched += Number(!!ref);
      const normalized = ref && forMcpDisplay([ref], fields)[0];
      for (const field of fields) {
        const displayedHttp = s.statisticsMode && ref && ref[field] == null ? '-' : normalized?.[field];
        const value = row[field];
        const x = numeric(value), y = numeric(displayedHttp);
        const missing = !ref || !Object.hasOwn(row, field) || displayedHttp === undefined;
        const equals = !missing && compareRows({ ...s, matchKeys: keys, compareFields: [field], absoluteTolerance: 0 },
          [{ ...normalized, ...Object.fromEntries(keys.map(k => [k, row[k]])), [field]: displayedHttp }], [row]).status === 'PASS';
        pairs.push({ key, time: numeric(row.time), field, mcp: value, http: ref?.[field], displayedHttp,
          delta: x === null || y === null ? null : Math.abs(x - y), verdict: missing ? '누락' : equals ? '일치' : '불일치' });
      }
    }
  }
  const statistics = s.statisticsMode && mcp && mxqlRaw && httpRaw
    ? analyzeStats(s, mcp, transport!.text!, extractContent(mxqlRaw), extractContent(httpRaw)) : undefined;
  const aggregate = s.statisticsMode && mxql?.rows && http?.rows && statistics?.checks.some(check => check.code === 'STATS_AGGREGATE')
    ? forensicStatsGroups(s.statisticsMode, mxql.rows, http.rows, statistics.v2Window) : undefined;
  const summary = mcp && source?.rows ? checkSummary(transport!.text!, s, source.rows, mcp.rows) : undefined;
  const reportedTotal = transport?.text?.match(/\*\*Summary\*\*\s*\(\d+ of (\d+) rows\b/)?.[1];
  const counts = { 일치: 0, 불일치: 0, 누락: 0 };
  for (const pair of pairs) counts[pair.verdict]++;
  return { requestArgs, mcpTool: call.mcpTool, mcpPath: call.mcpPath, period: mcp?.period,
    status: call.status, reason: call.reason, reference, http, mxql, pairs, counts, keys, fields, matched,
    shown: mcp?.rows.length, mcpTotal: numeric(envelope.total ?? reportedTotal), referenceVerified, summary,
    statistics, aggregate, truncated: mcp?.truncated, candidateRows: candidate.parsedRows };
}

const safeSecret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{12,}|(?:authorization|api[_ -]?key|password|secret|token)\s*[:=]\s*\S+|\bBearer\s+\S+/i;
const safeIdentifier = /^[_a-zA-Z][_a-zA-Z0-9-]{0,79}$/;
const knownEndpoint = /^\/(?:open\/api\/(?:flush\/mxql\/path|v2\/stat\/(?:transaction|error))|open-mcp\/api\/flush\/mxql\/path)$/;
const prefixPath = /(?:^|[\s`("'=])(?:~?\/|[a-z]:\\)|(?:https?|ssh|file):\/\/|\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})\b/i;
const escape = (s: string) => s.replace(/[\\`*_{}\[\]<>|@#]/g, '\\$&').replace(/[\r\n\t]+/g, ' ');
const observedWindow = (args: Record<string, unknown> | undefined) =>
  typeof args?.stime === 'number' && typeof args.etime === 'number' ? { stime: args.stime, etime: args.etime } : undefined;

/** Read only retained evidence. The returned body is the exact payload used by gh. */
export async function buildAssignmentReport(report: AssignmentReport, options: {
  publishMetrics: boolean; archived?: boolean; scrub: (value: string) => string; protectedLiterals: ReadonlySet<string>;
}) {
  const { publishMetrics, archived, scrub, protectedLiterals } = options;
  if ((report.status !== 'VERIFIED' && !(archived && report.status === 'SUBMISSION_FAILED')) || !report.target || !report.repository ||
      !report.sourceHead || !/^[a-f0-9]{40,64}$/.test(report.sourceHead) ||
      !report.build?.build.ok || !report.build.regression.ok ||
      !report.changes.length || (!archived && report.editAttempts.at(-1)?.status !== 'VERIFIED'))
    throw Error('PR 보고서 생성에 필요한 소스 변경, 빌드 또는 독립 검증 증거 누락');

  const privateText = '민감정보 또는 내부 경로가 포함된 설명은 로컬 보고서에 보존했습니다.';
  const prose = (value: string | undefined) => !value ? unknown : value.split(/\r?\n/).map(line => {
    if (scrub(line) !== line || safeSecret.test(line) || prefixPath.test(line) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[\w-]+\.(?:internal|local|corp)\b/i.test(line) ||
        [...protectedLiterals].some(literal => literal && line.includes(literal))) return privateText;
    // Service measurements and counts are emitted only by the structured evidence renderer.
    return escape(line.slice(0, 1000).replace(/(?<![A-Za-z_])\d+(?:[.,]\d+)*(?![A-Za-z_])/g, '[수치 생략]'));
  }).slice(0, 12).join(' ');
  const id = (value: string | null | undefined) => value && safeIdentifier.test(value) && !safeSecret.test(value) ? escape(value) : unknown;
  const path = (value: string) => /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) ? prose(value) : privateText;
  const code = (value: string) => /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? escape(value) : unknown;
  const finished = report.finishedAt ?? new Date().toISOString();
  const sourceRange = (before: string | null, after: string | null) => {
    const oldLines = before?.trimEnd().split('\n') ?? [];
    const newLines = after?.trimEnd().split('\n') ?? [];
    let first = 0;
    while (first < oldLines.length && oldLines[first] === newLines[first]) first++;
    let oldEnd = oldLines.length, newEnd = newLines.length;
    while (oldEnd > first && newEnd > first && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return `\`@@ -${first + 1},${oldEnd - first} +${first + 1},${newEnd - first} @@\``;
  };
  const lines = ['# WhaTap ' + (report.target === 'mcp' ? 'MCP' : 'Harness') + ' 품질 개선 보고서',
    '', ...(archived ? ['> 보존된 이전 실행의 로컬 검토 예시입니다. 현재 제출 기준의 시도 기록이나 반복 조회가 없으면 미확보로 표시합니다.', ''] : []),
    '## 1. 작업 요약', '', '- 실행 주체 WhaTap AI Agent Harness 및 Codex CLI',
    '- 사용 모델 ' + unknown + ' (확인 가능한 실행 기록 기준)',
    '- 실행 시작 ' + timestamp(Date.parse(report.startedAt)), '- 검증 종료 ' + timestamp(Date.parse(finished)),
    '- 대상 저장소 ' + path(report.repository), '- 검증 기준 커밋 `' + report.sourceHead + '`',
    ...(archived && report.git.commit && /^[a-f0-9]{40,64}$/.test(report.git.commit) ? ['- 제출 커밋 `' + report.git.commit + '`'] : []),
    '- 작업 목적 ' + prose(report.purpose), '- 최종 판정 **' + code(report.status) + '** · ' + prose(report.reason),
    '', '## 2. 문제 발견 및 재현', '',
    '저장된 관측과 수정 전 재실행 결과의 요청 조건 및 판정은 5절에 기록했습니다.',
    '', '## 3. 원인 분석 및 수정 필요성', '',
    ...report.diagnoses.filter(d => d.classification === (report.target === 'mcp' ? 'MCP_DEFECT' : 'HARNESS_DEFECT')).flatMap(d => [
      '### ' + id(d.scenarioId), '- 관련 파일 ' + d.files.map(path).join(', '), '- 관련 함수 ' + prose(d.functions),
      '- 원인 가설 및 영향 ' + prose(d.cause), '- 수정 필요성과 관측 근거 ' + prose(d.basis),
      '- 선택한 변경 ' + prose(d.change), '- 분석 한계 ' + prose(d.limitations), '',
    ]),
    '## 4. 상세 변경 사항', '', '- 변경 요약 ' + prose(report.edit?.summary),
    '- 변경 이유와 기존·신규 검증 기준 ' + prose(report.edit?.rationale),
    '- 편집기 자체 테스트 기록 ' + (report.edit?.testsRun.map(prose).join(', ') || '기록 없음'),
    '', '| 변경 파일 | 변경 구분 | 전체 변경 줄 범위 |', '|---|---|---|',
    ...report.changes.map(change => '| ' + path(change.path) + ' | ' +
      (change.before === null ? '추가' : change.after === null ? '삭제' : '수정') + ' | ' + sourceRange(change.before, change.after) + ' |'),
    '', 'PR의 **Files changed**에서 전체 Diff를 확인할 수 있습니다. 수정 전후 코드 원문은 로컬 assignment.json에 보존했습니다.',
    '', '## 5. 수정 전후 데이터와 검증 계약', '',
    report.evidenceOrigin === 'fixture' ? '데이터 출처 · Mock 또는 합성 테스트 증거.' : '데이터 출처 · assignment가 보존한 MCP/HTTP 응답. 합성 계약은 별도로 표시합니다.',
    '측정값과 응답 행 수는 기간별로 기록합니다. 조회 기간이 다르면 행 단위 전후 차이를 계산하지 않습니다.',
    publishMetrics ? '공개 동의 범위에서 승인된 수치형 측정 필드와 UTC/KST 시각을 표시합니다.' :
      '실제 서비스 측정값과 조회 시각은 공개 동의가 없어 로컬 보고서에 보존했습니다.',
    '프로젝트 및 행 식별자, 비수치 응답 내용, 원본 응답 전문은 로컬 증거에 보존합니다.', ''];
  const audits: Array<Pick<Evidence, "path" | "sha256"> & { label: string; fixed?: Evidence["fixedReplayAudit"]; relative?: Evidence["relativeReplayAudit"] }> = [];
  const entries: Array<{ label: string; scenario: string; result: Awaited<ReturnType<typeof compareEvidence>> }> = [];
  const contracts: unknown[] = [];
  const seen = new Set<string>();
  const clock = (w?: Window | null) => publishMetrics ? period(w) : w ? '공개 제한' : unknown;
  const metric = (v: unknown) => v == null ? '—' : publishMetrics && numeric(v) !== null && !report.scenarios.some(s => String(s.projectCode) === String(v)) ? String(v) : '공개 제한';
  const publicFields = new Set(['cpu', 'memory_pused', 'tx_count', 'tx_error', 'tx_time_sum', 'tps', 'count']);
  const route = (v: unknown) => typeof v === 'string' && knownEndpoint.test(v) ? v : unknown;
  const rangeOf = (rows?: JsonRow[] | null) => {
    const times = (rows ?? []).map(row => numeric(row.time)).filter((time): time is number => time !== null && time > 0);
    return times.length ? { stime: times.reduce((a, b) => Math.min(a, b)), etime: times.reduce((a, b) => Math.max(a, b)) } : undefined;
  };
  const addRun = async (label: string, ev: Evidence, required = false) => {
    if (seen.has(ev.path)) return;
    seen.add(ev.path);
    await checked(ev.path, ev.sha256);
    audits.push({ label, path: ev.path, sha256: ev.sha256, fixed: ev.fixedReplayAudit, relative: ev.relativeReplayAudit });
    let compared = 0;
    for (const row of ev.scenarios) {
      const scenario = report.scenarios.find(s => s.id === row.id);
      if (!scenario) throw Error('보고서 비교 계약 누락');
      for (const [index, call] of (row.callResults?.length ? row.callResults : [row]).entries()) {
        lines.push('### ' + label + ' · ' + id(row.id) + (row.callResults?.length ? ' · 호출 ' + (index + 1) : ''), '',
          '- 실행 판정 ' + code(call.status) + ' / ' + code(call.reason));
        if (ev.fixedReplayAudit) lines.push('- 절대시간 요청 ' + clock(ev.fixedReplayAudit.requestedWindow) +
          ' · 스키마 ' + code(ev.fixedReplayAudit.schemaVerdict) + ' · MCP 호출 ' + ev.fixedReplayAudit.toolCalls +
          '회 · 요청·반환 기간 일치 ' + (ev.fixedReplayAudit.periodMatched ? '예' : '아니요'));
        if (ev.fixedReplayAudit?.toolCalls === 0) {
          lines.push('- 스키마 검사에서 호출 제한이 관측되어 이 요청의 수정 전 응답과 비교값을 확보하지 못했습니다.', '');
          continue;
        }
        const c = await compareEvidence(scenario, call, ev.path);
        const metadata = (data: typeof c.http) => data && { ...data, returned: data.rows?.length, rows: null };
        entries.push({ label, scenario: row.id, result: { ...c, http: metadata(c.http), mxql: metadata(c.mxql) } });
        compared += c.pairs.length;
        const args = c.requestArgs;
        const reference = c.mxql ?? c.http;
        const knownMcpPath = c.mcpPath && (scenario.allowedMcpPaths ?? [scenario.mcpPath]).includes(c.mcpPath) &&
          /^(?:\/?v2|\/?mxql)\/[a-z0-9_/]+$/.test(c.mcpPath) ? path(c.mcpPath.replace(/^\//, '')) : unknown;
        lines.push('- MCP Tool ' + id(c.mcpTool) + ' · 조회 경로 ' + knownMcpPath +
          ' · timeRange ' + (typeof args?.timeRange === 'string' && /^\d{1,4}[smhd]$/.test(args.timeRange) ? args.timeRange : unknown) +
          ' · limit ' + (Number.isSafeInteger(args?.limit) ? args?.limit : unknown) + ' · 절대시간 인자 ' + clock(observedWindow(args)),
          '- MCP 반환 Period ' + clock(c.period) + ' · 전체 행 ' + (c.mcpTotal ?? unknown) +
          ' · 표시 행 ' + (c.shown ?? c.candidateRows ?? unknown) + ' · 출력 제한 안내 ' + (c.truncated === undefined ? unknown : c.truncated ? '있음' : '없음'));
        for (const [tool, data] of [[row.referenceTool, c.http], ['whatap_http_mxql_path', c.mxql]] as const) {
          if (!data) continue;
          const window = rangeOf(data.rows);
          lines.push('- HTTP Tool ' + id(tool) + ' · POST ' + route(data.request.path) +
            ' · 요청 ' + clock(observedWindow(data.args)) +
            ' · 반환 데이터 시각 ' + (window && window.stime === window.etime ? (publishMetrics ? timestamp(window.stime) : '공개 제한') : clock(window)) +
            ' · 전체 ' + (numeric(data.total) ?? unknown) + ' · 반환 ' + (data.rows?.length ?? unknown) +
            ' · API retrievedTotal ' + (numeric(data.retrievedTotal) ?? unknown));
        }
        const stats = c.reference.statistics;
        if (c.reference.boundaryAlignment) lines.push('- 경계 보정 전 HTTP 요청 ' + clock(c.reference.boundaryAlignment.original.timeWindow) +
          ' · 반환 ' + (c.reference.boundaryAlignment.original.rowCount ?? unknown) + '행');
        if (stats) {
          lines.push('- 통계 v2 집계 요청 ' + clock(stats.v2Window) +
            ' · 집계 비교 버킷 ' + (stats.comparedBuckets ?? unknown) + ' · 원본 MXQL 행 ' + (stats.fullMxqlRows ?? unknown));
          const aggregate = c.aggregate;
          if (aggregate) {
            lines.push('- 독립 HTTP 집계 비교 ' + aggregate.bucketCount + '/' + aggregate.expectedBuckets +
              ' 버킷 · 그룹 일치 ' + aggregate.matching + ' · 불일치 ' + aggregate.different +
              ' · MXQL 누락 ' + aggregate.missingMxql + ' · v2 누락 ' + aggregate.missingV2);
            const groupSample = publishMetrics ? [...aggregate.allGroups.filter(g => g.status !== 'MATCH'),
              ...aggregate.allGroups.filter(g => g.status === 'MATCH')].slice(0, 1) : [];
            for (const group of groupSample) {
              lines.push('', '| 집계 필드 | HTTP MXQL 합계 | HTTP v2 | 절댓값 차이 | 허용 오차 | 그룹 판정 |',
                '|---|---:|---:|---:|---:|---|');
              for (const field of Object.keys(group.delta).filter(field => publicFields.has(field))) {
                const delta = group.delta[field];
                lines.push('| ' + field + ' | ' + [group.mxql?.[field], group.v2?.[field], delta == null ? null : Math.abs(delta)].map(metric).join(' | ') +
                  ' | ' + (field === 'tx_time_sum' ? '0.01' : '0') + ' | ' + code(group.status) + ' |');
              }
              lines.push('');
            }
          }
        }
        if (c.summary) lines.push('- MCP 요약 통계 검사 ' + (c.summary.ok ? '통과' : '실패 · ' + prose(c.summary.detail)));
        for (const attempt of c.reference.boundaryAlignment?.attempts ?? [])
          lines.push('- 경계 재조회 +' + attempt.deltaMs + 'ms · ' + clock(attempt.timeWindow) +
            ' · ' + code(attempt.status) + ' / ' + code(attempt.reason));
        lines.push('- MCP 표시 행 기준 HTTP 대응 ' + c.matched + '행 · 미검증 HTTP 행 ' +
          (reference?.rows && c.pairs.length ? reference.rows.length - c.matched : unknown) +
          ' · 비교 키 ' + c.keys.filter(k => /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(k)).map(id).join(', ') +
          ' · 필드 ' + c.fields.filter(f => publicFields.has(f)).map(id).join(', ') +
          ' · 표시값 허용 오차 0 · 일치 ' + c.counts.일치 + ' · 불일치 ' + c.counts.불일치 + ' · 누락 ' + c.counts.누락);
        const rowIds = new Map<string, number>();
        for (const p of c.pairs) if (!rowIds.has(p.key)) rowIds.set(p.key, rowIds.size + 1);
        const samples = publishMetrics ? [...c.pairs.filter(p => p.verdict !== '일치'), ...c.pairs.filter(p => p.verdict === '일치')]
          .filter(p => publicFields.has(p.field)).slice(0, 6) : [];
        if (samples.length) lines.push('', '| 관측 시각 UTC / KST | 비교 행 | 필드 | MCP 표시 | HTTP 원본 | HTTP 표시 기준 | 차이(절댓값) | 결과 |',
          '|---|---:|---|---:|---:|---:|---:|---|',
          ...samples.map(p => '| ' + timestamp(p.time ?? 0) + ' | ' + rowIds.get(p.key) + ' | ' + p.field + ' | ' +
            [p.mcp, p.http, p.displayedHttp, p.delta].map(metric).join(' | ') + ' | ' + p.verdict + ' |'));
        lines.push('');
        if (required && (!c.pairs.length || call.status !== 'PASS' || c.counts.불일치 || c.counts.누락 ||
          !reference || !knownEndpoint.test(String(reference.request.path)) || !observedWindow(reference.args) ||
          !c.summary?.ok || (scenario.statisticsMode ? c.statistics?.status !== 'PASS' : !c.referenceVerified)))
          throw Error('PR 보고서에 필요한 수정 후 원본 비교, 요청 또는 통과 근거 누락');
      }
    }
    if (required && !compared) throw Error('PR 보고서 수정 후 비교값 누락');
  };

  if (!report.before) throw Error('PR 보고서 수정 전 관측 누락');
  await addRun('초기 관측', report.before);
  for (const ev of report.beforeRefresh) await addRun('수정 전 독립 재현', ev);
  for (const check of report.absoluteChecks) {
    if (!check.after || !archived && !check.repeat) throw Error('절대시간 반복 검증 증거 누락');
    await addRun('수정 전 절대시간', check.before);
    await addRun('수정 후 절대시간 1차', check.after, true);
    if (check.repeat) {
      lines.push('- 두 호출의 시작 간격 ' + check.repeat.startIntervalMs.toFixed(3) + 'ms');
      await addRun('수정 후 절대시간 2차', check.repeat.evidence, true);
    } else lines.push('- 이전 실행에서 2차 반복 조회 증거 미확보');
  }
  for (const attempt of report.editAttempts.filter(item => item.status !== 'VERIFIED'))
    for (const ev of attempt.after) await addRun('실패 시도 ' + attempt.ordinal + '회차', ev);
  for (const ev of report.after) await addRun('수정 후 독립 재검증', ev, true);
  if (report.target === 'mcp' && (!report.after.length || report.validation.some(v => !v.replayAttested))) throw Error('MCP 수정 후 독립 검증 증거 누락');

  const longitudinal = [];
  for (const before of entries.filter(e => e.label === '수정 전 독립 재현' || e.label === '수정 전 절대시간' || e.label === '초기 관측')) {
    const start = before.result.period;
    if (!start || !before.result.pairs.length) continue;
    const previous = new Map(before.result.pairs.map(p => [JSON.stringify([p.key, p.field]), p]));
    for (const after of entries.filter(e => e.scenario === before.scenario && e.label.startsWith('수정 후'))) {
      const end = after.result.period;
      if (!end || start.stime !== end.stime || start.etime !== end.etime) continue;
      const rows = after.result.pairs.flatMap(p => {
        const old = previous.get(JSON.stringify([p.key, p.field]));
        if (!old) return [];
        const a = numeric(old.mcp), b = numeric(p.mcp);
        return [{ before: old, after: p, delta: a === null || b === null ? null : b - a }];
      });
      if (!rows.length) continue;
      longitudinal.push({ scenario: before.scenario, before: before.label, after: after.label, period: start, rows });
      const samples = publishMetrics ? rows.filter(r => publicFields.has(r.after.field)).sort((a, b) =>
        Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 4) : [];
      lines.push('### 동일 절대 기간 · ' + id(before.scenario) + ' · ' + before.label + ' / ' + after.label,
        '', '- ' + clock(start) + ' · 공통 행·필드 ' + rows.length + '개', '');
      if (samples.length) lines.push('| UTC / KST · 필드 | 수정 전 MCP | 수정 전 HTTP | 수정 후 MCP | 수정 후 HTTP | MCP 변화량 |',
        '|---|---:|---:|---:|---:|---:|',
        ...samples.map(r => '| ' + timestamp(r.after.time ?? 0) + ' · ' + r.after.field + ' | ' +
          [r.before.mcp, r.before.http, r.after.mcp, r.after.http, r.delta].map(metric).join(' | ') + ' |'), '');
    }
  }

  for (const check of report.harnessChecks ?? []) {
    if (!check.after?.length) throw Error('Harness 수정 후 독립 검증 계약 누락');
    const synthetic = check.after.some(result => 'synthetic' in result);
    const before = archived && !check.before.sha256 ? undefined : await checked(check.before.path, check.before.sha256);
    lines.push('### Harness ' + id(check.id), '',
      '| 검증 입력 | 기대 결과 | 관측 결과 | 독립 판정 |', '|---|---|---|---|',
      '| 수정 전 ' + (synthetic ? '합성 stable 계약' : '저장 응답 재생') +
      ' | 기존 결함 재현 | ' + code(synthetic ? before.status : check.before.row.status) +
      (synthetic ? ' · 반복 검증 요구 미충족 재현' : ' / ' + code(check.before.row.reason)) + ' | 재현 |');
    for (const result of check.after) {
      const document = await checked(result.evidence, result.evidenceSha256);
      if (result.independent.status !== 'PASS') throw Error('Harness 독립 검증 통과 근거 누락');
      const isSynthetic = 'synthetic' in result;
      if (isSynthetic && !Array.isArray(document.trace)) throw Error('합성 검증 호출 기록 누락');
      const expected = isSynthetic ? ({ stable: 'VERIFIED', drift: 'UNVERIFIABLE', mismatch: 'VERIFICATION_FAILED' } as Record<string, string>)[result.label] : 'PASS';
      const observed = isSynthetic ? document.status : result.after.row.status;
      if (!expected || expected !== observed) throw Error('Harness 검증 계약 관측 불일치');
      contracts.push({ scenario: check.id, synthetic: isSynthetic, input: result.label, expected, observed,
        evidence: result.evidence, sha256: result.evidenceSha256, before: check.before.path, beforeSha256: check.before.sha256,
        observation: isSynthetic ? document : undefined });
      const fixedCalls = isSynthetic ? document.trace.filter((call: { candidate?: boolean; fixed?: unknown }) => call.candidate && call.fixed) : [];
      const window = isSynthetic && fixedCalls[0]?.fixed?.window ? period(fixedCalls[0].fixed.window) : '';
      const interval = isSynthetic && fixedCalls.length >= 2 ? fixedCalls[1].elapsed - fixedCalls[0].elapsed : null;
      const input = isSynthetic ? (result.label === 'stable' ? '같은 절대 기간 응답' :
        result.label === 'drift' ? '두 번째 절대 기간 변경 응답' : '두 번째 비교값 불일치 응답') :
        result.label === 'historical' ? '저장 MCP 응답과 독립 HTTP 응답 재생' : '독립 재조회 후 응답 재생';
      lines.push('| ' + (isSynthetic ? '합성 ' : '') + input + (window ? ' · ' + window : '') + ' | ' + expected +
        ' | ' + code(observed) + (isSynthetic ? ' · 수정 후보 절대시간 호출 ' + fixedCalls.length + '회' + (Number.isFinite(interval) ? ' · 시작 간격 ' + interval + 'ms' : '') : '') +
        ' | ' + code(result.independent.status) + ' |');
    }
    lines.push('');
  }
  if (report.target === 'harness' && !contracts.length) throw Error('Harness 독립 검증 계약 누락');
  lines.push('## 6. 독립 검증 및 회귀 테스트', '',
    '- 별도 복사본 빌드 성공 · 종료 코드 ' + (report.build.build.exitCode ?? unknown),
    '- 기존 회귀 테스트 성공 · 종료 코드 ' + (report.build.regression.exitCode ?? unknown),
    ...report.validation.map(v => '- ' + id(v.id) + ' · ' + code(v.before) + ' → ' + code(v.after) +
      ' · ' + (v.samePeriod ? '동일 절대 기간' : '서로 다른 관측 기간') + ' · 직접 호출 확인 ' + (v.replayAttested ? '성공' : '실패')),
    '', '## 7. 실패 및 재시도 이력', '',
    ...(report.editAttempts.length ? [] : ['- 이전 실행의 시도별 구조화 기록 미확보']),
    ...report.editAttempts.flatMap(a => ['- ' + a.ordinal + '회차 ' + code(a.status) +
      (a.reason ? ' · ' + prose(a.reason) : '') + ' · ' + (a.changes.map(c => path(c.path)).join(', ') || '확인된 변경 없음'),
      ...(a.build ? ['  - 빌드 종료 코드 ' + (a.build.build.exitCode ?? unknown) +
        ' · 회귀 종료 코드 ' + (a.build.regression?.exitCode ?? unknown)] : []),
      ...(a.edit ? ['  - 수정 내용 ' + prose(a.edit.summary) + ' · 근거 ' + prose(a.edit.rationale)] : []),
      ...report.attempts.filter(step => step.attempt === a.ordinal && step.error).map(step => '  - 실패 근거 ' + prose(step.error))]),
    '', '## 8. 영향 범위 및 검증 한계', '',
    '- 호환성 검증 범위는 기존 회귀 테스트와 위에 기록된 시나리오 및 표시 행입니다.',
    '- MCP 전체 행 수를 응답에서 확인할 수 없는 경우 미확인으로 표시했습니다. HTTP에만 존재하는 미표시 행은 검증 범위에서 제외됩니다.',
    ...((report.edit?.risks.length ? report.edit.risks.map(r => '- 편집기 위험 분석 ' + prose(r)) : ['- 편집기 위험 분석 추가 기록 없음'])),
    '', '## 9. 재현 방법 및 최종 판단', '',
    '1. PR 대상 소스를 별도 checkout에서 준비합니다.',
    '2. Harness checkout에서 `npm ci`, `npm run build`, `npm test`를 실행합니다.',
    '3. 승인된 환경에서 저장 증거를 제공하고 `node tools/run-assignment.mjs --config <config> --worktree <agent-worktree> --evidence <report.json>`을 실행합니다. Harness를 검증할 때는 `--harness-worktree <harness-agent-worktree>`도 지정합니다.',
    '4. 로컬 assignment.json 및 비교 보고서에서 재현 판정과 직접 검증 판정, 빌드 및 회귀 결과를 확인합니다.',
    '', archived ? '당시의 관측과 회귀 결과를 기록했습니다. 현재 자동 제출 요건의 충족 여부는 새 실행 기록에서 확인합니다.' :
      '기존 결함의 재현과 수정 후 독립 검증 및 회귀 테스트 통과를 근거로 제출합니다. 최종 병합은 사람이 승인합니다.', '');
  const body = lines.join('\n');
  if (body.length > 60000 || Buffer.byteLength(body) > 110000 || scrub(body) !== body || safeSecret.test(body)) throw Error('공개 PR 본문 크기 또는 보안 검사 실패');
  return { body, entries, contracts, longitudinal, audits };
}
