import { isDeepStrictEqual } from 'node:util';
import type { Check, McpToolResult, Scenario, Status } from './types.js';

export type JsonRow = Record<string, unknown>;

/**
 * MXQL 5-second series may label the final bucket with the exact `etime`.
 * Permit that *single aligned boundary* for time-series metrics only; the
 * candidate must still have the same key and value in the independent HTTP
 * response. Other domains and timestamps beyond `etime` remain exclusive.
 */
export function isWithinTimeWindow(s: Pick<Scenario, 'domain' | 'stime' | 'etime' | 'expectedStepMs'>, time: unknown): boolean {
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < s.stime) return false;
  if (time < s.etime) return true;
  const step = s.expectedStepMs;
  return time === s.etime && s.domain === 'timeseries' &&
    typeof step === 'number' && Number.isSafeInteger(step) && step > 0 && time % step === 0;
}

export function extractContent(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = result.content?.filter(c => c.type === 'text' && typeof c.text === 'string') ?? [];
  if (texts.length === 1) {
    try { return JSON.parse(texts[0].text!); } catch { return texts[0].text; }
  }
  return texts.map(c => c.text);
}

function records(body: unknown): JsonRow[] | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body
    ? (body as {data: unknown}).data : body;
  if (!Array.isArray(value)) return null;
  const data = value.filter(item => !item || typeof item !== 'object' || !('_head_' in item));
  if (!data.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) return null;
  return data as JsonRow[];
}

export interface ReferenceAssessment {
  checks: Check[];
  rows: JsonRow[] | null;
  complete: boolean;
  total?: number;
  retrievedTotal?: number;
}

export function assessReference(s: Scenario, response: unknown, options: { skipStepCoverage?: boolean } = {}): ReferenceAssessment {
  const checks: Check[] = [];
  if (!response || typeof response !== 'object') return {
    checks: [{ code: 'INVALID_REFERENCE', ok: false, detail: 'HTTP 응답 객체를 읽을 수 없습니다' }],
    rows: null, complete: false,
  };
  const r = response as Record<string, unknown>;
  checks.push({ code: 'HTTP_OK', ok: r.status === 200 && r.ok === true,
    detail: `HTTP 상태: ${String(r.status)}; 정상 응답: ${String(r.ok)}` });
  const rows = records(r.body);
  checks.push({ code: 'PARSE_ROWS', ok: rows !== null,
    detail: rows ? `데이터 행: ${rows.length}건` : '구조화된 데이터 배열을 찾지 못했습니다' });
  const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body)
    ? r.body as Record<string, unknown> : {};
  const total = typeof body.total === 'number' ? body.total : undefined;
  const retrievedTotal = typeof body.retrievedTotal === 'number' ? body.retrievedTotal : undefined;
  let complete = rows !== null && r.status === 200 && r.ok === true;
  if (total !== undefined || retrievedTotal !== undefined) {
    const ok = total !== undefined && retrievedTotal !== undefined &&
      total === retrievedTotal && rows !== null && rows.length === retrievedTotal;
    checks.push({ code: 'STATS_COMPLETENESS', ok,
      detail: `전체 ${String(total)}건 / API 반환 ${String(retrievedTotal)}건 / 실제 데이터 ${rows?.length ?? '확인 불가'}건` });
    if (!ok) complete = false;
  }
  if (rows) {
    const within = rows.every(row => row.time === undefined || isWithinTimeWindow(s, row.time));
    const endpointRows = rows.filter(row => row.time === s.etime).length;
    checks.push({ code: 'TIME_WINDOW', ok: within, detail: within
      ? `확인 가능한 시각은 조회 구간 내에 있습니다${endpointRows ? ` (끝점 정렬 시계열 ${endpointRows}행 포함; HTTP 값 대조 필요)` : ''}`
      : '조회 범위 밖의 타임스탬프가 존재합니다' });
    if (!within) complete = false;
    if (s.expectedStepMs && !options.skipStepCoverage) {
      const times = [...new Set(rows.map(row => row.time).filter((t): t is number => typeof t === 'number'))].sort((a,b)=>a-b);
      const step = s.expectedStepMs;
      // Accept both timestamp conventions: bucket starts [stime, etime)
      // and bucket ends (stime, etime]. For unaligned bounds, both grids
      // naturally coincide. Do not fabricate missing samples in LLM mode.
      const matchGrid = (first: number, last: number): boolean => {
        const expected = Math.max(0, Math.floor((last - first) / step) + 1);
        return times.length === expected &&
          (expected === 0 || (times[0] === first && times[times.length - 1] === last)) &&
          times.every((t, i) => i === 0 || t - times[i-1] === step);
      };
      const firstStart = Math.ceil(s.stime / step) * step;
      const lastStart = Math.floor((s.etime - 1) / step) * step;
      const firstEnd = Math.floor(s.stime / step) * step + step;
      const lastEnd = Math.floor(s.etime / step) * step;
      const ok = matchGrid(firstStart, lastStart) ||
        (s.domain === 'timeseries' && matchGrid(firstEnd, lastEnd));
      checks.push({ code: 'TIMESERIES_COVERAGE', ok,
        detail: `고유 시각 ${times.length}개 / 간격 ${step}ms / 버킷 시작·종료 경계 규칙 검증` });
      if (!ok) complete = false;
    }
  }
  return { checks, rows, complete, total, retrievedTotal };
}


/**
 * The reference HTTP agent always reports the request it actually sent.
 * Validate that metadata before trusting returned rows as an independent reference.
 * This does not establish the candidate MCP's own internal HTTP request details.
 */
export function verifyReferenceRequest(s: Scenario, response: unknown): Check {
  const requests: Record<string, { path: string; mql?: string }> = {
    'whatap_http_server_metrics': { path: '/open/api/flush/mxql/path', mql: '/v2/sys/server_base' },
    'whatap_http_apm_transactions': { path: '/open/api/v2/stat/transaction' },
    'whatap_http_apm_errors': { path: '/open/api/v2/stat/error' },
    'whatap_http_apm_tps_series': { path: '/open/api/flush/mxql/path', mql: '/v2/app/tps_pcode' },
    'whatap_http_apm_error_series': { path: '/open/api/flush/mxql/path', mql: '/v2/app/tx_error_pcode' },
  };
  const expected = requests[s.referenceTool];
  const outer = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown> : {};
  const request = outer.request && typeof outer.request === 'object' && !Array.isArray(outer.request)
    ? outer.request as Record<string, unknown> : null;
  if (!request) return { code: 'REFERENCE_REQUEST', ok: false,
    detail: '기준 HTTP 요청의 메서드·경로·시간을 확인할 메타데이터가 없습니다' };
  const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? request.payload as Record<string, unknown> : null;
  const matches = !!expected && request.method === 'POST' && request.path === expected.path &&
    request.projectCode === s.projectCode && payload?.stime === s.stime && payload?.etime === s.etime &&
    (expected.mql === undefined || payload?.mql === expected.mql) &&
    // An unexpected explicit limit makes a full-result comparison unreliable.
    !(payload && Object.hasOwn(payload, 'limit'));
  return { code: 'REFERENCE_REQUEST', ok: matches, detail: matches
    ? `프로젝트 ${s.projectCode}, 요청 경로, 고정 시간 범위 확인 완료`
    : `기준 HTTP 요청 조건 불일치: 요청 경로=${String(request.path)}, 프로젝트=${String(request.projectCode)}, 기간=${String(payload?.stime)}~${String(payload?.etime)}` };
}

/**
 * Compare transport values, not metric validity or JSON runtime type.
 * Equal arbitrary strings (including "abc"), nulls or JSON values are valid matches.
 * For metric *values* (never identity keys), allow number/string representations
 * such as 25.5 and "25.5" / "25.50" with the configured numeric tolerance.
 */
function equivalentValues(x: unknown, y: unknown, tolerance: number): boolean {
  if (Object.is(x, y)) return true;
  const numeric = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const a = numeric(x), b = numeric(y);
  if (a !== null && b !== null) return Math.abs(a-b) <= tolerance;
  return isDeepStrictEqual(x, y);
}

function visibleValue(v: unknown): string {
  const raw = JSON.stringify(v);
  return (raw ?? String(v)).slice(0, 180);
}

export interface Comparison {
  status: Status;
  reason: string;
  checks: Check[];
}

function keyOf(row: JsonRow, keys: string[]): string | null {
  const parts: unknown[] = [];
  for (const k of keys) {
    if (!Object.hasOwn(row, k)) return null;
    const value = row[k];
    // JSON transport may stringify numeric IDs / epoch timestamps without
    // altering their textual identity. Preserve leading-zero string IDs.
    parts.push(typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
  }
  return JSON.stringify(parts);
}

/** Exact identity matching, configurable float tolerance; no silent truncation. */
export function compareRows(s: Scenario, reference: JsonRow[], candidate: JsonRow[]): Comparison {
  const keys = s.matchKeys ?? [];
  const fields = s.compareFields ?? [];
  if (!keys.length || !fields.length) return {
    status: 'UNVERIFIABLE', reason: 'COMPARISON_FIELDS_UNDEFINED', checks: [],
  };
  const checks: Check[] = [];
  const keyed = (rows: JsonRow[]) => {
    const map = new Map<string, JsonRow>();
    let dup = 0; let missing = 0;
    for (const row of rows) {
      const key = keyOf(row, keys);
      if (key === null) { missing++; continue; }
      if (map.has(key)) dup++;
      else map.set(key, row);
    }
    return { map, dup, missing };
  };
  const a = keyed(reference), b = keyed(candidate);
  const validKeys = a.dup === 0 && b.dup === 0 && a.missing === 0 && b.missing === 0;
  checks.push({ code: 'MATCH_KEYS', ok: validKeys, detail:
    `API 중복=${a.dup}, 식별자 누락=${a.missing}; MCP 중복=${b.dup}, 식별자 누락=${b.missing}` });
  if (!validKeys) return { status: 'UNVERIFIABLE', reason: 'AMBIGUOUS_RECORD_IDENTITIES', checks };
  const sameKeys = a.map.size === b.map.size && [...a.map.keys()].every(k => b.map.has(k));
  checks.push({ code: 'RECORD_IDENTITIES', ok: sameKeys,
    detail: `API ${a.map.size}건 / MCP ${b.map.size}건` });
  if (!sameKeys) return { status: 'FAIL', reason: 'MISSING_OR_EXTRA_RECORDS', checks };
  const tolerance = s.absoluteTolerance ?? 0;
  let mismatches = 0;
  let missingBoth = 0;
  const examples: string[] = [];
  for (const [key, row] of a.map) {
    const other = b.map.get(key)!;
    for (const field of fields) {
      const hasReference = Object.hasOwn(row, field);
      const hasCandidate = Object.hasOwn(other, field);
      // With neither field present, there is no measurement to verify.
      // Do not falsely claim this specific metric was verified.
      if (!hasReference && !hasCandidate) { missingBoth++; continue; }
      const x = row[field], y = other[field];
      if (!hasReference || !hasCandidate || !equivalentValues(x, y, tolerance)) {
        mismatches++;
        if (examples.length < 5) examples.push(
          `${key}/${field}: API=${hasReference ? visibleValue(x) : '(필드 없음)'} MCP=${hasCandidate ? visibleValue(y) : '(필드 없음)'}`,
        );
      }
    }
  }
  checks.push({ code: 'FIELD_VALUES', ok: mismatches === 0 && missingBoth === 0,
    detail: `값 불일치 ${mismatches}건, 양쪽 모두 필드 누락 ${missingBoth}건` +
      (examples.length ? `; 차이 예시: ${examples.join('; ')}` : '') });
  if (mismatches) return { status: 'FAIL', reason: 'FIELD_MISMATCH', checks };
  if (missingBoth) return { status: 'UNVERIFIABLE', reason: 'COMPARISON_FIELD_ABSENT_IN_BOTH', checks };
  return { status: 'PASS', reason: 'MATCHING_DATA', checks };
}

export function classifyMcpResult(result: McpToolResult):
  { kind: 'error' | 'raw' | 'formatted'; error?: string; rows?: JsonRow[]; text?: string } {
  const content = extractContent(result);
  const text = typeof content === 'string' ? content : undefined;
  if (result.isError === true || (text && /Invalid time range format/i.test(text))) {
    return { kind: 'error', error: text ?? JSON.stringify(content) };
  }
  const rows = records(content);
  if (rows) return { kind: 'raw', rows };
  return { kind: 'formatted', text: text ?? (Array.isArray(content) ? '[non-record JSON array]' : '[structured but not row-based data]') };
}
